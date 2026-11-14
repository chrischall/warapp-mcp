// The agreement ledger's pure model (docs/PLAN-TEAMS.md A2): what a recorded truce is, which
// state it is in on a turn, what my board history says about whether the partner keeps it, the
// quiet borders that read as an unspoken truce, and whether to trust it now.
//
// Principles (PLAN-TEAMS §4): an agreement exists only because the player recorded it with an
// explicit tool call — chat is never parsed into one — and words change no estimate: only the
// board raises a flag. Pure and deterministic like the planner (ties on ascending id, no I/O).
// Nothing here is used by the planner yet (part B2).
//
// Board events read off two consecutive boards with the visibility rules of `observeDeploy`: a
// territory counts only when both boards showed its owner and armies, so a fog reveal is never
// an event; and an event the fog leaves ambiguous (my covered territory lost to an owner I cannot
// see, or hit while another player or the fog also borders it) is `massing`, never `broken`.
import type { BoardState, TerritoryState } from '../board.js';
import { carriesTeam } from '../teams.js';
import { bonusTerritories } from './bonuses.js';
import { bfsDistances, neighborsOf, type MapGraph } from './graph.js';
import type { MyOrders, TurnBoard } from './opponents.js';
import { ownerShown, visibleState } from './plan/shared.js';

/** Every status an agreement can be recorded in. */
export const AGREEMENT_STATUSES = [
  'proposed-by-me',
  'proposed-by-them',
  'agreed',
  'notice-by-me',
  'notice-by-them',
  'ended',
  'broken-by-them',
  'broken-by-me',
] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

/** Statuses an agreement can be first recorded in. */
export const OPENING_STATUSES: readonly AgreementStatus[] = ['proposed-by-me', 'proposed-by-them', 'agreed'];

/** Statuses after which nothing more is recorded on the agreement (a new one is recorded instead). */
export const TERMINAL_STATUSES: ReadonlySet<AgreementStatus> = new Set(['ended', 'broken-by-them', 'broken-by-me']);

/** Which status may follow which ({@link transitionAgreement}). */
export const AGREEMENT_TRANSITIONS: Readonly<Record<AgreementStatus, readonly AgreementStatus[]>> = {
  'proposed-by-me': ['proposed-by-them', 'agreed', 'ended'],
  'proposed-by-them': ['proposed-by-me', 'agreed', 'ended'],
  agreed: ['notice-by-me', 'notice-by-them', 'ended', 'broken-by-them', 'broken-by-me'],
  'notice-by-me': ['agreed', 'ended', 'broken-by-them', 'broken-by-me'],
  'notice-by-them': ['agreed', 'ended', 'broken-by-them', 'broken-by-me'],
  ended: [],
  'broken-by-them': [],
  'broken-by-me': [],
};

/** The most turns of notice a truce can carry. */
export const MAX_NOTICE_TURNS = 3;
/** Consecutive turns of growth near the covered border that read as `massing`. */
export const TRUCE_MASSING_TURNS = 2;
/** Steps from the covered border within which the partner's growth counts as massing. */
export const TRUCE_MASSING_REACH = 2;
/** The partner's tracked income above this × mine is `outgrowing`. */
export const TRUCE_OUTGROW_RATIO = 1.5;
/** Quiet turns on a shared border, with no agreement, that read as an unspoken truce. */
export const TACIT_QUIET_TURNS = 3;
/**
 * The endgame of a truce: no other opponent's estimated income reaches this × the larger of mine
 * and the partner's. The partner no longer needs me from there on.
 */
export const TRUCE_ENDGAME_RATIO = 0.5;

/** What a truce covers: everything, some territories, or the territories of some bonuses. */
export type AgreementScope = 'all' | { territories: number[] } | { bonuses: number[] };

export interface AgreementTerms {
  scope: AgreementScope;
  /** Turns of notice either side gives before it ends (0–{@link MAX_NOTICE_TURNS}). */
  noticeTurns: number;
  /** The most armies either side keeps on a territory of the covered border. */
  borderCap?: number;
  /** The last turn it binds. */
  untilTurn?: number;
  /** It ends when this player (GameFeed id) is out of the game. */
  untilPlayerOut?: number;
  /** The player (GameFeed id) it is aimed at, when it names one. */
  against?: number;
}

export interface Agreement {
  /** Unique within its game's ledger. */
  id: string;
  /** The partner's GameFeed id. */
  with: number;
  kind: 'truce';
  status: AgreementStatus;
  /** The turn it was first recorded. */
  createdTurn: number;
  /** The turn it was agreed, once it was. */
  agreedTurn?: number;
  /** The turn notice was given (the latest notice). */
  noticeTurn?: number;
  /** The turn it reached a terminal status. */
  endedTurn?: number;
  terms: AgreementTerms;
  /** Held by a Diplomacy card (part D), not a promise. */
  enforced?: boolean;
  /** After `broken-by-me`: whether the partner retaliated (recorded by the player). */
  retaliated?: boolean;
  /** Every status it was recorded in, oldest first. */
  history: { turn: number; status: AgreementStatus }[];
}

/** A player as the ledger needs it (a GameFeed player fits). */
export interface RelationPlayer {
  id: number;
  state?: string;
  isAI?: boolean;
  humanTurnedIntoAI?: boolean;
  team?: number;
}

const byNum = (a: number, b: number) => a - b;
const alive = (p: RelationPlayer | undefined) => p !== undefined && (p.state === undefined || p.state === 'Playing');
const turnedAI = (p: RelationPlayer) => p.isAI === true || p.humanTurnedIntoAI === true;

/** The terms' end condition, as a word. */
export function endCondition(terms: AgreementTerms): 'none' | 'turn' | 'player-out' | 'turn-or-player-out' {
  const t = terms.untilTurn !== undefined;
  const p = terms.untilPlayerOut !== undefined;
  return t && p ? 'turn-or-player-out' : t ? 'turn' : p ? 'player-out' : 'none';
}

/**
 * Why `partner` cannot be a party to a truce with `me` in a game of `players`, or `undefined`
 * when it can: it must be in the game, not me, human, still playing and not my teammate, and a
 * truce needs a third player — none in a 1v1 or once only two players remain.
 */
export function partyRefusal(players: readonly RelationPlayer[], me: number, partner: number): string | undefined {
  const p = players.find((x) => x.id === partner);
  if (!p) return `player ${partner} is not in this game`;
  if (partner === me) return 'that is you';
  if (players.length <= 2) return 'a 1v1 has no third player: there is nothing a truce could leave aside';
  if (turnedAI(p)) return `player ${partner} is an AI${p.humanTurnedIntoAI ? ' (a human turned into one)' : ''}: it keeps no agreement`;
  if (!alive(p)) return `player ${partner} is no longer playing (${p.state})`;
  const mine = players.find((x) => x.id === me);
  if (mine && carriesTeam(mine.team) && p.team === mine.team) return `player ${partner} is your teammate`;
  if (players.filter(alive).length <= 2) return 'only two players remain: there is nothing a truce could leave aside';
  // Someone must stand outside me, my team and the partner's team, or the truce leaves nothing aside.
  const sameTeam = (x: RelationPlayer, y: RelationPlayer | undefined) => y !== undefined && carriesTeam(x.team) && x.team === y.team;
  const third = players.some((x) => alive(x) && x.id !== me && x.id !== partner && !sameTeam(x, mine) && !sameTeam(x, p));
  if (!third) return "no third player or team remains outside you, your team and the partner's team: there is nothing a truce could leave aside";
  return undefined;
}

/** Why `scope` names something not on the map, or `undefined` when every id exists. */
export function scopeRefusal(graph: MapGraph, scope: AgreementScope): string | undefined {
  if (scope === 'all') return undefined;
  if ('territories' in scope) {
    if (!scope.territories.length) return 'the scope lists no territory';
    const missing = scope.territories.filter((t) => !graph.territoryById.has(t));
    return missing.length ? `territories ${missing.join(', ')} are not on this map` : undefined;
  }
  if (!scope.bonuses.length) return 'the scope lists no bonus';
  const missing = scope.bonuses.filter((b) => !graph.bonusById.has(b));
  return missing.length ? `bonuses ${missing.join(', ')} are not on this map` : undefined;
}

/** A new agreement, first recorded on `turn` in `status` (one of {@link OPENING_STATUSES}). */
export function newAgreement(id: string, partner: number, status: AgreementStatus, turn: number, terms: AgreementTerms): Agreement {
  return {
    id,
    with: partner,
    kind: 'truce',
    status,
    createdTurn: turn,
    ...(status === 'agreed' ? { agreedTurn: turn } : {}),
    terms,
    history: [{ turn, status }],
  };
}

/**
 * `agreement` moved to `status` on `turn`, or the reason it cannot be: a terminal agreement
 * takes nothing more, and only the moves in {@link AGREEMENT_TRANSITIONS} are allowed. Notice
 * stamps `noticeTurn`, agreeing stamps `agreedTurn` (the first time), a terminal status stamps
 * `endedTurn`; withdrawing notice (back to `agreed`) clears `noticeTurn`.
 */
export function transitionAgreement(
  agreement: Agreement,
  status: AgreementStatus,
  turn: number,
): { agreement: Agreement } | { refused: string } {
  if (TERMINAL_STATUSES.has(agreement.status)) {
    return { refused: `agreement ${agreement.id} is already ${agreement.status}: record a new one instead` };
  }
  if (!AGREEMENT_TRANSITIONS[agreement.status].includes(status)) {
    return {
      refused: `agreement ${agreement.id} cannot go from ${agreement.status} to ${status} (allowed: ${AGREEMENT_TRANSITIONS[agreement.status].join(', ')})`,
    };
  }
  const next: Agreement = { ...agreement, status, history: [...agreement.history, { turn, status }] };
  if (status === 'agreed' && next.agreedTurn === undefined) next.agreedTurn = turn;
  if (status === 'agreed') delete next.noticeTurn;
  if (status === 'notice-by-me' || status === 'notice-by-them') next.noticeTurn = turn;
  if (TERMINAL_STATUSES.has(status)) next.endedTurn = turn;
  return { agreement: next };
}

export type AgreementPhase = 'proposed' | 'active' | 'notice' | 'over';
export type OverReason =
  | 'ended'
  | 'broken-by-them'
  | 'broken-by-me'
  | 'partner-out'
  | 'partner-ai'
  | 'two-left'
  | 'player-out'
  | 'until-turn'
  | 'notice-served';

export interface AgreementState {
  phase: AgreementPhase;
  /** In notice: the first turn it no longer binds. */
  endsTurn?: number;
  /** Over: why. */
  reason?: OverReason;
}

/**
 * An agreement's state on `turn`: `proposed` (not agreed yet), `active`, in `notice` (with the
 * first turn it no longer binds: the notice turn + its notice turns), or `over` — when recorded
 * ended or broken, when the partner is eliminated (or otherwise no longer playing) or became an
 * AI, when only two players remain, when its `untilPlayerOut` player is out, past its
 * `untilTurn`, or once its notice has run.
 */
export function agreementState(agreement: Agreement, turn: number, players: readonly RelationPlayer[]): AgreementState {
  const s = agreement.status;
  if (s === 'ended' || s === 'broken-by-them' || s === 'broken-by-me') return { phase: 'over', reason: s };
  const partner = players.find((p) => p.id === agreement.with);
  if (!partner || !alive(partner)) return { phase: 'over', reason: 'partner-out' };
  if (turnedAI(partner)) return { phase: 'over', reason: 'partner-ai' };
  if (players.filter(alive).length <= 2) return { phase: 'over', reason: 'two-left' };
  const out = agreement.terms.untilPlayerOut;
  if (out !== undefined && !alive(players.find((p) => p.id === out))) return { phase: 'over', reason: 'player-out' };
  const until = agreement.terms.untilTurn;
  if (until !== undefined && turn > until) return { phase: 'over', reason: 'until-turn' };
  if (s === 'proposed-by-me' || s === 'proposed-by-them') return { phase: 'proposed' };
  if ((s === 'notice-by-me' || s === 'notice-by-them') && agreement.noticeTurn !== undefined) {
    const endsTurn = agreement.noticeTurn + agreement.terms.noticeTurns;
    const capped = until !== undefined ? Math.min(endsTurn, until + 1) : endsTurn;
    return turn >= capped ? { phase: 'over', reason: 'notice-served' } : { phase: 'notice', endsTurn: capped };
  }
  return { phase: 'active' };
}

/** My territories in `scope` among `mine`, ascending. */
export function coveredTerritories(graph: MapGraph, scope: AgreementScope, mine: ReadonlySet<number>): number[] {
  let ids: Iterable<number>;
  if (scope === 'all') ids = mine;
  else if ('territories' in scope) ids = scope.territories;
  else ids = scope.bonuses.flatMap((b) => [...bonusTerritories(graph, b)]);
  return [...new Set(ids)].filter((t) => mine.has(t)).sort(byNum);
}

const ownerOn = (t: TerritoryState | undefined): number | null =>
  t && t.owner.kind === 'player' ? t.owner.playerId : null;

function territoryMap(board: BoardState): Map<number, TerritoryState> {
  return new Map(board.territories.map((t) => [t.territoryId, t]));
}

function mineOn(board: BoardState, me: number): Set<number> {
  return new Set(board.territories.filter((t) => ownerShown(t) && ownerOn(t) === me).map((t) => t.territoryId));
}

/** What my orders say should stand on `t` after the turn (deploys, moves out, moves in from mine). */
function expectedArmies(t: number, before: number, orders: MyOrders, mine: ReadonlySet<number>): number {
  let n = before;
  for (const d of orders.deploys) if (d.territoryId === t) n += d.armies;
  for (const m of orders.moves) {
    if (m.from === t) n -= m.armies;
    if (m.to === t && mine.has(m.from)) n += m.armies;
  }
  return n;
}

/**
 * Whether a transfer of mine into `t` may not have arrived in full: its source is no longer shown
 * as mine, or holds fewer armies than my orders leave there (it was hit, so the move may never have
 * run). A shortfall on `t` is then not evidence against anyone.
 */
function fedByHitSource(
  t: number,
  orders: MyOrders,
  mine: ReadonlySet<number>,
  was: ReadonlyMap<number, TerritoryState>,
  now: ReadonlyMap<number, TerritoryState>,
  me: number,
): boolean {
  return orders.moves.some((m) => {
    if (m.to !== t || !mine.has(m.from)) return false;
    const after = ownerShown(now.get(m.from));
    if (!after || ownerOn(after) !== me) return true;
    const before = visibleState(was.get(m.from))?.armies;
    const nowArmies = visibleState(after)?.armies;
    if (before == null || nowArmies == null) return true;
    return nowArmies < expectedArmies(m.from, before, orders, mine);
  });
}

export type WatchFlagKind = 'broken' | 'cap-exceeded' | 'massing' | 'outgrowing' | 'kept';

export interface WatchFlag {
  kind: WatchFlagKind;
  /** The turn whose orders showed it (the earlier board's turn), or the board's turn for a standing condition. */
  turn: number;
  /** The territories that are the evidence, ascending. */
  territories: number[];
  /** One plain sentence: what the boards showed. */
  evidence: string;
  /** A `massing` flag raised for an event the fog left ambiguous. */
  ambiguous?: boolean;
  /** `cap-exceeded`: the largest stack over the cap and the cap. */
  armies?: number;
  cap?: number;
  /** `massing` (growth): the partner's visible growth over the turns compared. */
  growth?: number;
  /** `outgrowing`: the partner's income over mine. */
  ratio?: number;
  /** `kept`: consecutive quiet turns up to the newest board. */
  quietTurns?: number;
}

export interface BreachInput {
  agreement: Agreement;
  graph: MapGraph;
  /** My boards (any order; one per turn, the last given wins), each with my orders when known. */
  boards: readonly TurnBoard[];
  /** My GameFeed id. */
  me: number;
  /** Incomes for `outgrowing`: mine and the partner's tracked estimate (`null`: unknown). */
  incomes?: { mine: number; partner: number | null };
}

/**
 * What my boards say about the partner keeping `agreement`, over the consecutive turns from the
 * one it was agreed (and before it ended), as flags with their turn and evidence:
 * - `broken`: the partner took a covered territory of mine, or attacked one (my orders known,
 *   armies lost there, only the partner — visibly — borders it, and no transfer of mine in came
 *   from a source taken or hit, which may never have arrived);
 * - `cap-exceeded` (newest board): a visible partner territory beside a covered one holds more
 *   than the cap;
 * - `massing`: the partner's visible armies within {@link TRUCE_MASSING_REACH} steps of the
 *   covered border grew for the last {@link TRUCE_MASSING_TURNS} turns up to the newest board
 *   (territories visible on both boards only: a fog reveal is no growth), or an event the fog
 *   leaves ambiguous;
 * - `outgrowing`: its income passed {@link TRUCE_OUTGROW_RATIO} × mine;
 * - `kept`: the consecutive quiet turns up to the newest board (when nothing broke).
 * A proposal that was never agreed has no flags.
 */
export function breachWatch(input: BreachInput): WatchFlag[] {
  const { agreement: a, graph, me } = input;
  if (a.agreedTurn === undefined) return [];
  const partner = a.with;
  const byTurn = new Map<number, TurnBoard>();
  for (const b of input.boards) byTurn.set(b.turn, b);
  const turns = [...byTurn.keys()].sort(byNum);
  const flags: WatchFlag[] = [];
  const inWindow = (t: number) => t >= a.agreedTurn! && (a.endedTurn === undefined || t < a.endedTurn);
  // Consecutive pairs whose earlier board's orders fall within the agreement.
  const pairs = turns
    .filter((t) => byTurn.has(t + 1) && inWindow(t))
    .map((t) => ({ from: byTurn.get(t)!, to: byTurn.get(t + 1)! }));
  const growthByTurn = new Map<number, number>();
  const eventTurns = new Set<number>();
  for (const { from, to } of pairs) {
    const was = territoryMap(from.board);
    const now = territoryMap(to.board);
    const mine = mineOn(from.board, me);
    const covered = coveredTerritories(graph, a.terms.scope, mine);
    const taken: number[] = [];
    const attacked: number[] = [];
    const ambiguous: number[] = [];
    for (const c of covered) {
      const after = now.get(c);
      const shown = ownerShown(after);
      const neighbours = neighborsOf(graph, c);
      const partnerNext = neighbours.some((n) => ownerOn(ownerShown(was.get(n))) === partner || ownerOn(ownerShown(now.get(n))) === partner);
      if (shown && ownerOn(shown) === partner) {
        taken.push(c);
        continue;
      }
      if (!shown) {
        // Lost to an owner I cannot see.
        if (partnerNext) ambiguous.push(c);
        continue;
      }
      if (ownerOn(shown) !== me || !from.orders) continue;
      const before = visibleState(was.get(c))?.armies;
      const nowArmies = visibleState(after)?.armies;
      if (before == null || nowArmies == null) continue;
      if (expectedArmies(c, before, from.orders, mine) - nowArmies <= 0) continue;
      // Armies lost on a territory still mine: who could have hit it? Mine and visible neutrals
      // cannot; a fogged neighbour or another player could.
      if (!partnerNext) continue;
      // A transfer of mine in whose source was taken or hit may never have arrived: open, not a break.
      if (fedByHitSource(c, from.orders, mine, was, now, me)) {
        ambiguous.push(c);
        continue;
      }
      const onlyPartner = neighbours.every((n) => {
        const t = ownerShown(was.get(n));
        if (t === undefined) return false;
        return t.owner.kind === 'neutral' || ownerOn(t) === me || ownerOn(t) === partner;
      });
      (onlyPartner ? attacked : ambiguous).push(c);
    }
    const turn = from.turn;
    if (taken.length) {
      flags.push({ kind: 'broken', turn, territories: taken, evidence: `took territories ${taken.join(', ')} on turn ${turn}` });
      eventTurns.add(turn);
    }
    if (attacked.length) {
      flags.push({
        kind: 'broken',
        turn,
        territories: attacked,
        evidence: `attacked territories ${attacked.join(', ')} on turn ${turn} (armies lost beyond my orders; only it borders them)`,
      });
      eventTurns.add(turn);
    }
    if (ambiguous.length) {
      flags.push({
        kind: 'massing',
        turn,
        territories: ambiguous,
        ambiguous: true,
        evidence: `territories ${ambiguous.join(', ')} were lost or hit on turn ${turn} beside it, but the fog or another player leaves who did it open`,
      });
      eventTurns.add(turn);
    }
    // Its visible armies near the covered border (both boards show them: no fog reveal counts).
    const zone = bfsDistances(graph, covered);
    let growth = 0;
    for (const [t, d] of zone) {
      if (d === 0 || d > TRUCE_MASSING_REACH) continue;
      const b = visibleState(was.get(t));
      const n = visibleState(now.get(t));
      if (!b || !n) continue;
      const armiesOf = (x: TerritoryState) => (ownerOn(x) === partner ? (x.armies ?? 0) : 0);
      growth += armiesOf(n) - armiesOf(b);
    }
    growthByTurn.set(turn, growth);
  }
  // Massing: growth on each of the last TRUCE_MASSING_TURNS consecutive pairs.
  // The pairs must run up to the newest board: growth followed by a gap is old news.
  const recent = pairs.slice(-TRUCE_MASSING_TURNS).map((p) => p.from.turn);
  if (
    recent.length === TRUCE_MASSING_TURNS &&
    recent.at(-1)! + 1 === turns.at(-1) &&
    recent.every((t, i) => i === 0 || t === recent[i - 1]! + 1) &&
    recent.every((t) => (growthByTurn.get(t) ?? 0) > 0)
  ) {
    const growth = recent.reduce((s, t) => s + growthByTurn.get(t)!, 0);
    const last = recent.at(-1)!;
    const covered = coveredTerritories(graph, a.terms.scope, mineOn(byTurn.get(last + 1)!.board, me));
    flags.push({
      kind: 'massing',
      turn: last,
      territories: covered,
      growth,
      evidence: `its visible armies within ${TRUCE_MASSING_REACH} steps of the covered border grew by ${growth} over turns ${recent[0]}–${last}`,
    });
  }
  // The cap, on the newest board.
  const newest = turns.at(-1);
  if (a.terms.borderCap !== undefined && newest !== undefined && newest >= a.agreedTurn && (a.endedTurn === undefined || newest <= a.endedTurn)) {
    const board = byTurn.get(newest)!.board;
    const at = territoryMap(board);
    const covered = coveredTerritories(graph, a.terms.scope, mineOn(board, me));
    const over = new Map<number, number>();
    for (const c of covered)
      for (const n of neighborsOf(graph, c)) {
        const t = visibleState(at.get(n));
        if (t && ownerOn(t) === partner && (t.armies ?? 0) > a.terms.borderCap) over.set(n, t.armies ?? 0);
      }
    if (over.size) {
      const ids = [...over.keys()].sort(byNum);
      const armies = Math.max(...over.values());
      flags.push({
        kind: 'cap-exceeded',
        turn: newest,
        territories: ids,
        armies,
        cap: a.terms.borderCap,
        evidence: `territories ${ids.join(', ')} on the covered border hold up to ${armies}, over the cap of ${a.terms.borderCap}`,
      });
    }
  }
  if (input.incomes && input.incomes.partner !== null && input.incomes.mine > 0) {
    const ratio = Math.round((input.incomes.partner / input.incomes.mine) * 100) / 100;
    if (input.incomes.partner > TRUCE_OUTGROW_RATIO * input.incomes.mine) {
      flags.push({
        kind: 'outgrowing',
        turn: newest ?? a.agreedTurn,
        territories: [],
        ratio,
        evidence: `its estimated income ${input.incomes.partner} is ${ratio}× mine (${input.incomes.mine}), above ${TRUCE_OUTGROW_RATIO}×`,
      });
    }
  }
  if (!flags.some((f) => f.kind === 'broken') && pairs.length) {
    let quiet = 0;
    for (let i = pairs.length - 1; i >= 0; i--) {
      const t = pairs[i]!.from.turn;
      if (eventTurns.has(t) || (i < pairs.length - 1 && pairs[i + 1]!.from.turn !== t + 1)) break;
      quiet++;
    }
    if (quiet > 0) {
      const last = pairs.at(-1)!.from.turn;
      flags.push({ kind: 'kept', turn: last, territories: [], quietTurns: quiet, evidence: `${quiet} quiet turn${quiet === 1 ? '' : 's'} up to turn ${last}` });
    }
  }
  return flags;
}

export interface TacitTruce {
  player: number;
  /** Consecutive quiet turns up to the newest board (at least {@link TACIT_QUIET_TURNS}). */
  quietTurns: number;
  /** My territories on the shared border (newest board), ascending. */
  border: number[];
}

/**
 * Neighbours with no agreement (`exclude` lists those with one) whose shared border with me saw
 * no deploy from either side, no attack and no change of hands for at least
 * {@link TACIT_QUIET_TURNS} consecutive turns up to the newest board. Reported, never planned on.
 * Their side counts only where both boards showed it; a turn whose border it cannot see is not
 * quiet. Without my orders, my side is quiet when its armies did not grow.
 */
export function tacitTruces(input: { graph: MapGraph; boards: readonly TurnBoard[]; me: number; exclude?: ReadonlySet<number> }): TacitTruce[] {
  const { graph, me } = input;
  const byTurn = new Map<number, TurnBoard>();
  for (const b of input.boards) byTurn.set(b.turn, b);
  const turns = [...byTurn.keys()].sort(byNum);
  const newest = turns.at(-1);
  if (newest === undefined) return [];
  const latest = territoryMap(byTurn.get(newest)!.board);
  const latestMine = mineOn(byTurn.get(newest)!.board, me);
  const players = new Set<number>();
  for (const m of latestMine)
    for (const n of neighborsOf(graph, m)) {
      const o = ownerOn(ownerShown(latest.get(n)));
      if (o !== null && o !== me && !input.exclude?.has(o)) players.add(o);
    }
  const out: TacitTruce[] = [];
  for (const p of [...players].sort(byNum)) {
    let quiet = 0;
    for (let t = newest - 1; byTurn.has(t) && byTurn.has(t + 1); t--) {
      if (!quietTurn(graph, byTurn.get(t)!, byTurn.get(t + 1)!, me, p)) break;
      quiet++;
    }
    if (quiet < TACIT_QUIET_TURNS) continue;
    const border = [...latestMine].filter((m) => neighborsOf(graph, m).some((n) => ownerOn(ownerShown(latest.get(n))) === p)).sort(byNum);
    out.push({ player: p, quietTurns: quiet, border });
  }
  return out;
}

function quietTurn(graph: MapGraph, from: TurnBoard, to: TurnBoard, me: number, p: number): boolean {
  const was = territoryMap(from.board);
  const now = territoryMap(to.board);
  const mine = mineOn(from.board, me);
  let border = 0;
  for (const m of [...mine].sort(byNum)) {
    const theirs = neighborsOf(graph, m).filter((n) => ownerOn(ownerShown(was.get(n))) === p);
    if (!theirs.length) continue;
    border++;
    if (ownerOn(ownerShown(now.get(m))) !== me) return false;
    const mb = visibleState(was.get(m))?.armies;
    const mn = visibleState(now.get(m))?.armies;
    if (mb == null || mn == null) return false;
    if (from.orders) {
      if (from.orders.deploys.some((d) => d.territoryId === m && d.armies > 0)) return false;
      if (from.orders.moves.some((x) => x.from === m && theirs.includes(x.to))) return false;
      if (expectedArmies(m, mb, from.orders, mine) > mn) return false;
    } else if (mn > mb) return false;
    for (const n of theirs) {
      const b = visibleState(was.get(n));
      const a = visibleState(now.get(n));
      if (!b || !a || ownerOn(a) !== p) return false;
      if ((a.armies ?? 0) > (b.armies ?? 0)) return false;
    }
  }
  return border > 0;
}

/**
 * Whether a truce is in its endgame: no other opponent's estimated income reaches
 * {@link TRUCE_ENDGAME_RATIO} × the larger of mine and the partner's (so the partner no longer
 * needs me). With no other opponent left it is.
 */
export function truceEndgame(input: { mine: number; partner: number; others: readonly number[] }): boolean {
  const bar = TRUCE_ENDGAME_RATIO * Math.max(input.mine, input.partner);
  return !input.others.some((o) => o >= bar);
}

export interface TrustVerdict {
  level: 'clear' | 'watch';
  /** Why `watch`, plain words; empty when `clear`. */
  reasons: string[];
}

/**
 * Whether to rely on a live agreement now: `watch` on any flag but `kept`, on their notice, and in
 * the endgame ({@link truceEndgame}); otherwise `clear`. Words in chat never move this — only the
 * board does.
 */
export function trust(agreement: Agreement, flags: readonly WatchFlag[], context: { endgame?: boolean }): TrustVerdict {
  const reasons: string[] = [];
  for (const kind of ['broken', 'cap-exceeded', 'massing', 'outgrowing'] as const)
    if (flags.some((f) => f.kind === kind)) reasons.push(`flag: ${kind}`);
  if (agreement.status === 'notice-by-them') reasons.push('they gave notice');
  if (context.endgame) reasons.push('endgame: no other opponent is still a match for either of us');
  return { level: reasons.length ? 'watch' : 'clear', reasons };
}
