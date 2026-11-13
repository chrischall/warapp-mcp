// Where each opponent is and what it is doing: a guess from the boards I have seen, the map, the
// settings and, when known, where players could start. Pure and deterministic (no I/O, no clock,
// no randomness, ties on ascending id). Nothing here is used by the turn planner yet.
//
// Only two things are FACT, and they are kept apart from everything else (`seen`): the
// territories of an opponent in view on the newest board, and those whose most recent shown owner
// was that opponent and that are hidden now ("last seen"). Everything else is a guess from a
// simple model, and every guess says what it rests on. A `likelihood` is the model's estimate,
// never a measured probability.
//
//  - STARTS. A candidate (a territory a player could start on) is ruled out when any board showed
//    it as a neutral, or my oldest board showed it as mine or another player's. A start the award
//    of picks proves, or one in view on the turn-1 board (nobody has moved), is certain. The rest
//    are weighed: every set of the starts still unknown, by the product of its candidates' prior
//    weights times, for each territory of the opponent ever seen (first on turn t), the best
//    explanation a start of the set gives — 1 when the growth model holds it from there by turn t,
//    {@link EXPLAINS_EARLIEST} when it could be there at the earliest ({@link reach}), 0 when it
//    could not be there in time. A candidate's likelihood is its share of that weight. Past
//    {@link MAX_START_SETS} sets the candidates are weighed one by one instead (each against what
//    the other starts are expected to explain) and scaled to sum to the starts unknown. When no
//    set explains what was seen the candidates are wrong: the prior alone is used, and said.
//  - REACH: one capture per turn along a path, each capture paying its whole attack out of the
//    armies at hand plus an income per turn ({@link reach}).
//  - GROWTH: what a player could plausibly hold n turns after starting somewhere, spending pooled
//    armies on the bonus with the best value per remaining capture cost ({@link growth}).
//    Deliberately generous.
//  - PRESENCE on a territory hidden now: the noisy-OR of last-seen, income (bonuses that would
//    explain a tracked income) and the strongest of start, corridor (the shortest ways between a
//    likely start and a sighting) and growth, which all rest on the same start likelihoods and so
//    are not counted as independent; capped at {@link PRESENCE_CAP} ({@link combinePresence}).
//  - From those: the bonuses it probably holds, the earliest turn it could attack each border
//    territory of mine (`approaches`), what it is doing in plain sentences (`doing`), and what to
//    prepare for (`prepare`: hold — the soonest attack a seen stack can make, contested — a bonus I
//    hold part of and that is worth finishing, scout).
import type { BoardState, TerritoryState } from '../board.js';
import { carriesTeam } from '../teams.js';
import { bonusTerritories } from './bonuses.js';
import { armiesToTake, specialUnitStrength } from './combat.js';
import { bfsDistances, neighborsOf, type MapGraph } from './graph.js';
import type { IncomeMethod, OpponentTrack, TrackPlayer, TurnBoard } from './opponents.js';
import { DEFAULT_NEUTRALS_IN_DISTRIBUTION, DEFAULT_NON_DISTRIBUTION_ARMIES, DEFAULT_PICK_ARMIES } from './picks.js';
import { captureCost, ownerShown, visibleState, type PlannerSettings } from './planner.js';
import { DEFAULT_BASE_INCOME, territoryIncome } from './player.js';

/** Captures along one path that {@link reach} looks ahead, and turns {@link growth} is run for. */
export const REACH_HORIZON = 12;
/** Start sets enumerated before the candidates are weighed one by one. */
export const MAX_START_SETS = 5000;
/** How well a start explains a sighting it could only reach at the earliest (1: the growth model holds it; 0: not in time). */
export const EXPLAINS_EARLIEST = 0.3;
/** No guess is surer than this. */
export const PRESENCE_CAP = 0.95;
/**
 * Presence on a territory last seen as the opponent's: `duel` in a two-player game (only I could
 * have taken it, and I would know); with more players `first` minus `perTurn` for each turn since,
 * never below `floor`.
 */
export const LAST_SEEN = { duel: 0.95, first: 0.9, perTurn: 0.1, floor: 0.4 } as const;
/** Presence the growth model gives a territory, as a share of its start's likelihood. */
export const GROWTH_WEIGHT = 0.6;
/** Presence on the hidden members of a bonus that is in every combination explaining a tracked income. */
export const INCOME_WEIGHT = 0.7;
/** The least likelihood at which a bonus is listed as probably held, or a missing member of mine as contested. */
export const LIKELY_BONUS = 0.3;
/** The least presence at which a hidden territory counts as a place it could attack from. */
export const SOURCE_PRESENCE = 0.5;
/** Presence that could go either way: worth a look. */
export const SCOUT_RANGE = { min: 0.25, max: 0.75 } as const;
/** How far ahead `prepare` looks: this turn and the next. */
export const PREPARE_TURNS = 2;
export const MAX_APPROACHES = 10;
export const MAX_PREPARE = 10;
/** Sentences one `doing` rule gives per opponent. */
export const MAX_DOING_PER_RULE = 3;
/** Territories one `can-attack` sentence names before it gives the rest as a count. */
export const MAX_TARGETS_NAMED = 5;
/**
 * A bonus I hold part of is `contested` only when finishing it (the capture cost of its missing
 * territories, as shown now) is at most this many turns of its value.
 */
export const CONTEST_PAYBACK_TURNS = 10;

/** The settings the model reads: the planner's, and how the game began. */
export interface WhereSettings extends PlannerSettings {
  /** Armies on each starting territory (default {@link DEFAULT_PICK_ARMIES}). */
  startingArmies?: number;
  /** Territories each player started on; absent: unknown, so no start is guessed. */
  startsPerPlayer?: number;
  /** Armies on a neutral outside the distribution (default {@link DEFAULT_NON_DISTRIBUTION_ARMIES}). */
  neutralArmies?: number;
  /** Armies on a territory a player could have started on and nobody did (default {@link DEFAULT_NEUTRALS_IN_DISTRIBUTION}). */
  distributionNeutralArmies?: number;
}

/** Where the start candidates came from. */
export type CandidateSource = 'pickable' | 'statistics';

/** The territories a player could start on. */
export interface StartCandidates {
  territories: readonly number[];
  source: CandidateSource;
}

/** A prior weight per candidate (a candidate without one weighs 1). Absent: every candidate weighs the same. */
export interface StartPrior {
  weights: ReadonlyMap<number, number>;
  source: 'statistics';
  /** Finished games the weights were counted over. */
  sample: number;
  /** The sample is too small to lean on. */
  weak?: boolean;
}

export interface WhereInput {
  graph: MapGraph;
  /** My player id. */
  me: number;
  /** The boards I saw, each with the turn it was played on; the newest is the current turn's. */
  boards: readonly TurnBoard[];
  /** Every player of the game (ids like the boards'): team and state decide who is an opponent. */
  players: readonly TrackPlayer[];
  settings: WhereSettings;
  candidates?: StartCandidates;
  prior?: StartPrior;
  /** Starts known for certain (the award of picks), by opponent id. */
  proven?: ReadonlyMap<number, readonly number[]>;
  /** The opponent tracks over the same boards (income, unexplained armies, inferred bonuses). */
  tracks?: readonly OpponentTrack[];
}

/** What a guess of presence rests on, in this order. */
export type PresenceSource = 'last-seen' | 'start' | 'corridor' | 'growth' | 'income';
const PRESENCE_ORDER: readonly PresenceSource[] = ['last-seen', 'start', 'corridor', 'growth', 'income'];
/** Sources that all come from one start likelihood: never added up as if independent. */
const FROM_STARTS: ReadonlySet<PresenceSource> = new Set(['start', 'corridor', 'growth']);

/**
 * A territory's presence from its sources. Start, corridor and growth all rest on the same start
 * likelihoods, so they count once (the strongest of them); that and the independent sources
 * (last-seen, income) are combined by noisy-OR, capped at {@link PRESENCE_CAP}.
 */
export function combinePresence(parts: ReadonlyMap<PresenceSource, number>): number {
  let fromStarts = 0;
  let p = 0;
  for (const s of PRESENCE_ORDER) {
    const v = parts.get(s) ?? 0;
    if (FROM_STARTS.has(s)) fromStarts = Math.max(fromStarts, v);
    else p = either(p, v);
  }
  return Math.min(PRESENCE_CAP, either(p, fromStarts));
}

export interface SeenTerritory {
  territoryId: number;
  /** Armies shown; `null` when only the owner is. */
  armies: number | null;
}

export interface LastSeen extends SeenTerritory {
  /** The newest turn whose board showed it. */
  turn: number;
}

export interface StartGuess {
  territoryId: number;
  /** The model's estimate, 0–1; not a measured probability. */
  likelihood: number;
}

export interface StartsReading {
  /** Where the candidates came from; `none`: no candidates are known, so no start is guessed. */
  source: 'none' | CandidateSource;
  /** Starts known for certain: proven by the award of picks, or in view on the turn-1 board. */
  proven: number[];
  /** Guessed starts with a likelihood above 0, likeliest first. */
  likely: StartGuess[];
  /** Candidates a board ruled out: shown as a neutral, or as mine or another player's on my oldest board. */
  ruledOut: number[];
  /** Starts still unknown; `null` when the settings do not say how many a player has. */
  unknown: number | null;
  /** How the likelihoods were reached: every start set weighed, or (too many sets) each candidate alone. */
  method: 'none' | 'enumerated' | 'independent';
  /** No start set explained what was seen, so the likelihoods are the prior alone. */
  priorOnly: boolean;
  prior: { source: 'uniform' | 'statistics'; sample: number | null; weak: boolean };
}

export interface Presence {
  territoryId: number;
  likelihood: number;
  /** The sources that contributed. */
  basis: PresenceSource[];
}

export interface BonusGuess {
  bonusId: number;
  /** The least presence among its members (one in view as its own counts 1). */
  likelihood: number;
  basis: PresenceSource[];
  /** Members in view as its own. */
  inView: number;
  /** Members hidden now. */
  hidden: number;
}

export interface Approach {
  /** My territory. */
  target: number;
  /** The first turn it could attack it. */
  turn: number;
  /** Turns from now (0: this turn). */
  inTurns: number;
  /** `seen`: from a territory of its in view; `guessed`: from one it only probably holds. */
  source: 'seen' | 'guessed';
  from: number;
  /** From the source to the target, both included. */
  path: number[];
  /** From a seen stack with its armies shown: the armies that could arrive on that turn. Else `null`. */
  armies: number | null;
  /** The target is in a bonus I hold in full, or holds my commander. */
  valued: boolean;
}

export type DoingRule = 'unseen' | 'out-of-sight' | 'can-attack' | 'stack-grew' | 'near-bonus' | 'hidden-armies';

export interface Doing {
  rule: DoingRule;
  /** One sentence, territories, bonuses and players by id. */
  text: string;
  territoryIds: number[];
  bonusId?: number;
}

export interface OpponentWhereabouts {
  playerId: number;
  /** FACTS: what my boards showed. */
  seen: {
    /** Its territories in view on the newest board. */
    inView: SeenTerritory[];
    /** Territories hidden now whose most recent shown owner was this player. */
    lastSeen: LastSeen[];
    /** Bonuses it holds in full in view. */
    bonuses: number[];
  };
  starts: StartsReading;
  /** GUESSES: territories hidden now it may hold, likeliest first. */
  presence: Presence[];
  /** GUESSES: bonuses it probably holds in full (at least one member hidden), likeliest first. */
  bonuses: BonusGuess[];
  /** Its tracked income and the term that set it; `null` without one. */
  income: { estimate: number; method: IncomeMethod | null } | null;
  /** Armies the track cannot place on the board (`unexplained`); `null` without a track. */
  hiddenArmies: number | null;
  /** The earliest it could attack each border territory of mine, soonest first, at most {@link MAX_APPROACHES}. */
  approaches: Approach[];
  doing: Doing[];
  /** One line. */
  summary: string;
}

export interface Prepare {
  kind: 'hold' | 'contested' | 'scout';
  opponent: number;
  /** The turn it matters on. */
  turn: number;
  /** hold: my territory; contested: the missing member; scout: the territory to take or look at. */
  territory: number;
  /** contested: the bonus; hold: the bonus the territory belongs to (absent for a commander alone). */
  bonusId?: number;
  /** hold: the armies it needs to hold, and what stands there (a commander as 7). */
  need?: number;
  have?: number;
  /** hold: the armies that could arrive. */
  armies?: number;
  /** hold, contested by reach: where from. */
  from?: number;
  /** contested by presence, scout: the guess it rests on. */
  likelihood?: number;
  /** scout: the hidden territories it would settle. */
  reveals?: number[];
  /** One sentence, by id. */
  text: string;
}

export interface Whereabouts {
  /** The turn of the newest board; `null` with no board. */
  turn: number | null;
  /** By player id. */
  opponents: OpponentWhereabouts[];
  /**
   * Across opponents, at most {@link MAX_PREPARE}: what to hold first, then contested bonuses, then
   * a look; each kind soonest first, then the largest shortfall or value.
   */
  prepare: Prepare[];
  /** What the model assumes, in plain sentences. */
  assumptions: string[];
}

const byNum = (a: number, b: number) => a - b;
const round2 = (n: number) => Math.round(n * 100) / 100;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** 1 − (1 − a)(1 − b), exact when one of them is 0. */
const either = (a: number, b: number) => (a <= 0 ? b : b <= 0 ? a : 1 - (1 - a) * (1 - b));

// ---- reach ----

/** The board as a mover crosses it. */
export interface ReachField {
  graph: MapGraph;
  /** Armies an attack needs to take a territory (0: the mover's own); `null`: it cannot be taken. */
  cost: (territoryId: number) => number | null;
  /** Territories that can be reached and never passed through (mine). */
  targets?: ReadonlySet<number>;
}

export interface ReachBudget {
  /** Armies at hand at the start. */
  armies: number;
  /** Armies added each turn, the first included. */
  income: number;
}

export interface Reached {
  /** The earliest number of turns after which it can hold the territory (0: a source). */
  turns: number;
  /** Captures on the way, the territory's own included. */
  captures: number;
  /** What those captures cost. */
  cost: number;
  /** From the source to the territory, both included. */
  path: number[];
}

interface ReachCore {
  best: Map<number, { turns: number; captures: number; cost: number }>;
  pathTo: (territoryId: number) => number[];
}

function reachCore(field: ReachField, sources: Iterable<number>, budget: ReachBudget, horizon: number): ReachCore {
  const g = field.graph;
  const armies = Math.max(0, budget.armies);
  const income = Math.max(0, budget.income);
  /** max(captures, the turns of income the cost needs); Infinity when it is never paid. */
  const turnsFor = (cost: number, captures: number): number => {
    if (cost <= armies) return captures;
    if (income <= 0) return Infinity;
    return Math.max(captures, Math.ceil((cost - armies) / income));
  };
  const cost = new Map<number, number>();
  const best = new Map<number, { turns: number; captures: number; cost: number }>();
  // steps[h]: the territories whose cheapest way in at most h captures is new at h → the one before.
  const steps: Map<number, number>[] = [new Map()];
  let frontier: number[] = [];
  for (const s of [...new Set(sources)].sort(byNum)) {
    if (!g.territoryById.has(s)) continue;
    cost.set(s, 0);
    best.set(s, { turns: 0, captures: 0, cost: 0 });
    frontier.push(s);
  }
  const isSource = new Set(frontier);
  for (let h = 1; h <= horizon && frontier.length; h++) {
    const cheaper = new Map<number, number>();
    const from = new Map<number, number>();
    for (const u of frontier) {
      if (field.targets?.has(u) && !isSource.has(u)) continue;
      const cu = cost.get(u)!;
      for (const n of neighborsOf(g, u)) {
        const c = field.cost(n);
        if (c === null) continue;
        const nc = cu + c;
        if (nc < (cheaper.get(n) ?? cost.get(n) ?? Infinity)) {
          cheaper.set(n, nc);
          from.set(n, u);
        }
      }
    }
    frontier = [...cheaper.keys()].sort(byNum);
    for (const v of frontier) {
      const nc = cheaper.get(v)!;
      cost.set(v, nc);
      const turns = turnsFor(nc, h);
      if (turns < (best.get(v)?.turns ?? Infinity)) best.set(v, { turns, captures: h, cost: nc });
    }
    steps.push(from);
  }
  const pathTo = (territoryId: number): number[] => {
    const b = best.get(territoryId);
    if (!b) return [];
    const path = [territoryId];
    let at = territoryId;
    for (let j = b.captures; j > 0; j--) {
      while (j > 0 && !steps[j]!.has(at)) j--;
      if (j === 0) break;
      at = steps[j]!.get(at)!;
      path.push(at);
    }
    return path.reverse();
  };
  return { best, pathTo };
}

/**
 * For a player standing on `sources`: the earliest number of turns after which it can hold each
 * territory, taking one capture per turn along a path and paying each capture's cost out of
 * `budget.armies` plus `budget.income` per turn. For a path of h captures costing C in total that
 * is max(h, ceil((C − armies) / income)); the least over h up to `horizon` is kept (fewest
 * captures on a tie). Territories of `field.targets` are reached, never passed through.
 */
export function reach(field: ReachField, sources: Iterable<number>, budget: ReachBudget, horizon = REACH_HORIZON): Map<number, Reached> {
  const core = reachCore(field, sources, budget, horizon);
  const out = new Map<number, Reached>();
  for (const id of [...core.best.keys()].sort(byNum)) out.set(id, { ...core.best.get(id)!, path: core.pathTo(id) });
  return out;
}

// ---- growth ----

export interface GrowthEconomy {
  /** Armies on the start. */
  armies: number;
  baseIncome: number;
  /** One army of income per this many territories held, when larger than the base (0 or absent: off). */
  bonusArmyPer?: number;
}

/** Territory → the bonuses it is in (superbonus members flattened), ascending; per graph. */
const bonusIndexes = new WeakMap<MapGraph, Map<number, number[]>>();
function bonusesOf(g: MapGraph): Map<number, number[]> {
  let index = bonusIndexes.get(g);
  if (index) return index;
  index = new Map();
  for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
    for (const t of bonusTerritories(g, b.id)) {
      const list = index.get(t);
      if (list) list.push(b.id);
      else index.set(t, [b.id]);
    }
  }
  bonusIndexes.set(g, index);
  return index;
}

/**
 * What a player starting on `start` could plausibly hold after `turns` turns (at most
 * {@link REACH_HORIZON}): territory → the turn it is first held (0: the start). Each turn it
 * adds its income (the base, plus the bonuses it holds in full) to one pool of armies and spends
 * it on the bonus with the best value per remaining capture cost among those with a member next
 * to what it held when the turn began, cheapest such member first, until a capture cannot be
 * paid. Territories of `field.targets` and of `never` are not taken (and are left out of a
 * bonus's remaining cost). Generous on purpose: the armies are pooled and nothing is kept back.
 */
export function growth(
  field: ReachField,
  start: number,
  turns: number,
  economy: GrowthEconomy,
  never: ReadonlySet<number> = new Set(),
): Map<number, number> {
  const g = field.graph;
  const held = new Map<number, number>();
  if (!g.territoryById.has(start)) return held;
  held.set(start, 0);
  const index = bonusesOf(g);
  const takeable = (t: number) => !held.has(t) && !never.has(t) && !field.targets?.has(t) && field.cost(t) !== null;
  const income = (): number => {
    let bonuses = 0;
    const checked = new Set<number>();
    for (const t of held.keys()) {
      for (const b of index.get(t) ?? []) {
        if (checked.has(b)) continue;
        checked.add(b);
        if (bonusTerritories(g, b).every((m) => held.has(m))) bonuses += g.bonusById.get(b)!.value;
      }
    }
    return Math.max(0, territoryIncome(held.size, economy.baseIncome, economy.bonusArmyPer ?? 0) + bonuses);
  };
  let pool = Math.max(0, economy.armies);
  for (let turn = 1; turn <= Math.min(turns, REACH_HORIZON); turn++) {
    pool += income();
    // One capture per turn along a path: only what borders the holdings the turn began with.
    const edge = new Set<number>();
    for (const t of held.keys()) for (const n of neighborsOf(g, t)) if (takeable(n)) edge.add(n);
    while (edge.size) {
      let choice: { bonusId: number; score: number; member: number; cost: number } | undefined;
      const checked = new Set<number>();
      for (const e of edge) {
        for (const b of index.get(e) ?? []) {
          if (checked.has(b)) continue;
          checked.add(b);
          const value = g.bonusById.get(b)!.value;
          if (value <= 0) continue;
          let remaining = 0;
          let member: number | undefined;
          let memberCost = Infinity;
          for (const m of bonusTerritories(g, b)) {
            if (!takeable(m)) continue;
            const c = field.cost(m)!;
            remaining += c;
            if (edge.has(m) && c < memberCost) {
              member = m;
              memberCost = c;
            }
          }
          if (member === undefined) continue;
          const score = remaining > 0 ? value / remaining : Infinity;
          if (!choice || score > choice.score || (score === choice.score && b < choice.bonusId))
            choice = { bonusId: b, score, member, cost: memberCost };
        }
      }
      if (!choice || choice.cost > pool) break;
      pool -= choice.cost;
      held.set(choice.member, turn);
      edge.delete(choice.member);
    }
  }
  return held;
}

// ---- the board as the model reads it ----

/** The owner a board shows: a player id, `neutral`, or `undefined` when hidden. */
function shownOwner(t: TerritoryState | undefined): number | 'neutral' | undefined {
  const s = ownerShown(t);
  if (!s) return undefined;
  return s.owner.kind === 'player' ? s.owner.playerId : 'neutral';
}

/** The armies a territory defends with: its count plus its special units (a commander as 7). */
const defenders = (t: TerritoryState) => (t.armies ?? 0) + specialUnitStrength(t.specialUnits);

interface World {
  g: MapGraph;
  me: number;
  /** The newest board's turn; `null` with no board. */
  turn: number | null;
  /** Ascending. */
  turns: number[];
  byTurn: Map<number, BoardState>;
  /** The newest board, by territory. */
  now: Map<number, TerritoryState>;
  mine: Set<number>;
  /** Shown now as a neutral or as mine: never on an opponent's way, never held by one. */
  wall: Set<number>;
  /** The newest board that showed each territory's owner, and what it showed. */
  lastShown: Map<number, { turn: number; state: TerritoryState }>;
  everNeutral: Set<number>;
  candidates: Set<number>;
  base: number;
  starting: number;
  guard: number;
  settings: WhereSettings;
  /** Armies on a neutral there: last shown, else by the settings (in the distribution or not). */
  neutralSize: (territoryId: number) => number;
  /** `captureCost`, remembered. */
  costOf: (defending: number) => number | null;
}

/** The inputs a {@link ReachField} is built from. */
export type FieldInput = Pick<WhereInput, 'graph' | 'boards' | 'me' | 'settings' | 'candidates'>;

function worldOf(input: FieldInput): World {
  const g = input.graph;
  const byTurn = new Map<number, BoardState>();
  for (const b of input.boards) byTurn.set(b.turn, b.board);
  const turns = [...byTurn.keys()].sort(byNum);
  const turn = turns.at(-1) ?? null;
  const now = new Map<number, TerritoryState>();
  if (turn !== null) for (const t of byTurn.get(turn)!.territories) if (g.territoryById.has(t.territoryId)) now.set(t.territoryId, t);
  const mine = new Set<number>();
  const wall = new Set<number>();
  for (const [id, t] of now) {
    const owner = shownOwner(t);
    if (owner === input.me) mine.add(id);
    if (owner === input.me || owner === 'neutral') wall.add(id);
  }
  const lastShown = new Map<number, { turn: number; state: TerritoryState }>();
  const neutralSeen = new Map<number, number>();
  const everNeutral = new Set<number>();
  for (const n of [...turns].reverse()) {
    for (const t of byTurn.get(n)!.territories) {
      const id = t.territoryId;
      if (!g.territoryById.has(id) || !ownerShown(t)) continue;
      if (t.owner.kind === 'neutral') {
        everNeutral.add(id);
        const v = visibleState(t);
        if (v && !neutralSeen.has(id)) neutralSeen.set(id, v.armies!);
      }
      if (!lastShown.has(id)) lastShown.set(id, { turn: n, state: t });
    }
  }
  const s = input.settings;
  const candidates = new Set((input.candidates?.territories ?? []).filter((t) => g.territoryById.has(t)));
  const neutral = Math.max(0, s.neutralArmies ?? DEFAULT_NON_DISTRIBUTION_ARMIES);
  const inDistribution = Math.max(0, s.distributionNeutralArmies ?? DEFAULT_NEUTRALS_IN_DISTRIBUTION);
  const costs = new Map<number, number | null>();
  return {
    g,
    me: input.me,
    turn,
    turns,
    byTurn,
    now,
    mine,
    wall,
    lastShown,
    everNeutral,
    candidates,
    base: Math.max(0, Math.floor(s.baseIncome ?? DEFAULT_BASE_INCOME)),
    starting: Math.max(0, s.startingArmies ?? DEFAULT_PICK_ARMIES),
    guard: s.oneArmyStandsGuard === false ? 0 : 1,
    settings: s,
    neutralSize: (id) => neutralSeen.get(id) ?? (candidates.has(id) ? inDistribution : neutral),
    costOf: (defending) => {
      let c = costs.get(defending);
      if (c === undefined) costs.set(defending, (c = captureCost(defending, s)));
      return c;
    },
  };
}

/**
 * The board as `mover` crosses it from now on: its own territories in view are free, a neutral
 * costs the attack that takes its armies (those shown, else those last shown, else the settings'
 * size — the in-distribution size for a start candidate nobody is known to have taken), another
 * player's what its stack costs, and mine are targets. With no `mover` it is the board as anyone
 * crossed it since the game began: every territory not mine costs what a neutral there would.
 */
function fieldFor(w: World, mover?: number): ReachField {
  const memo = new Map<number, number | null>();
  const compute = (id: number): number | null => {
    const t = w.now.get(id);
    const owner = shownOwner(t);
    if (owner === w.me) return w.costOf(defenders(t!));
    if (mover !== undefined && owner === mover) return 0;
    if (owner === 'neutral') return w.costOf(t!.armies ?? w.neutralSize(id));
    if (mover !== undefined && owner !== undefined) return w.costOf((t!.armies ?? w.neutralSize(id)) + specialUnitStrength(t!.specialUnits));
    return w.costOf(w.neutralSize(id));
  };
  return {
    graph: w.g,
    cost: (id) => {
      let c = memo.get(id);
      if (c === undefined) memo.set(id, (c = compute(id)));
      return c;
    },
    targets: w.mine,
  };
}

/** The {@link ReachField} of the newest board: for `mover` from now on, or (none given) for anyone since the game began. */
export function boardField(input: FieldInput, mover?: number): ReachField {
  return fieldFor(worldOf(input), mover);
}

// ---- starts ----

/** n choose k, or `limit + 1` once it passes `limit`. */
function choose(n: number, k: number, limit: number): number {
  if (k < 0 || k > n) return 0;
  const r = Math.min(k, n - k);
  let c = 1;
  for (let i = 1; i <= r; i++) {
    // C(n − r + i, i): whole at every step, and growing, so passing the limit is final.
    c = (c * (n - r + i)) / i;
    if (c > limit) return limit + 1;
  }
  return Math.round(c);
}

/** Every k-subset of 0..n−1 (as ascending indices), in lexicographic order. */
function forEachCombination(n: number, k: number, visit: (indices: readonly number[]) => void): void {
  if (k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    visit(idx);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]!++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1]! + 1;
  }
}

/** Scale weights to sum to `total`, none above 1 (what is cut off goes to the rest). */
function shareOut(weights: readonly number[], total: number): number[] {
  const out = weights.map(() => 0);
  const open = new Set(weights.map((_, i) => i).filter((i) => weights[i]! > 0));
  let left = Math.min(total, open.size);
  for (;;) {
    const sum = [...open].reduce((s, i) => s + weights[i]!, 0);
    if (sum <= 0 || left <= 0) break;
    const over = [...open].filter((i) => (weights[i]! * left) / sum >= 1);
    if (!over.length) {
      for (const i of open) out[i] = (weights[i]! * left) / sum;
      break;
    }
    for (const i of over) {
      out[i] = 1;
      open.delete(i);
      left -= 1;
    }
  }
  return out;
}

// ---- the model ----

interface Source {
  id: number;
  kind: 'seen' | 'guessed';
  /** Armies it can move: the stack less the guard (seen, armies shown), else the starting armies. */
  armies: number;
  /** A seen stack whose armies are shown. */
  counted: boolean;
}

interface Threat {
  armies: number;
  inTurns: number;
  from: number;
}

interface Taking {
  /** Turns after which it could hold the territory. */
  turns: number;
  from: number;
  /** From a territory it only probably holds. */
  guessed: boolean;
}

interface Located {
  out: OpponentWhereabouts;
  presence: Map<number, number>;
  /** My border territories → the most a seen stack could bring within {@link PREPARE_TURNS}. */
  threats: Map<number, Threat>;
  /** Missing members of bonuses I hold part of → the soonest it could hold them. */
  takings: Map<number, Taking>;
}

/**
 * Where each opponent is and what it is doing, as far as my boards, the map, the settings and the
 * start candidates say. See the module comment for the model; `seen` is fact, the rest is guessed.
 */
export function locateOpponents(input: WhereInput): Whereabouts {
  const w = worldOf(input);
  const g = w.g;
  const assumptions = baseAssumptions(input, w);
  if (w.turn === null) return { turn: null, opponents: [], prepare: [], assumptions };
  const turn = w.turn;

  // Who is an opponent: not me, not a teammate; still playing, or still holding territory in view.
  const players = input.players;
  const myTeam = players.find((p) => p.id === w.me)?.team;
  const friend = (id: number) => id === w.me || (carriesTeam(myTeam) && players.find((p) => p.id === id)?.team === myTeam);
  const inView = new Set<number>();
  for (const t of w.now.values()) {
    const owner = shownOwner(t);
    if (typeof owner === 'number') inView.add(owner);
  }
  const ids = new Set<number>(inView);
  for (const p of players) if ((p.state ?? 'Playing') === 'Playing') ids.add(p.id);
  const opponents = [...ids].filter((id) => !friend(id)).sort(byNum);
  const duel = opponents.length === 1 && !players.some((p) => p.id !== w.me && friend(p.id));

  // What my side holds and values.
  const index = bonusesOf(g);
  const fullBonusOf = new Map<number, number>();
  const mine = fieldFor(w, w.me);
  /** Finishing a bonus pays within {@link CONTEST_PAYBACK_TURNS} of its value. */
  const worthFinishing = (value: number, missing: readonly number[]): boolean => {
    let cost = 0;
    for (const t of missing) {
      const c = mine.cost(t);
      if (c === null) return false;
      cost += c;
    }
    return cost <= CONTEST_PAYBACK_TURNS * value;
  };
  const partial: { bonusId: number; value: number; size: number; held: number; missing: number[] }[] = [];
  for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
    const members = bonusTerritories(g, b.id);
    if (b.value <= 0 || !members.length) continue;
    const missing = members.filter((t) => !w.mine.has(t));
    if (!missing.length) {
      for (const t of members) if (!fullBonusOf.has(t)) fullBonusOf.set(t, b.id);
    } else if (missing.length < members.length && worthFinishing(b.value, missing)) {
      partial.push({ bonusId: b.id, value: b.value, size: members.length, held: members.length - missing.length, missing });
    }
  }
  const wanted = new Set(partial.flatMap((p) => p.missing));
  const commanderOn = new Set<number>();
  for (const id of w.mine) if (w.now.get(id)!.specialUnits?.some((u) => u.kind === 'commander' && u.playerId === w.me)) commanderOn.add(id);
  const valued = (id: number) => fullBonusOf.has(id) || commanderOn.has(id);
  const borders = [...w.mine].sort(byNum).filter((id) => neighborsOf(g, id).some((n) => !w.mine.has(n)));
  const hidden = (id: number) => shownOwner(w.now.get(id)) === undefined;

  // From a candidate start, for anyone: shared by every opponent.
  const past = fieldFor(w);
  const elapsed = Math.min(Math.max(0, turn - 1), REACH_HORIZON);
  const grown = new Map<number, Map<number, number>>();
  const growthFrom = (c: number) => {
    let m = grown.get(c);
    if (!m) grown.set(c, (m = growth(past, c, elapsed, { armies: w.starting, baseIncome: w.base, bonusArmyPer: w.settings.bonusArmyPer ?? 0 }, w.wall)));
    return m;
  };
  const reached = new Map<number, ReachCore['best']>();
  const reachFrom = (c: number) => {
    let m = reached.get(c);
    if (!m) reached.set(c, (m = reachCore(past, [c], { armies: w.starting, income: w.base }, REACH_HORIZON).best));
    return m;
  };
  const distances = new Map<number, Map<number, number>>();
  const distFrom = (c: number) => {
    let m = distances.get(c);
    if (!m) distances.set(c, (m = bfsDistances(g, [c], { passable: (id) => !w.wall.has(id) })));
    return m;
  };
  /** How well a start on `c` explains its owner being on `e` by the board of turn `firstSeen`. */
  const explains = (c: number, e: number, firstSeen: number): number => {
    const by = firstSeen - 1;
    const held = growthFrom(c).get(e);
    if (held !== undefined && held <= by) return 1;
    const r = reachFrom(c).get(e);
    if (r ? r.turns <= by : by > REACH_HORIZON) return EXPLAINS_EARLIEST;
    return 0;
  };

  const startsPerPlayer =
    w.settings.startsPerPlayer !== undefined && w.settings.startsPerPlayer > 0 ? Math.floor(w.settings.startsPerPlayer) : null;
  const oldest = w.byTurn.get(w.turns[0]!)!;
  const oldestOwner = new Map<number, number | 'neutral'>();
  for (const t of oldest.territories) {
    const owner = shownOwner(t);
    if (owner !== undefined && g.territoryById.has(t.territoryId)) oldestOwner.set(t.territoryId, owner);
  }
  // Certain starts: the award's, and whatever the turn-1 board shows (nobody has moved).
  const provenOf = new Map<number, Set<number>>();
  for (const o of opponents) provenOf.set(o, new Set((input.proven?.get(o) ?? []).filter((t) => g.territoryById.has(t))));
  const first = w.byTurn.get(1);
  if (first) {
    for (const t of first.territories) {
      const owner = shownOwner(t);
      if (typeof owner === 'number' && provenOf.has(owner) && g.territoryById.has(t.territoryId)) provenOf.get(owner)!.add(t.territoryId);
    }
  }

  const locate = (o: number): Located => {
    const track = input.tracks?.find((t) => t.playerId === o);

    // 1. Facts.
    const own = [...w.now.values()].filter((t) => shownOwner(t) === o).sort((a, b) => a.territoryId - b.territoryId);
    const ownIds = new Set(own.map((t) => t.territoryId));
    const seenInView: SeenTerritory[] = own.map((t) => ({ territoryId: t.territoryId, armies: visibleState(t)?.armies ?? null }));
    const lastSeen: LastSeen[] = [...w.lastShown]
      .filter(([, s]) => s.turn < turn && shownOwner(s.state) === o)
      .map(([id, s]) => ({ territoryId: id, armies: visibleState(s.state)?.armies ?? null, turn: s.turn }))
      .sort((a, b) => a.territoryId - b.territoryId);
    /** Every territory of it ever shown → the first turn whose board showed it. */
    const sightings = new Map<number, number>();
    let lastSight = 0;
    for (const n of w.turns) {
      for (const t of w.byTurn.get(n)!.territories) {
        if (shownOwner(t) !== o || !g.territoryById.has(t.territoryId)) continue;
        lastSight = n;
        if (!sightings.has(t.territoryId)) sightings.set(t.territoryId, n);
      }
    }
    const seenIds = [...sightings.keys()].sort(byNum);

    // 2. Starts.
    const proven = [...provenOf.get(o)!].sort(byNum);
    const provenElsewhere = new Set(opponents.filter((x) => x !== o).flatMap((x) => [...provenOf.get(x)!]));
    const ruledOut: number[] = [];
    const open: number[] = [];
    for (const c of [...w.candidates].sort(byNum)) {
      if (provenOf.get(o)!.has(c)) continue;
      const then = oldestOwner.get(c);
      const notIts = (then !== undefined && then !== o) || provenElsewhere.has(c);
      if (w.everNeutral.has(c) || notIts) ruledOut.push(c);
      else open.push(c);
    }
    const unknown = startsPerPlayer === null ? null : Math.max(0, startsPerPlayer - proven.length);
    const priorOf = (c: number) => {
      const v = input.prior?.weights.get(c) ?? 1;
      return Number.isFinite(v) && v > 0 ? v : 0;
    };
    const likelihood = new Map<number, number>(proven.map((c) => [c, 1]));
    let method: StartsReading['method'] = 'none';
    let priorOnly = false;
    const k = Math.min(unknown ?? 0, open.length);
    /** [candidate][sighting]: how well the candidate explains it. */
    const fit = new Map<number, number[]>();
    for (const c of [...proven, ...(k > 0 ? open : [])]) fit.set(c, seenIds.map((e) => explains(c, e, sightings.get(e)!)));
    const provenFit = seenIds.map((_, j) => Math.max(0, ...proven.map((c) => fit.get(c)![j]!)));
    if (k > 0) {
      const prior = open.map(priorOf);
      const rows = open.map((c) => fit.get(c)!);
      let marginals: number[];
      if (choose(open.length, k, MAX_START_SETS) <= MAX_START_SETS) {
        method = 'enumerated';
        const weigh = (explained: boolean) => {
          const sums = open.map(() => 0);
          let total = 0;
          forEachCombination(open.length, k, (set) => {
            let weight = 1;
            for (const i of set) weight *= prior[i]!;
            if (explained) {
              for (let j = 0; j < seenIds.length && weight > 0; j++) {
                let best = provenFit[j]!;
                for (const i of set) if (rows[i]![j]! > best) best = rows[i]![j]!;
                weight *= best;
              }
            }
            if (weight <= 0) return;
            total += weight;
            for (const i of set) sums[i]! += weight;
          });
          return { sums, total };
        };
        let r = weigh(true);
        if (r.total <= 0) {
          priorOnly = seenIds.length > 0;
          r = weigh(false);
        }
        marginals = r.total > 0 ? r.sums.map((s) => s / r.total) : open.map(() => k / open.length);
      } else {
        method = 'independent';
        // Each candidate alone, against what the other k − 1 starts are expected to explain.
        const priorSum = prior.reduce((s, p) => s + p, 0);
        const others = seenIds.map((_, j) => {
          if (priorSum <= 0) return 0;
          const q = rows.reduce((s, row, i) => s + prior[i]! * row[j]!, 0) / priorSum;
          return 1 - (1 - q) ** (k - 1);
        });
        let weights = open.map((_, i) => seenIds.reduce((x, _e, j) => x * Math.max(rows[i]![j]!, provenFit[j]!, others[j]!), prior[i]!));
        if (!weights.some((x) => x > 0)) {
          priorOnly = seenIds.length > 0;
          weights = prior.some((p) => p > 0) ? prior : open.map(() => 1);
        }
        marginals = shareOut(weights, k);
      }
      open.forEach((c, i) => likelihood.set(c, marginals[i]!));
    }
    const likely: StartGuess[] = open
      .filter((c) => (likelihood.get(c) ?? 0) > 0)
      .map((c) => ({ territoryId: c, likelihood: likelihood.get(c)! }))
      .sort((a, b) => b.likelihood - a.likelihood || a.territoryId - b.territoryId);
    const starts: StartsReading = {
      source: input.candidates ? input.candidates.source : 'none',
      proven,
      likely,
      ruledOut,
      unknown,
      method,
      priorOnly,
      prior: input.prior
        ? { source: input.prior.source, sample: input.prior.sample, weak: input.prior.weak === true }
        : { source: 'uniform', sample: null, weak: false },
    };
    if (priorOnly)
      assumptions.push(
        `Player ${o}: no start set explains where it was seen (the candidates may be wrong, or it moved faster than the model allows), so its start likelihoods are the prior alone.`,
      );
    if (method === 'independent')
      assumptions.push(
        `Player ${o}: more than ${MAX_START_SETS} start sets, so its candidates were weighed one by one, each against what its other starts are expected to explain.`,
      );
    if (unknown !== null && unknown > open.length && input.candidates)
      assumptions.push(
        `Player ${o}: ${unknown} ${plural(unknown, 'start is', 'starts are')} unknown and only ${open.length} ${plural(open.length, 'candidate is', 'candidates are')} left, so the candidates are incomplete.`,
      );

    // 5. Presence on what is hidden now.
    const parts = new Map<number, Map<PresenceSource, number>>();
    const add = (id: number, source: PresenceSource, x: number) => {
      if (x <= 0 || !hidden(id)) return;
      let m = parts.get(id);
      if (!m) parts.set(id, (m = new Map()));
      m.set(source, either(m.get(source) ?? 0, x));
    };
    for (const s of lastSeen)
      add(s.territoryId, 'last-seen', duel ? LAST_SEEN.duel : Math.max(LAST_SEEN.floor, LAST_SEEN.first - LAST_SEEN.perTurn * (turn - s.turn)));
    const startsByLikelihood = [...likelihood].filter(([, x]) => x > 0).sort(([a], [b]) => a - b);
    for (const [c, x] of startsByLikelihood) {
      add(c, 'start', x);
      for (const [t, heldOn] of growthFrom(c)) if (t !== c && heldOn <= elapsed) add(t, 'growth', x * GROWTH_WEIGHT);
      // The shortest ways from the start to each sighting it explains: per territory, the largest
      // share any one sighting gives (they are one walk from one start, not independent ones).
      const share = new Map<number, number>();
      const dist = distFrom(c);
      seenIds.forEach((e, j) => {
        if (e === c || fit.get(c)![j]! <= 0) return;
        const far = dist.get(e) ?? Math.min(Infinity, ...neighborsOf(g, e).map((n) => (dist.get(n) ?? Infinity) + 1));
        if (!Number.isFinite(far)) return;
        let level = [e];
        for (let d = far - 1; d >= 1; d--) {
          const before = new Set<number>();
          for (const v of level) for (const n of neighborsOf(g, v)) if (dist.get(n) === d) before.add(n);
          level = [...before];
          for (const v of level) share.set(v, Math.max(share.get(v) ?? 0, 1 / level.length));
        }
      });
      for (const [t, s] of [...share].sort(([a], [b]) => a - b)) add(t, 'corridor', x * s);
    }
    const combinations = track?.inferred?.candidates ?? [];
    if (combinations.length) {
      // Combinations that fit as well but are not listed count too, as holding none of these.
      const fits = combinations.length + (track?.inferred?.more ?? 0);
      const inHowMany = new Map<number, number>();
      for (const c of combinations) for (const b of new Set(c.bonusIds)) inHowMany.set(b, (inHowMany.get(b) ?? 0) + 1);
      for (const [b, n] of [...inHowMany].sort(([a], [x]) => a - x))
        for (const t of bonusTerritories(g, b)) add(t, 'income', (n / fits) * INCOME_WEIGHT);
    }
    const presence = new Map<number, number>();
    const basisOf = new Map<number, PresenceSource[]>();
    for (const [id, m] of parts) {
      presence.set(id, combinePresence(m));
      basisOf.set(id, PRESENCE_ORDER.filter((s) => m.has(s)));
    }
    const presenceList: Presence[] = [...presence]
      .map(([id, x]) => ({ territoryId: id, likelihood: x, basis: basisOf.get(id)! }))
      .sort((a, b) => b.likelihood - a.likelihood || a.territoryId - b.territoryId);

    // 6. Bonuses: held in full in view (fact), or probably (guess).
    const seenBonuses: number[] = [];
    const bonusGuesses: BonusGuess[] = [];
    const touched = new Set<number>();
    for (const id of ownIds) for (const b of index.get(id) ?? []) touched.add(b);
    for (const [id, x] of presence) if (x >= LIKELY_BONUS) for (const b of index.get(id) ?? []) touched.add(b);
    for (const b of [...touched].sort(byNum)) {
      if (g.bonusById.get(b)!.value <= 0) continue;
      let least = 1;
      let view = 0;
      let unseen = 0;
      const basis = new Set<PresenceSource>();
      for (const t of bonusTerritories(g, b)) {
        if (ownIds.has(t)) view++;
        else if (hidden(t)) {
          unseen++;
          least = Math.min(least, presence.get(t) ?? 0);
          for (const s of basisOf.get(t) ?? []) basis.add(s);
        } else least = 0;
        if (least <= 0) break;
      }
      if (least <= 0) continue;
      if (!unseen) seenBonuses.push(b);
      else if (least >= LIKELY_BONUS)
        bonusGuesses.push({ bonusId: b, likelihood: least, basis: PRESENCE_ORDER.filter((s) => basis.has(s)), inView: view, hidden: unseen });
    }
    bonusGuesses.sort((a, b) => b.likelihood - a.likelihood || g.bonusById.get(b.bonusId)!.value - g.bonusById.get(a.bonusId)!.value || a.bonusId - b.bonusId);

    // 7. Approaches: from each stack in view, and from each hidden territory it probably holds.
    const income = track?.income ?? track?.visibleIncome ?? w.base;
    const field = fieldFor(w, o);
    const sources: Source[] = [
      ...own.map((t): Source => {
        const shown = visibleState(t);
        const units = specialUnitStrength(t.specialUnits?.filter((u) => u.playerId === o));
        return shown
          ? { id: t.territoryId, kind: 'seen', armies: Math.max(0, shown.armies! - w.guard) + units, counted: true }
          : { id: t.territoryId, kind: 'seen', armies: w.starting, counted: false };
      }),
      ...presenceList
        .filter((p) => p.likelihood >= SOURCE_PRESENCE)
        .map((p): Source => ({ id: p.territoryId, kind: 'guessed', armies: w.starting, counted: false }))
        .sort((a, b) => a.id - b.id),
    ];
    interface Way {
      inTurns: number;
      arriving: number;
      via: number;
      source: Source;
      path: () => number[];
    }
    const sooner = (a: Way, b: Way | undefined): boolean => {
      if (!b) return true;
      if (a.inTurns !== b.inTurns) return a.inTurns < b.inTurns;
      if (a.source.kind !== b.source.kind) return a.source.kind === 'seen';
      if (a.source.counted !== b.source.counted) return a.source.counted;
      if (a.arriving !== b.arriving) return a.arriving > b.arriving;
      if (a.source.id !== b.source.id) return a.source.id < b.source.id;
      return a.via < b.via;
    };
    const ways = new Map<number, Way>();
    const threats = new Map<number, Threat>();
    const takings = new Map<number, Taking>();
    for (const s of sources) {
      const r = reachCore(field, [s.id], { armies: s.armies, income }, REACH_HORIZON);
      for (const m of borders) {
        for (const via of neighborsOf(g, m)) {
          const e = w.mine.has(via) ? undefined : r.best.get(via);
          if (!e) continue;
          const way: Way = {
            inTurns: e.turns,
            arriving: Math.max(0, s.armies + income * (e.turns + 1) - e.cost),
            via,
            source: s,
            path: () => [...r.pathTo(via), m],
          };
          if (sooner(way, ways.get(m))) ways.set(m, way);
          if (s.counted && way.inTurns < PREPARE_TURNS) {
            const t = threats.get(m);
            // The soonest attack is the one to prepare for; among equally soon ones, the largest.
            if (!t || way.inTurns < t.inTurns || (way.inTurns === t.inTurns && way.arriving > t.armies))
              threats.set(m, { armies: way.arriving, inTurns: way.inTurns, from: s.id });
          }
        }
      }
      for (const t of wanted) {
        const e = r.best.get(t);
        if (!e || e.turns < 1) continue;
        const had = takings.get(t);
        if (!had || e.turns < had.turns) takings.set(t, { turns: e.turns, from: s.id, guessed: s.kind === 'guessed' });
      }
    }
    const approaches: Approach[] = [...ways]
      .map(([target, way]): Approach => ({
        target,
        turn: turn + way.inTurns,
        inTurns: way.inTurns,
        source: way.source.kind,
        from: way.source.id,
        path: way.path(),
        armies: way.source.counted ? way.arriving : null,
        valued: valued(target),
      }))
      .sort((a, b) => a.inTurns - b.inTurns || Number(b.valued) - Number(a.valued) || a.target - b.target)
      .slice(0, MAX_APPROACHES);

    // 8. Doing.
    const doing: Doing[] = [];
    const received = track?.earnedAtLeast
      ? `; it has received at least ${track.earnedAtLeast.total} armies since the game started (received, not held).`
      : '.';
    if (!seenIds.length) doing.push({ rule: 'unseen', text: `Player ${o} has not been seen on any board of yours${received}`, territoryIds: [] });
    else if (!own.length)
      doing.push({ rule: 'out-of-sight', text: `Player ${o} has nothing in view (last seen on turn ${lastSight})${received}`, territoryIds: [] });
    // One sentence per stack, naming the territories of mine it can attack this turn.
    const stacks = new Map<number, { arriving: number; targets: number[] }>();
    for (const [target, way] of ways) {
      if (way.inTurns !== 0 || !way.source.counted) continue;
      const s = stacks.get(way.source.id) ?? { arriving: 0, targets: [] };
      s.arriving = Math.max(s.arriving, way.arriving);
      s.targets.push(target);
      stacks.set(way.source.id, s);
    }
    const attacks = [...stacks].sort(([a, x], [b, y]) => y.arriving - x.arriving || a - b).slice(0, MAX_DOING_PER_RULE);
    for (const [from, { arriving, targets }] of attacks) {
      targets.sort(byNum);
      const named = targets.slice(0, MAX_TARGETS_NAMED);
      const rest = targets.length - named.length;
      const list =
        targets.length === 1
          ? `territory ${named[0]}`
          : rest > 0
            ? `territories ${named.join(', ')} and ${rest} more`
            : `territories ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
      doing.push({
        rule: 'can-attack',
        text: `Player ${o} can attack ${list} this turn with up to ${arriving} armies from territory ${from} (what its stack can move plus a deploy of ${income}).`,
        territoryIds: [...targets, from],
      });
    }
    const before = w.byTurn.get(turn - 1);
    if (before) {
      const was = new Map(before.territories.map((t) => [t.territoryId, t]));
      const grew = own
        .flatMap((t) => {
          const a = visibleState(t);
          const b = visibleState(was.get(t.territoryId));
          const next = neighborsOf(g, t.territoryId).find((n) => w.mine.has(n));
          if (!a || !b || shownOwner(b) !== o || next === undefined || a.armies! <= b.armies!) return [];
          return [{ id: t.territoryId, by: a.armies! - b.armies!, to: a.armies!, next }];
        })
        .sort((a, b) => b.by - a.by || a.id - b.id)
        .slice(0, MAX_DOING_PER_RULE);
      for (const s of grew)
        doing.push({
          rule: 'stack-grew',
          text: `Player ${o}'s stack on territory ${s.id}, next to your territory ${s.next}, grew by ${s.by} to ${s.to} since turn ${turn - 1}.`,
          territoryIds: [s.id, s.next],
        });
    }
    const near: { bonusId: number; value: number; held: number; size: number; missing: number[] }[] = [];
    const ownBonuses = new Set<number>();
    for (const id of ownIds) for (const b of index.get(id) ?? []) ownBonuses.add(b);
    for (const b of [...ownBonuses].sort(byNum)) {
      const value = g.bonusById.get(b)!.value;
      const members = bonusTerritories(g, b);
      if (value <= 0 || members.some(hidden)) continue;
      const missing = members.filter((t) => !ownIds.has(t));
      if (missing.length >= 1 && missing.length <= 2) near.push({ bonusId: b, value, held: members.length - missing.length, size: members.length, missing });
    }
    near.sort((a, b) => a.missing.length - b.missing.length || b.value - a.value || a.bonusId - b.bonusId);
    for (const n of near.slice(0, MAX_DOING_PER_RULE)) {
      const yours = n.missing.filter((t) => w.mine.has(t));
      doing.push({
        rule: 'near-bonus',
        text:
          `Player ${o} holds ${n.held} of the ${n.size} territories of bonus ${n.bonusId} (+${n.value}): ${n.missing.length} ` +
          `${plural(n.missing.length, 'capture', 'captures')} from completing it (${plural(n.missing.length, 'territory', 'territories')} ${n.missing.join(', ')}` +
          `${yours.length ? `; ${yours.join(', ')} ${plural(yours.length, 'is', 'are')} yours` : ''}).`,
        territoryIds: n.missing,
        bonusId: n.bonusId,
      });
    }
    if (track?.unexplained !== null && track?.unexplained !== undefined && track.income !== null && track.unexplained > track.income)
      doing.push({
        rule: 'hidden-armies',
        text: `About ${track.unexplained} of player ${o}'s armies are out of sight or were spent there (earned since it was first seen, and neither on the board nor lost in view), more than its income of ${track.income} a turn.`,
        territoryIds: [],
      });

    const where = own.length ? `${own.length} ${plural(own.length, 'territory', 'territories')} in view` : 'nothing in view';
    const startText = proven.length
      ? `${plural(proven.length, 'start', 'starts')} ${proven.join(', ')} proven`
      : likely[0]
        ? `likeliest start ${likely[0].territoryId} (${round2(likely[0].likelihood)})`
        : 'no start guess';
    const soonest = approaches[0];
    const next = soonest
      ? `soonest attack on territory ${soonest.target} on turn ${soonest.turn}${soonest.armies !== null ? ` with up to ${soonest.armies}` : ''} (${soonest.source})`
      : 'no attack on you within reach';
    return {
      out: {
        playerId: o,
        seen: { inView: seenInView, lastSeen, bonuses: seenBonuses },
        starts,
        presence: presenceList,
        bonuses: bonusGuesses,
        income: track && track.income !== null ? { estimate: track.income, method: track.incomeMethod } : null,
        hiddenArmies: track?.unexplained ?? null,
        approaches,
        doing,
        summary: `Player ${o}: ${where}${lastSeen.length ? `, ${lastSeen.length} last seen` : ''}; ${startText}; ${next}.`,
      },
      presence,
      threats,
      takings,
    };
  };

  const located = opponents.map(locate);

  // 9. Prepare.
  interface Ranked extends Prepare {
    /** Larger first among the same turn and kind. */
    weight: number;
  }
  const rateArgs = {
    ...(w.settings.offensiveKillRate !== undefined ? { offensiveKillRate: w.settings.offensiveKillRate } : {}),
    ...(w.settings.defensiveKillRate !== undefined ? { defensiveKillRate: w.settings.defensiveKillRate } : {}),
  };
  /** The fewest defenders that `attackers` armies cannot take. */
  const defendersToHold = (attackers: number): number => {
    let d = 0;
    while (d <= attackers && (armiesToTake(d, rateArgs) ?? Infinity) <= attackers) d++;
    return d;
  };
  const ranked: Ranked[] = [];
  for (const { out, presence, threats, takings } of located) {
    const o = out.playerId;
    for (const [m, threat] of [...threats].sort(([a], [b]) => a - b)) {
      if (!valued(m)) continue;
      const need = defendersToHold(threat.armies);
      const have = defenders(w.now.get(m)!);
      if (need <= have) continue;
      const bonusId = fullBonusOf.get(m);
      const why = bonusId !== undefined ? `in bonus ${bonusId}, which you hold in full` : 'your commander is there';
      ranked.push({
        kind: 'hold',
        opponent: o,
        turn: turn + threat.inTurns,
        territory: m,
        ...(bonusId !== undefined ? { bonusId } : {}),
        need,
        have,
        armies: threat.armies,
        from: threat.from,
        text: `Territory ${m} (${why}) can be attacked by player ${o} on turn ${turn + threat.inTurns} with up to ${threat.armies} armies from territory ${threat.from}: it needs ${need} armies to hold and has ${have}.`,
        weight: need - have,
      });
    }
    for (const p of partial) {
      const head = `Bonus ${p.bonusId} (+${p.value}): you hold ${p.held} of ${p.size}; player ${o}`;
      const base = { kind: 'contested' as const, opponent: o, bonusId: p.bonusId, weight: p.value };
      const holds = p.missing.find((t) => shownOwner(w.now.get(t)) === o);
      if (holds !== undefined) {
        ranked.push({ ...base, turn, territory: holds, text: `${head} holds territory ${holds}.` });
        continue;
      }
      const guess = p.missing
        .filter((t) => (presence.get(t) ?? 0) >= LIKELY_BONUS)
        .sort((a, b) => presence.get(b)! - presence.get(a)! || a - b)[0];
      if (guess !== undefined) {
        const x = presence.get(guess)!;
        ranked.push({ ...base, turn, territory: guess, likelihood: x, text: `${head} may hold territory ${guess} (likelihood ${round2(x)}).` });
        continue;
      }
      const taken = p.missing
        .filter((t) => (takings.get(t)?.turns ?? Infinity) <= PREPARE_TURNS)
        .sort((a, b) => takings.get(a)!.turns - takings.get(b)!.turns || a - b)[0];
      if (taken !== undefined) {
        const t = takings.get(taken)!;
        const by = turn + t.turns - 1;
        ranked.push({ ...base, turn: by, territory: taken, from: t.from, text: `${head} could take territory ${taken} by turn ${by} from territory ${t.from}${t.guessed ? ' (guessed)' : ''}.` });
      }
    }
    // One look per opponent: the territory next to mine that shows the most of the fog, among
    // those that would settle a guess that could go either way.
    const unsure = (id: number) => hidden(id) && (presence.get(id) ?? 0) >= SCOUT_RANGE.min && (presence.get(id) ?? 0) <= SCOUT_RANGE.max;
    let look: { at: number; next: number; shows: number[]; fog: number } | undefined;
    const tried = new Set<number>();
    for (const m of borders) {
      for (const at of neighborsOf(g, m)) {
        if (w.mine.has(at) || tried.has(at)) continue;
        tried.add(at);
        const around = [at, ...neighborsOf(g, at)].filter(hidden);
        const shows = around.filter(unsure);
        if (!shows.length) continue;
        if (!look || around.length > look.fog || (around.length === look.fog && at < look.at)) look = { at, next: m, shows, fog: around.length };
      }
    }
    if (look) {
      const best = [...look.shows].sort((a, b) => presence.get(b)! - presence.get(a)! || a - b)[0]!;
      const x = presence.get(best)!;
      const text = hidden(look.at)
        ? `Territory ${look.at} borders your territory ${look.next} and is hidden: player ${o} may be there (likelihood ${round2(presence.get(look.at) ?? x)}); taking or seeing it would settle that.`
        : `Taking territory ${look.at} (it borders your territory ${look.next}) would show ${plural(look.shows.length, 'territory', 'territories')} ${look.shows.join(', ')}, where player ${o} may be (likelihood ${round2(x)}); it borders ${look.fog} hidden ${plural(look.fog, 'territory', 'territories')}.`;
      ranked.push({ kind: 'scout', opponent: o, turn, territory: look.at, reveals: look.shows, likelihood: x, text, weight: look.fog });
    }
  }
  const kindOrder = { hold: 0, contested: 1, scout: 2 } as const;
  const prepare = ranked
    .sort(
      (a, b) =>
        kindOrder[a.kind] - kindOrder[b.kind] ||
        a.turn - b.turn ||
        b.weight - a.weight ||
        a.territory - b.territory ||
        a.opponent - b.opponent ||
        (a.bonusId ?? 0) - (b.bonusId ?? 0),
    )
    .slice(0, MAX_PREPARE)
    .map(({ weight: _weight, ...p }): Prepare => p);

  return { turn, opponents: located.map((l) => l.out), prepare, assumptions };
}

/** What the model assumes whatever the opponent. */
function baseAssumptions(input: WhereInput, w: World): string[] {
  const out = [
    'Only `seen` is fact (what your boards showed). The likelihoods are a simple model\'s estimates, not measured probabilities.',
    'Growth pools armies: a start\'s armies and its whole income (the base, plus the bonuses it completes) are spent on the bonus with the best value per capture cost. It says what a player could plausibly hold, which is more than it probably does.',
    'Movement is one capture per turn along a path, each capture paying its whole attack out of the armies at hand plus the income per turn; Multi-Attack, Airlift and every other card are ignored.',
    'A start is never abandoned and a captured territory never turns neutral again (Blockade is ignored).',
    'An opponent\'s income is its tracked estimate when it has one, else what it visibly earns (the base plus the bonuses it holds in view). The armies that could arrive count that income every turn on the way and one stack only.',
  ];
  if (input.settings.multiAttack) out.push('This game has Multi-Attack on: a stack can take several territories in one turn, so every turn given here may come sooner.');
  const c = input.candidates;
  const n = w.candidates.size;
  if (!c) out.push('No start candidates are known (no pickable territories were kept, and no statistics are in use), so no start is guessed: the rest works from what was seen.');
  else if (c.source === 'pickable') out.push(`Start candidates: the ${n} ${plural(n, 'territory', 'territories')} the live board showed as pickable during distribution.`);
  else out.push(`Start candidates: the ${n} ${plural(n, 'territory', 'territories')} players started on in the finished games cached for this map; a start nobody used there is missed.`);
  if (c) {
    if (input.prior)
      out.push(
        `The start prior weighs a candidate by the players who started on it in ${input.prior.sample} finished ${plural(input.prior.sample, 'game', 'games')} on this map, plus one` +
          `${input.prior.weak ? ': a small sample, so a weak prior' : ''}.`,
      );
    else out.push('The start prior is uniform: every candidate weighs the same.');
    if (input.settings.startsPerPlayer === undefined || input.settings.startsPerPlayer <= 0)
      out.push('The settings do not say how many territories a player started on, so no start is guessed.');
  }
  const oldest = w.turns[0];
  if (oldest !== undefined && oldest > 1 && c)
    out.push(
      `Your oldest board is turn ${oldest}: what it shows as yours or as another player's is taken as no start of anyone else, though it may have been captured before.`,
    );
  return out;
}
