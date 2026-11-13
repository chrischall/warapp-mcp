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
//     + completed bonuses; with local deployments a bonus's income is deployed only inside
//     that bonus, the rest anywhere (#129: it was pooled). Within a turn it
//     repeatedly picks the bonus (value > 0, not a superbonus, with a member in or next
//     to the territories held) with the best value / remaining capture cost that has a
//     member next to a territory held at the start of the turn, and attacks that bonus's
//     cheapest such member from one bordering start-of-turn territory (the one with the
//     most movable armies, i.e. above the guard), topped up by the turn's unspent income
//     (deployed there). When that cannot afford it, the rest of the income is deployed on
//     that source and saved for the next turn, and the next-best bonuses are still tried
//     with the movable armies of other sources alone. A capture's survivors stay on the captured
//     territory and attack from there next turn (captured armies never attack the turn
//     they capture). Nothing is parked (#129): an attacking source's spare movable armies,
//     and the turn's unspent deploys, go with its attack into its most forward capture, so
//     a bonus behind one neutral completes on turn 2 as it does by hand. A bonus held in full by the picks themselves (a single-territory
//     bonus) completes on turn 0; one completed on turn 1 is a first-turn bonus (FTB).
//     (Before #47 every pick's armies and the captured survivors were one pool, so a
//     bonus was "completed" with armies on picks nowhere near it.)
//  3. Score of a pick set: Σ completed value × (PICK_HORIZON + 1 − turn) — the bonus
//     armies earned through turn PICK_HORIZON + 1 — plus PROGRESS_WEIGHT × value ×
//     share held for bonuses still incomplete, each bonus scaled by its
//     defensibility 1 / (1 + weight × entry points × hardness), where weight is
//     ENTRY_WEIGHT, or ENTRY_WEIGHT_1V1 (twice as much) in a 1v1 — one opponent finds
//     every entry point, so a narrow bonus wins ties against a wide one (#73) — and
//     hardness is how much dearer an attack is than at the standard 60/70 (at 30/75
//     a bonus with few entry points is worth more). A negative bonus held in full costs
//     its value × (PICK_HORIZON + 1 − turn), unscaled, and is listed among the pick's
//     negatives; the simulation never steers for a bonus whose completion would also
//     complete negative bonuses worth as much (its value is counted net of them, #129).
//  4. Contestedness. A pick's centrality is its mean hop distance to the other
//     pickable territories, normalised over the pickables (1 = most central). Its
//     score is scaled by 1 − contestWeight(players) × centrality: no penalty in a
//     1v1, growing CONTEST_PER_PLAYER per extra player up to CONTEST_MAX.
//  5. Groups. The primary group (min(TerritoryLimit, maxPicks) picks) grows from a seed
//     by adding, greedily, the pick with the biggest marginal gain in the joint
//     simulation's score (× its contest factor), among picks within COMPACT_DISTANCE hops
//     (on the map graph warapp_plan_route uses) of a pick already in the group. Ties:
//     individual score, then id. Every seed (the MAX_SEEDS best by score) grows a group and
//     the best-scoring group wins, ties to the better seed (#129: growing only from the best
//     single pick gave a +4 single grown into dead ground over three +3 singles); when none
//     grows a full group, the hop limit relaxes by one, with a warning, until one does. This holds in
//     a 1v1 too (#73): a primary spread over bonuses against a counter-pick meant a
//     frontier on every one of them from turn 1, and the counter-pick is already covered
//     by the fallback. The fallback group is built the same way from the remaining
//     pickables, up to maxPicks in total, but scored — its picks' scores and reasons too —
//     with the primary picks held by someone else, since only then is it granted: a bonus
//     shared with the primary never completes for it (#129). In a 1v1, among the equally
//     scored compact fallbacks found at its hop limit, the one farthest from the primary
//     (fewest hops between the two groups, maximised) wins, so one counter-pick cannot reach
//     both. A fallback that still outscores the primary is warned about. A list longer than
//     twice the limit (war.app's client allows players × territories per player,
//     `clientPickLimits`) runs in fallback tiers of the primary's size, each built the same
//     way with the primary and the earlier tiers taken; the fallback group's score, bonuses
//     and spread are its first tier's.
//     Only with `spread: true` in a 1v1 does the old rule apply: a pick may also join
//     when it anchors a bonus no group pick anchors and lies within SPREAD_DISTANCE hops,
//     and the bound gives way, with a warning, at the smallest hop limit where a group
//     scores SPREAD_RELAX_GAIN times the bounded one. Usually worse on large maps.
//     Each group is listed by score; its maxHops and the rationale state its real
//     spread (farthest pair, and the longest step linking its picks into one cluster) and
//     call it compact only when that step is at most COMPACT_DISTANCE: one cluster, not
//     merely each pick with a group-mate nearby.
//  5b. Award order (#129). Picks are awarded round by round in move order, reversing each
//     round, each player getting their highest-ranked territory still free (`pickOutcomes`
//     enumerates the sets a list can yield, other players' lists unknown). The list's worst
//     outcome is scored with the other players on the starts it implies
//     (`impliedOpponentStarts`) and reported; the primary is reordered (up to MAX_REORDER
//     picks) only when another order raises that worst outcome.
//  6. Reasons. reasons[0] is the bonus the pick anchors (worth most to it alone) and its
//     completion turn and the income it adds, or how much of it is held by the horizon;
//     then the other bonuses it completes or advances; negatives (shortfalls,
//     wastelands — a member other than the pick larger than an ordinary neutral —, contest,
//     negative bonuses held) come last.

import type { GameSettings } from '../normalize.js';
import { analyzeBonus, bonusTerritories } from './bonuses.js';
import { armiesToTake, DEFAULT_DEFENSIVE_KILL_RATE, DEFAULT_OFFENSIVE_KILL_RATE, straightKills } from './combat.js';
import { bfsDistances, neighborsOf, type MapGraph } from './graph.js';
import { captureCost } from './planner.js';
import { boardIncome, DEFAULT_BASE_INCOME } from './player.js';

/** Turns the opening simulation runs (income by turn 3). */
export const PICK_HORIZON = 3;
/** Share of a still-incomplete bonus's value credited per share of it held at the horizon. */
export const PROGRESS_WEIGHT = 0.5;
/** Defensibility penalty per entry point (scaled by attack hardness)… */
export const ENTRY_WEIGHT = 0.05;
/** …and in a 1v1 (twice ENTRY_WEIGHT: the one opponent finds every entry point, #73). */
export const ENTRY_WEIGHT_1V1 = 0.1;
/** Contest penalty per player beyond two… */
export const CONTEST_PER_PLAYER = 0.06;
/** …capped here. */
export const CONTEST_MAX = 0.5;
/** A group pick lies within this many hops of another pick in its group… */
export const COMPACT_DISTANCE = 2;
/** With `spread: true` in a 1v1: or within this many when it anchors a bonus no other group pick anchors. */
export const SPREAD_DISTANCE = 4;
/** With `spread: true`: a 1v1 group spreads past SPREAD_DISTANCE only when that scores at least this many times as much. */
export const SPREAD_RELAX_GAIN = 1.5;
/** Defaults when the settings are missing (war.app's usual values). */
export const DEFAULT_PICK_ARMIES = 5;
export const DEFAULT_NEUTRALS_IN_DISTRIBUTION = 4;
export const DEFAULT_NON_DISTRIBUTION_ARMIES = 2;
/** Seeds (best score first) each group search grows from; every one when the pool is no larger (#129). */
export const MAX_SEEDS = 12;
/** The primary's order is searched for the best worst outcome only up to this size (#129). */
export const MAX_REORDER = 5;
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
  /** Picks to list: war.app's client allows players × territories per player (`clientPickLimits`). */
  maxPicks: number;
  /** Neutral armies as the live board shows them (wastelands included), by territory id. */
  neutralArmies?: ReadonlyMap<number, number>;
  /**
   * In a 1v1, spread the primary across bonuses against a counter-pick (the pre-#73 rule);
   * usually worse on large maps. Ignored with three or more players.
   */
  spread?: boolean;
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
  /** The group's joint simulation score (the fallback's: its first tier's, with the primary taken). */
  score: number;
  /** Bonuses the group completes within PICK_HORIZON turns. */
  bonuses: GroupBonus[];
  /** Hops between the group's two farthest picks on the map graph (`null`: not connected). */
  maxHops: number | null;
}

export interface AwardReport {
  /** Distinct sets of picks the award order can grant from this list (see {@link pickOutcomes}). */
  outcomes: number;
  /** The outcome scoring least in the opening simulation, with the other players' starts it implies. */
  worst: { territoryIds: number[]; score: number; opponentStarts: number[] };
  /** The primary was reordered from score order because that raises the worst outcome. */
  reordered: boolean;
}

export interface PickPlan {
  picks: PickChoice[];
  groups: { primary: PickGroup; fallback: PickGroup };
  /** The list judged by what the award order can give; absent when too many outcomes to enumerate (#129). */
  award?: AwardReport;
  warnings: string[];
  rationale: string[];
}

const byNum = (a: number, b: number) => a - b;
const NO_TAKEN: ReadonlySet<number> = new Set();
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
  /** Negative bonuses (value < 0, not superbonuses), by id (#129). */
  penalties: Map<number, BonusInfo>;
  /** Territory → negative bonus ids. */
  penaltiesOf: Map<number, number[]>;
  pickArmies: number;
  guard: number;
  baseIncome: number;
  bonusArmyPer: number;
  /** Bonus income may be deployed only inside its bonus (#129). */
  localDeployments: boolean;
}

/** A turn's deploys: `cells` null deploys anywhere, else only there (a bonus, under local deployments). */
interface Pool {
  cells: ReadonlySet<number> | null;
  left: number;
}

interface SimResult {
  completions: Map<number, number>;
  /** Negative bonuses held in full, by the turn they complete (0: held by the picks). */
  penalties: Map<number, number>;
  /** Share held at the horizon, for bonuses touched but not completed. */
  progress: Map<number, number>;
  score: number;
}

/**
 * The opening from `start`. `taken` territories belong to someone else (the primary picks when
 * the fallback is granted, #129): never captured, so a bonus holding one never completes.
 */
function simulate(ctx: Ctx, start: readonly number[], taken: ReadonlySet<number> = NO_TAKEN): SimResult {
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
  const penalties = new Map<number, number>();
  const checkComplete = (turn: number) => {
    for (const id of relevant(held)) {
      if (completions.has(id)) continue;
      if (ctx.bonuses.get(id)!.members.every((m) => held.has(m))) completions.set(id, turn);
    }
    for (const t of held)
      for (const id of ctx.penaltiesOf.get(t) ?? [])
        if (!penalties.has(id) && ctx.penalties.get(id)!.members.every((m) => held.has(m))) penalties.set(id, turn);
  };
  // A bonus is worth its value less the negative bonuses that completing it would also
  // complete (#129): one worth no more than that is not steered for.
  const netValue = (b: BonusInfo) => {
    let v = b.value;
    const ids = new Set(b.members.flatMap((m) => ctx.penaltiesOf.get(m) ?? []));
    for (const id of ids) {
      if (penalties.has(id)) continue;
      const n = ctx.penalties.get(id)!;
      if (n.members.every((m) => held.has(m) || b.members.includes(m))) v += n.value;
    }
    return v;
  };
  checkComplete(0);
  for (let turn = 1; turn <= PICK_HORIZON; turn++) {
    // The one income rule (#85): every bonus held in full counts — negative ones and superbonuses
    // too, not only the anchorable bonuses the simulation steers for. With local deployments
    // (#129) each positive bonus's income is its own pool, deployable only inside the bonus;
    // the rest (base or territory income, less negative bonuses) goes anywhere.
    const income = boardIncome(ctx.g, held, { base: ctx.baseIncome, per: ctx.bonusArmyPer });
    const pools: Pool[] = [];
    if (ctx.localDeployments) {
      const local = income.bonuses.filter((b) => b.value > 0);
      const free = income.total - local.reduce((n, b) => n + b.value, 0);
      for (const b of local) pools.push({ cells: new Set(bonusTerritories(ctx.g, b.bonusId)), left: b.value });
      pools.push({ cells: null, left: Math.max(0, free) });
    } else pools.push({ cells: null, left: income.total });
    const usable = (p: Pool, t: number) => p.cells === null || p.cells.has(t);
    const startHeld = [...held].sort(byNum);
    const startSet = new Set(startHeld);
    // Movable armies of the territories held at the start of the turn (captured ones never attack).
    const avail = new Map(startHeld.map((t) => [t, Math.max(0, armiesOn.get(t)! - ctx.guard)]));
    const captured = new Set<number>();
    // Where this turn's unspent deploys go: the source of the attack it is saving for.
    // Once set, the deploys that could go there are reserved for it; other sources still
    // attack with their own armies (and, with local deployments, the pools it cannot use).
    let saveAt: number | null = null;
    const reserved = new Set<Pool>();
    const deployAt = (t: number) => pools.reduce((n, p) => n + (usable(p, t) && !reserved.has(p) ? p.left : 0), 0);
    const spend = (t: number, n: number) => {
      // Bonus-local pools first: the free pool can go elsewhere.
      for (const p of [...pools].sort((a, b) => (a.cells === null ? 1 : 0) - (b.cells === null ? 1 : 0))) {
        if (n <= 0) break;
        if (!usable(p, t) || reserved.has(p)) continue;
        const k = Math.min(p.left, n);
        p.left -= k;
        n -= k;
      }
    };
    // Bonuses whose next capture cannot be paid for this turn.
    const skipped = new Set<number>();
    // This turn's attacks, in order: the armies left over follow them (#129).
    const attacks: { source: number; target: number }[] = [];
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
          const c = taken.has(m) ? null : ctx.cost.get(m);
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
        const net = netValue(b);
        if (net <= 0) continue;
        const ratio = net / rem;
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
      const deploy = source < 0 ? 0 : deployAt(source);
      if (source < 0 || own + deploy < best.cost) {
        // Save the deploys for the best bonus; try the next one with what else stands idle.
        if (saveAt === null && source >= 0) {
          saveAt = source;
          for (const p of pools) if (usable(p, source)) reserved.add(p);
        }
        skipped.add(best.id);
        continue;
      }
      const fromOwn = Math.min(own, best.cost);
      avail.set(source, own - fromOwn);
      armiesOn.set(source, armiesOn.get(source)! - fromOwn);
      spend(source, best.cost - fromOwn);
      captured.add(best.target);
      attacks.push({ source, target: best.target });
      armiesOn.set(best.target, Math.max(0, best.cost - ctx.lost.get(best.target)!));
    }
    // Armies are not parked (#129): what is left goes with the attacks, as a player would
    // send it — each attacking source's spare movable armies, and the unspent deploys (on the
    // first attack's source they may be deployed on), join that source's most forward capture
    // (the most territories next to it neither held nor captured; ties: lowest id). Deploys
    // saved for an attack next turn stay on its source; with no attack they can go with, they
    // go on the start territory (they may be deployed on) with the most unheld neighbours.
    const unheld = (t: number) => neighborsOf(ctx.g, t).filter((n) => !held.has(n) && !captured.has(n)).length;
    const forward = (ids: number[]) => ids.reduce((a, b) => (unheld(b) > unheld(a) || (unheld(b) === unheld(a) && b < a) ? b : a));
    const carry = new Map<number, number>();
    for (const p of pools) {
      if (p.left <= 0) continue;
      if (reserved.has(p)) {
        armiesOn.set(saveAt!, armiesOn.get(saveAt!)! + p.left);
        continue;
      }
      const with_ = attacks.find((a) => usable(p, a.source) && a.source !== saveAt);
      if (with_) carry.set(with_.source, (carry.get(with_.source) ?? 0) + p.left);
      else {
        const cells = startHeld.filter((t) => usable(p, t));
        if (!cells.length) continue;
        const at = forward(cells);
        armiesOn.set(at, armiesOn.get(at)! + p.left);
      }
    }
    const sources = [...new Set(attacks.map((a) => a.source))].filter((t) => t !== saveAt);
    for (const src of sources) {
      const to = forward(attacks.filter((a) => a.source === src).map((a) => a.target));
      armiesOn.set(src, armiesOn.get(src)! - avail.get(src)!);
      armiesOn.set(to, armiesOn.get(to)! + avail.get(src)! + (carry.get(src) ?? 0));
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
    // A bonus someone else holds part of is not progress (#129).
    if (share > 0 && !b.members.some((m) => taken.has(m))) {
      progress.set(id, share);
      score += PROGRESS_WEIGHT * b.value * share * b.defense;
    }
  }
  for (const [id, turn] of penalties) score += ctx.penalties.get(id)!.value * (PICK_HORIZON + 1 - turn);
  return { completions, penalties, progress, score };
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
    warnings.push(
      'Local deployments are on: bonus income must be deployed inside its bonus, and the opening simulation deploys it only there.',
    );

  const guard = s.oneArmyStandsGuard === false ? 0 : 1;
  const players = Math.max(1, Math.floor(input.players));
  const duel = players <= 2;
  const entryWeight = duel ? ENTRY_WEIGHT_1V1 : ENTRY_WEIGHT;
  const rates = { offensiveKillRate: off, defensiveKillRate: def, luckModifier: s.luckModifier };

  // Per-territory capture cost.
  const armies = new Map<number, number>();
  const cost = new Map<number, number | null>();
  const lost = new Map<number, number>();
  for (const t of g.map.territories) {
    const n = Math.max(0, known.get(t.id) ?? (pickSet.has(t.id) ? neutralsIn : neutralsOut));
    armies.set(t.id, n);
    cost.set(t.id, captureCost(n, rates));
    lost.set(t.id, straightKills(n, def));
  }

  // Attack hardness vs the standard kill rates, for defensibility.
  const probe = armiesToTake(HARDNESS_PROBE, { offensiveKillRate: off, defensiveKillRate: def });
  const standard = armiesToTake(HARDNESS_PROBE)!;
  const hardness = probe === null ? 4 : Math.max(0.25, probe / standard);

  /** The size a neutral starts at when nothing special is placed on it. */
  const ordinary = (t: number) => (pickSet.has(t) ? neutralsIn : neutralsOut);

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
      defense: 1 / (1 + entryWeight * entryPoints * hardness),
    });
    for (const t of members) bonusesOf.set(t, [...(bonusesOf.get(t) ?? []), b.id]);
  }

  // Negative bonuses: never steered for, but charged when held in full (#129).
  const penalties = new Map<number, BonusInfo>();
  const penaltiesOf = new Map<number, number[]>();
  for (const b of g.map.bonuses) {
    if (b.value >= 0 || b.bonusIds.length > 0) continue;
    const members = (analyzeBonus(g, b.id)?.territoryIds ?? []).filter((t) => g.territoryById.has(t));
    if (!members.length) continue;
    penalties.set(b.id, { id: b.id, name: b.name, value: b.value, members, entryPoints: 0, defense: 1 });
    for (const t of members) penaltiesOf.set(t, [...(penaltiesOf.get(t) ?? []), b.id]);
  }

  const ctx: Ctx = {
    g,
    cost,
    lost,
    armies,
    bonuses,
    bonusesOf,
    penalties,
    penaltiesOf,
    pickArmies,
    guard,
    baseIncome,
    bonusArmyPer: s.bonusArmyPer ?? 0,
    localDeployments: s.localDeployments === true,
  };

  // Contestedness from centrality among the pickables.
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
  /** A pick's own score, reasons and anchor bonus, with `taken` held by someone else. */
  interface Assessment {
    score: number;
    reasons: string[];
    anchor: number | null;
  }
  const terrName = (id: number) => g.territoryById.get(id)?.name ?? String(id);
  const assess = (t: number, taken: ReadonlySet<number>): Assessment => {
    const sim = simulate(ctx, [t], taken);
    const factor = contestFactor(t);
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
      // A wasteland is a member other than the pick standing larger than an ordinary neutral
      // (#129: the pick itself, at the 4-army distribution size, was called one).
      const waste = b.members.filter((m) => m !== t && !taken.has(m) && armies.get(m)! > ordinary(m)).sort(byNum);
      if (waste.length)
        negatives.push(
          `${head} holds a wasteland: ${waste.map((m) => `${terrName(m)} (${armies.get(m)} armies)`).join(', ')}`,
        );
      lines.push({ id, worth, point, negatives });
    }
    lines.sort((a, b) => b.worth - a.worth || a.id - b.id);
    // Negative bonuses held in full: a cost, listed with the negatives (#129).
    const charged = [...sim.penalties.entries()]
      .sort((a, b) => a[1] - b[1] || a[0] - b[0])
      .map(([id, turn]) => {
        const n = penalties.get(id)!;
        const head = `${n.name} (−${-n.value})`;
        return turn === 0
          ? `${head}: a negative bonus held at once, −${-n.value} income from turn 1`
          : `${head}: a negative bonus completed on turn ${turn}, −${-n.value} income from turn ${turn + 1}`;
      });
    const why: string[] = [];
    const anchor = lines[0];
    if (anchor) {
      const verb = sim.completions.has(anchor.id) ? 'Anchors' : 'Advances';
      why.push(`${verb} ${anchor.point}`);
      for (const l of lines.slice(1)) why.push(`Also ${sim.completions.has(l.id) ? 'completes' : 'advances'} ${l.point}`);
      for (const l of lines) why.push(...l.negatives);
    } else why.push(`No bonus within reach in ${PICK_HORIZON} turns`);
    why.push(...charged);
    if (contestWeight > 0 && 1 - factor >= 0.05)
      why.push(`Central: likely contested with ${players} players (score −${Math.round((1 - factor) * 100)}%)`);
    return { score: round2(sim.score * factor), reasons: why, anchor: anchor?.id ?? null };
  };
  /** Assessments of a pool with `taken` held by someone else (the fallback's view, #129). */
  interface View {
    taken: ReadonlySet<number>;
    of: Map<number, Assessment>;
  }
  const viewOf = (pool: readonly number[], taken: ReadonlySet<number>): View => ({
    taken,
    of: new Map(pool.map((t) => [t, assess(t, taken)])),
  });
  const firstView = viewOf(pickable, NO_TAKEN);
  // Hop distances on the map graph (the one warapp_plan_route uses), cached per territory.
  const bfsCache = new Map<number, Map<number, number>>();
  const hops = (a: number, b: number) => {
    if (!bfsCache.has(a)) bfsCache.set(a, bfsDistances(g, [a]));
    return bfsCache.get(a)!.get(b) ?? Infinity;
  };

  // Groups. A pick joins a group when it lies within `hop` hops of a pick already in it
  // (hop starts at COMPACT_DISTANCE) — or, with `spread: true` in a 1v1, when it anchors a
  // bonus no group pick anchors and lies within max(SPREAD_DISTANCE, hop) hops. Every seed
  // (the MAX_SEEDS best) grows a group and the best-scoring one wins (#129); when no seed grows
  // a full group, hop relaxes by one and the search repeats.
  const spread = duel && input.spread === true;
  const tryGroup = (view: View, pool: number[], size: number, seed: number, hop: number): number[] | null => {
    const score = (t: number) => view.of.get(t)!.score;
    const group = [seed];
    const left = new Set(pool.filter((t) => t !== seed));
    let current = simulate(ctx, group, view.taken).score;
    const distTo = (c: number) => Math.min(...group.map((x) => hops(x, c)));
    while (group.length < size) {
      const anchored = new Set(group.map((t) => view.of.get(t)!.anchor));
      const eligible = [...left].sort(byNum).filter((c) => {
        const d = distTo(c);
        if (d <= hop) return true;
        const a = view.of.get(c)!.anchor;
        return spread && a != null && !anchored.has(a) && d <= Math.max(SPREAD_DISTANCE, hop);
      });
      if (!eligible.length) return null;
      let best: { t: number; gain: number; total: number } | null = null;
      for (const c of eligible) {
        const total = simulate(ctx, [...group, c], view.taken).score;
        const gain = round2((total - current) * contestFactor(c));
        if (
          !best ||
          gain > best.gain ||
          (gain === best.gain && (score(c) > score(best.t) || (score(c) === score(best.t) && c < best.t)))
        )
          best = { t: c, gain, total };
      }
      group.push(best!.t);
      left.delete(best!.t);
      current = best!.total;
    }
    return group;
  };
  /** The hop limit each group was relaxed to (absent: not relaxed; Infinity: until every pick could join). */
  const relaxedTo = new Map<string, number>();
  /** Fewest hops between a pick of `ids` and one of `away` (the gap between two groups). */
  const gapTo = (ids: number[], away: number[]) => Math.min(...ids.flatMap((a) => away.map((b) => hops(a, b))));
  // The best-scoring group any seed grows at this hop limit (ties: the better seed). With
  // `away` (a 1v1 fallback), among the groups scoring as much as the best, the one farthest
  // from `away` wins.
  const bestGroup = (view: View, pool: number[], size: number, seeds: number[], hop: number, away: number[] = []) => {
    const groupScore = (ids: number[]) => round2(simulate(ctx, ids, view.taken).score);
    let best: number[] | null = null;
    let bestScore = -Infinity;
    let bestGap = -Infinity;
    for (const seed of seeds.slice(0, MAX_SEEDS)) {
      const group = tryGroup(view, pool, size, seed, hop);
      if (!group) continue;
      const sc = groupScore(group);
      const gap = away.length ? gapTo(group, away) : 0;
      if (sc > bestScore || (sc === bestScore && gap > bestGap)) {
        best = group;
        bestScore = sc;
        bestGap = gap;
      }
    }
    return best;
  };
  const buildGroup = (view: View, pool: number[], size: number, label: string, away: number[] = []): number[] => {
    if (size <= 0 || !pool.length) return [];
    const score = (t: number) => view.of.get(t)!.score;
    const byScore = (a: number, b: number) => score(b) - score(a) || a - b;
    const groupScore = (ids: number[]) => simulate(ctx, ids, view.taken).score;
    const seeds = [...pool].sort(byScore);
    if (size === 1) {
      if (!away.length) return [seeds[0]!];
      // In a 1v1, the farthest from the primary among the equally scored best.
      const top = seeds.filter((t) => round2(score(t)) === round2(score(seeds[0]!)));
      let pick = top[0]!;
      for (const t of top) if (gapTo([t], away) > gapTo([pick], away)) pick = t;
      return [pick];
    }
    let widest = 0;
    for (const a of pool) for (const b of pool) if (a < b && hops(a, b) < Infinity) widest = Math.max(widest, hops(a, b));
    for (let hop = COMPACT_DISTANCE; ; hop++) {
      // Past every connected distance (and never at the compact limit itself): the
      // last try allows any distance, so it is a recorded relaxation, not "compact".
      const last = hop > Math.max(widest, COMPACT_DISTANCE);
      const group = bestGroup(view, pool, size, seeds, last ? Infinity : hop, away);
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
      // With `spread: true` in a 1v1 the hop bound must not quietly hand a far better group
      // to the fallback: spread past it when that scores SPREAD_RELAX_GAIN times as much, at
      // the smallest hop limit that does.
      const bound = Math.max(hop, SPREAD_DISTANCE);
      if (spread && !last && bound < widest) {
        const bounded = groupScore(group);
        const better = (g2: number[] | null) => {
          const sc = g2 ? groupScore(g2) : -Infinity;
          return sc > bounded && sc >= SPREAD_RELAX_GAIN * bounded ? sc : null;
        };
        if (better(bestGroup(view, pool, size, seeds, Infinity)) !== null) {
          for (let h = bound + 1; h <= widest + 1; h++) {
            const limit = h > widest ? Infinity : h;
            const wide = bestGroup(view, pool, size, seeds, limit);
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
  const primary = buildGroup(firstView, pickable, primarySize, 'primary');
  const rest = pickable.filter((t) => !primary.includes(t));
  // The fallback is granted only when someone else holds primary picks: it is scored, and
  // its reasons written, with the primary taken (#129). A list longer than twice the limit
  // (war.app's client allows players × territories per player) is a series of tiers, each a
  // group of the primary's size scored with the primary and the earlier tiers taken.
  const fallbackSize = Math.max(0, Math.min(maxPicks - primary.length, rest.length));
  const tierSize = Math.max(1, primary.length);
  const tiers: number[][] = [];
  const views = new Map<number, View>(primary.map((t) => [t, firstView]));
  let firstFallbackView: View = viewOf([], new Set(primary));
  for (let pool = rest, done = 0; done < fallbackSize && pool.length; ) {
    const taken = new Set([...primary, ...tiers.flat()]);
    const view = viewOf(pool, taken);
    if (!tiers.length) firstFallbackView = view;
    // In a 1v1 (unless spreading) the fallback is counter-pick insurance: in another area.
    const tier = buildGroup(
      view,
      pool,
      Math.min(tierSize, fallbackSize - done),
      tiers.length ? `fallback tier ${tiers.length + 1}` : 'fallback',
      !tiers.length && duel && !spread ? primary : [],
    );
    if (!tier.length) break;
    for (const t of tier) views.set(t, view);
    tiers.push(tier);
    done += tier.length;
    pool = pool.filter((t) => !tier.includes(t));
  }
  const fallback = tiers.flat();
  const firstTier = tiers[0] ?? [];
  const viewFor = (t: number) => views.get(t)!;

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

  const groupOf = (ids: number[], taken: ReadonlySet<number>): PickGroup => {
    if (!ids.length) return { territoryIds: [], score: 0, bonuses: [], maxHops: 0 };
    const sim = simulate(ctx, ids, taken);
    const done = [...sim.completions.entries()]
      .map(([id, turn]) => ({ bonusId: id, name: bonuses.get(id)!.name, value: bonuses.get(id)!.value, turn }))
      .sort((a, b) => a.turn - b.turn || a.bonusId - b.bonusId);
    const far = spreadOf(ids).far;
    return { territoryIds: ids, score: round2(sim.score), bonuses: done, maxHops: Number.isFinite(far) ? far : null };
  };

  // The award order (#129): a list is judged by the sets it can actually yield. The worst
  // outcome is scored with the other players holding the picks it implies they took; the
  // primary's order is changed only when another order raises that worst outcome.
  const outcomeCache = new Map<string, number>();
  const outcomeScore = (list: number[], ids: number[]) => {
    const taken = impliedOpponentStarts(list, ids);
    const key = `${[...ids].sort(byNum).join(',')}|${[...taken].sort(byNum).join(',')}`;
    if (!outcomeCache.has(key)) outcomeCache.set(key, round2(simulate(ctx, ids, new Set(taken)).score));
    return outcomeCache.get(key)!;
  };
  const worstOf = (list: number[], sets: number[][]) => {
    let worst: { territoryIds: number[]; score: number } | null = null;
    for (const set of sets) {
      const ids = set.map((i) => list[i]!);
      const sc = outcomeScore(list, ids);
      if (!worst || sc < worst.score) worst = { territoryIds: ids, score: sc };
    }
    return worst!;
  };
  const outcomeSets =
    primary.length > 0 ? pickOutcomes({ listLength: primary.length + fallback.length, perPlayer: primary.length, players }) : null;
  let award: AwardReport | undefined;
  if (outcomeSets) {
    const base = [...primary];
    let bestOrder = base;
    let bestWorst = worstOf([...base, ...fallback], outcomeSets);
    if (primary.length <= MAX_REORDER) {
      for (const order of permutations(base)) {
        const w = worstOf([...order, ...fallback], outcomeSets);
        if (w.score > bestWorst.score) {
          bestOrder = order;
          bestWorst = w;
        }
      }
    }
    const reordered = bestOrder !== base;
    primary.splice(0, primary.length, ...bestOrder);
    const list = [...primary, ...fallback];
    award = {
      outcomes: outcomeSets.length,
      worst: { ...bestWorst, opponentStarts: impliedOpponentStarts(list, bestWorst.territoryIds) },
      reordered,
    };
  }

  const pickOf = (t: number) => {
    const a = viewFor(t).of.get(t)!;
    return { score: a.score, reasons: a.reasons };
  };
  const picks: PickChoice[] = [
    ...primary.map((t) => ({ territoryId: t, group: 'primary' as const, ...pickOf(t) })),
    ...fallback.map((t) => ({ territoryId: t, group: 'fallback' as const, ...pickOf(t) })),
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
      : spread
        ? `In a 1v1 centrality is not penalised and entry points weigh twice as much; with spread on, a pick may join a group within ${SPREAD_DISTANCE} hops when it anchors a different bonus, so one counter-pick cannot wipe them` +
          (relaxed ? `; a group spreads farther only when no bounded group exists or spreading scores ${SPREAD_RELAX_GAIN}× as much (see the warnings).` : '.')
        : `In a 1v1 centrality is not penalised and entry points weigh twice as much; ` +
          (relaxed
            ? `each group is kept as compact as the map allows (the hop limit was relaxed; see the warnings), `
            : `each group is compact (one cluster, each pick within ${COMPACT_DISTANCE} hops of another), `) +
          'so the start has one front, not several; the fallback, in another area when one scores as much, is the insurance against a counter-pick.',
    `The first ${primary.length} picks are the primary group, ${describe(primary)}; ` +
      `the rest are a disjoint fallback${firstTier.length ? ` (${describe(firstTier)})` : ''}, granted in order when another player picks first` +
      (tiers.length > 1
        ? `; it runs in ${tiers.length} tiers of up to ${tierSize}, each scored as if the picks before it were taken.`
        : '.'),
  );

  // The fallback group's score, bonuses and spread are its first tier's: the picks granted
  // when the primary is taken.
  const groups = {
    primary: groupOf(primary, NO_TAKEN),
    fallback: { ...groupOf(firstTier, firstFallbackView.taken), territoryIds: fallback },
  };
  if (groups.fallback.score > groups.primary.score)
    warnings.push(
      `The fallback group scores more than the primary (${groups.fallback.score} vs ${groups.primary.score}): the primary keeps to ` +
        (players > 2
          ? `one compact cluster, since with ${players} players spread picks are likely contested.`
          : spread
            ? `within ${SPREAD_DISTANCE} hops unless spreading scores ${SPREAD_RELAX_GAIN}× as much.`
            : 'one compact cluster, so the start has one front; the fallback covers a counter-pick.') +
        ' Weigh the trade before submitting.',
    );
  if (award) {
    const names = (ids: number[]) => ids.map(terrName).join(', ') || 'none of this list';
    rationale.push(
      `Picks are awarded round by round in move order, the award order reversing each round, each player getting their highest-ranked territory still free: ` +
        `this list can yield ${award.outcomes} different set${award.outcomes === 1 ? '' : 's'}. The worst (score ${award.worst.score}) is ${names(award.worst.territoryIds)}` +
        (award.worst.opponentStarts.length ? `, with other players starting on ${names(award.worst.opponentStarts)}` : '') +
        '.' +
        (award.reordered ? ' The primary is ordered to raise that worst outcome, not by score.' : ''),
    );
  } else if (primary.length)
    rationale.push('Picks are awarded round by round in a reversing move order; this list has too many possible outcomes to enumerate.');
  return { picks, groups, ...(award ? { award } : {}), warnings, rationale };
}

export interface PickLimits {
  /** Territories each player can be granted: the territory limit, or fewer when the pickables cannot give everyone that many. */
  perPlayer: number;
  /** The shortest list the game accepts (perPlayer, at most 10). */
  min: number;
  /** The longest list the client lets a player build (players × perPlayer). */
  max: number;
}

/**
 * The pick-list bounds of war.app's own client (read from its bundle, #129): per player,
 * floor(pickables / players) capped by the territory limit (0: no limit); the client stops
 * adding picks at players × that, and the game's pick validation rejects a list shorter than
 * min(10, that). No maximum is enforced in that validation, only in the client's picking UI
 * (docs/WARAPP-API.md: unverified against the server). Without the pickable count the
 * territory limit stands in for the per-player share; `null` when neither is known.
 */
export function clientPickLimits(input: { territoryLimit: number | undefined; players: number; pickable?: number }): PickLimits | null {
  const players = Math.max(1, Math.floor(input.players));
  const limit = input.territoryLimit !== undefined && input.territoryLimit > 0 ? Math.floor(input.territoryLimit) : 0;
  let perPlayer: number;
  if (input.pickable === undefined) {
    if (!limit) return null;
    perPlayer = limit;
  } else {
    perPlayer = Math.floor(Math.max(0, input.pickable) / players);
    if (limit) perPlayer = Math.min(perPlayer, limit);
  }
  return { perPlayer, min: Math.min(10, perPlayer), max: players * perPlayer };
}

/** Most search states {@link pickOutcomes} explores before giving up (`null`). */
export const MAX_AWARD_STATES = 50_000;

/**
 * Every set of list positions (0 = first pick) the award order can grant (#129). Picks are
 * awarded round by round in move order, the order reversing each round, each player getting
 * the highest-ranked territory still free on their own list (the community wiki). The other
 * players' lists are unknown, so each of their picks may be any free territory of this list
 * or one outside it; this player's move position is unknown too. A position set shorter than
 * `perPlayer` means the list ran out (war.app then grants what is left). Sorted ascending,
 * each set ascending; `null` when the search would pass {@link MAX_AWARD_STATES} states.
 */
export function pickOutcomes(input: { listLength: number; perPlayer: number; players: number }): number[][] | null {
  const n = Math.max(0, Math.floor(input.listLength));
  const rounds = Math.max(0, Math.floor(input.perPlayer));
  const players = Math.max(1, Math.floor(input.players));
  if (n > 30) return null;
  const outcomes = new Set<number>();
  const seen = new Set<string>();
  let states = 0;
  // step: index into the whole pick sequence; taken: bitmask of list positions anyone holds; mine: mine.
  const visit = (pos: number, step: number, taken: number, mine: number): boolean => {
    const key = `${pos}:${step}:${taken}:${mine}`;
    if (seen.has(key)) return true;
    seen.add(key);
    if (++states > MAX_AWARD_STATES) return false;
    if (step === rounds * players) {
      outcomes.add(mine);
      return true;
    }
    const round = Math.floor(step / players);
    const slot = step % players;
    const mover = round % 2 === 0 ? slot : players - 1 - slot;
    if (mover === pos) {
      let first = -1;
      for (let i = 0; i < n; i++)
        if (!(taken & (1 << i))) {
          first = i;
          break;
        }
      return first < 0 ? visit(pos, step + 1, taken, mine) : visit(pos, step + 1, taken | (1 << first), mine | (1 << first));
    }
    // Another player: a territory outside this list, or any free one on it.
    if (!visit(pos, step + 1, taken, mine)) return false;
    for (let i = 0; i < n; i++) if (!(taken & (1 << i)) && !visit(pos, step + 1, taken | (1 << i), mine)) return false;
    return true;
  };
  for (let pos = 0; pos < players; pos++) if (!visit(pos, 0, 0, 0)) return null;
  const sets = [...outcomes].map((m) => Array.from({ length: n }, (_, i) => i).filter((i) => m & (1 << i)));
  return sets.sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
  });
}

/**
 * The other players' starts a pick list implies once picks are awarded (#129): every
 * territory ranked above the last one granted that was not granted went to another player
 * (an opponent, or a teammate in a team game) — the award gives each player their
 * highest-ranked territory still free.
 */
export function impliedOpponentStarts(list: readonly number[], granted: readonly number[]): number[] {
  const got = new Set(granted);
  let last = -1;
  list.forEach((t, i) => {
    if (got.has(t)) last = i;
  });
  return list.slice(0, last + 1).filter((t) => !got.has(t));
}

/** Every ordering of `xs`, starting with `xs` itself (lexicographic by position). */
function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}
