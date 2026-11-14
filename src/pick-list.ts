// My pick list of a game, kept so the award can be read from it (#166, src/analysis/award.ts).
//
// war.app serves a player's picks while territories are being distributed; whether it still does
// afterwards is not verified, and the award can only be read against the list it used. So the
// list is written here when this server reads it back from war.app (after warapp_submit_picks,
// or by warapp_get_my_picks during distribution), at `<dataDir>/picks/<gameId>.json`, with the
// award read from it on the first board after distribution. The same file keeps the territories
// the live board showed as pickable during distribution (written by warapp_plan_picks and by
// warapp_submit_picks' preview): once the game starts nothing says where a player could have
// started, and warapp_locate_opponents needs it. #201: beside them, the neutrals the picking board
// showed and their armies, so a neutral the fog hides later (a wasteland) keeps a known size for the
// turn planner. A record may hold any of these. Territory ids
// only: no names, no other player's data. Best effort and never throws; a game's file not
// written for 60 days is deleted on the first write of a process.
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AwardReading } from './analysis/award.js';
import { OWNER_NEUTRAL, type LiveTerritory } from './live.js';

interface PickRecord {
  gameId: number;
  /** The player whose list this is (GameFeed id). */
  playerId: number;
  /** The picks in priority order, as war.app read them back; absent while only the pickables are kept. */
  list?: number[];
  /** The territories the live board showed as pickable during distribution, ascending; absent when not kept. */
  pickable?: number[];
  /** #201: the neutrals the picking board showed, `[territory, armies]` ascending by territory; absent when not kept. */
  neutrals?: [number, number][];
  /**
   * The award read from the list on the first board after distribution: `null` when the list
   * could not explain that start; absent while it has not been read.
   */
  award?: AwardReading | null;
}

/** Where a game's pick list is kept. */
export const pickListPath = (dir: string, gameId: number) => join(dir, 'picks', `${gameId}.json`);

/** A game's pick list not written for this long is deleted (finished or abandoned games). */
export const PICK_LIST_MAX_AGE_MS = 60 * 86_400_000;
const PICK_FILE = /^\d+\.json$/;
/** Pick directories pruned by this process: once is enough. */
const pruned = new Set<string>();

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isIds = (v: unknown): v is number[] => Array.isArray(v) && v.every(isId);
const isArmies = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** `[territory, armies]` pairs, the malformed dropped, each territory once (the first), ascending. */
function neutralsOf(v: unknown): [number, number][] | undefined {
  if (!Array.isArray(v)) return undefined;
  const seen = new Map<number, number>();
  for (const e of v) if (Array.isArray(e) && e.length === 2 && isId(e[0]) && isArmies(e[1]) && !seen.has(e[0])) seen.set(e[0], e[1]);
  return seen.size ? [...seen].sort((a, b) => a[0] - b[0]) : undefined;
}

/** A stored award, loosely: anything that does not look like one is dropped. */
function awardOf(v: unknown): AwardReading | null | undefined {
  if (v === null) return null;
  if (!isRec(v) || !isIds(v.granted) || !isIds(v.unlisted) || !isIds(v.opponentStarts)) return undefined;
  if (typeof v.allStartsKnown !== 'boolean') return undefined;
  if (v.role !== null && v.role !== 'first' && v.role !== 'second') return undefined;
  if (v.opponentFirstAward !== null && !isId(v.opponentFirstAward)) return undefined;
  return {
    granted: v.granted,
    unlisted: v.unlisted,
    opponentStarts: v.opponentStarts,
    allStartsKnown: v.allStartsKnown,
    role: v.role,
    opponentFirstAward: v.opponentFirstAward,
  };
}

/**
 * The record kept for `gameId` when it is `playerId`'s: the pick list, the pickable territories, or
 * both; `undefined` when absent or when it holds neither. An award is read only beside a list.
 * Never throws.
 */
export async function readPickRecord(dir: string, gameId: number, playerId: number): Promise<PickRecord | undefined> {
  try {
    const c: unknown = JSON.parse(await readFile(pickListPath(dir, gameId), 'utf8'));
    if (!isRec(c) || c.gameId !== gameId || c.playerId !== playerId) return undefined;
    const list = isIds(c.list) && c.list.length ? c.list : undefined;
    const pickable = isIds(c.pickable) && c.pickable.length ? c.pickable : undefined;
    const neutrals = neutralsOf(c.neutrals);
    if (!list && !pickable) return undefined;
    const award = list ? awardOf(c.award) : undefined;
    return {
      gameId,
      playerId,
      ...(list ? { list } : {}),
      ...(pickable ? { pickable } : {}),
      ...(neutrals ? { neutrals } : {}),
      ...(award !== undefined ? { award } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Delete the pick lists of games not written for {@link PICK_LIST_MAX_AGE_MS}. Best effort. */
async function prunePickLists(dir: string): Promise<void> {
  const picks = join(dir, 'picks');
  if (pruned.has(picks)) return;
  pruned.add(picks);
  const cutoff = Date.now() - PICK_LIST_MAX_AGE_MS;
  try {
    for (const name of await readdir(picks)) {
      if (!PICK_FILE.test(name)) continue;
      const file = join(picks, name);
      try {
        if ((await stat(file)).mtimeMs < cutoff) await unlink(file);
      } catch {
        // Gone already, or unreadable: leave it.
      }
    }
  } catch {
    // No pick directory yet.
  }
}

async function writeRecord(dir: string, record: PickRecord): Promise<boolean> {
  try {
    const path = pickListPath(dir, record.gameId);
    await mkdir(join(dir, 'picks'), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
    await rename(tmp, path);
    await prunePickLists(dir);
    return true;
  } catch {
    return false;
  }
}

const sameIds = (a: readonly number[] | undefined, b: readonly number[]) => a !== undefined && a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * Keep `list` as `playerId`'s picks for `gameId`. The same list already kept stays as it is (its
 * award too); a different one replaces it and drops the award read from the old one. The pickable
 * territories kept beside it stay. Never throws.
 */
export async function writePickList(dir: string, gameId: number, playerId: number, list: readonly number[]): Promise<boolean> {
  if (!list.length || !isIds([...list])) return false;
  const kept = await readPickRecord(dir, gameId, playerId);
  if (sameIds(kept?.list, list)) return true;
  return writeRecord(dir, {
    gameId,
    playerId,
    list: [...list],
    ...(kept?.pickable ? { pickable: kept.pickable } : {}),
    ...(kept?.neutrals ? { neutrals: kept.neutrals } : {}),
  });
}

/** Keep the award read from the stored list (`null`: nothing could be read). False when no list is kept for this player. */
export async function writeAward(dir: string, gameId: number, playerId: number, award: AwardReading | null): Promise<boolean> {
  const kept = await readPickRecord(dir, gameId, playerId);
  if (!kept?.list) return false;
  return writeRecord(dir, {
    gameId,
    playerId,
    list: kept.list,
    ...(kept.pickable ? { pickable: kept.pickable } : {}),
    ...(kept.neutrals ? { neutrals: kept.neutrals } : {}),
    award,
  });
}

/**
 * Keep the territories the live board showed as pickable for `gameId` (ascending, each once),
 * beside `playerId`'s list and its award when those are kept, and (#201) the picking board's
 * neutrals with their armies when given (else those already kept stay). The same sets already
 * kept stay as they are. Never throws.
 */
export async function writePickable(
  dir: string,
  gameId: number,
  playerId: number,
  pickable: readonly number[],
  neutralArmies?: readonly (readonly [number, number])[],
): Promise<boolean> {
  if (!pickable.length || !isIds([...pickable])) return false;
  const ids = [...new Set(pickable)].sort((a, b) => a - b);
  const kept = await readPickRecord(dir, gameId, playerId);
  const neutrals = neutralsOf(neutralArmies) ?? kept?.neutrals;
  if (sameIds(kept?.pickable, ids) && JSON.stringify(kept?.neutrals) === JSON.stringify(neutrals)) return true;
  return writeRecord(dir, {
    gameId,
    playerId,
    ...(kept?.list ? { list: kept.list } : {}),
    pickable: ids,
    ...(neutrals ? { neutrals } : {}),
    ...(kept?.list && kept.award !== undefined ? { award: kept.award } : {}),
  });
}

/** #201: the neutrals a live board shows with their armies (fogged ones left out), ascending by territory. */
export function pickingNeutrals(board: readonly LiveTerritory[]): [number, number][] {
  return board
    .filter((t) => !t.fogged && t.owner === OWNER_NEUTRAL && t.armies !== null)
    .map((t): [number, number] => [t.territoryId, t.armies!])
    .sort((a, b) => a[0] - b[0]);
}
