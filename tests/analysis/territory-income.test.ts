// "Extra Armies for Territories" (BonusArmyPer), issue #38. war.app's client
// computes income as floor(territories / BonusArmyPer), topped up to
// MinimumArmyBonus when smaller ("Bonus armies for N territories (if more than
// base armies)"), then adds held bonuses. Live: base 4, per 1, 1 territory → 4;
// base 20, per 1, 164 territories → 164; base 2, per 1, 3 territories → 3 (5 was
// refused, 3 accepted). Synthetic maps and ids only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { enemyDeployEstimates, incomeFor, planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import { analyzePlayer, armyCapIncome, incomeUncertainties, territoryIncome } from '../../src/analysis/player.js';
import { incomeDetail } from '../../src/analysis/plan/shared.js';
import type { GameMap, GameSettings } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

/** A line of `n` territories 1..n, with optional bonuses. */
function lineMap(n: number, bonuses: GameMap['bonuses'] = []): GameMap {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  return {
    id: 1,
    name: 'Line',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: [id - 1, id + 1].filter((x) => x >= 1 && x <= n),
    })),
    bonuses,
    distributionModes: [],
  };
}

const settings = (extra: Partial<GameSettings>): GameSettings => ({ cards: [], raw: {}, ...extra });

describe('territoryIncome', () => {
  it('is the base when the setting is off', () => {
    expect(territoryIncome(50, 5, 0)).toBe(5);
  });
  it('replaces the base when the territory armies are larger, never adds to it', () => {
    expect(territoryIncome(1, 4, 1)).toBe(4);
    expect(territoryIncome(164, 20, 1)).toBe(164);
    expect(territoryIncome(3, 2, 1)).toBe(3);
    expect(territoryIncome(9, 3, 2)).toBe(4);
    expect(territoryIncome(5, 3, 2)).toBe(3);
  });
});

describe('income with Extra Armies for Territories (live cases, #38)', () => {
  it('base 4, one army per territory, 1 territory held: 4 (not 5)', () => {
    const g = buildGraph(lineMap(3));
    const s = board([mine(1, 5), neutral(2, 2), neutral(3, 2)]);
    const a = analyzePlayer(g, s, ME, settings({ minimumArmyBonus: 4, bonusArmyPer: 1 }));
    expect(a.income.total).toBe(4);
    expect(incomeFor(g, s, ME, settings({ minimumArmyBonus: 4, bonusArmyPer: 1 }))).toBe(4);
  });

  it('base 20, one army per territory, 164 territories held: 164 (not 184)', () => {
    const g = buildGraph(lineMap(170));
    const s = board(
      Array.from({ length: 170 }, (_, i): TerritoryState => (i < 164 ? mine(i + 1, 1) : neutral(i + 1, 2))),
    );
    const a = analyzePlayer(g, s, ME, settings({ minimumArmyBonus: 20, bonusArmyPer: 1 }));
    expect(a.income).toMatchObject({ base: 20, perTerritory: 164, total: 164 });
    expect(incomeFor(g, s, ME, settings({ minimumArmyBonus: 20, bonusArmyPer: 1 }))).toBe(164);
  });

  it('base 2, one army per territory, 3 territories held: 3 (not 5)', () => {
    const g = buildGraph(lineMap(4));
    const s = board([mine(1, 1), mine(2, 1), mine(3, 1), neutral(4, 2)]);
    const a = analyzePlayer(g, s, ME, settings({ minimumArmyBonus: 2, bonusArmyPer: 1 }));
    expect(a.income).toMatchObject({ base: 2, perTerritory: 3, total: 3 });
    expect(incomeFor(g, s, ME, settings({ minimumArmyBonus: 2, bonusArmyPer: 1 }))).toBe(3);
  });

  it('adds held bonuses on top of the larger of the two', () => {
    const g = buildGraph(lineMap(6, [{ id: 101, name: 'A', value: 3, territoryIds: [1, 2], bonusIds: [] }]));
    const s = board([mine(1, 1), mine(2, 1), mine(3, 1), mine(4, 1), mine(5, 1), mine(6, 1)]);
    // floor(6/1) = 6 > base 4 → 6, + 3.
    expect(incomeFor(g, s, ME, settings({ minimumArmyBonus: 4, bonusArmyPer: 1 }))).toBe(6 + 3);
    // floor(6/2) = 3 < base 4 → 4, + 3.
    expect(incomeFor(g, s, ME, settings({ minimumArmyBonus: 4, bonusArmyPer: 2 }))).toBe(4 + 3);
  });

  it('is unchanged without BonusArmyPer: base + held bonuses', () => {
    const g = buildGraph(lineMap(3, [{ id: 101, name: 'A', value: 2, territoryIds: [1], bonusIds: [] }]));
    const s = board([mine(1, 1), mine(2, 1), mine(3, 1)]);
    expect(incomeFor(g, s, ME, settings({ minimumArmyBonus: 5 }))).toBe(7);
    expect(incomeFor(g, s, ME, settings({ minimumArmyBonus: 5, bonusArmyPer: 0 }))).toBe(7);
    expect(incomeFor(g, s, ME)).toBe(7);
  });
});

describe('the planner with Extra Armies for Territories', () => {
  it('a lone territory protects no income while the base still exceeds the territory armies', () => {
    // 1 territory, base 5: losing it changes max(5, 1) → max(5, 0): nothing.
    const g = buildGraph(lineMap(2));
    const p = planTurn({
      graph: g,
      board: board([mine(1, 2), { territoryId: 2, owner: { kind: 'player', playerId: ENEMY }, armies: 6 }]),
      me: ME,
      income: 5,
      settings: { ...STD, bonusArmyPer: 1, baseIncome: 5 },
      options: { goal: 'defend' },
    });
    expect(p.warnings.join('\n')).not.toMatch(/protects \+1/);
  });

  it('a territory protects an army of income once the territory armies exceed the base', () => {
    const g = buildGraph(lineMap(2));
    const p = planTurn({
      graph: g,
      board: board([mine(1, 2), { territoryId: 2, owner: { kind: 'player', playerId: ENEMY }, armies: 6 }]),
      me: ME,
      income: 5,
      settings: { ...STD, bonusArmyPer: 1, baseIncome: 0 },
      options: { goal: 'defend' },
    });
    expect(p.warnings).toContain('T1 (#1) cannot be held economically (needs 5, protects +1): conceded');
  });

  it("an opponent's deploy floor counts its visible territories when they out-earn the base", () => {
    const g = buildGraph(lineMap(13));
    const s = board([
      mine(1, 3),
      ...Array.from({ length: 12 }, (_, i): TerritoryState => ({
        territoryId: i + 2,
        owner: { kind: 'player', playerId: ENEMY },
        armies: 3,
      })),
    ]);
    const [e] = enemyDeployEstimates(g, s, ME, { ...STD, baseIncome: 4, bonusArmyPer: 1 });
    expect(e).toMatchObject({ playerId: ENEMY, base: 12, estimate: 12 });
    const [off] = enemyDeployEstimates(g, s, ME, { ...STD, baseIncome: 4 });
    expect(off!.base).toBe(4);
  });
});

describe('incomeUncertainties', () => {
  it('is empty for a game whose income rules are all modelled', () => {
    expect(incomeUncertainties(settings({ minimumArmyBonus: 4, bonusArmyPer: 1, armyCap: null }))).toEqual([]);
    expect(incomeUncertainties(settings({ minimumArmyBonus: 5, raw: { OverriddenBonuses: [] } }))).toEqual([]);
  });
  it('names an army cap, overridden bonuses and a missing base income', () => {
    expect(incomeUncertainties(settings({ minimumArmyBonus: 5, armyCap: 3 })).join('\n')).toMatch(/army cap/i);
    // Overrides the model could not read (#62); ones it read are applied to the map instead.
    expect(
      incomeUncertainties(settings({ minimumArmyBonus: 5, overriddenBonuses: new Map(), overriddenBonusesUnparsed: true })).join('\n'),
    ).toMatch(/overridden bonus/i);
    expect(incomeUncertainties(settings({ minimumArmyBonus: 5, overriddenBonuses: new Map([[1, 9]]) }))).toEqual([]);
    expect(incomeUncertainties(settings({})).join('\n')).toMatch(/base income/i);
    expect(incomeUncertainties(undefined).join('\n')).toMatch(/base income/i);
  });
  it('names an enabled Sanctions card, which can cut my income below the model', () => {
    const r = incomeUncertainties(
      settings({ minimumArmyBonus: 5, cards: ['Sanctions'], raw: { SanctionsCard: { Duration: 1, Percentage: 0.6 } } }),
    ).join('\n');
    expect(r).toMatch(/sanctions/i);
    expect(r).toMatch(/60%/);
    expect(incomeUncertainties(settings({ minimumArmyBonus: 5, cards: ['Sanctions'] })).join('\n')).toMatch(/sanctions/i);
    expect(incomeUncertainties(settings({ minimumArmyBonus: 5, cards: ['Reinforcement', 'Spy'] }))).toEqual([]);
  });
});

describe('the army cap (#253): received = min(income, round(cap × income) − my armies on the board)', () => {
  it('the live case: 8× income 52 with 375 armies on the board pays 41 (52 drew error 11, 41 committed)', () => {
    expect(armyCapIncome(52, 8, 375)).toEqual({ uncapped: 52, cap: 8, armies: 375, limit: 416, received: 41, cut: true });
    const g = buildGraph(lineMap(4));
    const s = board([mine(1, 200), mine(2, 100), mine(3, 75), neutral(4, 2)]);
    const rules = settings({ minimumArmyBonus: 52, armyCap: 8 });
    expect(incomeFor(g, s, ME, rules)).toBe(41);
    expect(incomeDetail(g, s, ME, rules)).toEqual({
      income: 41,
      cap: { uncapped: 52, cap: 8, armies: 375, limit: 416, received: 41, cut: true },
    });
    // Another player's armies do not count against mine.
    const theirs = board([mine(1, 200), mine(2, 100), mine(3, 75), mine(4, 500, ENEMY)]);
    expect(incomeFor(g, theirs, ME, rules)).toBe(41);
  });

  it('no cap: unchanged', () => {
    expect(armyCapIncome(52, null, 375)).toBeUndefined();
    expect(armyCapIncome(52, undefined, 375)).toBeUndefined();
    const g = buildGraph(lineMap(4));
    const s = board([mine(1, 200), mine(2, 100), mine(3, 75), neutral(4, 2)]);
    expect(incomeFor(g, s, ME, settings({ minimumArmyBonus: 52, armyCap: null }))).toBe(52);
    expect(incomeDetail(g, s, ME, settings({ minimumArmyBonus: 52 }))).toEqual({ income: 52 });
  });

  it('below the cap: unchanged, and reported as not cut', () => {
    expect(armyCapIncome(52, 8, 300)).toEqual({ uncapped: 52, cap: 8, armies: 300, limit: 416, received: 52, cut: false });
    // Exactly reaching the cap pays in full.
    expect(armyCapIncome(52, 8, 364)).toMatchObject({ received: 52, cut: false });
    const g = buildGraph(lineMap(4));
    const s = board([mine(1, 200), mine(2, 100), neutral(3, 2), neutral(4, 2)]);
    expect(incomeFor(g, s, ME, settings({ minimumArmyBonus: 52, armyCap: 8 }))).toBe(52);
  });

  it('at or over the cap pays nothing, never a negative income', () => {
    expect(armyCapIncome(52, 8, 416)).toMatchObject({ received: 0, cut: true });
    expect(armyCapIncome(52, 8, 900)).toMatchObject({ received: 0, cut: true });
  });

  it("rounds a fractional cap's limit to the nearest, .5 down (the client's rounding)", () => {
    expect(armyCapIncome(5, 2.5, 10)).toMatchObject({ limit: 12, received: 2 });
    expect(armyCapIncome(5, 2.6, 10)).toMatchObject({ limit: 13, received: 3 });
  });

  it('an unreadable army count of mine leaves the cap unapplied', () => {
    const g = buildGraph(lineMap(3));
    const s = board([mine(1, 400), { ...mine(2, 0), armies: null }, neutral(3, 2)]);
    expect(incomeDetail(g, s, ME, settings({ minimumArmyBonus: 52, armyCap: 8 }))).toEqual({ income: 52, capUnknown: true });
  });

  it('the uncertainty states the formula, that it rests on one live case, and that card armies are outside it', () => {
    const text = incomeUncertainties(settings({ minimumArmyBonus: 52, armyCap: 8 })).join('\n');
    expect(text).toMatch(/min\(income, 8 × income − your armies on the board\)/);
    expect(text).toMatch(/one live case/);
    expect(text).toMatch(/Reinforcement card/);
    expect(text).not.toMatch(/does not apply it/);
    const computed = incomeUncertainties(settings({ minimumArmyBonus: 52, armyCap: 8 }), {
      armyCap: { uncapped: 52, cap: 8, armies: 375, limit: 416, received: 41, cut: true },
    }).join('\n');
    expect(computed).toMatch(/8 × 52 = 416, less your 375 armies on the board, is 41: income 41, not 52/);
    expect(computed).toMatch(/one live case/);
  });
});
