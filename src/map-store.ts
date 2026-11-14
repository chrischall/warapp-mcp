// The persistent map store: GameFeed maps by map id, so a known map is not downloaded again after a
// restart and the cached boards (`<dataDir>/boards/`) can be replayed offline (src/replay.ts).
//
// - `<dataDir>/maps/<mapId>.json`: `{ version: 1, map }`, the map exactly as `MapCache` holds it
//   (normalized: territories with adjacency, bonuses with their BASE values — overrides are per game
//   and applied by `mapOf`). Maps are public data. At most MAX_STORED_MAPS files; the least recently
//   used (file mtime, touched on every read) is evicted on a write.
// - `<dataDir>/maps/games.json`: `{ version: 1, games: [[gameId, mapId], …] }`, newest last, at most
//   MAX_GAME_INDEX entries — which map a game is on, so a game seen before a restart is still asked
//   `GetMap=false`.
//
// Files are 0600 in a 0700 folder and written atomically; every read is loose (a bad file is ignored,
// and replaced by the next write) and nothing here throws. Another process sharing the data directory
// may lose an index entry to a concurrent write, which only costs one map download.

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bonus, DistributionMode, GameMap, Territory } from './normalize.js';
import { withPathLock } from './path-lock.js';

/** Maps kept on disk; the least recently used goes first. */
export const MAX_STORED_MAPS = 40;
/** Game → map entries kept in the index; the oldest goes first. */
export const MAX_GAME_INDEX = 500;

const VERSION = 1;
const MAP_FILE = /^\d+\.json$/;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isIntArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(isInt);

export const mapsDir = (dir: string) => join(dir, 'maps');
export const mapStorePath = (dir: string, mapId: number) => join(mapsDir(dir), `${mapId}.json`);
const indexPath = (dir: string) => join(mapsDir(dir), 'games.json');

/** Write `body` as JSON at `path` atomically (0600; folder 0700). */
export async function writeJsonAtomic(path: string, folder: string, body: unknown): Promise<void> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

function territoryOf(t: unknown): Territory | undefined {
  if (!isRec(t) || !isInt(t.id) || typeof t.name !== 'string' || !isIntArray(t.connectedTo)) return undefined;
  const out: Territory = { id: t.id, name: t.name, connectedTo: t.connectedTo };
  if (isRec(t.coords) && typeof t.coords.x === 'number' && typeof t.coords.y === 'number') out.coords = { x: t.coords.x, y: t.coords.y };
  return out;
}

function bonusOf(b: unknown): Bonus | undefined {
  if (!isRec(b) || !isInt(b.id) || typeof b.name !== 'string' || !isInt(b.value)) return undefined;
  if (!isIntArray(b.territoryIds) || !isIntArray(b.bonusIds)) return undefined;
  const out: Bonus = { id: b.id, name: b.name, value: b.value, territoryIds: b.territoryIds, bonusIds: b.bonusIds };
  if (isIntArray(b.unknownIds) && b.unknownIds.length) out.unknownIds = b.unknownIds;
  return out;
}

function modeOf(d: unknown): DistributionMode | undefined {
  if (!isRec(d) || !isInt(d.id) || typeof d.name !== 'string') return undefined;
  const out: DistributionMode = { id: d.id, name: d.name };
  if (typeof d.type === 'string') out.type = d.type;
  return out;
}

/** Every element of `xs` read by `f`, or `undefined` when any is unreadable. */
function all<T>(xs: unknown, f: (x: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(xs)) return undefined;
  const out: T[] = [];
  for (const x of xs) {
    const v = f(x);
    if (v === undefined) return undefined;
    out.push(v);
  }
  return out;
}

/** A stored map, read strictly enough that the planner can trust it; `undefined` when anything is off. */
function storedMapOf(raw: unknown, mapId: number): GameMap | undefined {
  if (!isRec(raw) || raw.version !== VERSION || !isRec(raw.map)) return undefined;
  const m = raw.map;
  if (m.id !== mapId || typeof m.name !== 'string') return undefined;
  const territories = all(m.territories, territoryOf);
  const bonuses = all(m.bonuses, bonusOf);
  const distributionModes = all(m.distributionModes, modeOf);
  if (!territories || !bonuses || !distributionModes) return undefined;
  return { id: mapId, name: m.name, territories, bonuses, distributionModes };
}

/** The map stored for `mapId`, marking it recently used; `undefined` when absent or unusable. Never throws. */
export async function readStoredMap(dir: string, mapId: number): Promise<GameMap | undefined> {
  const path = mapStorePath(dir, mapId);
  try {
    const map = storedMapOf(JSON.parse(await readFile(path, 'utf8')), mapId);
    if (map) {
      const now = new Date();
      await utimes(path, now, now).catch(() => {});
    }
    return map;
  } catch {
    return undefined;
  }
}

/** Delete the least recently used maps beyond {@link MAX_STORED_MAPS}, keeping `keep`. Best effort. */
async function evictMaps(dir: string, keep: number): Promise<void> {
  const folder = mapsDir(dir);
  const files: { name: string; at: number }[] = [];
  for (const name of await readdir(folder)) {
    if (!MAP_FILE.test(name)) continue;
    try {
      files.push({ name, at: (await stat(join(folder, name))).mtimeMs });
    } catch {
      // Gone already.
    }
  }
  const excess = files.length - MAX_STORED_MAPS;
  if (excess <= 0) return;
  const victims = files.filter((f) => f.name !== `${keep}.json`).sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  for (const f of victims.slice(0, excess)) await unlink(join(folder, f.name)).catch(() => {});
}

/** Store `map` (its base values), then evict beyond the cap. `true` when written; never throws. */
export async function writeStoredMap(dir: string, map: GameMap): Promise<boolean> {
  try {
    await writeJsonAtomic(mapStorePath(dir, map.id), mapsDir(dir), { version: VERSION, map });
    await evictMaps(dir, map.id).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** The index entries, loosely: unusable entries are dropped. */
async function readIndex(dir: string): Promise<[number, number][]> {
  try {
    const raw: unknown = JSON.parse(await readFile(indexPath(dir), 'utf8'));
    if (!isRec(raw) || raw.version !== VERSION || !Array.isArray(raw.games)) return [];
    return raw.games.filter((e): e is [number, number] => Array.isArray(e) && e.length === 2 && isInt(e[0]) && isInt(e[1]));
  } catch {
    return [];
  }
}

/** The map id stored for `gameId`; `undefined` when not known. Never throws. */
export async function readGameMapId(dir: string, gameId: number): Promise<number | undefined> {
  const hit = (await readIndex(dir)).reverse().find(([g]) => g === gameId);
  return hit?.[1];
}

/** Remember that `gameId` is on `mapId` (newest kept, {@link MAX_GAME_INDEX} at most). `true` when written; never throws. */
export async function rememberGameMap(dir: string, gameId: number, mapId: number): Promise<boolean> {
  try {
    return await withPathLock(indexPath(dir), async () => {
      const games = (await readIndex(dir)).filter(([g]) => g !== gameId);
      games.push([gameId, mapId]);
      await writeJsonAtomic(indexPath(dir), mapsDir(dir), { version: VERSION, games: games.slice(-MAX_GAME_INDEX) });
      return true;
    });
  } catch {
    return false;
  }
}
