// The deploy book and the threats phase of planPass, moved to src/analysis/plan/orders.ts and
// src/analysis/plan/threats.ts (#133): run in order after the estimates, their lines are the next
// lines of planTurn's, and the borders they find are the ones the plan defends.
import { describe, expect, it } from 'vitest';
import * as planner from '../../src/analysis/planner.js';
import { emptyPlan, noteEstimates, planContext } from '../../src/analysis/plan/estimates.js';
import { deployBook } from '../../src/analysis/plan/orders.js';
import { newPlanState } from '../../src/analysis/plan/state.js';
import { threatsPhase } from '../../src/analysis/plan/threats.js';
import { syntheticInput } from './golden/corpus.js';

describe('plan/orders and plan/threats (#133)', () => {
  it("their rationale and warnings follow the estimates' in planTurn's, in order", () => {
    let checked = 0;
    for (let i = 0; i < 2000; i += 37) {
      const input = syntheticInput(i);
      const ctx = planContext(input);
      const state = newPlanState();
      noteEstimates(ctx, state);
      if (!ctx.mine.length) {
        expect(emptyPlan(ctx, state)).toEqual(planner.planTurn(input));
        continue;
      }
      const opening = state.rationale.length + state.warnings.length;
      deployBook(ctx, state);
      expect(state.budget).toBeLessThanOrEqual(ctx.income);
      threatsPhase(ctx, state, input);
      const plan = planner.planTurn(input);
      expect(plan.rationale.slice(0, state.rationale.length)).toEqual(state.rationale);
      expect(plan.warnings.slice(0, state.warnings.length)).toEqual(state.warnings);
      checked += state.rationale.length + state.warnings.length - opening;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('every border it finds is a territory of mine next to an opponent it names', () => {
    let borders = 0;
    for (let i = 0; i < 2000; i += 41) {
      const input = syntheticInput(i);
      const ctx = planContext(input);
      const state = newPlanState();
      noteEstimates(ctx, state);
      if (!ctx.mine.length) continue;
      deployBook(ctx, state);
      const threats = threatsPhase(ctx, state, input);
      for (const [id, b] of threats.borders) {
        expect(b.id).toBe(id);
        expect(ctx.mineSet.has(id)).toBe(true);
        expect(ctx.foe(b.player)).toBe(true);
        expect(b.threat).toBeGreaterThan(0);
        borders++;
      }
    }
    expect(borders).toBeGreaterThan(0);
  });
});
