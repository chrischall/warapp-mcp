// Withdrawals from conceded borders (rule 1b), the concessions this turn's captures make worth keeping
// (rule 1c, R2) and the garrisons of bonuses completed this turn (#122) — split from holds.ts, which
// re-exports it. Also the move-order helpers those rules share (`knownFirst`, `lateNet`, `sentOut`).
import { bonusTerritories } from '../bonuses.js';
import { bfsDistances, neighborsOf } from '../graph.js';
import { chargeDeploys } from '../local-deploy.js';
import {




  CONCEDE_FACTOR,


  type PlannedMove,


} from './shared.js';
import type { DeployBook } from './orders.js';
import { capRoom, } from './relations.js';
import { paybackLive, type PlanCtx, type PlanState } from './state.js';
import type { Threats } from './threats.js';
import { byNum } from './util.js';
import type { floorTier, heldBonusUnits, holdBasics, holdOrConcede, twoStepHolds, HoldBook, Threatened, Unit } from './holds.js';

/**
 * #215: I am known to move first (#127) — from a source the hold sizing trusts: one the user gave,
 * not the award of picks' unverified rule (`movesFirstUnverified`, #215 review) — and no opponent
 * may hold an Order Priority card (`opponentsMayHoldOrderPriority`, #215 review): played, it puts
 * its first order (an all-in on a border) before my first.
 */
export const knownFirst = (pc: PlanCtx) =>
  pc.opts.movesFirst === true && pc.opts.movesFirstUnverified !== true && pc.opts.opponentsMayHoldOrderPriority !== true;

/**
 * #215: the armies withdrawn into my `id` this turn (rule 1b) that a hold may count only if I move
 * first. A transfer in is my own order: when the opponent moves first, its first order — an all-in
 * on `id` — runs before any of mine. So unless I am known to move first (#127, {@link knownFirst})
 * they are late, and a hold sized for the worse order leaves them out. 0 when I am known to move first.
 */
export function lateArrivals(pc: PlanCtx, ps: PlanState, id: number): number {
  return knownFirst(pc) ? 0 : withdrawnInto(ps, id);
}

/**
 * #215 review: the armies a worse-order hold on my `id` leaves out. When the opponent moves first,
 * its first order runs before ALL of mine: the armies withdrawn into `id` are not there yet, and
 * the armies `id` sends out by its own orders are still there. After my orders have run, the
 * withdrawal is in and those armies are gone (the hold #127 sized). A move out of a territory is
 * scheduled after the moves into it (schedule.ts), so the worse of the two is the withdrawal less
 * what leaves: `max(0, late − sent out)`. 0 when I am known to move first.
 */
export function lateNet(pc: PlanCtx, ps: PlanState, id: number): number {
  const late = lateArrivals(pc, ps, id);
  return late <= 0 ? 0 : Math.max(0, late - sentOut(ps, id));
}

/** #215 review: the armies my `id` sends out by its own orders this turn (attacks and transfers). */
export function sentOut(ps: PlanState, id: number): number {
  return ps.moves.reduce((n, m) => (m.from === id ? n + m.armies : n), 0);
}

/**
 * #215: the armies withdrawn into my `id` this turn (rule 1b), whatever the move order. Only
 * withdrawal transfers count (#215 review): `incoming` also carries a softener's survivors that come
 * home and No-Split extras, which beside an idle transfer in (rule 6) would read as withdrawn.
 */
export function withdrawnInto(ps: PlanState, id: number): number {
  const sent = ps.moves.reduce(
    (n, m) => (m.kind === 'transfer' && m.to === id && m.reason === 'withdraws from a conceded border' ? n + m.armies : n),
    0,
  );
  return Math.max(0, Math.min(ps.incoming.get(id) ?? 0, sent));
}

/** Rule 1b: withdraw from conceded borders (and Order Priority when a withdrawal must go first). */
export function withdrawals(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hb: HoldBook,
  prev: HoldsUpTo4,
) {
  const { g, label, bonusName, mine, mineSet, unitsAt, toTake, noSplit } = pc;
  const { warnings, rationale, avail, locked, moves, incoming } = ps;
  const { coverOf, orderOf, warnSplit, pools, valueOf } = book;
  const local = pools !== null && pools.bonuses.length > 0;
  const { expectedAt, borders } = threats;
  const { conceded, units } = hb;
  const { stayAt, unitBorders } = prev;
  // ---- 1b. withdraw from conceded borders ----
  ps.cardAdvice = null;
  /** Conceded borders of a held bonus whose garrison stays (it holds against the expected attack). */
  const stood = new Set<number>();
  /** Bonuses whose Local Deployment concession warning (#103) is already given. */
  const warnedLocal = new Set<number>();
  /** Local Deployment (#103): conceded borders of a held bonus that might still hold; the leftover may go there. */
  const mayHold = new Set<number>();
  /** Local Deployment: the armies every pool containing `id` holds this turn. */
  const poolsAt = (id: number) =>
    local ? pools.bonuses.filter((p) => p.territoryIds.includes(id)).reduce((n, p) => n + p.value, 0) : 0;
  /** A border no deploy this turn can hold: its hold needs more than its pools and every free army. */
  const lostAnywayAt = (m: Threatened) => local && m.holdCost > poolsAt(m.id) + pools.anywhere;
  /** A held bonus that falls whatever this turn deploys: one of its threatened borders cannot be held. */
  const lostAnyway = (u: Unit) => u.members.some(lostAnywayAt);
  const withdraw = () => {
    if (!conceded.size) return;
    const withdrawals: PlannedMove[] = [];
    const keep = (id: number) => mineSet.has(id) && !conceded.has(id);
    // Borders that can hold: mine, not conceded, next to something not mine.
    const holding = mine.filter((id) => keep(id) && neighborsOf(g, id).some((n) => !mineSet.has(n)));
    for (const t of [...conceded].sort(byNum)) {
      // #179: a covered exit keeps its cover; only the rest may leave.
      const n = avail.get(t)! - coverOf(t);
      // No-Split (#124): a transfer sends the whole stack, so a covered exit sends none.
      if (n <= 0 || (noSplit && coverOf(t) > 0)) continue;
      // Issue #59: a held bonus's border keeps its garrison while it still holds against the
      // expected attack — withdrawing it would guarantee the loss.
      const held = g.map.bonuses
        .filter((b) => {
          const ts = bonusTerritories(g, b.id);
          return b.value > 0 && ts.includes(t) && ts.every((x) => mineSet.has(x));
        })
        .sort((a, b) => a.id - b.id);
      const stays = stayAt(t);
      const take = toTake(stays) ?? Infinity;
      const expected = expectedAt(t);
      if (held.length && take > expected) {
        locked.add(t);
        stood.add(t);
        rationale.push(
          `Keep the ${n} movable armies on ${label(t)} (not withdrawn): it is a border of held bonus ${held.map((b) => bonusName(b.id)).join(', ')}, and its ${stays} armies need ${take} to take, above the expected ~${expected} attack (movable + deploy estimate).`,
        );
        continue;
      }
      // Local Deployment (#103): a conceded held bonus keeps its garrisons unless it truly
      // cannot be held — some threatened border needs more than its pools and every free army
      // could give it. Withdrawing turns "might lose it" into "certainly loses it".
      if (local && held.length) {
        const mine1 = units.filter((u) => u.conceded && u.members.some((m) => m.id === t));
        const maybe = mine1.filter((u) => !lostAnyway(u));
        if (maybe.length) {
          locked.add(t);
          stood.add(t);
          mayHold.add(t);
          for (const u of maybe) {
            if (warnedLocal.has(u.bonusId)) continue;
            warnedLocal.add(u.bonusId);
            warnings.push(
              `Bonus ${bonusName(u.bonusId)} (+${u.value}) is conceded but might still hold: each of its ${unitBorders(u)} could be held with its own ${u.pool} local armies and the ${pools.anywhere} free ones, so its garrisons stay and its local armies defend it (withdrawing would make the loss certain); it may fall.`,
            );
          }
          rationale.push(
            `Keep the ${n} movable armies on ${label(t)} (not withdrawn): bonus ${maybe.map((u) => bonusName(u.bonusId)).join(', ')} might still hold under Local Deployment, and withdrawing would guarantee the loss.`,
          );
          continue;
        }
        for (const u of mine1) {
          if (warnedLocal.has(u.bonusId)) continue;
          warnedLocal.add(u.bonusId);
          const worst = u.members.find((m) => lostAnywayAt(m))!;
          warnings.push(
            `Bonus ${bonusName(u.bonusId)} (+${u.value}) cannot be held: ${label(worst.id)} needs ${worst.holdCost}, more than its own ${poolsAt(worst.id)} local armies and all ${pools.anywhere} free ones could give it, so its garrisons withdraw (it is lost either way).`,
          );
        }
      }
      // B2 (T5): never onto a truce's capped border past its cap.
      const options = neighborsOf(g, t)
        .filter((c) => keep(c) && capRoom(pc, ps, c, withdrawals) >= n)
        .map((c) => {
          const dist = bfsDistances(g, [c], { passable: keep });
          let best = Infinity;
          let value = 0;
          for (const h of holding) {
            const d = dist.get(h);
            if (d === undefined) continue;
            if (d < best || (d === best && valueOf(h) > value)) [best, value] = [d, valueOf(h)];
          }
          return { id: c, best, value };
        })
        .sort((a, b) => a.best - b.best || b.value - a.value || a.id - b.id);
      const to = options[0];
      if (!to) {
        const capped = neighborsOf(g, t).some((c) => keep(c) && capRoom(pc, ps, c, withdrawals) < n);
        warnings.push(
          `${label(t)} is conceded and has nowhere to withdraw to${capped ? ' (a truce caps the armies on the borders beside it)' : ''}: its ${n} movable armies stay.`,
        );
        continue;
      }
      // #118: a border of a bonus I hold in full keeps its garrison — those armies kill attackers
      // where they stand — unless withdrawing them makes another valued border hold this turn.
      // (Under Local Deployment rule 1b's pool test above decides instead.)
      if (held.length && !local) {
        const dest = borders.get(to.id);
        const at = stayAt(to.id) + unitsAt(to.id);
        const makesHold =
          dest !== undefined &&
          !conceded.has(to.id) &&
          valueOf(to.id) > 0 &&
          (toTake(at) ?? Infinity) <= dest.threat &&
          (toTake(at + n) ?? Infinity) > dest.threat;
        if (!makesHold) {
          locked.add(t);
          stood.add(t);
          rationale.push(
            `Keep the ${n} movable armies on ${label(t)} (not withdrawn): it is a border of held bonus ${held.map((b) => bonusName(b.id)).join(', ')}, and withdrawing them would make no other valued border hold this turn, while there they kill attackers.`,
          );
          continue;
        }
      }
      if (orderOf(t)) {
        warnSplit(t, `its ${n} remaining armies are not withdrawn to ${label(to.id)}`);
        locked.add(t);
        continue;
      }
      avail.set(t, avail.get(t)! - n);
      locked.add(t);
      const reason = 'withdraws from a conceded border';
      withdrawals.push({ from: t, to: to.id, armies: n, kind: 'transfer', reason });
      incoming.set(to.id, (incoming.get(to.id) ?? 0) + n);
      rationale.push(`Withdraw ${n} from ${label(t)} to ${label(to.id)}: ${reason}, toward a border that holds.`);
      warnings.push(
        `The withdrawal from ${label(t)} only executes if ${label(t)} is still mine when the order runs; play Order Priority so it goes first.`,
      );
      ps.cardAdvice = 'order-priority';
    }
    // Withdrawals go first: they only execute while the border is still mine.
    moves.unshift(...withdrawals);
  };
  return { stood, mayHold, withdraw };
}

/** Rule 1c (R2): reconsider concessions after the capture passes; #122: garrison a bonus completed this turn. */
export function reconsiderAndGarrison(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hb: HoldBook,
  prev: HoldsUpTo5,
) {
  const { g, guarded, reserve, paybackTurns, label, bonusName, mine, mineSet, unitsAt, toTake, myCommanders } = pc;
  const { warnings, rationale, deployed, locked, captured, moves } = ps;
  const { orderOf, deploy, pools, valueCache, cutCache, breachCache, opensCache, valueOf } = book;
  const local = pools !== null && pools.bonuses.length > 0;
  const { borders } = threats;
  const { conceded, kept, garrisoned } = hb;
  const { stayAt, heldBorders } = prev;
  // ---- 1c. reconsider concessions after the capture passes (R2) ----
  // Triage ran before captures were known, so a border in a bonus this turn's
  // captures complete was valued +0 and conceded. Re-value every border against
  // the holdings after the captures; a conceded border in a bonus completed this
  // turn is kept (never withdrawn from) and garrisoned from the leftover.
  const reconsider = () => {
    if (!captured.size) return;
    ps.holdings = new Set([...mine, ...captured]);
    valueCache.clear();
    cutCache.clear();
    breachCache.clear();
    opensCache.clear();
    if (!conceded.size) return;
    for (const t of [...conceded].sort(byNum)) {
      // Already withdrawn from (rule 1b ran first): its armies are gone, and it stays conceded.
      if (moves.some((m) => m.from === t && m.reason === 'withdraws from a conceded border')) continue;
      const completes = g.map.bonuses
        .filter((b) => {
          const ts = bonusTerritories(g, b.id);
          // #422: a payback completion is expected to fall next turn: it keeps no conceded border.
          return (
            b.value > 0 && !paybackLive(ps, ps.paybackBonuses, b.id) && ts.includes(t) && ts.every((x) => ps.holdings.has(x)) && !ts.every((x) => mineSet.has(x))
          );
        })
        .sort((a, b) => a.id - b.id);
      if (!completes.length) continue;
      conceded.delete(t);
      kept.add(t);
      locked.add(t);
      // Drop its concession warning: it is no longer conceded.
      const conceding = `${label(t)} cannot be held `;
      for (let i = warnings.length - 1; i >= 0; i--)
        if (warnings[i]!.startsWith(conceding) && warnings[i]!.endsWith(': conceded')) warnings.splice(i, 1);
      rationale.push(
        `Keep ${label(t)} (not conceded): this turn's captures complete ${completes.map((b) => `bonus ${b.name} (#${b.id}) (+${b.value})`).join(', ')}, so it protects +${valueOf(t)}.`,
      );
    }
  };
  // (Under `defend` the withdrawal runs after the capture passes, once `reconsider` has
  // kept any border this turn's captures make valuable; it still goes first in the orders.)

  // ---- #122: a bonus completed this turn is garrisoned like a held one (rule 1h) ----
  // Its members I held at the start of the turn that face an enemy would otherwise get only the
  // leftover (rule 1c), after every advance had spent the income: live, completed bonuses stood
  // beside enemies on 1-army borders and never paid a turn. So once a capture completes a bonus,
  // its threatened members are held whole right away — before any later capture — when the holds
  // pay for themselves as a held bonus's do (cost ≤ PAYBACK_TURNS × value and ≤ CONCEDE_FACTOR ×
  // its worth) and fit what may still be deployed; otherwise they are left to the leftover as
  // before. Captured members are not garrisoned: next turn's deploys land before any attack.
  /** Bonuses whose garrison was judged (funded or not), so each is judged once. */
  const garrisonJudged = new Set<number>();
  /** Do these deploys fit together what may still be deployed (the budget, and the pools under Local Deployment)? */
  const fitsTogether = (adds: readonly { id: number; d: number }[]): boolean => {
    if (adds.reduce((n, x) => n + x.d, 0) > ps.budget) return false;
    if (!local) return true;
    const next = new Map(deployed);
    for (const x of adds) next.set(x.id, (next.get(x.id) ?? 0) + x.d);
    return chargeDeploys(pools, next).anywhereUsed <= pools.anywhere;
  };
  const garrisonCompleted = () => {
    if (!guarded || !captured.size) return;
    const after = new Set([...mine, ...captured]);
    for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
      // #422: a payback completion is expected to fall next turn: no garrison is thrown after it.
      if (b.value <= 0 || garrisonJudged.has(b.id) || paybackLive(ps, ps.paybackBonuses, b.id)) continue;
      const ts = bonusTerritories(g, b.id);
      if (!ts.length || !ts.every((x) => after.has(x)) || ts.every((x) => mineSet.has(x))) continue;
      garrisonJudged.add(b.id);
      const todo: { id: number; d: number; threat: number }[] = [];
      let have = 0;
      let split = false;
      for (const t of ts) {
        const border = borders.get(t);
        if (!mineSet.has(t) || !border || heldBorders.has(t) || myCommanders.has(t)) continue;
        const stays = stayAt(t) + unitsAt(t);
        let d = 0;
        while ((toTake(stays + d) ?? Infinity) <= border.threat) d++;
        if (!d) continue;
        // No-Split: a deploy on a territory that already issues an order leaves with it.
        if (orderOf(t)) split = true;
        todo.push({ id: t, d, threat: border.threat });
        have += stays;
      }
      if (!todo.length || split) continue;
      const cost = todo.reduce((n, x) => n + x.d, 0);
      const worth = b.value + have / paybackTurns;
      // #421: the strike share holds back captures only, never this garrison.
      if (cost > paybackTurns * b.value || cost > CONCEDE_FACTOR * worth || cost > ps.budget - (reserve - pc.strikeShare)) continue;
      // The pools are checked for the members together: each may fit the free pool on its own
      // while together they overdraw it.
      if (!fitsTogether(todo)) continue;
      for (const x of todo) {
        deploy(x.id, x.d);
        garrisoned.add(x.id);
        heldBorders.add(x.id);
        locked.add(x.id);
        const stays = stayAt(x.id) + unitsAt(x.id);
        rationale.push(
          `Garrison ${label(x.id)} for bonus ${bonusName(b.id)} (+${b.value}), completed this turn: deploy ${x.d} so its ${stays} armies need ${toTake(stays)} to take, above the ~${x.threat} threat — held like a bonus held at the start, before any later capture, not left to the leftover.`,
        );
      }
    }
  };
  return { reconsider, garrisonCompleted };
}

export type HoldsUpTo0 = ReturnType<typeof holdBasics>;
export type HoldsUpTo1 = HoldsUpTo0 & ReturnType<typeof twoStepHolds>;
export type HoldsUpTo2 = HoldsUpTo1 & ReturnType<typeof holdOrConcede>;
export type HoldsUpTo3 = HoldsUpTo2 & ReturnType<typeof heldBonusUnits>;
type HoldsUpTo4 = HoldsUpTo3 & ReturnType<typeof floorTier>;
type HoldsUpTo5 = HoldsUpTo4 & ReturnType<typeof withdrawals>;
