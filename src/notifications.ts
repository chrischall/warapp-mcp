// war.app's in-app notifications (#311): a GetInAppNotifications reply (method 317), decoded by the
// client bundle's own readers by stable type name, like GetMyGames — fields by read order, checked by
// type, never by their minified names (docs/WEB-PROTOCOL.md, Notifications and read marks).
// UNVERIFIED live: read from the bundle, nothing here has been checked against a real reply.
//
// What a tool reports is name-free beyond ids: a notification's id, time, unread flag, a kind and the
// game id its link names. Its title and data are text war.app writes (with other players' names in
// them): they are read only to classify it, never passed on. The record's fourth field, a string the
// client never reads (perhaps a type name), is unverified free text: it is neither reported nor used.

import { McpToolError } from '@chrischall/mcp-utils';
import type { ClassReader } from './live.js';
import type { Reader } from './protocol/codec.js';
import { fields, isObj } from './protocol/decoded.js';
import { NOTIFICATION_ID } from './protocol/methods.js';

export { NOTIFICATIONS_PAGE_SIZE } from './protocol/methods.js';

export const IN_APP_NOTIFICATIONS_RETURN = 'warlight.shared.GetInAppNotificationsReturn';
export const IN_APP_NOTIFICATION = 'warlight.shared.InAppNotification';

/** InAppNotification field positions in read order, and its whole field count. */
const NF = { sent: 0, data: 1, id: 2, n3: 3, n4: 4, title: 5, unread: 6 } as const;
export const IN_APP_NOTIFICATION_FIELDS = 7;

/** One notification as the reply carries it. */
export interface RawNotification {
  /** Decimal text: what the acknowledge and delete calls send back. */
  id: string;
  sent: Date | null;
  /** A JSON object (Body, Url / UrlText, Urls, NotificationQuestion), war.app's text. */
  data: string | null;
  /** An int32 the client never reads. */
  n3: number;
  /** A string the client never reads: unverified free text, never reported or used to classify. */
  n4: string | null;
  /** The one line the client lists (war.app's text, other players' names included). */
  title: string | null;
  unread: boolean;
}

export type NotificationKind = 'game-ended' | 'other';

/** One notification as a tool reports it: ids, time and flags only. */
export interface Notification {
  id: string;
  kind: NotificationKind;
  /** The game the notification's war.app link names, when it names one. */
  gameId: number | null;
  /** ISO time it was sent, when the reply gave one. */
  time: string | null;
  unread: boolean;
}

/** The GetInAppNotifications reply arrived in a shape this server does not understand. */
export class NotificationsFormatError extends McpToolError {
  constructor(detail: string) {
    super(`war.app's notification list arrived in an unexpected shape (${detail}).`, {
      kind: 'unknown',
      hint: 'The war.app client may have changed; the notifications can still be read in the war.app tab.',
    });
    this.name = 'NotificationsFormatError';
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isStr = (v: unknown): v is string | null => v === null || typeof v === 'string';

function notificationOf(n: unknown): RawNotification {
  if (!isObj(n) || n.$type !== IN_APP_NOTIFICATION) throw new NotificationsFormatError('a notification is not an InAppNotification');
  const f = fields(n);
  if (f.length !== IN_APP_NOTIFICATION_FIELDS) {
    throw new NotificationsFormatError(`an InAppNotification has ${f.length} fields, not ${IN_APP_NOTIFICATION_FIELDS}`);
  }
  const sent = f[NF.sent];
  const data = f[NF.data];
  const rawId = f[NF.id];
  const n3 = f[NF.n3];
  const n4 = f[NF.n4];
  const title = f[NF.title];
  const unread = f[NF.unread];
  if (!(sent === null || sent instanceof Date) || !isStr(data) || !isInt(n3) || !isStr(n4) || !isStr(title) || typeof unread !== 'boolean') {
    throw new NotificationsFormatError('an InAppNotification lacks its fields');
  }
  // The client parses the id text as a number; the interpreter may hand back either.
  const id = typeof rawId === 'string' ? rawId.trim() : isInt(rawId) && rawId >= 0 ? String(rawId) : undefined;
  if (id === undefined || !NOTIFICATION_ID.test(id)) throw new NotificationsFormatError('a notification id is not a number');
  return { id, sent: sent !== null && Number.isFinite(sent.getTime()) ? sent : null, data, n3, n4, title, unread };
}

/** Read a GetInAppNotifications result (the body positioned at the result-present flag). */
export function readInAppNotifications(bundle: ClassReader, body: Reader): { items: RawNotification[]; total: number } {
  if (!body.bool()) return { items: [], total: 0 };
  const ret = bundle.readClass(IN_APP_NOTIFICATIONS_RETURN, body);
  if (!isObj(ret) || ret.$type !== IN_APP_NOTIFICATIONS_RETURN) throw new NotificationsFormatError('no GetInAppNotificationsReturn');
  const f = fields(ret);
  if (f.length !== 2) throw new NotificationsFormatError(`a GetInAppNotificationsReturn has ${f.length} fields, not 2`);
  const [list, total] = f;
  if (!(list === null || Array.isArray(list)) || !isInt(total)) throw new NotificationsFormatError('no notification list');
  const items = (list ?? []).filter((n) => n !== null).map(notificationOf);
  return { items, total: Math.max(total, items.length) };
}

/** The most data text read for a link: anything longer is not looked at. */
const MAX_DATA = 64 * 1024;
/** Hosts a game link may name (war.app, and the old Warzone domain the site still answers on). */
const GAME_HOSTS = new Set(['war.app', 'www.war.app', 'warzone.com', 'www.warzone.com']);

/** The game id one link names (`GameID=` on a war.app page, or a relative path), else null. */
function gameIdOfUrl(url: unknown): number | null {
  if (typeof url !== 'string' || url.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(url, 'https://war.app/');
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!GAME_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  for (const [k, v] of parsed.searchParams) {
    if (k.toLowerCase() === 'gameid' && /^\d{1,10}$/.test(v)) {
      const id = Number(v);
      if (id > 0 && id <= 0x7fffffff) return id;
    }
  }
  return null;
}

/** The game a notification's data links to: its `Url`, else the first of its `Urls` that names one. */
export function gameIdFromData(data: string | null): number | null {
  if (data === null || data.length > MAX_DATA) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObj(obj)) return null;
  const direct = gameIdOfUrl(obj.Url);
  if (direct !== null) return direct;
  if (Array.isArray(obj.Urls)) {
    for (const u of obj.Urls.slice(0, 20)) {
      const id = isObj(u) ? gameIdOfUrl(u.Url) : null;
      if (id !== null) return id;
    }
  }
  return null;
}

/**
 * The title of a game-ended notification, in the client's own wording (an owner's screenshot,
 * 2026-11-16): `Game "<name>" has ended. You can now view its history`. Matched on that structure,
 * anchored at both the leading `Game "` and the `" has ended.` after the name, never on a bare
 * "ended" or "finished" anywhere in the text (another notification can quote a player's words).
 * The name may itself hold quotes, so it is matched greedily up to the last `" has ended.`.
 */
const ENDED_TITLE = /^Game ".*" has ended\.(\s|$)/s;
/** The longest title looked at. */
const MAX_TITLE = 500;

/** A notification as a tool reports it: ids, time, flags and its kind, never its text. */
export function classifyNotification(n: RawNotification): Notification {
  const ended = n.title !== null && n.title.length <= MAX_TITLE && ENDED_TITLE.test(n.title);
  return {
    id: n.id,
    kind: ended ? 'game-ended' : 'other',
    gameId: gameIdFromData(n.data),
    time: n.sent ? n.sent.toISOString() : null,
    unread: n.unread,
  };
}
