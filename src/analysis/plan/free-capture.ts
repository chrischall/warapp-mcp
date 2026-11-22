// #426, the idle-stack warning: a stack of mine that stood idle last turn beside a no-loss neutral (its
// defenders kill none of my attackers) its own movable armies take, and that this plan again leaves standing
// beside it (my commander's stack aside). Live, stacks sat
// beside 0-army neutrals turn after turn while the plan's deploys went elsewhere. Report only: no order
// changes. Runs once every order is planned.
import type { BoardState } from '../../board.js';
import { neighborsOf } from '../graph.js';
import { noLossNeutral } from './after-leftover.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Targets } from './targets.js';
import { byNum } from './util.js';

export function warnIdleBesideFree(pc: PlanCtx, ps: PlanState, tgt: Targets, previousBoard: BoardState | undefined): void {
  if (!previousBoard) return;
  const { g, territories: state, label, mineSet, me, guard, myCommanders } = pc;
  const { captured, moves, warnings } = ps;
  const before = new Map(previousBoard.territories.map((t) => [t.territoryId, t]));
  const mineBefore = (x: number) => {
    const t = before.get(x);
    return t?.owner.kind === 'player' && t.owner.playerId === me ? t : undefined;
  };
  for (const x of [...mineSet].sort(byNum)) {
    // Idle this turn: the plan sends nothing out of it. My commander's stack stays by rule 1k's choice.
    if (myCommanders.has(x) || moves.some((m) => m.from === x)) continue;
    const now = state.get(x)?.armies;
    const was = mineBefore(x)?.armies;
    // It had armies to move last turn and has no fewer now.
    if (now == null || was == null || was - guard < 1 || now < was) continue;
    // Each neutral its own movable armies take (the guard stays), with no deploy.
    const free = neighborsOf(g, x)
      .filter((n) => {
        const cost = tgt.targets.get(n)?.cost;
        return !captured.has(n) && cost !== undefined && cost <= now - guard && noLossNeutral(pc, tgt, n) && before.get(n)?.owner.kind === 'neutral';
      })
      .sort(byNum);
    if (!free.length) continue;
    warnings.push(
      `${label(x)} has stood idle two turns with ${now} armies beside ${free.map(label).join(', ')}, which ${
        free.length === 1 ? 'is a no-loss capture (its defenders kill none of the attackers)' : 'are no-loss captures (their defenders kill none of the attackers)'
      }, and this plan leaves it idle again (#426).`,
    );
  }
}
