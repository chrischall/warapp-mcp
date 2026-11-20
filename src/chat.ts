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
import { parseFeedTime } from './normalize.js';
import { asInt } from './scalars.js';

export const GAME_DETAILS_AND_CHAT = 'warlight.shared.GameDetailsAndChat';
export const GAME_MESSAGE = 'warlight.shared.GameMessage';

/**
 * GameMessage field positions in read order, and its whole field count (protocol 243: the shared images,
 * an optional list of strings, at 5, and the reactions, an optional list of records, at 7).
 */
const GM = { date: 0, sender: 1, group: 2, id: 4, images: 5, text: 6, reactions: 7, channel: 8, to: 9, turn: 11 } as const;
export const GAME_MESSAGE_FIELDS = 12;

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
  /** A game-group message's group (web source; its channel is `unknown`). */
  group?: number;
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
  const images = f[GM.images];
  const reactions = f[GM.reactions];
  if (!(date === null || date instanceof Date) || !optInt(sender) || !optInt(group) || !optInt(to) || !optInt(turn)) return undefined;
  // Not reported, but checked: a field of another type here means the layout is not 243's.
  if (!(images === null || Array.isArray(images)) || !(reactions === null || Array.isArray(reactions))) return undefined;
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
    line.group = group;
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
 * message behind its own present flag), oldest first; `undefined` when it cannot be read. The replies of
 * RetrieveChat and RetrievePrivateMessageHistory have the same shape (the client reads them alike).
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

/** RetrieveChat's and RetrievePrivateMessageHistory's reply: a message list as SendChat's. */
export const readMessageHistoryReply = readSendChatReply;

/**
 * `lines` with `more` added, each message once (by id; a line with no id is kept as it is), oldest first.
 * GameRefresh and the history reads may both return a message.
 */
export function mergeChatLines(lines: readonly ChatLine[], more: readonly ChatLine[]): ChatLine[] {
  const ids = new Set(lines.flatMap((l) => (l.id === undefined ? [] : [l.id])));
  const out = [...lines];
  for (const l of more) {
    if (l.id !== undefined) {
      if (ids.has(l.id)) continue;
      ids.add(l.id);
    }
    out.push(l);
  }
  return out.sort(byAge);
}

/**
 * The oldest message id received among `lines` that `pick` keeps (decimal text), the "older than" marker of a
 * history read; `undefined` when there is none (the read then asks from the newest).
 */
export function oldestId(lines: readonly ChatLine[], pick: (l: ChatLine) => boolean): string | undefined {
  let best: string | undefined;
  for (const l of lines) {
    if (l.id === undefined || !/^\d{1,20}$/.test(l.id) || !pick(l)) continue;
    if (best === undefined || BigInt(l.id) < BigInt(best)) best = l.id;
  }
  return best;
}

// ---------- Read marks (RegisterChatView, #311) ----------

/** What RegisterChatView is sent to mark a game's chat read: per channel, the highest message id read. */
export interface ChatViewMarks {
  /** Absent: the public channel is not marked (sent as `-1`). */
  public?: string;
  /** Absent: the team channel is not marked (sent as `-1`). */
  team?: string;
  /** Per private conversation: the counterpart's in-game id → its mark. */
  private: Map<number, string>;
  /** Per game group: the group id → its mark. */
  groups: Map<number, string>;
  /** The channels a mark covers, in CHAT_CHANNELS order (`unknown` = the game groups). */
  channels: ChatChannel[];
}

const MESSAGE_ID = /^\d{1,20}$/;
const higher = (a: string | undefined, b: string): string => (a === undefined || BigInt(b) > BigInt(a) ? b : a);

/**
 * The read marks of web-client `lines` on `channels` (pure): per channel the highest message id among
 * them, mine included, as the client keeps it. A private conversation is keyed by its counterpart — the
 * recipient of a message I sent, else its sender — and a game group (`unknown`) by its group. Lines
 * without a message id (GameFeed's) mark nothing. `undefined` when nothing would be marked.
 */
export function chatViewMarks(lines: readonly ChatLine[], meInGame: number, channels: readonly ChatChannel[]): ChatViewMarks | undefined {
  const want = new Set(channels);
  const out: ChatViewMarks = { private: new Map(), groups: new Map(), channels: [] };
  for (const l of lines) {
    if (l.id === undefined || !MESSAGE_ID.test(l.id) || !want.has(l.channel)) continue;
    if (l.channel === 'public') out.public = higher(out.public, l.id);
    else if (l.channel === 'team') out.team = higher(out.team, l.id);
    else if (l.channel === 'private') {
      const other = l.sender === meInGame ? l.to : l.sender;
      if (other === undefined || other === null) continue;
      out.private.set(other, higher(out.private.get(other), l.id));
    } else if (l.group !== undefined) out.groups.set(l.group, higher(out.groups.get(l.group), l.id));
  }
  const has: Record<ChatChannel, boolean> = {
    public: out.public !== undefined,
    team: out.team !== undefined,
    private: out.private.size > 0,
    unknown: out.groups.size > 0,
  };
  out.channels = CHAT_CHANNELS.filter((c) => has[c]);
  return out.channels.length ? out : undefined;
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
      // A feed time with no zone is UTC, as every other GameFeed time (parseFeedTime); Date.parse would read it as local time.
      const ms = typeof time === 'string' ? (parseFeedTime(time) ?? Date.parse(time)) : Number.NaN;
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

// ---------- A short web read, filled from GameFeed (#313) ----------

/** Two times this close (ms) are one message's: GameFeed may give whole seconds where the web client gives ms. */
const SAME_MESSAGE_MS = 1000;

const sameMessage = (web: ChatLine, feed: ChatLine): boolean => {
  if (web.sender !== feed.sender) return false;
  if (web.timeMs !== undefined && feed.timeMs !== undefined) return Math.abs(web.timeMs - feed.timeMs) < SAME_MESSAGE_MS;
  return web.text === feed.text;
};

/**
 * The web client's `web` lines with GameFeed's `feed` lines that no web line matches (same sender, and
 * times within a second — or the same text when either has no time), each match used once. The added
 * lines keep GameFeed's `unknown` channel and go in by time (after every web line of the same or an
 * earlier time); one with no time goes last. Pure: `added` is how many GameFeed lines were added.
 */
export function fillFromFeed(web: readonly ChatLine[], feed: readonly ChatLine[]): { lines: ChatLine[]; added: number } {
  const used = new Set<number>();
  const extra: ChatLine[] = [];
  for (const f of feed) {
    const k = web.findIndex((w, i) => !used.has(i) && sameMessage(w, f));
    if (k >= 0) used.add(k);
    else extra.push({ ...f, channel: 'unknown' });
  }
  const lines = [...web];
  for (const e of extra) {
    const at = e.timeMs === undefined ? -1 : lines.findIndex((l) => l.timeMs !== undefined && l.timeMs > e.timeMs!);
    if (at < 0) lines.push(e);
    else lines.splice(at, 0, e);
  }
  return { lines, added: extra.length };
}
