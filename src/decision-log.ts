// The decision log (#412): per game, an entry for every turn the account plays. A turn this server
// planned is a full entry: what was seen (the fogged board), what the planner read and decided and why,
// what was actually sent (and any override), and what happened next. Any other turn the server sees (a
// board read live or filled from history) gets at least an observation entry (`kind: 'observed'`: the
// board, plus what was sent when known), which a later plan of that turn upgrades and which never
// overwrites a planned entry. It is the data strategy changes and scenarios are replayed against offline
// (src/analysis/decision-replay.ts, scripts/replay-decisions.mjs).
//
// `<dataDir>/decisions/<gameId>.json`: `{ version: 1, gameId, playerId, status, turns }`, one account's
// view per game. Name-free: player ids and the map's own territory and bonus names only; every player
// name the caller passes is scrubbed from every string (and a `name` field holding one is dropped).
// Boards are delta-encoded against the previous logged turn's board (the territories whose owner,
// armies, fog or units changed), with a full board at the first logged turn and every
// FULL_BOARD_EVERY turns after the last full one, so any turn rebuilds (`boardAt`). The planner's
// input is kept without what the map store and the board give back (the graph, the board) and without
// what `planTurn` sets itself; Maps and Sets are tagged so `decodeInput` restores them.
//
// 0600 in a 0700 folder, written atomically under the in-process path lock; best effort (never throws
// into a tool); a file that exists but does not parse, or carries another `version` (or none: a newer
// build's, say, sharing the data dir), is never overwritten, listed or pruned. The header (`version`,
// `gameId`, `playerId`, `status`) is always written before `turns`, so listing reads only the head of each
// file (`HEAD_BYTES`), never a whole log. At most MAX_DECISION_GAMES games and MAX_DECISION_BYTES in all
// (`pruneDecisionLogs`: the oldest finished games first, never one still running; a log is parsed whole
// only just before it is deleted; `pruneDecisionLogs` runs after a write at most once per
// DECISION_PRUNE_INTERVAL_MS per data dir). `WARAPP_DECISION_LOG=off` writes nothing; `full` keeps every
// turn whole (no compaction).
//
// Once a game is finished (the end-of-game pass, src/tools/end-of-game.ts) every turn of the game gets its
// `truth` from the full history and every logged turn its `accuracy` (`recordTruth`; pure part
// src/analysis/decision-truth.ts), then the log is compacted (`compactDecisionLog`): no-gaps rule (b) —
// every turn keeps its board, decision, sent orders, override, `next`, `truth` and `accuracy`; only the
// replay `input` of an uninteresting turn is dropped.
import { open, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type AccuracySummary, estimateOff, type LoggedTurn, type TruthResult, type TurnAccuracy, type TurnTruth } from './analysis/decision-truth.js';
import type { OutlookState } from './analysis/outlook.js';
import type { EnemyDeployEstimate, PlanInput, TurnPlan } from './analysis/plan/shared.js';
import type { BoardState, TerritoryState } from './board.js';
import { writeJsonAtomic } from './map-store.js';
import { withPathLock } from './path-lock.js';
import { VERSION } from './version.js';

export const DECISION_LOG_VERSION = 1;
/** Games whose decision logs are kept at most. */
export const MAX_DECISION_GAMES = 1000;
/** Bytes of decision logs kept at most, all games together. */
export const MAX_DECISION_BYTES = 500 * 1024 * 1024;
/** A full board at least this many turns after the last full one (and at the first logged turn). */
export const FULL_BOARD_EVERY = 10;
/** The post-write prune runs at most once per this interval per data dir. */
export const DECISION_PRUNE_INTERVAL_MS = 10 * 60_000;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

export const decisionsDir = (dir: string) => join(dir, 'decisions');
export const decisionLogPath = (dir: string, gameId: number) => join(decisionsDir(dir), `${gameId}.json`);
const DECISION_FILE = /^(\d{1,12})\.json$/;
/** Bytes read from the head of a log to list it: the header comes first, so this always covers it. */
const HEAD_BYTES = 512;

/** `off`: nothing written; `full`: every turn kept whole; `on`: the default. */
export type DecisionLogMode = 'on' | 'off' | 'full';

export function decisionLogMode(env: Readonly<Record<string, string | undefined>> = process.env): DecisionLogMode {
  const v = env.WARAPP_DECISION_LOG?.trim().toLowerCase();
  return v === 'off' ? 'off' : v === 'full' ? 'full' : 'on';
}

export interface DecisionLogOptions {
  /** Default: {@link decisionLogMode} of the environment. */
  mode?: DecisionLogMode;
  /** The caps the post-write prune applies (tests); default {@link MAX_DECISION_GAMES} / {@link MAX_DECISION_BYTES}. */
  caps?: { maxGames?: number; maxBytes?: number };
}

// ---------------------------------------------------------------------------------------------
// Shapes

export interface StoredBoardFull {
  kind: 'full';
  source: BoardState['source'];
  verified: boolean;
  territories: TerritoryState[];
}

export interface StoredBoardDelta {
  kind: 'delta';
  /** The logged turn whose board this one changes. */
  base: number;
  source: BoardState['source'];
  verified: boolean;
  /** The territories that differ from the base board (or are not on it), whole. */
  changed: TerritoryState[];
  /** Territories on the base board that are not on this one. */
  removed?: number[];
}

export type StoredBoard = StoredBoardFull | StoredBoardDelta;

/** The previous board kept in an input: changed against this turn's board. */
export interface StoredPreviousBoard {
  source: BoardState['source'];
  verified: boolean;
  changed: TerritoryState[];
  removed?: number[];
}

/**
 * The planner's input as kept: `PlanInput` without the graph (the map store gives it back), the board
 * (the entry's own), and what `planTurn` sets itself (`vacated`, `bonusPush`); `previousBoard` is kept
 * as a change against the board. Maps and Sets are tagged (`{ $map }`, `{ $set }`). The board's
 * `teammateOrders` (ids only) are kept here, never on the stored board, and `decodeInput` puts them back on
 * the rebuilt board: the planner reads them, and no store can rebuild them.
 */
export type LoggedInput = Rec & { previousBoard?: StoredPreviousBoard; teammateOrders?: unknown; plannedBoard?: StoredPreviousBoard };

/** The keys of `PlanInput` that are not kept in {@link LoggedInput}. */
const INPUT_DROPPED = new Set(['graph', 'board', 'vacated', 'bonusPush', 'previousBoard']);

/** One opponent's deploy estimate as the plan read it (#412 task 3: scored against the truth at the end). */
export interface LoggedEstimate {
  player: number;
  estimate: number;
  source: EnemyDeployEstimate['source'];
  /** The track's frontier coverage share (#294); `null` when unmeasured. */
  coverage: number | null;
  /** #368: sized on thin evidence (toward the midpoint). */
  thin: boolean;
}

export interface LoggedDecision {
  goal: TurnPlan['goal'];
  profile: TurnPlan['profile'];
  deploys: TurnPlan['deploys'];
  moves: TurnPlan['moves'];
  expected: TurnPlan['expected'];
  conceded: number[];
  offence: TurnPlan['offence'];
  enemyDeploy: number;
  cardAdvice: TurnPlan['cardAdvice'];
  rationale: string[];
  warnings: string[];
  /** The game outlook's state on this turn (`null`: none read). */
  outlook: OutlookState | null;
  /** Each opponent's deploy estimate the plan worked from; absent in entries written without them. */
  estimates?: LoggedEstimate[];
  /**
   * My income as the plan read it, card armies out (the input's `income − cardArmies`). Kept here, not
   * only in the replay `input` compaction drops, so the end-of-game truth scores a turn the same before
   * and after compaction. Absent in entries written without it.
   */
  income?: number;
}

/** One move as sent (#412): its count (a percentage when `percent`), and any option it carries. */
export interface LoggedMove {
  from: number;
  to: number;
  armies: number;
  /** `armies` is a percentage of what can move when the order runs. */
  percent?: true;
  /** Absent: an ordinary attack/transfer. */
  mode?: 'attack-only' | 'transfer-only';
  attackTeammates?: true;
  /** The move took my commander along. */
  commander?: true;
}

/** One card play as sent (#412): the card, its instance id, and the targets it took (ids only). */
export interface LoggedCardPlay {
  card: string;
  cardId: string;
  target?: number;
  player?: number;
  players?: readonly [number, number];
  bonus?: number;
  from?: number;
  to?: number;
  armies?: number;
  commander?: true;
  /** Order Delay: the move it is written above. */
  beforeMove?: number;
}

/**
 * The orders actually sent on a turn (#412), every kind, in the order sent within each kind: deploys,
 * every move (a percentage or a mode one included, with its count), card plays, discards (card
 * instance ids) and city purchases. Ids and counts only. The card, discard and purchase lists are
 * absent only in entries written without them.
 */
export interface LoggedSent {
  deploys: readonly { territoryId: number; armies: number }[];
  moves: readonly LoggedMove[];
  cards?: readonly LoggedCardPlay[];
  discards?: readonly string[];
  purchases?: readonly { territoryId: number; count: number }[];
}

/** Who chose orders that differ from the logged decision, and why when said. */
export interface DecisionOverride {
  by: 'hand' | 'agent';
  reason?: string;
}

/** What happened after a logged turn, filled when the following turn is logged. */
export interface DecisionOutcome {
  /** My income on the following turn (`null`: unread). */
  income: number | null;
  /** Territories I held next turn and not on this one, and the reverse. */
  gained: number[];
  lost: number[];
  /** The plan's captures I held next turn, and those I did not. */
  capturesMade: number[];
  capturesMissed: number[];
  /** The bonuses I held in full next turn. */
  bonusesHeld: number[];
  eliminated: boolean;
}

/** Where an observation's board came from: read live, or filled from the game's history. */
export type ObservationSource = 'live' | 'history';

export interface DecisionEntry {
  /** `planned`: written by {@link recordDecision}; `observed`: a board seen without a plan ({@link recordObservation}). Absent on an entry holding only sent orders. */
  kind?: 'planned' | 'observed';
  /** Set on an observation only. */
  source?: ObservationSource;
  board?: StoredBoard;
  input?: LoggedInput;
  planner?: { version: string };
  decision?: LoggedDecision;
  sent?: LoggedSent;
  override?: DecisionOverride;
  next?: DecisionOutcome;
  /** The end-of-game truth for this turn (#412 task 3); a turn with no other entry may hold only this. */
  truth?: TurnTruth;
  /** What this turn logged against the truth. */
  accuracy?: TurnAccuracy;
}

export type DecisionLogStatus = 'active' | 'finished' | 'compacted';

export interface DecisionLog {
  version: number;
  gameId: number;
  playerId: number;
  status: DecisionLogStatus;
  turns: Record<string, DecisionEntry>;
  /** The game's estimate and outlook accuracy, once its truth is written. */
  accuracySummary?: AccuracySummary;
  /** Turns of the game the history itself lacks (never because of the finished record's cut). */
  truthMissing?: number[];
}

/** One planned turn as handed to {@link recordDecision}. */
export interface DecisionRecord {
  turn: number;
  /** The board planned on (as seen: fog included). */
  board: BoardState;
  /** The input the planner was called with. */
  input: PlanInput;
  /**
   * The board the planner read when it is not `board` (the award of picks fills proven starts into the
   * fog): kept in the input as a change against `board`, and `decodeInput` plans on it again.
   */
  plannedBoard?: BoardState;
  plan: TurnPlan;
  outlookState?: OutlookState | null;
  /** The per-opponent deploy estimates the plan worked from. */
  estimates?: readonly EnemyDeployEstimate[];
  /** The game's players, for scrubbing names; only ids are ever written. */
  players?: readonly { id: number; name?: string }[];
}

// ---------------------------------------------------------------------------------------------
// Encoding

/** Maps and Sets tagged, undefined and functions dropped: JSON-safe and reversible. */
export function encodeValue(v: unknown): unknown {
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [encodeValue(k), encodeValue(x)]) };
  if (v instanceof Set) return { $set: [...v].map(encodeValue) };
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : encodeValue(x)));
  if (isRec(v)) {
    const out: Rec = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined || typeof x === 'function') continue;
      out[k] = encodeValue(x);
    }
    return out;
  }
  return typeof v === 'number' && !Number.isFinite(v) ? null : v;
}

/** The reverse of {@link encodeValue}. */
export function decodeValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeValue);
  if (isRec(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && Array.isArray(v.$map)) {
      return new Map((v.$map as unknown[]).filter(Array.isArray).map((p) => [decodeValue((p as unknown[])[0]), decodeValue((p as unknown[])[1])]));
    }
    if (keys.length === 1 && Array.isArray(v.$set)) return new Set((v.$set as unknown[]).map(decodeValue));
    const out: Rec = {};
    for (const [k, x] of Object.entries(v)) out[k] = decodeValue(x);
    return out;
  }
  return v;
}

const plainBoard = (b: BoardState): BoardState => ({ source: b.source, verified: b.verified, territories: b.territories });

/** The territories of `now` that differ from `base` (or are not on it), and the ids `base` has that `now` lacks. */
function diff(base: BoardState, now: BoardState): { changed: TerritoryState[]; removed?: number[] } {
  const was = new Map(base.territories.map((x) => [x.territoryId, JSON.stringify(x)]));
  const changed = now.territories.filter((x) => was.get(x.territoryId) !== JSON.stringify(x));
  const ids = new Set(now.territories.map((x) => x.territoryId));
  const removed = base.territories.map((x) => x.territoryId).filter((id) => !ids.has(id));
  return { changed, ...(removed.length ? { removed } : {}) };
}

/** `base` with `d` applied, territories in `base`'s order then new ones by id. */
function patch(base: BoardState, d: { source: BoardState['source']; verified: boolean; changed: TerritoryState[]; removed?: number[] }): BoardState {
  const changed = new Map(d.changed.map((x) => [x.territoryId, x]));
  const removed = new Set(d.removed ?? []);
  const kept = base.territories.filter((x) => !removed.has(x.territoryId)).map((x) => changed.get(x.territoryId) ?? x);
  const known = new Set(base.territories.map((x) => x.territoryId));
  const added = d.changed.filter((x) => !known.has(x.territoryId));
  return { source: d.source, verified: d.verified, territories: [...kept, ...added] };
}

const turnKeys = (turns: Record<string, unknown>): number[] =>
  Object.keys(turns)
    .filter((k) => /^\d+$/.test(k))
    .map(Number)
    .sort((a, b) => a - b);

/** The board seen on `turn`, rebuilt; `undefined` when the turn keeps none or its chain is broken. */
export function boardAt(log: Pick<DecisionLog, 'turns'>, turn: number, depth = 0): BoardState | undefined {
  const b = log.turns[String(turn)]?.board;
  if (!b || depth > 10_000) return undefined;
  if (b.kind === 'full') return { source: b.source, verified: b.verified, territories: b.territories };
  if (b.base >= turn) return undefined;
  const base = boardAt(log, b.base, depth + 1);
  return base ? patch(base, b) : undefined;
}

/**
 * Re-encode every kept board of `turns` from `boards` (turn → whole board): full at the first and at
 * least every {@link FULL_BOARD_EVERY} turns, else a delta on the previous turn that keeps a board.
 * Turns not in `boards` keep no board. Mutates `turns`.
 */
export function encodeBoards(turns: Record<string, DecisionEntry>, boards: ReadonlyMap<number, BoardState>): void {
  let prev: { turn: number; board: BoardState } | undefined;
  let lastFull = Number.NEGATIVE_INFINITY;
  for (const turn of turnKeys(turns)) {
    const entry = turns[String(turn)]!;
    const board = boards.get(turn);
    if (!board) {
      delete entry.board;
      continue;
    }
    if (!prev || turn - lastFull >= FULL_BOARD_EVERY) {
      entry.board = { kind: 'full', source: board.source, verified: board.verified, territories: board.territories };
      lastFull = turn;
    } else {
      entry.board = { kind: 'delta', base: prev.turn, source: board.source, verified: board.verified, ...diff(prev.board, board) };
    }
    prev = { turn, board };
  }
}

/** Every kept board of `log`, whole, by turn. */
export function decodeBoards(log: Pick<DecisionLog, 'turns'>): Map<number, BoardState> {
  const out = new Map<number, BoardState>();
  for (const turn of turnKeys(log.turns)) {
    const b = boardAt(log, turn);
    if (b) out.set(turn, b);
  }
  return out;
}

/** The input as kept (see {@link LoggedInput}). */
export function encodeInput(input: PlanInput): LoggedInput {
  const out: LoggedInput = {};
  for (const [k, v] of Object.entries(input)) {
    if (INPUT_DROPPED.has(k) || v === undefined) continue;
    out[k] = encodeValue(v);
  }
  if (input.board.teammateOrders) out.teammateOrders = encodeValue(input.board.teammateOrders);
  if (input.previousBoard) {
    const prev = plainBoard(input.previousBoard);
    out.previousBoard = { source: prev.source, verified: prev.verified, ...diff(plainBoard(input.board), prev) };
  }
  return out;
}

/** The planner's input rebuilt from a kept one, this turn's board and the map's graph. */
export function decodeInput(logged: LoggedInput, board: BoardState, graph: PlanInput['graph']): PlanInput {
  const { previousBoard, teammateOrders, plannedBoard, ...rest } = logged;
  const out = decodeValue(rest) as Rec;
  const planned = isRec(plannedBoard) && Array.isArray(plannedBoard.changed) ? patch(board, plannedBoard) : board;
  return {
    ...(out as unknown as PlanInput),
    graph,
    board: Array.isArray(teammateOrders) ? { ...planned, teammateOrders: decodeValue(teammateOrders) as BoardState['teammateOrders'] } : planned,
    ...(isRec(previousBoard) && Array.isArray(previousBoard.changed) ? { previousBoard: patch(board, previousBoard) } : {}),
  };
}

/** The estimates as logged: ids, figures and flags only. */
export function loggedEstimates(estimates: readonly EnemyDeployEstimate[]): LoggedEstimate[] {
  return [...estimates]
    .sort((a, b) => a.playerId - b.playerId)
    .map((e) => ({ player: e.playerId, estimate: e.estimate, source: e.source, coverage: e.coverage?.share ?? null, thin: !!e.thinEvidence }));
}

/** My income as `input` gives it, card armies out; `undefined` when it holds none. */
function earnedIncome(input: object | undefined): number | undefined {
  const { income, cardArmies } = (input ?? {}) as { income?: unknown; cardArmies?: unknown };
  if (typeof income !== 'number') return undefined;
  return income - (typeof cardArmies === 'number' ? cardArmies : 0);
}

function decisionOf(
  plan: TurnPlan,
  outlook: OutlookState | null | undefined,
  estimates: readonly EnemyDeployEstimate[] | undefined,
  income: number | undefined,
): LoggedDecision {
  return encodeValue({
    goal: plan.goal,
    profile: plan.profile,
    deploys: plan.deploys,
    moves: plan.moves,
    expected: plan.expected,
    conceded: plan.conceded,
    offence: plan.offence,
    enemyDeploy: plan.enemyDeploy,
    cardAdvice: plan.cardAdvice,
    rationale: plan.rationale,
    warnings: plan.warnings,
    outlook: outlook ?? null,
    ...(estimates ? { estimates: loggedEstimates(estimates) } : {}),
    ...(income !== undefined ? { income } : {}),
  }) as LoggedDecision;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `v` with every player name in `players` replaced by `Player <id>` in every string, and every `name`
 * field holding one dropped. A name is matched only standing alone (no letter, digit or `_` either side), so
 * a short name never rewrites part of a territory or bonus name. Names shorter than two characters are left.
 */
export function scrubNames<T>(v: T, players: readonly { id: number; name?: string }[] | undefined): T {
  const named = (players ?? [])
    .filter((p) => typeof p.name === 'string' && p.name.trim().length >= 2)
    .map((p) => ({ id: p.id, name: p.name!.trim() }))
    .sort((a, b) => b.name.length - a.name.length);
  if (!named.length) return v;
  const byName = new Set(named.map((p) => p.name.toLowerCase()));
  const res = named.map((p) => ({ re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:Player )?${escapeRe(p.name)}(?![\\p{L}\\p{N}_])`, 'giu'), to: `Player ${p.id}` }));
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return res.reduce((s, r) => s.replace(r.re, r.to), x);
    if (Array.isArray(x)) return x.map(walk);
    if (isRec(x)) {
      const out: Rec = {};
      for (const [k, y] of Object.entries(x)) {
        if (k === 'name' && typeof y === 'string' && byName.has(y.trim().toLowerCase())) continue;
        out[k] = walk(y);
      }
      return out;
    }
    return x;
  };
  return walk(v) as T;
}

// ---------------------------------------------------------------------------------------------
// Reading and writing

type Read = { kind: 'absent' } | { kind: 'unreadable' } | { kind: 'log'; log: DecisionLog };

function logOf(c: unknown, gameId: number): DecisionLog | undefined {
  if (!isRec(c) || c.version !== DECISION_LOG_VERSION || c.gameId !== gameId || !isInt(c.playerId) || !isRec(c.turns)) return undefined;
  const status: DecisionLogStatus = c.status === 'finished' || c.status === 'compacted' ? c.status : 'active';
  return {
    version: DECISION_LOG_VERSION,
    gameId,
    playerId: c.playerId,
    status,
    turns: c.turns as Record<string, DecisionEntry>,
    ...(isRec(c.accuracySummary) ? { accuracySummary: c.accuracySummary as unknown as AccuracySummary } : {}),
    ...(Array.isArray(c.truthMissing) ? { truthMissing: c.truthMissing.filter(isInt) } : {}),
  };
}

async function readRaw(dir: string, gameId: number): Promise<Read> {
  let text: string;
  try {
    text = await readFile(decisionLogPath(dir, gameId), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' };
  }
  try {
    const log = logOf(JSON.parse(text), gameId);
    return log ? { kind: 'log', log } : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
}

/** The log of `gameId` (only `playerId`'s when given); `undefined` when absent, unusable or another's. Never throws. */
export async function readDecisionLog(dir: string, gameId: number, playerId?: number): Promise<DecisionLog | undefined> {
  const r = await readRaw(dir, gameId);
  if (r.kind !== 'log' || (playerId !== undefined && r.log.playerId !== playerId)) return undefined;
  return r.log;
}

/**
 * Read, change and write `gameId`'s log as `playerId` under the path lock. `mutate` gets the log (a new
 * empty one when none exists) and returns the log to write, or `undefined` to write nothing. `true` when
 * written. Never writes over a file that does not parse or another account's log. Never throws.
 */
export async function updateDecisionLog(
  dir: string,
  gameId: number,
  playerId: number,
  mutate: (log: DecisionLog) => DecisionLog | undefined,
  opts: DecisionLogOptions = {},
): Promise<boolean> {
  if ((opts.mode ?? decisionLogMode()) === 'off') return false;
  const path = decisionLogPath(dir, gameId);
  try {
    const written = await withPathLock(path, async () => {
      const r = await readRaw(dir, gameId);
      if (r.kind === 'unreadable') return false;
      if (r.kind === 'log' && r.log.playerId !== playerId) return false;
      const current: DecisionLog =
        r.kind === 'log' ? r.log : { version: DECISION_LOG_VERSION, gameId, playerId, status: 'active', turns: {} };
      const next = mutate(current);
      if (!next) return false;
      // The header first: listing reads only the head of the file.
      const { version: _v, gameId: _g, playerId: _p, status, turns, ...rest } = next;
      await writeJsonAtomic(path, decisionsDir(dir), { version: DECISION_LOG_VERSION, gameId, playerId, status, turns, ...rest });
      return true;
    });
    // Outside the lock: the prune takes each log's own lock.
    if (written) await prunedAfterWrite(dir, opts.caps);
    return written;
  } catch {
    return false;
  }
}

/** When each data dir's post-write prune last ran (this process). */
const lastPrune = new Map<string, number>();

/** {@link pruneDecisionLogs} at most once per {@link DECISION_PRUNE_INTERVAL_MS} per data dir. Never throws. */
async function prunedAfterWrite(dir: string, caps: DecisionLogOptions['caps']): Promise<void> {
  const now = Date.now();
  const last = lastPrune.get(dir);
  if (last !== undefined && now - last < DECISION_PRUNE_INTERVAL_MS) return;
  lastPrune.set(dir, now);
  if (lastPrune.size > 100) lastPrune.delete(lastPrune.keys().next().value as string);
  await pruneDecisionLogs(dir, caps).catch(() => undefined);
}

/**
 * Log the turn planned, replacing any entry for that turn — unless its orders were already sent: then
 * the entry stays as it is (decision, sent orders, override, board), since a plan made after the
 * orders went out did not choose them, and nothing re-sends them (no-gaps rule). Name-free: every name
 * in `rec.players` is scrubbed. `true` when written (`false` for a turn already sent). Never throws.
 */
export async function recordDecision(
  dir: string,
  gameId: number,
  playerId: number,
  rec: DecisionRecord,
  opts: DecisionLogOptions = {},
): Promise<boolean> {
  try {
    const board = plainBoard(rec.board);
    const teammateOrders = rec.input.board.teammateOrders ?? rec.board.teammateOrders;
    const input = encodeInput({ ...rec.input, board: teammateOrders ? { ...board, teammateOrders } : board });
    if (rec.plannedBoard) {
      const d = diff(board, plainBoard(rec.plannedBoard));
      if (d.changed.length || d.removed) input.plannedBoard = { source: rec.plannedBoard.source, verified: rec.plannedBoard.verified, ...d };
    }
    const entry: DecisionEntry = scrubNames(
      {
        kind: 'planned',
        input,
        planner: { version: VERSION },
        decision: decisionOf(rec.plan, rec.outlookState, rec.estimates, earnedIncome(rec.input)),
      },
      rec.players,
    );
    return await updateDecisionLog(
      dir,
      gameId,
      playerId,
      (log) => {
        if (log.turns[String(rec.turn)]?.sent) return undefined;
        const boards = decodeBoards(log);
        boards.set(rec.turn, board);
        const turns = { ...log.turns, [String(rec.turn)]: entry };
        encodeBoards(turns, boards);
        return { ...log, turns };
      },
      opts,
    );
  } catch {
    return false;
  }
}

/** One board seen but not planned, for {@link recordObservations}. */
export interface Observation {
  turn: number;
  board: BoardState;
  source: ObservationSource;
}

/**
 * Log the boards of turns seen but not planned (no-gaps rule (a)), in one write: an observation entry
 * each, keeping any sent orders and override already logged for the turn. Never overwrites a planned
 * entry, and a board filled from history never replaces a board already logged (a live one is the
 * better view); a later {@link recordDecision} of the turn upgrades it. `true` when written (`false`
 * when nothing was new). Never throws.
 */
export async function recordObservations(
  dir: string,
  gameId: number,
  playerId: number,
  seen: readonly Observation[],
  opts: DecisionLogOptions = {},
): Promise<boolean> {
  try {
    const items = seen.map((o) => ({ turn: o.turn, board: plainBoard(o.board), source: o.source }));
    if (!items.length) return false;
    return await updateDecisionLog(
      dir,
      gameId,
      playerId,
      (log) => {
        const turns = { ...log.turns };
        const boards = decodeBoards(log);
        let changed = false;
        for (const o of items) {
          const was = turns[String(o.turn)];
          if (was?.kind === 'planned' || was?.decision) continue;
          if (o.source === 'history' && was?.board) continue;
          boards.set(o.turn, o.board);
          turns[String(o.turn)] = { ...was, kind: 'observed', source: o.source };
          changed = true;
        }
        if (!changed) return undefined;
        encodeBoards(turns, boards);
        return { ...log, turns };
      },
      opts,
    );
  } catch {
    return false;
  }
}

/** {@link recordObservations} of one board. */
export async function recordObservation(
  dir: string,
  gameId: number,
  playerId: number,
  turn: number,
  board: BoardState,
  source: ObservationSource,
  opts: DecisionLogOptions = {},
): Promise<boolean> {
  return recordObservations(dir, gameId, playerId, [{ turn, board, source }], opts);
}

export interface RecordSentOptions extends DecisionLogOptions {
  /** The game's players, for scrubbing names from the override's reason; only ids are ever written. */
  players?: readonly { id: number; name?: string }[];
}

/**
 * Log the orders actually sent on `turn`, with `override` when they differ from the decision (or came
 * from outside the planner). Starts an entry when the turn has none. Name-free: every name in
 * `opts.players` is scrubbed from the override's reason. `true` when written. Never throws.
 */
export async function recordSent(
  dir: string,
  gameId: number,
  playerId: number,
  turn: number,
  sent: LoggedSent,
  override?: DecisionOverride,
  opts: RecordSentOptions = {},
): Promise<boolean> {
  const kept = encodeValue(sent) as LoggedSent;
  const ov = override
    ? { by: override.by, ...(override.reason !== undefined ? { reason: scrubNames(String(override.reason), opts.players) } : {}) }
    : undefined;
  return updateDecisionLog(
    dir,
    gameId,
    playerId,
    (log) => {
      const { override: _old, ...was } = log.turns[String(turn)] ?? {};
      return { ...log, turns: { ...log.turns, [String(turn)]: { ...was, sent: kept, ...(ov ? { override: ov } : {}) } } };
    },
    opts,
  );
}

/** Fill what happened after `turn`; nothing when the turn has no entry. `true` when written. Never throws. */
export async function recordOutcome(
  dir: string,
  gameId: number,
  playerId: number,
  turn: number,
  next: DecisionOutcome,
  opts: DecisionLogOptions = {},
): Promise<boolean> {
  const kept = encodeValue(next) as DecisionOutcome;
  return updateDecisionLog(
    dir,
    gameId,
    playerId,
    (log) => {
      const e = log.turns[String(turn)];
      return e ? { ...log, turns: { ...log.turns, [String(turn)]: { ...e, next: kept } } } : undefined;
    },
    opts,
  );
}

/**
 * Fill what happened after `turn` with `make(entry, board)` (the turn's own entry and its rebuilt board),
 * under one lock: nothing when the turn has no entry, already has its outcome, or `make` gives none.
 * `true` when written. Never throws.
 */
export async function fillOutcome(
  dir: string,
  gameId: number,
  playerId: number,
  turn: number,
  make: (entry: DecisionEntry, board: BoardState | undefined) => DecisionOutcome | undefined,
  opts: DecisionLogOptions = {},
): Promise<boolean> {
  return updateDecisionLog(
    dir,
    gameId,
    playerId,
    (log) => {
      const e = log.turns[String(turn)];
      if (!e || e.next) return undefined;
      const next = make(e, boardAt(log, turn));
      return next ? { ...log, turns: { ...log.turns, [String(turn)]: { ...e, next: encodeValue(next) as DecisionOutcome } } } : undefined;
    },
    opts,
  );
}

const mine = (b: BoardState, me: number): Set<number> =>
  new Set(b.territories.flatMap((x) => (x.owner.kind === 'player' && x.owner.playerId === me ? [x.territoryId] : [])));
const byNum = (a: number, b: number) => a - b;

/**
 * What happened after a turn, from its board (`before`) and the following turn's (`after`): the income
 * then (`null`: unread), the territories gained and lost, which of the plan's `captures` I held, the
 * bonuses (id → every member territory) I held in full, and whether I had no territory left.
 */
export function decisionOutcome(a: {
  before: BoardState | undefined;
  after: BoardState;
  me: number;
  income: number | null;
  captures: readonly number[];
  bonuses: ReadonlyMap<number, readonly number[]>;
}): DecisionOutcome {
  const now = mine(a.after, a.me);
  const was = a.before ? mine(a.before, a.me) : undefined;
  return {
    income: a.income,
    gained: was ? [...now].filter((id) => !was.has(id)).sort(byNum) : [],
    lost: was ? [...was].filter((id) => !now.has(id)).sort(byNum) : [],
    capturesMade: a.captures.filter((id) => now.has(id)),
    capturesMissed: a.captures.filter((id) => !now.has(id)),
    bonusesHeld: [...a.bonuses]
      .filter(([, ts]) => ts.length > 0 && ts.every((id) => now.has(id)))
      .map(([id]) => id)
      .sort(byNum),
    eliminated: now.size === 0,
  };
}

/**
 * Orders as sent, for {@link ordersDiffer}: a move with `exact: false` (a percentage or a mode) is never
 * the planner's; `commander` when it takes my commander along.
 */
export interface SentOrders {
  deploys: readonly { territoryId: number; armies: number }[];
  moves: readonly { from: number; to: number; armies: number; exact?: boolean; commander?: boolean }[];
}

/**
 * Whether the orders sent differ from a decision's: the deploys compared per territory (merged, in any
 * order), the moves one by one in the order sent, the commander flag included (a planned commander move
 * sent without it, or the reverse, differs); a percentage or mode move always differs. Card plays are
 * not compared (the planner plays none).
 */
export function ordersDiffer(decision: Pick<LoggedDecision, 'deploys' | 'moves'>, sent: SentOrders): boolean {
  const sum = (ds: readonly { territoryId: number; armies: number }[]) => {
    const m = new Map<number, number>();
    for (const d of ds) m.set(d.territoryId, (m.get(d.territoryId) ?? 0) + d.armies);
    return JSON.stringify([...m].filter(([, n]) => n !== 0).sort(([x], [y]) => x - y));
  };
  if (sum(decision.deploys) !== sum(sent.deploys)) return true;
  if (decision.moves.length !== sent.moves.length) return true;
  return sent.moves.some((m, i) => {
    const d = decision.moves[i]!;
    return m.exact === false || m.from !== d.from || m.to !== d.to || m.armies !== d.armies || !!m.commander !== !!d.commander;
  });
}

/** What {@link recordSubmission} logs. */
export interface Submission {
  /** The orders as kept (`loggedSentOf`): every order sent. */
  sent: LoggedSent;
  /** The same orders for comparing with the decision. */
  orders: SentOrders;
  /** Who chose orders that differ, when the caller says. */
  by?: 'hand' | 'agent';
  /** Why, when the caller says (kept as given, names scrubbed). */
  reason?: string;
  /** The game's players, for scrubbing names from the reason; only ids are ever written. */
  players?: readonly { id: number; name?: string }[];
}

/**
 * Log the orders sent on `turn` (one lock: read, compare, write). Against a logged decision an override
 * is kept only when the orders differ (`by` the agent unless said); with no decision logged, only when
 * the caller says who chose them or why (`by` hand unless said): orders from outside the planner. An
 * entry (an observation's board, say) keeps everything else; a turn with none gets one. `true` when
 * written. Never throws.
 */
export async function recordSubmission(
  dir: string,
  gameId: number,
  playerId: number,
  turn: number,
  sub: Submission,
  opts: DecisionLogOptions = {},
): Promise<boolean> {
  try {
    const kept = encodeValue(sub.sent) as LoggedSent;
    const reason = sub.reason !== undefined ? scrubNames(String(sub.reason), sub.players) : undefined;
    return await updateDecisionLog(
      dir,
      gameId,
      playerId,
      (log) => {
        const { override: _old, ...was } = log.turns[String(turn)] ?? {};
        const decided = was.decision;
        const by = decided ? (ordersDiffer(decided, sub.orders) ? (sub.by ?? 'agent') : undefined) : sub.by !== undefined || reason !== undefined ? (sub.by ?? 'hand') : undefined;
        const override: DecisionOverride | undefined = by ? { by, ...(reason !== undefined ? { reason } : {}) } : undefined;
        return { ...log, turns: { ...log.turns, [String(turn)]: { ...was, sent: kept, ...(override ? { override } : {}) } } };
      },
      opts,
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// The end of a game: truth, accuracy and compaction

/** What each turn of `log` offers the truth's scoring: its board, logged outlook, estimates and income. */
export function loggedTurns(log: Pick<DecisionLog, 'turns'>): Map<number, LoggedTurn> {
  const out = new Map<number, LoggedTurn>();
  for (const turn of turnKeys(log.turns)) {
    const e = log.turns[String(turn)]!;
    if (!e.board && !e.decision) continue;
    const board = boardAt(log, turn);
    // The decision's income first: compaction never drops it (an entry written before it was kept
    // there falls back to the input; compaction copies it into the decision before dropping that).
    const income = e.decision?.income ?? earnedIncome(e.input) ?? log.turns[String(turn - 1)]?.next?.income ?? null;
    out.set(turn, {
      ...(board ? { board } : {}),
      outlook: e.decision?.outlook ?? null,
      estimates: e.decision?.estimates ?? [],
      myIncome: typeof income === 'number' ? income : null,
    });
  }
  return out;
}

/**
 * Write the end-of-game truth (no-gaps rule (c)): `make` gets what each logged turn offers and returns
 * the truth (src/analysis/decision-truth.ts); every turn it covers gets its `truth` (a turn with no
 * entry, a truth-only entry), every logged turn its `accuracy`, the log its `accuracySummary` and
 * `truthMissing`, and status `finished` (a compacted log stays compacted). Starts no log: a game with
 * none, or with truth only, gets nothing. Running it again replaces what it wrote. `true` when written.
 * Never throws.
 */
export async function recordTruth(
  dir: string,
  gameId: number,
  playerId: number,
  make: (logged: Map<number, LoggedTurn>) => TruthResult | undefined,
  opts: DecisionLogOptions = {},
): Promise<boolean> {
  return updateDecisionLog(
    dir,
    gameId,
    playerId,
    (log) => {
      // No turn logged (no log, or truth only): nothing to score, and a truth-only file per finished game
      // would crowd real logs out of the prune's budget. Gaps inside a log still get truth-only entries.
      if (!Object.values(log.turns).some((e) => Object.keys(e).some((k) => k !== 'truth' && k !== 'accuracy'))) return undefined;
      const r = make(loggedTurns(log));
      if (!r) return undefined;
      const turns: Record<string, DecisionEntry> = {};
      for (const [k, e] of Object.entries(log.turns)) {
        const { truth: _t, accuracy: _a, ...rest } = e;
        if (Object.keys(rest).length) turns[k] = rest;
      }
      for (const [turn, truth] of r.truth) turns[String(turn)] = { ...turns[String(turn)], truth: encodeValue(truth) as TurnTruth };
      for (const [turn, accuracy] of r.accuracy) if (turns[String(turn)]) turns[String(turn)]!.accuracy = encodeValue(accuracy) as TurnAccuracy;
      return {
        ...log,
        status: log.status === 'compacted' ? 'compacted' : 'finished',
        turns,
        accuracySummary: encodeValue(r.summary) as AccuracySummary,
        truthMissing: [...r.missing],
      };
    },
    opts,
  );
}

/** Turns kept whole before a loss or an elimination, and from the start of the game. */
export const KEEP_BEFORE_LOSS = 5;
export const KEEP_FIRST = 3;
/** Next income this far below the plan's expectation (a share of it) keeps the turn whole. */
export const INCOME_SHORTFALL = 0.2;

/**
 * The turns whose replay input compaction keeps (#412 task 3): any override; a turn whose outlook state
 * changed from the previous decided turn's; the {@link KEEP_BEFORE_LOSS} decided turns up to an
 * elimination (and, with `lost`, the last ones of the game); the first {@link KEEP_FIRST} decided turns;
 * a turn whose next income fell short of the expected by {@link INCOME_SHORTFALL} or more; a turn whose
 * accuracy shows an estimate off by more than 1.5× or under 0.5×. Reads nothing compaction drops, so it
 * gives the same answer before and after. Pure.
 */
export function interestingTurns(log: Pick<DecisionLog, 'turns'>, opts: { lost?: boolean } = {}): Set<number> {
  const decided = turnKeys(log.turns).filter((t) => log.turns[String(t)]!.decision);
  const out = new Set<number>(decided.slice(0, KEEP_FIRST));
  const lastBefore = (i: number) => decided.slice(Math.max(0, i - KEEP_BEFORE_LOSS + 1), i + 1).forEach((t) => out.add(t));
  if (opts.lost && decided.length) lastBefore(decided.length - 1);
  let prevOutlook: OutlookState | null | undefined;
  decided.forEach((turn, i) => {
    const e = log.turns[String(turn)]!;
    const outlook = e.decision!.outlook ?? null;
    if (i > 0 && outlook !== prevOutlook) out.add(turn);
    prevOutlook = outlook;
    if (e.override) out.add(turn);
    if (e.next?.eliminated) lastBefore(i);
    const expected = e.decision!.expected?.nextIncome;
    if (typeof expected === 'number' && expected > 0 && typeof e.next?.income === 'number' && e.next.income <= expected * (1 - INCOME_SHORTFALL)) out.add(turn);
    if (estimateOff(e.accuracy)) out.add(turn);
  });
  // An entry that is not decided (sent orders only, say) keeps its override's turn too.
  for (const t of turnKeys(log.turns)) if (log.turns[String(t)]!.override) out.add(t);
  return out;
}

/**
 * `log` compacted: every uninteresting turn's `input` dropped, everything else kept; status `compacted`.
 * A decision written without its `income` gets it from the input first, so the truth reads the same
 * income after compaction as before. Pure.
 */
export function compactLog(log: DecisionLog, opts: { lost?: boolean } = {}): DecisionLog {
  const keep = interestingTurns(log, opts);
  const turns: Record<string, DecisionEntry> = {};
  for (const [k, e] of Object.entries(log.turns)) {
    if (e.input && !keep.has(Number(k))) {
      const { input, ...rest } = e;
      const income = earnedIncome(input);
      turns[k] = rest.decision && rest.decision.income === undefined && income !== undefined ? { ...rest, decision: { ...rest.decision, income } } : rest;
    } else turns[k] = e;
  }
  return { ...log, status: 'compacted', turns };
}

/**
 * Compact a finished game's log (no-gaps rule (b): only uninteresting turns' replay `input` goes). Under
 * `WARAPP_DECISION_LOG=full` nothing is dropped and the log is marked `finished`. Nothing for a game with
 * no log. Idempotent. `true` when written. Never throws.
 */
export async function compactDecisionLog(
  dir: string,
  gameId: number,
  playerId: number,
  opts: DecisionLogOptions & { lost?: boolean } = {},
): Promise<boolean> {
  const mode = opts.mode ?? decisionLogMode();
  return updateDecisionLog(
    dir,
    gameId,
    playerId,
    (log) => {
      if (!Object.keys(log.turns).length) return undefined;
      if (mode === 'full') return log.status === 'active' ? { ...log, status: 'finished' } : undefined;
      const done = compactLog(log, opts.lost ? { lost: true } : {});
      const dropped = Object.keys(log.turns).some((k) => log.turns[k]!.input && !done.turns[k]!.input);
      return dropped || log.status !== 'compacted' ? done : undefined;
    },
    { ...opts, mode },
  );
}

/**
 * Mark the logs of games known to be over `finished`, dropping nothing (each stays whole for a later
 * truth and compaction, which accept a `finished` log): a game whose end-of-game pass captured no
 * history (`read-failed`, `history-unreadable`) or did not run (`WARAPP_PLAYER_PROFILE=off`) would
 * otherwise keep its log `active`, which the prune never deletes. `playerId` restricts it to that
 * account's logs; without it the log's own owner serves (the account may be unknown, but the game is
 * over whoever played it). A missing, unreadable, empty or already finished/compacted log is left as
 * it is; only the head of each file is read unless it needs a write. Returns the game ids written.
 * Never throws.
 */
export async function finishDecisionLogs(
  dir: string,
  gameIds: readonly number[],
  playerId: number | undefined,
  opts: DecisionLogOptions = {},
): Promise<number[]> {
  if ((opts.mode ?? decisionLogMode()) === 'off') return [];
  const done: number[] = [];
  for (const gameId of new Set(gameIds)) {
    try {
      const head = await headOf(decisionLogPath(dir, gameId), gameId);
      if (head?.status !== 'active' || (playerId !== undefined && head.playerId !== playerId)) continue;
      const written = await updateDecisionLog(
        dir,
        gameId,
        head.playerId,
        (log) => (log.status === 'active' && Object.keys(log.turns).length ? { ...log, status: 'finished' } : undefined),
        opts,
      );
      if (written) done.push(gameId);
    } catch {
      // Missing or unreadable: nothing to close.
    }
  }
  return done;
}

// ---------------------------------------------------------------------------------------------
// Listing and pruning

export interface DecisionLogListing {
  gameId: number;
  playerId: number;
  status: DecisionLogStatus;
  bytes: number;
  mtimeMs: number;
}

/**
 * The header of a log read from its first {@link HEAD_BYTES} bytes (it is written before `turns`): the
 * text up to `"turns":` closed with an empty `turns`. `undefined` when the head holds no header.
 */
async function headOf(path: string, gameId: number): Promise<DecisionLog | undefined> {
  const fh = await open(path, 'r');
  let head: string;
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    head = buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
  const at = head.indexOf('"turns":');
  if (at < 0) return undefined;
  return logOf(JSON.parse(`${head.slice(0, at)}"turns":{}}`), gameId);
}

/**
 * The account a decision log at `path` belongs to, read from its head only ({@link HEAD_BYTES}: the
 * header is written before `turns`), so a caller sorting logs by account never reads one whole.
 * `undefined` when the head holds no header for `gameId`. Never throws.
 */
export async function decisionLogOwner(path: string, gameId: number): Promise<number | undefined> {
  try {
    return (await headOf(path, gameId))?.playerId;
  } catch {
    return undefined;
  }
}

/** Every decision log whose header reads (from the head of the file only), by game id. Never throws. */
export async function listDecisionLogs(dir: string): Promise<DecisionLogListing[]> {
  let names: string[];
  try {
    names = await readdir(decisionsDir(dir));
  } catch {
    return [];
  }
  const out: DecisionLogListing[] = [];
  for (const name of names) {
    const m = DECISION_FILE.exec(name);
    if (!m) continue;
    const gameId = Number(m[1]);
    try {
      const path = decisionLogPath(dir, gameId);
      const [s, log] = await Promise.all([stat(path), headOf(path, gameId)]);
      if (log) out.push({ gameId, playerId: log.playerId, status: log.status, bytes: s.size, mtimeMs: s.mtimeMs });
    } catch {
      // Unreadable: neither listed nor pruned.
    }
  }
  return out.sort((a, b) => a.gameId - b.gameId);
}

/**
 * Delete the least recently written finished (or compacted) logs while more than `maxGames` logs or
 * more than `maxBytes` in all are kept; a game still running is never deleted, and a file that does not
 * parse is neither counted nor deleted. Returns the game ids deleted, oldest first. Never throws.
 */
export async function pruneDecisionLogs(
  dir: string,
  caps: { maxGames?: number; maxBytes?: number } = {},
): Promise<number[]> {
  const maxGames = caps.maxGames ?? MAX_DECISION_GAMES;
  const maxBytes = caps.maxBytes ?? MAX_DECISION_BYTES;
  const all = await listDecisionLogs(dir);
  let count = all.length;
  let bytes = all.reduce((s, l) => s + l.bytes, 0);
  const done = all.filter((l) => l.status !== 'active').sort((a, b) => a.mtimeMs - b.mtimeMs || a.gameId - b.gameId);
  const removed: number[] = [];
  for (const l of done) {
    if (count <= maxGames && bytes <= maxBytes) break;
    try {
      // Parsed whole only now, just before it goes: a file that does not parse is never deleted.
      const gone = await withPathLock(decisionLogPath(dir, l.gameId), async () => {
        const r = await readRaw(dir, l.gameId);
        if (r.kind !== 'log' || r.log.status === 'active') return false;
        await unlink(decisionLogPath(dir, l.gameId));
        return true;
      });
      if (!gone) continue;
      removed.push(l.gameId);
      count -= 1;
      bytes -= l.bytes;
    } catch {
      // Gone already, or not removable: leave it.
    }
  }
  return removed;
}
