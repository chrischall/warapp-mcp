import { McpToolError } from '@chrischall/mcp-utils';
import { describe, expect, it } from 'vitest';
import { MapCache, WarappClient } from '../src/client.js';
import { bundleFetcher, createLiveContext } from '../src/tools/live-context.js';
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
