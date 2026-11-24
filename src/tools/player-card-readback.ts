// Owner request 2026-11-24 (self-Sanctions): after warapp_submit_turn commits, the player-targeted card plays it sent
// (Sanctions) are read back from war.app's own copy of my committed orders (the warapp_get_my_orders read, as the
// Airlift read-back does: src/tools/airlift-readback.ts) and compared: the card instance and the player it names.
// A missing or retargeted one makes the tool throw. Pure.
import { normalizeGuid } from '../cards.js';
import type { MyOrders } from '../my-orders.js';
import type { TurnOrder } from '../protocol/methods.js';

/** The player-targeted card plays read back after a commit. */
export const READ_BACK_PLAYER_CARDS: ReadonlySet<string> = new Set(['Sanctions']);

/** One player-targeted play as sent and as compared: its card instance, kind and player (GameFeed id). */
export interface PlayerCardLine {
  card: string;
  kind: string;
  player: number;
}

export interface PlayerCardReadBack {
  /** `verified`: every play read back as sent; `mismatch`: one is missing or names another player; `unread`: not readable. */
  status: 'verified' | 'mismatch' | 'unread';
  sent: PlayerCardLine[];
  missing: PlayerCardLine[];
  altered: { sent: PlayerCardLine; read: { card: string; player: number } }[];
}

/** The plays of these kinds among the orders sent, the player by GameFeed id (`feedOf` the in-game id; unknown: left out). */
export function sentPlayerCards(orders: readonly TurnOrder[], feedOf: (inGame: number) => number | undefined, kinds = READ_BACK_PLAYER_CARDS): PlayerCardLine[] {
  return orders.flatMap((o) => {
    if (o.kind !== 'card' || !kinds.has(o.card) || o.player === undefined) return [];
    const player = feedOf(o.player);
    return player === undefined ? [] : [{ card: normalizeGuid(o.cardId) ?? o.cardId, kind: o.card, player }];
  });
}

/** Compare the plays sent with my orders read back (`null`: unknown): by card instance, else the same kind and player. */
export function checkPlayerCards(sent: readonly PlayerCardLine[], read: MyOrders | null): PlayerCardReadBack {
  if (!read) return { status: 'unread', sent: [...sent], missing: [], altered: [] };
  const back = read.orders.flatMap((o) =>
    o.kind === 'card' && o.player !== undefined ? [{ card: normalizeGuid(o.card) ?? o.card, kind: o.cardType, player: o.player }] : [],
  );
  const used = new Set<number>();
  const missing: PlayerCardLine[] = [];
  const altered: PlayerCardReadBack['altered'] = [];
  for (const s of sent) {
    let i = back.findIndex((b, k) => !used.has(k) && b.card === s.card);
    if (i < 0) i = back.findIndex((b, k) => !used.has(k) && b.kind === s.kind && b.player === s.player);
    if (i < 0) {
      missing.push(s);
      continue;
    }
    used.add(i);
    if (back[i]!.player !== s.player) altered.push({ sent: s, read: { card: back[i]!.card, player: back[i]!.player } });
  }
  return { status: missing.length || altered.length ? 'mismatch' : 'verified', sent: [...sent], missing, altered };
}

/** The error message's parts for a mismatch, by id. */
export function playerCardMismatchParts(r: PlayerCardReadBack): string[] {
  return [
    ...r.missing.map((x) => `the ${x.kind} on player ${x.player} is missing`),
    ...r.altered.map((x) => `the ${x.sent.kind} on player ${x.sent.player} reads back on player ${x.read.player}`),
  ];
}
