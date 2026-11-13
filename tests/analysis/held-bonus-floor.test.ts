// Issue #118: a held bonus is not conceded and withdrawn from when a few armies would keep
// it. One enemy deploy lands on one target, so sizing every border for the whole of it
// conceded every bonus once the deploy outgrew them. On synthetic maps (every id and name
// here is made up):
//  (a) three held +4 bonuses, one 2-army border each facing an enemy 6-stack, income 17, the
//      opponent deploying 30: each border first beats the armies already next to it (the floor
//      tier), then the rest is spread so the deploy can break a bonus only where it lands.
//  (b) a +4 bonus whose two threatened borders cost 12 each to hold (a third safe), income 35
//      and nothing else to spend it on: both are held (24), nothing conceded or withdrawn.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanOptions, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, string, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Floors',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, name, value, territoryIds]) => ({ id, name, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const enemy = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: ENEMY },
  armies,
});
const deployedTo = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
const deploySum = (p: TurnPlan) => p.deploys.reduce((s, d) => s + d.armies, 0);
const leaving = (p: TurnPlan, id: number) => p.moves.filter((m) => m.from === id).reduce((s, m) => s + m.armies, 0);

// ---- (a) three held +4 bonuses, one border each ----
//   A (+4): 1 2   B (+4): 3 4   C (+4): 5 6 — mine; 1, 3, 5 (2 armies) face enemy 6-stacks on
//   11, 13, 15; 2, 4, 6 are interior (1 army each), chained 2-4-6.
const MAP_A = makeMap(
  [1, 2, 3, 4, 5, 6, 11, 13, 15],
  [
    [1, 2], [3, 4], [5, 6], [2, 4], [4, 6],
    [1, 11], [3, 13], [5, 15], [11, 13], [13, 15],
  ],
  [
    [601, 'Alder', 4, [1, 2]],
    [602, 'Birch', 4, [3, 4]],
    [603, 'Cedar', 4, [5, 6]],
  ],
);
const gA = buildGraph(MAP_A);
const BOARD_A = board([
  mine(1, 2), mine(2, 1), mine(3, 2), mine(4, 1), mine(5, 2), mine(6, 1),
  enemy(11, 6), enemy(13, 6), enemy(15, 6),
]);
const planA = (options: PlanOptions = {}) =>
  planTurn({ graph: gA, board: BOARD_A, me: ME, income: 17, settings: STD, options: { enemyDeploy: 30, ...options } });

describe('#118 (a): three held bonuses facing one big deploy', () => {
  for (const goal of ['balanced', 'defend'] as const) {
    describe(`goal ${goal}`, () => {
      const plan = planA({ goal });
      it('concedes none of them', () => {
        expect(plan.conceded).toEqual([]);
      });
      it('withdraws nothing from their borders', () => {
        for (const b of [1, 3, 5]) expect(leaving(plan, b)).toBe(0);
      });
      it('makes every border beat the armies already next to it (the floor tier)', () => {
        // 5 movable armies on each enemy stack: a border holds them off when they cannot take it.
        for (const b of [1, 3, 5]) expect(armiesToTake(2 + deployedTo(plan, b), STD)!).toBeGreaterThan(5);
      });
      it('spreads the rest across the borders against the one shared deploy', () => {
        expect(deploySum(plan)).toBe(17);
        const ds = [1, 3, 5].map((b) => deployedTo(plan, b));
        expect(Math.min(...ds)).toBeGreaterThanOrEqual(5);
        expect(Math.max(...ds) - Math.min(...ds)).toBeLessThanOrEqual(1);
      });
      it('says the deploy can break a bonus only where it lands', () => {
        expect(plan.rationale.join('\n')).toMatch(/floor/i);
        expect(plan.warnings.join('\n')).toMatch(/only where it lands/);
      });
    });
  }
});

describe('#118 (a), income 36: spread, not one whole hold, when that loses less to the best response', () => {
  // Floors take 6. Holding one bonus whole (18 more) leaves 6 each for the others (10 armies,
  // 11 of the deploy take each: the 30 breaks both). Spreading the 30 leaves 14 on each (18 of
  // the deploy take one: the 30 breaks only one).
  const plan = planTurn({ graph: gA, board: BOARD_A, me: ME, income: 36, settings: STD, options: { enemyDeploy: 30 } });
  it('deploys 12 on each border', () => {
    expect([1, 3, 5].map((b) => deployedTo(plan, b))).toEqual([12, 12, 12]);
    expect(plan.conceded).toEqual([]);
  });
  it('says why', () => {
    expect(plan.rationale.join('\n')).toMatch(/Spread what is left over the floored bonuses' borders rather than hold one whole/);
  });
  it('still holds every bonus whole when the income covers them all', () => {
    const rich = planTurn({ graph: gA, board: BOARD_A, me: ME, income: 60, settings: STD, options: { enemyDeploy: 30 } });
    expect([1, 3, 5].map((b) => deployedTo(rich, b))).toEqual([20, 20, 20]);
    expect(rich.warnings.join('\n')).not.toMatch(/not safe against the whole enemy deploy/);
  });
});

// ---- (b) two dear borders of one +4, nothing else to buy ----
//   Delta (+4): 1 2 3 4 — mine; 1 and 2 (2 armies) face enemy 12-stacks on 11, 12; 3 (20 armies)
//   faces an enemy 2 on 13 and is safe; 4 is interior. The enemy deploys 10: each of 1 and 2
//   needs 12 to hold (14 armies, 23 to take, against 11 + 10 = 21).
const MAP_B = makeMap(
  [1, 2, 3, 4, 11, 12, 13],
  [
    [1, 2], [2, 3], [3, 4], [1, 4],
    [1, 11], [2, 12], [3, 13], [11, 12], [12, 13],
  ],
  [[611, 'Delta', 4, [1, 2, 3, 4]]],
);
const gB = buildGraph(MAP_B);
const BOARD_B = board([mine(1, 2), mine(2, 2), mine(3, 20), mine(4, 1), enemy(11, 12), enemy(12, 12), enemy(13, 2)]);
const planB = (options: PlanOptions = {}, extra: TerritoryState[] = []) =>
  planTurn({
    graph: gB,
    board: { ...BOARD_B, territories: [...BOARD_B.territories, ...extra] },
    me: ME,
    income: 35,
    settings: STD,
    options: { enemyDeploy: 10, ...options },
  });

describe('#118 (b): a dear hold with nothing better to buy', () => {
  for (const goal of ['balanced', 'defend'] as const) {
    describe(`goal ${goal}`, () => {
      const plan = planB({ goal });
      it('holds both borders in full (24; the leftover may add comfort) and concedes nothing', () => {
        expect(deployedTo(plan, 1)).toBeGreaterThanOrEqual(12);
        expect(deployedTo(plan, 2)).toBeGreaterThanOrEqual(12);
        expect(plan.rationale.join('\n')).toMatch(/Hold bonus Delta \(#611\) \(\+4\) whole: past its floor/);
        expect(plan.conceded).toEqual([]);
      });
      it('withdraws nothing', () => {
        expect(leaving(plan, 1)).toBe(0);
        expect(leaving(plan, 2)).toBe(0);
      });
    });
  }
  it('still makes the floor before a capture when the armies have a better use', () => {
    // A cheap neutral +5 next to the interior: the capture goes first, but each border still
    // beats the 11 armies next to it.
    const map = makeMap(
      [1, 2, 3, 4, 11, 12, 13, 21],
      [
        [1, 2], [2, 3], [3, 4], [1, 4],
        [1, 11], [2, 12], [3, 13], [11, 12], [12, 13], [4, 21],
      ],
      [[611, 'Delta', 4, [1, 2, 3, 4]], [612, 'Echo', 5, [21]]],
    );
    const plan = planTurn({
      graph: buildGraph(map),
      board: board([...BOARD_B.territories, neutral(21, 2)]),
      me: ME,
      income: 14,
      settings: STD,
      options: { enemyDeploy: 10 },
    });
    for (const b of [1, 2]) {
      expect(leaving(plan, b)).toBe(0);
      expect(armiesToTake(2 + deployedTo(plan, b), STD)!).toBeGreaterThan(11);
    }
    expect(plan.conceded).toEqual([]);
  });
});

// ---- (c) withdrawing from a conceded border of a held bonus ----
//   Hill (+3): 1 2 — mine; T1 (10) faces player 20's 60-stack on 5: hopeless. T2 is interior.
//   Kiln (+4): 3 — mine, next to T1; it faces player 30's 9 on 4 and is short of holding.
const OTHER = 30;
const MAP_C = makeMap(
  [1, 2, 3, 4, 5],
  [[1, 2], [1, 3], [1, 5], [3, 4]],
  [[621, 'Hill', 3, [1, 2]], [622, 'Kiln', 4, [3]]],
);
const gC = buildGraph(MAP_C);
const boardC = (kiln: number) =>
  board([
    mine(1, 10), mine(2, 1), mine(3, kiln),
    { territoryId: 4, owner: { kind: 'player', playerId: OTHER }, armies: 9 },
    enemy(5, 60),
  ]);
const planC = (kiln: number) =>
  planTurn({ graph: gC, board: boardC(kiln), me: ME, income: 5, settings: STD, options: { enemyDeploy: 5 } });

describe('#118 (c): a conceded border of a held bonus keeps its garrison unless it makes another hold', () => {
  it('keeps the garrison when withdrawing it would make no valued border hold', () => {
    // Kiln is safe on its own (20 armies): moving T1's 9 there changes nothing this turn.
    const p = planC(20);
    expect(p.conceded).toContain(1);
    expect(leaving(p, 1)).toBe(0);
    expect(p.rationale.join('\n')).toMatch(/Keep the 9 movable armies on T1 \(#1\) \(not withdrawn\): it is a border of held bonus Hill/);
  });
  it('withdraws when the armies make another valued border hold this turn', () => {
    // Kiln (2) needs 7 against 8 + ~5: the 5 income leave it 2 short; T1's 9 make it hold.
    const p = planC(2);
    expect(p.conceded).toContain(1);
    expect(p.moves).toContainEqual(expect.objectContaining({ from: 1, to: 3, armies: 9, kind: 'transfer' }));
  });
});
