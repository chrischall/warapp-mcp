// The estimates phase of planPass, moved to src/analysis/plan/estimates.ts (#133): its lines open
// every plan, and its public helpers are still reachable from planner.ts.
import { describe, expect, it } from 'vitest';
import * as planner from '../../src/analysis/planner.js';
import * as estimates from '../../src/analysis/plan/estimates.js';
import { newPlanState } from '../../src/analysis/plan/state.js';
import { syntheticInput } from './golden/corpus.js';

describe('plan/estimates (#133)', () => {
  it('planner.ts re-exports the moved helpers unchanged', () => {
    expect(planner.alliesOf).toBe(estimates.alliesOf);
    expect(planner.planEnemyEstimates).toBe(estimates.planEnemyEstimates);
  });

  it("its rationale and warnings are the first lines of planTurn's, in order", () => {
    let checked = 0;
    for (let i = 0; i < 2000; i += 37) {
      const input = syntheticInput(i);
      const state = newPlanState();
      const ctx = estimates.planContext(input);
      estimates.noteEstimates(ctx, state);
      const plan = planner.planTurn(input);
      expect(plan.rationale.slice(0, state.rationale.length)).toEqual(state.rationale);
      expect(plan.warnings.slice(0, state.warnings.length)).toEqual(state.warnings);
      expect(plan.goal).toBe(ctx.goal);
      expect(plan.profile).toEqual(ctx.profile);
      checked += state.rationale.length + state.warnings.length;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('a player with no territory gets the empty plan', () => {
    const input = syntheticInput(0);
    const nobody = { ...input, me: 987654 };
    const state = newPlanState();
    const ctx = estimates.planContext(nobody);
    estimates.noteEstimates(ctx, state);
    expect(ctx.mine).toEqual([]);
    expect(estimates.emptyPlan(ctx, state)).toEqual(planner.planTurn(nobody));
  });
});
