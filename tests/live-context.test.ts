import { McpToolError } from '@chrischall/mcp-utils';
import { describe, expect, it } from 'vitest';
import { MapCache, WarappClient } from '../src/client.js';
import { BUNDLE_FETCH_TIMEOUT_MS, BUNDLE_MAX_BYTES } from '../src/protocol/bundle.js';
import { bundleFetcher, createLiveContext, parseInviteToken, parseInviteTokenText } from '../src/tools/live-context.js';
import { withToolConfig } from '../src/tools/hints.js';
import { mockWarappBridge } from './bridge-mock.js';

const html = '<html><script src="https://warappcdn.com/js/Release/ujs.js?v=7"></script></html>';

function fetchStub(status: number, text: string) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    urls.push(String(url));
    expect(init?.redirect).toBe('error');
    return new Response(text, { status });
  }) as typeof fetch;
  return { urls, fetchImpl };
}

describe('bundleFetcher', () => {
  it('GETs war.app pages through the bridge and the CDN directly', async () => {
    const { bridge, mock } = mockWarappBridge(() => ({ status: 200, body: html, url: 'https://war.app/' }));
    const cdn = fetchStub(200, 'BUNDLE');
    const get = bundleFetcher(bridge, cdn.fetchImpl);
    expect(await get('https://war.app/')).toBe(html);
    expect(mock.requests).toEqual([{ method: 'GET', path: 'https://war.app/', headers: {}, body: undefined }]);
    expect(await get('https://warappcdn.com/js/Release/ujs.js?v=7')).toBe('BUNDLE');
    expect(cdn.urls).toEqual(['https://warappcdn.com/js/Release/ujs.js?v=7']);
  });

  it('fails on a non-200 from either side', async () => {
    const { bridge } = mockWarappBridge(() => ({ status: 503, body: '', url: 'https://war.app/' }));
    const get = bundleFetcher(bridge, fetchStub(404, '').fetchImpl);
    await expect(get('https://www.war.app/')).rejects.toThrow(/HTTP 503/);
    await expect(get('https://warappcdn.com/x.js')).rejects.toThrow(/warappcdn\.com answered HTTP 404/);
  });
});

describe('bundleFetcher limits', () => {
  const { bridge } = mockWarappBridge(() => ({ status: 200, body: '', url: 'https://war.app/' }));
  const URL_ = 'https://warappcdn.com/js/Release/ujs.js?v=7';

  it('names a timeout and a byte cap comfortably above the ~17 MB bundle', () => {
    expect(BUNDLE_MAX_BYTES).toBeGreaterThanOrEqual(2 * 17_000_000);
    expect(BUNDLE_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('passes an abort signal and keeps redirect: error', async () => {
    let init: RequestInit | undefined;
    const get = bundleFetcher(bridge, (async (_u: string | URL, i?: RequestInit) => {
      init = i;
      return new Response('ok');
    }) as typeof fetch);
    expect(await get(URL_)).toBe('ok');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('decodes the streamed body exactly as res.text() did: a byte-order mark is dropped, a split character is whole', async () => {
    // A BOM, then "é" (2 bytes) split across two chunks.
    const chunks = [new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xc3]), new Uint8Array([0xa9, 0x62])];
    const body = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const k of chunks) c.enqueue(k);
          c.close();
        },
      });
    const get = bundleFetcher(bridge, (async () => new Response(body())) as typeof fetch);
    expect(await get(URL_)).toBe(await new Response(body()).text());
    expect(await get(URL_)).toBe('aéb');
  });

  it('cuts off a body larger than the cap while it streams, without buffering it all', async () => {
    let produced = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        produced += 100;
        c.enqueue(new Uint8Array(100).fill(65));
      },
      cancel() {
        cancelled = true;
      },
    });
    const get = bundleFetcher(bridge, (async () => new Response(endless)) as typeof fetch, { maxBytes: 1000 });
    await expect(get(URL_)).rejects.toThrow(/larger than 1000 bytes/);
    expect(produced).toBeLessThanOrEqual(1000 + 100 * 3);
    expect(cancelled).toBe(true);
  });

  it('refuses up front a declared Content-Length over the cap', async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled = true;
        c.enqueue(new Uint8Array(10));
        c.close();
      },
    }, { highWaterMark: 0 }); // pull only when read
    const res = new Response(body, { headers: { 'content-length': '5000' } });
    const get = bundleFetcher(bridge, (async () => res) as typeof fetch, { maxBytes: 1000 });
    await expect(get(URL_)).rejects.toThrow(/larger than 1000 bytes/);
    expect(pulled).toBe(false);
  });

  it('accepts a body exactly at the cap', async () => {
    const get = bundleFetcher(bridge, (async () => new Response('x'.repeat(1000))) as typeof fetch, { maxBytes: 1000 });
    expect(await get(URL_)).toHaveLength(1000);
  });

  it('fails with a timeout when the fetch never completes', async () => {
    let signal: AbortSignal | undefined;
    const get = bundleFetcher(
      bridge,
      ((_u: string | URL, i?: RequestInit) => {
        signal = i?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }) as typeof fetch,
      { timeoutMs: 20 },
    );
    await expect(get(URL_)).rejects.toThrow(/timed out after 20 ms/);
    expect(signal?.aborted).toBe(true);
  });

  it('fails with a timeout when the body stalls', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(10));
      },
    });
    const get = bundleFetcher(bridge, (async () => new Response(stalled)) as typeof fetch, { timeoutMs: 20 });
    await expect(get(URL_)).rejects.toThrow(/timed out after 20 ms/);
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** A body that trickles one byte per pull, counting pulls and noting a cancel. */
  const trickle = () => {
    const s = { pulls: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        await sleep(5);
        s.pulls++;
        c.enqueue(new Uint8Array(1));
      },
      cancel() {
        s.cancelled = true;
      },
    });
    return { s, body };
  };

  it('stops reading the body once the timeout fires, even when the fetch ignores the abort signal', async () => {
    const { s, body } = trickle();
    const get = bundleFetcher(bridge, (async () => new Response(body)) as typeof fetch, { timeoutMs: 50 });
    await expect(get(URL_)).rejects.toThrow(/timed out after 50 ms/);
    await sleep(10); // let the cancel land
    const atTimeout = s.pulls;
    await sleep(100);
    expect(s.cancelled).toBe(true);
    expect(s.pulls).toBe(atTimeout);
  });

  it('never starts reading a body whose response arrives after the timeout', async () => {
    const { s, body } = trickle();
    const get = bundleFetcher(
      bridge,
      (async () => {
        await sleep(60);
        return new Response(body);
      }) as typeof fetch,
      { timeoutMs: 20 },
    );
    await expect(get(URL_)).rejects.toThrow(/timed out after 20 ms/);
    await sleep(120);
    expect(s.cancelled).toBe(true);
    expect(s.pulls).toBeLessThanOrEqual(1);
  });
});

describe('createLiveContext', () => {
  const client = new WarappClient({ env: {}, mapCache: new MapCache() });

  it('wraps a bundle load failure in a tool error with a hint', async () => {
    const { bridge } = mockWarappBridge(() => ({ status: 200, body: '<html></html>', url: 'https://war.app/' }));
    const ctx = createLiveContext({ client, bridge, env: { MCP_DATA_DIR: '/nonexistent-warapp-test' } });
    const err = await ctx.bundle().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).message).toMatch(/Could not load war\.app's client bundle: no ujs\.js script tag/);
    expect((err as McpToolError).hint).toMatch(/signed-in war\.app tab/);
  });

  it('passes a tool error from the loader through unchanged, and wraps a non-Error', async () => {
    const { bridge } = mockWarappBridge(() => ({ status: 200, body: '', url: '' }));
    const own = new McpToolError('mine');
    const a = createLiveContext({ client, bridge, bundle: () => Promise.reject(own) });
    await expect(a.bundle()).rejects.toBe(own);
    const b = createLiveContext({ client, bridge, bundle: () => Promise.reject('boom') });
    await expect(b.bundle()).rejects.toThrow(/client bundle: boom/);
  });
});

describe('withToolConfig', () => {
  it('restores an own registerTool after registering', () => {
    const seen: unknown[] = [];
    const own = (_n: unknown, cfg: unknown) => seen.push(cfg);
    const server = { registerTool: own };
    withToolConfig(server as never, { title: 'T' }, () => {
      (server as { registerTool: (n: string, c: object) => void }).registerTool('x', { a: 1 });
    });
    expect(seen).toEqual([{ a: 1, title: 'T' }]);
    expect(server.registerTool).toBe(own);
  });
});

describe('invite token (the signed-in account)', () => {
  it('parses the token from the InviteToken page, and nothing from anything else', () => {
    expect(parseInviteToken('<div>Your invite token is 3312345644</div>')).toBe(3312345644);
    expect(parseInviteToken('<html>Sign in</html>')).toBeUndefined();
    expect(parseInviteToken('Your invite token is 99999999999999999999')).toBeUndefined();
  });

  it('keeps the token as text, so a leading 0 check digit survives (#130)', async () => {
    expect(parseInviteToken('Your invite token is 0712345698')).toBe(712345698);
    expect(parseInviteTokenText('Your invite token is 0712345698')).toBe('0712345698');
    const { bridge } = mockWarappBridge(() => ({ status: 200, body: 'Your invite token is 0712345698', url: 'https://war.app/InviteToken' }));
    const client = new WarappClient({ env: {}, fetchImpl: async () => new Response('{}'), mapCache: new MapCache() });
    const ctx = createLiveContext({ client, bridge, bundle: async () => { throw new Error('unused'); } });
    expect(await ctx.myInviteToken()).toBe(712345698);
    expect(await ctx.myInGameId()).toBe(123456);
  });

  it('myIdentity gives the token and the in-game id from ONE read, so both are the same account', async () => {
    let reads = 0;
    const { bridge } = mockWarappBridge(() => {
      reads += 1;
      // Each read answers as another account: two reads would pair one account's token with another's id.
      const token = reads === 1 ? '0712345698' : '5598765499';
      return { status: 200, body: `Your invite token is ${token}`, url: 'https://war.app/InviteToken' };
    });
    const client = new WarappClient({ env: {}, fetchImpl: async () => new Response('{}'), mapCache: new MapCache() });
    const ctx = createLiveContext({ client, bridge, bundle: async () => { throw new Error('unused'); } });
    expect(await ctx.myIdentity({ fresh: true })).toEqual({ token: 712345698, inGameId: 123456 });
    expect(reads).toBe(1);
    expect(await ctx.myIdentity({ fresh: true })).toEqual({ token: 5598765499, inGameId: 987654 });
    expect(reads).toBe(2);
  });

  it('caches a success and retries after a failure', async () => {
    let n = 0;
    const { bridge } = mockWarappBridge(() => {
      n += 1;
      return n === 1
        ? { status: 500, body: '', url: 'https://war.app/InviteToken' }
        : { status: 200, body: 'Your invite token is 3312345644', url: 'https://war.app/InviteToken' };
    });
    const client = new WarappClient({ env: {}, fetchImpl: async () => new Response('{}'), mapCache: new MapCache() });
    const ctx = createLiveContext({ client, bridge, bundle: async () => { throw new Error('unused'); } });
    expect(await ctx.myInviteToken()).toBeUndefined();
    expect(await ctx.myInviteToken()).toBe(3312345644);
    expect(await ctx.myInviteToken()).toBe(3312345644);
    expect(n).toBe(2);
  });
});
