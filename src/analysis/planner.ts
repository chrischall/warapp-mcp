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
//  1a. Triage (every goal). Each threatened border's protected value is the sum
//     of my complete bonuses containing it, plus incomplete bonuses containing it
//     that I would lose all access to without it, plus the per-territory
//     income it carries (each bonus counted once). Its hold cost is the fewest
//     deploys making `armiesToTake(armies + d) > threat`. Borders are taken in
//     order of protected value per army of hold cost (ties: lower hold cost, then
//     id); a border is conceded when its hold cost exceeds the budget left or
//     CONCEDE_FACTOR × its protected value (so a border protecting nothing is
//     conceded). Under `goal: 'defend'` the plan deploys each hold, and a held
//     border then makes no moves.
//     Scope of "protected value", deliberately narrow: only bonuses containing T
//     count (not a bonus T merely borders), and an incomplete one counts in full
//     when T is my only foothold, however much of it the enemy holds. So with no
//     complete bonus and no per-territory income (`bonusArmyPer` off), a threatened
//     border protects +0 and is conceded: early in a game `defend` holds nothing
//     and withdraws from every threatened border, keeping armies for expansion.
//     Under other goals a conceded border is only kept out of the leftover deploy:
//     it may still attack out (and get that capture's shortfall deployed), since its
//     armies are lost anyway if they stay.
//  1b. Withdraw (under `defend`). A conceded border's movable armies move first
//     to the adjacent territory of mine nearest a border that holds (then the
//     one protecting the most value, then id); the plan advises Order Priority
//     (`cardAdvice`), because a withdrawal only executes while the border is mine.
//  2. Targets: visible neutrals adjacent to a territory I held at the start of
//     the turn (plus visible enemy territories under `goal: 'complete-bonus'` —
//     deliberately not under `expand`/`defend`: attacking a player is a choice the
//     caller makes, never a default). Fogged or unknown neighbours are never
//     attacked — they produce a warning.
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
//     (not under `complete-bonus`) takes any other affordable target.
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

export type PlanGoal = 'expand' | 'complete-bonus' | 'defend';

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
  /** Default `expand`. */
  goal?: PlanGoal;
  /** Bonuses to work on first, even when uneconomic. */
  focusBonusIds?: number[];
  /** Income held back from captures (still deployed, as leftover). */
  reserve?: number;
  /** Assumed enemy deploy next turn when judging threats (default {@link defaultEnemyDeploy}). */
  enemyDeploy?: number;
}

export interface PlanInput {
  graph: MapGraph;
  board: BoardState;
  /** My player id. */
  me: number;
  /** Armies to deploy this turn (see {@link incomeFor}). */
  income: number;
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
  const goal: PlanGoal = opts.goal ?? 'expand';
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

  // ---- 1. defence ----
  interface Border {
    id: number;
    player: number;
    movable: number;
    threat: number;
  }
  const borders = new Map<number, Border>();
  for (const t of mine) {
    const byPlayer = new Map<number, number>();
    for (const n of neighborsOf(g, t)) {
      const st = state.get(n);
      if (st?.owner.kind !== 'player' || st.owner.playerId === me || st.armies === null) continue;
      byPlayer.set(st.owner.playerId, (byPlayer.get(st.owner.playerId) ?? 0) + Math.max(0, st.armies - guard));
    }
    if (!byPlayer.size) continue;
    const [player, movable] = [...byPlayer].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]!;
    borders.set(t, { id: t, player, movable, threat: movable + enemyDeploy });
  }
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
  }
  const threatened: Threatened[] = [];
  for (const b of borders.values()) {
    const have = armiesOf(b.id);
    const take = armiesToTake(have, rates);
    if (take === null || take > b.threat) continue;
    warnings.push(
      `${label(b.id)} (${have} armies) could be taken next turn: player ${b.player} has ${b.movable} movable armies next to it plus ~${enemyDeploy} deploy, and ${take} would do.`,
    );
    // armiesToTake grows at least one army per ~(100 / offensive kill rate) defenders, so this ends.
    let d = 1;
    while ((armiesToTake(have + d, rates) ?? Infinity) <= b.threat) d++;
    threatened.push({ id: b.id, have, threat: b.threat, holdCost: d, value: valueOf(b.id) });
  }
  threatened.sort(
    (a, b) => b.value / b.holdCost - a.value / a.holdCost || a.holdCost - b.holdCost || a.id - b.id,
  );

  const acting = goal === 'defend';
  const conceded = new Set<number>();
  let triageBudget = budget;
  for (const t of threatened) {
    const left = acting ? budget : triageBudget;
    if (t.holdCost > CONCEDE_FACTOR * t.value) {
      conceded.add(t.id);
      warnings.push(`${label(t.id)} cannot be held economically (needs ${t.holdCost}, protects +${t.value}): conceded`);
      continue;
    }
    if (t.holdCost > left) {
      conceded.add(t.id);
      warnings.push(
        `${label(t.id)} cannot be held with the ${left} armies left to deploy (needs ${t.holdCost}, protects +${t.value}): conceded`,
      );
      continue;
    }
    triageBudget -= t.holdCost;
    if (!acting) continue;
    deploy(t.id, t.holdCost);
    locked.add(t.id);
    rationale.push(
      `Deploy ${t.holdCost} to ${label(t.id)} so it holds (protects +${t.value}): ${t.have + t.holdCost} armies need ${armiesToTake(t.have + t.holdCost, rates)} to take, above the ~${t.threat} threat.`,
    );
  }

  // ---- 1b. withdraw from conceded borders ----
  let cardAdvice: CardAdvice | null = null;
  // Armies withdrawn into each territory this turn (they stay there: armies never move twice).
  const incoming = new Map<number, number>();
  if (acting && conceded.size) {
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
      moves.push({ from: t, to: to.id, armies: n, kind: 'transfer', reason });
      incoming.set(to.id, (incoming.get(to.id) ?? 0) + n);
      rationale.push(`Withdraw ${n} from ${label(t)} to ${label(to.id)}: ${reason}, toward a border that holds.`);
      warnings.push(
        `The withdrawal from ${label(t)} only executes if ${label(t)} is still mine when the order runs; play Order Priority so it goes first.`,
      );
      cardAdvice = 'order-priority';
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
    if (enemy && goal !== 'complete-bonus') continue;
    const cost = captureCost(st.armies, s);
    if (cost === null) continue;
    targets.set(t, { id: t, cost, enemy, sources });
  }

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
    if (!remaining.some((t) => targets.has(t))) continue;
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
      completable: remaining.every((t) => targets.has(t)),
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
  const tryCapture = (t: number, reason: string): boolean => {
    const tg = targets.get(t)!;
    const sources = tg.sources
      .filter((x) => !locked.has(x))
      .sort((a, b) => avail.get(b)! - avail.get(a)! || a - b);
    const src = sources[0];
    if (src === undefined) return false;
    const need = Math.max(0, tg.cost - avail.get(src)!);
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

  // ---- pass 1: complete bonuses this turn (all or nothing) ----
  for (const p of plans) {
    if (!p.completable) continue;
    const todo = p.remaining
      .filter((t) => !captured.has(t))
      .sort((a, b) => targets.get(a)!.cost - targets.get(b)!.cost || a - b);
    if (!todo.length) continue;
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
      continue;
    }
    budget = snap.budget;
    deployed.clear();
    for (const [k, v] of snap.deployed) deployed.set(k, v);
    for (const [k, v] of snap.avail) avail.set(k, v);
    for (const m of moves.splice(snap.moves)) captured.delete(m.to);
    rationale.length = snap.rationale;
    warnings.length = snap.warnings;
  }

  // ---- pass 2: advance bonuses ----
  for (const p of plans) {
    const todo = p.remaining
      .filter((t) => targets.has(t) && !captured.has(t))
      .sort((a, b) => targets.get(a)!.cost - targets.get(b)!.cost || a - b);
    for (const t of todo) {
      if (tryCapture(t, `advances bonus ${bonusName(p.bonusId)} (+${p.value}, ${p.cost} to finish)`))
        anchor ??= moves[moves.length - 1]!.from;
    }
  }

  // ---- pass 3: other expansion ----
  if (goal !== 'complete-bonus') {
    const rest = [...targets.values()]
      .filter((t) => !captured.has(t.id) && (economicMember.has(t.id) || !uneconomicMember.has(t.id)))
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
