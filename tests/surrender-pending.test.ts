import { describe, expect, it } from 'vitest';
import { WarappBundle } from '../src/protocol/bundle.js';
import { Reader, Writer } from '../src/protocol/codec.js';
import { pendingSurrenders, readGameDetailsSeats, surrenderOwed, type DetailsSeat } from '../src/surrender-pending.js';
import { CHAT_BUNDLE, writeGameDetailsAndChat, type SyntheticSeat } from './protocol/chat-bundle.js';

const bundle = new WarappBundle(CHAT_BUNDLE, 'test');
const bytes = (fill: (w: Writer) => void) => {
  const w = new Writer();
  fill(w);
  return new Reader(w.bytes());
};
const read = (seats: SyntheticSeat[] | null, b = bundle) => readGameDetailsSeats(b, bytes((w) => writeGameDetailsAndChat(w, null, seats)));

describe('readGameDetailsSeats', () => {
  it('reads each seat: id, AI, state, the Surrendered flag and who accepted', () => {
    expect(
      read([
        { id: 11 },
        { id: 22, surrendered: true, acceptedBy: [33] },
        { aiId: 5 },
        { id: 44, state: 7, turnedAI: true, acceptedBy: null },
      ]),
    ).toEqual([
      { id: 11, ai: false, turnedAI: false, state: 2, surrendered: false, acceptedBy: [] },
      { id: 22, ai: false, turnedAI: false, state: 2, surrendered: true, acceptedBy: [33] },
      { id: 5, ai: true, turnedAI: false, state: 2, surrendered: false, acceptedBy: [] },
      { id: 44, ai: false, turnedAI: true, state: 7, surrendered: false, acceptedBy: [] },
    ]);
  });

  it('is unknown (undefined) without a result, a game, players, or in a shape it does not know', () => {
    expect(readGameDetailsSeats(bundle, bytes((w) => w.bool(false)))).toBeUndefined();
    expect(read(null)).toBeUndefined();
    expect(read([])).toBeUndefined();
    expect(readGameDetailsSeats(bundle, bytes((w) => w.bool(true).bool(false).bool(false).int32(0)))).toBeUndefined();
    // A field more on the player: its count no longer matches, so nothing is read rather than read wrong.
    const extra = new WarappBundle(CHAT_BUNDLE.replace('b.p29=P.Yc(a);', 'b.p29=P.Yc(a);b.px=0;'), 'extra');
    expect(read([{ id: 1 }], extra)).toBeUndefined();
    // The flag read as a number: not a bool, so unknown.
    const odd = new WarappBundle(CHAT_BUNDLE.replace('b.p29=P.Yc(a);', 'b.p29=P.uq(a);'), 'odd');
    expect(read([{ id: 1 }], odd)).toBeUndefined();
    // Truncated bytes: never a throw.
    expect(readGameDetailsSeats(bundle, bytes((w) => w.bool(true).bool(false).bool(true).int32(1)))).toBeUndefined();
  });
});

describe('pendingSurrenders', () => {
  const seat = (s: Partial<DetailsSeat> & { id: number }): DetailsSeat => ({
    ai: false,
    turnedAI: false,
    state: 2,
    surrendered: false,
    acceptedBy: [],
    ...s,
  });
  const feed = (id: number) => (id === 22 ? 1220099 : null);

  it('owes my acceptance while my seat plays and has not accepted', () => {
    const seats = [seat({ id: 11 }), seat({ id: 22, surrendered: true }), seat({ id: 33 })];
    expect(pendingSurrenders(seats, 11, feed)).toEqual([{ inGameId: 22, player: 1220099, owedByMe: true }]);
    expect(surrenderOwed(pendingSurrenders(seats, 11, feed))).toBe(true);
  });

  it('owes nothing once I accepted, or when my seat cannot accept', () => {
    const accepted = [seat({ id: 11 }), seat({ id: 22, surrendered: true, acceptedBy: [11] })];
    expect(pendingSurrenders(accepted, 11)).toEqual([{ inGameId: 22, player: null, owedByMe: false }]);
    for (const mine of [seat({ id: 11, state: 7 }), seat({ id: 11, turnedAI: true }), seat({ id: 11, ai: true })]) {
      expect(pendingSurrenders([mine, seat({ id: 22, surrendered: true })], 11)[0]!.owedByMe).toBe(false);
    }
    expect(surrenderOwed(pendingSurrenders(accepted, 11))).toBe(false);
  });

  it('is unknown (null) for me when my seat is not known', () => {
    const seats = [seat({ id: 22, surrendered: true })];
    expect(pendingSurrenders(seats, undefined)).toEqual([{ inGameId: 22, player: null, owedByMe: null }]);
    expect(pendingSurrenders(seats, 99)[0]!.owedByMe).toBeNull();
    expect(surrenderOwed(pendingSurrenders(seats, undefined))).toBe(false);
  });

  it('leaves out my own surrender and a seat no longer playing', () => {
    const seats = [seat({ id: 11, surrendered: true }), seat({ id: 22, surrendered: true, state: 7 })];
    expect(pendingSurrenders(seats, 11)).toEqual([]);
    expect(surrenderOwed(null)).toBe(false);
  });
});
