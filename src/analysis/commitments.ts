// B4 (docs/PLAN-TEAMS.md section 8): a message promises only what the plan does. The commitments a
// chat message declares — never read from its text, which is not parsed — are checked against this
// turn's orders (the plan made in the call, or the orders already submitted) and the agreement ledger,
// recorded in the ledger as mine once the message is sent, and checked again when later orders are
// submitted (`commitmentWarnings`).
//
// Kinds:
// - `no-attack`: I will not attack the player's territories in `scope` this turn and the next
//   `turns - 1`. No order this turn may attack one.
// - `will-attack`: I will attack the player (any of its territories) or a territory this turn. An
//   order this turn must. Only this turn: no plan covers a later one.
// - `notice`: I am ending agreement A. It must be agreed (or already in my notice); the truce binds
//   until its agreed notice has run, so no order this turn may attack a covered territory, and a turn
//   the message names as its end must be the one the agreed notice gives: earlier is a surprise break,
//   later a promise the ledger does not keep (it frees the territories when the notice has run). A
//   truce with no notice (0 turns) ends with the message: it binds no more from this turn, so an
//   attack this turn breaks nothing.
// - `propose` / `accept`: a truce on structured terms. No order this turn may attack a territory it
//   covers. On send it creates or advances the agreement as warapp_record_agreement would. A truce
//   whose last turn (`untilTurn`) is before this one is refused; an accept compares only the terms it
//   restates.
//
// Fog: a territory a promise names (an explicit scope) whose owner is not shown may be the player's,
// so an order attacking it conflicts; under the scope `all`, orders into territories whose owner is not
// shown are named in the carried sentence, and in `commitmentWarnings`' (soft) warning, as not checked.
//
// Pure and deterministic like the planner (ids ascending, no I/O). Sentences name players and
// territories by id only: names are third-party text.
import type { BoardState } from '../board.js';
import type { MapGraph } from './graph.js';
import { ownerShown } from './plan/shared.js';
import { bonusTerritories } from './bonuses.js';
import {
  agreementState,
  coveredTerritories,
  newAgreement,
  partyRefusal,
  scopeRefusal,
  TERMINAL_STATUSES,
  transitionAgreement,
  type Agreement,
  type AgreementScope,
  type AgreementTerms,
  type RelationPlayer,
} from './relations.js';

/** Every commitment kind a message may declare. */
export const COMMITMENT_KINDS = ['no-attack', 'will-attack', 'notice', 'propose', 'accept'] as const;
export type CommitmentKind = (typeof COMMITMENT_KINDS)[number];

/** The most turns a `no-attack` promise may run. */
export const MAX_NO_ATTACK_TURNS = 10;
/** The most commitments one message may declare. */
export const MAX_MESSAGE_COMMITMENTS = 10;

/** A commitment as a message declares it (players by GameFeed id, territories and bonuses by id). */
export type Commitment =
  | { kind: 'no-attack'; with: number; scope: AgreementScope; turns: number }
  | { kind: 'will-attack'; with?: number; territory?: number; turn?: number }
  | { kind: 'notice'; agreement: string; endsTurn?: number }
  | { kind: 'propose'; with: number; terms: AgreementTerms }
  /** `terms`: what the message restates; a field not given is not compared (new terms take the defaults). */
  | { kind: 'accept'; agreement?: string; with?: number; terms?: Partial<AgreementTerms> };

/** A commitment as the ledger keeps it: name-free, with the turn it was sent and the turns it binds. */
export type RecordedCommitment = { id: string; sentTurn: number } & (
  | { kind: 'no-attack'; with: number; scope: AgreementScope; fromTurn: number; toTurn: number }
  | { kind: 'will-attack'; with?: number; territory?: number; turn: number }
  | { kind: 'notice'; agreement: string; with: number; endsTurn: number }
  | { kind: 'propose' | 'accept'; agreement: string; with: number }
);

/** A recorded commitment before the ledger gives it an id. */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
export type CommitmentRecord = WithoutId<RecordedCommitment>;

/** One order of mine this turn, as the check reads it. */
export interface OrderMove {
  from: number;
  to: number;
  /** A transfer-only order attacks nothing. */
  transferOnly?: boolean;
}

/** What an agreement change does to the ledger: the agreement after it, and as it stood. */
export interface AgreementChange {
  agreement: Agreement;
  before: Agreement | undefined;
  created: boolean;
}

export interface CommitmentContext {
  graph: MapGraph;
  /** My board at the start of this turn: whose a target is. */
  board: BoardState;
  me: number;
  turn: number;
  players: readonly RelationPlayer[];
  /** The ledger's agreements. */
  agreements: readonly Agreement[];
  /** The next agreement id for a ledger holding `agreements`. */
  nextAgreementId: (agreements: readonly Agreement[]) => string;
}

export interface CommitmentCheck {
  /** Its place in the message's list (0-based). */
  index: number;
  kind: CommitmentKind;
  /** Why the plan and the ledger carry it (ids only). */
  carried?: string;
  /** Why they do not (ids only): the send is refused. */
  refused?: string;
  /** What the ledger records once the message is sent. */
  record?: CommitmentRecord;
  /** For propose, accept and notice: the agreement change it makes. */
  change?: AgreementChange;
}

const ownerOf = (board: BoardState, t: number): number | null => {
  const s = board.territories.find((x) => x.territoryId === t);
  return s && ownerShown(s) && s.owner.kind === 'player' ? s.owner.playerId : null;
};

const heldBy = (board: BoardState, p: number): Set<number> =>
  new Set(board.territories.filter((t) => ownerShown(t) && t.owner.kind === 'player' && t.owner.playerId === p).map((t) => t.territoryId));

/** The territories `scope` names (none for `all`) whose owner my board does not show: they may be anyone's. */
function unseenNamed(graph: MapGraph, board: BoardState, scope: AgreementScope): Set<number> {
  if (scope === 'all') return new Set();
  const ids = 'territories' in scope ? scope.territories : scope.bonuses.flatMap((b) => [...bonusTerritories(graph, b)]);
  const shown = new Map(board.territories.map((t) => [t.territoryId, t]));
  return new Set(ids.filter((t) => !ownerShown(shown.get(t))));
}

/** Every territory on the map whose owner my board does not show. */
function unseenAll(graph: MapGraph, board: BoardState): Set<number> {
  const shown = new Map(board.territories.map((t) => [t.territoryId, t]));
  return new Set([...graph.territoryById.keys()].filter((t) => !ownerShown(shown.get(t))));
}

const intoFog = (hit: readonly { index: number; from: number; to: number }[]) =>
  `${hit.map((h) => `move ${h.index + 1} (${h.from} → ${h.to})`).join(', ')} ${hit.length === 1 ? 'goes into a territory' : 'go into territories'} whose owner is not shown`;

/** The orders among `moves` that attack one of `targets` (by index), transfers-only aside. */
function attacksOn(moves: readonly OrderMove[], targets: ReadonlySet<number>): { index: number; from: number; to: number }[] {
  return moves.flatMap((m, index) => (!m.transferOnly && targets.has(m.to) ? [{ index, from: m.from, to: m.to }] : []));
}

const normScope = (s: AgreementScope) =>
  JSON.stringify(s === 'all' ? 'all' : 'territories' in s ? { territories: [...s.territories].sort((x, y) => x - y) } : { bonuses: [...s.bonuses].sort((x, y) => x - y) });
/** Whether `given` (the terms an accept restates) agrees with `t` on every field it gives. */
function sameGivenTerms(given: Partial<AgreementTerms>, t: AgreementTerms): boolean {
  return (Object.keys(given) as (keyof AgreementTerms)[]).every((k) =>
    given[k] === undefined ? true : k === 'scope' ? normScope(given.scope!) === normScope(t.scope) : given[k] === t[k],
  );
}
/** New terms from what an accept gives: the scope `all` and 1 turn of notice unless stated. */
const fullTerms = (t: Partial<AgreementTerms>): AgreementTerms => ({ ...t, scope: t.scope ?? 'all', noticeTurns: t.noticeTurns ?? 1 });
/** A truce whose last turn has passed is over before it begins. */
const pastUntil = (t: AgreementTerms, turn: number) =>
  t.untilTurn !== undefined && t.untilTurn < turn ? `the truce would bind only until turn ${t.untilTurn}, before this turn (${turn})` : undefined;

const openWith = (agreements: readonly Agreement[], p: number) => agreements.find((a) => a.with === p && !TERMINAL_STATUSES.has(a.status));

/**
 * The agreement change a `propose`, `accept` or `notice` makes to `agreements` on `turn`, or why it
 * cannot. Shared by the check (`checkCommitments`) and the write once the message is sent, so both
 * apply the same rule to the ledger as it then stands. `players` is checked for a new commitment
 * (`partyRefusal`) only when given.
 */
export function agreementChange(
  c: Extract<Commitment, { kind: 'propose' | 'accept' | 'notice' }>,
  o: { agreements: readonly Agreement[]; turn: number; me: number; players?: readonly RelationPlayer[]; graph?: MapGraph; nextAgreementId: (agreements: readonly Agreement[]) => string },
): AgreementChange | { refused: string } {
  const { agreements, turn, me } = o;
  const party = (p: number) => (o.players ? partyRefusal(o.players, me, p) : undefined);
  const scopeBad = (t: AgreementTerms) => (o.graph ? scopeRefusal(o.graph, t.scope) : undefined);
  const move = (a: Agreement, status: Agreement['status']) => {
    const r = transitionAgreement(a, status, turn);
    return 'refused' in r ? r : { agreement: r.agreement, before: a, created: false };
  };
  if (c.kind === 'notice') {
    const a = agreements.find((x) => x.id === c.agreement);
    if (!a) return { refused: `there is no agreement ${c.agreement} in the ledger` };
    if (a.status === 'notice-by-me') return { agreement: a, before: a, created: false };
    if (a.status !== 'agreed') return { refused: `agreement ${a.id} is ${a.status}: notice is given on an agreed truce` };
    return move(a, 'notice-by-me');
  }
  if (c.kind === 'propose') {
    const why = party(c.with) ?? scopeBad(c.terms) ?? pastUntil(c.terms, turn);
    if (why) return { refused: why };
    const open = openWith(agreements, c.with);
    if (!open) return { agreement: newAgreement(o.nextAgreementId(agreements), c.with, 'proposed-by-me', turn, c.terms), before: undefined, created: true };
    if (open.status !== 'proposed-by-me' && open.status !== 'proposed-by-them')
      return { refused: `agreement ${open.id} with player ${c.with} is already ${open.status}: end it before proposing new terms` };
    const withTerms = { ...open, terms: c.terms };
    if (open.status === 'proposed-by-me') return { agreement: withTerms, before: open, created: false };
    const r = transitionAgreement(withTerms, 'proposed-by-me', turn);
    return 'refused' in r ? r : { agreement: r.agreement, before: open, created: false };
  }
  // accept
  let target: Agreement | undefined;
  if (c.agreement !== undefined) {
    target = agreements.find((x) => x.id === c.agreement);
    if (!target) return { refused: `there is no agreement ${c.agreement} in the ledger` };
    if (c.with !== undefined && c.with !== target.with) return { refused: `agreement ${target.id} is with player ${target.with}, not player ${c.with}` };
  } else if (c.with !== undefined) {
    const open = openWith(agreements, c.with);
    if (open && (open.status === 'proposed-by-me' || open.status === 'proposed-by-them')) target = open;
    else if (open) return { refused: `agreement ${open.id} with player ${c.with} is already ${open.status}` };
  } else {
    return { refused: 'an acceptance names the agreement, or the player and the terms' };
  }
  if (target) {
    if (target.status !== 'proposed-by-me' && target.status !== 'proposed-by-them')
      return { refused: `agreement ${target.id} is ${target.status}: only a proposal is accepted` };
    if (c.terms && !sameGivenTerms(c.terms, target.terms))
      return { refused: `the terms differ from agreement ${target.id}'s: a counter-offer is a propose, not an accept` };
    const why = party(target.with) ?? pastUntil(target.terms, turn);
    if (why) return { refused: why };
    return move(target, 'agreed');
  }
  if (!c.terms) return { refused: `no proposal from player ${c.with} is recorded: give the terms accepted` };
  const terms = fullTerms(c.terms);
  const why = party(c.with!) ?? scopeBad(terms) ?? pastUntil(terms, turn);
  if (why) return { refused: why };
  return { agreement: newAgreement(o.nextAgreementId(agreements), c.with!, 'agreed', turn, terms), before: undefined, created: true };
}

/**
 * B4: each commitment checked against this turn's orders (`moves`: the plan made in the call, or the
 * orders already submitted — `source` says which) and the ledger, in the message's order: a change an
 * earlier commitment makes to an agreement is seen by a later one. A commitment the orders or the
 * ledger do not carry is `refused`, with the reason.
 */
export function checkCommitments(
  input: CommitmentContext & { commitments: readonly Commitment[]; moves: readonly OrderMove[]; source: 'plan' | 'submitted' },
): { checks: CommitmentCheck[]; agreements: Agreement[] } {
  const { graph, board, me, turn, players, moves, source } = input;
  let agreements = [...input.agreements];
  const orders = source === 'plan' ? 'planned' : 'submitted';
  const named = (a: { from: number; to: number; index: number }) => `the ${orders} move ${a.index + 1} (${a.from} → ${a.to})`;
  const checks: CommitmentCheck[] = [];
  const player = (p: number) => players.find((x) => x.id === p);
  // Under the scope `all`, orders into territories whose owner is not shown are said, never assumed safe.
  const fogAll = attacksOn(moves, unseenAll(graph, board));
  const unchecked = (scope: AgreementScope) => (scope === 'all' && fogAll.length ? `; ${intoFog(fogAll)}, which ${fogAll.length === 1 ? 'was' : 'were'} not checked` : '');
  input.commitments.forEach((c, index) => {
    const out = (rest: Omit<CommitmentCheck, 'index' | 'kind'>) => checks.push({ index, kind: c.kind, ...rest });
    if (c.kind === 'no-attack') {
      if (c.with === me) return out({ refused: 'a promise not to attack yourself carries nothing' });
      if (!player(c.with)) return out({ refused: `player ${c.with} is not in this game` });
      const bad = scopeRefusal(graph, c.scope);
      if (bad) return out({ refused: bad });
      const covered = new Set(coveredTerritories(graph, c.scope, heldBy(board, c.with)));
      const hit = attacksOn(moves, covered);
      if (hit.length) return out({ refused: `${named(hit[0]!)} attacks player ${c.with}'s territory ${hit[0]!.to}, which the promise covers` });
      const fog = attacksOn(moves, unseenNamed(graph, board, c.scope));
      if (fog.length) return out({ refused: `${named(fog[0]!)} attacks territory ${fog[0]!.to}, which the promise names and whose owner is not shown: it may be player ${c.with}'s` });
      const toTurn = turn + c.turns - 1;
      return out({
        carried: `no ${orders} order this turn attacks player ${c.with}'s territories it covers (${covered.size} on the board now); it binds through turn ${toTurn}${unchecked(c.scope)}`,
        record: { sentTurn: turn, kind: 'no-attack', with: c.with, scope: c.scope, fromTurn: turn, toTurn },
      });
    }
    if (c.kind === 'will-attack') {
      if (c.with === undefined && c.territory === undefined) return out({ refused: 'a promise to attack names a player or a territory' });
      const when = c.turn ?? turn;
      if (when !== turn)
        return out({ refused: `only this turn's orders (turn ${turn}) can carry a promise to attack: turn ${when} is not planned yet — send it on that turn` });
      if (c.with !== undefined) {
        if (c.with === me) return out({ refused: 'you cannot attack yourself' });
        if (!player(c.with)) return out({ refused: `player ${c.with} is not in this game` });
      }
      let targets: Set<number>;
      if (c.territory !== undefined) {
        if (!graph.territoryById.has(c.territory)) return out({ refused: `territory ${c.territory} is not on this map` });
        const owner = ownerOf(board, c.territory);
        if (owner === me) return out({ refused: `territory ${c.territory} is yours: there is nothing to attack` });
        if (c.with !== undefined && owner !== c.with) return out({ refused: `territory ${c.territory} is not player ${c.with}'s on your board` });
        targets = new Set([c.territory]);
      } else {
        targets = heldBy(board, c.with!);
      }
      const hit = attacksOn(moves, targets);
      const what = c.territory !== undefined ? `territory ${c.territory}` : `player ${c.with}`;
      if (!hit.length) {
        const fog = attacksOn(moves, unseenAll(graph, board));
        return out({ refused: `no ${orders} order this turn attacks ${what}${fog.length ? ` (${intoFog(fog)}, which does not count)` : ''}` });
      }
      return out({
        carried: `${named(hit[0]!)} attacks ${what}`,
        record: {
          sentTurn: turn,
          kind: 'will-attack',
          ...(c.with !== undefined ? { with: c.with } : {}),
          ...(c.territory !== undefined ? { territory: c.territory } : {}),
          turn,
        },
      });
    }
    // notice, propose, accept: the ledger first, then the orders against what the agreement covers.
    const change = agreementChange(c, { agreements, turn, me, players, graph, nextAgreementId: input.nextAgreementId });
    if ('refused' in change) return out({ refused: change.refused });
    const a = change.agreement;
    const covered = new Set(coveredTerritories(graph, a.terms.scope, heldBy(board, a.with)));
    const hit = attacksOn(moves, covered);
    const fog = attacksOn(moves, unseenNamed(graph, board, a.terms.scope));
    const fogText = (what: string) => `${named(fog[0]!)} attacks territory ${fog[0]!.to}, which ${what} names and whose owner is not shown: it may be player ${a.with}'s`;
    if (c.kind === 'notice') {
      const state = agreementState(a, turn, players);
      // A truce with no notice (0 turns, an agreed term) ends with the message: notice served this turn
      // has already run, so it binds no more from this turn and an attack this turn breaks nothing.
      const endsNow = a.status === 'notice-by-me' && a.noticeTurn === turn && state.phase === 'over' && state.reason === 'notice-served';
      const endsTurn = endsNow ? turn : state.endsTurn;
      if (endsTurn === undefined || (!endsNow && state.phase !== 'notice'))
        return out({ refused: `agreement ${a.id} is over (${state.reason ?? state.phase}): there is nothing to give notice on` });
      if (c.endsTurn !== undefined && c.endsTurn !== endsTurn)
        return out({
          refused:
            `agreement ${a.id} carries ${a.terms.noticeTurns} turn${a.terms.noticeTurns === 1 ? '' : 's'} of notice: given on turn ${a.noticeTurn}, ` +
            `it binds until turn ${endsTurn}, so the message cannot say it ends on turn ${c.endsTurn}` +
            (c.endsTurn > endsTurn ? ` (the ledger frees its territories on turn ${endsTurn}: to keep the truce longer, propose new terms)` : ''),
        });
      const record: CommitmentRecord = { sentTurn: turn, kind: 'notice', agreement: a.id, with: a.with, endsTurn };
      if (endsNow) {
        agreements = [...agreements.filter((x) => x.id !== a.id), a];
        return out({
          carried: `agreement ${a.id} with player ${a.with} carries no notice: it ends with this message, so it no longer binds from this turn (${turn}) and an attack on its territories this turn breaks nothing`,
          record,
          change,
        });
      }
      if (hit.length) return out({ refused: `${named(hit[0]!)} attacks territory ${hit[0]!.to}, which agreement ${a.id} covers while its notice runs` });
      if (fog.length) return out({ refused: fogText(`agreement ${a.id}`) });
      agreements = [...agreements.filter((x) => x.id !== a.id), a];
      return out({
        carried: `agreement ${a.id} with player ${a.with}: notice from turn ${a.noticeTurn}, binding until turn ${endsTurn}, and no ${orders} order this turn attacks a territory it covers${unchecked(a.terms.scope)}`,
        record,
        change,
      });
    }
    if (hit.length)
      return out({ refused: `${named(hit[0]!)} attacks player ${a.with}'s territory ${hit[0]!.to}, which the ${c.kind === 'propose' ? 'proposed' : 'accepted'} truce covers` });
    if (fog.length) return out({ refused: fogText(`the ${c.kind === 'propose' ? 'proposed' : 'accepted'} truce`) });
    agreements = [...agreements.filter((x) => x.id !== a.id), a];
    return out({
      carried: `agreement ${a.id} with player ${a.with} (${a.status}), and no ${orders} order this turn attacks a territory it covers${unchecked(a.terms.scope)}`,
      record: { sentTurn: turn, kind: c.kind, agreement: a.id, with: a.with },
      change,
    });
  });
  return { checks, agreements };
}

/** One recorded commitment a list of orders breaks (`commitmentWarnings`). */
export interface CommitmentWarning {
  commitment: string;
  kind: CommitmentKind;
  with?: number;
  /** The orders (index in the list given) that break it; none for a promise to attack they do not carry. */
  moves: { index: number; from: number; to: number }[];
  /** What it says (ids only). */
  text: string;
  /** The orders only go into territories whose owner is not shown, under the scope `all`: they may break it, unchecked. */
  unchecked?: true;
}

/**
 * B4 (warapp_submit_turn): the commitments I sent that `moves` would break on `turn` — an order that
 * attacks a territory a `no-attack` still covers, or that a truce I proposed (still a proposal) covers;
 * and a `will-attack` for this turn that no order carries. Notice and accepted truces are the ledger's
 * own (`truceBreaksIn`). Under the scope `all`, orders that only go into territories whose owner is not
 * shown are a soft warning (`unchecked`): they may land on the player. Warnings, never a refusal. Pure.
 */
export function commitmentWarnings(input: {
  commitments: readonly RecordedCommitment[];
  agreements: readonly Agreement[];
  graph: MapGraph;
  board: BoardState;
  me: number;
  turn: number;
  moves: readonly OrderMove[];
}): CommitmentWarning[] {
  const { graph, board, me, turn, moves } = input;
  const out: CommitmentWarning[] = [];
  const said = (c: RecordedCommitment) => `commitment ${c.id} (sent turn ${c.sentTurn})`;
  const list = (hit: { index: number; from: number; to: number }[]) => hit.map((h) => `move ${h.index + 1} (${h.from} → ${h.to})`).join(', ');
  // A territory the scope names whose owner is not shown may be the partner's: an attack there counts.
  const hitsOn = (scope: AgreementScope, p: number) => {
    const covered = new Set(coveredTerritories(graph, scope, heldBy(board, p)));
    const unseen = unseenNamed(graph, board, scope);
    const hit = attacksOn(moves, new Set([...covered, ...unseen]));
    const fogged = [...new Set(hit.filter((h) => unseen.has(h.to)).map((h) => h.to))];
    const note = fogged.length ? ` (territory ${fogged.join(', ')}'s owner is not shown)` : '';
    // Under the scope `all` any territory whose owner is not shown may be the player's: said, never assumed safe.
    const fog = scope === 'all' && !hit.length ? attacksOn(moves, unseenAll(graph, board)) : [];
    return { hit, note, fog, fogText: fog.length ? `${intoFog(fog)} — it may be player ${p}'s, which was not checked` : '' };
  };
  for (const c of [...input.commitments].sort((x, y) => x.id.localeCompare(y.id, 'en', { numeric: true }))) {
    if (c.kind === 'no-attack') {
      if (turn < c.fromTurn || turn > c.toTurn || c.with === me) continue;
      const { hit, note, fog, fogText } = hitsOn(c.scope, c.with);
      if (hit.length)
        out.push({ commitment: c.id, kind: c.kind, with: c.with, moves: hit, text: `${said(c)} promised player ${c.with} no attack there through turn ${c.toTurn}: ${list(hit)} attacks it${note}` });
      else if (fog.length)
        out.push({ commitment: c.id, kind: c.kind, with: c.with, moves: fog, unchecked: true, text: `${said(c)} promised player ${c.with} no attack on any of its territories through turn ${c.toTurn}: ${fogText}` });
    } else if (c.kind === 'will-attack') {
      if (c.turn !== turn) continue;
      const targets = c.territory !== undefined ? new Set([c.territory]) : heldBy(board, c.with!);
      if (attacksOn(moves, targets).length) continue;
      const what = c.territory !== undefined ? `territory ${c.territory}` : `player ${c.with}`;
      out.push({
        commitment: c.id,
        kind: c.kind,
        ...(c.with !== undefined ? { with: c.with } : {}),
        moves: [],
        text: `${said(c)} said you would attack ${what} this turn: no order here does`,
      });
    } else if (c.kind === 'propose') {
      const a = input.agreements.find((x) => x.id === c.agreement);
      if (!a || (a.status !== 'proposed-by-me' && a.status !== 'proposed-by-them')) continue;
      const { hit, note, fog, fogText } = hitsOn(a.terms.scope, a.with);
      if (hit.length)
        out.push({ commitment: c.id, kind: c.kind, with: a.with, moves: hit, text: `${said(c)} proposed truce ${a.id} to player ${a.with}, still open: ${list(hit)} attacks a territory it covers${note}` });
      else if (fog.length)
        out.push({ commitment: c.id, kind: c.kind, with: a.with, moves: fog, unchecked: true, text: `${said(c)} proposed truce ${a.id} to player ${a.with}, still open: ${fogText}` });
    }
  }
  return out;
}
