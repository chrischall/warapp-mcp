import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import { registerAllTools } from '../src/tools/index.js';
import { PROBE_GAME_ID } from '../src/tools/healthcheck.js';

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
