import { describe, expect, it } from 'vitest';
import { MoveSlot, scheduleMoves, type SchedulableMove } from '../../src/analysis/schedule.js';

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
