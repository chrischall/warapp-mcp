import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  advanceCursor,
  chatCursorPath,
  markNew,
  readChatCursor,
  unreadCounts,
  writeChatCursor,
  type ChatCursor,
  type CursorLine,
} from '../src/chat-cursor.js';

const ME = 3312345644;
const line = (channel: CursorLine['channel'], timeMs?: number, mine = false): CursorLine => ({
  channel,
  mine,
  ...(timeMs !== undefined ? { timeMs } : {}),
});
const empty = (): ChatCursor => ({ gameId: 7, playerId: ME, channels: {} });

describe('markNew', () => {
  it('with no cursor every message is new, except my own', () => {
    expect(markNew([line('public', 1), line('public', 2, true), line('team', 3)], undefined)).toEqual([true, false, true]);
  });

  it('by time: only what came after the last message seen on that channel', () => {
    const lines = [line('public', 1), line('public', 2), line('public', 3), line('team', 2)];
    const c = advanceCursor(empty(), lines.slice(0, 2), ['public']);
    expect(markNew(lines, c)).toEqual([false, false, true, true]);
  });

  it('two messages at the same time: the one not seen yet is still new', () => {
    const seen = [line('public', 5)];
    const c = advanceCursor(empty(), seen, ['public']);
    expect(markNew([line('public', 5), line('public', 5)], c)).toEqual([false, true]);
  });

  it('a list that shrank (older messages dropped) still finds the new ones by time', () => {
    const c = advanceCursor(empty(), [line('public', 1), line('public', 2), line('public', 3)], ['public']);
    expect(markNew([line('public', 3), line('public', 4)], c)).toEqual([false, true]);
  });

  it('without times: by count; a list that shrank has nothing new', () => {
    const c = advanceCursor(empty(), [line('unknown'), line('unknown')], ['unknown']);
    expect(markNew([line('unknown'), line('unknown'), line('unknown')], c)).toEqual([false, false, true]);
    expect(markNew([line('unknown')], c)).toEqual([false]);
  });

  it('a channel the cursor never marked is all new', () => {
    const c = advanceCursor(empty(), [line('public', 1)], ['public']);
    expect(markNew([line('private', 1)], c)).toEqual([true]);
  });
});

describe('a source with no channels (GameFeed) against a cursor marked from one with them', () => {
  it('unknown messages are judged against the whole chat once all of it was marked seen', () => {
    const web = [line('public', 1), line('team', 2), line('private', 3)];
    const c = advanceCursor(empty(), web, ['public', 'team', 'private', 'unknown']);
    expect(c.all).toEqual({ seen: 3, lastTimeMs: 3, atLast: 1 });
    expect(markNew([line('unknown', 1), line('unknown', 3), line('unknown', 4)], c)).toEqual([false, false, true]);
  });

  it('marking one channel does not mark the whole chat', () => {
    expect(advanceCursor(empty(), [line('public', 1)], ['public']).all).toBeUndefined();
  });
});

describe('advanceCursor', () => {
  it('marks only the channels named, keeping the others', () => {
    let c = advanceCursor(empty(), [line('public', 1), line('team', 9)], ['public', 'team']);
    c = advanceCursor(c, [line('public', 1), line('public', 4), line('team', 9), line('team', 12)], ['public']);
    expect(c.channels).toEqual({ public: { seen: 2, lastTimeMs: 4, atLast: 1 }, team: { seen: 1, lastTimeMs: 9, atLast: 1 } });
  });

  it('a channel with no messages is recorded as seen-nothing', () => {
    expect(advanceCursor(empty(), [], ['private']).channels).toEqual({ private: { seen: 0 } });
  });
});

describe('unreadCounts', () => {
  it('counts new messages per channel; unknown only when there is one', () => {
    const lines = [line('public', 1), line('team', 2), line('team', 3), line('private', 4), line('public', 5, true)];
    expect(unreadCounts(lines, markNew(lines, undefined))).toEqual({ public: 1, team: 2, private: 1 });
    const u = [line('unknown', 1)];
    expect(unreadCounts(u, [true])).toEqual({ public: 0, team: 0, private: 0, unknown: 1 });
  });
});

describe('the store', () => {
  it('round-trips, mode 0600 in a 0700 directory, name-free (counts and times only)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-chat-'));
    const c = advanceCursor({ gameId: 42, playerId: ME, channels: {} }, [line('public', 10)], ['public']);
    expect(await writeChatCursor(dir, c)).toBe(true);
    expect(await readChatCursor(dir, 42, ME)).toEqual(c);
    const path = chatCursorPath(dir, 42);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'chat')).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ gameId: 42, playerId: ME, channels: { public: { seen: 1, lastTimeMs: 10, atLast: 1 } } });
    const whole = advanceCursor(c, [line('public', 10)], ['public', 'team', 'private', 'unknown']);
    await writeChatCursor(dir, whole);
    expect(await readChatCursor(dir, 42, ME)).toEqual(whole);
  });

  it("survives a restart: another account's cursor, a missing or broken file read as none", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-chat-'));
    expect(await readChatCursor(dir, 42, ME)).toBeUndefined();
    await writeChatCursor(dir, { gameId: 42, playerId: ME, channels: {} });
    expect(await readChatCursor(dir, 42, 999)).toBeUndefined();
    expect(await readChatCursor(dir, 42, ME)).toEqual({ gameId: 42, playerId: ME, channels: {} });
    writeFileSync(chatCursorPath(dir, 42), '{nope');
    expect(await readChatCursor(dir, 42, ME)).toBeUndefined();
    writeFileSync(chatCursorPath(dir, 42), JSON.stringify({ gameId: 42, playerId: ME, channels: { public: { seen: 'x' } } }));
    expect(await readChatCursor(dir, 42, ME)).toEqual({ gameId: 42, playerId: ME, channels: {} });
  });

  it('a write that cannot land is false, never a throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-chat-'));
    writeFileSync(join(dir, 'chat'), 'a file where the directory should be');
    expect(await writeChatCursor(dir, { gameId: 1, playerId: ME, channels: {} })).toBe(false);
  });
});
