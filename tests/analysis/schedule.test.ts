import { describe, expect, it } from 'vitest';
import { indexAfterAll, MoveSlot, opponentOrdersBefore, scheduleMoves, type SchedulableMove } from '../../src/analysis/schedule.js';

type M = SchedulableMove & { tag: string; slot: MoveSlot };
const m = (tag: string, from: number, to: number, kind: 'attack' | 'transfer', slot: MoveSlot): M => ({ tag, from, to, kind, slot });
const order = (ms: M[]) => scheduleMoves(ms, (x) => x.slot).map((x) => x.tag);

describe('scheduleMoves (#127)', () => {
  it('sorts by slot, ties in decision order', () => {
    expect(
      order([
        m('last', 1, 2, 'attack', MoveSlot.Last),
        m('filler', 3, 4, 'attack', MoveSlot.Filler),
        m('early', 5, 6, 'transfer', MoveSlot.Early),
        m('sure', 7, 8, 'attack', MoveSlot.Sure),
        m('filler2', 9, 10, 'transfer', MoveSlot.Filler),
        m('first', 11, 12, 'transfer', MoveSlot.Protected),
      ]),
    ).toEqual(['first', 'early', 'sure', 'filler', 'filler2', 'last']);
  });

  it('keeps softeners before their finisher', () => {
    expect(
      order([
        m('soft', 1, 9, 'attack', MoveSlot.Last),
        m('fin', 2, 9, 'attack', MoveSlot.Sure),
        m('other', 3, 4, 'attack', MoveSlot.Filler),
      ]),
    ).toEqual(['other', 'soft', 'fin']);
  });

  it('keeps a transfer into a territory captured this turn after the capture', () => {
    expect(
      order([
        m('capture', 1, 5, 'attack', MoveSlot.Last),
        m('in', 2, 5, 'transfer', MoveSlot.Early),
      ]),
    ).toEqual(['capture', 'in']);
  });

  it('keeps a move out of a territory after the move that went in', () => {
    expect(
      order([
        m('stage', 1, 2, 'transfer', MoveSlot.Filler),
        m('out', 2, 3, 'attack', MoveSlot.Sure),
      ]),
    ).toEqual(['stage', 'out']);
  });

  it('does not reorder unrelated moves sharing nothing', () => {
    expect(order([])).toEqual([]);
    expect(order([m('a', 1, 2, 'attack', MoveSlot.Filler)])).toEqual(['a']);
  });
});

describe('scheduleMoves tie-break (#127)', () => {
  it('within a slot, sends the larger move first when asked (one grouped early transfer beats small ones)', () => {
    const ms = [
      m('small', 1, 2, 'transfer', MoveSlot.Early),
      m('big', 3, 4, 'transfer', MoveSlot.Early),
      m('filler', 5, 6, 'transfer', MoveSlot.Filler),
    ];
    const size: Record<string, number> = { small: 2, big: 6, filler: 9 };
    const out = scheduleMoves(ms, (x) => x.slot, (x) => (x.slot === MoveSlot.Early ? size[x.tag]! : 0)).map((x) => x.tag);
    expect(out).toEqual(['big', 'small', 'filler']);
  });

  it('never lets the tie-break pass a dependency', () => {
    const ms = [m('capture', 1, 5, 'attack', MoveSlot.Early), m('on', 5, 6, 'attack', MoveSlot.Early)];
    const out = scheduleMoves(ms, (x) => x.slot, (x) => (x.tag === 'on' ? 9 : 1)).map((x) => x.tag);
    expect(out).toEqual(['capture', 'on']);
  });
});

describe('zigzag position arithmetic, two players (#127)', () => {
  it("counts the opponent's orders that run before my k-th", () => {
    // F S S F F S S F F …
    expect([1, 2, 3, 4, 5].map((k) => opponentOrdersBefore(k, 'first'))).toEqual([0, 2, 2, 4, 4]);
    expect([1, 2, 3, 4, 5].map((k) => opponentOrdersBefore(k, 'second'))).toEqual([1, 1, 3, 3, 5]);
  });

  it("gives the first index that runs after all m of the opponent's orders", () => {
    expect([0, 1, 2, 3, 4].map((n) => indexAfterAll(n, 'first'))).toEqual([1, 2, 2, 4, 4]);
    expect([0, 1, 2, 3, 4].map((n) => indexAfterAll(n, 'second'))).toEqual([1, 1, 3, 3, 5]);
    expect([0, 1, 2, 3, 4].map((n) => indexAfterAll(n, 'unknown'))).toEqual([1, 2, 3, 4, 5]);
  });

  it('agrees with the interleave it is derived from', () => {
    for (const mover of ['first', 'second'] as const) {
      for (let n = 0; n <= 6; n++) {
        const k = indexAfterAll(n, mover);
        expect(Math.min(n, opponentOrdersBefore(k, mover))).toBe(n);
        if (k > 1) expect(opponentOrdersBefore(k - 1, mover)).toBeLessThan(n);
      }
    }
  });
});
