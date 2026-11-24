// An Airlift plan beside the plain plan (owner request 2026-11-24, part 3). When I hold Airlift cards,
// warapp_plan_turn also looks for a plan that plays them: each candidate Airlift is applied to the board the
// planner plans on (its source loses the armies, its destination gains them — the Airlift runs after the
// deploys and before every move, so to the planner they stand there), the unchanged planner (`planTurn`) plans
// that board, and the plans are compared by the plain plan's own measure of a turn: the next income it keeps if
// every border it concedes falls, then its next income, then fewer borders conceded, then more captures. The best
// one that beats the plain plan is returned ALONGSIDE it; the plain plan and its orders never change. Pure and
// deterministic (candidates in id order); no I/O.
//
// Candidates (owner's a/b; c is not built, see below):
//   reinforce  a border the plain plan concedes (the threat model says it falls) — and a conceded member of a
//              held bonus first — gets an interior stack's spare armies (no enemy, neutral or fog beside it, not
//              my commander's territory), the largest stacks first;
//   evacuate   the spare armies of a border the plain plan concedes go to the border of mine with the most
//              enemy armies beside it (one it does not concede), and to a conceded member of a held bonus.
//   (c) "mass armies for a capture the deploy can't reach" is NOT built: armies an Airlift lands cannot attack
//              or move again that turn (the wiki's Airlift Card; warapp_submit_turn refuses it), so an Airlift
//              cannot fund a capture this turn — an owner decision whether to stage one for next turn.
//
// A candidate's plan is kept only when its orders are ones warapp_submit_turn accepts: what moves out of an
// Airlift's destination is at most what stood there plus its deploys, less the guard (what landed cannot move).
// Spare armies: all but the guard (one army, unless the game turns One Army Must Stand Guard off) — the
// submit's own rule — counting only the armies standing there now, so the source's deploys stay the planner's.

import type { BoardState } from '../board.js';
import { neighborsOf } from './graph.js';
import { planTurn } from './planner.js';
import type { PlanInput, TurnPlan } from './plan/shared.js';

/** Most candidate plans tried for one turn (each is one planner run). */
export const MAX_AIRLIFT_CANDIDATES = 8;

export interface PlannedAirlift {
  from: number;
  to: number;
  armies: number;
  kind: 'reinforce' | 'evacuate';
}

/** The plain plan's measure of a turn, best first: see the header. */
export interface PlanScore {
  /** Next income if every border the plan concedes falls (`nextIncomeIfConcededFall`, else `nextIncome`). */
  safeIncome: number;
  nextIncome: number;
  conceded: number;
  captures: number;
}

export interface AirliftPlan {
  plan: TurnPlan;
  airlifts: PlannedAirlift[];
  score: PlanScore;
  plainScore: PlanScore;
  /** Candidate plans tried (each one planner run), and how many were dropped as orders war.app would refuse. */
  considered: number;
  invalid: number;
}

export interface AirliftPlanInput {
  /** The exact input the plain plan was made from. */
  input: PlanInput;
  plain: TurnPlan;
  /** Airlift cards that may be played this turn (held, less any the plain plan uses, less those kept in reserve). */
  cards: number;
  /** One army stands guard (default true). */
  guard?: boolean;
}

export function scoreOf(plan: TurnPlan): PlanScore {
  return {
    safeIncome: plan.expected.nextIncomeIfConcededFall ?? plan.expected.nextIncome,
    nextIncome: plan.expected.nextIncome,
    conceded: plan.conceded.length,
    captures: plan.expected.captures.length,
  };
}

/** Negative when `a` is the better turn. */
export function compareScores(a: PlanScore, b: PlanScore): number {
  return b.safeIncome - a.safeIncome || b.nextIncome - a.nextIncome || a.conceded - b.conceded || b.captures - a.captures;
}

/** The board after these Airlifts, as the planner should see it: armies off each source and onto each destination. */
export function airliftedBoard(board: BoardState, airlifts: readonly PlannedAirlift[]): BoardState {
  const delta = new Map<number, number>();
  for (const a of airlifts) {
    delta.set(a.from, (delta.get(a.from) ?? 0) - a.armies);
    delta.set(a.to, (delta.get(a.to) ?? 0) + a.armies);
  }
  return {
    ...board,
    territories: board.territories.map((t) => (delta.has(t.territoryId) ? { ...t, armies: (t.armies ?? 0) + delta.get(t.territoryId)! } : t)),
  };
}

/** The candidate Airlifts for one card, best first within each kind (see the header). */
export function airliftCandidates(input: PlanInput, plain: TurnPlan, guardOn = true): PlannedAirlift[] {
  const { graph, board, me } = input;
  const guard = guardOn ? 1 : 0;
  const at = new Map(board.territories.map((t) => [t.territoryId, t]));
  const isMine = (id: number) => {
    const t = at.get(id);
    return t?.owner.kind === 'player' && t.owner.playerId === me && t.armies !== null;
  };
  const isEnemy = (id: number) => {
    const t = at.get(id);
    return t?.owner.kind === 'player' && t.owner.playerId !== me;
  };
  const armies = (id: number) => at.get(id)?.armies ?? 0;
  const commanderOn = (id: number) => at.get(id)?.specialUnits?.some((u) => u.kind === 'commander' && u.playerId === me) === true;
  const spare = (id: number) => Math.max(0, armies(id) - guard);
  const mine = board.territories.map((t) => t.territoryId).filter(isMine).sort((a, b) => a - b);
  const conceded = new Set(plain.conceded.filter(isMine));
  const atRisk = new Set((plain.expected.bonusesAtRisk ?? []).flatMap((b) => b.conceded));
  const enemyBeside = (id: number) => neighborsOf(graph, id).reduce((n, x) => n + (isEnemy(x) ? Math.max(1, armies(x)) : 0), 0);
  const interior = (id: number) => neighborsOf(graph, id).every((x) => isMine(x));

  // Reinforce: a conceded border (a held bonus's member first, then the most enemy beside it) from interior stacks.
  const targets = [...conceded].sort((a, b) => Number(atRisk.has(b)) - Number(atRisk.has(a)) || enemyBeside(b) - enemyBeside(a) || a - b);
  const sources = mine
    .filter((s) => interior(s) && !conceded.has(s) && !commanderOn(s) && spare(s) > 0)
    .sort((a, b) => spare(b) - spare(a) || a - b);
  const out: PlannedAirlift[] = [];
  for (const t of targets.slice(0, 3)) for (const s of sources.slice(0, 2)) out.push({ from: s, to: t, armies: spare(s), kind: 'reinforce' });

  // Evacuate: a conceded border's spare armies to the strongest-pressed border kept, and to a conceded bonus member.
  const kept = mine.filter((t) => !conceded.has(t) && enemyBeside(t) > 0).sort((a, b) => enemyBeside(b) - enemyBeside(a) || a - b);
  const leaving = [...conceded].filter((s) => !commanderOn(s) && spare(s) > 1).sort((a, b) => spare(b) - spare(a) || a - b);
  for (const s of leaving.slice(0, 2)) {
    const to = [kept[0], targets.find((t) => t !== s && atRisk.has(t))].filter((t): t is number => t !== undefined && t !== s);
    for (const t of [...new Set(to)]) out.push({ from: s, to: t, armies: spare(s), kind: 'evacuate' });
  }
  const seen = new Set<string>();
  return out.filter((a) => {
    const k = `${a.from}>${a.to}`;
    if (seen.has(k) || a.armies <= 0) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Orders war.app's validation (and warapp_submit_turn) accepts with these Airlifts: what moves out of a
 * destination is at most what stood there plus its deploys less the guard — the armies that landed cannot move.
 */
export function airliftOrdersValid(board: BoardState, plan: TurnPlan, airlifts: readonly PlannedAirlift[], guardOn = true): boolean {
  const guard = guardOn ? 1 : 0;
  const stood = new Map(board.territories.map((t) => [t.territoryId, t.armies ?? 0]));
  const deployed = new Map<number, number>();
  for (const d of plan.deploys) deployed.set(d.territoryId, (deployed.get(d.territoryId) ?? 0) + d.armies);
  const out = new Map<number, number>();
  for (const m of plan.moves) out.set(m.from, (out.get(m.from) ?? 0) + m.armies);
  const lifted = new Map<number, number>();
  for (const a of airlifts) lifted.set(a.from, (lifted.get(a.from) ?? 0) + a.armies);
  for (const a of airlifts) {
    const own = (stood.get(a.to) ?? 0) + (deployed.get(a.to) ?? 0) - (lifted.get(a.to) ?? 0);
    if ((out.get(a.to) ?? 0) > Math.max(0, own - guard)) return false;
  }
  return true;
}

/** The best Airlift plan that beats the plain plan, or `undefined` (with nothing better, or no card to play). */
export function planAirlift(a: AirliftPlanInput): { best?: AirliftPlan; considered: number; invalid: number } {
  const guardOn = a.guard !== false;
  if (a.cards < 1) return { considered: 0, invalid: 0 };
  const plainScore = scoreOf(a.plain);
  const tried: { airlifts: PlannedAirlift[]; plan: TurnPlan; score: PlanScore }[] = [];
  let considered = 0;
  let invalid = 0;
  const run = (airlifts: PlannedAirlift[]) => {
    considered++;
    const plan = planTurn({ ...a.input, board: airliftedBoard(a.input.board, airlifts) });
    if (!airliftOrdersValid(a.input.board, plan, airlifts, guardOn)) {
      invalid++;
      return;
    }
    tried.push({ airlifts, plan, score: scoreOf(plan) });
  };
  const candidates = airliftCandidates(a.input, a.plain, guardOn).slice(0, MAX_AIRLIFT_CANDIDATES);
  for (const c of candidates) run([c]);
  const rank = (x: (typeof tried)[number], y: (typeof tried)[number]) => compareScores(x.score, y.score);
  tried.sort(rank);
  // With two cards or more: the best two singles together, when their sources and destinations are distinct.
  if (a.cards >= 2 && tried.length >= 2) {
    const [x, y] = [tried[0]!.airlifts[0]!, tried.find((t) => {
      const o = t.airlifts[0]!;
      const first = tried[0]!.airlifts[0]!;
      return new Set([o.from, o.to, first.from, first.to]).size === 4;
    })?.airlifts[0]];
    if (y) {
      run([x, y]);
      tried.sort(rank);
    }
  }
  const top = tried[0];
  if (!top || compareScores(top.score, plainScore) >= 0) return { considered, invalid };
  return { best: { plan: top.plan, airlifts: top.airlifts, score: top.score, plainScore, considered, invalid }, considered, invalid };
}
