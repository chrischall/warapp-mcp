// #314: a hold that survives by a handful loses the stack anyway. A border at 1061 against an
// adjacent 1188 stack plus a 579 deploy "holds" (1767 attackers kill 1060), but the exchange leaves
// 1 of mine against hundreds of its survivors, and the territory falls next turn. The plan now says
// what the exchange leaves and warns when the survivors take it next turn. Ids and names are made up.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine } from './helpers.js';

const ME = 10;
const FOE = 20;
const map: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2, 3] },
    { id: 2, name: 'T2', connectedTo: [1] },
    { id: 3, name: 'T3', connectedTo: [1] },
  ],
  bonuses: [],
  distributionModes: [],
};
const input = (mineOn1: number, foeOn2: number, deploy: number): PlanInput => ({
  graph: buildGraph(map),
  board: board([mine(1, mineOn1), mine(2, foeOn2, FOE), mine(3, 1)]),
  me: ME,
  income: 61,
  settings: { offensiveKillRate: 60, defensiveKillRate: 70 },
  game: { players: [{ id: ME }, { id: FOE }], turn: 10 },
  options: { enemyDeploy: deploy, goal: 'defend' },
});
const handful = (w: string[]) => w.filter((x) => x.includes('#314'));

describe('a hold that survives by a handful (#314)', () => {
  it('reports what the exchange leaves and warns when the survivors take it next turn', () => {
    const plan = planTurn(input(1000, 1188, 579));
    const lines = handful(plan.warnings);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^T1 \(#1\) holds by a handful/);
    expect(lines[0]).toMatch(/leaves 1 of mine against \d+ of player 20's/);
  });
  it('says nothing when the hold leaves a real stack', () => {
    expect(handful(planTurn(input(1000, 100, 50)).warnings)).toEqual([]);
  });
});
