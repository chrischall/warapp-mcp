import { describe, expect, it } from 'vitest';
import { COALITION_GRACE_TURNS, coalitionAdvice } from '../../src/analysis/coalition.js';

const rows = [
  { playerId: 1, armies: 40, income: 12 },
  { playerId: 2, armies: 90, income: 20 },
  { playerId: 3, armies: 70, income: 9 },
  { playerId: 4, armies: 30, income: 6 },
];

describe('coalitionAdvice (#445)', () => {
  it('is viable when the trailing players together earn at least the leader, partners bordering it first', () => {
    const r = coalitionAdvice({ rows, me: 1, leader: 2, bordersLeader: new Set([4]) })!;
    expect(r.viable).toBe(true);
    expect(r.trailingIncome).toBe(12 + 9 + 6);
    expect(r.partners.map((p) => p.playerId)).toEqual([4, 3]);
    expect(r.graceTurns).toBe(COALITION_GRACE_TURNS);
    expect(r.advice).toMatch(/Try a coalition first/);
    expect(r.draft).toMatch(/hold off attacking each other/);
    expect(r.draft).not.toMatch(/~|income|armies/);
  });

  it('says the surrender advice stands when the trailing players cannot catch the leader', () => {
    const r = coalitionAdvice({ rows: [{ playerId: 1, armies: 10, income: 4 }, { playerId: 2, armies: 90, income: 30 }, { playerId: 3, armies: 20, income: 5 }], me: 1, leader: 2, bordersLeader: new Set() })!;
    expect(r.viable).toBe(false);
    expect(r.advice).toMatch(/surrender advice stands/);
    expect(r.draft).toBeUndefined();
  });

  it('leaves out excluded players, and is null in a 1v1 or when I lead', () => {
    const r = coalitionAdvice({ rows, me: 1, leader: 2, bordersLeader: new Set(), excluded: new Set([3, 4]) })!;
    expect(r.partners).toEqual([]);
    expect(r.viable).toBe(false);
    expect(coalitionAdvice({ rows: rows.slice(0, 2), me: 1, leader: 2, bordersLeader: new Set() })).toBeNull();
    expect(coalitionAdvice({ rows, me: 2, leader: 2, bordersLeader: new Set() })).toBeNull();
  });
});
