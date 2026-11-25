// The income estimates scored against the truth from the decision logs (#569, for #568), pure: what
// warapp_calibration reports. Every finished game whose decision log carries the end-of-game truth (#412
// task 3: `truth` and `accuracy` per turn) gives one sample per logged estimate — the figure the plan worked
// from that turn (`decision.estimates`) beside the opponent's true income on the board the turn was played
// on (`accuracy.estimates`, the calibration's own alignment) — with its context: format and seats, phase,
// frontier coverage band (#294), the estimate's source, thin evidence (#368), the tracker's income method
// (#418's rise cap; logged since #569, absent before) and whether the opponent led the others on income.
//
// Reported only: nothing plans on it (owner decision P1). Name-free: games are numbered by their place in
// the report (an ordinal, never the id), opponents are never named or numbered. No I/O, no clock.
import type { DecisionEntry, EstimateStages } from '../decision-log.js';
import { CALIBRATION_HIGH, CALIBRATION_LOW, COVERAGE_BUCKETS, coverageBucket, type CoverageBucket } from './game-lessons.js';

/** A true income jump at least this many times the turn before starts a catch-up count. */
export const JUMP_FACTOR = 1.5;
/** The estimate has caught up once it reaches this share of the truth. */
export const CATCH_UP_SHARE = 2 / 3;
/** The largest misses listed. */
export const WORST_LISTED = 10;
/** The phases a turn falls in. */
export const PHASES = ['turns-1-4', 'turns-5-10', 'turns-11-up'] as const;
export type Phase = (typeof PHASES)[number];
/** Seat-count bands. */
export const SEAT_BANDS = ['2', '3-6', '7-16', '17-up'] as const;
export type SeatBand = (typeof SEAT_BANDS)[number];

export function phaseOf(turn: number): Phase {
  return turn <= 4 ? 'turns-1-4' : turn <= 10 ? 'turns-5-10' : 'turns-11-up';
}

export function seatBand(seats: number | null): SeatBand | 'unknown' {
  if (seats === null || seats < 2) return 'unknown';
  return seats === 2 ? '2' : seats <= 6 ? '3-6' : seats <= 16 ? '7-16' : '17-up';
}

/** One finished game as the scoring reads it. */
export interface CalibrationGame {
  /** `1v1`, `ffa`, `team`, or `unknown` when nothing kept says. */
  format: string;
  /** Seats in the game (`null`: unknown). */
  seats: number | null;
  /** The decision log's turns. */
  turns: Readonly<Record<string, Pick<DecisionEntry, 'decision' | 'accuracy' | 'truth' | 'next'>>>;
}

/** One logged estimate beside the truth. */
export interface IncomeSample {
  /** The game's place in this report (1-based): never its id. */
  game: number;
  turn: number;
  format: string;
  seats: number | null;
  phase: Phase;
  estimate: number;
  truth: number;
  /** estimate ÷ truth. */
  ratio: number;
  /** estimate − truth, in armies. */
  error: number;
  source: string;
  coverage: number | null;
  band: CoverageBucket;
  thin: boolean;
  /** The tracker's income method that turn (`rise-capped` when #418's cap held it); `null` when not logged. */
  method: string | null;
  /** The opponent had the highest true income of my opponents that turn. */
  leader: boolean;
  /** #568: each pipeline stage's figure that turn (logged since #568); `null` before. */
  stages: EstimateStages | null;
}

/** Estimate ÷ truth over a set of samples, with the signed error in armies. */
export interface ErrorView {
  n: number;
  mean: number;
  median: number;
  geoMean: number;
  /** Shares under {@link CALIBRATION_LOW} and over {@link CALIBRATION_HIGH}. */
  under: number;
  over: number;
  /** Mean of estimate − truth, in armies (negative: read low). */
  meanError: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function errorView(samples: readonly Pick<IncomeSample, 'ratio' | 'error'>[]): ErrorView | null {
  const n = samples.length;
  if (!n) return null;
  const ratios = samples.map((s) => s.ratio).sort((a, b) => a - b);
  const mid = n >> 1;
  const median = n % 2 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
  return {
    n,
    mean: r3(ratios.reduce((s, r) => s + r, 0) / n),
    median: r3(median),
    geoMean: r3(Math.exp(ratios.reduce((s, r) => s + Math.log(Math.max(r, 1e-6)), 0) / n)),
    under: r3(ratios.filter((r) => r < CALIBRATION_LOW).length / n),
    over: r3(ratios.filter((r) => r > CALIBRATION_HIGH).length / n),
    meanError: r3(samples.reduce((s, x) => s + x.error, 0) / n),
  };
}

const turnKeys = (turns: CalibrationGame['turns']) =>
  Object.keys(turns)
    .filter((k) => /^\d+$/.test(k))
    .map(Number)
    .sort((a, b) => a - b);

/** Every scored estimate of every game, in game then turn then opponent order. Pure. */
export function incomeSamples(games: readonly CalibrationGame[]): IncomeSample[] {
  const out: IncomeSample[] = [];
  games.forEach((g, i) => {
    for (const turn of turnKeys(g.turns)) {
      const e = g.turns[String(turn)]!;
      const acc = e.accuracy?.estimates;
      if (!acc?.length) continue;
      const truths = e.truth?.opponents ?? [];
      const top = truths.length ? Math.max(...truths.map((o) => o.income)) : null;
      const logged = new Map((e.decision?.estimates ?? []).map((x) => [x.player, x]));
      for (const a of [...acc].sort((x, y) => x.player - y.player)) {
        if (a.truth <= 0) continue;
        const ratio = a.estimate / a.truth;
        out.push({
          game: i + 1,
          turn,
          format: g.format,
          seats: g.seats,
          phase: phaseOf(turn),
          estimate: a.estimate,
          truth: a.truth,
          ratio: r3(ratio),
          error: a.estimate - a.truth,
          source: a.source ?? 'unknown',
          coverage: a.coverage,
          band: coverageBucket(a.coverage),
          thin: a.thin,
          method: logged.get(a.player)?.method ?? null,
          leader: top !== null && a.truth >= top,
          stages: logged.get(a.player)?.stages ?? null,
        });
      }
    }
  });
  return out;
}

/** The catch-up after true income jumps: how many turns until the estimate reached {@link CATCH_UP_SHARE} of the truth. */
export interface CatchUp {
  /** Jumps seen on a turn whose estimate was logged at or after it. */
  jumps: number;
  /** Jumps the estimate caught within the logged turns, and the turns that took (0: the jump turn itself). */
  caught: number;
  meanLag: number | null;
  medianLag: number | null;
  /** Lags by turns: `{ "0": n, "1": n, … }`. */
  lags: Record<string, number>;
  /** Jumps never caught before the logged turns ended. */
  censored: number;
}

/**
 * Per game and opponent, a turn whose true income is at least {@link JUMP_FACTOR} × the turn before (both
 * read, the earlier above 0) is a jump; its lag is the turns from it to the first logged estimate of that
 * opponent at or after it that reaches {@link CATCH_UP_SHARE} of that turn's truth. Pure.
 */
export function catchUp(games: readonly CalibrationGame[]): CatchUp {
  const lagsList: number[] = [];
  let censored = 0;
  for (const g of games) {
    const turns = turnKeys(g.turns);
    const truth = new Map<number, Map<number, number>>(); // player → turn → income
    const est = new Map<number, Map<number, number>>(); // player → turn → estimate
    for (const t of turns) {
      const e = g.turns[String(t)]!;
      for (const o of e.truth?.opponents ?? []) (truth.get(o.player) ?? truth.set(o.player, new Map()).get(o.player)!).set(t, o.income);
      for (const a of e.accuracy?.estimates ?? []) (est.get(a.player) ?? est.set(a.player, new Map()).get(a.player)!).set(t, a.estimate);
    }
    for (const [player, series] of [...truth].sort((a, b) => a[0] - b[0])) {
      const estimates = est.get(player);
      if (!estimates?.size) continue;
      const last = Math.max(...estimates.keys());
      for (const [t, income] of [...series].sort((a, b) => a[0] - b[0])) {
        const before = series.get(t - 1);
        if (before === undefined || before <= 0 || income < JUMP_FACTOR * before || t > last) continue;
        let lag: number | null = null;
        for (const u of [...estimates.keys()].filter((u) => u >= t).sort((a, b) => a - b)) {
          const truthU = series.get(u) ?? income;
          if (estimates.get(u)! >= CATCH_UP_SHARE * truthU) {
            lag = u - t;
            break;
          }
        }
        if (lag === null) censored++;
        else lagsList.push(lag);
      }
    }
  }
  const sorted = [...lagsList].sort((a, b) => a - b);
  const n = sorted.length;
  const lags: Record<string, number> = {};
  for (const l of sorted) lags[String(l)] = (lags[String(l)] ?? 0) + 1;
  return {
    jumps: n + censored,
    caught: n,
    meanLag: n ? r3(sorted.reduce((s, x) => s + x, 0) / n) : null,
    medianLag: n ? (n % 2 ? sorted[n >> 1]! : (sorted[(n >> 1) - 1]! + sorted[n >> 1]!) / 2) : null,
    lags,
    censored,
  };
}

/**
 * A proxy for what a wrong estimate cost: logged turns with the outcome kept (`next`), split by whether any
 * estimate read under {@link CALIBRATION_LOW} of the truth, and how many of each lost a territory the plan
 * did not concede. Not a cause: a loss has many.
 */
export interface Consequences {
  turns: number;
  underTurns: number;
  underWithLoss: number;
  otherTurns: number;
  otherWithLoss: number;
}

export function consequences(games: readonly CalibrationGame[]): Consequences {
  const c: Consequences = { turns: 0, underTurns: 0, underWithLoss: 0, otherTurns: 0, otherWithLoss: 0 };
  for (const g of games)
    for (const t of turnKeys(g.turns)) {
      const e = g.turns[String(t)]!;
      const acc = e.accuracy?.estimates;
      if (!acc?.length || !e.next || !e.decision) continue;
      const conceded = new Set(e.decision.conceded ?? []);
      const loss = e.next.lost.some((id) => !conceded.has(id));
      const under = acc.some((a) => a.ratio !== null && a.ratio < CALIBRATION_LOW);
      c.turns++;
      if (under) {
        c.underTurns++;
        if (loss) c.underWithLoss++;
      } else {
        c.otherTurns++;
        if (loss) c.otherWithLoss++;
      }
    }
  return c;
}

/** #568: the stages scored, in pipeline order (`card` is armies on top of an income, not scored alone). */
export const STAGES = ['visible', 'observed', 'tracked', 'prior', 'stated', 'blend', 'thin', 'known'] as const;
export type Stage = (typeof STAGES)[number];

/**
 * #568: each stage's figure ÷ the truth, over the samples that logged it and where the stage applied (a figure
 * above 0; the truth is the income, card armies apart, so the card is left out). Pure.
 */
export function stageErrors(samples: readonly IncomeSample[]): Partial<Record<Stage, ErrorView>> {
  const out: Partial<Record<Stage, ErrorView>> = {};
  for (const stage of STAGES) {
    const rows = samples.flatMap((s) => {
      const v = s.stages?.[stage];
      return typeof v === 'number' && v > 0 ? [{ ratio: r3(v / s.truth), error: v - s.truth }] : [];
    });
    const view = errorView(rows);
    if (view) out[stage] = view;
  }
  return out;
}

/** #568: the dampings the what-if tries (0: no correction; 1: the full band factor). */
export const WHAT_IF_DAMPINGS = [0, 0.25, 0.5, 0.75, 1] as const;
/** #568: a band's factor counts only from this many samples of the other games. */
export const WHAT_IF_MIN_SAMPLES = 5;

/** #568: the tracked stage corrected by its band at one damping, against the truth. */
export interface WhatIfRow {
  damping: number;
  /** The corrected tracked figures ÷ truth (every sample with a tracked stage). */
  error: ErrorView | null;
  /** Samples a band factor raised. */
  raised: number;
  /** The same by coverage band (does the correction help in the 50–75% band too?). */
  byBand: Partial<Record<CoverageBucket, ErrorView>>;
}

/**
 * #568: what dividing the tracked figure by its coverage band's geometric mean of tracked ÷ truth, to each
 * damping in {@link WHAT_IF_DAMPINGS}, would have read. Leave one game out: a game's samples are corrected by
 * the bands of the other games only (at least {@link WHAT_IF_MIN_SAMPLES} samples, a band under 1×), so a game
 * never calibrates itself. Only ever raises, as the draft rule does. The tracked stage alone, not the whole
 * pipeline (the prior, its blend and thin evidence would move with it). Pure.
 */
export function trackedWhatIf(samples: readonly IncomeSample[]): WhatIfRow[] {
  const rows = samples.flatMap((s) => (typeof s.stages?.tracked === 'number' && s.stages.tracked > 0 ? [{ s, tracked: s.stages.tracked }] : []));
  const sums = new Map<string, { n: number; log: number }>();
  const key = (game: number, band: CoverageBucket) => `${game}|${band}`;
  for (const { s, tracked } of rows) {
    const k = key(s.game, s.band);
    const v = sums.get(k) ?? { n: 0, log: 0 };
    v.n++;
    v.log += Math.log(tracked / s.truth);
    sums.set(k, v);
  }
  const bandTotals = new Map<CoverageBucket, { n: number; log: number }>();
  for (const [k, v] of sums) {
    const band = k.slice(k.indexOf('|') + 1) as CoverageBucket;
    const t = bandTotals.get(band) ?? { n: 0, log: 0 };
    bandTotals.set(band, { n: t.n + v.n, log: t.log + v.log });
  }
  const factorFor = (game: number, band: CoverageBucket): number | undefined => {
    const all = bandTotals.get(band);
    const own = sums.get(key(game, band)) ?? { n: 0, log: 0 };
    const n = (all?.n ?? 0) - own.n;
    if (n < WHAT_IF_MIN_SAMPLES) return undefined;
    const g = Math.exp(((all?.log ?? 0) - own.log) / n);
    return g < 1 ? g : undefined;
  };
  return WHAT_IF_DAMPINGS.map((damping) => {
    let raised = 0;
    const scored = rows.map(({ s, tracked }) => {
      const g = factorFor(s.game, s.band);
      const v = g === undefined ? tracked : Math.max(tracked, Math.round(tracked / g ** damping));
      if (v > tracked) raised++;
      return { band: s.band, ratio: r3(v / s.truth), error: v - s.truth };
    });
    const byBand: Partial<Record<CoverageBucket, ErrorView>> = {};
    for (const band of COVERAGE_BUCKETS) {
      const view = errorView(scored.filter((x) => x.band === band));
      if (view) byBand[band] = view;
    }
    return { damping, error: errorView(scored), raised, byBand };
  });
}

/** The whole report. */
export interface IncomeCalibration {
  games: number;
  samples: number;
  all: ErrorView | null;
  byFormat: Record<string, ErrorView>;
  bySeats: Record<string, ErrorView>;
  byPhase: Partial<Record<Phase, ErrorView>>;
  byCoverage: Partial<Record<CoverageBucket, ErrorView>>;
  bySource: Record<string, ErrorView>;
  byThin: { thin?: ErrorView; solid?: ErrorView };
  /** By the tracker's income method; `unlogged` for estimates logged before #569 kept it. */
  byMethod: Record<string, ErrorView>;
  byLeader: { leader?: ErrorView; trailer?: ErrorView };
  /** Coverage band within each phase. */
  byPhaseAndCoverage: Partial<Record<Phase, Partial<Record<CoverageBucket, ErrorView>>>>;
  catchUp: CatchUp;
  consequences: Consequences;
  /** The {@link WORST_LISTED} largest misses either way (by |ln ratio|). */
  worst: IncomeSample[];
  /** #568: each pipeline stage's figure ÷ truth, over the estimates that logged their stages. */
  byStage: Partial<Record<Stage, ErrorView>>;
  /** #568: the tracked stage corrected by its coverage band, per damping (leave one game out). */
  trackedWhatIf: WhatIfRow[];
}

function groupBy<K extends string>(samples: readonly IncomeSample[], key: (s: IncomeSample) => K, order?: readonly K[]): Partial<Record<K, ErrorView>> {
  const groups = new Map<K, IncomeSample[]>();
  for (const s of samples) {
    const k = key(s);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
  }
  const keys = order ? order.filter((k) => groups.has(k)) : [...groups.keys()].sort();
  const out: Partial<Record<K, ErrorView>> = {};
  for (const k of keys) out[k] = errorView(groups.get(k)!)!;
  return out;
}

/** The report over `games` (each finished game's log, in a stable order). Pure. */
export function incomeCalibration(games: readonly CalibrationGame[]): IncomeCalibration {
  const samples = incomeSamples(games);
  const byPhaseAndCoverage: IncomeCalibration['byPhaseAndCoverage'] = {};
  for (const p of PHASES) {
    const of = samples.filter((s) => s.phase === p);
    if (of.length) byPhaseAndCoverage[p] = groupBy(of, (s) => s.band, COVERAGE_BUCKETS);
  }
  const worst = [...samples]
    .sort((a, b) => Math.abs(Math.log(Math.max(b.ratio, 1e-6))) - Math.abs(Math.log(Math.max(a.ratio, 1e-6))) || a.game - b.game || a.turn - b.turn)
    .slice(0, WORST_LISTED);
  return {
    games: games.filter((g) => turnKeys(g.turns).some((t) => g.turns[String(t)]!.accuracy?.estimates.length)).length,
    samples: samples.length,
    all: errorView(samples),
    byFormat: groupBy(samples, (s) => s.format) as Record<string, ErrorView>,
    bySeats: groupBy(samples, (s) => seatBand(s.seats), [...SEAT_BANDS, 'unknown'] as const) as Record<string, ErrorView>,
    byPhase: groupBy(samples, (s) => s.phase, PHASES),
    byCoverage: groupBy(samples, (s) => s.band, COVERAGE_BUCKETS),
    bySource: groupBy(samples, (s) => s.source) as Record<string, ErrorView>,
    byThin: groupBy(samples, (s) => (s.thin ? 'thin' : 'solid')),
    byMethod: groupBy(samples, (s) => s.method ?? 'unlogged') as Record<string, ErrorView>,
    byLeader: groupBy(samples, (s) => (s.leader ? 'leader' : 'trailer')),
    byPhaseAndCoverage,
    catchUp: catchUp(games),
    consequences: consequences(games),
    worst,
    byStage: stageErrors(samples),
    trackedWhatIf: trackedWhatIf(samples),
  };
}
