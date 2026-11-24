// The orders of an alternative plan beside the plain one (`airliftPlan`): the plain plan's card plays and discards, then
// the alternative's own card plays, deploys and moves. The advised Order Delay is left out (its `before` names a move of
// the plain plan); it is discarded instead only when the plain card choice had to shed it (it was among the discards and
// played in their place, `insteadOfDiscard`) — otherwise the player keeps it (auto-review #558). Pure.

export interface Orderish {
  kind: string;
  card?: unknown;
}

/** Whether the orders play a card of `type` (by the hand's card ids): an advised Order Priority included. */
export function playsCardType(orders: readonly Orderish[], hand: readonly { id: string; type: number }[], type: number): boolean {
  const ids = new Set(hand.filter((c) => c.type === type).map((c) => c.id));
  return orders.some((o) => o.kind === 'card' && typeof o.card === 'string' && ids.has(o.card));
}

/** The cards of one type left after this plan: those the plain plan leaves (`free`), less those it spends. */
export const cardsLeftAfter = (a: { held: number; free: number; spent: number }): number => Math.max(0, Math.min(a.held, a.free) - a.spent);

export function alternativeOrders<T extends Orderish>(a: {
  orders: readonly T[];
  /** The advised Order Delay's order in the plain orders, when there is one. */
  delayOrder: unknown;
  /** Its card. */
  playedDelay: string | undefined;
  /** The plain card choice had to shed it (it was among the discards). */
  delayMustGo: boolean;
  cardPlays: readonly Orderish[];
  deploys: readonly Orderish[];
  moves: readonly Orderish[];
}): Orderish[] {
  const delayDiscard = a.playedDelay && a.delayOrder !== undefined && a.delayMustGo ? [{ kind: 'discard', card: a.playedDelay }] : [];
  return [
    ...a.orders.filter((o) => (o.kind === 'discard' || o.kind === 'card') && o !== a.delayOrder),
    ...delayDiscard,
    ...a.cardPlays,
    ...a.deploys,
    ...a.moves,
  ];
}
