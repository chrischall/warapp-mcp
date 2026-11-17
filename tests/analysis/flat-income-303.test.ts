// #303: from the play session's 21 lost games — my income flattened after about turn 10 while the winner's
// grew, and in contact the plan turned the income into holds and margins over them while a neutral bonus was
// still in reach. In miniature: B901 (+2, T1) faces player 20's 10 on T2; B902 (+6) is one neutral, T3 (5),
// beside T4 (mine, 3) — 8 to take, more than the 3 left after T1's exact hold of 7. Player 30 sits far away
// on T6, making it an FFA. Every map, id and name here is made up.
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
const flat = [4, 5, 6, 7].map((turn) => ({ turn, income: 10 }));
const input = (o: { history?: { turn: number; income: number }[]; t3?: TerritoryState; enemyDeploy?: number } = {}): PlanInput => ({
  graph: g,
  board: board([mine(1, 4), enemy(2, 10), o.t3 ?? neutral(3, 5), mine(4, 3), neutral(5, 2), enemy(6, 3, 30)]),
  me: ME,
  income: 10,
  settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
  game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 8 },
  turn: 8,
  ...(o.history ? { incomeHistory: o.history } : {}),
  options: { adapt: true, enemyDeploy: o.enemyDeploy ?? 8 },
});
const why = (p: ReturnType<typeof planTurn>) => p.rationale.join('\n');
const deployOn = (p: ReturnType<typeof planTurn>, t: number) => p.deploys.find((d) => d.territoryId === t)?.armies ?? 0;

describe('#303: a flat income keeps the margins over the holds from starving a reachable bonus', () => {
  it('without a history the leftover tops T1 up to a comfortable margin and T4 walks to the front', () => {
    const p = planTurn(input());
    expect(p.incomeTrend).toBeUndefined();
    expect(deployOn(p, 1)).toBe(10);
    expect(p.moves).toContainEqual(expect.objectContaining({ from: 4, to: 1, kind: 'transfer' }));
    expect(why(p)).not.toMatch(/#303/);
  });

  it('flat: T1 keeps its exact hold and the leftover saves on T4 toward B902 instead', () => {
    const p = planTurn(input({ history: flat }));
    expect(p.incomeTrend).toEqual({ turns: [4, 5, 6, 7, 8].map((turn) => ({ turn, income: 10 })), slope: 0, flat: true });
    expect(deployOn(p, 1)).toBe(7);
    expect(deployOn(p, 4)).toBe(3);
    expect(p.moves.some((m) => m.from === 4)).toBe(false);
    expect(why(p)).toMatch(
      /Deploy the leftover 3 to T4 \(#4\): save toward T3 \(#3\) \(8 to take\), the next step of bonus B902 \(#902\), which this turn cannot afford: my income is flat \(10, 10, 10, 10, 10 over turns 4–8, slope 0\/turn\), so no comfort margin above the exact holds goes ahead of completing bonus B902 \(#902\) \(\+6\) from neutrals \(#303\)\./,
    );
    // The exact hold still holds the border.
    expect(why(p)).toMatch(/Deploy 7 to T1 \(#1\) so it holds/);
  });

  it('a growing income is not flat: the plan is the plan without a history', () => {
    const p = planTurn(input({ history: [4, 5, 6, 7].map((turn, i) => ({ turn, income: 4 + 2 * i })) }));
    expect(p.incomeTrend).toMatchObject({ flat: false, slope: 1.6 });
    const { incomeTrend: _, ...rest } = p;
    const { incomeTrend: __, ...base } = planTurn(input());
    expect(rest).toEqual(base);
  });

  it('a member held by an opponent earning more than me is no reachable bonus: the margin stands', () => {
    const p = planTurn(input({ history: flat, t3: enemy(3, 1, 30), enemyDeploy: 12 }));
    expect(why(p)).not.toMatch(/#303/);
  });
});
