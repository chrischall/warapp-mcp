// The decision log's capture points (#412 task 2), one helper each, so every tool logs the same way:
// `capturePlan` (warapp_plan_turn's decision, and the previous turn's outcome), `captureObservation`
// (a board read without a plan: the board cache's writers and boardHistory's history fill) and
// `captureSent` (warapp_submit_turn's orders, with any override). Best effort, never throws; nothing
// without a data dir or with `WARAPP_DECISION_LOG=off` (`LiveContext.decisionLog`). Name-free: every
// player name the game carries is scrubbed by the store.
import type { OutlookState } from '../analysis/outlook.js';
import { bonusTerritories } from '../analysis/bonuses.js';
import type { MapGraph } from '../analysis/graph.js';
import type { EnemyDeployEstimate, PlanInput, TurnPlan } from '../analysis/plan/shared.js';
import type { BoardState } from '../board.js';
import {
  decisionOutcome,
  fillOutcome,
  type Observation,
  recordDecision,
  recordObservations,
  recordSubmission,
  type Submission,
} from '../decision-log.js';
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
  },
): Promise<void> {
  if (!ctx.dataDir) return;
  const opts = modeOf(ctx);
  await recordDecision(ctx.dataDir, a.gameId, a.me, { turn: a.turn, board: a.board, ...(a.plannedBoard ? { plannedBoard: a.plannedBoard } : {}), input: a.input, plan: a.plan, outlookState: a.outlookState, ...(a.estimates ? { estimates: a.estimates } : {}), players: a.players }, opts);
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
