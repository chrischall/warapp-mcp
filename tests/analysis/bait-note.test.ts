// #593 5c: the "Not attacking" line names what the owner's stacks beside a cheap-looking enemy
// territory can move in before an attack lands (the bait the rematch's small attacks walked into).
// Made-up map. Kill rates 60/70, no luck: armiesToTake(24) = 40.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

/** 1 (mine) ─ 2 (its 1) ─ 3 (its stack); 4, mine, behind 1, beside 5, a neutral 2 the plan takes instead. */
const MAP: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2, 4] },
    { id: 2, name: 'T2', connectedTo: [1, 3] },
    { id: 3, name: 'T3', connectedTo: [2] },
    { id: 4, name: 'T4', connectedTo: [1, 5] },
    { id: 5, name: 'T5', connectedTo: [4] },
  ],
  bonuses: [],
  distributionModes: [],
};

const plan = (stack: number) =>
  planTurn({
    graph: buildGraph(MAP),
    board: board([mine(1, 10), mine(2, 1, ENEMY), mine(3, stack, ENEMY), mine(4, 4), neutral(5, 2)]),
    me: ME,
    income: 5,
    settings: STD,
    game: { players: [{ id: ME }, { id: ENEMY }] },
  });
const notAttacking = (p: ReturnType<typeof plan>) => p.rationale.find((l) => l.startsWith('Not attacking')) ?? '';

describe('the Not attacking line names the stacks that can move in first (#593 5c)', () => {
  it('a 1-army territory beside its 24: 23 can move in, 40 to take then', () => {
    const line = notAttacking(plan(24));
    expect(line).toMatch(/T2 \(#2\) \(player 20, 1 armies\)/);
    expect(line).toMatch(/its stacks beside it can move 23 in before an attack lands \(T3 \(#3\) 23\): 40 to take it then \(#593\)/);
  });

  it('says nothing of it when no stack beside it can move', () => {
    expect(notAttacking(plan(1))).not.toMatch(/can move .* in before an attack lands/);
  });
});
