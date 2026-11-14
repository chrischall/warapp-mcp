// Game chat as data: one line shape for both sources, with the channel each message was sent on.
//
// - The web client's GameRefresh (method 39) answers `warlight.shared.GameDetailsAndChat`, whose first
//   field is the chat: a list of `warlight.shared.GameMessage`. Both are decoded by the client bundle's
//   own readers, found by their stable registered type names; fields are taken by read order and
//   checked by type, never by their minified names (docs/WEB-PROTOCOL.md, Chat). The SendChat reply is
//   the same message list. UNVERIFIED live: the field meanings come from how the client's chat UI uses
//   them (the sender, the channel, -1 public, else a team; the private counterpart; the turn).
// - GameFeed's `GetChat=true` list is read loosely: it is not documented, and whether it carries team
//   or private messages, or any channel field, is unknown. A message with no channel field is `unknown`.
//
// Readers here never throw: a reply in a shape they do not understand is `undefined`, and the caller
// falls back (GameRefresh to GameFeed) or reports the outcome as unreadable.

import type { ClassReader } from './live.js';
import type { Reader } from './protocol/codec.js';
import { fields, isObj } from './protocol/decoded.js';
import { asInt } from './scalars.js';

export const GAME_DETAILS_AND_CHAT = 'warlight.shared.GameDetailsAndChat';
export const GAME_MESSAGE = 'warlight.shared.GameMessage';

/** GameMessage field positions in read order, and its whole field count. */
const GM = { date: 0, sender: 1, group: 2, id: 4, text: 5, channel: 6, to: 7, turn: 9 } as const;
export const GAME_MESSAGE_FIELDS = 10;

/** The public channel's value (any other is a team). */
export const PUBLIC_CHANNEL = -1;

export type ChatChannel = 'public' | 'team' | 'private' | 'unknown';
export const CHAT_CHANNELS: readonly ChatChannel[] = ['public', 'team', 'private', 'unknown'];

/** One chat message from either source, players by in-game id as the source gave them. */
export interface ChatLine {
  /** The message id (web source). */
  id?: string;
  /** The sender's in-game id; `null` for a system line or when the source named no id. */
  sender: number | null;
  /** GameFeed only: a sender given as a name rather than an id. */
  senderName?: string;
  text: string;
  /** The time as the source gave it (the web source: ISO). */
  time?: string;
  /** The time in epoch ms, when it could be read. */
  timeMs?: number;
  turn: number | null;
  channel: ChatChannel;
  /** A team message's team. */
  team?: number;
  /** A private message's recipient (in-game id). */
  to?: number;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const optInt = (v: unknown): v is number | null => v === null || isInt(v);

/** One decoded GameMessage as a line; `undefined` when a field is not what it should be. */
function webLine(m: unknown): ChatLine | undefined {
  if (!isObj(m) || m.$type !== GAME_MESSAGE) return undefined;
  const f = fields(m);
  if (f.length !== GAME_MESSAGE_FIELDS) return undefined;
  const date = f[GM.date];
  const sender = f[GM.sender];
  const group = f[GM.group];
  const id = f[GM.id];
  const text = f[GM.text];
  const channel = f[GM.channel];
  const to = f[GM.to];
  const turn = f[GM.turn];
  if (!(date === null || date instanceof Date) || !optInt(sender) || !optInt(group) || !optInt(to) || !optInt(turn)) return undefined;
  if (!(id === null || typeof id === 'string' || isInt(id)) || typeof text !== 'string' || !isInt(channel)) return undefined;
  const line: ChatLine = { sender, text, turn, channel: 'unknown' };
  if (id !== null) line.id = String(id);
  if (date !== null && Number.isFinite(date.getTime())) {
    line.time = date.toISOString();
    line.timeMs = date.getTime();
  }
  // The client sorts a message into a tab the same way: a private counterpart first, then a game
  // group (no channel of ours), then the channel (-1 public, else the team).
  if (to !== null) {
    line.channel = 'private';
    line.to = to;
  } else if (group !== null) {
    line.channel = 'unknown';
  } else if (channel === PUBLIC_CHANNEL) {
    line.channel = 'public';
  } else {
    line.channel = 'team';
    line.team = channel;
  }
  return line;
}

const numericId = (id: string | undefined): number => {
  const n = id === undefined ? Number.NaN : Number(id);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
};

/** Oldest first: by time where both have one, else by id. */
function byAge(a: ChatLine, b: ChatLine): number {
  if (a.timeMs !== undefined && b.timeMs !== undefined && a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
  return numericId(a.id) - numericId(b.id);
}

/** A decoded message list as lines, oldest first; `undefined` when any message is unreadable. */
function webLines(list: unknown): ChatLine[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: ChatLine[] = [];
  for (const m of list) {
    if (m === null) continue;
    const line = webLine(m);
    if (!line) return undefined;
    out.push(line);
  }
  return out.sort(byAge);
}

/**
 * The chat of a GameRefresh reply (the body positioned at the result-present flag), oldest first;
 * `undefined` when there is no result, no chat list, or a shape this server does not understand.
 */
export function readGameRefreshChat(bundle: ClassReader, body: Reader): ChatLine[] | undefined {
  try {
    if (!body.bool()) return undefined;
    const ret = bundle.readClass(GAME_DETAILS_AND_CHAT, body);
    if (!isObj(ret) || ret.$type !== GAME_DETAILS_AND_CHAT) return undefined;
    const list = fields(ret)[0];
    return list === null ? undefined : webLines(list);
  } catch {
    return undefined;
  }
}

/**
 * The SendChat reply: the updated message list, read straight after the result-present flag (each
 * message behind its own present flag), oldest first; `undefined` when it cannot be read.
 */
export function readSendChatReply(bundle: ClassReader, body: Reader): ChatLine[] | undefined {
  try {
    if (!body.bool()) return undefined;
    const list = body.list((r) => (r.bool() ? bundle.readClass(GAME_MESSAGE, r) : null));
    return list === null ? undefined : webLines(list);
  } catch {
    return undefined;
  }
}

// ---------- GameFeed ----------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const pick = (r: Rec, keys: readonly string[]): unknown => {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) return r[k];
  return undefined;
};

const SENDER_KEYS = ['playerID', 'playerId', 'sender', 'senderID', 'from', 'player'] as const;
const TEXT_KEYS = ['message', 'text', 'chat', 'msg', 'body'] as const;
const TIME_KEYS = ['time', 'date', 'dateTime', 'created', 'sent', 'when'] as const;
const LIST_KEYS = ['chat', 'messages', 'Chat'] as const;
const TURN_KEYS = ['turn', 'turnNumber', 'Turn'] as const;
// None of these has been seen in a GameFeed reply (V2 in docs/PLAN-TEAMS.md): read only to be tolerant.
const CHANNEL_KEYS = ['channel', 'Channel', 'teamID', 'teamId', 'team', 'Team'] as const;
const RECIPIENT_KEYS = ['recipientID', 'recipientId', 'recipient', 'toPlayerID', 'toPlayerId', 'privateTo', 'to'] as const;

/**
 * GameFeed's chat as lines, in the order sent (most recent last): a message is anything with a text
 * field, its sender an id (GameFeed's `playerID` is the in-game id) or a name. `undefined` when
 * nothing recognisable is there, so the caller can pass the raw value through instead.
 */
export function feedChatLines(raw: unknown): ChatLine[] | undefined {
  let list: unknown = raw;
  if (isRec(list)) list = pick(list, LIST_KEYS);
  if (!Array.isArray(list)) return undefined;
  const out: ChatLine[] = [];
  for (const item of list) {
    if (!isRec(item)) return undefined;
    const text = pick(item, TEXT_KEYS);
    if (typeof text !== 'string') return undefined;
    const from = pick(item, SENDER_KEYS);
    const id = asInt(from);
    const line: ChatLine = { sender: id ?? null, text, turn: asInt(pick(item, TURN_KEYS)) ?? null, channel: 'unknown' };
    if (id === undefined && typeof from === 'string' && from !== '') line.senderName = from;
    const time = pick(item, TIME_KEYS);
    if (typeof time === 'string' || typeof time === 'number') {
      line.time = String(time);
      const ms = typeof time === 'string' ? Date.parse(time) : Number.NaN;
      if (Number.isFinite(ms)) line.timeMs = ms;
    }
    const to = asInt(pick(item, RECIPIENT_KEYS));
    const channel = asInt(pick(item, CHANNEL_KEYS));
    if (to !== undefined) {
      line.channel = 'private';
      line.to = to;
    } else if (channel !== undefined) {
      if (channel === PUBLIC_CHANNEL) line.channel = 'public';
      else {
        line.channel = 'team';
        line.team = channel;
      }
    }
    out.push(line);
  }
  return out;
}
