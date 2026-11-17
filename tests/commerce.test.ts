import { describe, expect, it } from 'vitest';
import { armiesForGold, commerceDeploy, commerceRules, goldForArmies, deployBudget } from '../src/commerce.js';

// The client's own functions (GameSettings, client 6.08.0.2; read from the bundle, never run):
// armies a gold amount buys, and what a number of armies costs, under CommerceArmyCostMultiplier m.
function clientArmies(gold: number, m: number): number {
  if (m === 0) return gold;
  let d = 0;
  for (let e = 1; gold > 0; e++) {
    const f = Math.min(m, Math.floor(gold / e));
    if (f === 0) break;
    d += f;
    gold -= f * e;
  }
  return d;
}
function clientCost(armies: number, m: number): number {
  if (m === 0) return Math.max(armies, 0);
  let d = 0;
  for (let e = 1; armies > 0; e++) {
    d += e * Math.min(m, armies);
    armies -= m;
  }
  return Math.max(d, 0);
}

describe('the army price (CommerceArmyCostMultiplier)', () => {
  it('multiplier 0: one gold is one army (the live Trade Wars and Lunar games)', () => {
    expect(armiesForGold(25, 0)).toBe(25);
    expect(goldForArmies(25, 0)).toBe(25);
    expect(goldForArmies(-3, 0)).toBe(0);
  });

  it('multiplier m: the first m armies cost 1 each, the next m 2 each, and so on', () => {
    expect(goldForArmies(1, 1)).toBe(1);
    expect(goldForArmies(3, 1)).toBe(6); // 1 + 2 + 3
    expect(goldForArmies(5, 2)).toBe(1 + 1 + 2 + 2 + 3);
    expect(armiesForGold(6, 1)).toBe(3);
    expect(armiesForGold(7, 1)).toBe(3); // the 4th would cost 4
  });

  it('agrees with the client on every small case', () => {
    for (const m of [0, 1, 2, 3, 5, 10])
      for (let n = 0; n <= 60; n++) {
        expect(armiesForGold(n, m)).toBe(clientArmies(n, m));
        expect(goldForArmies(n, m)).toBe(clientCost(n, m));
      }
  });

  it('what the gold buys never costs more than the gold', () => {
    for (const m of [1, 2, 4])
      for (let g = 0; g <= 80; g++) {
        const a = armiesForGold(g, m);
        expect(goldForArmies(a, m)).toBeLessThanOrEqual(g);
        expect(goldForArmies(a + 1, m)).toBeGreaterThan(g);
      }
  });
});

describe('commerceRules', () => {
  it('is undefined outside a commerce game', () => {
    expect(commerceRules(undefined)).toBeUndefined();
    expect(commerceRules({ commerce: false })).toBeUndefined();
  });

  it('reads the parsed settings, defaulting what a game left out', () => {
    expect(commerceRules({ commerce: true, commerceRules: { armyCostMultiplier: 0 } })).toEqual({
      armyCostMultiplier: 0,
      cityBaseCost: null,
      territoryCityCostIncrease: 0,
      globalCityCostIncrease: 0,
      cityIncome: 0,
    });
  });

  it('a commerce game whose settings were not read is not guessed', () => {
    expect(commerceRules({ commerce: true })).toBeUndefined();
  });
});

describe('deployBudget', () => {
  it('spends the gold on armies at the game price', () => {
    expect(deployBudget(25, 0)).toEqual({ gold: 25, armies: 25, cost: 25, left: 0 });
    expect(deployBudget(7, 1)).toEqual({ gold: 7, armies: 3, cost: 6, left: 1 });
  });
});

describe('commerceDeploy', () => {
  const rules = (m: number) => ({ armyCostMultiplier: m, cityBaseCost: null, territoryCityCostIncrease: 0, globalCityCostIncrease: 0, cityIncome: 0 });

  it('buys armies with the gold the standing shows (it already carries saved gold and any Sanctions)', () => {
    expect(commerceDeploy(rules(0), 25, 25)).toEqual({ source: 'standing', gold: 25, armies: 25, cost: 25, left: 0, armyCostMultiplier: 0 });
    expect(commerceDeploy(rules(1), 7, 3)).toEqual({ source: 'standing', gold: 7, armies: 3, cost: 6, left: 1, armyCostMultiplier: 1 });
  });

  it("falls back to the modelled income when the standing's gold could not be read", () => {
    expect(commerceDeploy(rules(2), undefined, 10)).toEqual({ source: 'model', gold: 10, armies: 5, cost: 9, left: 1, armyCostMultiplier: 2 });
  });
});
