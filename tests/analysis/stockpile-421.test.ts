// #421: from the strategy review — losing FFA games ended with many turns of income standing on the board
// (median 6.8 at surrender) while the income sat flat: outside a 1v1 the leftover went to comfort margins and
// no strike stack was built, so nothing spent the pile. In miniature: B901 (+2, T1) is mine with 60 armies,
// facing player 20's 25 on T2 (its bonus B902, +3, is T2 alone); player 30 sits far away on T6, making it an
// FFA. My income is 10, flat; 60 is six turns of it. Every map, id and name here is made up.
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
    { id: 6, name: 'T6', connectedTo: [5, 7] },
    { id: 7, name: 'T7', connectedTo: [6] },
  ],
  bonuses: [
    { id: 901, name: 'B901', value: 2, territoryIds: [1], bonusIds: [] },
  ],
  distributionModes: [],
};
const g = buildGraph(map);
const flat = [4, 5, 6, 7].map((turn) => ({ turn, income: 10 }));
const input = (o: { history?: { turn: number; income: number }[]; t1?: number; t2?: number } = {}): PlanInput => ({
  graph: g,
  board: board([mine(1, o.t1 ?? 60), enemy(2, o.t2 ?? 25), neutral(3, 40), mine(4, 3), neutral(5, 40), enemy(6, 3, 30), enemy(7, 5)]),
  me: ME,
  income: 10,
  settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
  game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 8 },
  turn: 8,
  ...(o.history ? { incomeHistory: o.history } : {}),
  options: { adapt: true, enemyDeploy: 5 },
});
const why = (p: ReturnType<typeof planTurn>) => p.rationale.join('\n');

const attacks = (p: ReturnType<typeof planTurn>) => p.moves.filter((m) => m.kind === 'attack');

describe('#421: a stockpile on a flat income builds and spends a strike stack outside a 1v1', () => {
  it('without a history nothing spends the 63 armies: T2 breaks no bonus and the lead is short of 3×', () => {
    const p = planTurn(input());
    expect(attacks(p)).toEqual([]);
    expect(why(p)).not.toMatch(/#421/);
  });

  it('flat: T1 is the strike stack facing player 20 (2.1× its armies in view) and takes T2', () => {
    const p = planTurn(input({ history: flat }));
    expect(p.incomeTrend?.flat).toBe(true);
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 2, kind: 'attack', armies: 50 })]);
    expect(why(p)).toMatch(
      /Stockpile \(#421\): 63 armies of mine stand on the board, 6\.3 turns of my flat 10 income, 2\.1× player 20's in view, so the spare deploys build one strike stack on T1 \(#1\) facing it/,
    );
    expect(why(p)).toMatch(
      /Deploy the leftover 10 to T1 \(#1\): one strike stack on the border facing player 20, the opponent whose armies in view mine outnumber 2\.1× \(#421\)/,
    );
    expect(why(p)).toMatch(/Attack T2 \(#2\) from the strike stack T1 \(#1\) with 50/);
  });

  it('a growing income is no stockpile: the plan is the plan without a history', () => {
    const p = planTurn(input({ history: [4, 5, 6, 7].map((turn, i) => ({ turn, income: 4 + 2 * i })) }));
    expect(p.incomeTrend?.flat).toBe(false);
    const { incomeTrend: _, ...rest } = p;
    const { incomeTrend: __, ...base } = planTurn(input());
    expect(rest).toEqual(base);
  });

  it('under four turns of income on the board is no stockpile', () => {
    // 36 + 3 = 39 armies, 3.9 turns of income; player 20's 15 + 5 leave a 2× lead.
    const p = planTurn(input({ history: flat, t1: 36, t2: 15 }));
    expect(why(p)).not.toMatch(/#421/);
  });

  it('without a 2× lead in visible armies over the opponent beside me, no assault', () => {
    // 63 against player 20's 30 + 5 = 35: 1.8×.
    const p = planTurn(input({ history: flat, t2: 30 }));
    expect(why(p)).not.toMatch(/#421/);
    expect(attacks(p)).toEqual([]);
  });
});
