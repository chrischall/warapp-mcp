// Opt-in per-map statistics: collect finished games, cache them forever (S6).
//
// OFF unless `WARAPP_STATS` is truthy, and ALWAYS off on a hosted child: a
// hosted server makes requests on someone else's machine and quota, and its
// dataDir is not the user's to fill. mcp-host gives this server no explicit
// "hosted" flag, so a hosted child is recognised by the variables only the host
// sets (`HOSTED_MARKERS`, src/hosted.ts); mint.yaml never sets WARAPP_STATS either
// (pinned by tests/packaging.test.ts).
//
// Source: war.app's game-ID feed for a ladder (`WarappClient.getGameIds`), then
// GameFeed with `GetHistory=true` per game (`WarappClient.getGame`, without the map: a map
// already cached is attached by its id, and only a finished game on an uncached map costs one more
// request, for the map) — every request through WarappClient. At most `maxNewGames` new games per call, at
// least {@link MIN_GAP_MS} between requests, and a finished game is cached
// forever at `<dataDir>/stats/<mapId>/<gameId>.json` (its compact
// {@link GameRecord}: ids, wins and turn numbers, no names), so a cache hit
// costs no request. A failing game is skipped and counted, never fatal. A finished
// game whose history does not parse is counted and not cached (#132): cached, it
// would sit in every denominator forever, and a later parser could read it.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readEnvVar, type EnvSource } from '@chrischall/mcp-utils';
import type { GetGameOptions } from './client.js';
import { isHosted } from './hosted.js';
import { readableRecord, recordFromGame, type GameRecord } from './map-stats.js';
import type { Game } from './normalize.js';

// The hosted check is shared (src/hosted.ts); re-exported for existing imports.
export { HOSTED_MARKERS, isHosted } from './hosted.js';

/** The opt-in switch. */
export const STATS_ENV = 'WARAPP_STATS';

export const DEFAULT_NEW_GAMES = 10;
export const MAX_NEW_GAMES = 50;
/** The least time between two requests the collector makes. */
export const MIN_GAP_MS = 1000;
/** How long a game seen unfinished is skipped before it is fetched again. */
export const UNFINISHED_RETRY_MS = 60 * 60 * 1000;

const truthy = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());

export type StatsGate = { enabled: true } | { enabled: false; reason: 'off' | 'hosted' };

/** Whether map statistics may run here. */
export function statsGate(env: EnvSource = process.env): StatsGate {
  if (isHosted(env)) return { enabled: false, reason: 'hosted' };
  return truthy(readEnvVar(STATS_ENV, { env })) ? { enabled: true } : { enabled: false, reason: 'off' };
}

/** What the collector needs of WarappClient. */
export interface StatsClient {
  getGameIds(source: { ladderId: number }): Promise<number[]>;
  getGame(id: number, opts: GetGameOptions): Promise<Game>;
}

interface CollectorOptions {
  client: StatsClient;
  /** The data directory; records go under `<dir>/stats/`. */
  dir: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CollectResult {
  ladderId: number;
  /** Game ids the feed returned. */
  feedGames: number;
  /** Feed games already cached (no request). */
  cacheHits: number;
  /** Games fetched this call (each one request). */
  fetched: number;
  /** Of those, newly cached finished games. */
  newlyCached: number;
  /** Fetched games not finished yet (not cached; skipped for {@link UNFINISHED_RETRY_MS}). */
  notFinished: number;
  /** Games whose request or parse failed — skipped, not cached. */
  failed: number;
  /**
   * Finished games whose history did not parse (no starts read): not cached, and not fetched
   * again this process (counted again on each call, with no request).
   */
  unreadable: number;
  /** Feed games still uncollected after this call's budget. */
  remaining: number;
}

const statsDir = (dir: string) => join(dir, 'stats');
export const recordPath = (dir: string, mapId: number, gameId: number) =>
  join(statsDir(dir), String(mapId), `${gameId}.json`);

const isRecord = (v: unknown): v is GameRecord => {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.gameId === 'number' &&
    typeof r.mapId === 'number' &&
    typeof r.turnsSeen === 'number' &&
    Array.isArray(r.players) &&
    r.players.every(
      (p: unknown) =>
        !!p &&
        typeof p === 'object' &&
        typeof (p as Record<string, unknown>).playerId === 'number' &&
        typeof (p as Record<string, unknown>).won === 'boolean' &&
        Array.isArray((p as Record<string, unknown>).starts),
    )
  );
};

/** One cached record: `undefined` when the file is not there, `null` when it is not a usable record. */
async function parseRecord(path: string): Promise<GameRecord | null | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  let r: unknown;
  try {
    r = JSON.parse(text);
  } catch {
    r = undefined;
  }
  return isRecord(r) && readableRecord(r) ? r : null;
}

/**
 * Read one cached record. A file that reads but is not a valid record is
 * deleted: its name alone counts as a cache hit, so left in place it would
 * never be fetched again and never be counted.
 */
async function readRecord(path: string): Promise<GameRecord | undefined> {
  const r = await parseRecord(path);
  if (r) return r;
  // An unreadable game cached by an older version is dropped too, so it is fetched again (#132).
  if (r === null) await unlink(path).catch(() => undefined);
  return undefined;
}

/** The record files cached for `mapId` (`<dir>/stats/<mapId>/<gameId>.json`), by name. */
async function recordFiles(dir: string, mapId: number): Promise<string[]> {
  const folder = join(statsDir(dir), String(mapId));
  return (await names(folder))
    .filter((f) => /^\d+\.json$/.test(f))
    .sort()
    .map((f) => join(folder, f));
}

/**
 * Every usable record already cached for `mapId` under `dir`, ascending by game id. The cache
 * alone: no request is made, and nothing is written or deleted (a file that is not a usable
 * record is skipped where it is — the collector drops it). For readers outside the collector
 * (warapp_locate_opponents), which call it only when {@link statsGate} allows statistics.
 */
export async function cachedRecords(dir: string, mapId: number): Promise<GameRecord[]> {
  const out: GameRecord[] = [];
  for (const file of await recordFiles(dir, mapId)) {
    const r = await parseRecord(file);
    if (r && r.mapId === mapId) out.push(r);
  }
  return out.sort((a, b) => a.gameId - b.gameId);
}

async function names(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/** Every cached game id → its map id, from the file names alone. */
async function cacheIndex(dir: string): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const m of await names(statsDir(dir))) {
    if (!/^\d+$/.test(m)) continue;
    for (const f of await names(join(statsDir(dir), m))) {
      const g = /^(\d+)\.json$/.exec(f);
      if (g) out.set(Number(g[1]), Number(m));
    }
  }
  return out;
}

async function writeRecord(dir: string, r: GameRecord): Promise<void> {
  const path = recordPath(dir, r.mapId, r.gameId);
  await mkdir(join(statsDir(dir), String(r.mapId)), { recursive: true, mode: 0o700 });
  // Unique per write, so overlapping writes of one record never share (and lose) a temp file.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(r), { mode: 0o600 });
  await rename(tmp, path);
}

/** Collects finished games into the cache. One per process, so the throttle spans calls. */
export class StatsCollector {
  readonly #client: StatsClient;
  readonly #dir: () => string;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Games seen unfinished → when: not worth a request again until {@link UNFINISHED_RETRY_MS} has passed. */
  readonly #unfinished = new Map<number, number>();
  /** Games that failed this process: tried again only after every untried game. */
  readonly #failed = new Set<number>();
  /** Finished games whose history did not parse this process: not fetched again. */
  readonly #unreadable = new Set<number>();
  #last: number | undefined;
  /** The request queue: each throttle waits for the one before it, so overlapping calls never share a slot. */
  #queue: Promise<void> = Promise.resolve();

  constructor(opts: CollectorOptions) {
    this.#client = opts.client;
    this.#dir = opts.dir;
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Wait until {@link MIN_GAP_MS} has passed since the previous request, then
   * mark this one. Slots are granted one at a time through {@link #queue}, so
   * two overlapping `collect()` calls cannot read the same `#last` and wake together.
   */
  #throttle(): Promise<void> {
    const turn = this.#queue.then(async () => {
      if (this.#last !== undefined) {
        const wait = this.#last + MIN_GAP_MS - this.#now();
        if (wait > 0) await this.#sleep(wait);
      }
      this.#last = this.#now();
    });
    this.#queue = turn.catch(() => undefined);
    return turn;
  }

  /** Pull up to `maxNewGames` uncached games from a ladder's feed into the cache. */
  async collect(ladderId: number, maxNewGames: number = DEFAULT_NEW_GAMES): Promise<CollectResult> {
    const budget = Math.max(0, Math.min(MAX_NEW_GAMES, Math.floor(maxNewGames)));
    const dir = this.#dir();
    await this.#throttle();
    const ids = await this.#client.getGameIds({ ladderId });
    const index = await cacheIndex(dir);
    const res: CollectResult = {
      ladderId,
      feedGames: ids.length,
      cacheHits: 0,
      fetched: 0,
      newlyCached: 0,
      notFinished: 0,
      failed: 0,
      unreadable: 0,
      remaining: 0,
    };
    // Newest first, but a game that already failed this process goes last, so a
    // permanently broken game at the head of the feed cannot eat the budget every call.
    const ordered = [...ids.filter((id) => !this.#failed.has(id)), ...ids.filter((id) => this.#failed.has(id))];
    for (const id of ordered) {
      if (index.has(id)) {
        res.cacheHits++;
        continue;
      }
      if (this.#unreadable.has(id)) {
        res.unreadable++;
        continue;
      }
      const seen = this.#unfinished.get(id);
      if (seen !== undefined && this.#now() - seen < UNFINISHED_RETRY_MS) {
        res.notFinished++;
        continue;
      }
      if (res.fetched >= budget) {
        res.remaining++;
        continue;
      }
      res.fetched++;
      try {
        await this.#throttle();
        // No map download (#148): WarappClient attaches a map it has cached for the game's map id
        // (the settings name it), and an unfinished game needs none. Only a finished game on a map
        // not cached yet costs a second request, for the map.
        const game = await this.#client.getGame(id, { history: true, settings: true, map: false });
        if (game.state !== 'Finished') {
          this.#unfinished.set(id, this.#now());
          res.notFinished++;
          continue;
        }
        let map = game.map;
        if (!map) {
          await this.#throttle();
          map = (await this.#client.getGame(id, { settings: true })).map;
        }
        if (!map) throw new Error('no map');
        const record = recordFromGame(game, map);
        if (!readableRecord(record)) {
          this.#unreadable.add(id);
          this.#failed.delete(id);
          res.unreadable++;
          continue;
        }
        await writeRecord(dir, record);
        this.#failed.delete(id);
        this.#unfinished.delete(id);
        res.newlyCached++;
      } catch {
        this.#failed.add(id);
        res.failed++;
      }
    }
    return res;
  }

  /** Every cached record of `mapId`, ascending by game id. No request. */
  async records(mapId: number): Promise<GameRecord[]> {
    const out: GameRecord[] = [];
    for (const file of await recordFiles(this.#dir(), mapId)) {
      const r = await readRecord(file);
      if (r && r.mapId === mapId) out.push(r);
    }
    return out.sort((a, b) => a.gameId - b.gameId);
  }
}
