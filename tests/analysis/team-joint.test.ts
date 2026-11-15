// PLAN-TEAMS C3.6: a joint capture whose outcome depends on whose attack runs first, on the pure report
// (synthetic ids). My 1-army softener must run first: after my teammate's 10 the 1 defender left kills it.
import { describe, expect, it } from 'vitest';
import type { BoardState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { jointCaptures, type TeamPlanView } from '../../src/analysis/plan/team.js';

const ME = 10;
const MATE = 11;
const g = buildGraph({
  id: 1,
  name: 'M',
  territories: [
    { id: 1, name: 'T1', connectedTo: [3] },
    { id: 2, name: 'T2', connectedTo: [3] },
    { id: 3, name: 'T3', connectedTo: [1, 2] },
  ],
  bonuses: [],
  distributionModes: [],
});
const board: BoardState = {
  source: 'gamefeed',
  verified: false,
  territories: [
    { territoryId: 1, owner: { kind: 'player', playerId: ME }, armies: 2 },
    { territoryId: 2, owner: { kind: 'player', playerId: MATE }, armies: 11 },
    { territoryId: 3, owner: { kind: 'player', playerId: 20 }, armies: 7 },
  ],
  teammateOrders: [
    { playerId: MATE, orders: { deploys: [], moves: [{ from: 2, to: 3, armies: 10, mode: 'attack' }], cards: [], discards: [], unread: [] }, picks: null },
  ],
};
const pc = (moveOrder?: string) =>
  ({
    allies: new Set([MATE]),
    territories: new Map(board.territories.map((t) => [t.territoryId, t])),
    g,
    me: ME,
    mineSet: new Set([1]),
    board,
    foe: (p: number) => p === 20,
    myCommanders: new Set<number>(),
    noSplit: false,
    unitsAt: () => 0,
    s: { offensiveKillRate: 60, defensiveKillRate: 70 },
    game: { players: [{ id: ME, team: 0 }, { id: MATE, team: 0 }, { id: 20, team: 1 }], ...(moveOrder ? { moveOrder } : {}) },
    deployOf: () => 5,
    guard: 1,
  }) as unknown as Parameters<typeof jointCaptures>[0];
const view: TeamPlanView = {
  ps: { avail: new Map([[1, 1]]), locked: new Set(), coverKeep: new Map(), centralKeep: new Map(), captured: new Set(), moves: [] },
  threats: { threatAt: () => null, holdArmies: () => 0 },
  hd: { keepFor: () => 0, twoStepKeep: () => 0, conceded: new Set() },
  deploys: [],
} as unknown as TeamPlanView;

describe('C3.6: whose attack must go first', () => {
  it('only my softener first takes it, and a cyclic order says so', () => {
    const [j] = jointCaptures(pc('NoLuckCycle'), view);
    expect(j?.cases).toEqual([
      { first: ME, captured: true, by: MATE, capturedIfReinforced: false },
      { first: MATE, captured: false, by: null, capturedIfReinforced: false },
    ]);
    expect(j?.mustGoFirst).toBe(ME);
  });
  it('without a cyclic order gives both cases only', () => {
    const [j] = jointCaptures(pc(), view);
    expect(j?.cases).toHaveLength(2);
    expect(j).not.toHaveProperty('mustGoFirst');
  });
  it('nothing to report with no idle army of mine beside it', () => {
    expect(jointCaptures(pc(), { ...view, ps: { ...view.ps, avail: new Map([[1, 0]]) } })).toEqual([]);
  });
});
