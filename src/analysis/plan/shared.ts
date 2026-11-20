// The planner's shared constants, types and pure helpers (#133): the tuning constants, the input and
// output types of `planTurn`, combat sizing (`captureCost`), fog (`visibleState`) and the enemy deploy
// estimates. A leaf module: planner.ts and every phase under src/analysis/plan/ import from it, and it
// imports no phase and not planner.ts, so the import graph has no runtime cycle (observe.ts takes only types from it). planner.ts re-exports all of it.
import type { IncomePoint, IncomeTrend } from '../income-trend.js';
import type { BoardState, TerritoryState } from '../../board.js';
import { commerceRules } from '../../commerce.js';
import type { MyOrders, ObservedTurn, OpponentTrack } from '../opponents.js';
import { LEAD_ARMIES } from '../opponents.js';
import type { GameSettings } from '../../normalize.js';
import { bonusTerritories } from '../bonuses.js';
import {
  armiesForChance,
  armiesToTake,
  DEFAULT_DEFENSIVE_KILL_RATE,
  DEFAULT_OFFENSIVE_KILL_RATE,


  guaranteedKills,
  luckFraction,


  winChance,
  type CombatSettings,

} from '../combat.js';
import { neighborsOf, type MapGraph } from '../graph.js';
import type { GameOutlook } from '../outlook.js';
import type { BorderOutcome, Exchange } from '../exchange.js';
import type { TwoStepReach } from '../lookahead.js';
import type { MoveSlot } from '../schedule.js';
import { armyCapIncome, boardIncome, DEFAULT_BASE_INCOME, incomeRules, territoryIncome, type ArmyCapIncome } from '../player.js';
import type { GameProfile, ProfilePlayer } from '../profile.js';
import { byNum } from './util.js';
import type { TeamView } from './team.js';
import type { Jab } from './jabs.js';
import type { SiegeMemory, SiegeReport } from './siege.js';
import type { BonusAttemptMemory, BonusPushEntry } from './bonus-attempts.js';
export * from './observe.js';

/** A bonus is uneconomic when its remaining capture cost exceeds this many turns of its value… */
export const PAYBACK_TURNS = 10;
/**
 * #275 (pattern 2): with the guard off, the share of a breach's income (`breachBehind`, src/analysis/breach.ts) a
 * border's protected value counts. Half: the bonuses behind fall only if the breaching stack walks on
 * next turn, and a border may still be retaken or the stack turned elsewhere.
 */
export const BREACH_WEIGHT = 0.5;
/**
 * #291: the share of what a gate's loss opens (`opensBehind`: held bonuses every route from an enemy or the fog
 * reaches only through it) that its protected value counts — the enemy still has to walk in, as with a breach.
 */
export const OPENS_WEIGHT = 0.5;
/** #201: the shortest payback horizon once the game is decided. */
export const DECIDED_PAYBACK_MIN = 3;
/** …or when one remaining territory alone costs more than this many times its value (a wasteland). */
export const WASTELAND_FACTOR = 5;
/**
 * Plain expansion (pass 3, #125): a capture that adds no income and is in no bonus worth
 * completing is made only when it loses at most this many armies (a 2- or 3-army neutral at the
 * default rates): a cheap step still widens my reach, a 10-army one throws 7 armies away.
 */
export const PLAIN_EXPANSION_LOSS = 2;
/**
 * The fewest armies an order out of a conceded border must carry before the plan spends an Order
 * Priority card on it (#127): a base income's worth (war.app's default MinimumArmyBonus). A
 * 1-army withdrawal from a +0 border is not worth a card.
 */
export const ORDER_PRIORITY_MIN_ARMIES = DEFAULT_BASE_INCOME;
/** Floor of the default enemy deploy estimate (a player's base income). */
export const MIN_ENEMY_DEPLOY = DEFAULT_BASE_INCOME;

/**
 * Observed turns an opponent track needs before the planner uses its income in place of the
 * single-turn observed figure (S3).
 */
export const TRACKED_MIN_TURNS = 2;
/**
 * #235: how much evidence halves the fog prior's lead over an opponent's own figure: the prior keeps
 * PRIOR_EVIDENCE_TURNS / (PRIOR_EVIDENCE_TURNS + observed turns × the visible share of its edge) of
 * the gap. Unmeasured: four observed turns with its whole edge in view meet half-way.
 */
export const PRIOR_EVIDENCE_TURNS = 4;
/**
 * #294: an opponent's tracked income was read from less than this share of its frontier
 * ({@link frontierCoverage}, over its income window): the evidence is thin. #368 (owner decision of
 * 2026-11-19): the estimate is then the midpoint of its range, moved toward the tracked figure as the
 * coverage nears this share ({@link EnemyDeployEstimate.thinEvidence}); it replaced #294's floor of the
 * tracked figure × 1.5. Unmeasured.
 */
export const LOW_COVERAGE = 0.5;

/** Fog reveals named in the observed-deploy rationale before "and N more". */
export const MAX_NAMED_REVEALS = 6;
/**
 * #164: a stack the fog hides (Dense / Heavy fog) moves at most this many turns of its owner's
 * income beyond the guard, however many armies the tracker cannot account for: those are spread
 * over its hidden territories, and its income under fog that shows every owner is exact. A larger
 * bank on one border is possible and the fog cannot show it; the cap is a judgement, said in the
 * warning.
 */
export const HIDDEN_POOL_INCOMES = 2;
/** A border is conceded when holding it costs more than this many times the income it protects. */
export const CONCEDE_FACTOR = 3;
/** A held border is comfortable once taking it needs more than this many times its threat. */
export const COMFORT_MARGIN = 1.25;
/**
 * A held bonus whose threatened borders are short of a sure hold by at most this share of
 * the hold they need (or {@link NEAR_MISS_ARMIES}, whichever is larger) is a near miss:
 * funded with everything available rather than conceded (issue #59).
 */
export const NEAR_MISS = 0.15;
/** The near-miss margin is never below this many armies. */
export const NEAR_MISS_ARMIES = 2;
/** The most a held bonus's hold `need` may be short and still be a near miss. */
export function nearMissMargin(need: number): number {
  return Math.max(NEAR_MISS_ARMIES, NEAR_MISS * need);
}

/**
 * An opponent next to the fog (it may hold unseen territories) is still pressured — all its
 * visible territories attacked, each sized for its full estimated deploy plus
 * {@link pressureMargin} — when each of those margin-sized captures costs at most this many
 * times a typical expansion capture (the median capture cost of the visible neutrals next to
 * me; issue #60), or is paid outright from idle armies next to it (#120: it then displaces no
 * expansion). All or nothing: one visible territory over it blocks the pressure on all.
 * Not tuned to admit #60: at ~6 its 0-army territory costs 15 with the margin, five 2-army
 * neutrals — "more than the expansion it displaces" (the owner's live calibration) — so it is
 * not attempted; at ~4 it costs 10 and is.
 */
export const PRESSURE_FACTOR = 4;
/**
 * A pressure attack is sized for its target's armies + the full estimated deploy + this share
 * of that deploy (at least {@link PRESSURE_MARGIN_ARMIES}): the opponent's income is unseen
 * under fog, and live (#60) an attack sized for exactly its ~6 deploy failed.
 */
export const PRESSURE_MARGIN = 0.5;
/** The pressure margin is never below this many armies. */
export const PRESSURE_MARGIN_ARMIES = 2;
/** The extra defenders a pressure attack is sized for, over an estimated `deploy`. */
export function pressureMargin(deploy: number): number {
  return Math.max(PRESSURE_MARGIN_ARMIES, Math.ceil(PRESSURE_MARGIN * deploy));
}

/**
 * Ahead in a 1v1 under the game profile (rule 0p): pressure on an opponent next to the fog is
 * allowed when each margin-sized capture costs at most this many typical expansion captures
 * (instead of {@link PRESSURE_FACTOR}) — a lead is pressed, not left to sit.
 */
export const AHEAD_PRESSURE_FACTOR = 8;
/**
 * FFA with two or more opponents left (rule 0p): a break against a player that threatens no
 * bonus of mine is skipped when a neutral capture scores at least this share of it per army.
 */
export const SECOND_FRONT_SIMILAR = 0.5;
/**
 * #167: rule 0p.2 scales with my army lead — my visible armies over the largest opponent's in view
 * (special units included). Up to this many times, the neutral needs SECOND_FRONT_SIMILAR × the lead
 * (at least 1×) of a break's score to skip it; above it the rule is off: idle stacks beside weak
 * enemy territories are a lever, not a risk, and (adapting) they attack them (the lead strikes).
 */
export const SECOND_FRONT_LEAD = 3;

/** Denying +V to the opponent is worth this many times gaining +V yourself (per opponent: divided among them). */
export const BREAK_WEIGHT = 1.0;
/** Under `balanced`, at least this share of income goes to expansion/breaking before holds protecting less than it. */
export const MIN_EXPANSION_SHARE = 0.3;
/** #167: how many enemy territories the "Not attacking … next to mine" line gives a reason for; the rest are named. */
export const NOT_ATTACKING_REASONS = 6;
/**
 * Under `balanced`/`defend` a bonus's score is value / (capture cost + this × the
 * deploys its frontier needs next turn to hold), so a defensible smaller bonus can
 * beat an indefensible big one.
 */
export const DEFENSE_DISCOUNT = 1;
/**
 * Every capture pays for the frontier it adds (#71): each border it opens costs this many armies
 * in its score (one it closes saves as much), plus, when the border faces a visible enemy, the
 * deploys it needs next turn to hold. Small, so borders facing only neutrals barely matter.
 */
export const NEUTRAL_BORDER_COST = 0.25;

/**
 * #382: `siege` plans as `balanced` against every player but one (plan/siege.ts): the target's
 * cheapest bonus breaks first, its other territories left alone and a strike stack built facing it
 * until the assault trigger fires.
 */
export type PlanGoal = 'balanced' | 'expand' | 'complete-bonus' | 'defend' | 'siege';

/** Move orders under which the award order carries into the turns (GameFeed's `MoveOrder`). */
const CYCLIC_ORDERS = new Set(['Cycle', 'NoLuckCycle']);

/** A cyclic move order (GameFeed's `MoveOrder`): the order reverses every turn. */
export const isCyclicMoveOrder = (moveOrder: string | undefined): boolean => moveOrder !== undefined && CYCLIC_ORDERS.has(moveOrder);

export interface PlannerSettings {
  offensiveKillRate?: number;
  defensiveKillRate?: number;
  /** Fraction (0.16) or percent (16). */
  luckModifier?: number;
  roundingMode?: string;
  /** Default `true`. */
  oneArmyStandsGuard?: boolean;
  multiAttack?: boolean;
  /**
   * Default `true`: idle interior armies may transfer (rule 6). The planner's own switch, not war.app's
   * AllowTransferOnly (#257): that toggles the per-order Transfer Only mode, while every planned move is
   * sent as AttackTransfer, which transfers between my own territories in any game.
   */
  idleTransfers?: boolean;
  /** One army of income per this many territories held (0 or absent: off). */
  bonusArmyPer?: number;
  /**
   * #332, a commerce game's army cost multiplier (absent: not a commerce game, or one gold per army): an opponent's
   * gold income read off the board buys `armiesForGold` armies (src/commerce.ts). Set only when it is above 0, so
   * every other game's plan is unchanged.
   */
  armyCostMultiplier?: number;
  /** Every player's base income (the game's MinimumArmyBonus; default {@link DEFAULT_BASE_INCOME}). */
  baseIncome?: number;
  /** Local Deployment: a held bonus's armies are deployed only inside that bonus. Default `false`. */
  localDeployments?: boolean;
  /** No-Split: a territory issues at most one attack or transfer this turn. Default `false`. */
  noSplit?: boolean;
  /**
   * Army cap (the game's ArmyCap, × income): armies above it are wasted, so spending them is
   * free (rule 4e). `null` / absent: no cap.
   */
  armyCap?: number | null;
  /**
   * #167: automatic Wastelands — `count` neutrals started at `size` armies. A fogged missing member of
   * a bonus (its size unknown) is then costed with the expected surcharge of being one.
   */
  wastelands?: { count: number; size: number };
  /**
   * #428: the game's neutral size (the larger of InitialNonDistributionArmies and
   * InitialNeutralsInDistribution the settings give): a fogged missing bonus member whose owner the fog
   * does not show, and that no board showed, is costed as a neutral of this size. Absent: at the bonus's
   * costliest visible missing member, as before.
   */
  neutralArmies?: number;
  /**
   * #271 review: the first turn an opponent may play a Bomb card (the card clock's fastest turn), when
   * one is in play; absent, none can be. A bomb on a hold of mine reads as a failed attack, so on a turn
   * one may have been played {@link repelledFloor} leaves out the half it could take ({@link bombPossibleOn}).
   */
  bombFrom?: number;
  /**
   * #293 review: an opponent's Reinforcement card on the card clock (a fixed card's armies; set by
   * `plannerSettings` without a hand), when one is in play. Read only under Local Deployment, where
   * the observed deploy counts it in the free income ({@link localFreeOn}); the planner prefers the
   * game context's clock (`PlanGameContext.reinforcement`, which can value a progressive card).
   */
  opponentReinforcement?: ReinforcementClock;
}

/**
 * #293 review: an opponent's free income under Local Deployment on the turn read (`turn`), for
 * {@link ObserveContext.localFree}: its base (never below `floor`) plus a Reinforcement card's armies
 * when the clock says one can be in hand by then (unknown turn: yes, when one is in play). A card
 * play is income it may deploy anywhere.
 */
export function localFreeOn(base: number, floor: number, clock: ReinforcementClock | undefined, turn: number | null | undefined): number {
  const card = clock && clock.armies > 0 && (turn === null || turn === undefined || turn >= clock.firstTurn) ? clock.armies : 0;
  return Math.max(floor, base) + card;
}

/** #271 review: whether an opponent may have played a Bomb on `turn` (unknown turn: yes, when one is in play). */
export function bombPossibleOn(settings: PlannerSettings, turn: number | null | undefined): boolean {
  return settings.bombFrom !== undefined && (turn === null || turn === undefined || turn >= settings.bombFrom);
}

export interface PlanOptions {
  /** Default `balanced`. */
  goal?: PlanGoal;
  /** #382: under `goal: 'siege'`, the player besieged (GameFeed id); default the strongest opponent in contact. */
  siegeTarget?: number;
  /**
   * #361: single-army jabs (plan/jabs.ts), only at 0% luck under straight rounding. Default: on under
   * `goal: 'siege'`, off otherwise (opt in with `true`; `false` turns them off under a siege too).
   */
  jabs?: boolean;
  /**
   * #375: territories (any owner, a neutral included) and players (GameFeed ids) no pass of the plan
   * attacks — a deal outside any recorded truce. Each is treated like a truce's covered territory (T1).
   */
  avoid?: { territories?: readonly number[]; players?: readonly number[] };
  /**
   * #274: `false` keeps my commander where it stands this turn (rule 1k alone, the walk of
   * plan/commander.ts off). Default: it walks toward safety when it should.
   */
  commanderWalks?: boolean;
  /**
   * #420: `false` turns the total hold cap off (plain holds take whatever they need, as before it). Default:
   * plain holds take at most half my income, 70% when behind. Tests of earlier hold rules use it.
   */
  holdCap?: boolean;
  /**
   * #421: `false` holds no strike share out of captures (`planShare` replans so when holding it would
   * lower next income). Default: in contact on a flat income, 25% of income goes to the strike stack.
   */
  strikeShare?: boolean;
  /** #382: `false` keeps the profile from picking the siege (adapting with no goal). Default: it picks it when it fits. */
  siegeAuto?: boolean;
  /**
   * #201: the outlook (#178, `gameOutlook`) from my boards over the last turns. Once it reports the
   * game decided (winning or losing), payback tests count the turns the game has left and the
   * forecasts below read it; adapting only.
   */
  outlook?: Pick<GameOutlook, 'state' | 'turns'>;
  /**
   * #201: the neutrals the picking board showed, territory → armies (`warapp_plan_picks` keeps them).
   * A missing bonus member the fog hides now is costed at its remembered size, never attacked.
   */
  rememberedNeutrals?: ReadonlyMap<number, number>;
  /**
   * #428: each territory's last sighting on my board history (its armies, and its owner: a player id,
   * `null` for a neutral). A missing bonus member the fog hides now is costed at those armies, ahead of
   * `rememberedNeutrals` and the neutral size — unless the fog shows another owner now.
   */
  lastSeen?: ReadonlyMap<number, { armies: number; owner: number | null }>;
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
  /**
   * I hold an Order Priority card I could play this turn: when a commander strike is planned
   * and my commander's territory is threatened, `cardAdvice` says to play it (rule 1s); for a
   * move out of a conceded border worth a card, too (rule 7, #127). Without it no card is advised.
   */
  holdsOrderPriority?: boolean;
  /**
   * The Order Priority I hold is played this turn anyway (the hand is over the card limit and it
   * must go): it costs nothing, so rule 7 advises it for a move out of a conceded border however
   * few armies that saves (ORDER_PRIORITY_MIN_ARMIES does not apply).
   */
  orderPriorityForced?: boolean;
  /**
   * I move first this turn (#127): the caller knows it (Cycle and No-Luck Cycle swap the first
   * mover every turn). My first order then already runs before the opponent's first, so
   * Order Priority is never advised, and finishing a player off needs no caveat. Default unknown.
   */
  movesFirst?: boolean;
  /**
   * #215 review: {@link movesFirst} comes from a source not verified live (the award of picks: the
   * wiki's rule). The schedule and card advice still use it; hold sizing treats the first mover as
   * unknown (armies moved into a border count as landing after the opponent's first attack), and a
   * hold that depends on it says so. Default false.
   */
  movesFirstUnverified?: boolean;
  /**
   * An opponent may hold an Order Priority card this turn (#179): the card clock says one can
   * exist by now and its hand is hidden. Two played cards cancel, so even moving first, mine is
   * what keeps the killing strike (rule 1e) or the commander strike (rule 1s) first. Default false.
   */
  opponentsMayHoldOrderPriority?: boolean;
  /**
   * An opponent may hold a Bomb card this turn (#163): the card clock's fastest turn says one can
   * exist by now (whether hands are hidden is not checked: the plan never sees an opponent's hand). A bomb halves one territory of mine next to the bomber after the deploys and
   * before any move, so every hold is sized as if its stack were halved first (the commander
   * unharmed), and the leftover goes to two stacks rather than one (not a strike, saving or
   * expansion stack, which concentrate for one attack). Default false.
   */
  opponentsMayHoldBomb?: boolean;
  /**
   * #127: the armies a turn with a capture earns in card pieces (`capturePieceValue`: the
   * Reinforcement pieces it brings × that card's armies over its pieces). With no capture planned,
   * the cheapest capture that loses no more armies than this is taken (rule 4g). Absent or 0: off.
   */
  cardPieceValue?: number;
  /**
   * Adapt to the game profile (rule 0p): with no `goal`, pick it from the profile (behind:
   * `defend`, else `balanced`) and apply the profile's rules. An explicit `goal` always wins
   * (the plan says the profile was overridden). Default `false`: the plan ignores the profile.
   */
  adapt?: boolean;
  /**
   * The least win chance an ordinary capture is sized for, 0.5–1. Default (#126): 1 with no
   * luck, {@link LUCK_WIN_CHANCE} with luck on. Below 1, each capture of a neutral or an enemy
   * territory sized for its current armies gets the fewest armies whose {@link winChance}
   * reaches it — a bonus's missing captures together (each at the chance^(1/k)). Worst-case
   * sizings (finishing a player off, fog pressure, commander strikes) stay certain.
   */
  minWinChance?: number;
}

/** What the game profile needs beyond the board (rule 0p); every field optional. */
export interface PlanGameContext {
  /** Every player of the game (GameFeed ids, like the board's); default the players in sight. */
  players?: ProfilePlayer[];
  /** The turn being played. */
  turn?: number | null;
  /** Territories are still being picked. */
  picking?: boolean;
  /** GameFeed's `Fog` setting. */
  fog?: string;
  commanders?: boolean;
  /** Any card is in play. */
  cards?: boolean;
  /**
   * Every player started with the same territories and armies (#235: any distribution but a custom
   * scenario, a map's scenario distribution included): in a 1v1 (#119), or a free-for-all with no teams and every seated player still in
   * (#226), it turns the fog prior on ({@link EnemyIncomePrior}).
   */
  symmetricStart?: boolean;
  /**
   * #235: why the start may not have been even, when `symmetricStart` is false (`unevenStart` in
   * src/analysis/opponents.ts): a free-for-all's plan names it where it says the prior is off.
   */
  unevenStart?: string;
  /**
   * #166: per opponent, its income this turn simulated from the starts the award of picks proved
   * (`openingIncome`); with the fog prior on, that opponent's prior is the larger of it and my income.
   */
  opening?: ReadonlyMap<number, number>;
  /**
   * #419: the pace past winners set at this turn ({@link FogPace}, read from the map record by the tool): with the
   * fog prior on, thin evidence's upper bound is the larger of the prior and it.
   */
  mapPace?: FogPace;
  /**
   * GameFeed's `MoveOrder` (PLAN-TEAMS C3.6: under a cyclic order a joint capture says whose attack must
   * run first). Read only by the team report.
   */
  moveOrder?: string;
  /**
   * #178: the end-of-game settings the profile reads (`Game.endRules`): who the game ends with.
   * #270: and whether a surrendered or booted seat is played by an AI (else it is static, {@link staticSeats}).
   */
  endRules?: { aisSurrenderWhenOneHumanRemains?: boolean; surrenderedTurnIntoAI?: boolean; bootedTurnIntoAI?: boolean };
  /**
   * #164: when an opponent's Reinforcement card can first be in hand (the card clock), and what it
   * adds; absent when no Reinforcement card is in play or its armies are unknown.
   */
  reinforcement?: ReinforcementClock;
}

/**
 * #164: an opponent's Reinforcement card, from the card clock (`src/strategy/card-clock.ts`): the first
 * turn one can be in a hand (a player capturing every turn), the armies it adds, and the capturing
 * turns each further card takes (`null`: no further card, or unknown).
 */
export interface ReinforcementClock {
  firstTurn: number;
  armies: number;
  turnsPerCard: number | null;
}

/** #164: GameFeed fog levels that show every territory's owner (No, Light and Dense fog): income is exact. */
export const OWNERS_SHOWN_FOG: ReadonlySet<string> = new Set(['NoFog', 'LightFog', 'ModerateFog']);

export interface PlanInput {
  graph: MapGraph;
  board: BoardState;
  /** My player id. */
  me: number;
  /** Armies to deploy this turn (see {@link incomeFor}), card armies included. */
  income: number;
  /**
   * #253: the army cap's arithmetic (incomeDetail's `cap`) when the game has one: `income` is then
   * already the received figure. The fog prior and the standing read the income before the cut, and
   * rule 4e's cap fallback reads the cut itself. Absent: the old test (`armyCap` × `income`).
   */
  incomeCap?: ArmyCapIncome;
  /**
   * The part of `income` that comes from this turn's card plays (Reinforcement): it is not
   * earned again next turn, so `expected.nextIncome` leaves it out. Default 0.
   */
  cardArmies?: number;
  /**
   * The same player's view one turn earlier, when known: enemy stacks next to me
   * that grew since then project their growth into next turn's threat.
   */
  previousBoard?: BoardState;
  /**
   * #281: the territories a static seat (#270: out, no AI on it) held, by territory, with the player
   * who left them. `planTurn` sets it when it plans them as neutrals; a caller need not.
   */
  vacated?: ReadonlyMap<number, number>;
  /**
   * #417: for each territory fogged on `board`, the player who held it on the newest earlier board that
   * showed it (`foggedLastSeen` in plan/vacated.ts, over my board history). A static seat's fogged land is planned
   * as vacated from it however long it has been fogged. Absent: `previousBoard` alone is read.
   */
  foggedLastSeen?: ReadonlyMap<number, number>;
  /**
   * #226: my orders on the turn `previousBoard` was played (what warapp_submit_turn sent and cached):
   * a failed attack of mine counts its kills back into the defender's observed deploy
   * ({@link ObserveContext.myOrders}). Unknown orders change nothing.
   */
  previousOrders?: MyOrders;
  /**
   * #240: territories my attacks failed on repeatedly while their owner reinforced them
   * ({@link repulsedAttacks} over my board history and cached orders): a further attack on one is
   * sized for its defenders plus its owner's deploy there, or not made. Absent: no change.
   */
  repulsed?: readonly RepulsedTarget[];
  /**
   * The turn being planned, when known: `previousBoard` is then turn − 1's board, and the
   * observed-deploy rationale names the two turns.
   */
  turn?: number;
  /**
   * #303: my board income (card armies out, after the army cap) on earlier turns, from the cached
   * boards: with `turn`, the plan reports {@link TurnPlan.incomeTrend} and rule 0p.4 reads it.
   */
  incomeHistory?: readonly IncomePoint[];
  /**
   * Opponent tracks over my board history ({@link trackOpponents}, ending on `board`): an
   * opponent observed over at least {@link TRACKED_MIN_TURNS} turns gets its tracked income in
   * place of the single-turn observed figure.
   */
  tracks?: readonly OpponentTrack[];
  /** #382: the siege's memory kept for this game (src/siege-store.ts), read under `goal: 'siege'` with `turn`. */
  siegeMemory?: SiegeMemory;
  /**
   * #298: the bonuses I attempted to complete in this game (src/bonus-attempt-store.ts), read with `turn`:
   * after two failed attempts on consecutive turns a bonus is pushed all-in once or dropped as a target
   * (plan/bonus-attempts.ts). Absent: no change.
   */
  bonusAttempts?: BonusAttemptMemory;
  /**
   * #298, set by planTurn from `bonusAttempts` (callers leave it out): the bonuses pushed all-in this
   * pass (each missing member sized for its owner's deploy, or not taken) and those dropped as targets.
   */
  bonusPush?: { allIn: ReadonlySet<number>; dropped: ReadonlySet<number> };
  /**
   * #421, set by planTurn on a stockpile (callers leave it out): the contested bonuses pushed all-in as a spend
   * of the pile — every missing member a target (an opponent's included), sized for its owner's deploy or not
   * taken, the push capped at the payback horizon × the bonus's value (the armies already stand on the board).
   */
  stockpileAllIn?: ReadonlySet<number>;
  settings?: PlannerSettings;
  options?: PlanOptions;
  /** The game around the board, for the profile (rule 0p). */
  game?: PlanGameContext;
  /**
   * B2 (docs/PLAN-TEAMS.md): the truces in force with other players, resolved by warapp_plan_turn
   * from the agreement ledger, its watch flags and the trust. Only in a free-for-all; with teams or
   * two players they are ignored with a warning. Absent or empty, the plan is what it was without.
   */
  relations?: readonly PlanRelation[];
  /**
   * G2 (PLAN-TEAMS D3): the Sanctions on other players the decoder is sure of (`cardsInEffect`'s
   * `sanctionsOnOthers`): a figure read off the board is cut by them ({@link EnemyDeployEstimate.sanctioned}).
   */
  sanctions?: readonly { player: number; percentage: number; untilTurn: number }[];
  /**
   * #275 (b): opponents whose estimate a tripwire marked untrusted (src/analysis/tripwire.ts), each with
   * the deploy to size against instead — the caller's larger of what tripped it and my own income. Only
   * a border of a bonus I hold in full at the start of the turn is sized for it (never below the
   * estimate); every other border, and an explicit `options.enemyDeploy`, are unchanged. Absent or empty,
   * the plan is what it was without.
   */
  untrusted?: readonly { player: number; deploy: number }[];
  /**
   * #420 (P1 amended, owner decision of 2026-11-20): the quiet neighbours — opponents with 10 or more
   * observed contact turns at an attack rate of 0.1 or less and no attack on me since
   * (`quietNeighbour`, src/analysis/opponent-profile.ts). Each of their borders of mine is sized at the
   * stacks beside it plus their largest top-up seen (the track's `topUp`). Absent or empty, the plan is
   * what it was without.
   */
  quiet?: readonly { player: number; contactTurns: number; attacks: number }[];
  /**
   * #368: per-player incomes the user knows (warapp_plan_turn's `known_income`: what a player said in
   * chat, say), by GameFeed id: each replaces that opponent's estimate ({@link applyKnown}), a
   * Reinforcement card the clock adds kept on top. Ignored under `options.enemyDeploy`, and for a player
   * with none of its territories in view (a warning names it).
   */
  knownIncome?: readonly { player: number; income: number }[];
}

/** Why a truce's trust is `watch` ({@link PlanRelation.watch}). */
export type TruceWatchReason = 'broken' | 'cap-exceeded' | 'massing' | 'outgrowing' | 'their-notice' | 'endgame';

/**
 * B2: one truce as the planner reads it. `coveredMine` and `coveredTheirs` are the territories the
 * terms cover on each side; `state` `active` or `notice` binds (a notice until `endsTurn`, the first
 * turn it no longer binds), `broken` (T8: broken by them, `breach` saying how) does not. `trust`
 * `watch` (with its reasons) keeps every border's full hold (T3). `enforced` (T9): a Diplomacy card
 * the decoder is sure of — that player cannot attack me, nor I it, this turn, in any format
 * (`warapp_plan_turn` sets it from the board's active cards, PLAN-TEAMS D3; the ledger's field is
 * never read). `enforcedUntil`: the turn the card is gone by — when that is the next turn, the
 * player still counts for the next turn's look-ahead (#172); absent, the card is taken to last.
 */
export interface PlanRelation {
  player: number;
  coveredMine: readonly number[];
  coveredTheirs: readonly number[];
  state: 'active' | 'notice' | 'broken';
  endsTurn?: number;
  borderCap?: number;
  trust: 'clear' | 'watch';
  watch?: readonly TruceWatchReason[];
  enforced?: boolean;
  /** T9: the turn the enforcing card is gone by (D3). */
  enforcedUntil?: number;
  /** D3: a relation that is only a card in effect (no agreement in the ledger). */
  card?: 'Diplomacy';
  /** The ledger's agreement id, for the report. */
  agreement?: string;
  /** In notice: who gave it. */
  noticeBy?: 'me' | 'them';
  /** T8: what broke it — the term, the turn and the board's evidence. */
  breach?: { term: string; turn: number; evidence: string; territories: readonly number[] };
}

/** B2: one truce as the plan reports it. */
export interface PlanRelationView {
  player: number;
  agreement?: string;
  /** `ignored`: not in a free-for-all; `over`: its notice has run; `not-a-foe`: a teammate or me. */
  state: 'active' | 'notice' | 'broken' | 'over' | 'ignored' | 'not-a-foe';
  /** Whether the plan honours it this turn (T1, T2, T4, T5). */
  honoured: boolean;
  enforced: boolean;
  /** T9 (D3): the turn the Diplomacy card enforcing it is gone by. */
  enforcedUntil?: number;
  /** D3: only a card in effect, no agreement. */
  card?: 'Diplomacy';
  trust: 'clear' | 'watch';
  flags: TruceWatchReason[];
  endsTurn?: number;
  /** T2: my covered borders sized for the partner's visible stacks with no deploy, ascending. */
  relaxed: number[];
  /** T3: my covered borders facing only the partner that keep the full hold, and why. */
  fullHold: { territory: number; why: 'commander' | 'value' | 'watch' }[];
  /**
   * The armies the relaxed holds need less this turn: per relaxed border, what its full hold needs
   * beyond the armies there less what the truce hold needs — only where the full hold would have
   * been funded (not a border this plan concedes, nor one rule 1a's economic test or my income
   * refuses the full hold); at most my income.
   */
  armiesFreed: number;
  /** T5: the armies moved back from a covered border to keep at most the cap there. */
  capMoved?: { from: number; to: number; armies: number }[];
  breach?: PlanRelation['breach'];
  /**
   * T6: what a break would cost this turn — the partner's whole estimated deploy on any territory of
   * its beside my costliest covered territory (covered by the truce or not) and an attack on mine from
   * there, against this plan's orders, on the turn simulator. `null` when the truce does not bind, is
   * enforced, or no stack of the partner in view stands beside a covered territory of mine.
   */
  lossIfBroken: TruceBreakLoss | null;
}

/** T6: one break, carried out (see {@link PlanRelationView.lossIfBroken}). */
export interface TruceBreakLoss {
  /** The partner's covered territory it deploys on and attacks from. */
  from: number;
  /** My covered territory it attacks. */
  to: number;
  /** Its whole deploy estimate (the planner's, as every hold is sized for). */
  deploy: number;
  /** The armies that attack (its stack and the deploy, less the guard). */
  attackers: number;
  /** Territories I would hold after this plan that the break leaves me without, ascending. */
  territories: number[];
  /** My armies lost against this plan going unanswered. */
  armies: number;
  /** Bonuses I would hold after this plan and no longer hold, ascending by id. */
  bonuses: { id: number; value: number }[];
  /** Their values summed: the income lost. */
  bonusValue: number;
  commanderLost: boolean;
  /** When the first mover is unknown and only one move order costs this: who has to move first. */
  firstMover?: 'me' | 'partner';
  /** `false` under luck or weighted rounding: the battle was resolved at its expectation. */
  exact: boolean;
}

/** B2 (T7): advice the plan gives about an agreement; the planner itself sends nothing. */
export interface PlanAdvice {
  kind: 'give-notice';
  player: number;
  agreement?: string;
  why: string;
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
  /**
   * Attacks only: the exact probability this attack captures its target as the board stands
   * (every defender dies, an attacker survives) at the game's kill rates, luck and rounding.
   * 1 when certain. A softener of a combined capture fails by design (0).
   */
  winChance?: number;
  /**
   * #274: my commander goes along (the order option of #165: encoding unverified live). Only a
   * transfer one step toward safety (plan/commander.ts); it may carry no armies at all.
   */
  commander?: true;
}

/** A card the submission should play for the plan to work (the planner itself never plays cards). */
export type CardAdvice = 'order-priority';

export interface TurnPlan {
  /** The goal planned for: the explicit one, else (adapting) the profile's, else `balanced`. */
  goal: PlanGoal;
  /** #382: under `goal: 'siege'` with a target found, the siege's state this turn (plan/siege.ts). */
  siege?: SiegeReport;
  /** #298: what the plan did about each bonus the attempt memory names (all-in or dropped). Absent with none. */
  bonusPush?: BonusPushEntry[];
  /**
   * #361: the single-army jabs among `moves` (0% luck, straight rounding only; plan/jabs.ts): each
   * kills round(1 × the offensive kill rate) and loses its army. Attrition, never a capture. Absent with none.
   */
  jabs?: Jab[];
  /** The game profile (rule 0p), computed on every plan. */
  profile: GameProfile;
  /** Sorted by territory id; sums to the income whenever I own a territory. */
  deploys: PlannedDeploy[];
  /** In the order to send them (rule 7, #127): the protected order, early, sure, filler, last. */
  moves: PlannedMove[];
  expected: {
    captures: number[];
    bonusesCompleted: number[];
    /**
     * Next turn's income if every territory the plan keeps and captures is held — conceded
     * borders included (#109: see `nextIncomeIfConcededFall`). One income rule ({@link boardIncome}).
     * #253: under an army cap it is this turn's capped income plus what the plan's captures gain, not
     * a re-run of the cap (next turn's cut depends on the armies spent and on the larger income).
     */
    nextIncome: number;
    /**
     * Next turn's income if every border the plan concedes falls (#109): the same income rule
     * over the holdings after the plan less `conceded`. Present only when it differs from
     * `nextIncome` or a bonus is at risk.
     */
    nextIncomeIfConcededFall?: number;
    /**
     * The positive bonuses complete after the plan (held at the start or completed this turn)
     * with at least one member it concedes, by bonus id; `conceded` lists those members.
     * Present together with `nextIncomeIfConcededFall`.
     */
    bonusesAtRisk?: BonusAtRisk[];
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
  /**
   * `'order-priority'` when a withdrawal is planned (it must run before the border falls), or
   * when a commander strike is planned, my commander's territory is threatened and I hold the card
   * (my attacks then resolve first).
   */
  cardAdvice: CardAdvice | null;
  /**
   * Captures made by a combined (multi-source) attack sequence (rule 3a), sorted:
   * their attacks must run in the planned order, and only at 0% luck.
   */
  multiSourceCaptures: number[];
  /**
   * The frontier this plan leaves (rule 4d, #71): my territories (captures included) next to one
   * I do not hold, those next to a visible enemy, the deploys those need next turn to hold at the
   * expected enemy deploy, and the next income that pays for them.
   */
  frontier: FrontierBudget;
  /** #297: the gate budget, in a 1v1 with the opponent in contact; absent otherwise. */
  gates?: GateBudget;
  /**
   * The offensive options this plan considered (#72): each bonus break (its cheapest visible
   * member, "probable" when the opponent tracker inferred the bonus), each counter-attack on a
   * stack that shrank fighting me, the strike stack the spare deploys built and each attack from it
   * (#102). `kind` is `strike` for the stack itself and `strike-attack` for each attack from it. `cost` is the capture's armies (what the final orders send when made; the strike
   * stack itself: the armies deployed), `value` its worth in income terms (the strike stack: the
   * strongest opponent's income; a strike attack: the bonus it breaks or retakes, else 0), `taken`
   * whether the plan makes it (a break: whether any member of the bonus falls this turn, `target`
   * then being that member; the strike stack: whether it attacks this turn), `why` the reason.
   */
  offence: OffenceEntry[];
  /**
   * Each move's place in the schedule (#127), parallel to `moves`: `protected` (the one order
   * Order Priority protects), `early` (withdrawals, transfers into a border the enemy can break),
   * `sure`, `filler`, and `last` (an attack the opponent can answer first: its stack can attack
   * before mine lands, or it can reach a contested neutral). Read by the card advice (#163: Order
   * Delay goes above every order that is not urgent when a `last` attack is planned).
   */
  moveSlots?: MoveSlotName[];
  /**
   * #167: each attack on a player's territory judged by its exchange (`classifyExchange`): kills,
   * losses and capture against its defenders as they stand, after its owner's estimated deploy
   * there, and after its owner's whole income, with a label. Absent when no attack hits a player.
   */
  exchanges?: ExchangeView[];
  /**
   * #179: estimated turns to eliminate each visible opponent, by player id (absent with none in
   * view). Present for every opponent with a visible territory my land can reach.
   */
  eta?: { eliminate: Record<number, EliminateEta> };
  /**
   * #179: the exits of each visible opponent down to {@link FEW_TERRITORIES} or fewer — none
   * whose land borders the fog (it may hold more there) unless it is being finished off.
   */
  exits?: OpponentExits[];
  /**
   * #218: the main front (rule 2f: the biggest enemy stack next to me against my biggest stack
   * beside it, `mainFront`) forecast with my whole income and the opponent's estimated income
   * deployed there every turn — the same computation as the game outlook's front, which
   * warapp_plan_turn feeds it for the turn being played. Present only when the front outlook ran.
   */
  front?: FrontView;
  /**
   * #303: my income over the last turns (at most five, this one last), its least-squares slope per turn
   * and whether it is flat (#312's rule). Present only with `PlanInput.incomeHistory` and the turn known.
   */
  incomeTrend?: IncomeTrend;
  /** B2: each truce given in the input, as the plan treated it. Absent without relations. */
  relations?: PlanRelationView[];
  /** B2 (T7): advice about the agreements (give notice). Absent when there is none. */
  advice?: PlanAdvice[];
  /**
   * PLAN-TEAMS C3: the team section, advisory. `sharedBonuses` (C3.3): each positive bonus a
   * teammate and I both hold members of, and who is nearer to holding it. Absent outside a team
   * game and when there is nothing to report.
   */
  team?: TeamView;
}

/** #218: a front forecast: the pair, the incomes deployed there every turn, and the outcome. */
export interface FrontView {
  from: number;
  at: number;
  mine: number;
  theirs: number;
  player: number;
  myIncome: number;
  theirIncome: number;
  outcome: BorderOutcome;
  turn: number | null;
}

/**
 * Turns to eliminate one opponent (#179): at least the steps from my land to its farthest visible
 * territory (a multi-source search), and enough turns that what its territories need — each one's
 * capture cost now, plus its deploy for that many turns — fits my movable armies plus my income for
 * as many turns. `turns` is null when that is not within {@link ETA_HORIZON} turns (its deploy grows
 * faster than my income can pay). `atLeast` when its land borders the fog (it may hold more there).
 */
export interface EliminateEta {
  turns: number | null;
  atLeast: boolean;
  /** Steps from my nearest territory to its farthest visible one. */
  distance: number;
  /**
   * The armies that takes, at `turns` (at `distance` when `turns` is null); null when no attack
   * can take what its deploy piles up by then (no finite capture cost).
   */
  armies: number | null;
}

/** An opponent with at most this many visible territories has its exits listed (#179). */
export const FEW_TERRITORIES = 3;

/**
 * Where an opponent down to a few territories can go this turn (#179), per stack: its own
 * neighbours, the visible neutrals its movable armies plus the deploy that can reach it take, and
 * my territories that fall to that once this plan's orders are in. Sorted by id.
 */
export interface OpponentExits {
  player: number;
  stacks: { territory: number; movable: number; own: number[]; neutrals: number[]; mine: number[] }[];
}

/** The most turns {@link EliminateEta} looks ahead. */
export const ETA_HORIZON = 30;

export interface ExchangeView extends Exchange {
  from: number;
  to: number;
  armies: number;
  player: number;
}

/** The names of {@link MoveSlot}, earliest first. */
export type MoveSlotName = 'protected' | 'early' | 'sure' | 'filler' | 'last';
export const SLOT_NAMES: readonly MoveSlotName[] = ['protected', 'early', 'sure', 'filler', 'last'];

export interface OffenceEntry {
  target: number;
  kind: 'break' | 'strike' | 'strike-attack' | 'counter';
  cost: number;
  value: number;
  taken: boolean;
  why: string;
}

export interface BonusAtRisk {
  bonusId: number;
  name: string;
  value: number;
  /** Its members the plan concedes, sorted. */
  conceded: number[];
}

/**
 * The positive bonuses complete over `after` (the holdings after a plan) with at least one
 * member in `conceded`, sorted by id (#109): what the plan's concessions put at risk.
 */
export function bonusesAtRisk(g: MapGraph, after: ReadonlySet<number>, conceded: ReadonlySet<number>): BonusAtRisk[] {
  if (!conceded.size) return [];
  return g.map.bonuses
    .filter((b) => b.value > 0)
    .map((b) => ({ b, ts: bonusTerritories(g, b.id) }))
    .filter(({ ts }) => ts.length > 0 && ts.every((t) => after.has(t)) && ts.some((t) => conceded.has(t)))
    .sort((x, y) => x.b.id - y.b.id)
    .map(({ b, ts }) => ({
      bonusId: b.id,
      name: b.name,
      value: b.value,
      conceded: ts.filter((t) => conceded.has(t)).sort(byNum),
    }));
}

/**
 * #297: in a 1v1, every border of mine facing the opponent is a gate, each sized for its stack beside it plus its
 * whole deploy (the deploy lands where it chooses, so each gate's worst case is the same floating deploy).
 */
export interface GateBudget {
  /** The opponent the gates face. */
  player: number;
  /** Each gate: what it needs to hold next turn, and what stands on it after this plan. */
  gates: { id: number; needs: number; armies: number; conceded?: true }[];
  /** What the gates need together. */
  need: number;
  /** What stands on them after this plan. */
  onGates: number;
  /**
   * What each gate still lacks, summed (armies on one gate do not defend another): rule 4d's hold cost on the gates,
   * plus what the gates it concedes lack (a conceded gate is still a way in).
   */
  deficit: number;
  /** The next income that can add to them ({@link FrontierBudget}'s figure). */
  income: number;
  /** deficit − income, at least 0. */
  short: number;
}

export interface FrontierBudget {
  borders: number;
  enemyBorders: number;
  holdCost: number;
  /**
   * The next income the plan counts on (#128): `expected.nextIncome` without the bonuses broken
   * by the borders it concedes, and without those of a held bonus still contested (warned about
   * as short, not conceded). It can be below `expected.nextIncomeIfConcededFall`, which leaves
   * out only the conceded borders.
   */
  income: number;
}

/** A probability as a whole percent, for the rationale. */

/** The combat model's view of the planner settings. */
export function combatSettings(settings: PlannerSettings = {}): CombatSettings {
  return {
    offensiveKillRate: settings.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE,
    defensiveKillRate: settings.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE,
    luck: luckFraction(settings.luckModifier),
    ...(settings.roundingMode !== undefined ? { rounding: settings.roundingMode } : {}),
  };
}

/** A `minWinChance` option clamped to [0.5, 1] (default 1). */
export function minWinChanceOf(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0.5, v));
}

/**
 * The win chance an ordinary capture is sized for when `minWinChance` is not given (#126): with
 * luck on, certainty can cost several times a likely win (a 2-army neutral needs 14 armies to be
 * certain at 75% luck, 5 for 95%), so {@link LUCK_WIN_CHANCE}; with no luck certainty is cheap
 * (weighted-random rounding: one army more than straight rounding), so 1.
 */
export const LUCK_WIN_CHANCE = 0.95;
/**
 * The most a hold may fall to the attack it is sized against (#126): with luck or weighted-random
 * rounding a stack falls to an attack below its exact `armiesToTake` some of the time, so a hold
 * is judged against the fewest attackers that win more often than this.
 */
export const HOLD_FALL_CHANCE = 0.05;
/**
 * Marks around a rationale clause citing a two-step hold (#172): `OPEN <territory> SEP <clause>
 * SEP <fallback> CLOSE`, resolved at the end of the plan (the clause if the hold still applies, the
 * fallback if not).
 */
export const CITE_OPEN = '\u0001';
export const CITE_SEP = '\u0002';
export const CITE_CLOSE = '\u0003';
export const CITE_RE = /\u0001(\d+)\u0002([^\u0002\u0003]*)\u0002([^\u0003]*)\u0003/g;
export function defaultMinWinChance(settings: PlannerSettings = {}): number {
  return luckFraction(settings.luckModifier) > 0 ? LUCK_WIN_CHANCE : 1;
}

/** Certain sizes by settings and defenders: each is a search over the exact model. */
const certainMemo = new Map<string, number | null>();

/**
 * Armies to send at a territory held by `defenders`; `null` when it cannot be taken. With
 * `minWinChance` 1 (default) the certain sizing (#126): the fewest armies whose exact
 * {@link winChance} is 1 — every roll and every rounding takes it (`armiesToTake` at 0% luck under
 * straight rounding; one army more under weighted-random rounding; the kills the luck-free share
 * guarantees, {@link guaranteedKills}, with luck). Below 1, the fewest armies whose
 * {@link winChance} reaches it.
 */
export function captureCost(defenders: number, settings: PlannerSettings = {}, minWinChance = 1): number | null {
  const combat = combatSettings(settings);
  if (minWinChance < 1) return armiesForChance(defenders, minWinChanceOf(minWinChance), combat);
  if (!combat.luck && combat.rounding !== 'WeightedRandom') return armiesToTake(defenders, combat);
  const key = `${combat.offensiveKillRate}|${combat.defensiveKillRate}|${combat.luck}|${combat.rounding}|${defenders}`;
  if (!certainMemo.has(key)) {
    if (certainMemo.size > 50_000) certainMemo.clear();
    certainMemo.set(key, armiesForChance(defenders, 1, combat));
  }
  return certainMemo.get(key)!;
}

/**
 * How many attacked territories fall for sure when their owner answers with its best
 * response: one deploy budget `deploy`, split over its territories to save as many as it
 * can. `saveCosts[i]` is the deploys target i needs to survive its attack (the most
 * defenders the attack takes, minus its armies, plus one; 0 when it survives unreinforced).
 * Saving the cheapest first is optimal: any j saved targets cost at least the j cheapest
 * save costs, so j can be saved exactly when those fit the budget.
 */
export function guaranteedFalls(saveCosts: readonly number[], deploy: number): number {
  let left = deploy;
  let saved = 0;
  for (const c of [...saveCosts].sort((a, b) => a - b)) {
    if (c > left) break;
    left -= c;
    saved++;
  }
  return saveCosts.length - saved;
}

/**
 * {@link guaranteedFalls} when not all of the owner's deploy can reach every target (#179: Local
 * Deployment pays a bonus only into its own territories): `reaches[i]` is the most it can deploy on
 * target i. A target whose save costs more than that falls for sure; the rest share the one budget
 * `deploy`, cheapest first. An upper bound on what it saves (its pools may not cover the cheapest
 * set together), so the falls stay sure.
 */
export function guaranteedFallsReaching(saveCosts: readonly number[], reaches: readonly number[], deploy: number): number {
  const savable = saveCosts.filter((c, i) => c <= (reaches[i] ?? deploy));
  return saveCosts.length - savable.length + guaranteedFalls(savable, deploy);
}

/** One visible opponent's estimated deploy next turn and how it was reached. */
export interface EnemyDeployEstimate {
  playerId: number;
  /** max(base + bonusIncome, MIN_ENEMY_DEPLOY, base) — never below what it visibly holds; that floor on the opening board. */
  estimate: number;
  /** The territories it visibly owns (owner shown, armies or not): what `base` is computed from. */
  held: number;
  /**
   * Its base income: MinimumArmyBonus, or (BonusArmyPer on) its visible
   * territories / BonusArmyPer when larger.
   */
  base: number;
  /** Value of the bonuses this player visibly holds in full. */
  bonusIncome: number;
  /** Its largest visible stack next to one of my territories (else its largest visible stack): what can move, not what it earns. */
  largestStack: number;
  /** Every visible territory holds the same army count: no one has deployed yet. */
  opening: boolean;
  /**
   * Its deploy as observed since the previous board ({@link observeDeploy}), at most
   * {@link EnemyDeployEstimate.observedCap}; `null` without a previous board.
   */
  observed: number | null;
  /** The observed deploy before the plausibility cap; `null` without a previous board. */
  observedRaw: number | null;
  /**
   * The most it could earn on this board (issue #69): what the territories it could hold pay
   * ({@link EnemyDeployEstimate.couldHold}) plus every positive bonus it could possibly hold (none of
   * its territories visibly held by someone else, owner-only included); `null` without a previous board.
   */
  observedCap: number | null;
  /** Which territories the observation counted and skipped; `null` without a previous board. */
  observation: DeployObservation | null;
  /**
   * Its tracked income ({@link OpponentTrack.income}) when its track has at least
   * {@link TRACKED_MIN_TURNS} observed turns; it then replaces `observed` in the estimate.
   * `null` otherwise.
   */
  tracked: number | null;
  /**
   * #235 1c: the track's newest observed turn, when it ends on this board and #123's bound cut
   * armies that arrived beside the fog (or joined a capture) as moves: `observed` is its reading,
   * `reading` the same turn with every ambiguous army a deploy (at most what it could earn that turn),
   * `expected` the bound's base (twice it). A label, never income: the estimate keeps its figure, and
   * the warning names `reading` for warapp_check_plan's `enemy_deploy`. `null` otherwise.
   */
  newestCut: { from: number; to: number; observed: number; reading: number; expected: number | null } | null;
  /** The observed turns behind `tracked` (`from` turns, oldest first); empty when `tracked` is `null`. */
  trackedTurns: number[];
  /**
   * The most it could earn on this board: what the territories it could hold pay plus every
   * positive bonus none of whose territories someone else visibly holds (the same figure as
   * `observedCap`, given or not a previous board). #226: with per-territory income (BonusArmyPer)
   * the territories it could hold are its visible ones and every one whose owner the board hides
   * ({@link EnemyDeployEstimate.couldHold}), so a prior or an observation is not capped at the base
   * its few visible territories pay; without it, the base.
   */
  couldEarn: number;
  /**
   * #226: the territories it could hold on this board — its visible ones plus every one whose owner
   * the board does not show — what `couldEarn` counts at the per-territory rate.
   */
  couldHold: number;
  /**
   * The fog prior (#119), when asked for ({@link EnemyIncomePrior}: a symmetric-start 1v1, or #226 an
   * even-start free-for-all with no teams) and it borders the fog: my own income, or its simulated opening income when given and larger (#166), capped
   * at `couldEarn`; else `null`.
   */
  prior: number | null;
  /**
   * #235: the prior shrunk toward its own evidence, when it has a usable track and the prior is above
   * it: `prior` (the figure above) keeps `weight` of its lead over `toward` (its tracked income, or its
   * visible income when larger), `weight` = {@link PRIOR_EVIDENCE_TURNS} / (PRIOR_EVIDENCE_TURNS
   * + `turns` × `share`), where `turns` is its run of consecutive observed turns up to the newest and
   * `share` (#294) the mean frontier coverage of those turns ({@link FrontierCoverage}: the evidence is
   * the sum of each turn's share); a turn that carries none (a track built by hand) counts the part of
   * its edge in view on this board (the territories next to its visible ones, not its own, whose owner
   * shows), as before #294. The estimate is then `figure`. `null` otherwise.
   */
  priorBlend: { prior: number; toward: number; turns: number; share: number; weight: number; figure: number } | null;
  /**
   * #294: how much of its frontier its tracked income was read from ({@link trackCoverage} over the
   * track's income window); `null` without a usable track or when its turns carry no coverage.
   */
  coverage: TrackCoverage | null;
  /**
   * #368 (owner decision of 2026-11-19: choose the middle until we learn otherwise): the evidence behind
   * its tracked figure was thin — read from under {@link LOW_COVERAGE} of its frontier (`coverage`), or its
   * tracked figure rose two turns running (`rising`: as of each of its last three consecutive observed
   * turns, {@link risingTracked}). `lower` is the most of its visible income, `tracked` and the trend's
   * next step (`trend`: the newest figure plus the mean rise of the last two turns); `upper` the fog prior
   * (`prior`, whole: never shrunk toward the track), else `couldEarn`, never below `lower`; `midpoint` the
   * middle of the two (rounded up); `toward` what the evidence gives without thin evidence (`tracked`, or
   * #235's prior shrunk toward it, `priorBlend`), never below `lower`. Under {@link LOW_COVERAGE} the
   * estimate is `figure` = `toward` + `weight` × (`midpoint` − `toward`), `weight` = 1 − coverage ÷
   * LOW_COVERAGE: the midpoint with none of its frontier read, moving to `toward` as the coverage nears
   * LOW_COVERAGE (so it does not jump there), whether that raises or lowers it (it replaced #294's floor of
   * `tracked` × 1.5). A rising track read from more of its frontier has `weight` 0 and sets `figure` =
   * `toward` only when above the estimate otherwise. All at most `couldEarn`. `null` otherwise, with an
   * exact income, and without a usable track. A known income (`known`) replaces it.
   */
  thinEvidence?: {
    coverage: number | null;
    rising: number[] | null;
    tracked: number;
    prior: number | null;
    trend: number | null;
    lower: number;
    upper: number;
    midpoint: number;
    toward: number;
    weight: number;
    figure: number;
    /** #419: the past winners' pace that set `upper` above the prior (its figure, capped and scaled as the prior). */
    pace?: { figure: number; basis: FogPace['basis']; afterTurn: number; games: number; ratio?: number };
  } | null;
  /**
   * #235: in a free-for-all (`EnemyIncomePrior.opponents`), the cap on the prior: its visible
   * territories and bonuses plus an even share of the territories the board hides and of the bonuses
   * it could still hold; `null` otherwise (the prior is capped at `couldEarn`).
   */
  priorCap: number | null;
  /** #235: a territory next to one of its visible ones shows no owner (the fog prior's test). */
  fogBeside: boolean;
  /**
   * `'tracked'` when the tracked income beat the visible-bonus figure, else (no usable track)
   * `'observed'` when the single-turn observed figure did, else `'visible'` — unless the fog prior beat
   * all of them: `'prior'`. With a usable track the observed figure never counts (#235 1c: a newest turn
   * its bound cut is labelled, {@link EnemyDeployEstimate.newestCut}).
   */
  source: 'visible' | 'observed' | 'tracked' | 'prior' | 'exact';
  /**
   * #164: its income exactly — base plus every bonus it holds — when the game's fog shows every
   * territory's owner ({@link OWNERS_SHOWN_FOG}) and this board does; the estimate is then this
   * figure (`source` `'exact'`), observations aside (only the army cap, Sanctions and a
   * Reinforcement card are unknown). `null` otherwise, and on the opening board.
   */
  exact: number | null;
  /**
   * #164: a Reinforcement card it may hold (the card clock), added to `estimate`: its armies and the
   * turn it became due. `null` before then, after a deployment above its income was seen (until the
   * next card can be due), or without a clock.
   */
  card: { armies: number; due: number } | null;
  /** #164: the latest turn a deployment above its income was seen (a Reinforcement card played); else `null`. */
  cardPlayed: number | null;
  /**
   * G2 (PLAN-TEAMS D3): the Sanctions in effect on it that the decoder is sure of. `applied`: the
   * estimate's income (`before`, card left out) was cut by them to `estimate` less its card — only
   * when the figure comes from the board (`visible`, `exact`); an observed, tracked or prior figure
   * may already carry the cut, or stands for an income guessed apart from it, so it is left whole
   * and a warning says so. Absent with no Sanctions on it.
   */
  sanctioned?: { percentages: number[]; untilTurn: number; before: number; applied: boolean };
  /** #332: a figure read off the board in a commerce game with a rising army price: the gold it earns, and the price. */
  armyPrice?: { gold: number; multiplier: number };
  /** #368: the income the user supplied for it (`PlanInput.knownIncome`), and the estimate's income it replaced. */
  known?: { income: number; was: number };
  /**
   * #444: its prior scaled by the incomes other players stated (`EnemyIncomePrior.stated`): `full` the
   * prior unscaled, `scaled` the figure `prior` now holds. With no usable track (#368's midpoint, applied
   * to an untracked opponent while the scale applies) and the scaled prior above what is in view
   * (`lower`: its visible or observed figure), it is sized at `midpoint`, the middle (rounded up);
   * `midpoint` is `null` otherwise. Absent when nothing was scaled.
   */
  stated?: { full: number; scaled: number; lower: number; midpoint: number | null };
}

/**
 * #419 (owner decision of 2026-11-20): the pace past winners set, read from my finished games' map records
 * (src/lessons-store.ts). `map`: the median past winner's income after `afterTurn` completed turns on this map
 * (`income`), over `games` (3 or more) of this format and settings; `format`: too few on this map, so the median
 * of winner ÷ mine then over every map's games of this format (`ratio`), which scales my income.
 */
export interface FogPace {
  basis: 'map' | 'format';
  afterTurn: number;
  games: number;
  income?: number;
  ratio?: number;
}

/** #419: the income a pace stands for, given my income. */
export function fogPaceIncome(p: FogPace, myIncome: number): number {
  return p.basis === 'map' ? Math.max(0, Math.floor(p.income ?? 0)) : Math.ceil(Math.max(0, myIncome) * (p.ratio ?? 0) - 1e-9);
}

/**
 * The fog prior (#119): in a 1v1 that started even (the same territories and armies each), an
 * opponent I cannot see all of — one bordering the fog — is assumed to earn at least what I earn
 * (`myIncome`, card armies out), capped at what it could earn on the board. Observed deploys are
 * lower bounds under fog: the evidence (a finished game's true deploys against the estimate)
 * read 2–3× low without it. A prior, never an observation; the warning says so.
 */
export interface EnemyIncomePrior {
  myIncome: number;
  /**
   * #226: the game it applies to: `1v1` (#119), or `ffa` — a free-for-all that started even, with no
   * teams and every seated player still in, where each opponent beside the fog gets the same prior
   * (peer-paced on my own income, as `peerPace` in src/analysis/outlook.ts paces an unmeasured one).
   * Default `1v1`.
   */
  format?: '1v1' | 'ffa';
  /**
   * #166: per player, its income this turn from the pick advisor's opening simulation run from
   * the starts the award of picks proved (`openingIncome`); for that player the prior figure is the
   * larger of it and `myIncome` (still capped, still only beside the fog, still only raising).
   */
  opening?: ReadonlyMap<number, number>;
  /**
   * #235: in a free-for-all, how many opponents share what the board hides: the prior is capped at
   * an even share of the hidden territories and of the bonuses each could still hold, as `peerPace`'s
   * ceiling shares the map, not all of it for every one.
   */
  opponents?: number;
  /**
   * #368: the players out of a free-for-all whose seats no AI plays (#270), by id with the state that
   * put each out: their share of what the board hides is split among the `opponents` still playing,
   * so a player out no longer turns the prior off. Absent with none.
   */
  out?: readonly { id: number; state: string }[];
  /**
   * #444: the incomes stated in chat (`known_income`) applied this turn — players in view — whose mean
   * is below `mine` (`myIncome`): every other opponent's prior is scaled by `ratio` (their mean ÷ mine),
   * never below what is in view or tracked, never above the prior unscaled. Absent otherwise.
   */
  stated?: { players: readonly { id: number; income: number }[]; mine: number; ratio: number };
  /**
   * #419: the pace past winners set at this turn ({@link FogPace}): while its frontier is mostly hidden (#368's
   * thin evidence), an opponent's upper bound is the larger of the prior and this pace (capped, scaled and
   * only beside the fog as the prior is). It never moves the prior itself. (Not docs/PLAN-PROFILES.md E1's
   * planned per-player `pace`.)
   */
  winnerPace?: FogPace;
}

// #133 follow-up: fog, frontier coverage, hold/repulse evidence and the observed deploy live in observe.ts.
import { observeDeploy, ownerShown, trackCoverage, visibleState, type DeployObservation, type RepulsedTarget, type TrackCoverage } from './observe.js';

/**
 * The army count every visible player territory holds, when they all hold the same one (the
 * initial allotment). Neutrals are left out (#128): their stacks are not the starting stacks on
 * ordinary maps, so counting them meant this never fired. Only the first turn can be the opening
 * board (#128): with a previous board, or a known turn past the first, equal stacks are a
 * coincidence of the mid-game, and reading them as the opening would drop visible bonuses.
 */
export function openingArmies(
  g: MapGraph,
  board: BoardState,
  when: { turn?: number | null | undefined; previous?: BoardState | undefined } = {},
): number | null {
  if (when.previous !== undefined || (when.turn !== null && when.turn !== undefined && when.turn > 1)) return null;
  const counts = new Set<number>();
  for (const t of board.territories)
    if (g.territoryById.has(t.territoryId) && t.armies !== null && t.owner.kind === 'player') counts.add(t.armies);
  return counts.size === 1 ? [...counts][0]! : null;
}

/**
 * #368: an opponent's tracked figure as of each of its last three consecutive observed turns — the most
 * it was seen to earn (`earned`) over that turn and the two before it, the tracker's max-observed window —
 * when it rose on both steps; else `null` (fewer than three consecutive turns, or a step not a rise).
 */
export function risingTracked(turns: readonly Pick<ObservedTurn, 'from' | 'earned'>[]): number[] | null {
  const n = turns.length;
  if (n < 3) return null;
  for (let i = n - 2; i < n; i++) if (turns[i]!.from !== turns[i - 1]!.from + 1) return null;
  const asOf = (i: number) => Math.max(...turns.slice(Math.max(0, i - 2), i + 1).map((x) => x.earned));
  const series = [asOf(n - 3), asOf(n - 2), asOf(n - 1)];
  return series[0]! < series[1]! && series[1]! < series[2]! ? series : null;
}

/**
 * Per-opponent enemy deploy estimates, one per visible enemy player (sorted by
 * id): base income plus the bonuses that player visibly holds in full, never
 * below max({@link MIN_ENEMY_DEPLOY}, base income). Its stack next to me does not
 * limit it — income held in plain view can all be deployed on my border, however
 * small the stack there. Bonuses in the fog are unseen, so this is what the
 * visible board supports. On the opening board (every visible player territory holds
 * the same count, with no previous board and `when.turn` unknown or the first) every
 * opponent gets the floor.
 */
export function enemyDeployEstimates(
  g: MapGraph,
  board: BoardState,
  me: number,
  settings: PlannerSettings = {},
  previous?: BoardState,
  tracks?: readonly OpponentTrack[],
  prior?: EnemyIncomePrior,
  when: {
    turn?: number | null;
    fog?: string | undefined;
    reinforcement?: ReinforcementClock | undefined;
    /** #226: my orders on the turn between `previous` and `board` ({@link ObserveContext.myOrders}). */
    previousOrders?: MyOrders | undefined;
  } = {},
): EnemyDeployEstimate[] {
  const owner = new Map<number, number>();
  const armies = new Map<number, number>();
  const seenNow = new Map<number, TerritoryState>();
  for (const t of board.territories) if (g.territoryById.has(t.territoryId)) seenNow.set(t.territoryId, t);
  // Owners count whatever the armies: an owner-only territory (light fog) is visibly held, so
  // it counts toward base income and the bonuses held in full. Only stacks need the armies.
  for (const t of board.territories) {
    if (!g.territoryById.has(t.territoryId) || t.owner.kind !== 'player') continue;
    owner.set(t.territoryId, t.owner.playerId);
    if (t.armies !== null) armies.set(t.territoryId, t.armies);
  }
  const players = [...new Set([...owner.values()].filter((p) => p !== me))].sort(byNum);
  const opening = openingArmies(g, board, { turn: when.turn, previous }) !== null;
  // #164: under No, Light and Dense fog every owner shows, so income is exact — when this board
  // shows every territory's owner too (the setting is a name, never compared by position).
  const ownersAll =
    when.fog !== undefined &&
    OWNERS_SHOWN_FOG.has(when.fog) &&
    g.map.territories.every((t) => ownerShown(seenNow.get(t.id)) !== undefined);
  const minimum = Math.max(0, Math.floor(settings.baseIncome ?? DEFAULT_BASE_INCOME));
  const per = settings.bonusArmyPer ?? 0;
  // #418: my income on the board (cards aside) and my armies in view, against which a rising track is weighed.
  const myLand = new Set<number>();
  let myArmies = 0;
  for (const [t, p] of owner)
    if (p === me) {
      myLand.add(t);
      myArmies += armies.get(t) ?? 0;
    }
  const myBoardIncome = boardIncome(g, myLand, { base: minimum, per }).total;
  return players.map((playerId) => {
    // Its visible territories are a lower bound on what it holds, so on its
    // per-territory income too.
    const theirs = new Set<number>();
    for (const [t, p] of owner) if (p === playerId) theirs.add(t);
    const held = theirs.size;
    const base = territoryIncome(held, minimum, per);
    // The one income rule (#85) over what it visibly holds; `bonusIncome` is what it adds to the base.
    const bonusIncome = boardIncome(g, theirs, { base: minimum, per }).total - base;
    let adjacent = 0;
    let any = 0;
    for (const [t, p] of owner) {
      if (p !== playerId) continue;
      const a = armies.get(t);
      if (a === undefined) continue;
      any = Math.max(any, a);
      if (neighborsOf(g, t).some((n) => owner.get(n) === me)) adjacent = Math.max(adjacent, a);
    }
    const largestStack = adjacent || any;
    // Every opponent earns at least the game's base income (never below the 5 minimum), and
    // never less than the bonuses it visibly holds: its stack next to me limits neither.
    const floor = Math.max(MIN_ENEMY_DEPLOY, base);
    const visible = opening ? floor : Math.max(floor, base + bonusIncome);
    // What it was seen to deploy is cut only by what it could earn
    // (#69): its base plus every bonus none of whose territories someone else visibly holds
    // (an owner-only territory is visibly held: its owner shows). Both come from this board,
    // so a bonus it lost since last turn is out, though it may have paid for that deploy.
    let possible = 0;
    /** #235: of `possible`, the bonuses it visibly holds in full (no share of them goes to another). */
    let possibleOwn = 0;
    for (const b of g.map.bonuses) {
      const ts = bonusTerritories(g, b.id);
      if (b.value <= 0 || !ts.length) continue;
      const taken = ts.some((t) => {
        const st = ownerShown(seenNow.get(t));
        return st !== undefined && !(st.owner.kind === 'player' && st.owner.playerId === playerId);
      });
      if (!taken) possible += b.value;
      if (!taken && ts.every((t) => theirs.has(t))) possibleOwn += b.value;
    }
    // #226: with per-territory income, the territories it could hold pay at the rate: its visible
    // ones and every one whose owner this board hides (it may hold any of them).
    const couldHold =
      per > 0
        ? g.map.territories.filter((t) => {
            const st = ownerShown(seenNow.get(t.id));
            return st === undefined || (st.owner.kind === 'player' && st.owner.playerId === playerId) || theirs.has(t.id);
          }).length
        : held;
    const couldEarn = territoryIncome(couldHold, minimum, per) + possible;
    // #119: the fog prior. In a symmetric-start 1v1 an opponent bordering the fog earns at least
    // what I earn, capped at what it could earn on this board. It only ever raises the figure.
    const fogBeside = [...theirs].some((t) => neighborsOf(g, t).some((n) => !ownerShown(seenNow.get(n))));
    // #166: with its starts proven, its opening simulated from them raises the prior when it earns
    // more than I do; never lowers it (the simulation is a simple player, and #119's evidence read low).
    const priorBase = Math.max(prior?.myIncome ?? 0, prior?.opening?.get(playerId) ?? 0);
    // #235: in a free-for-all the hidden part of the board is shared: an even share of the hidden
    // territories and of the bonuses it could still hold (its own in full), never above couldEarn.
    const k = prior?.format === 'ffa' && (prior.opponents ?? 0) > 1 ? prior.opponents! : 0;
    const priorCap =
      prior && k > 0
        ? Math.min(couldEarn, territoryIncome(held + Math.ceil((couldHold - held) / k), minimum, per) + possibleOwn + Math.ceil((possible - possibleOwn) / k))
        : null;
    const priorFull = prior && fogBeside ? Math.min(Math.max(0, Math.floor(priorBase!)), priorCap ?? couldEarn) : null;
    // #444: incomes other players stated scale this one's prior down by their ratio to mine (never up).
    const statedRatio = prior?.stated && !prior.stated.players.some((x) => x.id === playerId) ? prior.stated.ratio : null;
    const priorFigure = priorFull !== null && statedRatio !== null ? Math.min(priorFull, Math.ceil(priorFull * statedRatio - 1e-9)) : priorFull;
    // #419: the past winners' pace, as the prior is figured (capped, scaled, only beside the fog), when above it.
    const paceIncome = prior?.winnerPace ? fogPaceIncome(prior.winnerPace, prior.myIncome) : null;
    const paceFull = paceIncome !== null && fogBeside && paceIncome > priorBase ? Math.min(paceIncome, priorCap ?? couldEarn) : null;
    const paceFigure = paceFull !== null && statedRatio !== null ? Math.min(paceFull, Math.ceil(paceFull * statedRatio - 1e-9)) : paceFull;
    const paceTop = paceFigure !== null && priorFigure !== null && paceFigure > priorFigure ? paceFigure : null;
    // A track over enough turns replaces the single-turn observed figure (S3).
    const track = tracks?.find((t) => t.playerId === playerId);
    const usable = track && track.income !== null && track.turns.length >= TRACKED_MIN_TURNS ? track : undefined;
    const tracked = usable ? usable.income : null;
    // #235 review: does the track end on this board? Its newest observed turn then ends at the turn
    // being planned (the newest board's turn, when that is not given: tracks end on `board`).
    const newestTurn = when.turn ?? usable?.lastTurn ?? null;
    const newest = usable?.turns.at(-1);
    const trackEndsNow = newest !== undefined && newest.to === newestTurn;
    // #123: what it was expected to deploy before this observation (its visible income, and its
    // tracked income when it has a usable track, else the prior): ambiguous armies beyond twice that
    // are moves out of the fog ({@link ambiguousBound}); a capture from me is priced at the guard.
    // With a track the prior stays out of the bound, and the reading is no part of the estimate
    // (#235 1c): the track replaces it. A track that ends on this board has read the newest turn
    // already, so the turn is read with that track's own bound (`ObservedTurn.expected`), and the
    // rationale's observed line agrees with the tracker and with the label below.
    const trackBound = trackEndsNow ? newest!.expected : undefined;
    const observation = previous
      ? observeDeploy(g, board, previous, playerId, settings, {
          me,
          guard: (settings.oneArmyStandsGuard ?? true) ? 1 : 0,
          expected: Math.max(visible, trackBound ?? tracked ?? priorFull ?? 0),
          most: couldEarn,
          // #293: under Local Deployment, growth beside the fog outside every bonus it could hold is
          // deploy only up to its free income.
          ...(settings.localDeployments
            ? { localFree: localFreeOn(base, MIN_ENEMY_DEPLOY, when.reinforcement ?? settings.opponentReinforcement, when.turn == null ? null : when.turn - 1) }
            : {}),
          ...(when.previousOrders ? { myOrders: when.previousOrders } : {}),
          // #271 review: the turn read is the one before the turn planned.
          ...(bombPossibleOn(settings, when.turn == null ? null : when.turn - 1) ? { bomb: true } : {}),
        })
      : null;
    // #235 1c: the track's newest turn, when it ends on this board and its bound cut armies that
    // arrived beside the fog (or joined a capture): what that turn reads with them all as deploys.
    // A label only: a stack walking in is not income (#123 lesson 5), so the estimate stays.
    const newestCut: EnemyDeployEstimate['newestCut'] =
      trackEndsNow && newest!.high > newest!.raw && (newest!.grewFromFog.length > 0 || newest!.reinforced.length > 0)
        ? {
            from: newest!.from,
            to: newest!.to,
            observed: newest!.observed,
            reading: Math.min(newest!.high, newest!.cap),
            expected: newest!.expected ?? null,
          }
        : null;
    const observedCap = observation ? couldEarn : null;
    const observedRaw = observation?.deploy ?? null;
    const observed = observation ? Math.min(observation.deploy, observedCap!) : null;
    // A usable track replaces the single-turn observed figure (S3; #235 1c: its newest reading too).
    const seenSource: EnemyDeployEstimate['source'] =
      tracked !== null
        ? tracked > visible
          ? 'tracked'
          : 'visible'
        : observed !== null && observed > visible
          ? 'observed'
          : 'visible';
    const seen = seenSource === 'tracked' ? tracked! : seenSource === 'observed' ? observed! : visible;
    // #235: the prior shrinks toward that evidence: the more consecutive observed turns, and the more
    // of its edge in view, the less of its lead it keeps.
    let priorBlend: EnemyDeployEstimate['priorBlend'] = null;
    if (priorFigure !== null && usable) {
      const toward = Math.max(tracked!, visible);
      if (priorFigure > toward) {
        // The consecutive observed turns up to the newest board; a run that stopped earlier is none.
        let turns = trackEndsNow ? 1 : 0;
        const run = usable.turns;
        for (let i = run.length - 1; turns > 0 && i > 0 && run[i - 1]!.from === run[i]!.from - 1; i--) turns++;
        const edge = new Set<number>();
        for (const t of theirs) for (const n of neighborsOf(g, t)) if (!theirs.has(n)) edge.add(n);
        const edgeShare = edge.size ? [...edge].filter((n) => ownerShown(seenNow.get(n)) !== undefined).length / edge.size : 0;
        // #294: each turn of the run weighs what it read of its frontier (this board's edge for a turn
        // that carries no coverage).
        const evidence = run.slice(run.length - turns).reduce((n, x) => n + (x.coverage?.share ?? edgeShare), 0);
        const share = turns ? evidence / turns : edgeShare;
        const weight = PRIOR_EVIDENCE_TURNS / (PRIOR_EVIDENCE_TURNS + evidence);
        const figure = toward + Math.ceil(weight * (priorFigure - toward) - 1e-9);
        priorBlend = { prior: priorFigure, toward, turns, share, weight, figure };
      }
    }
    const priorUsed = priorBlend ? priorBlend.figure : priorFigure;
    // #164: with every owner shown, its income is base + held bonuses exactly; a deploy above it was
    // a card (or armies the board misread), never income.
    const exact = ownersAll && !opening ? Math.max(0, base + bonusIncome) : null;
    const source: EnemyDeployEstimate['source'] =
      exact !== null ? 'exact' : priorUsed !== null && priorUsed > seen ? 'prior' : seenSource;
    // #294: what its tracked figure was read from (#368: while that is little, thin evidence below).
    const coverage = usable ? trackCoverage(usable.turns.filter((x) => usable.incomeTurns.includes(x.from))) : null;
    // #444: an untracked opponent whose prior a stated income scaled: #368's midpoint between what is in
    // view (or observed) and that prior.
    const statedMid = statedRatio !== null && source === 'prior' && !usable ? seen + Math.ceil((priorUsed! - seen) / 2 - 1e-9) : null;
    const chosen = source === 'exact' ? exact! : source === 'prior' ? (statedMid ?? priorUsed!) : seen;
    // #368 (owner decision of 2026-11-19: on a hidden opponent, choose the middle until we learn
    // otherwise): thin evidence — its tracked figure read from under LOW_COVERAGE of its frontier —
    // sizes it for the midpoint between the lower bound (what is in view or tracked, raised to the
    // trend's next step when its tracked figure rose two turns running, #418: unless I lead it on armies
    // in view and on income — above its tracked figure, or with LEAD_ARMIES × its armies above what it
    // earned before the newest rise) and the upper bound (the fog
    // prior whole, else the most it could earn), moved toward what the evidence gives as the coverage
    // nears LOW_COVERAGE. A rising track read from more of its frontier only raises the estimate to that
    // lower bound. Never the maximum.
    let thinEvidence: EnemyDeployEstimate['thinEvidence'] = null;
    if (source !== 'exact' && usable && tracked !== null) {
      // #418: no trend step on an opponent I lead on income (its tracked figure) and on armies in view.
      // #418 review: with LEAD_ARMIES × its armies in view, the income lead is judged against what it
      // earned before the newest rise (or its visible income) instead: an over-read tracked figure must
      // not switch off the gate meant to stop it. (On that judgement alone, with a bare army lead, the
      // calibration lost 3 of 4 changed samples further below truth.)
      let theirArmies = 0;
      for (const t of theirs) theirArmies += armies.get(t) ?? 0;
      const risen = risingTracked(usable.turns);
      const leadIt =
        risen !== null &&
        myArmies > theirArmies &&
        (myBoardIncome > Math.max(visible, tracked) || (myArmies >= LEAD_ARMIES * theirArmies && myBoardIncome > Math.max(visible, risen[1]!)));
      const rising = leadIt ? null : risen;
      const thinCoverage = coverage !== null && coverage.share < LOW_COVERAGE;
      if (thinCoverage || rising) {
        const trend = rising ? Math.min(couldEarn, rising[2]! + Math.ceil((rising[2]! - rising[0]!) / 2 - 1e-9)) : null;
        const lower = Math.min(couldEarn, Math.max(visible, tracked, trend ?? 0));
        // #419: the top of its range is the larger of the prior and the past winners' pace.
        const upper = Math.max(lower, Math.min(couldEarn, paceTop ?? priorFigure ?? couldEarn));
        const midpoint = lower + Math.ceil((upper - lower) / 2 - 1e-9);
        // What the evidence gives without thin evidence (the track, or #235's prior shrunk toward it),
        // never below the lower bound: the figure meets it at LOW_COVERAGE, so it does not jump there.
        const toward = Math.min(couldEarn, Math.max(lower, chosen));
        const weight = thinCoverage ? Math.max(0, 1 - coverage!.share / LOW_COVERAGE) : 0;
        const figure = toward + Math.ceil(weight * (midpoint - toward) - 1e-9);
        // Thin coverage: the figure replaces the estimate, up or down. A rising track alone: a raise only.
        if (thinCoverage || figure > chosen)
          thinEvidence = {
            coverage: coverage ? coverage.share : null,
            rising,
            tracked,
            prior: priorFigure,
            trend,
            lower,
            upper,
            midpoint,
            toward,
            weight,
            figure,
            ...(paceTop !== null && prior?.winnerPace
              ? {
                  pace: {
                    figure: paceTop,
                    basis: prior.winnerPace.basis,
                    afterTurn: prior.winnerPace.afterTurn,
                    games: prior.winnerPace.games,
                    ...(prior.winnerPace.ratio !== undefined ? { ratio: prior.winnerPace.ratio } : {}),
                  },
                }
              : {}),
          };
      }
    }
    const income = thinEvidence ? thinEvidence.figure : chosen;
    // #368: the figure thin evidence chose names its source: the prior when there is one and the figure
    // lies above the lower bound, else the track.
    const finalSource: EnemyDeployEstimate['source'] = thinEvidence
      ? thinEvidence.prior !== null && thinEvidence.figure > thinEvidence.lower
        ? 'prior'
        : 'tracked'
      : source;
    // #164: a Reinforcement card, from the turn the clock says one can be in hand, until a deployment
    // above its income is seen; the next card is due a card's capturing turns after the last one
    // (pieces carry over while a card is held), never before the turn after the play.
    // A play is seen as a deploy (its low reading) above the income that turn: exactly, when every
    // owner shows; under fog only a jump of the card's armies over its visible income counts (a
    // smaller excess may be a bonus the fog hides — and the tracked income then carries the jump).
    const played: number[] = [];
    if (when.reinforcement) {
      const above = (low: number, income: number) => (exact !== null ? low > income : low >= income + when.reinforcement!.armies);
      for (const x of track?.turns ?? []) if (above(x.low, x.visibleIncome)) played.push(x.from);
      // Last turn's deploy was paid by last turn's income: what it held on the previous board (a
      // bonus it lost since paid for it), never below this board's figure.
      if (observation && previous && when.turn !== null && when.turn !== undefined) {
        const before = new Set<number>();
        for (const t of previous.territories)
          if (g.territoryById.has(t.territoryId) && t.owner.kind === 'player' && t.owner.playerId === playerId) before.add(t.territoryId);
        const paid = boardIncome(g, before, { base: minimum, per }).total;
        if (above(observation.low, Math.max(exact ?? visible, paid))) played.push(when.turn - 1);
      }
    }
    let card: EnemyDeployEstimate['card'] = null;
    let cardPlayed: number | null = null;
    if (when.reinforcement && when.turn !== null && when.turn !== undefined) {
      const r = when.reinforcement;
      let due = r.firstTurn;
      let cards = 0;
      for (const t of [...new Set(played)].sort(byNum)) {
        if (t < due || t >= when.turn) continue;
        cards++;
        cardPlayed = t;
        due = r.turnsPerCard === null ? Infinity : Math.max(t + 1, r.firstTurn + cards * Math.max(1, r.turnsPerCard));
      }
      if (when.turn >= due && r.armies > 0) card = { armies: r.armies, due };
    }
    const estimate = income + (card?.armies ?? 0);
    return {
      playerId,
      estimate,
      held,
      base,
      bonusIncome,
      largestStack,
      opening,
      observed,
      observedRaw,
      observedCap,
      couldEarn,
      couldHold,
      observation,
      tracked,
      newestCut,
      trackedTurns: usable ? usable.incomeTurns : [],
      prior: priorFigure,
      priorBlend,
      coverage,
      priorCap,
      fogBeside,
      source: finalSource,
      thinEvidence,
      exact,
      card,
      cardPlayed,
      ...(priorFull !== null && priorFigure! < priorFull ? { stated: { full: priorFull, scaled: priorFigure!, lower: seen, midpoint: statedMid } } : {}),
    };
  });
}

/**
 * Default enemy deploy: the largest {@link enemyDeployEstimates} figure among the
 * players with a stack next to me — visible, or its owner shown and its armies hidden (#164) —
 * at least {@link MIN_ENEMY_DEPLOY}. Pass the turn, fog setting and Reinforcement clock (`when`)
 * and the fog prior {@link planEnemyEstimates} uses, or a mid-game board of equal stacks reads as
 * the opening board (#128), an opponent's card is left out (#164), and the figure disagrees with
 * the planner's. Unlike the planner's, it does not know the teams: a teammate counts.
 */
export function defaultEnemyDeploy(
  g: MapGraph,
  board: BoardState,
  me: number,
  settings: PlannerSettings = {},
  previous?: BoardState,
  tracks?: readonly OpponentTrack[],
  prior?: EnemyIncomePrior,
  when: { turn?: number | null; fog?: string | undefined; reinforcement?: ReinforcementClock | undefined } = {},
): number {
  const mineIds = new Set(
    board.territories.flatMap((t) => (t.owner.kind === 'player' && t.owner.playerId === me ? [t.territoryId] : [])),
  );
  const next = new Set<number>();
  for (const t of board.territories) {
    if (t.owner.kind !== 'player' || t.owner.playerId === me) continue;
    if (t.armies === null && (ownerShown(t) === undefined || visibleState(t))) continue;
    if (!g.territoryById.has(t.territoryId)) continue;
    if (neighborsOf(g, t.territoryId).some((n) => mineIds.has(n))) next.add(t.owner.playerId);
  }
  return enemyDeployEstimates(g, board, me, settings, previous, tracks, prior, when).reduce(
    (m, e) => (next.has(e.playerId) ? Math.max(m, e.estimate) : m),
    MIN_ENEMY_DEPLOY,
  );
}

/**
 * This turn's income on the board, cards aside: {@link boardIncome} over the territories `me`
 * holds, cut by the game's army cap (#253, {@link armyCapIncome}: min(income, round(cap × income)
 * − my armies on the board)). warapp_plan_turn and warapp_submit_turn both use it (plus the armies
 * of the card plays in their orders, which the cap leaves alone), so the plan's deploy total is the
 * total the submit check requires.
 */
export function incomeFor(g: MapGraph, board: BoardState, me: number, settings?: GameSettings): number {
  return incomeDetail(g, board, me, settings).income;
}

/**
 * Another player's income from what the board shows, before any army cap: base, bonuses and cities
 * over the territories it visibly holds. The cap is not applied (#253): its fogged armies are
 * unknown, so a cut from its visible armies alone would depend on the fog. My own income is
 * {@link incomeFor}.
 */
export function visibleIncomeFor(g: MapGraph, board: BoardState, player: number, settings?: GameSettings): number {
  const held = new Set<number>();
  let cities = 0;
  for (const t of board.territories)
    if (g.territoryById.has(t.territoryId) && t.owner.kind === 'player' && t.owner.playerId === player) {
      held.add(t.territoryId);
      cities += t.cities ?? 0;
    }
  return boardIncome(g, held, incomeRules(settings)).total + cityGold(cities, settings);
}

/**
 * #332: the gold a commerce game's cities pay each turn (CityIncome each), part of the income like a bonus (the client's
 * income function adds it after base and bonuses, before the army cap). 0 outside a commerce game with city income.
 */
export function cityGold(cities: number, settings?: GameSettings): number {
  const per = commerceRules(settings)?.cityIncome ?? 0;
  return cities > 0 && per > 0 ? cities * per : 0;
}

/**
 * {@link incomeFor} with the army cap's arithmetic: `cap` when the game has one and every territory
 * of mine shows its armies (my own always should); `capUnknown` when one does not, and the income is
 * then left uncut. The cap reads my armies from the start-of-turn standing as war.app showed it:
 * callers may pass a board with the award or a prior merged in (livePlanSetup's `board`), which must
 * never change my own territories' armies — a merge that did would move the cap's cut.
 */
export function incomeDetail(
  g: MapGraph,
  board: BoardState,
  me: number,
  settings?: GameSettings,
): { income: number; cap?: ArmyCapIncome; capUnknown?: true } {
  const held = new Set<number>();
  let armies = 0;
  let unread = false;
  let cities = 0;
  for (const t of board.territories) {
    if (!g.territoryById.has(t.territoryId) || t.owner.kind !== 'player' || t.owner.playerId !== me) continue;
    held.add(t.territoryId);
    cities += t.cities ?? 0;
    if (t.armies === null) unread = true;
    else armies += t.armies;
  }
  const income = boardIncome(g, held, incomeRules(settings)).total + cityGold(cities, settings);
  if (settings?.armyCap === undefined || settings.armyCap === null || !(settings.armyCap > 0)) return { income };
  if (unread) return { income, capUnknown: true };
  const cap = armyCapIncome(income, settings.armyCap, armies)!;
  return { income: cap.received, cap };
}

export interface Target {
  id: number;
  cost: number;
  enemy: boolean;
  sources: number[];
}

export interface BonusPlan {
  bonusId: number;
  value: number;
  focus: boolean;
  remaining: number[];
  completable: boolean;
  cost: number;
  borders: number;
  /** Deploys its frontier needs next turn to hold once completed (0 when not judged). */
  defenseCost: number;
  /**
   * Its worth once complete (#70): its value plus the (negative) value of every other negative
   * bonus its missing members complete. Equal to `value` on a map without negative bonuses.
   */
  net: number;
  /** The frontier its missing members add, in armies (rule 4d; negative when it closes gaps). */
  frontier: number;
  /** Missing members in the fog (#101), each counted in `cost` at `fogEach` armies. */
  fogged: number;
  /** The armies each fogged member counts for: its bonus's costliest visible missing member. */
  fogEach: number;
  /**
   * #428: the fogged members costed as the game's neutral size (`PlannerSettings.neutralArmies`) instead,
   * `count` of them at `each` armies; not counted in `fogged`.
   */
  fogNeutral?: FogNeutral;
}

/** #428: fogged bonus members costed as a neutral of the game's neutral size (`size`), `each` armies apiece. */
export interface FogNeutral {
  count: number;
  each: number;
  size: number;
}

/**
 * #172: how one planning pass treats the two-step hold. Attacks are sized greedily, so an early
 * attack out of a guarded territory cannot know that a later order of the same plan takes the
 * reach's stack or the territory in between; {@link planTurn} learns that from earlier passes.
 */
export interface TwoStepPass {
  /** Reaches from, or through, these territories are cut: the plan takes them (a later order included). */
  readonly cut: ReadonlySet<number>;
  /** Attacks are sized without the two-step hold (to learn what the plan would take without it). */
  readonly relaxAttacks: boolean;
  /** Set by the pass when some two-step hold was found to bind. */
  used: boolean;
  /**
   * Whether a territory of mine in between a reach and its target is held (so its own one-step
   * hold covers the reach, which is cut), as learned from the end of an earlier pass; a territory
   * absent here is judged by the concession as the pass goes.
   */
  readonly viaHeld: ReadonlyMap<number, boolean>;
  /** No territory of mine in between is held: the fallback that is the same at every order. */
  readonly viaNever: boolean;
  /** Filled by the pass: each "held in between" decision it made, by territory. */
  readonly viaSeen: Map<number, boolean>;
  /** Set by the pass when one territory was judged both ways. */
  viaMixed: boolean;
  /** Filled at the end of the pass: whether each territory in `viaSeen` ends kept and holding. */
  readonly viaFinal: Map<number, boolean>;
  /** Shared by every pass of one {@link planTurn}: what depends only on its input. */
  readonly shared: TwoStepShared;
}
/**
 * What every pass of one {@link planTurn} shares (#172): the two-step reaches depend only on the
 * start board (the opponents, their deploys, the territories worth guarding), so they are found
 * once, by the first pass that needs them, and each pass filters them by its own plan.
 */
export interface TwoStepShared {
  reaches?: ReadonlyMap<number, readonly TwoStepReach[]>;
  /**
   * #214 review: no lead step is retried at its bare cost in this {@link planTurn} run — the plan
   * a run with bare steps is checked against (planTurn keeps the bare one only when it costs no
   * hold this one makes).
   */
  noBare?: boolean;
}
/** A two-step hold on one territory of mine (#172): what stays, what it needs, and the reach. */
export interface TwoStepHoldAt {
  /** Armies (in `stayAt` terms) that stay to hold. */
  stay: number;
  /** Armies it needs to hold against the reach (as a one-step hold is measured). */
  needs: number;
  reach: TwoStepReach;
}
