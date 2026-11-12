// Turn planner: deploys and moves for one turn, from one player's view of a
// board. Pure and deterministic (every choice tie-breaks on ascending id); no
// I/O. Advisory only — it never submits orders.
//
// Rules, in decision order:
//  1. Defence. A visible enemy next to my territory T threatens it when
//     `armiesToTake(armies(T)) ≤ E + enemyDeploy`, where E is that player's
//     movable armies (minus the guard) summed over its territories bordering T.
//     enemyDeploy is estimated per opponent (`enemyDeployEstimates`): base
//     income (the larger of MinimumArmyBonus and, with BonusArmyPer on, its
//     visible territories / BonusArmyPer) plus the bonuses that player
//     visibly holds in full, clamped below by max(MIN_ENEMY_DEPLOY, base
//     income) and above by round(ENEMY_STACK_SHARE × its largest
//     stack next to me) — a big stack implies it *can* move a lot, never that
//     its income is big (live, a 0.75 × 15 guess on an all-15 opening board made
//     every base-income opponent look like ~11). On the opening board (every
//     visible territory still holds the same count) every opponent gets the
//     floor. `options.enemyDeploy` overrides all of them. Always a warning.
//  1t. Trend. Given `previousBoard` (my view one turn earlier), each visible
//     enemy territory next to me that was visible then under the same owner and
//     has grown is "building" at growth = armies now − armies then per turn (a
//     warning naming my most exposed neighbour and the armies it needs to hold
//     next turn and the turn after). A border's threat becomes movable +
//     max(enemyDeploy, the owner's fastest growth next to it), so its hold cost
//     and the leftover margin both use the projection (a rationale line says so).
//  1e. Finish off (under `balanced` and `defend`, before triage; issue #45). For
//     each visible opponent whose every territory is visible (none borders the fog)
//     and borders mine — fewest territories, then fewest armies, then id — plan
//     "attack every one of its territories this turn", each target assumed to hold
//     its armies plus that opponent's full deploy estimate (the worst case), with the
//     usual capture rules (single and combined attacks, kill rates, luck margin, R3).
//     A softener in a combined capture never kills the defenders there now either.
//     Every opponent in reach is tried, not only weak ones (the worst case sizes it).
//     Holds against other players that pass rule 1a's CONCEDE_FACTOR test come first:
//     a source keeps what holds it there, and the deploys a hold on any other border
//     needs are reserved out of the budget (in triage order) while the captures are
//     sized. Kept when it eliminates the opponent, or takes most (over half) of its
//     territories with no attacking border facing the rest; else rolled back (a kept
//     pressure plan leaves the untaken territories as they were). An opponent bordering
//     the fog is never attempted (a warning says so when its visible territories could
//     all fall); with fog anywhere else, the elimination is hedged ("if it holds nothing
//     in the fog") and a warning says it may hold unseen territories. Borders next to
//     the captures are then re-judged without them, and triage judges each border by
//     the armies that stay on it. A border held last turn (per `previousBoard`) by a
//     weak opponent (fully visible, fewer territories than mine, deploy below my
//     income) that threatens it now is never conceded economically; under `balanced`
//     its hold goes first.
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
//     complete bonus and no per-territory income (`bonusArmyPer` off, or its
//     armies still below the base income they replace), a threatened
//     border protects +0 and is conceded: early in a game `defend` holds nothing
//     and withdraws from every threatened border, keeping armies for expansion.
//     A conceded border is never deployed to (unless every territory I hold is
//     conceded): it may still attack out with the armies already on it, since they
//     are lost anyway if they stay, but no capture is funded there.
//     Under `balanced` a hold is not deployed here: it competes in the greedy
//     step (rule 4a), and a threatened border it might hold makes no attacks.
//  1c. Reconsider (every goal, after the capture passes). Triage runs before
//     captures are known, so a border in a bonus this turn's captures complete
//     protected +0 and was conceded. Protected value is then re-judged against my
//     holdings plus this turn's captures: a conceded border in a bonus completed
//     this turn is kept (its concession warning dropped, a rationale line added),
//     never withdrawn from, and garrisoned from the leftover (rule 5); a warning
//     says so when the leftover still cannot make it hold.
//  1b. Withdraw (under `defend` and `balanced`, after 1c). A conceded border's movable armies move first
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
//  3a. Combined (multi-source) captures (R4). When no single source can afford a
//     target (its movable armies plus the deploys left), two or more of my
//     sources held at the start of the turn (not locked, not conceded) attack it
//     in sequence: sources by most movable armies, then id; the first is the
//     finisher, the others ("softeners", in id order) each attack first with their
//     movable armies (capped so they never kill the last defender), killing
//     round(off × armies) defenders each, cumulatively; their survivors stay home.
//     The finisher then sends armiesToTake(defenders left), deploying its
//     shortfall. Fewest sources first. Exact only under straight rounding at 0%
//     luck: otherwise it is skipped with a warning. It is a fallback inside every
//     pass, so it only ever takes a target the passes already chose (economic by
//     the same scoring), and only when no single source suffices. The plan lists
//     such targets in `multiSourceCaptures`.
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
//  4b. Defensibility (R3). A capture that completes a bonus is checked against the
//     frontier it leaves: each member a visible enemy could take next turn (threat as
//     in rule 1, armies staying after this turn's moves; a fresh capture holds its
//     attack's survivors) needs holdArmies(threat) − armies more. When the total
//     exceeds my next income (plus this turn's leftover, for members I held at the
//     start) the bonus would fall at once: under `balanced`/`defend` the capture is
//     refused (warning "… indefensible …: not completed"); under `expand` and
//     `complete-bonus` it is made with a warning. Under `balanced`/`defend` a bonus's
//     score is value / (capture cost + DEFENSE_DISCOUNT × that defence cost).
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
// Local Deployment (`localDeployments`): a held bonus's value is a pool deployable
// only on that bonus's territories (a superbonus's on all of its territories, beside
// its member bonuses' pools); the rest of the income (base, per-territory, card
// armies) may go anywhere. Every affordability check above uses the armies
// deployable at that territory; leftover bonus pools are still deployed inside their
// bonus, on its most threatened member (not conceded first; ties by id). A rationale
// line names each pool. Off (the default), plans are unchanged.
// No-Split (`noSplit`): a territory issues at most one order (attack or transfer)
// this turn. Orders are planned in decision order, so a territory's first order is
// its best by the scoring above; any later attack, withdrawal or transfer from it is
// not planned (a warning names it), and another source may take that target instead.
// Combined captures (rule 3a) use only sources with no order yet: each still issues
// one. The planned armies are kept (not forced all-in; whether No-Split also requires
// all movable armies is unverified). Off (the default), plans are unchanged.
// Kill rates: every combat computation above (capture cost, threats and holds,
// survivors, R3's frontier, R4's kills) uses the game's offensive/defensive kill
// rates; only when the settings carry none does it assume 60/70, with a warning.
// Every combination of these rules is planned and then checked by
// warapp_submit_turn's validator (`validateTurn`) in the lessons suite: the planner
// never proposes a turn the validator refuses.
// Accounting: a territory's outgoing armies never exceed its armies after deploy
// minus the guard. Armies never move twice and captured armies never attack, so
// the plan is valid with or without multi-attack.

import type { BoardState, TerritoryState } from '../board.js';
import type { GameSettings } from '../normalize.js';
import { analyzeBonus, bonusTerritories } from './bonuses.js';
import { armiesToTake, DEFAULT_DEFENSIVE_KILL_RATE, DEFAULT_OFFENSIVE_KILL_RATE } from './combat.js';
import { bfsDistances, neighborsOf, type MapGraph } from './graph.js';
import { chargeDeploys, deployPools } from './local-deploy.js';
import { analyzePlayer, DEFAULT_BASE_INCOME, territoryIncome } from './player.js';

/** A bonus is uneconomic when its remaining capture cost exceeds this many turns of its value… */
export const PAYBACK_TURNS = 10;
/** …or when one remaining territory alone costs more than this many times its value (a wasteland). */
export const WASTELAND_FACTOR = 5;
/** Floor of the default enemy deploy estimate (a player's base income). */
export const MIN_ENEMY_DEPLOY = DEFAULT_BASE_INCOME;
/** The default estimate is capped at this share of the opponent's largest stack next to me. */
export const ENEMY_STACK_SHARE = 0.75;
/** A border is conceded when holding it costs more than this many times the income it protects. */
export const CONCEDE_FACTOR = 3;
/** A held border is comfortable once taking it needs more than this many times its threat. */
export const COMFORT_MARGIN = 1.25;

/** Denying +V to the opponent is worth this many times gaining +V yourself (per opponent: divided among them). */
export const BREAK_WEIGHT = 1.0;
/** Under `balanced`, at least this share of income goes to expansion/breaking before holds protecting less than it. */
export const MIN_EXPANSION_SHARE = 0.3;
/**
 * Under `balanced`/`defend` a bonus's score is value / (capture cost + this × the
 * deploys its frontier needs next turn to hold), so a defensible smaller bonus can
 * beat an indefensible big one.
 */
export const DEFENSE_DISCOUNT = 1;

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
  /** Every player's base income (the game's MinimumArmyBonus; default {@link DEFAULT_BASE_INCOME}). */
  baseIncome?: number;
  /** Local Deployment: a held bonus's armies are deployed only inside that bonus. Default `false`. */
  localDeployments?: boolean;
  /** No-Split: a territory issues at most one attack or transfer this turn. Default `false`. */
  noSplit?: boolean;
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
  /**
   * The enemy deploy the threat checks assumed: the caller's override, else the
   * largest per-opponent estimate among the players next to me (at least
   * {@link MIN_ENEMY_DEPLOY}).
   */
  enemyDeploy: number;
  /** Threatened borders not worth (or not affordable) holding this turn, sorted. */
  conceded: number[];
  /** `'order-priority'` when a withdrawal is planned (it must run before the border falls). */
  cardAdvice: CardAdvice | null;
  /**
   * Captures made by a combined (multi-source) attack sequence (rule 3a), sorted:
   * their attacks must run in the planned order, and only at 0% luck.
   */
  multiSourceCaptures: number[];
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

/** One visible opponent's estimated deploy next turn and how it was reached. */
export interface EnemyDeployEstimate {
  playerId: number;
  /** clamp(base + bonusIncome, max(MIN_ENEMY_DEPLOY, base), stackCap); that floor on the opening board. */
  estimate: number;
  /**
   * Its base income: MinimumArmyBonus, or (BonusArmyPer on) its visible
   * territories / BonusArmyPer when larger.
   */
  base: number;
  /** Value of the bonuses this player visibly holds in full. */
  bonusIncome: number;
  /** Its largest visible stack next to one of my territories (else its largest visible stack). */
  largestStack: number;
  /** round(ENEMY_STACK_SHARE × largestStack). */
  stackCap: number;
  /** Every visible territory holds the same army count: no one has deployed yet. */
  opening: boolean;
}

/** The army count every visible territory holds, when they all hold the same one (the initial allotment). */
function openingArmies(g: MapGraph, board: BoardState): number | null {
  const counts = new Set<number>();
  for (const t of board.territories)
    if (g.territoryById.has(t.territoryId) && t.armies !== null && t.owner.kind !== 'unknown') counts.add(t.armies);
  return counts.size === 1 ? [...counts][0]! : null;
}

/**
 * Per-opponent enemy deploy estimates, one per visible enemy player (sorted by
 * id): base income plus the bonuses that player visibly holds in full, clamped
 * below by max({@link MIN_ENEMY_DEPLOY}, base income) — the floor wins over the cap — and above by round({@link ENEMY_STACK_SHARE}
 * × its largest stack next to me). Bonuses in the fog are unseen, so this is
 * what the visible board supports. On the opening board (every visible
 * territory holds the same count) every opponent gets the floor.
 */
export function enemyDeployEstimates(
  g: MapGraph,
  board: BoardState,
  me: number,
  settings: PlannerSettings = {},
): EnemyDeployEstimate[] {
  const owner = new Map<number, number>();
  const armies = new Map<number, number>();
  for (const t of board.territories) {
    if (!g.territoryById.has(t.territoryId) || t.owner.kind !== 'player' || t.armies === null) continue;
    owner.set(t.territoryId, t.owner.playerId);
    armies.set(t.territoryId, t.armies);
  }
  const players = [...new Set([...owner.values()].filter((p) => p !== me))].sort(byNum);
  const opening = openingArmies(g, board) !== null;
  const minimum = Math.max(0, Math.floor(settings.baseIncome ?? DEFAULT_BASE_INCOME));
  const per = settings.bonusArmyPer ?? 0;
  return players.map((playerId) => {
    // Its visible territories are a lower bound on what it holds, so on its
    // per-territory income too.
    let held = 0;
    for (const p of owner.values()) if (p === playerId) held++;
    const base = territoryIncome(held, minimum, per);
    let bonusIncome = 0;
    for (const b of g.map.bonuses) {
      const ts = bonusTerritories(g, b.id);
      if (ts.length && ts.every((t) => owner.get(t) === playerId)) bonusIncome += b.value;
    }
    let adjacent = 0;
    let any = 0;
    for (const [t, p] of owner) {
      if (p !== playerId) continue;
      const a = armies.get(t)!;
      any = Math.max(any, a);
      if (neighborsOf(g, t).some((n) => owner.get(n) === me)) adjacent = Math.max(adjacent, a);
    }
    const largestStack = adjacent || any;
    const stackCap = Math.round(ENEMY_STACK_SHARE * largestStack);
    // Every opponent earns at least the game's base income (never below the 5 minimum).
    const floor = Math.max(MIN_ENEMY_DEPLOY, base);
    const estimate = opening ? floor : Math.max(floor, Math.min(base + bonusIncome, stackCap));
    return { playerId, estimate, base, bonusIncome, largestStack, stackCap, opening };
  });
}

/**
 * Default enemy deploy: the largest {@link enemyDeployEstimates} figure among the
 * players with a visible stack next to me, at least {@link MIN_ENEMY_DEPLOY}.
 */
export function defaultEnemyDeploy(
  g: MapGraph,
  board: BoardState,
  me: number,
  settings: PlannerSettings = {},
): number {
  const mineIds = new Set(
    board.territories.flatMap((t) => (t.owner.kind === 'player' && t.owner.playerId === me ? [t.territoryId] : [])),
  );
  const next = new Set<number>();
  for (const t of board.territories) {
    if (t.owner.kind !== 'player' || t.owner.playerId === me || t.armies === null) continue;
    if (!g.territoryById.has(t.territoryId)) continue;
    if (neighborsOf(g, t.territoryId).some((n) => mineIds.has(n))) next.add(t.owner.playerId);
  }
  return enemyDeployEstimates(g, board, me, settings).reduce(
    (m, e) => (next.has(e.playerId) ? Math.max(m, e.estimate) : m),
    MIN_ENEMY_DEPLOY,
  );
}

/** This turn's income from the existing income code (max(base, per-territory) + held bonuses). */
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
  /** Deploys its frontier needs next turn to hold once completed (0 when not judged). */
  defenseCost: number;
}

export function planTurn(input: PlanInput): TurnPlan {
  const { graph: g, board, me } = input;
  const s = input.settings ?? {};
  const baseIncome = Math.max(0, Math.floor(s.baseIncome ?? DEFAULT_BASE_INCOME));
  const opts = input.options ?? {};
  const goal: PlanGoal = opts.goal ?? 'balanced';
  const balanced = goal === 'balanced';
  /** Goals that refuse to complete a bonus they cannot hold (R3); the others only warn. */
  const guarded = balanced || goal === 'defend';
  const focus = new Set(opts.focusBonusIds ?? []);
  const income = Math.max(0, Math.floor(input.income));
  const reserve = Math.min(income, Math.max(0, Math.floor(opts.reserve ?? 0)));
  const custom = opts.enemyDeploy !== undefined;
  const enemyDeploy = custom ? Math.max(0, Math.floor(opts.enemyDeploy!)) : defaultEnemyDeploy(g, board, me, s);
  const estimates = new Map(enemyDeployEstimates(g, board, me, s).map((e) => [e.playerId, e]));
  /** The deploy assumed for one opponent's threat: the override, else its own estimate. */
  const deployOf = (player: number) => (custom ? enemyDeploy : (estimates.get(player)?.estimate ?? MIN_ENEMY_DEPLOY));
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
  if (s.offensiveKillRate === undefined || s.defensiveKillRate === undefined)
    warnings.push(
      `Kill rates missing from the game settings; assuming ${rates.offensiveKillRate}% offense, ${rates.defensiveKillRate}% defense.`,
    );
  if (s.roundingMode !== undefined && s.roundingMode !== 'StraightRound')
    warnings.push(`Capture costs assume straight rounding; this game uses ${s.roundingMode}.`);
  if (s.multiAttack)
    rationale.push('Multi-attack is on, but the plan does not chain attacks from captured territories.');
  const noSplit = s.noSplit === true;
  if (noSplit) {
    rationale.push(
      'No-Split: each territory issues at most one attack or transfer this turn; a territory that would split keeps its first (best) order.',
    );
  }

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
      multiSourceCaptures: [],
    };
  }

  // ---- mutable plan state ----
  let budget = income;
  const deployed = new Map<number, number>();
  // May start at −1 (a 0-army territory still owes its guard): deploys there pay for it first.
  const avail = new Map(mine.map((id) => [id, armiesOf(id) - guard]));
  const locked = new Set<number>();
  const captured = new Set<number>();
  /** Targets taken by a combined (multi-source) capture. */
  const combined = new Set<number>();
  const moves: PlannedMove[] = [];
  /** Armies that occupy each capture this turn (its finishing attack's survivors). */
  const survivorsAt = new Map<number, number>();
  /** Under No-Split, the order `x` already issues (its only one); otherwise always `undefined`. */
  const orderOf = (x: number): PlannedMove | undefined => (noSplit ? moves.find((m) => m.from === x) : undefined);
  const describeOrder = (m: PlannedMove) =>
    m.kind === 'attack' ? `attacks ${label(m.to)}` : `transfers to ${label(m.to)}`;
  /** A No-Split warning: `x` already issues an order, so `what` is not planned. Never repeated. */
  const warnSplit = (x: number, what: string) => {
    const w = `No-Split: ${label(x)} already ${describeOrder(orderOf(x)!)}, so ${what} (one attack or transfer per territory).`;
    if (!warnings.includes(w)) warnings.push(w);
  };
  const deploy = (id: number, n: number) => {
    if (n <= 0) return;
    deployed.set(id, (deployed.get(id) ?? 0) + n);
    avail.set(id, avail.get(id)! + n);
    budget -= n;
  };

  // ---- Local Deployment pools ----
  const pools = s.localDeployments ? deployPools(g, mineSet, income) : null;
  const local = pools !== null && pools.bonuses.length > 0;
  /** Armies that may still be deployed on `id` (pools respected; with Local Deployment off, the budget). */
  const roomAt = (id: number): number => {
    if (!local || budget <= 0) return budget;
    const fits = (n: number) => {
      const next = new Map(deployed);
      next.set(id, (next.get(id) ?? 0) + n);
      return chargeDeploys(pools, next).anywhereUsed <= pools.anywhere;
    };
    let lo = 0;
    let hi = budget;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  /** Armies a capture may still deploy on `id`: its room, less the reserve. */
  const spareAt = (id: number) => Math.min(budget - reserve, roomAt(id));
  if (local) {
    rationale.push(
      `Local Deployment: ${pools.anywhere} of the ${income} income may be deployed anywhere; each held bonus's armies stay inside it.`,
    );
    for (const p of pools.bonuses)
      rationale.push(
        `Local Deployment: bonus ${p.name} (#${p.bonusId})'s +${p.value} may only be deployed on its territories (${p.territoryIds.map(label).join(', ')}).`,
      );
    if (pools.trimmed)
      warnings.push(
        `Local Deployment: the income of ${income} is less than the held bonuses are worth; ${pools.trimmed} pooled armies were dropped from the plan's pools.`,
      );
  }

  // ---- protected value ----
  // Judged against my holdings at the start of the turn until the capture passes
  // have run; then against those holdings plus this turn's captures (R2).
  let holdings: Set<number> = mineSet;
  const protectedValue = (t: number): number => {
    // Each bonus is visited once, so it counts once however many of its borders are threatened.
    let v = 0;
    const mineWithout = (x: number) => x !== t && holdings.has(x);
    for (const b of g.map.bonuses) {
      const ts = bonusTerritories(g, b.id);
      if (b.value <= 0 || !ts.includes(t)) continue;
      if (ts.every((x) => holdings.has(x))) {
        v += b.value;
        continue;
      }
      // An incomplete bonus I am working on (T is in it): lost access if T is my only way in.
      const access = (has: (x: number) => boolean) =>
        ts.some((x) => has(x) || neighborsOf(g, x).some(has));
      if (!access(mineWithout)) v += b.value;
    }
    // Per-territory income replaces the base only when larger, so losing T
    // costs an army only above it.
    const per = s.bonusArmyPer ?? 0;
    if (per > 0) v += territoryIncome(mine.length, baseIncome, per) - territoryIncome(mine.length - 1, baseIncome, per);
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
  /**
   * The strongest visible enemy force that could hit `t` next turn: per player, its
   * movable armies next to `t` (territories in `gone` excluded: captured this turn)
   * plus max(its deploy estimate, its fastest growth there). `null` with no enemy next to it.
   */
  const threatAt = (t: number, gone: (n: number) => boolean): { player: number; threat: number } | null => {
    const byPlayer = new Map<number, { movable: number; growth: number }>();
    for (const n of neighborsOf(g, t)) {
      const st = state.get(n);
      if (gone(n) || st?.owner.kind !== 'player' || st.owner.playerId === me || st.armies === null) continue;
      const p = byPlayer.get(st.owner.playerId) ?? { movable: 0, growth: 0 };
      p.movable += Math.max(0, st.armies - guard);
      p.growth = Math.max(p.growth, growthOf.get(n)?.growth ?? 0);
      byPlayer.set(st.owner.playerId, p);
    }
    let best: { player: number; threat: number } | null = null;
    for (const [player, p] of [...byPlayer].sort((a, b) => a[0] - b[0])) {
      const threat = p.movable + Math.max(deployOf(player), p.growth);
      if (!best || threat > best.threat) best = { player, threat };
    }
    return best;
  };
  interface Exposure {
    id: number;
    player: number;
    /** Armies the enemy needs to take it. */
    take: number;
    /** Deploys it still needs next turn to hold. */
    need: number;
  }
  /** Members of a bonus I would hold that a visible enemy could take next turn, given the armies staying on each. */
  const exposure = (members: number[], gone: (n: number) => boolean, stays: (m: number) => number): Exposure[] => {
    const out: Exposure[] = [];
    for (const m of members) {
      const th = threatAt(m, gone);
      if (!th) continue;
      const have = stays(m);
      const take = armiesToTake(have, rates);
      if (take === null || take > th.threat) continue;
      out.push({ id: m, player: th.player, take, need: holdArmies(th.threat) - have });
    }
    return out;
  };

  // ---- 1. defence ----
  interface Border {
    id: number;
    player: number;
    movable: number;
    /** That player's fastest-growing stack next to this border (0 without a trend). */
    growth: number;
    /** That player's deploy estimate (or the override). */
    deploy: number;
    /** movable + max(deploy, growth). */
    threat: number;
  }
  const borders = new Map<number, Border>();
  /** Every visible enemy player with a stack next to one of my territories. */
  const facing = new Set<number>();
  /** The strongest visible enemy threat to my `t` (territories in `gone` excluded), or `null` with none next to it. */
  const borderAt = (t: number, gone: (n: number) => boolean): Border | null => {
    const byPlayer = new Map<number, { movable: number; growth: number }>();
    for (const n of neighborsOf(g, t)) {
      const st = state.get(n);
      if (gone(n) || st?.owner.kind !== 'player' || st.owner.playerId === me || st.armies === null) continue;
      const p = byPlayer.get(st.owner.playerId) ?? { movable: 0, growth: 0 };
      p.movable += Math.max(0, st.armies - guard);
      p.growth = Math.max(p.growth, growthOf.get(n)?.growth ?? 0);
      byPlayer.set(st.owner.playerId, p);
    }
    if (!byPlayer.size) return null;
    const [player, { movable, growth }] = [...byPlayer]
      .map(([id, p]) => [id, p, p.movable + Math.max(deployOf(id), p.growth)] as const)
      .sort((a, b) => b[2] - a[2] || a[0] - b[0])[0]!;
    const deploy = deployOf(player);
    return { id: t, player, movable, growth, deploy, threat: movable + Math.max(deploy, growth) };
  };
  for (const t of mine) {
    for (const n of neighborsOf(g, t)) {
      const st = state.get(n);
      if (st?.owner.kind === 'player' && st.owner.playerId !== me && st.armies !== null) facing.add(st.owner.playerId);
    }
    const b = borderAt(t, () => false);
    if (b) borders.set(t, b);
  }
  for (const [e, gr] of growthOf) {
    // Name the most exposed of my territories next to it (fewest armies, then id).
    const t = neighborsOf(g, e)
      .filter((n) => mineSet.has(n))
      .sort((a, b) => armiesOf(a) - armiesOf(b) || a - b)[0]!;
    const b = borders.get(t)!;
    const next = b.movable + Math.max(b.deploy, b.growth);
    const after = b.movable + b.growth + Math.max(b.deploy, b.growth);
    warnings.push(
      `${label(e)} is building: +${gr.growth}/turn (${gr.from} → ${gr.to}); at this rate ${label(t)} needs ${holdArmies(next)} to hold next turn and ${holdArmies(after)} the turn after`,
    );
  }
  for (const b of borders.values())
    if (b.growth > b.deploy)
      rationale.push(
        `Threat on ${label(b.id)} uses the trend: player ${b.player}'s stack next to it grows +${b.growth}/turn, more than the ~${b.deploy} deploy estimate, so ~${b.threat}.`,
      );
  if (borders.size) {
    if (custom)
      warnings.push(
        `Enemy deploy estimate: threat checks assume ~${enemyDeploy} (your estimate); enemy income is unknown, so they could deploy more.`,
      );
    else {
      const opening = openingArmies(g, board);
      for (const p of [...facing].sort(byNum)) {
        const e = estimates.get(p)!;
        warnings.push(
          opening !== null
            ? `Enemy deploy estimate for player ${p}: ~${e.estimate} (opening board: every visible territory holds ${opening}, so no one has deployed yet and every opponent gets its base income, at least ${MIN_ENEMY_DEPLOY}); enemy income is unknown, so they could deploy more.`
            : `Enemy deploy estimate for player ${p}: ~${e.estimate} (base ${e.base} + visible bonuses +${e.bonusIncome} = ${e.base + e.bonusIncome}, at least max(${MIN_ENEMY_DEPLOY}, base) and at most ${ENEMY_STACK_SHARE * 100}% of its largest stack next to me (${e.largestStack}) = ${e.stackCap}); enemy income beyond its visible bonuses is unknown, so they could deploy more.`,
        );
      }
    }
  }

  interface Threatened {
    id: number;
    have: number;
    threat: number;
    holdCost: number;
    value: number;
    /** Protected value plus the armies a hold saves, in income terms (armies / PAYBACK_TURNS). */
    worth: number;
    /** A weak opponent that held it last turn and threatens it now: it is never conceded economically. */
    recentFrom?: number;
  }
  const threatened: Threatened[] = [];
  /** Armies that stay on my `id` after this turn's deploys, outgoing moves and incoming withdrawals so far. */
  const stayAt = (id: number) => avail.get(id)! + guard + (incoming.get(id) ?? 0);
  /**
   * Fill `threatened` from `borders`, judging each by the armies that stay on it (its
   * armies at the start of the turn unless a finishing-off attack already left).
   */
  const assessThreats = () => {
    for (const b of borders.values()) {
      const have = stayAt(b.id);
      const take = armiesToTake(have, rates);
      if (take === null || take > b.threat) continue;
      warnings.push(
        `${label(b.id)} (${have} armies) could be taken next turn: player ${b.player} has ${b.movable} movable armies next to it plus ~${b.growth > b.deploy ? `${b.growth} (its growth per turn)` : `${b.deploy} deploy`}, and ${take} would do.`,
      );
      // armiesToTake grows at least one army per ~(100 / offensive kill rate) defenders, so this ends.
      let d = 1;
      while ((armiesToTake(have + d, rates) ?? Infinity) <= b.threat) d++;
      const value = valueOf(b.id);
      const from = recentlyTakenFrom(b.id);
      threatened.push({
        id: b.id,
        have,
        threat: b.threat,
        holdCost: d,
        value,
        worth: value + have / PAYBACK_TURNS,
        ...(from !== undefined && from === b.player ? { recentFrom: from } : {}),
      });
    }
    threatened.sort(
      (a, b) =>
        Number(b.recentFrom !== undefined) - Number(a.recentFrom !== undefined) ||
        b.worth / b.holdCost - a.worth / a.holdCost ||
        a.holdCost - b.holdCost ||
        a.id - b.id,
    );
  };

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
  const triage = () => {
    let triageBudget = budget;
    for (const t of threatened) {
      const left = Math.min(acting ? budget : triageBudget, local ? roomAt(t.id) : Infinity);
      if (t.recentFrom !== undefined)
        rationale.push(
          `${label(t.id)} was captured from player ${t.recentFrom} last turn, and that opponent is weak: it is held, not conceded (conceding hands it back for free).`,
        );
      else if (t.holdCost > CONCEDE_FACTOR * t.worth) {
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
  };

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
      if (orderOf(t)) {
        warnSplit(t, `its ${n} remaining armies are not withdrawn to ${label(to.id)}`);
        locked.add(t);
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

  // ---- 1c. reconsider concessions after the capture passes (R2) ----
  // Triage ran before captures were known, so a border in a bonus this turn's
  // captures complete was valued +0 and conceded. Re-value every border against
  // the holdings after the captures; a conceded border in a bonus completed this
  // turn is kept (never withdrawn from) and garrisoned from the leftover.
  /** Conceded borders kept because this turn's captures complete a bonus they protect. */
  const kept = new Set<number>();
  const reconsider = () => {
    if (!captured.size) return;
    holdings = new Set([...mine, ...captured]);
    valueCache.clear();
    if (!conceded.size) return;
    for (const t of [...conceded].sort(byNum)) {
      const completes = g.map.bonuses
        .filter((b) => {
          const ts = bonusTerritories(g, b.id);
          return b.value > 0 && ts.includes(t) && ts.every((x) => holdings.has(x)) && !ts.every((x) => mineSet.has(x));
        })
        .sort((a, b) => a.id - b.id);
      if (!completes.length) continue;
      conceded.delete(t);
      kept.add(t);
      locked.add(t);
      // Drop its concession warning: it is no longer conceded.
      const conceding = `${label(t)} cannot be held `;
      for (let i = warnings.length - 1; i >= 0; i--)
        if (warnings[i]!.startsWith(conceding) && warnings[i]!.endsWith(': conceded')) warnings.splice(i, 1);
      rationale.push(
        `Keep ${label(t)} (not conceded): this turn's captures complete ${completes.map((b) => `bonus ${b.name} (#${b.id}) (+${b.value})`).join(', ')}, so it protects +${valueOf(t)}.`,
      );
    }
  };
  // (Under `defend` the withdrawal runs after the capture passes, once `reconsider` has
  // kept any border this turn's captures make valuable; it still goes first in the orders.)

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
    // R3: what holding the completed bonus's frontier would cost next turn (each
    // remaining member holding the survivors of its capture, mine their armies now).
    let defenseCost = 0;
    if (guarded && remaining.every(bonusTarget)) {
      const rem = new Set(remaining);
      const exposed = exposure(ts, (n) => rem.has(n), (m) => {
        if (!rem.has(m)) return armiesOf(m);
        const c = targets.get(m)!.cost;
        return c - Math.round((armiesOf(m) * rates.defensiveKillRate) / 100);
      });
      defenseCost = exposed.reduce((sum, e) => sum + e.need, 0);
      if (defenseCost > 0)
        rationale.push(
          `Bonus ${b.name} (#${b.id}) needs ~${defenseCost} more armies next turn to hold its frontier once completed (${exposed.map((e) => `${label(e.id)} ${e.need}`).join(', ')}): its score is +${b.value} / (${cost} + ${DEFENSE_DISCOUNT} × ${defenseCost}).`,
        );
    }
    plans.push({
      bonusId: b.id,
      value: b.value,
      focus: isFocus,
      remaining,
      completable: remaining.every(bonusTarget),
      cost,
      borders: analyzeBonus(g, b.id)!.borderTerritoryIds.length,
      defenseCost,
    });
  }
  const ratio = (p: BonusPlan) => {
    const cost = p.cost + DEFENSE_DISCOUNT * p.defenseCost;
    return cost > 0 ? p.value / cost : Infinity;
  };
  plans.sort(
    (a, b) =>
      Number(b.focus) - Number(a.focus) || ratio(b) - ratio(a) || a.borders - b.borders || a.bonusId - b.bonusId,
  );
  const bonusName = (id: number) => `${g.bonusById.get(id)!.name} (#${id})`;

  // ---- R3: a completion must leave a frontier I can hold ----
  /**
   * "Not completed" warning and rationale, by bonus: kept outside `warnings`/`rationale`
   * so a rolled-back pass cannot drop them. A refusal is not final — the next income
   * grows as other bonuses complete — so they are emitted at the end only for bonuses
   * the plan did not complete after all.
   */
  const notCompleted = new Map<number, { warning: string; why: string }>();
  /**
   * Called with `t` just captured (`survivors` armies move in): for every bonus this
   * capture completes, the deploys its exposed members still need next turn to
   * hold must fit my projected next income (plus this turn's leftover, for members
   * I held at the start: a fresh capture cannot be deployed to). Otherwise the
   * bonus is lost immediately: refused under `balanced`/`defend`, warned otherwise.
   * The total need is checked, not each member alone: holding the bonus needs every
   * exposed member held. The leftover is as of this check; a later capture this turn
   * may still spend it (defence funds held borders first, so this is rarely material).
   */
  const defensible = (t: number, survivors: number): boolean => {
    const after = new Set([...mine, ...captured]);
    const completes = g.map.bonuses
      .filter((b) => {
        const ts = bonusTerritories(g, b.id);
        return b.value > 0 && ts.includes(t) && ts.every((x) => after.has(x));
      })
      .sort((a, b) => a.id - b.id);
    if (!completes.length) return true;
    const gained = g.map.bonuses.reduce((sum, b) => {
      const ts = bonusTerritories(g, b.id);
      return ts.length && ts.every((x) => after.has(x)) && !ts.every((x) => mineSet.has(x)) ? sum + b.value : sum;
    }, 0);
    const nextIncome = income + gained;
    const spare = Math.max(0, budget - reserve);
    const stays = (m: number) => {
      if (mineSet.has(m)) return avail.get(m)! + guard + (incoming.get(m) ?? 0);
      if (m === t) return survivors;
      // An earlier capture this turn: the survivors of its finishing attack.
      return survivorsAt.get(m) ?? 0;
    };
    let ok = true;
    for (const b of completes) {
      const exposed = exposure(bonusTerritories(g, b.id), (n) => captured.has(n), stays);
      const total = exposed.reduce((sum, e) => sum + e.need, 0);
      const held = exposed.filter((e) => mineSet.has(e.id)).reduce((sum, e) => sum + e.need, 0);
      if (total <= nextIncome + Math.min(spare, held)) continue;
      const worst = [...exposed].sort((a, b) => b.need - a.need || a.id - b.id)[0]!;
      const head = `completing ${bonusName(b.id)} leaves ${label(worst.id)} indefensible (player ${worst.player} can take it for ${worst.take}; next income ${nextIncome})`;
      if (guarded) {
        if (!notCompleted.has(b.id)) {
          notCompleted.set(b.id, {
            warning: `${head}: not completed`,
            why: `Do not complete bonus ${bonusName(b.id)}: holding its frontier next turn needs ${total} more armies (${exposed.map((e) => `${label(e.id)} ${e.need}`).join(', ')}), more than the next income of ${nextIncome}${held ? ` plus the ${Math.min(spare, held)} left this turn` : ''}, so it would fall next turn; the armies stay for defence.`,
          });
        }
        ok = false;
      } else {
        const w = `${head}: completed anyway (goal ${goal} ignores defence)`;
        if (!warnings.includes(w)) warnings.push(w);
      }
    }
    return ok;
  };

  // ---- capture helper ----
  let anchor: number | undefined;
  /**
   * Defenders assumed at a target attacked to finish its owner off: its armies plus that
   * owner's full deploy estimate (the worst case). Other targets: their armies now.
   */
  const worstCase = new Map<number, number>();
  const defendersAt = (t: number) => worstCase.get(t) ?? armiesOf(t);
  /**
   * Capture `t` from its best source. A conceded border is never deployed to: it attacks
   * out only with the armies already on it (unless every territory I hold is conceded,
   * when there is nowhere better). `force` names the source (it may be locked) and the
   * armies on it that stay out of the attack.
   */
  const tryCapture = (t: number, reason: string, force?: { from: number; keep: number }): boolean => {
    const tg = targets.get(t)!;
    const spare = (x: number) => avail.get(x)! - (force?.keep ?? 0);
    if (force && orderOf(force.from)) return false;
    const usable = (x: number) =>
      !locked.has(x) && (!conceded.has(x) || avail.get(x)! >= tg.cost || mine.every((id) => conceded.has(id)));
    const sources = force
      ? [force.from]
      : tg.sources.filter((x) => usable(x) && !orderOf(x)).sort((a, b) => avail.get(b)! - avail.get(a)! || a - b);
    const needAt = (x: number) => Math.max(0, tg.cost - spare(x));
    // Sorted by armies, the first source needs the fewest deploys; under Local Deployment
    // another may have more room (its bonus pool), so take the first that can afford it.
    const src = local ? (sources.find((x) => needAt(x) <= spareAt(x)) ?? sources[0]) : sources[0];
    const need = src === undefined ? Infinity : needAt(src);
    // No single source can afford it: try a combined capture (never for a forced source).
    if (src === undefined || need > spareAt(src)) {
      if (force) return false;
      if (tryCombined(t, reason)) return true;
      // No-Split: name a source that could have taken it alone but already issues an order.
      const split = tg.sources.find((x) => usable(x) && orderOf(x) && needAt(x) <= spareAt(x));
      if (split !== undefined) warnSplit(split, `the attack on ${label(t)} is not planned`);
      return false;
    }
    deploy(src, need);
    avail.set(src, avail.get(src)! - tg.cost);
    captured.add(t);
    const survivors = tg.cost - Math.round((defendersAt(t) * rates.defensiveKillRate) / 100);
    if (!defensible(t, survivors)) {
      // Undo: under a guarded goal a bonus that falls next turn is not completed.
      avail.set(src, avail.get(src)! + tg.cost - need);
      const left = (deployed.get(src) ?? 0) - need;
      if (left > 0) deployed.set(src, left);
      else deployed.delete(src);
      budget += need;
      captured.delete(t);
      return false;
    }
    survivorsAt.set(t, survivors);
    moves.push({ from: src, to: t, armies: tg.cost, kind: 'attack', reason });
    if (tg.enemy && !worstCase.has(t))
      warnings.push(`Attack on enemy ${label(t)} assumes its owner does not reinforce it first.`);
    rationale.push(
      `Attack ${label(t)} from ${label(src)} with ${tg.cost}${need ? ` (deploy ${need} there)` : ''}: ${reason}.`,
    );
    return true;
  };
  if (reserve) rationale.push(`Hold a reserve of ${reserve} out of captures.`);

  // ---- 3a. combined (multi-source) captures (R4) ----
  interface Softener {
    from: number;
    armies: number;
    kills: number;
    /** Defenders left when it attacks. */
    before: number;
    /** Its attack fails by design: these return home. */
    survivors: number;
  }
  interface Combined {
    softeners: Softener[];
    finisher: number;
    armies: number;
    /** Deploys the finisher needs. */
    need: number;
    /** Defenders left for the finisher. */
    left: number;
    survivors: number;
  }
  /**
   * The cheapest combined capture of `t` (fewest sources) under exact 0%-luck,
   * straight-round arithmetic, or `null` when even every eligible source together
   * (plus the deploys left) cannot take it.
   */
  const combinedPlan = (t: number): Combined | null => {
    const tg = targets.get(t)!;
    const eligible = tg.sources
      .filter((x) => !locked.has(x) && !conceded.has(x) && avail.get(x)! > 0 && !orderOf(x))
      .sort((a, b) => avail.get(b)! - avail.get(a)! || a - b);
    const off = rates.offensiveKillRate;
    const def = rates.defensiveKillRate;
    for (let k = 2; k <= eligible.length; k++) {
      const finisher = eligible[0]!;
      let left = defendersAt(t);
      // The defenders there now: under a worst case (more assumed) a softener must not take
      // it either if the reinforcement never comes.
      let real = armiesOf(t);
      const softeners: Softener[] = [];
      for (const x of eligible.slice(1, k).sort(byNum)) {
        // Never kill the last defender: the finisher's attack is the one that moves in.
        let a = avail.get(x)!;
        while (a > 0 && Math.round((a * off) / 100) >= Math.min(left, real)) a--;
        const kills = Math.round((a * off) / 100);
        if (a <= 0 || kills <= 0) continue;
        const lost = Math.min(a, Math.round((left * def) / 100));
        softeners.push({ from: x, armies: a, kills, before: left, survivors: a - lost });
        left -= kills;
        real -= kills;
      }
      if (!softeners.length) continue;
      const armies = armiesToTake(left, rates);
      if (armies === null) return null;
      const need = Math.max(0, armies - avail.get(finisher)!);
      if (need > spareAt(finisher)) continue;
      const survivors = armies - Math.round((left * def) / 100);
      return { softeners, finisher, armies, need, left, survivors };
    }
    return null;
  };
  const tryCombined = (t: number, reason: string): boolean => {
    const plan = combinedPlan(t);
    if (!plan) return false;
    const tg = targets.get(t)!;
    const n = plan.softeners.length + 1;
    if (luck > 0 || (s.roundingMode !== undefined && s.roundingMode !== 'StraightRound')) {
      const why = luck > 0 ? `luck is ${Math.round(luck * 100)}%` : `this game uses ${s.roundingMode} rounding`;
      const w = `Multi-source capture of ${label(t)} skipped: no single source can afford its ${tg.cost}, and ${n} sources together could only at 0% luck under straight rounding, but ${why}.`;
      if (!warnings.includes(w)) warnings.push(w);
      return false;
    }
    const before = { avail: new Map(avail), incoming: new Map(incoming), deployed: new Map(deployed), budget };
    deploy(plan.finisher, plan.need);
    for (const x of plan.softeners) {
      avail.set(x.from, avail.get(x.from)! - x.armies);
      incoming.set(x.from, (incoming.get(x.from) ?? 0) + x.survivors);
    }
    avail.set(plan.finisher, avail.get(plan.finisher)! - plan.armies);
    captured.add(t);
    if (!defensible(t, plan.survivors)) {
      for (const [k, v] of before.avail) avail.set(k, v);
      incoming.clear();
      for (const [k, v] of before.incoming) incoming.set(k, v);
      deployed.clear();
      for (const [k, v] of before.deployed) deployed.set(k, v);
      budget = before.budget;
      captured.delete(t);
      return false;
    }
    survivorsAt.set(t, plan.survivors);
    combined.add(t);
    for (const x of plan.softeners)
      moves.push({
        from: x.from,
        to: t,
        armies: x.armies,
        kind: 'attack',
        reason: `wears ${label(t)} down for a combined capture (${reason})`,
      });
    moves.push({ from: plan.finisher, to: t, armies: plan.armies, kind: 'attack', reason });
    if (tg.enemy && !worstCase.has(t))
      warnings.push(`Attack on enemy ${label(t)} assumes its owner does not reinforce it first.`);
    const order = [...plan.softeners.map((x) => x.from), plan.finisher].map(label).join(', then ');
    warnings.push(
      `The capture of ${label(t)} combines ${n} attacks that must run in this order (${order}): the first ${n === 2 ? 'one fails' : `${n - 1} fail`} by design, only wearing the defenders down; the arithmetic is exact only at 0% luck under straight rounding.`,
    );
    rationale.push(
      `Attack ${label(t)} with ${n} attacks (no single source can afford its ${tg.cost}): ${plan.softeners
        .map((x) => `from ${label(x.from)} with ${x.armies} (kills ${x.kills} of ${x.before}; ${x.survivors} survive and stay)`)
        .join(', then ')}, then from ${label(plan.finisher)} with ${plan.armies}${plan.need ? ` (deploy ${plan.need} there)` : ''}, taking the last ${plan.left}: ${reason}.`,
    );
    return true;
  };

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
      incoming: new Map(incoming),
      combined: new Set(combined),
      survivorsAt: new Map(survivorsAt),
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
    incoming.clear();
    for (const [k, v] of snap.incoming) incoming.set(k, v);
    for (const m of moves.splice(snap.moves)) captured.delete(m.to);
    combined.clear();
    for (const t of snap.combined) combined.add(t);
    survivorsAt.clear();
    for (const [k, v] of snap.survivorsAt) survivorsAt.set(k, v);
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

  // ---- 1e. finish off an opponent (#45) ----
  // Before any border is conceded: for each visible opponent whose every territory is
  // visible (none borders the fog) and borders mine — any such opponent, however strong,
  // fewest territories first — plan "attack every one of its territories this turn", each
  // target assumed to receive that opponent's full deploy estimate (the worst case). Kept
  // when it eliminates the opponent, or takes most of what it holds with every attacking
  // border left facing none of the rest. Holds worth paying for against other players
  // come first: an attacking border keeps what holds it, and the deploys a hold elsewhere
  // needs are reserved out of the budget.
  /** Visible enemy territories by owner, sorted. */
  const ownedBy = new Map<number, number[]>();
  for (const [id, st] of [...state].sort((a, b) => a[0] - b[0])) {
    if (st.owner.kind !== 'player' || st.owner.playerId === me || st.armies === null) continue;
    ownedBy.set(st.owner.playerId, [...(ownedBy.get(st.owner.playerId) ?? []), id]);
  }
  const ownerOf = (id: number) => {
    const o = state.get(id)?.owner;
    return o?.kind === 'player' ? o.playerId : undefined;
  };
  const hidden = (n: number) => {
    const st = state.get(n);
    return !st || st.owner.kind === 'unknown' || st.armies === null;
  };
  /** Its territories with a fogged neighbour: it may hold more in the fog. */
  /** Anything on the board hidden: an opponent may hold territories there no visible one borders. */
  const fogAnywhere = [...g.territoryById.keys()].some(hidden);
  const fogEdge = (p: number) => ownedBy.get(p)!.filter((t) => neighborsOf(g, t).some(hidden));
  const inReach = (p: number) => ownedBy.get(p)!.every((t) => neighborsOf(g, t).some((n) => mineSet.has(n)));
  /** Fully visible, fewer territories than mine, and a deploy below my income. */
  const weak = new Set(
    [...ownedBy.keys()].filter(
      (p) => !fogEdge(p).length && ownedBy.get(p)!.length < mine.length && deployOf(p) < income,
    ),
  );
  const previousOwner = new Map(
    (input.previousBoard?.territories ?? []).flatMap((t) =>
      t.owner.kind === 'player' ? [[t.territoryId, t.owner.playerId] as const] : [],
    ),
  );
  /** The weak opponent that held my `id` on the previous board, if any. */
  const recentlyTakenFrom = (id: number): number | undefined => {
    const p = previousOwner.get(id);
    return p !== undefined && p !== me && weak.has(p) ? p : undefined;
  };
  /**
   * Plan every capture of player `p`'s territories against the worst case. Committed
   * (true) when it eliminates `p` or takes most of it with the attacking borders freed;
   * otherwise rolled back. `probe`: always rolled back, true when all would fall.
   */
  const finishOff = (p: number, probe: boolean): boolean => {
    const ts = ownedBy.get(p)!;
    const deployP = deployOf(p);
    const snap = {
      budget,
      deployed: new Map(deployed),
      avail: new Map(avail),
      incoming: new Map(incoming),
      captured: new Set(captured),
      combined: new Set(combined),
      survivorsAt: new Map(survivorsAt),
      targets: new Map(ts.map((t) => [t, targets.get(t)] as const)),
      notCompleted: new Map(notCompleted),
      moves: moves.length,
      rationale: rationale.length,
      warnings: warnings.length,
    };
    const rollback = () => {
      budget = snap.budget;
      deployed.clear();
      for (const [k, v] of snap.deployed) deployed.set(k, v);
      for (const [k, v] of snap.avail) avail.set(k, v);
      incoming.clear();
      for (const [k, v] of snap.incoming) incoming.set(k, v);
      captured.clear();
      for (const t of snap.captured) captured.add(t);
      combined.clear();
      for (const t of snap.combined) combined.add(t);
      survivorsAt.clear();
      for (const [k, v] of snap.survivorsAt) survivorsAt.set(k, v);
      for (const [t, tg] of snap.targets) {
        worstCase.delete(t);
        if (tg) targets.set(t, tg);
        else targets.delete(t);
      }
      notCompleted.clear();
      for (const [k, v] of snap.notCompleted) notCompleted.set(k, v);
      moves.length = snap.moves;
      rationale.length = snap.rationale;
      warnings.length = snap.warnings;
    };
    for (const t of ts) {
      const defenders = armiesOf(t) + deployP;
      const cost = captureCost(defenders, s);
      if (cost === null) {
        rollback();
        return false;
      }
      worstCase.set(t, defenders);
      targets.set(t, { id: t, cost, enemy: true, sources: neighborsOf(g, t).filter((n) => mineSet.has(n)) });
    }
    // Holds against other players worth paying for (rule 1a's CONCEDE_FACTOR test) come
    // first. A source keeps what holds it there; a border that attacks nothing has the
    // deploys its hold needs reserved out of the budget (in triage order, while it lasts).
    const sources = new Set(ts.flatMap((t) => targets.get(t)!.sources));
    const keepAt = new Map<number, number>();
    const elsewhere: { x: number; cost: number; worth: number }[] = [];
    for (const x of mine) {
      const rest = borderAt(x, (n) => ownerOf(n) === p);
      if (!rest) continue;
      const need = holdArmies(rest.threat);
      const cost = Math.max(0, need - armiesOf(x));
      const worth = valueOf(x) + armiesOf(x) / PAYBACK_TURNS;
      if (cost > CONCEDE_FACTOR * worth) continue;
      if (sources.has(x)) {
        const keep = Math.max(0, need - guard);
        keepAt.set(x, keep);
        avail.set(x, avail.get(x)! - keep);
      } else if (cost > 0) elsewhere.push({ x, cost, worth });
    }
    let reserved = 0;
    elsewhere.sort((a, b) => b.worth / b.cost - a.worth / a.cost || a.cost - b.cost || a.x - b.x);
    for (const h of elsewhere) {
      const room = local ? Math.min(budget, roomAt(h.x)) : budget;
      if (h.cost > room) continue;
      budget -= h.cost;
      reserved += h.cost;
    }
    const reason = `takes player ${p}'s territory, sized for its full ~${deployP} deploy landing there`;
    const order = [...ts].sort((a, b) => targets.get(a)!.cost - targets.get(b)!.cost || a - b);
    const taken = order.filter((t) => tryCapture(t, reason));
    for (const [x, k] of keepAt) avail.set(x, avail.get(x)! + k);
    budget += reserved;
    const all = taken.length === ts.length;
    if (probe) {
      rollback();
      return all;
    }
    const left = ts.filter((t) => !captured.has(t));
    const freed = moves
      .slice(snap.moves)
      .filter((m) => m.kind === 'attack')
      .every((m) => !neighborsOf(g, m.from).some((n) => left.includes(n)));
    if (!taken.length || !(all || (taken.length * 2 > ts.length && freed))) {
      rollback();
      return false;
    }
    // The territories left stay ordinary (non-worst-case) targets, as before this attempt.
    for (const t of left) {
      worstCase.delete(t);
      const tg = snap.targets.get(t);
      if (tg) targets.set(t, tg);
      else targets.delete(t);
    }
    const names = taken.sort(byNum).map(label).join(', ');
    if (all) {
      rationale.push(
        `Finish off player ${p}: attack all ${ts.length} of its territories (${names}) this turn, each sized for its full ~${deployP} deploy landing there, so it is eliminated ${fogAnywhere ? 'if it holds nothing in the fog, ' : ''}even if it reinforces; the borders facing it need no holding.`,
      );
      warnings.push(
        `Eliminating player ${p} assumes it deploys at most ~${deployP} (its estimate); more income than that (unseen bonuses, cards) could still save one of its territories.`,
      );
      if (fogAnywhere)
        warnings.push(
          `player ${p} could still hold territories in the fog that border none of its visible ones: taking all ${ts.length} visible ones may not eliminate it.`,
        );
    } else {
      rationale.push(
        `Pressure player ${p}: take ${taken.length} of its ${ts.length} territories (${names}) this turn, each sized for its full ~${deployP} deploy landing there; ${left.map(label).join(', ')} stay${left.length === 1 ? 's' : ''} theirs, and no attacking border faces ${left.length === 1 ? 'it' : 'them'}.`,
      );
      warnings.push(
        `Pressuring player ${p} assumes it deploys at most ~${deployP} (its estimate); more income than that (unseen bonuses, cards) could still save a territory.`,
      );
    }
    return true;
  };
  if (guarded) {
    const candidates = [...ownedBy.keys()]
      .filter(inReach)
      .sort(
        (a, b) =>
          ownedBy.get(a)!.length - ownedBy.get(b)!.length ||
          ownedBy.get(a)!.reduce((n, t) => n + armiesOf(t), 0) - ownedBy.get(b)!.reduce((n, t) => n + armiesOf(t), 0) ||
          a - b,
      );
    for (const p of candidates) {
      const edge = fogEdge(p);
      if (edge.length) {
        if (finishOff(p, true))
          warnings.push(
            `player ${p} may hold more territories in the fog (next to ${edge.map(label).join(', ')}): finishing it off is not attempted, though its ${ownedBy.get(p)!.length} visible territories could all be taken this turn.`,
          );
        continue;
      }
      finishOff(p, false);
    }
    // The borders those captures relieve: re-judged without the territories taken.
    if (captured.size)
      for (const id of [...borders.keys()]) {
        if (!neighborsOf(g, id).some((n) => captured.has(n))) continue;
        const b = borderAt(id, (n) => captured.has(n));
        if (b) borders.set(id, b);
        else borders.delete(id);
      }
  }
  assessThreats();
  triage();

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
      // Each opponent's movable armies plus its own deploy estimate; with none next to it, the reported estimate.
      if (!byPlayer.size) return enemyDeploy;
      return Math.max(...[...byPlayer].map(([p, movable]) => movable + deployOf(p)));
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
      if (!b || !targets.has(n) || broken(b) || orderOf(t.id)) return false;
      const o = breakOption(n);
      if (t.holdCost + o.cost > spareAt(t.id)) return false;
      const before = budget;
      deploy(t.id, t.holdCost);
      if (!tryCapture(n, breakReason(b), { from: t.id, keep: avail.get(t.id)! })) {
        // Refused (R3: it would complete a bonus I cannot hold next turn): just hold.
        rationale.push(
          `Deploy ${t.holdCost} to ${label(t.id)} so it holds (protects +${t.value}): ${t.have + t.holdCost} armies need ${armiesToTake(t.have + t.holdCost, rates)} to take, above the ~${t.threat} threat.`,
        );
        return true;
      }
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
        // A border just taken from a weak opponent is held first: conceding it hands it back.
        score: t.recentFrom !== undefined ? Infinity : t.worth / t.holdCost,
        cost: t.holdCost,
        id: t.id,
        value: t.value,
        focus: false,
        borders: 0,
        run: () => {
          if (holdAndBreak(t)) return;
          const pending =
            expansionLeft > 0 && t.worth < topValue && t.recentFrom === undefined ? Math.max(0, floor - expansionSpent) : 0;
          const room = roomAt(t.id);
          if (t.holdCost > room) return concedeUnaffordable(t, room);
          if (t.holdCost > room - pending) {
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
      const room = roomAt(t.id);
      if (t.holdCost > room) concedeUnaffordable(t, room);
      else hold(t);
    }
    reconsider();
    withdraw();
  } else {
    for (const p of plans) complete(p);
    for (const p of plans) advance(p);
    reconsider();
    if (acting) withdraw();
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
    const n = roomAt(where);
    if (n > 0) {
      rationale.push(`Deploy the leftover ${n} to ${label(where)}: ${why}.`);
      deploy(where, n);
    }
    // Local Deployment: what is left of each bonus pool stays inside its bonus, on its
    // most threatened member (not conceded first; ties by id). One charge, taken before
    // any of these deploys: re-charging after each would let the matching spread a
    // pool's armies over an overlapping pool and strand the latter's.
    if (local && budget > 0) {
      const danger = (id: number) => {
        const b = borders.get(id);
        if (!b) return -Infinity;
        return b.threat - (armiesToTake(stays(id), rates) ?? Infinity);
      };
      const charged = chargeDeploys(pools, deployed).used;
      for (const p of pools.bonuses) {
        const left = p.value - (charged.get(p.bonusId) ?? 0);
        if (left <= 0) continue;
        const m = [...p.territoryIds].sort(
          (a, b) => Number(conceded.has(a)) - Number(conceded.has(b)) || danger(b) - danger(a) || a - b,
        )[0]!;
        rationale.push(
          `Deploy bonus ${p.name} (#${p.bonusId})'s ${left} to ${label(m)}: Local Deployment keeps them inside the bonus, and it is its most threatened member.`,
        );
        deploy(m, left);
      }
    }
    if (budget > 0) {
      // Unreachable: the leftover deploy filled `where` to its exact room, so no anywhere
      // armies remain, and each pool's unused room (from one maximum charge) went inside
      // it. Never leave income undeployed — but say the plan breaks the pools.
      warnings.push(
        `Local Deployment: ${budget} armies could not be placed within the pools; they go to ${label(where)}, which breaks Local Deployment — war.app may refuse this turn.`,
      );
      deploy(where, budget);
    }
  }

  // A kept border the leftover could not make safe: the completed bonus can fall with it.
  for (const t of [...kept].sort(byNum)) {
    const b = borders.get(t)!;
    const stays = avail.get(t)! + guard + (incoming.get(t) ?? 0);
    const take = armiesToTake(stays, rates);
    if (take !== null && take <= b.threat)
      warnings.push(
        `${label(t)} is kept for the bonus this turn completes, but its ${stays} armies need only ${take} to take against the ~${b.threat} threat: the bonus can fall next turn.`,
      );
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
      if (orderOf(t)) {
        warnSplit(t, `its ${n} idle armies are not transferred to ${label(step)}`);
        continue;
      }
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
  // A bonus refused in one pass but completed by a later one is not reported as refused.
  for (const id of [...notCompleted.keys()].sort(byNum)) {
    if (completed.includes(id)) continue;
    warnings.push(notCompleted.get(id)!.warning);
    rationale.push(notCompleted.get(id)!.why);
  }
  const gained = completed.reduce((sum, id) => sum + g.bonusById.get(id)!.value, 0);

  if (noSplit && moves.length)
    warnings.push(
      'No-Split is on: each order sends the planned armies, not every movable army; whether war.app also requires sending all movable armies from a territory is unverified.',
    );
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
    multiSourceCaptures: [...combined].sort(byNum),
  };
}
