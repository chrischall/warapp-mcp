// What the award of picks reveals (#166). Every id here is made up.
import { describe, expect, it } from 'vitest';
import { firstMoverOnTurn, readAward } from '../../src/analysis/award.js';
import { pickOutcomes } from '../../src/analysis/picks.js';

/** A list of `n` picks: list number k (1-based) is territory 100 + k. */
const list = (n: number) => Array.from({ length: n }, (_, i) => 101 + i);
/** The territories at these list numbers (1-based). */
const at = (...numbers: number[]) => numbers.map((k) => 100 + k);
/** Read the award of a two-player game with `starts` each, from the list numbers granted. */
const duel = (starts: number, ...granted: number[]) => readAward({ list: list(2 * starts), mine: at(...granted), players: 2 });

describe('readAward — two players, three starts each', () => {
  // Granted list numbers, then the opponent's starts they prove.
  const table: [number[], number[]][] = [
    [[1, 2, 3], []],
    [[1, 2, 4], [3]],
    [[1, 2, 5], [3, 4]],
    [[1, 2, 6], [3, 4, 5]],
    [[1, 3, 4], [2]],
    [[1, 3, 5], [2, 4]],
    [[1, 3, 6], [2, 4, 5]],
    [[1, 4, 5], [2, 3]],
    [[2, 3, 4], [1]],
    [[2, 3, 5], [1, 4]],
    [[2, 3, 6], [1, 4, 5]],
  ];

  it('names the opponent starts each granted set proves', () => {
    for (const [granted, theirs] of table) {
      const r = duel(3, ...granted)!;
      expect(r.granted, granted.join('')).toEqual(at(...granted));
      expect(r.opponentStarts, granted.join('')).toEqual(at(...theirs));
      expect(r.allStartsKnown, granted.join('')).toBe(theirs.length === 3);
    }
  });

  it('covers exactly the sets the award can grant', () => {
    const sets = pickOutcomes({ listLength: 6, perPlayer: 3, players: 2 })!.map((s) => s.map((i) => i + 1).join(''));
    expect(sets.sort()).toEqual(table.map(([g]) => g.join('')).sort());
  });

  it('tells who was awarded first when only one role can give the set', () => {
    const role = (...granted: number[]) => duel(3, ...granted)!.role;
    for (const g of [[1, 2, 6], [1, 3, 6], [2, 3, 4], [2, 3, 5], [2, 3, 6]]) expect(role(...g), g.join('')).toBe('second');
    expect(role(1, 4, 5)).toBe('first');
    for (const g of [[1, 2, 3], [1, 2, 4], [1, 2, 5], [1, 3, 4], [1, 3, 5]]) expect(role(...g), g.join('')).toBeNull();
  });

  it("names the opponent's first award only when every award that fits gives the same one", () => {
    // Without my first pick, the opponent was awarded it before I was awarded anything.
    for (const g of [[2, 3, 4], [2, 3, 5], [2, 3, 6]]) expect(duel(3, ...g)!.opponentFirstAward, g.join('')).toBe(101);
    // Awarded second and missing my second pick: it went first.
    expect(duel(3, 1, 3, 6)!.opponentFirstAward).toBe(102);
    // 1, 3, 4 fits either role; as the first awarded the opponent's first may be elsewhere.
    expect(duel(3, 1, 3, 4)!.opponentFirstAward).toBeNull();
    // 1, 4, 5: the opponent took my second and third, in an order the award does not show.
    expect(duel(3, 1, 4, 5)!.opponentFirstAward).toBeNull();
    expect(duel(3, 1, 2, 3)!.opponentFirstAward).toBeNull();
  });
});

describe('readAward — other sizes', () => {
  it('two starts each', () => {
    expect(duel(2, 1, 2)!.opponentStarts).toEqual([]);
    expect(duel(2, 1, 3)!.opponentStarts).toEqual(at(2));
    expect(duel(2, 1, 4)).toMatchObject({ opponentStarts: at(2, 3), allStartsKnown: true, role: 'first' });
    expect(duel(2, 2, 3)).toMatchObject({ opponentStarts: at(1), allStartsKnown: false, role: 'second', opponentFirstAward: 101 });
  });

  it('agrees with the 2k rule for one to five starts: my k-th granted pick being list number 2k fixes the role', () => {
    for (let starts = 1; starts <= 5; starts++) {
      for (const set of pickOutcomes({ listLength: 2 * starts, perPlayer: starts, players: 2 })!) {
        const numbers = set.map((i) => i + 1);
        if (numbers.length < starts) continue;
        const k = numbers.findIndex((n, i) => n === 2 * (i + 1)) + 1;
        const expected = k === 0 ? null : k % 2 === 1 ? 'second' : 'first';
        expect(duel(starts, ...numbers)!.role, `${starts} starts, ${numbers.join(',')}`).toBe(expected);
      }
    }
  });

  it('reads a list that ran out: every listed territory I lack is the opponent\'s', () => {
    // A list of three for three starts; I hold its first and third and one territory I never listed.
    const r = readAward({ list: at(1, 2, 3), mine: [101, 103, 900], players: 2 })!;
    expect(r.granted).toEqual([101, 103]);
    expect(r.unlisted).toEqual([900]);
    expect(r.opponentStarts).toEqual([102]);
  });

  it('gives no reading when the list cannot explain the start', () => {
    // 1, 5, 6 of six: never granted (I am never refused both my second and my third and my fourth).
    expect(duel(3, 1, 5, 6)).toBeNull();
    // Nothing of mine is on the list, yet the list did not run out.
    expect(readAward({ list: list(6), mine: [900, 901, 902], players: 2 })).toBeNull();
    // A territory off the list while listed ones went to nobody I could have lost them to.
    expect(readAward({ list: list(6), mine: [101, 102, 900], players: 2 })).toBeNull();
    expect(readAward({ list: [], mine: [900], players: 2 })).toBeNull();
    expect(readAward({ list: list(6), mine: [], players: 2 })).toBeNull();
  });

  it('with three or more players names the starts of others without saying whose, and no role', () => {
    const r = readAward({ list: list(9), mine: at(1, 3, 6), players: 3 })!;
    expect(r.opponentStarts).toEqual(at(2, 4, 5));
    expect(r).toMatchObject({ allStartsKnown: false, role: null, opponentFirstAward: null });
    expect(readAward({ list: list(9), mine: [101, 900, 901], players: 3 })).toBeNull();
  });

  it('ignores a territory listed twice and keeps list order', () => {
    const r = readAward({ list: [101, 102, 102, 103, 104], mine: [103, 101], players: 2 })!;
    expect(r.granted).toEqual([101, 103]);
    expect(r.opponentStarts).toEqual([102]);
  });
});

describe('firstMoverOnTurn', () => {
  it('under a cyclic order the first awarded moves second on turn 1, and the order alternates', () => {
    for (const order of ['Cycle', 'NoLuckCycle']) {
      expect(firstMoverOnTurn({ role: 'first', turn: 1, moveOrder: order })).toBe('opponent');
      expect(firstMoverOnTurn({ role: 'first', turn: 2, moveOrder: order })).toBe('me');
      expect(firstMoverOnTurn({ role: 'second', turn: 1, moveOrder: order })).toBe('me');
      expect(firstMoverOnTurn({ role: 'second', turn: 4, moveOrder: order })).toBe('opponent');
    }
  });

  it('says nothing under a random order, an order it does not know, or an unknown role or turn', () => {
    expect(firstMoverOnTurn({ role: 'first', turn: 1, moveOrder: 'Random' })).toBeNull();
    expect(firstMoverOnTurn({ role: 'first', turn: 1, moveOrder: undefined })).toBeNull();
    expect(firstMoverOnTurn({ role: 'first', turn: 1, moveOrder: 'Something' })).toBeNull();
    expect(firstMoverOnTurn({ role: null, turn: 1, moveOrder: 'Cycle' })).toBeNull();
    expect(firstMoverOnTurn({ role: 'first', turn: 0, moveOrder: 'Cycle' })).toBeNull();
    expect(firstMoverOnTurn({ role: 'first', turn: null, moveOrder: 'Cycle' })).toBeNull();
  });
});
