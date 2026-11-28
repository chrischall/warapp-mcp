// #275 (a): the headroom table — for every border of mine, the smallest single deploy by a
// neighbouring opponent that takes it after my orders, carried out on the turn simulator, and what
// falls with it. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { HEADROOM_CAP, headroomTable, smallest, type HeadroomInput } from '../../src/analysis/headroom.js';
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
      { territory: 2, armies: 10, opponent: FOE, from: 3, deploy: 14, bonuses: [{ id: 100, value: 4 }], behind: [1], behindIncome: 3, breach: { territories: [1], income: 3 } },
    ]);
  });

  it('lands my Airlifts on the border before the moves (#618)', () => {
    // 1 interior with 6, 2 the border with 1: airlifting 5 from 1 makes it 6 before the attack.
    const entries = [mine(1, 6), mine(2, 1), foe(3, 3)];
    const [bare] = table(LINE3, entries);
    const [lifted] = table(LINE3, entries, { airlifts: [{ from: 1, to: 2, armies: 5 }] });
    expect(bare).toMatchObject({ territory: 2, armies: 1 });
    // 6 defenders need 10 attackers: 2 + 8.
    expect(lifted).toMatchObject({ territory: 2, armies: 6, deploy: 8 });
  });

  it('counts my deploys on the border', () => {
    // 15 defenders need 25 attackers: 2 + 23.
    const [row] = table(LINE3, [mine(1, 1), mine(2, 10), foe(3, 3)], { deploys: [{ territoryId: 2, armies: 5 }] });
    expect(row).toMatchObject({ territory: 2, armies: 15, deploy: 23 });
  });

  it('takes the worse move order when the first mover is unknown, and says which one it needs', () => {
    // A transfer of 9 into the border from 1: moving first, I land it before the attack; the
    // opponent moving first takes the 2 there before it lands, and must then hold against my 9, which
    // now attack: 7 attackers (a deploy of 5) leave 6, which 9 cannot take.
    const entries = [mine(1, 10), mine(2, 2), foe(3, 3)];
    const moves = [{ from: 1, to: 2, armies: 9 }];
    const [either] = table(LINE3, entries, { moves });
    expect(either).toMatchObject({ territory: 2, armies: 11, deploy: 5, firstMover: 'opponent' });
    // Known to move first, I meet it with 11, which need 18 attackers: 2 + 16.
    const [early] = table(LINE3, entries, { moves, firstMover: 'me' });
    expect(early).toMatchObject({ territory: 2, deploy: 16 });
    expect(early!.firstMover).toBeUndefined();
  });

  it('lets the opponent attack after my orders that drain the border, whoever moves first', () => {
    // A transfer of 8 out of the border leaves 2, which 3 attackers take: an opponent moving first
    // delays its attack behind a filler order rather than meet all 10.
    const entries = [mine(1, 1), mine(2, 10), foe(3, 3)];
    const moves = [{ from: 2, to: 1, armies: 8 }];
    for (const firstMover of [undefined, 'opponent', 'me'] as const) {
      const [row] = table(LINE3, entries, { moves, ...(firstMover ? { firstMover } : {}) });
      expect(row).toMatchObject({ territory: 2, armies: 2, deploy: 1 });
      expect(row!.firstMover).toBeUndefined();
    }
  });

  it('finds the drain when it is my second order', () => {
    // 1 ─ 2 ─ 3 ─ 4, 2 ─ 5, 1 ─ 6: I take neutral 6 from 1, then empty 2 into neutral 5. The stack
    // of 3 attacks the 1 left on 2 after both, with no deploy.
    const map = makeMap(6, [[1, 2], [2, 3], [3, 4], [2, 5], [1, 6]], []);
    const entries = [mine(1, 10), mine(2, 20), foe(3, 3), foe(4, 3), neutral(5, 2), neutral(6, 2)];
    const moves = [
      { from: 1, to: 6, armies: 9 },
      { from: 2, to: 5, armies: 19 },
    ];
    for (const firstMover of [undefined, 'opponent', 'me'] as const) {
      const rows = table(map, entries, { moves, ...(firstMover ? { firstMover } : {}) });
      expect(rows.find((r) => r.territory === 2)).toMatchObject({ armies: 1, deploy: 0, from: 3 });
    }
  });

  it('searches no further than the cap', () => {
    expect(smallest((d) => d >= HEADROOM_CAP, HEADROOM_CAP - 3)).toBe(HEADROOM_CAP);
    const asked: number[] = [];
    expect(
      smallest((d) => {
        asked.push(d);
        return false;
      }, HEADROOM_CAP - 3),
    ).toBeNull();
    expect(Math.max(...asked)).toBe(HEADROOM_CAP);
    expect(smallest(() => false, HEADROOM_CAP)).toBeNull();
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

describe('headroomTable and static seats (#270)', () => {
  it('gives a static seat no row: its territories are neutrals, as the planner reads them', () => {
    const entries = [mine(1, 1), mine(2, 10), foe(3, 3)];
    expect(table(LINE3, entries)).toHaveLength(1);
    expect(table(LINE3, entries, { staticSeats: new Map([[FOE, 'SurrenderAccepted']]) })).toEqual([]);
  });
});
