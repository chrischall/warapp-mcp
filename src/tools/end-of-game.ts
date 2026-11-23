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
import { readEnvVar, type EnvSource } from '@chrischall/mcp-utils';
import type { BoardState } from '../board.js';
import { decisionTruth } from '../analysis/decision-truth.js';
import { endGameStats } from '../analysis/end-game-stats.js';
import { captureFinished, excludedKind, outcomeOf, type FinishedCapture, type GameKind } from '../analysis/finished-game.js';
import { compactDecisionLog, decisionLogMode, finishDecisionLogs, recordTruth } from '../decision-log.js';
import { teammatesOf } from '../teams.js';
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
import { recordLessons, recordLessonsExcluded, recordMapExcluded, recordMapGame } from '../lessons-store.js';
import { endingOf, foldGame, markHistoryFolded, profileFileState, type FoldSeat } from '../profile-store.js';
import type { WarappClient } from '../client.js';
import {
  MAX_FINISHED_RECORDS,
  finishedPath,
  finishedRecordOf,
  markProcessed,
  readFinishedRecord,
  readFinishedState,
  readProcessed,
  storedStats,
  touchFinished,
  writeFinishedRecord,
  type FinishedFailure,
  type FinishedRecord,
  type FinishedStatus,
  type StoredEndStats,
} from '../finished-store.js';
import { playerKey } from '../player-record-store.js';
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
import { settingsKey } from './decision-capture.js';
import { mapOf } from './map.js';
import { keptFacts, kindsOf } from './game-kind.js';
import { cardsInPlay, EXCLUDED_FOLD_NOTE, foldFinished, observeSettings, profiledOpponents, type FinishedFold } from './profile-hook.js';
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
  /**
   * #523: every player's end-of-game stats from the record (captured now, kept before, or `backfilled` into a
   * record kept before them from an `include_history` read), by GameFeed id.
   */
  stats?: EndStatsView;
  /** #523: the stats were added to a record kept before them (an `include_history` call; nothing else re-run). */
  backfilled?: 'stats';
}

/** #523: the stats as a tool shows them: per player by GameFeed id, mine marked. */
export interface EndStatsView {
  turnsRead: number;
  /** What each figure is (the client's end-of-game screen definitions). */
  note: string;
  players: (StoredEndStats & { playerId: number; me?: true })[];
}

export const END_STATS_NOTE =
  "From the game's history, as the client's end-of-game screen defines them: produced = every army deployed (card armies included); lost = its armies killed attacking and defending; killed = armies it killed attacking (neutrals included: killedNeutral) and defending; highestIncome = the most board income it had (cards and the army cap aside). `series` are the client's All Graphs: armies, territories and income per history board from the start (the line stops when the seat left), deployed per turn, and cumulative luck, offensiveLuck and defensiveLuck from 0.";

/** The record's stats with the keys put back to `players`' ids (a key is never reversed: matched). */
function statsView(rec: { stats?: { turnsRead: number; players: Record<string, StoredEndStats> } }, salt: string, players: readonly { id: number }[], me: number): EndStatsView | undefined {
  if (!rec.stats) return undefined;
  const out: EndStatsView['players'] = [];
  for (const p of players) {
    const s = rec.stats.players[playerKey(salt, p.id)];
    if (s) out.push({ playerId: p.id, ...(p.id === me ? { me: true as const } : {}), ...s });
  }
  return { turnsRead: rec.stats.turnsRead, note: END_STATS_NOTE, players: out };
}

/**
 * What a captured history was processed into (#312 E2): the opponent profiles folded from it (part C),
 * the map's record, and the lessons store. `no-map`: the map was not had, so no income or adjacency;
 * `teams-unknown`: a game of 3+ seats whose teams could not be read (teammates are never profiled);
 * `nothing`: no opponent turn observed.
 */
export interface Processed {
  profiles: 'folded' | 'nothing' | 'no-map' | 'teams-unknown' | 'failed' | 'excluded';
  map: 'kept' | 'no-map' | 'failed' | 'excluded';
  lessons: 'kept' | 'no-map' | 'failed' | 'excluded';
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

/** The decision log's mode as `env` sets it. */
const decisionLogModeOf = (env: EnvSource) => decisionLogMode({ WARAPP_DECISION_LOG: readEnvVar('WARAPP_DECISION_LOG', { env }) });

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
  if (!profileEnabled(env)) {
    // #412: no pass runs, but the game is over: its decision log leaves `active` (the prune never deletes
    // an active log), dropping nothing. The account may be unknown here (none is read with profiling off).
    if (dataDir && seen?.state === 'Finished') await finishDecisionLogs(dataDir, [gameId], me, { mode: decisionLogModeOf(env) });
    return { status: 'off' };
  }
  if (!dataDir) return { status: 'no-data-dir' };
  if (me === undefined) return { status: 'account-unknown' };
  if (seen && seen.state !== 'Finished') return { status: 'not-finished' };
  if (seen && !seen.players.some((p) => p.id === me && holdsSeat(p.state))) return { status: 'not-a-player' };
  // #412: an exit that runs no truth or compaction for a game over still takes its decision log out of
  // `active` (the prune never deletes an active log, and the lasting mark may already stop any later
  // pass), dropping nothing: an `include_history` retry can still write the truth and compact.
  const closeOnly = () => finishDecisionLogs(dataDir, [gameId], me, { mode: decisionLogModeOf(env) });
  let read: Game | undefined;
  // #437: the kind this pass keeps the game apart for (no profile fold either).
  let kept: ReturnType<typeof excludedKind>;
  try {
    const salt = await playerSaltForWrite(dataDir);
    if (!salt) return { status: 'unavailable' };
    const path = finishedPath(dataDir, salt, me, gameId);
    const result = await withPathLock(path, async (): Promise<EndOfGameResult> => {
      const state = await readFinishedState(path);
      if (state === 'unreadable') {
        await closeOnly();
        return { status: 'record-unreadable' };
      }
      if (state !== 'missing' && state.status === 'captured') return await keptOrBackfilled(dataDir, path, salt, me, opts.history ?? seen, opts.history);
      if (state !== 'missing' && (!opts.retry || !opts.history)) return { status: 'already-processed' };
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
      kept = excludedKind(record.kinds ?? []);
      try {
        const protect = opts.protectIds ? new Set(opts.protectIds.map((id) => finishedPath(dataDir, salt, me, id))) : undefined;
        await writeFinishedRecord(dataDir, path, record, opts.keep, protect);
      } catch {
        await closeOnly();
        return { status: 'failed' };
      }
      const processed = history && game ? await processHistory(dataDir, env, salt, me, gameId, game, history) : undefined;
      // #412: the decision log's truth (from the full history, before any cut) and its compaction.
      await closeDecisionLog(dataDir, env, me, gameId, game ?? shown, history && game ? history : undefined);
      const view = shown ? statsView(record, salt, shown.players, me) : undefined;
      return {
        status: record.status,
        ...(view ? { stats: view } : {}),
        ...(record.turns ? { turns: record.turns.length } : {}),
        ...(record.failure ? { failure: record.failure } : {}),
        ...(processed ? { processed } : {}),
      };
    });
    if (opts.fold && (result.status === 'captured' || result.status === 'history-unreadable')) {
      const game = read ?? seen;
      if (kept) result.profileFold = { status: 'nothing', reason: 'excluded', note: EXCLUDED_FOLD_NOTE };
      else if (game) result.profileFold = await foldFinished(dataDir, env, game);
    }
    return result;
  } catch {
    // Shown finished (or, with no read, passed as finished by the sweep or a game-ended notice).
    if (((read ?? seen)?.state ?? 'Finished') === 'Finished') await closeOnly();
    return { status: 'failed' };
  }
}

/**
 * #523: a captured record, already processed: its stats shown when it keeps them; else, given a read WITH the
 * history (an explicit `include_history` call, never a trigger), the stats computed from that read and added to the
 * record (`backfilled`) — nothing else is re-run (no profile fold, map record, lessons or decision-log truth), so
 * nothing is counted twice. Called under the record's path lock. Never throws (an unreadable record: as kept).
 */
async function keptOrBackfilled(
  dataDir: string,
  path: string,
  salt: string,
  me: number,
  shown: Game | undefined,
  history: Game | undefined,
): Promise<EndOfGameResult> {
  const rec = await readFinishedRecord(path);
  if (typeof rec === 'string') return { status: 'already-processed' };
  const players = shown?.players ?? [];
  if (rec.stats || !history || history.state !== 'Finished') {
    const view = statsView(rec, salt, players, me);
    return { status: 'already-processed', ...(view ? { stats: view } : {}) };
  }
  try {
    const stats = endGameStats(history.history, history.players);
    if (!stats || !('read' in historyReport(history))) return { status: 'already-processed' };
    const boards = historyBoards(history.history, history.players, history.numberOfTurns !== undefined ? { numberOfTurns: history.numberOfTurns } : {});
    const map = history.map ? mapOf(history) : undefined;
    const c = capture(history, me, boards, new Map(), map ? graphOf(map) : undefined, undefined);
    if (!c) return { status: 'already-processed' };
    const next = { ...rec, stats: storedStats(stats, c, (id) => playerKey(salt, id)) };
    await writeFinishedRecord(dataDir, path, next);
    const view = statsView(next, salt, history.players, me);
    return { status: 'already-processed', backfilled: 'stats', ...(view ? { stats: view } : {}) };
  } catch {
    return { status: 'already-processed' };
  }
}

/** What a captured history hands to {@link processHistory}. */
interface CapturedHistory {
  capture: FinishedCapture;
  boards: { turn: number; board: BoardState }[];
  orders: ReadonlyMap<number, MyOrders>;
  graph: MapGraph | undefined;
  /** #437: the game's kinds. */
  kinds: GameKind[];
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
  // #437: what this server kept of the game: its kind, and the turn my seat left.
  const facts = await keptFacts(dataDir, gameId, me);
  if (!read) {
    const c = capture(shown, me, [], new Map(), undefined, facts.leftTurn);
    return { record: finishedRecordOf({ ...common, status: 'read-failed', failure, capture: c, kinds: kindsOf(shown, me, c, facts) }) };
  }
  const report = historyReport(read);
  const orders = facts.orders;
  const map = read.map ? mapOf(read) : undefined;
  if ('unreadable' in report) {
    const u = report.unreadable;
    const c = capture(read, me, [], orders, undefined, facts.leftTurn);
    return {
      record: finishedRecordOf({
        ...common,
        status: 'history-unreadable',
        failure: { reason: u.reason, keys: u.keys, ...(u.layout ? { layout: u.layout } : {}), ...(u.shape ? { shape: u.shape } : {}), ...(u.turns !== undefined ? { turns: u.turns } : {}) },
        capture: c,
        kinds: kindsOf(read, me, c, facts),
      }),
    };
  }
  const boards = historyBoards(read.history, read.players, read.numberOfTurns !== undefined ? { numberOfTurns: read.numberOfTurns } : {});
  const graph = map ? graphOf(map) : undefined;
  const captured = capture(read, me, boards, orders, graph, facts.leftTurn)!;
  const kinds = kindsOf(read, me, captured, facts);
  // #523: the per-player stats from the same history (its orders), no further request.
  const stats = endGameStats(read.history, read.players);
  return {
    record: finishedRecordOf({ ...common, status: 'captured', layout: report.read.layout, noMap: !map, capture: captured, boards, kinds, stats }),
    history: { capture: captured, boards, orders, graph, kinds },
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
  const key = finishedGameKey(salt, me, gameId);
  const mapId = game.settings?.mapId ?? game.map?.id;
  // #437: a lottery or no-show game is counted apart: never in the lessons, the map record or the profiles.
  const apart = excludedKind(h.kinds);
  if (apart) {
    const map = mapId !== undefined ? await recordMapExcluded(dataDir, mapId, key, apart) : 'excluded';
    const lessons = await recordLessonsExcluded(dataDir, key, apart);
    return { profiles: 'excluded', map, lessons };
  }
  const out: Processed = { profiles: 'no-map', map: 'no-map', lessons: 'no-map' };
  const g = h.graph;
  if (!g) return out;
  const teams = await keptTeams(dataDir, game).catch(() => undefined);
  const resolved = teams?.game ?? game;
  const mine = resolved.players.find((p) => p.id === me);
  const seated = resolved.players.filter((p) => holdsSeat(p.state));
  const format = profileFormatOf(resolved.players);
  const opponents = mine ? profiledOpponents(resolved, mine) : resolved.players.filter((p) => p.id !== me).map((p) => p.id);
  const c = h.capture;
  try {
    out.profiles = !teams?.known || !mine ? 'teams-unknown' : await foldHistory(dataDir, env, me, gameId, resolved, opponents, format, seated.length, h);
  } catch {
    out.profiles = 'failed';
  }
  if (mapId !== undefined) {
    const s = game.settings;
    out.map = await recordMapGame(dataDir, mapId, {
      key,
      format,
      seats: seated.length,
      result: c.outcome.result,
      turns: c.outcome.turn,
      ...mapFacts(g, me, c.outcome.winners, c.starts, c.turns),
      kinds: h.kinds,
      // #437: the views read only the games of the current game's format and settings.
      settings: {
        key: settingsKey(game),
        ...(s?.localDeployments !== undefined ? { localDeployments: s.localDeployments } : {}),
        ...(s?.commanders !== undefined ? { commanders: s.commanders } : {}),
      },
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
        // #437: a surrender's or a boot's turn is the one my seat left (the log's events), not only the history's.
        outTurn: c.outcome.leftTurn ?? c.outcome.outTurn,
      }),
      calibration: aggregateCalibration(samples),
      kinds: h.kinds,
    });
  } catch {
    out.lessons = 'failed';
  }
  return out;
}

/**
 * The decision log of a finished game (#412 task 3): with the history captured, every turn's truth and
 * every logged turn's accuracy from the FULL history boards (`h.boards`, before the finished record's
 * head/tail cut: no-gaps rule (c)); then the log is compacted (no-gaps rule (b); `full` keeps it whole).
 * Without a captured history the log is only marked `finished` (whole, but no longer protected from the
 * prune): the retry that brings it writes the truth, then compacts. Nothing with `WARAPP_DECISION_LOG=off`.
 * Never throws.
 */
async function closeDecisionLog(dataDir: string, env: EnvSource, me: number, gameId: number, game: Game | undefined, h: CapturedHistory | undefined): Promise<void> {
  const mode = decisionLogModeOf(env);
  if (mode === 'off') return;
  try {
    if (h?.graph && game) {
      const graph = h.graph;
      const teams = await keptTeams(dataDir, game).catch(() => undefined);
      const resolved = teams?.game ?? game;
      const mine = resolved.players.find((p) => p.id === me);
      const allies = new Set(mine ? teammatesOf(resolved.players, mine).map((p) => p.id) : []);
      const opponents = resolved.players.filter((p) => p.id !== me && !allies.has(p.id)).map((p) => p.id);
      // Every seat as still playing: a final state would read a seat out on every earlier board.
      const asPlaying = resolved.players.map(({ state: _state, ...p }) => p);
      await recordTruth(
        dataDir,
        gameId,
        me,
        (logged) =>
          decisionTruth({
            graph,
            me,
            opponents,
            history: h.boards,
            ...(game.numberOfTurns !== undefined ? { numberOfTurns: game.numberOfTurns } : {}),
            incomeSettings: game.settings,
            plannerSettings: plannerSettings(game.settings),
            game: trackGame(asPlaying, game.settings, game.map),
            logged,
          }),
        { mode },
      );
    }
    // Compaction follows the truth (its choice of turns reads the accuracy): with no history captured, a
    // retry (warapp_get_game include_history) can still bring it, so the log stays whole until then — but
    // marked `finished` (the game is over), so the prune may drop it: an `active` log is never pruned, and
    // no trigger retries the read by itself. The retry's truth and compaction accept a `finished` log. A
    // captured history with no map can never give a truth (a captured pass is not run again): compact.
    if (!h) {
      await finishDecisionLogs(dataDir, [gameId], me, { mode });
      return;
    }
    const lost = game ? ['lost', 'surrendered', 'eliminated', 'booted'].includes(outcomeOf(game.players, me)) : false;
    await compactDecisionLog(dataDir, gameId, me, { mode, lost });
  } catch {
    // Best effort.
  }
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
  leftTurn: number | undefined,
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
    leftTurn,
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
  // #412: with profiling off no pass runs, but these games are over: their decision logs leave `active`
  // (no request; a log already closed costs one head read).
  if (deps.dataDir && !profileEnabled(deps.env)) await finishDecisionLogs(deps.dataDir, window, me, { mode: decisionLogModeOf(deps.env) });
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
