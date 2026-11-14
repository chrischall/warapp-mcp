// #215 review: what a hold counts as withdrawn into a border (rule 1b), and what a worse-order hold
// leaves out. `incoming` also carries a softener's survivors that come home and No-Split extras, so
// only withdrawal transfers count as withdrawn (else survivors read as withdrawn beside an idle
// transfer); and when the opponent moves first, the armies a border sends out by its own orders
// still stand there. Every id here is made up.
import { describe, expect, it } from 'vitest';
import { lateNet, sentOut, withdrawnInto } from '../../src/analysis/plan/holds.js';
import type { PlannedMove } from '../../src/analysis/plan/shared.js';
import { newPlanState, type PlanCtx } from '../../src/analysis/plan/state.js';

const WITHDRAWS = 'withdraws from a conceded border';
const move = (from: number, to: number, armies: number, kind: 'attack' | 'transfer', reason: string): PlannedMove =>
  ({ from, to, armies, kind, reason }) as PlannedMove;
const ctx = (movesFirst?: boolean) => ({ opts: movesFirst === undefined ? {} : { movesFirst } }) as unknown as PlanCtx;

describe('#215 review: withdrawnInto counts only rule 1b withdrawals', () => {
  it('does not read a softener\'s survivors as withdrawn beside an idle transfer', () => {
    const ps = newPlanState();
    ps.moves.push(move(5, 7, 4, 'transfer', 'moves idle interior armies toward the front'));
    ps.incoming.set(7, 3); // survivors of a softener from T7 that come home
    expect(withdrawnInto(ps, 7)).toBe(0);
  });

  it('counts the withdrawal, not the idle transfer or the survivors', () => {
    const ps = newPlanState();
    ps.moves.push(move(9, 7, 2, 'transfer', WITHDRAWS), move(5, 7, 4, 'transfer', 'moves idle interior armies toward the front'));
    ps.incoming.set(7, 2 + 3);
    expect(withdrawnInto(ps, 7)).toBe(2);
  });

  it('never counts more than arrives', () => {
    const ps = newPlanState();
    ps.moves.push(move(9, 7, 6, 'transfer', WITHDRAWS));
    ps.incoming.set(7, 4);
    expect(withdrawnInto(ps, 7)).toBe(4);
  });
});

describe('#215 review: lateNet leaves out the withdrawal less what the border sends out', () => {
  const ps = newPlanState();
  ps.moves.push(move(1, 3, 26, 'transfer', WITHDRAWS), move(3, 4, 2, 'attack', 'completes a bonus'));
  ps.incoming.set(3, 26);
  it('counts the armies its own orders send out', () => {
    expect(sentOut(ps, 3)).toBe(2);
    expect(lateNet(ctx(), ps, 3)).toBe(24);
  });
  it('is 0 when I am known to move first', () => {
    expect(lateNet(ctx(true), ps, 3)).toBe(0);
  });
  it('is 0 when the border sends out more than is withdrawn into it', () => {
    const p2 = newPlanState();
    p2.moves.push(move(9, 7, 2, 'transfer', WITHDRAWS), move(7, 10, 5, 'attack', 'breaks a bonus'));
    p2.incoming.set(7, 2);
    expect(lateNet(ctx(), p2, 7)).toBe(0);
  });
});
