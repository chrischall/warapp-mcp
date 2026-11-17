import { describe, expect, it } from 'vitest';
import { incomeTrend, TREND_POINTS } from '../../src/analysis/income-trend.js';

const pts = (from: number, incomes: number[]) => incomes.map((income, i) => ({ turn: from + i, income }));

describe('#303: incomeTrend', () => {
  it('keeps the last five turns, the current one last, and fits a least-squares slope', () => {
    const t = incomeTrend(pts(3, [10, 12, 14, 16, 18]), { turn: 8, income: 20 })!;
    expect(TREND_POINTS).toBe(5);
    expect(t.turns).toEqual(pts(4, [12, 14, 16, 18, 20]));
    expect(t.slope).toBe(2);
    expect(t.flat).toBe(false);
  });

  it('is flat when the last four consecutive turns stay within 10% of the first of them (#312 rule)', () => {
    const t = incomeTrend(pts(10, [30, 31, 32, 31]), { turn: 14, income: 32 })!;
    expect(t.flat).toBe(true);
    expect(t.slope).toBe(0.4);
  });

  it('is not flat across a gap in the turns, nor with fewer than four points', () => {
    expect(incomeTrend([{ turn: 10, income: 30 }, { turn: 12, income: 30 }, { turn: 13, income: 30 }], { turn: 14, income: 30 })!.flat).toBe(false);
    expect(incomeTrend(pts(12, [30, 30]), { turn: 14, income: 30 })!.flat).toBe(false);
  });

  it('a later board for the same turn wins, and turns at or after the current one are ignored', () => {
    const t = incomeTrend([...pts(10, [5, 6, 7]), { turn: 12, income: 9 }, { turn: 13, income: 99 }], { turn: 13, income: 9 })!;
    expect(t.turns).toEqual([...pts(10, [5, 6]), { turn: 12, income: 9 }, { turn: 13, income: 9 }]);
  });

  it('is absent with no earlier turn to compare', () => {
    expect(incomeTrend([], { turn: 5, income: 10 })).toBeUndefined();
  });
});
