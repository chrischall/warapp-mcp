// What a finished game teaches (#312 E2), pure: the history's boards read as opponent profile turns
// (part C), the record of the game for its map (my start and income curve, the winner's start and
// pace), and the lessons kept across games (the turn my income went flat, how I lost, and the tracked
// estimates scored against the true incomes the history shows, by frontier coverage, #294). No I/O,
// no clock; ids ascending. The stores (src/lessons-store.ts, src/profile-store.ts) keep these
// name-free. Profiles and lessons INFORM ONLY (owner decision P1): no planner decision reads them.
//
// Turn numbers: a history board is numbered by completed turns (`afterTurn` N is the board turn N + 1
// is played on); my orders and my cached boards are numbered by the turn played. So the orders of turn
// T ran on history board T − 1, and the board I cached for turn T is my fogged view of that same board.
import type { BoardState } from '../board.js';
import type { GameSettings } from '../normalize.js';
import type { PlayerTurn } from './finished-game.js';
import { turnIncomes } from './finished-game.js';
import type { MapGraph } from './graph.js';
import { howLost, type LossCause } from './how-lost.js';
import { habitsOf, observeTurn, type Habits, type ObserveInput, type ObservedPrimitives } from './opponent-profile.js';
import { trackOpponents, type MyOrders, type TrackGame, type TurnBoard } from './opponents.js';
import type { PlannerSettings } from './plan/shared.js';

type HistoryBoards = readonly { turn: number; board: BoardState }[];

const ownsLand = (b: BoardState, p: number) => b.territories.some((t) => t.owner.kind === 'player' && t.owner.playerId === p);
const ascending = <T extends { turn: number }>(xs: readonly T[]) => [...xs].sort((a, b) => a.turn - b.turn);

// ---- part C: the history as profile turns ----

/** What {@link observeHistory} reads. */
export interface HistoryObserveInput {
  graph: MapGraph;
  me: number;
  /** The history boards (by completed turns). */
  boards: HistoryBoards;
  /** My cached orders by the turn played. */
  orders: ReadonlyMap<number, MyOrders>;
  settings: ObserveInput['settings'];
  cards?: readonly string[] | undefined;
  /** My opponents: never me, a teammate, or a human who became an AI. */
  opponents: readonly number[];
}

/**
 * Each opponent's turns as the history shows them (part C of docs/PLAN-PROFILES.md): every pair of
 * consecutive history boards N, N + 1 is turn N + 1, observed with my orders of that turn when cached
 * (`observeTurn`, the same rules as the live boards; a history board shows everything, so nothing is
 * left out for the fog). Only while I held land on the earlier board: after I am out nothing is
 * between me and anyone. Opponents ascending, turns oldest first; an opponent never observed is left
 * out. Pure.
 */
export function observeHistory(input: HistoryObserveInput): Map<number, ObservedPrimitives[]> {
  const boards = ascending(input.boards);
  const out = new Map<number, ObservedPrimitives[]>();
  for (let i = 0; i + 1 < boards.length; i++) {
    const was = boards[i]!;
    const now = boards[i + 1]!;
    if (now.turn !== was.turn + 1 || !ownsLand(was.board, input.me)) continue;
    const turn = was.turn + 1;
    const seen = observeTurn({
      graph: input.graph,
      me: input.me,
      previous: was.board,
      current: now.board,
      orders: input.orders.get(turn),
      settings: input.settings,
      opponents: input.opponents,
      ...(input.cards !== undefined ? { cards: input.cards } : {}),
    });
    for (const [o, primitives] of seen) {
      const list = out.get(o) ?? [];
      list.push({ turn, primitives });
      out.set(o, list);
    }
  }
  return new Map([...out].sort(([a], [b]) => a - b));
}

/** {@link observeHistory} added up into habits per opponent (`habitsOf`). Pure. */
export function historyHabits(input: HistoryObserveInput): Map<number, Habits> {
  return new Map([...observeHistory(input)].map(([o, turns]) => [o, habitsOf(turns)]));
}

// ---- income curves ----

/** One player's income on each history board, by completed turns (ascending). */
export type IncomeCurve = { afterTurn: number; income: number }[];

/** `player`'s curve from the capture's turns (`FinishedCapture.turns`). Pure. */
export function incomeCurve(turns: readonly { afterTurn: number; players: ReadonlyMap<number, PlayerTurn> }[], player: number): IncomeCurve {
  return turns
    .flatMap((t) => {
      const p = t.players.get(player);
      return p ? [{ afterTurn: t.afterTurn, income: p.income }] : [];
    })
    .sort((a, b) => a.afterTurn - b.afterTurn);
}

// #303: one definition of "flat", shared with the planner's income trend.
import { FLAT_TOLERANCE, FLAT_TURNS } from './income-trend.js';
export { FLAT_TOLERANCE, FLAT_TURNS };

/**
 * The first board (by completed turns, the opening's board 0 left out) from which my income stayed
 * within {@link FLAT_TOLERANCE} of it (at least 1) on each of the next {@link FLAT_TURNS} consecutive
 * boards, while I held land; `null` when it never did. Pure.
 */
export function flatTurn(curve: IncomeCurve): number | null {
  const at = new Map(curve.map((c) => [c.afterTurn, c.income]));
  for (const { afterTurn, income } of [...curve].sort((a, b) => a.afterTurn - b.afterTurn)) {
    if (afterTurn < 1 || income <= 0) continue;
    const tol = Math.max(1, FLAT_TOLERANCE * income);
    let flat = true;
    for (let k = 1; k <= FLAT_TURNS && flat; k++) {
      const next = at.get(afterTurn + k);
      flat = next !== undefined && next > 0 && Math.abs(next - income) <= tol;
    }
    if (flat) return afterTurn;
  }
  return null;
}

// ---- the map record's entry ----

/** A start: its territories and every bonus with a member among them (the region it opened in). */
export interface StartRegion {
  territories: number[];
  bonuses: number[];
}

/** The bonuses with a member territory in `start`, ascending. Pure. */
export function startRegion(g: MapGraph, start: readonly number[]): StartRegion {
  const set = new Set(start);
  const bonuses = [...g.bonusById.values()].filter((b) => b.territoryIds.some((t) => set.has(t))).map((b) => b.id).sort((a, b) => a - b);
  return { territories: [...start].sort((a, b) => a - b), bonuses };
}

/** Income curve points kept per game (the opening and the middle game: the pace). */
export const MAX_CURVE_POINTS = 60;
/** The boards the pace is read on: the income after these completed turns. */
export const PACE_TURNS = [4, 8] as const;

const incomeAfter = (curve: IncomeCurve, n: number) => curve.find((c) => c.afterTurn === n)?.income ?? null;

/** A finished game in its map's record, by real ids (the store keeps no player id). */
export interface MapGameFacts {
  me: StartRegion & { income: (number | null)[]; income4: number | null; income8: number | null };
  winners: (StartRegion & { income4: number | null; income8: number | null })[];
}

/**
 * My start region and income curve (index = completed turns, `null` where no board read, at most
 * {@link MAX_CURVE_POINTS}), and each winner's start region and income after turns 4 and 8 (the pace
 * to beat). Pure.
 */
export function mapFacts(
  g: MapGraph,
  me: number,
  winners: readonly number[],
  starts: ReadonlyMap<number, readonly number[]>,
  turns: readonly { afterTurn: number; players: ReadonlyMap<number, PlayerTurn> }[],
): MapGameFacts {
  const mine = incomeCurve(turns, me);
  const last = Math.min(MAX_CURVE_POINTS, mine.length ? mine.at(-1)!.afterTurn + 1 : 0);
  const income: (number | null)[] = Array.from({ length: last }, (_, i) => incomeAfter(mine, i));
  const pace = (curve: IncomeCurve) => ({ income4: incomeAfter(curve, PACE_TURNS[0]), income8: incomeAfter(curve, PACE_TURNS[1]) });
  return {
    me: { ...startRegion(g, starts.get(me) ?? []), income, ...pace(mine) },
    winners: [...winners].sort((a, b) => a - b).map((w) => ({ ...startRegion(g, starts.get(w) ?? []), ...pace(incomeCurve(turns, w)) })),
  };
}

// ---- how I lost ----

/** How the game ended for me, name-free: the cause and the turn played when it came. */
export type LessonCause = LossCause | 'surrendered' | 'booted' | 'still-holding';
export interface LessonLoss {
  cause: LessonCause;
  /** The turn played when I was out (eliminated: the last board I held land on + 1); `null` when not known. */
  turn: number | null;
}

/**
 * How I lost, from the history (full boards): eliminated → `howLost` on the history boards (numbered
 * by the turn played on them; a history board carries no special units, so a game with commanders
 * reads `unknown`); surrendered or booted → that, on my out turn; lost while still holding land (a team
 * game my side lost) → `still-holding`. `null` for a game I did not lose. Pure.
 */
export function lessonLoss(input: {
  result: string;
  me: number;
  boards: HistoryBoards;
  orders: ReadonlyMap<number, MyOrders>;
  graph: MapGraph;
  settings: Pick<GameSettings, 'offensiveKillRate' | 'defensiveKillRate' | 'luckModifier' | 'roundingMode' | 'commanders'> | undefined;
  numberOfTurns: number | null;
  outTurn: number | null;
}): LessonLoss | null {
  const { result } = input;
  if (result === 'surrendered' || result === 'booted') return { cause: result, turn: input.outTurn };
  if (result === 'lost') return { cause: 'still-holding', turn: input.numberOfTurns };
  if (result !== 'eliminated') return null;
  const s = input.settings;
  const loss = howLost({
    me: input.me,
    boards: input.boards.map((b) => ({ turn: b.turn + 1, board: b.board })),
    orders: input.orders,
    adjacency: input.graph.neighbors,
    rates: {
      ...(s?.offensiveKillRate !== undefined ? { offensiveKillRate: s.offensiveKillRate } : {}),
      ...(s?.defensiveKillRate !== undefined ? { defensiveKillRate: s.defensiveKillRate } : {}),
      ...(s?.luckModifier !== undefined ? { luck: s.luckModifier } : {}),
      ...(s?.roundingMode !== undefined ? { rounding: s.roundingMode } : {}),
    },
    ...(input.numberOfTurns !== null ? { turnsCompleted: input.numberOfTurns } : {}),
    ...(s?.commanders !== undefined ? { commanders: s.commanders } : {}),
  });
  return loss ? { cause: loss.cause, turn: loss.turn } : { cause: 'unknown', turn: input.outTurn };
}

// ---- calibration (#294, #318 a) ----

/** One opponent on one turn I cached: the tracker's income estimate against the true income. */
export interface CalibrationSample {
  turn: number;
  opponent: number;
  /** `trackOpponents`' income over my cached boards up to the turn. */
  estimate: number;
  /** Its income on the history board the turn was played on (base + full bonuses, cards aside). */
  truth: number;
  /** The track's frontier coverage share (#294); `null` when no pair of my boards measured it. */
  coverage: number | null;
}

/** What {@link calibrationSamples} reads. */
export interface CalibrationInput {
  graph: MapGraph;
  me: number;
  /** My cached boards (fogged), numbered by the turn played, with my orders. */
  cached: readonly TurnBoard[];
  /** The history boards (by completed turns). */
  history: HistoryBoards;
  plannerSettings: PlannerSettings;
  incomeSettings: Pick<GameSettings, 'minimumArmyBonus' | 'bonusArmyPer'> | undefined;
  /** The game around the boards, every seat as still playing (a final state would read a seat out early). */
  game: TrackGame;
  /** The players scored: my opponents. */
  opponents: readonly number[];
}

/**
 * For each turn T I cached a board for and the history has the board T was played on: every
 * opponent with land there and a tracked income (`trackOpponents` over my cached boards up to T, as
 * the plan and the track tool read them), the estimate beside the truth and the coverage. Pure.
 */
export function calibrationSamples(input: CalibrationInput): CalibrationSample[] {
  const truthBoard = new Map(input.history.map((b) => [b.turn, b.board]));
  const cached = ascending(input.cached);
  const scored = new Set(input.opponents);
  const out: CalibrationSample[] = [];
  for (const { turn } of cached) {
    const truth = truthBoard.get(turn - 1);
    if (!truth) continue;
    const upTo = cached.filter((b) => b.turn <= turn);
    if (upTo.length < 2) continue;
    const tracks = trackOpponents(input.graph, upTo, input.me, input.plannerSettings, input.game);
    const real = turnIncomes(input.graph, truth, input.opponents, input.incomeSettings);
    for (const track of [...tracks].sort((a, b) => a.playerId - b.playerId)) {
      if (!scored.has(track.playerId) || track.income === null) continue;
      const t = real.get(track.playerId);
      if (!t || t.income <= 0) continue;
      out.push({ turn, opponent: track.playerId, estimate: track.income, truth: t.income, coverage: track.coverage?.share ?? null });
    }
  }
  return out;
}

/** The coverage buckets a sample is counted in. */
export const COVERAGE_BUCKETS = ['none', 'under-25', '25-50', '50-75', '75-up'] as const;
export type CoverageBucket = (typeof COVERAGE_BUCKETS)[number];

export function coverageBucket(share: number | null): CoverageBucket {
  if (share === null) return 'none';
  if (share < 0.25) return 'under-25';
  if (share < 0.5) return '25-50';
  if (share < 0.75) return '50-75';
  return '75-up';
}

/** A ratio's running counts (estimate ÷ truth): its count, sum and square sum, log sum, and how many read under half or over 1.5×. */
export interface RatioStats {
  n: number;
  sum: number;
  sq: number;
  logSum: number;
  under: number;
  over: number;
}

/** A ratio under this reads low; over {@link CALIBRATION_HIGH}, high. */
export const CALIBRATION_LOW = 0.5;
export const CALIBRATION_HIGH = 1.5;

export type Calibration = Partial<Record<CoverageBucket, RatioStats>>;

const round = (x: number) => Math.round(x * 1e6) / 1e6;

/** The samples counted by coverage bucket (aggregates only: no turn, no player). Pure. */
export function aggregateCalibration(samples: readonly CalibrationSample[]): Calibration {
  const out: Calibration = {};
  for (const s of samples) {
    const r = s.estimate / s.truth;
    const b = coverageBucket(s.coverage);
    const x = out[b] ?? { n: 0, sum: 0, sq: 0, logSum: 0, under: 0, over: 0 };
    out[b] = {
      n: x.n + 1,
      sum: round(x.sum + r),
      sq: round(x.sq + r * r),
      logSum: round(x.logSum + Math.log(Math.max(r, 1e-6))),
      under: x.under + (r < CALIBRATION_LOW ? 1 : 0),
      over: x.over + (r > CALIBRATION_HIGH ? 1 : 0),
    };
  }
  return out;
}

/** Two calibrations added, `b` scaled (−1 takes it back out). Pure. */
export function addCalibration(a: Calibration, b: Calibration, scale = 1): Calibration {
  const out: Calibration = {};
  for (const k of COVERAGE_BUCKETS) {
    const x = a[k];
    const y = b[k];
    if (!x && !y) continue;
    const z = { n: 0, sum: 0, sq: 0, logSum: 0, under: 0, over: 0 };
    for (const f of Object.keys(z) as (keyof RatioStats)[]) z[f] = round((x?.[f] ?? 0) + scale * (y?.[f] ?? 0));
    if (z.n > 0) out[k] = z;
  }
  return out;
}
