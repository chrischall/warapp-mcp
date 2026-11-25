// Opponent tracking (S3): what a history of my own boards says about each opponent. Pure and
// deterministic (ties on ascending id, no I/O).
//
// Every turn pair is read with F1's rules (#69, `observeDeploy`): only territories visible on
// both boards count, so a stack that comes out of the fog is never deploy, never a capture and
// never "armies that moved into the fog". A capture out of the fog (#86, `fromFog`) counts
// what it cost (the defenders' kills at the defensive kill rate), never the stack standing
// there: that stack moved, it is not income. From the per-turn observations:
//  - income (visible income is the one income rule, `boardIncome`, via enemyDeployEstimates):
//    over the last {@link INCOME_TURNS} observed turns, the larger of the most it was observed
//    to deploy and its stock and flow (visible army change plus visible losses, less the armies
//    that arrived from the fog, per turn),
//    capped at the most it could earn in that window and floored at what it visibly earns on
//    the newest board (base income + the bonuses it visibly holds in full) — see
//    {@link trackedIncome} (#99). It never decays (#119): walking the observed turns, a window's
//    figure replaces the carried one only when larger; otherwise the carried figure stays, less
//    the value of each bonus it visibly held in full that the next board shows broken, and never
//    above that turn's could-earn cap (`incomeMethod` 'carried'). Given my own orders on a turn
//    (`TurnBoard.orders`), they are measurements ({@link measureOrders}): the defenders my failed
//    attacks killed, what a hold of mine that fell really killed, and what its failed attack on a
//    hold of mine cost it — and that failed attack bounds the turn's deploy from below (#271,
//    `repelledFloor`: the attackers my loss needed less its stacks beside the hold), and so does a
//    capture with every source army in view (#418, `captureFloor`): proof may always raise an
//    estimate — the turn reads at least that, a carry it reaches is confirmed, and the #418 rise cap
//    never holds the carry below it. Proof may lower an estimate only on a turn with every army it could
//    have deployed in view (#418, {@link everyArmyInView}): the carry then steps down at most one
//    {@link RISE_CAP} step a turn toward that turn's reading, never below it (the over-read tripwire,
//    {@link carryIncome}; `incomeMethod` 'tripped', `incomeTrip`). A pattern of
//    captures of neutrals in view that needed attackers its stacks in view did not send
//    ({@link FOG_CAPTURE_MIN} turns in {@link FOG_CAPTURE_TURNS}, #271 `fogCaptures`) is income: those
//    attackers spread over the turns, a carry no later quiet turn disproves; arrivals from its stacks
//    hidden the turn after (#271) are left out of the stock and flow like fog arrivals;
//  - unexplained armies (#123): the income it earned since first seen (each turn: what it
//    visibly earned, or what it was seen to deploy when more) minus the change of its visible
//    armies, what it visibly lost, and what it may have lost fighting where its stack and a
//    neighbour of another player both shrank — armies in the fog, spent there, or a misread;
//  - inferred bonuses: when the income beats the visible income, the combinations of bonuses
//    it could hold (none of their territories visibly held by anyone else, neutral included)
//    whose values come closest to the gap — only bonuses within {@link INFER_REACH} hops of a
//    territory it visibly holds, and that it could have paid for (#123: a member not visibly its
//    costs at least {@link NEUTRAL_CAPTURE_LOSS}, against its starting armies plus what it was
//    seen to earn on the observed turns and the base income on the others), nearest first. They are candidates, never an assertion; when more than
//    {@link MAX_LISTED_COMBINATIONS} fit, none is listed.
//
// Stacks that left view (#164): each territory's last sighting of a large stack of its (at least
// {@link LOST_STACK_INCOMES} × its visible income that turn, beyond the guard) that no later board
// showed again — fogged, or its armies hidden — is kept with its turn (`lostStacks`), and so is a
// large stack that walked off a territory still in view (Normal fog: what borders me never leaves
// view) into the fog: the shrink beyond what its neighbours in view gained, with a neighbour the
// fog hides, and no fight beside it. Under fog that hides every stack, an owner-only territory it
// took counts in its army change at the guard, and the capture at what the defenders killed
// (NEUTRAL_CAPTURE_LOSS when hidden), so its unaccounted armies are not all it earned; the planner
// counts it at every border of mine it can reach by now, for {@link LOST_STACK_TURNS} turns. A
// stack is tracked by territory, so each large stack of its that came into view after (not large
// there on the board before) within the lost one's reach (one move a turn) is taken as it, or the
// part of it in view: it offsets the lost armies once, and what is left stays lost while large.
// #201: an attack out of the fog fixes where a lost stack is. The boards carry no attack events, but
// a territory of mine taken by the player with none of its territories in view beside it (a
// neighbour the fog hid) was attacked from the fog: the largest lost stack of its that could stand
// beside it then is counted as last seen on that territory on that turn.
//
// One-off movements (#123): each observed turn carries a low and a high reading of its deploy
// (`observeDeploy`): growth next to the fog and the surplus of a capture whose visible attacking
// stack shrank are read as deploy up to twice what it was expected to deploy (its visible income,
// or the income carried so far — so a steady hidden income is learnt over a few turns; the
// tracker does not apply the planner's fog prior, so in a 1v1 a turn the planner reads with the
// prior can read lower here) and at most what it could earn, the rest as a move out of the fog; a
// carry that only bound-cut readings reached ends at a later turn read in full that observed less
// ({@link carryIncome}); a capture from me is priced at the guard unless my orders say what stood
// there.
//
// An income set by one turn far above the turns before it (#250, {@link incomeJump}: more than
// {@link INCOME_JUMP_FACTOR} × the most it was seen to earn on them) is kept — such a turn is
// usually the first true reading after turns it deployed out of sight — and a warning says, in
// numbers, whether the boards back it: its armies in view after the jump plus its losses seen
// against its armies in view before plus what it was seen to earn since. More, even leaving out the
// armies that only came into view (the jump turn's own #123 ambiguous armies among them: read as
// deploy, they may be a stack out of the fog), is armies it could not have banked; otherwise the warning hedges
// (old armies revealed, or armies it banked out of view). #254: the warning leads with that verdict
// in about a dozen words, then one sentence of numbers; the full figures are `incomeJump`. Given its starting armies, the whole game
// is weighed at the most it was seen to earn on any observed turn before the jump. The armies on
// territory it took from me on the jump turn are named. Its losses seen leave out the likely combat
// deaths ({@link combatLosses}: a guess that can read a transfer as a fight). No warning when a later
// observed turn also reads more than the factor × that most: the income then rests on more than one
// turn. The figure never changes for it.
//
// Given the game's players (#94), every opponent still playing is listed — teammates and
// players out of the game are not — even with no territory in view: `visible` counts its
// territories in view on the newest board, `turnsUnseen` the latest turns none was, counted back
// over my boards to the one that last showed it, or to turn 1 (every turn of the game). Where my
// boards stop first (the oldest board, or a gap), it is a floor (`turnsUnseenAtLeast`) and the
// text says "at least". For one with nothing in view,
// `earnedAtLeast` is a LOWER BOUND on the armies it has received since the game started: its
// starting armies (TerritoryLimit × InitialPlayerArmiesPerTerritory, when the settings give
// them) + the base income (the one income rule, `boardIncome`, over no territory: the
// MinimumArmyBonus floor, never a bonus) for every turn so far, the turn being played included
// (its income is paid at the start of the turn). Armies received, not held: neutral captures
// cost armies, so it could be banking up to roughly that, minus what its expansion cost. A
// warning says when the bound beats my largest stack, and separately my total visible armies.
import type { BoardState, TerritoryState } from '../board.js';
import type { GameMap, GameSettings } from '../normalize.js';
import { holdsSeat } from '../player-states.js';
import { carriesTeam, isTeamGame } from '../teams.js';
import { neutralizeSeats, staticSeats, type SeatEndRules } from './static-seats.js';
import { bonusTerritories } from './bonuses.js';
import { DEFAULT_DEFENSIVE_KILL_RATE, DEFAULT_OFFENSIVE_KILL_RATE, guaranteedKills, luckFraction, straightKills } from './combat.js';
import { bfsDistances, neighborsOf, type MapGraph } from './graph.js';
import { bombPossibleOn, enemyDeployEstimates, localFreeOn, LOW_COVERAGE, TRACKED_MIN_TURNS, type PlannerSettings } from './planner.js';
import { captureFloor, failedAttackKills, frontierCoverage, holdLosses, observeSigned, ownerShown, repelledFloor, coverageText, trackCoverage, visibleState, type FrontierCoverage, type TrackCoverage, type RepelledAttacks } from './plan/observe.js';
import { boardIncome, DEFAULT_BASE_INCOME } from './player.js';

/** #164: a stack is large when its armies are at least this many turns of its visible income. */
const LOST_STACK_INCOMES = 2;
/** #164: lost stacks kept per opponent. */
export const MAX_LOST_STACKS = 5;
/**
 * #164: the planner counts a lost stack for this many turns after it was last seen, then drops it:
 * by then it has been spent, split or seen without the tracker telling which.
 */
export const LOST_STACK_TURNS = 6;

/** #164: a large stack of an opponent last seen on `territoryId` on `turn`, hidden since. */
interface LostStack {
  territoryId: number;
  turn: number;
  armies: number;
}

/** One of my boards and the turn it was seen on (the turn being played on it). */
export interface TurnBoard {
  turn: number;
  board: BoardState;
  /**
   * My own orders on that turn, when known (#119): measurements of what the opponents deployed
   * ({@link measureOrders}). Unknown orders change nothing.
   */
  orders?: MyOrders;
  /** Profiles A1: `history` for a board read from GameFeed's unverified `GetHistory`; absent for a cached live board. */
  source?: 'history';
}

/** My orders on one turn (#119): my deploys and the moves I sent (attacks and transfers alike). */
export interface MyOrders {
  deploys: readonly { territoryId: number; armies: number }[];
  /** `commander` (#274): the move took my commander along. Absent in caches written before it. */
  moves: readonly { from: number; to: number; armies: number; commander?: true }[];
  /**
   * B4: every move order sent, in order, a Transfer Only one flagged (it attacks nothing); percentage
   * and Attack Only orders kept, which `moves` leaves out. What a chat commitment is checked against.
   * Absent in caches written before it. Never read by opponent tracking.
   */
  sent?: readonly { from: number; to: number; transferOnly?: true; commander?: true }[];
  /**
   * Profiles A1: every card play sent, by card name, with the territories it touches (an Airlift's
   * `from` and `to`, a Gift's or Blockade's `target`). Empty when none was played; absent in caches
   * written before it, where a card play is unknown. Never read by opponent tracking.
   */
  cards?: readonly MyCardPlay[];
}

/** One card play of mine and the territories it touches (profiles A1). */
export interface MyCardPlay {
  card: string;
  from?: number;
  to?: number;
  target?: number;
}

/** Observed turns (the latest) feeding the income estimate (#99: {@link trackedIncome}). */
const INCOME_TURNS = 3;
/**
 * #271 (2): turns with a capture of a neutral in view that needed attackers out of sight, among the
 * last {@link FOG_CAPTURE_TURNS} turns, that make a pattern: income, not a move.
 */
export const FOG_CAPTURE_MIN = 3;
/** #271 (2): the turns a pattern of such captures is looked for in. */
export const FOG_CAPTURE_TURNS = 6;
/** Most bonuses in one inferred combination. */
const MAX_COMBINATION = 3;
/** Inferred combinations listed; when more fit, none is (#123: too many to name any). */
export const MAX_LISTED_COMBINATIONS = 8;
/** #123: an inferred bonus has a member within this many hops of a territory it visibly holds. */
export const INFER_REACH = 4;
/** #123: the least a territory it is not seen holding cost it to take (a 2-army neutral at 70%). */
const NEUTRAL_CAPTURE_LOSS = 1;

/** What one turn (board `from` → board `to`) showed of one opponent. */
export interface ObservedTurn {
  /** The turn whose orders the change shows (the earlier board's turn). */
  from: number;
  /** The later board's turn (`from + 1`: only consecutive boards are compared). */
  to: number;
  /**
   * #294: how much of its frontier the turn could read ({@link frontierCoverage}). Absent on a turn
   * built by hand.
   */
  coverage?: FrontierCoverage;
  /**
   * #418: my income on the later board, when my armies in view there were at least
   * {@link LEAD_ARMIES} × its own; absent otherwise. While it is above the carry before the turn (or
   * that turn's visible income), an unconfirmed rise is held ({@link RISE_CAP}), however far the
   * reading itself goes above it.
   */
  leadIncome?: number;
  /**
   * #420: the most one of its stacks beside my land grew that turn ({@link borderTopUp}); absent when no
   * stack of its beside my land was in view with armies on both boards, or either board came from
   * GameFeed history (its army counts are unverified).
   */
  topUp?: number;
  /** Its observed deploy, capped at what it could earn ({@link ObservedTurn.cap}). */
  observed: number;
  /** The observed deploy before the cap ({@link ObservedTurn.measured} included). */
  raw: number;
  /**
   * #123: what it was expected to deploy that turn, the base of the bound on its ambiguous armies
   * (twice this): its visible income or the income carried before the turn, whichever is more.
   * Absent when the reading had no bound. The planner reads the newest turn with it, and its label of
   * a cut reading names it (#235 1c, `EnemyDeployEstimate.newestCut`).
   */
  expected?: number;
  /**
   * What my own orders on the earlier turn measured (#119, {@link measureOrders}), added to the
   * board's reading before the floor at 0 and to `losses`: the defenders my failed attacks killed,
   * on a hold of mine that fell, what its defenders really killed, and the attackers it lost on a
   * hold of mine that held. 0 without my orders.
   */
  measured: number;
  /**
   * Bonuses it visibly held in full on the earlier board of which the later one shows a member
   * held by someone else: visibly broken (#119: only that lowers a carried income).
   */
  broken: number[];
  /** Their total value. */
  brokenValue: number;
  /** Base income plus every bonus it could still hold, on the later board. */
  cap: number;
  /** Territories visible on both boards and its on the later one, by id. */
  counted: number[];
  /** Of `counted`, those it took from another visible owner. */
  captured: number[];
  /** Of `captured`, those taken (at least partly) out of the fog (#86): only their cost is deploy. */
  fromFog: number[];
  /**
   * The armies that arrived out of the fog on `fromFog` (#86): in `net` (they came into view),
   * but a move, never income — {@link trackedIncome}'s stock and flow takes them out.
   */
  fogArmies: number;
  /** Its territories on the later board that the earlier one did not show: fog reveals. */
  reveals: number[];
  /**
   * #123: the deploy that turn with every ambiguous army read the low way (a stack out of the
   * fog, a capture from me priced at the guard) and the high way (deployed, my stack standing),
   * my orders' measurement included; `raw` lies between them.
   */
  low: number;
  high: number;
  /** Captures whose surplus over what a visible stack sent counted as deploy-then-capture (#123). */
  reinforced: number[];
  /** Its territories whose growth next to the fog was read as a move out of it (#123). */
  grewFromFog: number[];
  /** Captures from me priced at the guard I may have left (#123; my orders, when known, measure them). */
  emptied: number[];
  /**
   * #271 (3): armies on its captures that its stacks in view beside them, hidden the turn after,
   * may have sent: arrivals, in `net` but neither income nor a move out of the fog —
   * {@link trackedIncome}'s stock and flow takes them out. Absent (0) on a turn built by hand, as are
   * the #271 fields below.
   */
  arrivals?: number;
  /** #271 (2): its captures of a neutral in view that needed attackers its stacks in view did not send. */
  unseenAttackers?: number[];
  /** #271 (2): the attackers they needed beyond those, unbounded (read as income only as a pattern: `fogCaptures`). */
  unseenAttackerArmies?: number;
  /** #271 (1): its failed attacks on my holds that turn, as {@link repelledFloor} read them (given my orders); else null. */
  repelled?: RepelledAttacks | null;
  /** #271 (1): the attackers my losses there needed less its stacks beside them: `raw`, `low` and `high` are at least this. */
  repelledFloor?: number;
  /** #418: its captures read with every source army in view ({@link captureFloor}); absent with no floor. */
  proven?: number[];
  /**
   * #418: the deploy those captures prove: `raw`, `low` and `high` are at least this, and a carry it
   * reaches is confirmed ({@link confirmedBy}): proof may always raise an estimate. Absent with no floor.
   */
  captureFloor?: number;
  /**
   * #418: every army it could have deployed that turn is accounted for in view ({@link everyArmyInView}):
   * the over-read tripwire may lower the carry toward this turn's reading ({@link carryIncome}).
   */
  accounted?: true;
  /**
   * #271 (2): a pattern of such captures ending on this turn: {@link FOG_CAPTURE_MIN} or more turns
   * with one among the last {@link FOG_CAPTURE_TURNS} observed turns (by turn number). `income` is
   * their attackers spread over the turns from the first of them to this one, at most this turn's
   * `cap`; {@link trackedIncome} takes it as income. Absent without a pattern.
   */
  fogCaptures?: { turns: number[]; armies: number; income: number };
  /**
   * #123: armies it may have lost fighting where its stack and a neighbour of another player both
   * shrank (the neighbour's losses at the kill rates: round(shrink × offensive ÷ defensive)), each
   * neighbour counted once; with my orders known, mine count only where an attack on a hold of mine
   * is pinned on no one (the loss my orders do not explain). Only the unexplained
   * armies use it: the board cannot tell a fight from a transfer.
   */
  combat: number;
  /** Base income + visibly held bonuses on the earlier board: what it surely earned that turn. */
  visibleIncome: number;
  /** What it earned, as far as can be told: max(visibleIncome, observed). */
  earned: number;
  /** Change of its armies over territories visible on both boards (held on either). */
  net: number;
  /**
   * Armies it visibly lost: whole stacks on territories taken from it, and what its captures
   * cost (the defenders' kills at the defensive kill rate, as observeDeploy counts them).
   */
  losses: number;
}

/** One combination of bonuses that would explain an income gap. */
interface BonusCombination {
  bonusIds: number[];
  total: number;
  /** Hops from a territory it visibly holds to the nearest member, summed over its bonuses (#123). */
  hops: number;
}

interface InferredBonuses {
  /** income − visibleIncome. */
  gap: number;
  /** Some combination's values sum to exactly the gap. */
  exact: boolean;
  /**
   * The best-fitting combinations (fewest bonuses first, then nearest, then ids); none when more
   * than {@link MAX_LISTED_COMBINATIONS} fit (#123).
   */
  candidates: BonusCombination[];
  /** Combinations that fit equally well, not listed (all of them when none is). */
  more: number;
  /** Bonuses left out as beyond reach or more than it could have paid for (#123). */
  implausible: number;
}

/** One player of the game (GameFeed ids, like the board's). */
export interface TrackPlayer {
  id: number;
  /** Its display name, for the warnings (else `Player <id>`). */
  name?: string;
  /** Its team; absent or -1 (`NO_TEAM`) in a no-team game. */
  team?: number;
  /** GameFeed state, e.g. `Playing`, `Eliminated`; absent counts as `Playing`. */
  state?: string;
  /** #270: an AI now plays this human's seat (it stays an opponent when out). */
  humanTurnedIntoAI?: boolean;
}

/** The game around the boards (#94): who is still playing, and what each started with. */
export interface TrackGame {
  players: readonly TrackPlayer[];
  /**
   * #270: the players out of the game whose seat no AI plays ({@link staticSeats}), ascending, teammates
   * included: a reader takes {@link staticSeatsFor} (no ally of mine), whose territories read as
   * neutrals on every board, and who are tracked as no opponent.
   */
  staticSeats?: readonly number[];
  /** Territories each player started with, and the armies on each, when the settings give them. */
  start?: { territories: number; armiesPerTerritory: number };
  /** Why `start` is absent (said in the note). */
  startUnknown?: string;
  /**
   * #205: with `start` absent but every player given the same share of the map (full
   * distribution, or no TerritoryLimit), the armies each starting territory had: a player
   * started with at most ⌈territories ÷ players⌉ of them, an upper bound for the outlook.
   */
  startArmiesPerTerritory?: number;
  /**
   * #214 review: full distribution split every territory among the players, so the even share
   * (⌈territories ÷ seated players⌉ × `startArmiesPerTerritory`) is every player's real start, not
   * only a bound on it.
   */
  fullDistribution?: true;
  /** Settings under which the base income each turn may not be a floor (e.g. Sanctions), said in the note. */
  incomeCaveats?: string[];
}

/** What an opponent with no territory in view must have received since the game started (#94). */
interface EarnedBound {
  /** (start ?? 0) + baseIncome × turns: a lower bound on armies received, not on armies held. */
  total: number;
  /** Its starting armies; `null` when the settings do not give them (left out of `total`). */
  start: number | null;
  /** The base income it surely earned each turn (no bonus counted). */
  baseIncome: number;
  /** Turns of income paid so far: every turn of the game, the one being played included. */
  turns: number;
  /** My largest stack on the newest board. */
  largestStack: number;
  /** My total visible armies on the newest board. */
  visibleArmies: number;
  exceedsLargest: boolean;
  exceedsTotal: boolean;
}

export interface OpponentTrack {
  playerId: number;
  /** The first turn whose board showed any territory of it; `null` when none ever did. */
  firstSeen: number | null;
  /** The newest turn in the history. */
  lastTurn: number;
  /** Observed turns since first seen, oldest first. */
  turns: ObservedTurn[];
  /** Base income on the newest board (visible territories). */
  base: number;
  /** Bonuses it visibly holds in full on the newest board. */
  bonusIncome: number;
  /** base + bonusIncome: what it visibly earns. */
  visibleIncome: number;
  /**
   * Its income estimate over the last {@link INCOME_TURNS} observed turns ({@link trackedIncome},
   * #99), at least `visibleIncome`; `null` before any observed turn.
   */
  income: number | null;
  /** The `from` turns the estimate used (its window), oldest first. */
  incomeTurns: number[];
  /**
   * #294: how much of its frontier the window's turns read ({@link trackCoverage}); `null` before any
   * observed turn. Absent on a track built by hand.
   */
  coverage?: TrackCoverage | null;
  /** The least and the most it was observed to deploy over that window; `null` before any observed turn. */
  observedRange: { min: number; max: number } | null;
  /** Which term set `income` ({@link IncomeMethod}); `null` before any observed turn. */
  incomeMethod: IncomeMethod | null;
  /**
   * With `incomeMethod` `'carried'`: what the window it came from gave less what it is now
   * (the bonuses visibly broken since, or a lower could-earn cap); else 0.
   */
  incomeLowered: number;
  /**
   * #418: with `incomeMethod` `'rise-capped'`: what its window read and the income carried before
   * it; the income is {@link RISE_CAP} × that, rounded up. Absent otherwise.
   */
  incomeRise?: IncomeRise;
  /**
   * #567: the highest low end any turn of its income window read (each turn's `low`, at most its could-earn
   * `cap`) — every ambiguous army read as a move, so the least that turn deployed — when it is above
   * `income`: the #418 rise cap or the tripwire's ceiling holds the estimate below what a turn surely read.
   * `high` that turn's high end (at most its cap), `coverage` the share of its frontier the turn read
   * (`null` when none was measured). Reported only: the estimate is unchanged. Absent otherwise.
   */
  observedLow?: ObservedLow;
  /**
   * #418: with `incomeMethod` `'tripped'`: the over-read tripwire's latest step — the carry it stepped
   * down `from`, the reading `proven` on turn `turn`, a turn with every army it could deploy in view.
   * Absent otherwise.
   */
  incomeTrip?: IncomeTrip;
  /**
   * Unexplained armies (#123): the income it earned since first seen minus its visible army
   * change, its visible losses and what it may have lost fighting (`combat`) — armies that are
   * in the fog, or were spent there, or a misread (≥ 0); `null` before any observed turn.
   */
  unexplained: number | null;
  /** Bonuses that could explain `income − visibleIncome`; `null` when there is no gap. */
  inferred: InferredBonuses | null;
  /**
   * #420: its largest top-up seen — the most one of its stacks beside my land grew in one turn over its
   * observed turns ({@link ObservedTurn.topUp}); `null` when no turn read one. Absent on a track built by hand.
   */
  topUp?: number | null;
  /** Its territories in view on the newest board. */
  visible: number;
  /**
   * The latest turns with none of its territories in view (0 when some are in view), counted
   * over my boards: back to the board that last showed it, or to turn 1.
   */
  turnsUnseen: number;
  /**
   * `true` when my boards stop before that (the oldest board, or a gap, comes after it could
   * last have been in view): `turnsUnseen` is then a floor, counted from the boards I have.
   */
  turnsUnseenAtLeast: boolean;
  /** With nothing in view: what it must have received since the game started; else `null`. */
  earnedAtLeast: EarnedBound | null;
  /**
   * #164: its large stacks that left view — each territory's last sighting of a stack of at least
   * {@link LOST_STACK_INCOMES} × its visible income that turn, when no later board showed that
   * territory again, less the stacks of its that came into view within its reach since (largest
   * first, then id; at most {@link MAX_LOST_STACKS}, counted among those last seen at most
   * {@link LOST_STACK_TURNS} turns before the newest board). Absent on a track built by hand.
   */
  lostStacks?: LostStack[];
  /**
   * #250: the income rests on one turn far above the turns before it ({@link incomeJump}), with the
   * evidence for and against it; absent otherwise. The income itself is never changed for it.
   */
  incomeJump?: IncomeJump;
  /**
   * Unseen-banking warnings (#94) and the line on an income set by one high turn (#250), each
   * naming it (also in `notes`).
   */
  warnings: string[];
  /** Confidence notes, plain sentences. */
  notes: string[];
}

/**
 * {@link TrackGame} from GameFeed's players and settings: each player's starting armies are
 * TerritoryLimit × InitialPlayerArmiesPerTerritory, unless either is missing, the game uses full
 * distribution ({@link fullDistribution}, #428: DistributionMode 0 with no TerritoryLimit — every
 * territory is split among the players; -1 is a limited start) or a map distribution that is not `normal` (a
 * scenario sets its own starts). A Sanctions card is an income caveat: it can cut income below
 * the base the bound counts.
 */
export function trackGame(
  players: readonly TrackPlayer[],
  settings:
    | (Pick<GameSettings, 'territoryLimit' | 'initialPlayerArmiesPerTerritory' | 'distributionMode'> & { cards?: readonly string[] })
    | undefined,
  map?: Pick<GameMap, 'distributionModes'>,
  /** #270: the game's end rules (`Game.endRules`): whether a surrendered or booted seat is played by an AI. */
  endRules?: SeatEndRules,
): TrackGame {
  const list = players.map((p) => ({
    id: p.id,
    ...(p.name !== undefined ? { name: p.name } : {}),
    ...(p.team !== undefined ? { team: p.team } : {}),
    ...(p.state !== undefined ? { state: p.state } : {}),
    ...(p.humanTurnedIntoAI ? { humanTurnedIntoAI: true } : {}),
  }));
  const caveats = settings?.cards?.includes('Sanctions')
    ? ['the game has the Sanctions card, which can cut a sanctioned player\'s income below the base']
    : [];
  // Every static seat; a reader leaves out me and my teammates (`staticSeatsFor`).
  const seats = [...staticSeats(list, endRules).keys()].sort(byNum);
  const base = { players: list, ...(seats.length ? { staticSeats: seats } : {}), ...(caveats.length ? { incomeCaveats: caveats } : {}) };
  const perTerritory =
    settings?.initialPlayerArmiesPerTerritory !== undefined ? { startArmiesPerTerritory: Math.max(0, settings.initialPlayerArmiesPerTerritory) } : {};
  if (fullDistribution(settings))
    return {
      ...base,
      startUnknown: 'the game uses full distribution, which splits every territory among the players whatever the territory limit',
      ...perTerritory,
      fullDistribution: true,
    };
  const mode = map?.distributionModes.find((d) => d.id === settings?.distributionMode);
  if (mode?.type !== undefined && mode.type !== 'normal')
    return { ...base, startUnknown: `the game uses the map's "${mode.name}" distribution (${mode.type}), which sets its own starting armies` };
  const territories = settings?.territoryLimit;
  const armiesPerTerritory = settings?.initialPlayerArmiesPerTerritory;
  if (territories === undefined || territories <= 0)
    return { ...base, startUnknown: "the settings do not give the territories each player started with (TerritoryLimit)", ...perTerritory };
  if (armiesPerTerritory === undefined)
    return { ...base, startUnknown: 'the settings do not give the armies each starting territory had (InitialPlayerArmiesPerTerritory)' };
  return { ...base, start: { territories, armiesPerTerritory: Math.max(0, armiesPerTerritory) } };
}

/**
 * #270: the static seats of {@link TrackGame.staticSeats} that are not `me` nor a teammate of mine, by
 * id with their state: the players whose territories a reader treats as neutrals.
 */
export function staticSeatsFor(game: TrackGame | undefined, me: number): Map<number, string> {
  const ids = new Set(game?.staticSeats ?? []);
  if (!ids.size) return new Map();
  return staticSeats(game!.players.filter((p) => ids.has(p.id) || p.id === me), undefined, me);
}

/** TerritoryLimit assumed when the settings do not say (war.app's usual default). */
export const DEFAULT_TERRITORY_LIMIT = 3;

/**
 * GameFeed's DistributionMode for full distribution: the client's id (docs/WARAPP-API.md, #235). #428:
 * -1 is a limited start (the client's random warlords: TerritoryLimit territories each), verified on
 * three finished games, where reading it as full distribution put an opponent's start at 189 for a real 9.
 */
const FULL_DISTRIBUTION = 0;

/**
 * #428: the game deals every territory among the players — DistributionMode 0 with no TerritoryLimit
 * (unset or 0: the client's "no cap"). Mode 0 with a TerritoryLimit stays a limited start (the client
 * caps each player's share by the limit; that a full-distribution game never sends one is unverified).
 */
export function fullDistribution(settings: Pick<GameSettings, 'distributionMode' | 'territoryLimit'> | undefined): boolean {
  return settings?.distributionMode === FULL_DISTRIBUTION && !(settings.territoryLimit !== undefined && settings.territoryLimit > 0);
}

/** GameFeed's DistributionMode for a custom scenario (the client's id; unverified on GameFeed, docs/WARAPP-API.md). */
const CUSTOM_SCENARIO = -3;

/**
 * Why the start may not have been even (#119: the planner's fog prior needs an even one), or
 * `undefined` when every player started with the same territories and armies. #235: the client's
 * own rules (docs/WARAPP-API.md "Starting armies and DistributionMode"): full, random warlords,
 * random cities and every map distribution — a map's "scenario" distribution included, which only
 * says WHERE each player or team starts and still gives each the same number of territories at the
 * same armies — start even; only a custom scenario (DistributionMode -3, or a `CustomScenario`
 * setting), the game creator's own territory-by-territory start, may not. Unknown (no settings, no
 * DistributionMode) is not even: the prior stays off.
 */
export function unevenStart(settings: (Pick<GameSettings, 'distributionMode'> & { raw?: Record<string, unknown> }) | undefined): string | undefined {
  const mode = settings?.distributionMode;
  if (mode === undefined) return 'the settings do not say how the territories were distributed (DistributionMode)';
  const custom = settings?.raw?.CustomScenario;
  const set = custom !== undefined && custom !== null && custom !== false && !(typeof custom === 'string' && /^\s*(null|none|false)?\s*$/i.test(custom));
  if (mode === CUSTOM_SCENARIO || set)
    return "the game uses a custom scenario, which sets each player's starting territories and armies by hand";
  return undefined;
}

/** Every player started with the same territories and armies ({@link unevenStart} names no reason). */
export function symmetricStart(settings: Parameters<typeof unevenStart>[0]): boolean {
  return unevenStart(settings) === undefined;
}

/** Player states still in the game (absent counts as playing), as the profile counts them. */
const playing = (p: TrackPlayer) => (p.state ?? 'Playing') === 'Playing';

const byNum = (a: number, b: number) => a - b;

/**
 * Which term set a tracked income: `max-observed` the most it was observed to deploy,
 * `stock-flow` its visible army change plus visible losses (less fog arrivals) per turn, `visible` what it visibly
 * earns on the newest board (base + bonuses it visibly holds in full), `carried` an earlier
 * window's figure kept (#119: an income never decays unless a bonus it visibly held is visibly
 * broken, or the most it could earn falls below it), `fog-captures` a pattern of captures of neutrals in
 * view that needed attackers out of sight (#271: {@link ObservedTurn.fogCaptures}).
 */
export type IncomeMethod = 'max-observed' | 'stock-flow' | 'visible' | 'carried' | 'fog-captures' | 'rise-capped' | 'tripped';

/**
 * #418: a rise no turn read in full confirmed ({@link confirmedBy}) is held to this many times the
 * income carried before it, each turn: walk-ins beside the fog are read up to twice the carry (#123),
 * so without it they compounded (10, 20, 40, …) while nothing backed them. Unmeasured beyond #418's
 * calibration run.
 */
export const RISE_CAP = 1.3;

/**
 * #567 (owner decision 2026-11-25): a turn read from at least this share of its frontier
 * ({@link ObservedTurn.coverage}) is evidence enough that its low end (every ambiguous army read as a move,
 * at most its could-earn cap) was deployed: the {@link RISE_CAP} hold never stays below it. Offline, on the
 * calibration records, no turn read at 60% or more had a low end above the truth.
 */
export const RISE_LOW_COVERAGE = 0.6;

/** #418: my armies in view against its own, at or above which I lead it on the board ({@link ObservedTurn.leadIncome}). */
export const LEAD_ARMIES = 3;

/** A tracked income and how it was reached ({@link trackedIncome}). */
interface TrackedIncome {
  income: number;
  method: IncomeMethod;
  observedRange: { min: number; max: number };
  /** Its stock and flow over the window, before the cap. */
  stockFlow: number;
  /** The highest could-earn cap in the window. */
  cap: number;
}

/**
 * Income over a window of observed turns (#99). Each observed deploy is a LOWER BOUND on that
 * turn's income: deploys onto fogged territories are unseen, and so are armies moved into the
 * fog or lost in failed attacks. The median of lower bounds is no bound at all — one quiet turn
 * (an opponent deploying into the fog) drags it to the floor — so the estimate is the largest:
 * the tightest lower bound the window gives. Its stock and flow is the change of its visible
 * armies over territories visible on both boards of each pair, plus what it visibly lost, less
 * the armies that arrived out of the fog (#86: a stack out of the fog moved, it is not income),
 * summed over the window and divided by its length — rounded up, erring high on an opponent as
 * the planner does, and at least 0. With the fog arrivals out it is each turn's uncapped
 * observed deploy averaged, so it sets the income only when a turn's observation was cut by a
 * lower could-earn cap than the window's highest. The larger of the two is capped at the
 * highest per-turn could-earn cap in the window (each observation already is), then floored at
 * what it visibly earns, `visibleIncome`. Ties name the floor first, then the observation.
 */
export function trackedIncome(window: readonly ObservedTurn[], visibleIncome: number): TrackedIncome {
  const observed = window.map((x) => x.observed);
  const maxObserved = Math.max(...observed);
  const stockFlow = Math.max(0, Math.ceil(window.reduce((s, x) => s + x.net + x.losses - x.fogArmies - (x.arrivals ?? 0), 0) / window.length));
  const cap = Math.max(...window.map((x) => x.cap));
  const flow = Math.min(cap, stockFlow);
  // #271 (2): a pattern of captures that needed attackers out of sight, ending in the window.
  const pattern = Math.max(0, ...window.map((x) => x.fogCaptures?.income ?? 0));
  const fromWindow = Math.max(maxObserved, flow, pattern);
  const method: IncomeMethod =
    visibleIncome >= fromWindow ? 'visible' : maxObserved >= Math.max(flow, pattern) ? 'max-observed' : flow >= pattern ? 'stock-flow' : 'fog-captures';
  return {
    income: Math.max(visibleIncome, fromWindow),
    method,
    observedRange: { min: Math.min(...observed), max: maxObserved },
    stockFlow,
    cap,
  };
}

/** `turn 4` or `turns 4–6`. */
const turnSpan = (turns: readonly number[]) =>
  turns.length === 1 ? `turn ${turns[0]}` : `turns ${turns[0]}–${turns.at(-1)}`;

/**
 * How a track's income was reached, for a rationale line or a note, e.g. "max observed over
 * turns 9–11, observed 3–31"; `null` before any observed turn.
 */
export function incomeBasis(
  t: Pick<OpponentTrack, 'incomeMethod' | 'incomeTurns' | 'observedRange'> &
    Partial<Pick<OpponentTrack, 'incomeLowered'>> & { incomeRise?: OpponentTrack['incomeRise'] | null; incomeTrip?: IncomeTrip | null },
): string | null {
  if (!t.incomeMethod || !t.observedRange || !t.incomeTurns.length) return null;
  const span = turnSpan(t.incomeTurns);
  const range = `observed ${t.observedRange.min}–${t.observedRange.max}`;
  if (t.incomeMethod === 'carried')
    return t.incomeLowered
      ? `carried from ${span}, ${range}, less ${t.incomeLowered} for what it has visibly lost since`
      : `carried from ${span}, ${range}: no bonus it visibly held has been visibly broken since`;
  if (t.incomeMethod === 'max-observed') return `max observed over ${span}, ${range}`;
  if (t.incomeMethod === 'rise-capped')
    return t.incomeRise
      ? t.incomeRise.proven !== undefined
        ? `max observed over ${span}, ${range}, held at the +${t.incomeRise.proven} a capture with every source in view proved (above ${RISE_CAP}× the ~${t.incomeRise.before} before it): no turn read in full reached ${t.incomeRise.read}`
        : t.incomeRise.low !== undefined
          ? `max observed over ${span}, ${range}, held at the +${t.incomeRise.low} a turn read from ${Math.round(RISE_LOW_COVERAGE * 100)}% or more of its frontier surely deployed (above ${RISE_CAP}× the ~${t.incomeRise.before} before it): no turn read in full reached ${t.incomeRise.read}`
          : `max observed over ${span}, ${range}, held to ${RISE_CAP}× the ~${t.incomeRise.before} before it: no turn read in full reached ${t.incomeRise.read}`
      : `max observed over ${span}, ${range}, a rise held to ${RISE_CAP}× a turn`;
  if (t.incomeMethod === 'tripped')
    return t.incomeTrip
      ? `stepped down from ~${t.incomeTrip.from} toward +${t.incomeTrip.proven}: every army it could deploy was in view on turn ${t.incomeTrip.turn}, which read +${t.incomeTrip.proven} (one ${RISE_CAP}× step a turn, never below that reading; ${span}, ${range})`
      : `stepped down toward a turn read with every army it could deploy in view (${span}, ${range})`;
  if (t.incomeMethod === 'stock-flow') return `visible army growth plus losses (fog arrivals left out) over ${span}, ${range}`;
  if (t.incomeMethod === 'fog-captures') return `captures of neutrals in view that needed attackers out of sight, ending in ${span}, ${range}`;
  return `its visible base + bonuses, ${range} over ${span}`;
}

/**
 * Its army change over territories visible on both boards, and what it visibly lost. A capture
 * from me is priced at the guard, as observeDeploy prices it (#123); my orders correct both.
 */
function armyChange(g: MapGraph, before: BoardState, after: BoardState, playerId: number, defensive: number, me: number, guard: number) {
  const was = new Map(before.territories.map((t) => [t.territoryId, t]));
  const ids = [...new Set(after.territories.map((t) => t.territoryId))].sort(byNum);
  let net = 0;
  let losses = 0;
  const now = new Map(after.territories.map((t) => [t.territoryId, t]));
  for (const id of ids) {
    if (!g.territoryById.has(id)) continue;
    const a = visibleState(now.get(id));
    const b = visibleState(was.get(id));
    if (!a || !b) {
      // #164: under fog that hides the stacks (Dense / Heavy fog), a territory whose owner shows on
      // both boards and that it took is still a capture in view: it left at least the guard there,
      // and the capture cost what the defenders killed (their armies when shown, a capture from me
      // priced at the guard; a hidden defender NEUTRAL_CAPTURE_LOSS at least). Without this its
      // unaccounted armies under Dense fog would be everything it earned.
      const ao = ownerShown(now.get(id));
      const bo = ownerShown(was.get(id));
      if (!ao || !bo || ao.owner.kind !== 'player' || ao.owner.playerId !== playerId) continue;
      if (bo.owner.kind === 'player' && bo.owner.playerId === playerId) continue;
      net += a ? a.armies! : guard;
      const fromMe = bo.owner.kind === 'player' && bo.owner.playerId === me;
      losses += b ? straightKills(fromMe ? Math.min(b.armies!, guard) : b.armies!, defensive) : NEUTRAL_CAPTURE_LOSS;
      continue;
    }
    const mineNow = a.owner.kind === 'player' && a.owner.playerId === playerId;
    const mineThen = b.owner.kind === 'player' && b.owner.playerId === playerId;
    if (mineNow && mineThen) net += a.armies! - b.armies!;
    else if (mineNow) {
      // The stack now standing there came into view (from a visible source or the fog): it
      // counts in `net`; the capture cost what the defenders killed, as in observeDeploy (#86).
      net += a.armies!;
      const fromMe = b.owner.kind === 'player' && b.owner.playerId === me;
      losses += straightKills(fromMe ? Math.min(b.armies!, guard) : b.armies!, defensive);
    } else if (mineThen) {
      net -= b.armies!;
      losses += b.armies!; // destroyed defending
    }
  }
  return { net, losses };
}

function seesPlayer(board: BoardState, g: MapGraph, playerId: number): boolean {
  return board.territories.some(
    (t) => g.territoryById.has(t.territoryId) && t.owner.kind === 'player' && t.owner.playerId === playerId && ownerShown(t),
  );
}

/** A bonus `playerId` could hold, how far it lies from what it visibly holds, and what taking it cost at least. */
interface PossibleBonus {
  id: number;
  value: number;
  /** Hops from a territory it visibly holds to the nearest member (Infinity when unreachable). */
  hops: number;
  /** Members not shown as its × {@link NEUTRAL_CAPTURE_LOSS}: the least they cost it to take. */
  cost: number;
}

/** Bonuses `playerId` could hold but does not visibly hold in full, on `board`. */
function possibleBonuses(g: MapGraph, board: BoardState, playerId: number): PossibleBonus[] {
  const seen = new Map(board.territories.map((t) => [t.territoryId, t]));
  // Hops from its visible territories (breadth first, over the whole map).
  const hops = new Map<number, number>();
  let frontier: number[] = [];
  for (const t of board.territories) {
    const st = ownerShown(t);
    if (g.territoryById.has(t.territoryId) && st?.owner.kind === 'player' && st.owner.playerId === playerId) {
      hops.set(t.territoryId, 0);
      frontier.push(t.territoryId);
    }
  }
  for (let d = 1; frontier.length; d++) {
    const next: number[] = [];
    for (const t of frontier)
      for (const n of g.neighbors.get(t) ?? [])
        if (!hops.has(n)) {
          hops.set(n, d);
          next.push(n);
        }
    frontier = next;
  }
  const out: PossibleBonus[] = [];
  for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
    const ts = bonusTerritories(g, b.id);
    if (b.value <= 0 || !ts.length) continue;
    let held = 0;
    let taken = false;
    for (const t of ts) {
      const st = ownerShown(seen.get(t));
      if (!st) continue;
      if (st.owner.kind === 'player' && st.owner.playerId === playerId) held++;
      else taken = true;
    }
    if (!taken && held < ts.length)
      out.push({
        id: b.id,
        value: b.value,
        hops: Math.min(...ts.map((t) => hops.get(t) ?? Infinity)),
        cost: (ts.length - held) * NEUTRAL_CAPTURE_LOSS,
      });
  }
  return out;
}

/** Positive bonuses `playerId` visibly holds in full on `board`: every member shown as its. */
function visiblyHeld(g: MapGraph, board: BoardState, playerId: number): { id: number; value: number }[] {
  const seen = new Map(board.territories.map((t) => [t.territoryId, t]));
  return [...g.map.bonuses]
    .sort((x, y) => x.id - y.id)
    .filter((b) => {
      const ts = bonusTerritories(g, b.id);
      if (b.value <= 0 || !ts.length) return false;
      return ts.every((t) => {
        const st = ownerShown(seen.get(t));
        return st?.owner.kind === 'player' && st.owner.playerId === playerId;
      });
    })
    .map((b) => ({ id: b.id, value: b.value }));
}

/** Of the bonuses it visibly held in full on `before`, those `after` shows a member of held by someone else. */
function visiblyBroken(g: MapGraph, before: BoardState, after: BoardState, playerId: number): { id: number; value: number }[] {
  const now = new Map(after.territories.map((t) => [t.territoryId, t]));
  return visiblyHeld(g, before, playerId).filter((b) =>
    bonusTerritories(g, b.id).some((t) => {
      const st = ownerShown(now.get(t));
      return st !== undefined && !(st.owner.kind === 'player' && st.owner.playerId === playerId);
    }),
  );
}

/**
 * What my own orders on the turn `before` → `after` measure of `playerId`'s deploy (#119), to add
 * to the board's reading ({@link observeSigned}) — which leaves both out, as
 * {@link observeDeploy}'s comment says:
 * - a failed attack of mine (a move onto a territory it shows on both boards): its defenders lost
 *   what my attackers killed, round(armies × the offensive kill rate) — the board reads that loss
 *   as a shrink, so it counts back. Not when its source fell this turn: it may have been taken
 *   before my attack ran;
 * - a hold of mine that fell to it: its defenders were my armies there plus what I deployed there
 *   less what I sent out of it; the board reading priced the capture at the guard (#123, the
 *   least I may have left), so the difference in what they killed (at the defensive kill rate)
 *   is the correction;
 * - its failed attack on a hold of mine ({@link attacksOnMyHolds}): what it lost there — the board
 *   reads that loss as a shrink, so it counts back.
 * Kill counts are straight-rounded expectations: luck can move them.
 */
export function measureOrders(
  g: MapGraph,
  before: BoardState,
  after: BoardState,
  me: number,
  playerId: number,
  orders: MyOrders,
  settings: PlannerSettings = {},
): number {
  const offensive = settings.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  const defensive = settings.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  const guard = (settings.oneArmyStandsGuard ?? true) ? 1 : 0;
  const was = new Map(before.territories.map((t) => [t.territoryId, t]));
  const now = new Map(after.territories.map((t) => [t.territoryId, t]));
  const owns = (t: ReturnType<typeof visibleState>, p: number) => t?.owner.kind === 'player' && t.owner.playerId === p;
  const deployed = new Map<number, number>();
  for (const d of orders.deploys) deployed.set(d.territoryId, (deployed.get(d.territoryId) ?? 0) + Math.max(0, d.armies));
  const sent = new Map<number, number>();
  for (const m of orders.moves) sent.set(m.from, (sent.get(m.from) ?? 0) + Math.max(0, m.armies));
  // My failed attacks (a source that fell this turn may have been taken before my attack ran: not
  // measured): the same count the planner's single-turn reading uses (#226, failedAttackKills).
  let measured = 0;
  for (const k of failedAttackKills(g, before, after, me, playerId, orders, { offensiveKillRate: offensive }).values()) measured += k;
  const ids = [...new Set(after.territories.map((t) => t.territoryId))].sort(byNum);
  for (const id of ids) {
    if (!g.territoryById.has(id)) continue;
    const b = visibleState(was.get(id));
    if (!owns(b, me) || !owns(visibleState(now.get(id)), playerId)) continue;
    const defenders = Math.max(0, b!.armies! + (deployed.get(id) ?? 0) - (sent.get(id) ?? 0));
    measured += straightKills(defenders, defensive) - straightKills(Math.min(b!.armies!, guard), defensive);
  }
  for (const a of attacksOnMyHolds(g, before, after, me, orders, settings)) if (a.attacker === playerId) measured += a.attackerLoss;
  return measured;
}

/** A hold of mine that lost armies my orders do not explain: an attack on it that failed (#123 review). */
interface AttackOnMyHold {
  territoryId: number;
  /** What it lost beyond what my orders explain. */
  loss: number;
  /** The only other player with a territory in view beside it, else null (not pinned on anyone). */
  attacker: number | null;
  /** The attacker's loss: the attackers that killed `loss` (÷ the offensive kill rate), at most what the defenders killed. */
  attackerLoss: number;
}

/**
 * My holds (mine, with armies, on both boards) that lost armies my orders do not explain: the
 * defenders were my armies there plus what I deployed there and moved in, less what I sent out;
 * what the later board shows less is what an attack that failed killed. Its attackers were that
 * loss ÷ the offensive kill rate, and it lost them all, up to what the defenders killed (at the
 * defensive kill rate). A hold I attacked out of and failed is skipped: the survivors of my own
 * attack came back to it, so its loss is not known. Straight-rounded expectations: luck can move them.
 */
function attacksOnMyHolds(
  g: MapGraph,
  before: BoardState,
  after: BoardState,
  me: number,
  orders: MyOrders,
  settings: PlannerSettings,
): AttackOnMyHold[] {
  const offensive = settings.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  const defensive = settings.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  const was = new Map(before.territories.map((t) => [t.territoryId, t]));
  return holdLosses(g, before, after, me, orders).map(({ territoryId, defenders, loss }) => {
    const others = new Set<number>();
    for (const n of neighborsOf(g, territoryId)) {
      const st = visibleState(was.get(n));
      if (st?.owner.kind === 'player' && st.owner.playerId !== me) others.add(st.owner.playerId);
    }
    const attackers = Math.round((loss * 100) / offensive);
    return {
      territoryId,
      loss,
      attacker: others.size === 1 ? [...others][0]! : null,
      attackerLoss: Math.min(attackers, straightKills(defenders, defensive)),
    };
  });
}

/**
 * What `playerId` may have lost fighting on the turn `before` → `after` (#123): on each of its
 * territories shown with armies on both boards that shrank, each neighbour of another player
 * shown with armies on both boards that shrank too (claimed once, ascending ids) counts
 * round(its shrink × offensive ÷ defensive kill rate) — the armies a failed attack that cost the
 * neighbour that many killed. When my orders measured the turn (`measured`), a hold of mine counts
 * only where an attack on it is pinned on no one ({@link attacksOnMyHolds}: more than one other
 * player beside it), with the loss my orders do not explain as its shrink; the rest of mine are
 * left out (my orders explain them, or {@link measureOrders} counted them).
 * The board cannot tell a fight from a transfer, nor whom the neighbour fought (a third player)
 * or where its armies went: it can overcount, so only the unexplained armies use it (where it only
 * makes the count more cautious); {@link incomeJump} leaves it out, since there it would make a case.
 * The ratio is a heuristic: a failed attack's real loss runs from about 0.6x to 1.43x the
 * attacker's shrink, depending on how many attacked; offensive ÷ defensive (about 0.86x at the
 * defaults) sits inside that range and needs only the two shrinks the boards show.
 */
function combatLosses(
  g: MapGraph,
  before: BoardState,
  after: BoardState,
  playerId: number,
  measured: { me: number; unpinned: ReadonlyMap<number, number> } | null,
  settings: PlannerSettings,
): number {
  const offensive = settings.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  const defensive = settings.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  const was = new Map(before.territories.map((t) => [t.territoryId, t]));
  const now = new Map(after.territories.map((t) => [t.territoryId, t]));
  /** Its shrink when one player shows it with armies on both boards; else null. */
  const shrinkOf = (id: number): { player: number; shrink: number } | null => {
    const a = visibleState(now.get(id));
    const b = visibleState(was.get(id));
    if (a?.owner.kind !== 'player' || b?.owner.kind !== 'player' || a.owner.playerId !== b.owner.playerId) return null;
    return { player: a.owner.playerId, shrink: b.armies! - a.armies! };
  };
  const claimed = new Set<number>();
  let lost = 0;
  for (const id of [...new Set(after.territories.map((t) => t.territoryId))].sort(byNum)) {
    if (!g.territoryById.has(id)) continue;
    const own = shrinkOf(id);
    if (own?.player !== playerId || own.shrink <= 0) continue;
    for (const n of [...neighborsOf(g, id)].sort(byNum)) {
      if (claimed.has(n)) continue;
      const seen = shrinkOf(n);
      const other = seen && measured && seen.player === measured.me ? { ...seen, shrink: measured.unpinned.get(n) ?? 0 } : seen;
      if (!other || other.player === playerId || other.shrink <= 0) continue;
      claimed.add(n);
      lost += Math.round((other.shrink * offensive) / defensive);
    }
  }
  return lost;
}

/**
 * The combinations of up to {@link MAX_COMBINATION} bonuses whose total comes closest to `gap`
 * (within max(1, a quarter of the gap)), fewest bonuses first, then nearest (summed hops), then
 * by ids. Only plausible bonuses take part (#123): a member within {@link INFER_REACH} hops of a
 * territory it visibly holds, and a combination costing no more than `budget` (what it could
 * have received). When more than {@link MAX_LISTED_COMBINATIONS} fit, none is listed.
 * The cost binds mostly early and on large bonuses: one army per member against what it earned
 * (seen, or the base income on the turns not seen). The reach filter does most of the work.
 */
function inferBonuses(all: readonly PossibleBonus[], gap: number, budget: number): InferredBonuses {
  const tolerance = Math.max(1, Math.round(gap / 4));
  const options = all.filter((b) => b.hops <= INFER_REACH && b.cost <= budget);
  const sorted = [...options].sort((a, b) => a.value - b.value || a.id - b.id);
  let best = Infinity;
  let found: BonusCombination[] = [];
  const pick: PossibleBonus[] = [];
  const visit = (start: number, sum: number, cost: number) => {
    if (pick.length) {
      const diff = Math.abs(sum - gap);
      if (diff <= tolerance && diff <= best) {
        if (diff < best) {
          best = diff;
          found = [];
        }
        found.push({ bonusIds: pick.map((p) => p.id).sort(byNum), total: sum, hops: pick.reduce((h, p) => h + p.hops, 0) });
      }
    }
    if (pick.length === MAX_COMBINATION) return;
    for (let i = start; i < sorted.length; i++) {
      const b = sorted[i]!;
      // Values only grow from here: past the gap plus the tolerance nothing fits.
      if (sum + b.value > gap + tolerance) break;
      if (cost + b.cost > budget) continue;
      pick.push(b);
      visit(i + 1, sum + b.value, cost + b.cost);
      pick.pop();
    }
  };
  visit(0, 0, 0);
  found.sort((a, b) => {
    if (a.bonusIds.length !== b.bonusIds.length) return a.bonusIds.length - b.bonusIds.length;
    if (a.hops !== b.hops) return a.hops - b.hops;
    for (let i = 0; i < a.bonusIds.length; i++) if (a.bonusIds[i] !== b.bonusIds[i]) return a.bonusIds[i]! - b.bonusIds[i]!;
    return 0;
  });
  const tooMany = found.length > MAX_LISTED_COMBINATIONS;
  return {
    gap,
    exact: best === 0,
    candidates: tooMany ? [] : found,
    more: tooMany ? found.length : 0,
    implausible: all.length - options.length,
  };
}

/**
 * #271 (2): a pattern of captures of neutrals in view that needed attackers out of sight, ending on
 * the newest observed turn: {@link FOG_CAPTURE_MIN} or more turns with one among the observed turns
 * of the last {@link FOG_CAPTURE_TURNS} (by turn number, the newest included). One such capture may
 * be a banked stack walking out of the fog; three in six turns are income it earns out of sight. The
 * attackers they needed (beyond what its stacks in view sent) are spread over the turns from the
 * first of them to the newest, rounded up, at most the newest turn's could-earn cap. Null without one.
 */
function fogCapturePattern(observed: readonly ObservedTurn[]): ObservedTurn['fogCaptures'] | null {
  const last = observed.at(-1);
  if (!last) return null;
  const hits = observed.filter((x) => x.from > last.from - FOG_CAPTURE_TURNS && (x.unseenAttackerArmies ?? 0) > 0);
  if (hits.length < FOG_CAPTURE_MIN) return null;
  const armies = hits.reduce((n, x) => n + (x.unseenAttackerArmies ?? 0), 0);
  const income = Math.min(last.cap, Math.ceil(armies / (last.from - hits[0]!.from + 1)));
  return { turns: hits.map((x) => x.from), armies, income };
}

/**
 * The income carried over the observed turns (#119): see the walk in {@link trackOpponents}.
 * `confirmed` when a turn of its window read in full (no army read as a move out of the fog) at
 * least that figure ({@link confirmedBy}).
 */
type Carry = {
  income: number;
  set: number;
  window: ObservedTurn[];
  est: TrackedIncome;
  confirmed: boolean;
  /** #418: the window read `read`, held to {@link RISE_CAP} × the carry `before` it (or to the `proven` capture floor, when higher). */
  rise?: IncomeRise;
  /** #418: the over-read tripwire stepped this carry down ({@link carryIncome}). */
  trip?: IncomeTrip;
  /** #418: the ceiling the tripwire left on the readings of the turns up to `through` (returned on the last carry). */
  ceiling?: TripCeiling;
};

/**
 * #418: a rise held while I lead ({@link OpponentTrack.incomeRise}): what the window read, the carry before
 * it, and — when a capture with every source in view proved more than {@link RISE_CAP} × that — the proof,
 * which the hold never goes below.
 */
export interface IncomeRise {
  read: number;
  before: number;
  proven?: number;
  /** #567: the low end of a turn read from {@link RISE_LOW_COVERAGE} or more of its frontier, when it set the hold. */
  low?: number;
}

/** #567: a turn's low end above the tracked income ({@link OpponentTrack.observedLow}). */
export interface ObservedLow {
  low: number;
  high: number;
  turn: number;
  coverage: number | null;
}

/**
 * #567: the turn of `window` whose low end (at most its could-earn cap) is highest, the newest on a tie,
 * when that low end is above `income`; else `null`. Pure.
 */
export function observedLowOf(window: readonly ObservedTurn[], income: number | null): ObservedLow | null {
  if (income === null) return null;
  let top: ObservedTurn | null = null;
  for (const x of window) if (!top || Math.min(x.low, x.cap) >= Math.min(top.low, top.cap)) top = x;
  if (!top || Math.min(top.low, top.cap) <= income) return null;
  return { low: Math.min(top.low, top.cap), high: Math.min(top.high, top.cap), turn: top.from, coverage: top.coverage?.share ?? null };
}

/** #567: the warning that a tracked income is held below what a turn of its window surely read. */
export function observedLowWarning(player: string, income: number, o: ObservedLow, method: IncomeMethod | null): string {
  const read = o.coverage !== null ? `, from ${Math.round(o.coverage * 100)}% of its frontier` : '';
  const range = o.high > o.low ? `, up to +${o.high}` : '';
  const why =
    method === 'tripped'
      ? 'the over-read tripwire keeps the readings before its step at most the stepped figure (#418)'
      : `a rise no turn read in full confirmed is held to ${RISE_CAP}× a turn (#418)`;
  return (
    `Player ${player}'s income is held at ~${income}, but turn ${o.turn} read it deploying at least +${o.low}${range}${read} (#567): ` +
    `${why}, so the plan sizes its borders for ~${income}. To test the low end, pass known_income ${o.low} for it to ` +
    'warapp_check_plan (a board figure: it moves no other opponent, #567).'
  );
}

/** #418: one step of the over-read tripwire ({@link OpponentTrack.incomeTrip}). */
export interface IncomeTrip {
  from: number;
  proven: number;
  turn: number;
}

/**
 * #418: after a step down, the readings of the turns up to `through` count at most `value`: the over-read
 * the tripwire stepped down from stays out of every later window it is still in (else the next turn's
 * window would read it back whole). Readings of later turns count whole.
 */
interface TripCeiling {
  value: number;
  through: number;
  trip: IncomeTrip;
}

/**
 * #418: {@link trackedIncome} with the tripwire's ceiling on the readings of the turns it covers: those
 * count at most its value, the later ones whole; method `tripped` when that lowers the figure.
 */
function ceiledIncome(window: readonly ObservedTurn[], visibleIncome: number, ceiling: TripCeiling | null | undefined): TrackedIncome {
  const est = trackedIncome(window, visibleIncome);
  if (!ceiling || !window.some((x) => x.from <= ceiling.through)) return est;
  const later = window.filter((x) => x.from > ceiling.through);
  const income = Math.max(visibleIncome, Math.min(est.income, ceiling.value), later.length ? trackedIncome(later, visibleIncome).income : 0);
  return income >= est.income ? est : { ...est, income, method: 'tripped' };
}

/**
 * #418, the over-read tripwire (owner decision of 2026-11-20): proof may lower an estimate only when every
 * army the opponent could have deployed that turn is accounted for in view. Its deploy lands only on its
 * own territories, so the turn is read in full when every territory it held on either board shows its
 * armies on both, nothing beside them hides its owner on either board (#294's whole frontier read: a
 * territory of its cut off in deep fog, beside none of its land in view, is the one gap), and nothing
 * beside it could hide a fight that cost it armies the board does not show: no third player beside it
 * (another's attack, or a failed attack of its on another, is unseen), no neutral beside it that shrank or
 * changed hands (a failed attack of its), no territory of its lost, and — beside my land — my orders known
 * in full (`sent` and `cards`, so `measureOrders` counts what my attacks killed and what its failed attacks
 * on me cost) with no card of mine on its land. A failed attack must always show: one army kills at least
 * one defender ({@link guaranteedKills}); with a capture, luck is off under straight rounding (else its cost
 * varies). Not in a commerce game with an army price (it may save gold rather than deploy).
 */
export function everyArmyInView(
  g: MapGraph,
  before: BoardState,
  after: BoardState,
  playerId: number,
  me: number,
  orders: MyOrders | undefined,
  settings: PlannerSettings = {},
): boolean {
  if (settings.armyCostMultiplier) return false;
  const was = new Map(before.territories.map((t) => [t.territoryId, t]));
  const now = new Map(after.territories.map((t) => [t.territoryId, t]));
  const its = (t: TerritoryState | undefined) => t?.owner.kind === 'player' && t.owner.playerId === playerId;
  const land = new Set<number>();
  for (const id of g.territoryById.keys()) if (its(ownerShown(was.get(id))) || its(ownerShown(now.get(id)))) land.add(id);
  if (!land.size) return false;
  let captured = false;
  for (const id of land) {
    const b = visibleState(was.get(id));
    const a = visibleState(now.get(id));
    if (!b || !a || !its(a)) return false;
    if (!its(b)) captured = true;
  }
  let bordersMe = false;
  for (const id of land)
    for (const n of neighborsOf(g, id)) {
      if (land.has(n)) continue;
      const b = ownerShown(was.get(n));
      const a = ownerShown(now.get(n));
      if (!b || !a) return false;
      for (const o of [b.owner, a.owner]) {
        if (o.kind !== 'player') continue;
        if (o.playerId !== me) return false;
        bordersMe = true;
      }
      if (b.owner.kind === 'neutral') {
        const vb = visibleState(b);
        const va = visibleState(a);
        if (a.owner.kind !== 'neutral' || !vb || !va || va.armies! < vb.armies!) return false;
      }
    }
  if (bordersMe) {
    if (!orders?.sent || !orders.cards) return false;
    if (orders.cards.some((c) => [c.from, c.to, c.target].some((t) => t !== undefined && land.has(t)))) return false;
  }
  const luck = luckFraction(settings.luckModifier);
  const straight = (settings.roundingMode ?? 'StraightRound') === 'StraightRound';
  if (captured && (luck > 0 || !straight)) return false;
  return guaranteedKills(1, settings.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE, settings.luckModifier, settings.roundingMode) >= 1;
}

/**
 * #123 review: a turn read in full — no ambiguous army was read as a move out of the fog (the
 * bound cut nothing) — whose observed deploy reaches `income` confirms it, and so does a pattern of
 * fog captures (#271) or a capture floor (#418, {@link ObservedTurn.captureFloor}) that reaches it. A figure only bound-cut
 * readings reached (each up to twice the income carried so far) is a guess, however often it
 * compounded.
 */
const confirmedBy = (window: readonly ObservedTurn[], income: number) =>
  window.some((x) => (x.fogArmies === 0 && x.observed >= income) || (x.fogCaptures?.income ?? 0) >= income || (x.captureFloor ?? 0) >= income);

/**
 * #119: no decay. Walk the observed turns: each window's figure (as `trackedIncome` reads it)
 * replaces the carried one only when larger; otherwise the carried figure stays, less the
 * bonuses it visibly held that were visibly broken that turn, and never above that turn's
 * could-earn cap. Null with no observed turn.
 *
 * #123 review: a carry no turn read in full ever confirmed does not outlive a later turn read in
 * full that observed less: the window's figure takes over (so walk-ins over several turns, each
 * read up to twice the carry before it, age out of the window as a one-off does, rather than
 * staying pinned). The trade-off: a hidden income beyond twice the visible one, learnt only from
 * bound-cut readings (section 7's +20 read 10, 20, …), is dropped the first time it deploys into
 * the fog and shows less in full — unless a turn read in full had already confirmed it.
 *
 * #418: while I lead it ({@link ObservedTurn.leadIncome} above the carry before the turn, or that
 * turn's visible income when larger — not above the reading, which an over-read would pass), a window
 * figure above the carry that no turn read in full confirmed rises at most to {@link RISE_CAP} × that
 * figure, rounded up; on a turn read in full that observed less than the carry it does not rise at all.
 * #418: never below a capture floor in the window (proof may always raise an estimate).
 *
 * #418, the over-read tripwire: on a turn with every army it could have deployed in view
 * ({@link ObservedTurn.accounted}), a carry above that turn's reading steps down at most one step,
 * to ⌈carry ÷ {@link RISE_CAP}⌉, never below the reading nor its visible income; the readings of the
 * turns up to it then count at most the stepped figure in every later window ({@link ceiledIncome}),
 * so the next turn does not read the over-read back.
 */
function carryIncome(observed: readonly ObservedTurn[]): Carry | null {
  let carry = null as Carry | null;
  let ceiling = null as TripCeiling | null;
  /**
   * #271 (2): the latest pattern of captures that needed attackers out of sight, as a carry: it is
   * evidence, not a bound-cut guess, so no later turn read in full disproves it; like any carry it
   * falls with the bonuses visibly broken since and never stays above a turn's could-earn cap.
   */
  let pattern = null as Carry | null;
  for (let i = 0; i < observed.length; i++) {
    const x = observed[i]!;
    const window = observed.slice(Math.max(0, i - INCOME_TURNS + 1), i + 1);
    const est = ceiledIncome(window, 0, ceiling);
    const fresh: Carry = { income: est.income, set: est.income, window, est, confirmed: confirmedBy(window, est.income) };
    if (pattern) pattern = { ...pattern, income: Math.min(x.cap, pattern.income - x.brokenValue) };
    if (x.fogCaptures && x.fogCaptures.income >= (pattern?.income ?? 0)) {
      const income = x.fogCaptures.income;
      pattern = { income, set: income, window, est: { ...est, income, method: 'fog-captures' }, confirmed: true };
    }
    const prev: Carry | null = carry;
    if (!prev) carry = fresh;
    else {
      const disproved = !prev.confirmed && x.fogArmies === 0 && x.observed < prev.income;
      const kept: number = Math.min(x.cap, prev.income - x.brokenValue);
      if (!(disproved || est.income >= kept)) carry = { ...prev, income: kept };
      else {
        const before = Math.max(prev.income, x.visibleIncome);
        // #418: proof may always raise an estimate: the hold never goes below a capture floor in the window.
        const proof = Math.max(0, ...window.map((w) => w.captureFloor ?? 0));
        // #567: nor below the low end of a turn read from RISE_LOW_COVERAGE or more of its frontier.
        const low = disproved
          ? 0
          : Math.max(0, ...window.filter((w) => (w.coverage?.share ?? 0) >= RISE_LOW_COVERAGE).map((w) => Math.min(w.low, w.cap)));
        const limit = Math.max(disproved ? prev.income : Math.ceil(before * RISE_CAP - 1e-9), proof, low);
        // #418 review: the lead is judged against the carry before the rise (or its visible income), never
        // against the reading being judged: an over-read above my income must not switch its own cap off.
        carry =
          (x.leadIncome ?? 0) > before && !fresh.confirmed && fresh.income > limit
            ? {
                ...fresh,
                income: limit,
                set: limit,
                rise: { read: fresh.income, before, ...(proof >= limit ? { proven: proof } : low >= limit ? { low } : {}) },
              }
            : fresh;
      }
    }
    if (pattern && pattern.income > carry.income) carry = pattern;
    // #418, the over-read tripwire: on a turn with every army it could deploy in view, the carry steps
    // down at most one RISE_CAP step toward that turn's reading, never below it (nor its visible income).
    // It steps `carry`, never `pattern`: a #271 fog-capture pattern above the stepped figure is restored by
    // the line above on the next turn, so a pattern-set reading is lowered for that one turn only.
    if (x.accounted && carry.income > x.observed) {
      const step = Math.max(x.observed, x.visibleIncome, Math.ceil(carry.income / RISE_CAP - 1e-9));
      if (step < carry.income) {
        const trip: IncomeTrip = { from: carry.income, proven: x.observed, turn: x.from };
        carry = { ...carry, income: step, set: step, trip };
        ceiling = { value: step, through: x.from, trip };
      }
    }
  }
  return carry && ceiling ? { ...carry, ceiling } : carry;
}

/** #250: a turn that reads more than this many times the most it was seen to earn before it is a jump. */
export const INCOME_JUMP_FACTOR = 2;

/**
 * #250: a tracked income set by one observed turn far above the turns before it. Such a turn is
 * usually the first true reading after turns that deployed into the fog (a play session lowered one
 * by hand and lost the game), so the figure is kept; this says whether the boards back it.
 */
export interface IncomeJump {
  /** The turn (its `from`) whose reading set the income. */
  turn: number;
  /** Its observed deploy. */
  observed: number;
  /** The most it was seen to earn (`earned`) on the consecutive observed turns just before it. */
  before: number;
  /** The first of those turns: the board the evidence starts from. */
  since: number;
  /** Its armies in view on the board of turn `since`. */
  armiesBefore: number;
  /** What it was seen to earn from `since` up to the jump, plus its visible income on the jump turn. */
  earnedSince: number;
  /** Its armies in view on the board after the jump. */
  armiesNow: number;
  /**
   * What it was seen to lose over those turns (`losses`). Not the likely combat deaths (`combat`):
   * that guess can read a transfer as a fight, and here it would only strengthen `supported`.
   */
  lossesSeen: number;
  /**
   * Of `armiesNow` and those turns' readings, the armies that only came into view: on territories
   * it holds after the jump that a board from `since` up to the jump did not show (owner and armies;
   * a territory shown on all of them under another owner — a capture from a neutral or player in
   * view — is in the readings, not a reveal), less what it had in view there on the board of `since`
   * (those are in `armiesBefore` already), plus those read as arriving out of the fog (`fogArmies`),
   * plus the jump turn's {@link IncomeJump.ambiguous} armies. An upper bound (they may overlap): it
   * only ever weakens the case for the jump.
   */
  cameIntoView: number;
  /**
   * The jump turn's ambiguous armies read as deploy (#123: growth beside the fog, a capture's surplus
   * over what a visible stack sent): its reading less its low one. They may be a stack walking out of
   * the fog, so they count as come into view (`cameIntoView`); the turn reads `low` to `high`.
   * A capture from me priced at the guard is not among them (it only raises `high`).
   */
  ambiguous: number;
  /** The jump turn's low and high readings (#123). */
  low: number;
  high: number;
  /**
   * The territories it took from me on the jump turn (in view on both boards), and its armies on
   * them after it: the part of the jump that went into capturing my territory. `guardPriced` when
   * any of those captures was priced at the guard I may have left (my orders that turn unknown,
   * #123), so the turn reads between `low` and `high`.
   */
  fromMe?: { territories: number[]; armies: number; guardPriced: boolean; low: number; high: number };
  /**
   * The whole game at the earlier rate, when its starting armies are known (an upper bound under
   * full distribution): had it earned no more than `rate` (the most it was seen to earn on any
   * observed turn before the jump, or its visible income on the jump turn when more) every turn from turn 1 through the jump
   * turn, it received at most `start + rate × turns` (`received`). Its armies in view after the jump
   * plus every loss seen up to it (`lossesAll`, `losses` only, as `lossesSeen`) beyond that are armies it could not have had: the
   * high turn, or a higher income before it than was read, is real. Old armies coming into view
   * cannot explain them — this counts every army it has, wherever it stood.
   */
  stock?: { start: number; rate: number; turns: number; received: number; lossesAll: number };
  /**
   * `supported`: armiesNow + lossesSeen − cameIntoView > armiesBefore + earnedSince (more armies
   * than it could have banked, even leaving out what came into view), or armiesNow + lossesAll >
   * `stock.received`; `reveal`: neither, but the first holds counting what came into view;
   * `banked`: neither.
   */
  verdict: 'supported' | 'reveal' | 'banked';
}

/** The armies of `playerId` on territories shown with armies on `board`, and their armies by id. */
function armiesInView(g: MapGraph, board: BoardState, playerId: number): { total: number; ids: Map<number, number> } {
  let total = 0;
  const ids = new Map<number, number>();
  for (const t of board.territories) {
    if (!g.territoryById.has(t.territoryId)) continue;
    const st = visibleState(t);
    if (st?.owner.kind !== 'player' || st.owner.playerId !== playerId) continue;
    total += st.armies!;
    ids.set(t.territoryId, st.armies!);
  }
  return { total, ids };
}

/**
 * #250: when the income was set by the most observed in its window (`max-observed`, or carried from
 * such a window) and that turn read more than {@link INCOME_JUMP_FACTOR} × the most it was seen to
 * earn on the consecutive observed turns just before it (up to {@link INCOME_TURNS} − 1 of them),
 * weigh the boards: its armies in view after the jump plus what it was seen to lose since the first
 * of those turns, against its armies in view then plus what it was seen to earn since (the jump turn
 * at its visible income only). More than that, even without the armies that only came into view, is
 * armies it could not have banked: `supported`. Given its starting armies (`startArmies`), the whole
 * game is weighed too ({@link IncomeJump.stock}), which no reveal of old armies can explain. Undefined
 * without such a jump, without the boards to weigh it, or when a later observed turn also reads more
 * than {@link INCOME_JUMP_FACTOR} × that most (the income then rests on more than one turn).
 */
export function incomeJump(
  g: MapGraph,
  byTurn: ReadonlyMap<number, BoardState>,
  playerId: number,
  observed: readonly ObservedTurn[],
  window: readonly ObservedTurn[],
  method: IncomeMethod,
  startArmies?: number,
  me?: number,
): IncomeJump | undefined {
  if (method !== 'max-observed' || !window.length) return undefined;
  const max = Math.max(...window.map((x) => x.observed));
  const x = window.find((w) => w.observed === max)!;
  // The consecutive observed turns just before it (at most INCOME_TURNS − 1): a carried window may
  // start at the jump (#119), so they are looked up in the whole history.
  const at = observed.indexOf(x);
  let first = at;
  while (first > 0 && at - first < INCOME_TURNS - 1 && observed[first - 1]!.to === observed[first]!.from) first--;
  const prev = observed.slice(first, at);
  if (!prev.length) return undefined;
  const before = Math.max(...prev.map((p) => p.earned));
  // `earned` is floored at its visible income (base income + visibly held bonuses), so a fogged turn
  // that read 0 still counts at least its base income here: `before` is 0 only in a game whose base
  // income is 0 with no bonus held in view, where no ratio means anything (any positive turn would be
  // "more than twice"), so no line is given.
  if (before <= 0 || x.observed <= INCOME_JUMP_FACTOR * before) return undefined;
  // A later observed turn that also reads more than INCOME_JUMP_FACTOR × `before` backs it: the
  // income no longer rests on one turn, and a line weighing that turn alone would hedge a figure
  // two readings carry.
  if (observed.some((p) => p.from > x.from && p.observed > INCOME_JUMP_FACTOR * before)) return undefined;
  const since = prev[0]!.from;
  const start = byTurn.get(since);
  const end = byTurn.get(x.to);
  if (!start || !end) return undefined;
  const then = armiesInView(g, start, playerId);
  const now = armiesInView(g, end, playerId);
  const span = [...prev, x];
  const earnedSince = prev.reduce((s, p) => s + p.earned, 0) + x.visibleIncome;
  // `losses` only: `combat` is a guess that can count a transfer as a fight ({@link combatLosses}),
  // and on this side it would make the case for the jump.
  const lossesSeen = span.reduce((s, p) => s + p.losses, 0);
  // The jump turn's ambiguous armies (#123) read as deploy may be a stack out of the fog: counting
  // them as income would make the case for the jump with the very armies it is about.
  const ambiguous = Math.max(0, x.observed - x.low);
  // #271 (3): arrivals from its stacks hidden after came into view too.
  let cameIntoView = span.reduce((s, p) => s + p.fogArmies + (p.arrivals ?? 0), 0) + ambiguous;
  // A territory it holds after the jump that some board from `since` up to the jump did not show
  // (owner and armies): its armies may be old ones revealed. One shown on every one of them is no
  // reveal, whoever held it: a capture there (from a neutral or a player in view) is in the readings.
  const boards = span.map((p) => byTurn.get(p.from));
  const shownThroughout = (id: number) => boards.every((b) => b?.territories.some((t) => t.territoryId === id && visibleState(t)));
  // Less what it had in view there on the board of `since`: those armies are in `armiesBefore` already.
  for (const [id, armies] of now.ids)
    if (!shownThroughout(id)) cameIntoView += Math.max(0, armies - (then.ids.get(id) ?? 0));
  const seen = now.total + lossesSeen;
  const banked = then.total + earnedSince;
  let stock: IncomeJump['stock'];
  if (startArmies !== undefined) {
    // Every observed turn before the jump, not only the ones `before` weighs: a high reading earlier
    // in the game is income it may have kept earning out of sight.
    const rate = Math.max(x.visibleIncome, ...observed.filter((p) => p.from < x.from).map((p) => p.earned));
    const turns = Math.max(0, x.from);
    const lossesAll = observed.filter((p) => p.from <= x.from).reduce((s, p) => s + p.losses, 0);
    stock = { start: startArmies, rate, turns, received: startArmies + rate * turns, lossesAll };
  }
  // #250: the captures from me on the jump turn, and what stands on them after it.
  let fromMe: IncomeJump['fromMe'];
  const jumpBoard = byTurn.get(x.from);
  if (me !== undefined && jumpBoard) {
    const taken = x.captured.filter((id) =>
      jumpBoard.territories.some((t) => {
        if (t.territoryId !== id) return false;
        const st = visibleState(t);
        return st?.owner.kind === 'player' && st.owner.playerId === me;
      }),
    );
    if (taken.length)
      fromMe = {
        territories: [...taken].sort((a, b) => a - b),
        armies: taken.reduce((s, id) => s + (now.ids.get(id) ?? 0), 0),
        guardPriced: !x.measured && taken.some((id) => x.emptied.includes(id)),
        low: x.low,
        high: x.high,
      };
  }
  const verdict =
    seen - cameIntoView > banked || (stock && now.total + stock.lossesAll > stock.received) ? 'supported' : seen > banked ? 'reveal' : 'banked';
  return {
    turn: x.from,
    observed: x.observed,
    before,
    since,
    armiesBefore: then.total,
    earnedSince,
    armiesNow: now.total,
    lossesSeen,
    cameIntoView,
    ambiguous,
    low: x.low,
    high: x.high,
    ...(fromMe ? { fromMe } : {}),
    ...(stock ? { stock } : {}),
    verdict,
  };
}

/**
 * #250: the line for an {@link IncomeJump} (the subject — "Player X's" — prefixed by the caller). #254:
 * the verdict comes first in about a dozen words, then one sentence of numbers; every figure is in
 * the track tool's `income.jump`.
 */
export function incomeJumpText(j: IncomeJump, income: number, earlier: readonly ObservedTurn[]): string {
  const seen = j.armiesNow + j.lossesSeen;
  const banked = j.armiesBefore + j.earnedSince;
  const readings = earlier.map((p) => `+${p.earned}`).join(', ');
  const onJump = j.earnedSince - earlier.reduce((s, p) => s + p.earned, 0);
  const proven = j.verdict === 'supported' && seen - j.cameIntoView > banked;
  const verdict = proven
    ? 'confirmed — armies it could not have banked; do not lower it'
    : j.verdict === 'supported'
      ? 'kept — more armies than its earlier rate allows; not proof of this turn'
      : `not confirmed, kept as a lower bound; could be ${j.verdict === 'reveal' ? 'old armies revealed' : 'armies it had banked'}`;
  const lead = `+${j.observed} on one turn (turn ${j.turn}): ${verdict}.`;
  // A carried figure (#119) may have been cut since: a bonus it held visibly broken, or more than it could earn.
  const cut = income < j.observed ? ` Tracked ~${income}/turn, less ${j.observed - income} since (a bonus broken, or more than it could earn).` : '';
  // #123: armies the jump turn read as deploy that may be a stack out of the fog.
  const amb = j.ambiguous ? ` Turn ${j.turn} reads +${j.low} to +${j.high}: ${j.ambiguous} may be a stack out of the fog.` : '';
  const m = j.fromMe;
  const fromMe = m
    ? `, ${m.armies} on territor${m.territories.length === 1 ? 'y' : 'ies'} ${m.territories.join(', ')} taken from me${
        m.guardPriced ? ` (priced at the guard I may have left: turn ${j.turn} reads +${m.low} to +${m.high})` : ''
      }`
    : '';
  const sum = ` Over ${INCOME_JUMP_FACTOR}× the ${j.before} before it; ${j.armiesNow} in view on turn ${j.turn + 1}${fromMe} + ${j.lossesSeen} lost = ${seen}, vs ${j.armiesBefore} on turn ${j.since} + ${j.earnedSince} earned (${readings ? `${readings}, then ` : ''}+${onJump} visible on turn ${j.turn}) = ${banked}`;
  const k = j.stock;
  const had = k ? j.armiesNow + k.lossesAll : 0;
  const rate = k ? `at ${k.rate} a turn` : '';
  const from = k ? `(starting armies ${k.start} + ${k.rate} × ${k.turns} turns)` : '';
  let tail: string;
  if (proven) tail = `: more by ${seen - banked}${j.cameIntoView ? `, ${seen - j.cameIntoView - banked} without the ${j.cameIntoView} that came into view` : ''}.`;
  else if (j.verdict === 'supported' && k)
    tail = `; ${rate} it could have received at most ${k.received} ${from}, yet shows ${had} with its losses, more by ${had - k.received}: armies it could not have had at that rate (cards aside).`;
  else
    tail = `${j.verdict === 'reveal' ? `: more only counting the ${j.cameIntoView} armies that came into view` : ': no more'}.${
      k ? ` ${rate[0]!.toUpperCase()}${rate.slice(1)} it could have received up to ${k.received} by turn ${j.turn} ${from}, enough for the ${had}.` : ''
    }`;
  return `${lead}${cut}${amb}${sum}${tail}`;
}

/**
 * #420: the most armies one of `playerId`'s stacks beside my land grew over one turn (board `before` →
 * `after`): each territory its own on both boards, shown with its armies on both (`visibleState`), and
 * next to a territory of mine on `before`; a stack that shrank or stood still reads 0. `undefined` when
 * there is no such stack. Growth counts deploys and armies moved in alike: what the stack facing me
 * gained, the top-up a border must answer.
 */
export function borderTopUp(g: MapGraph, before: BoardState, after: BoardState, playerId: number, me: number): number | undefined {
  const was = new Map(before.territories.map((t) => [t.territoryId, t]));
  const now = new Map(after.territories.map((t) => [t.territoryId, t]));
  const owns = (t: ReturnType<typeof visibleState>, p: number) => t?.owner.kind === 'player' && t.owner.playerId === p;
  let most: number | undefined;
  for (const id of [...g.territoryById.keys()].sort(byNum)) {
    const b = visibleState(was.get(id));
    const a = visibleState(now.get(id));
    if (!owns(b, playerId) || !owns(a, playerId)) continue;
    if (!neighborsOf(g, id).some((n) => owns(ownerShown(was.get(n)), me))) continue;
    most = Math.max(most ?? 0, a!.armies! - b!.armies!);
  }
  return most;
}

/**
 * Per opponent: its observed deploys turn by turn, an income estimate, the armies that must be
 * in the fog and the bonuses that could explain an income gap. Those visible on the newest
 * board come first (by id); given `game`, every other opponent still playing follows (by id),
 * with its received lower bound (#94). `boards` are my views of the same game, any order; only
 * consecutive turns are compared. See the module comment for the rules.
 */
export function trackOpponents(
  g: MapGraph,
  boards: readonly TurnBoard[],
  me: number,
  settings: PlannerSettings = {},
  game?: TrackGame,
): OpponentTrack[] {
  // #270: a static seat (out, no AI on it) deploys nothing: its territories read as neutrals.
  const seats = staticSeatsFor(game, me);
  // One board per turn (the last given wins), oldest first.
  const byTurn = new Map<number, BoardState>();
  const ordersOn = new Map<number, MyOrders | undefined>();
  /** #420: the turns whose board came from GameFeed history (army counts unverified). */
  const fromHistory = new Set<number>();
  for (const b of boards) {
    byTurn.set(b.turn, neutralizeSeats(b.board, seats));
    ordersOn.set(b.turn, b.orders);
    if (b.source === 'history') fromHistory.add(b.turn);
    else fromHistory.delete(b.turn);
  }
  const turns = [...byTurn.keys()].sort(byNum);
  if (!turns.length) return [];
  const lastTurn = turns.at(-1)!;
  const latest = byTurn.get(lastTurn)!;
  const visibleOn = new Map<number, Map<number, { playerId: number; base: number; bonusIncome: number }>>();
  const visibleAt = (turn: number) => {
    let m = visibleOn.get(turn);
    if (!m) {
      m = new Map(enemyDeployEstimates(g, byTurn.get(turn)!, me, settings, undefined, undefined, undefined, { turn }).map((e) => [e.playerId, e]));
      visibleOn.set(turn, m);
    }
    return m;
  };
  /** Each board's territories by id (#164: the lost-stack scan reads every territory on every board). */
  const shownBy = new Map<number, Map<number, BoardState['territories'][number]>>();
  const shownOn = (turn: number) => {
    let m = shownBy.get(turn);
    if (!m) {
      m = new Map(byTurn.get(turn)!.territories.map((t) => [t.territoryId, t]));
      shownBy.set(turn, m);
    }
    return m;
  };
  const players = game?.players ?? [];
  const teams = isTeamGame(players);
  const myTeam = players.find((p) => p.id === me)?.team;
  const ally = (p: TrackPlayer) => p.id === me || (teams && carriesTeam(myTeam) && p.team === myTeam);
  // A teammate in view is not an opponent either (given the game's players).
  const visibleIds = [...visibleAt(lastTurn).keys()].filter((id) => {
    const p = players.find((x) => x.id === id);
    return !p || !ally(p);
  });
  const unseenIds = players
    .filter((p) => !ally(p) && playing(p) && !visibleIds.includes(p.id))
    .map((p) => p.id)
    .sort(byNum);
  const nameOf = (id: number) => players.find((p) => p.id === id)?.name ?? String(id);
  // My stacks on the newest board, against which an unseen opponent's bound is weighed.
  let largestStack = 0;
  let visibleArmies = 0;
  for (const t of latest.territories) {
    if (!g.territoryById.has(t.territoryId) || t.owner.kind !== 'player' || t.owner.playerId !== me || t.armies === null) continue;
    largestStack = Math.max(largestStack, t.armies);
    visibleArmies += t.armies;
  }
  const rules = { base: Math.max(0, Math.floor(settings.baseIncome ?? DEFAULT_BASE_INCOME)), per: settings.bonusArmyPer ?? 0 };
  const guard = (settings.oneArmyStandsGuard ?? true) ? 1 : 0;
  // The one income rule over no territory: the base income floor, never a bonus. With nothing in
  // view it may hold as little as one territory, and floor(1 / BonusArmyPer) never beats the base.
  const baseIncome = boardIncome(g, new Set(), rules).total;
  // When the base income each turn may not be a floor: a held negative bonus can take income
  // below it (boardIncome clamps only the total at 0), and so can a Sanctions card.
  const caveats = [
    ...(g.map.bonuses.some((b) => b.value < 0) ? ['the map has a negative-value bonus, which can take income below the base'] : []),
    ...(game?.incomeCaveats ?? []),
  ];

  // Only seated players split the map: GameFeed also lists players who never took a seat (Invited,
  // Declined, RemovedByHost), and counting them would shrink the share and the start with it.
  const seated = players.filter((p) => holdsSeat(p.state)).length;
  const startArmies = game?.start
    ? game.start.territories * game.start.armiesPerTerritory
    : game?.fullDistribution && game.startArmiesPerTerritory !== undefined && seated > 0
      ? Math.ceil(g.territoryById.size / seated) * game.startArmiesPerTerritory
      : undefined;

  return [...visibleIds, ...unseenIds].map((playerId) => {
    const seenOn = turns.filter((t) => seesPlayer(byTurn.get(t)!, g, playerId));
    const firstSeen = seenOn[0] ?? null;
    const observed: ObservedTurn[] = [];
    const missing: number[] = [];
    const unseen: number[] = [];
    for (let i = 1; i < turns.length; i++) {
      const from = turns[i - 1]!;
      const to = turns[i]!;
      if (firstSeen === null || from < firstSeen) continue;
      for (let m = from + 1; m < to; m++) missing.push(m);
      if (to !== from + 1) continue;
      const before = byTurn.get(from)!;
      const after = byTurn.get(to)!;
      // A turn pair where the opponent has no territory in view on either board says nothing
      // about its deploy (every stack would read as a reveal, or there is no estimate at all):
      // skip it with a note rather than observe 0 or throw (#83).
      const e = seesPlayer(before, g, playerId)
        ? enemyDeployEstimates(g, after, me, settings, before, undefined, undefined, { turn: to }).find((x) => x.playerId === playerId)
        : undefined;
      if (!e?.observation) {
        unseen.push(seesPlayer(before, g, playerId) ? to : from);
        continue;
      }
      // #123: what it was expected to deploy includes the income carried so far, so a hidden
      // income beyond twice the visible one (`ambiguousBound`) is learnt over a few turns. No fog
      // prior here (enemyDeployEstimates is called without one): visible or carried income only.
      const carriedSoFar = carryIncome(observed)?.income ?? 0;
      const v = visibleAt(from).get(playerId);
      const visibleIncome = v ? v.base + v.bonusIncome : 0;
      const change = armyChange(g, before, after, playerId, settings.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE, me, guard);
      const net = change.net;
      // My own orders that turn, when known, are measurements (#119).
      const orders = ordersOn.get(from);
      const measured = orders ? measureOrders(g, before, after, me, playerId, orders, settings) : 0;
      // The same context the board-only reading used (#123): without `most`, the surplus on a
      // reinforced capture would be read as a move out of the fog again.
      const expected = e.observation.expected;
      const context = {
        me,
        guard,
        most: e.observedCap!,
        ...(expected !== null ? { expected: Math.max(expected, carriedSoFar) } : {}),
        // #293: the same Local Deployment reading the board-only observation used.
        ...(settings.localDeployments ? { localFree: localFreeOn(e.base, DEFAULT_BASE_INCOME, settings.opponentReinforcement, from) } : {}),
        // #418: a Bomb it may have played halves a capture's defenders before the proof reads them.
        ...(bombPossibleOn(settings, from) ? { bomb: true } : {}),
      };
      const { signed, ...o } =
        expected !== null && carriedSoFar > expected
          ? observeSigned(g, after, before, playerId, settings, context)
          : { ...e.observation, signed: e.observedRaw! };
      // #271 (1): a failed attack on a hold of mine bounds its deploy from below, fog or not.
      const repelled = orders ? repelledFloor(g, before, after, me, playerId, orders, settings, guard, bombPossibleOn(settings, from)) : null;
      // #418: a capture with every source army in view proves a minimum deploy (my orders known: one
      // beside my land reads too). Proof may always raise the reading.
      const proof = captureFloor(g, before, after, playerId, settings, guard, { me, orders, bomb: bombPossibleOn(settings, from) });
      const floor = Math.max(repelled?.floor ?? 0, proof.floor);
      const raw = Math.max(
        measured ? Math.max(0, observeSigned(g, after, before, playerId, settings, context).signed + measured) : Math.max(0, signed),
        floor,
      );
      const losses = Math.max(0, change.losses + measured);
      // #123: with my orders known, what stood on an emptied capture is measured: no high reading.
      const low = Math.max(0, o.low + measured, floor);
      const high = Math.max(raw, o.high + measured - (orders ? o.emptiedHigh : 0));
      const seenObserved = Math.min(raw, e.observedCap!);
      const broken = visiblyBroken(g, before, after, playerId);
      // #418: did I lead it on the board read?
      const myLand = new Set<number>();
      let myArmies = 0;
      let itsArmies = 0;
      for (const t of after.territories) {
        if (!g.territoryById.has(t.territoryId) || t.owner.kind !== 'player') continue;
        if (t.owner.playerId === me) {
          myLand.add(t.territoryId);
          myArmies += t.armies ?? 0;
        } else if (t.owner.playerId === playerId) itsArmies += t.armies ?? 0;
      }
      const leadIncome = myArmies >= LEAD_ARMIES * itsArmies ? boardIncome(g, myLand, rules).total : null;
      const topUp = fromHistory.has(from) || fromHistory.has(to) ? undefined : borderTopUp(g, before, after, playerId, me);
      observed.push({
        from,
        to,
        coverage: frontierCoverage(g, after, before, playerId),
        ...(topUp !== undefined ? { topUp } : {}),
        ...(leadIncome !== null ? { leadIncome } : {}),
        observed: seenObserved,
        raw,
        ...(context.expected !== undefined ? { expected: context.expected } : {}),
        measured,
        broken: broken.map((b) => b.id),
        brokenValue: broken.reduce((sum, b) => sum + b.value, 0),
        cap: e.observedCap!,
        counted: o.counted,
        captured: o.captured,
        fromFog: o.fromFog,
        fogArmies: o.fogArmies,
        reveals: o.reveals,
        low: Math.min(low, raw),
        high,
        reinforced: o.reinforced,
        grewFromFog: o.grewFromFog,
        emptied: o.emptied,
        arrivals: o.arrivals,
        unseenAttackers: o.unseenAttackers,
        unseenAttackerArmies: o.unseenAttackerArmies,
        repelled: repelled?.territories.length ? repelled : null,
        repelledFloor: repelled?.floor ?? 0,
        ...(proof.floor > 0 ? { proven: proof.territories, captureFloor: proof.floor } : {}),
        ...(everyArmyInView(g, before, after, playerId, me, orders, settings) ? { accounted: true as const } : {}),
        combat: combatLosses(
          g,
          before,
          after,
          playerId,
          orders
            ? {
                me,
                unpinned: new Map(
                  attacksOnMyHolds(g, before, after, me, orders, settings)
                    .filter((a) => a.attacker === null)
                    .map((a) => [a.territoryId, a.loss]),
                ),
              }
            : null,
          settings,
        ),
        visibleIncome,
        earned: Math.max(visibleIncome, seenObserved),
        net,
        losses,
      });
      // #271 (2): captures that needed attackers out of sight on enough recent turns are a pattern.
      const pattern = fogCapturePattern(observed);
      if (pattern) observed[observed.length - 1]!.fogCaptures = pattern;
    }
    const v = visibleAt(lastTurn).get(playerId) ?? { base: baseIncome, bonusIncome: 0 };
    const visibleIncome = v.base + v.bonusIncome;
    const visible = latest.territories.filter(
      (t) => g.territoryById.has(t.territoryId) && t.owner.kind === 'player' && t.owner.playerId === playerId && ownerShown(t),
    ).length;
    // Back from the newest board while consecutive boards show none of its territories: we stop
    // on a board that shows it (exact), on turn 0 (the whole game, exact) or on a turn I have no
    // board for (a gap or the oldest board): then all I know is the turns after it, a floor.
    let back = lastTurn;
    while (back >= 1 && byTurn.has(back) && !seesPlayer(byTurn.get(back)!, g, playerId)) back--;
    const turnsUnseen = visible ? 0 : lastTurn - back;
    const turnsUnseenAtLeast = turnsUnseen > 0 && back >= 1 && !byTurn.has(back);
    const recent = observed.slice(-INCOME_TURNS);
    // #119: no decay ({@link carryIncome}). The last three turns alone read a real 31 as 12 once
    // it aged out.
    const carry = carryIncome(observed);
    // #418: the readings an over-read tripwire stepped down from count at most its ceiling.
    const lastWindow = recent.length ? ceiledIncome(recent, visibleIncome, carry?.ceiling) : null;
    const carried = carry !== null && lastWindow !== null && carry.income > lastWindow.income ? carry : null;
    // #418: an unconfirmed rise held below what the last window reads keeps the held figure.
    const held = !carried && carry?.rise && lastWindow !== null && carry.income < lastWindow.income ? carry : null;
    const estimate = carried
      ? { ...carried.est, income: carried.income, method: (carried.trip ? 'tripped' : 'carried') as IncomeMethod }
      : held
        ? {
            ...held.est,
            income: Math.max(visibleIncome, held.income),
            method: (visibleIncome >= held.income ? 'visible' : 'rise-capped') as IncomeMethod,
          }
        : lastWindow;
    const incomeRise = held && estimate!.method === 'rise-capped' ? held.rise! : null;
    const incomeTrip = estimate?.method === 'tripped' ? (carried?.trip ?? carry?.ceiling?.trip ?? null) : null;
    const incomeWindow = carried ? carried.window : held ? held.window : recent;
    const income = estimate?.income ?? null;
    // #250: an income set by one turn far above the turns before it, with the evidence for it. Its
    // starting armies, when known (under full distribution, an even share: an upper bound).
    const jump =
      estimate && observed.length >= 2
        ? incomeJump(g, byTurn, playerId, observed, incomeWindow, carried ? carried.est.method : estimate.method, startArmies, me)
        : undefined;
    const unexplained = observed.length
      ? Math.max(0, observed.reduce((s, x) => s + x.earned - x.net - x.losses - x.combat, 0))
      : null;
    const gap = income !== null ? income - visibleIncome : 0;
    // #123: what it could have spent taking bonuses out of sight: its starting armies (when the
    // settings give them) plus what it earned — on each observed turn, what it was seen to earn
    // (`earned`); on every other turn of the game so far, the base income (not its income now,
    // which overstates the early game).
    const budget =
      (game?.start ? game.start.territories * game.start.armiesPerTerritory : 0) +
      observed.reduce((sum, x) => sum + x.earned, 0) +
      baseIncome * Math.max(0, Math.max(1, lastTurn) - observed.length);
    const inferred = gap > 0 ? inferBonuses(possibleBonuses(g, latest, playerId), gap, budget) : null;

    const notes: string[] = [];
    const warnings: string[] = [];
    let earnedAtLeast: EarnedBound | null = null;
    if (!visible) {
      const start = game?.start ? game.start.territories * game.start.armiesPerTerritory : null;
      const paid = Math.max(0, lastTurn);
      const total = (start ?? 0) + baseIncome * paid;
      earnedAtLeast = {
        total,
        start,
        baseIncome,
        turns: paid,
        largestStack,
        visibleArmies,
        exceedsLargest: total > largestStack,
        exceedsTotal: total > visibleArmies,
      };
      const s = (n: number) => (n === 1 ? '' : 's');
      const outOfSight = turnsUnseenAtLeast
        ? `out of sight for at least ${turnsUnseen} turn${s(turnsUnseen)} (no board of mine for turn ${back})`
        : `out of sight for ${turnsUnseen} turn${s(turnsUnseen)}`;
      const startText =
        start !== null ? `starting armies ${start} (${game!.start!.territories} territories × ${game!.start!.armiesPerTerritory}) + ` : '';
      notes.push(
        `It has been ${outOfSight} and has received at least ${total} armies since the game started (${startText}base income ${baseIncome} × ${paid} turn${s(paid)}, no bonus counted): a lower bound on armies received, not held — it could be banking up to roughly this, minus what its expansion cost.${
          start === null ? ` Its starting armies are not counted: ${game?.startUnknown ?? 'the settings do not give them'}.` : ''
        }${caveats.length ? ` The base income each turn may not hold: ${caveats.join('; ')}.` : ''}`,
      );
      const head = `Player ${nameOf(playerId)} has been ${outOfSight} and has received at least ${total} armies since the game started (${
        start !== null ? `starting armies ${start} + ` : ''
      }base income ${baseIncome} × ${paid} turn${s(paid)})`;
      if (earnedAtLeast.exceedsLargest)
        warnings.push(`${head}; it could be banking a stack larger than your largest (${largestStack}).`);
      if (earnedAtLeast.exceedsTotal)
        warnings.push(`${head}; it could be banking more than your total visible armies (${visibleArmies}).`);
    }
    // #567: a turn of the window surely read more than the income held: said, never applied.
    const observedLow = observed.length >= TRACKED_MIN_TURNS ? observedLowOf(incomeWindow, income) : null;
    if (observedLow) warnings.push(observedLowWarning(nameOf(playerId), income!, observedLow, estimate!.method));
    if (jump)
      warnings.push(
        `Player ${nameOf(playerId)}'s ${incomeJumpText(jump, income!, observed.filter((x) => x.from >= jump.since && x.from < jump.turn))}`,
      );
    if (firstSeen === null) {
      // Never in view: there is nothing else to say about it.
    } else if (observed.length < 2)
      notes.push(
        `Only ${observed.length} observed turn${observed.length === 1 ? '' : 's'} (fewer than 2 observed turns): the planner keeps its single-turn estimate.`,
      );
    else {
      const basis = incomeBasis({
        incomeMethod: estimate!.method,
        incomeTurns: incomeWindow.map((x) => x.from),
        observedRange: estimate!.observedRange,
        incomeLowered: carried ? carried.set - carried.income : 0,
        incomeRise,
        incomeTrip,
      });
      if (incomeTrip)
        notes.push(
          `Income ~${income} (${basis}): proof lowers an estimate only on a turn with every army it could deploy in view, and then by one step a turn (#418). Each observed deploy is a lower bound under fog.`,
        );
      else if (incomeRise)
        notes.push(
          `Income ~${income} (${basis}): a rise is held to ${RISE_CAP}× a turn until a turn read in full (no army read as a move out of the fog) confirms it, since armies walking in beside the fog are read up to twice the income carried (#418). Each observed deploy is a lower bound under fog.`,
        );
      else if (carried)
        notes.push(
          `Income ~${income} (${basis}): an income does not decay — it is kept until a bonus it visibly held is visibly broken (less its value) or it could no longer earn it; its last ${recent.length} observed turns alone give ~${lastWindow!.income}. Each observed deploy is a lower bound under fog.`,
        );
      else notes.push(
        `Income ~${income} (${basis}): the larger of the most it was observed to deploy (each observation is a lower bound under fog, so the largest is the tightest) and its visible army growth plus losses per turn, fog arrivals left out (${estimate!.stockFlow}), capped at the most it could earn (${estimate!.cap}), at least its visible income ${visibleIncome}.`,
      );
    }
    if (missing.length)
      notes.push(`No board for turn ${missing.join(', ')}: only consecutive turns are compared, so those turns are not observed.`);
    if (unseen.length) {
      const ts = [...new Set(unseen)].sort(byNum);
      notes.push(
        `No territory of it in view on turn ${ts.join(', ')}: the turn pairs around ${ts.length === 1 ? 'it are' : 'them are'} not observed.`,
      );
    }
    const capped = observed.filter((x) => x.raw > x.cap);
    if (capped.length)
      notes.push(
        `Capped at what it could earn on turn ${capped.map((x) => `${x.from} (+${x.raw} → ${x.cap})`).join(', ')}: armies from the fog or a Reinforcement card may explain the rest.`,
      );
    const measuredTurns = observed.filter((x) => x.measured);
    if (measuredTurns.length)
      notes.push(
        `My own orders on turn ${measuredTurns.map((x) => `${x.from} (${x.measured > 0 ? '+' : ''}${x.measured})`).join(', ')} count as measurements: the defenders my failed attacks killed, and what a hold of mine that fell really killed.`,
      );
    // #271 (1): its failed attacks on my holds, each a bound on that turn's deploy.
    for (const x of observed.filter((x) => (x.repelledFloor ?? 0) > 0)) {
      const r = x.repelled!;
      const one = r.territories.length === 1;
      notes.push(
        `Turn ${x.from}: its attack on territor${one ? 'y' : 'ies'} ${r.territories.join(', ')} that held needed at least ${r.attackers} attackers for what I lost there (my orders say what stood there); its stacks beside ${one ? 'it' : 'them'} could send ${r.supply} at the start of the turn, so it deployed at least ${r.floor} that turn, fog or not.`,
      );
    }
    // #271 (2): a pattern of captures that needed attackers out of sight (the latest one).
    const patternTurn = [...observed].reverse().find((x) => x.fogCaptures);
    if (patternTurn) {
      const p = patternTurn.fogCaptures!;
      const n = observed.filter((x) => p.turns.includes(x.from)).reduce((k, x) => k + (x.unseenAttackers?.length ?? 0), 0);
      notes.push(
        `${n} captures of neutrals in view on turns ${p.turns.join(', ')} needed ${p.armies} attackers beyond what its stacks in view sent: ${FOG_CAPTURE_MIN} or more turns in ${FOG_CAPTURE_TURNS} are a pattern, read as income of ~${p.income}/turn (spread over turns ${p.turns[0]}–${patternTurn.from}), not stacks walking out of the fog.`,
      );
    }
    const reveals = observed.reduce((s, x) => s + x.reveals.length, 0);
    if (reveals) notes.push(`${reveals} fog reveal${reveals === 1 ? '' : 's'} skipped: stacks that only came into view are not income.`);
    // A reinforced capture whose surplus passed the bound is in `fromFog` too: its note is below.
    const outOfFog = (x: ObservedTurn) => x.fromFog.filter((id) => !x.reinforced.includes(id));
    const fogCaptures = observed.filter((x) => outOfFog(x).length);
    if (fogCaptures.length) {
      const n = fogCaptures.reduce((s, x) => s + outOfFog(x).length, 0);
      notes.push(
        `${n} capture${n === 1 ? '' : 's'} out of the fog on turn ${fogCaptures.map((x) => x.from).join(', ')}: only what ${n === 1 ? 'it' : 'they'} cost counts as deploy; no visible stack of it shrank into ${n === 1 ? 'it' : 'them'}, so the stack most likely moved in from the fog.`,
      );
    }
    // #123: the ambiguous readings, each with the other way it could read.
    const span = (xs: readonly ObservedTurn[]) => xs.map((x) => `${x.from} (${x.low}–${x.high})`).join(', ');
    const reinforcedTurns = observed.filter((x) => x.reinforced.length);
    if (reinforcedTurns.length)
      notes.push(
        `Captures with more armies than its visible stack next to them sent, on turn ${span(reinforcedTurns)}: read as armies deployed on the visible stack that attacked (deploy-then-capture), up to twice what it was expected to deploy and the rest as a stack out of the fog; a stack out of the fog may have joined instead, the low figure.`,
      );
    const fogGrowthTurns = observed.filter((x) => x.grewFromFog.length);
    if (fogGrowthTurns.length)
      notes.push(
        `Growth next to the fog beyond twice what it was expected to deploy, on turn ${span(fogGrowthTurns)}: read as stacks that walked in from the fog, not income; it may be income the fog hides, the high figure.`,
      );
    const emptiedTurns = observed.filter((x) => x.emptied.length && !x.measured);
    if (emptiedTurns.length)
      notes.push(
        `Captures from me on turn ${span(emptiedTurns)} priced at the guard I may have left (my orders that turn are unknown); had my stack stood there, the high figure.`,
      );
    const fought = observed.filter((x) => x.combat);
    if (fought.length)
      notes.push(
        `It may have lost ${fought.reduce((s, x) => s + x.combat, 0)} fighting on turn ${fought.map((x) => x.from).join(', ')} (its stack and a neighbour of another player both shrank): left out of the unexplained armies.`,
      );
    if (unexplained)
      notes.push(
        `${unexplained} unexplained armies: what it earned since first seen beyond its visible army change and losses — in the fog, spent there, or a misread (a transfer or a fight the boards cannot tell apart).`,
      );
    if (observed.length)
      notes.push(
        'Observed deploys are lower bounds: armies moved into the fog and losses in failed attacks are unseen, and the fog may hide territories and bonuses.',
      );
    if (inferred) {
      const n = inferred.candidates.length + inferred.more;
      const left = inferred.implausible
        ? ` (${inferred.implausible} bonus${inferred.implausible === 1 ? '' : 'es'} left out: more than ${INFER_REACH} hops from its territories, or more than it could have paid for)`
        : '';
      if (!n) notes.push(`No combination of bonuses it could hold explains its income gap of ${gap}${left}.`);
      else if (!inferred.candidates.length)
        notes.push(`${n} combinations fit its income gap of ${gap}${inferred.exact ? '' : ' approximately'}: too many to name any${left}.`);
      else
        notes.push(
          `${n} combination${n === 1 ? '' : 's'} fit${n === 1 ? 's' : ''} its income gap of ${gap}${inferred.exact ? '' : ' approximately'}, nearest first: candidates, not facts${left}.`,
        );
    }
    // #164: stacks that left view. The last board showing each territory decides: a large stack of
    // its there, and every later board hides it (fogged, or its armies hidden).
    const largeAt = (turn: number, armies: number) => {
      const income = visibleAt(turn).get(playerId);
      return armies - guard > 0 && armies - guard >= LOST_STACK_INCOMES * (income ? income.base + income.bonusIncome : baseIncome);
    };
    const largeOn = (turn: number, id: number) => {
      const st = visibleState(shownOn(turn).get(id));
      return st && st.owner.kind === 'player' && st.owner.playerId === playerId && largeAt(turn, st.armies!) ? st.armies! : null;
    };
    const candidates: LostStack[] = [];
    for (const id of [...g.territoryById.keys()].sort(byNum)) {
      let last: { turn: number; armies: number } | null = null;
      let lastShown = -Infinity;
      for (const turn of turns) {
        if (!visibleState(shownOn(turn).get(id))) continue;
        lastShown = turn;
        const armies = largeOn(turn, id);
        last = armies !== null ? { turn, armies } : null;
      }
      if (last && last.turn === lastShown && last.turn < lastTurn) candidates.push({ territoryId: id, turn: last.turn, armies: last.armies });
    }
    // Under Normal fog a territory next to mine never leaves view, so a stack that walks off it into
    // the fog shows as a shrink, not a hidden territory: a large stack of its that shrank between two
    // consecutive boards (its territory in view on both), beyond what its neighbours in view gained
    // (its own that grew, captures of its, the defenders those killed), with a neighbour the fog
    // hides on the later board, left view with what went missing (the guard counted on top, as on a
    // standing stack). A shrink beside a fight — a neighbour in view of anyone else's that shrank or
    // changed hands — is skipped: the board cannot tell a lost attack from a move.
    const defensive = settings.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
    for (let i = 1; i < turns.length; i++) {
      const from = turns[i - 1]!;
      const to = turns[i]!;
      if (to !== from + 1 || lastTurn - from > LOST_STACK_TURNS) continue;
      const was = shownOn(from);
      const now = shownOn(to);
      const its = (st: BoardState['territories'][number] | undefined) =>
        st !== undefined && st.owner.kind === 'player' && st.owner.playerId === playerId;
      for (const id of [...g.territoryById.keys()].sort(byNum)) {
        const b = visibleState(was.get(id));
        const a = visibleState(now.get(id));
        if (!its(b) || !its(a) || !largeAt(from, b!.armies!)) continue;
        const drop = b!.armies! - a!.armies!;
        if (drop <= 0) continue;
        let inView = 0;
        let fight = false;
        let hiddenNext = false;
        for (const n of neighborsOf(g, id)) {
          const nb = visibleState(was.get(n));
          const na = visibleState(now.get(n));
          if (!na) {
            hiddenNext = true;
            continue;
          }
          if (its(na)) {
            if (its(nb)) inView += Math.max(0, na.armies! - nb!.armies!);
            else inView += na.armies! + (nb ? straightKills(nb.armies!, defensive) : 0);
          } else if (nb && (its(nb) || nb.owner.kind !== na.owner.kind || (nb.owner.kind === 'player' && na.owner.kind === 'player' && nb.owner.playerId !== na.owner.playerId) || na.armies! < nb.armies!))
            fight = true;
        }
        const gone = drop - inView;
        if (fight || !hiddenNext || gone <= 0 || !largeAt(from, gone + guard)) continue;
        candidates.push({ territoryId: id, turn: from, armies: gone + guard });
      }
    }
    // A stack is tracked by territory, so one that moved into view elsewhere would still read as
    // lost. Each large stack of its that appeared in view after a lost one (not large there on the
    // board before) and that the lost one could have reached by then (one move a turn) is taken as
    // that stack, or the part of it in view: it offsets the lost armies once, the largest stack it
    // can reach first; what is left stays lost while still large.
    const appeared: { turn: number; territoryId: number; armies: number }[] = [];
    for (let i = 1; i < turns.length; i++)
      for (const id of [...g.territoryById.keys()].sort(byNum)) {
        const armies = largeOn(turns[i]!, id);
        if (armies !== null && largeOn(turns[i - 1]!, id) === null) appeared.push({ turn: turns[i]!, territoryId: id, armies });
      }
    const used = new Set<number>();
    const lostStacks: LostStack[] = [];
    for (const l of candidates.sort((a, b) => b.armies - a.armies || a.territoryId - b.territoryId)) {
      const dist = bfsDistances(g, [l.territoryId]);
      let armies = l.armies;
      const reach = appeared
        .map((a, i) => ({ ...a, i }))
        .filter((a) => !used.has(a.i) && a.turn > l.turn && (dist.get(a.territoryId) ?? Infinity) <= a.turn - l.turn)
        .sort((a, b) => b.armies - a.armies || a.turn - b.turn || a.territoryId - b.territoryId);
      for (const a of reach) {
        if (armies - guard <= 0) break;
        used.add(a.i);
        armies -= a.armies;
      }
      if (armies === l.armies) lostStacks.push(l);
      else if (largeAt(l.turn, armies)) lostStacks.push({ ...l, armies });
    }
    // #201: an attack out of the fog fixes where a lost stack is. A territory of mine on one board
    // that is this player's on the next, with no territory of its in view beside it on the first
    // (so the attack came from a neighbour the fog hid), places the stack that made it: it stood next
    // to that territory during that turn, so it is counted as last seen there on that turn (its reach
    // from there covers every border it can reach from wherever it attacked from). The largest lost
    // stack of its that could have stood beside it by then is taken, each attack fixing one stack,
    // and the latest attack wins.
    for (let i = 1; i < turns.length; i++) {
      const from = turns[i - 1]!;
      const to = turns[i]!;
      if (to !== from + 1) continue;
      const was = shownOn(from);
      const now = shownOn(to);
      /** Lost stacks an attack already placed on this turn: each attack fixes one stack, once. */
      const placed = new Set<number>();
      for (const c of [...g.territoryById.keys()].sort(byNum)) {
        const b = was.get(c);
        const a = now.get(c);
        if (b?.owner.kind !== 'player' || b.owner.playerId !== me || a?.owner.kind !== 'player' || a.owner.playerId !== playerId) continue;
        const nexts = neighborsOf(g, c).map((n) => was.get(n));
        if (nexts.some((n) => n?.owner.kind === 'player' && n.owner.playerId === playerId)) continue;
        if (!nexts.some((n) => !visibleState(n) && (!n || n.owner.kind === 'unknown'))) continue;
        const k = lostStacks
          .map((l, idx) => ({ l, idx }))
          .filter(({ l, idx }) => !placed.has(idx) && l.turn <= from && (bfsDistances(g, [l.territoryId]).get(c) ?? Infinity) <= from - l.turn + 1)
          .sort((x, y) => y.l.armies - x.l.armies || x.l.territoryId - y.l.territoryId)[0];
        if (!k || (k.l.territoryId === c && k.l.turn === from)) continue;
        lostStacks[k.idx] = { ...k.l, territoryId: c, turn: from };
        placed.add(k.idx);
        notes.push(
          `Its stack of ${k.l.armies} (last seen on territory ${k.l.territoryId} on turn ${k.l.turn}) attacked territory ${c} out of the fog between turns ${from} and ${to} (#201): it stood next to ${c} then, so it is counted from there.`,
        );
      }
    }
    // The planner drops a stack seen more than LOST_STACK_TURNS turns ago, so drop it here before the
    // cut: a stale large stack must never push a fresh one out of the MAX_LOST_STACKS kept. (Aged
    // against the newest board; the planner ages it against the turn being played, never earlier.)
    const fresh = lostStacks.filter((l) => lastTurn - l.turn <= LOST_STACK_TURNS);
    lostStacks.splice(0, lostStacks.length, ...fresh);
    lostStacks.sort((a, b) => b.armies - a.armies || a.territoryId - b.territoryId).splice(MAX_LOST_STACKS);
    for (const l of lostStacks)
      notes.push(`A stack of ${l.armies} was last seen on territory ${l.territoryId} on turn ${l.turn} and has been out of view since (stacks of it that came into view since, within its reach, are taken as it and offset it): the planner counts it at each border it can reach by now, for ${LOST_STACK_TURNS} turns after it was seen.`);
    // #294: what its income was read from.
    const covered = estimate ? trackCoverage(incomeWindow) : null;
    if (covered && covered.share < 1)
      notes.push(
        `Income read from ${coverageText(covered)}: the rest of where it can deploy was out of view, so the figure is a lower bound${covered.share < LOW_COVERAGE && observed.length >= TRACKED_MIN_TURNS ? `, and the planner sizes it toward the midpoint between it and the most it could have (#368)` : ''}.`,
      );
    notes.push(...warnings);
    return {
      playerId,
      firstSeen,
      lastTurn,
      turns: observed,
      base: v.base,
      bonusIncome: v.bonusIncome,
      visibleIncome,
      income,
      incomeTurns: incomeWindow.map((x) => x.from),
      coverage: estimate ? trackCoverage(incomeWindow) : null,
      observedRange: estimate?.observedRange ?? null,
      incomeMethod: estimate?.method ?? null,
      incomeLowered: carried ? carried.set - carried.income : 0,
      ...(incomeRise ? { incomeRise } : {}),
      ...(incomeTrip ? { incomeTrip } : {}),
      ...(observedLow ? { observedLow } : {}),
      unexplained,
      inferred,
      topUp: observed.reduce<number | null>((n, x) => (x.topUp === undefined ? n : Math.max(n ?? 0, x.topUp)), null),
      visible,
      turnsUnseen,
      turnsUnseenAtLeast,
      earnedAtLeast,
      lostStacks,
      ...(jump ? { incomeJump: jump } : {}),
      warnings,
      notes,
    };
  });
}
