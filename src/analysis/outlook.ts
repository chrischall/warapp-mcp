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
// `high` against the highest `low` (`null`: no upper limit). It is per player: in a team game my
// strength alone against the single strongest opponent, teams are not summed.
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
// when even the high ratio is at most 1 / OUTLOOK_RATIO, `stalemate` when neither and no territory
// in view on both boards changed owner since the turn before while I face an enemy and (#201) the
// main front's multi-turn forecast is a stand-off, else `even`. The main front (#218: `mainFront`,
// exchange.ts, the planner's definition) is the biggest enemy stack next to me against my biggest
// stack beside it, both owners deploying their whole income there every turn (`forecastBorder`):
// mine off my board, theirs the tracked income (its visible income at least) — and on the turn
// being played, when the plan's `front` is that pair (`front` input), the plan's incomes, so the
// plan's front outlook and this forecast agree. A front that breaks or grinds me down within the
// horizon is not stuck, however quiet the last turns were; the basis says what the front assumed.
// The outlook reports a state only once it has held for OUTLOOK_TURNS consecutive turns; until
// then `state` is null and the basis says what each turn read.
//
// OUTLOOK_RATIO (2.4×) is borrowed from a published bot's "lost" rule and has never been measured
// for war.app: the outlook is a basis for a decision, not a verdict. The planner acts on it in one
// way only (#201): once winning or losing, its payback tests count the turns the game has left.

import type { BoardState } from '../board.js';
import { holdsSeat } from '../player-states.js';
import { carriesTeam } from '../teams.js';
import { neighborsOf, type MapGraph } from './graph.js';
import { DEFAULT_TERRITORY_LIMIT, trackOpponents, type TrackGame, type TurnBoard } from './opponents.js';
import { ownerShown, type PlannerSettings } from './planner.js';
import { bonusTerritories } from './bonuses.js';
import { cardArmiesBy, type CardArmyCeiling } from '../strategy/card-clock.js';
import { boardIncome, DEFAULT_BASE_INCOME, territoryIncome } from './player.js';
import { STRENGTH_INCOME_TURNS } from './profile.js';
import { FORECAST_TURNS, forecastBorder, mainFront, type BorderOutcome, type FrontStack } from './exchange.js';
import { specialUnitStrength } from './combat.js';

/** Turns a state must hold before it is reported. */
export const OUTLOOK_TURNS = 3;
/** Winning at this strength ratio or more, losing at its inverse or less (borrowed, unmeasured). */
export const OUTLOOK_RATIO = 2.4;
/** #208: the likely high lets an opponent earn up to this many times its tracked income every turn (unmeasured). */
export const LIKELY_INCOME_MARGIN = 2;

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

export type OutlookState = 'winning' | 'losing' | 'even' | 'stalemate';

export interface OutlookTurn {
  turn: number;
  /** My strength: armies + k × income. */
  mine: number;
  /** The strongest opponent (by `high`, unbounded first, then `low`, then id); `null` when there is none. */
  strongest: { playerId: number; low: number; high: number | null } | null;
  /** Mine ÷ the opponents' strength: `low` against the highest high (0 when unbounded or that high is 0), `high` against the highest low (`null`: no limit). */
  ratio: { low: number; high: number | null };
  /**
   * #208: the opponent with the highest likely high — an ESTIMATE, not a bound (see the header) —
   * and mine ÷ it. Absent with every opponent in full view, or any unbounded.
   */
  likely?: {
    playerId: number;
    high: number;
    ratio: number;
    /** #214: `tracked` from its observed income, `prior` from at least its even share of the map's income. */
    source: LikelySource;
    /** #214: with a prior, why — `unseen` (no territory in view now) or `unmeasured` (no observed income). */
    why?: PriorWhy;
  };
  /** #208: `true` when the state is `winning` on the likely high alone (the bound did not show it). */
  estimated?: true;
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
  state: OutlookState;
}

export interface GameOutlook {
  /** The state, once it held for {@link OUTLOOK_TURNS} turns; `null` until then. */
  state: OutlookState | null;
  /** How many of the latest turns read the newest turn's state. */
  heldTurns: number;
  /** The turns judged (the latest {@link OUTLOOK_TURNS} consecutive ones), oldest first. */
  turns: OutlookTurn[];
  /** Strength = armies + `k` × income. */
  k: number;
  threshold: number;
  /** One paragraph: the measure, the latest turn's figures, the thresholds and why they are not a verdict. */
  basis: string;
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
  for (const b of input.boards) byTurn.set(b.turn, b);
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
  const teamGame = players.some((p) => carriesTeam(p.team));
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
      | Map<number, { visible: number; income: number | null; visibleIncome: number; observed: { to: number; observed: number }[] }>
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
    const mine = (armies.get(me) ?? 0) + k * boardIncome(g, held.get(me) ?? new Set(), rules).total;
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
        const none = { likely: undefined as number | undefined, source: undefined as LikelySource | undefined, why: undefined as PriorWhy | undefined };
        if (open) return { playerId, low, high: low as number | null, ...none };
        if (start === null || likelyStart === null || cardsBound === undefined) return { playerId, low, high: null, ...none };
        // Each turn's could-earn cap: from that turn's board when I have it, else the ceiling.
        let received = start;
        for (let t = 1; t <= turn; t++) received += turnCap(t, playerId);
        const cap = Math.max(income, turnCap(turn, playerId));
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
        return { playerId, low, high, likely: Math.min(high, Math.max(low, likely)), source, why };
      });
    const maxLow = rows.reduce((m, r) => Math.max(m, r.low), 0);
    const unbounded = rows.some((r) => r.high === null);
    const maxHigh = rows.reduce((m, r) => Math.max(m, r.high ?? 0), 0);
    const top =
      [...rows].sort(
        (a, b) =>
          (a.high === null ? 0 : 1) - (b.high === null ? 0 : 1) || (b.high ?? 0) - (a.high ?? 0) || b.low - a.low || a.playerId - b.playerId,
      )[0];
    const strongest = top ? { playerId: top.playerId, low: top.low, high: top.high } : null;
    const ratio = {
      low: !unbounded && maxHigh > 0 ? round2(mine / maxHigh) : 0,
      high: maxLow > 0 ? round2(mine / maxLow) : null,
    };
    // #208: the highest likely high, when every opponent is bounded and one is not in full view.
    let likely: OutlookTurn['likely'];
    if (!unbounded && !open && rows.length) {
      const top = [...rows].sort((a, b) => (b.likely ?? 0) - (a.likely ?? 0) || a.playerId - b.playerId)[0]!;
      const high = top.likely ?? 0;
      likely = {
        playerId: top.playerId,
        high,
        ratio: high > 0 ? round2(mine / high) : 0,
        source: top.source ?? 'tracked',
        ...(top.why ? { why: top.why } : {}),
      };
    }
    // Every opponent bounded at no strength at all while I have some: dominated.
    const dominated = rows.length > 0 && !unbounded && maxHigh === 0 && mine > 0;
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
    if (main) {
      const given =
        input.front && input.front.turn === turn && input.front.from === main.from && input.front.at === main.at ? input.front : undefined;
      // Their income: the plan's estimate on the turn being played; else what the tracker reads
      // off my boards (its tracked income, its visible income at least).
      const tr = given ? undefined : trackedAll().get(main.player);
      const myIncome = given?.myIncome ?? boardIncome(g, mineNow, rules).total;
      const theirIncome =
        given?.theirIncome ?? Math.max(boardIncome(g, held.get(main.player) ?? new Set(), rules).total, tr?.income ?? 0);
      const f = forecastBorder({
        mine: main.mine,
        theirs: main.theirs,
        myIncome,
        theirIncome,
        outcomeOnly: true,
        settings: {
          ...(settings.offensiveKillRate !== undefined ? { offensiveKillRate: settings.offensiveKillRate } : {}),
          ...(settings.defensiveKillRate !== undefined ? { defensiveKillRate: settings.defensiveKillRate } : {}),
          ...(settings.oneArmyStandsGuard !== undefined ? { oneArmyStandsGuard: settings.oneArmyStandsGuard } : {}),
        },
      });
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
    const bound = dominated || (rows.length > 0 && ratio.low >= OUTLOOK_RATIO);
    const estimated = !bound && likely !== undefined && likely.high > 0 && likely.ratio >= OUTLOOK_RATIO;
    const state: OutlookState =
      bound || estimated
        ? 'winning'
        : ratio.high !== null && ratio.high <= 1 / OUTLOOK_RATIO
          ? 'losing'
          : changed === 0 && front && (!forecast || forecast.outcome === 'stand-off')
            ? 'stalemate'
            : 'even';
    return {
      turn,
      mine,
      strongest,
      ratio,
      ...(likely ? { likely } : {}),
      changed,
      ...(forecast ? { front: forecast } : {}),
      state,
      ...(estimated ? { estimated: true as const } : {}),
    };
  });

  const last = turns.at(-1);
  let heldTurns = 0;
  for (let i = turns.length - 1; i >= 0 && turns[i]!.state === last?.state; i--) heldTurns++;
  const state = last && heldTurns >= OUTLOOK_TURNS ? last.state : null;
  const measure = `Strength = armies + ${k} × income; an opponent's is a range under fog (low: what is in view; high: the most it could have received and earn). Per player: my strength alone against the single strongest opponent, teams not summed.${teamGame ? ' In a team game a teammate can transfer armies to an opponent, so its high is not a ceiling.' : ''}`;
  const thresholds = `Winning at ${OUTLOOK_RATIO}× the strongest opponent or more even at its high, losing at 1/${OUTLOOK_RATIO} (${round2(1 / OUTLOOK_RATIO)}×) or less even at its low, stalemate when nothing in view changed hands for ${OUTLOOK_TURNS} turns along a front whose forecast is a stand-off. The ${OUTLOOK_RATIO}× is borrowed from a bot and was never measured for war.app: a basis for a decision, not a verdict.`;
  let reading: string;
  if (!last) reading = 'No board to judge.';
  else {
    const s = last.strongest;
    const figures = s
      ? `turn ${last.turn}: mine ${last.mine}, the strongest opponent player ${s.playerId} at ${s.high === s.low ? s.low : `${s.low}–${s.high ?? 'unbounded'}`}, ratio ${last.ratio.high === last.ratio.low ? last.ratio.low : `${last.ratio.low}–${last.ratio.high ?? 'unbounded'}`}×`
      : `turn ${last.turn}: mine ${last.mine}, no opponent to compare`;
    // #208: the likely high, said as what it is; #214: a prior says so and why, and an estimate
    // that does not show a win names the opponent that blocks it.
    const l = last.likely;
    const rests = l?.source === 'prior'
      ? `for player ${l.playerId} a prior (${l.why === 'unmeasured' ? 'no observed income: no pair of my boards measured its deploy' : 'no territory in view now'}), paced by its peers: it starts as a symmetric opening, and each turn earns ${LIKELY_INCOME_MARGIN === 2 ? 'twice' : `${LIKELY_INCOME_MARGIN}×`} the higher of my income that turn (ramped up from the opening's before my first board) and the most any opponent was tracked earning by then (the base income at least), at most an even share of the map's income (${evenShare}) and that turn's cap, and at least ${LIKELY_INCOME_MARGIN}× its visible income (and any income tracked earlier)${l.why === 'unmeasured' ? '' : ', and at least the armies and income it held when last in view'}`
      : `each turn at most ${LIKELY_INCOME_MARGIN}× the income the tracker reads off my boards`;
    let est = '';
    if (l && (l.high !== s?.high || l.source === 'prior'))
      est = ` The likely high — an estimate, not a bound: ${rests} — is player ${l.playerId} at ${l.high}, ratio ${l.ratio}×${last.estimated ? '; winning rests on it' : ''}.`;
    if (l && l.high > 0 && last.state !== 'winning')
      est += ` Player ${l.playerId} blocks a win on the estimate: winning needs mine at ${OUTLOOK_RATIO}× its likely high (${round2(OUTLOOK_RATIO * l.high)}), and mine is ${last.mine}.`;
    reading =
      turns.length < OUTLOOK_TURNS
        ? `Only ${turns.length} turn${turns.length === 1 ? '' : 's'} of boards in a row (${OUTLOOK_TURNS} needed), so no state yet; ${figures}.`
        : state
          ? `${state[0]!.toUpperCase()}${state.slice(1)} for ${OUTLOOK_TURNS} turns running; ${figures}.`
          : `${last.state[0]!.toUpperCase()}${last.state.slice(1)} for ${heldTurns} of the ${OUTLOOK_TURNS} turns (${turns.map((t) => t.state).join(', ')}), so no state yet; ${figures}.`;
    reading += est;
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
  return { state, heldTurns, turns, k, threshold: OUTLOOK_RATIO, basis: `${reading} ${measure} ${thresholds}` };
}
