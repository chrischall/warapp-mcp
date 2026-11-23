// Mega-game part 4: Local Deployment when most bonuses are worth 0 (game 45736172: Huge Westeros, the Local
// Deployment Helper zeroed 670 bonuses, 384 single-territory castles pay 10–250, MinimumArmyBonus 15,
// BonusArmyPer 1). The client's income code (bundle `Bm`/`hAb`, read 2026-11-23): free armies =
// floor(territories ÷ BonusArmyPer), topped up to MinimumArmyBonus; each held bonus adds its value as a pool
// (`Oac` skips a 0 value: no pool); a deploy on a territory draws on the pools of its bonuses, smallest first,
// then on the free armies (`IKa`), else error 415 ArmiesNotDeployedLocally. Synthetic map only.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import { chargeDeploys, deployPools } from '../../src/analysis/local-deploy.js';
import { boardIncome, territoryIncome } from '../../src/analysis/player.js';
import type { LiveTerritory } from '../../src/live.js';
import type { GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';

const ME = 7;
// 1 is a castle (+10, alone in its bonus); 1–3 are a region the helper zeroed; 4–5 another zeroed region.
const map: GameMap = {
  id: 1,
  name: 'Synthetic Westeros',
  territories: [1, 2, 3, 4, 5].map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: [id - 1, id + 1].filter((n) => n >= 1 && n <= 5),
  })),
  bonuses: [
    { id: 11, name: 'Castle', value: 10, territoryIds: [1], bonusIds: [] },
    { id: 12, name: 'Region', value: 0, territoryIds: [1, 2, 3], bonusIds: [] },
    { id: 13, name: 'Far', value: 0, territoryIds: [4, 5], bonusIds: [] },
  ],
  distributionModes: [],
};
const g = buildGraph(map);
const held = new Set([1, 2, 3]);
const board: LiveTerritory[] = [1, 2, 3, 4, 5].map((id) => ({
  territoryId: id,
  fogLevel: 1,
  fogged: false,
  owner: held.has(id) ? ME : 0,
  armies: 5,
}));
const rules = { base: 15, per: 1 };

describe('Local Deployment with 0-value bonuses and the minimum army bonus', () => {
  it('the free income is MinimumArmyBonus until the territories pay more', () => {
    expect(territoryIncome(1, 15, 1)).toBe(15);
    expect(territoryIncome(3, 15, 1)).toBe(15);
    expect(territoryIncome(40, 15, 1)).toBe(40);
    expect(boardIncome(g, held, rules).total).toBe(25);
  });

  it('a held 0-value bonus makes no pool; only the castle pools, the rest goes anywhere', () => {
    const pools = deployPools(g, held, 25);
    expect(pools.bonuses.map((p) => [p.bonusId, p.value, p.territoryIds])).toEqual([[11, 10, [1]]]);
    expect(pools.anywhere).toBe(15);
    // The castle's pool and free armies both land on the castle.
    expect(chargeDeploys(pools, new Map([[1, 25]])).anywhereUsed).toBe(15);
  });

  const T = (id: number) => ({ id, name: `T${id}` });
  const submit = (deploys: Array<[number, number]>) =>
    validateTurn({
      map,
      board,
      myInGameId: ME,
      income: 25,
      guard: true,
      deploys: deploys.map(([id, armies]) => ({ territory: T(id), armies })),
      moves: [],
      localDeployments: true,
    });

  it('submit: the base income may go on any territory of mine, a 0-value bonus\'s included', () => {
    expect(submit([[2, 15], [1, 10]])).toEqual({ warnings: [] });
    expect(submit([[3, 5], [2, 10], [1, 10]])).toEqual({ warnings: [] });
    expect(submit([[1, 25]])).toEqual({ warnings: [] });
  });

  it('submit: the castle\'s armies off the castle are refused (error 415 before sending)', () => {
    expect(() => submit([[2, 25]])).toThrow(/only 15 may go anywhere this turn \(10 too many\)/);
    expect(() => submit([[2, 20], [1, 5]])).toThrow(/Castle.*\+10 earned, only 5 deployed inside it/);
  });

  it('the refusal hint names what the free income is', () => {
    try {
      submit([[2, 25]]);
    } catch (e) {
      expect((e as { hint?: string }).hint).toMatch(/0-value bonus has no pool/);
      expect((e as { hint?: string }).hint).toMatch(/MinimumArmyBonus/);
      return;
    }
    throw new Error('not refused');
  });
});
