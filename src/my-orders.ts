// My own orders this turn, read back from a decoded LatestGameInfo (warapp_get_my_orders).
//
// From the client bundle (6.08.0.2, read 2026-11-22): LatestGameInfo's FIRST field is a list of GameOrder —
// the client's "active orders" (its log line "EndCommit Wrote N active orders"), which it fills on a commit and
// shows again in "Modify orders" (its ShowCommittedTurn state). The server builds it from the game's
// ActiveTurnOrders entry for the asking player only, while the game is being played (its second field is the
// same for picks while distributing). VERIFIED live 2026-11-22: a committed turn read back exactly — two
// deploys, a Gift card play (recipient and territory), six moves — and five more committed games read their
// deploys, moves and an Order Priority play. Still UNVERIFIED: what it holds while my orders are entered but not
// committed (the same ActiveTurnOrders carries a teammate's entered orders before it commits, V5).
//
// The field is found by its values, not its minified name: the one field of the info that is a non-empty list of
// GameOrder records (a teammate's orders sit inside the TeammateOrders dict, never directly in the info). An empty
// list or none names no field, so it reads as unknown, never as "no orders". Each order is decoded by
// `decodeOrder` (src/team-orders.ts, shared with the teammate reader) and projected into the shape
// warapp_submit_turn takes; a card play's own fields are read by class, in the order the bundle's writer puts them
// (src/protocol/methods.ts `writeCardPlayOrder`). Players come back as GameFeed ids. Never throws.

import { playersByInGameId } from './live.js';
import type { Player } from './normalize.js';
import { fields, isObj } from './protocol/decoded.js';
import { armiesOf, decodeOrder, orderClass } from './team-orders.js';

const ORDER_PREFIX = 'warlight.shared.GameOrder';

/** One order in the shape `warapp_submit_turn` takes (ids only), plus `cardType` on a card play for display. */
export type MyOrder =
  | { kind: 'deploy'; territory: number; armies: number }
  | {
      kind: 'move';
      from: number;
      to: number;
      armies: number;
      mode?: 'attack-only' | 'transfer-only';
      percent?: true;
      commander?: true;
      attack_teammates?: true;
    }
  | {
      kind: 'card';
      /** The card instance GUID (the type name when the order carried none). */
      card: string;
      /** The card's name, for display; `warapp_submit_turn` ignores it. */
      cardType: string;
      target?: number;
      player?: number;
      players?: [number, number];
      bonus?: number;
      from?: number;
      to?: number;
      armies?: number;
      commander?: true;
      before?: number;
    }
  | { kind: 'discard'; card: string };

export interface MyOrders {
  /** In the order war.app keeps them. */
  orders: MyOrder[];
  /** Orders present but not read: their class, with the reason when known. */
  unread: string[];
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isOrder = (v: unknown) => isObj(v) && typeof v.$type === 'string' && v.$type.startsWith(ORDER_PREFIX);

/**
 * The list of my orders in a decoded LatestGameInfo: the one field that is a non-empty list of GameOrder
 * records. `undefined` (unknown) when there is none, or more than one.
 */
export function readMyOrderList(info: unknown): unknown[] | undefined {
  if (!isObj(info)) return undefined;
  const lists = fields(info).filter(
    (v): v is unknown[] => Array.isArray(v) && v.length > 0 && v.every((o) => o === null || isOrder(o)) && v.some(isOrder),
  );
  return lists.length === 1 ? lists[0]!.filter((o) => o !== null) : undefined;
}

/** Which own fields each card play carries, by class (the bundle's writers; `Abandon` is Emergency Blockade). */
const TERRITORY_CARDS = new Set(['Blockade', 'Abandon', 'Bomb', 'Reconnaissance']);
const PLAYER_CARDS = new Set(['Spy', 'Sanctions']);
const PLAIN_CARDS = new Set(['Reinforcement', 'OrderPriority', 'OrderDelay']);

/**
 * My orders projected into `warapp_submit_turn`'s shape; `null` (unknown) when the info carries no list of them.
 * A card naming a player not in `players` (in-game ids) is unread, never sent back with a wrong id.
 */
export function myOrdersOf(info: unknown, players: readonly Player[]): MyOrders | null {
  const list = readMyOrderList(info);
  if (!list) return null;
  const byInGame = playersByInGameId(players);
  const feedId = (inGame: number): number | undefined => (inGame === 0 ? 0 : byInGame.get(inGame)?.id);
  const orders: MyOrder[] = [];
  const unread: string[] = [];
  let movesSeen = 0;
  const delays: Array<{ order: Extract<MyOrder, { kind: 'card' }>; movesBefore: number }> = [];
  for (const raw of list) {
    const cls = orderClass(raw);
    const d = decodeOrder(raw);
    if (!d) {
      unread.push(cls);
      continue;
    }
    if (d.kind === 'deploy') {
      orders.push({ kind: 'deploy', territory: d.territoryId, armies: d.armies });
      continue;
    }
    if (d.kind === 'move') {
      movesSeen += 1;
      orders.push({
        kind: 'move',
        from: d.from,
        to: d.to,
        armies: d.armies,
        ...(d.mode === 'attack' ? { mode: 'attack-only' as const } : {}),
        ...(d.mode === 'transfer' ? { mode: 'transfer-only' as const } : {}),
        ...(d.percent ? { percent: true as const } : {}),
        ...(d.attackTeammates ? { attack_teammates: true as const } : {}),
        ...(d.commander ? { commander: true as const } : {}),
      });
      continue;
    }
    if (d.kind === 'discard') {
      if (d.cardId === undefined) unread.push(`${cls} (no card id)`);
      else orders.push({ kind: 'discard', card: d.cardId });
      continue;
    }
    const card = { kind: 'card' as const, card: d.cardId ?? d.name, cardType: d.name };
    const ints = d.own.filter(isInt);
    let fieldsOf: Record<string, unknown> | undefined;
    let missingPlayer: number | undefined;
    const who = (n: number | undefined) => {
      if (n === undefined) return undefined;
      const id = feedId(n);
      if (id === undefined) missingPlayer = n;
      return id;
    };
    if (PLAIN_CARDS.has(d.cls)) fieldsOf = {};
    else if (TERRITORY_CARDS.has(d.cls) && ints.length === 1) fieldsOf = { target: ints[0] };
    else if (d.cls === 'Surveillance' && ints.length === 1) fieldsOf = { bonus: ints[0] };
    else if (PLAYER_CARDS.has(d.cls) && ints.length === 1) fieldsOf = { player: who(ints[0]) };
    else if (d.cls === 'Gift' && ints.length === 2) fieldsOf = { target: ints[1], player: who(ints[0]) };
    else if (d.cls === 'Diplomacy' && ints.length === 2) fieldsOf = { players: [who(ints[0]), who(ints[1])] };
    else if (d.cls === 'Airlift') {
      // An optional Armies, then from, a legacy count the client leaves 0, to.
      const army = armiesOf(d.own[0]);
      if (army && ints.length === 3) {
        fieldsOf = { from: ints[0], to: ints[2], armies: army.count, ...(army.commander ? { commander: true as const } : {}) };
      }
    }
    if (missingPlayer !== undefined) {
      unread.push(`${cls} (player ${missingPlayer} is not in the game)`);
      continue;
    }
    if (!fieldsOf) {
      unread.push(cls);
      continue;
    }
    const order = { ...card, ...fieldsOf } as Extract<MyOrder, { kind: 'card' }>;
    orders.push(order);
    if (d.cls === 'OrderDelay') delays.push({ order, movesBefore: movesSeen });
  }
  // Order Delay is written above the move it delays (`before`, 1-based over the moves); after every move, none.
  for (const { order, movesBefore } of delays) if (movesBefore < movesSeen) order.before = movesBefore + 1;
  return { orders, unread };
}
