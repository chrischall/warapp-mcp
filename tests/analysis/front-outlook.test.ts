// #167: a multi-turn view of the main front decides whether the expansion share stands in contact.
// Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const enemy = (territoryId: number, armies: number, playerId = 20): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
// T1 (mine, my +2 B901) faces player 20's stack on T2; T3 (a neutral 2) completes B902 (+6) from T1's
// neighbour T4 (mine, interior to the front). Player 30 sits far away on T6, making it an FFA.
const map: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2, 4] },
    { id: 2, name: 'T2', connectedTo: [1, 5] },
    { id: 3, name: 'T3', connectedTo: [4] },
    { id: 4, name: 'T4', connectedTo: [1, 3] },
    { id: 5, name: 'T5', connectedTo: [2, 6] },
    { id: 6, name: 'T6', connectedTo: [5] },
  ],
  bonuses: [
    { id: 901, name: 'B901', value: 2, territoryIds: [1], bonusIds: [] },
    { id: 902, name: 'B902', value: 6, territoryIds: [3], bonusIds: [] },
  ],
  distributionModes: [],
};
const g = buildGraph(map);
const input = (mineArmies: number, theirs: number): PlanInput => ({
  graph: g,
  board: board([mine(1, mineArmies), enemy(2, theirs), neutral(3, 2), mine(4, 1), neutral(5, 2), neutral(6, 3)]),
  me: ME,
  income: 10,
  settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
  game: { players: [{ id: ME }, { id: 20 }], turn: 8 },
  options: { adapt: true, enemyDeploy: 8 },
});
const why = (p: ReturnType<typeof planTurn>) => p.rationale.join('\n');

describe('#167: the front outlook and the expansion share', () => {
  it('ground down with the share gone to expansion: holds come before it this turn', () => {
    const p = planTurn(input(20, 38));
    expect(p.profile.phase).toBe('contact');
    expect(why(p)).toMatch(
      /Front outlook \(#167\): my 20 on T1 \(#1\) against player 20's 38 on T2 \(#2\), .*with 7 a turn \(the income less the 3 expansion share\) I am ground down on turn 1 — the border pins 10 of my 10 income\. Holds come before the expansion share this turn\./,
    );
    expect(why(p)).not.toMatch(/Hold T1 \(#1\) later/);
  });

  it('a stand-off or a front I break keeps the share', () => {
    expect(why(planTurn(input(25, 25)))).toMatch(/it is a stand-off even with 3 of income going to expansion \(the border pins 7\): the expansion share stands/);
    expect(why(planTurn(input(30, 20)))).toMatch(/my stack breaks it on turn 2 even with 3 of income going to expansion/);
  });

  it('not adapting: no outlook, the fixed share', () => {
    expect(why(planTurn({ ...input(20, 38), options: { enemyDeploy: 8 } }))).not.toMatch(/Front outlook/);
  });
});
