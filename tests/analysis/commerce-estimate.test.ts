// #332: in a commerce game an opponent earns gold, and with a rising army price (multiplier m > 0) the gold its
// visible base and bonuses pay buys fewer armies. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings } from '../../src/analysis/planner.js';
import { applyArmyPrice } from '../../src/analysis/plan/estimates.js';
import type { EnemyDeployEstimate } from '../../src/analysis/plan/shared.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, baseIncome: 5 };
const enemy = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: FOE }, armies });

// The foe holds bonus 900 = {2, 3} (+10): it earns 5 + 10 = 15 gold.
const map: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2] },
    { id: 2, name: 'T2', connectedTo: [1, 3] },
    { id: 3, name: 'T3', connectedTo: [2] },
  ],
  bonuses: [{ id: 900, name: 'B900', value: 10, territoryIds: [2, 3], bonusIds: [] }],
  distributionModes: [],
};
const input = (settings: PlannerSettings): PlanInput => ({
  graph: buildGraph(map),
  board: board([mine(1, 30), enemy(2, 4), enemy(3, 2)]),
  me: ME,
  income: 5,
  settings,
  game: { players: [{ id: ME }, { id: FOE }], turn: 6 },
});

describe('#332: an opponent estimate in a commerce game', () => {
  it('is unchanged at one gold per army (multiplier 0) and outside a commerce game', () => {
    expect(planTurn(input(STD)).enemyDeploy).toBe(15);
    expect(planTurn(input({ ...STD, armyCostMultiplier: 0 })).enemyDeploy).toBe(15);
  });

  it('buys armies with the gold its visible income pays, at the rising price', () => {
    // 15 gold at multiplier 1 buys 5 armies (1 + 2 + 3 + 4 + 5 = 15).
    const p = planTurn(input({ ...STD, armyCostMultiplier: 1 }));
    expect(p.enemyDeploy).toBe(5);
    expect(p.warnings.join('\n')).toMatch(/Player 20 earns ~15 gold, which buys ~5 armies at the army cost multiplier 1/);
  });

  it('converts only a figure read off the board; an observed, tracked or prior figure is already armies', () => {
    const base = { playerId: FOE, estimate: 15, card: null } as unknown as EnemyDeployEstimate;
    for (const source of ['observed', 'tracked', 'prior'] as const) expect(applyArmyPrice([{ ...base, source }], 1)[0]!.estimate).toBe(15);
    expect(applyArmyPrice([{ ...base, source: 'visible' }], 1)[0]).toMatchObject({ estimate: 5, armyPrice: { gold: 15, multiplier: 1 } });
    // A Reinforcement card's armies are not gold: they stay on top.
    const carded = applyArmyPrice([{ ...base, source: 'exact', estimate: 20, card: { armies: 5, due: 4 } } as unknown as EnemyDeployEstimate], 1);
    expect(carded[0]!.estimate).toBe(10);
    expect(applyArmyPrice([{ ...base, source: 'visible' }], 0)[0]!.estimate).toBe(15);
  });
});
