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
// Owner-approved 2026-11-24: the plain plan's measure reads only my income, and a conceded border is lost either way,
// so a wall's worth is the bonus it denies: `denied` (that bonus's value) enters the two-turn score as a staging
// gain does (`scoreOf(plan, denied)`: × `STAGING_DISCOUNT`, ranked first), only for a wall the stack beside it does
// not break this turn (luck-free: its armies plus the plan's enemy deploy against the wall).
// The wall is built from the armies standing now: a deploy there would be multiplied too, but the planner does not
// deploy onto a neutral, so a plan sized on this board is never short for that reason.
//
// A Blockade (phase 60, after every move; owner decision 2026-11-24): the plain plan's orders stand unchanged and the
// card is added. Its candidates are territories of mine whose fall would complete an opponent's bonus (the same
// denial term), not my commander's; it is valued only when the stress-tested line keeps the territory mine through
// the attacks (no single-deploy reply `stressPlan` tries takes it — each opponent beside my land at the plan's enemy
// deploy), since the Blockade acts only on a territory still mine then. The wall is its armies after the plan × the
// multiplier. It is charged the positive bonuses of mine it gives up (every member mine after the plan), out of
// both incomes; the two-turn score is that plus 0.8 × the denied bonus.

import type { BoardState } from '../board.js';
import { compareScores, scoreOf, type PlanScore } from './airlift-plan.js';
import { armiesToTake } from './combat.js';
import { neighborsOf } from './graph.js';
import { stressPlan } from './stress.js';
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

/** The best Blockade (phase 60) added to the plain plan's orders, or none (see the header). */
export function planBlockade(a: { input: PlanInput; plain: TurnPlan; cards: number; multiplier: number }): { best?: WallPlan; considered: number } {
  if (a.cards < 1 || !(a.multiplier > 0)) return { considered: 0 };
  const { graph, board, me } = a.input;
  const plainScore = scoreOf(a.plain);
  const at = new Map(board.territories.map((t) => [t.territoryId, t]));
  const isMine = (id: number) => {
    const t = at.get(id);
    return t?.owner.kind === 'player' && t.owner.playerId === me && t.armies !== null;
  };
  const deployed = new Map<number, number>();
  for (const d of a.plain.deploys) deployed.set(d.territoryId, (deployed.get(d.territoryId) ?? 0) + d.armies);
  const after = (id: number) =>
    (at.get(id)?.armies ?? 0) +
    (deployed.get(id) ?? 0) -
    a.plain.moves.filter((m) => m.from === id).reduce((n, m) => n + m.armies, 0) +
    a.plain.moves.filter((m) => m.to === id && m.kind === 'transfer').reduce((n, m) => n + m.armies, 0);
  const candidates = board.territories
    .filter((t) => isMine(t.territoryId) && !t.specialUnits?.some((u) => u.kind === 'commander' && u.playerId === me))
    .map((t) => ({ target: t.territoryId, armies: after(t.territoryId), ...denialOf(a.input, t.territoryId) }))
    .filter((c) => c.denied > 0 && c.armies > 0)
    .map((c) => ({ ...c, wall: roundHalfDown(c.armies * a.multiplier) }))
    .sort((x, y) => y.denied - x.denied || y.wall - x.wall || x.target - y.target)
    .slice(0, MAX_WALL_CANDIDATES);
  if (!candidates.length) return { considered: 0 };
  // The stress-tested line: the plain plan's orders against each opponent beside my land at the plan's enemy deploy.
  const opponents = [
    ...new Set(
      board.territories.flatMap((t) =>
        t.owner.kind === 'player' && t.owner.playerId !== me && neighborsOf(graph, t.territoryId).some(isMine) ? [t.owner.playerId] : [],
      ),
    ),
  ].map((id) => ({ id, deploy: a.plain.enemyDeploy }));
  const report = stressPlan({
    graph,
    board,
    me,
    deploys: a.plain.deploys,
    moves: a.plain.moves.map((m) => ({ from: m.from, to: m.to, armies: m.armies, ...(m.commander ? { withCommander: true } : {}) })),
    opponents,
    ...(a.input.settings ? { settings: a.input.settings } : {}),
    lookAhead: false,
  });
  const falls = new Set(report.atRisk.territories.map((t) => t.id));
  const captured = new Set(a.plain.expected.captures);
  const conceded = new Set(a.plain.conceded);
  const mineAfter = (id: number) => (isMine(id) && !conceded.has(id)) || captured.has(id);
  let best: WallPlan | undefined;
  let considered = 0;
  for (const c of candidates) {
    considered++;
    if (falls.has(c.target) || report.baseline.captured.includes(c.target)) continue;
    const lost = [...graph.bonusById.values()]
      .filter((b) => b.value > 0 && b.territoryIds.includes(c.target) && b.territoryIds.every(mineAfter))
      .reduce((n, b) => n + b.value, 0);
    const scored = scoreOf(a.plain, c.denied);
    const score: PlanScore = {
      ...scored,
      twoTurn: scored.twoTurn - lost,
      safeIncome: scored.safeIncome - lost,
      nextIncome: scored.nextIncome - lost,
    };
    if (compareScores(score, plainScore) >= 0) continue;
    if (!best || compareScores(score, best.score) < 0) best = { plan: a.plain, wall: c, score, plainScore, considered: 0 };
  }
  if (best) best.considered = considered;
  return best ? { best, considered } : { considered };
}
