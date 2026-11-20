// #421 (owner decision of 2026-11-20, "Other spends"): on a stockpile the turn may spend by an all-in completion —
// every remaining member of a contested bonus taken in one turn, each member an opponent holds sized for its
// owner's deploy, the push within the payback horizon × the bonus's value. In miniature: my T1 (60) faces player
// 20's 25 on T2; my T4 (12) is one member of B907 (+3), whose other member T11 player 20 holds with 2. Player 30
// sits far off on T6; a neutral +1 (T12) lies beside T4 too. Income 10, flat. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput } from '../../src/analysis/planner.js';
import { contestedBonuses } from '../../src/analysis/plan/stockpile.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const enemy = (territoryId: number, armies: number, playerId = 20): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const edges: [number, number][] = [[1, 2], [1, 4], [2, 5], [4, 11], [4, 12], [5, 6], [6, 7]];
const map: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: [1, 2, 4, 5, 6, 7, 11, 12].map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
  })),
  bonuses: [
    { id: 901, name: 'B901', value: 2, territoryIds: [1], bonusIds: [] },
    { id: 907, name: 'B907', value: 3, territoryIds: [4, 11], bonusIds: [] },
    { id: 908, name: 'B908', value: 1, territoryIds: [12], bonusIds: [] },
  ],
  distributionModes: [],
};
const g = buildGraph(map);
const flat = [4, 5, 6, 7].map((turn) => ({ turn, income: 10 }));
const input = (o: { history?: boolean; t11?: number } = {}): PlanInput => ({
  graph: g,
  board: board([mine(1, 60), enemy(2, 25), mine(4, 12), neutral(5, 40), enemy(6, 3, 30), enemy(7, 5), enemy(11, o.t11 ?? 2), neutral(12, 2)]),
  me: ME,
  income: 10,
  settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
  game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 8 },
  turn: 8,
  ...(o.history === false ? {} : { incomeHistory: flat }),
  options: { adapt: true },
});
const why = (p: ReturnType<typeof planTurn>) => p.rationale.join('\n');

describe('#421: a stockpile completes a contested bonus all-in', () => {
  it('B907 is contested: I hold T4, player 20 holds T11 in view beside it', () => {
    const b = input().board;
    const state = new Map(b.territories.map((t) => [t.territoryId, t]));
    expect(contestedBonuses(g, state, new Set([1, 4]), (p) => p !== ME)).toEqual([907]);
    // A missing member out of view is no all-in.
    const fogged = new Map(state);
    fogged.set(11, { territoryId: 11, owner: { kind: 'unknown' }, armies: null });
    expect(contestedBonuses(g, fogged, new Set([1, 4]), (p) => p !== ME)).toEqual([]);
  });

  it('without a history T11 is left alone: an opponent’s member is no bonus step under balanced', () => {
    const p = planTurn(input({ history: false }));
    expect(p.expected.captures).not.toContain(11);
    expect(why(p)).not.toMatch(/Stockpile all-in/);
  });

  it('on the pile T11 is taken, sized for player 20’s deploy, and B907 completes', () => {
    const p = planTurn(input());
    expect(p.expected.captures).toContain(11);
    expect(p.expected.bonusesCompleted).toContain(907);
    const sent = p.moves.filter((m) => m.kind === 'attack' && m.to === 11).reduce((n, m) => n + m.armies, 0);
    expect(sent).toBeGreaterThan(armiesToTake(2, { offensiveKillRate: 60, defensiveKillRate: 70 })!);
    expect(why(p)).toMatch(/Stockpile all-in \(#421\): bonus B907 \(#907\) is contested and my armies stand idle on a flat income, so every missing member is taken this turn/);
    expect(p.bonusPush ?? []).toEqual([]);
  });

  it('a push past the payback horizon × its value is not made, and nothing is dropped', () => {
    // 30 defenders: the push needs far more than the horizon × 3.
    const p = planTurn(input({ t11: 30 }));
    expect(p.expected.captures).not.toContain(11);
    expect(why(p)).not.toMatch(/Stockpile all-in/);
    expect(p.bonusPush ?? []).toEqual([]);
  });
});
