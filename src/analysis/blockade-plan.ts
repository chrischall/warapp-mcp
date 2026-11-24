// An Emergency Blockade plan beside the plain plan (owner request 2026-11-24, part B). When I hold an Emergency
// Blockade card, warapp_plan_turn also looks for a plan that walls off a border the plain plan concedes: the
// territory turns neutral at its armies × the card's multiplier (rounded with a half down) in phase 37 — after the
// deploys and Bombs, before every move (the client bundle's GameOrderPlayCardAbandonResult) — so the stack beside it
// must break through a wall instead of taking a thin border into what lies behind. The unchanged planner (`planTurn`)
// plans that board and the plans are compared by the plain plan's own measure (`scoreOf`, shared with the Airlift
// plan); the best one that beats the plain plan is returned ALONGSIDE it, the plain plan and its orders unchanged.
// Pure and deterministic.
//
// Candidates (the evacuation/denial case beside the Airlift's evacuate): a territory of mine the plain plan concedes,
// with armies on it, not my commander's (it would be lost with it); those whose fall would complete an opponent's
// bonus first (every other member visibly its own, a stack of its beside the territory), then the strongest wall.
//
// DRAFT for owner approval: the plain plan's measure reads only my income, and a conceded border is lost either way,
// so a wall's worth is the bonus it denies: `denied` (that bonus's value) enters the two-turn score as a staging
// gain does (`scoreOf(plan, denied)`: × `STAGING_DISCOUNT`, ranked first), only for a wall the stack beside it does
// not break this turn (luck-free: its armies plus the plan's enemy deploy against the wall).
// The wall is built from the armies standing now: a deploy there would be multiplied too, but the planner does not
// deploy onto a neutral, so a plan sized on this board is never short for that reason.
//
// A Blockade (phase 60, after every move) is not planned here: it acts only on a territory still mine at the end of
// the turn, so it changes nothing the plain plan's one-turn measure reads (an owner decision how to value it).

import type { BoardState } from '../board.js';
import { compareScores, scoreOf, type PlanScore } from './airlift-plan.js';
import { armiesToTake } from './combat.js';
import { neighborsOf } from './graph.js';
import { planTurn } from './planner.js';
import type { PlanInput, TurnPlan } from './plan/shared.js';
import { roundHalfDown } from './turn-sim.js';

/** Most candidate walls tried (each one planner run). */
export const MAX_WALL_CANDIDATES = 6;

export interface PlannedWall {
  target: number;
  /** Armies on it now, and the neutral wall they make. */
  armies: number;
  wall: number;
  /** The bonus value its fall would hand an opponent (0: none), and that opponent. */
  denied: number;
  deniedFrom?: number;
}

export interface WallPlan {
  plan: TurnPlan;
  wall: PlannedWall;
  score: PlanScore;
  plainScore: PlanScore;
  considered: number;
}

/** The board with `target` a neutral wall of `armies`. */
export function walledBoard(board: BoardState, target: number, armies: number): BoardState {
  return {
    ...board,
    territories: board.territories.map((t) => {
      if (t.territoryId !== target) return t;
      const { specialUnits: _units, ...rest } = t;
      return { ...rest, owner: { kind: 'neutral' as const }, armies };
    }),
  };
}

/** The bonus value the fall of `id` would complete for an opponent with a stack beside it, and that opponent. */
function denialOf(input: PlanInput, id: number): { denied: number; deniedFrom?: number } {
  const { graph, board, me } = input;
  const owner = new Map(board.territories.map((t) => [t.territoryId, t.owner.kind === 'player' && t.armies !== null ? t.owner.playerId : undefined]));
  let best = { denied: 0 } as { denied: number; deniedFrom?: number };
  for (const p of new Set(neighborsOf(graph, id).map((n) => owner.get(n)).filter((x): x is number => x !== undefined && x !== me))) {
    const value = [...graph.bonusById.values()]
      .filter((b) => b.value > 0 && b.territoryIds.includes(id) && b.territoryIds.every((x) => x === id || owner.get(x) === p))
      .reduce((n, b) => n + b.value, 0);
    if (value > best.denied) best = { denied: value, deniedFrom: p };
  }
  return best;
}

/** The candidate walls, denials first, then the strongest (see the header). */
export function wallCandidates(input: PlanInput, plain: TurnPlan, multiplier: number): PlannedWall[] {
  const { board, me } = input;
  const conceded = new Set(plain.conceded);
  return board.territories
    .filter(
      (t) =>
        conceded.has(t.territoryId) &&
        t.owner.kind === 'player' &&
        t.owner.playerId === me &&
        t.armies !== null &&
        t.armies > 0 &&
        !t.specialUnits?.some((u) => u.kind === 'commander' && u.playerId === me),
    )
    .map((t) => ({ target: t.territoryId, armies: t.armies!, wall: roundHalfDown(t.armies! * multiplier), ...denialOf(input, t.territoryId) }))
    .sort((a, b) => b.denied - a.denied || b.wall - a.wall || a.target - b.target);
}

/** The wall survives this turn: every enemy stack beside it (its movable armies) plus the enemy deploy, luck-free. */
function wallHolds(input: PlanInput, wall: PlannedWall, enemyDeploy: number): boolean {
  const guard = input.settings?.oneArmyStandsGuard === false ? 0 : 1;
  const attackers =
    neighborsOf(input.graph, wall.target).reduce((n, x) => {
      const t = input.board.territories.find((y) => y.territoryId === x);
      return n + (t?.owner.kind === 'player' && t.owner.playerId !== input.me && t.armies !== null ? Math.max(0, t.armies - guard) : 0);
    }, 0) + enemyDeploy;
  const need = armiesToTake(wall.wall, {
    ...(input.settings?.offensiveKillRate !== undefined ? { offensiveKillRate: input.settings.offensiveKillRate } : {}),
    ...(input.settings?.defensiveKillRate !== undefined ? { defensiveKillRate: input.settings.defensiveKillRate } : {}),
  });
  return need === null || attackers < need;
}

/** The best Emergency Blockade plan that beats the plain plan, or none. */
export function planWall(a: { input: PlanInput; plain: TurnPlan; cards: number; multiplier: number }): { best?: WallPlan; considered: number } {
  if (a.cards < 1 || !(a.multiplier > 0)) return { considered: 0 };
  const plainScore = scoreOf(a.plain);
  let best: WallPlan | undefined;
  let considered = 0;
  for (const wall of wallCandidates(a.input, a.plain, a.multiplier).slice(0, MAX_WALL_CANDIDATES)) {
    considered++;
    const plan = planTurn({ ...a.input, board: walledBoard(a.input.board, wall.target, wall.wall) });
    const score = scoreOf(plan, wall.denied > 0 && wallHolds(a.input, wall, a.plain.enemyDeploy) ? wall.denied : 0);
    if (compareScores(score, plainScore) >= 0) continue;
    if (!best || compareScores(score, best.score) < 0) best = { plan, wall, score, plainScore, considered: 0 };
  }
  if (best) best.considered = considered;
  return best ? { best, considered } : { considered };
}
