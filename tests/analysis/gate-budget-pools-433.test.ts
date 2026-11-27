// #433: under Local Deployment the gate budget (#297) is pool-aware. A bonus's armies deploy only on its own
// territories, so the next income pays a gate's shortfall only from the free income and the pools of the bonuses
// that gate is in. Counting the whole income said "not short" while the free income was short. Every map, id and
// name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { poolShortfall } from '../../src/analysis/local-deploy.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral, tinyMap } from './helpers.js';

const ME = 10;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  return {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const enemy = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

describe('poolShortfall', () => {
  // tinyMap: bonus A (+3) = 1, 2, 3; B (+2) = 4, 5; S (+4) = A + B.
  const g = buildGraph(tinyMap());
  it('without a pool it is the plain shortfall: what the needs lack against the income', () => {
    expect(poolShortfall(g, new Set([1, 7]), 5, new Map([[1, 4], [7, 3]]))).toEqual({ short: 2, deployable: 5 });
  });
  it("a bonus's pool pays only for needs on its own territories", () => {
    // A is held (+3): income 8 = 5 free + 3 on A. A need of 6 on 7 (outside A) gets only the 5 free.
    expect(poolShortfall(g, new Set([1, 2, 3, 7]), 8, new Map([[7, 6]]))).toEqual({ short: 1, deployable: 5 });
    // The same need on 1 (inside A) gets all 8.
    expect(poolShortfall(g, new Set([1, 2, 3, 7]), 8, new Map([[1, 6]]))).toEqual({ short: 0, deployable: 8 });
  });
  it('splits the needs between the pools and the free income as well as they can be', () => {
    // A and B and so S are held: income 5 + 3 + 2 + 4 = 14. Needs 4 on 1 (A, S) and 6 on 7 (no bonus): A and S
    // pay the 4 on 1, the 5 free pay 5 of the 6 on 7: 1 short. B's 2 reach no need: 12 deployable.
    const held = new Set([1, 2, 3, 4, 5, 7]);
    expect(poolShortfall(g, held, 14, new Map([[1, 4], [7, 6]]))).toEqual({ short: 1, deployable: 12 });
  });
});

// My gates T1 and T2 (10 each) face player 20's T11 and T12; my T3 (30) stands behind both, beside the neutral T4
// (2) that with T5 makes the +3 bonus B900 and borders player 20's T13, and beside my +4 bonus B901 (T6, T7), which
// is no gate. Income 9: 5 free and 4 that deploy only on T6 and T7. His deploy ~5.
const EDGES: [number, number][] = [[1, 2], [2, 3], [1, 3], [3, 4], [4, 5], [1, 11], [2, 12], [4, 13], [11, 12], [12, 13], [3, 6], [6, 7]];
const plan = (stacks: number, localDeployments: boolean): TurnPlan =>
  planTurn({
    graph: buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7, 11, 12, 13], EDGES, [[900, 3, [4, 5]], [901, 4, [6, 7]]])),
    board: board([
      mine(1, 10), mine(2, 10), mine(3, 30), neutral(4, 2), neutral(5, 2), mine(6, 1), mine(7, 1),
      enemy(11, stacks, 20), enemy(12, stacks, 20), enemy(13, stacks, 20),
    ]),
    me: ME,
    income: 9,
    settings: { ...STD, ...(localDeployments ? { localDeployments: true } : {}) },
    game: { players: [{ id: ME }, { id: 20 }], turn: 9 },
    options: { adapt: true, enemyDeploy: 5 },
  });

describe('#433: the gate budget counts only the income that can be deployed on the gates', () => {
  it('without Local Deployment the whole income pays: T4 opens a third gate the income of 9 can hold', () => {
    const p = plan(8, false);
    expect(p.expected.captures).toContain(4);
    expect(p.gates!.short).toBe(0);
    expect(p.gates!.deployable).toBeUndefined();
  });
  it("reports the shortfall the whole income hid: 'not short' at 9 is 1 short against the 5 that reach the gates", () => {
    // Here the strike on T11 and the step into T4 both land (T4 alone opens no gate more than without it).
    const p = plan(6, true);
    const g = p.gates!;
    expect(g.gates.map((x) => x.id)).toEqual([2, 4, 11]);
    expect(g.deficit).toBe(6);
    expect(g.income).toBe(9);
    expect(g.deployable).toBe(5);
    expect(g.short).toBe(1);
  });
});
