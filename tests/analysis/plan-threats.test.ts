// The deploy book, the threats and the holds of planPass, moved to src/analysis/plan/orders.ts,
// threats.ts and holds.ts (#133): run in order after the estimates, their lines are the next lines
// of planTurn's, the borders they find face an opponent, and the holds only define what planPass runs.
import { describe, expect, it } from 'vitest';
import * as planner from '../../src/analysis/planner.js';
import { emptyPlan, noteEstimates, planContext } from '../../src/analysis/plan/estimates.js';
import { holdsPhase } from '../../src/analysis/plan/holds.js';
import { deployBook } from '../../src/analysis/plan/orders.js';
import { newPlanState } from '../../src/analysis/plan/state.js';
import { threatsPhase } from '../../src/analysis/plan/threats.js';
import { syntheticInput } from './golden/corpus.js';

// These tests loop over hundreds of synthetic boards: v8 coverage (CI runs `npm run test:coverage`)
// slows them about 6x, past vitest's default 5 s.
const SEEDED_LOOP_TIMEOUT = 120_000;

describe('plan/orders and plan/threats (#133)', { timeout: SEEDED_LOOP_TIMEOUT }, () => {
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

describe('plan/holds (#133)', { timeout: SEEDED_LOOP_TIMEOUT }, () => {
  it('defines the holds without deploying, moving or saying anything', () => {
    let defined = 0;
    for (let i = 0; i < 2000; i += 43) {
      const input = syntheticInput(i);
      const ctx = planContext(input);
      const state = newPlanState();
      noteEstimates(ctx, state);
      if (!ctx.mine.length) continue;
      const book = deployBook(ctx, state);
      const threats = threatsPhase(ctx, state, input);
      const before = {
        rationale: [...state.rationale],
        warnings: [...state.warnings],
        budget: state.budget,
        deployed: new Map(state.deployed),
        moves: state.moves.length,
      };
      const pass = {
        cut: new Set<number>(),
        relaxAttacks: false,
        used: false,
        viaHeld: new Map(),
        viaNever: false,
        viaSeen: new Map(),
        viaMixed: false,
        viaFinal: new Map(),
        shared: {},
      };
      const holds = holdsPhase(ctx, state, book, threats, pass);
      expect(state.rationale).toEqual(before.rationale);
      expect(state.warnings).toEqual(before.warnings);
      expect(state.budget).toBe(before.budget);
      expect(state.deployed).toEqual(before.deployed);
      expect(state.moves.length).toBe(before.moves);
      expect(holds.threatened).toEqual([]);
      expect(holds.conceded.size).toBe(0);
      // Nothing conceded or contested yet: the income the plan counts on is the board's.
      expect(holds.keptIncome(ctx.mineSet)).toBe(ctx.incomeAfter(ctx.mineSet));
      defined++;
    }
    expect(defined).toBeGreaterThan(0);
  });
});
