// The end-of-game truth beside the decision log's estimates (#412 task 3, owner request 2026-11-19), pure.
// Once a finished game's history is read, every turn of the game gets a `truth` block from the history
// board it was played on, and every logged turn an `accuracy` block comparing what it logged with that
// truth; the game gets an `accuracySummary`. No I/O, no clock; ids ascending; ids and numbers only.
//
// Turn numbers (as src/analysis/game-lessons.ts and the #318 calibration): a history board is numbered by
// completed turns, so turn T is played on history board T − 1, and the estimate logged on turn T is
// scored against the opponent's income on history board T − 1 — the calibration's own alignment.
import type { BoardState } from '../board.js';
import type { GameSettings } from '../normalize.js';
import { type CalibrationSample, COVERAGE_BUCKETS, CALIBRATION_HIGH, CALIBRATION_LOW, type CoverageBucket, coverageBucket } from './game-lessons.js';
import { turnIncomes } from './finished-game.js';
import type { MapGraph } from './graph.js';
import type { TrackGame } from './opponents.js';
import { gameOutlook, OUTLOOK_TURNS, readingOf, type OutlookReading } from './outlook.js';
import { type PlannerSettings, visibleState } from './plan/shared.js';

/** One opponent's true figures on the board a turn was played on. */
export interface OpponentTruth {
  player: number;
  /** `boardIncome`: base (or per-territory) + full bonuses, cards and the army cap aside. */
  income: number;
  /** `null` when the history hid any of its armies. */
  armies: number | null;
  /**
   * #437: its territories in view whose count did not read: `armies` leaves them out, so it is a lower bound
   * then. Absent when every count read (a commander's territory reads since 2026-11-20: `commanders`).
   */
  armiesUnread?: number;
  /** #437: its own commanders on its land (each fights as 7; not in `armies`, the plain armies); absent when none. */
  commanders?: number;
  territories: number;
  bonuses: number[];
  /** Its true start-of-turn armies on each territory my logged board showed fogged or owner-only: `[territory, armies]`. */
  hidden: [number, number][];
}

/** The truth for one turn: the history board it was played on, read whole. */
export interface TurnTruth {
  /** The history board read (completed turns): the turn − 1. */
  board: number;
  /** `armiesUnread` as {@link OpponentTruth}'s: `armies` is a lower bound when present. */
  mine: { income: number; armies: number | null; territories: number; armiesUnread?: number; commanders?: number };
  opponents: OpponentTruth[];
}

/** One estimate the turn logged against the opponent's true income. */
export interface EstimateAccuracy {
  player: number;
  estimate: number;
  truth: number;
  /** estimate ÷ truth; `null` when the truth is 0 (the opponent out). */
  ratio: number | null;
  source: string | null;
  coverage: number | null;
  thin: boolean;
}

/** What a logged turn got right and wrong. */
export interface TurnAccuracy {
  estimates: EstimateAccuracy[];
  /** My outlook state as logged against the state the true figures give (`gameOutlook` on the history boards). */
  outlook: { logged: OutlookReading | null; truth: OutlookReading | null; right: boolean | null };
  /** The income the "stack ≥ my income" test reads: the one logged, else my true income. */
  myIncome: number;
  /** Territories my logged board hid that held an enemy stack ≥ that income; `null` with no board logged. */
  hiddenStacks: number | null;
}

/** Estimate ÷ truth over many samples. */
export interface RatioView {
  n: number;
  mean: number;
  geoMean: number;
  /** Shares of samples under {@link CALIBRATION_LOW} and over {@link CALIBRATION_HIGH}. */
  under: number;
  over: number;
}

export interface AccuracySummary {
  estimates: RatioView | null;
  byCoverage: Partial<Record<CoverageBucket, RatioView>>;
  bySource: Record<string, RatioView>;
  outlook: { right: number; wrong: number };
  /** Turns with a truth block, and how many of them hid an enemy stack ≥ my income. */
  turns: number;
  turnsWithHiddenStacks: number;
}

/** What a logged entry offers the scoring: only what it logged. */
export interface LoggedTurn {
  board?: BoardState;
  /** #454: the finer reading logged (the income lean beside an even state, else the state). */
  outlook: OutlookReading | null;
  estimates: readonly { player: number; estimate: number; source?: string; coverage: number | null; thin: boolean }[];
  /** My income as logged that turn (card armies out), when known. */
  myIncome: number | null;
}

export interface TruthInput {
  graph: MapGraph;
  me: number;
  /** The players scored: my opponents. */
  opponents: readonly number[];
  /** The FULL history the end-of-game pass read (before the finished record's head/tail cut). */
  history: readonly { turn: number; board: BoardState }[];
  /** Completed turns at the end; absent: the newest history board's. */
  numberOfTurns?: number;
  incomeSettings: Pick<GameSettings, 'minimumArmyBonus' | 'bonusArmyPer'> | undefined;
  plannerSettings?: PlannerSettings;
  /** The game around the boards (every seat as still playing), for the outlook. */
  game?: TrackGame;
  /** The logged turns, by turn played. */
  logged: ReadonlyMap<number, LoggedTurn>;
}

export interface TruthResult {
  truth: Map<number, TurnTruth>;
  accuracy: Map<number, TurnAccuracy>;
  summary: AccuracySummary;
  /** Turns of the game (or logged) whose board the history lacks, ascending. */
  missing: number[];
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;
const ownerOf = (t: { owner: BoardState['territories'][number]['owner'] }) => (t.owner.kind === 'player' ? t.owner.playerId : undefined);

/** The ratio view of estimate ÷ truth samples (truth > 0); `null` with none. */
export function ratioView(ratios: readonly number[]): RatioView | null {
  if (!ratios.length) return null;
  const n = ratios.length;
  return {
    n,
    mean: round(ratios.reduce((s, r) => s + r, 0) / n),
    geoMean: round(Math.exp(ratios.reduce((s, r) => s + Math.log(Math.max(r, 1e-6)), 0) / n)),
    under: round(ratios.filter((r) => r < CALIBRATION_LOW).length / n),
    over: round(ratios.filter((r) => r > CALIBRATION_HIGH).length / n),
  };
}

/** The outlook the true figures give on turn T: `gameOutlook` over the history boards up to T − 1, each as the turn played on it. */
function trueOutlook(input: TruthInput, byBoard: ReadonlyMap<number, BoardState>, turn: number): OutlookReading | null {
  const boards: { turn: number; board: BoardState }[] = [];
  // The outlook reads the latest run of consecutive turns; a few more boards than that give the tracker its window.
  for (let b = turn - 1; b >= 0 && boards.length < OUTLOOK_TURNS + 3; b--) {
    const board = byBoard.get(b);
    if (!board) break;
    boards.unshift({ turn: b + 1, board });
  }
  if (!boards.length) return null;
  try {
    // #454: the finer reading, as the decision log keeps it.
    return readingOf(
      gameOutlook({
        graph: input.graph,
        me: input.me,
        boards,
        ...(input.plannerSettings ? { settings: input.plannerSettings } : {}),
        ...(input.game ? { game: input.game } : {}),
      }),
    );
  } catch {
    return null;
  }
}

/**
 * Every turn's truth (turns 1 … the game's last, and any logged turn), every logged turn's accuracy, and
 * the game's summary. A turn whose history board the history lacks is `missing`. Pure.
 */
export function decisionTruth(input: TruthInput): TruthResult {
  const byBoard = new Map(input.history.map((b) => [b.turn, b.board]));
  const last = input.numberOfTurns ?? Math.max(0, ...input.history.map((b) => b.turn));
  const turns = new Set<number>();
  for (let t = 1; t <= last; t++) turns.add(t);
  for (const t of input.logged.keys()) if (t >= 1) turns.add(t);
  const players = [...new Set(input.opponents)].filter((p) => p !== input.me).sort((a, b) => a - b);
  const truth = new Map<number, TurnTruth>();
  const accuracy = new Map<number, TurnAccuracy>();
  const missing: number[] = [];
  const samples: (CalibrationSample & { source: string | null })[] = [];
  const outlook = { right: 0, wrong: 0 };
  let withHidden = 0;
  for (const turn of [...turns].sort((a, b) => a - b)) {
    const real = byBoard.get(turn - 1);
    if (!real) {
      missing.push(turn);
      continue;
    }
    const logged = input.logged.get(turn);
    const seen = new Map((logged?.board?.territories ?? []).map((t) => [t.territoryId, t]));
    const hiddenOnMine = (id: number) => !!logged?.board && !visibleState(seen.get(id));
    const incomes = turnIncomes(input.graph, real, [input.me, ...players], input.incomeSettings);
    const mine = incomes.get(input.me)!;
    const opponents: OpponentTruth[] = players.map((p) => {
      const x = incomes.get(p)!;
      const hidden = real.territories
        .filter((t) => ownerOf(t) === p && t.armies !== null && hiddenOnMine(t.territoryId))
        .map((t) => [t.territoryId, t.armies!] as [number, number])
        .sort((a, b) => a[0] - b[0]);
      return {
        player: p,
        income: x.income,
        armies: x.armies,
        ...(x.armiesUnread ? { armiesUnread: x.armiesUnread } : {}),
        ...(x.commanders ? { commanders: x.commanders } : {}),
        territories: x.territories,
        bonuses: x.bonuses,
        hidden,
      };
    });
    const myUnread = mine.armiesUnread ? { armiesUnread: mine.armiesUnread } : {};
    const myCommanders = mine.commanders ? { commanders: mine.commanders } : {};
    truth.set(turn, {
      board: turn - 1,
      mine: { income: mine.income, armies: mine.armies, territories: mine.territories, ...myUnread, ...myCommanders },
      opponents,
    });
    if (!logged) continue;
    const myIncome = logged.myIncome ?? mine.income;
    const hiddenStacks = logged.board ? opponents.reduce((s, o) => s + o.hidden.filter(([, a]) => a >= myIncome && a > 0).length, 0) : null;
    if (hiddenStacks) withHidden++;
    const estimates: EstimateAccuracy[] = [...logged.estimates]
      .filter((e) => players.includes(e.player))
      .sort((a, b) => a.player - b.player)
      .map((e) => {
        const t = opponents.find((o) => o.player === e.player)!.income;
        const ratio = t > 0 ? round(e.estimate / t) : null;
        if (ratio !== null) samples.push({ turn, opponent: e.player, estimate: e.estimate, truth: t, coverage: e.coverage, source: e.source ?? null });
        return { player: e.player, estimate: e.estimate, truth: t, ratio, source: e.source ?? null, coverage: e.coverage, thin: e.thin };
      });
    const trueState = logged.outlook !== null ? trueOutlook(input, byBoard, turn) : null;
    const right = logged.outlook !== null && trueState !== null ? logged.outlook === trueState : null;
    if (right === true) outlook.right++;
    if (right === false) outlook.wrong++;
    accuracy.set(turn, { estimates, outlook: { logged: logged.outlook, truth: trueState, right }, myIncome, hiddenStacks });
  }
  const ratios = (xs: typeof samples) => xs.map((s) => s.estimate / s.truth);
  const byCoverage: AccuracySummary['byCoverage'] = {};
  for (const b of COVERAGE_BUCKETS) {
    const v = ratioView(ratios(samples.filter((s) => coverageBucket(s.coverage) === b)));
    if (v) byCoverage[b] = v;
  }
  const bySource: Record<string, RatioView> = {};
  for (const src of [...new Set(samples.map((s) => s.source ?? 'unknown'))].sort()) {
    bySource[src] = ratioView(ratios(samples.filter((s) => (s.source ?? 'unknown') === src)))!;
  }
  return {
    truth,
    accuracy,
    summary: { estimates: ratioView(ratios(samples)), byCoverage, bySource, outlook, turns: truth.size, turnsWithHiddenStacks: withHidden },
    missing,
  };
}

/** Whether a turn's accuracy shows an estimate off by more than 1.5× or under 0.5× (#412 compaction's rule). */
export function estimateOff(a: TurnAccuracy | undefined): boolean {
  return !!a?.estimates.some((e) => e.ratio !== null && (e.ratio > CALIBRATION_HIGH || e.ratio < CALIBRATION_LOW));
}
