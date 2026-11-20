// #421 (owner decision of 2026-11-20, "Strike share"): once in contact on a flat income, 25% of the income
// feeds the strike stack each turn, ahead of comfort margins; holds still take their exact need first. The
// share is held out of captures (rule 0p.3c's stack gets it with the leftover), and never at the cost of next
// income. In miniature (the #421 stockpile board): T1 (+2) is mine with 60 armies facing player 20's 25 on T2;
// T3, a neutral single-territory bonus B903 (+4), lies beside my T4 (3 armies); on the second map T3 is one
// of two members of B904 (+4, the other T8 on 40), so taking it completes nothing. Income 10, flat. Every
// map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput } from '../../src/analysis/planner.js';
import { STRIKE_SHARE } from '../../src/analysis/plan/stockpile.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const enemy = (territoryId: number, armies: number, playerId = 20): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const mapOf = (advance: boolean): GameMap => ({
  id: 1,
  name: 'Synthetic',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2, 4] },
    { id: 2, name: 'T2', connectedTo: [1, 5] },
    { id: 3, name: 'T3', connectedTo: [4] },
    { id: 4, name: 'T4', connectedTo: [1, 3] },
    { id: 5, name: 'T5', connectedTo: [2, 6] },
    { id: 6, name: 'T6', connectedTo: [5, 7] },
    { id: 7, name: 'T7', connectedTo: [6] },
    ...(advance ? [{ id: 8, name: 'T8', connectedTo: [3] }] : []),
  ].map((t) => (advance && t.id === 3 ? { ...t, connectedTo: [4, 8] } : t)),
  bonuses: [
    { id: 901, name: 'B901', value: 2, territoryIds: [1], bonusIds: [] },
    advance
      ? { id: 904, name: 'B904', value: 4, territoryIds: [3, 8], bonusIds: [] }
      : { id: 903, name: 'B903', value: 4, territoryIds: [3], bonusIds: [] },
  ],
  distributionModes: [],
});
const single = buildGraph(mapOf(false));
const pair = buildGraph(mapOf(true));
const flat = [4, 5, 6, 7].map((turn) => ({ turn, income: 10 }));
const input = (o: { history?: boolean; t3?: number; oneVsOne?: boolean; share?: false; advance?: boolean } = {}): PlanInput => ({
  graph: o.advance ? pair : single,
  board: board([
    mine(1, 60),
    enemy(2, 25),
    neutral(3, o.t3 ?? 6),
    mine(4, 3),
    neutral(5, 40),
    ...(o.oneVsOne ? [neutral(6, 3)] : [enemy(6, 3, 30)]),
    enemy(7, 5),
    ...(o.advance ? [neutral(8, 40)] : []),
  ]),
  me: ME,
  income: 10,
  settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
  game: { players: [{ id: ME }, { id: 20 }, ...(o.oneVsOne ? [] : [{ id: 30 }])], turn: 8 },
  turn: 8,
  ...(o.history === false ? {} : { incomeHistory: flat }),
  options: { adapt: true, enemyDeploy: 5, ...(o.share === false ? { strikeShare: false } : {}) },
});
const why = (p: ReturnType<typeof planTurn>) => p.rationale.join('\n');
const deployOn = (p: ReturnType<typeof planTurn>, t: number) => p.deploys.find((d) => d.territoryId === t)?.armies ?? 0;

describe('#421: the strike share', () => {
  it('is a quarter of the income', () => {
    expect(STRIKE_SHARE).toBe(0.25);
  });

  it('flat and in contact, with room for both: the capture of T3 leaves the stack its 2 anyway', () => {
    const p = planTurn(input());
    expect(deployOn(p, 1)).toBe(2);
    expect(deployOn(p, 4)).toBe(8);
    expect(p.expected.captures).toEqual(expect.arrayContaining([2, 3]));
    expect(why(p)).toMatch(
      /Strike share \(#421\): 2 of my flat 10 income \(25%\) was held out of captures for the strike stack on T1 \(#1\), ahead of comfort margins; holds took their exact need first\./,
    );
    expect(why(p)).not.toMatch(/Hold a reserve of/);
  });

  it('without the share an advance into B904 takes 9 of the 10; with it the advance no longer fits and the stack gets the income', () => {
    // T3 on 7 needs 9 deploys beside T4's 3: more than the 8 the share leaves.
    const off = planTurn(input({ advance: true, t3: 7, share: false }));
    expect(deployOn(off, 1)).toBe(1);
    expect(deployOn(off, 4)).toBe(9);
    expect(off.expected.captures).toContain(3);
    const on = planTurn(input({ advance: true, t3: 7 }));
    expect(deployOn(on, 1)).toBe(10);
    expect(on.expected.captures).not.toContain(3);
    expect(on.expected.captures).toContain(2);
    expect(on.expected.nextIncome).toBe(off.expected.nextIncome);
    expect(why(on)).toMatch(/Strike share \(#421\): 2 of my flat 10 income/);
  });

  it('never at the cost of next income: when the share would starve the completion of B903, it is not held', () => {
    // T3 on 7 needs all 10 deploys beside T4's 3: holding 2 back would lose the +4.
    const p = planTurn(input({ t3: 7 }));
    expect(p.expected.captures).toContain(3);
    expect(p.expected.bonusesCompleted).toContain(903);
    expect(why(p)).toMatch(/Strike share \(#421\) not held this turn: holding 2 of the income out of captures for the strike stack would lower next income/);
  });

  it('in a 1v1 on a flat income too', () => {
    const p = planTurn(input({ oneVsOne: true }));
    expect(deployOn(p, 1)).toBeGreaterThanOrEqual(2);
    expect(why(p)).toMatch(/Strike share \(#421\): 2 of my flat 10 income/);
  });

  it('no income history, or a growing income: no share, the plan as before', () => {
    const none = planTurn(input({ history: false }));
    expect(why(none)).not.toMatch(/Strike share/);
    const growing: PlanInput = { ...input(), incomeHistory: [4, 5, 6, 7].map((turn, i) => ({ turn, income: 4 + 2 * i })) };
    const p = planTurn(growing);
    expect(p.incomeTrend?.flat).toBe(false);
    expect(why(p)).not.toMatch(/Strike share/);
  });

  it('a caller reserve is still said as such, apart from the share', () => {
    const p = planTurn({ ...input({ t3: 4 }), options: { adapt: true, enemyDeploy: 5, reserve: 1 } });
    expect(why(p)).toMatch(/Hold a reserve of 1 out of captures\./);
    expect(why(p)).toMatch(/Strike share \(#421\): 2 of my flat 10 income/);
  });
});
