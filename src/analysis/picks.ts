// Pick advisor for manual-distribution games (docs/PLAN-PICKS.md, K1). Pure and
// deterministic (every choice tie-breaks on ascending id); no I/O. Advisory only —
// the owner submits with warapp_submit_picks.
//
// Model, in order:
//  1. Neutral sizes. A territory's neutral armies are the live board's count when
//     given (`neutralArmies`: wastelands at their real size), else
//     InitialNeutralsInDistribution for a pickable territory (an unpicked one turns
//     neutral) and InitialNonDistributionArmies for the rest. A capture costs
//     `captureCost` (the planner's: exact at the game's kill rates, 0% luck,
//     straight round, with a luck margin when luck > 0).
//  2. Opening simulation (`simulate`), PICK_HORIZON turns from a set of picks, each
//     starting with InitialPlayerArmiesPerTerritory. Movable armies (above the
//     guard) are one pool; each turn adds max(base income, floor(territories held /
//     BonusArmyPer)) (`territoryIncome`: the territory armies replace the base, never
//     add to it) + completed bonuses. Within a turn it repeatedly picks the bonus
//     (value > 0, not a superbonus, with a member in or next to the territories held) with
//     the best value / remaining capture cost that has a member next to a territory
//     held at the start of the turn, and attacks that bonus's cheapest such member;
//     when the pool cannot afford it, the armies are saved for the next turn. A
//     capture's survivors (minus a guard) join the pool next turn. A bonus held in
//     full by the picks themselves (a single-territory bonus) completes on turn 0;
//     one completed on turn 1 is a first-turn bonus (FTB).
//  3. Score of a pick set: Σ completed value × (PICK_HORIZON + 1 − turn) — the bonus
//     armies earned through turn PICK_HORIZON + 1 — plus PROGRESS_WEIGHT × value ×
//     share held for bonuses still incomplete, each bonus scaled by its
//     defensibility 1 / (1 + ENTRY_WEIGHT × entry points × hardness), where
//     hardness is how much dearer an attack is than at the standard 60/70 (at 30/75
//     a bonus with few entry points is worth more).
//  4. Contestedness. A pick's centrality is its mean hop distance to the other
//     pickable territories, normalised over the pickables (1 = most central). Its
//     score is scaled by 1 − contestWeight(players) × centrality: no penalty in a
//     1v1, growing CONTEST_PER_PLAYER per extra player up to CONTEST_MAX.
//  5. Groups. The primary group (min(TerritoryLimit, maxPicks) picks) starts from
//     the best-scoring pick and adds, greedily, the pick with the biggest marginal
//     gain in the joint simulation's score (× its contest factor), among picks
//     within COMPACT_DISTANCE hops of a pick already in the group — or, in a 1v1,
//     anchoring a bonus no group pick anchors (spreading against one counter-pick).
//     Ties: individual score, then id. When no candidate qualifies, the nearest one
//     is taken with a warning. The fallback group is built the same way from the
//     remaining pickables, up to maxPicks in total. Each group is listed by score.

import type { GameSettings } from '../normalize.js';
import { analyzeBonus } from './bonuses.js';
import { armiesToTake, DEFAULT_DEFENSIVE_KILL_RATE, DEFAULT_OFFENSIVE_KILL_RATE } from './combat.js';
import { bfsDistances, neighborsOf, type MapGraph } from './graph.js';
import { captureCost, WASTELAND_FACTOR } from './planner.js';
import { DEFAULT_BASE_INCOME, territoryIncome } from './player.js';

/** Turns the opening simulation runs (income by turn 3). */
export const PICK_HORIZON = 3;
/** Share of a still-incomplete bonus's value credited per share of it held at the horizon. */
export const PROGRESS_WEIGHT = 0.5;
/** Defensibility penalty per entry point (scaled by attack hardness). */
export const ENTRY_WEIGHT = 0.05;
/** Contest penalty per player beyond two… */
export const CONTEST_PER_PLAYER = 0.06;
/** …capped here. */
export const CONTEST_MAX = 0.5;
/** A group pick lies within this many hops of another pick in its group. */
export const COMPACT_DISTANCE = 2;
/** Defaults when the settings are missing (war.app's usual values). */
export const DEFAULT_PICK_ARMIES = 5;
export const DEFAULT_NEUTRALS_IN_DISTRIBUTION = 4;
export const DEFAULT_NON_DISTRIBUTION_ARMIES = 2;
/** Neutral size used to compare attack hardness against the standard kill rates. */
const HARDNESS_PROBE = 10;

export type PickSettings = Partial<
  Pick<
    GameSettings,
    | 'offensiveKillRate'
    | 'defensiveKillRate'
    | 'luckModifier'
    | 'roundingMode'
    | 'oneArmyStandsGuard'
    | 'minimumArmyBonus'
    | 'bonusArmyPer'
    | 'localDeployments'
    | 'initialPlayerArmiesPerTerritory'
    | 'initialNonDistributionArmies'
    | 'initialNeutralsInDistribution'
  >
>;

export interface PlanPicksInput {
  graph: MapGraph;
  /** Territories the live board lists as pickable. */
  pickable: readonly number[];
  settings?: PickSettings;
  /** Players in the game. */
  players: number;
  /** Territories each player is granted (TerritoryLimit). */
  territoryLimit: number;
  /** Most picks the game accepts (TerritoryLimit × 2). */
  maxPicks: number;
  /** Neutral armies as the live board shows them (wastelands included), by territory id. */
  neutralArmies?: ReadonlyMap<number, number>;
}

export type PickGroupName = 'primary' | 'fallback';

export interface PickChoice {
  territoryId: number;
  group: PickGroupName;
  /** The pick's own score (bonus armies earned in the opening, defensibility- and contest-weighted). */
  score: number;
  reasons: string[];
}

export interface GroupBonus {
  bonusId: number;
  name: string;
  value: number;
  /** Turn the group completes it in the opening simulation (0: held by the picks themselves). */
  turn: number;
}

export interface PickGroup {
  /** In pick order (score desc, then id). */
  territoryIds: number[];
  /** The group's joint simulation score. */
  score: number;
  /** Bonuses the group completes within PICK_HORIZON turns. */
  bonuses: GroupBonus[];
}

export interface PickPlan {
  picks: PickChoice[];
  groups: { primary: PickGroup; fallback: PickGroup };
  warnings: string[];
  rationale: string[];
}

const byNum = (a: number, b: number) => a - b;
const round2 = (x: number) => Math.round(x * 100) / 100;

interface BonusInfo {
  id: number;
  name: string;
  value: number;
  members: number[];
  entryPoints: number;
  defense: number;
}

interface Ctx {
  g: MapGraph;
  cost: Map<number, number | null>;
  lost: Map<number, number>;
  armies: Map<number, number>;
  bonuses: Map<number, BonusInfo>;
  /** Territory → bonus ids (value > 0, not superbonuses). */
  bonusesOf: Map<number, number[]>;
  pickArmies: number;
  guard: number;
  baseIncome: number;
  bonusArmyPer: number;
}

interface SimResult {
  completions: Map<number, number>;
  /** Share held at the horizon, for bonuses touched but not completed. */
  progress: Map<number, number>;
  score: number;
}

function simulate(ctx: Ctx, start: readonly number[]): SimResult {
  const held = new Set(start);
  let pool = start.length * Math.max(0, ctx.pickArmies - ctx.guard);
  const completions = new Map<number, number>();
  const relevant = (from: Iterable<number>) => {
    const ids = new Set<number>();
    for (const t of from) {
      for (const b of ctx.bonusesOf.get(t) ?? []) ids.add(b);
      for (const n of neighborsOf(ctx.g, t)) for (const b of ctx.bonusesOf.get(n) ?? []) ids.add(b);
    }
    return [...ids].sort(byNum);
  };
  const checkComplete = (turn: number) => {
    for (const id of relevant(held)) {
      if (completions.has(id)) continue;
      if (ctx.bonuses.get(id)!.members.every((m) => held.has(m))) completions.set(id, turn);
    }
  };
  checkComplete(0);
  for (let turn = 1; turn <= PICK_HORIZON; turn++) {
    let income = territoryIncome(held.size, ctx.baseIncome, ctx.bonusArmyPer);
    for (const id of completions.keys()) income += ctx.bonuses.get(id)!.value;
    pool += income;
    const startHeld = [...held];
    const frontier = new Set<number>();
    for (const t of startHeld) for (const n of neighborsOf(ctx.g, t)) if (!held.has(n)) frontier.add(n);
    const captured = new Set<number>();
    let gain = 0;
    for (;;) {
      let best: { id: number; ratio: number; rem: number; target: number; cost: number } | null = null;
      for (const id of relevant(startHeld)) {
        if (completions.has(id)) continue;
        const b = ctx.bonuses.get(id)!;
        let rem = 0;
        let target: number | null = null;
        let targetCost = Infinity;
        let blocked = false;
        for (const m of b.members) {
          if (held.has(m) || captured.has(m)) continue;
          const c = ctx.cost.get(m);
          if (c === null || c === undefined) {
            blocked = true;
            break;
          }
          rem += c;
          if (frontier.has(m) && (c < targetCost || (c === targetCost && m < target!))) {
            target = m;
            targetCost = c;
          }
        }
        if (blocked || target === null || rem === 0) continue;
        const ratio = b.value / rem;
        if (!best || ratio > best.ratio || (ratio === best.ratio && (rem < best.rem || (rem === best.rem && id < best.id))))
          best = { id, ratio, rem, target, cost: targetCost };
      }
      if (!best || best.cost > pool) break;
      pool -= best.cost;
      captured.add(best.target);
      gain += Math.max(0, best.cost - ctx.lost.get(best.target)! - ctx.guard);
    }
    for (const t of captured) held.add(t);
    pool += gain;
    checkComplete(turn);
  }
  const progress = new Map<number, number>();
  let score = 0;
  for (const id of relevant(held)) {
    const b = ctx.bonuses.get(id)!;
    const turn = completions.get(id);
    if (turn !== undefined) {
      score += b.value * (PICK_HORIZON + 1 - turn) * b.defense;
      continue;
    }
    const share = b.members.filter((m) => held.has(m)).length / b.members.length;
    if (share > 0) {
      progress.set(id, share);
      score += PROGRESS_WEIGHT * b.value * share * b.defense;
    }
  }
  return { completions, progress, score };
}

function luckPercent(v: number | undefined): number {
  if (!v || v <= 0) return 0;
  return Math.round(Math.min(v > 1 ? v / 100 : v, 0.95) * 100);
}

export function planPicks(input: PlanPicksInput): PickPlan {
  const { graph: g } = input;
  const s = input.settings ?? {};
  const warnings: string[] = [];
  const rationale: string[] = [];

  // Pickable territories: known, unique, sorted.
  const unknown: number[] = [];
  const pickSet = new Set<number>();
  for (const t of input.pickable) {
    if (g.territoryById.has(t)) pickSet.add(t);
    else if (!unknown.includes(t)) unknown.push(t);
  }
  if (unknown.length) warnings.push(`Ignored pickable ids not on the map: ${unknown.sort(byNum).join(', ')}.`);
  const pickable = [...pickSet].sort(byNum);

  // Settings and assumptions.
  const pickArmies = s.initialPlayerArmiesPerTerritory ?? DEFAULT_PICK_ARMIES;
  if (s.initialPlayerArmiesPerTerritory === undefined)
    warnings.push(`Starting armies per picked territory missing from settings; assumed ${DEFAULT_PICK_ARMIES}.`);
  const baseIncome = s.minimumArmyBonus ?? DEFAULT_BASE_INCOME;
  if (s.minimumArmyBonus === undefined)
    warnings.push(`Base income missing from settings; assumed ${DEFAULT_BASE_INCOME}.`);
  const off = s.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  const def = s.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  if (s.offensiveKillRate === undefined || s.defensiveKillRate === undefined)
    warnings.push(`Kill rates missing from settings; assumed ${off}/${def} (offence/defence).`);
  const neutralsIn = s.initialNeutralsInDistribution ?? DEFAULT_NEUTRALS_IN_DISTRIBUTION;
  const neutralsOut = s.initialNonDistributionArmies ?? DEFAULT_NON_DISTRIBUTION_ARMIES;
  const known = input.neutralArmies ?? new Map<number, number>();
  const missingIn = s.initialNeutralsInDistribution === undefined && pickable.some((t) => !known.has(t));
  const missingOut =
    s.initialNonDistributionArmies === undefined &&
    g.map.territories.some((t) => !pickSet.has(t.id) && !known.has(t.id));
  if (missingIn)
    warnings.push(
      `Neutral size of unpicked pickable territories missing from settings; assumed ${DEFAULT_NEUTRALS_IN_DISTRIBUTION}.`,
    );
  if (missingOut)
    warnings.push(
      `Neutral size of territories outside the distribution missing from settings (and not on the board); assumed ${DEFAULT_NON_DISTRIBUTION_ARMIES}.`,
    );
  const luck = luckPercent(s.luckModifier);
  if (luck > 0) warnings.push(`Luck is ${luck}%: capture costs carry a margin and can still fail.`);
  if (s.roundingMode !== undefined && s.roundingMode !== 'StraightRound')
    warnings.push(`Capture costs assume straight rounding; this game uses ${s.roundingMode}.`);
  if (s.localDeployments)
    warnings.push('Local deployments are on: bonus income must be deployed inside its bonus; the model pools it.');

  const guard = s.oneArmyStandsGuard === false ? 0 : 1;
  const rates = { offensiveKillRate: off, defensiveKillRate: def, luckModifier: s.luckModifier };

  // Per-territory capture cost.
  const armies = new Map<number, number>();
  const cost = new Map<number, number | null>();
  const lost = new Map<number, number>();
  for (const t of g.map.territories) {
    const n = Math.max(0, known.get(t.id) ?? (pickSet.has(t.id) ? neutralsIn : neutralsOut));
    armies.set(t.id, n);
    cost.set(t.id, captureCost(n, rates));
    lost.set(t.id, Math.round((n * def) / 100));
  }

  // Attack hardness vs the standard kill rates, for defensibility.
  const probe = armiesToTake(HARDNESS_PROBE, { offensiveKillRate: off, defensiveKillRate: def });
  const standard = armiesToTake(HARDNESS_PROBE)!;
  const hardness = probe === null ? 4 : Math.max(0.25, probe / standard);

  // Anchorable bonuses: value > 0, territories listed directly (superbonuses skipped).
  const bonuses = new Map<number, BonusInfo>();
  const bonusesOf = new Map<number, number[]>();
  for (const b of g.map.bonuses) {
    if (b.value <= 0 || b.bonusIds.length > 0) continue;
    const a = analyzeBonus(g, b.id)!;
    const members = a.territoryIds.filter((t) => g.territoryById.has(t));
    if (!members.length) continue;
    const entryPoints = a.entryPointIds.length;
    bonuses.set(b.id, {
      id: b.id,
      name: b.name,
      value: b.value,
      members,
      entryPoints,
      defense: 1 / (1 + ENTRY_WEIGHT * entryPoints * hardness),
    });
    for (const t of members) bonusesOf.set(t, [...(bonusesOf.get(t) ?? []), b.id]);
  }

  const ctx: Ctx = {
    g,
    cost,
    lost,
    armies,
    bonuses,
    bonusesOf,
    pickArmies,
    guard,
    baseIncome,
    bonusArmyPer: s.bonusArmyPer ?? 0,
  };

  // Contestedness from centrality among the pickables.
  const players = Math.max(1, Math.floor(input.players));
  const contestWeight = Math.min(CONTEST_MAX, Math.max(0, (players - 2) * CONTEST_PER_PLAYER));
  const meanDist = new Map<number, number>();
  for (const t of pickable) {
    const d = bfsDistances(g, [t]);
    let sum = 0;
    let count = 0;
    for (const o of pickable) {
      if (o === t || !d.has(o)) continue;
      sum += d.get(o)!;
      count++;
    }
    if (count) meanDist.set(t, sum / count);
  }
  const means = [...meanDist.values()];
  const lo = Math.min(...means);
  const hi = Math.max(...means);
  const centrality = (t: number) => {
    const m = meanDist.get(t);
    return m === undefined || hi === lo ? 0 : (hi - m) / (hi - lo);
  };
  const contestFactor = (t: number) => 1 - contestWeight * centrality(t);

  // Individual scores and reasons.
  const scores = new Map<number, number>();
  const anchors = new Map<number, number | null>();
  const reasons = new Map<number, string[]>();
  const terrName = (id: number) => g.territoryById.get(id)?.name ?? String(id);
  for (const t of pickable) {
    const sim = simulate(ctx, [t]);
    const factor = contestFactor(t);
    scores.set(t, round2(sim.score * factor));
    const why: string[] = [];
    let anchor: { id: number; worth: number } | null = null;
    const touched = [...new Set([...sim.completions.keys(), ...sim.progress.keys()])].sort(byNum);
    for (const id of touched) {
      const b = bonuses.get(id)!;
      const turn = sim.completions.get(id);
      const head = `${b.name} (+${b.value})`;
      const entries = `${b.entryPoints} entry point${b.entryPoints === 1 ? '' : 's'}`;
      let worth: number;
      if (turn === 0) {
        why.push(`${head}: held at once (single-territory bonus); ${entries}`);
        worth = b.value * (PICK_HORIZON + 1);
      } else if (turn !== undefined) {
        why.push(`${head}: ${turn === 1 ? 'first-turn bonus' : `complete on turn ${turn}`}; ${entries}`);
        worth = b.value * (PICK_HORIZON + 1 - turn);
      } else {
        // The pick itself is held; the rest are captured. A member that cannot be
        // taken at these kill rates makes the bonus unreachable, not cheaper.
        const rest = b.members.filter((m) => m !== t).map((m) => cost.get(m));
        const left = rest.some((c) => c === null || c === undefined)
          ? 'a member cannot be taken at these kill rates'
          : `~${rest.reduce((acc: number, c) => acc + (c as number), 0)} armies to take the rest`;
        why.push(`${head}: not complete within ${PICK_HORIZON} turns (${left}); ${entries}`);
        worth = PROGRESS_WEIGHT * b.value * sim.progress.get(id)!;
      }
      worth *= b.defense;
      if (!anchor || worth > anchor.worth) anchor = { id, worth };
      const waste = b.members.filter((m) => (cost.get(m) ?? Infinity) > WASTELAND_FACTOR * b.value).sort(byNum);
      if (waste.length)
        why.push(
          `${head} holds a wasteland: ${waste.map((m) => `${terrName(m)} (${armies.get(m)} armies)`).join(', ')}`,
        );
    }
    if (!why.length) why.push(`No bonus within reach in ${PICK_HORIZON} turns`);
    if (contestWeight > 0 && 1 - factor >= 0.05)
      why.push(`Central: likely contested with ${players} players (score −${Math.round((1 - factor) * 100)}%)`);
    reasons.set(t, why);
    anchors.set(t, anchor?.id ?? null);
  }
  const byScore = (a: number, b: number) => scores.get(b)! - scores.get(a)! || a - b;

  // Groups.
  const spread = players <= 2;
  let relaxed = false;
  const buildGroup = (pool: number[], size: number): number[] => {
    const group: number[] = [];
    if (size <= 0 || !pool.length) return group;
    const left = new Set(pool);
    const first = [...left].sort(byScore)[0]!;
    group.push(first);
    left.delete(first);
    let current = simulate(ctx, group).score;
    const distTo = new Map<number, number>();
    const updateDist = (t: number) => {
      const d = bfsDistances(g, [t]);
      for (const c of left) {
        const v = d.get(c) ?? Infinity;
        if (v < (distTo.get(c) ?? Infinity)) distTo.set(c, v);
      }
    };
    updateDist(first);
    while (group.length < size && left.size) {
      const anchored = new Set(group.map((t) => anchors.get(t)));
      const all = [...left].sort(byNum);
      let eligible = all.filter(
        (c) =>
          (distTo.get(c) ?? Infinity) <= COMPACT_DISTANCE ||
          (spread && anchors.get(c) != null && !anchored.has(anchors.get(c))),
      );
      if (!eligible.length) {
        relaxed = true;
        const nearest = Math.min(...all.map((c) => distTo.get(c) ?? Infinity));
        eligible = all.filter((c) => (distTo.get(c) ?? Infinity) === nearest);
      }
      let best: { t: number; gain: number; total: number } | null = null;
      for (const c of eligible) {
        const total = simulate(ctx, [...group, c]).score;
        const gain = round2((total - current) * contestFactor(c));
        if (
          !best ||
          gain > best.gain ||
          (gain === best.gain && (scores.get(c)! > scores.get(best.t)! || (scores.get(c) === scores.get(best.t) && c < best.t)))
        )
          best = { t: c, gain, total };
      }
      group.push(best!.t);
      left.delete(best!.t);
      current = best!.total;
      updateDist(best!.t);
    }
    return group.sort(byScore);
  };

  const maxPicks = Math.max(0, Math.floor(input.maxPicks));
  const limit = Math.max(0, Math.floor(input.territoryLimit));
  const primarySize = Math.min(limit, maxPicks, pickable.length);
  if (pickable.length < limit)
    warnings.push(
      `Only ${pickable.length} pickable territor${pickable.length === 1 ? 'y' : 'ies'} for a limit of ${limit}: the list has no full fallback.`,
    );
  const primary = buildGroup(pickable, primarySize);
  const rest = pickable.filter((t) => !primary.includes(t));
  const fallback = buildGroup(rest, Math.min(maxPicks - primary.length, rest.length));
  if (relaxed) warnings.push(`No pick within ${COMPACT_DISTANCE} hops was left for a group: the nearest one was taken.`);

  const groupOf = (ids: number[]): PickGroup => {
    if (!ids.length) return { territoryIds: [], score: 0, bonuses: [] };
    const sim = simulate(ctx, ids);
    const done = [...sim.completions.entries()]
      .map(([id, turn]) => ({ bonusId: id, name: bonuses.get(id)!.name, value: bonuses.get(id)!.value, turn }))
      .sort((a, b) => a.turn - b.turn || a.bonusId - b.bonusId);
    return { territoryIds: ids, score: round2(sim.score), bonuses: done };
  };

  const picks: PickChoice[] = [
    ...primary.map((t) => ({ territoryId: t, group: 'primary' as const, score: scores.get(t)!, reasons: reasons.get(t)! })),
    ...fallback.map((t) => ({ territoryId: t, group: 'fallback' as const, score: scores.get(t)!, reasons: reasons.get(t)! })),
  ];

  rationale.push(
    `Each pick is scored by the bonus armies it earns through turn ${PICK_HORIZON + 1} in a ${PICK_HORIZON}-turn opening simulation: ` +
      `${pickArmies} starting armies, ${baseIncome} base income, capture costs at ${off}/${def} kill rates against the neutrals' real sizes.`,
    `Bonuses are weighted by defensibility (fewer entry points is better${hardness > 1 ? '; attacks here are dearer than at 60/70, so this weighs more' : ''}).`,
    contestWeight > 0
      ? `With ${players} players central picks are likely contested: scores drop by up to ${Math.round(contestWeight * 100)}% with centrality.`
      : `In a 1v1 centrality is not penalised; picks may spread across different bonuses so one counter-pick cannot wipe them.`,
    `The first ${primary.length} picks form a compact primary group (each within ${COMPACT_DISTANCE} hops of another); ` +
      `the rest are a disjoint fallback, granted in order when another player picks first.`,
  );

  return { picks, groups: { primary: groupOf(primary), fallback: groupOf(fallback) }, warnings, rationale };
}
