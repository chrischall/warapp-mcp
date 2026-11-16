// The end-of-game records (#312 E1; owner decisions P2–P4 of 2026-11-16): one file per finished game
// the account played, `<dataDir>/finished/<key>.json`, the key an HMAC of my account and the game
// under the one shared salt (`finishedGameKey`, src/player-record-store.ts), so no file name holds an
// id. NAME-FREE inside too: players by the deal record's `playerKey` under the same salt, never an id
// or a name; territory, bonus and map ids are the map's own, public data. No clock is kept.
//
// The file is also the "processed" mark: the end-of-game pass (src/tools/end-of-game.ts) runs once per
// game, and a file of any status means it ran. `captured` holds the history's capture; `history-unreadable`
// (with #315's reason) and `read-failed` (the request failed) record a pass whose history did not come,
// and are never retried automatically (an explicit warapp_get_game with `include_history` may).
//
// Same guarantees as the profile stores: 0600 files in a 0700 folder, atomic writes, best effort; at
// most `MAX_FINISHED_RECORDS` files, the least recently written dropped first; a file that exists but
// does not parse (not JSON, not an object, another version) is never overwritten. `WARAPP_PLAYER_PROFILE=off`
// switches the pass off (nothing read or written).
import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FinishedCapture, FinishedOutcome, PlayerTurn } from './analysis/finished-game.js';
import { profileFormatOf, type ProfileFormat } from './analysis/opponent-profile.js';
import { writeJsonAtomic } from './map-store.js';
import type { Game } from './normalize.js';
import type { AwardReading } from './analysis/award.js';
import { finishedGameKey, playerKey } from './player-record-store.js';
import { holdsSeat } from './player-states.js';
import type { HistoryUnreadable } from './trend.js';

export const MAX_FINISHED_RECORDS = 500;
const VERSION = 1;
const FILE = /^[0-9a-f]{32}\.json$/;

export const finishedDir = (dir: string) => join(dir, 'finished');
export const finishedPath = (dir: string, salt: string, me: number, gameId: number) =>
  join(finishedDir(dir), `${finishedGameKey(salt, me, gameId)}.json`);

/** What a pass left: the capture, or why the history did not come. */
export type FinishedStatus = 'captured' | 'history-unreadable' | 'read-failed';

/** Why a pass's history did not come: #315's unreadable reason (name-free), or a failed request. */
export type FinishedFailure =
  | { reason: HistoryUnreadable['reason']; layout?: string; keys: string[]; shape?: string; turns?: number }
  | { reason: 'request-failed'; kind?: string };

type Side = { owner: string; armies: number | null };

/** The record as stored (players by key). */
export interface FinishedRecord {
  version: 1;
  status: FinishedStatus;
  failure?: FinishedFailure;
  /** The history layout the boards were read in (#315). */
  layout?: string;
  mapId?: number;
  /** Without a map the income by turn is not computed. */
  noMap?: true;
  format?: ProfileFormat;
  /** Players seated. */
  seats?: number;
  /** The settings shape (`nameFreeSettings`, src/replay.ts). */
  settings?: Record<string, unknown>;
  /** My key among `players`. */
  me: string;
  players?: { key: string; ai: boolean; turnedAI?: true; team?: number; state?: string }[];
  outcome?: { result: FinishedOutcome; turn: number | null; outTurn: number | null; winners: string[] };
  /** My pick list as war.app read it back, and the award read from it (`src/pick-list.ts`); `null` when none was kept. */
  picks?: { list: number[]; award?: AwardReading | null } | null;
  starts?: Record<string, number[]>;
  /** Per history board, after `afterTurn` completed turns: each player's income, territories, armies and full bonuses. */
  turns?: { afterTurn: number; players: Record<string, PlayerTurn> }[];
  failedAttacks?: { turn: number; to: number; from: number[]; sent: number; before: Side; after: Side }[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const STATUSES: ReadonlySet<string> = new Set<FinishedStatus>(['captured', 'history-unreadable', 'read-failed']);

/**
 * The record at `path`: `missing`, `unreadable` (exists, but not JSON, not an object, another version
 * or an unknown status: never overwritten), or its status. Never throws.
 */
export async function readFinishedState(path: string): Promise<'missing' | 'unreadable' | { status: FinishedStatus }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  try {
    const v: unknown = JSON.parse(text);
    if (!isRec(v) || v.version !== VERSION || typeof v.status !== 'string' || !STATUSES.has(v.status)) return 'unreadable';
    return { status: v.status as FinishedStatus };
  } catch {
    return 'unreadable';
  }
}

/** Write a record atomically (0600), then keep the newest {@link MAX_FINISHED_RECORDS}. Throws on a failed write. */
export async function writeFinishedRecord(dir: string, path: string, body: FinishedRecord, keep = MAX_FINISHED_RECORDS): Promise<void> {
  await writeJsonAtomic(path, finishedDir(dir), body);
  await pruneFinished(dir, keep).catch(() => undefined);
}

async function pruneFinished(dir: string, keep: number): Promise<void> {
  const folder = finishedDir(dir);
  const files: { path: string; at: number }[] = [];
  for (const name of await readdir(folder)) {
    if (!FILE.test(name)) continue;
    const path = join(folder, name);
    try {
      files.push({ path, at: (await stat(path)).mtimeMs });
    } catch {
      // Gone already.
    }
  }
  if (files.length <= keep) return;
  files.sort((a, b) => b.at - a.at || a.path.localeCompare(b.path));
  for (const f of files.slice(keep)) await unlink(f.path).catch(() => undefined);
}

/** What {@link finishedRecordOf} keys and keeps beside the capture. */
export interface RecordParts {
  salt: string;
  me: number;
  status: FinishedStatus;
  /** The game as read (the history read when it came, else the read that showed it finished); absent when none. */
  game?: Pick<Game, 'players' | 'settings' | 'name' | 'numberOfTurns'> | undefined;
  settings?: Record<string, unknown> | undefined;
  mapId?: number | undefined;
  noMap?: boolean;
  layout?: string | undefined;
  failure?: FinishedFailure | undefined;
  capture?: FinishedCapture | undefined;
  picks?: FinishedRecord['picks'];
}

/** The stored record: every player id replaced by its `playerKey`. Pure. */
export function finishedRecordOf(p: RecordParts): FinishedRecord {
  const key = (id: number) => playerKey(p.salt, id);
  const owner = (o: number | 'neutral' | 'unknown') => (typeof o === 'number' ? key(o) : o);
  const keyed = <T>(m: ReadonlyMap<number, T>): Record<string, T> => Object.fromEntries([...m].map(([id, v]) => [key(id), v]));
  const game = p.game;
  const c = p.capture;
  // The history's own parts only when it read.
  const h = p.status === 'captured' ? c : undefined;
  return {
    version: VERSION,
    status: p.status,
    ...(p.failure ? { failure: p.failure } : {}),
    ...(p.layout ? { layout: p.layout } : {}),
    ...(p.mapId !== undefined ? { mapId: p.mapId } : {}),
    ...(p.noMap ? { noMap: true as const } : {}),
    ...(game ? { format: profileFormatOf(game.players), seats: game.players.filter((x) => holdsSeat(x.state)).length } : {}),
    ...(p.settings ? { settings: p.settings } : {}),
    me: key(p.me),
    ...(game
      ? {
          players: game.players
            .filter((x) => holdsSeat(x.state))
            .map((x) => ({
              key: key(x.id),
              ai: x.isAI,
              ...(x.humanTurnedIntoAI ? { turnedAI: true as const } : {}),
              ...(x.team !== undefined && x.team !== null ? { team: x.team } : {}),
              ...(x.state ? { state: x.state } : {}),
            })),
        }
      : {}),
    ...(c ? { outcome: { ...c.outcome, winners: c.outcome.winners.map(key) } } : {}),
    ...(p.picks !== undefined ? { picks: p.picks } : {}),
    ...(h ? { starts: keyed(h.starts) } : {}),
    ...(h ? { turns: h.turns.map((t) => ({ afterTurn: t.afterTurn, players: keyed(t.players) })) } : {}),
    ...(h
      ? {
          failedAttacks: h.failedAttacks.map((f) => ({
            ...f,
            before: { owner: owner(f.before.owner), armies: f.before.armies },
            after: { owner: owner(f.after.owner), armies: f.after.armies },
          })),
        }
      : {}),
  };
}
