import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpToolError } from '@chrischall/mcp-utils';
import { MAX_MAP_AGE_MS, MAX_STORED_MAPS, mapStorePath, readGameMapId, readStoredMap, rememberGameMap, writeStoredMap } from '../src/map-store.js';
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

function client(fetchImpl: typeof fetch, mapCache = new MapCache(), env: Record<string, string> = CREDS, dataDir?: string) {
  return new WarappClient({ env, fetchImpl, sleep: noSleep, mapCache, ...(dataDir ? { dataDir: () => dataDir } : {}) });
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

  it('fetches an unseen game without its map when asked (map: false) (#131)', async () => {
    const { calls, fetchImpl } = stubFetch({ body: WITHOUT_MAP });
    const game = await client(fetchImpl).getGame(12345678, { map: false });
    expect(calls[0]!.url).toBe('https://war.app/API/GameFeed?GameID=12345678&GetMap=false');
    expect(game.map).toBeUndefined();
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

  describe('with a data directory (the persistent map store)', () => {
    const tmp = () => mkdtempSync(join(tmpdir(), 'warapp-client-maps-'));

    it('writes a map read with GetMap to <dir>/maps/<mapId>.json, base values, and the game to the index', async () => {
      const dir = tmp();
      const game = await client(stubFetch({ body: FIXTURE }).fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      expect(await readStoredMap(dir, 39905)).toEqual(game.map);
      expect(await readGameMapId(dir, 12345678)).toBe(39905);
    });

    it('after a restart (a fresh MapCache) asks a known game GetMap=false and attaches the stored map', async () => {
      const dir = tmp();
      const first = await client(stubFetch({ body: FIXTURE }).fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      const { calls, fetchImpl } = stubFetch({ body: WITHOUT_MAP });
      const cache = new MapCache();
      const again = await client(fetchImpl, cache, CREDS, dir).getGame(12345678);
      expect(calls[0]!.url).toBe('https://war.app/API/GameFeed?GameID=12345678&GetMap=false');
      expect(again.map).toEqual(first.map);
      expect(cache.get(39905)).toBe(again.map);
    });

    it('attaches the stored map to a new game whose settings name it, without a download', async () => {
      const dir = tmp();
      await client(stubFetch({ body: FIXTURE }).fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      const { calls, fetchImpl } = stubFetch({ body: { ...WITHOUT_MAP, id: '999' } });
      const game = await client(fetchImpl, new MapCache(), CREDS, dir).getGame(999, { settings: true, map: false });
      expect(calls[0]!.url).toContain('GetMap=false');
      expect(game.map?.id).toBe(39905);
      // A caller that never uses the map always asks GetMap=false: no index entry is spent on it.
      expect(await readGameMapId(dir, 999)).toBeUndefined();
    });

    it('downloads the map again (GetMap) for a known game once the stored copy is older than the maximum age', async () => {
      const dir = tmp();
      await client(stubFetch({ body: FIXTURE }).fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      const path = join(dir, 'maps', '39905.json');
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { storedAt: number };
      raw.storedAt -= MAX_MAP_AGE_MS + 1;
      writeFileSync(path, JSON.stringify(raw));
      const { calls, fetchImpl } = stubFetch({ body: FIXTURE });
      await client(fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      expect(calls[0]!.url).not.toContain('GetMap');
      const fresh = JSON.parse(readFileSync(path, 'utf8')) as { storedAt: number };
      expect(Date.now() - fresh.storedAt).toBeLessThan(60_000);
    });

    it('spends no index entry on a finished game (map statistics read many)', async () => {
      const dir = tmp();
      const game = await client(stubFetch({ body: { ...FIXTURE, state: 'Finished' } }).fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      expect(game.map?.id).toBe(39905);
      expect(await readGameMapId(dir, 12345678)).toBeUndefined();
    });

    it('downloads the map again when the stored file is bad, and replaces it', async () => {
      const dir = tmp();
      await client(stubFetch({ body: FIXTURE }).fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      writeFileSync(join(dir, 'maps', '39905.json'), 'garbage');
      const { calls, fetchImpl } = stubFetch({ body: FIXTURE });
      const game = await client(fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      expect(calls[0]!.url).not.toContain('GetMap');
      expect(await readStoredMap(dir, 39905)).toEqual(game.map);
    });

    it('still serves the game when the data directory cannot be written', async () => {
      const dir = tmp();
      writeFileSync(join(dir, 'maps'), 'a file, not a folder');
      const game = await client(stubFetch({ body: FIXTURE }).fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      expect(game.map?.id).toBe(39905);
    });

    it(`keeps the map of a game served from memory while ${MAX_STORED_MAPS + 5} other maps are stored (replay needs it)`, async () => {
      const dir = tmp();
      const { fetchImpl } = stubFetch({ body: FIXTURE }, { body: WITHOUT_MAP });
      const c = client(fetchImpl, new MapCache(), CREDS, dir);
      await c.getGame(12345678);
      const path = mapStorePath(dir, 39905);
      const now = Date.now() / 1000;
      utimesSync(path, now - 10_000, now - 10_000);
      for (let i = 1; i <= MAX_STORED_MAPS + 5; i++) {
        await writeStoredMap(dir, { id: i, name: `Other ${i}`, territories: [], bonuses: [], distributionModes: [] });
        utimesSync(mapStorePath(dir, i), now - 5_000 + i, now - 5_000 + i);
        // The active game is read again; its map is a memory hit.
        await c.getGame(12345678);
      }
      expect(existsSync(path)).toBe(true);
      expect(await readStoredMap(dir, 39905)).toBeDefined();
    });

    it('stores the map again on a memory hit when its file has gone', async () => {
      const dir = tmp();
      const { fetchImpl } = stubFetch({ body: FIXTURE }, { body: WITHOUT_MAP });
      const c = client(fetchImpl, new MapCache(), CREDS, dir);
      const game = await c.getGame(12345678);
      const { unlinkSync } = await import('node:fs');
      unlinkSync(mapStorePath(dir, 39905));
      await c.getGame(12345678);
      expect(await readStoredMap(dir, 39905)).toEqual(game.map);
    });

    it('moves a game read back from the index after a restart to the newest entry', async () => {
      const dir = tmp();
      await client(stubFetch({ body: FIXTURE }).fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      await rememberGameMap(dir, 777, 1);
      await client(stubFetch({ body: WITHOUT_MAP }).fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      const index = JSON.parse(readFileSync(join(dir, 'maps', 'games.json'), 'utf8')) as { games: number[][] };
      expect(index.games.at(-1)).toEqual([12345678, 39905]);
    });

    it('downloads the map again when the feed names a territory the stored map lacks (an edited map)', async () => {
      const dir = tmp();
      await client(stubFetch({ body: FIXTURE }).fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      const map = FIXTURE.map as { territories: Record<string, unknown>[] };
      const added = { ...map.territories[0]!, id: 999_999_999, name: 'New land' };
      const edited = { ...FIXTURE, map: { ...map, territories: [...map.territories, added] } };
      const standing = { '999999999': { armies: 2 } };
      const { calls, fetchImpl } = stubFetch({ body: { ...WITHOUT_MAP, standing } }, { body: { ...edited, standing } });
      const game = await client(fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.url).toContain('GetMap=false');
      expect(calls[1]!.url).not.toContain('GetMap');
      expect(game.map?.territories.some((t) => t.id === 999_999_999)).toBe(true);
      expect((await readStoredMap(dir, 39905))?.territories.some((t) => t.id === 999_999_999)).toBe(true);
    });

    it('downloads an edited map at most once per process, even if the new copy still lacks the territory', async () => {
      const dir = tmp();
      await client(stubFetch({ body: FIXTURE }).fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      const standing = { '999999999': { armies: 2 } };
      const { calls, fetchImpl } = stubFetch({ body: { ...WITHOUT_MAP, standing } }, { body: { ...FIXTURE, standing } }, { body: { ...WITHOUT_MAP, standing } });
      const c = client(fetchImpl, new MapCache(), CREDS, dir);
      await c.getGame(12345678);
      await c.getGame(12345678);
      expect(calls).toHaveLength(3);
      expect(calls[2]!.url).toContain('GetMap=false');
    });

    it('keeps the first read and the stored map when the edited-map download fails', async () => {
      const dir = tmp();
      await client(stubFetch({ body: FIXTURE }).fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      const standing = { '999999999': { armies: 2 } };
      const { fetchImpl } = stubFetch({ body: { ...WITHOUT_MAP, standing } }, { body: { termsOfUse: 'x', error: 'Something broke' } });
      const game = await client(fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      expect(game.map?.id).toBe(39905);
    });

    it('keeps the stored map when every territory the feed names is on it', async () => {
      const dir = tmp();
      await client(stubFetch({ body: FIXTURE }).fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      const first = (FIXTURE.map as { territories: { id: unknown }[] }).territories[0]!.id;
      const { calls, fetchImpl } = stubFetch({ body: { ...WITHOUT_MAP, standing: { [String(first)]: { armies: 2 } } } });
      await client(fetchImpl, new MapCache(), CREDS, dir).getGame(12345678);
      expect(calls).toHaveLength(1);
    });

    it('does not rewrite the store for a map and game already known in this process', async () => {
      const dir = tmp();
      const cache = new MapCache();
      const { fetchImpl } = stubFetch({ body: FIXTURE }, { body: WITHOUT_MAP });
      const c = client(fetchImpl, cache, CREDS, dir);
      await c.getGame(12345678);
      writeFileSync(join(dir, 'maps', '39905.json'), 'garbage');
      await c.getGame(12345678);
      expect(await readStoredMap(dir, 39905)).toBeUndefined();
    });
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

  it('redacts the email and token from an upstream page echoing the form-encoded request body', async () => {
    // Made-up credentials whose encoded spellings differ from the raw ones.
    const email = 'first.last+wz@example.com';
    const token = 'Ab$12*xyz#tok/3n+Z=';
    const encToken = encodeURIComponent(token);
    const echo = `<html>Bad request: Email=first.last%2Bwz%40example.com&APIToken=${encToken}</html>`;
    const { fetchImpl } = stubFetch({ body: echo, status: 400 });
    const err = await rejection(client(fetchImpl, new MapCache(), { WARAPP_EMAIL: email, WARAPP_API_TOKEN: token }).getGame(1));
    expect(err.message).toContain('Bad request');
    expect(err.message).not.toContain('first.last%2Bwz%40example.com');
    expect(err.message).not.toContain(encToken);
    expect(err.message).not.toContain('xyz');
    expect(err.message).not.toContain('wz');
  });

  it('redacts a form-encoded token and an email in another letter case from an { error } body', async () => {
    const token = 'tok en/with+plus';
    const formToken = new URLSearchParams({ v: token }).toString().slice(2);
    const { fetchImpl } = stubFetch({ body: { error: `Bad pair (${EMAIL.toUpperCase()} / ${formToken})` } });
    const err = await rejection(client(fetchImpl, new MapCache(), { WARAPP_EMAIL: EMAIL, WARAPP_API_TOKEN: token }).getGame(1));
    expect(err.message).toContain('Bad pair');
    expect(err.message.toLowerCase()).not.toContain(EMAIL);
    expect(err.message).not.toContain(formToken);
    expect(err.message).not.toContain('with');
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

describe('WarappClient.getGameIds (GameIDFeed — response shape UNVERIFIED)', () => {
  it('POSTs /API/GameIDFeed?LadderID=<n> with the credentials and reads the ids', async () => {
    const { calls, fetchImpl } = stubFetch({ body: { gameIDs: [3, '1', 2, 2] } });
    expect(await client(fetchImpl).getGameIds({ ladderId: 0 })).toEqual([3, 2, 1]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://war.app/API/GameIDFeed?LadderID=0');
    expect(calls[0]!.init.method).toBe('POST');
    expect(String(calls[0]!.init.body)).toBe(`Email=${encodeURIComponent(EMAIL)}&APIToken=${TOKEN}`);
  });

  it('accepts the plausible layouts: a bare array, gameIds, games of {id}', async () => {
    for (const body of [[5, 4], { gameIds: ['4', '5'] }, { games: [{ id: 4 }, { gameID: '5' }] }]) {
      const { fetchImpl } = stubFetch({ body });
      expect(await client(fetchImpl).getGameIds({ ladderId: 1 })).toEqual([5, 4]);
    }
  });

  it('names a tournament instead of a ladder', async () => {
    const { calls, fetchImpl } = stubFetch({ body: { gameIDs: [] } });
    await client(fetchImpl).getGameIds({ tournamentId: 1234 });
    expect(calls[0]!.url).toBe('https://war.app/API/GameIDFeed?TournamentID=1234');
  });

  it('maps an { error } body and scrubs the token from it', async () => {
    const { fetchImpl } = stubFetch({ body: { error: `bad ladder for ${TOKEN}` } });
    const e = await rejection(client(fetchImpl).getGameIds({ ladderId: 99 }));
    expect(e).toBeInstanceOf(McpToolError);
    expect(e.message).toMatch(/GameIDFeed/);
    expect(e.message).not.toContain(TOKEN);
  });

  it('refuses a bad ladder id without a request', async () => {
    const { calls, fetchImpl } = stubFetch({ body: [] });
    await rejection(client(fetchImpl).getGameIds({ ladderId: -1 }));
    expect(calls).toHaveLength(0);
  });
});
