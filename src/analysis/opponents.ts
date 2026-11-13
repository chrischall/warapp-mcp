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
//    attacks killed, and what a hold of mine that fell really killed;
//  - unexplained armies (#123): the income it earned since first seen (each turn: what it
//    visibly earned, or what it was seen to deploy when more) minus the change of its visible
//    armies, what it visibly lost, and what it may have lost fighting where its stack and a
//    neighbour of another player both shrank — armies in the fog, spent there, or a misread;
//  - inferred bonuses: when the income beats the visible income, the combinations of bonuses
//    it could hold (none of their territories visibly held by anyone else, neutral included)
//    whose values come closest to the gap — only bonuses within {@link INFER_REACH} hops of a
//    territory it visibly holds, and that it could have paid for (#123: a member not visibly its
//    costs at least {@link NEUTRAL_CAPTURE_LOSS}, against its starting armies plus its income
//    every turn so far), nearest first. They are candidates, never an assertion; when more than
//    {@link MAX_LISTED_COMBINATIONS} fit, none is listed.
//
// One-off movements (#123): each observed turn carries a low and a high reading of its deploy
// (`observeDeploy`): growth next to the fog beyond its visible income is read as a move out of
// the fog, a capture whose visible attacking stack shrank counts its surplus as deployed on that
// stack, and a capture from me is priced at the guard unless my orders say what stood there.
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
import type { BoardState } from '../board.js';
import type { GameMap, GameSettings } from '../normalize.js';
import { carriesTeam } from '../teams.js';
import { bonusTerritories } from './bonuses.js';
import { DEFAULT_DEFENSIVE_KILL_RATE, DEFAULT_OFFENSIVE_KILL_RATE, straightKills } from './combat.js';
import { neighborsOf, type MapGraph } from './graph.js';
import { enemyDeployEstimates, observeSigned, ownerShown, visibleState, type PlannerSettings } from './planner.js';
import { boardIncome, DEFAULT_BASE_INCOME } from './player.js';

/** One of my boards and the turn it was seen on (the turn being played on it). */
export interface TurnBoard {
  turn: number;
  board: BoardState;
  /**
   * My own orders on that turn, when known (#119): measurements of what the opponents deployed
   * ({@link measureOrders}). Unknown orders change nothing.
   */
  orders?: MyOrders;
}

/** My orders on one turn (#119): my deploys and the moves I sent (attacks and transfers alike). */
export interface MyOrders {
  deploys: readonly { territoryId: number; armies: number }[];
  moves: readonly { from: number; to: number; armies: number }[];
}

/** Observed turns (the latest) feeding the income estimate (#99: {@link trackedIncome}). */
export const INCOME_TURNS = 3;
/** Most bonuses in one inferred combination. */
export const MAX_COMBINATION = 3;
/** Inferred combinations listed; when more fit, none is (#123: too many to name any). */
export const MAX_LISTED_COMBINATIONS = 8;
/** #123: an inferred bonus has a member within this many hops of a territory it visibly holds. */
export const INFER_REACH = 4;
/** #123: the least a territory it is not seen holding cost it to take (a 2-army neutral at 70%). */
export const NEUTRAL_CAPTURE_LOSS = 1;

/** What one turn (board `from` → board `to`) showed of one opponent. */
export interface ObservedTurn {
  /** The turn whose orders the change shows (the earlier board's turn). */
  from: number;
  /** The later board's turn (`from + 1`: only consecutive boards are compared). */
  to: number;
  /** Its observed deploy, capped at what it could earn ({@link ObservedTurn.cap}). */
  observed: number;
  /** The observed deploy before the cap ({@link ObservedTurn.measured} included). */
  raw: number;
  /**
   * What my own orders on the earlier turn measured (#119, {@link measureOrders}), added to the
   * board's reading before the floor at 0 and to `losses`: the defenders my failed attacks killed,
   * and on a hold of mine that fell, what its defenders really killed. 0 without my orders.
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
   * #123: armies it may have lost fighting where its stack and a neighbour of another player both
   * shrank (the neighbour's losses at the kill rates: round(shrink × offensive ÷ defensive)), each
   * neighbour counted once; mine left out when my orders measured the turn. Only the unexplained
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
export interface BonusCombination {
  bonusIds: number[];
  total: number;
  /** Hops from a territory it visibly holds to the nearest member, summed over its bonuses (#123). */
  hops: number;
}

export interface InferredBonuses {
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
}

/** The game around the boards (#94): who is still playing, and what each started with. */
export interface TrackGame {
  players: readonly TrackPlayer[];
  /** Territories each player started with, and the armies on each, when the settings give them. */
  start?: { territories: number; armiesPerTerritory: number };
  /** Why `start` is absent (said in the note). */
  startUnknown?: string;
  /** Settings under which the base income each turn may not be a floor (e.g. Sanctions), said in the note. */
  incomeCaveats?: string[];
}

/** What an opponent with no territory in view must have received since the game started (#94). */
export interface EarnedBound {
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
   * Unexplained armies (#123): the income it earned since first seen minus its visible army
   * change, its visible losses and what it may have lost fighting (`combat`) — armies that are
   * in the fog, or were spent there, or a misread (≥ 0); `null` before any observed turn.
   */
  unexplained: number | null;
  /** Bonuses that could explain `income − visibleIncome`; `null` when there is no gap. */
  inferred: InferredBonuses | null;
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
  /** Unseen-banking warnings (also in `notes`), naming it. */
  warnings: string[];
  /** Confidence notes, plain sentences. */
  notes: string[];
}

/**
 * {@link TrackGame} from GameFeed's players and settings: each player's starting armies are
 * TerritoryLimit × InitialPlayerArmiesPerTerritory, unless either is missing, the game uses full
 * distribution (DistributionMode -1: every territory is split among the players, TerritoryLimit
 * ignored — unverified, docs/WARAPP-API.md) or a map distribution that is not `normal` (a
 * scenario sets its own starts). A Sanctions card is an income caveat: it can cut income below
 * the base the bound counts.
 */
export function trackGame(
  players: readonly TrackPlayer[],
  settings:
    | (Pick<GameSettings, 'territoryLimit' | 'initialPlayerArmiesPerTerritory' | 'distributionMode'> & { cards?: readonly string[] })
    | undefined,
  map?: Pick<GameMap, 'distributionModes'>,
): TrackGame {
  const list = players.map((p) => ({
    id: p.id,
    ...(p.name !== undefined ? { name: p.name } : {}),
    ...(p.team !== undefined ? { team: p.team } : {}),
    ...(p.state !== undefined ? { state: p.state } : {}),
  }));
  const caveats = settings?.cards?.includes('Sanctions')
    ? ['the game has the Sanctions card, which can cut a sanctioned player\'s income below the base']
    : [];
  const base = { players: list, ...(caveats.length ? { incomeCaveats: caveats } : {}) };
  if (settings?.distributionMode === FULL_DISTRIBUTION)
    return { ...base, startUnknown: 'the game uses full distribution, which splits every territory among the players whatever the territory limit' };
  const mode = map?.distributionModes.find((d) => d.id === settings?.distributionMode);
  if (mode?.type !== undefined && mode.type !== 'normal')
    return { ...base, startUnknown: `the game uses the map's "${mode.name}" distribution (${mode.type}), which sets its own starting armies` };
  const territories = settings?.territoryLimit;
  const armiesPerTerritory = settings?.initialPlayerArmiesPerTerritory;
  if (territories === undefined || territories <= 0)
    return { ...base, startUnknown: "the settings do not give the territories each player started with (TerritoryLimit)" };
  if (armiesPerTerritory === undefined)
    return { ...base, startUnknown: 'the settings do not give the armies each starting territory had (InitialPlayerArmiesPerTerritory)' };
  return { ...base, start: { territories, armiesPerTerritory: Math.max(0, armiesPerTerritory) } };
}

/** GameFeed's DistributionMode for full distribution (unverified, docs/WARAPP-API.md). */
export const FULL_DISTRIBUTION = -1;

/**
 * Every player started with the same territories and armies (#119: the planner's fog prior
 * needs it): any distribution but one of the map's own that is not `normal` (a scenario sets its
 * own starts). Picks, random and full distribution give each player the same share. Unknown
 * (no settings, no DistributionMode) is not symmetric: the prior stays off.
 */
export function symmetricStart(
  settings: Pick<GameSettings, 'distributionMode'> | undefined,
  map?: Pick<GameMap, 'distributionModes'>,
): boolean {
  const mode = settings?.distributionMode;
  if (mode === undefined) return false;
  const custom = map?.distributionModes.find((d) => d.id === mode);
  return custom?.type === undefined || custom.type === 'normal';
}

/** Player states still in the game (absent counts as playing), as the profile counts them. */
const playing = (p: TrackPlayer) => (p.state ?? 'Playing') === 'Playing';

const byNum = (a: number, b: number) => a - b;

/**
 * Which term set a tracked income: `max-observed` the most it was observed to deploy,
 * `stock-flow` its visible army change plus visible losses (less fog arrivals) per turn, `visible` what it visibly
 * earns on the newest board (base + bonuses it visibly holds in full), `carried` an earlier
 * window's figure kept (#119: an income never decays unless a bonus it visibly held is visibly
 * broken, or the most it could earn falls below it).
 */
export type IncomeMethod = 'max-observed' | 'stock-flow' | 'visible' | 'carried';

/** A tracked income and how it was reached ({@link trackedIncome}). */
export interface TrackedIncome {
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
  const stockFlow = Math.max(0, Math.ceil(window.reduce((s, x) => s + x.net + x.losses - x.fogArmies, 0) / window.length));
  const cap = Math.max(...window.map((x) => x.cap));
  const flow = Math.min(cap, stockFlow);
  const fromWindow = Math.max(maxObserved, flow);
  const method: IncomeMethod = visibleIncome >= fromWindow ? 'visible' : maxObserved >= flow ? 'max-observed' : 'stock-flow';
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
  t: Pick<OpponentTrack, 'incomeMethod' | 'incomeTurns' | 'observedRange'> & Partial<Pick<OpponentTrack, 'incomeLowered'>>,
): string | null {
  if (!t.incomeMethod || !t.observedRange || !t.incomeTurns.length) return null;
  const span = turnSpan(t.incomeTurns);
  const range = `observed ${t.observedRange.min}–${t.observedRange.max}`;
  if (t.incomeMethod === 'carried')
    return t.incomeLowered
      ? `carried from ${span}, ${range}, less ${t.incomeLowered} for what it has visibly lost since`
      : `carried from ${span}, ${range}: no bonus it visibly held has been visibly broken since`;
  if (t.incomeMethod === 'max-observed') return `max observed over ${span}, ${range}`;
  if (t.incomeMethod === 'stock-flow') return `visible army growth plus losses (fog arrivals left out) over ${span}, ${range}`;
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
    if (!a || !b) continue;
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
 *   as a shrink, so it counts back;
 * - a hold of mine that fell to it: its defenders were my armies there plus what I deployed there
 *   less what I sent out of it; the board reading priced the capture at the guard (#123, the
 *   least I may have left), so the difference in what they killed (at the defensive kill rate)
 *   is the correction.
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
  let measured = 0;
  for (const m of orders.moves) {
    if (!g.territoryById.has(m.to) || !owns(visibleState(was.get(m.from)), me)) continue;
    if (owns(visibleState(was.get(m.to)), playerId) && owns(visibleState(now.get(m.to)), playerId))
      measured += straightKills(Math.max(0, m.armies), offensive);
  }
  const ids = [...new Set(after.territories.map((t) => t.territoryId))].sort(byNum);
  for (const id of ids) {
    if (!g.territoryById.has(id)) continue;
    const b = visibleState(was.get(id));
    if (!owns(b, me) || !owns(visibleState(now.get(id)), playerId)) continue;
    const defenders = Math.max(0, b!.armies! + (deployed.get(id) ?? 0) - (sent.get(id) ?? 0));
    measured += straightKills(defenders, defensive) - straightKills(Math.min(b!.armies!, guard), defensive);
  }
  return measured;
}

/**
 * What `playerId` may have lost fighting on the turn `before` → `after` (#123): on each of its
 * territories shown with armies on both boards that shrank, each neighbour of another player
 * shown with armies on both boards that shrank too (claimed once, ascending ids) counts
 * round(its shrink × offensive ÷ defensive kill rate) — the armies a failed attack that cost the
 * neighbour that many killed. Mine are left out when my orders measured the turn (`measuredMe`).
 * The board cannot tell a fight from a transfer: only the unexplained armies use it.
 */
function combatLosses(
  g: MapGraph,
  before: BoardState,
  after: BoardState,
  playerId: number,
  measuredMe: number | null,
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
      const other = shrinkOf(n);
      if (!other || other.player === playerId || other.player === measuredMe || other.shrink <= 0) continue;
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
  // One board per turn (the last given wins), oldest first.
  const byTurn = new Map<number, BoardState>();
  const ordersOn = new Map<number, MyOrders | undefined>();
  for (const b of boards) {
    byTurn.set(b.turn, b.board);
    ordersOn.set(b.turn, b.orders);
  }
  const turns = [...byTurn.keys()].sort(byNum);
  if (!turns.length) return [];
  const lastTurn = turns.at(-1)!;
  const latest = byTurn.get(lastTurn)!;
  const visibleOn = new Map<number, Map<number, { playerId: number; base: number; bonusIncome: number }>>();
  const visibleAt = (turn: number) => {
    let m = visibleOn.get(turn);
    if (!m) {
      m = new Map(enemyDeployEstimates(g, byTurn.get(turn)!, me, settings).map((e) => [e.playerId, e]));
      visibleOn.set(turn, m);
    }
    return m;
  };
  const players = game?.players ?? [];
  const teams = players.some((p) => carriesTeam(p.team));
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
        ? enemyDeployEstimates(g, after, me, settings, before).find((x) => x.playerId === playerId)
        : undefined;
      if (!e?.observation) {
        unseen.push(seesPlayer(before, g, playerId) ? to : from);
        continue;
      }
      const o = e.observation;
      const v = visibleAt(from).get(playerId);
      const visibleIncome = v ? v.base + v.bonusIncome : 0;
      const change = armyChange(g, before, after, playerId, settings.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE, me, guard);
      const net = change.net;
      // My own orders that turn, when known, are measurements (#119).
      const orders = ordersOn.get(from);
      const measured = orders ? measureOrders(g, before, after, me, playerId, orders, settings) : 0;
      const context = { me, guard, ...(o.expected !== null ? { expected: o.expected } : {}) };
      const raw = measured ? Math.max(0, observeSigned(g, after, before, playerId, settings, context).signed + measured) : e.observedRaw!;
      const losses = Math.max(0, change.losses + measured);
      // #123: with my orders known, what stood on an emptied capture is measured: no high reading.
      const low = Math.max(0, o.low + measured);
      const high = Math.max(raw, o.high + measured - (orders ? o.emptiedHigh : 0));
      const seenObserved = Math.min(raw, e.observedCap!);
      const broken = visiblyBroken(g, before, after, playerId);
      observed.push({
        from,
        to,
        observed: seenObserved,
        raw,
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
        combat: combatLosses(g, before, after, playerId, orders ? me : null, settings),
        visibleIncome,
        earned: Math.max(visibleIncome, seenObserved),
        net,
        losses,
      });
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
    const lastWindow = recent.length ? trackedIncome(recent, visibleIncome) : null;
    // #119: no decay. Walk the observed turns: each window's figure (as `trackedIncome` reads it)
    // replaces the carried one only when larger; otherwise the carried figure stays, less the
    // bonuses it visibly held that were visibly broken that turn, and never above that turn's
    // could-earn cap. The last three turns alone read a real 31 as 12 once it aged out.
    type Carry = { income: number; set: number; window: ObservedTurn[]; est: TrackedIncome };
    let carry: Carry | null = null as Carry | null;
    for (let i = 0; i < observed.length; i++) {
      const x = observed[i]!;
      const window = observed.slice(Math.max(0, i - INCOME_TURNS + 1), i + 1);
      const est = trackedIncome(window, 0);
      const prev: Carry | null = carry;
      const kept = prev ? Math.min(x.cap, prev.income - x.brokenValue) : -Infinity;
      carry = !prev || est.income >= kept ? { income: est.income, set: est.income, window, est } : { ...prev, income: kept };
    }
    const carried = carry !== null && lastWindow !== null && carry.income > lastWindow.income ? carry : null;
    const estimate = carried
      ? { ...carried.est, income: carried.income, method: 'carried' as IncomeMethod }
      : lastWindow;
    const incomeWindow = carried ? carried.window : recent;
    const income = estimate?.income ?? null;
    const unexplained = observed.length
      ? Math.max(0, observed.reduce((s, x) => s + x.earned - x.net - x.losses - x.combat, 0))
      : null;
    const gap = income !== null ? income - visibleIncome : 0;
    // #123: what it could have spent taking bonuses out of sight: its starting armies (when the
    // settings give them) plus its income every turn of the game so far.
    const budget =
      (game?.start ? game.start.territories * game.start.armiesPerTerritory : 0) + Math.max(income ?? 0, baseIncome) * Math.max(1, lastTurn);
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
      });
      if (carried)
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
    const reveals = observed.reduce((s, x) => s + x.reveals.length, 0);
    if (reveals) notes.push(`${reveals} fog reveal${reveals === 1 ? '' : 's'} skipped: stacks that only came into view are not income.`);
    const fogCaptures = observed.filter((x) => x.fromFog.length);
    if (fogCaptures.length) {
      const n = fogCaptures.reduce((s, x) => s + x.fromFog.length, 0);
      notes.push(
        `${n} capture${n === 1 ? '' : 's'} out of the fog on turn ${fogCaptures.map((x) => x.from).join(', ')}: only what ${n === 1 ? 'it' : 'they'} cost counts as deploy; no visible stack of it shrank into ${n === 1 ? 'it' : 'them'}, so the stack most likely moved in from the fog.`,
      );
    }
    // #123: the ambiguous readings, each with the other way it could read.
    const span = (xs: readonly ObservedTurn[]) => xs.map((x) => `${x.from} (${x.low}–${x.high})`).join(', ');
    const reinforcedTurns = observed.filter((x) => x.reinforced.length);
    if (reinforcedTurns.length)
      notes.push(
        `Captures with more armies than its visible stack next to them sent, on turn ${span(reinforcedTurns)}: read as armies deployed on the visible stack that attacked (deploy-then-capture); a stack out of the fog may have joined instead, the low figure.`,
      );
    const fogGrowthTurns = observed.filter((x) => x.grewFromFog.length);
    if (fogGrowthTurns.length)
      notes.push(
        `Growth next to the fog beyond its visible income, on turn ${span(fogGrowthTurns)}: read as stacks that walked in from the fog, not income; it may be income the fog hides, the high figure.`,
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
      observedRange: estimate?.observedRange ?? null,
      incomeMethod: estimate?.method ?? null,
      incomeLowered: carried ? carried.set - carried.income : 0,
      unexplained,
      inferred,
      visible,
      turnsUnseen,
      turnsUnseenAtLeast,
      earnedAtLeast,
      warnings,
      notes,
    };
  });
}
