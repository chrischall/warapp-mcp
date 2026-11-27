// The model's strategy inputs (#606): the mechanics of a turn laid out as ranked options, and two or three
// alternative full plans, so the calling model can choose — or override the default plan with a reason the
// decision log keeps (#412). Pure and deterministic: no plan reads it, and the default plan is unchanged.
//
// - `captureOptions`: every territory in view beside mine that is not mine, with what taking it costs (its
//   defenders, and with its owner's whole deploy landed first), where the armies come from, what it completes or
//   advances, and how many new borders facing a player it opens. Ranked by income gained per army, then by the
//   bonus it brings nearest, then by cost.
// - `holdOptions`: every border of mine facing a player, with the armies needed to hold against the stacks beside
//   it and against those stacks plus the whole deploy (one deploy lands on one border), and what it protects.
// - `alternativePlans`: the default plan and the planner under other goals, each with its orders, what it expects
//   and (when the caller passes a stress test) how it fares against the opponents' replies. Identical plans are
//   listed once.
import type { BoardState, TerritoryState } from '../board.js';
import { bonusTerritories } from './bonuses.js';
import { armiesToTake } from './combat.js';
import { neighborsOf, type MapGraph } from './graph.js';
import { planTurn, type PlanGoal, type PlanInput, type TurnPlan } from './planner.js';

/** Said with every `strategy` view: what the options are, and what they are not. */
export const STRATEGY_NOTE =
  'Mechanics, not advice: capture costs at the game\'s kill rates with no luck beyond them, deploy estimates as warapp_plan_turn ' +
  'reads them, and each alternative stress-tested against single-deploy replies only (as warapp_check_plan). The default ' +
  'plan is the planner\'s pick; choosing another or your own is yours to judge — check it with warapp_check_plan.';

/** The most options of each kind listed. */
export const MAX_OPTIONS = 15;

export interface CaptureOption {
  target: number;
  /** `neutral`, or the owner's GameFeed id. */
  owner: 'neutral' | number;
  defenders: number;
  /** Attackers that take it as it stands (`null`: no attack can, at these kill rates). */
  needs: number | null;
  /** A player's territory: attackers that take it after its owner lands its whole deploy there. */
  needsIfReinforced?: number | null;
  /** My territories beside it and the armies each can send without deploying (all but the guard). */
  from: { territoryId: number; spare: number }[];
  /** Bonuses the capture completes, with their values. */
  completes: { bonusId: number; value: number }[];
  /** Positive bonuses it advances without completing, and the members still missing after it. */
  advances: { bonusId: number; value: number; missingAfter: number }[];
  /** Income gained next turn (the bonuses it completes). */
  incomeGain: number;
  /** Territories of a player beside it that no territory of mine borders now: new borders facing a player. */
  opensBorders: number;
}

export interface HoldOption {
  territoryId: number;
  armies: number;
  /** Each player with a stack beside it: its movable armies beside it and its deploy estimate. */
  facing: { player: number; stacks: number; deploy: number }[];
  /** Armies to add so it holds against the stacks beside it alone (0: it holds). */
  addAgainstStacks: number;
  /** Armies to add so it holds against those stacks plus one player's whole deploy landed beside it. */
  addAgainstDeploy: number;
  /** Positive bonuses I hold in full that it is a member of. */
  protects: { bonusId: number; value: number }[];
}

export interface OptionsInput {
  graph: MapGraph;
  board: BoardState;
  me: number;
  /** Each opponent's deploy estimate (the plan's `enemyDeployDetail`); unknown: 0. */
  deployOf: (player: number) => number;
  rates: { offensiveKillRate?: number; defensiveKillRate?: number };
  /** One army must stand guard (default true). */
  guard?: boolean;
  /** Players never counted as opponents (teammates). */
  friends?: ReadonlySet<number>;
}

const ownerOf = (t: TerritoryState | undefined): 'neutral' | number | null =>
  t?.owner.kind === 'neutral' ? 'neutral' : t?.owner.kind === 'player' ? t.owner.playerId : null;

/** The capture and hold options on this board, ranked. */
export function turnOptions(input: OptionsInput, limit = MAX_OPTIONS): { captures: CaptureOption[]; holds: HoldOption[] } {
  const { graph: g, board, me } = input;
  const state = new Map(board.territories.map((t) => [t.territoryId, t]));
  const guard = input.guard === false ? 0 : 1;
  const mine = new Set(board.territories.filter((t) => ownerOf(t) === me).map((t) => t.territoryId));
  const foe = (o: 'neutral' | number | null): o is number => typeof o === 'number' && o !== me && !input.friends?.has(o);
  const armies = (t: number) => state.get(t)?.armies ?? 0;
  const take = (defenders: number) => armiesToTake(defenders, input.rates);
  const bonusesOf = new Map<number, number[]>();
  for (const b of g.map.bonuses) for (const t of bonusTerritories(g, b.id)) bonusesOf.set(t, [...(bonusesOf.get(t) ?? []), b.id]);
  const missing = (bonusId: number, held: ReadonlySet<number>) => bonusTerritories(g, bonusId).filter((t) => !held.has(t)).length;

  const captures: CaptureOption[] = [];
  const seen = new Set<number>();
  for (const m of [...mine].sort((a, b) => a - b))
    for (const t of neighborsOf(g, m)) {
      if (mine.has(t) || seen.has(t)) continue;
      seen.add(t);
      const st = state.get(t);
      const owner = ownerOf(st);
      if (owner === null || st!.armies === null) continue;
      if (typeof owner === 'number' && input.friends?.has(owner)) continue;
      const defenders = st!.armies;
      const after = new Set([...mine, t]);
      const completes: CaptureOption['completes'] = [];
      const advances: CaptureOption['advances'] = [];
      for (const id of bonusesOf.get(t) ?? []) {
        const b = g.bonusById.get(id)!;
        if (b.value <= 0) continue;
        const left = missing(id, after);
        if (left === 0) completes.push({ bonusId: id, value: b.value });
        else advances.push({ bonusId: id, value: b.value, missingAfter: left });
      }
      const opens = neighborsOf(g, t).filter(
        (n) => !mine.has(n) && foe(ownerOf(state.get(n))) && !neighborsOf(g, n).some((x) => mine.has(x)),
      ).length;
      captures.push({
        target: t,
        owner,
        defenders,
        needs: take(defenders),
        ...(typeof owner === 'number' ? { needsIfReinforced: take(defenders + Math.max(0, input.deployOf(owner))) } : {}),
        from: neighborsOf(g, t)
          .filter((n) => mine.has(n))
          .map((n) => ({ territoryId: n, spare: Math.max(0, armies(n) - guard) }))
          .sort((a, b) => b.spare - a.spare || a.territoryId - b.territoryId),
        completes,
        advances: advances.sort((a, b) => a.missingAfter - b.missingAfter || b.value - a.value || a.bonusId - b.bonusId),
        incomeGain: completes.reduce((n, c) => n + c.value, 0),
        opensBorders: opens,
      });
    }
  const nearest = (c: CaptureOption) => (c.advances.length ? c.advances[0]!.missingAfter : Infinity);
  const cost = (c: CaptureOption) => c.needs ?? Infinity;
  captures.sort(
    (a, b) =>
      b.incomeGain / Math.max(1, cost(b)) - a.incomeGain / Math.max(1, cost(a)) ||
      nearest(a) - nearest(b) ||
      cost(a) - cost(b) ||
      a.target - b.target,
  );

  const holds: HoldOption[] = [];
  for (const t of [...mine].sort((a, b) => a - b)) {
    const byPlayer = new Map<number, number>();
    for (const n of neighborsOf(g, t)) {
      const o = ownerOf(state.get(n));
      if (!foe(o)) continue;
      byPlayer.set(o, (byPlayer.get(o) ?? 0) + Math.max(0, armies(n) - guard));
    }
    if (!byPlayer.size) continue;
    const have = armies(t);
    const facing = [...byPlayer].sort((a, b) => a[0] - b[0]).map(([player, stacks]) => ({ player, stacks, deploy: Math.max(0, input.deployOf(player)) }));
    /** Armies to add to `have` so `attack` attackers do not take it. */
    const add = (attack: number) => {
      let n = 0;
      while ((take(have + n) ?? Infinity) <= attack) n++;
      return n;
    };
    const stacks = Math.max(...facing.map((f) => f.stacks));
    const deployed = Math.max(...facing.map((f) => f.stacks + f.deploy));
    const protects = (bonusesOf.get(t) ?? [])
      .map((id) => g.bonusById.get(id)!)
      .filter((b) => b.value > 0 && bonusTerritories(g, b.id).every((x) => mine.has(x)))
      .map((b) => ({ bonusId: b.id, value: b.value }));
    holds.push({ territoryId: t, armies: have, facing, addAgainstStacks: add(stacks), addAgainstDeploy: add(deployed), protects });
  }
  const worth = (h: HoldOption) => h.protects.reduce((n, p) => n + p.value, 0);
  holds.sort((a, b) => worth(b) - worth(a) || b.addAgainstDeploy - a.addAgainstDeploy || a.territoryId - b.territoryId);
  return { captures: captures.slice(0, limit), holds: holds.slice(0, limit) };
}

/** How a plan fares against the opponents' replies (a summary of warapp_check_plan's stress test). */
export interface StressSummary {
  /** No reply tried costs anything (`null`: nothing could be tried). */
  safe: boolean | null;
  harmful: number;
  considered: number;
  /** The worst reply: what it takes from me. */
  worst?: { opponent: number; lost: number[]; capturesFailed: number[]; incomeLost: number };
}

export interface AlternativePlan {
  /** `default` (the plan warapp_plan_turn returns), or the goal it was planned under. */
  name: 'default' | PlanGoal;
  goal: PlanGoal;
  deploys: { territoryId: number; armies: number }[];
  moves: { from: number; to: number; armies: number; kind: string }[];
  expected: { nextIncome: number; captures: number[]; bonusesCompleted: number[]; nextIncomeIfConcededFall?: number };
  conceded: number[];
  stress?: StressSummary;
}

/** The other goals an alternative plan is made under. */
export const ALTERNATIVE_GOALS: readonly PlanGoal[] = ['expand', 'defend'];

/**
 * The default plan and the planner under {@link ALTERNATIVE_GOALS} (each a goal the default did not pick), each with
 * its orders, what it expects and (`stress` given) its stress summary. A plan whose orders match one already listed
 * is left out.
 */
export function alternativePlans(input: PlanInput, base: TurnPlan, stress?: (p: TurnPlan) => StressSummary | undefined): AlternativePlan[] {
  const view = (name: AlternativePlan['name'], p: TurnPlan): AlternativePlan => {
    const s = stress?.(p);
    return {
      name,
      goal: p.goal,
      deploys: p.deploys.map((d) => ({ territoryId: d.territoryId, armies: d.armies })),
      moves: p.moves.map((m) => ({ from: m.from, to: m.to, armies: m.armies, kind: m.kind })),
      expected: {
        nextIncome: p.expected.nextIncome,
        captures: p.expected.captures,
        bonusesCompleted: p.expected.bonusesCompleted,
        ...(p.expected.nextIncomeIfConcededFall !== undefined ? { nextIncomeIfConcededFall: p.expected.nextIncomeIfConcededFall } : {}),
      },
      conceded: p.conceded,
      ...(s ? { stress: s } : {}),
    };
  };
  const key = (p: TurnPlan) => JSON.stringify([p.deploys.map((d) => [d.territoryId, d.armies]), p.moves.map((m) => [m.from, m.to, m.armies])]);
  const out = [view('default', base)];
  const keys = new Set([key(base)]);
  for (const goal of ALTERNATIVE_GOALS) {
    if (goal === base.goal) continue;
    const p = planTurn({ ...input, options: { ...input.options, goal } });
    if (keys.has(key(p))) continue;
    keys.add(key(p));
    out.push(view(goal, p));
  }
  return out;
}

/** A stress report boiled down to what a choice between plans needs. */
export function stressSummary(r: {
  considered: number;
  harmful: number;
  worst?: { opponent: number; lost: number[]; capturesFailed: number[]; incomeLost: number };
}): StressSummary {
  return {
    safe: r.considered === 0 ? null : r.harmful === 0,
    harmful: r.harmful,
    considered: r.considered,
    ...(r.worst
      ? { worst: { opponent: r.worst.opponent, lost: r.worst.lost, capturesFailed: r.worst.capturesFailed, incomeLost: r.worst.incomeLost } }
      : {}),
  };
}
