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
import { analyzePlayer, incomeUncertainties, territoryIncome } from '../../src/analysis/player.js';
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
