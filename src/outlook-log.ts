// The outlook log (#178): per game, the strength ratio of every turn this server planned and the
// latest outlook, plus the final result once a game this server logs is seen finished. Local
// only, at `<dataDir>/outlook/<gameId>.json`, and name-free (player ids and figures, no names):
// it is the data the outlook's thresholds are to be calibrated from (OUTLOOK_RATIO is borrowed).
// Best effort: never throws.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { GameOutlook, OutlookState } from './analysis/outlook.js';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Turns kept per game (a long game is still a small file). */
export const OUTLOOK_LOG_TURNS = 500;

export const outlookLogPath = (dir: string, gameId: number) => join(dir, 'outlook', `${gameId}.json`);

export interface OutlookLogTurn {
  /** My strength. */
  mine: number;
  /** The strongest opponent's strength range (`high` `null`: unbounded). */
  low: number | null;
  high: number | null;
  ratio: { low: number; high: number | null };
  state: OutlookState;
}

export interface OutlookLog {
  gameId: number;
  playerId: number;
  turns: Record<string, OutlookLogTurn>;
  /** The outlook of the newest turn planned. */
  latest?: { turn: number; state: OutlookState | null; heldTurns: number; basis: string };
  /** My GameFeed state once the game was seen finished (e.g. `Won`, `Eliminated`, `SurrenderAccepted`). */
  result?: string;
}

/** The log of `gameId` as `playerId` played it; `undefined` when absent, another player's, or unusable. */
export async function readOutlookLog(dir: string, gameId: number, playerId: number): Promise<OutlookLog | undefined> {
  try {
    const c: unknown = JSON.parse(await readFile(outlookLogPath(dir, gameId), 'utf8'));
    if (!isRec(c) || c.gameId !== gameId || c.playerId !== playerId || !isRec(c.turns)) return undefined;
    return c as unknown as OutlookLog;
  } catch {
    return undefined;
  }
}

async function write(dir: string, log: OutlookLog): Promise<void> {
  const path = outlookLogPath(dir, log.gameId);
  await mkdir(join(dir, 'outlook'), { recursive: true, mode: 0o700 });
  // Unique per write: two plans of one game in this process must not share (and race on) a temp file.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(log), { mode: 0o600 });
  await rename(tmp, path);
}

/** Add the outlook's turns to the log and make it the latest. Best effort. */
export async function recordOutlook(dir: string, gameId: number, playerId: number, outlook: GameOutlook): Promise<void> {
  try {
    const log = (await readOutlookLog(dir, gameId, playerId)) ?? { gameId, playerId, turns: {} };
    for (const t of outlook.turns)
      log.turns[String(t.turn)] = {
        mine: t.mine,
        low: t.strongest?.low ?? null,
        high: t.strongest?.high ?? null,
        ratio: t.ratio,
        state: t.state,
      };
    const keep = Object.keys(log.turns)
      .map(Number)
      .sort((a, b) => b - a)
      .slice(0, OUTLOOK_LOG_TURNS);
    log.turns = Object.fromEntries(keep.sort((a, b) => a - b).map((k) => [String(k), log.turns[String(k)]!]));
    const last = outlook.turns.at(-1);
    if (last) log.latest = { turn: last.turn, state: outlook.state, heldTurns: outlook.heldTurns, basis: outlook.basis };
    await write(dir, log);
  } catch {
    // The log is optional.
  }
}

/** Record the final result of a game the log already holds; `true` when written. Best effort. */
export async function recordResult(dir: string, gameId: number, playerId: number, result: string): Promise<boolean> {
  try {
    const log = await readOutlookLog(dir, gameId, playerId);
    if (!log) return false;
    if (log.result === result) return true;
    await write(dir, { ...log, result });
    return true;
  } catch {
    return false;
  }
}

/**
 * When `game` is finished and this server logs it, record the logged player's final GameFeed state
 * as the result; `true` when written. Best effort.
 */
export async function recordFinalResult(
  dir: string,
  game: { id: number; state: string; players: ReadonlyArray<{ id: number; state?: string }> },
): Promise<boolean> {
  if (game.state !== 'Finished') return false;
  try {
    const c: unknown = JSON.parse(await readFile(outlookLogPath(dir, game.id), 'utf8'));
    if (!isRec(c) || typeof c.playerId !== 'number') return false;
    const playerId = c.playerId;
    const state = game.players.find((p) => p.id === playerId)?.state;
    return state === undefined ? false : await recordResult(dir, game.id, playerId, state);
  } catch {
    return false;
  }
}
