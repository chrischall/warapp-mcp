import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Reader, Writer } from '../../src/protocol/codec.js';
import { BundleError, BundleProvider, discoverBundleUrl, loadBundle, WarappBundle } from '../../src/protocol/bundle.js';
import { MINI_BUNDLE } from './mini-bundle.js';

const PAGE = 'https://war.app/MultiPlayer';
const CDN = 'https://warappcdn.com/js/Release/ujs.js?v=987';
const html = (src: string) => `<html><head><script type="text/javascript" src="${src}"></script></head></html>`;

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'warapp-bundle-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    // Only ever remove the directories this file created under the OS temp dir.
    if (d.startsWith(tmpdir() + sep) && d.includes('warapp-bundle-')) rmSync(d, { recursive: true, force: true });
  }
});

function fakeFetch(pages: Record<string, string>) {
  const calls: string[] = [];
  const fetchText = async (url: string) => {
    calls.push(url);
    const body = pages[url];
    if (body === undefined) throw new Error(`unexpected fetch ${url}`);
    return body;
  };
  return { calls, fetchText };
}

describe('discoverBundleUrl', () => {
  it('finds an absolute CDN script and its version', () => {
    expect(discoverBundleUrl(html(CDN), PAGE)).toEqual({ url: CDN, version: '987' });
  });

  it('resolves protocol-relative and relative sources and HTML entities', () => {
    expect(discoverBundleUrl(html('//warappcdn.com/js/Release/ujs.js?v=5&amp;x=1'), PAGE)).toEqual({
      url: 'https://warappcdn.com/js/Release/ujs.js?v=5&x=1',
      version: '5',
    });
    expect(discoverBundleUrl(html('/js/Release/ujs.js?v=6'), PAGE)).toEqual({
      url: 'https://war.app/js/Release/ujs.js?v=6',
      version: '6',
    });
  });

  it('derives a stable version when the URL carries none', () => {
    const a = discoverBundleUrl(html('https://warappcdn.com/js/ujs.js'), PAGE);
    expect(a.version).toMatch(/^u-[0-9a-f]{16}$/);
    expect(discoverBundleUrl(html('https://warappcdn.com/js/ujs.js'), PAGE)).toEqual(a);
  });

  it('rejects a page without the bundle script', () => {
    expect(() => discoverBundleUrl('<html><script src="/other.js"></script></html>', PAGE)).toThrow(BundleError);
  });

  it('rejects a bundle on another host or over http', () => {
    expect(() => discoverBundleUrl(html('https://evil.example/ujs.js?v=1'), PAGE)).toThrow(/host/);
    expect(() => discoverBundleUrl(html('http://warappcdn.com/ujs.js?v=1'), PAGE)).toThrow(/https/);
  });

  it('rejects a version that is not a safe file name', () => {
    expect(() => discoverBundleUrl(html('https://warappcdn.com/ujs.js?v=../../x'), PAGE)).toThrow(/version/);
  });
});

describe('loadBundle', () => {
  it('downloads, caches under <dataDir>/bundle/<version>.js and reads by stable type name', async () => {
    const dataDir = tempDir();
    const f = fakeFetch({ [PAGE]: html(CDN), [CDN]: MINI_BUNDLE });
    const b = await loadBundle({ dataDir, fetchText: f.fetchText, pageUrl: PAGE });
    expect(f.calls).toEqual([PAGE, CDN]);
    expect(b.version).toBe('987');
    const file = join(dataDir, 'bundle', '987.js');
    expect(readFileSync(file, 'utf8')).toBe(MINI_BUNDLE);
    const r = new Reader(new Writer().int32(12).bytes());
    expect(b.readClass('warlight.shared.LatestGameInfo', r)).toEqual({
      $type: 'warlight.shared.LatestGameInfo',
      turn: 12,
      ver: 242,
    });
    expect(b.has('warlight.shared.LatestGameInfo')).toBe(true);
    expect(b.has('warlight.shared.Nope')).toBe(false);
  });

  it('uses the cached copy without downloading again', async () => {
    const dataDir = tempDir();
    await loadBundle({ dataDir, fetchText: fakeFetch({ [PAGE]: html(CDN), [CDN]: MINI_BUNDLE }).fetchText, pageUrl: PAGE });
    const f = fakeFetch({ [PAGE]: html(CDN) });
    const b = await loadBundle({ dataDir, fetchText: f.fetchText, pageUrl: PAGE });
    expect(f.calls).toEqual([PAGE]);
    expect(b.readClass('NE', new Reader(new Writer().int32(1).bytes()))).toMatchObject({ turn: 1 });
  });

  it('refuses and does not cache something that is not a client bundle', async () => {
    const dataDir = tempDir();
    const f = fakeFetch({ [PAGE]: html(CDN), [CDN]: '<html>error</html>' });
    await expect(loadBundle({ dataDir, fetchText: f.fetchText, pageUrl: PAGE })).rejects.toThrow(BundleError);
    expect(existsSync(join(dataDir, 'bundle', '987.js'))).toBe(false);
  });

  it('passes interpreter options through', async () => {
    const f = fakeFetch({ [PAGE]: html(CDN), [CDN]: MINI_BUNDLE });
    const b = await loadBundle({ dataDir: tempDir(), fetchText: f.fetchText, pageUrl: PAGE, interp: { version: 200 } });
    expect(b.readClass('NE', new Reader(new Writer().int32(1).bytes()))).toMatchObject({ ver: 200 });
  });

  // war.app's homepage does not load the game client; /MultiPlayer (like every game
  // page) carries the ujs.js script tag — observed live 2026-11-12.
  it('defaults the page to war.app/MultiPlayer, which carries the client bundle', async () => {
    const f = fakeFetch({ 'https://war.app/MultiPlayer': html(CDN), [CDN]: MINI_BUNDLE });
    await loadBundle({ dataDir: tempDir(), fetchText: f.fetchText });
    expect(f.calls[0]).toBe('https://war.app/MultiPlayer');
  });
});

describe('BundleProvider', () => {
  it('loads once per process and retries after a failure', async () => {
    let fail = true;
    const calls: string[] = [];
    const fetchText = async (url: string) => {
      calls.push(url);
      if (fail) throw new Error('offline');
      return url === PAGE ? html(CDN) : MINI_BUNDLE;
    };
    const p = new BundleProvider({ dataDir: tempDir(), fetchText, pageUrl: PAGE });
    await expect(p.get()).rejects.toThrow('offline');
    fail = false;
    const [a, b] = await Promise.all([p.get(), p.get()]);
    expect(a).toBe(b);
    expect(await p.get()).toBe(a);
    expect(calls).toEqual([PAGE, PAGE, CDN]);
  });
});

describe('the built-in reader helpers are checked against the bundle at load (#131)', () => {
  // A reader that reads a one-byte field then a four-byte field through two P helpers.
  const READER = 'function Dx(){}W["t.Dx"]=Dx;Dx.Ha=function(a,b,d){var e=new Dx;e.small=P.uq(a);e.big=P.Ya(a);return e};';

  it('loads a bundle whose helpers do what the built-ins do, and reports them verified', () => {
    const b = new WarappBundle(
      'var W={};var P={};P.Ya=function(a){return a.Og()};P.uq=function(a){return a.bc()};' +
        'P.wc=function(a){return a.Ua()?a.FJ():null};' +
        'P.Sd=function(a,b){a=a.Og();if(-1==a)return null;for(var d=[],e=0;e<a;)d.push(b()),++e;return d};' +
        READER,
      'same',
    );
    expect(b.dialectCheck.verified).toEqual(['P.Sd', 'P.Ya', 'P.uq', 'P.wc']);
    expect(b.dialectCheck.mismatched).toEqual([]);
    expect(b.readClass('t.Dx', new Reader(new Writer().u8(7).int32(100000).bytes()))).toEqual({ $type: 't.Dx', small: 7, big: 100000 });
  });

  it('refuses a bundle that swapped two helpers rather than mis-reading every field', () => {
    // A new minification gave the names to each other: P.Ya now reads a byte, P.uq four.
    const swapped = 'var W={};var P={};P.Ya=function(a){return a.MGb()};P.uq=function(a){return a.Og()};' + READER;
    expect(() => new WarappBundle(swapped, 'swapped')).toThrow(BundleError);
    expect(() => new WarappBundle(swapped, 'swapped')).toThrow(/P\.Ya.*P\.uq|P\.uq.*P\.Ya/);
  });

  it('leaves a helper it cannot evaluate unverified, not refused', () => {
    const b = new WarappBundle('var W={};var P={};P.Td=function(a){return O.N3c(a)};' + READER, 'opaque');
    expect(b.dialectCheck.unverified).toContain('P.Td');
    expect(b.dialectCheck.mismatched).toEqual([]);
  });

  it('a bundle that defines no helpers (the test bundles) has nothing to check', () => {
    const b = new WarappBundle(MINI_BUNDLE, 'mini');
    expect(b.dialectCheck).toEqual({ verified: [], unverified: [], mismatched: [] });
  });
});

describe('the bundle cache is pruned and survives a failed version lookup (#131)', () => {
  const seed = (dataDir: string, files: Record<string, string>, mtimeSec?: Record<string, number>) => {
    mkdirSync(join(dataDir, 'bundle'), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      const f = join(dataDir, 'bundle', name);
      writeFileSync(f, body);
      const t = mtimeSec?.[name];
      if (t !== undefined) utimesSync(f, t, t);
    }
  };

  it('keeps only the version in use once it loads', async () => {
    const dataDir = tempDir();
    seed(dataDir, { '111.js': MINI_BUNDLE, '222.js': MINI_BUNDLE, '987.js.tmp-1': 'x', 'notes.txt': 'keep' });
    await loadBundle({ dataDir, fetchText: fakeFetch({ [PAGE]: html(CDN), [CDN]: MINI_BUNDLE }).fetchText, pageUrl: PAGE });
    expect(readdirSync(join(dataDir, 'bundle')).sort()).toEqual(['987.js', 'notes.txt']);
  });

  it('falls back to the newest cached copy when the page naming the version cannot be read', async () => {
    const dataDir = tempDir();
    seed(dataDir, { '111.js': MINI_BUNDLE, '222.js': MINI_BUNDLE }, { '111.js': 1_700_000_000, '222.js': 1_700_000_500 });
    const fetchText = async () => {
      throw new Error('did not respond within 30000ms');
    };
    const b = await loadBundle({ dataDir, fetchText, pageUrl: PAGE });
    expect(b.version).toBe('222');
    expect(b.fallback).toBe(true);
    // Nothing is pruned on a fallback: the lookup did not say which version is current.
    expect(readdirSync(join(dataDir, 'bundle')).sort()).toEqual(['111.js', '222.js']);
  });

  it('still fails when there is no cached copy to fall back to', async () => {
    const fetchText = async () => {
      throw new Error('offline');
    };
    await expect(loadBundle({ dataDir: tempDir(), fetchText, pageUrl: PAGE })).rejects.toThrow('offline');
  });

  it('the provider keeps a fallback copy only for a while, then looks the version up again', async () => {
    const dataDir = tempDir();
    seed(dataDir, { '111.js': MINI_BUNDLE });
    let now = 1_000_000;
    let up = false;
    const calls: string[] = [];
    const fetchText = async (url: string) => {
      calls.push(url);
      if (!up) throw new Error('offline');
      return url === PAGE ? html(CDN) : MINI_BUNDLE;
    };
    const p = new BundleProvider({ dataDir, fetchText, pageUrl: PAGE, now: () => now });
    expect((await p.get()).version).toBe('111');
    up = true;
    expect((await p.get()).version).toBe('111');
    now += 5 * 60_000;
    expect((await p.get()).version).toBe('987');
    expect(calls).toEqual([PAGE, PAGE, CDN]);
  });
});
