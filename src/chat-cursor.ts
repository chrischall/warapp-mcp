// The chat cursor: per game, per channel, how many messages were marked seen and the time of the
// newest one, so "new since" survives a restart. Local only, at `<dataDir>/chat/<gameId>.json`, and
// name-free: counts and times, never a message's text, sender or name (docs/PLAN-TEAMS.md, part A).
// Keyed to the account (its GameFeed id) that marked it. Best effort: the store never throws.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHAT_CHANNELS, type ChatChannel } from './chat.js';

export interface ChannelCursor {
  /** Messages on the channel when it was marked seen. */
  seen: number;
  /** The newest seen message's time (epoch ms), when every message on the channel had one. */
  lastTimeMs?: number;
  /** How many seen messages carried exactly `lastTimeMs` (two messages in one millisecond). */
  atLast?: number;
}

export interface ChatCursor {
  gameId: number;
  /** The account that marked it (GameFeed id); `null` when it could not be read. */
  playerId: number | null;
  channels: Partial<Record<ChatChannel, ChannelCursor>>;
  /**
   * Every channel at once, set when the whole chat was marked seen. A source that names no channel
   * (GameFeed: every message `unknown`) is judged against it, so marking the web client's chat seen
   * also marks GameFeed's copy of it.
   */
  all?: ChannelCursor;
}

/** What the cursor needs of a message. */
export interface CursorLine {
  channel: ChatChannel;
  timeMs?: number;
  /** Sent by me: never new. */
  mine: boolean;
}

export const chatCursorPath = (dir: string, gameId: number) => join(dir, 'chat', `${gameId}.json`);

const byChannel = <T extends CursorLine>(lines: readonly T[], channel: ChatChannel) =>
  lines.map((l, i) => [l, i] as const).filter(([l]) => l.channel === channel);

/**
 * Which messages are new (parallel to `lines`, oldest first). With no cursor for a channel, all of it
 * is. With the times of every message on the channel and a time in the cursor: what came after the
 * newest message seen (one sharing its millisecond counts past the `atLast` seen there), so a list
 * that dropped its oldest messages still finds the new ones. Otherwise by count: the messages past
 * the number seen (a list that shrank then has nothing new). My own messages are never new.
 */
export function markNew(lines: readonly CursorLine[], cursor: ChatCursor | undefined): boolean[] {
  const out = lines.map((l) => !l.mine);
  if (!cursor) return out;
  for (const channel of CHAT_CHANNELS) {
    const c = channel === 'unknown' ? (cursor.all ?? cursor.channels.unknown) : cursor.channels[channel];
    if (!c) continue;
    const mine = byChannel(lines, channel);
    const timed = c.lastTimeMs !== undefined && mine.every(([l]) => l.timeMs !== undefined);
    let atLast = 0;
    mine.forEach(([l, i], k) => {
      let fresh: boolean;
      if (timed) {
        const t = l.timeMs!;
        if (t === c.lastTimeMs) fresh = ++atLast > (c.atLast ?? 1);
        else fresh = t > c.lastTimeMs!;
      } else {
        fresh = k >= c.seen;
      }
      out[i] = fresh && !l.mine;
    });
  }
  return out;
}

/** The cursor with `channels` marked seen as `lines` stand (every message on them, mine included). */
export function advanceCursor(cursor: ChatCursor, lines: readonly CursorLine[], channels: readonly ChatChannel[]): ChatCursor {
  const next: ChatCursor = { ...cursor, channels: { ...cursor.channels } };
  for (const channel of channels) next.channels[channel] = seenOf(byChannel(lines, channel).map(([l]) => l));
  if (CHAT_CHANNELS.every((c) => channels.includes(c))) next.all = seenOf(lines);
  return next;
}

function seenOf(on: readonly CursorLine[]): ChannelCursor {
  const c: ChannelCursor = { seen: on.length };
  if (on.length && on.every((l) => l.timeMs !== undefined)) {
    const last = Math.max(...on.map((l) => l.timeMs!));
    c.lastTimeMs = last;
    c.atLast = on.filter((l) => l.timeMs === last).length;
  }
  return c;
}

export type UnreadCounts = { public: number; team: number; private: number; unknown?: number };

/** New messages per channel; `unknown` only when there is one. */
export function unreadCounts(lines: readonly CursorLine[], fresh: readonly boolean[]): UnreadCounts {
  const n = (channel: ChatChannel) => lines.filter((l, i) => l.channel === channel && fresh[i]).length;
  const unknown = n('unknown');
  return { public: n('public'), team: n('team'), private: n('private'), ...(unknown ? { unknown } : {}) };
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function channelOf(v: unknown): ChannelCursor | undefined {
  if (!isRec(v) || !count(v.seen)) return undefined;
  const c: ChannelCursor = { seen: v.seen };
  if (typeof v.lastTimeMs === 'number' && Number.isFinite(v.lastTimeMs)) {
    c.lastTimeMs = v.lastTimeMs;
    if (count(v.atLast)) c.atLast = v.atLast;
  }
  return c;
}

/** The cursor of `gameId` as `playerId` marked it; `undefined` when absent, another account's, or unusable. */
export async function readChatCursor(dir: string, gameId: number, playerId: number | null): Promise<ChatCursor | undefined> {
  try {
    const c: unknown = JSON.parse(await readFile(chatCursorPath(dir, gameId), 'utf8'));
    if (!isRec(c) || c.gameId !== gameId || c.playerId !== playerId || !isRec(c.channels)) return undefined;
    const channels: ChatCursor['channels'] = {};
    for (const ch of CHAT_CHANNELS) {
      const v = channelOf(c.channels[ch]);
      if (v) channels[ch] = v;
    }
    const all = channelOf(c.all);
    return { gameId, playerId, channels, ...(all ? { all } : {}) };
  } catch {
    return undefined;
  }
}

/** Write the cursor (mode 0600, atomically); `true` when written. Best effort. */
export async function writeChatCursor(dir: string, cursor: ChatCursor): Promise<boolean> {
  try {
    const path = chatCursorPath(dir, cursor.gameId);
    await mkdir(join(dir, 'chat'), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(cursor), { mode: 0o600 });
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}
