// #417, the 1v1 race (owner decision of 2026-11-20): while a departed seat's land is still untaken, its
// cheap captures rank ahead of the 1v1 "expansion last" rule (rule 0p.1). Held-bonus gates and my
// commander are still funded first. Synthetic map, made-up ids.
//
//   7 ─ 4 ─ 3 ─ 5 ─ 6        3 mine (30), facing A's 4 (20): a 1v1 in contact once S is out
//            │                5 mine (1), 6 a neutral of 3: B800 (+3) = 5, 6 completes for all 5 of income
//            1 ─ 2            1 mine (1), 2 S's (1 army: costs 2 to take)
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const A = 20;
const S = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, baseIncome: 5 };

const held = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Synthetic 1v1 race',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}

const text = (p: TurnPlan) => p.rationale.join('\n');
const attacksOn = (p: TurnPlan, t: number) => p.moves.filter((m) => m.kind === 'attack' && m.to === t);

const EDGES: [number, number][] = [
  [7, 4],
  [4, 3],
  [3, 5],
  [5, 6],
  [5, 1],
  [1, 2],
];
const g = buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7], EDGES, [[800, 3, [5, 6]]]));
const out = [
  { id: ME, state: 'Playing' },
  { id: A, state: 'Playing' },
  { id: S, state: 'SurrenderAccepted' },
];
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  graph: g,
  board: board([mine(1, 1), held(2, 1, S), mine(3, 30), held(4, 20, A), mine(5, 1), neutral(6, 3), held(7, 5, A)]),
  me: ME,
  income: 5,
  settings: STD,
  turn: 14,
  game: { players: out, turn: 14 },
  options: { adapt: true },
  ...over,
});

describe('the 1v1 race for vacated land (#417)', () => {
  it('takes the seat\'s cheap land before a completion the expansion-last rule would fund first', () => {
    const p = planTurn(input());
    expect(p.profile.format).toBe('1v1');
    expect(attacksOn(p, 2)).toEqual([expect.objectContaining({ from: 1, armies: 2 })]);
    expect(text(p)).toMatch(/1v1 race for vacated land \(#417\): .*T2 \(#2\)/);
  });

  it('without a departed seat the same capture still waits (rule 0p.1 as before)', () => {
    // 2 a plain neutral: no seat left it.
    const p = planTurn(input({ board: board([mine(1, 1), neutral(2, 1), mine(3, 30), held(4, 20, A), mine(5, 1), neutral(6, 3), held(7, 5, A)]) }));
    expect(attacksOn(p, 2)).toEqual([]);
    expect(attacksOn(p, 6)).toEqual([expect.objectContaining({ from: 5 })]);
    expect(text(p)).not.toMatch(/#417/);
  });

  it('a held bonus\'s gate is still funded first', () => {
    // B900 (+5) = 3, 8: held in full; its border 3 faces A's 4 (15), a hold of 4 of the 5 income.
    const gb = buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7, 8], [...EDGES, [3, 8]], [[800, 3, [5, 6]], [900, 5, [3, 8]]]));
    const b = board([mine(1, 1), held(2, 1, S), mine(3, 8), held(4, 15, A), mine(5, 1), neutral(6, 3), held(7, 5, A), mine(8, 1)]);
    const p = planTurn(input({ graph: gb, board: b }));
    expect(p.deploys.find((d) => d.territoryId === 3)?.armies ?? 0).toBeGreaterThanOrEqual(4);
    expect(attacksOn(p, 2)).toEqual([]);
    expect(text(p)).toMatch(/Hold bonus B900 \(#900\) \(\+5\) whole/);
  });

  it('my commander\'s hold is still funded first', () => {
    // My commander on 3 (2 armies + 7) faces A's 4 (12): its worst-case hold takes the whole income.
    const b = board([
      mine(1, 1),
      held(2, 1, S),
      { ...mine(3, 2), specialUnits: [{ kind: 'commander', id: 'c', playerId: ME }] },
      held(4, 12, A),
      mine(5, 1),
      neutral(6, 3),
      held(7, 5, A),
    ]);
    const p = planTurn(input({ board: b, options: { adapt: true, commanderWalks: false } }));
    expect(p.deploys.find((d) => d.territoryId === 3)?.armies).toBe(5);
    expect(attacksOn(p, 2)).toEqual([]);
  });

  it('dearer than VACATED_MAX_COST, the seat\'s land is no race', () => {
    const p = planTurn(input({ board: board([mine(1, 1), held(2, 4, S), mine(3, 30), held(4, 20, A), mine(5, 1), neutral(6, 3), held(7, 5, A)]) }));
    expect(text(p)).not.toMatch(/1v1 race/);
  });

  it('in a free-for-all there is no expansion-last rule to rank ahead of', () => {
    const B = 40;
    const ffa = [...out, { id: B, state: 'Playing' }];
    const gb = buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7, 9], [...EDGES, [7, 9]], [[800, 3, [5, 6]]]));
    const b = board([mine(1, 1), held(2, 1, S), mine(3, 30), held(4, 20, A), mine(5, 1), neutral(6, 3), held(7, 5, A), held(9, 5, B)]);
    const p = planTurn(input({ graph: gb, board: b, game: { players: ffa, turn: 14 } }));
    expect(text(p)).not.toMatch(/1v1 race/);
  });
});
