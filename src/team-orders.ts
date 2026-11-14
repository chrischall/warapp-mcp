// Teammates' entered orders and picks (C1, docs/PLAN-TEAMS.md), projected from a decoded LatestGameInfo.
//
// From the client bundle (read 2026-11-14, not live): LatestGameInfo carries, after the standings, a dict
// in-game player id → `warlight.shared.TeammateOrders` { a stamp (int), the orders entered (a list of
// GameOrder, during a turn), the picks entered (a list of territory ids, while distributing) }. The client
// shows a teammate's orders and picks from it, and counts the card plays and discards in it against the
// team's hand. UNVERIFIED live (V5): whether war.app fills it before the teammate commits, and what it holds
// once they have.
//
// Field names are minified, so the dict is found by the registered type name of its values, and an order's
// kind by its class name. Within an order, fields are read by kind and read order, as the bundle's readers
// fill them: Deploy (territory, free flag, armies, then the base: player …); AttackTransfer (attack-teammates
// flag, mode byte, by-percent flag, from, Armies, to, then the base); a card play (its own fields, the card
// GUID, the base); Discard (the GUID, the base). Tolerant throughout: absent means unknown, an entry it
// cannot read is listed as unread, nothing throws.

import { cardTypeByName, cardTypeName, normalizeGuid } from './cards.js';
import { playersByInGameId } from './live.js';
import type { Player } from './normalize.js';
import { fields, isObj, type DecodedRecord } from './protocol/decoded.js';

const TEAMMATE_ORDERS = 'warlight.shared.TeammateOrders';
const ORDER_PREFIX = 'warlight.shared.GameOrder';
const DEPLOY = 'warlight.shared.GameOrderDeploy';
const ATTACK_TRANSFER = 'warlight.shared.GameOrderAttackTransfer';
const DISCARD = 'warlight.shared.GameOrderDiscard';
const PLAY_CARD = 'warlight.shared.GameOrderPlayCard';
const ARMIES = 'warlight.shared.Armies';
const COMMANDER = 'warlight.shared.Commander';

/** AttackTransfer's mode byte (docs/WEB-PROTOCOL.md "Orders"). */
const MODES: Readonly<Record<number, TeamMove['mode']>> = { 1: 'attack', 2: 'transfer', 3: 'attack-transfer' };

/** Card-play classes whose name is not the card's (the Emergency Blockade card plays as "Abandon"). */
const CARD_CLASS_TYPES: Readonly<Record<string, number>> = { Abandon: 3 };

export interface TeamDeploy {
  territoryId: number;
  armies: number;
}

export interface TeamMove {
  from: number;
  to: number;
  /** Armies, or the percentage when `percent`. */
  armies: number;
  mode: 'attack' | 'transfer' | 'attack-transfer';
  percent?: true;
  attackTeammates?: true;
  /** The mover's commander goes with it. */
  commander?: true;
}

export interface TeamCardPlay {
  /** The card instance GUID, when the order carries a readable one. */
  cardId?: string;
  /** The card type id; `null` when the class names none this server knows (e.g. a fogged play). */
  type: number | null;
  name: string;
}

/** The orders one teammate has entered this turn. */
export interface TeamOrders {
  deploys: TeamDeploy[];
  moves: TeamMove[];
  cards: TeamCardPlay[];
  discards: Array<{ cardId?: string }>;
  /** Orders present but not read: their class (short name), or `unknown`. */
  unread: string[];
}

/** One teammate's entry, keyed by in-game id. */
export interface RawTeammateOrders {
  inGameId: number;
  /** `null`: war.app sent no order list (none entered, or not sent: unknown). */
  orders: TeamOrders | null;
  /** Territory ids in priority order; `null`: no pick list sent. */
  picks: number[] | null;
}

/** One teammate's entry at the tool boundary: the player by GameFeed id (the in-game id when unknown). */
export interface TeammateOrders {
  playerId: number;
  orders: TeamOrders | null;
  picks: number[] | null;
}

type Obj = DecodedRecord;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const shortName = (type: unknown) => (typeof type === 'string' ? type.replace(/^warlight\.shared\./, '') : 'unknown');

/** The teammate-orders dict of a decoded LatestGameInfo: the field whose values are TeammateOrders. */
function teammateDict(info: unknown): Array<[unknown, Obj]> | undefined {
  if (!isObj(info)) return undefined;
  for (const v of fields(info)) {
    if (!Array.isArray(v)) continue;
    const pairs = v.filter((e): e is [unknown, unknown] => Array.isArray(e) && e.length === 2);
    if (pairs.some(([, x]) => isObj(x) && x.$type === TEAMMATE_ORDERS)) {
      return pairs.filter((p): p is [unknown, Obj] => isObj(p[1]) && p[1].$type === TEAMMATE_ORDERS);
    }
  }
  return undefined;
}

function armiesOf(a: unknown): { count: number; commander: boolean } | undefined {
  if (!isObj(a) || a.$type !== ARMIES) return undefined;
  const f = fields(a);
  const numbers = f.filter(isInt);
  if (numbers.length !== 1) return undefined;
  const units = f.find((x): x is unknown[] => Array.isArray(x)) ?? [];
  return { count: numbers[0]!, commander: units.some((u) => isObj(u) && u.$type === COMMANDER) };
}

/** Reads one order into `out`; false when its shape is not understood. */
function readOrder(o: Obj, out: TeamOrders): boolean {
  const type = String(o.$type);
  const f = fields(o);
  const ints = f.filter(isInt);
  if (type === DEPLOY) {
    if (ints.length < 2) return false;
    out.deploys.push({ territoryId: ints[0]!, armies: ints[1]! });
    return true;
  }
  if (type === ATTACK_TRANSFER) {
    // attackTeammates, mode, byPercent, from, Armies, to, then the base (player …).
    const [attackTeammates, mode, percent, from, armies, to] = f;
    const army = armiesOf(armies);
    if (typeof attackTeammates !== 'boolean' || typeof percent !== 'boolean' || !isInt(mode) || !isInt(from) || !isInt(to) || !army) return false;
    const m = MODES[mode];
    if (!m) return false;
    out.moves.push({
      from,
      to,
      armies: army.count,
      mode: m,
      ...(percent ? { percent: true as const } : {}),
      ...(attackTeammates ? { attackTeammates: true as const } : {}),
      ...(army.commander ? { commander: true as const } : {}),
    });
    return true;
  }
  const cardId = f.map(normalizeGuid).find((g) => g !== undefined);
  if (type === DISCARD) {
    out.discards.push(cardId !== undefined ? { cardId } : {});
    return true;
  }
  if (type.startsWith(PLAY_CARD)) {
    const cls = type.slice(PLAY_CARD.length);
    const t = CARD_CLASS_TYPES[cls] ?? cardTypeByName(cls) ?? null;
    out.cards.push({ ...(cardId !== undefined ? { cardId } : {}), type: t, name: t !== null ? cardTypeName(t) : cls || 'card' });
    return true;
  }
  return false;
}

function ordersOf(list: unknown): TeamOrders | null {
  if (!Array.isArray(list)) return null;
  const out: TeamOrders = { deploys: [], moves: [], cards: [], discards: [], unread: [] };
  for (const o of list) {
    if (o === null) continue;
    if (!isObj(o) || typeof o.$type !== 'string' || !o.$type.startsWith(ORDER_PREFIX) || !readOrder(o, out)) {
      out.unread.push(isObj(o) ? shortName(o.$type) : 'unknown');
    }
  }
  return out;
}

/**
 * Every teammate entry of a decoded LatestGameInfo, by in-game id (ascending). `undefined` when the info
 * carries no teammate orders at all (not a team game, or war.app sent none: unknown). Never throws.
 */
export function readTeammateOrders(info: unknown): Map<number, RawTeammateOrders> | undefined {
  const dict = teammateDict(info);
  if (!dict) return undefined;
  const out = new Map<number, RawTeammateOrders>();
  for (const [key, entry] of dict.filter(([k]) => isInt(k)).sort((a, b) => (a[0] as number) - (b[0] as number))) {
    // The stamp, the orders, the picks, in read order.
    const [, orders, picks] = fields(entry);
    out.set(key as number, {
      inGameId: key as number,
      orders: ordersOf(orders),
      picks: Array.isArray(picks) ? picks.filter(isInt) : null,
    });
  }
  return out;
}

/** {@link readTeammateOrders} keyed by GameFeed id (the in-game id when the player is unknown). */
export function teammateOrdersOf(info: unknown, players: readonly Player[]): TeammateOrders[] | undefined {
  const raw = readTeammateOrders(info);
  if (!raw) return undefined;
  const byInGame = playersByInGameId(players);
  return [...raw.values()].map((r) => ({ playerId: byInGame.get(r.inGameId)?.id ?? r.inGameId, orders: r.orders, picks: r.picks }));
}
