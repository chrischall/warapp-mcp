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
//     straight round; the game's luck is not passed in).
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
//     (deployed there). When that cannot afford it, the capture is tried in two orders
//     (#166, only at 0% luck under straight rounding and with No-Split off, where the
//     arithmetic is exact): a first attack of k armies that does not capture — it kills
//     round(k × offence) of the d defenders, leaving at least one, and loses
//     min(k, round(d × defence)) — then one sized for the defenders left; both from one
//     bordering start-of-turn territory, or the first from one (its own movable armies only)
//     and the second from another. The plan committing the fewest armies wins, then one source
//     over two, then the lower ids, then the smaller first attack; the first attack's armies
//     are spent for the turn (its survivors stay on their source), and such captures are
//     reported (`twoOrderCaptures`). At 60/70 a 3-army neutral costs 5 in one order and 4 in
//     two (1, then 3). When that cannot be paid either, the rest of the income is deployed on
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
//     defensibility 1 / (1 + weight × exposure × hardness), where weight is
//     ENTRY_WEIGHT, or ENTRY_WEIGHT_1V1 (twice as much) in a 1v1 — one opponent finds
//     every entry point, so a narrow bonus wins ties against a wide one (#73) —,
//     exposure counts each entry point once per member of the bonus it borders (#166: a
//     double border, one outside territory next to two members, counts twice; with none it
//     is the number of entry points), and hardness is how much dearer an attack is than at
//     the standard 60/70 (at 30/75 a bonus with few entry points is worth more).
//     A completed bonus is also credited by who can reach it (#166): × (1 − THREAT_LOSS × P).
//     A pickable territory q that is not one of the picks threatens a bonus completed on
//     turn T when a lone stack starting on q holds one of the bonus's territories, or a
//     territory next to one, by the end of turn T (it denies the bonus, or attacks it on
//     turn T + 1). The stack: the starting armies on q, the base income deployed on it each
//     turn, and each turn everything but the guard may go into one neighbour whose capture
//     cost it covers, arriving less the armies lost; every other territory is a neutral at
//     its size, so a wasteland in the way delays it. For T = 0 the threats are the pickables
//     next to the bonus. P is the chance an opponent stands on a threat: 1 when a known
//     opponent start (`taken`) is one; otherwise 1 − C(N − k, L) / C(N, L), with N the
//     pickables neither mine nor known, k the threats among them and L the opponent starts
//     still unknown ((players − 1) × the territory limit, less the known ones) — their starts
//     taken as drawn uniformly from the pickables left, a simplification. A pick of mine is
//     never a threat, so also holding the threatening neighbour restores the credit.
//     A negative bonus held in full costs
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
//     shared with the primary never completes for it (#129).
//     In a two-player game whose primary has 2 to 4 picks (and without `spread`, and with
//     room on the list for as many again), the first fallback tier is not a group (#166):
//     a pick ranked below the primary is granted only when the opponent holds picks above
//     it, so each is chosen for exactly those outcomes. Positions primary + 1 … 2 × primary
//     are filled one at a time. For position p, each outcome of `pickOutcomes` whose last
//     granted position is p is settled by the list so far plus the candidate: I hold the
//     granted set G and the opponent the picks above p that I was not granted, K
//     (`impliedOpponentStarts`). The candidate's value there is
//     simulate(G, K).score − OPPONENT_WEIGHT × simulate(K, G).score: my opening, less a share
//     of the opponent's from the starts the award reveals, in which my picks are known
//     threats to their bonuses — so a pick that reaches the bonus of the pick I lost scores
//     higher, and its own bonus still counts. The best mean over those outcomes wins; ties:
//     its own score with the primary taken, then id. (The opponent's opening is simulated
//     once per outcome for every candidate standing nowhere it looks.) The picks' scores and
//     reasons are still those with the primary taken, plus what each answers.
//     Otherwise in a 1v1 (a primary of one pick, or of five or more), among the equally
//     scored compact fallbacks found at its hop limit, the one farthest from the primary
//     (fewest hops between the two groups, maximised) wins, so one counter-pick cannot reach
//     both. A fallback that still outscores the primary is warned about. A list longer than
//     twice the limit (war.app's client allows players × territories per player,
//     `clientPickLimits`) runs in fallback tiers of the primary's size, each built as a group
//     with the primary and the earlier tiers taken; the fallback group's score, bonuses
//     and spread are its first tier's.
//     Only with `spread: true` in a 1v1 does the old rule apply: a pick may also join
//     when it anchors a bonus no group pick anchors and lies within SPREAD_DISTANCE hops,
//     and the bound gives way, with a warning, at the smallest hop limit where a group
//     scores SPREAD_RELAX_GAIN times the bounded one. Usually worse on large maps.
//     Each group built as a group is listed by score (an answering tier in the order its
//     picks were chosen); its maxHops and the rationale state its real
//     spread (farthest pair, and the longest step linking its picks into one cluster) and
//     call it compact only when that step is at most COMPACT_DISTANCE: one cluster, not
//     merely each pick with a group-mate nearby.
//  5b. Award order (#129). Picks are awarded round by round in move order, reversing each
//     round, each player getting their highest-ranked territory still free (`pickOutcomes`
//     enumerates the sets a list can yield, other players' lists unknown). The list's worst
//     outcome is scored with the other players on the starts it implies
//     (`impliedOpponentStarts`) and reported; the primary is reordered (up to MAX_REORDER
//     picks) only when another order raises that worst outcome. An answering fallback
//     (item 5) depends on that order: it is chosen for the score order first, and when the
//     award order prefers another, chosen again for it — the new order standing only if the
//     list as it then reads still has a better worst outcome than the list it replaces.
//  5c. Commanders (#129): the first pick awarded carries the commander, so the primary's
//     safest pick (fewest other pickables within COMPACT_DISTANCE hops, then fewest
//     neighbours outside the primary, then score) is listed first; the award reorder keeps it.
//  6. Reasons. reasons[0] is the bonus the pick anchors (worth most to it alone) and its
//     completion turn and the income it adds, or how much of it is held by the horizon;
//     then the other bonuses it completes or advances. Each such line gives the bonus's entry
//     points and which are double borders, and for a completed bonus who can reach it: no
//     other pickable territory, or the threats by name (three at most) with the score cost,
//     and "safe only if you also hold …" when there are one or two. Then the captures that
//     took two orders; negatives (shortfalls,
//     wastelands — a member other than the pick larger than an ordinary neutral —, contest,
//     negative bonuses held) come last, and after them what a pick of an answering fallback
//     answers: the lost picks whose bonus it reaches by the turn they complete it alone.

import type { GameSettings } from '../normalize.js';
import { analyzeBonus, bonusTerritories, entryTouches } from './bonuses.js';
import {
  armiesToTake,
  DEFAULT_DEFENSIVE_KILL_RATE,
  DEFAULT_OFFENSIVE_KILL_RATE,
  luckFraction,
  straightKills,
} from './combat.js';
import { bfsDistances, neighborsOf, type MapGraph } from './graph.js';
import { captureCost } from './planner.js';
import { boardIncome, DEFAULT_BASE_INCOME } from './player.js';

/** Turns the opening simulation runs (income by turn 3). */
export const PICK_HORIZON = 3;
/** Share of a still-incomplete bonus's value credited per share of it held at the horizon. */
export const PROGRESS_WEIGHT = 0.5;
/** Share of a completed bonus's credit lost when an opponent certainly starts where it can be reached in time (#166). */
export const THREAT_LOSS = 0.5;
/**
 * In a two-player game a fallback pick is worth its own opening less this share of the
 * opponent's, from the starts the award then reveals (#166).
 */
export const OPPONENT_WEIGHT = 0.5;
/** Defensibility penalty per unit of exposure — an entry point, once per member it borders — scaled by attack hardness… */
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
/** Territories a reason names before it says "and n more". */
const MAX_NAMED = 3;

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
    | 'commanders'
    | 'noSplit'
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
  /**
   * The pick's own score: the bonus armies its opening alone earns, weighted by each bonus's
   * defensibility and by who can reach it, and by the pick's contestedness (a fallback pick's:
   * with the primary taken).
   */
  score: number;
  reasons: string[];
}

export interface GroupBonus {
  bonusId: number;
  name: string;
  value: number;
  /** Turn the group completes it in the opening simulation (0: held by the picks themselves). */
  turn: number;
  /**
   * The pickable territories outside the group from which a lone stack holds or stands next to
   * one of its territories by that turn, so could attack it the turn after (#166); ascending.
   */
  threats: number[];
}

/** One order of the opening simulation: `armies` attacking out of `from`. */
export interface PickOrder {
  from: number;
  armies: number;
}

/**
 * A neutral the opening simulation takes in two orders because no single one can be paid for
 * (#166): the first only wears it down, and its armies are spent for the turn; the second takes
 * it. Exact arithmetic, so only at 0% luck under straight rounding, and never with No-Split.
 */
export interface TwoOrderCapture {
  /** Turn of the opening simulation. */
  turn: number;
  /** The neutral taken. */
  territoryId: number;
  orders: [PickOrder, PickOrder];
}

export interface PickGroup {
  /**
   * In list order: by score (then id) for a group built as a group, unless the award order or the
   * commander reorders the primary; a two-player fallback that answers losses, in the order its
   * picks were chosen.
   */
  territoryIds: number[];
  /** The group's joint simulation score (the fallback's: its first tier's, with the primary taken). */
  score: number;
  /** Bonuses the group completes within PICK_HORIZON turns. */
  bonuses: GroupBonus[];
  /** The captures of its joint opening that take two orders, in the order they are made (#166). */
  twoOrderCaptures: TwoOrderCapture[];
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

/**
 * The coverage-first alternative (#166): as many picks as the primary — a pair within
 * COMPACT_DISTANCE hops chosen as the primary's best pair would be, then the picks that most raise
 * coverage (ties: their own score, then id) — scored by the same opening simulation.
 */
export interface AlternativePicks {
  group: PickGroup;
  coverage: CoverageReport;
  /** Its fallback, built for it by the rule the primary's fallback uses. */
  fallback: number[];
  /** What warapp_submit_picks takes for this list: its picks, then its fallback. */
  submitPicks: number[];
}

export interface PickPlan {
  picks: PickChoice[];
  groups: { primary: PickGroup; fallback: PickGroup };
  /** The list judged by what the award order can give; absent when too many outcomes to enumerate (#129). */
  award?: AwardReport;
  /** The primary group's coverage ({@link coverageModel}, #166). */
  coverage: CoverageReport;
  /**
   * A coverage-first list beside the compact primary (#166): only in a two-player game without
   * `spread`, and only when it covers more reasonable bonuses than the primary does.
   */
  alternative?: AlternativePicks;
  warnings: string[];
  rationale: string[];
}

const byNum = (a: number, b: number) => a - b;
const NO_TAKEN: ReadonlySet<number> = new Set();
const round2 = (x: number) => Math.round(x * 100) / 100;
/** `a` sorts before `b`, compared element by element. */
const lexLess = (a: readonly number[], b: readonly number[]) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return a.length < b.length;
};

interface BonusInfo {
  id: number;
  name: string;
  value: number;
  members: number[];
  entryPoints: number;
  /** Entry points that border two or more of its territories, ascending, with how many. */
  doubleBorders: { territoryId: number; touches: number }[];
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
  /** Kill rates (percent), for a capture in two orders. */
  off: number;
  def: number;
  /** One neutral may be taken in two orders: 0% luck, straight rounding, No-Split off (#166). */
  twoOrders: boolean;
  /** Pickable territories on the map. */
  pickCount: number;
  /** Starts the other players are granted in all: (players − 1) × the territory limit. */
  opponentStarts: number;
  /**
   * Bonus id → by completion turn 0..PICK_HORIZON, the pickable territories that reach it by
   * then (hold a member, or a territory next to one), ascending (#166).
   */
  threats: Map<number, number[][]>;
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
  /** Per completed bonus, the pickables not in `start` that reach it by its completion turn, ascending. */
  threats: Map<number, number[]>;
  /** Per completed bonus, the chance an opponent starts on one of them ({@link threatChance}). */
  risk: Map<number, number>;
  /** Captures made in two orders, in the order they are made. */
  twoOrders: TwoOrderCapture[];
  /** The territories held at the horizon. */
  held: ReadonlySet<number>;
  /** The income of each turn 1..PICK_HORIZON (index 0: turn 1), as the simulation deployed it. */
  incomes: number[];
  score: number;
}

const NO_THREATS: readonly number[] = [];

/**
 * The chance that an opponent starts on one of `threats` (pickables that are not mine). 1 when
 * a known opponent start (`taken`) is among them. Otherwise the opponent starts still unknown
 * — (players − 1) × the territory limit, less the known ones — are taken to be drawn uniformly
 * from the pickables that are neither mine nor known: 1 − C(N − k, L) / C(N, L).
 */
function threatChance(ctx: Ctx, threats: readonly number[], mine: number, taken: ReadonlySet<number>, known: number): number {
  if (!threats.length) return 0;
  for (const q of threats) if (taken.has(q)) return 1;
  const n = Math.max(0, ctx.pickCount - mine - known);
  const unknown = Math.min(Math.max(0, ctx.opponentStarts - known), n);
  const k = threats.length;
  if (unknown <= 0) return 0;
  if (n - k < unknown) return 1;
  let none = 1;
  for (let i = 0; i < unknown; i++) none *= (n - k - i) / (n - i);
  return 1 - none;
}

/** The bonuses with a territory in or next to `from`, ascending: the ones an opening from there can touch. */
function relevantBonuses(ctx: Ctx, from: Iterable<number>): number[] {
  const ids = new Set<number>();
  for (const t of from) {
    for (const b of ctx.bonusesOf.get(t) ?? []) ids.add(b);
    for (const n of neighborsOf(ctx.g, t)) for (const b of ctx.bonusesOf.get(n) ?? []) ids.add(b);
  }
  return [...ids].sort(byNum);
}

/**
 * Every territory whose owner an opening looked at: the members of each bonus it could touch,
 * and the pickables that reach a bonus it completed. Giving any other territory to someone
 * else changes nothing in that opening but the count of known starts.
 */
function territoriesRead(ctx: Ctx, sim: SimResult): Set<number> {
  const read = new Set<number>();
  for (const id of relevantBonuses(ctx, sim.held)) for (const m of ctx.bonuses.get(id)!.members) read.add(m);
  for (const reach of sim.threats.values()) for (const q of reach) read.add(q);
  return read;
}

/**
 * The opening from `start`. `taken` territories belong to someone else (the primary picks when
 * the fallback is granted, #129): never captured, so a bonus holding one never completes.
 * `known` is how many of the other players' starts are known (all of `taken`, unless the caller
 * knows of one more that this opening never comes near).
 */
function simulate(
  ctx: Ctx,
  start: readonly number[],
  taken: ReadonlySet<number> = NO_TAKEN,
  known: number = taken.size,
): SimResult {
  const held = new Set(start);
  // Armies on each held territory: armies attack only from where they stand.
  const armiesOn = new Map<number, number>(start.map((t) => [t, ctx.pickArmies]));
  const completions = new Map<number, number>();
  // The bonuses the territories held can touch, worked out again only when more are held.
  let touching: number[] | null = null;
  const relevant = () => (touching ??= relevantBonuses(ctx, held));
  const penalties = new Map<number, number>();
  const twoOrders: TwoOrderCapture[] = [];
  const incomes: number[] = [];
  const checkComplete = (turn: number) => {
    for (const id of relevant()) {
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
    if (!ctx.penalties.size) return v;
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
    incomes.push(income.total);
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
    // A capture in two orders (#166), for a target no single source can pay for: a first attack
    // of k armies that does not capture (it kills round(k × offence) of the d defenders, leaving
    // at least one, and loses min(k, round(d × defence))), then one sized for the defenders left.
    // Both from one bordering start-of-turn territory (its movable armies and the deploys it may
    // receive), or the first from one using only its own movable armies and the second from
    // another. The fewest armies committed wins, then one source over two, then the lower ids,
    // then the smaller first attack.
    const twoOrderPlan = (target: number) => {
      const d = ctx.armies.get(target)!;
      const sources = neighborsOf(ctx.g, target).filter((n) => startSet.has(n) && n !== saveAt);
      if (!ctx.twoOrders || ctx.off <= 0 || d < 2 || !sources.length) return null;
      const reach = new Map(sources.map((n) => [n, avail.get(n)! + deployAt(n)]));
      const most = Math.max(...reach.values());
      let best: { key: number[]; first: number; second: number; k: number; rest: number; then: number } | null = null;
      for (let k = 1; k <= most; k++) {
        const kills = straightKills(k, ctx.off);
        if (kills >= d) break;
        if (kills < 1) continue;
        const rest = d - kills;
        const then = armiesToTake(rest, { offensiveKillRate: ctx.off, defensiveKillRate: ctx.def })!;
        for (const first of sources)
          for (const second of sources) {
            const can =
              first === second ? reach.get(first)! >= k + then : avail.get(first)! >= k && reach.get(second)! >= then;
            if (!can) continue;
            const key = [k + then, first === second ? 1 : 2, first, second, k];
            if (!best || lexLess(key, best.key)) best = { key, first, second, k, rest, then };
          }
      }
      return best;
    };
    // Bonuses whose next capture cannot be paid for this turn.
    const skipped = new Set<number>();
    // This turn's attacks, in order: the armies left over follow them (#129).
    const attacks: { source: number; target: number }[] = [];
    // The bonuses this turn can work on, set up once (the simulation runs very many times): what
    // is left to capture, and the members next to a territory held at the start of the turn,
    // cheapest first (then id). Within the turn only the captures change: `rem` falls, and a
    // captured target is passed over.
    const reachable = new Set<number>();
    for (const t of startHeld) for (const n of neighborsOf(ctx.g, t)) reachable.add(n);
    interface Open {
      id: number;
      net: number;
      rem: number;
      targets: number[];
      next: number;
    }
    const open: Open[] = [];
    const openById = new Map<number, Open>();
    for (const id of relevant()) {
      if (completions.has(id)) continue;
      const b = ctx.bonuses.get(id)!;
      let rem = 0;
      let blocked = false;
      const targets: number[] = [];
      for (const m of b.members) {
        if (held.has(m)) continue;
        const c = taken.has(m) ? null : ctx.cost.get(m);
        if (c === null || c === undefined) {
          blocked = true;
          break;
        }
        rem += c;
        if (reachable.has(m)) targets.push(m);
      }
      if (blocked || !targets.length || rem === 0) continue;
      const net = netValue(b);
      if (net <= 0) continue;
      targets.sort((x, y) => ctx.cost.get(x)! - ctx.cost.get(y)! || x - y);
      const o = { id, net, rem, targets, next: 0 };
      open.push(o);
      openById.set(id, o);
    }
    const capture = (target: number) => {
      captured.add(target);
      for (const id of ctx.bonusesOf.get(target) ?? []) {
        const o = openById.get(id);
        if (o) o.rem -= ctx.cost.get(target)!;
      }
    };
    for (;;) {
      let best: { id: number; ratio: number; rem: number; target: number; cost: number } | null = null;
      for (const o of open) {
        if (skipped.has(o.id)) continue;
        while (o.next < o.targets.length && captured.has(o.targets[o.next]!)) o.next++;
        if (o.next >= o.targets.length || o.rem === 0) continue;
        const { id, rem } = o;
        const ratio = o.net / rem;
        if (!best || ratio > best.ratio || (ratio === best.ratio && (rem < best.rem || (rem === best.rem && id < best.id)))) {
          const target = o.targets[o.next]!;
          best = { id, ratio, rem, target, cost: ctx.cost.get(target)! };
        }
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
      const two = source < 0 || own + deploy < best.cost ? twoOrderPlan(best.target) : null;
      if (two) {
        const { first, second, k, rest, then } = two;
        // The first attack: its armies are spent for the turn, and its survivors stay put.
        const dead = Math.min(k, straightKills(ctx.armies.get(best.target)!, ctx.def));
        const pay = (t: number, n: number) => {
          const fromOwn = Math.min(avail.get(t)!, n);
          avail.set(t, avail.get(t)! - fromOwn);
          armiesOn.set(t, armiesOn.get(t)! - fromOwn);
          spend(t, n - fromOwn);
        };
        pay(first, k);
        armiesOn.set(first, armiesOn.get(first)! + k - dead);
        pay(second, then);
        capture(best.target);
        attacks.push({ source: second, target: best.target });
        armiesOn.set(best.target, then - straightKills(rest, ctx.def));
        twoOrders.push({
          turn,
          territoryId: best.target,
          orders: [
            { from: first, armies: k },
            { from: second, armies: then },
          ],
        });
        continue;
      }
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
      capture(best.target);
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
    if (captured.size) touching = null;
    checkComplete(turn);
  }
  const progress = new Map<number, number>();
  const threats = new Map<number, number[]>();
  const risk = new Map<number, number>();
  const mine = new Set(start);
  let score = 0;
  for (const id of relevant()) {
    const b = ctx.bonuses.get(id)!;
    const turn = completions.get(id);
    if (turn !== undefined) {
      // Credited by who can reach it (#166): my own picks are no threat to it.
      const reach = (ctx.threats.get(id)?.[turn] ?? NO_THREATS).filter((q) => !mine.has(q));
      const p = threatChance(ctx, reach, start.length, taken, known);
      threats.set(id, reach);
      risk.set(id, p);
      score += b.value * (PICK_HORIZON + 1 - turn) * b.defense * (1 - THREAT_LOSS * p);
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
  return { completions, penalties, progress, threats, risk, twoOrders, held, incomes, score };
}

/** What {@link openingIncome} simulates from. */
export interface OpeningIncomeInput {
  graph: MapGraph;
  /** The territories the player starts on (unknown ids are ignored). */
  starts: readonly number[];
  settings?: PickSettings;
  /** Territories someone else holds (my starts, when simulating the opponent's): never captured. */
  taken?: readonly number[];
  /**
   * The territories pickable during distribution, for the neutral sizes: an unpicked one is
   * InitialNeutralsInDistribution, the rest InitialNonDistributionArmies. Absent: the starts and
   * `taken` count as the pickables, so every other territory is a non-distribution neutral.
   */
  pickable?: readonly number[];
  /** Neutral armies as a board shows them (wastelands included), by territory id: these win. */
  neutralArmies?: ReadonlyMap<number, number>;
}

/**
 * The income the pick advisor's opening simulation gives a player from `starts` on each turn
 * 1..PICK_HORIZON + 1 (index 0: turn 1), the last being what it holds after PICK_HORIZON turns
 * (#166: the opening threat model, from the opponent's starts the award of picks proves). The same
 * simulation, rules and income rule (`boardIncome`) as {@link planPicks}; the settings it lacks
 * take its defaults. Pure and deterministic.
 */
export function openingIncome(input: OpeningIncomeInput): number[] {
  const { graph: g } = input;
  const s = input.settings ?? {};
  const starts = [...new Set(input.starts)].filter((t) => g.territoryById.has(t)).sort(byNum);
  const taken = new Set((input.taken ?? []).filter((t) => g.territoryById.has(t) && !starts.includes(t)));
  const pickSet = new Set(input.pickable ?? [...starts, ...taken]);
  const known = input.neutralArmies ?? new Map<number, number>();
  const neutralsIn = s.initialNeutralsInDistribution ?? DEFAULT_NEUTRALS_IN_DISTRIBUTION;
  const neutralsOut = s.initialNonDistributionArmies ?? DEFAULT_NON_DISTRIBUTION_ARMIES;
  const off = s.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  const def = s.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  const rates = { offensiveKillRate: off, defensiveKillRate: def, luckModifier: s.luckModifier };
  const { armies, cost, lost } = territoryCosts(g, (t) => known.get(t) ?? (pickSet.has(t) ? neutralsIn : neutralsOut), rates);
  // Defensibility weighs only the score, never the income: no weight.
  const { bonuses, bonusesOf, penalties, penaltiesOf } = bonusTables(g, 0, 1);
  const ctx: Ctx = {
    g,
    cost,
    lost,
    armies,
    bonuses,
    bonusesOf,
    penalties,
    penaltiesOf,
    pickArmies: s.initialPlayerArmiesPerTerritory ?? DEFAULT_PICK_ARMIES,
    guard: s.oneArmyStandsGuard === false ? 0 : 1,
    baseIncome: s.minimumArmyBonus ?? DEFAULT_BASE_INCOME,
    bonusArmyPer: s.bonusArmyPer ?? 0,
    localDeployments: s.localDeployments === true,
    off,
    def,
    twoOrders: luckFraction(s.luckModifier) === 0 && (s.roundingMode === undefined || s.roundingMode === 'StraightRound') && s.noSplit !== true,
    pickCount: pickSet.size,
    opponentStarts: 0,
    threats: new Map(),
  };
  const sim = simulate(ctx, starts, taken);
  const last = boardIncome(g, sim.held, { base: ctx.baseIncome, per: ctx.bonusArmyPer }).total;
  return [...sim.incomes, last];
}

function luckPercent(v: number | undefined): number {
  if (!v || v <= 0) return 0;
  return Math.round(Math.min(v > 1 ? v / 100 : v, 0.95) * 100);
}

/** Neutral armies, capture cost and the armies a capture loses, per territory of the map. */
function territoryCosts(
  g: MapGraph,
  neutralOf: (t: number) => number,
  rates: { offensiveKillRate: number; defensiveKillRate: number; luckModifier?: number | undefined },
): { armies: Map<number, number>; cost: Map<number, number | null>; lost: Map<number, number> } {
  const armies = new Map<number, number>();
  const cost = new Map<number, number | null>();
  const lost = new Map<number, number>();
  for (const t of g.map.territories) {
    const n = Math.max(0, neutralOf(t.id));
    armies.set(t.id, n);
    cost.set(t.id, captureCost(n, rates));
    lost.set(t.id, straightKills(n, rates.defensiveKillRate));
  }
  return { armies, cost, lost };
}

/** The bonuses the opening steers for (value > 0) and the negative ones it is charged for, by id and by territory. */
function bonusTables(
  g: MapGraph,
  entryWeight: number,
  hardness: number,
): {
  bonuses: Map<number, BonusInfo>;
  bonusesOf: Map<number, number[]>;
  penalties: Map<number, BonusInfo>;
  penaltiesOf: Map<number, number[]>;
} {
  // Anchorable bonuses: value > 0, territories listed directly (superbonuses skipped).
  const bonuses = new Map<number, BonusInfo>();
  const bonusesOf = new Map<number, number[]>();
  for (const b of g.map.bonuses) {
    if (b.value <= 0 || b.bonusIds.length > 0) continue;
    const a = analyzeBonus(g, b.id)!;
    const members = a.territoryIds.filter((t) => g.territoryById.has(t));
    if (!members.length) continue;
    // Exposure: each entry point counted once per member it borders, so a double border
    // (one outside territory next to two members) weighs twice (#166).
    const touches = [...entryTouches(g, b.id)];
    const exposure = touches.reduce((n, [, k]) => n + k, 0);
    bonuses.set(b.id, {
      id: b.id,
      name: b.name,
      value: b.value,
      members,
      entryPoints: a.entryPointIds.length,
      doubleBorders: touches.filter(([, k]) => k > 1).map(([territoryId, k]) => ({ territoryId, touches: k })),
      defense: 1 / (1 + entryWeight * exposure * hardness),
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
    penalties.set(b.id, { id: b.id, name: b.name, value: b.value, members, entryPoints: 0, doubleBorders: [], defense: 1 });
    for (const t of members) penaltiesOf.set(t, [...(penaltiesOf.get(t) ?? []), b.id]);
  }
  return { bonuses, bonusesOf, penalties, penaltiesOf };
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
  const players = Number.isFinite(input.players) ? Math.max(1, Math.floor(input.players)) : 2;
  const maxPicks = Math.max(0, Math.floor(input.maxPicks));
  const limit = Math.max(0, Math.floor(input.territoryLimit));
  const duel = players <= 2;
  const entryWeight = duel ? ENTRY_WEIGHT_1V1 : ENTRY_WEIGHT;
  const rates = { offensiveKillRate: off, defensiveKillRate: def, luckModifier: s.luckModifier };

  // Per-territory capture cost.
  const { armies, cost, lost } = territoryCosts(g, (t) => known.get(t) ?? (pickSet.has(t) ? neutralsIn : neutralsOut), rates);

  // Attack hardness vs the standard kill rates, for defensibility.
  const probe = armiesToTake(HARDNESS_PROBE, { offensiveKillRate: off, defensiveKillRate: def });
  const standard = armiesToTake(HARDNESS_PROBE)!;
  const hardness = probe === null ? 4 : Math.max(0.25, probe / standard);

  /** The size a neutral starts at when nothing special is placed on it. */
  const ordinary = (t: number) => (pickSet.has(t) ? neutralsIn : neutralsOut);

  const { bonuses, bonusesOf, penalties, penaltiesOf } = bonusTables(g, entryWeight, hardness);

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
    off,
    def,
    twoOrders: luckFraction(s.luckModifier) === 0 && (s.roundingMode === undefined || s.roundingMode === 'StraightRound') && s.noSplit !== true,
    pickCount: pickable.length,
    opponentStarts: (players - 1) * limit,
    threats: new Map(),
  };

  // Who can reach a bonus (#166). From each pickable territory q, a lone stack: the starting
  // armies on q, then each turn the base income is deployed on it and it may send everything
  // but the guard into one neighbour whose capture cost that covers, arriving with what it
  // sent less the armies lost. Every other territory is a neutral at its size. `most` is the
  // most armies the stack can have on a territory at the end of the turn — more is never worse
  // — so the first turn a territory appears is the earliest it can be held.
  const arrivalFrom = (q: number): Map<number, number> => {
    const arrival = new Map<number, number>([[q, 0]]);
    let most = new Map<number, number>([[q, pickArmies]]);
    for (let turn = 1; turn <= PICK_HORIZON; turn++) {
      const next = new Map<number, number>();
      const put = (t: number, n: number) => {
        if ((next.get(t) ?? -1) < n) next.set(t, n);
      };
      for (const [from, n] of most) {
        put(from, n + baseIncome);
        const sent = n - guard + baseIncome;
        for (const to of neighborsOf(g, from)) {
          const c = cost.get(to);
          if (to === q || c === null || c === undefined || sent < c) continue;
          put(to, sent - lost.get(to)!);
          if (!arrival.has(to)) arrival.set(to, turn);
        }
      }
      most = next;
    }
    return arrival;
  };
  // A bonus is reached through its zone: its territories (holding one denies it) and the
  // territories next to them (standing there means an attack the turn after).
  const zoneOf = new Map<number, number[]>();
  for (const b of bonuses.values()) {
    const zone = new Set(b.members);
    for (const m of b.members) for (const n of neighborsOf(g, m)) zone.add(n);
    for (const t of zone) zoneOf.set(t, [...(zoneOf.get(t) ?? []), b.id]);
  }
  /** Bonus id → pickable territory → the earliest turn-end its stack is in the bonus's zone. */
  const reach = new Map<number, Map<number, number>>();
  for (const q of pickable)
    for (const [t, turn] of arrivalFrom(q))
      for (const id of zoneOf.get(t) ?? []) {
        let by = reach.get(id);
        if (!by) reach.set(id, (by = new Map()));
        const known = by.get(q);
        if (known === undefined || turn < known) by.set(q, turn);
      }
  // Per bonus and completion turn, once: `simulate` only filters these (it runs very many times).
  for (const [id, by] of reach)
    ctx.threats.set(
      id,
      Array.from({ length: PICK_HORIZON + 1 }, (_, turn) => [...by].filter(([, at]) => at <= turn).map(([q]) => q)),
    );

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
    /** The bonuses the pick completes alone, by turn. */
    completions: Map<number, number>;
  }
  const terrName = (id: number) => g.territoryById.get(id)?.name ?? String(id);
  /** "3 entry points, 1 a double border (T7 touches 2 of its territories)"; three named at most. */
  const entriesText = (b: BonusInfo) => {
    const entries = `${b.entryPoints} entry point${b.entryPoints === 1 ? '' : 's'}`;
    const doubles = b.doubleBorders;
    if (!doubles.length) return entries;
    const shown = doubles
      .slice(0, MAX_NAMED)
      .map((d, i) => `${terrName(d.territoryId)} touches ${d.touches}${i === 0 ? ' of its territories' : ''}`);
    const more = doubles.length > MAX_NAMED ? ` and ${doubles.length - MAX_NAMED} more` : '';
    return `${entries}, ${doubles.length === 1 ? '1 a double border' : `${doubles.length} double borders`} (${shown.join(', ')}${more})`;
  };
  /** "A", "A and B", "A, B and C", then "A, B, C and n more". */
  const namesOf = (ids: readonly number[]) => {
    const names = ids.slice(0, MAX_NAMED).map(terrName);
    if (ids.length > MAX_NAMED) return `${names.join(', ')} and ${ids.length - MAX_NAMED} more`;
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
  };
  /** Who can reach a bonus completed on `turn`, and what that costs its credit (#166). */
  const threatText = (threats: readonly number[], p: number, turn: number, taken: ReadonlySet<number>) => {
    const by = `by turn ${turn + 1}`;
    if (!threats.length) return `no other pickable territory can reach it ${by}`;
    const pct = Math.round(THREAT_LOSS * p * 100);
    const cost = pct >= 1 ? `score −${pct}%` : 'score down by less than 1%';
    const known = threats.filter((q) => taken.has(q));
    if (known.length) return `${namesOf(known)} (another player's when this pick is granted) can reach it ${by} (${cost})`;
    if (p <= 0) return `no other player's start can reach it ${by}`;
    return (
      `${namesOf(threats)} can reach it ${by} (${cost})` +
      (threats.length <= 2 ? `, safe only if you also hold ${namesOf(threats)}` : '')
    );
  };
  const assess = (t: number, taken: ReadonlySet<number>): Assessment => {
    const sim = simulate(ctx, [t], taken);
    const factor = contestFactor(t);
    const lines: { id: number; worth: number; head: string; point: string; negatives: string[] }[] = [];
    const touched = [...new Set([...sim.completions.keys(), ...sim.progress.keys()])].sort(byNum);
    for (const id of touched) {
      const b = bonuses.get(id)!;
      const turn = sim.completions.get(id);
      const head = `${b.name} (+${b.value})`;
      const entries = entriesText(b);
      const negatives: string[] = [];
      let point: string;
      let worth: number;
      if (turn !== undefined) {
        const when =
          turn === 0
            ? 'held at once (single-territory bonus)'
            : turn === 1
              ? 'first-turn bonus (complete on turn 1)'
              : `complete on turn ${turn}`;
        const p = sim.risk.get(id) ?? 0;
        const reached = threatText(sim.threats.get(id) ?? NO_THREATS, p, turn, taken);
        point = `${head}: ${when}, +${b.value} income from turn ${turn + 1}; ${entries}; ${reached}`;
        worth = b.value * (PICK_HORIZON + 1 - turn) * (1 - THREAT_LOSS * p);
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
      lines.push({ id, worth, head, point, negatives });
    }
    lines.sort((a, b) => b.worth - a.worth || a.id - b.id);
    // Captures that take two orders (#166), each under the first bonus listed that holds it.
    const twice = sim.twoOrders.map((c) => {
      const [first, second] = c.orders;
      const of = lines.find((l) => bonuses.get(l.id)!.members.includes(c.territoryId));
      const armies = `${first.armies} arm${first.armies === 1 ? 'y' : 'ies'}`;
      const how =
        first.from === second.from
          ? `${armies} first, then ${second.armies}`
          : `${armies} from ${terrName(first.from)} first, then ${second.armies} from ${terrName(second.from)}`;
      return `${of ? `${of.head} needs` : 'Needs'} two orders on ${terrName(c.territoryId)}: ${how}`;
    });
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
      why.push(...twice);
      for (const l of lines) why.push(...l.negatives);
    } else why.push(`No bonus within reach in ${PICK_HORIZON} turns`);
    why.push(...charged);
    if (contestWeight > 0 && 1 - factor >= 0.05)
      why.push(`Central: likely contested with ${players} players (score −${Math.round((1 - factor) * 100)}%)`);
    return { score: round2(sim.score * factor), reasons: why, anchor: anchor?.id ?? null, completions: sim.completions };
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
  /** What building a group has to say: its warnings, and the hop limit it was relaxed to (absent: not relaxed; Infinity: until every pick could join), by group label. */
  interface GroupNotes {
    warnings: string[];
    relaxedTo: Map<string, number>;
  }
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
    // None of the best seeds grows a group at this hop limit: try the rest, first that grows,
    // before the caller relaxes the limit (as the single-seed search did; #143).
    if (!best)
      for (const seed of seeds.slice(MAX_SEEDS)) {
        const group = tryGroup(view, pool, size, seed, hop);
        if (group) return group;
      }
    return best;
  };
  const buildGroup = (
    view: View,
    pool: number[],
    size: number,
    label: string,
    away: number[] = [],
    notes: GroupNotes = { warnings, relaxedTo },
  ): number[] => {
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
        notes.relaxedTo.set(label, last ? Infinity : hop);
        notes.warnings.push(
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
            notes.relaxedTo.set(label, limit);
            const within = Number.isFinite(limit) ? `within ${limit} hops` : 'any distance';
            notes.warnings.push(
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

  const primarySize = Math.min(limit, maxPicks, pickable.length);
  if (pickable.length < limit)
    warnings.push(
      `Only ${pickable.length} pickable territor${pickable.length === 1 ? 'y' : 'ies'} for a limit of ${limit}: the list has no full fallback.`,
    );
  const primary = buildGroup(firstView, pickable, primarySize, 'primary');
  const rest = pickable.filter((t) => !primary.includes(t));
  // Commanders (#129): the first pick awarded carries the commander, so the primary's safest
  // pick goes first — the fewest other pickable territories (where other players may start)
  // within COMPACT_DISTANCE hops, then the fewest neighbours outside the primary, then score.
  let commanderPick: number | null = null;
  let commanderExposure = 0;
  /** Of `ids`, the pick safest to carry the commander: fewest other pickables within reach, then fewest outside neighbours, then score. */
  const safestOf = (ids: readonly number[]) => {
    const inSet = new Set(ids);
    const exposure = (t: number) => pickable.filter((o) => !inSet.has(o) && hops(t, o) <= COMPACT_DISTANCE).length;
    const open = (t: number) => neighborsOf(g, t).filter((n) => !inSet.has(n)).length;
    const score = (t: number) => firstView.of.get(t)!.score;
    const pick = [...ids].sort((a, b) => exposure(a) - exposure(b) || open(a) - open(b) || score(b) - score(a) || a - b)[0]!;
    return { pick, exposure: exposure(pick) };
  };
  if (s.commanders && primary.length) {
    ({ pick: commanderPick, exposure: commanderExposure } = safestOf(primary));
    primary.splice(0, primary.length, commanderPick, ...primary.filter((t) => t !== commanderPick));
  }

  /** The joint opening's score from `start` with `taken` held by someone else, remembered. */
  const simScores = new Map<string, number>();
  const simScore = (start: readonly number[], taken: readonly number[]) => {
    const key = `${[...start].sort(byNum).join(',')}|${[...taken].sort(byNum).join(',')}`;
    let sc = simScores.get(key);
    if (sc === undefined) simScores.set(key, (sc = simulate(ctx, start, new Set(taken)).score));
    return sc;
  };

  // The fallback is granted only when someone else holds primary picks: it is scored, and
  // its reasons written, with the primary taken (#129). A list longer than twice the limit
  // (war.app's client allows players × territories per player) is a series of tiers, each a
  // group of the primary's size scored with the primary and the earlier tiers taken.
  const fallbackSize = Math.max(0, Math.min(maxPicks - primary.length, rest.length));
  const tierSize = Math.max(1, primary.length);
  // In a two-player game with 2 to 4 picks each (#166) the first tier is not a second group:
  // each of its picks answers the loss that grants it. `answerSets` are the sets of list
  // positions the award can grant from a list of twice the primary; null: the tier rule stands.
  const answerSets =
    players === 2 && !spread && primary.length >= 2 && primary.length <= 4 && fallbackSize >= primary.length
      ? pickOutcomes({ listLength: 2 * primary.length, perPlayer: primary.length, players })
      : null;
  // Positions primary + 1 … 2 × primary, one at a time. A pick at position p is granted exactly
  // in the outcomes whose last granted position is p, and each of those is settled by the list
  // so far plus the candidate: I hold the granted set G, the opponent the picks above p that I
  // was not granted, K. The candidate is worth my opening from G with K the opponent's, less
  // OPPONENT_WEIGHT × the opponent's from K with G mine — so standing where a lost pick's bonus
  // can be reached counts (a known threat halves its credit), and so does its own bonus. The
  // best mean over those outcomes wins; ties: its own score with the primary taken, then id.
  const answerTier = (order: readonly number[], view: View, others: readonly number[] = rest): number[] => {
    const n = order.length;
    const list = [...order];
    for (let p = n; p < 2 * n; p++) {
      const sets = answerSets!
        .filter((o) => o[o.length - 1] === p)
        .map((o) => {
          const kept = o.slice(0, -1).map((i) => list[i]!);
          const lost = list.filter((_, i) => !o.includes(i));
          // Most candidates stand nowhere the opponent's opening looks: for those it is the
          // same opening, simulated once with one more start of mine known.
          const apart = simulate(ctx, lost, new Set(kept), kept.length + 1);
          return { kept, lost, apart: apart.score, read: territoriesRead(ctx, apart) };
        });
      let best: { t: number; value: number; own: number } | null = null;
      for (const c of others) {
        if (list.includes(c)) continue;
        const own = view.of.get(c)!.score;
        // No outcome ends at p: the candidate's own score with the primary taken decides.
        let value = own;
        if (sets.length) {
          let sum = 0;
          for (const o of sets) {
            const granted = [...o.kept, c];
            const theirs = o.read.has(c) ? simScore(o.lost, granted) : o.apart;
            sum += simScore(granted, o.lost) - OPPONENT_WEIGHT * theirs;
          }
          value = round2(sum / sets.length);
        }
        if (!best || value > best.value || (value === best.value && own > best.own)) best = { t: c, value, own };
      }
      if (!best) break;
      list.push(best.t);
    }
    return list.slice(n);
  };
  interface Fallback extends GroupNotes {
    tiers: number[][];
    /** The view each listed pick is scored in. */
    views: Map<number, View>;
    /** The first tier's view: the primary taken. */
    firstView: View;
  }
  const buildFallback = (order: readonly number[], others: readonly number[] = rest): Fallback => {
    const out: Fallback = {
      tiers: [],
      views: new Map<number, View>(order.map((t) => [t, firstView])),
      firstView: viewOf([], new Set(order)),
      warnings: [],
      relaxedTo: new Map(),
    };
    let pool = [...others];
    let done = 0;
    const add = (tier: number[], view: View) => {
      for (const t of tier) out.views.set(t, view);
      out.tiers.push(tier);
      done += tier.length;
      pool = pool.filter((t) => !tier.includes(t));
    };
    if (answerSets) {
      out.firstView = viewOf(pool, new Set(order));
      add(answerTier(order, out.firstView, others), out.firstView);
    }
    while (done < fallbackSize && pool.length) {
      const view = viewOf(pool, new Set([...order, ...out.tiers.flat()]));
      if (!out.tiers.length) out.firstView = view;
      // In a 1v1 (unless spreading) a first tier built as a group is counter-pick insurance: in another area.
      const tier = buildGroup(
        view,
        pool,
        Math.min(tierSize, fallbackSize - done),
        out.tiers.length ? `fallback tier ${out.tiers.length + 1}` : 'fallback',
        !out.tiers.length && duel && !spread ? [...order] : [],
        out,
      );
      if (!tier.length) break;
      add(tier, view);
    }
    return out;
  };
  let listed = buildFallback(primary);

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
    if (!ids.length) return { territoryIds: [], score: 0, bonuses: [], twoOrderCaptures: [], maxHops: 0 };
    const sim = simulate(ctx, ids, taken);
    const done = [...sim.completions.entries()]
      .map(([id, turn]) => ({
        bonusId: id,
        name: bonuses.get(id)!.name,
        value: bonuses.get(id)!.value,
        turn,
        threats: [...(sim.threats.get(id) ?? [])],
      }))
      .sort((a, b) => a.turn - b.turn || a.bonusId - b.bonusId);
    const far = spreadOf(ids).far;
    return {
      territoryIds: ids,
      score: round2(sim.score),
      bonuses: done,
      twoOrderCaptures: sim.twoOrders,
      maxHops: Number.isFinite(far) ? far : null,
    };
  };

  // The award order (#129): a list is judged by the sets it can actually yield. The worst
  // outcome is scored with the other players holding the picks it implies they took; the
  // primary's order is changed only when another order raises that worst outcome.
  const outcomeScore = (list: number[], ids: number[]) => round2(simScore(ids, impliedOpponentStarts(list, ids)));
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
    primary.length > 0
      ? pickOutcomes({ listLength: primary.length + listed.tiers.flat().length, perPlayer: primary.length, players })
      : null;
  let award: AwardReport | undefined;
  if (outcomeSets?.length) {
    const base = [...primary];
    const baseWorst = worstOf([...base, ...listed.tiers.flat()], outcomeSets);
    let bestOrder = base;
    let bestWorst = baseWorst;
    if (primary.length <= MAX_REORDER) {
      const orders =
        commanderPick === null ? permutations(base) : permutations(base.slice(1)).map((rest) => [commanderPick!, ...rest]);
      for (const order of orders) {
        const w = worstOf([...order, ...listed.tiers.flat()], outcomeSets);
        if (w.score > bestWorst.score) {
          bestOrder = order;
          bestWorst = w;
        }
      }
    }
    if (bestOrder !== base && answerSets) {
      // An answering fallback (#166) depends on the primary's order: it is built again for the
      // new one, and the new order stands only if the list as it then reads still has a better
      // worst outcome than the list it replaces.
      const again = buildFallback(bestOrder);
      const w = worstOf([...bestOrder, ...again.tiers.flat()], outcomeSets);
      if (w.score > baseWorst.score) {
        listed = again;
        bestWorst = w;
      } else {
        bestOrder = base;
        bestWorst = baseWorst;
      }
    }
    const reordered = bestOrder !== base;
    primary.splice(0, primary.length, ...bestOrder);
    award = {
      outcomes: outcomeSets.length,
      worst: { ...bestWorst, opponentStarts: impliedOpponentStarts([...primary, ...listed.tiers.flat()], bestWorst.territoryIds) },
      reordered,
    };
  }
  const { tiers } = listed;
  const fallback = tiers.flat();
  const firstTier = tiers[0] ?? [];
  const firstFallbackView = listed.firstView;
  const viewFor = (t: number) => listed.views.get(t)!;
  warnings.push(...listed.warnings);
  for (const [label, hop] of listed.relaxedTo) relaxedTo.set(label, hop);

  // What each pick of an answering fallback answers (#166): the picks lost in the outcomes that
  // grant it whose own bonus (one the lost pick completes alone, by that turn) it reaches in
  // time. One bonus is named per lost pick — the one worth most to it — and the rest counted.
  const answers = new Map<number, string>();
  if (answerSets) {
    const list = [...primary, ...firstTier];
    for (let p = primary.length; p < list.length; p++) {
      const lost = new Set<number>();
      for (const o of answerSets)
        if (o[o.length - 1] === p) for (let i = 0; i < p; i++) if (!o.includes(i)) lost.add(i);
      const parts: string[] = [];
      for (const i of [...lost].sort(byNum)) {
        const credit = (id: number, turn: number) => bonuses.get(id)!.value * (PICK_HORIZON + 1 - turn);
        const reached = [...firstView.of.get(list[i]!)!.completions]
          .map(([id, turn]) => ({ id, turn, at: reach.get(id)?.get(list[p]!) }))
          .filter((b): b is { id: number; turn: number; at: number } => b.at !== undefined && b.at <= b.turn)
          .sort((a, b) => credit(b.id, b.turn) - credit(a.id, a.turn) || a.id - b.id);
        const top = reached[0];
        if (!top) continue;
        const more = reached.length - 1;
        parts.push(
          `${terrName(list[i]!)}: reaches ${bonuses.get(top.id)!.name} by turn ${top.at + 1}` +
            (more ? ` (and ${more} more of its bonuses)` : ''),
        );
      }
      if (parts.length) answers.set(list[p]!, `Answers the loss of ${parts.join('; of ')}`);
    }
  }

  const pickOf = (t: number) => {
    const a = viewFor(t).of.get(t)!;
    const commander =
      t === commanderPick
        ? [
            `Commander: listed first, so the commander most likely starts here — the primary's safest pick ` +
              `(${commanderExposure} other pickable territor${commanderExposure === 1 ? 'y' : 'ies'} within ${COMPACT_DISTANCE} hops)`,
          ]
        : [];
    const answer = answers.get(t);
    return { score: a.score, reasons: [...a.reasons, ...(answer ? [answer] : []), ...commander] };
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
      `armies attack only from a territory held at the start of the turn that borders the target, topped up by that turn's deploys` +
      (ctx.twoOrders ? '; a neutral no single order can pay for may be taken in two, the first only wearing it down.' : '.'),
    `A pick's reasons are its opening alone (a fallback pick's with the primary taken); a group's bonuses are its picks' joint opening, so one bonus can complete on different turns in the two.`,
    `Bonuses are weighted by defensibility (fewer entry points is better, and one next to two of a bonus's territories counts twice${hardness > 1 ? '; attacks here are dearer than at 60/70, so this weighs more' : ''}), ` +
      `and a completed bonus by who can reach it: it loses up to ${Math.round(THREAT_LOSS * 100)}% of its credit with the chance that another player starts on a pickable territory ` +
      `whose armies can stand in or next to it by the turn it completes (their starts taken as equally likely on every pickable territory left).`,
    contestWeight > 0
      ? `With ${players} players central picks are likely contested: scores drop by up to ${Math.round(contestWeight * 100)}% with centrality, and ` +
          (relaxed
            ? `each group is kept as compact as the map allows (no group of the needed size forms one cluster with each pick within ${COMPACT_DISTANCE} hops of another, so the hop limit was relaxed; see the warnings).`
            : `each group is compact (one cluster, each pick within ${COMPACT_DISTANCE} hops of another).`)
      : spread
        ? `In a 1v1 centrality is not penalised and entry points weigh twice as much; with spread on, a pick may join a group within ${SPREAD_DISTANCE} hops when it anchors a different bonus, so one counter-pick cannot wipe them` +
          (relaxed ? `; a group spreads farther only when no bounded group exists or spreading scores ${SPREAD_RELAX_GAIN}× as much (see the warnings).` : '.')
        : `In a 1v1 centrality is not penalised and entry points weigh twice as much; ` +
          (answerSets
            ? (relaxedTo.has('primary')
                ? `the primary group is kept as compact as the map allows (the hop limit was relaxed; see the warnings), `
                : `the primary group is compact (one cluster, each pick within ${COMPACT_DISTANCE} hops of another), `) +
              `so the start has one front, not several; each fallback pick is chosen for the outcomes that grant it, in which the picks lost above it ` +
              `are the opponent's starts: its opening there, less ${OPPONENT_WEIGHT} × the opponent's from those starts.`
            : (relaxed
                ? `each group is kept as compact as the map allows (the hop limit was relaxed; see the warnings), `
                : `each group is compact (one cluster, each pick within ${COMPACT_DISTANCE} hops of another), `) +
              'so the start has one front, not several; the fallback, in another area when one scores as much, is the insurance against a counter-pick.'),
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
            : answerSets
              ? 'one compact cluster, so the start has one front; each fallback pick is listed for the outcomes in which a pick above it is lost.'
              : 'one compact cluster, so the start has one front; the fallback covers a counter-pick.') +
        ' Weigh the trade before submitting.',
    );
  if (commanderPick !== null)
    rationale.push(
      `Commanders are on: the first pick awarded carries the commander, so the primary's safest pick (${terrName(commanderPick)}: ` +
        `fewest other pickable territories within ${COMPACT_DISTANCE} hops) is listed first; if another player takes it, the next pick awarded carries it.`,
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

  // The coverage-first alternative (#166): the primary is kept; this is offered beside it.
  const coverageOf = coverageModel({ graph: g, pickable, settings: s, neutralArmies: input.neutralArmies });
  const primaryCoverage = coverageOf(primary);
  let alternative: AlternativePicks | undefined;
  if (players === 2 && !spread && primary.length >= 2) {
    const score = (t: number) => firstView.of.get(t)!.score;
    const seeds = [...pickable].sort((a, b) => score(b) - score(a) || a - b);
    const pair = bestGroup(firstView, pickable, 2, seeds, COMPACT_DISTANCE);
    if (pair) {
      const alt = [...pair].sort((a, b) => score(b) - score(a) || a - b);
      while (alt.length < primary.length) {
        let best: { t: number; covered: number } | null = null;
        for (const c of pickable) {
          if (alt.includes(c)) continue;
          const covered = coverageOf([...alt, c]).covered;
          if (!best || covered > best.covered || (covered === best.covered && score(c) > score(best.t))) best = { t: c, covered };
        }
        if (!best) break;
        alt.push(best.t);
      }
      // With commanders the first pick awarded carries the commander: the alternative's safest goes first too.
      if (s.commanders) {
        const safe = safestOf(alt).pick;
        alt.splice(0, alt.length, safe, ...alt.filter((t) => t !== safe));
      }
      const altCoverage = coverageOf(alt);
      const same = alt.length === primary.length && alt.every((t) => primary.includes(t));
      if (!same && altCoverage.covered > primaryCoverage.covered) {
        const altFallback = buildFallback(alt, pickable.filter((t) => !alt.includes(t))).tiers.flat();
        alternative = {
          group: groupOf(alt, NO_TAKEN),
          coverage: altCoverage,
          fallback: altFallback,
          submitPicks: [...alt, ...altFallback],
        };
        const of = (c: CoverageReport) => `${c.covered} of ${c.reasonable}`;
        rationale.push(
          `A coverage-first alternative (${alt.map(terrName).join(', ')}: a pair within ${COMPACT_DISTANCE} hops, then the picks that most widen ` +
            `the reach) can stand next to ${of(altCoverage)} reasonable bonuses within ${COVERAGE_DISTANCE} moves, against ${of(primaryCoverage)} ` +
            `for the primary, and scores ${alternative.group.score} against ${groups.primary.score}. Prefer the compact primary by default; ` +
            'prefer the alternative on a small board when knowing where the opponent is and keeping a way into every region matter more than the fastest start.',
        );
      }
    }
  }
  return {
    picks,
    groups,
    ...(award ? { award } : {}),
    coverage: primaryCoverage,
    ...(alternative ? { alternative } : {}),
    warnings,
    rationale,
  };
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
  const players = Number.isFinite(input.players) ? Math.max(1, Math.floor(input.players)) : 2;
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

/** Moves within which a pick covers a bonus: it can stand in or next to the bonus (#166). */
export const COVERAGE_DISTANCE = 2;

export interface CoverageInput {
  graph: MapGraph;
  pickable: readonly number[];
  settings?: PickSettings;
  /** Neutral armies as the live board shows them (wastelands included), by territory id. */
  neutralArmies?: ReadonlyMap<number, number>;
}

export interface CoverageReport {
  /** covered ÷ reasonable, to two places; 1 when no bonus is reasonable. */
  share: number;
  covered: number;
  /** Reasonable bonuses on the map (see {@link coverage}). */
  reasonable: number;
  /** The reasonable bonuses no pick covers, ascending by id. */
  uncovered: { bonusId: number; name: string }[];
}

/**
 * The coverage of every pick set on one board (#166), set up once. A wasteland is a territory
 * whose neutral is larger than an ordinary one (the distribution size on a pickable territory,
 * the non-distribution size elsewhere), as the advisor's reasons define it. A bonus is
 * reasonable — one an opponent would reasonably start in — when its value is positive, it is not
 * a superbonus, no member is a wasteland, a member is pickable, every member can be taken, and
 * its value per capture cost (every member at `captureCost`, as in the opening simulation) is at
 * least the median over such bonuses. A pick covers a bonus when a territory of the bonus, or
 * one next to it, lies within COVERAGE_DISTANCE hops of the pick, walking only through
 * territories that are not wastelands.
 */
export function coverageModel(input: CoverageInput): (picks: readonly number[]) => CoverageReport {
  const g = input.graph;
  const s = input.settings ?? {};
  const pickSet = new Set(input.pickable.filter((t) => g.territoryById.has(t)));
  const known = input.neutralArmies ?? new Map<number, number>();
  const neutralsIn = s.initialNeutralsInDistribution ?? DEFAULT_NEUTRALS_IN_DISTRIBUTION;
  const neutralsOut = s.initialNonDistributionArmies ?? DEFAULT_NON_DISTRIBUTION_ARMIES;
  const rates = {
    offensiveKillRate: s.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE,
    defensiveKillRate: s.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE,
    luckModifier: s.luckModifier,
  };
  const ordinary = (t: number) => (pickSet.has(t) ? neutralsIn : neutralsOut);
  const { armies, cost } = territoryCosts(g, (t) => known.get(t) ?? ordinary(t), rates);
  const waste = new Set([...armies].filter(([t, n]) => n > ordinary(t)).map(([t]) => t));
  const candidates: { id: number; name: string; ratio: number; zone: Set<number> }[] = [];
  for (const b of g.map.bonuses) {
    if (b.value <= 0 || b.bonusIds.length > 0) continue;
    const members = (analyzeBonus(g, b.id)?.territoryIds ?? []).filter((t) => g.territoryById.has(t));
    if (!members.length || members.some((m) => waste.has(m)) || !members.some((m) => pickSet.has(m))) continue;
    const costs = members.map((m) => cost.get(m));
    if (costs.some((c) => c === null || c === undefined)) continue;
    const total = (costs as number[]).reduce((a, c) => a + c, 0);
    const zone = new Set(members);
    for (const m of members) for (const n of neighborsOf(g, m)) zone.add(n);
    candidates.push({ id: b.id, name: b.name, ratio: total > 0 ? b.value / total : Infinity, zone });
  }
  const ratios = candidates.map((c) => c.ratio).sort(byNum);
  const mid = ratios.length >> 1;
  const median = !ratios.length ? 0 : ratios.length % 2 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
  const reasonable = candidates.filter((c) => c.ratio >= median).sort((a, b) => a.id - b.id);
  return (picks) => {
    // Breadth-first from every pick at once, never entering a wasteland.
    const seen = new Set(picks.filter((t) => g.territoryById.has(t) && !waste.has(t)));
    let frontier = [...seen];
    for (let d = 0; d < COVERAGE_DISTANCE && frontier.length; d++) {
      const next: number[] = [];
      for (const t of frontier)
        for (const n of neighborsOf(g, t))
          if (!seen.has(n) && !waste.has(n)) {
            seen.add(n);
            next.push(n);
          }
      frontier = next;
    }
    const uncovered = reasonable.filter((b) => ![...b.zone].some((t) => seen.has(t)));
    const covered = reasonable.length - uncovered.length;
    return {
      share: reasonable.length ? round2(covered / reasonable.length) : 1,
      covered,
      reasonable: reasonable.length,
      uncovered: uncovered.map((b) => ({ bonusId: b.id, name: b.name })),
    };
  };
}

/** The coverage of one pick set (see {@link coverageModel}). */
export function coverage(input: CoverageInput, picks: readonly number[]): CoverageReport {
  return coverageModel(input)(picks);
}
