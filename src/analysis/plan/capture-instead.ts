// #285: capture the one enemy stack a held bonus's borders face, rather than hold them against it.
// Rule 1h holds a contested held bonus whole from what the captures leave (#118). Live, two borders
// that faced only one enemy stack were held against it and its owner's deploy (41 deployed on one
// of them), while capturing the stack would have left both borders interior. Owner decisions of
// 2026-11-19: the capture is sized against the same deploy estimate the holds are sized against
// (#368's middle figure, through `reinforcementAt`: rule 3's #120 sizing, so it lands even if the
// owner deploys there first), and the hold it saves is credited for HOLD_CREDIT_TURNS turns, since
// a border that stops being one needs no hold on the turns after this one either.
// So, once the capture passes have run and before `settleContested` holds the contested units: for
// each enemy territory S beside a contested member still unheld, the members that border no enemy,
// fog or hidden territory but S (and face no threat once S falls) are its interior set. When the
// deploy that captures S from one of them (the one needing the least; it keeps what it still must
// hold, #172's two-step keep included) is at most HOLD_CREDIT_TURNS × the hold costs of that set,
// and the turn can fund it, S is captured from there and the set is held: rule 1h no longer deploys
// to it. Largest saving first, then id; repeated while one is taken. Not under No-Split (an order
// carries the whole stack), never from my commander's territory, never a truce's covered territory,
// a buffer left standing (#179), a territory with a special unit or one whose capture lowers income.
import { neighborsOf } from '../graph.js';
import type { Captures } from './captures.js';
import type { Holds, Threatened } from './holds.js';
import type { DeployBook } from './orders.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Targets } from './targets.js';
import type { Threats } from './threats.js';
import { byNum } from './util.js';

/** #285 (owner decision of 2026-11-19): the turns a hold made unnecessary by a capture is credited for. */
export const HOLD_CREDIT_TURNS = 3;

export function captureInsteadOfHold(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hd: Holds,
  tgt: Targets,
  caps: Captures,
): void {
  const { g, foe, territories: state, label, mineSet, unitsAt, uncounted, defenceAt, costAt, myCommanders, noSplit } = pc;
  const { avail, captured, spared, rationale } = ps;
  const { units, heldBorders, conceded, keepFor, twoStepKeep } = hd;
  const { borderAt, reinforcementAt } = threats;
  const { targets } = tgt;
  const { gainWith, spareAt, orderOf } = book;
  if (noSplit) return;
  const tried = new Set<number>();
  for (;;) {
    const members = [
      ...new Set(
        units
          .filter((u) => u.contested && !u.conceded)
          .flatMap((u) => u.members.filter((m) => !heldBorders.has(m.id) && !conceded.has(m.id) && m.holdCost > 0)),
      ),
    ].sort((a, b) => a.id - b.id);
    if (!members.length) return;
    const foeOf = (n: number) => {
      const o = state.get(n)?.owner;
      return o?.kind === 'player' && foe(o.playerId) ? o.playerId : undefined;
    };
    /** Every neighbour of `x` but `s` is mine, captured, a neutral in view or a teammate's: no frontier left. */
    const closedBut = (x: number, s: number) =>
      neighborsOf(g, x).every((y) => {
        if (y === s || mineSet.has(y) || captured.has(y)) return true;
        const st = state.get(y);
        if (!st || st.armies === null) return false;
        return st.owner.kind === 'neutral' || (st.owner.kind === 'player' && !foe(st.owner.playerId));
      });
    type Cand = { s: number; src: number; keep: number; need: number; cost: number; d: number; extra: number; set: Threatened[]; credit: number };
    let best: Cand | undefined;
    const seen = [...new Set(members.flatMap((m) => neighborsOf(g, m.id)))].sort(byNum);
    for (const s of seen) {
      const player = foeOf(s);
      const st = state.get(s);
      if (player === undefined || !st || st.armies === null) continue;
      if (tried.has(s) || captured.has(s) || spared.has(s) || pc.truce.noTarget(s) || uncounted(s) || unitsAt(s) > 0) continue;
      const gone = (n: number) => n === s;
      const set = members.filter(
        (m) => neighborsOf(g, m.id).includes(s) && closedBut(m.id, s) && !borderAt(m.id, (n) => captured.has(n) || gone(n)),
      );
      if (!set.length || gainWith([s]) < 0) continue;
      const d = defenceAt(s);
      const extra = reinforcementAt(s);
      const cost = costAt(s, d + extra);
      if (cost === null) continue;
      const credit = HOLD_CREDIT_TURNS * set.reduce((n, m) => n + m.holdCost, 0);
      const src = set
        .filter((m) => !myCommanders.has(m.id) && !orderOf(m.id))
        .map((m) => {
          const keep = Math.max(keepFor(m.id, gone), twoStepKeep(m.id, gone));
          return { id: m.id, keep, need: Math.max(0, cost - (avail.get(m.id)! - keep)) };
        })
        .filter((o) => o.need <= spareAt(o.id))
        .sort((a, b) => a.need - b.need || a.id - b.id)[0];
      if (!src || src.need > credit) continue;
      const c: Cand = { s, src: src.id, keep: src.keep, need: src.need, cost, d, extra, set, credit };
      if (!best || c.credit - c.need > best.credit - best.need) best = c;
    }
    if (!best) return;
    const c = best;
    tried.add(c.s);
    const prev = targets.get(c.s);
    targets.set(c.s, { id: c.s, cost: c.cost, enemy: true, sources: [c.src] });
    const hadWorst = caps.worstCase.get(c.s);
    caps.worstCase.set(c.s, c.d + c.extra);
    const player = foeOf(c.s)!;
    const names = c.set.map((m) => label(m.id)).join(', ');
    const holds = c.set.reduce((n, m) => n + m.holdCost, 0);
    const reason = `takes the one enemy stack beside ${names}, sure even if player ${player} deploys its ~${c.extra} there first (${c.d} + ${c.extra} defenders), so ${c.set.length === 1 ? 'that border needs' : 'those borders need'} no hold (#285)`;
    if (!caps.tryCapture(c.s, reason, { from: c.src, keep: c.keep })) {
      if (prev) targets.set(c.s, prev);
      else targets.delete(c.s);
      if (hadWorst === undefined) caps.worstCase.delete(c.s);
      else caps.worstCase.set(c.s, hadWorst);
      continue;
    }
    for (const m of c.set) heldBorders.add(m.id);
    for (const u of units) if (u.contested && u.members.every((m) => heldBorders.has(m.id))) u.contested = false;
    rationale.push(
      `Take ${label(c.s)} from ${label(c.src)} rather than hold ${names}: a deploy of ${c.need} sends ${c.cost}, sure even if player ${player} deploys its ~${c.extra} there first, against the ${holds} the ${c.set.length === 1 ? 'hold' : 'holds'} would cost this turn (${c.credit} for ${HOLD_CREDIT_TURNS} turns); once it falls ${names} ${c.set.length === 1 ? 'borders' : 'border'} no enemy (#285).`,
    );
  }
}
