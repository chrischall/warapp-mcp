// Single-pick distribution on a huge map (the mega-game spec, part 2; owner 2026-11-23). With a
// territory limit of 1 a player is granted one start, so the pick advisor's group search has nothing
// to group: what matters is which single territory to start on. `rankSingleStarts` scores every
// pickable territory alone on four things and ranks them:
//
//   1. Income at the game's bonus values (overrides applied by the caller's map): a flood opening
//      from the start runs SINGLE_HORIZON turns — each turn the income is deployed and every
//      territory next to the land is taken, members of paying bonuses first, then the territories
//      nearer a paying bonus, then the cheapest, while the armies at the start of the turn cover the
//      capture costs (the armies are pooled: an upper bound on a real opening); another pickable
//      territory is never taken (a rival may start there). Income is the base income, or one army
//      per BonusArmyPer territories when more, plus the bonuses held whole; a bonus worth 0 or less
//      pays nothing and is never steered for, but its territories are crossed. The score is the
//      income above the base over turns 1..SINGLE_HORIZON + 1, each completed bonus discounted by
//      SINGLE_THREAT_LOSS × the chance another start lies within its completion turn + 1 hops of it.
//   2. Turns to the first income above the base (`firstIncomeTurn`: 0 when held at once).
//   3. Wastelands (a neutral larger than an ordinary one) within 2 hops: one in a paying bonus
//      blocks it (the flood prices it), any other shields an approach.
//   4. Commander (start) safety: open approaches (neighbours that are not wastelands), entries into
//      its 2-hop pocket, and the other likely starts near it (each other pickable within
//      RIVAL_RADIUS hops counts the chance a rival starts there, nearer counting more), charged in
//      starting armies, twice with Commanders on (losing the commander ends the game).
//
// Pure and deterministic; the ranking is cached per map graph, so paging through it costs nothing.

import { bonusTerritories } from './bonuses.js';
import { DEFAULT_DEFENSIVE_KILL_RATE, DEFAULT_OFFENSIVE_KILL_RATE, straightKills } from './combat.js';
import { neighborsOf, type MapGraph } from './graph.js';
import type { PickSettings } from './picks.js';
import { captureCost } from './planner.js';
import { DEFAULT_BASE_INCOME, territoryIncome } from './player.js';

/** Starts the plan details per call (one page); the submit list is the whole ranking, cut at the client's max. */
export const SINGLE_PICK_SHOWN = 25;
/** A map of at least this many territories is huge: there a territory limit of 1 ranks single starts. */
export const HUGE_MAP_TERRITORIES = 1000;
/** Turns the flood opening runs. */
export const SINGLE_HORIZON = 5;
/** The most starts simulated per call; the rest are ranked after them by their quick score. */
export const SINGLE_POOL = 600;
/** Share of a completed bonus's income lost when a rival surely starts within reach of it. */
export const SINGLE_THREAT_LOSS = 0.5;
/** Hops within which another likely start presses a start. */
export const RIVAL_RADIUS = 3;
const NEAREST_DEPTH = 8;
// Safety charges, as shares of the starting armies.
const RIVAL_SHARE = 0.5;
const APPROACH_SHARE = 0.02;
const ENTRY_SHARE = 0.02;
const SHIELD_SHARE = 0.02;
const COMMANDER_FACTOR = 2;
const DEFAULT_PICK_ARMIES = 5;
const DEFAULT_NEUTRALS_IN = 4;
const DEFAULT_NEUTRALS_OUT = 2;
const MAX_CACHED = 4;

export interface SingleStartInput {
  graph: MapGraph;
  pickable: readonly number[];
  settings?: PickSettings;
  players: number;
  neutralArmies?: ReadonlyMap<number, number>;
  budgetMs?: number;
  clock?: () => number;
}

export interface SingleStartBonus {
  bonusId: number;
  name: string;
  value: number;
  /** Turn the flood completes it (0: the start itself). */
  turn: number;
  /** The chance another start lies within its completion turn + 1 hops of it. */
  contest: number;
}

export interface SingleStart {
  territoryId: number;
  score: number;
  /** Income above the base over turns 1..SINGLE_HORIZON + 1, before the contest discount. */
  income: number;
  /** The first turn after which the income is above the base (0: from the start); null: not within the horizon. */
  firstIncomeTurn: number | null;
  /** The nearest paying bonus (a member within NEAREST_DEPTH hops), the most valuable of the nearest. */
  nearestPaying: { bonusId: number; name: string; value: number; hops: number } | null;
  bonuses: SingleStartBonus[];
  wastelands: { blocking: number[]; shielding: number[] };
  safety: {
    approaches: number;
    entries: number;
    nearestStart: number | null;
    /** Expected rival starts within RIVAL_RADIUS hops, nearer weighing more. */
    rivalsNear: number;
    penalty: number;
  };
  /** False when the budget or the pool cap left it to its quick score. */
  simulated: boolean;
  /** Set by the plan for the starts it shows. */
  reasons?: string[];
}

export interface SingleRanking {
  ranked: SingleStart[];
  simulated: number;
  pickable: number;
  paying: number;
  base: number;
  partial?: true;
  cached?: true;
}

const cache = new WeakMap<MapGraph, Map<string, SingleRanking>>();
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Rank every pickable territory as a lone start (the module header). */
export function rankSingleStarts(input: SingleStartInput): SingleRanking {
  const g = input.graph;
  const s = input.settings ?? {};
  const pickable = [...new Set(input.pickable.filter((t) => g.territoryById.has(t)))].sort((a, b) => a - b);
  const known = input.neutralArmies ?? new Map<number, number>();
  const key = JSON.stringify([
    pickable,
    s,
    input.players,
    [...known].sort((a, b) => a[0] - b[0]),
    g.map.bonuses.length,
  ]);
  let byKey = cache.get(g);
  const hit = byKey?.get(key);
  if (hit) return { ...hit, cached: true };

  const clock = input.clock ?? Date.now;
  const started = clock();
  const expired = () => input.budgetMs !== undefined && clock() - started > input.budgetMs;

  const pickSet = new Set(pickable);
  const base = Math.max(0, Math.floor(s.minimumArmyBonus ?? DEFAULT_BASE_INCOME));
  const per = s.bonusArmyPer ?? 0;
  const pickArmies = s.initialPlayerArmiesPerTerritory ?? DEFAULT_PICK_ARMIES;
  const neutralsIn = s.initialNeutralsInDistribution ?? DEFAULT_NEUTRALS_IN;
  const neutralsOut = s.initialNonDistributionArmies ?? DEFAULT_NEUTRALS_OUT;
  const def = s.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  const rates = { offensiveKillRate: s.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE, defensiveKillRate: def, luckModifier: s.luckModifier };
  const ordinary = (t: number) => (pickSet.has(t) ? neutralsIn : neutralsOut);
  const armiesAt = (t: number) => Math.max(0, known.get(t) ?? ordinary(t));
  const waste = new Set<number>();
  for (const t of g.map.territories) if (armiesAt(t.id) > ordinary(t.id)) waste.add(t.id);
  const costOf = new Map<number, number | null>();
  const lossOf = new Map<number, number>();
  const cost = (t: number) => {
    if (!costOf.has(t)) {
      const n = armiesAt(t);
      costOf.set(t, captureCost(n, rates));
      lossOf.set(t, straightKills(n, def));
    }
    return costOf.get(t)!;
  };

  // Paying bonuses (value > 0 at the game's values): plain ones steer the flood; superbonuses only pay.
  const paying = g.map.bonuses.filter((b) => b.value > 0);
  const plain = paying.filter((b) => b.bonusIds.length === 0);
  const supers = paying.filter((b) => b.bonusIds.length > 0);
  const members = new Map<number, readonly number[]>();
  const payingOf = new Map<number, number[]>();
  for (const b of plain) {
    const ms = bonusTerritories(g, b.id).filter((t) => g.territoryById.has(t));
    if (!ms.length) continue;
    members.set(b.id, ms);
    for (const t of ms) payingOf.set(t, [...(payingOf.get(t) ?? []), b.id]);
  }
  // Hops from every territory to the nearest paying member (map-wide, one search).
  const toPaying = multiSource(g, [...payingOf.keys()]);

  const others = Math.max(1, pickable.length - 1);
  const q = Math.min(1, Math.max(0, (Math.max(1, Math.floor(input.players)) - 1) / others));
  const factor = s.commanders ? COMMANDER_FACTOR : 1;

  // Per bonus: the pickables within SINGLE_HORIZON + 1 hops of a member, with their hops (lazy).
  const nearPicks = new Map<number, Array<[number, number]>>();
  const picksNear = (bid: number) => {
    let out = nearPicks.get(bid);
    if (!out) {
      const d = bounded(g, members.get(bid)!, SINGLE_HORIZON + 1, () => true);
      out = [...d].filter(([t]) => pickSet.has(t));
      nearPicks.set(bid, out);
    }
    return out;
  };

  const quick = (c: number) => {
    const own = (payingOf.get(c) ?? []).filter((b) => members.get(b)!.length === 1);
    const v = own.reduce((n, b) => n + g.bonusById.get(b)!.value, 0);
    return v * (SINGLE_HORIZON + 1) - (toPaying.get(c) ?? NEAREST_DEPTH * 2);
  };
  const order = [...pickable].sort((a, b) => quick(b) - quick(a) || a - b);
  const pool = order.slice(0, SINGLE_POOL);

  const ranked: SingleStart[] = [];
  let partial = false;
  for (let i = 0; i < pool.length; i++) {
    if (i % 16 === 0 && expired()) {
      partial = true;
      break;
    }
    ranked.push(simulateStart(pool[i]!));
  }
  const done = new Set(ranked.map((r) => r.territoryId));
  ranked.sort((a, b) => b.score - a.score || a.territoryId - b.territoryId);
  for (const c of order) if (!done.has(c)) ranked.push(unsimulated(c));

  const result: SingleRanking = { ranked, simulated: done.size, pickable: pickable.length, paying: paying.length, base, ...(partial ? { partial: true as const } : {}) };
  if (!partial) {
    if (!byKey) cache.set(g, (byKey = new Map()));
    if (byKey.size >= MAX_CACHED) byKey.delete(byKey.keys().next().value!);
    byKey.set(key, result);
  }
  return result;

  function nearestPaying(c: number): SingleStart['nearestPaying'] {
    const d = toPaying.get(c);
    if (d === undefined || d > NEAREST_DEPTH) return null;
    const ring = [...bounded(g, [c], d, () => true)].filter(([t, h]) => h === d && payingOf.has(t)).map(([t]) => t);
    let best: SingleStart['nearestPaying'] = null;
    for (const t of ring)
      for (const bid of payingOf.get(t)!) {
        const b = g.bonusById.get(bid)!;
        if (!best || b.value > best.value || (b.value === best.value && bid < best.bonusId)) best = { bonusId: bid, name: b.name, value: b.value, hops: d };
      }
    return best;
  }

  function safetyOf(c: number) {
    const d = bounded(g, [c], Math.max(RIVAL_RADIUS, NEAREST_DEPTH), (t) => !waste.has(t));
    const approaches = neighborsOf(g, c).filter((n) => !waste.has(n)).length;
    let entries = 0;
    let rivals = 0;
    let nearest: number | null = null;
    for (const [t, h] of d) {
      if (h === 2 && neighborsOf(g, t).some((n) => d.get(n) === 3)) entries++;
      if (t !== c && pickSet.has(t)) {
        if (nearest === null || h < nearest) nearest = h;
        if (h <= RIVAL_RADIUS) rivals += (q * (RIVAL_RADIUS + 1 - h)) / RIVAL_RADIUS;
      }
    }
    const near2 = bounded(g, [c], 2, () => true);
    const blocking: number[] = [];
    const shielding: number[] = [];
    for (const t of [...near2.keys()].sort((a, b) => a - b)) {
      if (t === c || !waste.has(t)) continue;
      (payingOf.has(t) ? blocking : shielding).push(t);
    }
    const penalty = pickArmies * factor * (RIVAL_SHARE * rivals + APPROACH_SHARE * approaches + ENTRY_SHARE * entries - SHIELD_SHARE * shielding.length);
    return { safety: { approaches, entries, nearestStart: nearest, rivalsNear: round2(rivals), penalty: round2(penalty) }, wastelands: { blocking, shielding } };
  }

  function unsimulated(c: number): SingleStart {
    const { safety, wastelands } = safetyOf(c);
    return {
      territoryId: c,
      score: round2(quick(c) - safety.penalty),
      income: 0,
      firstIncomeTurn: null,
      nearestPaying: nearestPaying(c),
      bonuses: [],
      wastelands,
      safety,
      simulated: false,
    };
  }

  function simulateStart(c: number): SingleStart {
    const held = new Set<number>([c]);
    const left = new Map<number, number>();
    const completed = new Map<number, number>();
    const take = (t: number, turn: number) => {
      held.add(t);
      for (const bid of payingOf.get(t) ?? []) {
        const n = (left.get(bid) ?? members.get(bid)!.length) - 1;
        left.set(bid, n);
        if (n === 0) completed.set(bid, turn);
      }
    };
    held.delete(c);
    take(c, 0);
    const superDone = new Map<number, number>();
    const incomeNow = (turn: number) => {
      for (const b of supers)
        if (!superDone.has(b.id) && bonusTerritories(g, b.id).every((t) => held.has(t))) superDone.set(b.id, turn);
      let v = territoryIncome(held.size, base, per);
      for (const bid of completed.keys()) v += g.bonusById.get(bid)!.value;
      for (const bid of superDone.keys()) v += g.bonusById.get(bid)!.value;
      return v;
    };
    let armies = pickArmies;
    let income = incomeNow(0);
    let extra = income - base;
    let firstIncomeTurn: number | null = income > base ? 0 : null;
    for (let turn = 1; turn <= SINGLE_HORIZON; turn++) {
      armies += income;
      const frontier = new Set<number>();
      for (const h of held)
        for (const n of neighborsOf(g, h)) if (!held.has(n) && !pickSet.has(n) && cost(n) !== null) frontier.add(n);
      const pull = (t: number) => {
        let best = 0;
        for (const bid of payingOf.get(t) ?? []) {
          if (completed.has(bid)) continue;
          best = Math.max(best, g.bonusById.get(bid)!.value / (left.get(bid) ?? members.get(bid)!.length));
        }
        return best;
      };
      const list = [...frontier].sort(
        (a, b) => pull(b) - pull(a) || (toPaying.get(a) ?? 1e9) - (toPaying.get(b) ?? 1e9) || cost(a)! - cost(b)! || a - b,
      );
      let committed = 0;
      for (const t of list) {
        const k = cost(t)!;
        if (committed + k > armies) continue;
        committed += k;
        take(t, turn);
      }
      for (const t of list) if (held.has(t)) armies -= lossOf.get(t)!;
      income = incomeNow(turn);
      extra += income - base;
      if (firstIncomeTurn === null && income > base) firstIncomeTurn = turn;
    }
    const bonuses: SingleStartBonus[] = [];
    let discount = 0;
    for (const [bid, turn] of completed) {
      const b = g.bonusById.get(bid)!;
      const k = picksNear(bid).filter(([t, h]) => t !== c && h <= turn + 1).length;
      const p = 1 - (1 - q) ** k;
      discount += SINGLE_THREAT_LOSS * p * b.value * (SINGLE_HORIZON + 1 - turn);
      bonuses.push({ bonusId: bid, name: b.name, value: b.value, turn, contest: round2(p) });
    }
    bonuses.sort((a, b) => a.turn - b.turn || b.value - a.value || a.bonusId - b.bonusId);
    const { safety, wastelands } = safetyOf(c);
    return {
      territoryId: c,
      score: round2(extra - discount - safety.penalty),
      income: extra,
      firstIncomeTurn,
      nearestPaying: nearestPaying(c),
      bonuses,
      wastelands,
      safety,
      simulated: true,
    };
  }
}

/** Hops from the nearest of `sources` to every territory (unbounded). */
function multiSource(g: MapGraph, sources: readonly number[]): Map<number, number> {
  return bounded(g, sources, Number.POSITIVE_INFINITY, () => true);
}

/** Hops from the nearest of `sources`, at most `depth`, entering only `pass` territories (sources always). */
function bounded(g: MapGraph, sources: readonly number[], depth: number, pass: (t: number) => boolean): Map<number, number> {
  const dist = new Map<number, number>();
  let frontier: number[] = [];
  for (const s of sources)
    if (!dist.has(s)) {
      dist.set(s, 0);
      frontier.push(s);
    }
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: number[] = [];
    for (const t of frontier)
      for (const n of neighborsOf(g, t))
        if (!dist.has(n) && pass(n)) {
          dist.set(n, d);
          next.push(n);
        }
    frontier = next;
  }
  return dist;
}

/** One start's reasons, by name: income, bonuses, wastelands and safety. */
export function singleStartReasons(g: MapGraph, s: SingleStart, base: number, commanders: boolean): string[] {
  const name = (t: number) => g.territoryById.get(t)?.name ?? String(t);
  const out: string[] = [];
  if (!s.simulated) out.push('Ranked by its quick score only (nearest paying bonus): the time budget or the pool cap left it unsimulated.');
  else
    out.push(
      s.firstIncomeTurn === 0
        ? `Income above the ${base} minimum from the start; +${s.income} armies above it over ${SINGLE_HORIZON + 1} turns`
        : s.firstIncomeTurn !== null
          ? `First income above the ${base} minimum after turn ${s.firstIncomeTurn}; +${s.income} armies above it over ${SINGLE_HORIZON + 1} turns`
          : `No income above the ${base} minimum within ${SINGLE_HORIZON} turns`,
    );
  for (const b of s.bonuses.slice(0, 3))
    out.push(
      `${b.name} (+${b.value}) ${b.turn === 0 ? 'held at once' : `complete on turn ${b.turn}`}` +
        (b.contest > 0 ? `; a rival may start within reach of it (${Math.round(b.contest * 100)}%)` : '; no other start can reach it in time'),
    );
  if (!s.bonuses.length && s.nearestPaying)
    out.push(`Nearest paying bonus: ${s.nearestPaying.name} (+${s.nearestPaying.value}), ${s.nearestPaying.hops} hop${s.nearestPaying.hops === 1 ? '' : 's'} away`);
  if (!s.nearestPaying && !s.bonuses.length) out.push(`No paying bonus within ${NEAREST_DEPTH} hops`);
  const { blocking, shielding } = s.wastelands;
  if (blocking.length) out.push(`Wasteland in a paying bonus within 2 hops (blocks it): ${blocking.map(name).join(', ')}`);
  if (shielding.length) out.push(`Wasteland shielding an approach within 2 hops: ${shielding.map(name).join(', ')}`);
  const f = s.safety;
  out.push(
    `${commanders ? 'Commander' : 'Start'} safety: ${f.approaches} open approach${f.approaches === 1 ? '' : 'es'}, ${f.entries} entr${f.entries === 1 ? 'y' : 'ies'} into its 2-hop pocket, ` +
      `nearest other start ${f.nearestStart === null ? `over ${NEAREST_DEPTH} hops` : `${f.nearestStart} hop${f.nearestStart === 1 ? '' : 's'}`} away, ` +
      `~${f.rivalsNear} rival start${f.rivalsNear === 1 ? '' : 's'} expected within ${RIVAL_RADIUS} hops (−${f.penalty})`,
  );
  return out;
}
