// #275 (pattern 2): a small second line. With the guard off every interior territory may hold 0, so
// once a large stack breaks through a border it walks into whatever lies behind it with one army per
// territory. When a visible enemy stack larger than my income stands two moves from a bonus I hold in
// full, the member it would reach next — one facing no enemy itself (no hold covers it) — keeps
// SECOND_LINE_ARMIES: a token army no longer takes it, and the stack must commit armies to each step.
//
// Conservative by construction: guard off only (and not under No-Split, where an order sends the
// whole stack), paid from the leftover only (after every hold and capture, before rule 5's leftover
// deploy, so expansion is never starved), all second lines together at most SECOND_LINE_SHARE of the
// income, the most valuable bonus first. Armies already standing there count, and whatever the line
// keeps is held back from the later passes through `coverKeep` (rule 6's transfers, the strike stack,
// #218's neutral, #226's margins all respect it).
import { neighborsOf } from '../graph.js';
import { SECOND_LINE_ARMIES, SECOND_LINE_SHARE } from './shared.js';
import type { DeployBook } from './orders.js';
import type { PlanCtx, PlanState } from './state.js';
import { byNum } from './util.js';

export function secondLine(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  open: (id: number) => boolean,
  stays: (id: number) => number,
): void {
  const { g, territories: state, mineSet, foe, guard, noSplit, income, label, bonusName, bonusTs, unitsAt, toTake, deployOf } = pc;
  const { avail, coverKeep, rationale } = ps;
  if (guard || noSplit) return;
  /** A visible enemy stack and what it moves (its commander counted). */
  const stackAt = (x: number): { player: number; armies: number } | undefined => {
    const t = state.get(x);
    if (t?.owner.kind !== 'player' || !foe(t.owner.playerId) || t.armies === null) return undefined;
    return { player: t.owner.playerId, armies: t.armies + unitsAt(x) };
  };
  const facesEnemy = (x: number) =>
    neighborsOf(g, x).some((n) => {
      const o = state.get(n)?.owner;
      return o === undefined || o.kind === 'unknown' || (o.kind === 'player' && foe(o.playerId));
    });
  const big = [...state.keys()].sort(byNum).flatMap((at) => {
    const s = stackAt(at);
    return s && s.armies > income ? [{ at, ...s }] : [];
  });
  if (!big.length) return;
  let room = Math.floor(SECOND_LINE_SHARE * income);
  // The bonuses I hold in full at the start of the turn.
  const held = [...bonusTs.keys()]
    .filter((b) => (g.bonusById.get(b)?.value ?? 0) > 0 && (bonusTs.get(b) ?? []).length > 0 && bonusTs.get(b)!.every((t) => mineSet.has(t)))
    .sort((a, b) => g.bonusById.get(b)!.value - g.bonusById.get(a)!.value || a - b);
  const done = new Set<number>();
  for (const bonus of held) {
    for (const m of [...(bonusTs.get(bonus) ?? [])].sort(byNum)) {
      if (done.has(m) || !mineSet.has(m) || facesEnemy(m)) continue;
      // The biggest stack two moves from it, through a territory between that it can break: not mine,
      // or mine but given up, or falling to the stack with its owner's deploy after this plan (ties by id).
      const breaks = (y: number, s: { armies: number; player: number }) =>
        !mineSet.has(y) || !open(y) || (toTake(stays(y) + unitsAt(y)) ?? Infinity) <= s.armies + deployOf(s.player);
      const via = neighborsOf(g, m)
        .flatMap((y) => big.filter((s) => neighborsOf(g, y).includes(s.at) && breaks(y, s)).map((s) => ({ y, s })))
        .sort((a, b) => b.s.armies - a.s.armies || a.s.at - b.s.at || a.y - b.y)[0];
      if (!via) continue;
      const have = Math.max(0, avail.get(m)!);
      const need = Math.max(0, SECOND_LINE_ARMIES - have);
      const add = Math.min(need, room, ps.budget, book.roomAt(m));
      if (have + add <= 0) continue;
      if (add > 0) {
        book.deploy(m, add);
        room -= add;
      }
      const keep = Math.min(SECOND_LINE_ARMIES, have + add);
      coverKeep.set(m, Math.max(coverKeep.get(m) ?? 0, keep));
      ps.secondLine.set(m, keep);
      done.add(m);
      rationale.push(
        `Second line (#275): ${label(m)} keeps ${keep} ${keep === 1 ? 'army' : 'armies'}${add > 0 ? ` (${add} deployed)` : ''} — bonus ${bonusName(bonus)} (+${g.bonusById.get(bonus)!.value}) is two moves from player ${via.s.player}'s ${via.s.armies}-army stack on ${label(via.s.at)} (through ${label(via.y)}), more than my income of ${income}; with the guard off an empty member falls to a single army once the border breaks.`,
      );
    }
  }
}
