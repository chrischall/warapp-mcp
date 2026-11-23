// #272 (item 1): a conceded border attacks out for a free step into a bonus before it withdraws.
// Rule 1b withdraws a conceded border's movable armies toward a border that holds; the capture
// passes only use such a border for a completion it is in (#122) or a capture its armies already
// cover. Live, the last member of a +3 bonus stood empty beside a border the plan conceded and
// withdrew from, and two more empty territories beside another: the play session held the border
// and took the member, completing the bonus. So, once the bonus passes have run and before rule 1b
// withdraws: a territory next to a conceded border of mine holding at most CONCEDED_OUT_MAX armies
// (a neutral, or a foe's with no special unit; never a truce's or, under `expand`, a player's), in a
// positive bonus whose capture completes it or advances one I am building (another member mine or
// captured; under No-Split, which sends the whole stack, a completion only), is taken with that
// border's own armies (no deploy) when they cover what the capture sends (a lead step's or a
// repulsed territory's size included) beyond its exit cover — completions
// first, then by bonus value, cost, a teammate's focus (C3.4) and id, repeated while a capture makes another complete. R3 does
// not refuse it (the armies would otherwise leave the border it gives up); a completed bonus then
// keeps the border as rule 1c keeps any member of a bonus this turn completes. The rest withdraw.
// planPass runs it just before rule 1c's re-valuation and rule 1b's withdrawal.
import { bonusTerritories } from '../bonuses.js';
import { neighborsOf } from '../graph.js';
import type { Captures } from './captures.js';
import type { Holds } from './holds.js';
import type { DeployBook } from './orders.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Targets } from './targets.js';
import { teamFocusLine } from './team.js';
import { byNum } from './util.js';

/** #272: a target holding at most this many armies is "empty or near-empty". */
export const CONCEDED_OUT_MAX = 2;

/**
 * #286: rule 1c keeps my `x` — a positive bonus containing it is completed by this turn's captures —
 * so its armies would not withdraw: they are its garrison, not a free step. Live, a +2 member
 * attacked out with 3 into an uneconomic bonus, was kept, and ended 1 army short of its hold.
 */
export function keptByCompletion(pc: PlanCtx, ps: PlanState, x: number): boolean {
  const { g, mineSet } = pc;
  const holding = (y: number) => mineSet.has(y) || ps.captured.has(y);
  return g.map.bonuses.some((b) => {
    if (b.value <= 0) return false;
    const ts = bonusTerritories(g, b.id);
    return ts.includes(x) && ts.every(holding) && !ts.every((y) => mineSet.has(y));
  });
}

export function attackOutOfConceded(pc: PlanCtx, ps: PlanState, book: DeployBook, hd: Holds, tgt: Targets, caps: Captures): void {
  const { g, goal, foe, territories: state, label, bonusName, mineSet, unitsAt, uncounted, defenceAt, costAt, myCommanders, noSplit } = pc;
  const { avail, captured, spared, rationale } = ps;
  const { conceded } = hd;
  const { targets } = tgt;
  const { gainWith, coverOf } = book;
  if (!conceded.size) return;
  const holding = (x: number) => mineSet.has(x) || captured.has(x);
  /** The positive bonuses taking `t` completes, and those it advances (another member already mine or captured). */
  const stepOf = (t: number) => {
    const completes: number[] = [];
    const advances: number[] = [];
    for (const b of g.map.bonuses) {
      if (b.value <= 0) continue;
      const ts = bonusTerritories(g, b.id);
      if (!ts.includes(t) || ts.every((x) => mineSet.has(x))) continue;
      if (ts.every((x) => x === t || holding(x))) completes.push(b.id);
      else if (ts.some((x) => x !== t && holding(x))) advances.push(b.id);
    }
    return { completes, advances };
  };
  const keptBy1c = (x: number) => keptByCompletion(pc, ps, x);
  const tried = new Set<number>();
  for (;;) {
    const cands: { t: number; from: number; cost: number; bonus: number; value: number; completes: boolean; focus: boolean }[] = [];
    for (const x of [...conceded].sort(byNum)) {
      if (!mineSet.has(x) || myCommanders.has(x) || keptBy1c(x)) continue;
      // #272 review: what tryCapture's forced source may spend: a covered exit (#179) keeps its cover
      // (No-Split sends the whole stack).
      const n = (avail.get(x) ?? 0) - (noSplit ? 0 : coverOf(x));
      if (n <= 0) continue;
      for (const t of neighborsOf(g, x)) {
        if (mineSet.has(t) || captured.has(t) || spared.has(t) || tried.has(t) || pc.truce.noTarget(t) || tgt.droppedMembers.has(t)) continue;
        const st = state.get(t);
        if (!st || st.armies === null || uncounted(t) || unitsAt(t) > 0) continue;
        if (st.owner.kind === 'player' && (goal === 'expand' || !foe(st.owner.playerId))) continue;
        if (st.owner.kind !== 'player' && st.owner.kind !== 'neutral') continue;
        if (defenceAt(t) > CONCEDED_OUT_MAX) continue;
        const cost = costAt(t);
        // What the capture must send (#272 review: what tryCapture sends, the target's cost): a repulsed
        // territory's size (#240) or a lead step's sure size (#203) may be more than the plain cost.
        // Never more than the border's own armies: a conceded border gets no deploy.
        if (cost === null || Math.max(tgt.sizeOf(t, cost), targets.get(t)?.cost ?? cost) > n || gainWith([t]) < 0) continue;
        const { completes, advances } = stepOf(t);
        // No-Split: the whole stack goes, none withdraws — only for a completion.
        const ids = completes.length ? completes : noSplit ? [] : advances;
        if (!ids.length) continue;
        const best = ids.map((id) => g.bonusById.get(id)!).sort((a, b) => b.value - a.value || a.id - b.id)[0]!;
        // PLAN-TEAMS C3.4: a player my teammate attacks this turn ranks above an equal capture.
        const focus = st.owner.kind === 'player' && pc.teamFocus.has(st.owner.playerId);
        cands.push({ t, from: x, cost, bonus: best.id, value: best.value, completes: completes.length > 0, focus });
      }
    }
    if (!cands.length) return;
    cands.sort(
      (a, b) =>
        Number(b.completes) - Number(a.completes) ||
        b.value - a.value ||
        a.cost - b.cost ||
        Number(b.focus) - Number(a.focus) ||
        (avail.get(b.from) ?? 0) - (avail.get(a.from) ?? 0) ||
        a.t - b.t ||
        a.from - b.from,
    );
    const c = cands[0]!;
    tried.add(c.t);
    const owner = (t: number) => {
      const o = state.get(t)!.owner;
      return o.kind === 'player' ? o.playerId : undefined;
    };
    /** PLAN-TEAMS C3.4: the candidate the focus put this one above, when only the focus decided. */
    const passed = c.focus ? cands.find((d) => !d.focus && d.completes === c.completes && d.value === c.value && d.cost === c.cost) : undefined;
    const st = state.get(c.t)!;
    const added = !targets.has(c.t);
    if (added) targets.set(c.t, { id: c.t, cost: c.cost, enemy: st.owner.kind === 'player', sources: [c.from] });
    const reason = `${c.completes ? 'completes' : 'advances'} bonus ${bonusName(c.bonus)} (+${c.value}) out of conceded ${label(c.from)}, with armies that would otherwise withdraw (#272)`;
    caps.r3Exempt.add(c.t);
    const ok = caps.tryCapture(c.t, reason, { from: c.from, keep: 0 });
    if (!ok) {
      caps.r3Exempt.delete(c.t);
      if (added) targets.delete(c.t);
      continue;
    }
    // What the attack sends (a repulsed territory's sure size may be more than its plain cost, #240).
    const sent = ps.moves.filter((m) => m.kind === 'attack' && m.from === c.from && m.to === c.t).reduce((n, m) => n + m.armies, 0);
    // #272 review: rule 1b withdraws only into a neighbour of mine that is not conceded; with none, the
    // armies would have stayed, and the attack thins the border instead.
    const canWithdraw = neighborsOf(g, c.from).some((x) => mineSet.has(x) && !conceded.has(x));
    const verb = `${c.completes ? 'completing' : 'advancing'} bonus ${bonusName(c.bonus)} (+${c.value}) (#272)`;
    rationale.push(
      canWithdraw
        ? `Attack out of conceded ${label(c.from)} before withdrawing: ${label(c.t)} holds ${defenceAt(c.t)}, and ${sent} of the armies leaving the border anyway take it, ${verb}.`
        : `Attack out of conceded ${label(c.from)}: ${label(c.t)} holds ${defenceAt(c.t)}, and ${sent} of its armies take it, ${verb}; it has nowhere to withdraw to, so they leave a border that keeps the rest.`,
    );
    if (passed)
      rationale.push(
        teamFocusLine(pc, { kind: 'capture', id: c.t, target: c.t, owner: owner(c.t)! }, { kind: 'capture', id: passed.t, target: passed.t, ...(owner(passed.t) !== undefined ? { owner: owner(passed.t)! } : {}) }),
      );
  }
}
