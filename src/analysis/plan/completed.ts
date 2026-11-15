// #265: a member of a bonus this turn's captures complete that faces an enemy and is short of its
// hold once the captures land. Rule 1c (#18) and the #122 garrison keep and garrison such members;
// what neither could fund is the leftover's first call (rule 5, plan/leftover.ts), and a combined
// capture (#17) it is a source of is rebalanced at the same kills to leave armies on it
// (plan/captures.ts, `rebalanceCombined`).
import type { PlanCtx, PlanState } from './state.js';
import type { Threats } from './threats.js';

/** A weak member: the residual threat it faces, the armies it still needs, and its bonus. */
export interface WeakMember {
  threat: number;
  need: number;
  bonusId: number;
}

/**
 * `weakMember(id)`: my open `id` in a positive bonus this turn's captures complete (one I did not
 * hold at the start), next to a visible enemy once the captures land, whose `stays` armies (with
 * its special units) fall to that threat — else `undefined`. `need` is what it still lacks to
 * hold. The bonus named is the most valuable one it completes this turn (ties by id).
 */
export function completedMembers(
  pc: PlanCtx,
  ps: PlanState,
  threats: Threats,
  open: (id: number) => boolean,
  stays: (id: number) => number,
) {
  const { g, mine, mineSet, completedBy, bonusTs, unitsAt, toTake } = pc;
  const before = new Set(completedBy(mineSet));
  const now = completedBy(new Set([...mine, ...ps.captured]))
    .filter((b) => !before.has(b) && (g.bonusById.get(b)?.value ?? 0) > 0)
    .sort((a, b) => g.bonusById.get(b)!.value - g.bonusById.get(a)!.value || a - b);
  const weakMember = (id: number): WeakMember | undefined => {
    if (!now.length || !mineSet.has(id) || !open(id)) return undefined;
    const bonusId = now.find((b) => bonusTs.get(b)?.includes(id));
    if (bonusId === undefined) return undefined;
    const b = threats.borderAt(id, (n) => ps.captured.has(n));
    if (!b) return undefined;
    const at = stays(id) + unitsAt(id);
    let need = 0;
    while ((toTake(at + need) ?? Infinity) <= b.threat) need++;
    return need > 0 ? { threat: b.threat, need, bonusId } : undefined;
  };
  return { weakMember, completedNow: now };
}
