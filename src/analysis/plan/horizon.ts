// #432: in a 1v1 in contact whose gates are already short at the start of the turn, the payback horizon shortens
// the way #201's decided game shortens it. The #297 gate budget sizes every border facing the opponent for his stack
// beside it plus his whole deploy; when what those gates lack together is more than my income, the income cannot
// even refill the gates I have, and a capture that repays only over PAYBACK_TURNS turns is mostly lost before it
// does. Measured on the finished 1v1 histories: of the captures made in contact that repaid at all, almost every one
// did so within 5 turns, and more than half never repaid.
import type { PlanCtx, PlanState } from './state.js';
import type { Threats } from './threats.js';

/** #432: the payback horizon, in turns, of a 1v1 whose gates are short at the start of the turn. */
export const SHORT_GATES_PAYBACK_TURNS = 5;

export interface ShortGates {
  /** The opponent the gates face. */
  player: number;
  /** The gates' summed shortfall at the start of the turn (each gate's need less what stands on it). */
  deficit: number;
  /** The payback horizon the plan counts from here on. */
  turns: number;
}

/**
 * The start-of-turn gate budget (#297's arithmetic on my start-of-turn holdings and armies), and the shorter horizon
 * when it is short: adapting only (as #201), a 1v1 only, in contact, the gates' summed shortfall over my income, and
 * only when that horizon is shorter than the one the plan already counts (a decided game's may be shorter still).
 * `undefined` otherwise.
 */
export function shortGatesHorizon(pc: PlanCtx, threats: Pick<Threats, 'nextTurnAt' | 'holdArmies'>): ShortGates | undefined {
  if (!pc.auto || pc.profile.format !== '1v1' || pc.paybackTurns <= SHORT_GATES_PAYBACK_TURNS) return undefined;
  const ours = (n: number) => pc.mineSet.has(n);
  let deficit = 0;
  let player: number | undefined;
  for (const x of pc.mine) {
    const th = threats.nextTurnAt(x, ours);
    if (!th) continue;
    player ??= th.player;
    deficit += Math.max(0, threats.holdArmies(th.threat) - pc.armiesOf(x) - pc.unitsAt(x));
  }
  if (player === undefined || deficit <= pc.income) return undefined;
  return { player, deficit, turns: SHORT_GATES_PAYBACK_TURNS };
}

/** The rationale line for {@link shortGatesHorizon}'s reading. */
export function shortGatesLine(pc: PlanCtx, s: ShortGates): string {
  return `Gate budget short (#432): in this 1v1 the gates facing player ${s.player} need ${s.deficit} more than stands on them against its one floating deploy, more than my income of ${pc.income}, so every payback test counts ${s.turns} turns instead of ${pc.paybackTurns} (the #201 horizon).`;
}

/**
 * Apply {@link shortGatesHorizon} to the plan: its rationale line, and the shorter horizon every later phase reads
 * from `pc.paybackTurns`. Run right after the threats phase (nothing before it applies a payback test).
 */
export function applyShortGates(pc: PlanCtx, ps: Pick<PlanState, 'rationale'>, threats: Pick<Threats, 'nextTurnAt' | 'holdArmies'>): ShortGates | undefined {
  const sg = shortGatesHorizon(pc, threats);
  if (!sg) return undefined;
  ps.rationale.push(shortGatesLine(pc, sg));
  pc.paybackTurns = sg.turns;
  return sg;
}
