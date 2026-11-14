// The targets and the capture passes of planPass, moved to src/analysis/plan/targets.ts and
// captures.ts (#133): run in order after the holds, their lines are the next lines of planTurn's,
// every target is a territory next to mine, the capture passes only define what planPass runs, and
// a snapshot's restore undoes a capture made since.
import { describe, expect, it } from 'vitest';
import * as planner from '../../src/analysis/planner.js';
import { capturesPhase } from '../../src/analysis/plan/captures.js';
import { noteEstimates, planContext } from '../../src/analysis/plan/estimates.js';
import { holdsPhase } from '../../src/analysis/plan/holds.js';
import { deployBook } from '../../src/analysis/plan/orders.js';
import { newPlanState } from '../../src/analysis/plan/state.js';
import { targetsPhase } from '../../src/analysis/plan/targets.js';
import { threatsPhase } from '../../src/analysis/plan/threats.js';
import { syntheticInput } from './golden/corpus.js';

const noPass = (): planner.TwoStepPass => ({
  cut: new Set<number>(),
  relaxAttacks: false,
  used: false,
  viaHeld: new Map(),
  viaNever: false,
  viaSeen: new Map(),
  viaMixed: false,
  viaFinal: new Map(),
  shared: {},
});

/** The phases up to the capture passes, on synthetic board `i` (undefined when I hold nothing). */
function upToCaptures(i: number) {
  const input = syntheticInput(i);
  const ctx = planContext(input);
  const state = newPlanState();
  noteEstimates(ctx, state);
  if (!ctx.mine.length) return undefined;
  const book = deployBook(ctx, state);
  const threats = threatsPhase(ctx, state, input);
  const pass = noPass();
  const hd = holdsPhase(ctx, state, book, threats, pass);
  const tgt = targetsPhase(ctx, state, input, threats, hd);
  return { input, ctx, state, book, threats, pass, hd, tgt };
}

describe('plan/targets (#133)', () => {
  it("its rationale and warnings follow the threats' in planTurn's, in order", () => {
    let checked = 0;
    for (let i = 0; i < 2000; i += 37) {
      const run = upToCaptures(i);
      if (!run) continue;
      const plan = planner.planTurn(run.input);
      expect(plan.rationale.slice(0, run.state.rationale.length)).toEqual(run.state.rationale);
      expect(plan.warnings.slice(0, run.state.warnings.length)).toEqual(run.state.warnings);
      checked += run.state.rationale.length + run.state.warnings.length;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('every target is a territory not mine, attacked from territories of mine next to it', () => {
    let targets = 0;
    for (let i = 0; i < 2000; i += 41) {
      const run = upToCaptures(i);
      if (!run) continue;
      const { ctx, tgt } = run;
      for (const [id, t] of tgt.targets) {
        expect(t.id).toBe(id);
        expect(ctx.mineSet.has(id)).toBe(false);
        expect(t.sources.length).toBeGreaterThan(0);
        for (const x of t.sources) expect(ctx.mineSet.has(x)).toBe(true);
        expect(t.cost).toBeGreaterThanOrEqual(0);
        targets++;
      }
      // The bonus plans are each a bonus still missing members, in score order.
      for (const p of tgt.plans) expect(p.remaining.length).toBeGreaterThan(0);
    }
    expect(targets).toBeGreaterThan(0);
  });
});

describe('plan/captures (#133)', () => {
  it('defines the capture passes without capturing, moving or deploying anything', () => {
    let defined = 0;
    for (let i = 0; i < 2000; i += 43) {
      const run = upToCaptures(i);
      if (!run) continue;
      const { ctx, state, pass, book, threats, hd, tgt } = run;
      const before = { rationale: state.rationale.length, warnings: [...state.warnings], budget: state.budget };
      capturesPhase(ctx, state, pass, book, threats, hd, tgt);
      // Only the reserve line, when there is a reserve.
      expect(state.rationale.length).toBe(before.rationale + (ctx.reserve ? 1 : 0));
      expect(state.warnings).toEqual(before.warnings);
      expect(state.budget).toBe(before.budget);
      expect(state.moves).toEqual([]);
      expect(state.captured.size).toBe(0);
      expect(state.anchor).toBeUndefined();
      defined++;
    }
    expect(defined).toBeGreaterThan(0);
  });

  it("a snapshot's restore undoes a capture made since", () => {
    let undone = 0;
    for (let i = 0; i < 2000; i += 7) {
      const run = upToCaptures(i);
      if (!run) continue;
      const { ctx, state, pass, book, threats, hd, tgt } = run;
      const caps = capturesPhase(ctx, state, pass, book, threats, hd, tgt);
      const t = [...tgt.targets.values()].filter((x) => !x.enemy).sort((a, b) => a.cost - b.cost || a.id - b.id)[0];
      if (!t) continue;
      const before = {
        rationale: [...state.rationale],
        warnings: [...state.warnings],
        budget: state.budget,
        avail: new Map(state.avail),
        deployed: new Map(state.deployed),
      };
      const restore = caps.snapshot();
      if (!caps.tryCapture(t.id, 'a test capture')) continue;
      expect(state.captured.has(t.id)).toBe(true);
      expect(state.moves.at(-1)).toMatchObject({ to: t.id, kind: 'attack', reason: 'a test capture' });
      restore();
      expect(state.captured.has(t.id)).toBe(false);
      expect(state.moves).toEqual([]);
      expect(state.rationale).toEqual(before.rationale);
      expect(state.warnings).toEqual(before.warnings);
      expect(state.budget).toBe(before.budget);
      expect(state.avail).toEqual(before.avail);
      expect(state.deployed).toEqual(before.deployed);
      undone++;
    }
    expect(undone).toBeGreaterThan(0);
  });
});
