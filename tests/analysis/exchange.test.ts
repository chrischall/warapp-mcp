// #167: an attack on a player classified by its exchange, and a multi-turn view of a border.
// Pure arithmetic and simulation; every number is made up.
import { describe, expect, it } from 'vitest';
import { classifyExchange, forecastBorder, FORECAST_TURNS } from '../../src/analysis/exchange.js';

describe('classifyExchange (#167)', () => {
  it('below seven sixths of the defenders an attack loses more than it kills', () => {
    // 11 on 10 at 60/70: kills 7, loses 7 — 12 on 12 kills 7 and loses 8.
    const x = classifyExchange({ attackers: 12, defenders: 12, deploy: 0, income: 0 });
    expect(x.cases[0]).toMatchObject({ defenders: 12, kills: 7, losses: 8, net: -1, captures: false });
    expect(x.label).toBe('stand');
  });

  it('from seven sixths to five thirds it kills more without capturing: a favourable exchange', () => {
    // 15 on 10: kills 9, loses 7.
    const x = classifyExchange({ attackers: 15, defenders: 10, deploy: 0, income: 0 });
    expect(x.cases[0]).toMatchObject({ kills: 9, losses: 7, net: 2, captures: false });
    expect(x.label).toBe('favourable exchange');
  });

  it('gives the exchange at three defender sizes: as they stand, the estimated deploy, the whole income', () => {
    const x = classifyExchange({ attackers: 20, defenders: 6, deploy: 4, income: 9 });
    expect(x.cases.map((c) => c.case)).toEqual(['now', 'estimated', 'whole']);
    expect(x.cases.map((c) => c.defenders)).toEqual([6, 10, 15]);
    // 20 take 6 and 10 (17 needed), not 15 (25 needed).
    expect(x.cases.map((c) => c.captures)).toEqual([true, true, false]);
    expect(x.label).toBe('favourable exchange');
  });

  it('a capture even against the whole income is a certain first strike', () => {
    const x = classifyExchange({ attackers: 30, defenders: 6, deploy: 4, income: 9 });
    expect(x.cases.every((c) => c.captures)).toBe(true);
    expect(x.label).toBe('certain first strike');
  });

  it('an unprofitable attack on a stack that can hit my source back is struck last, not first', () => {
    const x = classifyExchange({ attackers: 12, defenders: 12, deploy: 0, income: 0, threatensSource: true });
    expect(x.label).toBe('strike last');
  });

  it('kills never exceed the defenders, losses never exceed the attackers', () => {
    const x = classifyExchange({ attackers: 50, defenders: 2, deploy: 0, income: 0 });
    expect(x.cases[0]).toMatchObject({ kills: 2, losses: 1, net: 1, captures: true });
  });
});

describe('forecastBorder (#167)', () => {
  it('two equal stacks on equal incomes are a stand-off', () => {
    const f = forecastBorder({ mine: 30, theirs: 30, myIncome: 5, theirIncome: 5 });
    expect(f.outcome).toBe('stand-off');
    expect(f.turn).toBeNull();
    expect(f.turns).toBe(FORECAST_TURNS);
  });

  it('a stack well above the defender breaks the border by attacking every turn', () => {
    const f = forecastBorder({ mine: 60, theirs: 30, myIncome: 5, theirIncome: 5 });
    expect(f.outcome).toBe('breaks');
    expect(f.turn).toBe(1);
  });

  it('a much larger enemy stack grinds me down', () => {
    const f = forecastBorder({ mine: 20, theirs: 40, myIncome: 5, theirIncome: 5 });
    expect(f.outcome).toBe('ground-down');
    expect(f.turn).toBe(1);
  });

  it('a slightly larger stack grinds the defender down over several turns', () => {
    // 1.2× at 100 armies on equal incomes of 10: the attacks trade almost evenly, but each one
    // leaves the ratio higher, and the third captures. 1.1× is still a stand-off.
    const f = forecastBorder({ mine: 120, theirs: 100, myIncome: 10, theirIncome: 10 });
    expect(f).toMatchObject({ outcome: 'breaks', turn: 3 });
    expect(forecastBorder({ mine: 110, theirs: 100, myIncome: 10, theirIncome: 10 }).outcome).toBe('stand-off');
  });

  it('says how much of my income the border pins: the least per-turn deploy that stops the grind', () => {
    // Against an equal stack on equal income I must keep deploying there; with none it falls.
    const f = forecastBorder({ mine: 30, theirs: 30, myIncome: 10, theirIncome: 10 });
    expect(f.pinned).toBeGreaterThan(0);
    expect(f.pinned).toBeLessThanOrEqual(10);
    const unpinned = forecastBorder({ mine: 30, theirs: 30, myIncome: 10, theirIncome: 10, myDeploy: f.pinned - 1 });
    expect(unpinned.outcome).toBe('ground-down');
    // A stack the enemy cannot touch pins nothing.
    expect(forecastBorder({ mine: 200, theirs: 5, myIncome: 10, theirIncome: 5 }).pinned).toBe(0);
  });

  it('is deterministic', () => {
    const a = forecastBorder({ mine: 37, theirs: 33, myIncome: 7, theirIncome: 6 });
    expect(forecastBorder({ mine: 37, theirs: 33, myIncome: 7, theirIncome: 6 })).toEqual(a);
  });
});
