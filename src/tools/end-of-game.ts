// The end-of-game pass (#312 E1; owner decisions P2–P4 of 2026-11-16): once per finished game the
// account played, read the game's history ONCE (GameFeed GetHistory with its settings; the map from
// the cache when the game's map is known, else in the same reply), capture what it teaches
// (src/analysis/finished-game.ts) and keep it name-free (src/finished-store.ts). The record is the
// "processed" mark: a game with one is never read again by a trigger, whatever its status — a failed
// read is recorded and NOT retried automatically; an explicit warapp_get_game with `include_history`
// re-runs a failed pass from the history that call already read (no further request).
//
// Triggers: any read that shows the game finished (warapp_get_game, warapp_wait_for_turn's read), and
// the sweep in warapp_my_games over the account's finished games not yet processed, at most
// `END_OF_GAME_PER_CALL` per call (the records themselves are its cursor: each attempt leaves one, so
// the next call moves on). Off with `WARAPP_PLAYER_PROFILE=off`; nothing without a data directory.
// Profiles inform only (P1): no planner decision reads any of this. Never throws.
import type { EnvSource } from '@chrischall/mcp-utils';
import { captureFinished, type FinishedCapture } from '../analysis/finished-game.js';
import type { WarappClient } from '../client.js';
import { finishedPath, finishedRecordOf, readFinishedState, writeFinishedRecord, type FinishedFailure, type FinishedRecord, type FinishedStatus } from '../finished-store.js';
import type { Game } from '../normalize.js';
import { withPathLock } from '../path-lock.js';
import { readPickRecord } from '../pick-list.js';
import { playerRecordSalt, playerSaltForWrite } from '../player-record-store.js';
import { holdsSeat } from '../player-states.js';
import { profileEnabled } from '../profile-store.js';
import { nameFreeSettings } from '../replay.js';
import { historyBoards, historyReport, readCachedOrders, readCachedPlayer } from '../trend.js';
import { graphOf } from './common.js';
import { mapOf } from './map.js';
import { foldFinished, type FinishedFold } from './profile-hook.js';

/** Finished games the warapp_my_games sweep processes per call (each one GameFeed history read). */
export const END_OF_GAME_PER_CALL = 2;

/** What one pass did. */
export type EndOfGameStatus =
  | FinishedStatus
  /** A record was already there (any status): nothing read. */
  | 'already-processed'
  /** A record exists but does not parse: never overwritten, nothing read. */
  | 'record-unreadable'
  | 'off'
  | 'no-data-dir'
  | 'not-finished'
  /** The account is not seated in the game (P3: only games it played). */
  | 'not-a-player'
  /** Which account is mine could not be told. */
  | 'account-unknown'
  /** The salt is malformed (never regenerated), so no record can be keyed. */
  | 'unavailable'
  /** The record could not be written. */
  | 'failed';

export interface EndOfGameResult {
  status: EndOfGameStatus;
  /** History boards captured. */
  turns?: number;
  /** With `history-unreadable` / `read-failed`: why. */
  failure?: FinishedFailure;
  /** The profile fold, when the pass ran it (the warapp_my_games sweep). */
  profileFold?: FinishedFold;
}

export interface EndOfGameDeps {
  client: WarappClient;
  dataDir: string | undefined;
  env: EnvSource;
}

export interface EndOfGameOptions {
  /** A read of this game WITH its history (warapp_get_game's `include_history`): used instead of a request. */
  history?: Game | undefined;
  /** Re-run a pass whose record is a failure (an explicit call; never a trigger). */
  retry?: boolean;
  /** Also fold the game's opponent profiles (`foldFinished`; the sweep, whose callers do not fold). */
  fold?: boolean;
}

const SAFE = /^[a-z_]{1,40}$/;

/**
 * Whether `gameId` still needs its pass as `me`: `true` unless a record is there (or the pass cannot
 * run: off, no data dir, malformed salt). Read-only: never makes the salt. Never throws.
 */
export async function needsEndOfGame(dataDir: string | undefined, env: EnvSource, gameId: number, me: number): Promise<boolean> {
  if (!dataDir || !profileEnabled(env)) return false;
  try {
    const salt = await playerRecordSalt(dataDir);
    if (!salt) return true;
    return (await readFinishedState(finishedPath(dataDir, salt, me, gameId))) === 'missing';
  } catch {
    return false;
  }
}

/**
 * The end-of-game pass for `gameId` as `me` (the GameFeed id). `seen` is the read that showed it
 * finished (absent from the sweep, whose own read serves). Never throws.
 */
export async function endOfGame(
  deps: EndOfGameDeps,
  gameId: number,
  me: number | undefined,
  seen: Game | undefined,
  opts: EndOfGameOptions = {},
): Promise<EndOfGameResult> {
  const { dataDir, env } = deps;
  if (!profileEnabled(env)) return { status: 'off' };
  if (!dataDir) return { status: 'no-data-dir' };
  if (me === undefined) return { status: 'account-unknown' };
  if (seen && seen.state !== 'Finished') return { status: 'not-finished' };
  if (seen && !seen.players.some((p) => p.id === me && holdsSeat(p.state))) return { status: 'not-a-player' };
  try {
    const salt = await playerSaltForWrite(dataDir);
    if (!salt) return { status: 'unavailable' };
    const path = finishedPath(dataDir, salt, me, gameId);
    let read: Game | undefined;
    const result = await withPathLock(path, async (): Promise<EndOfGameResult> => {
      const state = await readFinishedState(path);
      if (state === 'unreadable') return { status: 'record-unreadable' };
      if (state !== 'missing' && (!opts.retry || state.status === 'captured' || !opts.history)) return { status: 'already-processed' };
      // The one history read: the caller's, else one request, never retried.
      let game: Game | undefined = opts.history;
      let failure: FinishedFailure | undefined;
      if (!game) {
        try {
          game = await deps.client.getGame(gameId, { history: true, settings: true });
        } catch (e) {
          const kind = (e as { kind?: unknown }).kind;
          failure = { reason: 'request-failed', ...(typeof kind === 'string' && SAFE.test(kind) ? { kind } : {}) };
        }
      }
      if (game && game.state !== 'Finished') return { status: 'not-finished' };
      if (game && !game.players.some((p) => p.id === me && holdsSeat(p.state))) return { status: 'not-a-player' };
      read = game;
      const shown = game ?? seen;
      const record = await buildRecord(dataDir, salt, me, gameId, game, shown, failure);
      try {
        await writeFinishedRecord(dataDir, path, record);
      } catch {
        return { status: 'failed' };
      }
      return {
        status: record.status,
        ...(record.turns ? { turns: record.turns.length } : {}),
        ...(record.failure ? { failure: record.failure } : {}),
      };
    });
    if (opts.fold && (result.status === 'captured' || result.status === 'history-unreadable')) {
      const game = read ?? seen;
      if (game) result.profileFold = await foldFinished(dataDir, env, game);
    }
    return result;
  } catch {
    return { status: 'failed' };
  }
}

/** The record of one pass: the capture when the history read, else what the reads that came say. */
async function buildRecord(
  dataDir: string,
  salt: string,
  me: number,
  gameId: number,
  read: Game | undefined,
  shown: Game | undefined,
  failure: FinishedFailure | undefined,
): Promise<FinishedRecord> {
  const pick = await readPickRecord(dataDir, gameId, me);
  const picks = pick?.list ? { list: pick.list, ...(pick.award !== undefined ? { award: pick.award } : {}) } : null;
  const common = {
    salt,
    me,
    game: shown,
    settings: shown ? nameFreeSettings(shown) : undefined,
    mapId: shown?.settings?.mapId ?? shown?.map?.id,
    picks,
  };
  if (!read) return finishedRecordOf({ ...common, status: 'read-failed', failure, capture: capture(shown, me, [], new Map(), undefined) });
  const report = historyReport(read);
  const orders = (await readCachedPlayer(dataDir, gameId)) === me ? await readCachedOrders(dataDir, gameId, me) : new Map();
  const map = read.map ? mapOf(read) : undefined;
  if ('unreadable' in report) {
    const u = report.unreadable;
    return finishedRecordOf({
      ...common,
      status: 'history-unreadable',
      failure: { reason: u.reason, keys: u.keys, ...(u.layout ? { layout: u.layout } : {}), ...(u.shape ? { shape: u.shape } : {}), ...(u.turns !== undefined ? { turns: u.turns } : {}) },
      capture: capture(read, me, [], orders, undefined),
    });
  }
  const boards = historyBoards(read.history, read.players, read.numberOfTurns !== undefined ? { numberOfTurns: read.numberOfTurns } : {});
  return finishedRecordOf({
    ...common,
    status: 'captured',
    layout: report.read.layout,
    noMap: !map,
    capture: capture(read, me, boards, orders, map ? graphOf(map) : undefined),
  });
}

function capture(
  game: Game | undefined,
  me: number,
  boards: Parameters<typeof captureFinished>[0]['boards'],
  orders: Parameters<typeof captureFinished>[0]['orders'],
  graph: Parameters<typeof captureFinished>[0]['graph'],
): FinishedCapture | undefined {
  if (!game) return undefined;
  return captureFinished({
    graph,
    settings: game.settings,
    me,
    players: game.players.filter((p) => holdsSeat(p.state)),
    numberOfTurns: game.numberOfTurns,
    boards,
    orders,
  });
}

/** The account a finished game was played as, with no request: the board cache's, else `identity` (the signed-in account). */
export async function finishedAccount(
  dataDir: string | undefined,
  gameId: number,
  identity?: () => Promise<number | undefined>,
): Promise<number | undefined> {
  const cached = dataDir ? await readCachedPlayer(dataDir, gameId) : undefined;
  if (cached !== undefined) return cached;
  try {
    return await identity?.();
  } catch {
    return undefined;
  }
}

/**
 * The sweep (warapp_my_games): of `gameIds` (finished games of mine, newest first), process at most
 * `limit` not yet processed, one at a time, each folding its profiles too. `pending` counts those
 * left for a later call. Never throws.
 */
export async function sweepFinished(
  deps: EndOfGameDeps,
  me: number,
  gameIds: readonly number[],
  limit = END_OF_GAME_PER_CALL,
): Promise<{ processed: { gameId: number; status: EndOfGameStatus; turns?: number }[]; pending: number }> {
  const todo: number[] = [];
  for (const id of gameIds) if (await needsEndOfGame(deps.dataDir, deps.env, id, me)) todo.push(id);
  const processed: { gameId: number; status: EndOfGameStatus; turns?: number }[] = [];
  for (const id of todo.slice(0, limit)) {
    const r = await endOfGame(deps, id, me, undefined, { fold: true });
    processed.push({ gameId: id, status: r.status, ...(r.turns !== undefined ? { turns: r.turns } : {}) });
  }
  return { processed, pending: Math.max(0, todo.length - limit) };
}
