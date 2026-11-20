// #439: a high-value single-territory bonus two moves away through a visible neutral is a two-turn
// completion. The planner plans one turn ahead, so such a bonus (a city, a capital) was never a bonus
// plan — its one member is not next to mine, so no capture reaches it — and the neutral in between
// lost to captures that complete nothing: live, two cities came a turn late (about 17 armies of income).
import { bonusTerritories } from '../bonuses.js';
import { neighborsOf } from '../graph.js';
import type { PlanCtx, PlanState } from './state.js';
import { teammateAt } from './state.js';
import type { Targets } from './targets.js';

/** #439: the least value of a single-territory bonus worth staging toward two moves ahead. */
export const TWO_MOVE_MIN_VALUE = 5;

export interface TwoMoveStage {
  bonusId: number;
  /** The bonus's one territory, two moves from mine. */
  member: number;
  /** The visible neutral next to mine and to `member`, taken this turn. */
  via: number;
  /** Armies over the two turns: the capture of `via` plus that of `member`. */
  cost: number;
  /** Income the two captures add once both land (every bonus they complete, negative ones included). */
  net: number;
}

/**
 * The single-territory bonuses of at least {@link TWO_MOVE_MIN_VALUE} two moves from mine through a
 * visible neutral target, each with its cheapest neutral in between, best income per army first (then
 * bonus id). The bonus territory is a visible neutral, or a fogged one the picking board showed as a
 * neutral (`rememberedNeutrals`, costed at that size); never a player's, a teammate's, a truce's or one
 * whose bonus was dropped. Kept only when the two captures repay their armies within the payback turns.
 */
export function twoMoveStages(pc: PlanCtx, tgt: Pick<Targets, 'targets' | 'fromMine' | 'bonusDropped'>): TwoMoveStage[] {
  const { g, territories: state, mineSet, costAt, completedOver, paybackTurns, opts } = pc;
  const out: TwoMoveStage[] = [];
  for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
    if (b.value < TWO_MOVE_MIN_VALUE || tgt.bonusDropped.has(b.id)) continue;
    const ts = bonusTerritories(g, b.id);
    if (ts.length !== 1) continue;
    const member = ts[0]!;
    if (mineSet.has(member) || tgt.fromMine.get(member) !== 2 || pc.truce.noTarget(member) || teammateAt(pc, member)) continue;
    const st = state.get(member);
    let memberCost: number | null = null;
    if (st?.owner.kind === 'neutral' && st.armies !== null) memberCost = costAt(member);
    else if (!st || st.owner.kind === 'unknown' || st.armies === null) {
      const was = opts.rememberedNeutrals?.get(member);
      if (was !== undefined && st?.owner.kind !== 'player') memberCost = costAt(member, was);
    }
    if (memberCost === null) continue;
    let best: TwoMoveStage | undefined;
    for (const via of [...neighborsOf(g, member)].sort((x, y) => x - y)) {
      const tg = tgt.targets.get(via);
      if (!tg || tg.enemy || state.get(via)?.owner.kind !== 'neutral') continue;
      const cost = tg.cost + memberCost;
      const net = completedOver((x) => mineSet.has(x) || x === via || x === member, [via, member]).reduce(
        (n, id) => n + g.bonusById.get(id)!.value,
        0,
      );
      if (net <= 0 || cost > paybackTurns * net) continue;
      if (!best || cost < best.cost) best = { bonusId: b.id, member, via, cost, net };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.net / b.cost - a.net / a.cost || a.bonusId - b.bonusId);
}

/**
 * #439: take `s.via` toward its bonus (pass 3's capture: R3, rule 4d and the usual sizing), unless this
 * turn's captures already took it or stand next to the bonus territory, or it lowers income. Says so.
 */
export function stageTwoMove(
  pc: PlanCtx,
  ps: PlanState,
  s: TwoMoveStage,
  gainWith: (ts: number[]) => number,
  tryExpand: (t: number, reason: string) => boolean,
): void {
  const { g, label, bonusName } = pc;
  if (ps.captured.has(s.via) || neighborsOf(g, s.member).some((n) => ps.captured.has(n)) || gainWith([s.via]) < 0) return;
  const value = g.bonusById.get(s.bonusId)!.value;
  const worth = s.net === value ? `+${value}` : `+${value}, net +${s.net}`;
  if (!tryExpand(s.via, `stages bonus ${bonusName(s.bonusId)} (${worth}) two moves away (#439)`)) return;
  ps.rationale.push(
    `Stage toward ${bonusName(s.bonusId)} (${worth}), two moves away: ${label(s.via)} now, ${label(s.member)} next turn — ${s.cost} armies over two turns (#439).`,
  );
}
