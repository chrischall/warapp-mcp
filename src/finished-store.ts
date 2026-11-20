// The end-of-game records (#312 E1; owner decisions P2–P4 of 2026-11-16): one file per finished game
// the account played, `<dataDir>/finished/<key>.json`, the key an HMAC of my account and the game
// under the one shared salt (`finishedGameKey`, src/player-record-store.ts), so no file name holds an
// id. NAME-FREE inside too: players by the deal record's `playerKey` under the same salt, never an id
// or a name; territory, bonus and map ids are the map's own, public data. No clock is kept.
// A captured record also keeps the history's boards (owners by key, delta-encoded), which the calibration
// harness (#318, scripts/calibrate.mjs) reads as its truth: it never reads a history of its own.
//
// The file is also the "processed" mark: the end-of-game pass (src/tools/end-of-game.ts) runs once per
// game, and a file of any status means it ran. `captured` holds the history's capture; `history-unreadable`
// (with #315's reason) and `read-failed` (the request failed) record a pass whose history did not come,
// and are never retried automatically (an explicit warapp_get_game with `include_history` may).
//
// The record bound would drop a processed mark, so every pass that spent its history read (its own
// request, or the history a caller read and handed it) also leaves a mark in
// `<dataDir>/finished/processed.json` (`markProcessed`): the record keys only (hashed, no id),
// at most `MAX_PROCESSED_KEYS` (ten times the record bound), the least recently marked dropped first. A
// game with a mark is never read again by a trigger even once its record is pruned (P2). The one
// remaining exception: a game whose record AND mark have both aged out (over 5000 later passes) reads
// again if a trigger names it. A marks file that does not parse is never overwritten (marks then rely
// on the records alone).
//
// A captured record keeps at most `MAX_RECORD_BOARDS_HEAD` opening boards and `MAX_RECORD_BOARDS_TAIL`
// closing ones (the opening benchmark reads the first, the calibration the turns the board cache kept,
// the last ten); `boardsOmitted` counts the boards between them that were left out.
//
// Same guarantees as the profile stores: 0600 files in a 0700 folder, atomic writes, best effort; at
// most `MAX_FINISHED_RECORDS` files, the least recently written (or refreshed by the sweep) dropped first, never
// one the writer protects (the sweep's window: its newest finished games, half the bound, so a processed
// game it lists never loses its mark and is never read again); a file that exists but
// does not parse (not JSON, not an object, another version) is never overwritten. `WARAPP_PLAYER_PROFILE=off`
// switches the pass off (nothing read or written).
import { readdir, readFile, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import type { FinishedCapture, FinishedOutcome, GameKind, PlayerTurn } from './analysis/finished-game.js';
import { profileFormatOf, type ProfileFormat } from './analysis/opponent-profile.js';
import { writeJsonAtomic } from './map-store.js';
import type { Game } from './normalize.js';
import type { AwardReading } from './analysis/award.js';
import { finishedGameKey, playerKey } from './player-record-store.js';
import { holdsSeat } from './player-states.js';
import type { BoardState, TerritoryOwner, TerritoryState } from './board.js';
import type { HistoryUnreadable } from './trend.js';
import { contractFinalOutlook, type FinalOutlook } from './outlook-log.js';
import { withPathLock } from './path-lock.js';

export const MAX_FINISHED_RECORDS = 500;
/** The processed marks kept: ten times the record bound. */
export const MAX_PROCESSED_KEYS = 5000;
/** The opening boards a captured record keeps. */
export const MAX_RECORD_BOARDS_HEAD = 30;
/** The closing boards a captured record keeps. */
export const MAX_RECORD_BOARDS_TAIL = 30;
const VERSION = 1;
const FILE = /^[0-9a-f]{32}\.json$/;

export const finishedDir = (dir: string) => join(dir, 'finished');
export const finishedPath = (dir: string, salt: string, me: number, gameId: number) =>
  join(finishedDir(dir), `${finishedGameKey(salt, me, gameId)}.json`);
/** The processed marks: not a record (its name is no key), so the prune and the record list skip it. */
export const processedPath = (dir: string) => join(finishedDir(dir), 'processed.json');
const KEY = /^[0-9a-f]{32}$/;

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
  /** `leftTurn` (#437): the turn being played when my seat left (absent on records kept before it). */
  outcome?: { result: FinishedOutcome; turn: number | null; outTurn: number | null; leftTurn?: number | null; winners: string[] };
  /**
   * #437: the game's kinds (`gameKinds`: lottery, no-show, legacy, team); absent on records kept before them.
   * A lottery or no-show game is counted apart in the lessons and the map record, and folds no profile.
   */
  kinds?: GameKind[];
  /**
   * #312: the final outlook line this server logged for the game (`<dataDir>/outlook/<gameId>.json`,
   * `finalOutlookOf`): state, turn, held turns, ratio, estimated / thin flags; no id, no words. Absent
   * when it never planned the game.
   */
  outlook?: FinalOutlook;
  /** My pick list as war.app read it back, and the award read from it (`src/pick-list.ts`); `null` when none was kept. */
  picks?: { list: number[]; award?: AwardReading | null } | null;
  starts?: Record<string, number[]>;
  /** Per history board, after `afterTurn` completed turns: each player's income, territories, armies and full bonuses. */
  turns?: { afterTurn: number; players: Record<string, PlayerTurn> }[];
  failedAttacks?: { turn: number; to: number; from: number[]; sent: number; before: Side; after: Side }[];
  /** The players owning land on `boards`, by key: a board's owner index points in here. */
  boardOwners?: string[];
  /**
   * The history's boards themselves (#318: the calibration harness's truth, so the one history read
   * feeds it too), after `turn` completed turns: per territory `[id, owner, armies]`, the owner an index
   * into `boardOwners` or {@link OWNER_NEUTRAL} / {@link OWNER_AVAILABLE} / {@link OWNER_UNKNOWN}, and a
   * fourth element, the fog level, only when one was sent and is not `Visible`. A board listing the same
   * territories in the same order as the one before it is kept as its changed rows only (`d`), each
   * replacing that territory's row whole.
   */
  boards?: { turn: number; d?: true; t: StoredTerritory[] }[];
  /** The history boards left out between the opening and the closing ones kept (absent: none). */
  boardsOmitted?: number;
}

/** A history board's territory as stored: `[territory id, owner, armies]`, then a fog level other than `Visible`. */
export type StoredTerritory = [number, number, number | null] | [number, number, number | null, string];
export const OWNER_NEUTRAL = -1;
export const OWNER_AVAILABLE = -2;
/** Fogged, or an owner that is no seated player's (its raw value is never kept). */
export const OWNER_UNKNOWN = -3;
const FOG_WORD = /^[A-Za-z0-9]{1,20}$/;

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

/**
 * Write a record atomically (0600), then keep the newest {@link MAX_FINISHED_RECORDS}: never a path in
 * `protect` (the sweep's window, src/tools/end-of-game.ts), nor the one just written. Throws on a failed write.
 */
export async function writeFinishedRecord(
  dir: string,
  path: string,
  body: FinishedRecord,
  keep = MAX_FINISHED_RECORDS,
  protect?: ReadonlySet<string>,
): Promise<void> {
  await writeJsonAtomic(path, finishedDir(dir), body);
  await pruneFinished(dir, keep, new Set([...(protect ?? []), path])).catch(() => undefined);
}

/** Mark a record most recently used (a prune drops the least recently written or touched first). Never throws. */
export async function touchFinished(path: string): Promise<void> {
  const now = new Date();
  await utimes(path, now, now).catch(() => undefined);
}

/**
 * The processed marks: the record keys of every game whose pass spent its history read, oldest first.
 * Missing: none. `unreadable`: the file exists but does not parse (never overwritten). Never throws.
 */
export async function readProcessed(dir: string): Promise<ReadonlySet<string> | 'unreadable'> {
  const keys = await readProcessedKeys(dir);
  return keys === 'unreadable' ? keys : new Set(keys);
}

async function readProcessedKeys(dir: string): Promise<string[] | 'unreadable'> {
  let text: string;
  try {
    text = await readFile(processedPath(dir), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : 'unreadable';
  }
  try {
    const v: unknown = JSON.parse(text);
    if (!isRec(v) || v.version !== VERSION || !Array.isArray(v.keys) || !v.keys.every((k) => typeof k === 'string' && KEY.test(k))) return 'unreadable';
    return v.keys as string[];
  } catch {
    return 'unreadable';
  }
}

/**
 * Mark `key` (a `finishedGameKey`) processed, newest, keeping at most `limit` marks (0600, atomic,
 * under the path lock). `false` when the marks file does not parse (left as it is) or the write failed. Never throws.
 */
export async function markProcessed(dir: string, key: string, limit = MAX_PROCESSED_KEYS): Promise<boolean> {
  if (!KEY.test(key)) return false;
  const path = processedPath(dir);
  try {
    return await withPathLock(path, async () => {
      const keys = await readProcessedKeys(dir);
      if (keys === 'unreadable') return false;
      const next = [...keys.filter((k) => k !== key), key];
      await writeJsonAtomic(path, finishedDir(dir), { version: VERSION, keys: next.slice(Math.max(0, next.length - limit)) });
      return true;
    });
  } catch {
    return false;
  }
}

/** Every record file under `dir` (the marks file aside), by path, sorted. Never throws. */
export async function listFinishedRecords(dir: string): Promise<string[]> {
  const names = await readdir(finishedDir(dir)).catch(() => [] as string[]);
  return names
    .filter((n) => FILE.test(n))
    .sort()
    .map((n) => join(finishedDir(dir), n));
}

async function pruneFinished(dir: string, keep: number, protect: ReadonlySet<string>): Promise<void> {
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
  let over = files.length - keep;
  for (const f of [...files].reverse()) {
    if (over <= 0) break;
    if (protect.has(f.path)) continue;
    await unlink(f.path).catch(() => undefined);
    over--;
  }
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
  outlook?: FinalOutlook | undefined;
  /** The history's boards (owners by GameFeed id), kept only with `captured`. */
  boards?: readonly { turn: number; board: BoardState }[] | undefined;
  /** #437: the game's kinds. */
  kinds?: GameKind[] | undefined;
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
  const kept = p.status === 'captured' && p.boards ? boundedBoards(p.boards) : undefined;
  const stored = kept ? storeBoards(kept.boards, p.game?.players.map((x) => x.id) ?? [p.me], key) : undefined;
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
    ...(p.kinds ? { kinds: p.kinds } : {}),
    ...(p.outlook ? { outlook: p.outlook } : {}),
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
    ...(stored ?? {}),
    ...(kept?.omitted ? { boardsOmitted: kept.omitted } : {}),
  };
}

/** The opening and closing boards a record keeps, and how many between them it leaves out. Pure. */
function boundedBoards<T>(boards: readonly T[]): { boards: readonly T[]; omitted: number } {
  const max = MAX_RECORD_BOARDS_HEAD + MAX_RECORD_BOARDS_TAIL;
  if (boards.length <= max) return { boards, omitted: 0 };
  return { boards: [...boards.slice(0, MAX_RECORD_BOARDS_HEAD), ...boards.slice(boards.length - MAX_RECORD_BOARDS_TAIL)], omitted: boards.length - max };
}

/** The boards in their stored shape: owners by key (only the game's players; any other owner is unknown). Pure. */
function storeBoards(
  boards: readonly { turn: number; board: BoardState }[],
  ids: readonly number[],
  key: (id: number) => string,
): { boardOwners: string[]; boards: { turn: number; d?: true; t: StoredTerritory[] }[] } {
  const known = new Set(ids);
  const index = new Map<number, number>();
  const owners: string[] = [];
  const ownerOf = (o: TerritoryOwner): number => {
    if (o.kind === 'neutral') return OWNER_NEUTRAL;
    if (o.kind === 'available') return OWNER_AVAILABLE;
    if (o.kind !== 'player' || !known.has(o.playerId)) return OWNER_UNKNOWN;
    let i = index.get(o.playerId);
    if (i === undefined) {
      i = owners.push(key(o.playerId)) - 1;
      index.set(o.playerId, i);
    }
    return i;
  };
  const rowOf = (x: TerritoryState): StoredTerritory => {
    const row: [number, number, number | null] = [x.territoryId, ownerOf(x.owner), x.armies];
    return x.fogLevel && x.fogLevel !== 'Visible' && FOG_WORD.test(x.fogLevel) ? [...row, x.fogLevel] : row;
  };
  let prev: StoredTerritory[] | undefined;
  const out: { turn: number; d?: true; t: StoredTerritory[] }[] = [];
  for (const { turn, board } of boards) {
    const rows = board.territories.map(rowOf);
    const before = prev;
    const sameList = before !== undefined && before.length === rows.length && rows.every((r, i) => r[0] === before[i]![0]);
    out.push(sameList ? { turn, d: true, t: rows.filter((r, i) => JSON.stringify(r) !== JSON.stringify(before[i])) } : { turn, t: rows });
    prev = rows;
  }
  return { boardOwners: owners, boards: out };
}

/**
 * The record at `path`: `missing`, `unreadable` (as {@link readFinishedState}), or the record itself.
 * Never throws. The harness's reader (scripts/calibrate.mjs); the pass needs only the state.
 */
export async function readFinishedRecord(path: string): Promise<'missing' | 'unreadable' | FinishedRecord> {
  const state = await readFinishedState(path);
  if (typeof state === 'string') return state;
  try {
    const rec = JSON.parse(await readFile(path, 'utf8')) as FinishedRecord;
    // #454: a record written with the income lean as the outlook's state reads as even with that lean.
    return rec.outlook ? { ...rec, outlook: contractFinalOutlook(rec.outlook) } : rec;
  } catch {
    return 'unreadable';
  }
}

/** A captured record's history with the ids put back, for the calibration harness (#318). */
export interface RecordHistory {
  me: number;
  numberOfTurns: number | null;
  players: { id: number; isAI: boolean; team?: number; state?: string }[];
  boards: { turn: number; board: BoardState }[];
}

/**
 * The history a captured record keeps, its keys matched against `ids` (the players the caller already
 * knows by id: a key is never reversed). `no-boards`: not captured, or captured without its boards;
 * `unmatched`: my key is none of `ids`. A seat matching none is left out, and land it owned reads as
 * an unknown owner. Pure.
 */
export function historyOfRecord(rec: FinishedRecord, salt: string, ids: readonly number[]): RecordHistory | 'no-boards' | 'unmatched' {
  if (!hasBoards(rec)) return 'no-boards';
  const byKey = new Map(ids.map((id) => [playerKey(salt, id), id]));
  if (!byKey.has(rec.me)) return 'unmatched';
  return decodeHistory(rec, byKey);
}

/**
 * The history a captured record keeps when the ids of its game are not known (#318: the game's settings
 * record aged out): each player labelled by position, me 1, then the seats in the record's order, then
 * any other board owner. A key is never reversed: the labels say who is who within the record only. Pure.
 */
export function anonymousHistoryOfRecord(rec: FinishedRecord): RecordHistory | 'no-boards' {
  if (!hasBoards(rec)) return 'no-boards';
  const byKey = new Map<string, number>();
  for (const k of [rec.me, ...(rec.players ?? []).map((p) => p.key), ...rec.boardOwners!]) if (!byKey.has(k)) byKey.set(k, byKey.size + 1);
  const h = decodeHistory(rec, byKey);
  // Me first among the players.
  h.players.sort((a, b) => a.id - b.id);
  return h;
}

const hasBoards = (rec: FinishedRecord): boolean => rec.status === 'captured' && Array.isArray(rec.boards) && Array.isArray(rec.boardOwners);

function decodeHistory(rec: FinishedRecord, byKey: ReadonlyMap<string, number>): RecordHistory {
  const me = byKey.get(rec.me)!;
  const owners = rec.boardOwners!.map((k) => byKey.get(k));
  const ownerOf = (o: number): TerritoryOwner => {
    if (o === OWNER_NEUTRAL) return { kind: 'neutral' };
    if (o === OWNER_AVAILABLE) return { kind: 'available' };
    const id = owners[o];
    return id === undefined ? { kind: 'unknown' } : { kind: 'player', playerId: id };
  };
  const players: RecordHistory['players'] = [];
  for (const p of rec.players ?? []) {
    const id = byKey.get(p.key);
    if (id === undefined) continue;
    players.push({ id, isAI: p.ai, ...(p.team !== undefined ? { team: p.team } : {}), ...(p.state !== undefined ? { state: p.state } : {}) });
  }
  const territoryOf = ([territoryId, owner, armies, fogLevel]: StoredTerritory): TerritoryState => ({
    territoryId,
    owner: ownerOf(owner),
    armies,
    ...(fogLevel !== undefined ? { fogLevel } : {}),
  });
  const boards: RecordHistory['boards'] = [];
  let prev: TerritoryState[] | undefined;
  for (const { turn, d, t } of rec.boards!) {
    let territories: TerritoryState[];
    if (d && prev) {
      const changed = new Map(t.map((row) => [row[0], territoryOf(row)]));
      territories = prev.map((x) => changed.get(x.territoryId) ?? { ...x });
    } else territories = t.map(territoryOf);
    boards.push({ turn, board: { source: 'gamefeed', verified: false, territories } });
    prev = territories;
  }
  return { me, numberOfTurns: rec.outcome?.turn ?? null, players, boards };
}
