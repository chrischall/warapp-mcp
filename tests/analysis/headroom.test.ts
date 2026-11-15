// #275 (a): the headroom table — for every border of mine, the smallest single deploy by a
// neighbouring opponent that takes it after my orders, carried out on the turn simulator, and what
// falls with it. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { headroomTable, type HeadroomInput } from '../../src/analysis/headroom.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(n: number, edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
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

const foe = (id: number, armies: number, player = FOE): TerritoryState => mine(id, armies, player);

/** 1 ─ 2 ─ 3 in a line: bonus 100 (+4) is territory 2, bonus 200 (+3) is territory 1, behind it. */
const LINE3 = makeMap(3, [[1, 2], [2, 3]], [[100, 4, [2]], [200, 3, [1]]]);

function table(map: GameMap, entries: TerritoryState[], over: Partial<HeadroomInput> = {}) {
  return headroomTable({ graph: buildGraph(map), board: board(entries), me: ME, deploys: [], moves: [], settings: STD, ...over });
}

describe('headroomTable (#275 a)', () => {
  it('gives the smallest deploy on the neighbouring stack that takes the border, and what falls with it', () => {
    // 10 defenders need 16 attackers; the stack of 3 sends 2 + its deploy: 14.
    const rows = table(LINE3, [mine(1, 1), mine(2, 10), foe(3, 3)]);
    expect(rows).toEqual([
      { territory: 2, armies: 10, opponent: FOE, from: 3, deploy: 14, bonuses: [{ id: 100, value: 4 }], behind: [1], behindIncome: 3 },
    ]);
  });

  it('counts my deploys on the border', () => {
    // 15 defenders need 25 attackers: 2 + 23.
    const [row] = table(LINE3, [mine(1, 1), mine(2, 10), foe(3, 3)], { deploys: [{ territoryId: 2, armies: 5 }] });
    expect(row).toMatchObject({ territory: 2, armies: 15, deploy: 23 });
  });

  it('takes the worse move order when the first mover is unknown, and says which one it needs', () => {
    // A transfer of 8 out of the border: moving first, I leave 2 there, which 3 attackers take.
    const entries = [mine(1, 1), mine(2, 10), foe(3, 3)];
    const moves = [{ from: 2, to: 1, armies: 8 }];
    const [either] = table(LINE3, entries, { moves });
    expect(either).toMatchObject({ territory: 2, armies: 2, deploy: 1, firstMover: 'me' });
    // The opponent known to move first meets all 10.
    const [late] = table(LINE3, entries, { moves, firstMover: 'opponent' });
    expect(late).toMatchObject({ territory: 2, deploy: 14 });
    expect(late!.firstMover).toBeUndefined();
  });

  it('is 0 for a border the stack already takes, and lists the weakest border first', () => {
    const map = makeMap(4, [[1, 2], [2, 3], [3, 4]], []);
    const rows = table(map, [mine(1, 2), foe(2, 9), mine(3, 20), foe(4, 1)]);
    expect(rows.map((r) => [r.territory, r.deploy])).toEqual([
      [1, 0],
      [3, 25],
    ]);
    // The larger stack on 2 needs less than the one on 4: 8 + 25 attackers.
    expect(rows[1]!.from).toBe(2);
  });

  it('leaves out a territory next to the fog alone, and one next to nothing but neutrals', () => {
    const map = makeMap(4, [[1, 2], [2, 3], [3, 4]], []);
    expect(table(map, [neutral(1, 2), mine(2, 5), mine(3, 5), fogged(4)])).toEqual([]);
  });

  it('includes a capture of this turn that ends beside an enemy stack', () => {
    // I take neutral 2 from 1; it then borders the stack on 3.
    const map = makeMap(3, [[1, 2], [2, 3]], []);
    const rows = table(map, [mine(1, 10), neutral(2, 2), foe(3, 2)], { moves: [{ from: 1, to: 2, armies: 9 }] });
    expect(rows.map((r) => r.territory)).toEqual([2]);
    expect(rows[0]!.armies).toBe(9 - 1);
  });
});
