// The agreement ledger's pure model (docs/PLAN-TEAMS.md A2): what a recorded truce is, which
// state it is in on a turn, what my board history says about whether the partner keeps it, the
// quiet borders that read as an unspoken truce, and whether to trust it now.
//
// Principles (PLAN-TEAMS §4): an agreement exists only because the player recorded it with an
// explicit tool call — chat is never parsed into one — and words change no estimate: only the
// board raises a flag. Pure and deterministic like the planner (ties on ascending id, no I/O).
// `planRelationsFrom` resolves the ledger into the planner's `relations` (part B2); `priceTruce` prices a
// deal by planning with and without it (part B3), the planner called, never changed.
//
// Board events read off two consecutive boards with the visibility rules of `observeDeploy`: a
// territory counts only when both boards showed its owner and armies, so a fog reveal is never
// an event; and an event the fog leaves ambiguous (my covered territory lost to an owner I cannot
// see, or hit while another player or the fog also borders it) is `massing`, never `broken`.
import type { BoardState, TerritoryState } from '../board.js';
import { carriesTeam, teammatesOf } from '../teams.js';
import { bonusTerritories } from './bonuses.js';
import { bfsDistances, neighborsOf, type MapGraph } from './graph.js';
import type { MyOrders, TurnBoard } from './opponents.js';
import {
  ownerShown,
  OWNERS_SHOWN_FOG,
  visibleState,
  type PlanInput,
  type PlanRelation,
  ruleOnly,
  type TruceBreakLoss,
  type TruceWatchReason,
  type TurnPlan,
} from './plan/shared.js';
import { planTurn } from './planner.js';

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
  /**
   * Partner-approved exceptions (oldest first; absent when none): attacks on covered territories the
   * partner agreed to, for some turns, that are no break. Never a status change.
   */
  exceptions?: AgreementException[];
}

/**
 * Who an exception lets attack: `mine` — the partner agreed I may attack its covered territories;
 * `theirs` — I agreed the partner may attack (or take) covered territories of mine.
 */
export const EXCEPTION_DIRECTIONS = ['mine', 'theirs'] as const;
export type ExceptionDirection = (typeof EXCEPTION_DIRECTIONS)[number];
/** Exceptions kept per agreement (the newest). */
export const MAX_EXCEPTIONS = 50;
/** The longest note an exception keeps (the owner's own words, names scrubbed). */
export const MAX_EXCEPTION_NOTE = 200;

/** One partner-approved exception to a truce: these territories, these turns (inclusive), one direction. */
export interface AgreementException {
  /** Unique within its agreement: `e1`, `e2`, … */
  id: string;
  direction: ExceptionDirection;
  /** The territories it lets be attacked, ascending. */
  territories: number[];
  /** The first and last turn it applies (inclusive). */
  fromTurn: number;
  toTurn: number;
  /** The turn it was recorded. */
  recordedTurn: number;
  /** The owner's own words, player names scrubbed to `Player <id>`; absent when none. */
  note?: string;
}

/** The next exception id on `a`: `e1`, `e2`, … */
export function nextExceptionId(a: Pick<Agreement, 'exceptions'>): string {
  const n = (a.exceptions ?? []).reduce((m, e) => Math.max(m, Number(/^e(\d+)$/.exec(e.id)?.[1] ?? 0)), 0);
  return `e${n + 1}`;
}

/** `a` with `exceptions` appended (fresh ids), at most {@link MAX_EXCEPTIONS} kept (the newest). */
export function withExceptions(a: Agreement, exceptions: readonly Omit<AgreementException, 'id'>[]): Agreement {
  let next: Agreement = a;
  for (const e of exceptions) next = { ...next, exceptions: [...(next.exceptions ?? []), { id: nextExceptionId(next), ...e }] };
  return next.exceptions && next.exceptions.length > MAX_EXCEPTIONS ? { ...next, exceptions: next.exceptions.slice(-MAX_EXCEPTIONS) } : next;
}

/** The territories `a`'s exceptions in `direction` open on `turn` (the turn's orders), ascending. */
export function exceptedOn(a: Pick<Agreement, 'exceptions'>, turn: number, direction: ExceptionDirection): Set<number> {
  const out = new Set<number>();
  for (const e of a.exceptions ?? []) if (e.direction === direction && e.fromTurn <= turn && turn <= e.toTurn) for (const t of e.territories) out.add(t);
  return out;
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
 * A covered territory under a `theirs` exception on a turn (the partner may attack it by agreement) raises
 * nothing that turn. A proposal that was never agreed has no flags.
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
    // A `theirs` exception on this turn: the partner may attack or take these by agreement — no event.
    const allowed = exceptedOn(a, from.turn, 'theirs');
    for (const c of covered) {
      if (allowed.has(c)) continue;
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

/** B2: what the plan resolves the ledger from. */
export interface PlanRelationsInput {
  agreements: readonly Agreement[];
  graph: MapGraph;
  /** My board this turn (the covered territories are read on it). */
  board: BoardState;
  /** My boards, oldest first, this turn's included, each with my orders when known. */
  boards: readonly TurnBoard[];
  me: number;
  turn: number;
  players: readonly RelationPlayer[];
  /** My income and each opponent's estimate (`null`: unknown), for `outgrowing` and the endgame. */
  incomes: { mine: number | null; opponents: ReadonlyMap<number, number | null> };
  /**
   * PLAN-TEAMS D3 (T9): the Diplomacy cards between me and a player that the active-card decoder is
   * sure of this turn (`cardsInEffect`, src/analysis/cards-in-effect.ts), with the turn each is gone by.
   */
  diplomacy?: readonly { player: number; untilTurn: number }[];
  /**
   * T9 too: my allies in the Diplomacy 2 mod (GameFeed ids; src/mod-alliances.ts). The game skips every attack
   * between us this turn, but either side may enter a break this turn that no one else can see and that applies
   * at its end, so the alliance is enforced until next turn only (`enforcedUntil` = turn + 1): its player still
   * counts for next turn's look-ahead.
   */
  modAllies?: readonly number[];
}

/** The flag kinds that make the trust `watch`, as the planner names them. */
const WATCH_KINDS = ['broken', 'cap-exceeded', 'massing', 'outgrowing'] as const satisfies readonly WatchFlagKind[];

/**
 * B2: the agreements the planner reads this turn — every one agreed and `active` or in `notice`,
 * with its covered territories on both sides (on `board`), its watch flags, the trust and why,
 * and the border cap; one the partner broke (a `broken` flag, never ambiguous) as `broken` with
 * the evidence (T8: an ordinary opponent at once). `enforced` (T9) comes only from `diplomacy`, the
 * Diplomacy cards the decoder is sure of (PLAN-TEAMS D3), never from the ledger's own field: an
 * agreement active or in notice with that player is marked enforced until the card is gone, and a
 * player with none gets a relation of its own (`card: 'Diplomacy'`, every territory of each side
 * covered). Also the tacit truces with every neighbour no open agreement names and off my team
 * (#435): reported, never planned on.
 */
/** One agreement an order list would break (`truceBreaksIn`). */
export interface TruceBreak {
  agreement: string;
  with: number;
  state: 'active' | 'notice';
  /** The orders (index in the list given) that attack a territory of the partner the agreement covers. */
  moves: { index: number; from: number; to: number }[];
  /** The Bombs (index in the `bombs` list given) on a territory of the partner the agreement covers; absent when none. */
  bombs?: { index: number; target: number }[];
}

/**
 * B2 (warapp_submit_turn): the active or in-notice agreements that `moves` would break — an order that
 * attacks a territory the partner holds on `board` and the terms cover (a transfer-only order attacks
 * nothing), or a Bomb (`bombs`, the targets) on such a territory — except one a `mine` exception opens on `turn`
 * (the partner agreed to it). By agreement id; empty when nothing binds. Pure; reads only the ledger's own agreements and
 * the board (the breach watch is not consulted: a break by them is recorded as broken-by-them first).
 */
export function truceBreaksIn(input: {
  agreements: readonly Agreement[];
  graph: MapGraph;
  board: BoardState;
  me: number;
  turn: number;
  players: readonly RelationPlayer[];
  moves: readonly { from: number; to: number; mode?: string }[];
  bombs?: readonly number[];
}): TruceBreak[] {
  const out: TruceBreak[] = [];
  for (const a of [...input.agreements].sort((x, y) => x.id.localeCompare(y.id))) {
    if (a.with === input.me) continue;
    const state = agreementState(a, input.turn, input.players);
    if (state.phase !== 'active' && state.phase !== 'notice') continue;
    const held = new Set(input.board.territories.filter((t) => ownerShown(t) && ownerOn(t) === a.with).map((t) => t.territoryId));
    // A `mine` exception on this turn: the partner agreed to these attacks — no break.
    const allowed = exceptedOn(a, input.turn, 'mine');
    const covered = new Set(coveredTerritories(input.graph, a.terms.scope, held).filter((t) => !allowed.has(t)));
    const moves = input.moves.flatMap((m, index) => (m.mode !== 'transfer-only' && covered.has(m.to) ? [{ index, from: m.from, to: m.to }] : []));
    const bombs = (input.bombs ?? []).flatMap((target, index) => (covered.has(target) ? [{ index, target }] : []));
    if (moves.length || bombs.length) out.push({ agreement: a.id, with: a.with, state: state.phase, moves, ...(bombs.length ? { bombs } : {}) });
  }
  return out;
}

export function planRelationsFrom(input: PlanRelationsInput): { relations: PlanRelation[]; tacit: TacitTruce[] } {
  const { graph, board, me, turn, players, incomes } = input;
  const holding = (p: number) =>
    new Set(board.territories.filter((t) => ownerShown(t) && ownerOn(t) === p).map((t) => t.territoryId));
  const mine = holding(me);
  const relations: PlanRelation[] = [];
  for (const a of [...input.agreements].sort((x, y) => x.id.localeCompare(y.id))) {
    const state = agreementState(a, turn, players);
    if (state.phase !== 'active' && state.phase !== 'notice') continue;
    const partnerIncome = incomes.opponents.get(a.with);
    const flags = breachWatch({
      agreement: a,
      graph,
      boards: input.boards,
      me,
      ...(incomes.mine !== null ? { incomes: { mine: incomes.mine, partner: partnerIncome ?? null } } : {}),
    });
    const others = [...incomes.opponents].filter(([id]) => id !== a.with);
    const endgame =
      incomes.mine !== null && partnerIncome !== null && partnerIncome !== undefined && others.every(([, v]) => v !== null)
        ? truceEndgame({ mine: incomes.mine, partner: partnerIncome, others: others.map(([, v]) => v!) })
        : false;
    const verdict = trust(a, flags, { endgame });
    const watch: TruceWatchReason[] = WATCH_KINDS.filter((k) => flags.some((f) => f.kind === k));
    if (a.status === 'notice-by-them') watch.push('their-notice');
    if (endgame) watch.push('endgame');
    const broke = flags.find((f) => f.kind === 'broken' && !f.ambiguous);
    // Partner-approved exceptions on this turn: those territories are no longer covered (normal targets
    // for me, or open to the partner), and the plan lists them.
    const exceptMine = exceptedOn(a, turn, 'mine');
    const exceptTheirs = exceptedOn(a, turn, 'theirs');
    const coveredMine = coveredTerritories(graph, a.terms.scope, mine);
    const coveredTheirs = coveredTerritories(graph, a.terms.scope, holding(a.with));
    const exceptions = [
      { direction: 'mine' as const, territories: coveredTheirs.filter((t) => exceptMine.has(t)) },
      { direction: 'theirs' as const, territories: coveredMine.filter((t) => exceptTheirs.has(t)) },
    ].filter((e) => e.territories.length);
    relations.push({
      player: a.with,
      coveredMine: coveredMine.filter((t) => !exceptTheirs.has(t)),
      coveredTheirs: coveredTheirs.filter((t) => !exceptMine.has(t)),
      ...(exceptions.length ? { exceptions } : {}),
      state: broke ? 'broken' : state.phase,
      ...(state.endsTurn !== undefined ? { endsTurn: state.endsTurn } : {}),
      ...(a.terms.borderCap !== undefined ? { borderCap: a.terms.borderCap } : {}),
      trust: verdict.level,
      ...(watch.length ? { watch } : {}),
      // T9: `a.enforced` is never read in. No tool writes it, and only a Diplomacy card the decoder is
      // sure of (part D) may make a player no foe; a hand-edited ledger must not do it indefinitely.
      agreement: a.id,
      ...(a.status === 'notice-by-me' ? { noticeBy: 'me' as const } : a.status === 'notice-by-them' ? { noticeBy: 'them' as const } : {}),
      ...(broke
        ? { breach: { term: 'took or attacked a covered territory of mine', turn: broke.turn, evidence: broke.evidence, territories: [...broke.territories] } }
        : {}),
    });
  }
  // T9: the Diplomacy 2 mod's alliances, a game rule like a card: enforced this turn whatever the ledger says.
  for (const player of [...new Set(input.modAllies ?? [])].sort((x, y) => x - y)) {
    if (player === me) continue;
    const bound = relations.filter((r) => r.player === player && (r.state === 'active' || r.state === 'notice'));
    for (const r of bound) {
      r.enforced = true;
      r.enforcedUntil = turn + 1;
      r.mod = 'Diplomacy 2';
    }
    if (bound.length) continue;
    relations.push({
      player,
      coveredMine: [...mine].sort((x, y) => x - y),
      coveredTheirs: [...holding(player)].sort((x, y) => x - y),
      state: 'active',
      trust: 'clear',
      enforced: true,
      enforcedUntil: turn + 1,
      mod: 'Diplomacy 2',
    });
  }
  // D3 (T9): the Diplomacy cards in effect. A card is a game rule, not a promise: it binds whatever the ledger says.
  for (const d of [...(input.diplomacy ?? [])].sort((x, y) => x.player - y.player)) {
    if (d.player === me || d.untilTurn <= turn) continue;
    const bound = relations.filter((r) => r.player === d.player && (r.state === 'active' || r.state === 'notice'));
    for (const r of bound) {
      r.enforced = true;
      // A mod alliance enforcing it already: the card keeps it at least as long.
      r.enforcedUntil = r.enforcedUntil !== undefined ? Math.max(r.enforcedUntil, d.untilTurn) : d.untilTurn;
    }
    if (bound.length) continue;
    relations.push({
      player: d.player,
      coveredMine: [...mine].sort((x, y) => x - y),
      coveredTheirs: [...holding(d.player)].sort((x, y) => x - y),
      state: 'active',
      trust: 'clear',
      enforced: true,
      enforcedUntil: d.untilTurn,
      card: 'Diplomacy',
    });
  }
  // #435: a teammate's quiet border is no tacit truce (#246): left out like a partner with an open
  // agreement, as warapp_get_relations already did — plan_turn, check_plan and advise_diplomacy listed them.
  const self = players.find((p) => p.id === me);
  const open = new Set([
    ...input.agreements.filter((a) => !TERMINAL_STATUSES.has(a.status)).map((a) => a.with),
    ...(self ? teammatesOf(players, self).map((p) => p.id) : []),
  ]);
  return { relations, tacit: tacitTruces({ graph, boards: input.boards, me, exclude: open }) };
}

// ---------- B3: pricing a deal (docs/PLAN-TEAMS.md section 8 B3) ----------
//
// A truce is priced by planning the turn twice — without it and with it — on the same input, and
// comparing the plans. The planner is called, never changed. What the partner gains is read off the
// visible board only, and is an estimate. Words change no estimate: nothing here reads chat, and the
// partner's record (owner decision D5) is the board-derived history of what it did, never what it said.

/** The turns a suggested truce runs (its `untilTurn` is this turn + this). */
export const SUGGESTED_TRUCE_TURNS = 5;
/** The turns of notice a suggested truce carries. */
export const SUGGESTED_NOTICE_TURNS = 1;
/**
 * Armies freed of at least this share of my income are worth a proposal on their own (B1's measure:
 * a truce worth having frees a fifth of the turn's income).
 */
export const TRUCE_MATERIAL_SHARE = 0.2;
/** A partner whose record keeps this share of its agreements or more reads as one who keeps them. */
export const RECORD_KEPT_RATE = 0.75;
/** A partner whose record keeps less than this share reads as one who breaks them. */
export const RECORD_BROKE_RATE = 0.5;

/** The partner's record (D5) as the pricing reads it: its tallies and the facts that bear on a break. */
export interface RecordFacts {
  made: number;
  kept: number;
  endedWithNotice: number;
  brokenByThem: number;
  keptRate: number | null;
  theirNotice: { honoured: number; broken: number };
  brokenByThemInEndgame: number;
  brokenByThemLeading: number;
}

/** What the record says, in one word: no finished agreement yet, kept, mixed, or broke. */
export type Reliability = 'unknown' | 'kept' | 'mixed' | 'broke';

/** The record's reading: `unknown` with no finished agreement, else by its kept rate. */
export function reliabilityOf(record: RecordFacts | null | undefined): Reliability {
  if (!record || record.keptRate === null) return 'unknown';
  if (record.keptRate >= RECORD_KEPT_RATE) return 'kept';
  if (record.keptRate < RECORD_BROKE_RATE) return 'broke';
  return 'mixed';
}

/** A rough reading of the partner's side of a deal, from the visible board only (an estimate). */
export interface PartnerReading {
  estimate: true;
  /** Third players (not me, not the partner) with a visible territory beside a visible one of the partner's, ascending. */
  otherFronts: number[];
  /** Visible neutrals beside its visible territories. */
  neutralsBeside: number;
  /** Some territory of its borders the fog: it may have more room than shows. */
  fogBeside: boolean;
  /** Its visible armies on its territories beside my covered ones: what my keeping the truce lets it use elsewhere. */
  armiesOnBorder: number;
  /** Whether the deal leaves it room to grow: another front or a neutral beside it; `null` when only the fog might. */
  roomToGrow: boolean | null;
}

/** B3: one truce priced against the no-deal plan (`priceTruce`). */
export interface TrucePrice {
  player: number;
  /** My territories and the partner's that the terms cover on this board, ascending. */
  coveredMine: number[];
  coveredTheirs: number[];
  /**
   * The truce as the plan with it reads it: a recorded truce with this player keeps the board's
   * reading of it (`planRelationsFrom`: its state — `broken` with the breach, T8 — its trust and
   * its watch flags); a new one is `active`, `clear` unless the caller says `watch` (the endgame).
   */
  state: 'active' | 'notice' | 'broken';
  /** In notice: the first turn it no longer binds, and who gave the notice. */
  endsTurn?: number;
  noticeBy?: 'me' | 'them';
  trust: 'clear' | 'watch';
  watch: TruceWatchReason[];
  breach?: PlanRelation['breach'];
  /** Whether the plan with the truce honours it (only in a free-for-all; never under `watch` trust for the relaxing). */
  honoured: boolean;
  /** The plan's view of the hypothetical truce (T2's relaxed borders, T3's full holds). */
  relaxed: number[];
  fullHold: { territory: number; why: 'commander' | 'value' | 'watch' }[];
  /** The armies the relaxed holds need less this turn (the plan's `armiesFreed`). */
  armiesFreed: number;
  /** Captures the plan makes only with the truce, and those it makes only without, ascending. */
  capturesGained: number[];
  capturesLost: number[];
  bonusesGained: number[];
  bonusesLost: number[];
  /** Next turn's income with the truce less without (the captures' worth). */
  incomeGained: number;
  /** Borders conceded without the truce and held with it, and the reverse, ascending. */
  concededAvoided: number[];
  concededAdded: number[];
  /** Covered territories of the partner the no-deal plan attacks: what keeping the truce gives up, ascending. */
  attacksForgone: number[];
  /** T6 on the plan with the truce: what a break this turn would cost. */
  lossIfBroken: TruceBreakLoss | null;
  /** The partner's side, read off the visible board: an estimate. */
  partner: PartnerReading;
  /** The partner's record (D5), when on and kept, and its reading. */
  record: RecordFacts | null;
  reliability: Reliability;
  /** Warnings the plan with the truce gives that the plan without it does not (a cap's cost, say). */
  warnings: string[];
}

const ownedBy = (t: TerritoryState | undefined, p: number) => {
  const s = ownerShown(t);
  return s !== undefined && ownerOn(s) === p;
};

/** B3: the partner's side of a deal from the visible board (an estimate; see {@link PartnerReading}). */
export function partnerReading(graph: MapGraph, board: BoardState, me: number, partner: number, coveredMine: readonly number[]): PartnerReading {
  const at = territoryMap(board);
  const theirs = board.territories.filter((t) => ownedBy(t, partner)).map((t) => t.territoryId).sort(byNum);
  const fronts = new Set<number>();
  const neutrals = new Set<number>();
  let fogBeside = false;
  for (const t of theirs)
    for (const n of neighborsOf(graph, t)) {
      const s = ownerShown(at.get(n));
      if (!s) fogBeside = true;
      else if (s.owner.kind === 'neutral') neutrals.add(n);
      else {
        const o = ownerOn(s);
        if (o !== null && o !== me && o !== partner) fronts.add(o);
      }
    }
  const covered = new Set(coveredMine);
  let armiesOnBorder = 0;
  for (const t of theirs)
    if (neighborsOf(graph, t).some((n) => covered.has(n))) armiesOnBorder += visibleState(at.get(t))?.armies ?? 0;
  const roomToGrow = fronts.size > 0 || neutrals.size > 0 ? true : fogBeside ? null : false;
  return { estimate: true, otherFronts: [...fronts].sort(byNum), neutralsBeside: neutrals.size, fogBeside, armiesOnBorder, roomToGrow };
}

const minus = (a: readonly number[], b: readonly number[]) => {
  const s = new Set(b);
  return [...new Set(a)].filter((x) => !s.has(x)).sort(byNum);
};

/**
 * B3: price a truce with `player` on `terms` — plan the turn without it (any other relation in
 * `input` kept, a recorded one with this player taken out) and with it, and compare. The truce
 * planned with is `active`, trust `clear` — unless `input` holds a relation with `player`, whose
 * board reading it keeps (state, `broken` with its breach or `notice` with its end, trust and
 * watch flags: so a recorded truce is priced on the plan warapp_plan_turn makes, and a partner the
 * board flags is never priced as trusted) — with `opts.trust` / `opts.watch` (an endgame) added.
 * Compared: the armies freed, the
 * captures, bonuses and next income gained or lost, the borders no longer conceded, the partner's
 * covered territories the no-deal plan attacks (what the truce gives up), and T6's `lossIfBroken`.
 * Plus a rough reading of the partner's side from the visible board, marked as an estimate, and its
 * record (D5) when given. Pure and deterministic: the planner is called, never changed, and `input`
 * is not mutated. `opts.without` reuses a no-deal plan already made on the same input, and is
 * ignored when `input` holds a relation with `player`: a plan on that input already carries the
 * truce, so it is no no-deal plan (priced against it, every gain would read zero).
 */
export function priceTruce(
  input: PlanInput,
  player: number,
  terms: AgreementTerms,
  opts: { without?: TurnPlan; record?: RecordFacts | null; trust?: 'clear' | 'watch'; watch?: readonly TruceWatchReason[]; agreement?: string } = {},
): TrucePrice {
  const holding = (p: number) => new Set(input.board.territories.filter((t) => ownedBy(t, p)).map((t) => t.territoryId));
  // D3: a Diplomacy card in effect with this player binds with or without the deal, so both plans keep it.
  const enforcing = (input.relations ?? []).find((r) => r.player === player && r.enforced);
  const card: PlanRelation[] = enforcing
    ? [
        {
          player,
          coveredMine: [...holding(input.me)].sort(byNum),
          coveredTheirs: [...holding(player)].sort(byNum),
          state: 'active',
          trust: 'clear',
          enforced: true,
          ...(enforcing.enforcedUntil !== undefined ? { enforcedUntil: enforcing.enforcedUntil } : {}),
          // A Diplomacy 2 alliance binds like a card, with or without the deal.
          ...(enforcing.mod && !enforcing.card ? { mod: enforcing.mod } : { card: 'Diplomacy' as const }),
        },
      ]
    : [];
  const others = [...(input.relations ?? []).filter((r) => r.player !== player), ...card];
  const { relations: _given, ...rest } = input;
  const base: PlanInput = others.length ? { ...rest, relations: others } : rest;
  const reusable = !card.length && others.length === (input.relations ?? []).length;
  const without = (reusable ? opts.without : undefined) ?? planTurn(base);
  const coveredMine = coveredTerritories(input.graph, terms.scope, holding(input.me));
  const coveredTheirs = coveredTerritories(input.graph, terms.scope, holding(player));
  // The board's reading of a recorded truce with this player (planRelationsFrom) is kept: words
  // never clear a flag, and a price never trusts more than warapp_plan_turn does (PLAN-TEAMS §4).
  const standing = (input.relations ?? []).find((r) => r.player === player && !ruleOnly(r));
  const watch = [...new Set([...(standing?.watch ?? []), ...(opts.watch ?? [])])];
  const trusted: 'clear' | 'watch' = standing?.trust === 'watch' || opts.trust === 'watch' ? 'watch' : 'clear';
  const state = standing?.state ?? 'active';
  const hypothetical: PlanRelation = {
    player,
    coveredMine,
    coveredTheirs,
    state,
    ...(state === 'notice' && standing?.endsTurn !== undefined ? { endsTurn: standing.endsTurn } : {}),
    ...(state === 'notice' && standing?.noticeBy !== undefined ? { noticeBy: standing.noticeBy } : {}),
    ...(state === 'broken' && standing?.breach ? { breach: standing.breach } : {}),
    ...(terms.borderCap !== undefined ? { borderCap: terms.borderCap } : {}),
    trust: trusted,
    ...(watch.length ? { watch } : {}),
    ...(opts.agreement !== undefined ? { agreement: opts.agreement } : standing?.agreement !== undefined ? { agreement: standing.agreement } : {}),
  };
  const withPlan = planTurn({ ...base, relations: [...others, hypothetical] });
  const view = withPlan.relations?.find((r) => r.player === player && !r.card);
  const theirCovered = new Set(coveredTheirs);
  const attacksForgone = [...new Set(without.moves.filter((m) => m.kind === 'attack' && theirCovered.has(m.to)).map((m) => m.to))].sort(byNum);
  const seen = new Set(without.warnings);
  return {
    player,
    coveredMine,
    coveredTheirs,
    state,
    ...(hypothetical.endsTurn !== undefined ? { endsTurn: hypothetical.endsTurn } : {}),
    ...(hypothetical.noticeBy !== undefined ? { noticeBy: hypothetical.noticeBy } : {}),
    trust: trusted,
    watch,
    ...(hypothetical.breach ? { breach: hypothetical.breach } : {}),
    honoured: view?.honoured ?? false,
    relaxed: view?.relaxed ?? [],
    fullHold: view?.fullHold ?? [],
    armiesFreed: view?.armiesFreed ?? 0,
    capturesGained: minus(withPlan.expected.captures, without.expected.captures),
    capturesLost: minus(without.expected.captures, withPlan.expected.captures),
    bonusesGained: minus(withPlan.expected.bonusesCompleted, without.expected.bonusesCompleted),
    bonusesLost: minus(without.expected.bonusesCompleted, withPlan.expected.bonusesCompleted),
    incomeGained: withPlan.expected.nextIncome - without.expected.nextIncome,
    concededAvoided: minus(without.conceded, withPlan.conceded),
    concededAdded: minus(withPlan.conceded, without.conceded),
    attacksForgone,
    lossIfBroken: view?.lossIfBroken ?? null,
    partner: partnerReading(input.graph, input.board, input.me, player, coveredMine),
    record: opts.record ?? null,
    reliability: reliabilityOf(opts.record),
    warnings: withPlan.warnings.filter((w) => !seen.has(w)),
  };
}

export type TruceVerdictKind = 'propose' | 'accept-if-offered' | 'no';

export interface TruceVerdict {
  verdict: TruceVerdictKind;
  /** Plain sentences, ids only: why. */
  reasons: string[];
}

/** Whether a break this turn would cost me anything on the board (territory, armies, a bonus, my commander). */
const breakCosts = (l: TruceBreakLoss | null) => l !== null && (l.commanderLost || l.territories.length > 0 || l.bonusValue > 0 || l.armies > 0);

/** Each watch flag in plain words, for a verdict's reasons. */
const WATCH_WORDS: Readonly<Record<TruceWatchReason, string>> = {
  broken: 'a covered territory of mine was lost or hit beside it',
  'cap-exceeded': 'it keeps more than the cap on the covered border',
  massing: 'it is massing armies beside the covered border',
  outgrowing: 'its income has outgrown mine',
  'their-notice': 'it gave notice',
  endgame: 'endgame: no other opponent is still a match for either of us, so the partner no longer needs me',
};

/**
 * B3: the verdict on a priced truce. `no` when the partner broke it (`state: 'broken'`, T8: an
 * ordinary opponent at once), when I already gave notice on it (it is ending: withdraw the notice or
 * propose new terms), when the plan would not honour it, when the board puts it under
 * watch (its flags, their notice, the endgame: every covered border keeps its full hold, so it
 * frees nothing to rely on), when it gains nothing
 * this turn (no armies freed, no income, no border kept), when a break would cost my commander, or
 * when the partner's record reads `broke` and a break would cost me anything. `propose` when it gains
 * something material (income, a border kept, or armies freed of at least {@link TRUCE_MATERIAL_SHARE}
 * of my income), gives up no planned attack, a break would cost no more income than it gains, the
 * partner has room to grow elsewhere (else it has little reason to keep it) and its record does not
 * read `broke`; otherwise `accept-if-offered`.
 */
export function truceVerdict(price: TrucePrice, income: number): TruceVerdict {
  const reasons: string[] = [];
  const p = price.player;
  if (price.state === 'broken') {
    const b = price.breach;
    return {
      verdict: 'no',
      reasons: [
        `player ${p} broke the truce${b ? `: ${b.term} on turn ${b.turn} (${b.evidence})` : ''}; it is an ordinary opponent now, and no truce is priced as trusted (T8)`,
      ],
    };
  }
  if (price.state === 'notice' && price.noticeBy === 'me')
    return {
      verdict: 'no',
      reasons: [
        `I already gave notice on this truce with player ${p}: it ${price.endsTurn !== undefined ? `no longer binds from turn ${price.endsTurn}` : 'is ending'}. ` +
          'To keep a truce, withdraw the notice or propose new terms',
      ],
    };
  if (!price.honoured) return { verdict: 'no', reasons: [`the plan would not honour a truce with player ${p} this turn (not a free-for-all, or nothing of it binds)`] };
  if (price.lossIfBroken?.commanderLost)
    return { verdict: 'no', reasons: [`a break this turn would take my commander (from ${price.lossIfBroken.from} on ${price.lossIfBroken.to})`] };
  if (price.trust === 'watch') {
    const flags = price.watch.map((w) => WATCH_WORDS[w]);
    const holds = price.fullHold.length ? `; every covered border facing it keeps its full hold (${price.fullHold.map((f) => `${f.territory}: ${f.why}`).join(', ')})` : '';
    return { verdict: 'no', reasons: [`under watch (${flags.length ? flags.join('; ') : 'the board flags it'}): nothing it frees can be relied on${holds}`] };
  }
  const gained = price.armiesFreed > 0 || price.incomeGained > 0 || price.concededAvoided.length > 0;
  if (!gained) {
    const why = price.fullHold.length
      ? `every covered border facing it keeps its full hold (${price.fullHold.map((f) => `${f.territory}: ${f.why}`).join(', ')})`
      : price.relaxed.length
        ? 'the relaxed borders free no armies the plan would have spent'
        : 'no covered border of mine faces only it';
    return { verdict: 'no', reasons: [`it frees nothing this turn: ${why}`] };
  }
  if (price.reliability === 'broke' && breakCosts(price.lossIfBroken))
    return { verdict: 'no', reasons: [`its record reads as one who breaks agreements (kept rate ${price.record?.keptRate}), and a break this turn would cost me`] };
  const material = price.incomeGained > 0 || price.concededAvoided.length > 0 || price.armiesFreed >= Math.max(1, Math.ceil(TRUCE_MATERIAL_SHARE * income));
  const bits: string[] = [];
  if (price.armiesFreed > 0) bits.push(`frees ${price.armiesFreed} armies`);
  if (price.incomeGained > 0) bits.push(`+${price.incomeGained} next income`);
  if (price.capturesGained.length) bits.push(`captures ${price.capturesGained.join(', ')}`);
  if (price.concededAvoided.length) bits.push(`holds ${price.concededAvoided.join(', ')}, conceded without it`);
  reasons.push(`it ${bits.join('; ')}`);
  let propose = material;
  if (!material) reasons.push(`the gain is small (under ${Math.round(TRUCE_MATERIAL_SHARE * 100)}% of my income ${income})`);
  if (price.attacksForgone.length) {
    propose = false;
    reasons.push(`keeping it gives up the planned attack${price.attacksForgone.length === 1 ? '' : 's'} on ${price.attacksForgone.join(', ')}`);
  }
  const lossIncome = price.lossIfBroken?.bonusValue ?? 0;
  if (lossIncome > Math.max(0, price.incomeGained)) {
    propose = false;
    reasons.push(`a break this turn would cost +${lossIncome} income, more than it gains`);
  }
  if (price.partner.roomToGrow === false) {
    propose = false;
    reasons.push('the partner has no other front and no neutral beside it in view: it gains little from a truce and may not keep it (an estimate)');
  }
  if (price.reliability === 'broke') {
    propose = false;
    reasons.push(`its record reads as one who breaks agreements (kept rate ${price.record?.keptRate})`);
  } else if (price.reliability === 'kept') reasons.push(`its record reads as one who keeps agreements (kept rate ${price.record?.keptRate})`);
  return { verdict: propose ? 'propose' : 'accept-if-offered', reasons };
}

/** B3: the three checks on an offer (the research's), and whether to stress-test first. */
export interface OfferChecks {
  /**
   * My gain rests on their keeping it: armies freed or a border kept that the plan without it
   * concedes — both come from thinner holds facing them (T2), which a break takes. A gain that is
   * only captures and income, with no hold thinned (armies kept from an attack on them I give up),
   * survives a break: `false`.
   */
  iGainOnlyIfTheyKeepIt: boolean;
  /** Complying while they break costs me: a break this turn takes territory, armies, a bonus or my commander. */
  iLoseIfIComplyAndTheyDoNot: boolean;
  /** They gain from my compliance: it spares a planned attack of mine, or frees their border armies for another front or a neutral (an estimate). */
  theyGainFromMyCompliance: boolean;
  /** All three: check the plan against a break (warapp_check_plan) before agreeing. */
  stressTestFirst: boolean;
  reasons: string[];
}

export function offerChecks(price: TrucePrice): OfferChecks {
  const reasons: string[] = [];
  const thinned = price.armiesFreed > 0 || price.concededAvoided.length > 0;
  reasons.push(
    thinned
      ? 'what it gains me comes from thinner holds on borders that face them'
      : price.incomeGained > 0 || price.capturesGained.length > 0
        ? 'what it gains me comes from armies kept from an attack on them, not from thinner holds: it survives a break'
        : 'it gains me nothing this turn',
  );
  const lose = breakCosts(price.lossIfBroken);
  const l = price.lossIfBroken;
  reasons.push(
    lose && l
      ? `a break this turn (from ${l.from} on ${l.to}) would cost ${l.territories.length} territor${l.territories.length === 1 ? 'y' : 'ies'}, ${l.armies} armies${l.bonusValue ? `, +${l.bonusValue} income` : ''}${l.commanderLost ? ', my commander' : ''}`
      : 'a break this turn would cost me nothing on the board',
  );
  const r = price.partner;
  const freesThem = r.armiesOnBorder > 0 && (r.otherFronts.length > 0 || r.neutralsBeside > 0);
  const theirs = price.attacksForgone.length > 0 || freesThem;
  reasons.push(
    price.attacksForgone.length
      ? `it spares their ${price.attacksForgone.join(', ')} from my planned attack`
      : freesThem
        ? `it frees their ${r.armiesOnBorder} armies on the border for ${r.otherFronts.length ? 'another front' : 'the neutrals beside them'} (an estimate)`
        : 'it frees nothing of theirs that shows',
  );
  return {
    iGainOnlyIfTheyKeepIt: thinned,
    iLoseIfIComplyAndTheyDoNot: lose,
    theyGainFromMyCompliance: theirs,
    stressTestFirst: thinned && lose && theirs,
    reasons,
  };
}

/** B3: the border I share with a neighbour on the board. */
export interface SharedBorder {
  /** My territories beside one of its, ascending. */
  mine: number[];
  /** Its territories beside one of mine, ascending. */
  theirs: number[];
  /** Of either side, those that are chokepoints (`findChokepoints`), ascending. */
  chokepoints: number[];
  /** The armies on each side's border territories (visible ones only on its side). */
  myArmies: number;
  theirArmies: number;
  /** Its border territories whose armies the fog hides. */
  theirHidden: number;
  /** The largest stack on either side (what a suggested cap leaves where it stands). */
  largestStack: number;
}

export function sharedBorder(graph: MapGraph, board: BoardState, me: number, partner: number, chokepoints: ReadonlySet<number>): SharedBorder {
  const at = territoryMap(board);
  const mineB = new Set<number>();
  const theirsB = new Set<number>();
  for (const t of board.territories) {
    if (!ownedBy(t, me)) continue;
    for (const n of neighborsOf(graph, t.territoryId))
      if (ownedBy(at.get(n), partner)) {
        mineB.add(t.territoryId);
        theirsB.add(n);
      }
  }
  const mine = [...mineB].sort(byNum);
  const theirs = [...theirsB].sort(byNum);
  const armies = (t: number) => visibleState(at.get(t))?.armies ?? null;
  const myArmies = mine.reduce((s, t) => s + (armies(t) ?? 0), 0);
  const theirArmies = theirs.reduce((s, t) => s + (armies(t) ?? 0), 0);
  const theirHidden = theirs.filter((t) => armies(t) === null).length;
  const largestStack = Math.max(0, ...[...mine, ...theirs].map((t) => armies(t) ?? 0));
  return {
    mine,
    theirs,
    chokepoints: [...mine, ...theirs].filter((t) => chokepoints.has(t)).sort(byNum),
    myArmies,
    theirArmies,
    theirHidden,
    largestStack,
  };
}

/**
 * B3: the terms suggested for a truce on `border`: scope by the named territories on both sides,
 * {@link SUGGESTED_NOTICE_TURNS} turn of notice, a cap at the largest stack standing there now (so
 * neither side has to move armies back, and any build-up shows as `cap-exceeded`), and an end
 * {@link SUGGESTED_TRUCE_TURNS} turns on when the turn is known.
 */
export function suggestedTerms(border: SharedBorder, turn: number | null | undefined): AgreementTerms {
  return {
    scope: { territories: [...new Set([...border.mine, ...border.theirs])].sort(byNum) },
    noticeTurns: SUGGESTED_NOTICE_TURNS,
    ...(border.largestStack > 0 ? { borderCap: border.largestStack } : {}),
    ...(turn != null ? { untilTurn: turn + SUGGESTED_TRUCE_TURNS } : {}),
  };
}

/** Whether a player sees something under a game's fog: `unknown` for a fog name not listed. */
export type Sees = 'yes' | 'no' | 'unknown';

/**
 * What a player sees under GameFeed's fog setting (the wiki's fog levels; UNVERIFIED live): every
 * territory's owner under No, Light and Moderate fog (as {@link OWNERS_SHOWN_FOG}); the armies
 * beside its own territories under No, Light and normal fog (`Foggy`), not under Very Foggy or
 * Extreme fog.
 */
export function seesUnderFog(fog: string | undefined, what: 'owners' | 'armies-beside'): Sees {
  if (fog === undefined) return 'unknown';
  if (what === 'owners') return OWNERS_SHOWN_FOG.has(fog) ? 'yes' : ['Foggy', 'VeryFoggy', 'ExtremeFog'].includes(fog) ? 'no' : 'unknown';
  return ['NoFog', 'LightFog', 'Foggy'].includes(fog) ? 'yes' : ['VeryFoggy', 'ExtremeFog'].includes(fog) ? 'no' : 'unknown';
}

/** B3: a true statement the agent may cite to `recipient`, ids only, with whether the recipient can see it. */
export interface DiplomacyFact {
  kind: 'stack-beside-you' | 'territories' | 'bonuses';
  /** The third player it is about. */
  about: number;
  /** One plain sentence, players and territories by id: true of my board. */
  text: string;
  /**
   * Whether the recipient can check it under the game's fog: `no` means it cannot be assumed to
   * (fog that hides owners, and some of it away from the recipient); what lies wholly beside a
   * territory the recipient holds is `yes` where the fog shows armies beside it, else `unknown`.
   */
  recipientSees: Sees;
  territory?: number;
  beside?: number;
  armies?: number;
  count?: number;
  /** `true` when the fog may hide more than I see (the figure is then a lower bound, and the text says "at least"). */
  atLeast?: boolean;
  bonuses?: number[];
  value?: number;
}

/**
 * B3: true statements about third players (not me, not `recipient`) the agent may cite to
 * `recipient`, from my board: the largest visible stack each has beside a territory of the
 * recipient; how many territories each holds that I see (exact only when the fog shows every owner,
 * else "at least"); and the bonuses each visibly holds in full. Each says whether the recipient can
 * see it under `fog`. Nothing about me (withholding is free). Ascending by player, then kind.
 */
export function diplomacyFacts(input: { graph: MapGraph; board: BoardState; me: number; recipient: number; fog?: string }): DiplomacyFact[] {
  const { graph, board, me, recipient, fog } = input;
  const at = territoryMap(board);
  const byPlayer = new Map<number, number[]>();
  for (const t of board.territories) {
    const s = ownerShown(t);
    const o = s ? ownerOn(s) : null;
    if (o === null || o === me || o === recipient) continue;
    byPlayer.set(o, [...(byPlayer.get(o) ?? []), t.territoryId]);
  }
  const ownersShown = seesUnderFog(fog, 'owners');
  const besideShown = seesUnderFog(fog, 'armies-beside');
  const besideRecipient = (t: number) => neighborsOf(graph, t).some((n) => ownedBy(at.get(n), recipient));
  // Owners hidden by the fog: what lies wholly beside the recipient it may still see.
  const sees = (ts: readonly number[]): Sees =>
    ownersShown !== 'no' || !ts.length || !ts.every(besideRecipient) ? ownersShown : besideShown === 'yes' ? 'yes' : 'unknown';
  const out: DiplomacyFact[] = [];
  for (const [p, ts] of [...byPlayer].sort(([a], [b]) => a - b)) {
    let best: { territory: number; beside: number; armies: number } | undefined;
    for (const t of [...ts].sort(byNum)) {
      const armies = visibleState(at.get(t))?.armies;
      if (armies == null) continue;
      const beside = neighborsOf(graph, t).filter((n) => ownedBy(at.get(n), recipient)).sort(byNum)[0];
      if (beside === undefined) continue;
      if (!best || armies > best.armies) best = { territory: t, beside, armies };
    }
    if (best)
      out.push({
        kind: 'stack-beside-you',
        about: p,
        text: `player ${p} has ${best.armies} armies on territory ${best.territory}, beside your territory ${best.beside}`,
        recipientSees: seesUnderFog(fog, 'armies-beside'),
        ...best,
      });
    const atLeast = ownersShown !== 'yes';
    out.push({
      kind: 'territories',
      about: p,
      text: `player ${p} holds ${atLeast ? 'at least ' : ''}${ts.length} territor${ts.length === 1 ? 'y' : 'ies'}`,
      recipientSees: sees(ts),
      count: ts.length,
      ...(atLeast ? { atLeast: true } : {}),
    });
    const held = new Set(ts);
    const full = [...graph.bonusById.keys()]
      .sort(byNum)
      .filter((b) => {
        const members = bonusTerritories(graph, b);
        return members.length > 0 && members.every((m) => held.has(m));
      })
      .filter((b) => (graph.bonusById.get(b)?.value ?? 0) > 0);
    if (full.length) {
      const value = full.reduce((s, b) => s + (graph.bonusById.get(b)?.value ?? 0), 0);
      out.push({
        kind: 'bonuses',
        about: p,
        text: `player ${p} holds bonus${full.length === 1 ? '' : 'es'} ${full.join(', ')} in full, worth +${value} a turn`,
        recipientSees: sees(full.flatMap((b) => bonusTerritories(graph, b))),
        bonuses: full,
        value,
      });
    }
  }
  return out;
}
