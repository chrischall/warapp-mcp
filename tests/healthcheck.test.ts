import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import { registerAllTools } from '../src/tools/index.js';
import { BRIDGE_PROBE_PATH, PROBE_GAME_ID } from '../src/tools/healthcheck.js';
import { mockWarappBridge } from './bridge-mock.js';

const EMAIL = 'player@example.com';
const TOKEN = 'deadbeefcafef00d';
const CREDS = { WARAPP_EMAIL: EMAIL, WARAPP_API_TOKEN: TOKEN };

type Call = { url: string; init: RequestInit };

function stubFetch(body: unknown, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function check(env: Record<string, string>, fetchImpl: typeof fetch) {
  harness = await createTestHarness((s) => registerAllTools(s, { env, fetchImpl, sleep: async () => {} }));
  const res = await harness.client.callTool({ name: 'warapp_healthcheck', arguments: {} });
  const text = (res.content as Array<{ text: string }>)[0]!.text;
  return { text, body: parseToolResult<{ ok: boolean; credential: { source: string | null }; error?: { kind: string; message: string }; hint: string }>(res as never) };
}

describe('warapp_healthcheck', () => {
  it('is registered, read-only', async () => {
    harness = await createTestHarness((s) => registerAllTools(s, { env: {} }));
    const { tools } = await harness.client.listTools();
    const hc = tools.find((t) => t.name === 'warapp_healthcheck');
    expect(hc).toBeDefined();
    expect(hc!.annotations?.readOnlyHint).toBe(true);
  });

  it('skips the probe and reports no_credential without credentials', async () => {
    const { calls, fetchImpl } = stubFetch({});
    const { body } = await check({}, fetchImpl);
    expect(body.ok).toBe(false);
    expect(body.credential.source).toBeNull();
    expect(body.error?.kind).toBe('no_credential');
    expect(calls).toHaveLength(0);
  });

  it('is healthy when the API authenticates and reports the probe game as not found', async () => {
    const { calls, fetchImpl } = stubFetch({
      termsOfUse: 'x',
      error: 'Loading the game produced an error: ServerGameKeyNotFound',
    });
    const { body, text } = await check(CREDS, fetchImpl);
    expect(body.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(`https://war.app/API/GameFeed?GameID=${PROBE_GAME_ID}&GetMap=false`);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(String(init.body)).toBe(new URLSearchParams({ Email: EMAIL, APIToken: TOKEN }).toString());
    expect(text).not.toContain(TOKEN);
  });

  it('reports credential_rejected on "Auth failed" with the regenerate hint', async () => {
    const { fetchImpl } = stubFetch({ termsOfUse: 'x', error: 'Auth failed' });
    const { body, text } = await check(CREDS, fetchImpl);
    expect(body.ok).toBe(false);
    expect(body.error?.kind).toBe('credential_rejected');
    expect(body.hint).toContain('https://war.app/API/GetAPIToken');
    expect(text).not.toContain(TOKEN);
  });

  it('is healthy if the probe game happens to exist (auth is still proven)', async () => {
    const { fetchImpl } = stubFetch({ id: String(PROBE_GAME_ID), state: 'Finished' });
    const { body } = await check(CREDS, fetchImpl);
    expect(body.ok).toBe(true);
  });

  it('fails with the upstream error, redacted, for any other error string', async () => {
    const { fetchImpl } = stubFetch({ error: `Something broke for ${TOKEN}` });
    const { body, text } = await check(CREDS, fetchImpl);
    expect(body.ok).toBe(false);
    expect(body.error?.kind).not.toBe('credential_rejected');
    expect(text).not.toContain(TOKEN);
  });

  it('fails on an HTTP error status (after one retry)', async () => {
    const { fetchImpl } = stubFetch('oops', 503);
    const { body } = await check(CREDS, fetchImpl);
    expect(body.ok).toBe(false);
  });

  it('fails on a non-JSON body', async () => {
    const { fetchImpl } = stubFetch('<html>not json</html>');
    const { body } = await check(CREDS, fetchImpl);
    expect(body.ok).toBe(false);
  });
});

describe('warapp_healthcheck with the browser bridge', () => {
  const page = () => ({ status: 200, body: '<html>war.app</html>', url: 'https://war.app/' });

  it('names both paths in its description', async () => {
    const { bridge } = mockWarappBridge(page);
    harness = await createTestHarness((s) => registerAllTools(s, { env: {}, bridge }));
    const { tools } = await harness.client.listTools();
    const hc = tools.find((t) => t.name === 'warapp_healthcheck')!;
    expect(hc.description).toMatch(/bridge/i);
  });

  it('answers from the credential arm, without touching the bridge, until the bridge carries a request', async () => {
    const { bridge, mock } = mockWarappBridge(page);
    const { calls, fetchImpl } = stubFetch({ error: 'Loading the game produced an error: ServerGameKeyNotFound' });
    harness = await createTestHarness((s) =>
      registerAllTools(s, { env: CREDS, fetchImpl, sleep: async () => {}, bridge }),
    );
    const res = await harness.client.callTool({ name: 'warapp_healthcheck', arguments: {} });
    const body = parseToolResult<{ ok: boolean; bridge?: unknown }>(res as never);
    expect(body.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(mock.requests).toHaveLength(0);
    expect(mock.listenCalls).toBe(0);
  });

  it('answers from the bridge arm once the bridge is in use, probing war.app through the tab', async () => {
    const { bridge, mock } = mockWarappBridge(page);
    await (await bridge.ready()).fetch({ method: 'GET', path: '/x' });
    const { calls, fetchImpl } = stubFetch({});
    harness = await createTestHarness((s) => registerAllTools(s, { env: CREDS, fetchImpl, bridge }));
    const res = await harness.client.callTool({ name: 'warapp_healthcheck', arguments: {} });
    const body = parseToolResult<{ ok: boolean; bridge?: { role: string } }>(res as never);
    expect(body.ok).toBe(true);
    expect(body.bridge?.role).toBe('host');
    expect(calls).toHaveLength(0);
    expect(mock.requests.at(-1)).toMatchObject({ method: 'GET', path: BRIDGE_PROBE_PATH });
  });

  it('reports a failing bridge probe on an HTTP error page', async () => {
    const { bridge } = mockWarappBridge((req) =>
      req.path === BRIDGE_PROBE_PATH ? { status: 503, body: 'down', url: 'https://war.app/' } : page(),
    );
    await (await bridge.ready()).fetch({ method: 'GET', path: '/x' });
    harness = await createTestHarness((s) => registerAllTools(s, { env: CREDS, bridge }));
    const res = await harness.client.callTool({ name: 'warapp_healthcheck', arguments: {} });
    const body = parseToolResult<{ ok: boolean; error?: { message: string } }>(res as never);
    expect(body.ok).toBe(false);
    expect(body.error?.message).toContain('503');
  });
});
