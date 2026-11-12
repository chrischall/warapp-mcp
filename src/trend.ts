// The previous turn's board, for the planner's threat trend. Best effort and
// never throws: GameFeed's `GetHistory` standing for the previous turn when the
// feed sends one (UNVERIFIED for games in progress — see docs/WARAPP-API.md),
// else the board this server last planned on for the game, cached on disk.
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
    const board = boardFromStanding(raw);
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
  } catch {
    return undefined;
  }
}

/** Where the last planned board of a game is cached. */
export const boardCachePath = (dir: string, gameId: number) => join(dir, 'boards', `${gameId}.json`);

interface CachedBoard {
  gameId: number;
  playerId: number;
  turn: number;
  board: BoardState;
}

/**
 * The board this server last planned on for `gameId`, only when it was planned
 * for `playerId` on exactly turn `turn`; `undefined` otherwise. Never throws.
 */
export async function readBoardCache(
  dir: string,
  gameId: number,
  playerId: number,
  turn: number,
): Promise<BoardState | undefined> {
  try {
    const c = JSON.parse(await readFile(boardCachePath(dir, gameId), 'utf8')) as Partial<CachedBoard>;
    if (c.gameId !== gameId || c.playerId !== playerId || c.turn !== turn) return undefined;
    const b = c.board;
    if (!isRec(b) || !Array.isArray(b.territories)) return undefined;
    const territories = (b.territories as unknown[]).filter(
      (t): t is TerritoryState =>
        isRec(t) &&
        typeof t.territoryId === 'number' &&
        isRec(t.owner) &&
        (typeof t.armies === 'number' || t.armies === null),
    );
    return { source: b.source === 'gamefeed' ? 'gamefeed' : 'browser', verified: b.verified === true, territories };
  } catch {
    return undefined;
  }
}

/** Cache the board just planned on (turn `turn` of `gameId`, as `playerId` sees it). Never throws. */
export async function writeBoardCache(
  dir: string,
  gameId: number,
  playerId: number,
  turn: number,
  board: BoardState,
): Promise<boolean> {
  try {
    const path = boardCachePath(dir, gameId);
    await mkdir(join(dir, 'boards'), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    const body: CachedBoard = { gameId, playerId, turn, board };
    await writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}
