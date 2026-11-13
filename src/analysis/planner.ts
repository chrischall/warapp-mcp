// Turn planner: deploys and moves for one turn, from one player's view of a
// board. Pure and deterministic (every choice tie-breaks on ascending id); no
// I/O. Advisory only — it never submits orders.
//
// Rules, in decision order:
//  0p. Game profile (`gameProfile`, src/analysis/profile.ts), computed on every plan and
//     returned as `profile`: format (1v1 / ffa / teams), phase (opening / expansion /
//     contact / late), standing (my income against the strongest opponent's estimate:
//     ahead ≥ AHEAD_RATIO×, behind ≤ BEHIND_RATIO×, unknown when fog hides most of the
//     board) and the settings that shape strategy. Only with `options.adapt` and no `goal`
//     does it change the plan (each rule a rationale line when it fires):
//       1. 1v1 in contact: a break is weighted like a completion of equal value (weight 1),
//          and an advance (expansion that completes no bonus) ranks below every hold, unit,
//          break and completion, and never defers a hold for the expansion share.
//       2. FFA with two or more opponents left: no second front — a break (also from a held
//          border, rule 4a) against a player that can take no member of a bonus I hold next
//          turn and loses nothing to this turn's strike / finishing off is skipped when a
//          neutral bonus capture scores at least SECOND_FRONT_SIMILAR × its score per army.
//          Finishing off (rule 1e) and strikes (rule 1s) are untouched.
//       3. Behind: the goal is `defend`, and pressure (rule 1e) is sized with no margin.
//          Ahead in a 1v1: pressure is allowed up to AHEAD_PRESSURE_FACTOR typical
//          expansions (instead of PRESSURE_FACTOR).
//       4. An explicit `goal` always wins: none of the above, and the rationale says the
//          profile was overridden.
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
//     floor. Given `previousBoard`, each estimate is at least the deploy observed since
//     then (`observeDeploy`, issue #57: the net change of its armies visible on both
//     boards — shrinks included, so a transfer between its own territories is not deploy —
//     plus, on each territory it captured from a visibly held or neutral territory, the
//     attackers the previous defenders killed at the game's kill rates, and its armies there
//     only up to what its visible-both-turns neighbours sent away (their shrink, each claimed
//     once, ascending id); the rest arrived from the fog when a neighbour was hidden (a move
//     and a threat, never income, issue #86), or counts as deploy when every neighbour was in view). A territory hidden last turn
//     (fogged, or under a fog level that hid its armies) is a fog reveal, never growth or a
//     capture (issue #69). The observed figure is never cut by the stack cap, but is capped
//     at what the opponent could earn on this board: its base income plus every bonus none of
//     whose territories someone else visibly holds, owner-only included (a warning says when). A rationale line names
//     the turns compared and the territories counted vs skipped as reveals; the warning
//     names which source won.
//     `options.enemyDeploy` overrides all of them. Always a warning.
//  1t. Trend. Given `previousBoard` (my view one turn earlier), each visible
//     enemy territory next to me that was visible then (owner and armies, #69) under the same owner and
//     has grown is "building" at growth = armies now − armies then per turn (a
//     warning naming my most exposed neighbour and the armies it needs to hold
//     next turn and the turn after). A border's threat becomes movable +
//     max(enemyDeploy, the owner's fastest growth next to it), so its hold cost
//     and the leftover margin both use the projection (a rationale line says so).
//  1e. Finish off (under `balanced` and `defend`, before triage; issue #45). For
//     each visible opponent whose every territory is visible (none borders the fog)
//     and borders mine — fewest territories, then fewest armies, then id — size
//     attacks on its territories against its best response: its deploy estimate D is
//     ONE budget, split (in whole armies) over its territories to save as many as it
//     can. An attack that takes up to c defenders is saved by c − armies + 1 deploys
//     there; saving the cheapest first is optimal, so the sure falls are exact
//     (`guaranteedFalls`). Every sizing is searched: each territory attacked as if
//     0..D of the deploy lands there, or not attacked (all of them while there are at
//     most 1024 sizings, else evenly spaced shares, always including D), with the
//     usual capture rules (single and combined attacks, kill rates, luck margin, R3);
//     a softener in a combined capture never kills the defenders there now either.
//     Every opponent in reach is tried, not only weak ones. A sizing succeeds when every
//     territory falls for sure (elimination, so each attack is sized for all of D), or
//     when the sure falls leave it at most one territory or take at least half of it,
//     no attacking border faces a territory left unattacked, and every hold worth
//     paying for against those is funded. The best success wins: elimination, then
//     more sure falls, then fewer attacking armies, then a dearer cheapest save, then
//     fewer deploys. Holds that pass rule 1a's CONCEDE_FACTOR test against other
//     players (and against what a retry leaves unattacked) come first: an attacking
//     source keeps what holds it; on a border that attacks nothing, each hold, best
//     worth per army first, is deployed there while the attacks are sized when it fits
//     what is left (one that does not is left to triage), then released for triage to
//     deploy. When the best sizing fails only on an unfunded hold, the search runs once
//     more with those holds reserved and those territories left unattacked, and its
//     best is kept if it beats the first search's. With no success, nothing changes.
//     An opponent bordering the fog is never eliminated (issue #60): it is pressured
//     instead — every visible territory attacked, each sized for its full deploy plus
//     pressureMargin (an attack sized for exactly the estimate failed live), and
//     only when all of them fall for sure ("Pressure player …: take all N of its visible
//     territories …, so this is not an elimination", with a warning that it may hold more
//     in the fog) — when each of those margin-sized captures costs at most PRESSURE_FACTOR × a typical
//     expansion capture (the median capture cost of the visible neutrals next to me; with
//     none, any cost). Otherwise it is not attempted (a warning says so when its visible
//     territories could all be taken); with fog anywhere else, the
//     elimination is hedged ("if it holds nothing in the fog") and a warning says it
//     may hold unseen territories. When it can save some attacked territories, a
//     warning says it chooses which. Borders next to the attacks are then re-judged
//     without the territories attacked, and triage judges each border by the armies
//     that stay on it. A border held last turn (per `previousBoard`) by a weak opponent
//     (fully visible, fewer territories than mine, deploy below my income) that
//     threatens it now is never conceded economically (the rationale says so once its
//     hold is deployed); under `balanced` its hold goes first.
//  1a. Triage (every goal). Each threatened border's protected value is the sum
//     of my complete bonuses containing it, plus incomplete bonuses containing it
//     that I would lose all access to without it, plus the per-territory
//     income it carries (each bonus counted once). Its worth adds the armies a
//     hold saves, in income terms (armies / PAYBACK_TURNS): a top-up that keeps a
//     big stack is worth paying even for a small bonus (live, a 60-army border
//     protecting +4 needed 20 and held against 105). Its hold cost is the fewest
//     deploys making `armiesToTake(armies + d) > threat`. Every border facing one
//     opponent is sized for that opponent's whole deploy (#69): it picks where to land
//     after I commit, so that is each border's worst case, and a sure hold of several
//     needs each sized for it (a rationale line says so when two or more are held
//     against one player). Borders are taken in
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
//  1h. Held bonuses (under `balanced` and `defend`; issue #51). Every bonus I hold in
//     full with a threatened border is one unit: its threatened borders are all held
//     or none (holding some while conceding another breaks it anyway). Its hold cost
//     is the sum of its borders' (a border shared by two held bonuses counts in both
//     units' feasibility, and is paid for once). A unit pays for itself when that cost
//     ≤ PAYBACK_TURNS × its value and, as rule 1a asks of every border, ≤ CONCEDE_FACTOR
//     × its worth (waived when a member was just taken from a weak opponent); one that
//     does not is conceded whole. A unit that pays is funded before any capture that
//     completes no bonus (advances, breaks, other expansion, unless focused): under `defend` with the
//     other holds, by worth per army (worth = value + the armies its holds save /
//     PAYBACK_TURNS); under `balanced` it competes on that score with holds and
//     completions, and at the first advance or break every pending unit runs first
//     (with the completions outscoring the weakest of them). A completion that runs
//     before a pending unit and would leave too little to fund it runs only when its
//     bonus earns more than the units it starves; otherwise it waits until they are
//     funded (concede a held bonus only for alternatives that earn more). It waits for
//     rule 4a's expansion share only until then. Finishing off (rule 1e) keeps its place before
//     it. A unit the armies left cannot cover is first tried as a near miss (issue #59):
//     each border not yet held gets what may still be deployed there, up to its hold
//     cost (pools respected), and the unit is kept — deploys stay, nothing withdrawn,
//     a warning "… is held though short …; X may fall" — when the total is short by at
//     most nearMissMargin(need) = max(NEAR_MISS_ARMIES, NEAR_MISS × need), or when every
//     short border still holds against the expected attack (movable + deploy estimate,
//     no trend projection). Otherwise it is conceded whole ("conceding bonus …:
//     holding all N threatened borders needs X, more than …"; a one-border unit keeps
//     rule 1a's warnings). Each border of a conceded unit is then judged alone by rule
//     1a with its protected value less that bonus (other bonuses, per-territory income,
//     the stack it saves), and held only when that justifies it. Under `expand`
//     nothing changes, but a warning names each held bonus whose holds would pay back;
//     `complete-bonus` is unchanged.
//  1k. My commander (every goal; #61). A territory where my own commander stands is
//     must-hold: when threatened it is held before any other hold or capture (only a
//     commander strike, rule 1s, comes first, and it reserves this hold), never
//     conceded, and it makes no attack or transfer except that strike. When the hold
//     does not fit, all that may still be deployed there goes there, with a warning.
//     Unthreatened, any attack from it keeps what holds it against the visible enemies
//     next to it; next to an enemy at the start of the turn, it never transfers out (a
//     capture that makes it interior can still fail). A held bonus containing it leaves
//     its hold, once fully funded here, out of the bonus's cost and payback test (rule 1h):
//     neither its hold cost nor the stack it saves counts for the unit. The
//     commander itself never moves: planned moves carry armies only (the order encoder
//     sends no special units).
//  1s. Commander strike (every goal, before finishing off, triage and any expansion; #61).
//     A visible enemy commander next to a territory I held at the start of the turn is
//     attacked first — killing it eliminates its owner — sized for its armies + the
//     commander's 7 + its owner's full deploy estimate. Nothing is conceded yet, so a thin
//     border next to it may strike with deploys. No vanishing: war.app interleaves both
//     players' attacks, so only the struck territory stops threatening; the owner's other
//     stacks still count in every threat this turn (elimination changes next turn). My
//     commander's must-hold reserve is funded first: the deploys its territory needs against
//     those threats (all that may be deployed there when the hold does not fit). The strike
//     is funded from what is left plus each source's movable armies beyond its keep (what
//     holds it); a source other than my commander's whose hold is hopeless even with the
//     deploys left keeps nothing (its armies are lost anyway). R3 never vetoes a strike (the
//     bonus side-effect is irrelevant). A source that already issues an order (No-Split) does
//     not strike (strikes run before every other pass, so no source is locked or conceded
//     yet). With no source able to send that many, and no finishing off taking it, a warning
//     names what held it back — a source's keep (only when that source could send enough
//     without it and the reserve), the reserve (only when it binds: a source could send
//     enough with its keep but for the reserve, or dropping the keep alone would not do),
//     No-Split, or "unaffordable" — and nothing is attacked.
//     When a strike is planned and, once every deploy and move is planned, what stays on my
//     commander's territory falls to the visible stacks next to it — the struck one included
//     (attacks interleave, so it may attack before the strike lands; a strike from my
//     commander's territory thins it) — `cardAdvice` is Order Priority if I hold one
//     (`holdsOrderPriority`: my attacks resolve first), with a rationale line; without one, a
//     warning says the attacks interleave. Its owner is not also finished off (rule 1e).
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
//     A conceded border of a bonus I hold in full whose armies staying still hold
//     against the expected attack (movable + deploy estimate) is never withdrawn from
//     (issue #59): its garrison stays, and under Local Deployment its bonus's leftover
//     pool may go there as if it were not conceded.
//  2. Targets: visible neutrals adjacent to a territory I held at the start of
//     the turn (plus visible enemy territories under `goal: 'complete-bonus'`, and
//     under `balanced` only enemy territories in a breakable bonus — one whose
//     every territory is visible and held by a single enemy; never under
//     `expand`/`defend`). Fogged or unknown neighbours are never attacked — they
//     produce a warning.
//  3. Capture cost: `armiesToTake` (0% luck, straight round). With luck L > 0
//     the cost becomes `ceil(cost / (1 − L))`, i.e. the luck-free share of the
//     attack alone still takes the territory. S2: with `minWinChance` below 1 an
//     ordinary capture instead gets the fewest armies whose exact `winChance`
//     reaches it (worst-case sizings stay guaranteed); every attack carries its
//     `winChance`; after the leftover deploy an attack is topped up to its next kill
//     breakpoint from idle armies on its source (never a hold, a conceded border, my
//     commander's territory or a source still facing an enemy) when its target is a
//     player's or it is not certain; otherwise an attack between breakpoints is named.
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
//     never captures into it (completing one would cut income). A positive bonus is
//     scored by its net worth (rule 4c), not its value, in every test above.
//  4c. Net income (#70). Maps with overlapping bonuses (each sea tile a single-territory
//     −4 bonus and a member of a +22 group) are scored by every capture's effect on
//     income: `incomeGain` — the exact sum over every bonus whose completion status
//     changes, the one computation `expected.nextIncome` and R3 use. A positive bonus's
//     net worth is its value plus the (negative) values of the other negative bonuses its
//     missing members complete (= value on a map without negative bonuses); net ≤ 0 is
//     uneconomic unless focused. Completing it is all or nothing (pass 1), refused when it
//     would lower income. A capture that lowers income this turn (it completes a negative
//     bonus) is taken only when (a) it is part of completing a positive bonus this turn,
//     (b) it is in a focused bonus, or (c) it stages a bonus: with k = ceil(the capture
//     cost of the bonus's other missing members / the income left after this step) turns
//     to finish (≥ 1; unknown under fog, or no income left: refused), k ≤ PAYBACK_TURNS and k × every penalty its missing
//     members carry ≤ PAYBACK_TURNS × its net worth; the reason then says "stages", never
//     "advances". Pass 3 never takes one. Guard: after the capture passes, while next income
//     is below this turn's, the latest capture that completes a negative bonus is dropped
//     (its attacks taken back, its deploys left where they are) unless focused, staging,
//     a commander strike or finishing off; whatever remains is a warning with the numbers.
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
// Special units: a commander fights as COMMANDER_STRENGTH (7) armies, attacking and
// defending, and takes no partial damage (armies die first; it falls to 7 damage left
// over), so a stack of d armies plus a commander defends exactly as d + 7: every capture
// cost, worst case, survivor count and hold above counts it, and an enemy commander next
// to my border adds 7 to that player's threat. A target with a special unit is never a
// combined capture. Bosses and custom units are not counted.
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
import {
  armiesForChance,
  armiesToTake,
  COMMANDER_STRENGTH,
  DEFAULT_DEFENSIVE_KILL_RATE,
  DEFAULT_OFFENSIVE_KILL_RATE,
  guaranteedKills,
  luckFraction,
  nextBreakpoint,
  specialUnitStrength,
  straightKills,
  winChance,
  type CombatSettings,
  type KillRates,
} from './combat.js';
import { bfsDistances, neighborsOf, type MapGraph } from './graph.js';
import { chargeDeploys, deployPools } from './local-deploy.js';
import { boardIncome, DEFAULT_BASE_INCOME, incomeRules, territoryIncome } from './player.js';
import { gameProfile, type GameProfile, type ProfilePlayer } from './profile.js';

/** A bonus is uneconomic when its remaining capture cost exceeds this many turns of its value… */
export const PAYBACK_TURNS = 10;
/** …or when one remaining territory alone costs more than this many times its value (a wasteland). */
export const WASTELAND_FACTOR = 5;
/** Floor of the default enemy deploy estimate (a player's base income). */
export const MIN_ENEMY_DEPLOY = DEFAULT_BASE_INCOME;

/** Fog reveals named in the observed-deploy rationale before "and N more". */
const MAX_NAMED_REVEALS = 6;
/** The default estimate is capped at this share of the opponent's largest stack next to me. */
export const ENEMY_STACK_SHARE = 0.75;
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
 * me; issue #60). All or nothing: one visible territory over it blocks the pressure on all.
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
  /**
   * I hold an Order Priority card I could play this turn: when a commander strike is planned
   * and my commander's territory is threatened, `cardAdvice` says to play it (rule 1s).
   */
  holdsOrderPriority?: boolean;
  /**
   * Adapt to the game profile (rule 0p): with no `goal`, pick it from the profile (behind:
   * `defend`, else `balanced`) and apply the profile's rules. An explicit `goal` always wins
   * (the plan says the profile was overridden). Default `false`: the plan ignores the profile.
   */
  adapt?: boolean;
  /**
   * The least win chance an ordinary capture is sized for, 0.5–1. Default 1: today's
   * guaranteed sizing (`captureCost`). Below 1, each capture of a neutral or an enemy
   * territory sized for its current armies gets the fewest armies whose {@link winChance}
   * reaches it. Worst-case sizings (finishing a player off, fog pressure, commander strikes)
   * stay guaranteed.
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
}

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
   * The turn being planned, when known: `previousBoard` is then turn − 1's board, and the
   * observed-deploy rationale names the two turns.
   */
  turn?: number;
  settings?: PlannerSettings;
  options?: PlanOptions;
  /** The game around the board, for the profile (rule 0p). */
  game?: PlanGameContext;
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
}

const byNum = (a: number, b: number) => a - b;
/** A probability as a whole percent, for the rationale. */
const pct = (p: number) => `${Math.round(p * 1000) / 10}%`;

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
 * Armies to send at a territory held by `defenders`; `null` when it cannot be taken. With
 * `minWinChance` 1 (default) the guaranteed sizing: `armiesToTake` (0% luck, straight round)
 * plus the luck margin `ceil(cost / (1 − luck))`. Below 1, the fewest armies whose exact
 * {@link winChance} reaches it.
 */
export function captureCost(defenders: number, settings: PlannerSettings = {}, minWinChance = 1): number | null {
  if (minWinChance < 1) return armiesForChance(defenders, minWinChanceOf(minWinChance), combatSettings(settings));
  const base = armiesToTake(defenders, {
    offensiveKillRate: settings.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE,
    defensiveKillRate: settings.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE,
  });
  if (base === null) return null;
  const luck = luckFraction(settings.luckModifier);
  return luck > 0 ? Math.ceil(base / (1 - luck)) : base;
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

/** One visible opponent's estimated deploy next turn and how it was reached. */
export interface EnemyDeployEstimate {
  playerId: number;
  /** clamp(base + bonusIncome, max(MIN_ENEMY_DEPLOY, base), stackCap); that floor on the opening board. */
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
  /** Its largest visible stack next to one of my territories (else its largest visible stack). */
  largestStack: number;
  /** round(ENEMY_STACK_SHARE × largestStack). */
  stackCap: number;
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
   * The most it could earn on this board (issue #69): `base` plus every positive bonus it could
   * possibly hold (none of its territories visibly held by someone else, owner-only included);
   * `null` without a previous board.
   */
  observedCap: number | null;
  /** Which territories the observation counted and skipped; `null` without a previous board. */
  observation: DeployObservation | null;
  /** `'observed'` when the observed figure beat the visible-bonus one (and set the estimate). */
  source: 'visible' | 'observed';
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
function ownerShown(t: TerritoryState | undefined): TerritoryState | undefined {
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
  /** Its territories now that last turn's board did not show: fog reveals, never income. */
  reveals: number[];
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
 *   kill rate (`straightKills`, as in `armiesToTake`) — plus the armies now on it up to what its
 *   territories next to it, shown on both boards, visibly sent away (their total shrink, each
 *   army claimed by one capture only): those moved in from a visible source, whose shrink they
 *   cancel, so source shrink + destination gain nets to the attrition (issue #86). An unchanged
 *   visible neighbour sent nothing, so it explains nothing. The rest arrived from the fog when a
 *   neighbour was hidden on either board — a move, never income (`fromFog`), still a threat to
 *   the borders next to it; with every neighbour in view it can only be a deploy on the source.
 * Not counted: armies it lost on a territory it attacked but did not take. The defender's
 * count there also moves with the defender's own deploys and transfers (mine included —
 * this board says nothing about my orders), so the loss cannot be read off it; leaving it
 * out keeps the figure a lower bound (the failed attack's losses still shrink its source).
 * One turn only, not smoothed: the planner sees a single previous board. Transfers in from
 * (or out to) the fog still bias it — income in the fog is unseen anyway.
 */
export function observeDeploy(
  g: MapGraph,
  board: BoardState,
  previous: BoardState,
  playerId: number,
  rates: KillRates = {},
): DeployObservation {
  const before = new Map(previous.territories.map((t) => [t.territoryId, t]));
  let total = 0;
  const counted: number[] = [];
  const captured: number[] = [];
  const fromFog: number[] = [];
  const reveals: number[] = [];
  const now = new Map(board.territories.map((t) => [t.territoryId, t]));
  const defensive = rates.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  const mineBothTimes = (id: number) => {
    const a = visibleState(now.get(id));
    const b = visibleState(before.get(id));
    return a?.owner.kind === 'player' && a.owner.playerId === playerId && b?.owner.kind === 'player' && b.owner.playerId === playerId;
  };
  /**
   * What each of its territories shown with armies on both boards visibly sent away (its
   * shrink): the most a capture next to it can have received from it. A capture draws on it
   * (ascending ids), so two captures never both claim the same armies.
   */
  const shrinkLeft = new Map<number, number>();
  for (const t of board.territories)
    if (g.territoryById.has(t.territoryId) && mineBothTimes(t.territoryId))
      shrinkLeft.set(t.territoryId, Math.max(0, visibleState(before.get(t.territoryId))!.armies! - t.armies!));
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
    if (was.owner.kind === 'player' && was.owner.playerId === playerId) total += t.armies! - was.armies!;
    else {
      captured.push(t.territoryId);
      // What the capture cost it, always; the armies standing there only as far as a visible
      // source's shrink accounts for them (it cancels them). Beyond that, with a neighbour that
      // was hidden on either board, the rest arrived from the fog: a move, not income (#86).
      // With none, the rest can only be a deploy on a visible source before it attacked.
      total += straightKills(was.armies!, defensive);
      let arrived = t.armies!;
      const ns = [...neighborsOf(g, t.territoryId)].sort((a, b) => a - b);
      for (const n of ns) {
        const left = shrinkLeft.get(n);
        if (!left || !arrived) continue;
        const take = Math.min(left, arrived);
        shrinkLeft.set(n, left - take);
        arrived -= take;
        total += take;
      }
      if (arrived > 0 && ns.some(hidden)) fromFog.push(t.territoryId);
      else total += arrived;
    }
  }
  return { deploy: Math.max(0, total), counted, captured, fromFog, reveals };
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
  previous?: BoardState,
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
  const opening = openingArmies(g, board) !== null;
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
    const stackCap = Math.round(ENEMY_STACK_SHARE * largestStack);
    // Every opponent earns at least the game's base income (never below the 5 minimum).
    const floor = Math.max(MIN_ENEMY_DEPLOY, base);
    const visible = opening ? floor : Math.max(floor, Math.min(base + bonusIncome, stackCap));
    // What it was seen to deploy is never cut by the stack cap, only by what it could earn
    // (#69): its base plus every bonus none of whose territories someone else visibly holds
    // (an owner-only territory is visibly held: its owner shows). Both come from this board,
    // so a bonus it lost since last turn is out, though it may have paid for that deploy.
    const observation = previous ? observeDeploy(g, board, previous, playerId, settings) : null;
    let observedCap: number | null = null;
    if (observation) {
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
      observedCap = base + possible;
    }
    const observedRaw = observation?.deploy ?? null;
    const observed = observation ? Math.min(observation.deploy, observedCap!) : null;
    const source = observed !== null && observed > visible ? 'observed' : 'visible';
    const estimate = source === 'observed' ? observed! : visible;
    return {
      playerId,
      estimate,
      held,
      base,
      bonusIncome,
      largestStack,
      stackCap,
      opening,
      observed,
      observedRaw,
      observedCap,
      observation,
      source,
    };
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
  previous?: BoardState,
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
  return enemyDeployEstimates(g, board, me, settings, previous).reduce(
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
  /**
   * Its worth once complete (#70): its value plus the (negative) value of every other negative
   * bonus its missing members complete. Equal to `value` on a map without negative bonuses.
   */
  net: number;
}

export function planTurn(input: PlanInput): TurnPlan {
  const { graph: g, board, me } = input;
  const s = input.settings ?? {};
  const baseIncome = Math.max(0, Math.floor(s.baseIncome ?? DEFAULT_BASE_INCOME));
  const opts = input.options ?? {};
  const income = Math.max(0, Math.floor(input.income));
  const estimateList = enemyDeployEstimates(g, board, me, s, input.previousBoard);
  // ---- 0p. the game profile ----
  const ctx = input.game ?? {};
  const profile = gameProfile({
    graph: g,
    board,
    me,
    players: ctx.players ?? [],
    settings: {
      ...(s.luckModifier !== undefined ? { luckModifier: s.luckModifier } : {}),
      ...(s.roundingMode !== undefined ? { roundingMode: s.roundingMode } : {}),
      ...(ctx.cards !== undefined ? { cards: ctx.cards } : {}),
      ...(s.localDeployments !== undefined ? { localDeployments: s.localDeployments } : {}),
      ...(s.noSplit !== undefined ? { noSplit: s.noSplit } : {}),
      ...(ctx.commanders !== undefined ? { commanders: ctx.commanders } : {}),
      ...(ctx.fog !== undefined ? { fog: ctx.fog } : {}),
    },
    ...(ctx.turn !== undefined ? { turn: ctx.turn } : {}),
    ...(ctx.picking !== undefined ? { picking: ctx.picking } : {}),
    income,
    estimates: estimateList,
  });
  /** The profile picks the goal and tunes the scoring (rule 0p): adapting, with no explicit goal. */
  const auto = opts.adapt === true && opts.goal === undefined;
  const goal: PlanGoal = opts.goal ?? (auto && profile.standing === 'behind' ? 'defend' : 'balanced');
  const balanced = goal === 'balanced';
  /** Rule 0p.3: behind — defend first and size attacks at the minimum (no pressure margin). */
  const minimal = auto && profile.standing === 'behind';
  /** Rule 0p.3: ahead in a 1v1 — pressure allowed at {@link AHEAD_PRESSURE_FACTOR}. */
  const pressureFactor = auto && profile.format === '1v1' && profile.standing === 'ahead' ? AHEAD_PRESSURE_FACTOR : PRESSURE_FACTOR;
  /** The pressure margin over an estimated deploy: none when sizing at the minimum. */
  const marginFor = (d: number) => (minimal ? 0 : pressureMargin(d));
  /** Goals that refuse to complete a bonus they cannot hold (R3); the others only warn. */
  const guarded = balanced || goal === 'defend';
  const focus = new Set(opts.focusBonusIds ?? []);
  const reserve = Math.min(income, Math.max(0, Math.floor(opts.reserve ?? 0)));
  const custom = opts.enemyDeploy !== undefined;
  const enemyDeploy = custom
    ? Math.max(0, Math.floor(opts.enemyDeploy!))
    : defaultEnemyDeploy(g, board, me, s, input.previousBoard);
  const estimates = new Map(estimateList.map((e) => [e.playerId, e]));
  /** The deploy assumed for one opponent's threat: the override, else its own estimate. */
  const deployOf = (player: number) => (custom ? enemyDeploy : (estimates.get(player)?.estimate ?? MIN_ENEMY_DEPLOY));
  const guard = (s.oneArmyStandsGuard ?? true) ? 1 : 0;
  const rates = {
    offensiveKillRate: s.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE,
    defensiveKillRate: s.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE,
  };
  /** The exact combat model's settings (S2): kill rates, luck, rounding. */
  const combat = combatSettings(s);
  const chanceOf = (armies: number, defenders: number) => winChance(armies, defenders, combat);
  /** The least win chance an ordinary capture is sized for (S2). */
  const minWin = minWinChanceOf(opts.minWinChance);
  const costMemo = new Map<number, number | null>();
  /** An ordinary capture's size against `defenders`, at {@link minWin}. */
  const costOf = (defenders: number): number | null => {
    if (!costMemo.has(defenders)) costMemo.set(defenders, captureCost(defenders, s, minWin));
    return costMemo.get(defenders)!;
  };
  const warnings: string[] = [];
  const rationale: string[] = [];
  const profileText = `${profile.format}, ${profile.phase}, ${profile.standing}`;
  if (opts.adapt && opts.goal !== undefined)
    rationale.push(`Goal ${goal} was given explicitly, so it overrides the game profile (${profileText}): none of the profile's rules apply.`);
  else if (auto) {
    const strongest = estimateList.reduce((m, e) => Math.max(m, e.estimate), 0);
    rationale.push(
      minimal
        ? `Goal defend from the game profile (${profileText}): behind on income (${income} against ~${strongest}), so defend first and size attacks at the minimum (no extra margin beyond what the rules require).`
        : `Goal balanced from the game profile (${profileText}): the base goal.`,
    );
    if (pressureFactor !== PRESSURE_FACTOR)
      rationale.push(
        `Ahead in a 1v1 (${income} against ~${strongest}): keep attacking — pressure on an opponent next to the fog is allowed when each capture costs up to ${pressureFactor}× a typical neutral capture (instead of ${PRESSURE_FACTOR}×).`,
      );
  }

  const state = new Map<number, TerritoryState>();
  for (const t of board.territories) if (g.territoryById.has(t.territoryId)) state.set(t.territoryId, t);
  const label = (id: number) => `${g.territoryById.get(id)!.name} (#${id})`;
  const isMine = (id: number) => {
    const o = state.get(id)?.owner;
    return o?.kind === 'player' && o.playerId === me;
  };
  const mine = [...state.keys()].filter(isMine).sort(byNum);
  const mineSet = new Set(mine);
  // Next turn's income (#85): this turn's, less its card armies, moved by what the one income rule
  // ({@link boardIncome}) says the holdings `after` change — bonuses completed (negative ones
  // too), per-territory armies, the floor at 0.
  const incomeRulesNow = { base: baseIncome, per: s.bonusArmyPer ?? 0 };
  const boardIncomeNow = boardIncome(g, mineSet, incomeRulesNow).total;
  const cardArmies = Math.max(0, Math.floor(input.cardArmies ?? 0));
  const incomeAfter = (after: ReadonlySet<number>) =>
    Math.max(0, income - cardArmies + boardIncome(g, after, incomeRulesNow).total - boardIncomeNow);
  const armiesOf = (id: number) => state.get(id)?.armies ?? 0;
  /** The armies the special units on `id` fight as (a commander: {@link COMMANDER_STRENGTH}). */
  const unitsAt = (id: number) => specialUnitStrength(state.get(id)?.specialUnits);
  /** What a territory defends as now: its armies plus its special units. */
  const defenceAt = (id: number) => armiesOf(id) + unitsAt(id);
  /** My territories where my own commander stands: must-hold (rule 1k). */
  const myCommanders = new Set(
    mine.filter((id) => (state.get(id)?.specialUnits ?? []).some((u) => u.kind === 'commander' && u.playerId === me)),
  );

  if (!board.verified)
    warnings.push('Board state comes from an unverified parser of the GameFeed standing; check it against the game.');
  const luck = luckFraction(s.luckModifier);
  const weightedRounding = s.roundingMode !== undefined && s.roundingMode !== 'StraightRound';
  if (luck > 0)
    warnings.push(
      minWin < 1
        ? `Luck is ${Math.round(luck * 100)}%: each capture is sized for at least a ${Math.round(minWin * 100)}% win chance (min_win_chance), so it can fail; each attack's winChance says how likely it is.`
        : `Luck is ${Math.round(luck * 100)}%: each attack carries a margin (armies = ceil(cost / (1 − luck))) so the luck-free share alone takes it${weightedRounding ? '' : ' (win chance 1 under straight rounding)'}; each attack's winChance says how likely it is.`,
    );
  if (s.offensiveKillRate === undefined || s.defensiveKillRate === undefined)
    warnings.push(
      `Kill rates missing from the game settings; assuming ${rates.offensiveKillRate}% offense, ${rates.defensiveKillRate}% defense.`,
    );
  if (s.roundingMode !== undefined && s.roundingMode !== 'StraightRound')
    warnings.push(
      `Capture costs assume straight rounding; this game uses ${s.roundingMode}: each attack's winChance is computed under it (an attack can fail).`,
    );
  if (minWin < 1)
    rationale.push(
      `Captures are sized for at least a ${Math.round(minWin * 100)}% win chance (min_win_chance), not a guaranteed take: each gets the fewest armies whose exact win chance reaches it. Attacks sized for a worst case (finishing a player off, fog pressure, commander strikes) stay guaranteed.`,
    );
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
      goal,
      profile,
      deploys: [],
      moves: [],
      expected: { captures: [], bonusesCompleted: [], nextIncome: Math.max(0, income - cardArmies) },
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

  // ---- income change (#70): the one computation nextIncome, R3 and the negative-bonus rules use ----
  const bonusTs = new Map(g.map.bonuses.map((b) => [b.id, bonusTerritories(g, b.id)]));
  /** Bonuses complete over `after` that were not complete at the start of the turn, sorted by id. */
  const completedBy = (after: ReadonlySet<number>): number[] =>
    g.map.bonuses
      .filter((b) => {
        const ts = bonusTs.get(b.id)!;
        return ts.length > 0 && ts.every((t) => after.has(t)) && !ts.every((t) => mineSet.has(t));
      })
      .map((b) => b.id)
      .sort(byNum);
  /**
   * The exact income change from holding `after` instead of what I held at the start: the sum
   * of every bonus whose completion status changes (negative ones and superbonuses included).
   */
  const incomeGain = (after: ReadonlySet<number>): number =>
    completedBy(after).reduce((sum, id) => sum + g.bonusById.get(id)!.value, 0);
  const heldNow = () => new Set([...mine, ...captured]);
  /** The income change of also capturing `ts`, on top of this turn's captures so far. */
  const gainWith = (ts: readonly number[]): number => {
    const now = heldNow();
    return incomeGain(new Set([...now, ...ts])) - incomeGain(now);
  };
  /** `t` is in a bonus the caller focused: the negative-bonus rules never refuse it. */
  const inFocus = (t: number) => [...focus].some((id) => bonusTs.get(id)?.includes(t));
  /** Every capture planned, in the order it was made (a rolled-back one may repeat; filter by `captured`). */
  const captureOrder: number[] = [];
  /** How to take back each capture's attacks (rule 4c's guard), by target. */
  const captureUndo = new Map<number, () => void>();
  /** Captures that stage a positive bonus under rule 4c(c), with the bonus they stage. */
  const staged = new Map<number, number>();
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
  const undeploy = (id: number, n: number) => {
    const d = (deployed.get(id) ?? 0) - n;
    if (d > 0) deployed.set(id, d);
    else deployed.delete(id);
    avail.set(id, avail.get(id)! - n);
    budget += n;
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
      // Visible both times (#69): a stack hidden last turn only came into view.
      const was = visibleState(before.get(id));
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
      // An enemy commander can join the attack: it fights as COMMANDER_STRENGTH armies.
      p.movable += Math.max(0, st.armies - guard) + unitsAt(n);
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
  /**
   * The expected (not worst-case) attack on my `t` next turn (issue #59): per player, its
   * movable armies next to `t` plus its deploy estimate — no trend projection. 0 with none.
   */
  const expectedAt = (t: number): number => {
    const byPlayer = new Map<number, number>();
    for (const n of neighborsOf(g, t)) {
      const st = state.get(n);
      if (captured.has(n) || st?.owner.kind !== 'player' || st.owner.playerId === me || st.armies === null) continue;
      byPlayer.set(st.owner.playerId, (byPlayer.get(st.owner.playerId) ?? 0) + Math.max(0, st.armies - guard));
    }
    return Math.max(0, ...[...byPlayer].map(([p, movable]) => movable + deployOf(p)));
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
      // My commander defends with the armies on my territory (a capture's units were the enemy's).
      const have = stays(m) + (mineSet.has(m) ? unitsAt(m) : 0);
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
      // An enemy commander can join the attack: it fights as COMMANDER_STRENGTH armies.
      p.movable += Math.max(0, st.armies - guard) + unitsAt(n);
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
        const visible = `base ${e.base} + visible bonuses +${e.bonusIncome} = ${e.base + e.bonusIncome}`;
        if (e.observation) {
          const o = e.observation;
          const turns = input.turn !== undefined ? `turn ${input.turn - 1} → turn ${input.turn}` : 'previous board → this board';
          const shown = o.reveals.slice(0, MAX_NAMED_REVEALS).map(label).join(', ');
          const more = o.reveals.length > MAX_NAMED_REVEALS ? ` and ${o.reveals.length - MAX_NAMED_REVEALS} more` : '';
          rationale.push(
            `Observed deploy for player ${p}, ${turns}: +${e.observedRaw}/turn over ${o.counted.length} territories visible on both boards (${o.captured.length} captured${o.captured.length ? `, ${o.fromFog.length} from the fog` : ''}); ${o.reveals.length} skipped as fog reveals${o.reveals.length ? ` (${shown}${more}): not shown with an owner and armies last turn (fogged, armies hidden, or not yet picked), so what they hold is not income` : ''}.`,
          );
          // A stack that arrived from the fog by a capture is a threat, never income (#86).
          for (const id of o.fromFog) {
            const where = neighborsOf(g, id).some((n) => mineSet.has(n)) ? 'stack next to you' : 'stack';
            rationale.push(
              `Player ${p}'s ${where}: ${armiesOf(id)} on ${label(id)} (threat), arrived from the fog by a capture: a move, not income.`,
            );
          }
          if (o.fromFog.length) {
            const n = o.fromFog.length;
            rationale.push(
              `Player ${p}'s estimated income: ~${e.estimate}/turn (${n} ${n === 1 ? 'stack' : 'stacks'} that arrived from the fog not counted in it).`,
            );
          }
          if (e.observedRaw! > e.observedCap!)
            warnings.push(
              `player ${p} was observed to deploy +${e.observedRaw}/turn, more than it could earn on this board (base ${e.base} for its ${e.held} visible territories + bonuses it could still hold +${e.observedCap! - e.base} = ${e.observedCap}): capped at ${e.observedCap}. Armies moved in from the fog, a Reinforcement card, or a bonus it has lost since may explain the rest.`,
            );
        }
        if (e.source === 'observed') {
          warnings.push(
            `Enemy deploy estimate for player ${p}: ~${e.estimate} (observed +${e.observed}/turn: the net growth of its territories visible on both boards plus what its captures from a visible owner cost it, more than ${visible}; the stack cap does not cut an observed figure); it holds income the fog hides, and could deploy more.`,
          );
          continue;
        }
        const seen = e.observed !== null ? ` Its deploy was observed +${e.observed}/turn since last turn, below that.` : '';
        warnings.push(
          (opening !== null
            ? `Enemy deploy estimate for player ${p}: ~${e.estimate} (opening board: every visible territory holds ${opening}, so no one has deployed yet and every opponent gets its base income, at least ${MIN_ENEMY_DEPLOY}); enemy income is unknown, so they could deploy more.`
            : `Enemy deploy estimate for player ${p}: ~${e.estimate} (${visible}, at least max(${MIN_ENEMY_DEPLOY}, base) and at most ${ENEMY_STACK_SHARE * 100}% of its largest stack next to me (${e.largestStack}) = ${e.stackCap}); enemy income beyond its visible bonuses is unknown, so they could deploy more.`) + seen,
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
    /** The armies my special units there fight as (my commander: {@link COMMANDER_STRENGTH}); they never move. */
    units: number;
    /** My commander stands here: must-hold (rule 1k), never conceded. */
    critical?: true;
  }
  const threatened: Threatened[] = [];
  /** Armies that stay on my `id` after this turn's deploys, outgoing moves and incoming withdrawals so far. */
  const stayAt = (id: number) => avail.get(id)! + guard + (incoming.get(id) ?? 0);
  /**
   * Armies (in `avail` terms) that must stay on my `x` for it to hold against the visible
   * threat next to it (its special units counted; the territories `gone` says fall this turn
   * left out: once taken they threaten nothing); 0 with no enemy next to it. When it cannot
   * hold on what it has: everything on my commander's territory (rule 1k: nothing leaves it),
   * else everything only if `room` deploys would make it hold, and nothing otherwise (triage
   * would concede it, so keeping its armies home saves nothing).
   */
  const keepFor = (x: number, gone: (n: number) => boolean, room = Infinity) => {
    const a = avail.get(x)!;
    const b = borderAt(x, (n) => captured.has(n) || gone(n));
    if (!b) return 0;
    const need = Math.max(0, holdArmies(b.threat) - unitsAt(x));
    const short = need - stayAt(x);
    if (short > room && !myCommanders.has(x)) return 0;
    return a - Math.max(0, Math.min(a, -short));
  };
  /**
   * Fill `threatened` from `borders`, judging each by the armies that stay on it (its
   * armies at the start of the turn unless a finishing-off attack already left).
   */
  const assessThreats = () => {
    for (const b of borders.values()) {
      const have = stayAt(b.id);
      const units = unitsAt(b.id);
      const take = armiesToTake(have + units, rates);
      if (take === null || take > b.threat) continue;
      warnings.push(
        `${label(b.id)} (${have} armies${units ? ' and my commander' : ''}) could be taken next turn: player ${b.player} has ${b.movable} movable armies next to it plus ~${b.growth > b.deploy ? `${b.growth} (its growth per turn)` : `${b.deploy} deploy`}, and ${take} would do.`,
      );
      // armiesToTake grows at least one army per ~(100 / offensive kill rate) defenders, so this ends.
      let d = 1;
      while ((armiesToTake(have + units + d, rates) ?? Infinity) <= b.threat) d++;
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
        units,
        ...(myCommanders.has(b.id) ? { critical: true as const } : {}),
      });
    }
    threatened.sort(
      (a, b) =>
        Number(b.critical === true) - Number(a.critical === true) ||
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
  /** Said only once its hold is actually deployed. */
  const noteRecent = (t: Threatened) => {
    if (t.recentFrom !== undefined)
      rationale.push(
        `${label(t.id)} was captured from player ${t.recentFrom} last turn, and that opponent is weak: it is not conceded economically (conceding hands it back for free).`,
      );
  };
  /** What stays on a held border, for the rationale: its armies, and my commander when it stands there. */
  const heldStack = (t: Threatened) => `${t.have + t.holdCost} armies${t.units ? ' and my commander' : ''}`;
  /** The borders a hold deployed to, by the player threatening them (for the #69 rationale). */
  const heldAgainst = new Map<number, Set<number>>();
  const hold = (t: Threatened) => {
    noteRecent(t);
    deploy(t.id, t.holdCost);
    locked.add(t.id);
    const by = borders.get(t.id)?.player;
    if (by !== undefined) heldAgainst.set(by, (heldAgainst.get(by) ?? new Set()).add(t.id));
    rationale.push(
      `Deploy ${t.holdCost} to ${label(t.id)} so it holds (protects +${t.value}): ${heldStack(t)} need ${armiesToTake(t.have + t.units + t.holdCost, rates)} to take, above the ~${t.threat} threat.`,
    );
  };
  // ---- 1h. held-bonus units (#51) ----
  // Every bonus I hold in full with a threatened border is one unit: all its threatened
  // borders are held, or none (holding some while conceding another breaks it anyway).
  interface Unit {
    bonusId: number;
    value: number;
    members: Threatened[];
    /** Sum of its members' hold costs (a border shared with another unit counted in both). */
    cost: number;
    /** Its value plus the armies its holds save, in income terms. */
    worth: number;
    /** Why it does not pay for itself, if it does not (see {@link UnitLoss}). */
    loss: 'payback' | 'factor' | null;
    conceded: boolean;
  }
  const units: Unit[] = [];
  /** Borders a funded unit (or an individual hold) already holds. */
  const heldBorders = new Set<number>();
  /** My commander's borders whose whole hold rule 1k deployed. */
  const commanderHeld = new Set<number>();
  const buildUnits = () => {
    for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
      const ts = bonusTerritories(g, b.id);
      if (b.value <= 0 || !ts.length || !ts.every((x) => holdings.has(x))) continue;
      const members = threatened.filter((t) => ts.includes(t.id)).sort((x, y) => x.id - y.id);
      if (!members.length) continue;
      // My commander's border, once its hold is funded (rule 1k), is held whatever it costs: a
      // sunk cost the unit no longer pays, and a stack it no longer saves, so it is left out of
      // the unit's cost and its payback test. A hold rule 1k could not fully fund still counts.
      const paying = members.filter((m) => !commanderHeld.has(m.id));
      const cost = paying.reduce((n, m) => n + m.holdCost, 0);
      const worth = b.value + paying.reduce((n, m) => n + m.have / PAYBACK_TURNS, 0);
      // It pays back within PAYBACK_TURNS, and (as rule 1a asks of every border) costs at
      // most CONCEDE_FACTOR × its worth, unless a member was just taken from a weak opponent.
      const recent = members.some((m) => m.recentFrom !== undefined);
      units.push({
        bonusId: b.id,
        value: b.value,
        members,
        cost,
        worth,
        loss: cost > PAYBACK_TURNS * b.value ? 'payback' : !recent && cost > CONCEDE_FACTOR * worth ? 'factor' : null,
        conceded: false,
      });
    }
  };
  /** A threatened border still owned by a unit not conceded (it is held or conceded with it). */
  const inLiveUnit = (id: number) => units.some((u) => !u.conceded && u.members.some((m) => m.id === id));
  /** `t` judged on its own: its protected value less the bonuses of the units conceded with it. */
  const residual = (t: Threatened): Threatened => {
    const lost = units.filter((u) => u.conceded && u.members.some((m) => m.id === t.id)).reduce((n, u) => n + u.value, 0);
    const value = Math.max(0, t.value - lost);
    return { ...t, value, worth: value + t.have / PAYBACK_TURNS };
  };
  const unitBorders = (u: Unit) =>
    `${u.members.length} threatened border${u.members.length === 1 ? '' : 's'}`;
  /** Why a unit is conceded: it does not pay for itself, or the armies left cannot cover it. */
  type UnitLoss = { economic: 'payback' | 'factor' } | { economic: false; left: number };
  /**
   * Concede `u` as a whole, then judge each of its members no other live unit owns on its
   * own merits (`single`, quietly: other bonuses, per-territory income, the stack it saves).
   * One warning: rule 1a's for a one-border unit that stays conceded (so it names the full
   * value it protects), else "conceding <bonus>: holding all N borders needs X, …".
   */
  const concedeUnit = (u: Unit, loss: UnitLoss, single: (t: Threatened, quiet: boolean) => void) => {
    u.conceded = true;
    for (const m of u.members) if (!heldBorders.has(m.id) && !inLiveUnit(m.id)) single(residual(m), true);
    const [only] = u.members;
    if (u.members.length === 1) {
      if (conceded.has(only!.id) && !heldBorders.has(only!.id))
        warnings.push(
          loss.economic
            ? `${label(only!.id)} cannot be held economically (needs ${only!.holdCost}, protects +${only!.value}): conceded`
            : `${label(only!.id)} cannot be held with the ${loss.left} armies left to deploy (needs ${only!.holdCost}, protects +${only!.value}): conceded`,
        );
      return;
    }
    const why =
      loss.economic === false
        ? `more than the ${loss.left} armies left to deploy`
        : loss.economic === 'payback'
          ? `more than it pays back in ${PAYBACK_TURNS} turns (${PAYBACK_TURNS} × +${u.value} = ${PAYBACK_TURNS * u.value})`
          : `more than ${CONCEDE_FACTOR} × its worth (~${Math.round(u.worth * 10) / 10})`;
    warnings.push(
      `conceding bonus ${bonusName(u.bonusId)} (+${u.value}): holding all ${u.members.length} threatened borders (${u.members.map((m) => label(m.id)).join(', ')}) needs ${u.cost}, ${why}`,
    );
  };
  /** The armies `u` may still deploy, for its warning: a one-border unit's room (pools respected). */
  const leftFor = (u: Unit) => (u.members.length === 1 ? roomAt(u.members[0]!.id) : budget);
  /**
   * Deploy every hold of `u` not yet funded, or nothing: false when they do not all fit.
   * `each` may take over one member's hold (attacking on top of it), given the deploys
   * the members after it still need; it returns false to leave it a plain hold.
   */
  const fundUnit = (u: Unit, each?: (m: Threatened, rest: number) => boolean): boolean => {
    // A commander border rule 1k could not fully hold is still owed (it cannot be deployed to further).
    const todo = u.members.filter((m) => !heldBorders.has(m.id) || (m.critical && !commanderHeld.has(m.id)));
    const cost = todo.reduce((n, m) => n + m.holdCost, 0);
    if (cost > budget) return false;
    if (local) {
      // Pools: each hold must fit its own territory's room, the earlier ones deployed.
      const done: Threatened[] = [];
      for (const m of todo) {
        if (m.holdCost > roomAt(m.id)) {
          for (const d of done) undeploy(d.id, d.holdCost);
          return false;
        }
        deploy(m.id, m.holdCost);
        done.push(m);
      }
      for (const d of done) undeploy(d.id, d.holdCost);
    }
    const one = u.members.length === 1;
    // What this unit deploys itself: a border another unit already holds costs it nothing.
    const needs = !todo.length
      ? u.members.every((m) => commanderHeld.has(m.id))
        ? `${one ? 'is' : 'are'} already held for my commander`
        : `${one ? 'is' : 'are'} already held for another bonus`
      : cost < u.cost
        ? `need${one ? 's' : ''} ${cost} more (${u.cost - cost} already deployed for another bonus)`
        : `need${one ? 's' : ''} ${cost} in all`;
    rationale.push(
      `Hold bonus ${bonusName(u.bonusId)} (+${u.value}) whole: its ${unitBorders(u)} ${needs} (it pays back within ${PAYBACK_TURNS} turns), before any capture that completes no bonus.`,
    );
    let rest = cost;
    for (const m of todo) {
      rest -= m.holdCost;
      if (!each?.(m, rest)) hold(m);
      heldBorders.add(m.id);
    }
    return true;
  };
  /**
   * Rule 1h near miss (issue #59), when {@link fundUnit} cannot cover `u`: give each of its
   * borders not yet held what may still be deployed there, up to its hold cost (pools
   * respected). It is kept — those deploys stay, nothing is withdrawn — when the total is
   * short by at most {@link nearMissMargin} of the need, or when every short border still
   * holds against the expected attack ({@link expectedAt}: movable + deploy estimate, not the
   * trend's worst case). Otherwise every deploy is rolled back: false.
   */
  const fundNearMiss = (u: Unit): boolean => {
    const todo = u.members.filter((m) => !heldBorders.has(m.id));
    if (!todo.length) return false;
    const given = todo.map((m) => {
      const n = Math.max(0, Math.min(m.holdCost, roomAt(m.id)));
      deploy(m.id, n);
      return { m, n };
    });
    const need = todo.reduce((n, m) => n + m.holdCost, 0);
    const total = given.reduce((n, x) => n + x.n, 0);
    const short = need - total;
    const margin = nearMissMargin(need);
    const shortOnes = given.filter((x) => x.n < x.m.holdCost);
    const holdsExpected = shortOnes.every(
      (x) => (armiesToTake(x.m.have + x.n, rates) ?? Infinity) > expectedAt(x.m.id),
    );
    if (short > margin && !holdsExpected) {
      for (const x of given) if (x.n > 0) undeploy(x.m.id, x.n);
      return false;
    }
    const expected = Math.max(...shortOnes.map((x) => expectedAt(x.m.id)));
    const why =
      short <= margin
        ? `short by ${short}, within the near-miss margin of ${Math.round(margin * 10) / 10}`
        : `enough to hold against the expected ~${expected} attack (movable + deploy estimate), not the worst case`;
    const one = todo.length === 1;
    warnings.push(
      `Bonus ${bonusName(u.bonusId)} (+${u.value}) is held though short: its ${todo.length} threatened border${one ? '' : 's'} need${one ? 's' : ''} ${need}, only ${total} left to deploy, so ${total ? `all ${total} go there` : 'its armies stay'} (${why}); ${shortOnes.map((x) => label(x.m.id)).join(', ')} may fall.`,
    );
    for (const { m, n } of given) {
      noteRecent(m);
      locked.add(m.id);
      heldBorders.add(m.id);
      rationale.push(
        n > 0
          ? `Deploy ${n} to ${label(m.id)} so bonus ${bonusName(u.bonusId)} (+${u.value}) is not conceded: ${m.have + n} armies need ${armiesToTake(m.have + n, rates)} to take, against the ~${m.threat} threat (its armies stay: withdrawing them would guarantee the loss).`
          : `Keep the armies on ${label(m.id)} so bonus ${bonusName(u.bonusId)} (+${u.value}) is not conceded: ${m.have} armies need ${armiesToTake(m.have, rates)} to take, against the ~${m.threat} threat.`,
      );
    }
    return true;
  };

  // Under `balanced`, holds worth paying for compete with expansion in the greedy step below.
  const holds: Threatened[] = [];
  const triage = () => {
    // ---- 1k. my commander's border is must-hold (#61) ----
    // Losing the commander eliminates me: its border is never conceded, and it is held
    // first, under every goal. When the hold does not fit, everything left that may be
    // deployed there goes there, and nothing leaves it.
    for (const t of threatened) {
      if (!t.critical) continue;
      heldBorders.add(t.id);
      locked.add(t.id);
      const room = roomAt(t.id);
      if (t.holdCost <= room) {
        deploy(t.id, t.holdCost);
        commanderHeld.add(t.id);
        rationale.push(
          `Deploy ${t.holdCost} to ${label(t.id)}: my commander stands there, so it must hold (losing the commander eliminates me): ${heldStack(t)} need ${armiesToTake(t.have + t.units + t.holdCost, rates)} to take, above the ~${t.threat} threat.`,
        );
        continue;
      }
      deploy(t.id, room);
      warnings.push(
        `My commander's territory ${label(t.id)} cannot be made safe this turn: it needs ${t.holdCost} more armies against the ~${t.threat} threat, but only ${room} can be deployed there. ${room ? `All ${room} go there, and` : 'Still,'} nothing leaves it (losing the commander eliminates me; it is never conceded).`,
      );
    }
    let triageBudget = budget;
    buildUnits();
    if (goal === 'expand')
      for (const u of units)
        if (!u.loss)
          warnings.push(
            `goal expand does not defend held bonus ${bonusName(u.bonusId)} (+${u.value}) first: holding its ${unitBorders(u)} needs ${u.cost} (it pays back within ${PAYBACK_TURNS} turns).`,
          );
    if (!guarded) units.length = 0;
    /** The per-border triage of rule 1a. */
    const single = (t: Threatened, quiet = false) => {
      // My commander's border is already held (rule 1k).
      if (t.critical) return;
      const left = Math.min(acting ? budget : triageBudget, local ? roomAt(t.id) : Infinity);
      if (t.recentFrom === undefined && t.holdCost > CONCEDE_FACTOR * t.worth) {
        conceded.add(t.id);
        if (!quiet)
          warnings.push(`${label(t.id)} cannot be held economically (needs ${t.holdCost}, protects +${t.value}): conceded`);
        return;
      }
      if (balanced) {
        // Its armies stay put until the greedy step decides: holding assumes they are all there.
        holds.push(t);
        locked.add(t.id);
        return;
      }
      if (t.holdCost > left) {
        if (quiet) conceded.add(t.id);
        else concedeUnaffordable(t, left);
        return;
      }
      triageBudget -= t.holdCost;
      if (acting) {
        hold(t);
        heldBorders.add(t.id);
      }
    };
    for (const u of units) if (u.loss) concedeUnit(u, { economic: u.loss }, single);
    type Item = { unit: Unit } | { border: Threatened };
    const items: Item[] = [
      ...units.filter((u) => !u.conceded).map((unit) => ({ unit })),
      ...threatened.filter((t) => !units.some((u) => u.members.some((m) => m.id === t.id))).map((border) => ({ border })),
    ];
    if (!acting) {
      // Under `balanced` the units compete in the greedy step; their members stay put.
      for (const u of units) if (!u.conceded) for (const m of u.members) locked.add(m.id);
      for (const it of items) if ('border' in it) single(it.border);
      return;
    }
    // `defend`: units and single borders by worth per army (a recent capture first).
    const key = (it: Item) =>
      'unit' in it
        ? { recent: it.unit.members.some((m) => m.recentFrom !== undefined), ratio: it.unit.worth / it.unit.cost, cost: it.unit.cost, id: it.unit.members[0]!.id }
        : { recent: it.border.recentFrom !== undefined, ratio: it.border.worth / it.border.holdCost, cost: it.border.holdCost, id: it.border.id };
    items.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return Number(y.recent) - Number(x.recent) || y.ratio - x.ratio || x.cost - y.cost || x.id - y.id;
    });
    for (const it of items) {
      if ('border' in it) {
        if (!heldBorders.has(it.border.id) && !conceded.has(it.border.id)) single(it.border);
        continue;
      }
      if (!fundUnit(it.unit) && !fundNearMiss(it.unit))
        concedeUnit(it.unit, { economic: false, left: leftFor(it.unit) }, single);
    }
  };

  // ---- 1b. withdraw from conceded borders ----
  let cardAdvice: CardAdvice | null = null;
  // Armies withdrawn into each territory this turn (they stay there: armies never move twice).
  const incoming = new Map<number, number>();
  /** Conceded borders of a held bonus whose garrison stays (it holds against the expected attack). */
  const stood = new Set<number>();
  const withdraw = () => {
    if (!conceded.size) return;
    const withdrawals: PlannedMove[] = [];
    const keep = (id: number) => mineSet.has(id) && !conceded.has(id);
    // Borders that can hold: mine, not conceded, next to something not mine.
    const holding = mine.filter((id) => keep(id) && neighborsOf(g, id).some((n) => !mineSet.has(n)));
    for (const t of [...conceded].sort(byNum)) {
      const n = avail.get(t)!;
      if (n <= 0) continue;
      // Issue #59: a held bonus's border keeps its garrison while it still holds against the
      // expected attack — withdrawing it would guarantee the loss.
      const held = g.map.bonuses
        .filter((b) => {
          const ts = bonusTerritories(g, b.id);
          return b.value > 0 && ts.includes(t) && ts.every((x) => mineSet.has(x));
        })
        .sort((a, b) => a.id - b.id);
      const stays = stayAt(t);
      const take = armiesToTake(stays, rates) ?? Infinity;
      const expected = expectedAt(t);
      if (held.length && take > expected) {
        locked.add(t);
        stood.add(t);
        rationale.push(
          `Keep the ${n} movable armies on ${label(t)} (not withdrawn): it is a border of held bonus ${held.map((b) => bonusName(b.id)).join(', ')}, and its ${stays} armies need ${take} to take, above the expected ~${expected} attack (movable + deploy estimate).`,
        );
        continue;
      }
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
    const cost = costOf(defenceAt(t));
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
    // Cluster as a unit (#70): the negative bonuses its missing members complete come off its
    // worth (on a map without negative bonuses, net = value).
    const whole = new Set([...mine, ...remaining]);
    const penalties = completedBy(whole).filter((id) => id !== b.id && g.bonusById.get(id)!.value < 0);
    const penalty = penalties.reduce((n, id) => n + g.bonusById.get(id)!.value, 0);
    const net = b.value + penalty;
    if (penalty < 0 && remaining.some(bonusTarget))
      rationale.push(
        `Bonus ${b.name} (#${b.id}) (+${b.value}) is worth +${net} net once complete: its missing members also complete ${penalties.length} negative bonus${penalties.length === 1 ? '' : 'es'} (${penalty}), and each step short of completion only adds penalties.`,
      );
    if (net <= 0 && !isFocus) {
      for (const t of remaining) uneconomicMember.add(t);
      if (remaining.some(bonusTarget))
        rationale.push(`Skip bonus ${b.name} (#${b.id}): completing it costs more income than it pays (net ${net}).`);
      continue;
    }
    let cost = 0;
    let worst = 0;
    for (const t of remaining) {
      const st = state.get(t);
      if (!st || st.owner.kind === 'unknown' || st.armies === null) continue;
      const c = costOf(defenceAt(t)) ?? Infinity;
      cost += c;
      worst = Math.max(worst, c);
    }
    const economic = isFocus || (cost <= PAYBACK_TURNS * net && worst <= WASTELAND_FACTOR * net);
    for (const t of remaining) (economic ? economicMember : uneconomicMember).add(t);
    if (!remaining.some(bonusTarget)) continue;
    if (!economic) {
      rationale.push(
        `Skip bonus ${b.name} (#${b.id}): uneconomic for +${net === b.value ? b.value : `${b.value} (net +${net})`} (${cost} armies to finish, ${worst} for its costliest territory).`,
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
        return c - straightKills(defenceAt(m), rates.defensiveKillRate);
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
      net,
    });
  }
  const ratio = (p: BonusPlan) => {
    const cost = p.cost + DEFENSE_DISCOUNT * p.defenseCost;
    return cost > 0 ? p.net / cost : Infinity;
  };
  plans.sort(
    (a, b) =>
      Number(b.focus) - Number(a.focus) || ratio(b) - ratio(a) || a.borders - b.borders || a.bonusId - b.bonusId,
  );
  const bonusName = (id: number) => `${g.bonusById.get(id)!.name} (#${id})`;
  /**
   * A break's retake check, by its target: the warning it raised (if any) and what it was
   * judged on, so a top-up that adds survivors re-judges it.
   */
  const retakeChecks = new Map<number, { bonusId: number; survivors: number; counter: number; warning?: string }>();
  const retakeWarning = (t: number, bonusId: number, survivors: number, counter: number): string | undefined => {
    const take = armiesToTake(survivors, rates);
    return take !== null && take <= counter
      ? `${label(t)} can be retaken after it breaks ${bonusName(bonusId)}: ${survivors} survivors need ${take} to take, against ~${counter} next turn.`
      : undefined;
  };

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
    const nextIncome = incomeAfter(after);
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
  /** Enemy commanders' territories attacked as a commander strike (rule 1s): exempt from R3. */
  const strikes = new Set<number>();
  /**
   * Defenders assumed at a target attacked to finish its owner off: its armies plus that
   * owner's full deploy estimate (the worst case). Other targets: their armies now.
   */
  const worstCase = new Map<number, number>();
  const defendersAt = (t: number) => worstCase.get(t) ?? defenceAt(t);
  /**
   * Capture `t` from its best source. A conceded border is never deployed to: it attacks
   * out only with the armies already on it (unless every territory I hold is conceded,
   * when there is nowhere better). `force` names the source (it may be locked) and the
   * armies on it that stay out of the attack.
   */
  const tryCapture = (t: number, reason: string, force?: { from: number; keep: number }): boolean => {
    const tg = targets.get(t)!;
    // My commander's territory keeps what holds it (rule 1k).
    const spare = (x: number) => avail.get(x)! - (force?.keep ?? (myCommanders.has(x) ? keepFor(x, (n) => n === t) : 0));
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
    const survivors = tg.cost - straightKills(defendersAt(t), rates.defensiveKillRate);
    // A commander strike is never refused by R3: killing the commander eliminates a player.
    if (!strikes.has(t) && !defensible(t, survivors)) {
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
    captureOrder.push(t);
    captureUndo.set(t, () => avail.set(src, avail.get(src)! + tg.cost));
    moves.push({ from: src, to: t, armies: tg.cost, kind: 'attack', reason, winChance: chanceOf(tg.cost, defenceAt(t)) });
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
    // A commander takes no partial damage, so softening one is not plain arithmetic: never combined.
    if (unitsAt(t) > 0) return null;
    const eligible = tg.sources
      .filter((x) => !locked.has(x) && !conceded.has(x) && !myCommanders.has(x) && avail.get(x)! > 0 && !orderOf(x))
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
        while (a > 0 && straightKills(a, off) >= Math.min(left, real)) a--;
        const kills = straightKills(a, off);
        if (a <= 0 || kills <= 0) continue;
        const lost = Math.min(a, straightKills(left, def));
        softeners.push({ from: x, armies: a, kills, before: left, survivors: a - lost });
        left -= kills;
        real -= kills;
      }
      if (!softeners.length) continue;
      const armies = armiesToTake(left, rates);
      if (armies === null) return null;
      const need = Math.max(0, armies - avail.get(finisher)!);
      if (need > spareAt(finisher)) continue;
      const survivors = armies - straightKills(left, def);
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
    captureOrder.push(t);
    captureUndo.set(t, () => {
      for (const x of plan.softeners) {
        avail.set(x.from, avail.get(x.from)! + x.armies);
        incoming.set(x.from, (incoming.get(x.from) ?? 0) - x.survivors);
      }
      avail.set(plan.finisher, avail.get(plan.finisher)! + plan.armies);
    });
    for (const x of plan.softeners)
      moves.push({
        from: x.from,
        to: t,
        armies: x.armies,
        kind: 'attack',
        reason: `wears ${label(t)} down for a combined capture (${reason})`,
        winChance: chanceOf(x.armies, x.before),
      });
    moves.push({
      from: plan.finisher,
      to: t,
      armies: plan.armies,
      kind: 'attack',
      reason,
      winChance: chanceOf(plan.armies, plan.left),
    });
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
  /** Snapshot the captures, deploys and notes so far; the result undoes everything since. */
  const snapshot = () => {
    const snap = {
      budget,
      anchor,
      deployed: new Map(deployed),
      avail: new Map(avail),
      incoming: new Map(incoming),
      combined: new Set(combined),
      survivorsAt: new Map(survivorsAt),
      staged: new Map(staged),
      captureOrder: captureOrder.length,
      moves: moves.length,
      rationale: rationale.length,
      warnings: warnings.length,
    };
    return () => {
      budget = snap.budget;
      anchor = snap.anchor;
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
      staged.clear();
      for (const [k, v] of snap.staged) staged.set(k, v);
      captureOrder.length = snap.captureOrder;
      rationale.length = snap.rationale;
      warnings.length = snap.warnings;
    };
  };
  const complete = (p: BonusPlan) => {
    if (!p.completable) return;
    const todo = p.remaining
      .filter((t) => !captured.has(t))
      .sort((a, b) => targets.get(a)!.cost - targets.get(b)!.cost || a - b);
    if (!todo.length) return;
    const first = moves.length;
    const restore = snapshot();
    const before = incomeGain(heldNow());
    const worth = p.net === p.value ? `+${p.value}` : `+${p.value}, net +${p.net}`;
    const ok = todo.every((t) => tryCapture(t, `completes bonus ${bonusName(p.bonusId)} (${worth})`));
    // Rule 4c: completing it must not lower income (its members' negative bonuses included).
    if (ok && !p.focus && incomeGain(heldNow()) < before) {
      const net = incomeGain(heldNow()) - before;
      restore();
      rationale.push(
        `Do not complete bonus ${bonusName(p.bonusId)} (${worth}): with this turn's other captures it changes income by ${net} (its members complete negative bonuses).`,
      );
      return;
    }
    if (ok) {
      anchor ??= moves[first]?.from;
      return;
    }
    restore();
  };

  // ---- pass 2: advance a bonus one capture at a time ----
  /** Bonuses whose staging was refused (rule 4c(c)), so the rationale says it once. */
  const unstaged = new Set<number>();
  /**
   * Rule 4c(c): capturing `t` toward `p` lowers income this turn. It is a staging step, taken
   * only when the bonus completes within PAYBACK_TURNS (k turns: its other missing members'
   * capture cost / the income left after this step, rounded up, at least 1; none left:
   * refused) and the penalties until then —
   * at most k × every penalty its missing members carry — are repaid by its net worth within
   * PAYBACK_TURNS turns of completion. Returns the capture's reason and rationale line, or
   * `null` when refused.
   */
  const stage = (p: BonusPlan, t: number): { reason: string; note: string } | null => {
    const rest = p.remaining.filter((x) => x !== t && !captured.has(x));
    let restCost = 0;
    for (const x of rest) {
      const st = state.get(x);
      restCost += !st || st.owner.kind === 'unknown' || st.armies === null ? Infinity : (captureCost(defenceAt(x), s) ?? Infinity);
    }
    const penalty = p.value - p.net;
    const step = gainWith([t]);
    // The income left once this step (and this turn's other captures) lands: the staging
    // capture itself lowers it, so the turns to finish are counted at that income (#70).
    const after = income + incomeGain(new Set([...heldNow(), t]));
    const turns = after > 0 ? Math.max(1, Math.ceil(restCost / after)) : Infinity;
    const interim = turns * penalty;
    if (turns <= PAYBACK_TURNS && interim <= PAYBACK_TURNS * p.net) {
      return {
        note: `Stage bonus ${bonusName(p.bonusId)} with ${label(t)} (${step} income until it completes): its other ${rest.length} missing member${rest.length === 1 ? '' : 's'} cost ${restCost}, ~${turns} turns at income ${after} (after this step); ${turns} turns × ${penalty} = ${interim} of penalties at most, repaid within ${PAYBACK_TURNS} turns of completion (${PAYBACK_TURNS} × +${p.net} = ${PAYBACK_TURNS * p.net}).`,
        reason: `stages bonus ${bonusName(p.bonusId)} (+${p.value}, net +${p.net} once complete; ${step} income until then)`,
      };
    }
    if (!unstaged.has(p.bonusId)) {
      unstaged.add(p.bonusId);
      rationale.push(
        `Do not take ${label(t)} toward bonus ${bonusName(p.bonusId)}: it costs ${step} income until the bonus completes, ${
          restCost === Infinity
            ? 'and the rest of the bonus cannot be costed (fog)'
            : `~${turns} turns away (${restCost} armies at income ${after} after this step); ${turns} × ${penalty} = ${interim} of penalties is not repaid by ${PAYBACK_TURNS} × +${p.net}`
        }.`,
      );
    }
    return null;
  };
  const advance = (p: BonusPlan) => {
    const todo = p.remaining
      .filter((t) => bonusTarget(t) && !captured.has(t))
      .sort((a, b) => targets.get(a)!.cost - targets.get(b)!.cost || a - b);
    for (const t of todo) {
      const stepping = !p.focus && gainWith([t]) < 0 ? stage(p, t) : undefined;
      if (stepping === null) continue;
      const reason = stepping?.reason ?? `advances bonus ${bonusName(p.bonusId)} (+${p.value}, ${p.cost} to finish)`;
      if (tryCapture(t, reason)) {
        anchor ??= moves[moves.length - 1]!.from;
        if (stepping) {
          staged.set(t, p.bonusId);
          rationale.push(stepping.note);
        }
      }
    }
  };

  // ---- 1e. finish off an opponent (#45) ----
  // Before any border is conceded: for each visible opponent whose every territory is
  // visible (none borders the fog) and borders mine — any such opponent, however strong,
  // fewest territories first — search the attack sizes on its territories against its best
  // response (its deploy estimate is one budget, spread to save as many as it can; see
  // `guaranteedFalls`). Kept when every territory falls (elimination), or when the falls it
  // cannot prevent leave it one territory or take at least half, no attacking border faces
  // a territory left unattacked, and every hold worth paying for against those is funded.
  // Visible enemy territories by owner, sorted.
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
  // Anything on the board hidden: an opponent may hold territories there no visible one borders.
  const fogAnywhere = [...g.territoryById.keys()].some(hidden);
  /** Its territories with a fogged neighbour: it may hold more in the fog. */
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
  /** The most defenders `armies` attackers take (capture cost, luck margin included). */
  const takesUpTo = (armies: number) => {
    let y = 0;
    while ((captureCost(y + 1, s) ?? Infinity) <= armies) y++;
    return y;
  };
  /** Everything a finish-off attempt may change, to restore it. */
  const checkpoint = (ts: readonly number[]) => ({
    budget,
    deployed: new Map(deployed),
    avail: new Map(avail),
    incoming: new Map(incoming),
    captured: new Set(captured),
    combined: new Set(combined),
    survivorsAt: new Map(survivorsAt),
    worstCase: new Map(worstCase),
    targets: new Map(ts.map((t) => [t, targets.get(t)] as const)),
    notCompleted: new Map(notCompleted),
    staged: new Map(staged),
    captureOrder: captureOrder.length,
    moves: moves.length,
    rationale: rationale.length,
    warnings: warnings.length,
  });
  const restore = (c: ReturnType<typeof checkpoint>) => {
    budget = c.budget;
    deployed.clear();
    for (const [k, v] of c.deployed) deployed.set(k, v);
    for (const [k, v] of c.avail) avail.set(k, v);
    incoming.clear();
    for (const [k, v] of c.incoming) incoming.set(k, v);
    captured.clear();
    for (const t of c.captured) captured.add(t);
    combined.clear();
    for (const t of c.combined) combined.add(t);
    survivorsAt.clear();
    for (const [k, v] of c.survivorsAt) survivorsAt.set(k, v);
    worstCase.clear();
    for (const [k, v] of c.worstCase) worstCase.set(k, v);
    for (const [t, tg] of c.targets) {
      if (tg) targets.set(t, tg);
      else targets.delete(t);
    }
    notCompleted.clear();
    for (const [k, v] of c.notCompleted) notCompleted.set(k, v);
    staged.clear();
    for (const [k, v] of c.staged) staged.set(k, v);
    captureOrder.length = c.captureOrder;
    moves.length = c.moves;
    rationale.length = c.rationale;
    warnings.length = c.warnings;
  };
  /** One sizing of the attacks: per target, the share of the deploy it is sized for, or SKIP. */
  const SKIP = -1;
  interface Attempt {
    sizes: number[];
    attacked: number[];
    /** Deploys player `p` must place on each attacked target to save it. */
    saveCost: number[];
    falls: number;
    all: boolean;
    armies: number;
    deploys: number;
    /** Success before the hold checks: eliminates, or leaves it one territory, or takes half. */
    enough: boolean;
    freed: boolean;
    unfunded: boolean;
    left: number[];
  }
  /**
   * Positive when `a` beats `b`: an elimination, then more sure falls, then fewer attacking
   * armies, then a dearer cheapest save (the opponent must commit more to save any one), then
   * fewer deploys. A tie keeps the first found (shares are tried from the full deploy down,
   * lowest territory id first), so the plan is deterministic.
   */
  const better = (a: Attempt, b: Attempt) =>
    Number(a.all) - Number(b.all) ||
    a.falls - b.falls ||
    b.armies - a.armies ||
    Math.min(...a.saveCost) - Math.min(...b.saveCost) ||
    b.deploys - a.deploys;
  /**
   * Plan the captures of player `p`'s territories against its best response. Committed
   * (true) when it eliminates `p`, or cuts it to one territory or takes at least half of it
   * with no attacking border facing what is left unattacked and every hold worth paying for
   * against that funded; otherwise rolled back. `probe`: always rolled back, true when an
   * elimination is affordable.
   */
  const finishOff = (p: number, probe: boolean, fogged: readonly number[] = []): boolean => {
    const ts = ownedBy.get(p)!;
    /** Next to the fog (#60): only taking every visible territory for sure counts, as pressure. */
    const pressure = fogged.length > 0;
    /** Its estimated deploy; under pressure, sized for with a margin over it (#60). */
    const estimateP = deployOf(p);
    const marginP = pressure ? marginFor(estimateP) : 0;
    const deployP = estimateP + marginP;
    const deployText = marginP ? `~${estimateP} deploy plus a margin of ${marginP}` : `~${deployP} deploy`;
    const start = checkpoint(ts);
    if (ts.some((t) => captureCost(defenceAt(t), s) === null)) return false;
    /**
     * Reserve the holds for an attempt that leaves `stay` unattacked. Holds against other
     * players (and against `stay`) worth paying for (rule 1a's CONCEDE_FACTOR test) come
     * first. A source keeps what holds it there. On a border that attacks nothing, each such
     * hold — best worth per army first, and only if it fits what is left — is deployed there
     * while the captures are sized, so neither the captures nor a Local Deployment pool can
     * spend that room; one that does not fit is left to triage.
     */
    const reserve = (stay: ReadonlySet<number>) => {
      const tried = ts.filter((t) => !stay.has(t));
      const sources = new Set(tried.flatMap((t) => neighborsOf(g, t).filter((n) => mineSet.has(n))));
      const keepAt = new Map<number, number>();
      const elsewhere: { x: number; cost: number; worth: number }[] = [];
      /** A hold's cost on my `x` against the threats left once `gone` fall, or null when not worth paying. */
      const holdCostAt = (x: number, gone: (n: number) => boolean) => {
        const rest = borderAt(x, gone);
        if (!rest) return null;
        // Armies that must stay: the hold less what my special units there fight as.
        const need = Math.max(0, holdArmies(rest.threat) - unitsAt(x));
        const cost = Math.max(0, need - armiesOf(x));
        const worth = valueOf(x) + armiesOf(x) / PAYBACK_TURNS;
        // My commander's border is always worth holding (rule 1k).
        return cost > CONCEDE_FACTOR * worth && !myCommanders.has(x) ? null : { need, cost, worth };
      };
      for (const x of mine) {
        const h = holdCostAt(x, (n) => ownerOf(n) === p && !stay.has(n));
        if (!h) continue;
        const { need, cost, worth } = h;
        if (sources.has(x)) {
          const keep = Math.max(0, need - guard);
          keepAt.set(x, keep);
          avail.set(x, avail.get(x)! - keep);
        } else if (cost > 0) elsewhere.push({ x, cost, worth });
      }
      /** The holds reserved, by border. */
      const funded = new Map<number, number>();
      elsewhere.sort((a, b) => b.worth / b.cost - a.worth / a.cost || a.cost - b.cost || a.x - b.x);
      for (const h of elsewhere) {
        if (h.cost > roomAt(h.x)) continue;
        deploy(h.x, h.cost);
        funded.set(h.x, h.cost);
      }
      const reserved = checkpoint(ts);
      const fullReason = `takes player ${p}'s territory, sized for its full ${deployText} landing there`;
      /** Size and plan the attacks for `sizes` (from `reserved`), and judge the result. */
      const attempt = (sizes: number[]): Attempt => {
        tried.forEach((t, i) => {
          const e = sizes[i]!;
          if (e === SKIP) return;
          worstCase.set(t, defenceAt(t) + e);
          targets.set(t, {
            id: t,
            cost: captureCost(defenceAt(t) + e, s)!,
            enemy: true,
            sources: neighborsOf(g, t).filter((n) => mineSet.has(n)),
          });
        });
        const order = tried
          .map((t, i) => ({ t, e: sizes[i]! }))
          .filter((x) => x.e !== SKIP)
          .sort((a, b) => targets.get(a.t)!.cost - targets.get(b.t)!.cost || a.t - b.t);
        const attacked = order
          .filter(({ t, e }) =>
            tryCapture(t, e >= deployP ? fullReason : `presses player ${p}: sized for ${e} of its ~${deployP} deploy landing there`),
          )
          .map((x) => x.t)
          .sort(byNum);
        const ours = moves.slice(reserved.moves).filter((m) => m.kind === 'attack');
        const saveCost = attacked.map((t) => {
          const at = ours.filter((m) => m.to === t);
          const finisher = at[at.length - 1]!;
          const kills = at
            .slice(0, -1)
            .reduce((n, m) => n + straightKills(m.armies, rates.offensiveKillRate), 0);
          return Math.max(0, kills + takesUpTo(finisher.armies) - defenceAt(t) + 1);
        });
        const falls = guaranteedFalls(saveCost, deployP);
        const all = falls === ts.length;
        const left = ts.filter((t) => !attacked.includes(t));
        const attackers = new Set(ours.map((m) => m.from));
        const freed = [...attackers].every((x) => !neighborsOf(g, x).some((n) => left.includes(n)));
        // What stays unattacked: a border that attacks nothing but faces it must still have its
        // hold funded, or the captures cost a border worth holding.
        const unfunded = ours.length
          ? mine.some((x) => {
              if (attackers.has(x) || !neighborsOf(g, x).some((n) => left.includes(n))) return false;
              const h = holdCostAt(x, (n) => captured.has(n));
              return h !== null && h.cost > (funded.get(x) ?? 0);
            })
          : false;
        return {
          sizes,
          attacked,
          saveCost,
          falls,
          all,
          armies: ours.reduce((n, m) => n + m.armies, 0),
          deploys: reserved.budget - budget,
          enough: falls > 0 && (all || ts.length - falls <= 1 || falls * 2 >= ts.length),
          freed,
          unfunded,
          left,
        };
      };
      // Every sizing, each target sized for 0..its full deploy share (or not attacked): exact
      // while there are few; otherwise evenly spaced shares, always including the full one.
      const LIMIT = 1024;
      let levels = deployP + 2;
      while (levels > 1 && levels ** tried.length > LIMIT) levels--;
      const spaced = Array.from({ length: Math.max(1, levels - 1) }, (_, i) =>
        Math.round(deployP - (i * deployP) / Math.max(1, levels - 2)),
      );
      const shares = levels >= 2 ? [...new Set(spaced), SKIP] : [deployP];
      /** Every sizing tried; the state is left as reserved. */
      const search = () => {
        let best: Attempt | null = null;
        let bestUnfunded: Attempt | null = null;
        let canEliminate = false;
        const sizes = tried.map(() => 0);
        const visit = (i: number) => {
          if (i === tried.length) {
            const a = attempt([...sizes]);
            restore(reserved);
            if (a.all) canEliminate = true;
            if (!a.enough || !a.freed || (pressure && !a.all)) return;
            if (a.unfunded) {
              if (!bestUnfunded || better(a, bestUnfunded) > 0) bestUnfunded = a;
            } else if (!best || better(a, best) > 0) best = a;
            return;
          }
          for (const e of shares) {
            sizes[i] = e;
            visit(i + 1);
          }
        };
        if (tried.length) visit(0);
        return { best: best as Attempt | null, bestUnfunded: bestUnfunded as Attempt | null, canEliminate };
      };
      /** Plan `chosen`, then release the reservations: the triage (or the greedy step) deploys the holds. */
      const commit = (chosen: Attempt) => {
        attempt(chosen.sizes);
        for (const [x, k] of keepAt) avail.set(x, avail.get(x)! + k);
        for (const [x, k] of funded) {
          const d = deployed.get(x)! - k;
          if (d) deployed.set(x, d);
          else deployed.delete(x);
          avail.set(x, avail.get(x)! - k);
          budget += k;
        }
      };
      return { search, commit };
    };
    const found = reserve(new Set()).search();
    restore(start);
    if (probe) return found.canEliminate;
    let chosen = found.best;
    let stay: ReadonlySet<number> = new Set();
    // A better attempt that left a hold facing what it left unattacked unfunded: once more,
    // with those holds reserved first and those territories left alone.
    const retry = found.bestUnfunded;
    if (retry && (!chosen || better(retry, chosen) > 0)) {
      const again = reserve(new Set(retry.left)).search();
      restore(start);
      if (again.best && (!chosen || better(again.best, chosen) > 0)) {
        chosen = again.best;
        stay = new Set(retry.left);
      }
    }
    if (!chosen) return false;
    reserve(stay).commit(chosen);
    const { attacked, falls, left } = chosen;
    // The territories left unattacked stay ordinary (non-worst-case) targets.
    for (const t of left) {
      worstCase.delete(t);
      const tg = start.targets.get(t);
      if (tg) targets.set(t, tg);
      else targets.delete(t);
    }
    const names = attacked.map(label).join(', ');
    const rest = left.length
      ? `; ${left.map(label).join(', ')} stay${left.length === 1 ? 's' : ''} unattacked, and no attacking border faces ${left.length === 1 ? 'it' : 'them'}`
      : '';
    if (chosen.all && pressure) {
      const edge = fogged.map(label).join(', ');
      rationale.push(
        `Pressure player ${p}: take all ${ts.length} of its visible territories (${names}) this turn, each sized for its full ${deployText} landing there; it may hold more in the fog (next to ${edge}), so this is not an elimination.`,
      );
      warnings.push(
        `Pressuring player ${p} assumes it deploys at most ~${deployP} (its ~${estimateP} estimate ${marginP ? `plus a margin of ${marginP}` : 'with no margin: behind, attacks are sized at the minimum'}); more income than that (unseen bonuses, cards) could still save a territory.`,
        `player ${p} may hold more territories in the fog (next to ${edge}): taking its ${ts.length} visible territories is pressure, not an elimination.`,
      );
      return true;
    }
    if (chosen.all) {
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
      return true;
    }
    const kept = ts.length - falls;
    const outcome = kept <= 1 ? 'cutting it to one territory' : `taking ${falls} of its ${ts.length}`;
    if (falls === attacked.length)
      rationale.push(
        `Pressure player ${p}: take ${falls} of its ${ts.length} territories (${names}) this turn, each sized for its full ~${deployP} deploy landing there, ${outcome}${rest}.`,
      );
    else {
      const saved = attacked.length - falls;
      rationale.push(
        `Pressure player ${p}: attack ${attacked.length === ts.length ? 'all' : attacked.length} ${attacked.length === ts.length ? `${ts.length} of its` : `of its ${ts.length}`} territories (${names}) this turn: its ~${deployP} deploy can save at most ${saved} of them, so at least ${falls} fall${falls === 1 ? 's' : ''}, ${outcome}${rest}.`,
      );
      warnings.push(
        `player ${p} chooses which of ${names} to save (up to ${saved}): what it deploys there survives my attack, next to the borders that attacked it.`,
      );
    }
    warnings.push(
      `Pressuring player ${p} assumes it deploys at most ~${deployP} (its estimate); more income than that (unseen bonuses, cards) could still save a territory.`,
    );
    return true;
  };
  // ---- 1s. strike an enemy commander (#61) ----
  // Killing a player's commander eliminates it, so a visible enemy commander next to a
  // territory I held at the start of the turn is attacked before anything else spends the
  // income (finishing off, pressure, holds, expansion), under every goal, sized for its
  // armies, the commander's COMMANDER_STRENGTH and its owner's full deploy estimate landing
  // there. Nothing is conceded yet, so a thin border next to it may strike. The owner's other
  // stacks still threaten this turn (attacks interleave). My commander's hold is reserved
  // first; each source keeps what holds it (`keepFor`; nothing when it cannot hold anyway,
  // unless it is my commander's).
  /** Players whose commander is struck this turn: finishing them off is moot. */
  const struck = new Set<number>();
  /** Strikes not made, warned about only when nothing else (finishing off) takes the territory. */
  const unstruck: { t: number; text: string }[] = [];
  for (const t of [...state.keys()].sort(byNum)) {
    const st = state.get(t)!;
    if (mineSet.has(t) || captured.has(t) || st.armies === null || st.owner.kind !== 'player') continue;
    if (!(st.specialUnits ?? []).some((u) => u.kind === 'commander' && u.playerId !== me)) continue;
    const adjacent = neighborsOf(g, t).filter((n) => mineSet.has(n));
    if (!adjacent.length) continue;
    const p = st.owner.playerId;
    const deployP = deployOf(p);
    const defenders = defenceAt(t) + deployP;
    const cost = captureCost(defenders, s);
    const at = `Player ${p}'s commander on ${label(t)}`;
    const sizing = `its ${armiesOf(t)} armies + the commander's ${COMMANDER_STRENGTH} + its owner's full ~${deployP} deploy`;
    if (cost === null) continue;
    // Only the struck territory stops threatening (once taken). war.app interleaves both
    // players' attacks, so the owner's other stacks still attack this turn: elimination
    // changes next turn's picture, not this one's.
    const gone = (x: number) => x === t;
    // My commander's must-hold reserve is funded first (rule 1k): what its territory needs
    // against every threat but the struck one; when that does not fit, all that may be
    // deployed there (rule 1k deploys it all there anyway). It is held as a deploy on my
    // commander's territory while the strike is tried, so under Local Deployment it is charged
    // to the pools that can reach it (`roomAt`/`spareAt` see it), not just taken off the budget.
    const held = new Map<number, number>();
    const hold = (on: boolean) => {
      for (const [c, n] of held) {
        const d = (deployed.get(c) ?? 0) + (on ? n : -n);
        if (d > 0) deployed.set(c, d);
        else deployed.delete(c);
        budget += on ? -n : n;
      }
    };
    for (const c of [...myCommanders].sort(byNum)) {
      const b = borderAt(c, (x) => captured.has(x) || gone(x));
      const n = b ? Math.min(roomAt(c), Math.max(0, holdArmies(b.threat) - unitsAt(c) - stayAt(c))) : 0;
      if (n <= 0) continue;
      held.set(c, n);
      deployed.set(c, (deployed.get(c) ?? 0) + n);
      budget -= n;
    }
    hold(false);
    const reserved = [...held.values()].reduce((a, n) => a + n, 0);
    // A source that issues no order yet (No-Split: it may already strike another commander)
    // may strike. Strikes run before triage and every other pass, so no source is conceded or
    // locked yet: those cannot hold a strike back.
    const blocked = (x: number) => orderOf(x) !== undefined;
    const order = adjacent
      .filter((x) => !blocked(x))
      .map((x) => ({ x, keep: keepFor(x, gone, budget - reserved - reserve) }))
      .sort((a, b) => avail.get(b.x)! - b.keep - (avail.get(a.x)! - a.keep) || a.x - b.x);
    const prev = targets.get(t);
    targets.set(t, { id: t, cost, enemy: true, sources: adjacent });
    worstCase.set(t, defenders);
    strikes.add(t);
    const reason = `kills player ${p}'s commander, which eliminates it (sized for ${sizing})`;
    // Every source's most, with no keep and no reserve: what the strike could ever be sent.
    const most = new Map(order.map(({ x }) => [x, Math.max(0, avail.get(x)!) + Math.max(0, spareAt(x))]));
    hold(true);
    const done = order.some(({ x, keep }) => tryCapture(t, reason, { from: x, keep }));
    /** What may still be deployed on each source with the reserve held back (pools included). */
    const roomLeft = new Map(order.map(({ x }) => [x, Math.max(0, spareAt(x))]));
    hold(false);
    if (done) {
      struck.add(p);
      warnings.push(
        `Killing player ${p}'s commander on ${label(t)} assumes it deploys at most ~${deployP} (its estimate); more than that (unseen bonuses, cards) could save it.`,
      );
      continue;
    }
    strikes.delete(t);
    worstCase.delete(t);
    if (prev) targets.set(t, prev);
    else targets.delete(t);
    // Say what actually held it back, so a manual strike can be judged; said only if finishing
    // off does not take it. A keep is named only for a source that could send enough without
    // it and the reserve; the reserve only when it binds (a source could send enough, keep
    // kept, but for it, or dropping that keep alone would not do). With no source able to
    // send enough at all, the strike is unaffordable.
    const could = order.filter(({ x }) => most.get(x)! >= cost);
    /** What `x` could send with no keep but the reserve held back (a guard owed is paid first). */
    const unkept = (x: number) => Math.max(0, avail.get(x)! + roomLeft.get(x)!);
    const limits = [
      ...adjacent.filter(blocked).map((x) => `No-Split: ${label(x)} already ${describeOrder(orderOf(x)!)}`),
      // The reserve only where it binds: a source could send enough, keep kept, but for it; or
      // dropping the keep alone would not do either (both stand in the way).
      ...(reserved && could.some(({ x, keep }) => most.get(x)! - keep >= cost || unkept(x) < cost)
        ? [`${reserved} of the income is held back for my commander's territory`]
        : []),
      ...could
        .filter(({ keep }) => keep > 0)
        .map(({ x, keep }) => `${label(x)} keeps ${keep} to hold ${myCommanders.has(x) ? 'my commander' : 'its other borders'}`),
      ...(order.length && !could.length
        ? [`unaffordable: at most ${Math.max(...most.values())} attackers from any one territory (every movable army and every deploy)`]
        : []),
    ];
    // Nothing above binds, yet no source could: name what each could actually send (under
    // Local Deployment, its pool room is what stops it).
    if (!limits.length)
      for (const { x } of could)
        limits.push(
          `${label(x)} can send at most ${unkept(x)}${local ? ` (Local Deployment: only ${roomLeft.get(x)} may be deployed there)` : ''}`,
        );
    unstruck.push({
      t,
      text: `${at} is in reach, but killing it needs ${cost} attackers (${sizing}), more than my territories next to it can send this turn${limits.length ? ` (${limits.join('; ')})` : ''}: not attacked.`,
    });
  }
  if (guarded) {
    const candidates = [...ownedBy.keys()]
      .filter((p) => inReach(p) && !struck.has(p))
      .sort(
        (a, b) =>
          ownedBy.get(a)!.length - ownedBy.get(b)!.length ||
          ownedBy.get(a)!.reduce((n, t) => n + armiesOf(t), 0) - ownedBy.get(b)!.reduce((n, t) => n + armiesOf(t), 0) ||
          a - b,
      );
    // A typical expansion capture: the median cost of the visible neutrals next to me.
    const neutralCosts = [...targets.values()].filter((tg) => !tg.enemy).map((tg) => tg.cost).sort(byNum);
    const expansionCost = neutralCosts.length ? neutralCosts[(neutralCosts.length - 1) >> 1]! : null;
    /**
     * Each of `p`'s visible territories, sized for its full deploy plus the pressure margin,
     * costs at most PRESSURE_FACTOR typical expansions (AHEAD_PRESSURE_FACTOR ahead in a 1v1 under
     * the profile, rule 0p.3; with no visible neutral next to me,
     * nothing to compare with: no limit). All or nothing.
     */
    const pressureAffordable = (p: number) => {
      const d = deployOf(p);
      return (
        expansionCost === null ||
        ownedBy.get(p)!.every((t) => (captureCost(armiesOf(t) + d + marginFor(d), s) ?? Infinity) <= pressureFactor * expansionCost)
      );
    };
    for (const p of candidates) {
      const edge = fogEdge(p);
      if (edge.length) {
        // Fog is a reason not to claim elimination, not to skip a cheap capture (#60).
        if (pressureAffordable(p) && finishOff(p, false, edge)) continue;
        if (finishOff(p, true))
          warnings.push(
            `player ${p} may hold more territories in the fog (next to ${edge.map(label).join(', ')}): finishing it off is not attempted, though its ${ownedBy.get(p)!.length} visible territories could all be taken this turn.`,
          );
        continue;
      }
      finishOff(p, false);
    }
  }
  for (const { t, text } of unstruck) if (!captured.has(t)) warnings.push(text);
  // The borders those captures (a strike, finishing off) relieve: re-judged without the
  // territories taken. A struck player's other stacks still threaten: attacks interleave, so
  // its elimination changes next turn, not this one.
  const fallen = (n: number) => captured.has(n);
  if (captured.size)
    for (const id of [...borders.keys()]) {
      if (!neighborsOf(g, id).some(fallen)) continue;
      const b = borderAt(id, fallen);
      if (b) borders.set(id, b);
      else borders.delete(id);
    }
  assessThreats();
  triage();

  if (myCommanders.size)
    rationale.push(
      `My commander stays on ${[...myCommanders].map(label).join(', ')}: planned moves carry armies only, never the commander.`,
    );

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
    // Rule 0p.1: in a 1v1 in contact, a break is a completion of equal value (the opponent
    // loses that income), and expansion that completes nothing ranks below holds and breaks.
    const oneVsOne = auto && profile.format === '1v1' && facing.size > 0;
    // Rule 0p.2: in an FFA with two or more opponents left, no second front.
    const ffa = auto && profile.format === 'ffa' && profile.opponents >= 2;
    if (oneVsOne)
      rationale.push(
        '1v1 in contact: breaking an enemy bonus counts like completing one of equal value (the opponent loses that income), and expansion that completes no bonus this turn ranks below holding, breaking and completing.',
      );
    const weight = oneVsOne ? 1 : BREAK_WEIGHT / opponents;
    /** Bonuses I hold in full (value > 0). */
    const heldBonusMembers = g.map.bonuses
      .filter((b) => b.value > 0)
      .map((b) => bonusTerritories(g, b.id))
      .filter((ts) => ts.length > 0 && ts.every((t) => mineSet.has(t)));
    /** Player `p` could take a member of a bonus I hold next turn (its stacks next to it plus its deploy). */
    const threatensMyBonus = (p: number) =>
      heldBonusMembers.some((ts) =>
        ts.some((m) => {
          let movable = 0;
          let growth = 0;
          let next = false;
          for (const n of neighborsOf(g, m)) {
            const st = state.get(n);
            if (st?.owner.kind !== 'player' || st.owner.playerId !== p || st.armies === null) continue;
            next = true;
            movable += Math.max(0, st.armies - guard) + unitsAt(n);
            growth = Math.max(growth, growthOf.get(n)?.growth ?? 0);
          }
          const take = armiesToTake(defenceAt(m), rates);
          return next && take !== null && take <= movable + Math.max(deployOf(p), growth);
        }),
      );
    /** Player `p` loses a territory to this turn's earlier passes (a strike, finishing off, pressure). */
    const beingFinished = (p: number) =>
      [...captured].some((t) => {
        const o = state.get(t)?.owner;
        return o?.kind === 'player' && o.playerId === p;
      });
    /** The best neutral bonus capture per army (complete or advance), 0 with none. */
    const bestNeutral = Math.max(0, ...plans.map(ratio));
    /**
     * Rule 0p.2: breaking `b` would open a second front (said once per bonus; the general rule
     * is said with the first break it skips). Call it only for a break the plan could afford.
     */
    const secondFrontSaid = new Set<number>();
    const opensSecondFront = (b: Breakable, score: number): boolean =>
      ffa && !threatensMyBonus(b.player) && !beingFinished(b.player) && bestNeutral >= SECOND_FRONT_SIMILAR * score;
    const secondFront = (b: Breakable, score: number): boolean => {
      if (!opensSecondFront(b, score)) return false;
      if (!secondFrontSaid.has(b.bonusId)) {
        if (!secondFrontSaid.size)
          rationale.push(
            `FFA with ${profile.opponents} opponents left: no second front — a player that threatens no bonus of mine and is not being finished off is not attacked while a neutral capture of similar value exists.`,
          );
        secondFrontSaid.add(b.bonusId);
        rationale.push(
          `Not breaking ${bonusName(b.bonusId)} (+${b.value} from player ${b.player}): no second front in an FFA — player ${b.player} threatens no bonus of mine and is not being finished off, and a neutral capture earns ${bestNeutral.toFixed(2)} per army against ${score.toFixed(2)}.`,
        );
      }
      return true;
    };
    // Enemy armies that could hit `t` next turn once it is mine (its own armies excluded).
    const counterThreat = (t: number) => {
      const byPlayer = new Map<number, number>();
      for (const n of neighborsOf(g, t)) {
        const st = state.get(n);
        if (st?.owner.kind !== 'player' || st.owner.playerId === me || st.armies === null) continue;
        byPlayer.set(st.owner.playerId, (byPlayer.get(st.owner.playerId) ?? 0) + Math.max(0, st.armies - guard) + unitsAt(n));
      }
      // Each opponent's movable armies plus its own deploy estimate; with none next to it, the reported estimate.
      if (!byPlayer.size) return enemyDeploy;
      return Math.max(...[...byPlayer].map(([p, movable]) => movable + deployOf(p)));
    };
    interface Candidate {
      kind: 'hold' | 'unit' | 'complete' | 'advance' | 'break';
      score: number;
      cost: number;
      id: number;
      value: number;
      focus: boolean;
      /** External borders of the bonus (fewer is easier to keep); 0 for holds. */
      borders: number;
      run: () => void;
    }
    const rank = { unit: 0, hold: 0, complete: 1, advance: 2, break: 3 } as const;
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
    /** A bonus's worth as the rationale states it: "+22, net +6" when its members carry penalties. */
    const worthOf = new Map<number, string>();
    for (const p of plans) {
      const score = ratio(p);
      // Rule 4c: a completion competes with holds at its net worth (`value` feeds topValue and
      // rule 1h.3's starve check), never its gross value.
      worthOf.set(p.bonusId, p.net === p.value ? `+${p.value}` : `+${p.value}, net +${p.net}`);
      if (p.completable)
        candidates.push({ kind: 'complete', score, cost: p.cost, id: p.bonusId, value: p.net, focus: p.focus, borders: p.borders, run: spend(() => complete(p)) });
      candidates.push({ kind: 'advance', score, cost: p.cost, id: p.bonusId, value: p.net, focus: p.focus, borders: p.borders, run: spend(() => advance(p)) });
    }
    // Capturing a member of a breakable bonus: what survives it, and whether that holds next turn.
    const breakOption = (t: number) => {
      const cost = targets.get(t)!.cost;
      const survivors = cost - straightKills(defenceAt(t), rates.defensiveKillRate);
      const counter = counterThreat(t);
      const take = armiesToTake(survivors, rates);
      return { t, cost, survivors, counter, take, survives: take === null || take > counter };
    };
    type BreakOption = ReturnType<typeof breakOption>;
    /**
     * At most what a capture of `t` could draw on now: every source free to attack plus the
     * deployable budget. Below its cost the capture cannot be planned this turn.
     */
    const affordable = (t: number) => {
      const tg = targets.get(t)!;
      const free = tg.sources.filter((x) => !locked.has(x) && !orderOf(x)).reduce((n, x) => n + Math.max(0, avail.get(x)!), 0);
      return free + Math.max(0, budget - reserve) >= tg.cost;
    };
    const broken = (b: Breakable) => bonusTerritories(g, b.bonusId).some((x) => captured.has(x));
    const breakReason = (b: Breakable) =>
      `breaks enemy bonus ${bonusName(b.bonusId)} (+${b.value} from player ${b.player})`;
    const warnRetake = (b: Breakable, o: BreakOption) => {
      const warning = retakeWarning(o.t, b.bonusId, o.survivors, o.counter);
      retakeChecks.set(o.t, { bonusId: b.bonusId, survivors: o.survivors, counter: o.counter, warning });
      if (warning) warnings.push(warning);
    };
    const breakOf = new Map<number, Breakable>();
    for (const b of breakable) for (const t of bonusTerritories(g, b.bonusId)) breakOf.set(t, b);
    // A threatened border whose only visible threat is a member of a breakable enemy
    // bonus also attacks it: the capture removes the threat and breaks the bonus. It
    // attacks on top of its hold, never instead of it: the threat assumes the enemy
    // reinforces that member first, so the capture can fail, and what stays on the
    // border must still hold. When the hold plus the capture is unaffordable, it just
    // holds. (A held border otherwise makes no attacks.)
    const holdAndBreak = (t: Threatened, rest = 0): boolean => {
      const threats = neighborsOf(g, t.id).filter((n) => {
        const st = state.get(n);
        return st?.owner.kind === 'player' && st.owner.playerId !== me && st.armies !== null;
      });
      if (threats.length !== 1) return false;
      const n = threats[0]!;
      const b = breakOf.get(n);
      if (!b || !targets.has(n) || broken(b) || orderOf(t.id)) return false;
      const o = breakOption(n);
      if (t.holdCost + o.cost > spareAt(t.id) - rest) return false;
      if (secondFront(b, (weight * b.value) / Math.max(1, o.cost))) return false;
      const before = budget;
      noteRecent(t);
      deploy(t.id, t.holdCost);
      if (!tryCapture(n, breakReason(b), { from: t.id, keep: avail.get(t.id)! })) {
        // Refused (R3: it would complete a bonus I cannot hold next turn): just hold.
        rationale.push(
          `Deploy ${t.holdCost} to ${label(t.id)} so it holds (protects +${t.value}): ${heldStack(t)} need ${armiesToTake(t.have + t.units + t.holdCost, rates)} to take, above the ~${t.threat} threat.`,
        );
        return true;
      }
      expansionSpent += before - budget - t.holdCost;
      anchor ??= moves[moves.length - 1]!.from;
      rationale.push(
        `${label(n)} is the only visible threat to ${label(t.id)}: capturing it removes that threat and breaks the bonus.`,
        `Deploy ${t.holdCost} to ${label(t.id)} so it still holds (protects +${t.value}) after attacking ${label(n)}: ${heldStack(t)} stay, needing ${armiesToTake(t.have + t.units + t.holdCost, rates)} to take, above the ~${t.threat} threat if the attack fails.`,
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
      const score = (weight * b.value) / Math.max(1, o.cost);
      // An FFA skips a second-front break, but only one the plan could pay for is named as
      // skipped: an unaffordable one is dropped quietly (it could not run either way).
      if (opensSecondFront(b, score) && !affordable(o.t)) continue;
      if (secondFront(b, score)) continue;
      candidates.push({
        kind: 'break',
        score,
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
    // Under rule 0p.1 an advance never outranks a hold, so it never defers one either.
    topValue = Math.max(0, ...candidates.filter((c) => !(oneVsOne && c.kind === 'advance')).map((c) => c.value));
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
    // A conceded unit's members, judged on their own now (rule 1a, against what is left).
    const singleNow = (t: Threatened, quiet: boolean) => {
      if (t.critical) return;
      if (t.recentFrom === undefined && t.holdCost > CONCEDE_FACTOR * t.worth) {
        conceded.add(t.id);
        if (!quiet)
          warnings.push(`${label(t.id)} cannot be held economically (needs ${t.holdCost}, protects +${t.value}): conceded`);
        return;
      }
      const room = roomAt(t.id);
      if (t.holdCost > room) {
        if (quiet) conceded.add(t.id);
        else concedeUnaffordable(t, room);
        return;
      }
      hold(t);
      heldBorders.add(t.id);
    };
    /** Units waiting for the expansion share (rule 4a's MIN_EXPANSION_SHARE), funded before any advance or break. */
    const waiting: Unit[] = [];
    const fundOrConcede = (u: Unit) => {
      if (u.conceded) return;
      if (!fundUnit(u, holdAndBreak) && !fundNearMiss(u))
        concedeUnit(u, { economic: false, left: leftFor(u) }, singleNow);
    };
    let unitsDue = false;
    const unitOf = new Map<Candidate, Unit>();
    for (const u of units) {
      if (u.conceded) continue;
      const c: Candidate = {
        kind: 'unit',
        score: u.members.some((m) => m.recentFrom !== undefined) ? Infinity : u.worth / u.cost,
        cost: u.cost,
        id: u.members[0]!.id,
        value: u.value,
        focus: false,
        borders: 0,
        run: () => {
          if (u.conceded) return;
          const recent = u.members.some((m) => m.recentFrom !== undefined);
          const pending = !unitsDue && expansionLeft > 0 && u.worth < topValue && !recent ? Math.max(0, floor - expansionSpent) : 0;
          const cost = u.members.filter((m) => !heldBorders.has(m.id)).reduce((n, m) => n + m.holdCost, 0);
          if (cost <= budget && cost > budget - pending) {
            waiting.push(u);
            rationale.push(
              `Hold ${u.members.map((m) => label(m.id)).join(', ')} after this turn's bonus completions (needs ${cost}, protects +${u.value}): a completion worth up to +${topValue} may go first, but the hold is funded before any capture that completes nothing.`,
            );
            return;
          }
          fundOrConcede(u);
        },
      };
      candidates.push(c);
      unitOf.set(c, u);
    }
    candidates.sort(
      (a, b) =>
        Number(b.focus) - Number(a.focus) ||
        (oneVsOne ? Number(a.kind === 'advance') - Number(b.kind === 'advance') : 0) ||
        b.score - a.score ||
        a.cost - b.cost ||
        a.borders - b.borders ||
        rank[a.kind] - rank[b.kind] ||
        a.id - b.id,
    );
    // A held-bonus unit that pays for itself is funded before any capture that completes
    // no bonus (an advance or a break, unless focused): at the first such capture, every
    // unit still pending runs first, with the completions that outscore the weakest of them.
    const done = new Set<Candidate>();
    // Rule 1h.3: a completion that outscores a pending unit per army still must not starve
    // it. When completing it first leaves too little to fund units it could have, it runs
    // only if its bonus earns more than those units; otherwise it waits until they are funded.
    const postponed: Candidate[] = [];
    const unitNeed = (u: Unit) => u.members.filter((m) => !heldBorders.has(m.id)).reduce((n, m) => n + m.holdCost, 0);
    /** The units `b` armies fund, taken in order (a unit that does not fit is skipped). */
    const fundable = (us: Unit[], b: number) =>
      us.filter((u) => {
        const need = unitNeed(u);
        if (need > b) return false;
        b -= need;
        return true;
      });
    const run = (c: Candidate) => {
      done.add(c);
      const pending =
        c.kind === 'complete' && !c.focus
          ? [...waiting, ...candidates.filter((d) => d.kind === 'unit' && !done.has(d)).map((d) => unitOf.get(d)!)].filter(
              (u) => !u.conceded,
            )
          : [];
      if (!pending.length) return c.run();
      const before = fundable(pending, budget);
      const restore = snapshot();
      const spent = expansionSpent;
      const left = expansionLeft;
      c.run();
      const after = new Set(fundable(pending, budget));
      const starved = before.filter((u) => !after.has(u));
      const lost = starved.reduce((n, u) => n + u.value, 0);
      if (!starved.length || c.value > lost) return;
      restore();
      expansionSpent = spent;
      expansionLeft = left;
      postponed.push(c);
      rationale.push(
        `Complete bonus ${bonusName(c.id)} (${worthOf.get(c.id) ?? `+${c.value}`}) only after holding ${starved.map((u) => `${bonusName(u.bonusId)} (+${u.value})`).join(', ')}: completing it first would leave too little to hold ${starved.length === 1 ? 'it' : 'them'}, and it earns no more.`,
      );
    };
    const runPostponed = () => {
      for (const c of postponed.splice(0)) c.run();
    };
    candidates.forEach((c, i) => {
      if (done.has(c)) return;
      if ((c.kind === 'advance' || c.kind === 'break') && !c.focus && !unitsDue) {
        unitsDue = true;
        // Those waiting for the expansion share outscore everything still to run.
        for (const u of waiting.splice(0)) fundOrConcede(u);
        const pending = candidates.filter((d) => d.kind === 'unit' && !done.has(d));
        if (pending.length) {
          const bar = Math.min(...pending.map((d) => d.score));
          for (const d of candidates.slice(i + 1))
            if (!done.has(d) && (d.kind === 'unit' || (d.kind === 'complete' && d.score > bar))) run(d);
        }
        runPostponed();
      }
      run(c);
    });
    unitsDue = true;
    for (const u of waiting.splice(0)) fundOrConcede(u);
    runPostponed();
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
    // Rule 4c: plain expansion never lowers income (a capture completing a negative bonus).
    for (const t of rest) if (gainWith([t.id]) >= 0 || inFocus(t.id)) tryCapture(t.id, 'expands territory');
  }

  // ---- rule 4c's guard: planned captures never lower next income (#70) ----
  // Known limit: dropping a capture rewinds its attacks, `avail`, `captured`, `survivorsAt` and
  // its own move/rationale/warning lines, but decisions made while it was assumed are not
  // re-checked: an earlier R3 `defensible()` may have counted its survivors, `anchor` may still
  // name its source, and a "Keep X (not conceded): this turn's captures complete ..." line may
  // cite a completion that no longer happens. Only maps with overlapping negative bonuses reach
  // this path (elsewhere no capture lowers income).
  {
    const order = captureOrder.filter((t, i) => captured.has(t) && captureOrder.lastIndexOf(t) === i);
    /** The negative bonuses `t` helps complete in the plan as it stands, as "name value". */
    const negativesOf = (t: number) =>
      completedBy(heldNow())
        .filter((id) => g.bonusById.get(id)!.value < 0 && bonusTs.get(id)!.includes(t))
        .map((id) => `${bonusName(id)} ${g.bonusById.get(id)!.value}`);
    let gain = incomeGain(heldNow());
    for (const t of [...order].reverse()) {
      if (gain >= 0) break;
      const after = incomeGain(new Set([...mine, ...captured].filter((x) => x !== t)));
      if (after <= gain) continue;
      // Kept: a focused bonus, a staging step (rule c), a commander strike, finishing off.
      if (inFocus(t) || staged.has(t) || strikes.has(t) || worstCase.has(t)) continue;
      const negatives = negativesOf(t);
      captureUndo.get(t)!();
      captured.delete(t);
      survivorsAt.delete(t);
      combined.delete(t);
      for (let i = moves.length - 1; i >= 0; i--) if (moves[i]!.kind === 'attack' && moves[i]!.to === t) moves.splice(i, 1);
      const attack = `Attack ${label(t)} `;
      for (let i = rationale.length - 1; i >= 0; i--) if (rationale[i]!.startsWith(attack)) rationale.splice(i, 1);
      for (let i = warnings.length - 1; i >= 0; i--)
        if (
          warnings[i]!.startsWith(`Attack on enemy ${label(t)} `) ||
          warnings[i]!.startsWith(`${label(t)} can be retaken `) ||
          warnings[i]!.startsWith(`The capture of ${label(t)} combines `)
        )
          warnings.splice(i, 1);
      rationale.push(
        `Drop the attack on ${label(t)}: it completes ${negatives.join(', ')}, and next income would fall below this turn's ${income} (next income ${income + gain} → ${income + after} without it); its armies stay where they are.`,
      );
      gain = after;
    }
    if (gain < 0) {
      const kept = order.flatMap((t) => {
        const negs = captured.has(t) ? negativesOf(t) : [];
        if (!negs.length) return [];
        const why = inFocus(t)
          ? 'focused'
          : staged.has(t)
            ? `stages bonus ${bonusName(staged.get(t)!)}`
            : strikes.has(t)
              ? 'a commander strike'
              : 'finishing off a player';
        return [`${label(t)} (${negs.join(', ')}; ${why})`];
      });
      warnings.push(
        `This plan lowers next income from ${income} to ${income + gain}: its captures complete negative bonuses — ${kept.join('; ')}.`,
      );
    }
  }

  /** Territories locked before the leftover deploy: holds, kept and standing borders, withdrawals. */
  const holdLocked = new Set(locked);
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
      .map((b) => ({ ...b, take: armiesToTake(stays(b.id) + unitsAt(b.id), rates) }))
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
        return b.threat - (armiesToTake(stays(id) + unitsAt(id), rates) ?? Infinity);
      };
      // A conceded border whose garrison stays (#59) is still defended: its pool goes there.
      const lost = (id: number) => conceded.has(id) && !stood.has(id);
      const charged = chargeDeploys(pools, deployed).used;
      for (const p of pools.bonuses) {
        const left = p.value - (charged.get(p.bonusId) ?? 0);
        if (left <= 0) continue;
        const m = [...p.territoryIds].sort(
          (a, b) => Number(lost(a)) - Number(lost(b)) || danger(b) - danger(a) || a - b,
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
    const take = armiesToTake(stays + unitsAt(t), rates);
    if (take !== null && take <= b.threat)
      warnings.push(
        `${label(t)} is kept for the bonus this turn completes, but its ${stays} armies need only ${take} to take against the ~${b.threat} threat: the bonus can fall next turn.`,
      );
  }

  // ---- efficient sizes (S2) ----
  // An attack below its next kill breakpoint is topped up to it from armies that would sit
  // idle on its source — never from a hold, a conceded border, my commander's territory, or
  // a source still facing an enemy after this turn's captures — when the extra kill can matter:
  // the target is a player's (its owner may reinforce it) or the attack is not certain.
  // Otherwise an attack between breakpoints is named as wasting armies.
  const rounding = s.roundingMode ?? 'StraightRound';
  const killsBy = (n: number) => guaranteedKills(n, rates.offensiveKillRate, luck, rounding);
  /**
   * Armies on `src` that would sit idle: none on a hold, a conceded border, my commander's
   * territory, or a border still facing an enemy once this turn's captures land (what stays
   * there defends it).
   */
  const idleAt = (src: number): number => {
    if (!mineSet.has(src) || holdLocked.has(src) || conceded.has(src) || myCommanders.has(src)) return 0;
    if (borderAt(src, (x) => captured.has(x))) return 0;
    return Math.max(0, avail.get(src)!);
  };
  for (const m of moves) {
    if (m.kind !== 'attack' || combined.has(m.to)) continue;
    // Sized for a worst case already (finishing a player off, fog pressure, a commander strike).
    const worst = worstCase.has(m.to) || strikes.has(m.to);
    const d = defenceAt(m.to);
    const chance = m.winChance ?? chanceOf(m.armies, d);
    const enemyTarget = state.get(m.to)?.owner.kind === 'player';
    const next = nextBreakpoint(m.armies, rates.offensiveKillRate, luck, rounding);
    const add = next === null ? 0 : next - m.armies;
    if (next !== null && add > 0 && !worst && (enemyTarget || chance < 1) && add <= idleAt(m.from)) {
      const before = m.armies;
      avail.set(m.from, avail.get(m.from)! - add);
      m.armies = next;
      m.winChance = chanceOf(next, d);
      if (survivorsAt.has(m.to)) survivorsAt.set(m.to, survivorsAt.get(m.to)! + add);
      // A break's retake warning was judged on the survivors before the top-up: re-judge it.
      const check = retakeChecks.get(m.to);
      const at = check?.warning === undefined ? -1 : warnings.indexOf(check.warning);
      if (check && at >= 0) {
        check.survivors += add;
        check.warning = retakeWarning(m.to, check.bonusId, check.survivors, check.counter);
        if (check.warning) warnings[at] = check.warning;
        else warnings.splice(at, 1);
      }
      const why = enemyTarget ? 'its owner may reinforce it' : `the win chance rises from ${pct(chance)} to ${pct(m.winChance)}`;
      rationale.push(
        `Top up the attack on ${label(m.to)} from ${label(m.from)} from ${before} to ${next} with ${add} idle armies there: ${next} is the next efficient size, killing ${killsBy(next)} for sure instead of ${killsBy(before)} (${why}).`,
      );
      continue;
    }
    const kills = killsBy(m.armies);
    if (kills <= 0 || killsBy(m.armies - 1) < kills) continue;
    let b = m.armies - 1;
    while (b > 1 && killsBy(b - 1) === kills) b--;
    if (chanceOf(b, d) < chance) continue;
    rationale.push(
      `The attack on ${label(m.to)} from ${label(m.from)} sends ${m.armies}, but ${b} already kill ${kills} for sure: the other ${m.armies - b} add no kill (only survivors)${next !== null ? `; the next kill needs ${next}` : ''}.`,
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
      // My commander's territory next to an enemy at the start of the turn keeps its armies,
      // even when this turn's captures make it interior: a capture can still fail.
      if (myCommanders.has(t) && neighborsOf(g, t).some((x) => (ownerOf(x) ?? me) !== me)) continue;
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

  // ---- Order Priority for a strike (rule 1s) ----
  // war.app interleaves both players' attacks, so a struck player's stacks next to my commander
  // may attack before the strike lands. Judged on what stays on my commander's territory once
  // every planned deploy and move is in (a strike from it thins it), against the STRUCK players'
  // visible stacks only: moving first kills their commander before they attack, but does nothing
  // against a third player, so a threat from someone else is no reason to spend the card.
  const commanderThreatened = [...myCommanders].some((c) => {
    const b = borderAt(c, (n) => {
      const st = state.get(n);
      return !(st?.owner.kind === 'player' && struck.has(st.owner.playerId));
    });
    return b !== null && (armiesToTake(stayAt(c) + unitsAt(c), rates) ?? Infinity) <= b.threat;
  });
  if (struck.size && commanderThreatened) {
    const where = [...myCommanders].map(label).join(', ');
    const who = [...struck].sort(byNum).map((p) => `player ${p}`).join(' and ');
    if (opts.holdsOrderPriority) {
      cardAdvice = 'order-priority';
      rationale.push(
        `Play Order Priority: my commander's territory ${where} is threatened this turn by what is left on it after this turn's orders, and with the card my attacks resolve first, so the strike on ${who}'s commander lands before its attacks.`,
      );
    } else
      warnings.push(
        `My attacks and ${who}'s interleave this turn, so its stacks may attack my commander's territory ${where} before the strike lands, and what is left on it after this turn's orders would fall; I hold no Order Priority card to make my attacks resolve first.`,
      );
  }

  // ---- expected ----
  const after = heldNow();
  const completed = completedBy(after);
  // A bonus refused in one pass but completed by a later one is not reported as refused.
  for (const id of [...notCompleted.keys()].sort(byNum)) {
    if (completed.includes(id)) continue;
    warnings.push(notCompleted.get(id)!.warning);
    rationale.push(notCompleted.get(id)!.why);
  }

  // Issue #69, second point: several borders facing one opponent are each sized for its whole
  // deploy. That is each border's worst case — the opponent picks where to land after I
  // commit — so a sure hold of all of them needs every one sized for it; no army is counted
  // twice on one border (movable + max(deploy, growth)).
  for (const [p, ids] of [...heldAgainst].sort((a, b) => a[0] - b[0])) {
    const held = [...ids].filter((id) => !conceded.has(id)).sort(byNum);
    if (held.length < 2) continue;
    rationale.push(
      `Each of the ${held.length} borders held against player ${p} (${held.map(label).join(', ')}) is sized for its full ~${deployOf(p)} deploy: it chooses where to land after seeing my orders, so any one of them can face all of it, and a share each would leave whichever it picks short. Each border's threat counts its stacks next to that border once plus one deploy, never the deploy twice.`,
    );
  }

  if (noSplit && moves.length)
    warnings.push(
      'No-Split is on: each order sends the planned armies, not every movable army; whether war.app also requires sending all movable armies from a territory is unverified.',
    );
  return {
    goal,
    profile,
    deploys: [...deployed]
      .filter(([, n]) => n > 0)
      .sort((a, b) => a[0] - b[0])
      .map(([territoryId, armies]) => ({ territoryId, armies })),
    moves,
    expected: { captures: [...captured].sort(byNum), bonusesCompleted: completed, nextIncome: incomeAfter(after) },
    warnings,
    rationale,
    enemyDeploy,
    conceded: [...conceded].sort(byNum),
    cardAdvice,
    multiSourceCaptures: [...combined].sort(byNum),
  };
}
