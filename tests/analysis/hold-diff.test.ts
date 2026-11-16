// #275 pattern 3: given orders against the default plan's hold, border by border. A diff against the
// plan, so a hand edit that drains a border the plan holds is named with the difference. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { holdsBelowPlan, type HoldDiffInput } from '../../src/analysis/hold-diff.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const MATE = 30;
const STD = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(n: number, edges: [number, number][]): GameMap {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  return {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: [],
    distributionModes: [],
  };
}

const foe = (id: number, armies: number, player = FOE): TerritoryState => mine(id, armies, player);

/** 1 ─ 2 ─ 3 ─ 4 in a line, 5 beside 1: 2 and 3 are mine, 4 is the enemy's; 1 is interior, 5 neutral. */
const LINE = makeMap(5, [[1, 2], [2, 3], [3, 4], [1, 5]]);
const ENTRIES = [mine(1, 8), mine(2, 3), mine(3, 6), foe(4, 9), neutral(5, 2)];

function diff(over: Partial<HoldDiffInput> = {}) {
  return holdsBelowPlan({
    graph: buildGraph(LINE),
    board: board(ENTRIES),
    me: ME,
    settings: STD,
    plan: { deploys: [{ territoryId: 3, armies: 5 }], moves: [] },
    given: { deploys: [{ territoryId: 3, armies: 5 }], moves: [] },
    ...over,
  });
}

describe('holdsBelowPlan (#275 pattern 3)', () => {
  it('names nothing when the given orders are the plan', () => {
    expect(diff()).toEqual([]);
  });

  it('names a border the given orders leave below the plan, with the difference', () => {
    // The plan stands 11 on 3; the hand edit deploys 2 there and 3 on the interior 1: 8, short 3.
    expect(diff({ given: { deploys: [{ territoryId: 3, armies: 2 }, { territoryId: 1, armies: 3 }], moves: [] } })).toEqual([
      { territory: 3, planLeaves: 11, left: 8, short: 3 },
    ]);
  });

  it('counts the armies an order sends out of the border', () => {
    // A transfer of 7 out of 3 into the interior leaves 4 of the plan's 11; a failed attack's survivors come back.
    expect(diff({ given: { deploys: [{ territoryId: 3, armies: 5 }], moves: [{ from: 3, to: 2, armies: 7 }] } })).toEqual([
      { territory: 3, planLeaves: 11, left: 4, short: 7 },
    ]);
    // 7 into the 9 on 4 kill 5 and lose 6 (60/70): the one survivor returns, 5 stand.
    expect(diff({ given: { deploys: [{ territoryId: 3, armies: 5 }], moves: [{ from: 3, to: 4, armies: 7 }] } })).toEqual([
      { territory: 3, planLeaves: 11, left: 5, short: 6 },
    ]);
  });

  it('never names a border the given orders leave above the plan, nor an interior territory', () => {
    // More on 3, less on the interior 1 (no enemy beside it): nothing.
    expect(diff({ given: { deploys: [{ territoryId: 3, armies: 5 }], moves: [{ from: 1, to: 3, armies: 7 }] } })).toEqual([]);
    expect(diff({ plan: { deploys: [{ territoryId: 1, armies: 5 }], moves: [] }, given: { deploys: [{ territoryId: 3, armies: 5 }], moves: [] } })).toEqual([]);
  });

  it('leaves out a border the plan concedes', () => {
    const given = { deploys: [{ territoryId: 1, armies: 5 }], moves: [] };
    expect(diff({ given })).toEqual([{ territory: 3, planLeaves: 11, left: 6, short: 5 }]);
    expect(diff({ given, conceded: [3] })).toEqual([]);
  });

  it('counts a teammate as no enemy, and my commander as 7', () => {
    const teamBoard = board([mine(1, 8), mine(2, 3), mine(3, 6), foe(4, 9, MATE), neutral(5, 2)]);
    const given = { deploys: [{ territoryId: 1, armies: 5 }], moves: [] };
    expect(diff({ board: teamBoard, teams: new Map([[ME, 1], [MATE, 1]]), given })).toEqual([]);
    // My commander on 3 taken along on an attack out: the plan keeps it there (11 + 7 = 18).
    const withCommander = board([mine(1, 8), mine(2, 3), { ...mine(3, 6), specialUnits: [{ kind: 'commander', id: 'c', playerId: ME }] }, foe(4, 9), neutral(5, 2)]);
    expect(
      diff({ board: withCommander, given: { deploys: [{ territoryId: 3, armies: 5 }], moves: [{ from: 3, to: 2, armies: 1, withCommander: true }] } }),
    ).toEqual([{ territory: 3, planLeaves: 18, left: 10, short: 8 }]);
  });

  it('lists the largest shortfall first, ties by id', () => {
    // 2 and 3 both face the enemy once 2 does: put an enemy beside 2 through a fresh map.
    const map = makeMap(5, [[1, 2], [2, 3], [3, 4], [2, 5]]);
    const entries = [mine(1, 8), mine(2, 3), mine(3, 6), foe(4, 9), foe(5, 4)];
    const out = holdsBelowPlan({
      graph: buildGraph(map),
      board: board(entries),
      me: ME,
      settings: STD,
      plan: { deploys: [{ territoryId: 2, armies: 2 }, { territoryId: 3, armies: 3 }], moves: [] },
      given: { deploys: [{ territoryId: 1, armies: 5 }], moves: [] },
    });
    expect(out).toEqual([
      { territory: 3, planLeaves: 9, left: 6, short: 3 },
      { territory: 2, planLeaves: 5, left: 3, short: 2 },
    ]);
  });

  it('picks borders on the start-of-turn board: one whose enemy the given orders capture is still named', () => {
    // 10 of 3's 11 take the 2 on 4, so 3 is interior once the turn has run; it is named all the same,
    // since the attack may fail against a deploy there and leave 3 to face it with 1.
    const weak = board([mine(1, 8), mine(2, 3), mine(3, 6), foe(4, 2), neutral(5, 2)]);
    expect(diff({ board: weak, given: { deploys: [{ territoryId: 3, armies: 5 }], moves: [{ from: 3, to: 4, armies: 10 }] } })).toEqual([
      { territory: 3, planLeaves: 11, left: 1, short: 10 },
    ]);
  });
});

describe('holdsBelowPlan and static seats (#270)', () => {
  it('names no border beside a static seat only: its territories are neutrals', () => {
    const given = { deploys: [{ territoryId: 3, armies: 2 }, { territoryId: 1, armies: 3 }], moves: [] };
    expect(diff({ given })).toHaveLength(1);
    expect(diff({ given, staticSeats: new Set([FOE]) })).toEqual([]);
  });
});
