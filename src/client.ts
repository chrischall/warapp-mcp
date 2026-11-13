// WarappClient — every call to war.app's GameFeed API.
//
//   POST https://war.app/API/GameFeed?GameID=<n>[&GetHistory=true][&GetSettings=true][&GetChat=true][&GetMap=false]
//   body (form): Email=<email>&APIToken=<token>
//
// Failures come back as HTTP 200 JSON `{ termsOfUse, error }`, so the status
// never decides success alone: `Auth failed` is a rejected credential,
// `…ServerGameKeyNotFound` an unknown game. Transport-level trouble (429 /
// 5xx) is retried once by createApiClient.
//
// Config is deferred: credentials are read per call, so the server boots
// without them. The email and token are scrubbed by value from every upstream
// string this module surfaces.
//
// Maps are immutable per map id and large (761 territories on map 39905), and
// the feed's terms ask callers to cache — so a map is kept per process and a
// game whose map is cached is fetched with GetMap=false.

import {
  createApiClient,
  McpToolError,
  truncateErrorMessage,
  type ApiClient,
  type EnvSource,
} from '@chrischall/mcp-utils';
import { readCredentials, TOKEN_URL, WarappConfigError, type WarappCredentials } from './config.js';
import { feedErrorOf, normalizeGame, normalizeMap, type Game, type GameMap } from './normalize.js';
import { asInt } from './scalars.js';

const BASE_URL = 'https://war.app';
const SERVICE = 'war.app';

/** A game id war.app will not have: the largest positive int32. */
export const PROBE_GAME_ID = 2147483647;

/** The hint for a rejected credential. */
export const AUTH_FAILED_HINT =
  `Check WARAPP_EMAIL is the email you sign in to war.app with, and regenerate WARAPP_API_TOKEN at ` +
  `${TOKEN_URL} while signed in — changing your war.app password also rotates the token.`;

/** The game id names no game this player can load. */
export class WarappNotFoundError extends McpToolError {
  readonly code = 'not_found' as const;
  constructor(gameId: number) {
    super(`war.app has no game ${gameId} (ServerGameKeyNotFound).`, {
      kind: 'http',
      status: 404,
      hint: 'Check the game id — it is the number in the game URL (war.app/MultiPlayer?GameID=<n>).',
    });
    this.name = 'WarappNotFoundError';
  }
}

/**
 * A GameFeed game id: a positive whole number below 2^31. Validated locally so
 * a bad id never costs a request (war.app answers `GameID must be an integer`).
 */
export function parseGameId(v: unknown): number {
  const n = typeof v === 'number' || (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) ? asInt(v) : undefined;
  if (n === undefined || n < 1 || n >= 2 ** 31) {
    throw new McpToolError(`Game id must be a positive whole number below 2147483648 (got ${JSON.stringify(String(v)).slice(0, 40)}).`, {
      hint: 'Use the number after GameID= in the game URL.',
    });
  }
  return n;
}

/** Per-process map cache: map id → map, plus game id → map id. */
export class MapCache {
  readonly #maps = new Map<number, GameMap>();
  readonly #gameMaps = new Map<number, number>();

  get(mapId: number): GameMap | undefined {
    return this.#maps.get(mapId);
  }

  set(map: GameMap): void {
    this.#maps.set(map.id, map);
  }

  /** The cached map of a game seen before, if it is still cached. */
  forGame(gameId: number): GameMap | undefined {
    const mapId = this.#gameMaps.get(gameId);
    return mapId === undefined ? undefined : this.#maps.get(mapId);
  }

  rememberGame(gameId: number, mapId: number): void {
    this.#gameMaps.set(gameId, mapId);
  }

  clear(): void {
    this.#maps.clear();
    this.#gameMaps.clear();
  }
}

/** The process-wide default cache. */
export const defaultMapCache = new MapCache();

export interface GetGameOptions {
  /** `GetHistory=true`: past turns (the docs say: once the game is finished). */
  history?: boolean;
  /** `GetSettings=true`: the game's settings (also names its map id). */
  settings?: boolean;
  /** `GetChat=true`: the game chat (third-party text). */
  chat?: boolean;
  /**
   * `false`: never download the map (`GetMap=false`) — for callers that only read the game's
   * state; the map is still attached when cached. Default: download it unless cached.
   */
  map?: boolean;
}

export interface WarappClientOptions {
  env?: EnvSource;
  fetchImpl?: typeof fetch;
  /** Injectable retry sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  mapCache?: MapCache;
  /** Per-attempt timeout, ms. Default 30 s. */
  timeoutMs?: number;
}

export class WarappClient {
  readonly #env: EnvSource | undefined;
  readonly #cache: MapCache;
  readonly #api: ApiClient;
  #secrets: string[] = [];

  constructor(opts: WarappClientOptions = {}) {
    this.#env = opts.env;
    this.#cache = opts.mapCache ?? defaultMapCache;
    this.#api = createApiClient({
      baseUrl: BASE_URL,
      serviceName: SERVICE,
      baseHeaders: { accept: 'application/json' },
      retry: { count: 1, delayMs: 2000, statuses: [429, 500, 502, 503, 504], honorRetryAfter: true },
      redirect: 'same-origin',
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      onUnauthorized: () =>
        new McpToolError('war.app refused the request (HTTP 401).', {
          kind: 'credential_rejected',
          status: 401,
          hint: AUTH_FAILED_HINT,
        }),
      onErrorResponse: ({ status, body }) =>
        new McpToolError(
          `war.app GameFeed answered HTTP ${status}${body.trim() ? `: ${this.#redact(body)}` : ''}`,
          { kind: 'http', status },
        ),
    });
  }

  #redact(text: string): string {
    return truncateErrorMessage(text, 300, { values: this.#secrets });
  }

  #credentials(): WarappCredentials {
    try {
      const creds = readCredentials(this.#env);
      this.#secrets = [creds.token, creds.email];
      return creds;
    } catch (e) {
      if (e instanceof WarappConfigError) {
        throw new McpToolError(e.message, {
          kind: 'no_credential',
          hint: `Set WARAPP_EMAIL and WARAPP_API_TOKEN (token from ${TOKEN_URL}).`,
          cause: e,
        });
      }
      throw e;
    }
  }

  /** One GameFeed call. Returns the parsed body; maps `{ error }` bodies to typed errors. */
  async #feed(gameId: number, flags: GetGameOptions & { noMap?: boolean }): Promise<Record<string, unknown>> {
    const { email, token } = this.#credentials();
    let path = `/API/GameFeed?GameID=${gameId}`;
    if (flags.history) path += '&GetHistory=true';
    if (flags.settings) path += '&GetSettings=true';
    if (flags.chat) path += '&GetChat=true';
    if (flags.noMap) path += '&GetMap=false';
    const body = await this.#api.fetchJson<Record<string, unknown>>('POST', path, {
      rawBody: new URLSearchParams({ Email: email, APIToken: token }).toString(),
      contentType: 'application/x-www-form-urlencoded',
      // A read sent as POST: safe to repeat.
      idempotent: true,
      expect: 'object',
    });
    const error = feedErrorOf(body);
    if (error === undefined) return body;
    if (error === 'Auth failed') {
      throw new McpToolError('war.app rejected the email + API token (Auth failed).', {
        kind: 'credential_rejected',
        hint: AUTH_FAILED_HINT,
      });
    }
    if (/ServerGameKeyNotFound/.test(error)) throw new WarappNotFoundError(gameId);
    throw new McpToolError(`war.app GameFeed error: ${this.#redact(error)}`, { kind: 'http' });
  }

  /**
   * Load a game, normalized. The map comes from the per-process cache when
   * this game's map is already known (fetched with GetMap=false), else from
   * the feed (and is then cached).
   */
  async getGame(id: unknown, opts: GetGameOptions = {}): Promise<Game> {
    const gameId = parseGameId(id);
    const known = this.#cache.forGame(gameId);
    const body = await this.#feed(gameId, { ...opts, noMap: known !== undefined || opts.map === false });
    const game = normalizeGame(body);

    let map = known;
    const rawMap = body.map;
    if (!map && rawMap && typeof rawMap === 'object' && Array.isArray((rawMap as { territories?: unknown }).territories)) {
      const fresh = normalizeMap(rawMap);
      map = this.#cache.get(fresh.id) ?? fresh;
      this.#cache.set(map);
    }
    if (!map && game.settings?.mapId !== undefined) map = this.#cache.get(game.settings.mapId);
    if (map) {
      this.#cache.rememberGame(gameId, map.id);
      game.map = map;
    }
    return game;
  }

  /**
   * The game ids of a ladder or tournament, from war.app's game-ID feed
   * (`/API/GameIDFeed?LadderID=<n>` or `?TournamentID=<n>`, documented on the
   * public wiki page "Game ID feed API": 1v1 ladder 0, 2v2 1, 3v3 4).
   * UNVERIFIED: the wiki names neither the method, the auth nor the reply, so
   * this POSTs the GameFeed credentials (harmless if the feed is public) and
   * reads the ids loosely — a bare array, or `gameIDs` / `gameIds` / `games`,
   * each a number, numeric string or `{ id | gameID }`. Distinct, newest
   * (highest id) first.
   */
  async getGameIds(source: { ladderId: number } | { tournamentId: number }): Promise<number[]> {
    const [key, raw] = 'ladderId' in source ? ['LadderID', source.ladderId] : ['TournamentID', source.tournamentId];
    if (!Number.isInteger(raw) || raw < 0 || raw >= 2 ** 31) {
      throw new McpToolError(`${key} must be a whole number from 0 (got ${String(raw).slice(0, 20)}).`, {
        hint: 'Ladders: 1v1 is 0, 2v2 is 1, 3v3 is 4.',
      });
    }
    const { email, token } = this.#credentials();
    const body = await this.#api.fetchJson<unknown>('POST', `/API/GameIDFeed?${key}=${raw}`, {
      rawBody: new URLSearchParams({ Email: email, APIToken: token }).toString(),
      contentType: 'application/x-www-form-urlencoded',
      idempotent: true,
    });
    const error = Array.isArray(body) ? undefined : feedErrorOf(body);
    if (error === 'Auth failed') {
      throw new McpToolError('war.app rejected the email + API token (Auth failed).', {
        kind: 'credential_rejected',
        hint: AUTH_FAILED_HINT,
      });
    }
    if (error !== undefined) throw new McpToolError(`war.app GameIDFeed error: ${this.#redact(error)}`, { kind: 'http' });
    return gameIdsOf(body);
  }

  /**
   * A map this process has already loaded (with some game), by map id; `undefined`
   * otherwise. GameFeed serves maps only with a game, so this never makes a request.
   */
  cachedMap(mapId: number): GameMap | undefined {
    return this.#cache.get(mapId);
  }

  /**
   * Prove the credentials work without loading a real game: ask for
   * {@link PROBE_GAME_ID}. `ServerGameKeyNotFound` (or, improbably, a game)
   * means authenticated; `Auth failed` throws `credential_rejected`.
   */
  async probeAuth(): Promise<{ authenticated: true }> {
    try {
      await this.#feed(PROBE_GAME_ID, { noMap: true });
    } catch (e) {
      if (!(e instanceof WarappNotFoundError)) throw e;
    }
    return { authenticated: true };
  }
}

/** Game ids out of a GameIDFeed body, in any of the plausible layouts; distinct, descending. */
export function gameIdsOf(body: unknown): number[] {
  const rec = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  const list = Array.isArray(body) ? body : (rec?.gameIDs ?? rec?.gameIds ?? rec?.GameIDs ?? rec?.games);
  if (!Array.isArray(list)) return [];
  const ids = new Set<number>();
  for (const e of list) {
    const v = e && typeof e === 'object' ? ((e as Record<string, unknown>).id ?? (e as Record<string, unknown>).gameID) : e;
    const n = asInt(v);
    if (n !== undefined && n > 0 && n < 2 ** 31) ids.add(n);
  }
  return [...ids].sort((a, b) => b - a);
}
