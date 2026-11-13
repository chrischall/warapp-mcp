// Opt-in per-map statistics: collect finished games, cache them forever (S6).
//
// OFF unless `WARAPP_STATS` is truthy, and ALWAYS off on a hosted child: a
// hosted server makes requests on someone else's machine and quota, and its
// dataDir is not the user's to fill. mcp-host gives this server no explicit
// "hosted" flag, so a hosted child is recognised by the variables only the host
// sets (see {@link HOSTED_MARKERS}); mint.yaml never sets WARAPP_STATS either
// (pinned by tests/packaging.test.ts).
//
// Source: war.app's game-ID feed for a ladder (`WarappClient.getGameIds`), then
// GameFeed with `GetHistory=true` per game (`WarappClient.getGame`) — every
// request through WarappClient. At most `maxNewGames` new games per call, at
// least {@link MIN_GAP_MS} between requests, and a finished game is cached
// forever at `<dataDir>/stats/<mapId>/<gameId>.json` (its compact
// {@link GameRecord}: ids, wins and turn numbers, no names), so a cache hit
// costs no request. A failing game is skipped and counted, never fatal.
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readEnvVar, type EnvSource } from '@chrischall/mcp-utils';
import type { GetGameOptions } from './client.js';
import { recordFromGame, type GameRecord } from './map-stats.js';
import type { Game } from './normalize.js';

/** The opt-in switch. */
export const STATS_ENV = 'WARAPP_STATS';

/**
 * Variables only a hosted child sees: mcp-host's own (its child-env contract —
 * the byte-meter file, the confirm-token key, the blob store) and the
 * platform's machine id. Any one of them set means hosted.
 */
export const HOSTED_MARKERS = [
  'MCP_HOST_METER_FILE',
  'MCP_HOST_CONFIRM_SECRET',
  'MCP_BLOB_BASE_URL',
  'FLY_MACHINE_ID',
] as const;

export const DEFAULT_NEW_GAMES = 10;
export const MAX_NEW_GAMES = 50;
/** The least time between two requests the collector makes. */
export const MIN_GAP_MS = 1000;

const truthy = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());

export function isHosted(env: EnvSource = process.env): boolean {
  return HOSTED_MARKERS.some((k) => readEnvVar(k, { env }) !== undefined);
}

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

export interface CollectorOptions {
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
  /** Fetched games not finished yet (not cached; skipped for the rest of this process). */
  notFinished: number;
  /** Games whose request or parse failed — skipped, not cached. */
  failed: number;
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

async function readRecord(path: string): Promise<GameRecord | undefined> {
  try {
    const r: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isRecord(r) ? r : undefined;
  } catch {
    return undefined;
  }
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
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(r), { mode: 0o600 });
  await rename(tmp, path);
}

/** Collects finished games into the cache. One per process, so the throttle spans calls. */
export class StatsCollector {
  readonly #client: StatsClient;
  readonly #dir: () => string;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Games seen unfinished this process: not worth a request again soon. */
  readonly #unfinished = new Set<number>();
  #last: number | undefined;

  constructor(opts: CollectorOptions) {
    this.#client = opts.client;
    this.#dir = opts.dir;
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Wait until {@link MIN_GAP_MS} has passed since the previous request, then mark this one. */
  async #throttle(): Promise<void> {
    if (this.#last !== undefined) {
      const wait = this.#last + MIN_GAP_MS - this.#now();
      if (wait > 0) await this.#sleep(wait);
    }
    this.#last = this.#now();
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
      remaining: 0,
    };
    for (const id of ids) {
      if (index.has(id)) {
        res.cacheHits++;
        continue;
      }
      if (this.#unfinished.has(id)) {
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
        const game = await this.#client.getGame(id, { history: true, settings: true });
        if (game.state !== 'Finished') {
          this.#unfinished.add(id);
          res.notFinished++;
          continue;
        }
        if (!game.map) throw new Error('no map');
        await writeRecord(dir, recordFromGame(game, game.map));
        res.newlyCached++;
      } catch {
        res.failed++;
      }
    }
    return res;
  }

  /** Every cached record of `mapId`, ascending by game id. No request. */
  async records(mapId: number): Promise<GameRecord[]> {
    const dir = join(statsDir(this.#dir()), String(mapId));
    const out: GameRecord[] = [];
    for (const f of (await names(dir)).sort()) {
      if (!/^\d+\.json$/.test(f)) continue;
      const r = await readRecord(join(dir, f));
      if (r && r.mapId === mapId) out.push(r);
    }
    return out.sort((a, b) => a.gameId - b.gameId);
  }
}
