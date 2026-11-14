// The strikes of planPass, moved to src/analysis/plan/strike.ts (#133): run in order after the capture
// passes are defined, their rationale lines are the next lines of planTurn's, every attack they make goes from
// a territory of mine to one next to it, a struck commander's territory is captured, and the 1v1
// strike stack is chosen only adapting in a 1v1 facing the opponent, on a border of mine.
import { describe, expect, it } from 'vitest';
import { neighborsOf } from '../../src/analysis/graph.js';
import * as planner from '../../src/analysis/planner.js';
import { capturesPhase } from '../../src/analysis/plan/captures.js';
import { noteEstimates, planContext } from '../../src/analysis/plan/estimates.js';
import { holdsPhase } from '../../src/analysis/plan/holds.js';
import { deployBook } from '../../src/analysis/plan/orders.js';
import { newPlanState } from '../../src/analysis/plan/state.js';
import { chooseStrikeStack, strikesPhase } from '../../src/analysis/plan/strike.js';
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

/** The phases up to the strikes, on synthetic board `i` (undefined when I hold nothing). */
function upToStrikes(i: number) {
  const input = syntheticInput(i);
  const ctx = planContext(input);
  const state = newPlanState();
  noteEstimates(ctx, state);
  if (!ctx.mine.length) return undefined;
  const book = deployBook(ctx, state);
  const threats = threatsPhase(ctx, state, input);
  const pass = noPass();
  const hd = holdsPhase(ctx, state, book, threats, pass);
  const tgt = targetsPhase(ctx, state, input, book, threats, hd);
  const caps = capturesPhase(ctx, state, pass, book, threats, hd, tgt);
  return { input, ctx, state, book, threats, pass, hd, tgt, caps };
}

describe('plan/strike (#133)', () => {
  it("strikesPhase's rationale lines follow the capture passes' in planTurn's, in order", () => {
    let checked = 0;
    for (let i = 0; i < 2000; i += 37) {
      const run = upToStrikes(i);
      if (!run) continue;
      const { ctx, state, book, threats, hd, tgt, caps } = run;
      const before = state.rationale.length;
      strikesPhase(ctx, state, book, threats, hd, tgt, caps);
      const plan = planner.planTurn(run.input);
      expect(plan.rationale.slice(0, state.rationale.length)).toEqual(state.rationale);
      // (Not the warnings: a later reconsideration drops a concession's, the reporting extends a border's.)
      checked += state.rationale.length - before;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('every strike attacks a territory next to mine from mine, and a struck commander falls', () => {
    let attacks = 0;
    let kills = 0;
    for (let i = 0; i < 2000; i += 3) {
      const run = upToStrikes(i);
      if (!run) continue;
      const { ctx, state, book, threats, hd, tgt, caps } = run;
      const { struck } = strikesPhase(ctx, state, book, threats, hd, tgt, caps);
      for (const m of state.moves) {
        expect(ctx.mineSet.has(m.from)).toBe(true);
        expect(neighborsOf(ctx.g, m.from)).toContain(m.to);
        attacks++;
      }
      for (const p of struck) {
        const at = [...caps.strikes].filter((t) => {
          const owner = ctx.territories.get(t)?.owner;
          return owner?.kind === 'player' && owner.playerId === p;
        });
        expect(at.length).toBeGreaterThan(0);
        for (const t of at) expect(state.captured.has(t)).toBe(true);
        kills++;
      }
    }
    expect(attacks).toBeGreaterThan(0);
    expect(kills).toBeGreaterThan(0);
  });

  it('the strike stack is a border of mine, chosen only adapting in a 1v1 facing the opponent', () => {
    let stacks = 0;
    for (let i = 0; i < 2000; i += 5) {
      const run = upToStrikes(i);
      if (!run) continue;
      const { ctx, state, book, threats, hd, tgt, caps } = run;
      strikesPhase(ctx, state, book, threats, hd, tgt, caps);
      const open = (id: number) => !hd.conceded.has(id) || hd.mayHold.has(id);
      const stays = (id: number) => state.avail.get(id)! + book.guardAt(id) + (state.incoming.get(id) ?? 0);
      const { stack } = chooseStrikeStack(ctx, state, book, threats, open, stays);
      if (!stack) continue;
      expect(ctx.auto && ctx.profile.format === '1v1' && ctx.goal !== 'defend').toBe(true);
      expect(threats.facing.has(stack.player)).toBe(true);
      expect(ctx.mineSet.has(stack.id)).toBe(true);
      expect(neighborsOf(ctx.g, stack.id).some((n) => ctx.territories.get(n)?.owner.kind === 'player')).toBe(true);
      stacks++;
    }
    expect(stacks).toBeGreaterThan(0);
  });
});
