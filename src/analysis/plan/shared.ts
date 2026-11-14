// The planner's shared constants, types and pure helpers (#133): the tuning constants, the input and
// output types of `planTurn`, combat sizing (`captureCost`), fog (`visibleState`) and the enemy deploy
// estimates. A leaf module: planner.ts and every phase under src/analysis/plan/ import from it, and it
// imports no phase and not planner.ts, so the import graph has no cycle. planner.ts re-exports all of it.
import type { BoardState, TerritoryState } from '../../board.js';
import type { MyOrders, OpponentTrack } from '../opponents.js';
import type { GameSettings } from '../../normalize.js';
import { bonusTerritories } from '../bonuses.js';
import {
  armiesForChance,
  armiesToTake,
  DEFAULT_DEFENSIVE_KILL_RATE,
  DEFAULT_OFFENSIVE_KILL_RATE,
  guaranteedKills,
  luckFraction,
  straightKills,
  winChance,
  type CombatSettings,
  type KillRates,
} from '../combat.js';
import { neighborsOf, type MapGraph } from '../graph.js';
import type { GameOutlook } from '../outlook.js';
import type { BorderOutcome, Exchange } from '../exchange.js';
import type { TwoStepReach } from '../lookahead.js';
import type { MoveSlot } from '../schedule.js';
import { boardIncome, DEFAULT_BASE_INCOME, incomeRules, territoryIncome } from '../player.js';
import type { GameProfile, ProfilePlayer } from '../profile.js';
import { byNum } from './util.js';

/** A bonus is uneconomic when its remaining capture cost exceeds this many turns of its value… */
export const PAYBACK_TURNS = 10;
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
}

export interface PlanOptions {
  /** Default `balanced`. */
  goal?: PlanGoal;
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
   * Every player started with the same territories and armies (not a map scenario that sets its
   * own starts): in a 1v1 (#119), or a free-for-all with no teams and every seated player still in
   * (#226), it turns the fog prior on ({@link EnemyIncomePrior}).
   */
  symmetricStart?: boolean;
  /**
   * #166: per opponent, its income this turn simulated from the starts the award of picks proved
   * (`openingIncome`); with the fog prior on, that opponent's prior is the larger of it and my income.
   */
  opening?: ReadonlyMap<number, number>;
  /** #178: the end-of-game settings the profile reads (`Game.endRules`): who the game ends with. */
  endRules?: { aisSurrenderWhenOneHumanRemains?: boolean };
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
   * #226: my orders on the turn `previousBoard` was played (what warapp_submit_turn sent and cached):
   * a failed attack of mine counts its kills back into the defender's observed deploy
   * ({@link ObserveContext.myOrders}). Unknown orders change nothing.
   */
  previousOrders?: MyOrders;
  /**
   * The turn being planned, when known: `previousBoard` is then turn − 1's board, and the
   * observed-deploy rationale names the two turns.
   */
  turn?: number;
  /**
   * Opponent tracks over my board history ({@link trackOpponents}, ending on `board`): an
   * opponent observed over at least {@link TRACKED_MIN_TURNS} turns gets its tracked income in
   * place of the single-turn observed figure.
   */
  tracks?: readonly OpponentTrack[];
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
}

/** Why a truce's trust is `watch` ({@link PlanRelation.watch}). */
export type TruceWatchReason = 'broken' | 'cap-exceeded' | 'massing' | 'outgrowing' | 'their-notice' | 'endgame';

/**
 * B2: one truce as the planner reads it. `coveredMine` and `coveredTheirs` are the territories the
 * terms cover on each side; `state` `active` or `notice` binds (a notice until `endsTurn`, the first
 * turn it no longer binds), `broken` (T8: broken by them, `breach` saying how) does not. `trust`
 * `watch` (with its reasons) keeps every border's full hold (T3). `enforced` (T9): a Diplomacy card
 * the decoder is sure of — that player cannot attack me, nor I it. `warapp_plan_turn` never sets it
 * yet (the ledger's field is ignored until part D's decoder-backed source).
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
   * T6: what a break would cost this turn — the partner's whole estimated deploy on its costliest
   * covered border and an attack on my covered territory beside it, against this plan's orders, on the
   * turn simulator. `null` when the truce does not bind, is enforced, or no covered stack of the
   * partner in view stands beside a covered territory of mine.
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
}

/** A card the submission should play for the plan to work (the planner itself never plays cards). */
export type CardAdvice = 'order-priority';

export interface TurnPlan {
  /** The goal planned for: the explicit one, else (adapting) the profile's, else `balanced`. */
  goal: PlanGoal;
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
  /** B2: each truce given in the input, as the plan treated it. Absent without relations. */
  relations?: PlanRelationView[];
  /** B2 (T7): advice about the agreements (give notice). Absent when there is none. */
  advice?: PlanAdvice[];
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
   * `'tracked'` when the tracked income beat the visible-bonus figure, else `'observed'` when the
   * single-turn observed figure did (only without a usable track), else `'visible'` — unless the
   * fog prior beat all of them: `'prior'`.
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
}

/**
 * Fog levels that hide a territory's armies. The live board names war.app's StandingFogLevel
 * (1 You, 2 Visible, 3 OwnerOnly, 4 Fogged; the client refuses a deploy on 3 or 4 as "fogged");
 * a GameFeed standing may spell it as a word or as the raw number (every GameFeed scalar is a
 * string).
 */
const HIDDEN_FOG = /fog|owneronly|^\s*[34]\s*$/i;
/** Fog levels that hide a territory's owner too (StandingFogLevel 4, Fogged). */
const OWNER_HIDDEN_FOG = /fog|^\s*4\s*$/i;

/**
 * `t` when a board shows both its owner (a player or a neutral) and its armies, else
 * `undefined`: a fogged territory (owner unknown, armies `null`), or one whose fog level hides
 * its armies even if a placeholder owner or count came with it (issue #69).
 *
 * One exception: an entry named `"OwnerOnly"` that still carries a count is fog level 2
 * (Visible) from a board cache written before #69, which misnamed it; every current board nulls
 * an owner-only territory's armies, and the old cache left level 3 unnamed (`"3"`).
 */
export function visibleState(t: TerritoryState | undefined): TerritoryState | undefined {
  if (!t || t.armies === null) return undefined;
  if (t.owner.kind !== 'player' && t.owner.kind !== 'neutral') return undefined;
  if (t.fogLevel !== undefined && HIDDEN_FOG.test(t.fogLevel) && !/^\s*owneronly\s*$/i.test(t.fogLevel)) return undefined;
  return t;
}

/**
 * `t` when a board shows its owner (a player or a neutral), whatever its armies: visible, or
 * owner-only (light fog); `undefined` when fogged, even under a placeholder owner.
 */
export function ownerShown(t: TerritoryState | undefined): TerritoryState | undefined {
  if (!t || (t.owner.kind !== 'player' && t.owner.kind !== 'neutral')) return undefined;
  if (t.fogLevel !== undefined && OWNER_HIDDEN_FOG.test(t.fogLevel)) return undefined;
  return t;
}

/** What {@link observeDeploy} read off two boards for one opponent. */
export interface DeployObservation {
  /** Its observed deploy last turn, floored at 0. */
  deploy: number;
  /** Its territories now that were visible last turn too (held both times, or captured), by id. */
  counted: number[];
  /** Of `counted`, those it took from another visible owner (a player, me included, or a neutral). */
  captured: number[];
  /**
   * Of `captured`, those taken (at least partly) from the fog (issue #86): more armies stand there
   * than its territories next to them visibly sent away, and a neighbour was hidden on a board,
   * so the rest arrived from the fog — a move, not income. They count only what the capture
   * cost plus what the visible sources sent; the stack stays a threat.
   */
  fromFog: number[];
  /**
   * The armies read as moves out of the fog, never income: the stacks on `fromFog` beyond what
   * visible sources sent, plus the ambiguous armies (growth on `grewFromFog`, a reinforced
   * capture's surplus) beyond the turn's bound ({@link ambiguousBound}).
   */
  fogArmies: number;
  /** Its territories now that last turn's board did not show: fog reveals, never income. */
  reveals: number[];
  /**
   * Of `captured`, those it took with more armies than its visible neighbours visibly sent, where
   * one of them did shrink into it and a neighbour was hidden (#123): the surplus counts as a
   * deploy on the visible stack that attacked (deploy-then-capture) up to the turn's bound
   * ({@link ambiguousBound}), though a stack out of the fog may have joined it (`low` counts it
   * so); beyond the bound it is in `fromFog` too.
   */
  reinforced: number[];
  /**
   * Its territories held on both boards, next to a territory hidden on either, whose growth was
   * read (at least partly) as a move out of the fog (#123): the growth there beyond the turn's
   * bound ({@link ambiguousBound}: twice what it was expected to deploy, at most what it could earn).
   */
  grewFromFog: number[];
  /** The armies of that growth read as moves (part of `fogArmies`). */
  fogGrowth: number;
  /** {@link ObserveContext.expected}, when given. */
  expected: number | null;
  /**
   * Of `captured`, those taken from me (#123, given {@link ObserveContext.me}): my orders are
   * unknown here, so the capture is priced at what the guard I may have left kills, never at my
   * stack last turn (I may have attacked out of it).
   */
  emptied: number[];
  /** What `high` adds for `emptied` (my stack last turn standing there, not the guard). */
  emptiedHigh: number;
  /**
   * #226: its territories my failed attacks hit last turn (held by it on both boards, my source mine
   * on both: {@link failedAttackKills}), given {@link ObserveContext.myOrders}; empty otherwise.
   */
  attacked: number[];
  /**
   * #226: the defenders my failed attacks killed there (straight-rounded at the offensive kill rate):
   * defenders after = before + deploy + transfers in − kills, so they count back into its growth
   * there (a lower bound on what stood there). Beside the fog that growth is ambiguous like any other
   * ({@link ambiguousBound}). 0 without my orders.
   */
  attackKills: number;
  /** The deploy with every ambiguous army read the low way (fog moves, emptied captures), floored at 0. */
  low: number;
  /** The deploy with every ambiguous army read the high way (deploys, my stack standing), floored at 0. */
  high: number;
}

/**
 * What {@link observeSigned} knows beyond the two boards (#123); every field optional, and
 * without them the reading is the board-only one.
 */
export interface ObserveContext {
  /** My player id: a capture from me is priced at the guard (`emptied`). */
  me?: number;
  /** Armies that stand guard on a territory (1, or 0 when the game lets a territory empty); default 1. */
  guard?: number;
  /**
   * What it was expected to deploy without this observation (its visible income, the fog prior,
   * or its tracked/carried income): ambiguous armies (growth on its territories next to a hidden
   * one, a reinforced capture's surplus) beyond twice that are moves out of the fog
   * (`grewFromFog`, `fromFog`), not income ({@link ambiguousBound}). Absent: every growth counts
   * as deploy.
   */
  expected?: number;
  /**
   * The most it could deploy (its base plus every bonus it could hold): the turn's deploy never
   * reads above it once ambiguous armies are counted (`reinforced`, growth beside the fog); the
   * rest arrived from the fog. With neither this nor `expected` (a board-only reading), a
   * capture's surplus is all a move, as before #123.
   */
  most?: number;
  /**
   * #226: my orders on the turn between the two boards (the deploys and moves warapp_submit_turn sent,
   * `TurnBoard.orders`): a failed attack of mine on its territory killed defenders the board reads as
   * a shrink, so they count back ({@link failedAttackKills}). Requires `me`.
   */
  myOrders?: MyOrders;
}

/**
 * #226: what my failed attacks on `playerId` killed, by target, on the turn `before` → `after`: each
 * move of mine onto a territory it holds on both boards (shown with armies both times), from a
 * source mine on both (one that fell may have been taken before my attack ran), kills
 * round(armies × the offensive kill rate) — a straight-rounded expectation, which luck can move.
 * The board reads that loss as a shrink. The opponent tracker's `measureOrders` counts the same.
 */
export function failedAttackKills(
  g: MapGraph,
  before: BoardState,
  after: BoardState,
  me: number,
  playerId: number,
  orders: MyOrders,
  rates: KillRates = {},
): Map<number, number> {
  const offensive = rates.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  const was = new Map(before.territories.map((t) => [t.territoryId, t]));
  const now = new Map(after.territories.map((t) => [t.territoryId, t]));
  const owns = (t: TerritoryState | undefined, p: number) => {
    const v = visibleState(t);
    return v?.owner.kind === 'player' && v.owner.playerId === p;
  };
  const out = new Map<number, number>();
  for (const m of orders.moves) {
    if (!g.territoryById.has(m.to) || !owns(was.get(m.from), me) || !owns(now.get(m.from), me)) continue;
    if (!owns(was.get(m.to), playerId) || !owns(now.get(m.to), playerId)) continue;
    out.set(m.to, (out.get(m.to) ?? 0) + straightKills(Math.max(0, m.armies), offensive));
  }
  return out;
}

/**
 * One opponent's deploy last turn as seen across two boards (issues #57, #69): the *net*
 * change of its visible armies plus what it visibly lost attacking, floored at 0. Only
 * territories visible on both boards count ({@link visibleState}): one hidden last time
 * (fogged, or under a fog level that hid its armies) only came into view, so it is a fog
 * reveal whoever holds it now — never growth, never a capture.
 * - under it both times: armies now − armies then, shrinks included — a transfer between
 *   its own territories nets to zero, so it is never read as deploy;
 * - taken from another visible owner (another player, me included, or a visible neutral): what
 *   the capture cost it — the attackers the previous defenders killed at the game's defensive
 *   kill rate (`straightKills`, as in `armiesToTake`); taken from me (given `context.me`), the
 *   defenders are the guard I may have left, not my stack last turn (#123, `emptied`: I may have
 *   attacked out of it) — plus the armies now on it up to what its territories next to it, shown
 *   on both boards, visibly sent away (their total shrink, each army claimed by one capture only):
 *   those moved in from a visible source, whose shrink they cancel, so source shrink + destination
 *   gain nets to the attrition (issue #86). An unchanged visible neighbour sent nothing, so it
 *   explains nothing. The rest, when a neighbour was hidden on either board, is ambiguous (#123):
 *   a deploy on a visible source that shrank into it (`reinforced`), or a move out of the fog —
 *   never income (`fromFog`), still a threat to the borders next to it. With every neighbour in
 *   view it can only be a deploy on the source.
 * - growth on its territory next to a hidden one is ambiguous the same way (`grewFromFog`).
 * Ambiguous armies count as deploy while the turn's total stays within {@link ambiguousBound}
 * (twice `context.expected`, never past `context.most`); the rest are moves. Without `expected`,
 * growth is all deploy and a capture's surplus counts up to `most` (none without it, #86).
 * `low` and `high` read every ambiguous army one way or the other (fog moves and the guard, or
 * deploys and my stack standing there).
 * Not counted: armies it lost on a territory it attacked but did not take. The defender's
 * count there also moves with the defender's own deploys and transfers (mine included —
 * this board says nothing about my orders), so the loss cannot be read off it; leaving it
 * out keeps the figure a lower bound (the failed attack's losses still shrink its source). The
 * opponent tracker adds it back when my orders that turn are known (#119, `measureOrders`).
 * Given those orders here (`context.myOrders`, #226), the defenders my failed attack killed on a
 * territory that stayed its count back into its growth there (`attacked`, `attackKills`): after =
 * before + deploy + transfers in − kills, so deploy ≥ after + kills − before — beside the fog an
 * ambiguous growth like any other, read as deploy up to the turn's bound.
 * One turn only, not smoothed (the tracker reads a history). Transfers in from (or out to) the
 * fog still bias it — income in the fog is unseen anyway.
 */
export function observeDeploy(
  g: MapGraph,
  board: BoardState,
  previous: BoardState,
  playerId: number,
  rates: KillRates = {},
  context: ObserveContext = {},
): DeployObservation {
  const { signed: _signed, ...o } = observeSigned(g, board, previous, playerId, rates, context);
  return o;
}

/**
 * {@link observeDeploy} with its total before the floor at 0 (`signed`): the opponent tracker
 * adds what my own orders measure (#119) to it before flooring.
 */
export function observeSigned(
  g: MapGraph,
  board: BoardState,
  previous: BoardState,
  playerId: number,
  rates: KillRates = {},
  context: ObserveContext = {},
): DeployObservation & { signed: number } {
  const before = new Map(previous.territories.map((t) => [t.territoryId, t]));
  let total = 0;
  /** What `low` and `high` differ from `total` by. */
  let lowExtra = 0;
  let highExtra = 0;
  const counted: number[] = [];
  const captured: number[] = [];
  const fromFog: number[] = [];
  let fogArmies = 0;
  const reveals: number[] = [];
  const reinforced: number[] = [];
  const emptied: number[] = [];
  let emptiedHigh = 0;
  /**
   * The ambiguous armies (#123): growth on its held territories next to a hidden one (a stack
   * may have walked in) and a capture's surplus over what a visible source that shrank into it
   * sent (deploy-then-capture, or a stack out of the fog joined). Read after the loop against
   * one bound, the same for both ({@link ambiguousBound}).
   */
  const ambiguous: { id: number; armies: number; kind: 'growth' | 'capture' }[] = [];
  const now = new Map(board.territories.map((t) => [t.territoryId, t]));
  const defensive = rates.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  const guard = Math.max(0, context.guard ?? 1);
  // #226: my failed attacks' kills, by target: they count back into its growth there.
  const kills =
    context.me !== undefined && context.myOrders
      ? failedAttackKills(g, previous, board, context.me, playerId, context.myOrders, rates)
      : new Map<number, number>();
  const killsAt = (id: number) => kills.get(id) ?? 0;
  /** Held by the observed player (`playerId`, not me) and shown with armies on both boards. */
  const heldBothTimes = (id: number) => {
    const a = visibleState(now.get(id));
    const b = visibleState(before.get(id));
    return a?.owner.kind === 'player' && a.owner.playerId === playerId && b?.owner.kind === 'player' && b.owner.playerId === playerId;
  };
  /**
   * What each of its territories shown with armies on both boards visibly sent away (its
   * shrink): the most a capture next to it can have received from it. A capture draws on it
   * (ascending ids), so two captures never both claim the same armies. What my failed attack killed
   * there (#226: these are exactly {@link failedAttackKills}' targets) is a loss, not armies sent
   * away, so it is taken out of the shrink.
   */
  const shrinkLeft = new Map<number, number>();
  for (const t of board.territories)
    if (g.territoryById.has(t.territoryId) && heldBothTimes(t.territoryId))
      shrinkLeft.set(t.territoryId, Math.max(0, visibleState(before.get(t.territoryId))!.armies! - t.armies! - killsAt(t.territoryId)));
  /** Not shown with armies on both boards: armies could have left it unseen. */
  const hidden = (id: number) => !visibleState(now.get(id)) || !visibleState(before.get(id));
  for (const t of [...board.territories].sort((a, b) => a.territoryId - b.territoryId)) {
    if (!g.territoryById.has(t.territoryId) || !visibleState(t)) continue;
    if (t.owner.kind !== 'player' || t.owner.playerId !== playerId) continue;
    const was = visibleState(before.get(t.territoryId));
    if (!was) {
      reveals.push(t.territoryId);
      continue;
    }
    counted.push(t.territoryId);
    const ns = [...neighborsOf(g, t.territoryId)].sort((a, b) => a - b);
    if (was.owner.kind === 'player' && was.owner.playerId === playerId) {
      // #226: what my failed attack killed there stood there too: defenders after = before + deploy
      // + transfers in − kills.
      const growth = t.armies! - was.armies! + killsAt(t.territoryId);
      if (growth > 0 && ns.some(hidden)) ambiguous.push({ id: t.territoryId, armies: growth, kind: 'growth' });
      else total += growth;
    } else {
      captured.push(t.territoryId);
      // What the capture cost it, always. Taken from me (#123), the defenders were what I left
      // there, which this board cannot tell (I may have attacked out of it): priced at the guard,
      // my stack last turn the high reading.
      if (context.me !== undefined && was.owner.kind === 'player' && was.owner.playerId === context.me) {
        const least = straightKills(Math.min(was.armies!, guard), defensive);
        total += least;
        highExtra += straightKills(was.armies!, defensive) - least;
        emptiedHigh += straightKills(was.armies!, defensive) - least;
        emptied.push(t.territoryId);
      } else total += straightKills(was.armies!, defensive);
      // The armies standing there only as far as a visible source's shrink accounts for them
      // (it cancels them). Beyond that, with a neighbour that was hidden on either board: when a
      // visible source did shrink into it, the attack came from that stack and the rest was
      // deployed on it first (deploy-then-capture, #123); when none did, the rest arrived from
      // the fog — a move, not income (#86). With no hidden neighbour, the rest can only be a
      // deploy on a visible source before it attacked.
      let arrived = t.armies!;
      let claimed = 0;
      for (const n of ns) {
        const left = shrinkLeft.get(n);
        if (!left || !arrived) continue;
        const take = Math.min(left, arrived);
        shrinkLeft.set(n, left - take);
        arrived -= take;
        claimed += take;
        total += take;
      }
      if (arrived > 0 && ns.some(hidden)) {
        if (claimed > 0) ambiguous.push({ id: t.territoryId, armies: arrived, kind: 'capture' });
        else {
          fromFog.push(t.territoryId);
          fogArmies += arrived;
          highExtra += arrived;
        }
      } else total += arrived;
    }
  }
  // #123: the ambiguous armies, read as deploy up to one bound on the turn's deploy — the same
  // bound for growth beside the fog and a reinforced capture's surplus, shared in id order —
  // and the rest as moves out of the fog. The low reading takes all of them out, the high one
  // counts all of them.
  const grewFromFog: number[] = [];
  let fogGrowth = 0;
  const bound = ambiguousBound(context);
  // Without an expected deploy (a board-only reading), growth is all deploy, as before #123.
  if (bound === null)
    for (const x of ambiguous) if (x.kind === 'growth') total += x.armies;
  // A board-only reading (neither `expected` nor `most`) has no room at all: a negative total (a
  // stack of its own that shrank into the fog) must not make room for a capture's surplus.
  let room = bound === null && context.most === undefined ? 0 : Math.max(0, (bound ?? Math.max(0, context.most!)) - total);
  for (const x of [...ambiguous].sort((a, b) => a.id - b.id)) {
    if (bound === null && x.kind === 'growth') {
      lowExtra -= x.armies;
      continue;
    }
    const deployed = Math.min(x.armies, room);
    room -= deployed;
    total += deployed;
    lowExtra -= deployed;
    const moved = x.armies - deployed;
    highExtra += moved;
    if (x.kind === 'capture') {
      if (deployed > 0) reinforced.push(x.id);
      if (moved > 0) fromFog.push(x.id);
    } else if (moved > 0) {
      grewFromFog.push(x.id);
      fogGrowth += moved;
    }
    fogArmies += moved;
  }
  fromFog.sort((a, b) => a - b);
  return {
    deploy: Math.max(0, total),
    signed: total,
    counted,
    captured,
    fromFog,
    fogArmies,
    reveals,
    reinforced,
    grewFromFog,
    fogGrowth,
    expected: context.expected ?? null,
    attacked: [...kills.keys()].sort(byNum),
    attackKills: [...kills.values()].reduce((n, k) => n + k, 0),
    emptied,
    emptiedHigh,
    low: Math.max(0, total + lowExtra),
    high: Math.max(0, total + highExtra),
  };
}

/**
 * How much more than it was expected to deploy an opponent may earn unseen (#123 review): under
 * fog the visible income reads 2–3× low (#119), so ambiguous armies count as deploy up to twice
 * the expected figure. A one-off stack out of the fog is not read as a phantom income; a steady
 * hidden bonus (as large as the visible income) still is, and the tracker, which raises the
 * expected figure to its carried income, learns a larger one over a few turns.
 */
export const HIDDEN_INCOME_FACTOR = 2;

/**
 * The most an opponent's deploy may total once ambiguous armies are counted (#123): twice what
 * it was expected to deploy ({@link HIDDEN_INCOME_FACTOR}), never more than it could earn
 * (`most`). Null without an expected figure: then growth is all deploy and a capture's surplus
 * counts up to `most` (none without it, #86).
 */
function ambiguousBound(context: ObserveContext): number | null {
  if (context.expected === undefined) return null;
  const twice = HIDDEN_INCOME_FACTOR * Math.max(0, context.expected);
  return context.most !== undefined ? Math.min(Math.max(0, context.most), twice) : twice;
}

/** {@link observeDeploy}'s deploy figure alone. */
export function observedDeploy(
  g: MapGraph,
  board: BoardState,
  previous: BoardState,
  playerId: number,
  rates: KillRates = {},
): number {
  return observeDeploy(g, board, previous, playerId, rates).deploy;
}

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
    for (const b of g.map.bonuses) {
      const ts = bonusTerritories(g, b.id);
      if (b.value <= 0 || !ts.length) continue;
      const taken = ts.some((t) => {
        const st = ownerShown(seenNow.get(t));
        return st !== undefined && !(st.owner.kind === 'player' && st.owner.playerId === playerId);
      });
      if (!taken) possible += b.value;
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
    const priorFigure = prior && fogBeside ? Math.min(Math.max(0, Math.floor(priorBase!)), couldEarn) : null;
    // A track over enough turns replaces the single-turn observed figure (S3).
    const track = tracks?.find((t) => t.playerId === playerId);
    const usable = track && track.income !== null && track.turns.length >= TRACKED_MIN_TURNS ? track : undefined;
    const tracked = usable ? usable.income : null;
    // #123: what it was expected to deploy before this observation (its visible income, the
    // prior, or its tracked income): ambiguous armies beyond twice that are moves out of the fog
    // ({@link ambiguousBound}); a capture from me is priced at the guard.
    const observation = previous
      ? observeDeploy(g, board, previous, playerId, settings, {
          me,
          guard: (settings.oneArmyStandsGuard ?? true) ? 1 : 0,
          expected: Math.max(visible, priorFigure ?? 0, tracked ?? 0),
          most: couldEarn,
          ...(when.previousOrders ? { myOrders: when.previousOrders } : {}),
        })
      : null;
    const observedCap = observation ? couldEarn : null;
    const observedRaw = observation?.deploy ?? null;
    const observed = observation ? Math.min(observation.deploy, observedCap!) : null;
    const seenSource: EnemyDeployEstimate['source'] =
      tracked !== null
        ? tracked > visible
          ? 'tracked'
          : 'visible'
        : observed !== null && observed > visible
          ? 'observed'
          : 'visible';
    const seen = seenSource === 'tracked' ? tracked! : seenSource === 'observed' ? observed! : visible;
    // #164: with every owner shown, its income is base + held bonuses exactly; a deploy above it was
    // a card (or armies the board misread), never income.
    const exact = ownersAll && !opening ? Math.max(0, base + bonusIncome) : null;
    const source: EnemyDeployEstimate['source'] =
      exact !== null ? 'exact' : priorFigure !== null && priorFigure > seen ? 'prior' : seenSource;
    const income = source === 'exact' ? exact! : source === 'prior' ? priorFigure! : seen;
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
      trackedTurns: usable ? usable.incomeTurns : [],
      prior: priorFigure,
      source,
      exact,
      card,
      cardPlayed,
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
 * holds. warapp_plan_turn and warapp_submit_turn both use it (plus the armies of the card
 * plays in their orders), so the plan's deploy total is the total the submit check requires.
 */
export function incomeFor(g: MapGraph, board: BoardState, me: number, settings?: GameSettings): number {
  const held = new Set<number>();
  for (const t of board.territories)
    if (g.territoryById.has(t.territoryId) && t.owner.kind === 'player' && t.owner.playerId === me) held.add(t.territoryId);
  return boardIncome(g, held, incomeRules(settings)).total;
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
