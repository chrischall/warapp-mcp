import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Reader, Writer } from '../../src/protocol/codec.js';
import { BundleError, BundleProvider, discoverBundleUrl, loadBundle } from '../../src/protocol/bundle.js';
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

  it('defaults the page to war.app', async () => {
    const f = fakeFetch({ 'https://war.app/': html(CDN), [CDN]: MINI_BUNDLE });
    await loadBundle({ dataDir: tempDir(), fetchText: f.fetchText });
    expect(f.calls[0]).toBe('https://war.app/');
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
