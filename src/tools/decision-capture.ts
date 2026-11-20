// The decision log's capture points (#412 task 2), one helper each, so every tool logs the same way:
// `capturePlan` (warapp_plan_turn's decision, and the previous turn's outcome), `captureObservation`
// (a board read without a plan: the board cache's writers and boardHistory's history fill) and
// `captureSent` (warapp_submit_turn's orders, with any override). Best effort, never throws; nothing
// without a data dir or with `WARAPP_DECISION_LOG=off` (`LiveContext.decisionLog`). Name-free: every
// player name the game carries is scrubbed by the store.
//
// #437: the per-turn additions — `capturePlan` takes the first mover, my hand, the card advice and the
// turn's boot deadlines; `captureSent` the submit's checks; `captureCheck` warapp_check_plan's summary —
// and the pure helpers that turn each tool's own values into the log's name-free shapes.
import type { HeadroomRow } from '../analysis/headroom.js';
import type { OutlookState } from '../analysis/outlook.js';
import type { stressPlan } from '../analysis/stress.js';
import type { CommitmentWarning } from '../analysis/commitments.js';
import type { Card } from '../cards.js';
import { type Game, parseFeedTime } from '../normalize.js';
import { bonusTerritories } from '../analysis/bonuses.js';
import type { MapGraph } from '../analysis/graph.js';
import type { EnemyDeployEstimate, PlanInput, TurnPlan } from '../analysis/plan/shared.js';
import type { BoardState } from '../board.js';
import {
  type CheckPlanSummary,
  decisionOutcome,
  type DecisionRecord,
  type DecisionTimes,
  fillOutcome,
  type LoggedCardAdvice,
  type LoggedHeadroom,
  type Observation,
  recordCheck,
  recordDecision,
  recordObservations,
  recordSubmission,
  type Submission,
  type SubmitChecks,
} from '../decision-log.js';
import type { CommanderCheck } from './commander-check.js';
import type { LiveContext } from './live-context.js';

type Ctx = Pick<LiveContext, 'dataDir' | 'decisionLog'>;
const modeOf = (ctx: Ctx) => (ctx.decisionLog ? { mode: ctx.decisionLog } : {});

/** Every bonus of the map with its member territories (superbonuses flattened). */
const bonusesOf = (graph: MapGraph): Map<number, readonly number[]> => new Map([...graph.bonusById.keys()].map((id) => [id, bonusTerritories(graph, id)]));

/**
 * Log the turn warapp_plan_turn planned (not a what-if plan), then fill the previous turn's outcome
 * from this turn's board and income when that turn has an entry without one. Never throws.
 */
export async function capturePlan(
  ctx: Ctx,
  a: {
    gameId: number;
    me: number;
    turn: number;
    board: BoardState;
    /** The board the planner read (`input.board`), when it may differ from the board seen. */
    plannedBoard?: BoardState;
    input: PlanInput;
    plan: TurnPlan;
    outlookState: OutlookState | null;
    /** The per-opponent deploy estimates the plan worked from (scored against the truth at the end, #412 task 3). */
    estimates?: readonly EnemyDeployEstimate[];
    graph: MapGraph;
    /** This turn's income, card armies out. */
    income: number;
    players: readonly { id: number; name?: string }[];
    /** #437: the plan's first mover (`null`: unknown), my hand and the advice, the turn's boot deadlines. */
    firstMover?: DecisionRecord['firstMover'];
    cards?: DecisionRecord['cards'];
    times?: DecisionRecord['times'];
  },
): Promise<void> {
  if (!ctx.dataDir) return;
  const opts = modeOf(ctx);
  await recordDecision(
    ctx.dataDir,
    a.gameId,
    a.me,
    {
      turn: a.turn,
      board: a.board,
      ...(a.plannedBoard ? { plannedBoard: a.plannedBoard } : {}),
      input: a.input,
      plan: a.plan,
      outlookState: a.outlookState,
      ...(a.estimates ? { estimates: a.estimates } : {}),
      players: a.players,
      ...(a.firstMover !== undefined ? { firstMover: a.firstMover } : {}),
      ...(a.cards ? { cards: a.cards } : {}),
      ...(a.times ? { times: a.times } : {}),
    },
    opts,
  );
  if (a.turn < 2) return;
  try {
    await fillOutcome(
      ctx.dataDir,
      a.gameId,
      a.me,
      a.turn - 1,
      (entry, before) =>
        decisionOutcome({ before, after: a.board, me: a.me, income: a.income, captures: entry.decision?.expected.captures ?? [], bonuses: bonusesOf(a.graph) }),
      opts,
    );
  } catch {
    // Best effort.
  }
}

/** Log boards seen without a plan as observations (never over a planned entry). Never throws. */
export async function captureObservation(ctx: Ctx, gameId: number, me: number, seen: readonly Observation[]): Promise<void> {
  if (!ctx.dataDir || !seen.length) return;
  await recordObservations(ctx.dataDir, gameId, me, seen, modeOf(ctx));
}

/** Log the orders warapp_submit_turn sent, with any override (see `recordSubmission`). Never throws. */
export async function captureSent(ctx: Ctx, gameId: number, me: number, turn: number, sub: Submission): Promise<void> {
  if (!ctx.dataDir) return;
  await recordSubmission(ctx.dataDir, gameId, me, turn, sub, modeOf(ctx));
}

/** Log warapp_check_plan's summary of the turn (the latest run wins). Never throws. */
export async function captureCheck(ctx: Ctx, gameId: number, me: number, turn: number, summary: CheckPlanSummary): Promise<void> {
  if (!ctx.dataDir) return;
  await recordCheck(ctx.dataDir, gameId, me, turn, summary, modeOf(ctx));
}

// ---------------------------------------------------------------------------------------------
// #437: the tools' values in the log's shapes (pure)

const byNum = (a: number, b: number) => a - b;

/** My hand by card type, counted, sorted by name (then type). */
export function handLog(cards: readonly Pick<Card, 'type' | 'name'>[]): { card: string; type: number; count: number }[] {
  const m = new Map<number, { card: string; type: number; count: number }>();
  for (const c of cards) {
    const e = m.get(c.type);
    if (e) e.count += 1;
    else m.set(c.type, { card: c.name, type: c.type, count: 1 });
  }
  return [...m.values()].sort((a, b) => a.card.localeCompare(b.card) || a.type - b.type);
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []);

/**
 * The card advice warapp_plan_turn offered (`cards.advice`), one entry per card advised: its kind, the
 * target ids, the player when one is named and a reason code — never the advice's prose. `active` (the
 * cards in effect) is not advice and is left out.
 */
export function cardAdviceLog(view: object): LoggedCardAdvice[] {
  const v = view as Readonly<Record<string, unknown>>;
  const out: LoggedCardAdvice[] = [];
  const add = (kind: string, targets: number[], reason: string | null, player?: number, extra: Partial<LoggedCardAdvice> = {}) =>
    out.push({ kind, targets, ...(player !== undefined ? { player } : {}), reason, ...extra });
  const d = rec(v.orderDelay);
  if (d) add('orderDelay', [], d.insteadOfDiscard ? 'instead-of-discard' : 'delay-attacks', undefined, num(d.before) !== undefined ? { before: num(d.before)! } : {});
  const b = rec(v.bomb);
  if (b) add('bomb', num(b.target) !== undefined ? [num(b.target)!] : [], typeof b.kind === 'string' ? b.kind : 'none');
  const e = rec(v.emergencyBlockade);
  if (e) add('emergencyBlockade', nums([e.territory]), 'conceded-wall', num(e.player));
  const dip = rec(v.diplomacy);
  if (dip) add('diplomacy', nums(dip.borders), dip.overTruce !== undefined ? 'over-truce' : 'border-pressure', num(dip.player));
  const s = rec(v.sanctions);
  if (s) add('sanctions', [], 'strongest', num(s.player));
  const a = rec(v.airlift);
  if (a) add('airlift', nums([a.from, a.to]), a.teammate !== undefined ? 'teammate-border' : 'border');
  const g = rec(v.gift);
  if (g) add('gift', nums(g.territories), 'teammate-bonus', num(g.player));
  const spy = rec(v.spy);
  if (spy) add('spy', [], 'fog', num(spy.player));
  const r = rec(v.reconnaissance);
  if (r) add('reconnaissance', nums([r.target]), 'fog');
  const sv = rec(v.surveillance);
  if (sv) add('surveillance', nums([sv.bonus]), 'fog');
  return out;
}

/** Headroom rows logged at most. */
export const LOGGED_HEADROOM_ROWS = 5;

/** The weakest {@link LOGGED_HEADROOM_ROWS} headroom rows (the smallest deploy that takes it first; none taking it last). */
export function headroomLog(rows: readonly HeadroomRow[]): LoggedHeadroom[] {
  const key = (r: HeadroomRow) => r.deploy ?? Number.POSITIVE_INFINITY;
  return [...rows]
    .sort((x, y) => key(x) - key(y) || x.territory - y.territory)
    .slice(0, LOGGED_HEADROOM_ROWS)
    .map((r) => ({
      territory: r.territory,
      takeAt: r.deploy,
      opponent: r.opponent,
      from: r.from,
      protects: { bonuses: r.bonuses.map((b) => b.id).sort(byNum), behindIncome: r.behindIncome, breachIncome: r.breach.income },
    }));
}

/** warapp_check_plan's report in the log's shape: the verdict, the worst reply in numbers and the at-risk counts. */
export function checkPlanLog(
  report: Pick<ReturnType<typeof stressPlan>, 'safe' | 'worst' | 'harmful' | 'considered' | 'atRisk'>,
  o: { whatIf: boolean },
): CheckPlanSummary {
  const w = report.worst;
  return {
    safe: report.safe,
    worst: w
      ? {
          opponent: w.opponent,
          kind: w.kind,
          deploy: w.deploy,
          lost: w.lost.length,
          capturesFailed: w.capturesFailed.length,
          bonusesLost: w.bonusesLost.length,
          incomeLost: w.incomeLost,
          commanderLost: w.commanderLost,
        }
      : null,
    harmful: report.harmful,
    considered: report.considered,
    atRisk: {
      commander: report.atRisk.commander,
      territories: report.atRisk.territories.length,
      captures: report.atRisk.captures.length,
      bonuses: report.atRisk.bonuses.length,
    },
    ...(o.whatIf ? { whatIf: true as const } : {}),
  };
}

/** What warapp_submit_turn checked on the orders, in the log's shape (ids and numbers only). */
export function submitChecksLog(a: {
  commander: (Pick<CommanderCheck, 'safety' | 'replyDeploy'> & { accepted?: boolean }) | undefined;
  headroom: readonly HeadroomRow[];
  belowPlan: { rows: readonly { territory: number; planLeaves: number; left: number; short: number }[]; against: 'plan' | 'guess' } | undefined;
  chat: readonly Pick<CommitmentWarning, 'kind' | 'with' | 'moves' | 'unchecked'>[];
}): SubmitChecks {
  const c = a.commander;
  return {
    commander: c
      ? {
          territory: c.safety.territory,
          armies: c.safety.armies,
          needs: c.safety.needs,
          replies: c.safety.killers,
          replyDeploy: c.replyDeploy,
          ...(c.accepted ? { accepted: true } : {}),
        }
      : null,
    headroom: headroomLog(a.headroom),
    belowPlan: (a.belowPlan?.rows ?? []).map((r) => ({ territory: r.territory, planLeaves: r.planLeaves, left: r.left, short: r.short })),
    ...(a.belowPlan ? { belowPlanAgainst: a.belowPlan.against } : {}),
    chat: a.chat.map((w) => ({
      kind: w.kind,
      ...(w.with !== undefined ? { with: w.with } : {}),
      moves: w.moves.map((m) => m.index),
      ...(w.unchecked ? { unchecked: true as const } : {}),
    })),
  };
}

/**
 * The turn's start (GameFeed's `lastTurnTime`, read as it — UNVERIFIED, as the boot warnings say) and the
 * boot deadlines its AutoBoot and DirectBoot minutes give, ISO; empty when the game read gives none.
 */
export function bootTimes(game: Pick<Game, 'lastTurnTime' | 'endRules'>): Pick<DecisionTimes, 'turnStartedAt' | 'bootAt'> {
  const start = parseFeedTime(game.lastTurnTime);
  if (start === undefined) return {};
  const at = (m: number | undefined) => (m !== undefined && m > 0 ? new Date(start + m * 60_000).toISOString() : undefined);
  const auto = at(game.endRules?.autoBootMinutes);
  const direct = at(game.endRules?.directBootMinutes);
  return {
    turnStartedAt: new Date(start).toISOString(),
    ...(auto || direct ? { bootAt: { ...(auto ? { auto } : {}), ...(direct ? { direct } : {}) } } : {}),
  };
}
