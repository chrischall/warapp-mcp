// #167: one deploy lands on one territory. Borders that hold against an opponent's stacks alone but
// not with its whole deploy on them are a gamble on where it lands, and the plan says so with the
// odds. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine } from './helpers.js';

const enemy = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: 20 }, armies });
// Player 20's T2 touches my T1 and T3, each its own held +5 bonus.
const map: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2] },
    { id: 2, name: 'T2', connectedTo: [1, 3] },
    { id: 3, name: 'T3', connectedTo: [2] },
  ],
  bonuses: [
    { id: 1, name: 'B1', value: 5, territoryIds: [1], bonusIds: [] },
    { id: 3, name: 'B3', value: 5, territoryIds: [3], bonusIds: [] },
  ],
  distributionModes: [],
};
const g = buildGraph(map);
const plan = (income: number, deploy: number) =>
  planTurn({
    graph: g,
    board: board([mine(1, 10), enemy(2, 8), mine(3, 10)]),
    me: 10,
    income,
    settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
    game: { players: [{ id: 10 }, { id: 20 }], turn: 6 },
    options: { enemyDeploy: deploy },
  });
const why = (p: ReturnType<typeof planTurn>) => p.rationale.join('\n');

describe('#167: cover odds', () => {
  it('two borders short of the whole deploy: each holds half the time, both never', () => {
    // 10 need 16 to take: player 20's 7 movable cannot, 7 + 10 can. No income covers either.
    const p = plan(0, 10);
    expect(why(p)).toMatch(
      /Cover odds against player 20 \(#167\): its one ~10 deploy can land on one of the 2 borders facing it; 2 hold against its stacks alone but not with that deploy on them \(T1 \(#1\), T3 \(#3\)\) — a gamble on where it lands: if it picks among the 2 at random, each holds with chance 50%, and all of them with 0%\./,
    );
  });

  it('one border short: the chance it holds', () => {
    // Income 1 covers T1 (11 need 18), not T3.
    expect(why(plan(1, 10))).toMatch(/\(T3 \(#3\)\) — a gamble on where it lands: if it picks among the 2 at random, it holds with chance 50%\./);
  });

  it('borders sized for the whole deploy are no gamble', () => {
    expect(why(plan(30, 10))).not.toMatch(/Cover odds/);
  });
});
