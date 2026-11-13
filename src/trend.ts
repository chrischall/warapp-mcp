// The previous turn's board, for the planner's threat trend. Best effort and
// never throws: GameFeed's `GetHistory` standing for the previous turn when the
// feed sends one (UNVERIFIED for games in progress — see docs/WARAPP-API.md),
// else the board this server planned on for the previous turn, cached on disk
// (the newest CACHED_TURNS turns per game, planned or tracked: opponent tracking
// reads the whole history).
//
// The cache holds only the player's own fogged view (what the live board
// showed them), at `<dataDir>/boards/<gameId>.json`.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boardFromStanding, type BoardState, type TerritoryState } from './board.js';
import { playersByInGameId } from './live.js';
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

interface CachedBoards {
  gameId: number;
  playerId: number;
  turns: Record<string, BoardState>;
}

/** The cached boards by turn for `gameId` as `playerId` saw them; `{}` when absent or unusable. */
async function readCachedTurns(dir: string, gameId: number, playerId: number): Promise<Record<string, unknown>> {
  try {
    const c: unknown = JSON.parse(await readFile(boardCachePath(dir, gameId), 'utf8'));
    if (!isRec(c) || c.gameId !== gameId || c.playerId !== playerId) return {};
    if (isRec(c.turns)) return c.turns;
    // A single-board cache written before turns were kept.
    if (typeof c.turn === 'number') return { [String(c.turn)]: c.board };
    return {};
  } catch {
    return {};
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
    const path = boardCachePath(dir, gameId);
    const kept = { ...(await readCachedTurns(dir, gameId, playerId)), [String(turn)]: board };
    const newest = Object.keys(kept)
      .filter((k) => /^\d+$/.test(k) && Number(k) <= turn)
      .map(Number)
      .sort((a, b) => b - a)
      .slice(0, CACHED_TURNS)
      .sort((a, b) => a - b);
    const turns: Record<string, BoardState> = {};
    for (const n of newest) turns[String(n)] = kept[String(n)] as BoardState;
    await mkdir(join(dir, 'boards'), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    const body: CachedBoards = { gameId, playerId, turns };
    await writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}
