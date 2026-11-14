// #215 review: the worse-order step's reserve. For a border that holds only once the armies
// withdrawn into it land (only if I move first), the leftover keeps back what another open border
// needs to hold the opponent's first order. That reserve counted borders that were themselves
// waiting for a worse-order deploy: with two of them, each was skipped for the other, neither got
// a deploy, and the leftover went to the expansion stack while either hold was affordable.
//
// Moving first lands only my first order before the opponent's first (the zigzag then gives it two
// orders before my second), so a border another withdrawal goes into falls whoever moves first
// without its worse-order hold; the border my first order goes into falls only if the opponent
// moves first. The leftover funds the first kind first. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { stressPlan } from '../../src/analysis/stress.js';
import type { GameMap } from '../../src/normalize.js';
import { board as boardOf } from './helpers.js';

const ME = 10;
const FOE = 20;
const RATES: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: false };

// Two copies of first-mover-hold-215's board (ids +100 for the second), same opponent. In each,
// conceded T1 withdraws into T3, which faces player 20's 28-stack and takes the neutral T4.
const EDGES: [number, number][] = [
  [1, 2],
  [1, 3],
  [3, 6],
  [3, 4],
  [4, 5],
  [5, 7],
  [6, 8],
  [2, 8],
  [7, 9],
  [6, 9],
  [7, 10],
  [10, 11],
  [11, 8],
];
const BONUSES: [number, number, number[]][] = [
  [1, 1, [3, 4]],
  [2, 3, [5, 7]],
  [3, 5, [2, 8]],
  [4, 4, [10, 11]],
];
const IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const both = <T>(f: (k: number) => T[]): T[] => [...f(0), ...f(100)];
const edges = both((k) => EDGES.map(([a, b]) => [a + k, b + k] as [number, number]));
const mapWith = (v2: number): GameMap => ({
  id: 1,
  name: 'Synthetic',
  territories: both((k) =>
    IDS.map((i) => {
      const id = i + k;
      return {
        id,
        name: `T${id}`,
        connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
      };
    }),
  ),
  bonuses: both((k) =>
    BONUSES.map(([id, value, ts]) => ({
      id: id + k,
      name: `B${id + k}`,
      value: k && id === 1 ? v2 : value,
      territoryIds: ts.map((t) => t + k),
      bonusIds: [],
    })),
  ),
  distributionModes: [],
});
/** The second copy's T101, T103 and T106, and B101's value (as the first copy by default). */
type Shape = { w2?: number; y2?: number; e2?: number; v2?: number; dep?: number };
const graphs = new Map<number, ReturnType<typeof buildGraph>>();
const graphOf = (v2: number) => graphs.get(v2) ?? graphs.set(v2, buildGraph(mapWith(v2))).get(v2)!;
const at = (territoryId: number, armies: number, who: number | 'neutral'): TerritoryState =>
  who === 'neutral'
    ? { territoryId, owner: { kind: 'neutral' }, armies }
    : { territoryId, owner: { kind: 'player', playerId: who }, armies };
const field = (o: Shape = {}): BoardState =>
  boardOf(
    both((k) => [
      at(1 + k, k ? (o.w2 ?? 27) : 27, ME),
      at(2 + k, 60, FOE),
      at(3 + k, k ? (o.y2 ?? 10) : 10, ME),
      at(4 + k, 1, 'neutral'),
      at(5 + k, 6, ME),
      at(6 + k, k ? (o.e2 ?? 28) : 28, FOE),
      at(7 + k, 10, ME),
      at(8 + k, 4, FOE),
      at(9 + k, 3, ME),
      at(10 + k, 2, FOE),
      at(11 + k, 2, FOE),
    ]),
  );
const input = (income: number, o: Shape = {}): PlanInput => ({
  graph: graphOf(o.v2 ?? 1),
  board: field(o),
  me: ME,
  income,
  settings: RATES,
  game: { players: [{ id: ME }, { id: FOE }], turn: 10 },
  options: { enemyDeploy: o.dep ?? 5 },
});
const deployedOn = (p: TurnPlan, id: number) => p.deploys.filter((d) => d.territoryId === id).reduce((n, d) => n + d.armies, 0);
const lostIf = (p: TurnPlan, firstMover: 'opponent' | 'me', o: Shape = {}) =>
  stressPlan({
    graph: graphOf(o.v2 ?? 1),
    board: field(o),
    me: ME,
    deploys: p.deploys,
    moves: p.moves,
    opponents: [{ id: FOE, deploy: o.dep ?? 5 }],
    settings: RATES,
    firstMover,
    lookAhead: false,
  }).replies.flatMap((r) => r.lost);

describe('#215 review: two borders waiting for a worse-order deploy do not block each other', () => {
  it('withdraws into T3 first, then into T103', () => {
    const p = planTurn(input(26));
    expect(p.moves.slice(0, 2).map((m) => [m.from, m.to])).toEqual([
      [1, 3],
      [101, 103],
    ]);
  });

  // Income 11, 12 and 17 to 27: what the captures leave covers one 11-army hold. Before the fix
  // neither was funded and the leftover went to T7 (at 26, 23 armies there).
  for (const income of [11, 12, 17, 20, 23, 26, 27])
    it(`holds T103 whoever moves first, and T3 if I do, when one hold is affordable (income ${income})`, () => {
      const p = planTurn(input(income));
      expect(deployedOn(p, 103)).toBe(11);
      expect(deployedOn(p, 3)).toBe(0);
      expect(p.rationale.join('\n')).toMatch(/Deploy 11 to T103 \(#103\) so it holds whoever moves first/);
      expect(lostIf(p, 'opponent')).not.toContain(103);
      const meFirst = lostIf(p, 'me');
      expect(meFirst).not.toContain(3);
      expect(meFirst).not.toContain(103);
      // T3 is named, truthfully: the 11 it needs are more than was left after T103.
      expect(p.warnings.join('\n')).toMatch(/T3 \(#3\) holds only if I move first: .* more than the plan had left to deploy there\./);
      expect(p.warnings.join('\n')).not.toMatch(/T103 \(#103\) holds only if I move first/);
    });

  it('funds neither when the captures leave less than one hold (income 14: 8 left)', () => {
    const p = planTurn(input(14));
    expect(deployedOn(p, 3)).toBe(0);
    expect(deployedOn(p, 103)).toBe(0);
    expect(p.rationale.join('\n')).toMatch(/Deploy the leftover 8 to T7 \(#7\)/);
  });

  it('funds both once both are affordable (income 28 or more, as before)', () => {
    const p = planTurn(input(28));
    expect(deployedOn(p, 3)).toBe(11);
    expect(deployedOn(p, 103)).toBe(11);
    for (const who of ['opponent', 'me'] as const) {
      const lost = lostIf(p, who);
      expect(lost).not.toContain(3);
      expect(lost).not.toContain(103);
    }
  });
});

describe('#215 review: a border my second withdrawal goes into is not traded for the one my first goes into', () => {
  // Nearby: T101 8 (withdraws 7 into T103), T103 4 facing player 20's 20-stack (~23 with its deploy
  // of 3), B101 worth +3. T103 falls whoever moves first unless it gets 11 (moving first, the 26
  // into T3 are my first order, and player 20's attack on T103 runs before my second); T3 falls only
  // if player 20 moves first. Keeping only what the later steps give each border back, T3 got 5
  // and T103 the 9 left, and T103 fell under both orders.
  const shape: Shape = { w2: 8, y2: 4, e2: 20, v2: 3, dep: 3 };
  it('holds T103 whoever moves first', () => {
    const p = planTurn(input(20, shape));
    expect(p.moves[0]).toMatchObject({ from: 1, to: 3, armies: 26 });
    expect(deployedOn(p, 103)).toBe(11);
    expect(deployedOn(p, 3)).toBe(0);
    for (const who of ['opponent', 'me'] as const) expect(lostIf(p, who, shape)).not.toContain(103);
    expect(lostIf(p, 'me', shape)).not.toContain(3);
  });
});
