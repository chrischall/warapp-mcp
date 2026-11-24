// A Bomb plan beside the plain plan (owner request 2026-11-24, part B). When I hold a Bomb card, warapp_plan_turn
// also looks for a plan that plays it: each candidate target is halved on the board the planner plans on (a Bomb
// runs in phase 30, after every deploy and before every move, and leaves half the armies rounded down — the client
// bundle's GameOrderPlayCardBombResult), the unchanged planner (`planTurn`) plans that board, and the plans are
// compared by the plain plan's own measure (`scoreOf`, shared with the Airlift plan). The best one that beats the
// plain plan is returned ALONGSIDE it; the plain plan and its orders never change. Pure and deterministic.
//
// Candidates: an opponent's territory beside mine (never a teammate's, never a player a truce or a Diplomacy card
// keeps at peace with me — the planner's own relations), first one that is a member of a bonus its owner visibly
// holds whole (a capture there breaks it), then the largest stacks (cutting a stack that presses my border).
// The halving here is of the armies standing now: the owner's deploy on the target lands before the Bomb and is
// halved with it, so a plan sized on this board is never short for that reason.

import type { BoardState } from '../board.js';
import { compareScores, scoreOf, type PlanScore } from './airlift-plan.js';
import { neighborsOf } from './graph.js';
import { planTurn } from './planner.js';
import type { PlanInput, TurnPlan } from './plan/shared.js';

/** Most candidate targets tried (each one planner run). */
export const MAX_BOMB_CANDIDATES = 6;

export interface PlannedBomb {
  target: number;
  kind: 'break-bonus' | 'cut-stack';
  /** Armies on the target now, and what the Bomb leaves of them. */
  armies: number;
  left: number;
}

export interface BombPlan {
  plan: TurnPlan;
  bomb: PlannedBomb;
  score: PlanScore;
  plainScore: PlanScore;
  considered: number;
}

/** What a Bomb leaves of `armies`: half, rounded down (round(armies / 2) with a half rounded down). */
export const bombLeaves = (armies: number): number => Math.floor(armies / 2);

/** The board with `target`'s armies halved. */
export function bombedBoard(board: BoardState, target: number): BoardState {
  return {
    ...board,
    territories: board.territories.map((t) => (t.territoryId === target && t.armies !== null ? { ...t, armies: bombLeaves(t.armies) } : t)),
  };
}

/** The candidate targets, best first (see the header). */
export function bombCandidates(input: PlanInput): PlannedBomb[] {
  const { graph, board, me } = input;
  const at = new Map(board.territories.map((t) => [t.territoryId, t]));
  const ownerOf = (id: number) => {
    const t = at.get(id);
    return t?.owner.kind === 'player' && t.armies !== null ? t.owner.playerId : undefined;
  };
  const myTeam = input.game?.players?.find((p) => p.id === me)?.team;
  const friend = (p: number) =>
    p === me || (myTeam !== undefined && myTeam >= 0 && input.game?.players?.find((x) => x.id === p)?.team === myTeam);
  const peace = new Set(
    (input.relations ?? []).filter((r) => r.enforced === true || r.state === 'active' || r.state === 'notice').map((r) => r.player),
  );
  const out: PlannedBomb[] = [];
  for (const t of board.territories) {
    const owner = ownerOf(t.territoryId);
    if (owner === undefined || friend(owner) || peace.has(owner)) continue;
    if (!neighborsOf(graph, t.territoryId).some((n) => ownerOf(n) === me)) continue;
    const armies = t.armies ?? 0;
    if (armies < 2) continue; // halving 0 or 1 changes nothing
    const breaks = [...graph.bonusById.values()].some(
      (b) => b.value > 0 && b.territoryIds.includes(t.territoryId) && b.territoryIds.every((x) => ownerOf(x) === owner),
    );
    out.push({ target: t.territoryId, kind: breaks ? 'break-bonus' : 'cut-stack', armies, left: bombLeaves(armies) });
  }
  return out.sort((a, b) => Number(b.kind === 'break-bonus') - Number(a.kind === 'break-bonus') || b.armies - a.armies || a.target - b.target);
}

/** The best Bomb plan that beats the plain plan, or none. */
export function planBomb(a: { input: PlanInput; plain: TurnPlan; cards: number }): { best?: BombPlan; considered: number } {
  if (a.cards < 1) return { considered: 0 };
  const plainScore = scoreOf(a.plain);
  let best: BombPlan | undefined;
  let considered = 0;
  for (const bomb of bombCandidates(a.input).slice(0, MAX_BOMB_CANDIDATES)) {
    considered++;
    const plan = planTurn({ ...a.input, board: bombedBoard(a.input.board, bomb.target) });
    const score = scoreOf(plan);
    if (compareScores(score, plainScore) >= 0) continue;
    if (!best || compareScores(score, best.score) < 0) best = { plan, bomb, score, plainScore, considered: 0 };
  }
  if (best) best.considered = considered;
  return best ? { best, considered } : { considered };
}
