// PLAN-TEAMS C3.7: the team hand and my teammates' entered card plays (#163). A team shares one hand, so a
// card my teammate has already entered a play or a discard of is theirs this turn: the plan never plays it
// too, and the card advice says who plays each card.
//
// VERIFIED live 2026-11-22 (V5, #435): war.app sends a teammate's entered orders before they commit. VERIFIED (V8, #310): how a
// team's hand and its limit are keyed (teamCardLimit). Tolerant: no teammate orders read means no claim.
import { cardsToShed, type Card, type CardRules } from './cards.js';
import type { TeammateOrders } from './team-orders.js';

/** A card a teammate's entered orders play or discard. */
export interface TeamCardClaim {
  player: number;
  kind: 'play' | 'discard';
  /** The card instance, when the order names a readable one. */
  cardId?: string;
  /** The card type, when known (a play names it; a discard does not). */
  type: number | null;
  name?: string;
}

/** Every card play and discard in my teammates' entered orders (`teammates`: their player ids), in entry order. */
export function teamCardClaims(entries: readonly TeammateOrders[] | undefined, teammates: ReadonlySet<number>): TeamCardClaim[] {
  const out: TeamCardClaim[] = [];
  for (const e of entries ?? []) {
    if (!teammates.has(e.playerId) || !e.orders) continue;
    for (const c of e.orders.cards)
      out.push({ player: e.playerId, kind: 'play', ...(c.cardId !== undefined ? { cardId: c.cardId } : {}), type: c.type, name: c.name });
    for (const d of e.orders.discards)
      out.push({ player: e.playerId, kind: 'discard', ...(d.cardId !== undefined ? { cardId: d.cardId } : {}), type: null });
  }
  return out;
}

/** A card of the hand a teammate has claimed. */
export interface ClaimedCard {
  card: Card;
  player: number;
  kind: 'play' | 'discard';
}

/**
 * The hand less what my teammates have claimed: a claim naming a card instance takes that card; a play
 * naming only its type takes the first unclaimed card of that type (in hand order). Claims matching no card
 * of the hand change nothing.
 */
export function teamHandLeft(hand: readonly Card[], claims: readonly TeamCardClaim[]): { left: Card[]; claimed: ClaimedCard[] } {
  const taken = new Map<string, ClaimedCard>();
  for (const c of claims.filter((x) => x.cardId !== undefined)) {
    const card = hand.find((h) => h.id === c.cardId);
    if (card && !taken.has(card.id)) taken.set(card.id, { card, player: c.player, kind: c.kind });
  }
  for (const c of claims.filter((x) => x.cardId === undefined && x.type !== null)) {
    const card = hand.find((h) => h.type === c.type && !taken.has(h.id));
    if (card) taken.set(card.id, { card, player: c.player, kind: c.kind });
  }
  return { left: hand.filter((h) => !taken.has(h.id)), claimed: hand.flatMap((h) => (taken.has(h.id) ? [taken.get(h.id)!] : [])) };
}

/** Who plays each card of the team hand this turn (C3.7). */
export interface TeamCardRole {
  card: string;
  name: string;
  /** `me`, a teammate's player id, or `null` when nobody plays it this turn. */
  by: 'me' | number | null;
  action: 'play' | 'discard' | 'hold';
  why: string;
}

/**
 * Who plays each card of the team hand: a teammate for a card they entered, me for a card my orders play
 * or discard, nobody for a card held (a Reinforcement held for the team says so).
 */
export function teamCardRoles(
  hand: readonly Card[],
  claimed: readonly ClaimedCard[],
  mine: { plays: readonly Card[]; discards: readonly Card[] },
): TeamCardRole[] {
  const theirs = new Map(claimed.map((c) => [c.card.id, c]));
  const plays = new Set(mine.plays.map((c) => c.id));
  const discards = new Set(mine.discards.map((c) => c.id));
  return hand.map((c) => {
    const t = theirs.get(c.id);
    if (t)
      return {
        card: c.id,
        name: c.name,
        by: t.player,
        action: t.kind,
        why: `player ${t.player} has already entered a ${t.kind} of it: leave it to them, so the team does not ${t.kind} one card twice`,
      };
    if (plays.has(c.id)) return { card: c.id, name: c.name, by: 'me' as const, action: 'play' as const, why: 'my plan plays it (it is in my orders)' };
    if (discards.has(c.id))
      return { card: c.id, name: c.name, by: 'me' as const, action: 'discard' as const, why: 'my plan discards it: the team hand is over the limit' };
    return {
      card: c.id,
      name: c.name,
      by: null,
      action: 'hold' as const,
      why: 'nobody plays it this turn: whoever needs it plays it, said in team chat first',
    };
  });
}

/** A card my own orders play or discard that a teammate has already entered (G3). */
export interface ClaimedCardUse {
  card: Card;
  mine: 'play' | 'discard';
  /** The teammate whose entered orders use it. */
  player: number;
  theirs: 'play' | 'discard';
}

/** Each card of `uses` (my orders' plays and discards) a teammate has claimed, in the order given. */
export function claimedCardUses(uses: readonly { card: Card; kind: 'play' | 'discard' }[], claimed: readonly ClaimedCard[]): ClaimedCardUse[] {
  const by = new Map(claimed.map((c) => [c.card.id, c]));
  return uses.flatMap((u) => {
    const c = by.get(u.card.id);
    return c ? [{ card: u.card, mine: u.kind, player: c.player, theirs: c.kind }] : [];
  });
}

/** The warning for {@link claimedCardUses} (card ids and player ids only), or undefined when there is none. */
export function claimedCardWarning(uses: readonly ClaimedCardUse[]): string | undefined {
  if (!uses.length) return undefined;
  const each = uses.map((u) => `${u.mine === 'play' ? 'plays' : 'discards'} the ${u.card.name} card ${u.card.id}, which player ${u.player} has already entered a ${u.theirs} of`);
  return (
    `These orders ${each.join('; ')}. A team shares one hand and must not use one card twice: leave it to them, or agree in ` +
    'team chat who uses it before committing. Their entered orders are read from the live board (V5, verified live before commit).'
  );
}

/** The hand with the cards my teammates have claimed moved last (order otherwise kept): a card named by type is then an unclaimed one when there is one. */
export function unclaimedFirst(hand: readonly Card[], claimed: readonly ClaimedCard[]): Card[] {
  const ids = new Set(claimed.map((c) => c.card.id));
  return [...hand.filter((c) => !ids.has(c.id)), ...hand.filter((c) => ids.has(c.id))];
}

/** A teammate as the team's card limit reads it (GameFeed: still playing, and whether committed). */
export interface LimitMate {
  id: number;
  hasCommittedOrders: boolean;
  state?: string;
}

/** The team's hand against the team's card limit (V8, #310). */
export interface TeamCardLimit {
  /** The team's hand less the cards my committed teammates' entered orders play or discard. */
  left: Card[];
  /** Cards that must still leave {@link left} for war.app to accept orders from the last of the team to commit. */
  shed: number;
  /** No teammate still playing is yet to commit: these orders are the team's last. */
  lastToCommit: boolean;
  /** Every committed teammate's entered orders were read (V5): their plays and discards are known. */
  ordersRead: boolean;
  /** The limit binds these orders: war.app refuses them (error 51) unless `shed` cards leave the hand. */
  binding: boolean;
}

/**
 * The team's card limit as war.app applies it (V8, #310; the client bundle's GameValidateOrders, the hand seen
 * live): the standing keeps each player's cards under that player's id, and a team's hand is every card under
 * any of its players, counted against `MaxCardsHold` (the settings call it the most "a player or team" may hold).
 * The cards my committed teammates' orders play or discard leave it first; then mine. Over the limit, war.app
 * refuses (error 51) only the orders of the last of the team still playing to commit: while a teammate has yet
 * to commit, they may still shed, and the orders are taken. `binding` holds only when every committed
 * teammate's orders were read, so an unread teammate never makes a refusal.
 */
export function teamCardLimit(
  hand: readonly Card[],
  rules: CardRules,
  mates: readonly LimitMate[],
  entries: readonly TeammateOrders[] | undefined,
): TeamCardLimit {
  const playing = mates.filter((m) => (m.state ?? 'Playing') === 'Playing');
  const committed = playing.filter((m) => m.hasCommittedOrders);
  const lastToCommit = playing.every((m) => m.hasCommittedOrders);
  const ordersRead = committed.every((m) => entries?.some((e) => e.playerId === m.id && e.orders !== null) === true);
  const { left } = teamHandLeft(hand, teamCardClaims(entries, new Set(committed.map((m) => m.id))));
  const shed = cardsToShed(left, rules);
  return { left, shed, lastToCommit, ordersRead, binding: lastToCommit && ordersRead };
}
