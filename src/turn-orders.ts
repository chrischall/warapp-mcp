// The turn just resolved, as this player saw it (#570): every visible order of every player in the
// LatestGameInfo's `warlight.shared.GameTurn` (docs/WEB-PROTOCOL.md "The last turn's orders", VERIFIED live
// 2026-11-22: { a null, the order list, int32 turn 0-based, a date }; the list held every player's visible
// deploys and moves, card plays and other turn events). Each order is read by `decodeOrder` (the same reader as
// my own and my teammates' entered orders, src/team-orders.ts) and its player is the last integer field of the
// order record, the base's player in-game id — the position #427 read for Reinforcement plays (verified); for
// deploys and moves it follows the bundle's base reader (UNVERIFIED live). A card play keeps its card name only
// (its own fields hold in-game ids not mapped here); any other order kind (a card received, an active card worn
// off, …) is kept by its class name only. Attack results (the `…Result` records) are not decoded: what an attack
// achieved shows on the next board. Ids and counts only, never a name. Pure; tolerant: nothing throws.
import { playersByInGameId } from './live.js';
import type { Player } from './normalize.js';
import { fields, isObj, type DecodedRecord } from './protocol/decoded.js';
import { decodeOrder, orderClass } from './team-orders.js';

/** Orders kept per turn at most (a mega game can show hundreds); the rest are counted. */
export const MAX_SEEN_ORDERS = 3000;

const GAME_TURN = /\.GameTurn$/;

/** One visible order of the resolved turn, ids and counts only. */
export interface SeenOrder {
  /** The player's GameFeed id; `null` when no seat matches (or none was read). */
  player: number | null;
  kind: 'deploy' | 'move' | 'card' | 'discard' | 'other';
  territoryId?: number;
  armies?: number;
  from?: number;
  to?: number;
  mode?: 'attack' | 'transfer' | 'attack-transfer';
  percent?: true;
  commander?: true;
  /** A card play: the card's name. */
  card?: string;
  /** Any other order: its class name (e.g. `GameOrderReceiveCard`). */
  cls?: string;
}

export interface SeenTurn {
  /** The turn played (1-based). */
  turn: number;
  orders: SeenOrder[];
  /** Orders past {@link MAX_SEEN_ORDERS}, not kept. */
  omitted?: number;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** The resolved turn in a decoded LatestGameInfo, its players mapped to GameFeed ids; `undefined` without one. */
export function readSeenTurn(info: unknown, players: readonly Player[]): SeenTurn | undefined {
  if (!isObj(info)) return undefined;
  const turn = fields(info).find((v): v is DecodedRecord => isObj(v) && typeof v.$type === 'string' && GAME_TURN.test(v.$type));
  if (!turn) return undefined;
  const own = fields(turn);
  const ints = own.filter(isInt);
  const list = own.find((v): v is unknown[] => Array.isArray(v));
  if (ints.length !== 1 || !list) return undefined;
  const byInGame = playersByInGameId(players);
  const orders: SeenOrder[] = [];
  let omitted = 0;
  for (const o of list) {
    if (!isObj(o)) continue;
    if (orders.length >= MAX_SEEN_ORDERS) {
      omitted++;
      continue;
    }
    const inGame = fields(o).filter(isInt).at(-1);
    const player = inGame !== undefined && byInGame.has(inGame) ? byInGame.get(inGame)!.id : null;
    const d = decodeOrder(o);
    if (!d) orders.push({ player, kind: 'other', cls: orderClass(o) });
    else if (d.kind === 'deploy') orders.push({ player, kind: 'deploy', territoryId: d.territoryId, armies: d.armies });
    else if (d.kind === 'move')
      orders.push({
        player,
        kind: 'move',
        from: d.from,
        to: d.to,
        armies: d.armies,
        mode: d.mode,
        ...(d.percent ? { percent: true as const } : {}),
        ...(d.commander ? { commander: true as const } : {}),
      });
    else if (d.kind === 'card') orders.push({ player, kind: 'card', card: d.name });
    else orders.push({ player, kind: 'discard' });
  }
  return { turn: ints[0]! + 1, orders, ...(omitted ? { omitted } : {}) };
}
