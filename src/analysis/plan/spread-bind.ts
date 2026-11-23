// #416 part 4 (owner 2026-11-22): while #319 fires, pass-3 plain expansion and advances into other bonuses may
// not spend deploys, or armies on a territory beside the nearest bonus's missing members, until that bonus's
// reachable steps are funded. Holds keep their places.
//
// - The nearest bonus is the one #319's warning names (rule 4f's order: `Targets.spreadNearest`).
// - Its reachable steps are its missing members a capture can reach this turn: capture targets beside a
//   territory of mine (rule 4f's first layer). "Funded" means captured by this plan; once every one is, the
//   bind lifts and the rest flows as before. A step refused for another reason (rule 4d, R3, income) keeps
//   the bind for the turn: the leftover saves toward it instead.
// - A stack beside the missing members of the nearest bonus and of another is the nearest bonus's.
// - Bound: advances into another bonus (pass 2, the `balanced` greedy's advance slots, #439's two-move
//   stage), pass 3 and rule 5b's leftover expansion (pass 3's order, paid by the leftover); the bonus's own
//   members never are. Not bound: completions of any bonus, focused bonuses, holds, breaks, counters, the
//   1v1 race, strikes, rule 4e's fallback, the card-piece capture and the army cap's spend.
// - What is bound may still attack from my other territories with the armies standing there.
import { neighborsOf } from '../graph.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Targets } from './targets.js';

export interface SpreadBind {
  /** The nearest bonus #319 names. */
  bonusId: number;
  /** Whether its reachable steps are not all funded yet. */
  open: () => boolean;
  /** Run `f` under the bind (no deploys, no armies beside the bonus's missing members) unless `exempt` or funded. */
  bound: <T>(exempt: boolean, f: () => T) => T;
}

export function spreadBind(
  pc: Pick<PlanCtx, 'g' | 'mine' | 'mineSet' | 'reserve' | 'label' | 'bonusName' | 'bonusTs'>,
  ps: Pick<PlanState, 'budget' | 'captured' | 'rationale' | 'bind'>,
  tgt: Pick<Targets, 'spreadNearest' | 'targets'>,
): SpreadBind | undefined {
  const p = tgt.spreadNearest;
  if (!p) return undefined;
  const { g, mine, mineSet, reserve, label, bonusName, bonusTs } = pc;
  const steps = p.remaining.filter((t) => tgt.targets.has(t) && neighborsOf(g, t).some((x) => mineSet.has(x))).sort((a, b) => a - b);
  if (!steps.length) return undefined;
  const missing = new Set(p.remaining);
  const members = new Set(bonusTs.get(p.bonusId) ?? p.remaining);
  const beside = new Set(mine.filter((x) => neighborsOf(g, x).some((t) => missing.has(t))));
  const open = () => steps.some((t) => !ps.captured.has(t));
  const line =
    `#319 binds the deploys (#416): until ${bonusName(p.bonusId)}'s reachable step${steps.length === 1 ? '' : 's'} ` +
    `(${steps.map(label).join(', ')}) ${steps.length === 1 ? 'is' : 'are'} taken, plain expansion and advances into other bonuses ` +
    `spend no deploys and no armies on ${[...beside].sort((a, b) => a - b).map(label).join(', ')}.`;
  const bound = <T>(exempt: boolean, f: () => T): T => {
    if (exempt || ps.bind || !open()) return f();
    if (!ps.rationale.includes(line)) ps.rationale.push(line);
    const withheld = Math.max(0, ps.budget - reserve);
    ps.budget -= withheld;
    ps.bind = { from: beside, members };
    try {
      return f();
    } finally {
      ps.budget += withheld;
      ps.bind = undefined;
    }
  };
  return { bonusId: p.bonusId, open, bound };
}
