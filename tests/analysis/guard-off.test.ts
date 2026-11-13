// #165: One Army Must Stand Guard off. A territory left at 0 armies falls to any single army, and
// an enemy territory standing at 0 can be taken by one army — breaking its owner's bonus. Synthetic map.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import { guardOffExposure } from '../../src/analysis/guard-off.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const MATE = 30;

/** 1 ─ 2 ─ 3 ─ 4 ─ 5, plus 6 off 3. Bonus 100 (+3) is 4 and 5. */
const MAP: GameMap = {
  id: 1,
  name: 'Guard',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2] },
    { id: 2, name: 'T2', connectedTo: [1, 3] },
    { id: 3, name: 'T3', connectedTo: [2, 4, 6] },
    { id: 4, name: 'T4', connectedTo: [3, 5] },
    { id: 5, name: 'T5', connectedTo: [4] },
    { id: 6, name: 'T6', connectedTo: [3] },
  ],
  bonuses: [{ id: 100, name: 'B100', value: 3, territoryIds: [4, 5], bonusIds: [] }],
  distributionModes: [],
};
const G = buildGraph(MAP);

describe('guardOffExposure (#165)', () => {
  it('finds my territories the orders leave at 0 beside an enemy or the fog', () => {
    const b = board([mine(1, 4, ME), mine(2, 3, ME), mine(3, 2, ME), mine(4, 2, FOE), mine(5, 0, FOE), fogged(6)]);
    // 3 empties itself into 2 and borders the enemy on 4 and the fog on 6; 1 empties next to nothing hostile.
    const r = guardOffExposure({ graph: G, board: b, me: ME, deploys: [], moves: [{ from: 3, to: 2, armies: 2 }, { from: 1, to: 2, armies: 4 }] });
    expect(r.emptied).toEqual([3]);
  });

  it('counts deploys and transfers in, and a commander that stays is not empty', () => {
    const b = board([mine(1, 0, ME), mine(2, 3, ME), mine(3, 2, ME), mine(4, 2, FOE), mine(5, 0, FOE), neutral(6, 2)]);
    const deployed = guardOffExposure({ graph: G, board: b, me: ME, deploys: [{ territoryId: 3, armies: 1 }], moves: [{ from: 3, to: 2, armies: 2 }] });
    expect(deployed.emptied).toEqual([]);
    const withCommander = board([
      mine(2, 3, ME),
      { ...mine(3, 2, ME), specialUnits: [{ kind: 'commander', id: 'c', playerId: ME }] },
      mine(4, 2, FOE),
    ]);
    expect(guardOffExposure({ graph: G, board: withCommander, me: ME, deploys: [], moves: [{ from: 3, to: 2, armies: 2 }] }).emptied).toEqual([]);
  });

  it('finds an empty enemy territory beside me whose loss breaks its owner\'s bonus, unless already attacked', () => {
    const b = board([mine(3, 5, ME), mine(4, 0, FOE), mine(5, 3, FOE)]);
    const r = guardOffExposure({ graph: G, board: b, me: ME, deploys: [], moves: [] });
    expect(r.breaks).toEqual([{ territoryId: 4, from: 3, playerId: FOE, bonusId: 100, value: 3 }]);
    expect(guardOffExposure({ graph: G, board: b, me: ME, deploys: [], moves: [{ from: 3, to: 4, armies: 1 }] }).breaks).toEqual([]);
  });

  it("a teammate is not an enemy: neither a threat nor a target", () => {
    const b = board([mine(3, 2, ME), mine(2, 3, ME), mine(4, 0, MATE), mine(5, 3, MATE), neutral(6, 0)]);
    const r = guardOffExposure({ graph: G, board: b, me: ME, friends: new Set([MATE]), deploys: [], moves: [{ from: 3, to: 2, armies: 2 }] });
    expect(r).toEqual({ emptied: [], breaks: [] });
  });
});
