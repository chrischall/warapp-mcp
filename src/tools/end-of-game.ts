// The end-of-game pass (#312 E1; owner decisions P2–P4 of 2026-11-16): once per finished game the
// account played, read the game's history ONCE (GameFeed GetHistory with its settings and GetMap=false:
// a cached map is attached by its id, and the client's refresh of a map that lacks land never runs, and
// with `noRetry` the client does not re-send it on a 429 or 5xx, so the history is never read twice; with no map cached, one map-only read without the history follows),
// capture what it teaches (src/analysis/finished-game.ts) and keep it name-free (src/finished-store.ts).
// The record is the "processed" mark, and a separate bounded list of hashed keys (`markProcessed`, ten
// times the record bound) outlives its prune: a game with either is never read again by a trigger,
// whatever its status — a failed read is recorded and NOT retried automatically; an explicit
// warapp_get_game with `include_history` re-runs a failed pass from the history that call already read
// (no further request); a pass from a caller's history leaves the lasting mark too. A reply showing the game still in play leaves no lasting mark (it may end later).
//
// Triggers: any read that shows the game finished (warapp_get_game, warapp_wait_for_turn's read), a
// game-ended in-app notification (warapp_get_notifications, at most `END_OF_GAME_PER_CALL` per call), and
// the sweep in warapp_my_games over the account's finished games not yet processed, at most
// `END_OF_GAME_PER_CALL` per call (the marks are its cursor: each attempt leaves one, so the next call
// moves on). A pass that spent its request but left no record is remembered for the life of the process
// too (`attempted`), so no trigger reads that game's history twice (P2: never retried in a loop).
// Off with `WARAPP_PLAYER_PROFILE=off`; nothing without a data directory.
// Profiles inform only (P1): no planner decision reads any of this. Never throws.
import type { EnvSource } from '@chrischall/mcp-utils';
import type { BoardState } from '../board.js';
import { captureFinished, type FinishedCapture } from '../analysis/finished-game.js';
import {
  aggregateCalibration,
  calibrationSamples,
  flatTurn,
  historyHabits,
  incomeCurve,
  lessonLoss,
  mapFacts,
} from '../analysis/game-lessons.js';
import type { MapGraph } from '../analysis/graph.js';
import { profileFormatOf } from '../analysis/opponent-profile.js';
import { trackGame, type MyOrders, type TurnBoard } from '../analysis/opponents.js';
import { recordLessons, recordMapGame } from '../lessons-store.js';
import { endingOf, foldGame, markHistoryFolded, profileFileState, type FoldSeat } from '../profile-store.js';
import type { WarappClient } from '../client.js';
import {
  MAX_FINISHED_RECORDS,
  finishedPath,
  finishedRecordOf,
  markProcessed,
  readFinishedState,
  readProcessed,
  touchFinished,
  writeFinishedRecord,
  type FinishedFailure,
  type FinishedRecord,
  type FinishedStatus,
} from '../finished-store.js';
import type { Game } from '../normalize.js';
import { withPathLock } from '../path-lock.js';
import { finalOutlookOf, readOutlookLog } from '../outlook-log.js';
import { readPickRecord } from '../pick-list.js';
import { finishedGameKey, playerRecordSalt, playerSaltForWrite } from '../player-record-store.js';
import { holdsSeat } from '../player-states.js';
import { profileEnabled } from '../profile-store.js';
import { nameFreeSettings } from '../replay.js';
import { historyBoards, historyReport, readBoardHistory, readCachedOrders, readCachedPlayer } from '../trend.js';
import { graphOf } from './common.js';
import { mapOf } from './map.js';
import { cardsInPlay, foldFinished, observeSettings, profiledOpponents, type FinishedFold } from './profile-hook.js';
import { keptTeams } from './team-source.js';
import { plannerSettings } from './turn.js';

/** Finished games the warapp_my_games sweep processes per call (each one GameFeed history read). */
export const END_OF_GAME_PER_CALL = 2;

/** What one pass did. */
export type EndOfGameStatus =
  | FinishedStatus
  /** A record was already there (any status): nothing read. */
  | 'already-processed'
  /** This process already spent the history read on it (no record could be kept): nothing read. */
  | 'attempted'
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
  /** With `captured`: what the history was processed into (#312 E2). */
  processed?: Processed;
}

/**
 * What a captured history was processed into (#312 E2): the opponent profiles folded from it (part C),
 * the map's record, and the lessons store. `no-map`: the map was not had, so no income or adjacency;
 * `teams-unknown`: a game of 3+ seats whose teams could not be read (teammates are never profiled);
 * `nothing`: no opponent turn observed.
 */
export interface Processed {
  profiles: 'folded' | 'nothing' | 'no-map' | 'teams-unknown' | 'failed';
  map: 'kept' | 'no-map' | 'failed';
  lessons: 'kept' | 'no-map' | 'failed';
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
  /** The store bound (tests; default `MAX_FINISHED_RECORDS`). */
  keep?: number;
  /** Games whose records this pass's prune must keep (the sweep's window). */
  protectIds?: readonly number[];
}

const SAFE = /^[a-z_]{1,40}$/;

/** Bound on the in-process memos below (oldest forgotten first). */
const MEMO_LIMIT = 1000;

function remember(set: Set<string>, key: string): void {
  set.delete(key);
  set.add(key);
  while (set.size > MEMO_LIMIT) set.delete(set.values().next().value as string);
}

/**
 * Games (per data dir and account) whose history request this process already spent, whatever came
 * of it: a game in here is never read again by any trigger in this process, even when no record
 * could be written (a read-only or full data dir) or the reply showed it not finished or not mine.
 */
const attempted = new Set<string>();
const attemptKey = (dataDir: string, me: number, gameId: number): string => `${dataDir}\0${me}\0${gameId}`;

/** Finished games (per data dir) whose signed-in account could not be read for the pass: asked once per process. */
const accountUnread = new Set<string>();

/** Whether a pass on `gameId` as `me` spent its history read before (the lasting mark; an unreadable marks file: no). */
async function isMarked(dataDir: string, salt: string, me: number, gameId: number): Promise<boolean> {
  const marks = await readProcessed(dataDir);
  return marks !== 'unreadable' && marks.has(finishedGameKey(salt, me, gameId));
}

/**
 * Whether `gameId` still needs its pass as `me`: `true` unless a record or a processed mark is there
 * (or the pass cannot run: off, no data dir, malformed salt; or this process already spent its read). Read-only: never makes the salt. Never throws.
 */
export async function needsEndOfGame(dataDir: string | undefined, env: EnvSource, gameId: number, me: number): Promise<boolean> {
  if (!dataDir || !profileEnabled(env)) return false;
  if (attempted.has(attemptKey(dataDir, me, gameId))) return false;
  try {
    const salt = await playerRecordSalt(dataDir);
    if (!salt) return true;
    if ((await readFinishedState(finishedPath(dataDir, salt, me, gameId))) !== 'missing') return false;
    return !(await isMarked(dataDir, salt, me, gameId));
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
      // The one history read: the caller's, else one request, sent once (no transport retry) and never retried.
      let game: Game | undefined = opts.history;
      let failure: FinishedFailure | undefined;
      if (!game) {
        if (state === 'missing' && (await isMarked(dataDir, salt, me, gameId))) return { status: 'already-processed' };
        // The request is spent from here on, whatever follows: never again in this process.
        const key = attemptKey(dataDir, me, gameId);
        if (attempted.has(key)) return { status: 'attempted' };
        remember(attempted, key);
        try {
          // P2: GetMap=false, so the client never re-reads the game for a map it lacks (no `lacksTerritory`
          // refresh, which would repeat the history read); a cached map is attached by its id. `noRetry`:
          // a 429 or 5xx is not re-sent by the client's transport retry either, so the POST goes out once.
          game = await deps.client.getGame(gameId, { history: true, settings: true, map: false, noRetry: true });
        } catch (e) {
          const kind = (e as { kind?: unknown }).kind;
          failure = { reason: 'request-failed', ...(typeof kind === 'string' && SAFE.test(kind) ? { kind } : {}) };
        }
        // Still in play: no lasting mark (it may end later); this process remembers the attempt.
        if (game && game.state !== 'Finished') return { status: 'not-finished' };
        // The lasting mark, before anything else can fail: it outlives the record bound (P2).
        await markProcessed(dataDir, finishedGameKey(salt, me, gameId));
        // No map cached: one map-only read (no history), never a second history read.
        if (game && !game.map && game.players.some((p) => p.id === me && holdsSeat(p.state))) {
          const withMap = await deps.client.getGame(gameId).catch(() => undefined);
          if (withMap?.map) game.map = withMap.map;
        }
      }
      if (game && game.state !== 'Finished') return { status: 'not-finished' };
      if (game && !game.players.some((p) => p.id === me && holdsSeat(p.state))) return { status: 'not-a-player' };
      // The caller's history read is consumed here too: the lasting mark, so a pruned record is never re-read (P2).
      if (opts.history) await markProcessed(dataDir, finishedGameKey(salt, me, gameId));
      read = game;
      const shown = game ?? seen;
      const { record, history } = await buildRecord(dataDir, salt, me, gameId, game, shown, failure);
      try {
        const protect = opts.protectIds ? new Set(opts.protectIds.map((id) => finishedPath(dataDir, salt, me, id))) : undefined;
        await writeFinishedRecord(dataDir, path, record, opts.keep, protect);
      } catch {
        return { status: 'failed' };
      }
      const processed = history && game ? await processHistory(dataDir, env, salt, me, gameId, game, history) : undefined;
      return {
        status: record.status,
        ...(record.turns ? { turns: record.turns.length } : {}),
        ...(record.failure ? { failure: record.failure } : {}),
        ...(processed ? { processed } : {}),
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

/** What a captured history hands to {@link processHistory}. */
interface CapturedHistory {
  capture: FinishedCapture;
  boards: { turn: number; board: BoardState }[];
  orders: ReadonlyMap<number, MyOrders>;
  graph: MapGraph | undefined;
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
): Promise<{ record: FinishedRecord; history?: CapturedHistory }> {
  const pick = await readPickRecord(dataDir, gameId, me);
  const picks = pick?.list ? { list: pick.list, ...(pick.award !== undefined ? { award: pick.award } : {}) } : null;
  // #312: the final outlook line, when this server planned the game as me.
  const log = await readOutlookLog(dataDir, gameId, me);
  const outlook = log ? finalOutlookOf(log) : undefined;
  const common = {
    outlook,
    salt,
    me,
    game: shown,
    settings: shown ? nameFreeSettings(shown) : undefined,
    mapId: shown?.settings?.mapId ?? shown?.map?.id,
    picks,
  };
  if (!read) return { record: finishedRecordOf({ ...common, status: 'read-failed', failure, capture: capture(shown, me, [], new Map(), undefined) }) };
  const report = historyReport(read);
  const orders = (await readCachedPlayer(dataDir, gameId)) === me ? await readCachedOrders(dataDir, gameId, me) : new Map();
  const map = read.map ? mapOf(read) : undefined;
  if ('unreadable' in report) {
    const u = report.unreadable;
    return {
      record: finishedRecordOf({
        ...common,
        status: 'history-unreadable',
        failure: { reason: u.reason, keys: u.keys, ...(u.layout ? { layout: u.layout } : {}), ...(u.shape ? { shape: u.shape } : {}), ...(u.turns !== undefined ? { turns: u.turns } : {}) },
        capture: capture(read, me, [], orders, undefined),
      }),
    };
  }
  const boards = historyBoards(read.history, read.players, read.numberOfTurns !== undefined ? { numberOfTurns: read.numberOfTurns } : {});
  const graph = map ? graphOf(map) : undefined;
  const captured = capture(read, me, boards, orders, graph)!;
  return {
    record: finishedRecordOf({ ...common, status: 'captured', layout: report.read.layout, noMap: !map, capture: captured, boards }),
    history: { capture: captured, boards, orders, graph },
  };
}

/**
 * Process a captured history (#312 E2), each part on its own (one failing leaves the others): fold the
 * opponent profiles from it (part C: `observeTurn` over the full boards with my cached orders, `history`
 * replacing the live entry, never counting a game twice), keep the game in its map's record, and add
 * its lessons (the turn my income went flat, how I lost, and the tracker's estimates over my cached
 * boards scored against the truth by coverage). Never throws.
 */
async function processHistory(dataDir: string, env: EnvSource, salt: string, me: number, gameId: number, game: Game, h: CapturedHistory): Promise<Processed> {
  const out: Processed = { profiles: 'no-map', map: 'no-map', lessons: 'no-map' };
  const g = h.graph;
  if (!g) return out;
  const teams = await keptTeams(dataDir, game).catch(() => undefined);
  const resolved = teams?.game ?? game;
  const mine = resolved.players.find((p) => p.id === me);
  const seated = resolved.players.filter((p) => holdsSeat(p.state));
  const format = profileFormatOf(resolved.players);
  const opponents = mine ? profiledOpponents(resolved, mine) : resolved.players.filter((p) => p.id !== me).map((p) => p.id);
  const key = finishedGameKey(salt, me, gameId);
  const c = h.capture;
  try {
    out.profiles = !teams?.known || !mine ? 'teams-unknown' : await foldHistory(dataDir, env, me, gameId, resolved, opponents, format, seated.length, h);
  } catch {
    out.profiles = 'failed';
  }
  const mapId = game.settings?.mapId ?? game.map?.id;
  if (mapId !== undefined) {
    out.map = await recordMapGame(dataDir, mapId, {
      key,
      format,
      seats: seated.length,
      result: c.outcome.result,
      turns: c.outcome.turn,
      ...mapFacts(g, me, c.outcome.winners, c.starts, c.turns),
    });
  }
  try {
    const cachedOrders = await readCachedOrders(dataDir, gameId, me);
    const cached: TurnBoard[] = ((await readCachedPlayer(dataDir, gameId)) === me ? await readBoardHistory(dataDir, gameId, me) : []).map((b) => {
      const o = cachedOrders.get(b.turn);
      return { turn: b.turn, board: b.board, ...(o ? { orders: o } : {}) };
    });
    // Every seat as still playing: a final state would read a seat out on every earlier board.
    const asPlaying = resolved.players.map(({ state: _state, ...p }) => p);
    const samples = calibrationSamples({
      graph: g,
      me,
      cached,
      history: h.boards,
      plannerSettings: plannerSettings(game.settings),
      incomeSettings: game.settings,
      game: trackGame(asPlaying, game.settings, game.map),
      opponents,
    });
    out.lessons = await recordLessons(dataDir, {
      key,
      format,
      seats: seated.length,
      result: c.outcome.result,
      flatAfterTurn: flatTurn(incomeCurve(c.turns, me)),
      howLost: lessonLoss({
        result: c.outcome.result,
        me,
        boards: h.boards,
        orders: h.orders,
        graph: g,
        settings: game.settings,
        numberOfTurns: c.outcome.turn,
        outTurn: c.outcome.outTurn,
      }),
      calibration: aggregateCalibration(samples),
    });
  } catch {
    out.lessons = 'failed';
  }
  return out;
}

/** Part C: fold the opponents' habits read off the history, as `history` (replacing a live entry). */
async function foldHistory(
  dataDir: string,
  env: EnvSource,
  me: number,
  gameId: number,
  game: Game,
  opponents: readonly number[],
  format: ReturnType<typeof profileFormatOf>,
  players: number,
  h: CapturedHistory,
): Promise<Processed['profiles']> {
  const byId = new Map(game.players.map((p) => [p.id, p]));
  // Never a human who became an AI (no turn of the change is known).
  const watched = opponents.filter((id) => !byId.get(id)?.humanTurnedIntoAI);
  const habits = historyHabits({
    graph: h.graph!,
    me,
    boards: h.boards,
    orders: h.orders,
    settings: observeSettings(game),
    ...cardsInPlay(game),
    opponents: watched,
  });
  const seats: FoldSeat[] = [...habits].map(([id, hb]) => ({ id, ai: byId.get(id)?.isAI === true, habits: hb, ending: endingOf(byId.get(id)?.state) }));
  if (!seats.length) return 'nothing';
  const foldedBefore = (await profileFileState(dataDir, gameId, me)) === 'folded';
  const r = await foldGame(dataDir, { me, gameId, format, players, source: 'history', seats, foldedBefore }, env);
  if (r !== 'folded') return 'failed';
  await markHistoryFolded(dataDir, gameId, me);
  return 'folded';
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

/**
 * The account a finished game was played as: the board cache's, else `identity` (the signed-in
 * account, a page read through the bridge or the direct leg). Nothing at all with profiling off or no
 * data directory (the pass cannot run, so no request is made for it). A failed `identity` read is not
 * repeated for the same game in this process: the warapp_my_games sweep, which reads the account
 * anyway, picks the game up later. Never throws.
 */
export async function finishedAccount(
  dataDir: string | undefined,
  env: EnvSource,
  gameId: number,
  identity?: () => Promise<number | undefined>,
): Promise<number | undefined> {
  if (!dataDir || !profileEnabled(env)) return undefined;
  const cached = await readCachedPlayer(dataDir, gameId).catch(() => undefined);
  if (cached !== undefined) return cached;
  const key = `${dataDir}\0${gameId}`;
  if (!identity || accountUnread.has(key)) return undefined;
  let me: number | undefined;
  try {
    me = await identity();
  } catch {
    me = undefined;
  }
  if (me === undefined) remember(accountUnread, key);
  return me;
}

/** How many of the newest finished games the sweep considers: half the store bound, so their records always fit. */
export const sweepWindow = (keep: number = MAX_FINISHED_RECORDS): number => Math.max(1, Math.floor(keep / 2));

/**
 * The sweep (warapp_my_games): of `gameIds` (finished games of mine, newest first), process at most
 * `limit` not yet processed, one at a time, each folding its profiles too. `pending` counts those
 * left for a later call. Never throws.
 *
 * The processed marks outlive the record bound, but they are bounded too, so the sweep looks only at
 * the newest {@link sweepWindow} games (half the record bound): older ones are never its candidates.
 * Its writes never prune a record of a game in that window (`protectIds`), and each call refreshes the
 * window's records, so the records the harness and the reports read stay the newest games'. A game the
 * sweep processed is so never read again (P2). `window` widens (or narrows) it for warapp_backfill_history,
 * at most `keep` games.
 */
export async function sweepFinished(
  deps: EndOfGameDeps,
  me: number,
  gameIds: readonly number[],
  {
    limit = END_OF_GAME_PER_CALL,
    keep = MAX_FINISHED_RECORDS,
    window: size,
  }: { limit?: number; keep?: number; window?: number } = {},
): Promise<{ processed: { gameId: number; status: EndOfGameStatus; turns?: number }[]; pending: number }> {
  // warapp_backfill_history may widen the window, never past the record bound (every game in it is protected).
  const window = gameIds.slice(0, Math.max(1, Math.min(size ?? sweepWindow(keep), keep)));
  const todo: number[] = [];
  for (const id of window) if (await needsEndOfGame(deps.dataDir, deps.env, id, me)) todo.push(id);
  await refreshProcessed(deps, me, window).catch(() => undefined);
  const processed: { gameId: number; status: EndOfGameStatus; turns?: number }[] = [];
  for (const id of todo.slice(0, limit)) {
    const r = await endOfGame(deps, id, me, undefined, { fold: true, keep, protectIds: window });
    processed.push({ gameId: id, status: r.status, ...(r.turns !== undefined ? { turns: r.turns } : {}) });
  }
  return { processed, pending: Math.max(0, todo.length - limit) };
}

/** Mark the window's records most recently used, so a prune drops a record outside the window first. */
async function refreshProcessed(deps: EndOfGameDeps, me: number, window: readonly number[]): Promise<void> {
  const { dataDir, env } = deps;
  if (!dataDir || !profileEnabled(env)) return;
  const salt = await playerRecordSalt(dataDir);
  if (!salt) return;
  for (const id of window) await touchFinished(finishedPath(dataDir, salt, me, id));
}
