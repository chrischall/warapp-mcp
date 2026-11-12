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
//     starting with InitialPlayerArmiesPerTerritory. Armies stay where they stand:
//     each turn's income is max(base income, floor(territories held / BonusArmyPer))
//     (`territoryIncome`: the territory armies replace the base, never add to it, #38)
//     + completed bonuses. Within a turn it
//     repeatedly picks the bonus (value > 0, not a superbonus, with a member in or next
//     to the territories held) with the best value / remaining capture cost that has a
//     member next to a territory held at the start of the turn, and attacks that bonus's
//     cheapest such member from one bordering start-of-turn territory (the one with the
//     most movable armies, i.e. above the guard), topped up by the turn's unspent income
//     (deployed there). When that cannot afford it, the rest of the income is deployed on
//     that source and saved for the next turn, and the next-best bonuses are still tried
//     with the movable armies of other sources alone. A capture's survivors stay on the captured
//     territory and attack from there next turn (captured armies never attack the turn
//     they capture). A bonus held in full by the picks themselves (a single-territory
//     bonus) completes on turn 0; one completed on turn 1 is a first-turn bonus (FTB).
//     (Before #47 every pick's armies and the captured survivors were one pool, so a
//     bonus was "completed" with armies on picks nowhere near it.)
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
//  5. Groups. The primary group (min(TerritoryLimit, maxPicks) picks) grows from a seed
//     by adding, greedily, the pick with the biggest marginal gain in the joint
//     simulation's score (× its contest factor), among picks within COMPACT_DISTANCE hops
//     (on the map graph warapp_plan_route uses) of a pick already in the group — or, in
//     a 1v1, anchoring a bonus no group pick anchors and within SPREAD_DISTANCE hops
//     (spreading against one counter-pick, bounded). Ties: individual score, then id.
//     Seeds are tried best score first; when none grows a full group, the hop limit
//     relaxes by one, with a warning, until one does. In a 1v1 the bound also gives way,
//     with a warning, at the smallest hop limit where a group scores SPREAD_RELAX_GAIN
//     times the bounded one — the bound must not quietly hand the best picks to the
//     fallback. The fallback group is built the same way from the remaining pickables,
//     up to maxPicks in total; a fallback that still outscores the primary is warned
//     about. Each group is listed by score; its maxHops and the rationale state its real
//     spread (farthest pair, and the longest step linking its picks into one cluster) and
//     call it compact only when that step is at most COMPACT_DISTANCE: one cluster, not
//     merely each pick with a group-mate nearby.
//  6. Reasons. reasons[0] is the bonus the pick anchors (worth most to it alone) and its
//     completion turn and the income it adds, or how much of it is held by the horizon;
//     then the other bonuses it completes or advances; negatives (shortfalls,
//     wastelands, contest) come last.

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
/** A group pick lies within this many hops of another pick in its group… */
export const COMPACT_DISTANCE = 2;
/** …or, in a 1v1, within this many when it anchors a bonus no other group pick anchors. */
export const SPREAD_DISTANCE = 4;
/** A 1v1 group spreads past SPREAD_DISTANCE only when that scores at least this many times as much. */
export const SPREAD_RELAX_GAIN = 1.5;
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
  /** Hops between the group's two farthest picks on the map graph (`null`: not connected). */
  maxHops: number | null;
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
  // Armies on each held territory: armies attack only from where they stand.
  const armiesOn = new Map<number, number>(start.map((t) => [t, ctx.pickArmies]));
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
    let budget = territoryIncome(held.size, ctx.baseIncome, ctx.bonusArmyPer);
    for (const id of completions.keys()) budget += ctx.bonuses.get(id)!.value;
    const startHeld = [...held].sort(byNum);
    const startSet = new Set(startHeld);
    // Movable armies of the territories held at the start of the turn (captured ones never attack).
    const avail = new Map(startHeld.map((t) => [t, Math.max(0, armiesOn.get(t)! - ctx.guard)]));
    const captured = new Set<number>();
    // Where this turn's unspent deploys go: the source of the attack it is saving for.
    // Once set, the deploys are reserved for it; other sources still attack with their own armies.
    let saveAt: number | null = null;
    // Bonuses whose next capture cannot be paid for this turn.
    const skipped = new Set<number>();
    for (;;) {
      let best: { id: number; ratio: number; rem: number; target: number; cost: number } | null = null;
      for (const id of relevant(startHeld)) {
        if (completions.has(id) || skipped.has(id)) continue;
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
          const reachable = neighborsOf(ctx.g, m).some((n) => startSet.has(n));
          if (reachable && (c < targetCost || (c === targetCost && m < target!))) {
            target = m;
            targetCost = c;
          }
        }
        if (blocked || target === null || rem === 0) continue;
        const ratio = b.value / rem;
        if (!best || ratio > best.ratio || (ratio === best.ratio && (rem < best.rem || (rem === best.rem && id < best.id))))
          best = { id, ratio, rem, target, cost: targetCost };
      }
      if (!best) break;
      // The attack comes from one bordering territory held at the start of the turn —
      // the one with the most movable armies (then id) — topped up by this turn's deploys
      // unless they are already reserved for an attack saved for next turn.
      let source = -1;
      for (const n of neighborsOf(ctx.g, best.target)) {
        if (!startSet.has(n) || n === saveAt) continue;
        if (source < 0 || avail.get(n)! > avail.get(source)!) source = n;
      }
      const own = source < 0 ? 0 : avail.get(source)!;
      const deploy = saveAt === null ? budget : 0;
      if (source < 0 || own + deploy < best.cost) {
        // Save the deploys for the best bonus; try the next one with what else stands idle.
        if (saveAt === null && source >= 0) saveAt = source;
        skipped.add(best.id);
        continue;
      }
      const fromOwn = Math.min(own, best.cost);
      avail.set(source, own - fromOwn);
      armiesOn.set(source, armiesOn.get(source)! - fromOwn);
      budget -= best.cost - fromOwn;
      captured.add(best.target);
      armiesOn.set(best.target, Math.max(0, best.cost - ctx.lost.get(best.target)!));
    }
    if (budget > 0 && startHeld.length) {
      const at = saveAt ?? startHeld[0]!;
      armiesOn.set(at, armiesOn.get(at)! + budget);
    }
    for (const t of captured) held.add(t);
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

  // Individual scores and reasons. reasons[0] is the point of the pick: the bonus it
  // anchors (worth most to it) and when it completes, or how far it gets; then the other
  // bonuses it helps; the negatives (shortfalls, wastelands, contest) come last.
  const scores = new Map<number, number>();
  const anchors = new Map<number, number | null>();
  const reasons = new Map<number, string[]>();
  const terrName = (id: number) => g.territoryById.get(id)?.name ?? String(id);
  for (const t of pickable) {
    const sim = simulate(ctx, [t]);
    const factor = contestFactor(t);
    scores.set(t, round2(sim.score * factor));
    const lines: { id: number; worth: number; point: string; negatives: string[] }[] = [];
    const touched = [...new Set([...sim.completions.keys(), ...sim.progress.keys()])].sort(byNum);
    for (const id of touched) {
      const b = bonuses.get(id)!;
      const turn = sim.completions.get(id);
      const head = `${b.name} (+${b.value})`;
      const entries = `${b.entryPoints} entry point${b.entryPoints === 1 ? '' : 's'}`;
      const negatives: string[] = [];
      let point: string;
      let worth: number;
      if (turn === 0) {
        point = `${head}: held at once (single-territory bonus), +${b.value} income from turn 1; ${entries}`;
        worth = b.value * (PICK_HORIZON + 1);
      } else if (turn !== undefined) {
        const when = turn === 1 ? 'first-turn bonus (complete on turn 1)' : `complete on turn ${turn}`;
        point = `${head}: ${when}, +${b.value} income from turn ${turn + 1}; ${entries}`;
        worth = b.value * (PICK_HORIZON + 1 - turn);
      } else {
        const share = sim.progress.get(id)!;
        const have = Math.round(share * b.members.length);
        // The pick itself is held; the rest are captured. A member that cannot be
        // taken at these kill rates makes the bonus unreachable, not cheaper.
        const rest = b.members.filter((m) => m !== t).map((m) => cost.get(m));
        const left = rest.some((c) => c === null || c === undefined)
          ? 'a member cannot be taken at these kill rates'
          : `~${rest.reduce((acc: number, c) => acc + (c as number), 0)} armies to take all of it from this pick`;
        point = `${head}: ${have} of ${b.members.length} territories by turn ${PICK_HORIZON}, ${left}; ${entries}`;
        negatives.push(`${head}: not complete within ${PICK_HORIZON} turns`);
        worth = PROGRESS_WEIGHT * b.value * share;
      }
      worth *= b.defense;
      const waste = b.members.filter((m) => (cost.get(m) ?? Infinity) > WASTELAND_FACTOR * b.value).sort(byNum);
      if (waste.length)
        negatives.push(
          `${head} holds a wasteland: ${waste.map((m) => `${terrName(m)} (${armies.get(m)} armies)`).join(', ')}`,
        );
      lines.push({ id, worth, point, negatives });
    }
    lines.sort((a, b) => b.worth - a.worth || a.id - b.id);
    const why: string[] = [];
    const anchor = lines[0];
    if (anchor) {
      const verb = sim.completions.has(anchor.id) ? 'Anchors' : 'Advances';
      why.push(`${verb} ${anchor.point}`);
      for (const l of lines.slice(1)) why.push(`Also ${sim.completions.has(l.id) ? 'completes' : 'advances'} ${l.point}`);
      for (const l of lines) why.push(...l.negatives);
    } else why.push(`No bonus within reach in ${PICK_HORIZON} turns`);
    if (contestWeight > 0 && 1 - factor >= 0.05)
      why.push(`Central: likely contested with ${players} players (score −${Math.round((1 - factor) * 100)}%)`);
    reasons.set(t, why);
    anchors.set(t, anchor?.id ?? null);
  }
  const byScore = (a: number, b: number) => scores.get(b)! - scores.get(a)! || a - b;

  // Hop distances on the map graph (the one warapp_plan_route uses), cached per territory.
  const bfsCache = new Map<number, Map<number, number>>();
  const hops = (a: number, b: number) => {
    if (!bfsCache.has(a)) bfsCache.set(a, bfsDistances(g, [a]));
    return bfsCache.get(a)!.get(b) ?? Infinity;
  };

  // Groups. A pick joins a group when it lies within `hop` hops of a pick already in it
  // (hop starts at COMPACT_DISTANCE) — or, in a 1v1, when it anchors a bonus no group pick
  // anchors and lies within max(SPREAD_DISTANCE, hop) hops. Seeds are tried best score
  // first; when no seed grows a full group, hop relaxes by one and the search repeats.
  const spread = players <= 2;
  const tryGroup = (pool: number[], size: number, seed: number, hop: number): number[] | null => {
    const group = [seed];
    const left = new Set(pool.filter((t) => t !== seed));
    let current = simulate(ctx, group).score;
    const distTo = (c: number) => Math.min(...group.map((x) => hops(x, c)));
    while (group.length < size) {
      const anchored = new Set(group.map((t) => anchors.get(t)));
      const eligible = [...left].sort(byNum).filter((c) => {
        const d = distTo(c);
        if (d <= hop) return true;
        const a = anchors.get(c);
        return spread && a != null && !anchored.has(a) && d <= Math.max(SPREAD_DISTANCE, hop);
      });
      if (!eligible.length) return null;
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
    }
    return group;
  };
  const groupScore = (ids: number[]) => simulate(ctx, ids).score;
  /** The hop limit each group was relaxed to (absent: not relaxed; Infinity: until every pick could join). */
  const relaxedTo = new Map<string, number>();
  const firstGroup = (pool: number[], size: number, seeds: number[], hop: number) => {
    for (const seed of seeds) {
      const group = tryGroup(pool, size, seed, hop);
      if (group) return group;
    }
    return null;
  };
  const buildGroup = (pool: number[], size: number, label: string): number[] => {
    if (size <= 0 || !pool.length) return [];
    const seeds = [...pool].sort(byScore);
    if (size === 1) return [seeds[0]!];
    let widest = 0;
    for (const a of pool) for (const b of pool) if (a < b && hops(a, b) < Infinity) widest = Math.max(widest, hops(a, b));
    for (let hop = COMPACT_DISTANCE; ; hop++) {
      // Past every connected distance (and never at the compact limit itself): the
      // last try allows any distance, so it is a recorded relaxation, not "compact".
      const last = hop > Math.max(widest, COMPACT_DISTANCE);
      const group = firstGroup(pool, size, seeds, last ? Infinity : hop);
      if (!group) {
        if (last) return seeds.slice(0, size).sort(byScore);
        continue;
      }
      if (hop > COMPACT_DISTANCE) {
        relaxedTo.set(label, last ? Infinity : hop);
        warnings.push(
          `No compact ${label} group of ${size} picks (each within ${COMPACT_DISTANCE} hops of another) exists among the pickable territories; ` +
            (last ? 'relaxed until every pick could join (some are not connected).' : `relaxed to within ${hop} hops.`),
        );
      }
      // In a 1v1 the hop bound must not quietly hand a far better group to the fallback:
      // spread past it when that scores SPREAD_RELAX_GAIN times as much, at the smallest
      // hop limit that does.
      const bound = Math.max(hop, SPREAD_DISTANCE);
      if (spread && !last && bound < widest) {
        const bounded = groupScore(group);
        const better = (g2: number[] | null) => {
          const sc = g2 ? groupScore(g2) : -Infinity;
          return sc > bounded && sc >= SPREAD_RELAX_GAIN * bounded ? sc : null;
        };
        if (better(firstGroup(pool, size, seeds, Infinity)) !== null) {
          for (let h = bound + 1; h <= widest + 1; h++) {
            const limit = h > widest ? Infinity : h;
            const wide = firstGroup(pool, size, seeds, limit);
            const sc = better(wide);
            if (sc === null) continue;
            relaxedTo.set(label, limit);
            const within = Number.isFinite(limit) ? `within ${limit} hops` : 'any distance';
            warnings.push(
              `In a 1v1 the best ${label} group within ${bound} hops scores ${round2(bounded)}, but one spread to ${within} scores ${round2(sc)} ` +
                `(at least ${SPREAD_RELAX_GAIN}× as much): the ${label} group spreads to ${within}, so its picks can support each other less.`,
            );
            return wide!.sort(byScore);
          }
        }
      }
      return group.sort(byScore);
    }
  };

  const maxPicks = Math.max(0, Math.floor(input.maxPicks));
  const limit = Math.max(0, Math.floor(input.territoryLimit));
  const primarySize = Math.min(limit, maxPicks, pickable.length);
  if (pickable.length < limit)
    warnings.push(
      `Only ${pickable.length} pickable territor${pickable.length === 1 ? 'y' : 'ies'} for a limit of ${limit}: the list has no full fallback.`,
    );
  const primary = buildGroup(pickable, primarySize, 'primary');
  const rest = pickable.filter((t) => !primary.includes(t));
  const fallback = buildGroup(rest, Math.min(maxPicks - primary.length, rest.length), 'fallback');

  /** Farthest pair (hops) and the longest step that links the picks into one cluster. */
  const spreadOf = (ids: number[]) => {
    let far = 0;
    let pair: [number, number] | null = null;
    for (const a of ids)
      for (const b of ids) {
        if (a >= b) continue;
        const d = hops(a, b);
        if (pair === null || d > far) {
          far = d;
          pair = [a, b];
        }
      }
    // The longest step needed to link every pick into one cluster (minimax spanning tree).
    let link = 0;
    if (ids.length > 1) {
      const inTree = new Set([ids[0]!]);
      while (inTree.size < ids.length) {
        let step = Infinity;
        let next = -1;
        for (const a of ids) {
          if (inTree.has(a)) continue;
          for (const b of inTree) {
            const d = hops(a, b);
            if (next < 0 || d < step) {
              step = d;
              next = a;
            }
          }
        }
        inTree.add(next);
        link = Math.max(link, step);
      }
    }
    return { far, pair, link };
  };

  const groupOf = (ids: number[]): PickGroup => {
    if (!ids.length) return { territoryIds: [], score: 0, bonuses: [], maxHops: 0 };
    const sim = simulate(ctx, ids);
    const done = [...sim.completions.entries()]
      .map(([id, turn]) => ({ bonusId: id, name: bonuses.get(id)!.name, value: bonuses.get(id)!.value, turn }))
      .sort((a, b) => a.turn - b.turn || a.bonusId - b.bonusId);
    const far = spreadOf(ids).far;
    return { territoryIds: ids, score: round2(sim.score), bonuses: done, maxHops: Number.isFinite(far) ? far : null };
  };

  const picks: PickChoice[] = [
    ...primary.map((t) => ({ territoryId: t, group: 'primary' as const, score: scores.get(t)!, reasons: reasons.get(t)! })),
    ...fallback.map((t) => ({ territoryId: t, group: 'fallback' as const, score: scores.get(t)!, reasons: reasons.get(t)! })),
  ];

  const hopsText = (n: number) => (Number.isFinite(n) ? `${n} hop${n === 1 ? '' : 's'}` : 'unconnected');
  // Compact means one cluster whose picks link up in steps of at most COMPACT_DISTANCE
  // hops — not merely each pick having a group-mate that close (two tight pairs far
  // apart pass that test).
  const describe = (ids: number[]): string => {
    if (ids.length < 2) return 'a single pick';
    const { far, pair, link } = spreadOf(ids);
    const names = `${terrName(pair![0])} and ${terrName(pair![1])}`;
    const between = Number.isFinite(far) ? `the farthest two ${hopsText(far)} apart (${names})` : `${names} not connected`;
    if (link <= COMPACT_DISTANCE) return `compact: one cluster, each pick within ${COMPACT_DISTANCE} hops of another, ${between}`;
    if (!Number.isFinite(link)) return `spread: some picks are not connected to the others, ${between}`;
    return `spread: its picks link up only in steps of up to ${hopsText(link)}, ${between}`;
  };
  const relaxed = relaxedTo.size > 0;

  rationale.push(
    `Each pick is scored by the bonus armies it earns through turn ${PICK_HORIZON + 1} in a ${PICK_HORIZON}-turn opening simulation: ` +
      `${pickArmies} starting armies, ${baseIncome} base income${ctx.bonusArmyPer > 0 ? ` (or 1 per ${ctx.bonusArmyPer} territories when more)` : ''}, ` +
      `capture costs at ${off}/${def} kill rates against the neutrals' real sizes; ` +
      `armies attack only from a territory held at the start of the turn that borders the target, topped up by that turn's deploys.`,
    `Bonuses are weighted by defensibility (fewer entry points is better${hardness > 1 ? '; attacks here are dearer than at 60/70, so this weighs more' : ''}).`,
    contestWeight > 0
      ? `With ${players} players central picks are likely contested: scores drop by up to ${Math.round(contestWeight * 100)}% with centrality, and ` +
          (relaxed
            ? `each group is kept as compact as the map allows (no group of the needed size forms one cluster with each pick within ${COMPACT_DISTANCE} hops of another, so the hop limit was relaxed; see the warnings).`
            : `each group is compact (one cluster, each pick within ${COMPACT_DISTANCE} hops of another).`)
      : `In a 1v1 centrality is not penalised; a pick may join a group within ${SPREAD_DISTANCE} hops when it anchors a different bonus, so one counter-pick cannot wipe them` +
          (relaxed ? `; a group spreads farther only when no bounded group exists or spreading scores ${SPREAD_RELAX_GAIN}× as much (see the warnings).` : '.'),
    `The first ${primary.length} picks are the primary group, ${describe(primary)}; ` +
      `the rest are a disjoint fallback${fallback.length ? ` (${describe(fallback)})` : ''}, granted in order when another player picks first.`,
  );

  const groups = { primary: groupOf(primary), fallback: groupOf(fallback) };
  if (groups.fallback.score > groups.primary.score)
    warnings.push(
      `The fallback group scores more than the primary (${groups.fallback.score} vs ${groups.primary.score}): the primary keeps to ` +
        (players > 2
          ? `one compact cluster, since with ${players} players spread picks are likely contested.`
          : `within ${SPREAD_DISTANCE} hops unless spreading scores ${SPREAD_RELAX_GAIN}× as much.`) +
        ' Weigh the trade before submitting.',
    );
  return { picks, groups, warnings, rationale };
}
