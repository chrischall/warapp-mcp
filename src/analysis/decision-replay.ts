// Replaying the decision log offline (#412 task 4), pure: each logged turn's planner input is rebuilt
// (the entry's board and kept input, the map from the replay's map store and settings) and planned again,
// optionally under a scenario (a goal, an enemy deploy, per-player estimate overrides, any planner option
// or setting), then compared with the logged decision and scored against what happened next (`next`).
// The estimate accuracy against the end-of-game truth (`truth`/`accuracy`, #412 task 3) is summed here
// too, beside how a scenario's estimates would have scored against the same truth. No I/O, no clock.
//
// INVARIANT (tests/analysis/decision-replay.test.ts, tests/decision-replay-tools.test.ts): with the same
// code and no scenario, a turn warapp_plan_turn logged replays to the logged deploys and moves.
// scripts/replay-decisions.mjs is the local dev script around it (never a tool, never run in CI).
import type { BoardState } from '../board.js';
import { boardAt, type DecisionEntry, type DecisionLog, type DecisionOutcome, decodeInput, interestingTurns, type LoggedDecision, type LoggedInput } from '../decision-log.js';
import type { GameMap, GameSettings } from '../normalize.js';
import { type AccuracySummary, ratioView, type RatioView } from './decision-truth.js';
import { COVERAGE_BUCKETS, coverageBucket } from './game-lessons.js';
import { buildGraph, type MapGraph } from './graph.js';
import { applyBonusOverrides } from './overrides.js';
import { alliesOf, planEnemyEstimates } from './plan/estimates.js';
import type { PlanGoal, PlanInput, PlannerSettings, PlanOptions, TurnPlan } from './plan/shared.js';
import { planningInput, planTurn } from './planner.js';

/** What a replay may change: each field, when given, replaces (or for `estimates`, adds to) the logged one. */
export interface Scenario {
  goal?: PlanGoal;
  /** The enemy deploy every threat is judged at (`options.enemyDeploy`). */
  enemyDeploy?: number;
  /** Per-player incomes that replace those opponents' estimates (`knownIncome`), by GameFeed id. */
  estimates?: readonly { player: number; income: number }[];
  /** Any planner option ({@link PlanOptions}), merged over the logged ones. */
  options?: Partial<PlanOptions>;
  /** Any planner setting ({@link PlannerSettings}), merged over the logged ones. */
  settings?: Partial<PlannerSettings>;
}

/** The map and settings a replay plans on: `Replay` from src/replay.ts gives both. */
export interface ReplaySource {
  map: GameMap | undefined;
  settings: GameSettings | undefined;
}

/** Why a logged turn was not planned again: no map, no kept input (compacted), no board, or the planner threw. */
export type TurnReplayStatus = 'compared' | 'no-map' | 'no-input' | 'no-board' | 'failed';

export interface TurnReplay {
  turn: number;
  status: TurnReplayStatus;
  /** Deploys and moves both identical to the logged ones (`compared` only). */
  same?: boolean;
  sameDeploys?: boolean;
  sameMoves?: boolean;
  goal: { logged: PlanGoal; replayed?: PlanGoal };
  nextIncome: { logged: number; replayed?: number };
  /** Against what happened next, when `next` is logged. */
  score?: TurnScore;
  /** The opponents' estimates the replayed input gives (scenario included), for scoring against the truth. */
  estimates?: { player: number; estimate: number; source: string; coverage: number | null }[];
}

/**
 * Did the logged plan's expectation hold, and would the new plan's captures have been possible given
 * what happened: a new capture is `backed` when I held it next turn anyway (the logged plan took it),
 * `failed` when the logged plan tried it and did not hold it, `untested` otherwise.
 */
export interface TurnScore {
  /** Next turn's income reached the logged `expected.nextIncome` (`null`: unread). */
  incomeHeld: boolean | null;
  /** Every logged capture was held next turn. */
  capturesHeld: boolean;
  eliminated: boolean;
  replayedCaptures: { backed: number[]; failed: number[]; untested: number[] };
}

export interface GameReplay {
  gameId: number;
  turns: TurnReplay[];
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const deploysOf = (ds: readonly { territoryId: number; armies: number }[]) => ds.map((d) => [d.territoryId, d.armies]);
const movesOf = (ms: readonly { from: number; to: number; armies: number; kind?: string; commander?: boolean }[]) =>
  ms.map((m) => [m.from, m.to, m.armies, m.kind ?? null, !!m.commander]);

/** `input` under `scenario`; the same object without one. Pure: `input` is not changed. */
export function applyScenario(input: PlanInput, scenario: Scenario | undefined): PlanInput {
  if (!scenario) return input;
  const options: PlanOptions = {
    ...input.options,
    ...scenario.options,
    ...(scenario.goal !== undefined ? { goal: scenario.goal } : {}),
    ...(scenario.enemyDeploy !== undefined ? { enemyDeploy: scenario.enemyDeploy } : {}),
  };
  const known = new Map((input.knownIncome ?? []).map((k) => [k.player, k] as const));
  for (const k of scenario.estimates ?? []) known.set(k.player, { player: k.player, income: k.income });
  return {
    ...input,
    options,
    ...(scenario.settings ? { settings: { ...input.settings, ...scenario.settings } } : {}),
    ...(known.size ? { knownIncome: [...known.values()] } : {}),
  };
}

/**
 * The opponents' deploy estimates `input` gives, as the planner reads them (static seats out, card
 * armies out of my income, a known income in place of an estimate); under `options.enemyDeploy` every
 * opponent is sized at that figure, so that is its estimate (`source: 'scenario'`).
 */
export function estimatesOf(input: PlanInput): { player: number; estimate: number; source: string; coverage: number | null }[] {
  const pi = planningInput(input);
  const ctx = pi.game ?? {};
  const capCut = pi.incomeCap ? Math.max(0, Math.floor(pi.incomeCap.uncapped - pi.incomeCap.received)) : 0;
  const allies = alliesOf(pi.me, ctx.players);
  const enemyDeploy = pi.options?.enemyDeploy;
  const { estimates } = planEnemyEstimates({
    graph: pi.graph,
    board: pi.board,
    me: pi.me,
    income: Math.max(0, Math.floor(pi.income)) + capCut - Math.max(0, Math.floor(pi.cardArmies ?? 0)),
    ...(pi.settings ? { settings: pi.settings } : {}),
    ...(pi.previousBoard ? { previousBoard: pi.previousBoard } : {}),
    ...(pi.previousOrders ? { previousOrders: pi.previousOrders } : {}),
    ...(pi.tracks ? { tracks: pi.tracks } : {}),
    game: ctx,
    turn: pi.turn ?? ctx.turn ?? null,
    ...(pi.sanctions?.length ? { sanctions: pi.sanctions } : {}),
    ...(pi.knownIncome?.length && enemyDeploy === undefined ? { known: pi.knownIncome } : {}),
  });
  return estimates
    .filter((e) => e.playerId !== pi.me && !allies.has(e.playerId))
    .sort((a, b) => a.playerId - b.playerId)
    .map((e) =>
      enemyDeploy !== undefined
        ? { player: e.playerId, estimate: enemyDeploy, source: 'scenario', coverage: e.coverage?.share ?? null }
        : { player: e.playerId, estimate: e.estimate, source: e.source, coverage: e.coverage?.share ?? null },
    );
}

/** The graph a replay plans on: the stored map with the game's bonus overrides. */
export function replayGraph(src: ReplaySource): MapGraph | undefined {
  return src.map ? buildGraph(applyBonusOverrides(src.map, src.settings)) : undefined;
}

function score(decision: LoggedDecision, next: DecisionOutcome, plan: TurnPlan | undefined): TurnScore {
  const expected = decision.expected?.nextIncome;
  const held = new Set([...next.capturesMade, ...next.gained]);
  const missed = new Set(next.capturesMissed);
  const caps = plan?.expected.captures ?? [];
  return {
    incomeHeld: typeof next.income === 'number' && typeof expected === 'number' ? next.income >= expected : null,
    capturesHeld: next.capturesMissed.length === 0,
    eliminated: next.eliminated,
    replayedCaptures: {
      backed: caps.filter((id) => held.has(id)),
      failed: caps.filter((id) => !held.has(id) && missed.has(id)),
      untested: caps.filter((id) => !held.has(id) && !missed.has(id)),
    },
  };
}

/** The decided turns of `log`, ascending. */
const decidedTurns = (log: Pick<DecisionLog, 'turns'>): [number, DecisionEntry & { decision: LoggedDecision }][] =>
  Object.entries(log.turns)
    .filter(([k, e]) => /^\d+$/.test(k) && !!e.decision)
    .map(([k, e]) => [Number(k), e as DecisionEntry & { decision: LoggedDecision }] as [number, DecisionEntry & { decision: LoggedDecision }])
    .sort((a, b) => a[0] - b[0]);

/** One logged turn planned again (see {@link replayDecisions}). */
export function replayTurn(log: Pick<DecisionLog, 'turns'>, turn: number, graph: MapGraph | undefined, scenario?: Scenario): TurnReplay {
  const e = log.turns[String(turn)]!;
  const d = e.decision!;
  const base: TurnReplay = { turn, status: 'compared', goal: { logged: d.goal }, nextIncome: { logged: d.expected?.nextIncome } };
  const scoreOnly = (status: TurnReplayStatus): TurnReplay => ({ ...base, status, ...(e.next ? { score: score(d, e.next, undefined) } : {}) });
  if (!graph) return scoreOnly('no-map');
  if (!e.input) return scoreOnly('no-input');
  const board: BoardState | undefined = boardAt(log, turn);
  if (!board) return scoreOnly('no-board');
  let input: PlanInput;
  let plan: TurnPlan;
  try {
    input = applyScenario(decodeInput(e.input as LoggedInput, board, graph), scenario);
    plan = planTurn(input);
  } catch {
    return scoreOnly('failed');
  }
  const sameDeploys = sameJson(deploysOf(d.deploys), deploysOf(plan.deploys));
  const sameMoves = sameJson(movesOf(d.moves), movesOf(plan.moves));
  let estimates: TurnReplay['estimates'];
  try {
    estimates = estimatesOf(input);
  } catch {
    estimates = undefined;
  }
  return {
    ...base,
    same: sameDeploys && sameMoves,
    sameDeploys,
    sameMoves,
    goal: { logged: d.goal, replayed: plan.goal },
    nextIncome: { logged: d.expected?.nextIncome, replayed: plan.expected.nextIncome },
    ...(e.next ? { score: score(d, e.next, plan) } : {}),
    ...(estimates ? { estimates } : {}),
  };
}

/** Every decided turn of `log` planned again on `src`'s map, under `scenario` when given. Pure; never throws. */
export function replayDecisions(log: DecisionLog, src: ReplaySource, scenario?: Scenario): GameReplay {
  let graph: MapGraph | undefined;
  try {
    graph = replayGraph(src);
  } catch {
    graph = undefined;
  }
  return { gameId: log.gameId, turns: decidedTurns(log).map(([turn]) => replayTurn(log, turn, graph, scenario)) };
}

export interface ReplayAggregate {
  games: number;
  /** Decided turns seen, and those planned again. */
  turns: number;
  compared: number;
  identical: number;
  /** identical ÷ compared (`null` with none compared). */
  identicalShare: number | null;
  goalChanged: number;
  /** By the logged goal: turns compared, and those whose orders differ. */
  byGoal: Record<string, { compared: number; different: number }>;
  /** Turns not planned again, by why. */
  skipped: Partial<Record<Exclude<TurnReplayStatus, 'compared'>, number>>;
  /** The logged expectations against `next`: turns scored, next income reached, every capture held. */
  expectations: { scored: number; incomeHeld: number; capturesHeld: number };
  /** The replayed plans' captures against what happened. */
  replayedCaptures: { backed: number; failed: number; untested: number };
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;

/** The replays summed: ids never appear. */
export function replayAggregate(games: readonly GameReplay[]): ReplayAggregate {
  const out: ReplayAggregate = {
    games: games.length,
    turns: 0,
    compared: 0,
    identical: 0,
    identicalShare: null,
    goalChanged: 0,
    byGoal: {},
    skipped: {},
    expectations: { scored: 0, incomeHeld: 0, capturesHeld: 0 },
    replayedCaptures: { backed: 0, failed: 0, untested: 0 },
  };
  for (const g of games)
    for (const t of g.turns) {
      out.turns++;
      if (t.score) {
        if (t.score.incomeHeld !== null) {
          out.expectations.scored++;
          if (t.score.incomeHeld) out.expectations.incomeHeld++;
          if (t.score.capturesHeld) out.expectations.capturesHeld++;
        }
        if (t.status === 'compared') {
          out.replayedCaptures.backed += t.score.replayedCaptures.backed.length;
          out.replayedCaptures.failed += t.score.replayedCaptures.failed.length;
          out.replayedCaptures.untested += t.score.replayedCaptures.untested.length;
        }
      }
      if (t.status !== 'compared') {
        out.skipped[t.status] = (out.skipped[t.status] ?? 0) + 1;
        continue;
      }
      out.compared++;
      if (t.same) out.identical++;
      if (t.goal.replayed !== t.goal.logged) out.goalChanged++;
      const b = (out.byGoal[t.goal.logged] ??= { compared: 0, different: 0 });
      b.compared++;
      if (!t.same) b.different++;
    }
  out.identicalShare = out.compared ? round(out.identical / out.compared) : null;
  return out;
}

/** Estimate ÷ truth grouped as the end-of-game summary groups it. */
export interface EstimateView {
  estimates: RatioView | null;
  byCoverage: AccuracySummary['byCoverage'];
  bySource: Record<string, RatioView>;
}

export interface AccuracyReport {
  /** Games with any truth written. */
  games: number;
  /** What the turns logged, against the truth: overall, and per game (in the order given, no ids). */
  logged: EstimateView & { outlook: { right: number; wrong: number } };
  perGame: (EstimateView & { outlook: { right: number; wrong: number } })[];
  /** The replayed (scenario's) estimates against the same truth; absent when no turn was replayed. */
  scenario?: EstimateView;
}

type Sample = { ratio: number; coverage: number | null; source: string };

function view(samples: readonly Sample[]): EstimateView {
  const byCoverage: AccuracySummary['byCoverage'] = {};
  for (const b of COVERAGE_BUCKETS) {
    const v = ratioView(samples.filter((s) => coverageBucket(s.coverage) === b).map((s) => s.ratio));
    if (v) byCoverage[b] = v;
  }
  const bySource: Record<string, RatioView> = {};
  for (const src of [...new Set(samples.map((s) => s.source))].sort()) bySource[src] = ratioView(samples.filter((s) => s.source === src).map((s) => s.ratio))!;
  return { estimates: ratioView(samples.map((s) => s.ratio)), byCoverage, bySource };
}

/**
 * The estimate accuracy over `games` (each log beside its replay): the logged turns' `accuracy` blocks
 * by coverage band and estimate source, outlook right/wrong — and the replayed estimates (under the
 * replay's scenario) against each turn's `truth`. Pure.
 */
export function accuracyReport(games: readonly { log: DecisionLog; replay?: GameReplay }[]): AccuracyReport {
  const all: Sample[] = [];
  const scen: Sample[] = [];
  const outlook = { right: 0, wrong: 0 };
  const perGame: AccuracyReport['perGame'] = [];
  let withTruth = 0;
  let replayed = false;
  for (const { log, replay } of games) {
    const mine: Sample[] = [];
    const o = { right: 0, wrong: 0 };
    let truthSeen = false;
    for (const e of Object.values(log.turns)) {
      if (e.truth) truthSeen = true;
      const a = e.accuracy;
      if (!a) continue;
      for (const x of a.estimates) if (x.ratio !== null) mine.push({ ratio: x.ratio, coverage: x.coverage, source: x.source ?? 'unknown' });
      if (a.outlook.right === true) o.right++;
      if (a.outlook.right === false) o.wrong++;
    }
    for (const t of replay?.turns ?? []) {
      const truth = log.turns[String(t.turn)]?.truth;
      if (!t.estimates || !truth) continue;
      replayed = true;
      for (const x of t.estimates) {
        const real = truth.opponents.find((p) => p.player === x.player)?.income;
        if (typeof real === 'number' && real > 0) scen.push({ ratio: x.estimate / real, coverage: x.coverage, source: x.source });
      }
    }
    if (!truthSeen) continue;
    withTruth++;
    all.push(...mine);
    outlook.right += o.right;
    outlook.wrong += o.wrong;
    perGame.push({ ...view(mine), outlook: o });
  }
  return { games: withTruth, logged: { ...view(all), outlook }, perGame, ...(replayed ? { scenario: view(scen) } : {}) };
}

/** One interesting turn as a standalone fixture: ids and numbers only (the logged entry is name-free). */
export interface DecisionFixture {
  version: 1;
  /** The map the input plans on (the map store's), and its game's settings' overrides are the replay's. */
  mapId: number | undefined;
  turn: number;
  plannerVersion: string | undefined;
  /** The turn's board, rebuilt whole (fog included). */
  board: BoardState;
  /** The kept planner input (`decodeInput` with the board and the map's graph rebuilds it). */
  input: LoggedInput;
  decision: LoggedDecision;
  sent?: DecisionEntry['sent'];
  override?: DecisionEntry['override'];
  next?: DecisionOutcome;
  truth?: DecisionEntry['truth'];
  accuracy?: DecisionEntry['accuracy'];
}

/** Each interesting turn of `log` (Task 3's rule, `interestingTurns`) that keeps its input and board, as a fixture. Pure. */
export function decisionFixtures(log: DecisionLog, src: Pick<ReplaySource, 'map' | 'settings'>): DecisionFixture[] {
  const keep = interestingTurns(log);
  const out: DecisionFixture[] = [];
  for (const [turn, e] of decidedTurns(log)) {
    if (!keep.has(turn) || !e.input) continue;
    const board = boardAt(log, turn);
    if (!board) continue;
    out.push({
      version: 1,
      mapId: src.map?.id ?? src.settings?.mapId,
      turn,
      plannerVersion: e.planner?.version,
      board,
      input: e.input,
      decision: e.decision,
      ...(e.sent ? { sent: e.sent } : {}),
      ...(e.override ? { override: e.override } : {}),
      ...(e.next ? { next: e.next } : {}),
      ...(e.truth ? { truth: e.truth } : {}),
      ...(e.accuracy ? { accuracy: e.accuracy } : {}),
    });
  }
  return JSON.parse(JSON.stringify(out)) as DecisionFixture[];
}
