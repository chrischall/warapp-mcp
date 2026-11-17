// A hand-written synthetic bundle carrying the classes a GetInAppNotifications reply reads
// (GetInAppNotificationsReturn → InAppNotification), in the same *shape* as war.app's generated
// readers and with the InAppNotification fields read in the documented order (docs/WEB-PROTOCOL.md,
// Notifications and read marks): sent (datetime), data (a JSON string), the id (a decimal string the
// client parses), an int32, a string, the title, the unread flag; then the total. Every var, field name
// and value here is made up; nothing is taken from the real bundle. `writeInAppNotificationsReturn`
// encodes matching bytes with this project's Writer.
import type { Writer } from '../../src/protocol/codec.js';
import { REQUIRED_HELPER_DEFS } from './mini-bundle.js';

export const NOTIFICATIONS_BUNDLE = [
  REQUIRED_HELPER_DEFS,
  'function Nlr(){}function Nnt(){}',
  'W["warlight.shared.GetInAppNotificationsReturn"]=Nlr;',
  'Nlr.Ha=function(a,b,d){null==d&&(d=243);return Nlr.rd(a,d)};',
  'Nlr.rd=function(a,b){var d=new Nlr,e=a.Ua()?P.Sd(a,function(){return a.Ua()?Nnt.Ha(a,d,b):null}):null;' +
    'd.n1=e;d.n2=P.Ya(a);return d};',
  'W["warlight.shared.InAppNotification"]=Nnt;',
  'Nnt.Ha=function(a){return Nnt.rd(a)};',
  'Nnt.rd=function(a){var b=new Nnt;b.f0=P.Td(a);b.f1=P.wc(a);b.f2=O.fA(P.wc(a));b.f3=P.Ya(a);' +
    'b.f4=P.wc(a);b.f5=P.wc(a);b.f6=P.Yc(a);return b};',
].join('\n');

/** One synthetic in-app notification. */
export interface SyntheticNotification {
  /** The id, sent as decimal text. */
  id: string;
  sent?: Date | null;
  /** The data JSON (default `{}`); a string is sent as it is, an object as its JSON. */
  data?: string | Record<string, unknown> | null;
  /** The int32 the client never reads. */
  n3?: number;
  /** The string the client never reads. */
  n4?: string | null;
  title?: string | null;
  unread?: boolean;
}

/** One notification record (no present flag). */
function writeNotification(w: Writer, n: SyntheticNotification): void {
  const data = n.data === undefined ? '{}' : n.data === null || typeof n.data === 'string' ? n.data : JSON.stringify(n.data);
  w.date(n.sent === undefined ? new Date(Date.UTC(2026, 10, 15, 12, 0, 0)) : n.sent)
    .string(data)
    .string(n.id)
    .int32(n.n3 ?? 0)
    .string(n.n4 ?? null)
    .string(n.title === undefined ? 'A notification' : n.title)
    .bool(n.unread ?? true);
}

/**
 * A GetInAppNotifications result: the result-present flag, then the return record (the list, then the
 * total, default the list's length). `null` writes an absent list.
 */
export function writeInAppNotificationsReturn(w: Writer, items: SyntheticNotification[] | null, total?: number): void {
  w.bool(true);
  if (items === null) w.bool(false);
  else {
    w.bool(true).int32(items.length);
    for (const n of items) {
      w.bool(true);
      writeNotification(w, n);
    }
  }
  w.int32(total ?? items?.length ?? 0);
}
