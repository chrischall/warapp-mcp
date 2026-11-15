// PLAN-TEAMS C3.7: the team hand and my teammates' entered card plays (#163). A team shares one hand, so a
// card my teammate has already entered a play or a discard of is theirs this turn: the plan never plays it
// too, and the card advice says who plays each card.
//
// UNVERIFIED live: whether war.app sends a teammate's orders before they commit (V5), and how a team's hand
// and its limit are keyed (V8). Tolerant: no teammate orders read means no claim, and the hand is as before.
import type { Card } from './cards.js';
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
