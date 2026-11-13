// The previous turn's board, for the planner's threat trend. Best effort and
// never throws: GameFeed's `GetHistory` standing for the previous turn when the
// feed sends one (UNVERIFIED for games in progress — see docs/WARAPP-API.md),
// else the board this server planned on for the previous turn, cached on disk
// (the newest CACHED_TURNS turns per game, planned or tracked: opponent tracking
// reads the whole history).
//
// The cache holds only the player's own fogged view (what the live board
// showed them), at `<dataDir>/boards/<gameId>.json`; a game's file not written for
// 60 days is deleted on the first write of a process.
//
// Beside the boards, the same file keeps the orders this server sent for a turn
// (`warapp_submit_turn`, #119): my own orders are measurements of what an opponent
// deployed (analysis/opponents.ts `measureOrders`). Orders sent from the web client
// stay unknown, which changes nothing.
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boardFromStanding, type BoardState, type TerritoryState } from './board.js';
import { playersByInGameId } from './live.js';
import type { MyOrders } from './analysis/opponents.js';
import type { Player } from './normalize.js';
import { asInt } from './scalars.js';

export type TrendSource = 'history' | 'cache';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

const STANDING_KEYS = ['standing', 'standings', 'latestStanding', 'Standing'] as const;
const NUMBER_KEYS = ['turnNumber', 'turn', 'number', 'TurnNumber'] as const;

function standingOf(entry: unknown): unknown {
  if (!isRec(entry)) return entry;
  for (const k of STANDING_KEYS) if (entry[k] !== undefined) return entry[k];
  return entry;
}

/** History entries as (completed turns, raw standing), in any of the plausible layouts. */
function entriesOf(history: unknown, out: Array<[number, unknown]> = []): Array<[number, unknown]> {
  if (Array.isArray(history)) {
    history.forEach((e, i) => {
      let n: number | undefined;
      if (isRec(e)) for (const k of NUMBER_KEYS) n ??= asInt(e[k]);
      out.push([n ?? i, standingOf(e)]);
    });
    return out;
  }
  if (!isRec(history)) return out;
  const turns = history.turns ?? history.Turns;
  if (turns !== undefined) return entriesOf(turns, out);
  for (const [k, v] of Object.entries(history)) {
    const m = /^(?:turn|standing)?_?(\d+)$/i.exec(k);
    if (m) out.push([Number(m[1]), standingOf(v)]);
  }
  return out;
}

/**
 * The standing after `completedTurns` turns from a raw `GetHistory` payload,
 * with owners keyed by GameFeed player id; `undefined` when it is absent or
 * unusable. An entry's number is read as the count of completed turns its
 * standing reflects (an assumption: the in-progress shape is unverified).
 * Never throws.
 */
export function boardFromHistory(
  history: unknown,
  completedTurns: number,
  players: readonly Player[],
): BoardState | undefined {
  try {
    const raw = entriesOf(history).find(([n]) => n === completedTurns)?.[1];
    return feedOwners(boardFromStanding(raw), players);
  } catch {
    return undefined;
  }
}

/** A parsed board with in-game owner ids mapped back to GameFeed player ids. */
function feedOwners(board: BoardState | undefined, players: readonly Player[]): BoardState | undefined {
  if (!board) return undefined;
  const byInGame = playersByInGameId(players);
  const feedIds = new Set(players.map((p) => p.id));
  return {
    ...board,
    territories: board.territories.map((t): TerritoryState => {
      if (t.owner.kind !== 'player' || feedIds.has(t.owner.playerId)) return t;
      const p = byInGame.get(t.owner.playerId);
      return p ? { ...t, owner: { kind: 'player', playerId: p.id } } : t;
    }),
  };
}

/**
 * Every usable standing in a raw `GetHistory` payload, ascending by entry
 * number (completed turns, as {@link boardFromHistory} reads it), owners keyed
 * by GameFeed player id. Entries that do not parse are left out; the first of
 * two entries with one number wins. Never throws.
 */
export function historyBoards(
  history: unknown,
  players: readonly Player[],
): Array<{ turn: number; board: BoardState }> {
  try {
    const seen = new Set<number>();
    const out: Array<{ turn: number; board: BoardState }> = [];
    for (const [turn, raw] of entriesOf(history)) {
      if (seen.has(turn)) continue;
      const board = feedOwners(boardFromStanding(raw), players);
      if (!board) continue;
      seen.add(turn);
      out.push({ turn, board });
    }
    return out.sort((a, b) => a.turn - b.turn);
  } catch {
    return [];
  }
}

/** Where the last planned boards of a game are cached. */
export const boardCachePath = (dir: string, gameId: number) => join(dir, 'boards', `${gameId}.json`);

/**
 * Turns kept per game: enough history for opponent tracking (an estimate over the
 * last three observed turns needs four boards; more shows where the armies went
 * since an opponent was first seen), and a turn planned again (another goal, or
 * after a hand override) still finds the board of the turn before it.
 */
export const CACHED_TURNS = 10;

/** A game's cached boards not written for this long are deleted (finished or abandoned games). */
export const BOARD_CACHE_MAX_AGE_MS = 60 * 86_400_000;
const BOARD_FILE = /^\d+\.json$/;
/** Board directories pruned by this process: once is enough. */
const pruned = new Set<string>();

/** Delete the board caches of games not written for {@link BOARD_CACHE_MAX_AGE_MS}. Best effort. */
async function pruneBoardCaches(dir: string): Promise<void> {
  const boards = join(dir, 'boards');
  if (pruned.has(boards)) return;
  pruned.add(boards);
  const cutoff = Date.now() - BOARD_CACHE_MAX_AGE_MS;
  try {
    for (const name of await readdir(boards)) {
      if (!BOARD_FILE.test(name)) continue;
      const file = join(boards, name);
      try {
        if ((await stat(file)).mtimeMs < cutoff) await unlink(file);
      } catch {
        // Gone already, or unreadable: leave it.
      }
    }
  } catch {
    // No board directory yet.
  }
}

interface CachedBoards {
  gameId: number;
  playerId: number;
  turns: Record<string, BoardState>;
  /** The orders this server sent, by turn (#119); absent when none were. */
  orders?: Record<string, MyOrders>;
}

/** The raw cache for `gameId` as `playerId` saw it: boards and orders by turn; empty when absent or unusable. */
async function readCache(
  dir: string,
  gameId: number,
  playerId: number,
): Promise<{ turns: Record<string, unknown>; orders: Record<string, unknown> }> {
  try {
    const c: unknown = JSON.parse(await readFile(boardCachePath(dir, gameId), 'utf8'));
    if (!isRec(c) || c.gameId !== gameId || c.playerId !== playerId) return { turns: {}, orders: {} };
    const orders = isRec(c.orders) ? c.orders : {};
    if (isRec(c.turns)) return { turns: c.turns, orders };
    // A single-board cache written before turns were kept.
    if (typeof c.turn === 'number') return { turns: { [String(c.turn)]: c.board }, orders };
    return { turns: {}, orders };
  } catch {
    return { turns: {}, orders: {} };
  }
}

/** The cached boards by turn for `gameId` as `playerId` saw them; `{}` when absent or unusable. */
async function readCachedTurns(dir: string, gameId: number, playerId: number): Promise<Record<string, unknown>> {
  return (await readCache(dir, gameId, playerId)).turns;
}

/** The newest {@link CACHED_TURNS} numeric keys of `rec` at or below `upTo`, ascending. */
function newestTurns(rec: Record<string, unknown>, upTo = Infinity): number[] {
  return Object.keys(rec)
    .filter((k) => /^\d+$/.test(k) && Number(k) <= upTo)
    .map(Number)
    .sort((a, b) => b - a)
    .slice(0, CACHED_TURNS)
    .sort((a, b) => a - b);
}

/** Write a game's cache file atomically, then prune old games. */
async function writeCache(dir: string, body: CachedBoards): Promise<void> {
  const path = boardCachePath(dir, body.gameId);
  await mkdir(join(dir, 'boards'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
  await rename(tmp, path);
  await pruneBoardCaches(dir);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Cached orders, loosely: unusable entries are dropped, never thrown on. */
function ordersOf(o: unknown): MyOrders | undefined {
  if (!isRec(o) || !Array.isArray(o.deploys) || !Array.isArray(o.moves)) return undefined;
  return {
    deploys: (o.deploys as unknown[])
      .filter((d): d is Rec => isRec(d) && isNum(d.territoryId) && isNum(d.armies))
      .map((d) => ({ territoryId: d.territoryId as number, armies: d.armies as number })),
    moves: (o.moves as unknown[])
      .filter((m): m is Rec => isRec(m) && isNum(m.from) && isNum(m.to) && isNum(m.armies))
      .map((m) => ({ from: m.from as number, to: m.to as number, armies: m.armies as number })),
  };
}

/** The orders this server sent for `gameId` as `playerId`, by turn (#119); empty when none. Never throws. */
export async function readCachedOrders(dir: string, gameId: number, playerId: number): Promise<Map<number, MyOrders>> {
  const { orders } = await readCache(dir, gameId, playerId);
  const out = new Map<number, MyOrders>();
  for (const turn of newestTurns(orders)) {
    const o = ordersOf(orders[String(turn)]);
    if (o) out.set(turn, o);
  }
  return out;
}

/**
 * Cache the deploys and moves this server sent for turn `turn` of `gameId` as `playerId` (#119),
 * keeping the newest {@link CACHED_TURNS} turns of orders and every cached board; the newest send
 * for a turn wins. Never throws.
 */
export async function writeOrdersCache(
  dir: string,
  gameId: number,
  playerId: number,
  turn: number,
  orders: MyOrders,
): Promise<boolean> {
  try {
    const cache = await readCache(dir, gameId, playerId);
    const all = { ...cache.orders, [String(turn)]: { deploys: orders.deploys, moves: orders.moves } };
    const kept: Record<string, MyOrders> = {};
    for (const n of newestTurns(all)) kept[String(n)] = all[String(n)] as MyOrders;
    await writeCache(dir, { gameId, playerId, turns: cache.turns as Record<string, BoardState>, orders: kept });
    return true;
  } catch {
    return false;
  }
}

/**
 * The board this server planned on for `gameId`, only when it was planned for
 * `playerId` on exactly turn `turn`; `undefined` otherwise. Never throws.
 */
export async function readBoardCache(
  dir: string,
  gameId: number,
  playerId: number,
  turn: number,
): Promise<BoardState | undefined> {
  return boardOf((await readCachedTurns(dir, gameId, playerId))[String(turn)]);
}

/** A cached board, loosely: unusable entries are dropped, never thrown on. */
function boardOf(b: unknown): BoardState | undefined {
  if (!isRec(b) || !Array.isArray(b.territories)) return undefined;
  const territories = (b.territories as unknown[]).filter(
    (t): t is TerritoryState =>
      isRec(t) &&
      typeof t.territoryId === 'number' &&
      isRec(t.owner) &&
      (typeof t.armies === 'number' || t.armies === null),
  );
  return { source: b.source === 'gamefeed' ? 'gamefeed' : 'browser', verified: b.verified === true, territories };
}

/**
 * Every board cached for `gameId` as `playerId` saw it, oldest turn first, only turns below
 * `before` when given; `[]` when there are none. Never throws.
 */
export async function readBoardHistory(
  dir: string,
  gameId: number,
  playerId: number,
  before?: number,
): Promise<{ turn: number; board: BoardState }[]> {
  const turns = await readCachedTurns(dir, gameId, playerId);
  const out: { turn: number; board: BoardState }[] = [];
  for (const [k, v] of Object.entries(turns)) {
    if (!/^\d+$/.test(k)) continue;
    const turn = Number(k);
    if (before !== undefined && turn >= before) continue;
    const board = boardOf(v);
    if (board) out.push({ turn, board });
  }
  return out.sort((a, b) => a.turn - b.turn);
}

/**
 * Cache the board just planned on (turn `turn` of `gameId`, as `playerId` sees
 * it), keeping the newest {@link CACHED_TURNS} turns; a different player's
 * cache is replaced. Never throws.
 */
export async function writeBoardCache(
  dir: string,
  gameId: number,
  playerId: number,
  turn: number,
  board: BoardState,
): Promise<boolean> {
  try {
    const cache = await readCache(dir, gameId, playerId);
    const kept = { ...cache.turns, [String(turn)]: board };
    const turns: Record<string, BoardState> = {};
    for (const n of newestTurns(kept, turn)) turns[String(n)] = kept[String(n)] as BoardState;
    const orders = Object.keys(cache.orders).length ? { orders: cache.orders as Record<string, MyOrders> } : {};
    await writeCache(dir, { gameId, playerId, turns, ...orders });
    return true;
  } catch {
    return false;
  }
}
