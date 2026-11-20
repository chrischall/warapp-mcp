// The decision log (#412): per game, for every turn this server planned, what was seen (the fogged
// board), what the planner read and decided and why, what was actually sent (and any override), and
// what happened next. It is the data strategy changes and scenarios are replayed against offline
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
// into a tool); a file that exists but does not parse is never overwritten. At most MAX_DECISION_GAMES
// games and MAX_DECISION_BYTES in all (`pruneDecisionLogs`: the oldest finished games first, never one
// still running). `WARAPP_DECISION_LOG=off` writes nothing; `full` keeps every turn whole (no compaction).
import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { MyOrders } from './analysis/opponents.js';
import type { OutlookState } from './analysis/outlook.js';
import type { PlanInput, TurnPlan } from './analysis/plan/shared.js';
import type { BoardState, TerritoryState } from './board.js';
import { writeJsonAtomic } from './map-store.js';
import { withPathLock } from './path-lock.js';
import { VERSION } from './version.js';

export const DECISION_LOG_VERSION = 1;
/** Games whose decision logs are kept at most. */
export const MAX_DECISION_GAMES = 200;
/** Bytes of decision logs kept at most, all games together. */
export const MAX_DECISION_BYTES = 50 * 1024 * 1024;
/** A full board at least this many turns after the last full one (and at the first logged turn). */
export const FULL_BOARD_EVERY = 10;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

export const decisionsDir = (dir: string) => join(dir, 'decisions');
export const decisionLogPath = (dir: string, gameId: number) => join(decisionsDir(dir), `${gameId}.json`);
const DECISION_FILE = /^(\d{1,12})\.json$/;

/** `off`: nothing written; `full`: every turn kept whole; `on`: the default. */
export type DecisionLogMode = 'on' | 'off' | 'full';

export function decisionLogMode(env: Readonly<Record<string, string | undefined>> = process.env): DecisionLogMode {
  const v = env.WARAPP_DECISION_LOG?.trim().toLowerCase();
  return v === 'off' ? 'off' : v === 'full' ? 'full' : 'on';
}

export interface DecisionLogOptions {
  /** Default: {@link decisionLogMode} of the environment. */
  mode?: DecisionLogMode;
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
 * as a change against the board. Maps and Sets are tagged (`{ $map }`, `{ $set }`).
 */
export type LoggedInput = Rec & { previousBoard?: StoredPreviousBoard };

/** The keys of `PlanInput` that are not kept in {@link LoggedInput}. */
const INPUT_DROPPED = new Set(['graph', 'board', 'vacated', 'bonusPush', 'previousBoard']);

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

export interface DecisionEntry {
  board?: StoredBoard;
  input?: LoggedInput;
  planner?: { version: string };
  decision?: LoggedDecision;
  sent?: MyOrders;
  override?: DecisionOverride;
  next?: DecisionOutcome;
}

export type DecisionLogStatus = 'active' | 'finished' | 'compacted';

export interface DecisionLog {
  version: number;
  gameId: number;
  playerId: number;
  status: DecisionLogStatus;
  turns: Record<string, DecisionEntry>;
}

/** One planned turn as handed to {@link recordDecision}. */
export interface DecisionRecord {
  turn: number;
  /** The board planned on (as seen: fog included). */
  board: BoardState;
  /** The input the planner was called with. */
  input: PlanInput;
  plan: TurnPlan;
  outlookState?: OutlookState | null;
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
  if (input.previousBoard) {
    const prev = plainBoard(input.previousBoard);
    out.previousBoard = { source: prev.source, verified: prev.verified, ...diff(plainBoard(input.board), prev) };
  }
  return out;
}

/** The planner's input rebuilt from a kept one, this turn's board and the map's graph. */
export function decodeInput(logged: LoggedInput, board: BoardState, graph: PlanInput['graph']): PlanInput {
  const { previousBoard, ...rest } = logged;
  const out = decodeValue(rest) as Rec;
  return {
    ...(out as unknown as PlanInput),
    graph,
    board,
    ...(isRec(previousBoard) && Array.isArray(previousBoard.changed) ? { previousBoard: patch(board, previousBoard) } : {}),
  };
}

function decisionOf(plan: TurnPlan, outlook: OutlookState | null | undefined): LoggedDecision {
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
  }) as LoggedDecision;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `v` with every player name in `players` replaced by `Player <id>` in every string, and every `name`
 * field holding one dropped. Names shorter than two characters are left (they would hit any word).
 */
export function scrubNames<T>(v: T, players: readonly { id: number; name?: string }[] | undefined): T {
  const named = (players ?? [])
    .filter((p) => typeof p.name === 'string' && p.name.trim().length >= 2)
    .map((p) => ({ id: p.id, name: p.name!.trim() }))
    .sort((a, b) => b.name.length - a.name.length);
  if (!named.length) return v;
  const byName = new Set(named.map((p) => p.name.toLowerCase()));
  const res = named.map((p) => ({ re: new RegExp(`(?:Player )?${escapeRe(p.name)}`, 'gi'), to: `Player ${p.id}` }));
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
  if (!isRec(c) || c.gameId !== gameId || !isInt(c.playerId) || !isRec(c.turns)) return undefined;
  const status: DecisionLogStatus = c.status === 'finished' || c.status === 'compacted' ? c.status : 'active';
  return {
    version: isInt(c.version) ? c.version : DECISION_LOG_VERSION,
    gameId,
    playerId: c.playerId,
    status,
    turns: c.turns as Record<string, DecisionEntry>,
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
    return await withPathLock(path, async () => {
      const r = await readRaw(dir, gameId);
      if (r.kind === 'unreadable') return false;
      if (r.kind === 'log' && r.log.playerId !== playerId) return false;
      const current: DecisionLog =
        r.kind === 'log' ? r.log : { version: DECISION_LOG_VERSION, gameId, playerId, status: 'active', turns: {} };
      const next = mutate(current);
      if (!next) return false;
      await writeJsonAtomic(path, decisionsDir(dir), { ...next, version: DECISION_LOG_VERSION, gameId, playerId });
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Log the turn planned (replacing any entry for that turn: its sent orders and outcome go with it).
 * Name-free: every name in `rec.players` is scrubbed. `true` when written. Never throws.
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
    const entry: DecisionEntry = scrubNames(
      {
        input: encodeInput({ ...rec.input, board }),
        planner: { version: VERSION },
        decision: decisionOf(rec.plan, rec.outlookState),
      },
      rec.players,
    );
    return await updateDecisionLog(
      dir,
      gameId,
      playerId,
      (log) => {
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

/**
 * Log the orders actually sent on `turn`, with `override` when they differ from the decision (or came
 * from outside the planner). Starts an entry when the turn has none. `true` when written. Never throws.
 */
export async function recordSent(
  dir: string,
  gameId: number,
  playerId: number,
  turn: number,
  sent: MyOrders,
  override?: DecisionOverride,
  opts: DecisionLogOptions = {},
): Promise<boolean> {
  const kept = encodeValue(sent) as MyOrders;
  const ov = override ? { by: override.by, ...(override.reason !== undefined ? { reason: override.reason } : {}) } : undefined;
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

// ---------------------------------------------------------------------------------------------
// Listing and pruning

export interface DecisionLogListing {
  gameId: number;
  playerId: number;
  status: DecisionLogStatus;
  bytes: number;
  mtimeMs: number;
}

/** Every decision log that parses, by game id. Never throws. */
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
      const [s, text] = await Promise.all([stat(path), readFile(path, 'utf8')]);
      const log = logOf(JSON.parse(text), gameId);
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
      await withPathLock(decisionLogPath(dir, l.gameId), () => unlink(decisionLogPath(dir, l.gameId)));
      removed.push(l.gameId);
      count -= 1;
      bytes -= l.bytes;
    } catch {
      // Gone already, or not removable: leave it.
    }
  }
  return removed;
}
