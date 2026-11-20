// #420 (step: holds sized only on a prior never outrank captures). A border that holds against the
// stacks beside it plus what the evidence says its opponent deploys (visible bonuses, an observed
// deploy) needs a hold only because of the fog prior (#119): such a hold ranks after every capture in
// rule 4a's greedy step, so a guess no longer outbids a completion. A hold the evidence needs keeps
// its rank.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const foe = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: FOE }, armies });

// My T1 (10 armies) faces the opponent's T4 beside the fog (T5, T6: a +10 it could hold). Behind T1,
// T2–T3 and T9; T7 (neutral, 5) completes my +4 B901 for all 8 of my income. The opponent's visible
// income is 5; the 1v1 started even, so the fog prior puts it at my 8.
const g = buildGraph(
  makeMap(
    [1, 2, 3, 4, 5, 6, 7, 9],
    [[1, 2], [2, 3], [3, 7], [1, 4], [4, 5], [5, 6], [2, 9]],
    [[901, 4, [2, 3, 7]], [902, 10, [5, 6]], [903, 3, [9]]],
  ),
);
const input = (foeArmies: number, symmetricStart = true): PlanInput => ({
  graph: g,
  board: board([mine(1, 10), mine(2, 1), mine(3, 1), mine(9, 1), neutral(7, 5), foe(4, foeArmies), fogged(5), fogged(6)]),
  me: ME,
  income: 8,
  settings: STD,
  turn: 12,
  game: { players: [{ id: ME }, { id: FOE }], turn: 12, symmetricStart },
});

describe('#420: a hold sized only on the fog prior never outranks a capture', () => {
  it('T1 holds against 9 movable + the visible 5: the completion goes first, the prior-only hold after it', () => {
    const p = planTurn(input(10));
    expect(p.enemyDeploy).toBe(8);
    expect(p.expected.captures).toEqual([7]);
    expect(p.expected.bonusesCompleted).toEqual([901]);
    expect(p.expected.nextIncome).toBe(12);
    expect(p.rationale.some((r) => r.includes('(#420)') && r.includes('T1 (#1)'))).toBe(true);
  });

  it('the same board without the prior (no even start) plans the same capture', () => {
    const p = planTurn(input(10, false));
    expect(p.expected.captures).toEqual([7]);
    expect(p.rationale.some((r) => r.includes('(#420)'))).toBe(false);
  });

  it('a hold the evidence needs (11 movable + the visible 5 take T1) keeps its rank before the capture', () => {
    const p = planTurn(input(12));
    expect(p.expected.captures).toEqual([]);
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 8 }]);
    expect(p.rationale.some((r) => r.includes('(#420)'))).toBe(false);
  });
});
