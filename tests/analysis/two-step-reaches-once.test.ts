// Review of #172: the two-step reaches depend only on the start board, so planTurn computes them
// once however many passes it makes (a refining pass re-made the look-ahead each time, which took
// the 761-territory fixture from ~50 ms to several hundred). A call count, not a wall clock.
// Synthetic map: every id and name is made up.
import { describe, expect, it, vi } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import * as lookahead from '../../src/analysis/lookahead.js';
import { planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

vi.mock('../../src/analysis/lookahead.js', async (original) => {
  const m = await original<typeof import('../../src/analysis/lookahead.js')>();
  return { ...m, twoStepReaches: vi.fn(m.twoStepReaches) };
});

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
//   T3 (enemy) ─ T2 (neutral 8) ─ T1 (+12, 28) ─ T4 (mine 50) ─ T5 (enemy 60)
const map: GameMap = {
  id: 1,
  name: 'TwoSteps',
  territories: [1, 2, 3, 4, 5].map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: ([[1, 2], [2, 3], [1, 4], [4, 5]] as [number, number][])
      .filter(([a, b]) => a === id || b === id)
      .map(([a, b]) => (a === id ? b : a)),
  })),
  bonuses: [{ id: 101, name: 'B101', value: 12, territoryIds: [1], bonusIds: [] }],
  distributionModes: [],
};
const player = (territoryId: number, armies: number) => ({ territoryId, owner: { kind: 'player' as const, playerId: ENEMY }, armies });

describe('planTurn computes the two-step reaches once (#172)', () => {
  /** Calls so far (counted as a difference: each test reads its own). */
  const calls = () => vi.mocked(lookahead.twoStepReaches).mock.calls.length;

  it('once per plan, however many passes a binding hold makes', () => {
    const b = board([mine(1, 28), neutral(2, 8), player(3, 98), mine(4, 50), player(5, 60)]);
    const before = calls();
    const p = planTurn({
      graph: buildGraph(map),
      board: b,
      me: ME,
      income: 40,
      settings: STD,
      game: { players: [{ id: ME }, { id: ENEMY }], turn: 7 },
      options: { goal: 'balanced', enemyDeploy: 5 },
    });
    // The hold binds, so planTurn re-plans (the plan without it, the cut passes).
    expect(p.rationale.join('\n')).toMatch(/can reach it next turn/);
    expect(calls() - before).toBe(1);
  });

  it('a second plan computes its own', () => {
    const b = board([mine(1, 28), neutral(2, 8), player(3, 98), mine(4, 50), player(5, 60)]);
    const run = () => planTurn({ graph: buildGraph(map), board: b, me: ME, income: 40, settings: STD, options: { enemyDeploy: 5 } });
    const before = calls();
    run();
    run();
    expect(calls() - before).toBe(2);
  });
});
