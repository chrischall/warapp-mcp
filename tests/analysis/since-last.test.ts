// #194: a "since last turn" line — this turn's income against the next income the plan of the
// previous turn expected, and the bonuses broken and territories lost since the previous board.
// Synthetic map: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { sinceLastTurn } from '../../src/analysis/since-last.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const enemy = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: ENEMY },
  armies,
});

// 1-2-3 is bonus 100 (+3), 4-5 bonus 200 (+2), 6 alone; a chain 1-2-3-4-5-6.
const MAP: GameMap = {
  id: 1,
  name: 'Since',
  territories: [1, 2, 3, 4, 5, 6].map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: [id - 1, id + 1].filter((n) => n >= 1 && n <= 6),
  })),
  bonuses: [
    { id: 100, name: 'Alpha', value: 3, territoryIds: [1, 2, 3], bonusIds: [] },
    { id: 200, name: 'Beta', value: 2, territoryIds: [4, 5], bonusIds: [] },
    { id: 300, name: 'Gamma', value: -1, territoryIds: [6], bonusIds: [] },
  ],
  distributionModes: [],
};
const graph = buildGraph(MAP);

describe('sinceLastTurn (#194)', () => {
  it('lists the bonuses broken and territories lost, and compares income with the expected', () => {
    const previous = board([mine(1, 3, ME), mine(2, 3, ME), mine(3, 3, ME), mine(4, 2, ME), mine(5, 2, ME), mine(6, 1, ME)]);
    const current = board([mine(1, 3, ME), enemy(2, 4), mine(3, 3, ME), mine(4, 2, ME), neutral(5, 1), fogged(6)]);
    const s = sinceLastTurn({ graph, previous, current, me: ME, income: 5, expected: 10, expectedTurn: 3 });
    // Positive bonuses only: losing the -1 Gamma is no loss.
    expect(s.bonusesBroken).toEqual([
      { bonusId: 100, value: 3 },
      { bonusId: 200, value: 2 },
    ]);
    // A territory now in the fog or neutral counts as lost too; the new owner when it is shown.
    expect(s.territoriesLost).toEqual([
      { territoryId: 2, to: ENEMY },
      { territoryId: 5, to: null },
      { territoryId: 6, to: null },
    ]);
    expect(s.income).toBe(5);
    expect(s.expected).toBe(10);
    expect(s.shortfall).toBe(5);
  });

  it('nothing lost and the income met: empty lists and no shortfall', () => {
    const b = board([mine(1, 3, ME), mine(2, 3, ME), mine(3, 3, ME), neutral(4, 2)]);
    const s = sinceLastTurn({ graph, previous: b, current: b, me: ME, income: 8, expected: 8, expectedTurn: 2 });
    expect(s.bonusesBroken).toEqual([]);
    expect(s.territoriesLost).toEqual([]);
    expect(s.shortfall).toBe(0);
    // Above the expected is no shortfall.
    expect(sinceLastTurn({ graph, previous: b, current: b, me: ME, income: 9, expected: 8, expectedTurn: 2 }).shortfall).toBe(0);
  });

  it('without a previous board it compares income only; without an expected it lists only', () => {
    const b = board([mine(1, 3, ME)]);
    const noBoard = sinceLastTurn({ graph, current: b, me: ME, income: 5, expected: 7, expectedTurn: 4 });
    expect(noBoard.bonusesBroken).toBeUndefined();
    expect(noBoard.territoriesLost).toBeUndefined();
    expect(noBoard.shortfall).toBe(2);
    const noExpected = sinceLastTurn({ graph, previous: b, current: board([enemy(1, 2)]), me: ME, income: 5 });
    expect(noExpected.expected).toBeNull();
    expect(noExpected.shortfall).toBeNull();
    expect(noExpected.territoriesLost).toEqual([{ territoryId: 1, to: ENEMY }]);
  });

  it('a territory not on the map is ignored, and ties come out in ascending id', () => {
    const previous = board([mine(99, 1, ME), mine(3, 1, ME), mine(1, 1, ME)]);
    const current = board([neutral(3, 1), neutral(1, 1)]);
    const s = sinceLastTurn({ graph, previous, current, me: ME, income: 5 });
    expect(s.territoriesLost!.map((t) => t.territoryId)).toEqual([1, 3]);
  });
});
