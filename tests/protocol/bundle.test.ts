import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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

  // The location is pinned (host, path, version as the only variable): a relative source
  // (which resolves onto war.app), extra query parameters and a URL without a version used
  // to be accepted; those expectations encoded the flaw and now read as refusals.
  it('resolves a protocol-relative source', () => {
    expect(discoverBundleUrl(html('//warappcdn.com/js/Release/ujs.js?v=5'), PAGE)).toEqual({
      url: 'https://warappcdn.com/js/Release/ujs.js?v=5',
      version: '5',
    });
  });

  it('pins the bundle to the CDN host and the bundle path, with the version the only variable', () => {
    for (const src of [
      'https://www.warappcdn.com/js/Release/ujs.js?v=1', // a subdomain of the CDN
      'https://cdn.war.app/js/Release/ujs.js?v=1', // a subdomain of war.app
      'https://war.app/js/Release/ujs.js?v=1', // war.app itself
      '/js/Release/ujs.js?v=6', // relative: resolves onto war.app
      'https://warappcdn.com.evil.example/js/Release/ujs.js?v=1',
      'https://user@warappcdn.com/js/Release/ujs.js?v=1',
      'https://warappcdn.com:8443/js/Release/ujs.js?v=1',
    ]) {
      expect(() => discoverBundleUrl(html(src), PAGE), src).toThrow(/host/);
    }
    for (const src of [
      'https://warappcdn.com/js/ujs.js?v=1',
      'https://warappcdn.com/uploads/js/Release/ujs.js?v=1',
      'https://warappcdn.com/js/Release/x/../ujs.js?v=1&y=/ujs.js',
    ]) {
      expect(() => discoverBundleUrl(html(src), PAGE), src).toThrow(BundleError);
    }
    expect(() => discoverBundleUrl(html('https://warappcdn.com/js/Release/ujs.js?v=5&amp;x=1'), PAGE)).toThrow(/query/);
    expect(() => discoverBundleUrl(html('https://warappcdn.com/js/Release/ujs.js?v=5&amp;v=6'), PAGE)).toThrow(/query/);
    expect(() => discoverBundleUrl(html('https://warappcdn.com/js/Release/ujs.js?v=5#frag'), PAGE)).toThrow(/fragment|query/);
  });

  it('refuses a bundle URL that carries no version', () => {
    expect(() => discoverBundleUrl(html('https://warappcdn.com/js/Release/ujs.js'), PAGE)).toThrow(/version/);
  });

  it('rejects a page without the bundle script', () => {
    expect(() => discoverBundleUrl('<html><script src="/other.js"></script></html>', PAGE)).toThrow(BundleError);
  });

  it('rejects a bundle on another host or over http', () => {
    expect(() => discoverBundleUrl(html('https://evil.example/ujs.js?v=1'), PAGE)).toThrow(/host/);
    expect(() => discoverBundleUrl(html('http://warappcdn.com/ujs.js?v=1'), PAGE)).toThrow(/https/);
  });

  it('rejects a version that is not a safe file name', () => {
    // The path is pinned now, so this probe uses the bundle path (it used `/ujs.js`).
    expect(() => discoverBundleUrl(html('https://warappcdn.com/js/Release/ujs.js?v=../../x'), PAGE)).toThrow(/version/);
    expect(() => discoverBundleUrl(html('https://warappcdn.com/js/Release/ujs.js?v=..'), PAGE)).toThrow(/version/);
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

describe('loadBundle cache integrity', () => {
  const bundleFile = (dataDir: string) => join(dataDir, 'bundle', '987.js');
  const digestFile = (dataDir: string) => join(dataDir, 'bundle', '987.js.sha256');
  const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
  const load = (dataDir: string, pages: Record<string, string> = { [PAGE]: html(CDN), [CDN]: MINI_BUNDLE }) => {
    const f = fakeFetch(pages);
    return loadBundle({ dataDir, fetchText: f.fetchText, pageUrl: PAGE }).then((b) => ({ b, calls: f.calls }));
  };

  it('stores the SHA-256 of the downloaded bundle beside it', async () => {
    const dataDir = tempDir();
    await load(dataDir);
    expect(readFileSync(digestFile(dataDir), 'utf8').trim()).toBe(sha256(MINI_BUNDLE));
  });

  it('does not use a cached file changed after it was written: it downloads it again', async () => {
    const dataDir = tempDir();
    await load(dataDir);
    writeFileSync(bundleFile(dataDir), MINI_BUNDLE.replace('turn', 'tvrn'));
    const { b, calls } = await load(dataDir);
    expect(calls).toEqual([PAGE, CDN]);
    expect(readFileSync(bundleFile(dataDir), 'utf8')).toBe(MINI_BUNDLE);
    expect(b.readClass('NE', new Reader(new Writer().int32(3).bytes()))).toMatchObject({ turn: 3 });
  });

  it('downloads again when the stored digest does not match', async () => {
    const dataDir = tempDir();
    await load(dataDir);
    writeFileSync(digestFile(dataDir), sha256('something else'));
    expect((await load(dataDir)).calls).toEqual([PAGE, CDN]);
    expect(readFileSync(digestFile(dataDir), 'utf8').trim()).toBe(sha256(MINI_BUNDLE));
  });

  it('re-runs the content check on load, even when the digest matches', async () => {
    const dataDir = tempDir();
    await load(dataDir);
    writeFileSync(bundleFile(dataDir), '<html>not a bundle</html>');
    writeFileSync(digestFile(dataDir), sha256('<html>not a bundle</html>'));
    expect((await load(dataDir)).calls).toEqual([PAGE, CDN]);
    expect(readFileSync(bundleFile(dataDir), 'utf8')).toBe(MINI_BUNDLE);
  });

  it('re-downloads a cached file with no digest once, then serves it from the cache', async () => {
    const dataDir = tempDir();
    mkdirSync(join(dataDir, 'bundle'), { recursive: true });
    writeFileSync(bundleFile(dataDir), MINI_BUNDLE); // a cache written before digests existed
    expect((await load(dataDir)).calls).toEqual([PAGE, CDN]);
    expect(existsSync(digestFile(dataDir))).toBe(true);
    expect((await load(dataDir, { [PAGE]: html(CDN) })).calls).toEqual([PAGE]);
  });

  it('deletes a cached file that fails verification even when the download then fails', async () => {
    const dataDir = tempDir();
    await load(dataDir);
    writeFileSync(bundleFile(dataDir), MINI_BUNDLE + '// changed');
    await expect(load(dataDir, { [PAGE]: html(CDN) })).rejects.toThrow(/unexpected fetch/);
    expect(existsSync(bundleFile(dataDir))).toBe(false);
    expect(existsSync(digestFile(dataDir))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('writes the bundle and digest 0600 in 0700 directories', async () => {
    const dataDir = join(tempDir(), 'data');
    await load(dataDir);
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(dataDir)).toBe(0o700);
    expect(mode(join(dataDir, 'bundle'))).toBe(0o700);
    expect(mode(bundleFile(dataDir))).toBe(0o600);
    expect(mode(digestFile(dataDir))).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('tightens a data and bundle directory that already exist as 0755', async () => {
    const dataDir = tempDir();
    mkdirSync(join(dataDir, 'bundle'));
    chmodSync(dataDir, 0o755);
    chmodSync(join(dataDir, 'bundle'), 0o755);
    await load(dataDir);
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(dataDir)).toBe(0o700);
    expect(mode(join(dataDir, 'bundle'))).toBe(0o700);
    expect(mode(bundleFile(dataDir))).toBe(0o600);
    expect(mode(digestFile(dataDir))).toBe(0o600);
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

  it('the provider remembers a refused bundle for a while instead of re-reading it on every call', async () => {
    const swapped = 'var W={};var P={};P.Ya=function(a){return a.MGb()};P.uq=function(a){return a.Og()};' + READER;
    let now = 1_000_000;
    const { calls, fetchText } = fakeFetch({ [PAGE]: html(CDN), [CDN]: swapped });
    const p = new BundleProvider({ dataDir: tempDir(), fetchText, pageUrl: PAGE, now: () => now });
    await expect(p.get()).rejects.toMatchObject({ kind: 'dialect-mismatch' });
    await expect(p.get()).rejects.toMatchObject({ kind: 'dialect-mismatch' });
    expect(calls).toEqual([PAGE, CDN]);
    now += 5 * 60_000;
    await expect(p.get()).rejects.toMatchObject({ kind: 'dialect-mismatch' });
    expect(calls).toEqual([PAGE, CDN, PAGE]); // looked up again; the refused version was cached on disk
  });

  it('leaves a helper it cannot evaluate unverified, not refused', () => {
    const b = new WarappBundle('var W={};var P={};P.Td=function(a){return O.N3c(a)};' + READER, 'opaque');
    expect(b.dialectCheck.unverified).toContain('P.Td');
    expect(b.dialectCheck.mismatched).toEqual([]);
  });

  it("runs the bundle's helpers under the interpreter's step budget: a runaway helper is unverified, not a hang", () => {
    const loop = 'var W={};var P={};P.Ya=function(a){for(;;){}};P.uq=function(a){return a.bc()};' + READER;
    const t0 = Date.now();
    const b = new WarappBundle(loop, 'loop', { maxSteps: 50_000, maxIterations: 1e9 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(b.dialectCheck.unverified).toContain('P.Ya');
    expect(b.dialectCheck.mismatched).toEqual([]);
    // The check's budget is its own: a read afterwards starts from a fresh count.
    expect(b.readClass('t.Dx', new Reader(new Writer().u8(7).int32(9).bytes()))).toEqual({ $type: 't.Dx', small: 7, big: 9 });
  });

  it("keeps the bundle's helpers contained during the check", () => {
    // A helper that reaches for a host member is refused inside the interpreter (unverified), never run.
    const b = new WarappBundle('var W={};var P={};P.Ya=function(a){return a.constructor};' + READER, 'escape');
    expect(b.dialectCheck.unverified).toContain('P.Ya');
    expect(b.dialectCheck.mismatched).toEqual([]);
  });

  it('a bundle that defines no helpers (the test bundles) has nothing to check', () => {
    const b = new WarappBundle(MINI_BUNDLE, 'mini');
    expect(b.dialectCheck).toEqual({ verified: [], unverified: [], mismatched: [] });
  });
});

describe('the bundle cache is pruned and survives a failed version lookup (#131)', () => {
  const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
  // A cached `<version>.js` is seeded with its recorded digest, as a download leaves it.
  const seed = (dataDir: string, files: Record<string, string>, mtimeSec?: Record<string, number>) => {
    mkdirSync(join(dataDir, 'bundle'), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      const f = join(dataDir, 'bundle', name);
      writeFileSync(f, body);
      if (name.endsWith('.js')) writeFileSync(`${f}.sha256`, `${sha256(body)}\n`);
      const t = mtimeSec?.[name];
      if (t !== undefined) utimesSync(f, t, t);
    }
  };

  it('keeps only the version in use once it loads', async () => {
    const dataDir = tempDir();
    seed(dataDir, { '111.js': MINI_BUNDLE, '222.js': MINI_BUNDLE, '987.js.tmp-2147483646': 'x', 'notes.txt': 'keep' });
    await loadBundle({ dataDir, fetchText: fakeFetch({ [PAGE]: html(CDN), [CDN]: MINI_BUNDLE }).fetchText, pageUrl: PAGE });
    expect(readdirSync(join(dataDir, 'bundle')).sort()).toEqual(['987.js', '987.js.sha256', 'notes.txt']);
  });

  it("prunes an old bundle's digest with it and an orphaned digest, never the digest in use", async () => {
    const dataDir = tempDir();
    seed(dataDir, { '111.js': MINI_BUNDLE, '333.js.sha256': 'orphan', '987.js.sha256.tmp-2147483646-ab12': 'x' });
    await loadBundle({ dataDir, fetchText: fakeFetch({ [PAGE]: html(CDN), [CDN]: MINI_BUNDLE }).fetchText, pageUrl: PAGE });
    expect(readdirSync(join(dataDir, 'bundle')).sort()).toEqual(['987.js', '987.js.sha256']);
    // The digest kept is the one that verifies the bundle kept: the next load is served from the cache.
    const f = fakeFetch({ [PAGE]: html(CDN) });
    await loadBundle({ dataDir, fetchText: f.fetchText, pageUrl: PAGE });
    expect(f.calls).toEqual([PAGE]);
  });

  // #140: a partial download belongs to whichever process is writing it; pruning it under a live
  // process makes that process's rename fail.
  it("keeps another live process's partial download, prunes a dead process's or a stale one", async () => {
    const dataDir = tempDir();
    const live = `987.js.tmp-${process.ppid}`;
    const dead = '987.js.tmp-2147483646';
    const stale = `988.js.tmp-${process.ppid}`;
    const old = Math.floor(Date.now() / 1000) - 3600;
    seed(dataDir, { [live]: 'x', [dead]: 'x', [stale]: 'x' }, { [stale]: old });
    await loadBundle({ dataDir, fetchText: fakeFetch({ [PAGE]: html(CDN), [CDN]: MINI_BUNDLE }).fetchText, pageUrl: PAGE });
    expect(readdirSync(join(dataDir, 'bundle')).sort()).toEqual(['987.js', '987.js.sha256', live]);
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
    expect(readdirSync(join(dataDir, 'bundle')).sort()).toEqual(['111.js', '111.js.sha256', '222.js', '222.js.sha256']);
  });

  it('falls back only to a copy that still matches its recorded digest', async () => {
    const dataDir = tempDir();
    seed(dataDir, { '111.js': MINI_BUNDLE, '222.js': MINI_BUNDLE, '333.js': MINI_BUNDLE }, {
      '111.js': 1_700_000_000,
      '222.js': 1_700_000_500,
      '333.js': 1_700_001_000,
    });
    // The newest copy changed after it was written, the next one has no digest: neither is loaded.
    writeFileSync(join(dataDir, 'bundle', '333.js'), MINI_BUNDLE + '// changed');
    utimesSync(join(dataDir, 'bundle', '333.js'), 1_700_001_000, 1_700_001_000);
    rmSync(join(dataDir, 'bundle', '222.js.sha256'));
    const fetchText = async () => {
      throw new Error('offline');
    };
    const b = await loadBundle({ dataDir, fetchText, pageUrl: PAGE });
    expect(b.version).toBe('111');
    expect(b.fallback).toBe(true);
    expect(readdirSync(join(dataDir, 'bundle')).sort()).toEqual(['111.js', '111.js.sha256']);
  });

  it('still fails when no cached copy verifies', async () => {
    const dataDir = tempDir();
    seed(dataDir, { '111.js': MINI_BUNDLE });
    writeFileSync(join(dataDir, 'bundle', '111.js.sha256'), sha256('something else'));
    const fetchText = async () => {
      throw new Error('offline');
    };
    await expect(loadBundle({ dataDir, fetchText, pageUrl: PAGE })).rejects.toThrow('offline');
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
