// #375: a deal outside any recorded truce — "that neutral is yours", "no war with you" — is given to the
// planner as territories and players to avoid: no pass attacks them, and the plan goes around them.
// Ids and names are made up.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
// My T1 (20) beside the neutral T2 (2), player 20's T3 (1) and the neutral T4 (2).
const map: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2, 3, 4] },
    { id: 2, name: 'T2', connectedTo: [1] },
    { id: 3, name: 'T3', connectedTo: [1] },
    { id: 4, name: 'T4', connectedTo: [1] },
  ],
  bonuses: [],
  distributionModes: [],
};
const input = (avoid?: { territories?: number[]; players?: number[] }): PlanInput => ({
  graph: buildGraph(map),
  board: board([mine(1, 20), neutral(2, 2), mine(3, 1, FOE), neutral(4, 2)]),
  me: ME,
  income: 5,
  settings: { offensiveKillRate: 60, defensiveKillRate: 70 },
  game: { players: [{ id: ME }, { id: FOE }, { id: 30 }], turn: 5 },
  options: { enemyDeploy: 1, ...(avoid ? { avoid } : {}) },
});
const targets = (avoid?: Parameters<typeof input>[0]) =>
  planTurn(input(avoid))
    .moves.filter((m) => m.kind === 'attack')
    .map((m) => m.to)
    .sort();

describe('avoid territories and players (#375)', () => {
  it('attacks them when nothing is avoided', () => {
    expect(targets()).toEqual(expect.arrayContaining([2, 3]));
  });
  it('never attacks an avoided territory or a territory of an avoided player', () => {
    const t = targets({ territories: [2], players: [FOE] });
    expect(t).not.toContain(2);
    expect(t).not.toContain(3);
    expect(t).toContain(4);
  });
});
