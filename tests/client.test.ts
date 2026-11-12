import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { McpToolError } from '@chrischall/mcp-utils';
import { MapCache, parseGameId, PROBE_GAME_ID, WarappClient, WarappNotFoundError } from '../src/client.js';

const FIXTURE_TEXT = readFileSync(new URL('./fixtures/gamefeed-lobby-map39905.json', import.meta.url), 'utf8');
const FIXTURE = JSON.parse(FIXTURE_TEXT) as Record<string, unknown>;
const EMAIL = 'player@example.com';
const TOKEN = 'deadbeefcafef00d';
const CREDS = { WARAPP_EMAIL: EMAIL, WARAPP_API_TOKEN: TOKEN };
const noSleep = async () => {};

type Reply = { body: unknown; status?: number };
type Call = { url: string; init: RequestInit };

/** A fetch stub answering each call with the next reply (the last one repeats). */
function stubFetch(...replies: Reply[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function client(fetchImpl: typeof fetch, mapCache = new MapCache(), env: Record<string, string> = CREDS) {
  return new WarappClient({ env, fetchImpl, sleep: noSleep, mapCache });
}

/** The fixture as war.app answers with GetMap=false: an empty map object. */
const WITHOUT_MAP = { ...FIXTURE, map: {} };

async function rejection(p: Promise<unknown>): Promise<McpToolError> {
  try {
    await p;
  } catch (e) {
    return e as McpToolError;
  }
  throw new Error('expected a rejection');
}

describe('parseGameId', () => {
  it('accepts positive int32 integers and numeric strings', () => {
    expect(parseGameId(45670418)).toBe(45670418);
    expect(parseGameId(' 42 ')).toBe(42);
    expect(parseGameId(2 ** 31 - 1)).toBe(2 ** 31 - 1);
  });

  it.each([0, -1, 2 ** 31, 1.5, 'abc', '', '1e3', Number.NaN])('rejects %s', (v) => {
    expect(() => parseGameId(v)).toThrow(McpToolError);
    expect(() => parseGameId(v)).toThrow(/positive whole number/);
  });
});

describe('WarappClient.getGame', () => {
  it('POSTs the form body to GameFeed and normalizes the game, map included', async () => {
    const { calls, fetchImpl } = stubFetch({ body: FIXTURE });
    const game = await client(fetchImpl).getGame(12345678, { settings: true });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://war.app/API/GameFeed?GameID=12345678&GetSettings=true');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(String(init.body)).toBe(new URLSearchParams({ Email: EMAIL, APIToken: TOKEN }).toString());
    expect(game.id).toBe(12345678);
    expect(game.players).toHaveLength(9);
    expect(game.settings?.mapId).toBe(39905);
    expect(game.map?.id).toBe(39905);
    expect(game.map?.territories).toHaveLength(761);
  });

  it('sends GetHistory / GetChat when asked', async () => {
    const { calls, fetchImpl } = stubFetch({ body: FIXTURE });
    await client(fetchImpl).getGame('7', { history: true, settings: true, chat: true });
    expect(calls[0]!.url).toBe('https://war.app/API/GameFeed?GameID=7&GetHistory=true&GetSettings=true&GetChat=true');
  });

  it('caches the map per map id and does not re-fetch it for the same game (GetMap=false)', async () => {
    const { calls, fetchImpl } = stubFetch({ body: FIXTURE }, { body: WITHOUT_MAP });
    const c = client(fetchImpl);
    const first = await c.getGame(12345678);
    const second = await c.getGame(12345678);
    expect(calls[1]!.url).toBe('https://war.app/API/GameFeed?GameID=12345678&GetMap=false');
    expect(second.map).toBe(first.map);
  });

  it('shares the cache across clients (one per process by default)', async () => {
    const cache = new MapCache();
    const a = stubFetch({ body: FIXTURE });
    await client(a.fetchImpl, cache).getGame(12345678);
    const b = stubFetch({ body: WITHOUT_MAP });
    const game = await client(b.fetchImpl, cache).getGame(12345678);
    expect(b.calls[0]!.url).toContain('GetMap=false');
    expect(game.map?.id).toBe(39905);
  });

  it('uses a cached map for a new game when settings name the map id', async () => {
    const cache = new MapCache();
    await client(stubFetch({ body: FIXTURE }).fetchImpl, cache).getGame(12345678);
    // A different game on the same map: the map is fetched again (its id is not
    // known before the call), but the cached copy is reused.
    const other = { ...FIXTURE, id: '999' };
    const { fetchImpl } = stubFetch({ body: other });
    const game = await client(fetchImpl, cache).getGame(999, { settings: true });
    expect(game.map).toBe(cache.get(39905));
  });

  it('leaves map undefined when the feed sends none and nothing is cached', async () => {
    const { fetchImpl } = stubFetch({ body: WITHOUT_MAP });
    const game = await client(fetchImpl).getGame(12345678);
    expect(game.map).toBeUndefined();
  });

  it('fetches the map again when the game is known but its map fell out of the cache', async () => {
    const cache = new MapCache();
    const { calls, fetchImpl } = stubFetch({ body: FIXTURE });
    const c = client(fetchImpl, cache);
    await c.getGame(12345678);
    cache.clear();
    await c.getGame(12345678);
    expect(calls[1]!.url).not.toContain('GetMap');
  });

  it('rejects an invalid game id before any request', async () => {
    const { calls, fetchImpl } = stubFetch({ body: FIXTURE });
    await expect(client(fetchImpl).getGame(0)).rejects.toThrow(/positive whole number/);
    expect(calls).toHaveLength(0);
  });

  it('maps "Auth failed" to credential_rejected with the regenerate hint, never echoing the token', async () => {
    const { fetchImpl } = stubFetch({ body: { termsOfUse: 'x', error: 'Auth failed' } });
    const err = await rejection(client(fetchImpl).getGame(1));
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.kind).toBe('credential_rejected');
    expect(err.hint).toContain('https://war.app/API/GetAPIToken');
    expect(err.hint).toMatch(/password/);
    expect(`${err.message} ${err.hint}`).not.toContain(TOKEN);
  });

  it('maps ServerGameKeyNotFound to not_found', async () => {
    const { fetchImpl } = stubFetch({
      body: { termsOfUse: 'x', error: 'Loading the game produced an error: ServerGameKeyNotFound' },
    });
    const err = await rejection(client(fetchImpl).getGame(5));
    expect(err).toBeInstanceOf(WarappNotFoundError);
    expect((err as WarappNotFoundError).code).toBe('not_found');
    expect(err.message).toContain('5');
  });

  it('surfaces any other error string as an upstream error, redacted', async () => {
    const { fetchImpl } = stubFetch({ body: { error: `Something broke for ${EMAIL} / ${TOKEN}` } });
    const err = await rejection(client(fetchImpl).getGame(1));
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.kind).toBe('http');
    expect(err.message).toContain('Something broke');
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(EMAIL);
  });

  it('reports missing credentials as no_credential without a request', async () => {
    const { calls, fetchImpl } = stubFetch({ body: FIXTURE });
    const err = await rejection(client(fetchImpl, new MapCache(), {}).getGame(1));
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.kind).toBe('no_credential');
    expect(err.message).toContain('WARAPP_EMAIL');
    expect(calls).toHaveLength(0);
  });

  it('retries a 503 once, then succeeds', async () => {
    const { calls, fetchImpl } = stubFetch({ body: 'down', status: 503 }, { body: FIXTURE });
    const game = await client(fetchImpl).getGame(12345678);
    expect(calls).toHaveLength(2);
    expect(game.id).toBe(12345678);
  });

  it('fails with a redacted http error when a 5xx persists', async () => {
    const { calls, fetchImpl } = stubFetch({ body: `bad ${TOKEN}`, status: 500 });
    const err = await rejection(client(fetchImpl).getGame(1));
    expect(calls).toHaveLength(2);
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.status).toBe(500);
    expect(err.message).not.toContain(TOKEN);
  });

  it('maps an HTTP 401 to credential_rejected', async () => {
    const { fetchImpl } = stubFetch({ body: 'no', status: 401 });
    const err = await rejection(client(fetchImpl).getGame(1));
    expect(err.kind).toBe('credential_rejected');
  });

  it('rejects a non-JSON 200 body', async () => {
    const { fetchImpl } = stubFetch({ body: '<html>hi</html>' });
    await expect(client(fetchImpl).getGame(1)).rejects.toThrow();
  });
});

describe('WarappClient.probeAuth', () => {
  it('asks for the nonexistent probe game without its map', async () => {
    const { calls, fetchImpl } = stubFetch({ body: { error: 'Loading the game produced an error: ServerGameKeyNotFound' } });
    await expect(client(fetchImpl).probeAuth()).resolves.toEqual({ authenticated: true });
    expect(calls[0]!.url).toBe(`https://war.app/API/GameFeed?GameID=${PROBE_GAME_ID}&GetMap=false`);
  });

  it('is authenticated when the probe game exists', async () => {
    const { fetchImpl } = stubFetch({ body: { id: '1', state: 'Finished' } });
    await expect(client(fetchImpl).probeAuth()).resolves.toEqual({ authenticated: true });
  });

  it('rejects on Auth failed', async () => {
    const { fetchImpl } = stubFetch({ body: { error: 'Auth failed' } });
    const err = await rejection(client(fetchImpl).probeAuth());
    expect(err.kind).toBe('credential_rejected');
  });
});
