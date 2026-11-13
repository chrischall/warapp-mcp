// My pick list of a game, kept so the award can be read from it (#166, src/analysis/award.ts).
//
// war.app serves a player's picks while territories are being distributed; whether it still does
// afterwards is not verified, and the award can only be read against the list it used. So the
// list is written here when this server reads it back from war.app (after warapp_submit_picks,
// or by warapp_get_my_picks during distribution), at `<dataDir>/picks/<gameId>.json`, with the
// award read from it on the first board after distribution. Territory ids only: no names, no
// other player's data. Best effort and never throws; a game's file not written for 60 days is
// deleted on the first write of a process.
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AwardReading } from './analysis/award.js';

export interface PickRecord {
  gameId: number;
  /** The player whose list this is (GameFeed id). */
  playerId: number;
  /** The picks in priority order, as war.app read them back. */
  list: number[];
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

/** The pick list kept for `gameId` when it is `playerId`'s; `undefined` when absent or unusable. Never throws. */
export async function readPickRecord(dir: string, gameId: number, playerId: number): Promise<PickRecord | undefined> {
  try {
    const c: unknown = JSON.parse(await readFile(pickListPath(dir, gameId), 'utf8'));
    if (!isRec(c) || c.gameId !== gameId || c.playerId !== playerId || !isIds(c.list) || !c.list.length) return undefined;
    const award = awardOf(c.award);
    return { gameId, playerId, list: c.list, ...(award !== undefined ? { award } : {}) };
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

/**
 * Keep `list` as `playerId`'s picks for `gameId`. The same list already kept stays as it is (its
 * award too); a different one replaces it and drops the award read from the old one. Never throws.
 */
export async function writePickList(dir: string, gameId: number, playerId: number, list: readonly number[]): Promise<boolean> {
  if (!list.length || !isIds([...list])) return false;
  const kept = await readPickRecord(dir, gameId, playerId);
  if (kept && kept.list.length === list.length && kept.list.every((t, i) => t === list[i])) return true;
  return writeRecord(dir, { gameId, playerId, list: [...list] });
}

/** Keep the award read from the stored list (`null`: nothing could be read). False when no list is kept for this player. */
export async function writeAward(dir: string, gameId: number, playerId: number, award: AwardReading | null): Promise<boolean> {
  const kept = await readPickRecord(dir, gameId, playerId);
  if (!kept) return false;
  return writeRecord(dir, { gameId, playerId, list: kept.list, award });
}
