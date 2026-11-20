// The outlook (#178): whether a game is being won, lost, is even or is stuck, from my boards over
// the last turns. Pure and deterministic; no I/O.
//
// Strength is armies + STRENGTH_INCOME_TURNS × income (the #167 FFA ranking's measure): what a
// player can field over the next few turns. Mine is exact. An opponent's is a range under fog:
//   - low: its visible armies + k × the income it visibly earns (both lower bounds);
//   - high: what it could have, at most — every army it can have received and k × the most it
//     could earn now. Received: its start (given, or #205 with the starts unknown under an even
//     split, ⌈territories ÷ players⌉ × the armies each starting territory had) plus, each turn
//     paid, the most it could earn that turn — on a turn I have a board of (#205), the territory
//     income of every territory nobody else visibly holds plus every bonus none of whose
//     territories someone else visibly holds; on any other turn the whole map's territory income
//     plus every bonus, since a bonus held by someone else now may have paid it before — plus,
//     with cards on (#205), the Reinforcement armies the card clock lets it have played by now and
//     over the next k turns (`cardArmies`, capturing every turn).
//     In a team game a teammate can transfer armies to it, so its high is not a ceiling there.
//     Unbounded (`null`) when its start is unknown (a scenario's, or no armies per territory) or
//     cards are on without that bound (a Gift card, a progressive or unknown Reinforcement card).
//     With every territory in view, high = low.
// The ratio is mine ÷ the strongest opponent's, as a range: `low` against the highest `high`,
// `high` against the highest `low` (`null`: no upper limit). PLAN-TEAMS C3: in a team game it is by
// team — mine is my team's (me and each teammate still playing, `minePlayers`), and each enemy team
// is one side whose low, high and likely high are its players' summed (`strongest.team`, `players`);
// summed, a teammate's transfers stay inside its team's high. A player with no team is its own side.
//
// #208: the high is a bound, and under fog it stays far too loose to call a win until late: the
// most it could earn each turn is what the whole fog could pay, though most of the fog is
// neutral. So each opponent also gets a LIKELY high — an estimate, not a bound: the same sum, with
// every turn's income at most LIKELY_INCOME_MARGIN × the income the tracker reads off my boards
// (`trackOpponents`: the most it was seen to deploy, its visible income at least), never above
// that turn's cap, clamped between its low and its high (`source: 'tracked'`). #214: that needs
// territory in view NOW and an observed income (a turn pair that measured its deploy); one with
// nothing in view on this board, or never measured, gets a modest labelled prior instead
// (`source: 'prior'`), PEER-PACED (`peerPace`, owner's decision on #214): each turn's income is
// LIKELY_INCOME_MARGIN × the higher of my income that turn (on a turn without my board, my latest
// board before it; before my first board, unknown — the cache keeps ten turns — so a linear ramp
// from the symmetric opening's income below up to my first board's) and the most any opponent was
// tracked earning by then
// (observed deploys up to that turn; on the judged turn its tracked or visible income), the base
// income at least — at most an even share of the map's income (an even share of the territories at
// the base income, plus the map's bonuses ÷ the seated players; base income alone when no one is
// seated) and that turn's cap: a CEILING only, since as a floor it read thousands on a
// 1,200-territory map whatever anyone earned. It never falls below what the opponent's own evidence
// says: LIKELY_INCOME_MARGIN × its visible income, and × the income tracked on earlier boards when
// one was measured before it went out of view; one out of view now also keeps at least the armies
// and income it held on the latest board it was in view on. So less evidence never reads more
// hopeful than a measure would — and never its loose high, which used to stand in for it and then
// outranked every real estimate. Every likely high (tracked or prior) starts symmetric, never on my
// fortunes since (#214 review: shrinking would read every opponent weaker): the given start; under
// full distribution the even share, which is then every player's real start; else (TerritoryLimit
// unknown, so the share is only a bound) my armies on my opening board (turn 1), else war.app's
// default territory limit (DEFAULT_TERRITORY_LIMIT) at the armies each starting territory had —
// either at most the bound's start. None is
// made while any opponent is unbounded. When an estimate exists but does not show a win, the
// basis names the opponent that blocks it and why.
// Each turn gets a state: `winning` when even the low ratio is at least OUTLOOK_RATIO (or every
// opponent is bounded at no strength at all while I have some, or — `estimated` — my strength is
// at least OUTLOOK_RATIO × the highest likely high), `losing`
// when even the high ratio is at most 1 / OUTLOOK_RATIO — or (#228, `estimated`) when mine is at most
// LIKELY_LOSING_RATIO × the highest likely high (1 / OUTLOOK_RATIO once its LIKELY_INCOME_MARGIN is
// taken back out: it counts every army received and none lost, so alone it read 0.05× in a game I
// led) AND that is corroborated, by the main front grinding me down or by my income at most
// BEHIND_RATIO × the most an opponent is tracked earning (the profile's "behind"); such a turn carries
// `lowLikely`, and so does an uncorroborated one, whose basis says why it is no loss. The front that
// corroborates it is always forecast on the incomes read off my boards (below), never the plan's
// (#228 review): warapp_plan_turn plans on an outlook read without the plan's front and then reports
// one read with it, so a losing state that followed the plan's incomes could differ between the two
// and the plan would act on a state it never showed — `stalemate` when neither and no territory
// in view on both boards changed owner since the turn before while I face an enemy and (#201) the
// main front's multi-turn forecast is a stand-off, else `even`. The main front (#218: `mainFront`,
// exchange.ts, the planner's definition) is the biggest enemy stack next to me against my biggest
// stack beside it, both owners deploying their whole income there every turn (`forecastBorder`):
// mine off my board, theirs the tracked income (its visible income at least) — and on the turn
// being played, when the plan's `front` is that pair (`front` input), the plan's incomes, so the
// plan's front outlook and this forecast agree. A front that breaks or grinds me down within the
// horizon is not stuck, however quiet the last turns were; the basis says what the front assumed.
// The outlook reports a state only once it has held for OUTLOOK_TURNS consecutive turns; until
// then `state` is null and the basis says what each turn read. #228: given the plan's profile
// `standing`, an `even` or `stalemate` latest turn beside `ahead` / `behind` says why the two differ
// (the standing compares incomes; this outlook needs a decided ratio). The state never reads it.
// #304: beside the state, each turn reports what it rests on (`evidence`): the two incomes compared
// and how much of each opponent's frontier its income was read from (#294's coverage); a share under
// LOW_COVERAGE, or none measured, under fog is thin evidence, and the basis says "even" is then not safe.
// Reporting only: the state never reads it.
//
// #436 (owner decision of 2026-11-20): the outlook follows both incomes and their trend. Each turn reads my
// side's income against the strongest opponent side's income (`income`): its range under fog — `low` the
// income the tracker reads (its visible income at least), `high` the most the likely high lets it earn a turn
// while its frontier read is thin (else `low`) — and its ESTIMATE, the tracked figure divided by the
// estimate ÷ truth past games measured in its coverage band (`calibration`, from lessons.json, a band with
// at least MIN_CALIBRATION_SAMPLES), never below its visible income; uncalibrated, the tracked figure. Its
// lean: `unknown` when the range spans both thresholds (mine ÷ high at most INCOME_BEHIND_RATIO and mine ÷
// low at least INCOME_AHEAD_RATIO), `behind` / `ahead` when the whole range, else the estimate, is past one,
// else `even` — unless each side's income, moved one more turn at its change per turn over the turns judged
// (`trend`), crosses a threshold the ratio is already heading to (`byTrend`). No lead is claimed at low
// coverage (any opponent's evidence thin, #304): an `ahead` lean reads `unknown`, and a win on the likely
// high alone is not read (`noLeadClaim`); a win on the bound still is. The lean replaces `even` in the
// state (winning, losing and stalemate keep their tests), so the state can read `ahead`, `behind` or
// `unknown`; the planner acts on winning and losing only (#201). `pace` is the income line: both incomes and
// their change per turn over the turns judged. `surrenderLine` is ADVICE ONLY (the server never acts on it):
// crossed when my income stayed under INCOME_BEHIND_RATIO × the strongest's estimate for SURRENDER_TURNS
// consecutive turns and no bonus in reach closes the gap (`bonusesInReach`: a positive bonus I do not hold
// whose every missing member borders my land and whose visible defenders are fewer than my armies beside them
// plus my income; it closes the gap when my income plus its value reaches the line).
//
// OUTLOOK_RATIO (2.4×) is borrowed from a published bot's "lost" rule and has never been measured
// for war.app: the outlook is a basis for a decision, not a verdict. The planner acts on it in one
// way only (#201): once winning or losing, its payback tests count the turns the game has left.

import type { BoardState } from '../board.js';
import { holdsSeat } from '../player-states.js';
import { carriesTeam, isTeamGame } from '../teams.js';
import { neighborsOf, type MapGraph } from './graph.js';
import { DEFAULT_TERRITORY_LIMIT, staticSeatsFor, trackOpponents, type TrackGame, type TurnBoard } from './opponents.js';
import { neutralizeSeats } from './static-seats.js';
import { ownerShown, type PlannerSettings } from './planner.js';
import { bonusTerritories } from './bonuses.js';
import { cardArmiesBy, type CardArmyCeiling } from '../strategy/card-clock.js';
import { boardIncome, DEFAULT_BASE_INCOME, territoryIncome } from './player.js';
import { BEHIND_RATIO, STRENGTH_INCOME_TURNS, type GameStanding } from './profile.js';
import { FORECAST_TURNS, forecastBorder, mainFront, type BorderOutcome, type FrontStack } from './exchange.js';
import { specialUnitStrength } from './combat.js';
import { coverageText, LOW_COVERAGE, type TrackCoverage } from './plan/shared.js';
import { coverageBucket, type CoverageBucket } from './game-lessons.js';

/** Turns a state must hold before it is reported. */
export const OUTLOOK_TURNS = 3;
/** Winning at this strength ratio or more, losing at its inverse or less (borrowed, unmeasured). */
export const OUTLOOK_RATIO = 2.4;
/** #208: the likely high lets an opponent earn up to this many times its tracked income every turn (unmeasured). */
export const LIKELY_INCOME_MARGIN = 2;
/**
 * #228: losing on the estimate needs mine at most this share of the likely high — 1/OUTLOOK_RATIO
 * of it once its LIKELY_INCOME_MARGIN is taken back out, since the likely high is generous to the
 * opponent (it counts every army received, at the margin, and none lost) — and corroboration.
 */
export const LIKELY_LOSING_RATIO = 1 / (OUTLOOK_RATIO * LIKELY_INCOME_MARGIN);

/**
 * #214: the peer-paced prior — what an opponent I cannot measure likely earns in a turn:
 * LIKELY_INCOME_MARGIN × the higher of my income that turn and the most any opponent was tracked
 * earning by then, the base income at least; at most `ceiling` (an even share of the map's income:
 * a ceiling only, never a floor); and never below `floor` (what its own evidence says: its visible
 * income, the margin on what it was seen or tracked earning). Pure: the planner reuses it.
 */
export function peerPace(p: { base: number; mine: number; peers: number; ceiling: number; floor?: number }): number {
  return Math.max(p.floor ?? 0, Math.min(p.ceiling, Math.max(p.base, LIKELY_INCOME_MARGIN * Math.max(p.mine, p.peers))));
}

/** #214: what a likely high rests on, and why a prior when it is one. */
export type LikelySource = 'tracked' | 'prior';
export type PriorWhy = 'unseen' | 'unmeasured';

export type OutlookState = 'winning' | 'losing' | 'ahead' | 'behind' | 'even' | 'unknown' | 'stalemate';

/** #436: behind on incomes at this share of the strongest opponent's or less — the owner's surrender line (two-thirds). */
export const INCOME_BEHIND_RATIO = 2 / 3;
/** #436: ahead on incomes at this multiple of the strongest opponent's or more (the line's inverse). */
export const INCOME_AHEAD_RATIO = 1.5;
/** #436: consecutive turns under the line before the surrender line is crossed (owner). */
export const SURRENDER_TURNS = 3;
/** #436: the samples a coverage band needs before its estimate ÷ truth calibrates an estimate (unmeasured). */
export const MIN_CALIBRATION_SAMPLES = 5;

/** #436: past games' estimate ÷ truth per coverage band (lessons.json's calibration: geometric mean and samples). */
export type OutlookCalibration = Partial<Record<CoverageBucket, { geoMean: number; n: number }>>;

/** #436: one turn's incomes, mine against the strongest opponent side's. */
export interface OutlookIncome {
  /** My side's income (card armies out). */
  mine: number;
  /** The strongest side by estimate: its income range and estimate (summed over an enemy team). */
  theirs: { playerId: number; team?: number; players?: number[]; low: number; high: number; estimate: number };
  /** Mine ÷ theirs: `low` against its high, `high` against its low, `estimate` against its estimate (`null`: that figure is 0). */
  ratio: { low: number | null; high: number | null; estimate: number | null };
  /** The estimate was divided by past games' estimate ÷ truth in its coverage band. */
  calibrated: boolean;
  /** Each side's income change per turn over the turns judged up to this one; absent on the first. */
  trend?: { mine: number; theirs: number };
  lean: 'ahead' | 'behind' | 'even' | 'unknown';
  /** The lean came from the trend, not the incomes now. */
  byTrend?: true;
  /** A lead (an `ahead` lean, or a win on the likely high) was not claimed: the evidence is thin. */
  noLeadClaim?: true;
  /**
   * Only the calibrated estimate read behind; the tracked figure (the range's low) did not have me under it,
   * so the lean is `unknown` and the turn is not under the surrender line (calibration deepens a deficit the
   * tracked figure shows, never creates one).
   */
  calibratedOnly?: true;
}

/** #436: a bonus I could complete next turn (see the header). */
export interface BonusInReach {
  bonus: number;
  value: number;
  /** The visible defenders on its members I do not hold. */
  defenders: number;
}

/** #436: the surrender line — ADVICE ONLY; the server never acts on it. */
export interface SurrenderLine {
  crossed: boolean;
  /** Consecutive turns, up to the latest, with my income under the line. */
  turnsBelow: number;
  needed: number;
  myIncome: number;
  theirIncome: number;
  playerId: number;
  team?: number;
  /** INCOME_BEHIND_RATIO × their estimate. */
  line: number;
  calibrated: boolean;
  /** The largest bonus in reach that would bring my income to the line. */
  closer?: BonusInReach;
  advice: string;
}

/** #436: the pace line — both incomes and their change per turn over the turns judged. */
export interface OutlookPace {
  from: number;
  to: number;
  mine: { income: number; perTurn: number };
  theirs: { playerId: number; team?: number; income: number; perTurn: number };
}

/** #283: a side's armies on the board and its board income (strength = armies + k × income). */
export interface OutlookFigures {
  armies: number;
  income: number;
}

export interface OutlookTurn {
  turn: number;
  /** My strength: armies + k × income; in a team game my team's (PLAN-TEAMS C3). */
  mine: number;
  /** PLAN-TEAMS C3, a team game only: the players summed into `mine` (me first, then by id). */
  minePlayers?: number[];
  /**
   * The strongest opponent (by `high`, unbounded first, then `low`, then id); `null` when there is
   * none. In a team game an enemy team's figures are its players' summed: `team` and `players` say
   * which, and `playerId` is its lowest id.
   */
  strongest: { playerId: number; low: number; high: number | null; team?: number; players?: number[] } | null;
  /** Mine ÷ the opponents' strength: `low` against the highest high (0 when unbounded or that high is 0), `high` against the highest low (`null`: no limit). */
  ratio: { low: number; high: number | null };
  /**
   * #208: the opponent with the highest likely high — an ESTIMATE, not a bound (see the header) —
   * and mine ÷ it. Absent with every opponent in full view, or any unbounded.
   */
  likely?: {
    playerId: number;
    /** PLAN-TEAMS C3: an enemy team, its players' likely highs summed. */
    team?: number;
    players?: number[];
    high: number;
    ratio: number;
    /** #214: `tracked` from its observed income, `prior` from at least its even share of the map's income. */
    source: LikelySource;
    /** #214: with a prior, why — `unseen` (no territory in view now) or `unmeasured` (no observed income). */
    why?: PriorWhy;
  };
  /**
   * #208: `true` when the state is `winning` on the likely high alone (the bound did not show it);
   * #228: or `losing` on it, corroborated (see the header).
   */
  estimated?: true;
  /**
   * #228: present when mine is at most {@link LIKELY_LOSING_RATIO} of the likely high (and neither
   * winning nor the bound's losing applies): my income, the most an opponent is tracked earning (0:
   * none measured), whether the main front grinds me down, and whether that corroborated a loss.
   */
  lowLikely?: { myIncome: number; mostTracked: number; groundDown: boolean; losing: boolean };
  /**
   * #283: the armies and income behind `mine` and `strongest.low`, as the board shows them (an opponent's
   * in view only: a lower bound under fog); each side's summed in a team game. Kept in the outlook log,
   * so a surrender report can say what the position was.
   */
  figures?: { mine: OutlookFigures; strongest: OutlookFigures | null };
  /** Territories in view on this board and the one before that changed owner (`null` without the board before). */
  changed: number | null;
  /**
   * #201: the main front's forecast — my biggest stack next to an enemy against the biggest enemy
   * stack beside it, both deploying their visible income every turn. Absent with no front.
   */
  front?: {
    mine: number;
    theirs: number;
    player: number;
    /** #218: my territory and the enemy's. */
    from: number;
    at: number;
    /** #218: the incomes deployed there every turn, and where theirs came from. */
    myIncome: number;
    theirIncome: number;
    incomeSource: 'plan' | 'tracked' | 'visible';
    outcome: BorderOutcome;
    turn: number | null;
  };
  /**
   * #304: what the state rests on, reported beside it (it never changes the state): the two incomes
   * compared and how much of each opponent's frontier its income was read from (#294's coverage).
   */
  evidence?: OutlookEvidence;
  /**
   * #368: the positive bonuses my side held in full on the board before this turn's and no longer holds
   * in full on it, by id; absent without the board before or with none lost.
   */
  bonusesLost?: number[];
  /** #436: my income against the strongest opponent's (see the header); absent with no opponent. */
  income?: OutlookIncome;
  /** #436: the bonuses in reach (latest turn only), largest first; absent when none. */
  bonusesInReach?: BonusInReach[];
  /**
   * #436: `even` when the state is an income lean (`ahead`, `behind` or `unknown`) that replaced an even
   * reading on strength; absent otherwise. Even-on-strength turns are one run, whatever their leans.
   */
  strength?: 'even';
  state: OutlookState;
}

/**
 * #304: one opponent's income as the outlook read it, and the share of its frontier that was read
 * ({@link TrackCoverage}, over its income window; `null` when no pair of my boards measured it).
 * `thin` when the board is not in full view and that share is under {@link LOW_COVERAGE} or unmeasured.
 */
export interface OutlookEvidenceRow {
  playerId: number;
  income: number;
  /** `tracked` off my boards (its visible income at least), else `visible`: a lower bound under fog. */
  source: 'tracked' | 'visible';
  coverage: number | null;
  thin: boolean;
  /** The words beside the share ({@link coverageText}); absent without a coverage. */
  read?: string;
}

/** #304: what an outlook turn's state rests on. Reporting only. */
export interface OutlookEvidence {
  /**
   * My side's income against the compared side's (the side the likely high rests on, else the
   * strongest): in a team game each team's players summed. `null` with no opponent.
   */
  incomes: { mine: number; theirs: number; playerId: number; team?: number; players?: number[]; source: 'tracked' | 'visible' } | null;
  /** Every opponent still playing, by id. */
  opponents: OutlookEvidenceRow[];
  /** Any opponent's row is thin: the state rests on thin evidence, so `even` is not safe. */
  thin: boolean;
}

export interface GameOutlook {
  /**
   * The state, once it held for {@link OUTLOOK_TURNS} turns; `null` until then. #436: turns that read even on
   * strength are one run whatever their income leans; the run reports its lean when every turn judged read
   * the same one, else `even`.
   */
  state: OutlookState | null;
  /** How many of the latest turns read the newest turn's state (#436: or, read even on strength, were even on strength). */
  heldTurns: number;
  /** The turns judged (the latest {@link OUTLOOK_TURNS} consecutive ones), oldest first. */
  turns: OutlookTurn[];
  /** Strength = armies + `k` × income. */
  k: number;
  threshold: number;
  /** One paragraph: the measure, the latest turn's figures, the thresholds and why they are not a verdict. */
  basis: string;
  /** #304: the latest turn's {@link OutlookEvidence}; absent with no turn judged. */
  evidence?: OutlookEvidence;
  /**
   * #368: every turn judged ({@link OUTLOOK_TURNS} running) read `even` (#436: on strength, whatever its income
   * lean) while my side lost a bonus on each
   * (`lost`: per turn, the value of the bonuses lost): the ratio lags a slide the board already shows, so
   * the game leans behind. Reported beside the state, which it never changes (the thresholds stay; the
   * profile's standing is #287's). Absent otherwise.
   */
  leaning?: { toward: 'behind'; turns: number; lost: { turn: number; value: number }[] };
  /** #436: the pace line; absent with fewer than two turns judged or no opponent. */
  pace?: OutlookPace;
  /** #436: ADVICE ONLY — present when the latest turn's income is under the line. */
  surrenderLine?: SurrenderLine;
}

interface OutlookInput {
  graph: MapGraph;
  me: number;
  /** My boards, any order (one per turn; the last given wins), the turn being played included. */
  boards: readonly TurnBoard[];
  settings?: PlannerSettings;
  /** The game's players and starts ({@link trackGame}). */
  game?: TrackGame;
  /** Cards are in play: a Reinforcement card can add armies, so no opponent's strength is bounded above under fog… */
  cards?: boolean;
  /** …unless (#205) the card clock bounds what cards can add ({@link cardArmyCeiling}). */
  cardArmies?: CardArmyCeiling;
  /**
   * #218: the plan's main front for the turn being played (its `front`): when the latest turn's
   * main front is that pair, its forecast uses the plan's incomes, so the two agree.
   */
  front?: { turn: number; from: number; at: number; myIncome: number; theirIncome: number };
  /**
   * #228: the plan's profile standing for the turn being played, when known: an `even` outlook
   * beside an `ahead` or `behind` standing says why the two differ.
   */
  standing?: GameStanding;
  /** #436: past games' estimate ÷ truth per coverage band, to calibrate the opponents' income estimates. */
  calibration?: OutlookCalibration;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The armies the special units on a territory fight as (commanders), as the planner counts them. */
const unitsOn = (b: BoardState, id: number) => specialUnitStrength(b.territories.find((t) => t.territoryId === id)?.specialUnits);

const fullyVisible = (g: MapGraph, b: BoardState) => {
  const seen = new Set<number>();
  for (const t of b.territories) if (t.owner.kind !== 'unknown' && t.armies !== null) seen.add(t.territoryId);
  return [...g.territoryById.keys()].every((t) => seen.has(t));
};

function ownersOf(g: MapGraph, b: BoardState): Map<number, string> {
  const m = new Map<number, string>();
  for (const t of b.territories) {
    if (!g.territoryById.has(t.territoryId) || t.owner.kind === 'unknown') continue;
    m.set(t.territoryId, t.owner.kind === 'player' ? `p${t.owner.playerId}` : 'n');
  }
  return m;
}

export function gameOutlook(input: OutlookInput): GameOutlook {
  const { graph: g, me } = input;
  const settings = input.settings ?? {};
  const k = STRENGTH_INCOME_TURNS;
  const byTurn = new Map<number, TurnBoard>();
  // #270: a static seat (out, no AI on it) is no opponent: its territories read as neutrals.
  const seats = staticSeatsFor(input.game, me);
  for (const b of input.boards) byTurn.set(b.turn, seats.size ? { ...b, board: neutralizeSeats(b.board, seats) } : b);
  const all = [...byTurn.keys()].sort((a, b) => a - b);
  // The latest run of consecutive turns, at most OUTLOOK_TURNS long.
  const run: number[] = [];
  for (let i = all.length - 1; i >= 0 && run.length < OUTLOOK_TURNS; i--) {
    if (run.length && all[i] !== run[0]! - 1) break;
    run.unshift(all[i]!);
  }
  const players = input.game?.players ?? [];
  const myTeam = players.find((p) => p.id === me)?.team;
  const ally = (id: number) => id === me || (carriesTeam(myTeam) && players.find((p) => p.id === id)?.team === myTeam);
  const teamGame = isTeamGame(players);
  const stillPlaying = (id: number) => (players.find((p) => p.id === id)?.state ?? 'Playing') === 'Playing';
  const rules = { base: Math.max(0, Math.floor(settings.baseIncome ?? DEFAULT_BASE_INCOME)), per: settings.bonusArmyPer ?? 0 };
  const allBonuses = [...g.bonusById.values()].reduce((s, b) => s + Math.max(0, b.value), 0);
  // The most any player can earn in a turn: the whole map's territory income (BonusArmyPer) plus
  // every bonus. An observed turn's cap counts only the territories in view, so under BonusArmyPer
  // it is raised by what the rest of the map could add to the base, never past this ceiling.
  const mapTerritories = territoryIncome(g.territoryById.size, rules.base, rules.per);
  const ceiling = mapTerritories + allBonuses;
  // #205: on a turn I have a board of, a player earned at most the territory income of every
  // territory nobody else visibly holds plus every bonus none of whose territories someone else
  // (a player or neutral) visibly holds: income is paid from the board the turn starts on.
  const boardCap = (b: BoardState, playerId: number): number => {
    const other = new Set<number>();
    for (const t of b.territories) {
      if (!g.territoryById.has(t.territoryId)) continue;
      const shown = ownerShown(t);
      if (shown && !(shown.owner.kind === 'player' && shown.owner.playerId === playerId)) other.add(t.territoryId);
    }
    let bonuses = 0;
    for (const bonus of g.bonusById.values()) {
      if (bonus.value <= 0) continue;
      const ts = bonusTerritories(g, bonus.id);
      if (ts.length && !ts.some((t) => other.has(t))) bonuses += bonus.value;
    }
    return Math.min(ceiling, territoryIncome(g.territoryById.size - other.size, rules.base, rules.per) + bonuses);
  };
  const turnCap = (t: number, playerId: number) => {
    const b = byTurn.get(t)?.board;
    return b ? boardCap(b, playerId) : ceiling;
  };
  // Its starting armies: given, or (#205) at most an even share of the map at the armies each
  // starting territory had. Only seated players split the map: GameFeed also lists players who
  // never took a seat (Invited, Declined, RemovedByHost), and counting them would shrink the share.
  const game = input.game;
  const seated = game ? game.players.filter((p) => holdsSeat(p.state)).length : 0;
  const share = seated > 0 ? Math.ceil(g.territoryById.size / seated) : null;
  const start = game?.start
    ? game.start.territories * game.start.armiesPerTerritory
    : game?.startArmiesPerTerritory !== undefined && share !== null
      ? share * game.startArmiesPerTerritory
      : null;
  // #214: an even share of the map's income — the prior's CEILING only (a floor there read
  // thousands on a big map whatever anyone earned).
  const evenShare =
    seated > 0 ? territoryIncome(share ?? 0, rules.base, rules.per) + Math.floor(allBonuses / seated) : rules.base;
  // #214: the likely high's start — symmetric, never my fortunes since. The given start; under full
  // distribution the even share, which is then every player's real start; else (TerritoryLimit
  // unknown, so the share is only a bound) my opening board (turn 1) when I have it, else war.app's
  // default territory limit at the starting armies — each at most the bound's start. Never the
  // territories I held on a later board: shrinking would read every opponent weaker.
  const mineOn = (t: number) =>
    byTurn.get(t)!.board.territories.filter((x) => g.territoryById.has(x.territoryId) && x.owner.kind === 'player' && x.owner.playerId === me);
  const opening = ((): { armies: number; territories: number } | null => {
    if (start === null) return null;
    if (game?.start) return { armies: start, territories: game.start.territories };
    if (game?.fullDistribution) return { armies: start, territories: share ?? 0 };
    const first = all.find((t) => t <= 1);
    if (first !== undefined) {
      const ts = mineOn(first);
      return { armies: Math.min(start, ts.reduce((s, x) => s + (x.armies ?? 0), 0)), territories: ts.length };
    }
    const n = Math.min(share ?? 0, DEFAULT_TERRITORY_LIMIT);
    return { armies: Math.min(start, n * (game?.startArmiesPerTerritory ?? 0)), territories: n };
  })();
  const likelyStart = opening?.armies ?? null;
  // My income on each of my boards; on a turn between them, the latest board before it. Before my
  // first board it is unknown (the board cache keeps ten turns), so it ramps linearly from that
  // symmetric opening's income (its territories at the base, no bonus) up to my first board's.
  const myIncome = new Map<number, number>();
  for (const t of all) {
    const ts = new Set<number>();
    for (const x of mineOn(t)) ts.add(x.territoryId);
    myIncome.set(t, boardIncome(g, ts, rules).total);
  }
  const openingIncome = territoryIncome(opening?.territories ?? 0, rules.base, rules.per);
  const myIncomeAt = (t: number): number => {
    const first = all[0];
    if (first === undefined) return rules.base;
    if (t < first) {
      const to = myIncome.get(first)!;
      return first <= 1 ? to : Math.round(openingIncome + ((to - openingIncome) * Math.max(0, t - 1)) / (first - 1));
    }
    let at = first;
    for (const x of all) if (x <= t) at = x;
    return myIncome.get(at)!;
  };
  // Cards: unbounded unless the card clock bounds what they add.
  const cardsBound = !input.cards ? null : (input.cardArmies ?? undefined);

  // The armies and income a player held on the latest of my boards up to `turn` where it had any
  // territory in view, and that board's turn (none when it never had).
  const lastSeen = (playerId: number, turn: number): { turn: number; armies: number; income: number } | undefined => {
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i]! > turn) continue;
      const held = new Set<number>();
      let armies = 0;
      for (const t of byTurn.get(all[i]!)!.board.territories) {
        if (!g.territoryById.has(t.territoryId) || t.owner.kind !== 'player' || t.owner.playerId !== playerId || t.armies === null) continue;
        held.add(t.territoryId);
        armies += t.armies;
      }
      if (held.size) return { turn: all[i]!, armies, income: boardIncome(g, held, rules).total };
    }
    return undefined;
  };

  const turns: OutlookTurn[] = run.map((turn) => {
    const board = byTurn.get(turn)!.board;
    // #208: what the tracker reads of each opponent's income off my boards up to this turn.
    let tracked:
      | Map<
          number,
          { visible: number; income: number | null; visibleIncome: number; observed: { to: number; observed: number }[]; coverage: TrackCoverage | null }
        >
      | undefined;
    const trackedAll = () =>
      (tracked ??= new Map(
        trackOpponents(
          g,
          all.filter((t) => t <= turn).map((t) => byTurn.get(t)!),
          me,
          settings,
          input.game,
        ).map((tr) => [
          tr.playerId,
          {
            visible: tr.visible,
            income: tr.income === null ? null : Math.max(tr.visibleIncome, tr.income),
            visibleIncome: tr.visibleIncome,
            observed: tr.turns.map((o) => ({ to: o.to, observed: o.observed })),
            coverage: tr.coverage ?? null,
          },
        ]),
      ));
    const trackedOf = (playerId: number) => trackedAll().get(playerId);
    // #214: the most any opponent was tracked earning by turn `t`: its observed deploys up to then,
    // and on this turn its tracked (or visible) income.
    const peersAt = (t: number): number => {
      let most = 0;
      for (const [p, tr] of trackedAll()) {
        if (ally(p)) continue;
        for (const o of tr.observed) if (o.to <= t) most = Math.max(most, o.observed);
        if (t >= turn) most = Math.max(most, tr.visibleIncome, tr.income ?? 0);
      }
      return most;
    };
    const held = new Map<number, Set<number>>();
    const armies = new Map<number, number>();
    for (const t of board.territories) {
      if (!g.territoryById.has(t.territoryId) || t.owner.kind !== 'player' || t.armies === null) continue;
      const p = t.owner.playerId;
      if (!held.has(p)) held.set(p, new Set());
      held.get(p)!.add(t.territoryId);
      armies.set(p, (armies.get(p) ?? 0) + t.armies);
    }
    // PLAN-TEAMS C3: in a team game my side is my team: me and each teammate still playing.
    const mates = teamGame
      ? [...new Set([...held.keys(), ...players.map((p) => p.id)])].filter((p) => p !== me && ally(p) && stillPlaying(p)).sort((a, b) => a - b)
      : [];
    const strengthOf = (p: number) => (armies.get(p) ?? 0) + k * boardIncome(g, held.get(p) ?? new Set(), rules).total;
    const mine = mates.reduce((n, p) => n + strengthOf(p), strengthOf(me));
    // #283: what `mine` is made of.
    const mineFigures: OutlookFigures = [me, ...mates].reduce(
      (f, p) => ({ armies: f.armies + (armies.get(p) ?? 0), income: f.income + boardIncome(g, held.get(p) ?? new Set(), rules).total }),
      { armies: 0, income: 0 },
    );
    const open = fullyVisible(g, board);
    const ids = new Set<number>([...held.keys()].filter((p) => !ally(p)));
    for (const p of players) if (!ally(p.id) && stillPlaying(p.id)) ids.add(p.id);
    const rows = [...ids]
      .filter((p) => stillPlaying(p))
      .sort((a, b) => a - b)
      .map((playerId) => {
        const a = armies.get(playerId) ?? 0;
        const income = boardIncome(g, held.get(playerId) ?? new Set(), rules).total;
        const low = a + k * income;
        const seen = { armies: a, income };
        const none = { likely: undefined as number | undefined, source: undefined as LikelySource | undefined, why: undefined as PriorWhy | undefined };
        if (open) return { playerId, low, high: low as number | null, seen, paceIncome: income, capIncome: income, ...none };
        // #436: the most it could earn this turn (never below what it visibly earns): no income estimate exceeds it.
        const cap = Math.max(income, turnCap(turn, playerId));
        if (start === null || likelyStart === null || cardsBound === undefined)
          return { playerId, low, high: null, seen, paceIncome: cap, capIncome: cap, ...none };
        // Each turn's could-earn cap: from that turn's board when I have it, else the ceiling.
        let received = start;
        for (let t = 1; t <= turn; t++) received += turnCap(t, playerId);
        // Cards: what the clock lets it have played by now, and over the next k turns.
        const now = cardsBound ? cardArmiesBy(cardsBound, turn) : 0;
        const ahead = cardsBound ? cardArmiesBy(cardsBound, turn + k) - now : 0;
        const high = Math.max(a, received + now) + k * cap + ahead;
        // #208: the likely high — the same sum at LIKELY_INCOME_MARGIN × its tracked income a turn;
        // #214: only with territory in view now and an observed income, else at the peer-paced
        // prior (`peerPace`). An unmeasured one keeps the margin on its visible income too, and an
        // unseen one measured on earlier boards keeps it on that tracked income: less evidence never
        // reads lower. Both start symmetric (`likelyStart`).
        const tr = trackedOf(playerId);
        const why: PriorWhy | undefined = !tr || tr.visible === 0 ? 'unseen' : tr.income === null ? 'unmeasured' : undefined;
        const source: LikelySource = why ? 'prior' : 'tracked';
        const own = Math.max(income, LIKELY_INCOME_MARGIN * Math.max(tr?.visibleIncome ?? 0, tr?.income ?? 0));
        const paceAt = (t: number) =>
          why
            ? peerPace({ base: rules.base, mine: myIncomeAt(t), peers: peersAt(t), ceiling: evenShare, floor: own })
            : LIKELY_INCOME_MARGIN * tr!.income!;
        const pace = paceAt(turn);
        let likelyReceived = likelyStart;
        for (let t = 1; t <= turn; t++) likelyReceived += Math.min(turnCap(t, playerId), paceAt(t));
        // An unseen one keeps at least the armies it was last seen with, plus what the same pace
        // paid it on each turn since, and the income it then held: losing sight of a stack bigger
        // than its pace could have paid never reads more hopeful than seeing it.
        const last = why === 'unseen' ? lastSeen(playerId, turn) : undefined;
        let since = last?.armies ?? 0;
        if (last) for (let t = last.turn + 1; t <= turn; t++) since += Math.min(turnCap(t, playerId), paceAt(t));
        const likely =
          Math.max(a, likelyReceived + now, since) + k * Math.max(income, last?.income ?? 0, Math.min(cap, pace)) + ahead;
        // #436: the most it likely earns a turn, as the likely high counts it.
        const paceIncome = Math.max(income, last?.income ?? 0, Math.min(cap, pace));
        return { playerId, low, high, seen, paceIncome, capIncome: cap, likely: Math.min(high, Math.max(low, likely)), source, why };
      });
    // PLAN-TEAMS C3: an enemy team is one side, its figures summed; elsewhere a side is a player.
    const teamOf = (p: number) => {
      const t = players.find((x) => x.id === p)?.team;
      return teamGame && carriesTeam(t) ? t : undefined;
    };
    type Side = (typeof rows)[number] & { team?: number; players?: number[] };
    const sides: Side[] = [];
    for (const r of rows) {
      const t = teamOf(r.playerId);
      const side = t === undefined ? undefined : sides.find((x) => x.team === t);
      if (t === undefined) sides.push(r);
      else if (!side) sides.push({ ...r, seen: { ...r.seen }, team: t, players: [r.playerId] });
      else {
        side.low += r.low;
        side.seen.armies += r.seen.armies;
        side.seen.income += r.seen.income;
        side.high = side.high === null || r.high === null ? null : side.high + r.high;
        side.likely = side.likely === undefined || r.likely === undefined ? undefined : side.likely + r.likely;
        if (r.source === 'prior' && side.source !== 'prior') {
          side.source = 'prior';
          side.why = r.why;
        }
        side.players!.push(r.playerId);
      }
    }
    const sideOf = (x: Side) => (x.team !== undefined ? { team: x.team, players: x.players! } : {});
    const maxLow = sides.reduce((m, r) => Math.max(m, r.low), 0);
    const unbounded = sides.some((r) => r.high === null);
    const maxHigh = sides.reduce((m, r) => Math.max(m, r.high ?? 0), 0);
    const top =
      [...sides].sort(
        (a, b) =>
          (a.high === null ? 0 : 1) - (b.high === null ? 0 : 1) || (b.high ?? 0) - (a.high ?? 0) || b.low - a.low || a.playerId - b.playerId,
      )[0];
    const strongest = top ? { playerId: top.playerId, low: top.low, high: top.high, ...sideOf(top) } : null;
    const ratio = {
      low: !unbounded && maxHigh > 0 ? round2(mine / maxHigh) : 0,
      high: maxLow > 0 ? round2(mine / maxLow) : null,
    };
    // #208: the highest likely high, when every opponent is bounded and one is not in full view.
    let likely: OutlookTurn['likely'];
    if (!unbounded && !open && sides.length) {
      const top = [...sides].sort((a, b) => (b.likely ?? 0) - (a.likely ?? 0) || a.playerId - b.playerId)[0]!;
      const high = top.likely ?? 0;
      likely = {
        playerId: top.playerId,
        ...sideOf(top),
        high,
        ratio: high > 0 ? round2(mine / high) : 0,
        source: top.source ?? 'tracked',
        ...(top.why ? { why: top.why } : {}),
      };
    }
    // Every opponent bounded at no strength at all while I have some: dominated.
    const dominated = sides.length > 0 && !unbounded && maxHigh === 0 && mine > 0;
    const prev = byTurn.get(turn - 1)?.board;
    let changed: number | null = null;
    if (prev) {
      const before = ownersOf(g, prev);
      const after = ownersOf(g, board);
      changed = [...after].filter(([t, o]) => before.has(t) && before.get(t) !== o).length;
    }
    // The first entry per territory, as a linear find would read it.
    const ownerById = new Map<number, BoardState['territories'][number]['owner']>();
    for (const x of board.territories) if (!ownerById.has(x.territoryId)) ownerById.set(x.territoryId, x.owner);
    const front = [...(held.get(me) ?? [])].some((t) =>
      neighborsOf(g, t).some((n) => {
        const o = ownerById.get(n);
        return o?.kind === 'player' && !ally(o.playerId);
      }),
    );
    // #201: the main front, forecast forward. #218: the planner's definition (`mainFront`), and on
    // the turn being played the planner's incomes (`input.front`, the plan's `front`), so the plan's
    // front outlook and this forecast are one computation.
    const enemies: FrontStack[] = [];
    for (const t of board.territories) {
      if (!g.territoryById.has(t.territoryId) || t.armies == null || ownerById.get(t.territoryId) !== t.owner) continue;
      if (t.owner.kind !== 'player' || ally(t.owner.playerId)) continue;
      enemies.push({ id: t.territoryId, armies: t.armies + unitsOn(board, t.territoryId), player: t.owner.playerId });
    }
    const armiesById = new Map<number, number>();
    for (const t of board.territories) if (!armiesById.has(t.territoryId)) armiesById.set(t.territoryId, t.armies ?? 0);
    const mineNow = held.get(me) ?? new Set<number>();
    const main = mainFront(g, (x) => mineNow.has(x), enemies, (x) => (armiesById.get(x) ?? 0) + unitsOn(board, x));
    let forecast: OutlookTurn['front'];
    // #228 review: the front on my boards' incomes, for losing on the estimate (equal to `forecast`
    // unless the plan's incomes are given), so the plan's read and the reported one share the state.
    let ownOutcome: BorderOutcome | undefined;
    if (main) {
      const given =
        input.front && input.front.turn === turn && input.front.from === main.from && input.front.at === main.at ? input.front : undefined;
      // Their income: the plan's estimate on the turn being played; else what the tracker reads
      // off my boards (its tracked income, its visible income at least).
      const tr = given ? undefined : trackedAll().get(main.player);
      const myIncome = given?.myIncome ?? boardIncome(g, mineNow, rules).total;
      const theirIncome =
        given?.theirIncome ?? Math.max(boardIncome(g, held.get(main.player) ?? new Set(), rules).total, tr?.income ?? 0);
      const forecastAt = (mineIncome: number, foeIncome: number) =>
        forecastBorder({
          mine: main.mine,
          theirs: main.theirs,
          myIncome: mineIncome,
          theirIncome: foeIncome,
          outcomeOnly: true,
          settings: {
            ...(settings.offensiveKillRate !== undefined ? { offensiveKillRate: settings.offensiveKillRate } : {}),
            ...(settings.defensiveKillRate !== undefined ? { defensiveKillRate: settings.defensiveKillRate } : {}),
            ...(settings.oneArmyStandsGuard !== undefined ? { oneArmyStandsGuard: settings.oneArmyStandsGuard } : {}),
          },
        });
      const f = forecastAt(myIncome, theirIncome);
      if (!given) ownOutcome = f.outcome;
      else {
        const own = trackedAll().get(main.player);
        ownOutcome = forecastAt(
          boardIncome(g, mineNow, rules).total,
          Math.max(boardIncome(g, held.get(main.player) ?? new Set(), rules).total, own?.income ?? 0),
        ).outcome;
      }
      forecast = {
        mine: main.mine,
        theirs: main.theirs,
        player: main.player,
        from: main.from,
        at: main.at,
        myIncome,
        theirIncome,
        incomeSource: given ? 'plan' : tr?.income != null && tr.income > boardIncome(g, held.get(main.player) ?? new Set(), rules).total ? 'tracked' : 'visible',
        outcome: f.outcome,
        turn: f.turn,
      };
    }
    const bound = dominated || (sides.length > 0 && ratio.low >= OUTLOOK_RATIO);
    const estimated = !bound && likely !== undefined && likely.high > 0 && likely.ratio >= OUTLOOK_RATIO;
    const lostOnBound = !bound && !estimated && ratio.high !== null && ratio.high <= 1 / OUTLOOK_RATIO;
    // #228: losing on the likely high — far below it (LIKELY_LOSING_RATIO, its margin taken back
    // out), and corroborated: the likely high alone reads every fogged opponent strong (it counts
    // every army received and none lost, so a game I lead can read 0.05×). Corroborated by the
    // main front grinding me down, or by my income at most BEHIND_RATIO × the most an opponent is
    // tracked earning (the profile's "behind").
    // PLAN-TEAMS C3: in a team game my team's income, against the most an enemy team is tracked earning.
    const myNow = mates.reduce((n, p) => n + boardIncome(g, held.get(p) ?? new Set(), rules).total, boardIncome(g, mineNow, rules).total);
    const mostTracked = () => {
      const by = new Map<string, number>();
      for (const [p, tr] of trackedAll()) {
        if (ally(p) || tr.income === null) continue;
        const t = teamOf(p);
        const key = t === undefined ? `p${p}` : `t${t}`;
        by.set(key, (by.get(key) ?? 0) + tr.income);
      }
      let most = 0;
      for (const v of by.values()) most = Math.max(most, v);
      return most;
    };
    const lowLikely = !bound && !estimated && !lostOnBound && likely !== undefined && likely.high > 0 && likely.ratio <= LIKELY_LOSING_RATIO;
    // #228 review: on my boards' incomes, whatever the plan gave the reported front.
    const groundDown = ownOutcome === 'ground-down';
    const incomeBehind = lowLikely && mostTracked() > 0 && myNow <= BEHIND_RATIO * mostTracked();
    const lostOnEstimate = lowLikely && (groundDown || incomeBehind);
    // #304: what the state rests on — the two incomes compared and each opponent's frontier read.
    // Reporting only: nothing above reads it.
    const evidenceRows: OutlookEvidenceRow[] = rows.map((r) => {
      const tr = trackedOf(r.playerId);
      const tracked = tr?.income ?? null;
      const cov = tr?.coverage ?? null;
      return {
        playerId: r.playerId,
        income: tracked ?? r.seen.income,
        source: tracked !== null ? 'tracked' : 'visible',
        coverage: cov ? round2(cov.share) : null,
        thin: !open && (cov === null || cov.share < LOW_COVERAGE),
        ...(cov ? { read: coverageText(cov) } : {}),
      };
    });
    const compared = likely ? sides.find((x) => x.playerId === likely.playerId) : top;
    const comparedRows = compared ? evidenceRows.filter((r) => (compared.players ?? [compared.playerId]).includes(r.playerId)) : [];
    const evidence: OutlookEvidence = {
      incomes: compared
        ? {
            mine: myNow,
            theirs: comparedRows.reduce((n, r) => n + r.income, 0),
            playerId: compared.playerId,
            ...sideOf(compared),
            source: comparedRows.some((r) => r.source === 'tracked') ? 'tracked' : 'visible',
          }
        : null,
      opponents: evidenceRows,
      thin: evidenceRows.some((r) => r.thin),
    };
    // #436: each opponent's income range and estimate, summed per side; the strongest side by estimate.
    const calibrationFor = (share: number | null) => {
      const c = input.calibration?.[coverageBucket(share)];
      return c && c.n >= MIN_CALIBRATION_SAMPLES && c.geoMean > 0 ? c.geoMean : undefined;
    };
    const incomeSides = new Map<string, { playerId: number; team?: number; players?: number[]; low: number; high: number; estimate: number; calibrated: boolean }>();
    for (const r of rows) {
      const tr = trackedOf(r.playerId);
      const row = evidenceRows.find((x) => x.playerId === r.playerId)!;
      const low = row.income;
      const factor = tr?.income != null ? calibrationFor(tr.coverage?.share ?? null) : undefined;
      // The calibrated estimate and the top of the range never pass what it could earn this turn (`capIncome`, the
      // bound `paceIncome` keeps to): dividing a low-coverage reading by ~0.3 must not read an income it cannot reach.
      const capped = (n: number) => Math.min(Math.max(r.capIncome, low), n);
      const estimate = open ? low : factor !== undefined ? capped(Math.max(r.seen.income, Math.round(tr!.income! / factor))) : low;
      const high = open ? low : capped(Math.max(estimate, low, row.thin ? r.paceIncome : low));
      const t = teamOf(r.playerId);
      const key = t === undefined ? `p${r.playerId}` : `t${t}`;
      const side = incomeSides.get(key);
      if (!side)
        incomeSides.set(key, {
          playerId: r.playerId,
          ...(t !== undefined ? { team: t, players: [r.playerId] } : {}),
          low: Math.min(low, estimate),
          high,
          estimate,
          calibrated: factor !== undefined,
        });
      else {
        side.low += Math.min(low, estimate);
        side.high += high;
        side.estimate += estimate;
        side.calibrated ||= factor !== undefined;
        side.players!.push(r.playerId);
      }
    }
    const theirs = [...incomeSides.values()].sort((a, b) => b.estimate - a.estimate || b.high - a.high || a.playerId - b.playerId)[0];
    const income: OutlookIncome | undefined = theirs
      ? {
          mine: myNow,
          theirs: {
            playerId: theirs.playerId,
            ...(theirs.team !== undefined ? { team: theirs.team, players: theirs.players! } : {}),
            low: theirs.low,
            high: theirs.high,
            estimate: theirs.estimate,
          },
          ratio: {
            low: theirs.high > 0 ? round2(myNow / theirs.high) : null,
            high: theirs.low > 0 ? round2(myNow / theirs.low) : null,
            estimate: theirs.estimate > 0 ? round2(myNow / theirs.estimate) : null,
          },
          calibrated: theirs.calibrated,
          lean: 'even',
        }
      : undefined;
    // #436: the bonuses I could complete next turn (the latest turn only: the surrender line reads them).
    const bonusesInReach: BonusInReach[] = [];
    if (turn === run.at(-1)) {
      const side = new Set([me, ...mates]);
      const ownerOfT = (id: number) => ownerById.get(id);
      const isMine = (id: number) => {
        const o = ownerOfT(id);
        return o?.kind === 'player' && side.has(o.playerId);
      };
      for (const bonus of [...g.bonusById.values()].sort((a, b) => a.id - b.id)) {
        if (bonus.value <= 0) continue;
        const ts = bonusTerritories(g, bonus.id);
        const missing = ts.filter((t) => !isMine(t));
        if (!ts.length || !missing.length) continue;
        const beside = new Set<number>();
        let reachable = true;
        for (const t of missing) {
          const mineNext = neighborsOf(g, t).filter(isMine);
          if (!mineNext.length) reachable = false;
          for (const n of mineNext) beside.add(n);
        }
        if (!reachable) continue;
        const defenders = missing.reduce((n, t) => n + (armiesById.get(t) ?? 0) + unitsOn(board, t), 0);
        const attackers = [...beside].reduce((n, t) => n + (armiesById.get(t) ?? 0), 0) + myNow;
        if (defenders < attackers) bonusesInReach.push({ bonus: bonus.id, value: bonus.value, defenders });
      }
      bonusesInReach.sort((a, b) => b.value - a.value || a.bonus - b.bonus);
    }
    // #368: the bonuses my side held in full on the board before and does not now.
    const bonusesLost = prev
      ? (() => {
          const side = new Set([me, ...mates]);
          const sideHeld = (b: BoardState) => {
            const ts = new Set<number>();
            for (const x of b.territories)
              if (g.territoryById.has(x.territoryId) && x.owner.kind === 'player' && side.has(x.owner.playerId)) ts.add(x.territoryId);
            return ts;
          };
          const before = sideHeld(prev);
          const now = sideHeld(board);
          const lost: number[] = [];
          for (const bonus of [...g.bonusById.values()].sort((a, b) => a.id - b.id)) {
            if (bonus.value <= 0) continue;
            const ts = bonusTerritories(g, bonus.id);
            if (ts.length && ts.every((t) => before.has(t)) && !ts.every((t) => now.has(t))) lost.push(bonus.id);
          }
          return lost;
        })()
      : [];
    // #436: no lead is claimed at low coverage — a win on the likely high alone needs evidence that is not thin.
    const claimWin = estimated && !evidence.thin;
    if (income && estimated && !claimWin) income.noLeadClaim = true;
    const state: OutlookState =
      bound || claimWin
        ? 'winning'
        : lostOnBound || lostOnEstimate
          ? 'losing'
          : changed === 0 && front && (!forecast || forecast.outcome === 'stand-off')
            ? 'stalemate'
            : 'even';
    return {
      turn,
      mine,
      ...(teamGame ? { minePlayers: [me, ...mates] } : {}),
      strongest,
      ratio,
      ...(likely ? { likely } : {}),
      figures: { mine: mineFigures, strongest: top ? { ...top.seen } : null },
      changed,
      ...(forecast ? { front: forecast } : {}),
      state,
      ...(claimWin || lostOnEstimate ? { estimated: true as const } : {}),
      ...(lowLikely ? { lowLikely: { myIncome: myNow, mostTracked: mostTracked(), groundDown, losing: lostOnEstimate } } : {}),
      evidence,
      ...(bonusesLost.length ? { bonusesLost } : {}),
      ...(income ? { income } : {}),
      ...(bonusesInReach.length ? { bonusesInReach } : {}),
    };
  });

  // #436: each turn's income lean, with each side's change per turn over the turns judged up to it; it
  // replaces an `even` state (winning, losing and stalemate keep their own tests).
  // Calibration deepens a deficit the tracked figure shows, never creates one: a behind lean on the
  // calibrated estimate (or its trend), and a turn under the surrender line, need my income under the
  // tracked figure (the range's low) too. In-sample, on 10 lost games, past games' estimate ÷ truth alone put
  // 5 of 25 truly-even turns past the surrender line; with this rule 1 (see CLAUDE.md, #436).
  const trackedBehind = (inc: OutlookIncome) => inc.mine < inc.theirs.low;
  const first = turns[0];
  for (const t of turns) {
    const inc = t.income;
    if (!inc) continue;
    if (first && first !== t && first.income) {
      const span = t.turn - first.turn;
      inc.trend = { mine: round2((inc.mine - first.income.mine) / span), theirs: round2((inc.theirs.estimate - first.income.theirs.estimate) / span) };
    }
    const r = inc.ratio;
    const spans = r.low !== null && r.low <= INCOME_BEHIND_RATIO && (r.high === null || r.high >= INCOME_AHEAD_RATIO);
    let lean: OutlookIncome['lean'];
    if (spans) lean = 'unknown';
    else if (r.high !== null && r.high <= INCOME_BEHIND_RATIO) lean = 'behind';
    else if (r.low === null || r.low >= INCOME_AHEAD_RATIO) lean = 'ahead';
    else if (r.estimate !== null && r.estimate <= INCOME_BEHIND_RATIO) {
      if (trackedBehind(inc)) lean = 'behind';
      else {
        lean = 'unknown';
        inc.calibratedOnly = true;
      }
    }
    else if (r.estimate === null || r.estimate >= INCOME_AHEAD_RATIO) lean = 'ahead';
    else {
      lean = 'even';
      // The trend: one more turn at each side's change per turn, toward a threshold the ratio is heading to.
      if (inc.trend && r.estimate !== null) {
        const mineNext = Math.max(0, inc.mine + inc.trend.mine);
        const theirsNext = Math.max(0, inc.theirs.estimate + inc.trend.theirs);
        const next = theirsNext > 0 ? mineNext / theirsNext : null;
        if (next !== null && r.estimate < 1 && next <= INCOME_BEHIND_RATIO && trackedBehind(inc)) lean = 'behind';
        else if ((next === null || next >= INCOME_AHEAD_RATIO) && r.estimate > 1) lean = 'ahead';
        if (lean !== 'even') inc.byTrend = true;
      }
    }
    if (lean === 'ahead' && t.evidence?.thin) {
      lean = 'unknown';
      inc.noLeadClaim = true;
      delete inc.byTrend;
    }
    inc.lean = lean;
    if (t.state === 'even' && lean !== 'even') {
      t.state = lean;
      t.strength = 'even';
    }
  }

  const last = turns.at(-1);
  // #436: an income lean moves from turn to turn; the turns that read even on strength are one run, so a
  // lean that changes (even, behind, behind on a slide) does not reset the hold. The run reports its lean
  // when every turn judged read it, else `even`.
  const evenOnStrength = (t: OutlookTurn) => t.state === 'even' || t.strength === 'even';
  const sameRun = (t: OutlookTurn) => (last && evenOnStrength(last) ? evenOnStrength(t) : t.state === last?.state);
  let heldTurns = 0;
  for (let i = turns.length - 1; i >= 0 && sameRun(turns[i]!); i--) heldTurns++;
  const held = turns.slice(turns.length - heldTurns);
  const state: OutlookState | null =
    !last || heldTurns < OUTLOOK_TURNS
      ? null
      : evenOnStrength(last)
        ? held.every((t) => t.state === last.state)
          ? last.state
          : 'even'
        : last.state;
  // #368: even on strength for OUTLOOK_TURNS turns running while a bonus of mine fell on each: leaning
  // behind. #436: whatever the income lean (the lean is the incomes; the slide is the board), unless the run
  // already reads behind.
  const leaning: GameOutlook['leaning'] =
    state !== null &&
    state !== 'behind' &&
    turns.length >= OUTLOOK_TURNS &&
    turns.every(evenOnStrength) &&
    turns.every((t) => t.bonusesLost?.length)
      ? {
          toward: 'behind',
          turns: turns.length,
          lost: turns.map((t) => ({
            turn: t.turn,
            value: t.bonusesLost!.reduce((n, id) => n + Math.max(0, input.graph.bonusById.get(id)?.value ?? 0), 0),
          })),
        }
      : undefined;
  // #436: the pace line, over the turns judged.
  const lastIncome = last?.income;
  const firstIncome = turns[0]?.income;
  const pace: OutlookPace | undefined =
    last && lastIncome && firstIncome && turns.length >= 2 && lastIncome.trend
      ? {
          from: turns[0]!.turn,
          to: last.turn,
          mine: { income: lastIncome.mine, perTurn: lastIncome.trend.mine },
          theirs: {
            playerId: lastIncome.theirs.playerId,
            ...(lastIncome.theirs.team !== undefined ? { team: lastIncome.theirs.team } : {}),
            income: lastIncome.theirs.estimate,
            perTurn: lastIncome.trend.theirs,
          },
        }
      : undefined;
  // #436: the surrender line (advice only): my income under the line for SURRENDER_TURNS turns running.
  const below = (t: OutlookTurn) =>
    !!t.income && t.income.mine < INCOME_BEHIND_RATIO * t.income.theirs.estimate && trackedBehind(t.income);
  let turnsBelow = 0;
  for (let i = turns.length - 1; i >= 0 && below(turns[i]!) && (i === turns.length - 1 || turns[i + 1]!.turn === turns[i]!.turn + 1); i--) turnsBelow++;
  let surrenderLine: SurrenderLine | undefined;
  if (last && lastIncome && turnsBelow > 0) {
    const line = round2(INCOME_BEHIND_RATIO * lastIncome.theirs.estimate);
    const closer = (last.bonusesInReach ?? []).find((b) => lastIncome.mine + b.value >= line);
    const crossed = turnsBelow >= SURRENDER_TURNS && !closer;
    const who = lastIncome.theirs.team !== undefined ? `team ${lastIncome.theirs.team}` : `player ${lastIncome.theirs.playerId}`;
    const est = `${who}'s ~${lastIncome.theirs.estimate} (${lastIncome.calibrated ? "calibrated on past games' estimate ÷ truth" : 'the tracked figure, uncalibrated'})`;
    const mineText = `my ${teamGame ? "team's " : ''}income ${lastIncome.mine}`;
    const advice = crossed
      ? `Surrender line crossed (advice only; the server never acts on it): ${mineText} has stayed below two-thirds of ${est} for ${turnsBelow} turns running (the line is ${line}), and no bonus in reach closes the gap.`
      : closer
        ? `Under the surrender line for ${turnsBelow} turn${turnsBelow === 1 ? '' : 's'} (advice only): ${mineText} is below two-thirds of ${est} (the line is ${line}), but bonus ${closer.bonus} (+${closer.value}) is in reach and would close the gap.`
        : `Under the surrender line for ${turnsBelow} of the ${SURRENDER_TURNS} turns it needs (advice only): ${mineText} is below two-thirds of ${est} (the line is ${line}).`;
    surrenderLine = {
      crossed,
      turnsBelow,
      needed: SURRENDER_TURNS,
      myIncome: lastIncome.mine,
      theirIncome: lastIncome.theirs.estimate,
      playerId: lastIncome.theirs.playerId,
      ...(lastIncome.theirs.team !== undefined ? { team: lastIncome.theirs.team } : {}),
      line,
      calibrated: lastIncome.calibrated,
      ...(closer ? { closer } : {}),
      advice,
    };
  }
  const measure = teamGame
    ? `Strength = armies + ${k} × income; an opponent's is a range under fog (low: what is in view; high: the most it could have received and earn). By team: my team's strength (mine and my teammates' still playing) against the strongest enemy team's, each the sum of its players'; summed, a teammate's transfers stay inside its team's high.`
    : `Strength = armies + ${k} × income; an opponent's is a range under fog (low: what is in view; high: the most it could have received and earn). Per player: my strength alone against the single strongest opponent, teams not summed.`;
  /** PLAN-TEAMS C3: how a side is named — an enemy team with its players, else the player. */
  const sideName = (x: { playerId: number; team?: number; players?: number[] }) =>
    x.team !== undefined ? `team ${x.team} (players ${x.players!.join(', ')})` : `player ${x.playerId}`;
  const cap = (t: string) => `${t[0]!.toUpperCase()}${t.slice(1)}`;
  const thresholds = `Winning at ${OUTLOOK_RATIO}× the strongest opponent or more even at its high, losing at 1/${OUTLOOK_RATIO} (${round2(1 / OUTLOOK_RATIO)}×) or less even at its low (or, on an estimate under fog, at ${round2(LIKELY_LOSING_RATIO)}× or less of its likely strength while the main front grinds me down or my income is at most ${BEHIND_RATIO}× the most an opponent is tracked earning), stalemate when nothing in view changed hands for ${OUTLOOK_TURNS} turns along a front whose forecast is a stand-off. The ${OUTLOOK_RATIO}× is borrowed from a bot and was never measured for war.app: a basis for a decision, not a verdict.`;
  // PLAN-TEAMS C3: in a team game the thresholds are against the strongest enemy team.
  const thresholdsText = teamGame
    ? thresholds.replace(/the strongest opponent/g, 'the strongest enemy team').replace('my income is at most', "my team's income is at most").replace('the most an opponent is tracked earning', 'the most an enemy team is tracked earning')
    : thresholds;
  let reading: string;
  if (!last) reading = 'No board to judge.';
  else {
    const s = last.strongest;
    const figures = s
      ? `turn ${last.turn}: ${teamGame ? `my team's ${last.mine}, the strongest enemy ${s.team !== undefined ? `team, ${sideName(s)}` : sideName(s)}` : `mine ${last.mine}, the strongest opponent player ${s.playerId}`} at ${s.high === s.low ? s.low : `${s.low}–${s.high ?? 'unbounded'}`}, ratio ${last.ratio.high === last.ratio.low ? last.ratio.low : `${last.ratio.low}–${last.ratio.high ?? 'unbounded'}`}×`
      : `turn ${last.turn}: mine ${last.mine}, no opponent to compare`;
    // #208: the likely high, said as what it is; #214: a prior says so and why, and an estimate
    // that does not show a win names the opponent that blocks it.
    const l = last.likely;
    const rests = l?.source === 'prior'
      ? `for ${sideName(l)} a prior (${l.why === 'unmeasured' ? 'no observed income: no pair of my boards measured its deploy' : 'no territory in view now'}), paced by its peers: it starts as a symmetric opening, and each turn earns ${LIKELY_INCOME_MARGIN === 2 ? 'twice' : `${LIKELY_INCOME_MARGIN}×`} the higher of my income that turn (ramped up from the opening's before my first board) and the most any opponent was tracked earning by then (the base income at least), at most an even share of the map's income (${evenShare}) and that turn's cap, and at least ${LIKELY_INCOME_MARGIN}× its visible income (and any income tracked earlier)${l.why === 'unmeasured' ? '' : ', and at least the armies and income it held when last in view'}`
      : `each turn at most ${LIKELY_INCOME_MARGIN}× the income the tracker reads off my boards`;
    let est = '';
    if (l && (l.high !== s?.high || l.source === 'prior'))
      est = ` The likely high — an estimate, not a bound: ${rests} — is ${sideName(l)} at ${l.high}, ratio ${l.ratio}×${last.estimated ? `; ${last.state} rests on it` : ''}.`;
    if (l && l.high > 0 && last.state !== 'winning')
      est += ` ${cap(sideName(l))} blocks a win on the estimate: winning needs mine at ${OUTLOOK_RATIO}× its likely high (${round2(OUTLOOK_RATIO * l.high)}), and mine is ${last.mine}.`;
    reading =
      turns.length < OUTLOOK_TURNS
        ? `Only ${turns.length} turn${turns.length === 1 ? '' : 's'} of boards in a row (${OUTLOOK_TURNS} needed), so no state yet; ${figures}.`
        : evenOnStrength(last) && !held.every((t) => t.state === last.state)
          ? state
            ? `Even on strength for ${OUTLOOK_TURNS} turns running, the incomes reading ${turns.map((t) => t.state).join(', ')}; ${figures}.`
            : `Even on strength for ${heldTurns} of the ${OUTLOOK_TURNS} turns (${turns.map((t) => t.state).join(', ')}), so no state yet; ${figures}.`
          : state
            ? `${state[0]!.toUpperCase()}${state.slice(1)} for ${OUTLOOK_TURNS} turns running; ${figures}.`
            : `${last.state[0]!.toUpperCase()}${last.state.slice(1)} for ${heldTurns} of the ${OUTLOOK_TURNS} turns (${turns.map((t) => t.state).join(', ')}), so no state yet; ${figures}.`;
    // #304: the incomes compared and each opponent's frontier read, said beside the state, and thin
    // evidence named so that "even" does not read as safe.
    const ev = last.evidence;
    if (ev?.incomes) {
      const i = ev.incomes;
      reading += ` Incomes compared: ${teamGame ? "my team's" : 'mine'} ${i.mine}, ${sideName(i)}'s ${i.theirs} (${i.source === 'tracked' ? 'tracked off my boards' : 'in view, a lower bound under fog'}).`;
    }
    if (ev && !fullyVisible(g, byTurn.get(last.turn)!.board) && ev.opponents.length)
      reading += ` Frontier read: ${ev.opponents.map((r) => `player ${r.playerId} ${r.read ?? 'not measured'}`).join('; ')}.`;
    if (ev?.thin) {
      const pct = Math.round(LOW_COVERAGE * 100);
      const which = ev.opponents
        .filter((r) => r.thin)
        .map((r) => `player ${r.playerId} (${r.coverage === null ? 'not measured' : `${Math.round(r.coverage * 100)}%`})`)
        .join(', ');
      reading += ` Thin evidence: the income of ${which} was read from under ${pct}% of its frontier, so "${last.state}" is not a safe reading: an opponent may be stronger than the fog shows.`;
    }
    reading += est;
    // #436: the incomes, their range and lean, and the pace line.
    const inc = last.income;
    if (inc) {
      const t = inc.theirs;
      const whose = t.team !== undefined ? `team ${t.team}` : `player ${t.playerId}`;
      const range = t.low === t.high ? `${t.estimate}` : `~${t.estimate} (range ${t.low}–${t.high})`;
      const leanText =
        inc.lean === 'unknown'
          ? inc.noLeadClaim
            ? 'unknown: the evidence is thin, so no lead is claimed'
            : inc.calibratedOnly
              ? `unknown: only the calibrated estimate reads behind (mine under ${round2(INCOME_BEHIND_RATIO)}× of it), not the tracked ${t.low}, so it is not counted against the surrender line`
              : `unknown: the range spans both thresholds (${round2(INCOME_BEHIND_RATIO)}× and ${INCOME_AHEAD_RATIO}×)`
          : `${inc.lean}${inc.byTrend ? ' on the trend' : ''}`;
      reading += ` On incomes: ${teamGame ? "my team's" : 'mine'} ${inc.mine} against the strongest, ${whose}, at ${range}${inc.calibrated ? ", calibrated on past games' estimate ÷ truth" : ''}: ${leanText}.`;
      if (inc.noLeadClaim && inc.lean !== 'unknown') reading += ' No lead is claimed on the likely high: the evidence is thin.';
    }
    if (pace) {
      const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
      const gap = pace.mine.perTurn > pace.theirs.perTurn ? 'my income gains on it' : pace.mine.perTurn < pace.theirs.perTurn ? 'its income gains on mine' : 'both move alike';
      reading += ` Pace: my income ${pace.mine.income} (${sign(pace.mine.perTurn)}/turn over turns ${pace.from}–${pace.to}) against ${pace.theirs.team !== undefined ? `team ${pace.theirs.team}` : `player ${pace.theirs.playerId}`}'s ~${pace.theirs.income} (${sign(pace.theirs.perTurn)}/turn): ${gap}.`;
    }
    if (surrenderLine) reading += ` ${surrenderLine.advice}`;
    // #228: a likely ratio far below parity, said with what it took (or lacked) to read losing.
    const low = last.lowLikely;
    if (low) {
      const share = `mine is at most 1/${round2(1 / LIKELY_LOSING_RATIO)} (${round2(LIKELY_LOSING_RATIO)}×) of the likely high`;
      const incomeText =
        low.mostTracked > 0
          ? teamGame
            ? `my team's income (${low.myIncome}) at most ${BEHIND_RATIO}× the most an enemy team is tracked earning (${low.mostTracked})`
            : `my income (${low.myIncome}) at most ${BEHIND_RATIO}× the most an opponent is tracked earning (${low.mostTracked})`
          : '';
      const behind = low.mostTracked > 0 && low.myIncome <= BEHIND_RATIO * low.mostTracked;
      reading += low.losing
        ? ` Losing on the estimate: ${share}, corroborated by ${[low.groundDown ? 'the main front grinding me down on the incomes read off my boards' : '', behind ? incomeText : ''].filter(Boolean).join(' and ')}.`
        : ` ${share[0]!.toUpperCase()}${share.slice(1)}, but that alone is no loss: the likely high counts every army an opponent could have received at ${LIKELY_INCOME_MARGIN}× its pace and none it lost, so it reads every fogged opponent strong. Losing on it needs the main front grinding me down on the incomes read off my boards (not the plan's, so the plan acts on the state shown) or my income at most ${BEHIND_RATIO}× the most an opponent is tracked earning${low.mostTracked > 0 ? ` (mine ${low.myIncome}, the most tracked ${low.mostTracked})` : ' (none is tracked)'}.`;
    }
    if (leaning)
      reading += ` Leaning behind: even for ${leaning.turns} turns running while I lost bonuses on each (${leaning.lost.map((x) => `turn ${x.turn} +${x.value}`).join(', ')}): the strength ratio lags a slide the board already shows, so read "even" as falling behind.`;
    // #228: the plan's profile standing is a different measure (incomes, then the armies in view).
    const standing = input.standing;
    if ((last.state === 'even' || last.state === 'stalemate') && (standing === 'ahead' || standing === 'behind'))
      reading += ` The profile's standing reads ${standing} (my income against the strongest opponent's estimate, overruled by the armies in view); this outlook reads ${last.state} because neither the winning nor the losing threshold was met on strength (armies + ${k} × income, and the likely high), a stricter test for a decided game.`;
    // #218: the main front, said with what it assumes, so it reads with the plan's front outlook.
    const fr = last.front;
    if (fr) {
      const theirs =
        fr.incomeSource === 'plan'
          ? "the plan's estimate"
          : fr.incomeSource === 'tracked'
            ? 'tracked off my boards'
            : 'its visible income, a lower bound under fog';
      const outcome =
        fr.outcome === 'ground-down'
          ? `I am ground down on turn ${fr.turn}`
          : fr.outcome === 'breaks'
            ? `my stack breaks it on turn ${fr.turn}`
            : `a stand-off over ${FORECAST_TURNS} turns`;
      reading += ` The main front (the biggest enemy stack next to me against my biggest beside it), each side deploying its whole income there every turn (mine ${fr.myIncome}, player ${fr.player}'s ${fr.theirIncome}: ${theirs}): my ${fr.mine} on #${fr.from} against its ${fr.theirs} on #${fr.at}, ${outcome}.`;
    }
  }
  return {
    state,
    heldTurns,
    turns,
    k,
    threshold: OUTLOOK_RATIO,
    basis: `${reading} ${measure} ${thresholdsText}`,
    ...(last?.evidence ? { evidence: last.evidence } : {}),
    ...(leaning ? { leaning } : {}),
    ...(pace ? { pace } : {}),
    ...(surrenderLine ? { surrenderLine } : {}),
  };
}
