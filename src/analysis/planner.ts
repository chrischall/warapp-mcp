// Turn planner: deploys and moves for one turn, from one player's view of a
// board. Pure and deterministic (every choice tie-breaks on ascending id); no
// I/O. Advisory only — it never submits orders.
//
// Rules, in decision order:
//  1. Defence. A visible enemy next to my territory T threatens it when
//     `armiesToTake(armies(T)) ≤ E + enemyDeploy`, where E is that player's
//     movable armies (minus the guard) summed over its territories bordering T.
//     enemyDeploy defaults to max(5, round(0.75 × the largest visible enemy
//     stack)): an opponent's income is unseen, and a big visible stack implies
//     a big income (live, 13 showing next door broke a 12-army border).
//     Always a warning.
//  1t. Trend. Given `previousBoard` (my view one turn earlier), each visible
//     enemy territory next to me that was visible then under the same owner and
//     has grown is "building" at growth = armies now − armies then per turn (a
//     warning naming my most exposed neighbour and the armies it needs to hold
//     next turn and the turn after). A border's threat becomes movable +
//     max(enemyDeploy, the owner's fastest growth next to it), so its hold cost
//     and the leftover margin both use the projection (a rationale line says so).
//  1a. Triage (every goal). Each threatened border's protected value is the sum
//     of my complete bonuses containing it, plus incomplete bonuses containing it
//     that I would lose all access to without it, plus the per-territory
//     income it carries (each bonus counted once). Its worth adds the armies a
//     hold saves, in income terms (armies / PAYBACK_TURNS): a top-up that keeps a
//     big stack is worth paying even for a small bonus (live, a 60-army border
//     protecting +4 needed 20 and held against 105). Its hold cost is the fewest
//     deploys making `armiesToTake(armies + d) > threat`. Borders are taken in
//     order of worth per army of hold cost (ties: lower hold cost, then id); a
//     border is conceded when its hold cost exceeds the budget left or
//     CONCEDE_FACTOR × its worth (so a thin border protecting nothing is
//     conceded). Under `goal: 'defend'` the plan deploys each hold, and a held
//     border then makes no moves.
//     Scope of "protected value", deliberately narrow: only bonuses containing T
//     count (not a bonus T merely borders), and an incomplete one counts in full
//     when T is my only foothold, however much of it the enemy holds. So with no
//     complete bonus and no per-territory income (`bonusArmyPer` off), a threatened
//     border protects +0 and is conceded: early in a game `defend` holds nothing
//     and withdraws from every threatened border, keeping armies for expansion.
//     A conceded border is never deployed to (unless every territory I hold is
//     conceded): it may still attack out with the armies already on it, since they
//     are lost anyway if they stay, but no capture is funded there.
//     Under `balanced` a hold is not deployed here: it competes in the greedy
//     step (rule 4a), and a threatened border it might hold makes no attacks.
//  1b. Withdraw (under `defend` and `balanced`). A conceded border's movable armies move first
//     to the adjacent territory of mine nearest a border that holds (then the
//     one protecting the most value, then id); the plan advises Order Priority
//     (`cardAdvice`), because a withdrawal only executes while the border is mine.
//  2. Targets: visible neutrals adjacent to a territory I held at the start of
//     the turn (plus visible enemy territories under `goal: 'complete-bonus'`, and
//     under `balanced` only enemy territories in a breakable bonus — one whose
//     every territory is visible and held by a single enemy; never under
//     `expand`/`defend`). Fogged or unknown neighbours are never attacked — they
//     produce a warning.
//  3. Capture cost: `armiesToTake` (0% luck, straight round). With luck L > 0
//     the cost becomes `ceil(cost / (1 − L))`, i.e. the luck-free share of the
//     attack alone still takes the territory.
//  4. Bonuses (value > 0) are scored by value / remaining capture cost, ties by
//     fewest external borders, then id; focused bonuses come first. A bonus whose
//     remaining cost exceeds PAYBACK_TURNS × value, or with one remaining
//     territory costing over WASTELAND_FACTOR × value, is uneconomic and its
//     territories are not planned (unless focused or also in an economic bonus).
//     A negative-value bonus is always uneconomic unless focused, so the plan
//     never captures into it (completing one would cut income).
//     Pass 1 completes bonuses that can be finished this turn (all or nothing);
//     pass 2 advances bonuses one capture at a time, cheapest first; pass 3
//     (not under `complete-bonus`) takes any other affordable target (never an
//     enemy one under `balanced`).
//  4a. Balanced (the default goal). Instead of passes 1–2, every candidate is
//     scored as income per army and taken greedily (focus first, then score, then
//     cheaper, fewer bonus borders, id): a hold (protected value / hold cost),
//     completing or advancing a bonus (value / remaining cost), breaking an enemy
//     bonus (BREAK_WEIGHT / opponents × value / capture cost, aimed at the member
//     whose survivors would hold against the counter-attack if any, else the
//     cheapest, warning when it can be retaken). A threatened border whose only
//     visible threat is a member of a breakable bonus also attacks it, once per
//     bonus: it deploys its hold plus the capture, so what stays still holds if
//     the enemy reinforces that member first and the attack fails; when it cannot
//     afford both it just holds (a held border otherwise makes no attacks). While expansion candidates
//     remain, a hold protecting less than the best expansion's value may not dip
//     into the first MIN_EXPANSION_SHARE of income not yet spent on expansion; it
//     is deferred and funded afterwards if the budget allows, else conceded.
//  5. Deploys cover only the shortfall of a chosen capture; leftover income never
//     goes to a conceded border: it goes to the held border with the highest
//     protected value still short of COMFORT_MARGIN × its threat (counting armies
//     withdrawn into it), else the source of the top expansion (which then makes
//     no transfer), else the border with the most fogged neighbours, else
//     my biggest stack.
//  6. Idle armies on interior territories transfer one step toward the front,
//     only into territories held at the start of the turn and never into, or
//     measured through, a conceded border
//     (only when transfer-only orders are allowed).
// Accounting: a territory's outgoing armies never exceed its armies after deploy
// minus the guard. Armies never move twice and captured armies never attack, so
// the plan is valid with or without multi-attack.

import type { BoardState, TerritoryState } from '../board.js';
import type { GameSettings } from '../normalize.js';
import { analyzeBonus, bonusTerritories } from './bonuses.js';
import { armiesToTake, DEFAULT_DEFENSIVE_KILL_RATE, DEFAULT_OFFENSIVE_KILL_RATE } from './combat.js';
import { bfsDistances, neighborsOf, type MapGraph } from './graph.js';
import { analyzePlayer, DEFAULT_BASE_INCOME } from './player.js';

/** A bonus is uneconomic when its remaining capture cost exceeds this many turns of its value… */
export const PAYBACK_TURNS = 10;
/** …or when one remaining territory alone costs more than this many times its value (a wasteland). */
export const WASTELAND_FACTOR = 5;
/** Floor of the default enemy deploy estimate (a player's base income). */
export const MIN_ENEMY_DEPLOY = DEFAULT_BASE_INCOME;
/** The default estimate is this share of the largest visible enemy stack. */
export const ENEMY_STACK_SHARE = 0.75;
/** A border is conceded when holding it costs more than this many times the income it protects. */
export const CONCEDE_FACTOR = 3;
/** A held border is comfortable once taking it needs more than this many times its threat. */
export const COMFORT_MARGIN = 1.25;

/** Denying +V to the opponent is worth this many times gaining +V yourself (per opponent: divided among them). */
export const BREAK_WEIGHT = 1.0;
/** Under `balanced`, at least this share of income goes to expansion/breaking before holds protecting less than it. */
export const MIN_EXPANSION_SHARE = 0.3;

export type PlanGoal = 'balanced' | 'expand' | 'complete-bonus' | 'defend';

export interface PlannerSettings {
  offensiveKillRate?: number;
  defensiveKillRate?: number;
  /** Fraction (0.16) or percent (16). */
  luckModifier?: number;
  roundingMode?: string;
  /** Default `true`. */
  oneArmyStandsGuard?: boolean;
  multiAttack?: boolean;
  /** Default `true`: idle interior armies may transfer. */
  allowTransferOnly?: boolean;
  /** One army of income per this many territories held (0 or absent: off). */
  bonusArmyPer?: number;
}

export interface PlanOptions {
  /** Default `balanced`. */
  goal?: PlanGoal;
  /** Bonuses to work on first, even when uneconomic. */
  focusBonusIds?: number[];
  /** Income held back from captures (still deployed, as leftover). */
  reserve?: number;
  /** Assumed enemy deploy next turn when judging threats (default {@link defaultEnemyDeploy}). */
  enemyDeploy?: number;
  /**
   * Other players still in the game (divides {@link BREAK_WEIGHT}); default the
   * number of enemy players visible on the board, at least 1.
   */
  opponents?: number;
}

export interface PlanInput {
  graph: MapGraph;
  board: BoardState;
  /** My player id. */
  me: number;
  /** Armies to deploy this turn (see {@link incomeFor}). */
  income: number;
  /**
   * The same player's view one turn earlier, when known: enemy stacks next to me
   * that grew since then project their growth into next turn's threat.
   */
  previousBoard?: BoardState;
  settings?: PlannerSettings;
  options?: PlanOptions;
}

export interface PlannedDeploy {
  territoryId: number;
  armies: number;
}

export interface PlannedMove {
  from: number;
  to: number;
  armies: number;
  kind: 'attack' | 'transfer';
  reason: string;
}

/** A card the submission should play for the plan to work (the planner itself never plays cards). */
export type CardAdvice = 'order-priority';

export interface TurnPlan {
  /** Sorted by territory id; sums to the income whenever I own a territory. */
  deploys: PlannedDeploy[];
  /** Withdrawals from conceded borders first, then attacks in decision order, then transfers. */
  moves: PlannedMove[];
  expected: {
    captures: number[];
    bonusesCompleted: number[];
    /** This turn's income plus newly completed bonuses (nothing lost, no per-territory income). */
    nextIncome: number;
  };
  warnings: string[];
  rationale: string[];
  /** The enemy deploy the threat checks assumed. */
  enemyDeploy: number;
  /** Threatened borders not worth (or not affordable) holding this turn, sorted. */
  conceded: number[];
  /** `'order-priority'` when a withdrawal is planned (it must run before the border falls). */
  cardAdvice: CardAdvice | null;
}

const byNum = (a: number, b: number) => a - b;

function luckFraction(v: number | undefined): number {
  if (!v || v <= 0) return 0;
  const f = v > 1 ? v / 100 : v;
  return Math.min(f, 0.95);
}

/** Armies to send at a territory held by `defenders`, luck margin included; `null` when it cannot be taken. */
export function captureCost(defenders: number, settings: PlannerSettings = {}): number | null {
  const base = armiesToTake(defenders, {
    offensiveKillRate: settings.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE,
    defensiveKillRate: settings.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE,
  });
  if (base === null) return null;
  const luck = luckFraction(settings.luckModifier);
  return luck > 0 ? Math.ceil(base / (1 - luck)) : base;
}

function largestEnemyStack(board: BoardState, me: number): number {
  let max = 0;
  for (const t of board.territories)
    if (t.owner.kind === 'player' && t.owner.playerId !== me && t.armies !== null) max = Math.max(max, t.armies);
  return max;
}

/**
 * Default enemy deploy estimate: max(5, round(0.75 × the largest visible enemy
 * stack)). Unseen income is unknown; a big visible stack implies a big one.
 */
export function defaultEnemyDeploy(board: BoardState, me: number): number {
  return Math.max(MIN_ENEMY_DEPLOY, Math.round(ENEMY_STACK_SHARE * largestEnemyStack(board, me)));
}

/** This turn's income from the existing income code (base + per-territory + held bonuses). */
export function incomeFor(g: MapGraph, board: BoardState, me: number, settings?: GameSettings): number {
  return analyzePlayer(g, board, me, settings).income.total;
}

interface Target {
  id: number;
  cost: number;
  enemy: boolean;
  sources: number[];
}

interface BonusPlan {
  bonusId: number;
  value: number;
  focus: boolean;
  remaining: number[];
  completable: boolean;
  cost: number;
  borders: number;
}

export function planTurn(input: PlanInput): TurnPlan {
  const { graph: g, board, me } = input;
  const s = input.settings ?? {};
  const opts = input.options ?? {};
  const goal: PlanGoal = opts.goal ?? 'balanced';
  const balanced = goal === 'balanced';
  const focus = new Set(opts.focusBonusIds ?? []);
  const income = Math.max(0, Math.floor(input.income));
  const reserve = Math.min(income, Math.max(0, Math.floor(opts.reserve ?? 0)));
  const custom = opts.enemyDeploy !== undefined;
  const enemyDeploy = custom ? Math.max(0, Math.floor(opts.enemyDeploy!)) : defaultEnemyDeploy(board, me);
  const guard = (s.oneArmyStandsGuard ?? true) ? 1 : 0;
  const rates = {
    offensiveKillRate: s.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE,
    defensiveKillRate: s.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE,
  };
  const warnings: string[] = [];
  const rationale: string[] = [];

  const state = new Map<number, TerritoryState>();
  for (const t of board.territories) if (g.territoryById.has(t.territoryId)) state.set(t.territoryId, t);
  const label = (id: number) => `${g.territoryById.get(id)!.name} (#${id})`;
  const isMine = (id: number) => {
    const o = state.get(id)?.owner;
    return o?.kind === 'player' && o.playerId === me;
  };
  const mine = [...state.keys()].filter(isMine).sort(byNum);
  const mineSet = new Set(mine);
  const armiesOf = (id: number) => state.get(id)?.armies ?? 0;

  if (!board.verified)
    warnings.push('Board state comes from an unverified parser of the GameFeed standing; check it against the game.');
  const luck = luckFraction(s.luckModifier);
  if (luck > 0)
    warnings.push(
      `Luck is ${Math.round(luck * 100)}%: each attack carries a margin (armies = ceil(cost / (1 − luck))) and can still fail.`,
    );
  if (s.roundingMode !== undefined && s.roundingMode !== 'StraightRound')
    warnings.push(`Capture costs assume straight rounding; this game uses ${s.roundingMode}.`);
  if (s.multiAttack)
    rationale.push('Multi-attack is on, but the plan does not chain attacks from captured territories.');

  if (!mine.length) {
    warnings.push(`Player ${me} holds no territories on this board, so there is nothing to deploy or move.`);
    return {
      deploys: [],
      moves: [],
      expected: { captures: [], bonusesCompleted: [], nextIncome: income },
      warnings,
      rationale,
      enemyDeploy,
      conceded: [],
      cardAdvice: null,
    };
  }

  // ---- mutable plan state ----
  let budget = income;
  const deployed = new Map<number, number>();
  // May start at −1 (a 0-army territory still owes its guard): deploys there pay for it first.
  const avail = new Map(mine.map((id) => [id, armiesOf(id) - guard]));
  const locked = new Set<number>();
  const captured = new Set<number>();
  const moves: PlannedMove[] = [];
  const deploy = (id: number, n: number) => {
    if (n <= 0) return;
    deployed.set(id, (deployed.get(id) ?? 0) + n);
    avail.set(id, avail.get(id)! + n);
    budget -= n;
  };

  // ---- protected value ----
  const protectedValue = (t: number): number => {
    // Each bonus is visited once, so it counts once however many of its borders are threatened.
    let v = 0;
    const mineWithout = (x: number) => x !== t && mineSet.has(x);
    for (const b of g.map.bonuses) {
      const ts = bonusTerritories(g, b.id);
      if (b.value <= 0 || !ts.includes(t)) continue;
      if (ts.every((x) => mineSet.has(x))) {
        v += b.value;
        continue;
      }
      // An incomplete bonus I am working on (T is in it): lost access if T is my only way in.
      const access = (has: (x: number) => boolean) =>
        ts.some((x) => has(x) || neighborsOf(g, x).some(has));
      if (!access(mineWithout)) v += b.value;
    }
    const per = s.bonusArmyPer ?? 0;
    if (per > 0) v += Math.floor(mine.length / per) - Math.floor((mine.length - 1) / per);
    return v;
  };
  const valueCache = new Map<number, number>();
  const valueOf = (t: number) => {
    if (!valueCache.has(t)) valueCache.set(t, protectedValue(t));
    return valueCache.get(t)!;
  };

  // ---- 0. threat trend ----
  // Growth of each visible enemy territory next to me since the previous board
  // (visible both times, same owner, grown): its armies per turn of build-up.
  interface Growth {
    from: number;
    to: number;
    growth: number;
  }
  const growthOf = new Map<number, Growth>();
  if (input.previousBoard) {
    const before = new Map(input.previousBoard.territories.map((t) => [t.territoryId, t]));
    for (const [id, st] of [...state].sort((a, b) => a[0] - b[0])) {
      if (st.owner.kind !== 'player' || st.owner.playerId === me || st.armies === null) continue;
      if (!neighborsOf(g, id).some((n) => mineSet.has(n))) continue;
      const was = before.get(id);
      if (was?.owner.kind !== 'player' || was.owner.playerId !== st.owner.playerId || was.armies === null) continue;
      if (st.armies > was.armies) growthOf.set(id, { from: was.armies, to: st.armies, growth: st.armies - was.armies });
    }
  }
  /** Fewest armies on a territory that hold against `threat` attackers. */
  const holdArmies = (threat: number) => {
    let a = 0;
    while ((armiesToTake(a, rates) ?? Infinity) <= threat) a++;
    return a;
  };

  // ---- 1. defence ----
  interface Border {
    id: number;
    player: number;
    movable: number;
    /** That player's fastest-growing stack next to this border (0 without a trend). */
    growth: number;
    /** movable + max(enemyDeploy, growth). */
    threat: number;
  }
  const borders = new Map<number, Border>();
  for (const t of mine) {
    const byPlayer = new Map<number, { movable: number; growth: number }>();
    for (const n of neighborsOf(g, t)) {
      const st = state.get(n);
      if (st?.owner.kind !== 'player' || st.owner.playerId === me || st.armies === null) continue;
      const p = byPlayer.get(st.owner.playerId) ?? { movable: 0, growth: 0 };
      p.movable += Math.max(0, st.armies - guard);
      p.growth = Math.max(p.growth, growthOf.get(n)?.growth ?? 0);
      byPlayer.set(st.owner.playerId, p);
    }
    if (!byPlayer.size) continue;
    const [player, { movable, growth }] = [...byPlayer]
      .map(([id, p]) => [id, p, p.movable + Math.max(enemyDeploy, p.growth)] as const)
      .sort((a, b) => b[2] - a[2] || a[0] - b[0])[0]!;
    borders.set(t, { id: t, player, movable, growth, threat: movable + Math.max(enemyDeploy, growth) });
  }
  for (const [e, gr] of growthOf) {
    // Name the most exposed of my territories next to it (fewest armies, then id).
    const t = neighborsOf(g, e)
      .filter((n) => mineSet.has(n))
      .sort((a, b) => armiesOf(a) - armiesOf(b) || a - b)[0]!;
    const b = borders.get(t)!;
    const next = b.movable + Math.max(enemyDeploy, b.growth);
    const after = b.movable + b.growth + Math.max(enemyDeploy, b.growth);
    warnings.push(
      `${label(e)} is building: +${gr.growth}/turn (${gr.from} → ${gr.to}); at this rate ${label(t)} needs ${holdArmies(next)} to hold next turn and ${holdArmies(after)} the turn after`,
    );
  }
  for (const b of borders.values())
    if (b.growth > enemyDeploy)
      rationale.push(
        `Threat on ${label(b.id)} uses the trend: player ${b.player}'s stack next to it grows +${b.growth}/turn, more than the ~${enemyDeploy} deploy estimate, so ~${b.threat}.`,
      );
  if (borders.size)
    warnings.push(
      custom
        ? `Enemy deploy estimate: threat checks assume ~${enemyDeploy} (your estimate); enemy income is unknown, so they could deploy more.`
        : `Enemy deploy estimate: threat checks assume ~${enemyDeploy} (max(${MIN_ENEMY_DEPLOY}, ${ENEMY_STACK_SHARE * 100}% of the largest visible enemy stack (${largestEnemyStack(board, me)}))); enemy income is unknown, so they could deploy more.`,
    );

  interface Threatened {
    id: number;
    have: number;
    threat: number;
    holdCost: number;
    value: number;
    /** Protected value plus the armies a hold saves, in income terms (armies / PAYBACK_TURNS). */
    worth: number;
  }
  const threatened: Threatened[] = [];
  for (const b of borders.values()) {
    const have = armiesOf(b.id);
    const take = armiesToTake(have, rates);
    if (take === null || take > b.threat) continue;
    warnings.push(
      `${label(b.id)} (${have} armies) could be taken next turn: player ${b.player} has ${b.movable} movable armies next to it plus ~${b.growth > enemyDeploy ? `${b.growth} (its growth per turn)` : `${enemyDeploy} deploy`}, and ${take} would do.`,
    );
    // armiesToTake grows at least one army per ~(100 / offensive kill rate) defenders, so this ends.
    let d = 1;
    while ((armiesToTake(have + d, rates) ?? Infinity) <= b.threat) d++;
    const value = valueOf(b.id);
    threatened.push({ id: b.id, have, threat: b.threat, holdCost: d, value, worth: value + have / PAYBACK_TURNS });
  }
  threatened.sort(
    (a, b) => b.worth / b.holdCost - a.worth / a.holdCost || a.holdCost - b.holdCost || a.id - b.id,
  );

  const acting = goal === 'defend';
  const conceded = new Set<number>();
  const concedeUnaffordable = (t: Threatened, left: number) => {
    conceded.add(t.id);
    warnings.push(
      `${label(t.id)} cannot be held with the ${left} armies left to deploy (needs ${t.holdCost}, protects +${t.value}): conceded`,
    );
  };
  const hold = (t: Threatened) => {
    deploy(t.id, t.holdCost);
    locked.add(t.id);
    rationale.push(
      `Deploy ${t.holdCost} to ${label(t.id)} so it holds (protects +${t.value}): ${t.have + t.holdCost} armies need ${armiesToTake(t.have + t.holdCost, rates)} to take, above the ~${t.threat} threat.`,
    );
  };
  // Under `balanced`, holds worth paying for compete with expansion in the greedy step below.
  const holds: Threatened[] = [];
  let triageBudget = budget;
  for (const t of threatened) {
    const left = acting ? budget : triageBudget;
    if (t.holdCost > CONCEDE_FACTOR * t.worth) {
      conceded.add(t.id);
      warnings.push(`${label(t.id)} cannot be held economically (needs ${t.holdCost}, protects +${t.value}): conceded`);
      continue;
    }
    if (balanced) {
      // Its armies stay put until the greedy step decides: holding assumes they are all there.
      holds.push(t);
      locked.add(t.id);
      continue;
    }
    if (t.holdCost > left) {
      concedeUnaffordable(t, left);
      continue;
    }
    triageBudget -= t.holdCost;
    if (acting) hold(t);
  }

  // ---- 1b. withdraw from conceded borders ----
  let cardAdvice: CardAdvice | null = null;
  // Armies withdrawn into each territory this turn (they stay there: armies never move twice).
  const incoming = new Map<number, number>();
  const withdraw = () => {
    if (!conceded.size) return;
    const withdrawals: PlannedMove[] = [];
    const keep = (id: number) => mineSet.has(id) && !conceded.has(id);
    // Borders that can hold: mine, not conceded, next to something not mine.
    const holding = mine.filter((id) => keep(id) && neighborsOf(g, id).some((n) => !mineSet.has(n)));
    for (const t of [...conceded].sort(byNum)) {
      const n = avail.get(t)!;
      if (n <= 0) continue;
      const options = neighborsOf(g, t)
        .filter(keep)
        .map((c) => {
          const dist = bfsDistances(g, [c], { passable: keep });
          let best = Infinity;
          let value = 0;
          for (const h of holding) {
            const d = dist.get(h);
            if (d === undefined) continue;
            if (d < best || (d === best && valueOf(h) > value)) [best, value] = [d, valueOf(h)];
          }
          return { id: c, best, value };
        })
        .sort((a, b) => a.best - b.best || b.value - a.value || a.id - b.id);
      const to = options[0];
      if (!to) {
        warnings.push(`${label(t)} is conceded and has nowhere to withdraw to: its ${n} movable armies stay.`);
        continue;
      }
      avail.set(t, 0);
      locked.add(t);
      const reason = 'withdraws from a conceded border';
      withdrawals.push({ from: t, to: to.id, armies: n, kind: 'transfer', reason });
      incoming.set(to.id, (incoming.get(to.id) ?? 0) + n);
      rationale.push(`Withdraw ${n} from ${label(t)} to ${label(to.id)}: ${reason}, toward a border that holds.`);
      warnings.push(
        `The withdrawal from ${label(t)} only executes if ${label(t)} is still mine when the order runs; play Order Priority so it goes first.`,
      );
      cardAdvice = 'order-priority';
    }
    // Withdrawals go first: they only execute while the border is still mine.
    moves.unshift(...withdrawals);
  };
  if (acting) withdraw();

  // ---- enemy bonuses I could break (under `balanced`) ----
  // A bonus is breakable when every territory in it is visible and held by one enemy.
  interface Breakable {
    bonusId: number;
    value: number;
    player: number;
  }
  const breakable: Breakable[] = [];
  const breakMember = new Set<number>();
  if (balanced) {
    for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
      const ts = bonusTerritories(g, b.id);
      if (b.value <= 0 || !ts.length) continue;
      const owners = new Set<number>();
      let visible = true;
      for (const t of ts) {
        const st = state.get(t);
        if (st?.owner.kind !== 'player' || st.owner.playerId === me || st.armies === null) visible = false;
        else owners.add(st.owner.playerId);
      }
      if (!visible || owners.size !== 1) continue;
      breakable.push({ bonusId: b.id, value: b.value, player: [...owners][0]! });
      for (const t of ts) breakMember.add(t);
    }
  }

  // ---- 2. targets ----
  const targets = new Map<number, Target>();
  for (const t of [...g.territoryById.keys()].sort(byNum)) {
    if (mineSet.has(t)) continue;
    const sources = neighborsOf(g, t).filter((n) => mineSet.has(n));
    if (!sources.length) continue;
    const st = state.get(t);
    if (!st || st.owner.kind === 'unknown' || st.armies === null) {
      warnings.push(
        `Fogged territory ${label(t)} borders my ${sources.map(label).join(', ')}: its armies are unknown (fog), so no attack is planned.`,
      );
      continue;
    }
    if (st.owner.kind === 'available') continue;
    const enemy = st.owner.kind === 'player';
    if (enemy && goal !== 'complete-bonus' && !(balanced && breakMember.has(t))) continue;
    const cost = captureCost(st.armies, s);
    if (cost === null) continue;
    targets.set(t, { id: t, cost, enemy, sources });
  }

  // Bonus passes work toward my own bonuses; under `balanced` enemy targets are only break candidates.
  const bonusTarget = (t: number) => targets.has(t) && !(balanced && targets.get(t)!.enemy);

  // ---- bonus scoring ----
  const plans: BonusPlan[] = [];
  const economicMember = new Set<number>();
  const uneconomicMember = new Set<number>();
  for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
    const isFocus = focus.has(b.id);
    const ts = bonusTerritories(g, b.id);
    const remaining = ts.filter((t) => !mineSet.has(t));
    if (b.value < 0 && !isFocus) {
      // Completing it would cut income: never plan into it (an economic
      // membership elsewhere still wins — see the pass-3 filter).
      for (const t of remaining) uneconomicMember.add(t);
      continue;
    }
    if (b.value <= 0 && !isFocus) continue;
    if (!remaining.length) continue;
    let cost = 0;
    let worst = 0;
    for (const t of remaining) {
      const st = state.get(t);
      if (!st || st.owner.kind === 'unknown' || st.armies === null) continue;
      const c = captureCost(st.armies, s) ?? Infinity;
      cost += c;
      worst = Math.max(worst, c);
    }
    const economic = isFocus || (cost <= PAYBACK_TURNS * b.value && worst <= WASTELAND_FACTOR * b.value);
    for (const t of remaining) (economic ? economicMember : uneconomicMember).add(t);
    if (!remaining.some(bonusTarget)) continue;
    if (!economic) {
      rationale.push(
        `Skip bonus ${b.name} (#${b.id}): uneconomic for +${b.value} (${cost} armies to finish, ${worst} for its costliest territory).`,
      );
      continue;
    }
    plans.push({
      bonusId: b.id,
      value: b.value,
      focus: isFocus,
      remaining,
      completable: remaining.every(bonusTarget),
      cost,
      borders: analyzeBonus(g, b.id)!.borderTerritoryIds.length,
    });
  }
  const ratio = (p: BonusPlan) => (p.cost > 0 ? p.value / p.cost : Infinity);
  plans.sort(
    (a, b) =>
      Number(b.focus) - Number(a.focus) || ratio(b) - ratio(a) || a.borders - b.borders || a.bonusId - b.bonusId,
  );
  const bonusName = (id: number) => `${g.bonusById.get(id)!.name} (#${id})`;

  // ---- capture helper ----
  let anchor: number | undefined;
  /**
   * Capture `t` from its best source. A conceded border is never deployed to: it attacks
   * out only with the armies already on it (unless every territory I hold is conceded,
   * when there is nowhere better). `force` names the source (it may be locked) and the
   * armies on it that stay out of the attack.
   */
  const tryCapture = (t: number, reason: string, force?: { from: number; keep: number }): boolean => {
    const tg = targets.get(t)!;
    const spare = (x: number) => avail.get(x)! - (force?.keep ?? 0);
    const sources = force
      ? [force.from]
      : tg.sources
          .filter(
            (x) =>
              !locked.has(x) &&
              (!conceded.has(x) || avail.get(x)! >= tg.cost || mine.every((id) => conceded.has(id))),
          )
          .sort((a, b) => avail.get(b)! - avail.get(a)! || a - b);
    const src = sources[0];
    if (src === undefined) return false;
    const need = Math.max(0, tg.cost - spare(src));
    if (budget - need < reserve) return false;
    deploy(src, need);
    avail.set(src, avail.get(src)! - tg.cost);
    captured.add(t);
    moves.push({ from: src, to: t, armies: tg.cost, kind: 'attack', reason });
    if (tg.enemy)
      warnings.push(`Attack on enemy ${label(t)} assumes its owner does not reinforce it first.`);
    rationale.push(
      `Attack ${label(t)} from ${label(src)} with ${tg.cost}${need ? ` (deploy ${need} there)` : ''}: ${reason}.`,
    );
    return true;
  };
  if (reserve) rationale.push(`Hold a reserve of ${reserve} out of captures.`);

  // ---- pass 1: complete a bonus this turn (all or nothing) ----
  const complete = (p: BonusPlan) => {
    if (!p.completable) return;
    const todo = p.remaining
      .filter((t) => !captured.has(t))
      .sort((a, b) => targets.get(a)!.cost - targets.get(b)!.cost || a - b);
    if (!todo.length) return;
    const snap = {
      budget,
      deployed: new Map(deployed),
      avail: new Map(avail),
      moves: moves.length,
      rationale: rationale.length,
      warnings: warnings.length,
    };
    const ok = todo.every((t) => tryCapture(t, `completes bonus ${bonusName(p.bonusId)} (+${p.value})`));
    if (ok) {
      anchor ??= moves[snap.moves]?.from;
      return;
    }
    budget = snap.budget;
    deployed.clear();
    for (const [k, v] of snap.deployed) deployed.set(k, v);
    for (const [k, v] of snap.avail) avail.set(k, v);
    for (const m of moves.splice(snap.moves)) captured.delete(m.to);
    rationale.length = snap.rationale;
    warnings.length = snap.warnings;
  };

  // ---- pass 2: advance a bonus one capture at a time ----
  const advance = (p: BonusPlan) => {
    const todo = p.remaining
      .filter((t) => bonusTarget(t) && !captured.has(t))
      .sort((a, b) => targets.get(a)!.cost - targets.get(b)!.cost || a - b);
    for (const t of todo) {
      if (tryCapture(t, `advances bonus ${bonusName(p.bonusId)} (+${p.value}, ${p.cost} to finish)`))
        anchor ??= moves[moves.length - 1]!.from;
    }
  };

  if (balanced) {
    // ---- balanced: greedy by income per army ----
    const opponents = Math.max(
      1,
      Math.floor(
        opts.opponents ??
          new Set(
            board.territories.flatMap((t) =>
              t.owner.kind === 'player' && t.owner.playerId !== me ? [t.owner.playerId] : [],
            ),
          ).size,
      ),
    );
    const weight = BREAK_WEIGHT / opponents;
    // Enemy armies that could hit `t` next turn once it is mine (its own armies excluded).
    const counterThreat = (t: number) => {
      const byPlayer = new Map<number, number>();
      for (const n of neighborsOf(g, t)) {
        const st = state.get(n);
        if (st?.owner.kind !== 'player' || st.owner.playerId === me || st.armies === null) continue;
        byPlayer.set(st.owner.playerId, (byPlayer.get(st.owner.playerId) ?? 0) + Math.max(0, st.armies - guard));
      }
      return Math.max(0, ...byPlayer.values()) + enemyDeploy;
    };
    interface Candidate {
      kind: 'hold' | 'complete' | 'advance' | 'break';
      score: number;
      cost: number;
      id: number;
      value: number;
      focus: boolean;
      /** External borders of the bonus (fewer is easier to keep); 0 for holds. */
      borders: number;
      run: () => void;
    }
    const rank = { hold: 0, complete: 1, advance: 2, break: 3 } as const;
    const candidates: Candidate[] = [];
    const deferred: Threatened[] = [];
    let expansionLeft = 0;
    let expansionSpent = 0;
    let topValue = 0;
    const spend = (f: () => void) => () => {
      const before = budget;
      f();
      expansionSpent += before - budget;
      expansionLeft--;
    };
    for (const p of plans) {
      const score = ratio(p);
      if (p.completable)
        candidates.push({ kind: 'complete', score, cost: p.cost, id: p.bonusId, value: p.value, focus: p.focus, borders: p.borders, run: spend(() => complete(p)) });
      candidates.push({ kind: 'advance', score, cost: p.cost, id: p.bonusId, value: p.value, focus: p.focus, borders: p.borders, run: spend(() => advance(p)) });
    }
    // Capturing a member of a breakable bonus: what survives it, and whether that holds next turn.
    const breakOption = (t: number) => {
      const cost = targets.get(t)!.cost;
      const survivors = cost - Math.round((armiesOf(t) * rates.defensiveKillRate) / 100);
      const counter = counterThreat(t);
      const take = armiesToTake(survivors, rates);
      return { t, cost, survivors, counter, take, survives: take === null || take > counter };
    };
    type BreakOption = ReturnType<typeof breakOption>;
    const broken = (b: Breakable) => bonusTerritories(g, b.bonusId).some((x) => captured.has(x));
    const breakReason = (b: Breakable) =>
      `breaks enemy bonus ${bonusName(b.bonusId)} (+${b.value} from player ${b.player})`;
    const warnRetake = (b: Breakable, o: BreakOption) => {
      if (!o.survives)
        warnings.push(
          `${label(o.t)} can be retaken after it breaks ${bonusName(b.bonusId)}: ${o.survivors} survivors need ${o.take} to take, against ~${o.counter} next turn.`,
        );
    };
    const breakOf = new Map<number, Breakable>();
    for (const b of breakable) for (const t of bonusTerritories(g, b.bonusId)) breakOf.set(t, b);
    // A threatened border whose only visible threat is a member of a breakable enemy
    // bonus also attacks it: the capture removes the threat and breaks the bonus. It
    // attacks on top of its hold, never instead of it: the threat assumes the enemy
    // reinforces that member first, so the capture can fail, and what stays on the
    // border must still hold. When the hold plus the capture is unaffordable, it just
    // holds. (A held border otherwise makes no attacks.)
    const holdAndBreak = (t: Threatened): boolean => {
      const threats = neighborsOf(g, t.id).filter((n) => {
        const st = state.get(n);
        return st?.owner.kind === 'player' && st.owner.playerId !== me && st.armies !== null;
      });
      if (threats.length !== 1) return false;
      const n = threats[0]!;
      const b = breakOf.get(n);
      if (!b || !targets.has(n) || broken(b)) return false;
      const o = breakOption(n);
      if (t.holdCost + o.cost > budget - reserve) return false;
      const before = budget;
      deploy(t.id, t.holdCost);
      tryCapture(n, breakReason(b), { from: t.id, keep: avail.get(t.id)! });
      expansionSpent += before - budget - t.holdCost;
      anchor ??= moves[moves.length - 1]!.from;
      rationale.push(
        `${label(n)} is the only visible threat to ${label(t.id)}: capturing it removes that threat and breaks the bonus.`,
        `Deploy ${t.holdCost} to ${label(t.id)} so it still holds (protects +${t.value}) after attacking ${label(n)}: ${t.have + t.holdCost} armies stay, needing ${armiesToTake(t.have + t.holdCost, rates)} to take, above the ~${t.threat} threat if the attack fails.`,
      );
      warnRetake(b, o);
      return true;
    };
    for (const b of breakable) {
      const options = bonusTerritories(g, b.bonusId)
        .filter((t) => targets.has(t))
        .map(breakOption)
        .sort((a, b) => Number(b.survives) - Number(a.survives) || a.cost - b.cost || a.t - b.t);
      const o = options[0];
      if (!o) continue;
      candidates.push({
        kind: 'break',
        score: (weight * b.value) / Math.max(1, o.cost),
        cost: o.cost,
        id: b.bonusId,
        value: b.value,
        focus: false,
        borders: analyzeBonus(g, b.bonusId)!.borderTerritoryIds.length,
        run: spend(() => {
          // Already broken (by a border attacking its only threat): one capture is enough.
          if (broken(b)) return;
          if (!tryCapture(o.t, breakReason(b))) return;
          anchor ??= moves[moves.length - 1]!.from;
          warnRetake(b, o);
        }),
      });
    }
    expansionLeft = candidates.length;
    topValue = Math.max(0, ...candidates.map((c) => c.value));
    const floor = expansionLeft ? Math.ceil(MIN_EXPANSION_SHARE * income) : 0;
    for (const t of holds)
      candidates.push({
        kind: 'hold',
        score: t.worth / t.holdCost,
        cost: t.holdCost,
        id: t.id,
        value: t.value,
        focus: false,
        borders: 0,
        run: () => {
          if (holdAndBreak(t)) return;
          const pending = expansionLeft > 0 && t.worth < topValue ? Math.max(0, floor - expansionSpent) : 0;
          if (t.holdCost > budget) return concedeUnaffordable(t, budget);
          if (t.holdCost > budget - pending) {
            deferred.push(t);
            rationale.push(
              `Hold ${label(t.id)} later (needs ${t.holdCost}, protects +${t.value}): at least ${floor} of income (${MIN_EXPANSION_SHARE * 100}%) goes to expansion first, worth up to +${topValue}.`,
            );
            return;
          }
          hold(t);
        },
      });
    candidates.sort(
      (a, b) =>
        Number(b.focus) - Number(a.focus) ||
        b.score - a.score ||
        a.cost - b.cost ||
        a.borders - b.borders ||
        rank[a.kind] - rank[b.kind] ||
        a.id - b.id,
    );
    for (const c of candidates) c.run();
    for (const t of deferred) {
      if (t.holdCost > budget) concedeUnaffordable(t, budget);
      else hold(t);
    }
    withdraw();
  } else {
    for (const p of plans) complete(p);
    for (const p of plans) advance(p);
  }

  // ---- pass 3: other expansion ----
  if (goal !== 'complete-bonus') {
    const rest = [...targets.values()]
      .filter(
        (t) =>
          !captured.has(t.id) &&
          !(balanced && t.enemy) &&
          (economicMember.has(t.id) || !uneconomicMember.has(t.id)),
      )
      .sort((a, b) => a.cost - b.cost || a.id - b.id);
    for (const t of rest) tryCapture(t.id, 'expands territory');
  }

  // ---- leftover deploy ----
  if (budget > 0) {
    const open = (id: number) => !conceded.has(id);
    const foggedNext = (id: number) =>
      neighborsOf(g, id).filter((n) => {
        const st = state.get(n);
        return !captured.has(n) && (!st || st.owner.kind === 'unknown' || st.armies === null);
      }).length;
    // Armies that stay on a border after its deploys, outgoing moves and incoming withdrawals.
    const stays = (id: number) => avail.get(id)! + guard + (incoming.get(id) ?? 0);
    const short = [...borders.values()]
      .filter((b) => open(b.id))
      .map((b) => ({ ...b, take: armiesToTake(stays(b.id), rates) }))
      .filter((b) => b.take !== null && b.take <= COMFORT_MARGIN * b.threat)
      .sort((a, b) => valueOf(b.id) - valueOf(a.id) || a.take! / a.threat - b.take! / b.threat || a.id - b.id);
    const expansion = anchor ?? moves.find((m) => m.kind === 'attack')?.from;
    const fogged = [...mine].filter(open).sort((a, b) => foggedNext(b) - foggedNext(a) || a - b).find((id) => foggedNext(id) > 0);
    const biggest = (ids: number[]) =>
      [...ids].sort((a, b) => armiesOf(b) + (deployed.get(b) ?? 0) - (armiesOf(a) + (deployed.get(a) ?? 0)) || a - b)[0];
    let where: number;
    let why: string;
    if (short[0]) {
      where = short[0].id;
      why = `the held border with the most at stake (protects +${valueOf(where)}), still short of a comfortable margin over the ~${short[0].threat} threat`;
    } else if (expansion !== undefined && open(expansion)) {
      where = expansion;
      why = 'the stack working on the top expansion';
      // Keep it there: the transfer step must not walk it back as "idle interior" armies.
      locked.add(where);
    } else if (fogged !== undefined) {
      where = fogged;
      why = 'the border with the most fogged neighbours';
    } else {
      const b = biggest(mine.filter(open));
      if (b !== undefined) {
        where = b;
        why = 'my biggest stack';
      } else {
        where = biggest(mine)!;
        why = 'my biggest stack';
        warnings.push(`Every territory I hold is conceded; the leftover ${budget} goes to ${label(where)} anyway.`);
      }
    }
    rationale.push(`Deploy the leftover ${budget} to ${label(where)}: ${why}.`);
    deploy(where, budget);
  }

  // ---- transfers ----
  if (s.allowTransferOnly ?? true) {
    const held = new Set([...mine, ...captured]);
    // A conceded border is not "the front": the plan gives it up, so armies never
    // flow into it and distances are not measured through it.
    const front = [...g.territoryById.keys()].filter((id) => !held.has(id));
    const dist = bfsDistances(g, front, { passable: (id) => held.has(id) && !conceded.has(id) });
    for (const t of mine) {
      const n = avail.get(t)!;
      if (n <= 0 || locked.has(t)) continue;
      const d = dist.get(t);
      if (d === undefined || d <= 1) continue;
      // Only into a territory held at the start of the turn: a planned capture is
      // not mine yet, and a "transfer" into it would execute as an attack.
      const step = neighborsOf(g, t)
        .filter((x) => mineSet.has(x) && !conceded.has(x) && (dist.get(x) ?? Infinity) < d)
        .sort((a, b) => dist.get(a)! - dist.get(b)! || a - b)[0];
      if (step === undefined) continue;
      avail.set(t, 0);
      const reason = 'moves idle interior armies toward the front';
      moves.push({ from: t, to: step, armies: n, kind: 'transfer', reason });
      rationale.push(`Transfer ${n} from ${label(t)} to ${label(step)}: ${reason}.`);
    }
  }

  // ---- expected ----
  const after = new Set([...mine, ...captured]);
  const completed = g.map.bonuses
    .filter((b) => {
      const ts = bonusTerritories(g, b.id);
      return ts.length > 0 && ts.every((t) => after.has(t)) && !ts.every((t) => mineSet.has(t));
    })
    .map((b) => b.id)
    .sort(byNum);
  const gained = completed.reduce((sum, id) => sum + g.bonusById.get(id)!.value, 0);

  return {
    deploys: [...deployed]
      .filter(([, n]) => n > 0)
      .sort((a, b) => a[0] - b[0])
      .map(([territoryId, armies]) => ({ territoryId, armies })),
    moves,
    expected: { captures: [...captured].sort(byNum), bonusesCompleted: completed, nextIncome: income + gained },
    warnings,
    rationale,
    enemyDeploy,
    conceded: [...conceded].sort(byNum),
    cardAdvice,
  };
}
