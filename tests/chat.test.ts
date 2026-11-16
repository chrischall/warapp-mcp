import { describe, expect, it } from 'vitest';
import { chatViewMarks, feedChatLines, fillFromFeed, readGameRefreshChat, readSendChatReply, type ChatLine } from '../src/chat.js';
import { Reader, Writer } from '../src/protocol/codec.js';
import { WarappBundle } from '../src/protocol/bundle.js';
import { CHAT_BUNDLE, writeGameDetailsAndChat, writeSendChatReply, type SyntheticMessage } from './protocol/chat-bundle.js';

const bundle = new WarappBundle(CHAT_BUNDLE, 'test');
const bytes = (write: (w: Writer) => void) => {
  const w = new Writer();
  write(w);
  return new Reader(w.bytes());
};

const ANN = 123456;
const BOB = 765432;
const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 10, min));

describe('readGameRefreshChat', () => {
  it('reads each message: sender, text, time, turn, and its channel', () => {
    const messages: SyntheticMessage[] = [
      { id: 3, date: at(3), from: BOB, text: 'team plan', channel: 4, turn: 2 },
      { id: 1, date: at(1), from: ANN, text: 'gl hf', turn: 1 },
      { id: 2, date: at(2), from: BOB, text: 'psst', privateTo: ANN, turn: 1 },
      { id: 4, date: at(4), text: 'Bob was booted' },
      { id: 5, date: at(5), from: ANN, group: 9, text: 'group line' },
    ];
    const lines = readGameRefreshChat(bundle, bytes((w) => writeGameDetailsAndChat(w, messages)));
    // Oldest first, whatever order war.app sent them in.
    expect(lines).toEqual([
      { id: '1', sender: ANN, text: 'gl hf', time: at(1).toISOString(), timeMs: at(1).getTime(), turn: 1, channel: 'public' },
      { id: '2', sender: BOB, text: 'psst', time: at(2).toISOString(), timeMs: at(2).getTime(), turn: 1, channel: 'private', to: ANN },
      { id: '3', sender: BOB, text: 'team plan', time: at(3).toISOString(), timeMs: at(3).getTime(), turn: 2, channel: 'team', team: 4 },
      { id: '4', sender: null, text: 'Bob was booted', time: at(4).toISOString(), timeMs: at(4).getTime(), turn: null, channel: 'public' },
      { id: '5', sender: ANN, text: 'group line', time: at(5).toISOString(), timeMs: at(5).getTime(), turn: null, channel: 'unknown', group: 9 },
    ]);
  });

  it('a message without a date keeps its place by id and has no time', () => {
    const lines = readGameRefreshChat(
      bundle,
      bytes((w) => writeGameDetailsAndChat(w, [{ id: 2, date: null, from: ANN, text: 'b' }, { id: 1, date: null, from: ANN, text: 'a' }])),
    );
    expect(lines?.map((l) => [l.text, l.time])).toEqual([
      ['a', undefined],
      ['b', undefined],
    ]);
  });

  it('no result, or no chat list, is undefined; an empty list is empty', () => {
    expect(readGameRefreshChat(bundle, bytes((w) => w.bool(false)))).toBeUndefined();
    expect(readGameRefreshChat(bundle, bytes((w) => writeGameDetailsAndChat(w, null)))).toBeUndefined();
    expect(readGameRefreshChat(bundle, bytes((w) => writeGameDetailsAndChat(w, [])))).toEqual([]);
  });

  it('never throws: a truncated reply or a bundle without the class is undefined', () => {
    expect(readGameRefreshChat(bundle, bytes((w) => w.bool(true).bool(true).int32(3)))).toBeUndefined();
    const other = new WarappBundle('var P={};P.Ya=function(a){return a.Og()};P.Yc=function(a){return a.Ua()};P.uq=function(a){return a.bc()};', 'x');
    expect(readGameRefreshChat(other, bytes((w) => writeGameDetailsAndChat(w, [])))).toBeUndefined();
  });

  it('a message whose text is not a string makes the whole list unreadable', () => {
    const odd = new WarappBundle(CHAT_BUNDLE.replace('b.m5=P.wc(a)', 'b.m5=P.Ya(a)'), 'odd');
    const r = bytes((w) => {
      w.bool(true).bool(true).list([1], (ww) => {
        ww.bool(true).date(at(1)).bool(false).bool(false).bool(false).string('1').int32(5).int32(-1);
        ww.bool(false).bool(false).bool(false);
      });
      w.bool(false).int32(0);
    });
    expect(readGameRefreshChat(odd, r)).toBeUndefined();
  });
});

describe('chatViewMarks (RegisterChatView, #311)', () => {
  const line = (id: string | undefined, channel: ChatLine['channel'], over: Partial<ChatLine> = {}): ChatLine => ({
    ...(id === undefined ? {} : { id }),
    sender: BOB,
    text: 'x',
    turn: null,
    channel,
    ...over,
  });
  const ALL = ['public', 'team', 'private', 'unknown'] as const;

  it('takes the highest id per channel, mine included, compared as numbers', () => {
    const marks = chatViewMarks(
      [
        line('9', 'public'),
        line('10', 'public', { sender: ANN }),
        line('3', 'team', { team: 2 }),
        line('12', 'private', { to: ANN }),
        line('15', 'private', { sender: ANN, to: BOB }),
        line('4', 'private', { sender: 555, to: ANN }),
        line('20', 'unknown', { group: 7 }),
        line('21', 'unknown', { group: 8 }),
        line('19', 'unknown', { group: 7 }),
      ],
      ANN,
      ALL,
    );
    expect(marks).toEqual({
      public: '10',
      team: '3',
      private: new Map([
        [BOB, '15'],
        [555, '4'],
      ]),
      groups: new Map([
        [7, '20'],
        [8, '21'],
      ]),
      channels: ['public', 'team', 'private', 'unknown'],
    });
  });

  it('marks only the channels asked for, and nothing a line without a message id carries', () => {
    const lines = [line('5', 'public'), line('6', 'team'), line(undefined, 'private', { to: ANN }), line('7', 'unknown')];
    expect(chatViewMarks(lines, ANN, ['public'])).toEqual({ public: '5', private: new Map(), groups: new Map(), channels: ['public'] });
    // GameFeed's lines (no id) and an `unknown` line with no group give nothing to mark.
    expect(chatViewMarks(lines, ANN, ['private', 'unknown'])).toBeUndefined();
    expect(chatViewMarks([], ANN, ALL)).toBeUndefined();
    expect(chatViewMarks([line('x1', 'public')], ANN, ALL)).toBeUndefined();
    // A system line in a private channel with no counterpart is skipped.
    expect(chatViewMarks([line('3', 'private', { sender: ANN })], ANN, ALL)).toBeUndefined();
  });
});

describe('readSendChatReply', () => {
  it('reads the updated list that follows the result flag', () => {
    const lines = readSendChatReply(bundle, bytes((w) => writeSendChatReply(w, [{ id: 8, from: ANN, text: 'hello' }])));
    expect(lines).toMatchObject([{ id: '8', sender: ANN, text: 'hello', channel: 'public' }]);
    expect(readSendChatReply(bundle, bytes((w) => writeSendChatReply(w, null)))).toBeUndefined();
    expect(readSendChatReply(bundle, bytes(() => {}))).toBeUndefined();
  });
});

describe('feedChatLines (GameFeed)', () => {
  it('reads a zone-less feed date as UTC, as every other feed time is, never as local time', () => {
    const [us, iso] = feedChatLines([
      { playerID: ANN, message: 'a', date: '11/14/2026 16:52:00' },
      { playerID: ANN, message: 'b', date: '2026-11-14 16:52:00' },
    ])!;
    expect(us!.timeMs).toBe(Date.UTC(2026, 10, 14, 16, 52));
    expect(iso!.timeMs).toBe(Date.UTC(2026, 10, 14, 16, 52));
  });

  it('a message with no channel field is unknown; turn and time are kept', () => {
    expect(
      feedChatLines([
        { playerID: ANN, message: 'gl', date: '2026-11-01T10:00:00Z', turn: '3' },
        { playerID: String(BOB), message: 'hi' },
        { sender: 'Ann', text: 'by name' },
      ]),
    ).toEqual([
      { sender: ANN, text: 'gl', time: '2026-11-01T10:00:00Z', timeMs: Date.UTC(2026, 10, 1, 10), turn: 3, channel: 'unknown' },
      { sender: BOB, text: 'hi', turn: null, channel: 'unknown' },
      { sender: null, senderName: 'Ann', text: 'by name', turn: null, channel: 'unknown' },
    ]);
  });

  it('reads a channel or a recipient when GameFeed sends one (UNVERIFIED shapes, read loosely)', () => {
    expect(
      feedChatLines([
        { playerID: ANN, message: 'all', channel: '-1' },
        { playerID: ANN, message: 'us', teamID: 2 },
        { playerID: ANN, message: 'you', recipientID: BOB },
      ])?.map((l) => [l.channel, l.team, l.to]),
    ).toEqual([
      ['public', undefined, undefined],
      ['team', 2, undefined],
      ['private', undefined, BOB],
    ]);
  });

  it('accepts a wrapped list; an unrecognisable shape is undefined', () => {
    expect(feedChatLines({ messages: [{ sender: 'Ann', text: 'hi', date: 5 }] })).toEqual([
      { sender: null, senderName: 'Ann', text: 'hi', time: '5', turn: null, channel: 'unknown' },
    ]);
    expect(feedChatLines([{ odd: 1 }])).toBeUndefined();
    expect(feedChatLines([7])).toBeUndefined();
    expect(feedChatLines('x')).toBeUndefined();
  });
});

describe('fillFromFeed (#313)', () => {
  const web = (sender: number, ms: number, text: string, channel: ChatLine['channel'] = 'public'): ChatLine => ({
    sender,
    text,
    turn: null,
    channel,
    timeMs: ms,
  });
  const feed = (sender: number | null, text: string, ms?: number): ChatLine => ({
    sender,
    text,
    turn: null,
    channel: 'unknown',
    ...(ms !== undefined ? { timeMs: ms } : {}),
  });

  it('adds the GameFeed lines no web line matches by sender and time (within a second), by time, under unknown', () => {
    const w = [web(ANN, 1_000_500, 'a'), web(BOB, 3_000_000, 'c', 'team')];
    const f = [feed(ANN, 'a', 1_000_000), feed(BOB, 'b', 2_000_000), feed(BOB, 'c', 3_000_000), feed(BOB, 'z', 9_000_000)];
    const { lines, added } = fillFromFeed(w, f);
    expect(added).toBe(2);
    expect(lines.map((l) => [l.text, l.channel])).toEqual([
      ['a', 'public'],
      ['b', 'unknown'],
      ['c', 'team'],
      ['z', 'unknown'],
    ]);
  });

  it('matches each web line once; a line without a time matches on sender and text, else goes last', () => {
    const w = [web(BOB, 1_000_000, 'gg')];
    const { lines, added } = fillFromFeed(w, [feed(BOB, 'gg'), feed(BOB, 'gg'), feed(null, 'system')]);
    expect(added).toBe(2);
    expect(lines.map((l) => [l.sender, l.text])).toEqual([
      [BOB, 'gg'],
      [BOB, 'gg'],
      [null, 'system'],
    ]);
  });

  it('a different sender at the same time is another message', () => {
    expect(fillFromFeed([web(ANN, 5_000, 'x')], [feed(BOB, 'x', 5_000)]).added).toBe(1);
  });
});
