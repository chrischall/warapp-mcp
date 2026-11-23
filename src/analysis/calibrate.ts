// The calibration and opening benchmark harness (#318), pure: what `scripts/calibrate.mjs` runs over
// the data directory's finished histories, cached boards and settings. A dev measurement, never a
// tool, never run in CI, and no planner decision reads it (owner decision P1: it informs only).
//
// (a) Calibration: on each turn I cached a board for, the three figures the plan has for each opponent
// — the tracker's income (`calibrationSamples`, #312 E2), the fog prior (#119, before #235's blend) and
// the plan's estimate (`planEnemyEstimates`, the figure every border is sized for) — beside its true
// income on the history board that turn was played on (`turnIncomes`), by the track's frontier
// coverage (#294). Aggregated as ratios (estimate ÷ truth) only: no turn, no player.
//
// (b) Opening benchmark: my real start (history board 0) replayed for the first turns on today's
// planner, my orders resolved with the turn simulator, and after each turn the opponents put back
// where the history shows them. APPROXIMATED, and said wherever it is reported: the planner sees the
// whole board (no fog); the opponents never attack me (no interaction): they hold the land and armies
// the history gives them, except land I hold in the replay; a territory I really took but did not take
// in the replay keeps its replayed state; card plays are left out; with luck or weighted rounding each
// battle is resolved at its expectation (`exact: false`).
//
// #503: the benchmarks are split by era (`openingEra`: before this server planned, before rule 4f, current),
// medians are reported beside means with the games each figure rests on, and a game whose opening window
// has a turn with no orders of mine or a boot of my seat (`openingFlags`) is reported apart, not averaged in.
//
// No I/O, no clock; ids ascending.
import type { BoardState, TerritoryState } from '../board.js';
import type { GameSettings } from '../normalize.js';
import { symmetricStart, trackOpponents, unevenStart } from './opponents.js';
import { turnIncomes } from './finished-game.js';
import {
  aggregateCalibration,
  calibrationSamples,
  CALIBRATION_HIGH,
  CALIBRATION_LOW,
  type Calibration,
  type CalibrationInput,
  type RatioStats,
} from './game-lessons.js';
import type { MapGraph } from './graph.js';
import { planTurn } from './planner.js';
import { planEnemyEstimates } from './plan/estimates.js';
import type { FogPace, PlannerSettings, PlanInput, TurnPlan } from './plan/shared.js';
import { boardIncome, incomeRules } from './player.js';
import type { ProfilePlayer } from './profile.js';
import { simulateTurn, type SimSettings, type SimTerritory } from './turn-sim.js';

type HistoryBoards = readonly { turn: number; board: BoardState }[];

const landOf = (b: BoardState, p: number): Set<number> =>
  new Set(b.territories.flatMap((t) => (t.owner.kind === 'player' && t.owner.playerId === p ? [t.territoryId] : [])));

// ---- (a) calibration ----

/** The figures scored. */
export const ESTIMATORS = ['tracker', 'prior', 'plan'] as const;
export type Estimator = (typeof ESTIMATORS)[number];

/** One opponent on one turn I cached: each figure the plan had beside the truth. */
export interface EstimateSample {
  turn: number;
  opponent: number;
  /** Its income on the history board the turn was played on. */
  truth: number;
  /** The track's frontier coverage share (#294); `null` when none was measured. */
  coverage: number | null;
  /** `trackOpponents`' income (2+ cached boards up to the turn); `null` without one. */
  tracker: number | null;
  /** The fog prior (#119) before #235's blend; `null` when the game gets none or it does not border the fog. */
  prior: number | null;
  /** The plan's estimate (`EnemyDeployEstimate.estimate`); `null` when it is not in view. */
  plan: number | null;
}

/** What {@link estimateSamples} reads: E2's calibration input, plus the settings and seats the plan context needs. */
export interface EstimateInput extends CalibrationInput {
  settings: GameSettings | undefined;
  /** Every seat (its final state left out: who is out on a turn is read off the history board). */
  players: readonly ProfilePlayer[];
  /** #419: the past winners' pace for the turn planned (the map record's, as warapp_plan_turn reads it); none: no pace. */
  mapPace?: (turn: number) => FogPace | undefined;
}

/**
 * For each turn T I cached a board for whose history board T − 1 the history has, every opponent with
 * land on that board: the tracker (E2's `calibrationSamples`), the fog prior and the plan's estimate
 * (`planEnemyEstimates` as warapp_plan_turn calls it: my income on my board, the previous cached board
 * and my orders on it, the tracks, the seats with a player holding no land on the truth board read as
 * out). A turn on which none of the three has a figure is left out. Pure.
 */
export function estimateSamples(input: EstimateInput): EstimateSample[] {
  const tracker = new Map(calibrationSamples(input).map((s) => [`${s.turn}:${s.opponent}`, s]));
  const truthBoard = new Map(input.history.map((b) => [b.turn, b.board]));
  const cached = [...input.cached].sort((a, b) => a.turn - b.turn);
  const rules = incomeRules(input.incomeSettings);
  const out: EstimateSample[] = [];
  for (const cur of cached) {
    const truth = truthBoard.get(cur.turn - 1);
    if (!truth) continue;
    const upTo = cached.filter((b) => b.turn <= cur.turn);
    const tracks = upTo.length >= 2 ? trackOpponents(input.graph, upTo, input.me, input.plannerSettings, input.game) : [];
    const previous = cached.find((b) => b.turn === cur.turn - 1);
    const real = turnIncomes(input.graph, truth, input.opponents, input.incomeSettings);
    const uneven = unevenStart(input.settings);
    const { estimates } = planEnemyEstimates({
      graph: input.graph,
      board: cur.board,
      me: input.me,
      income: boardIncome(input.graph, landOf(cur.board, input.me), rules).total,
      settings: input.plannerSettings,
      ...(previous ? { previousBoard: previous.board } : {}),
      ...(previous?.orders ? { previousOrders: previous.orders } : {}),
      tracks,
      game: {
        players: input.players.map((p) => ({ ...p, state: p.id === input.me || (real.get(p.id)?.territories ?? 1) > 0 ? 'Playing' : 'Eliminated' })),
        turn: cur.turn,
        symmetricStart: symmetricStart(input.settings),
        ...(uneven ? { unevenStart: uneven } : {}),
        ...(input.settings?.fog !== undefined ? { fog: input.settings.fog } : {}),
        ...(input.mapPace?.(cur.turn) ? { mapPace: input.mapPace(cur.turn)! } : {}),
      },
      turn: cur.turn,
    });
    for (const o of [...input.opponents].sort((a, b) => a - b)) {
      const t = real.get(o);
      if (!t || t.income <= 0) continue;
      const tr = tracker.get(`${cur.turn}:${o}`);
      const e = estimates.find((x) => x.playerId === o);
      const coverage = tr?.coverage ?? tracks.find((x) => x.playerId === o)?.coverage?.share ?? null;
      const sample: EstimateSample = {
        turn: cur.turn,
        opponent: o,
        truth: t.income,
        coverage,
        tracker: tr?.estimate ?? null,
        prior: e?.prior ?? null,
        plan: e?.estimate ?? null,
      };
      if (sample.tracker !== null || sample.prior !== null || sample.plan !== null) out.push(sample);
    }
  }
  return out;
}

/** Each estimator's samples counted by coverage band (E2's `aggregateCalibration`): ratios only. Pure. */
export function aggregateEstimates(samples: readonly EstimateSample[]): Partial<Record<Estimator, Calibration>> {
  const out: Partial<Record<Estimator, Calibration>> = {};
  for (const k of ESTIMATORS) {
    const of = samples.flatMap((s) => (s[k] === null ? [] : [{ turn: s.turn, opponent: s.opponent, estimate: s[k]!, truth: s.truth, coverage: s.coverage }]));
    if (of.length) out[k] = aggregateCalibration(of);
  }
  return out;
}

/** A ratio's counts read out: the mean, the geometric mean, the spread, and the shares under {@link CALIBRATION_LOW} and over {@link CALIBRATION_HIGH}. */
export interface RatioSummary {
  n: number;
  mean: number;
  geoMean: number;
  sd: number;
  under: number;
  over: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** {@link RatioStats} read out; `null` without samples. Pure. */
export function ratioSummary(s: RatioStats | undefined): RatioSummary | null {
  if (!s || s.n <= 0) return null;
  const mean = s.sum / s.n;
  return {
    n: s.n,
    mean: r3(mean),
    geoMean: r3(Math.exp(s.logSum / s.n)),
    sd: r3(Math.sqrt(Math.max(0, s.sq / s.n - mean * mean))),
    under: r3(s.under / s.n),
    over: r3(s.over / s.n),
  };
}

// ---- (b) the opening benchmark ----

/** The turns the opening benchmark replays. */
export const BENCHMARK_TURNS = 8;
/** "Land without bonuses" (#318 finding 2): this many territories or more on at most {@link LAND_POOR_INCOME}, after {@link GAP_TURN}. */
export const LAND_POOR_TERRITORIES = 11;
export const LAND_POOR_INCOME = 8;
/** The board the opening is judged on, and the gap that lost it (#318 finding 1: an opponent at 1.5× my income). */
export const GAP_TURN = 4;
export const GAP_FACTOR = 1.5;

export interface BenchmarkInput {
  graph: MapGraph;
  me: number;
  /** The history boards (by completed turns): board 0 is the start. */
  history: HistoryBoards;
  plannerSettings: PlannerSettings;
  incomeSettings: Pick<GameSettings, 'minimumArmyBonus' | 'bonusArmyPer'> | undefined;
  /** Every seat, final state left out. */
  players: readonly ProfilePlayer[];
  winners: readonly number[];
  /** Default {@link BENCHMARK_TURNS}. */
  turns?: number;
  /** The planner (default `planTurn`): tests give a fixed one. */
  plan?: (input: PlanInput) => Pick<TurnPlan, 'deploys' | 'moves'>;
}

export interface BenchmarkTurn {
  /** Completed turns: the board after this turn. */
  afterTurn: number;
  replay: { income: number; territories: number };
  /** On the history board; `null` when I hold nothing there. */
  real: { income: number; territories: number } | null;
  /** The best winner's income on the history board; `null` without a winner. */
  winner: number | null;
  /** The best opponent's income on the history board. */
  bestOpponent: number;
}

export interface Benchmark {
  turns: BenchmarkTurn[];
  /** `false` when a battle was resolved at its expectation (luck or weighted rounding). */
  exact: boolean;
  /** Why fewer turns than asked: no start of mine on board 0, or the history ran out. */
  stopped?: 'no-start' | 'history-ends';
}

const simSettingsOf = (s: PlannerSettings): SimSettings => ({
  ...(s.offensiveKillRate !== undefined ? { offensiveKillRate: s.offensiveKillRate } : {}),
  ...(s.defensiveKillRate !== undefined ? { defensiveKillRate: s.defensiveKillRate } : {}),
  ...(s.luckModifier !== undefined ? { luckModifier: s.luckModifier } : {}),
  ...(s.roundingMode !== undefined ? { roundingMode: s.roundingMode } : {}),
  ...(s.oneArmyStandsGuard !== undefined ? { oneArmyStandsGuard: s.oneArmyStandsGuard } : {}),
  ...(s.multiAttack !== undefined ? { multiAttack: s.multiAttack } : {}),
});

const territory = (territoryId: number, owner: SimTerritory['owner'], armies: number): TerritoryState => ({
  territoryId,
  owner: typeof owner === 'number' ? { kind: 'player', playerId: owner } : owner === 'neutral' ? { kind: 'neutral' } : { kind: 'unknown' },
  armies: owner === 'unknown' ? null : armies,
});

/**
 * The next replayed board: land I hold after my replayed orders stays mine with its armies; any other
 * territory an opponent holds on the history board is the history's (owner and armies); the rest keeps
 * its replayed state (a neutral my attack wore down, or one I really took but did not take here). Pure.
 */
export function overlayHistory(g: MapGraph, sim: ReadonlyMap<number, SimTerritory>, history: BoardState, me: number): BoardState {
  const real = new Map(history.territories.map((t) => [t.territoryId, t]));
  const territories: TerritoryState[] = [];
  for (const id of [...g.territoryById.keys()].sort((a, b) => a - b)) {
    const r = sim.get(id);
    const h = real.get(id);
    if (r?.owner === me) territories.push(territory(id, me, r.armies));
    else if (h && h.owner.kind === 'player' && h.owner.playerId !== me) territories.push({ territoryId: id, owner: h.owner, armies: h.armies });
    else if (r) territories.push(territory(id, r.owner, r.armies));
    else if (h) territories.push({ territoryId: id, owner: h.owner.kind === 'player' ? { kind: 'neutral' } : h.owner, armies: h.armies });
  }
  return { source: 'gamefeed', verified: false, territories };
}

/**
 * My opening replayed from my real start (see the header for what is approximated): each turn the
 * planner plans on the replayed board, the turn simulator resolves my deploys and moves alone, and the
 * opponents are put back where the history shows them ({@link overlayHistory}). After each turn, my
 * replayed income and territories beside the real ones, the winner's and the best opponent's. Pure.
 */
export function openingBenchmark(input: BenchmarkInput): Benchmark {
  const history = new Map(input.history.map((b) => [b.turn, b.board]));
  const start = history.get(0);
  if (!start || !landOf(start, input.me).size) return { turns: [], exact: true, stopped: 'no-start' };
  const plan = input.plan ?? planTurn;
  const rules = incomeRules(input.incomeSettings);
  const ids = [...new Set([...input.players.map((p) => p.id), input.me])].sort((a, b) => a - b);
  const teams = new Map(input.players.flatMap((p) => (typeof p.team === 'number' && p.team >= 0 ? [[p.id, p.team] as [number, number]] : [])));
  const sim = simSettingsOf(input.plannerSettings);
  const turns: BenchmarkTurn[] = [];
  let exact = true;
  let board = start;
  for (let n = 1; n <= (input.turns ?? BENCHMARK_TURNS); n++) {
    const next = history.get(n);
    if (!next) return { turns, exact, stopped: 'history-ends' };
    const income = boardIncome(input.graph, landOf(board, input.me), rules).total;
    const held = new Map(ids.map((p) => [p, landOf(board, p).size]));
    const p = plan({
      graph: input.graph,
      board,
      me: input.me,
      income,
      settings: input.plannerSettings,
      turn: n,
      game: {
        players: input.players.map((x) => ({ ...x, state: (held.get(x.id) ?? 0) > 0 ? 'Playing' : 'Eliminated' })),
        turn: n,
        fog: 'NoFog',
      },
    });
    const r = simulateTurn({
      graph: input.graph,
      board,
      deploys: p.deploys.map((d) => ({ player: input.me, territoryId: d.territoryId, armies: d.armies })),
      orders: [{ player: input.me, orders: p.moves.map((m) => ({ from: m.from, to: m.to, armies: m.armies })) }],
      moveOrder: [input.me],
      settings: sim,
      ...(teams.size ? { teams } : {}),
    });
    exact &&= r.exact;
    board = overlayHistory(input.graph, r.territories, next, input.me);
    const truth = turnIncomes(input.graph, next, ids, input.incomeSettings);
    const real = truth.get(input.me);
    const winners = input.winners.map((w) => truth.get(w)?.income ?? 0);
    const mineNow = landOf(board, input.me);
    turns.push({
      afterTurn: n,
      replay: { income: boardIncome(input.graph, mineNow, rules).total, territories: mineNow.size },
      real: real && real.territories > 0 ? { income: real.income, territories: real.territories } : null,
      winner: winners.length ? Math.max(...winners) : null,
      bestOpponent: Math.max(0, ...ids.filter((id) => id !== input.me).map((id) => truth.get(id)?.income ?? 0)),
    });
  }
  return { turns, exact };
}

/** The benchmarks of many games, aggregated (no game, no player). */
export interface BenchmarkAggregate {
  games: number;
  /** Games with a battle resolved at its expectation. */
  inexact: number;
  /** Per board after N turns: the mean incomes over the games that reached it, and how often the replay was ahead or behind the real game. */
  byTurn: {
    afterTurn: number;
    n: number;
    replay: number;
    real: number;
    winner: number | null;
    /** #503: the games with a winner, which `winner` rests on. */
    winners: number;
    /** #503: the medians beside the means (`winner` over the games with one). */
    median: { replay: number; real: number; winner: number | null };
    replayAhead: number;
    replayBehind: number;
  }[];
  /** Games with land without bonuses after {@link GAP_TURN}: replayed and real. */
  landWithoutBonuses: { replay: number; real: number };
  /** Games where an opponent had {@link GAP_FACTOR}× my income after {@link GAP_TURN}: replayed and real. */
  outpaced: { replay: number; real: number };
}

const mean = (xs: readonly number[]) => r3(xs.reduce((a, b) => a + b, 0) / xs.length);
const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return r3(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2);
};

/** Many {@link Benchmark}s aggregated. A turn where I held nothing in the real game counts the real income as 0. Pure. */
export function aggregateBenchmarks(results: readonly Benchmark[]): BenchmarkAggregate {
  const byTurn = new Map<number, BenchmarkTurn[]>();
  for (const r of results) for (const t of r.turns) byTurn.set(t.afterTurn, [...(byTurn.get(t.afterTurn) ?? []), t]);
  const poor = (x: { income: number; territories: number } | null) => x !== null && x.territories >= LAND_POOR_TERRITORIES && x.income <= LAND_POOR_INCOME;
  const behind = (mine: number, best: number) => best >= GAP_FACTOR * mine;
  const at = results.flatMap((r) => r.turns.filter((t) => t.afterTurn === GAP_TURN));
  return {
    games: results.length,
    inexact: results.filter((r) => !r.exact).length,
    byTurn: [...byTurn]
      .sort(([a], [b]) => a - b)
      .map(([afterTurn, ts]) => {
        const winners = ts.flatMap((t) => (t.winner === null ? [] : [t.winner]));
        const replay = ts.map((t) => t.replay.income);
        const real = ts.map((t) => t.real?.income ?? 0);
        return {
          afterTurn,
          n: ts.length,
          replay: mean(replay),
          real: mean(real),
          winner: winners.length ? mean(winners) : null,
          winners: winners.length,
          median: { replay: median(replay), real: median(real), winner: winners.length ? median(winners) : null },
          replayAhead: ts.filter((t) => t.replay.income > (t.real?.income ?? 0)).length,
          replayBehind: ts.filter((t) => t.replay.income < (t.real?.income ?? 0)).length,
        };
      }),
    landWithoutBonuses: { replay: at.filter((t) => poor(t.replay)).length, real: at.filter((t) => poor(t.real)).length },
    outpaced: {
      replay: at.filter((t) => behind(t.replay.income, t.bestOpponent)).length,
      real: at.filter((t) => behind(t.real?.income ?? 0, t.bestOpponent)).length,
    },
  };
}

// ---- #503: the opening benchmark by era ----

/** Rule 4f (#105) merged: openings played from here on are the current era. */
export const PRE_RULE_4F_AT = '2026-11-13T08:24:00Z';
/**
 * Without a turn-1 time, the era boundary by game id (ids are assigned when a game is created, so this
 * approximates the time): the first-bonus research of 2026-11-23 split its games here.
 */
export const PRE_RULE_4F_GAME_ID = 45_690_000;
/** The opening window the flags read: turns 1 to this. */
export const OPENING_WINDOW = 4;

export type OpeningEra = 'pre-tool' | 'pre-rule-4f' | 'current';
/** What the era was read from. */
export type EraBasis = 'turn-1 time' | 'game id' | 'not planned' | 'no game id';

/**
 * A finished game's opening era: by its turn-1 time where known, else by its game id; with neither, the
 * game is `pre-tool` (no local cache of it was ever kept, so this server never played it) — `basis`
 * says `not planned` when the record also keeps no outlook line, `no game id` when it does. Pure.
 */
export function openingEra(g: { planned: boolean; turn1At?: string; gameId?: number }): { era: OpeningEra; basis: EraBasis } {
  if (g.turn1At !== undefined && Number.isFinite(Date.parse(g.turn1At)))
    return { era: Date.parse(g.turn1At) < Date.parse(PRE_RULE_4F_AT) ? 'pre-rule-4f' : 'current', basis: 'turn-1 time' };
  if (g.gameId !== undefined) return { era: g.gameId < PRE_RULE_4F_GAME_ID ? 'pre-rule-4f' : 'current', basis: 'game id' };
  return { era: 'pre-tool', basis: g.planned ? 'no game id' : 'not planned' };
}

export interface OpeningFlags {
  /** Turns in the window the history shows no orders of mine on. */
  noOrderTurns: number[];
  /** The turn my seat was booted on, when it is in the window; else `null`. */
  bootedTurn: number | null;
}

/**
 * The opening window's turns with no orders of mine, and a boot of my seat in it. A turn n (history boards
 * n − 1 and n both kept, land of mine on n − 1) shows orders when I hold a territory I did not hold before,
 * a failed attack of mine is recorded that turn, or this server sent orders for it; else it reads as a turn
 * with no orders. Army growth alone is not read as orders: a missed turn's board shows it too (the
 * first-bonus research's missed turns all look so). Inferred from the boards: a deploy-and-transfer turn
 * with no capture reads as no orders. Pure.
 */
export function openingFlags(input: {
  me: number;
  history: HistoryBoards;
  window?: number;
  sentTurns?: readonly number[];
  failedAttackTurns?: readonly number[];
  /** My seat's boot: the turn being played when it left (`null`: not known). */
  booted?: { turn: number | null };
}): OpeningFlags {
  const window = input.window ?? OPENING_WINDOW;
  const boards = new Map(input.history.map((b) => [b.turn, b.board]));
  const sent = new Set([...(input.sentTurns ?? []), ...(input.failedAttackTurns ?? [])]);
  const noOrderTurns: number[] = [];
  for (let n = 1; n <= window; n++) {
    const before = boards.get(n - 1);
    const after = boards.get(n);
    if (!before || !after || sent.has(n)) continue;
    const was = landOf(before, input.me);
    if (!was.size) continue;
    if (![...landOf(after, input.me)].some((id) => !was.has(id))) noOrderTurns.push(n);
  }
  const bt = input.booted?.turn ?? null;
  return { noOrderTurns, bootedTurn: bt !== null && bt >= 1 && bt <= window ? bt : null };
}

/** One benchmarked game as {@link benchmarkByEra} groups it. */
export interface EraEntry {
  era: OpeningEra;
  basis: EraBasis;
  format: string;
  /** The map's territory count. */
  territories: number;
  flags: OpeningFlags;
  bench: Benchmark;
}

/** A map this many times the median map's territories or more is counted as large. */
export const LARGE_MAP_FACTOR = 5;

export interface EraBenchmark {
  /** The games with a clean opening window, all formats. */
  all: BenchmarkAggregate;
  byFormat: Record<string, BenchmarkAggregate>;
  /** Of the clean games, those on a map {@link LARGE_MAP_FACTOR}× the median map or larger (kept in: the medians read past them). */
  largeMaps: number;
  /** The games with a turn without orders or a boot in the window: counted and aggregated apart. */
  flagged: { games: number; noOrderTurns: number; boots: number; benchmark: BenchmarkAggregate | null };
}

/** The benchmarks grouped by era, then format; flagged games apart; how many eras were read from which basis. Pure. */
export function benchmarkByEra(entries: readonly EraEntry[]): { basis: Partial<Record<EraBasis, number>>; eras: Partial<Record<OpeningEra, EraBenchmark>> } {
  const basis: Partial<Record<EraBasis, number>> = {};
  for (const e of entries) basis[e.basis] = (basis[e.basis] ?? 0) + 1;
  const sizes = entries.map((e) => e.territories).filter((n) => n > 0);
  const large = sizes.length ? LARGE_MAP_FACTOR * median(sizes) : Number.POSITIVE_INFINITY;
  const eras: Partial<Record<OpeningEra, EraBenchmark>> = {};
  for (const era of ['pre-tool', 'pre-rule-4f', 'current'] as const) {
    const of = entries.filter((e) => e.era === era);
    if (!of.length) continue;
    const isFlagged = (e: EraEntry) => e.flags.noOrderTurns.length > 0 || e.flags.bootedTurn !== null;
    const clean = of.filter((e) => !isFlagged(e));
    const flagged = of.filter(isFlagged);
    const byFormat: Record<string, BenchmarkAggregate> = {};
    for (const f of [...new Set(clean.map((e) => e.format))].sort())
      byFormat[f] = aggregateBenchmarks(clean.filter((e) => e.format === f).map((e) => e.bench));
    eras[era] = {
      all: aggregateBenchmarks(clean.map((e) => e.bench)),
      byFormat,
      largeMaps: clean.filter((e) => e.territories >= large).length,
      flagged: {
        games: flagged.length,
        noOrderTurns: flagged.reduce((a, e) => a + e.flags.noOrderTurns.length, 0),
        boots: flagged.filter((e) => e.flags.bootedTurn !== null).length,
        benchmark: flagged.length ? aggregateBenchmarks(flagged.map((e) => e.bench)) : null,
      },
    };
  }
  return { basis, eras };
}
