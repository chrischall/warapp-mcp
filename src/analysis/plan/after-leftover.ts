// Rule 5b, a capture the leftover pays for (#218, last comment): once the leftover is placed, a
// neutral a source it reached can now take from what stands above its hold is taken. Live, a capture
// was ruled out because its source "stays to hold its border" (2 armies against a hold of ~5), and the
// leftover then put 1 and 7 on that same source as its comfortable margin — 13 against that hold,
// beside a 1-army neutral that 3 take for +1 — and nothing attacked it. planPass runs it after the
// leftover, the strike stack's orders and the lead strikes, before the efficient sizes, the transfers
// (rule 6) and the #226 margin.
import { straightKills } from '../combat.js';
import { neighborsOf } from '../graph.js';
import { lateArrivals, type Holds } from './holds.js';
import type { Captures } from './captures.js';
import type { DeployBook } from './orders.js';
import { PLAIN_EXPANSION_LOSS } from './shared.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Targets } from './targets.js';
import { notFromTransit, plainOrderCosts } from './vacated.js';
import type { Threats } from './threats.js';

/**
 * Pass 3's economy test (#125) for capturing `id` (its income change `gain`): a member of an economic
 * bonus is judged by that bonus, a focused one always passes; any other capture repays the armies it
 * loses (the defenders' kills) with the income it adds within PAYBACK_TURNS, and one adding none may
 * lose at most PLAIN_EXPANSION_LOSS. `null` when it passes, else its armies lost and the worth it adds.
 */
export function plainEconomy(pc: PlanCtx, tgt: Targets, id: number, gain: number): { lost: number; worth: number } | null {
  if (pc.inFocus(id) || tgt.economicMember.has(id)) return null;
  const lost = straightKills(pc.defenceAt(id), pc.rates.defensiveKillRate);
  const worth = pc.plainWorth(id, gain);
  return (worth > 0 ? lost > pc.paybackTurns * worth : lost > PLAIN_EXPANSION_LOSS) ? { lost, worth } : null;
}

/**
 * #426: a neutral in view whose defenders kill none of my attackers (0 armies at the usual 70% defensive
 * rate): its capture costs only the armies that land on it, which stay mine. Live (a guard-off game of
 * 0-army neutrals, turn 4), 25 of them beside idle stacks were skipped as members of bonuses too costly to
 * finish, though a bonus's cost says nothing about a territory that loses nothing. Never a negative
 * bonus's member (it would cut income).
 */
export function noLossNeutral(pc: PlanCtx, tgt: Targets, id: number): boolean {
  const st = pc.territories.get(id);
  return (
    st?.owner.kind === 'neutral' &&
    st.armies !== null &&
    !tgt.negativeMember.has(id) &&
    straightKills(pc.defenceAt(id), pc.rates.defensiveKillRate) === 0
  );
}

/**
 * #426: whether pass 3 takes `id` only as a no-loss capture ({@link noLossNeutral}): a member of an
 * uneconomic bonus no other exemption lets through. Its reason line says so.
 */
export function onlyNoLoss(pc: PlanCtx, tgt: Targets, id: number): boolean {
  return tgt.uneconomicMember.has(id) && !tgt.economicMember.has(id) && !plainEligible(pc, tgt, id, false, false) && noLossNeutral(pc, tgt, id);
}

/**
 * Pass 3's eligibility (#125): not a player's under `balanced` (but #281's empty enemy territory), and
 * not only a member of an uneconomic bonus (but #281's denial: what it denies the opponent beside it is
 * its worth, not my bonus; #417's land a static seat left, outside a negative bonus: the breach force
 * takes it while it is up for taking; and #426's no-loss neutral). `noLoss` false leaves #426 out.
 */
export function plainEligible(pc: PlanCtx, tgt: Targets, id: number, enemy: boolean, noLoss = true): boolean {
  return (
    !(pc.balanced && enemy && !tgt.emptyEnemies.has(id)) &&
    (tgt.economicMember.has(id) ||
      !tgt.uneconomicMember.has(id) ||
      tgt.denials.has(id) ||
      (noLoss && noLossNeutral(pc, tgt, id)) ||
      // #417, the breach force: land a static seat left is taken while it is up for taking.
      (pc.vacated.has(id) && !tgt.negativeMember.has(id)) ||
      (pc.territoryShare(1) > 0 && !tgt.negativeMember.has(id)))
  );
}

/**
 * Rule 5b. `before`: the deploys before the leftover (rule 5), so the sources are the territories
 * the leftover reached. `skip`: sources the caller keeps whole (the strike stack, the step the
 * leftover saves toward). `caps.tryExpand`: pass 3's capture (R3, rule 4d and the usual sizing). Returns
 * the targets taken.
 */
export function afterLeftoverCaptures(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hd: Holds,
  tgt: Targets,
  caps: Pick<Captures, 'tryExpand' | 'stopped' | 'notCompleted'>,
  before: ReadonlyMap<number, number>,
  skip: ReadonlySet<number>,
  poolDeployed: ReadonlyMap<number, number>,
): number[] {
  const { g, territories: state, label, mineSet, unitsAt, noSplit, myCommanders, goal } = pc;
  const { rationale, warnings, avail, deployed, captured, moves, centralKeep } = ps;
  const { coverOf, gainWith } = book;
  const { borderAt, forceAt, holdArmies } = threats;
  const { conceded, stayAt, twoStepKeep } = hd;
  const { targets } = tgt;
  const { tryExpand, stopped, notCompleted } = caps;
  // No-Split (#124) sends the whole stack: nothing would stay to hold the source. `complete-bonus`
  // never expands (as pass 3).
  if (noSplit || goal === 'complete-bonus' || ps.budget > 0) return [];
  /** A player's territory: an attack on it may fail, and the #226 margin sizes those from the source's spare. */
  const onPlayer = (n: number) => state.get(n)?.owner.kind === 'player';
  const sources = [...mineSet]
    .filter(
      (x) =>
        (deployed.get(x) ?? 0) > (before.get(x) ?? 0) &&
        !conceded.has(x) &&
        !myCommanders.has(x) &&
        !skip.has(x) &&
        !moves.some((m) => m.from === x && m.kind === 'attack' && onPlayer(m.to)),
    )
    .sort((a, b) => a - b);
  if (!sources.length) return [];
  /**
   * What `x` has above its hold once it attacks `t`: what holds it against the threat beside it —
   * judged as if this turn's attacks on players there failed, and without the armies withdrawn into
   * it unless I am known to move first (#215: as `keepFor` sizes a hold) — and at least what a stack
   * two steps away needs it to keep (#172), what covers a finished-off player's exit (#179), the
   * leftover kept central (#218) and a Local Deployment pool's armies (#103). `null` when it cannot
   * hold on what it has.
   */
  const spareFor = (x: number, t: number) => {
    const gone = (n: number) => n === t || (captured.has(n) && !onPlayer(n));
    const b = borderAt(x, gone);
    const stays = stayAt(x) - lateArrivals(pc, ps, x);
    let need = b ? Math.max(0, holdArmies(b.threat) - unitsAt(x)) : 0;
    // #128: what holds it against two opponents attacking together, when it holds that now: the
    // capture never brings on the warning that it does not.
    const pile = b ? forceAt(x, gone, { trend: true, allPlayers: true, pileOn: true })?.split : undefined;
    const together = pile && pile.players.length >= 2 && stays + unitsAt(x) > pile.takes ? pile : undefined;
    const alone = need;
    if (together) need = Math.max(need, together.takes + 1 - unitsAt(x));
    if (stays < need) return null;
    const keep = Math.max(
      avail.get(x)! - (stays - need),
      twoStepKeep(x, (n) => n === t),
      coverOf(x),
      centralKeep.get(x) ?? 0,
      poolDeployed.get(x) ?? 0,
    );
    return { spare: Math.max(0, avail.get(x)! - keep), keep, need, threat: b?.threat, together: need > alone ? together : undefined };
  };
  const taken: number[] = [];
  const eligible = [...targets.values()].filter(
    (tg) => state.get(tg.id)?.owner.kind === 'neutral' && !captured.has(tg.id) && tg.sources.some((x) => sources.includes(x)),
  );
  const order = plainOrderCosts(pc, tgt, eligible.map((tg) => tg.id));
  const candidates = eligible.sort((a, b) => order.get(a.id)! - order.get(b.id)! || a.cost - b.cost || a.id - b.id);
  for (const tg of candidates) {
    const t = tg.id;
    const gain = gainWith([t]);
    if (gain < 0 || !plainEligible(pc, tgt, t, false) || plainEconomy(pc, tgt, t, gain)) continue;
    // #281 × #282: a denial is never sourced from the territory my commander walks from (its transit hold).
    const best = (tgt.denials.has(t) ? notFromTransit(pc, tg) : tg).sources
      .filter((x) => sources.includes(x))
      .map((x) => ({ x, f: spareFor(x, t) }))
      .filter((c) => c.f !== null && c.f.spare >= tg.cost)
      .sort((a, b) => b.f!.spare - a.f!.spare || a.x - b.x)[0];
    if (!best) continue;
    const { x, f } = best;
    const late = lateArrivals(pc, ps, x);
    const had = stayAt(x) - late;
    const left = had - tg.cost;
    const failing = neighborsOf(g, x).some((n) => captured.has(n) && onPlayer(n));
    const held =
      f!.threat === undefined
        ? 'and no enemy is beside it'
        : `${left > f!.need ? `above the ${f!.need} that hold it` : 'what holds it'} against the ~${f!.threat} threat${
            f!.together ? ` and against players ${f!.together.players.join(' and ')} attacking it together (up to ${f!.together.takes} armies)` : ''
          }${
            failing ? " even if this turn's attacks on players beside it fail" : ''
          }`;
    const reason = `a neutral${gain > 0 ? ` (+${gain} income)` : ''} the leftover pays for (#218): of the ${had} on ${label(x)} after the leftover${
      late > 0 ? ` (the ${late} withdrawn into it left out: they may land too late)` : ''
    }, the ${tg.cost} sent leave ${left}, ${held}`;
    // A refused try leaves no line: this pass is an extra, and rule 4e or the frontier report already
    // says why the turn takes nothing more (R3's and rule 4d's refusals would otherwise repeat it).
    const lines = { rationale: rationale.length, warnings: warnings.length, stopped: stopped.length };
    const refusedBefore = new Set(notCompleted.keys());
    if (!tryExpand(t, reason, false, { from: x, keep: f!.keep })) {
      rationale.length = lines.rationale;
      warnings.length = lines.warnings;
      stopped.length = lines.stopped;
      for (const id of [...notCompleted.keys()]) if (!refusedBefore.has(id)) notCompleted.delete(id);
      continue;
    }
    taken.push(t);
  }
  if (taken.length) {
    // A capture is planned now: the stand-still warning (rule 4e) no longer holds.
    for (let i = warnings.length - 1; i >= 0; i--) if (warnings[i]!.startsWith('Standing still: no capture is planned')) warnings.splice(i, 1);
  }
  return taken;
}
