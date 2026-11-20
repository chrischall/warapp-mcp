// #421 (owner decision of 2026-11-20, "Other spends"): on a stockpile — my income flat and my armies in view at
// least four turns of it — the turn spends by breaking the strongest opponent's cheapest visible bonus, ahead of
// every other capture and never skipped as a second front. In miniature: my T1 (60) faces player 20's 25 on T2;
// my T4 (20) borders player 20's T3 (3; B905 = T3 + T8, +3) and player 30's T9 (1; B906 = T9 + T10, +2). Player
// 20 holds more and is the strongest; B906 is the cheaper break, but it is not the strongest's. Income 10. Every
// map, id and name here is made up.
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
const edges: [number, number][] = [[1, 2], [1, 4], [2, 5], [3, 4], [3, 8], [4, 9], [5, 6], [6, 7], [9, 10]];
const map: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
  })),
  bonuses: [
    { id: 905, name: 'B905', value: 3, territoryIds: [3, 8], bonusIds: [] },
    { id: 906, name: 'B906', value: 2, territoryIds: [9, 10], bonusIds: [] },
  ],
  distributionModes: [],
};
const g = buildGraph(map);
const flat = [4, 5, 6, 7].map((turn) => ({ turn, income: 10 }));
const input = (o: { history?: boolean; t4?: number } = {}): PlanInput => ({
  graph: g,
  board: board([
    mine(1, 60),
    enemy(2, 25),
    enemy(3, 3),
    mine(4, o.t4 ?? 20),
    neutral(5, 40),
    enemy(6, 3, 30),
    enemy(7, 5),
    enemy(8, 4),
    enemy(9, 1, 30),
    enemy(10, 1, 30),
  ]),
  me: ME,
  income: 10,
  settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
  game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 8 },
  turn: 8,
  ...(o.history === false ? {} : { incomeHistory: flat }),
  options: { adapt: true },
});
const why = (p: ReturnType<typeof planTurn>) => p.rationale.join('\n');

describe("#421: a stockpile breaks the strongest opponent's cheapest visible bonus", () => {
  it('without a history there is no pile and no spend', () => {
    const p = planTurn(input({ history: false }));
    expect(why(p)).not.toMatch(/Stockpile spend/);
    expect(p.moves.some((m) => /#421/.test(m.reason ?? ''))).toBe(false);
  });

  it("on the pile: player 20's B905 is broken first, named as the stockpile's spend", () => {
    const p = planTurn(input());
    expect(why(p)).toMatch(
      /Stockpile spend \(#421\): 80 armies of mine stand on the board, 8 turns of my flat 10 income, so the turn tries first to break the strongest opponent's cheapest visible bonus, player 20's B905 \(#905\) \(\+3\) through T3 \(#3\)/,
    );
    const attacks = p.moves.filter((m) => m.kind === 'attack' && m.from !== 1);
    expect(attacks[0]).toMatchObject({ from: 4, to: 3 });
    expect(attacks[0]!.reason).toMatch(/breaks enemy bonus B905 \(#905\).*the stockpile's spend on the strongest opponent \(#421\)/);
    expect(p.expected.captures).toContain(3);
  });

  it('under four turns of income in view: no spend', () => {
    // 20 + 15 = 35 armies against an income of 10: no pile.
    const p = planTurn({ ...input({ t4: 15 }), board: board([...input({ t4: 15 }).board.territories.filter((t) => t.territoryId !== 1), mine(1, 20)]) });
    expect(why(p)).not.toMatch(/Stockpile spend/);
  });
});
