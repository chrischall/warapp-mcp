// Owner request 2026-11-24 (Airlift part 5): after warapp_submit_turn commits, the Airlifts it sent are read back
// from war.app's own copy of my committed orders (LatestGameInfo's active orders, src/my-orders.ts, the read
// warapp_get_my_orders makes; VERIFIED live 2026-11-22 for committed turns) and compared field by field: the
// card instance, from, to, armies and the commander. Pure; the tool throws when one is missing or altered.
import { normalizeGuid } from '../cards.js';
import type { MyOrders } from '../my-orders.js';
import type { TurnOrder } from '../protocol/methods.js';

/** One Airlift as sent and as compared. */
export interface AirliftLine {
  card: string;
  from: number;
  to: number;
  armies: number;
  commander: boolean;
}

export interface AirliftReadBack {
  /** `verified`: every Airlift read back as sent; `mismatch`: one is missing or altered; `unread`: the orders could not be read. */
  status: 'verified' | 'mismatch' | 'unread';
  sent: AirliftLine[];
  missing: AirliftLine[];
  /** Sent, and read back with other fields. */
  altered: { sent: AirliftLine; read: AirliftLine }[];
}

/** The Airlift plays among the orders sent. */
export function sentAirlifts(orders: readonly TurnOrder[]): AirliftLine[] {
  return orders.flatMap((o) =>
    o.kind === 'card' && o.card === 'Airlift' && o.from !== undefined && o.to !== undefined && o.armies !== undefined
      ? [{ card: normalizeGuid(o.cardId) ?? o.cardId, from: o.from, to: o.to, armies: o.armies, commander: o.commander !== undefined }]
      : [],
  );
}

const same = (a: AirliftLine, b: AirliftLine) => a.from === b.from && a.to === b.to && a.armies === b.armies && a.commander === b.commander;

/** Compare the Airlifts sent with my orders read back (`null`: unknown). */
export function checkAirlifts(sent: readonly AirliftLine[], read: MyOrders | null): AirliftReadBack {
  if (!read) return { status: 'unread', sent: [...sent], missing: [], altered: [] };
  const back: AirliftLine[] = read.orders.flatMap((o) =>
    o.kind === 'card' && o.cardType === 'Airlift' && o.from !== undefined && o.to !== undefined
      ? [{ card: normalizeGuid(o.card) ?? o.card, from: o.from, to: o.to, armies: o.armies ?? 0, commander: o.commander === true }]
      : [],
  );
  const missing: AirliftLine[] = [];
  const altered: AirliftReadBack['altered'] = [];
  const used = new Set<number>();
  for (const s of sent) {
    // The same card instance, else (a card swapped for another of its type, as the validator may do) one with the same fields.
    let i = back.findIndex((b, k) => !used.has(k) && b.card === s.card);
    if (i < 0) i = back.findIndex((b, k) => !used.has(k) && same(b, s));
    if (i < 0) {
      missing.push(s);
      continue;
    }
    used.add(i);
    if (!same(back[i]!, s)) altered.push({ sent: s, read: back[i]! });
  }
  return { status: missing.length || altered.length ? 'mismatch' : 'verified', sent: [...sent], missing, altered };
}

const line = (a: AirliftLine) => `${a.armies}${a.commander ? ' + commander' : ''} from ${a.from} to ${a.to}`;

/** The error message for a mismatch: what is missing or altered, by id. */
export function mismatchMessage(r: AirliftReadBack, turn: number, game: number): string {
  const parts = [
    ...r.missing.map((a) => `the Airlift of ${line(a)} is missing`),
    ...r.altered.map((x) => `the Airlift of ${line(x.sent)} reads back as ${line(x.read)}`),
  ];
  return (
    `Your orders for game ${game}, turn ${turn} are committed, but war.app's copy of them does not match what was sent: ` +
    `${parts.join('; ')}. Nothing was resent.`
  );
}

/** The result fields a commit records beside its orders (#556): kept in the error when an Airlift reads back wrong. */
const RECORDED_KEYS = ['agreementsBroken', 'exceptionsRecorded', 'commanderRiskAccepted', 'chatReviewed'] as const;

/** One line naming what the commit recorded (a truce break, exceptions, an accepted commander risk, waived chat), or none. */
export function recordedWithCommit(result: Record<string, unknown>): string | undefined {
  const parts = RECORDED_KEYS.filter((k) => result[k] !== undefined).map((k) => `${k} ${JSON.stringify(result[k])}`);
  return parts.length ? `Recorded with this commit: ${parts.join('; ')}.` : undefined;
}

/**
 * Owner request 2026-11-24 (part B): the territory-targeted card plays read back the same way — a Bomb (and the
 * Blockades, through the same pipeline): the card instance and its target. Matched by card GUID, else (a card swapped
 * for another of its type) by the same target.
 */
export interface TargetedLine {
  card: string;
  kind: string;
  target: number;
}

export interface TargetedReadBack {
  status: 'verified' | 'mismatch' | 'unread';
  sent: TargetedLine[];
  missing: TargetedLine[];
  altered: { sent: TargetedLine; read: { card: string; target: number } }[];
}

/** The card plays of these kinds (`TurnOrder` card names, e.g. `Bomb`) among the orders sent. */
export function sentTargeted(orders: readonly TurnOrder[], kinds: ReadonlySet<string>): TargetedLine[] {
  return orders.flatMap((o) =>
    o.kind === 'card' && kinds.has(o.card) && o.target !== undefined ? [{ card: normalizeGuid(o.cardId) ?? o.cardId, kind: o.card, target: o.target }] : [],
  );
}

export function checkTargeted(sent: readonly TargetedLine[], read: MyOrders | null): TargetedReadBack {
  if (!read) return { status: 'unread', sent: [...sent], missing: [], altered: [] };
  const back = read.orders.flatMap((o) =>
    o.kind === 'card' && o.target !== undefined && o.from === undefined ? [{ card: normalizeGuid(o.card) ?? o.card, target: o.target }] : [],
  );
  const used = new Set<number>();
  const missing: TargetedLine[] = [];
  const altered: TargetedReadBack['altered'] = [];
  for (const s of sent) {
    let i = back.findIndex((b, k) => !used.has(k) && b.card === s.card);
    if (i < 0) i = back.findIndex((b, k) => !used.has(k) && b.target === s.target);
    if (i < 0) {
      missing.push(s);
      continue;
    }
    used.add(i);
    if (back[i]!.target !== s.target) altered.push({ sent: s, read: back[i]! });
  }
  return { status: missing.length || altered.length ? 'mismatch' : 'verified', sent: [...sent], missing, altered };
}

/** The error message's parts for a targeted mismatch. */
export function targetedMismatchParts(r: TargetedReadBack): string[] {
  return [
    ...r.missing.map((t) => `the ${t.kind} play on ${t.target} is missing`),
    ...r.altered.map((x) => `the ${x.sent.kind} play on ${x.sent.target} reads back on ${x.read.target}`),
  ];
}
