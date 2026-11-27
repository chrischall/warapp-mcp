// The capture passes of a planning pass (#133): R3's completion check, No-Split's must-hold
// (#124), the capture helper and combined (multi-source) captures (R4, rule 3a), and the bonus
// passes — pass 1 completes a bonus this turn, pass 2 advances one a capture at a time (rule
// 4c(c), rule 4d's frontier budget). planPass runs the passes, the strikes and pass 3 with them.
import { bonusTerritories } from '../bonuses.js';
import { armiesToTake, straightKills } from '../combat.js';
import { neighborsOf } from '../graph.js';
import { noLossNeutral } from './after-leftover.js';
import { deadAdvanceLine, deadAdvanceOf } from './dead-advance.js';
import { visibleState } from './observe.js';
import { captureCost, type BonusPlan, type TwoStepPass } from './shared.js';
import type { DeployBook } from './orders.js';
import type { Holds } from './holds.js';
import type { PlanCtx, PlanState } from './state.js';
import type { LeadBlock, LeadTry, Targets } from './targets.js';
import type { Threats } from './threats.js';
import { byNum } from './util.js';
import { denialLine, emptyEnemyLine } from './vacated.js';


/** Why the last tryCapture refused (R3, No-Split on a source that could take it); else size. */
export type Refusal =
  | { kind: 'r3' }
  | { kind: 'split'; from: number }
  | { kind: 'trade'; lost: number; killed: number }
  | ({ kind: 'must-hold' } & MustHold)
  | undefined;

export interface MustHold {
  from: number;
  value: number;
  stays: number;
  threat: number;
}

export interface Softener {
  from: number;
  armies: number;
  kills: number;
  /** Defenders left when it attacks. */
  before: number;
  /** Its attack fails by design: these return home. */
  survivors: number;
}

export interface Combined {
  softeners: Softener[];
  finisher: number;
  armies: number;
  /** Deploys the finisher needs. */
  need: number;
  /** Defenders left for the finisher. */
  left: number;
  survivors: number;
}

export type Captures = ReturnType<typeof capturesPhase>;

/** The capture rules, the capture helper and the bonus passes, in the order planPass defined them. */
export function capturesPhase(
  pc: PlanCtx,
  ps: PlanState,
  pass: TwoStepPass,
  book: DeployBook,
  threats: Threats,
  hd: Holds,
  tgt: Targets,
) {
  const c0 = captureRules(pc, ps, book, threats, hd);
  const c1 = { ...c0, ...captureHelper(pc, ps, pass, book, threats, hd, tgt, c0) };
  const c2 = { ...c1, ...bonusPasses(pc, ps, book, hd, tgt, c1) };
  return c2;
}

/** R3: a completion must leave a frontier I can hold; No-Split (#124): a stack that must hold. */
export function captureRules(pc: PlanCtx, ps: PlanState, book: DeployBook, threats: Threats, hd: Holds) {
  const {
    g, s, foe, goal, guarded, reserve, deployOf, territories: state, label, bonusName, mine, mineSet, armiesOf,
    unitsAt, defenceAt, bonusTs, completedBy, guard, toTake, noSplit, myCommanders, rates,
  } = pc;
  const { warnings, rationale, deployed, avail, captured, survivorsAt, incoming } = ps;
  const { guardAt, valueOf } = book;
  const { holdArmies, nextTurnAt, exposure, borderAt } = threats;
  const { conceded, keptIncome } = hd;
  // ---- R3: a completion must leave a frontier I can hold ----
  /**
   * "Not completed" warning and rationale, by bonus: kept outside `warnings`/`rationale`
   * so a rolled-back pass cannot drop them. A refusal is not final — the next income
   * grows as other bonuses complete — so they are emitted at the end only for bonuses
   * the plan did not complete after all.
   */
  const notCompleted = new Map<number, { warning: string; why: string }>();
  /**
   * Called with `t` just captured (`survivors` armies move in): for every bonus this
   * capture completes, the deploys its exposed members still need next turn to
   * hold must fit my projected next income (plus this turn's leftover, for members
   * I held at the start: a fresh capture cannot be deployed to). Otherwise the
   * bonus is lost immediately: refused under `balanced`/`defend`, warned otherwise.
   * The total need is checked, not each member alone: holding the bonus needs every
   * exposed member held. The leftover is as of this check; a later capture this turn
   * may still spend it (defence funds held borders first, so this is rarely material).
   * `lost`: the attackers the capture of `t` loses (#422), for the payback exemption below.
   */
  const defensible = (t: number, survivors: number, lost?: number): boolean => {
    const after = new Set([...mine, ...captured]);
    const completes = g.map.bonuses
      .filter((b) => {
        const ts = bonusTerritories(g, b.id);
        return b.value > 0 && ts.includes(t) && ts.every((x) => after.has(x));
      })
      .sort((a, b) => a.id - b.id);
    if (!completes.length) return true;
    const nextIncome = keptIncome(after);
    const spare = Math.max(0, ps.budget - reserve);
    const stays = (m: number) => {
      if (mineSet.has(m)) return avail.get(m)! + guardAt(m) + (incoming.get(m) ?? 0);
      if (m === t) return survivors;
      // An earlier capture this turn: the survivors of its finishing attack.
      return survivorsAt.get(m) ?? 0;
    };
    /**
     * #128: what holding `m` next turn needs that it would not have needed anyway. A member I held
     * at the start that is exposed either way (its armies before any attack leaves it, against the
     * threat without this turn's captures) only adds its need beyond that: refusing the completion
     * would not save it.
     */
    const either = (m: number) => {
      if (!mineSet.has(m)) return 0;
      const th = nextTurnAt(m, (n) => captured.has(n) && n !== t && !mineSet.has(n));
      if (!th) return 0;
      return Math.max(0, holdArmies(th.threat) - armiesOf(m) - (deployed.get(m) ?? 0) - unitsAt(m));
    };
    const exposedOf = (id: number) =>
      exposure(bonusTerritories(g, id), (n) => captured.has(n), stays).map((e) => ({ ...e, added: Math.max(0, e.need - either(e.id)) }));
    // #128: every bonus this turn's earlier captures completed shares the same next income — two
    // completions that each fit it may not fit it together.
    const ids = new Set(completes.map((b) => b.id));
    const earlier = new Map<number, number>();
    for (const e of completedBy(after)
      .filter((id) => !ids.has(id) && g.bonusById.get(id)!.value > 0 && !bonusTs.get(id)!.every((x) => mineSet.has(x)))
      .flatMap(exposedOf))
      earlier.set(e.id, Math.max(earlier.get(e.id) ?? 0, e.added));
    let ok = true;
    /** #422: the completions let through on payback, kept only when the capture is (no other bonus refuses it). */
    const payback: { line: string; bonusId: number; falls: number[] }[] = [];
    for (const b of completes) {
      const exposed = exposedOf(b.id);
      const total = exposed.reduce((sum, e) => sum + e.added, 0);
      const before = [...earlier].reduce((n, [id, need]) => n + (exposed.some((e) => e.id === id) ? 0 : need), 0);
      const held = exposed.filter((e) => mineSet.has(e.id)).reduce((sum, e) => sum + e.added, 0);
      const anyway = exposed.filter((e) => e.added < e.need);
      // A completion that adds no exposure (total 0) is never refused: refusing it saves nothing,
      // whatever the earlier completions need (it only adds income).
      if (total === 0 || total + before <= nextIncome + Math.min(spare, held)) {
        // #422: judged holdable now (a later try, with more income), so no longer a payback completion.
        ps.paybackBonuses.delete(b.id);
        if (anyway.length && guarded)
          rationale.push(
            `Complete bonus ${bonusName(b.id)} though ${anyway.map((e) => label(e.id)).join(', ')} may fall next turn: ${anyway.length === 1 ? 'it is' : 'they are'} exposed whether or not it is completed, so refusing would save nothing.`,
          );
        continue;
      }
      // #422: the payback exemption. A bonus held at the end of this turn pays its value in next turn's
      // income even if it falls straight after, so a completion whose losses — the attackers its captures
      // lose this turn plus the armies left on the members that would fall — are at most that value
      // repays itself in one turn: refusing it only gives the income up.
      if (guarded) {
        const falls = exposed.filter((e) => e.added > 0);
        const left = falls.reduce((n, e) => n + stays(e.id), 0);
        const killed = bonusTerritories(g, b.id)
          .filter((m) => captured.has(m) && !mineSet.has(m))
          .reduce((n, m) => n + (m === t && lost !== undefined ? lost : straightKills(defenceAt(m), rates.defensiveKillRate)), 0);
        if (killed + left <= b.value) {
          const line = `Complete bonus ${bonusName(b.id)} though its frontier cannot be held next turn (it needs ${total} more armies${before ? `, on top of the ${before} this turn's other completions need` : ''}, next income ${nextIncome}): it can lose at most ${killed + left} armies (${killed} killed taking it, ${left} left on ${falls.map((e) => label(e.id)).join(', ')}), no more than the +${b.value} it pays next turn (#422).`;
          payback.push({ line, bonusId: b.id, falls: falls.map((e) => e.id) });
          continue;
        }
      }
      const worst = [...exposed].sort((a, b) => b.added - a.added || b.need - a.need || a.id - b.id)[0]!;
      const head = `completing ${bonusName(b.id)} leaves ${label(worst.id)} indefensible (player ${worst.player} can take it for ${worst.take}; next income ${nextIncome})`;
      if (guarded) {
        if (!notCompleted.has(b.id)) {
          notCompleted.set(b.id, {
            warning: `${head}: not completed`,
            why: `Do not complete bonus ${bonusName(b.id)}: holding its frontier next turn needs ${total} more armies (${exposed.map((e) => `${label(e.id)} ${e.added}`).join(', ')})${before ? `, on top of the ${before} this turn's other completions need` : ''}, more than the next income of ${nextIncome}${held ? ` plus the ${Math.min(spare, held)} left this turn` : ''}, so it would fall next turn; the armies stay for defence.`,
          });
        }
        ok = false;
      } else {
        const w = `${head}: completed anyway (goal ${goal} ignores defence)`;
        if (!warnings.includes(w)) warnings.push(w);
      }
    }
    if (ok)
      for (const x of payback) {
        if (!rationale.includes(x.line)) rationale.push(x.line);
        for (const f of x.falls) ps.paybackFalls.set(f, x.line);
        ps.paybackBonuses.set(x.bonusId, x.line);
      }
    return ok;
  };

  // ---- No-Split: the whole stack moves (#124) ----
  /**
   * No-Split (#124): an order sends `x`'s whole stack, so only the guard (and armies withdrawn into
   * it) stay. `x` must hold — it issues no order — when it protects something (a bonus, income, my
   * commander), is not conceded, and what stays would fall to the visible threat left once this
   * turn's captures land. The target `t` stops threatening only when the `sent` armies take it for
   * sure even if its owner deploys there first. `null` when the order may go (always with No-Split off).
   */
  const mustHold = (x: number, t: number, sent: number): MustHold | null => {
    if (!noSplit || conceded.has(x)) return null;
    const value = valueOf(x);
    if (value <= 0 && !myCommanders.has(x)) return null;
    const st = state.get(t);
    const owner = st?.owner.kind === 'player' && foe(st.owner.playerId) ? st.owner.playerId : undefined;
    const sure = owner === undefined || (captureCost(defenceAt(t) + deployOf(owner), s) ?? Infinity) <= sent;
    const b = borderAt(x, (n) => captured.has(n) || ps.assumeGone(n) || (n === t && sure));
    if (!b) return null;
    const stays = guard + (incoming.get(x) ?? 0);
    if ((toTake(stays + unitsAt(x)) ?? Infinity) > b.threat) return null;
    return { from: x, value, stays, threat: b.threat };
  };
  /** A No-Split warning: `h.from` must hold, so `what` is not planned. Never repeated. */
  const warnHold = (h: MustHold, what: string) => {
    const w = `No-Split: ${label(h.from)} must hold (${h.value > 0 ? `protects +${h.value}` : 'my commander stands there'}): an order would send its whole stack, leaving ${h.stays} against the ~${h.threat} threat, so ${what}.`;
    if (!warnings.includes(w)) warnings.push(w);
  };
  return { notCompleted, defensible, mustHold, warnHold };
}

/** The capture helper (tryCapture) and combined (multi-source) captures (R4, rule 3a). */
export function captureHelper(
  pc: PlanCtx,
  ps: PlanState,
  pass: TwoStepPass,
  book: DeployBook,
  threats: Threats,
  hd: Holds,
  tgt: Targets,
  prev: ReturnType<typeof captureRules>,
) {
  const {
    g, s, reserve, label, bonusName, mine, mineSet, armiesOf, unitsAt, defenceAt, rates, chanceOf, luck, noSplit,
    myCommanders, armiesBehind, costAt, toTake,
  } = pc;
  const {
    warnings, rationale, deployed, avail, locked, spared, captured, combined, moves, survivorsAt, captureOrder,
    captureUndo, incoming,
  } = ps;
  const { coverOf, orderOf, warnSplit, deploy, spareAt, local } = book;
  const { borderAt, safeAtStart, holdArmies } = threats;
  const { conceded, heldBorders, keepFor, stayAt, twoStepBound, twoStepCite, twoStepHold, twoStepKeep } = hd;
  const { targets, leadSteps, leadTry, leadNote, skipOffence, badTrades, repulsed } = tgt;
  const { defensible, mustHold, warnHold } = prev;
  // ---- capture helper ----
  /** How far a combined capture of a player's territory trades below even (see `ps.evenTradesOnly`). */
  let belowEven: { lost: number; killed: number } | undefined;
  /** #214 review: the last {@link tryCombined} built a combined capture and R3 refused it. */
  let combinedR3 = false;
  /** #214 review: bare steps are tried in this run (planTurn's check run turns them off). */
  const bareOn = !pass.shared.noBare;
  /**
   * #214 review: lead steps captured at their bare cost (some may be undone later), for planTurn's
   * check that they cost no hold, and the entry each one's failed sure try left in `leadTry`.
   */
  const bareTaken = new Set<number>();
  /**
   * Armies on my `x` free to attack `t`: my commander's territory keeps what holds it (rule 1k),
   * and so does a border that held at the start of the turn and is not conceded (#121: one surplus
   * per territory — a capture never spends the garrison that holds a safe border).
   */
  const movableFor = (x: number, t: number) => avail.get(x)! - keepOf(x, t);
  /**
   * What `x` keeps back from an attack on `t` (see {@link movableFor}), and (#172) what a stack two
   * steps away needs it to keep — the larger, never both; an attack on the territory in between
   * cuts that reach.
   */
  const keepOf = (x: number, t: number) => {
    const near = myCommanders.has(x) || (!ps.spendKeeps && safeAtStart.has(x) && !conceded.has(x)) ? keepFor(x, (n) => n === t) : 0;
    const far = ps.spendKeeps || pass.relaxAttacks ? 0 : twoStepKeep(x, (n) => n === t);
    if (far > near) twoStepBound.add(x);
    // #179: a covered exit keeps its cover whatever the pass (conceded or not, keeps spent or not).
    return Math.max(near, far, coverOf(x));
  };
  /**
   * #214: the other members a completion in progress (pass 1, all or nothing) plans this turn. A
   * step from a conceded border that completes a bonus together with them is covered by #122's
   * exception: if any of them fails, the whole completion is undone.
   */
  const siblings = new Set<number>();
  /**
   * A conceded border attacks out only with the armies already on it (it is never deployed to),
   * unless every territory I hold is conceded, when there is nowhere better, or (#122) the capture
   * completes a bonus the border is in — with the members already taken or (#214) the sibling
   * steps the same completion plans: rule 1c then keeps it, so it is not given up.
   */
  const concededSourceBase = (x: number, t: number, cost: number) =>
    movableFor(x, t) >= cost ||
    mine.every((id) => conceded.has(id)) ||
    g.map.bonuses.some((b) => {
      const ts = bonusTerritories(g, b.id);
      return (
        b.value > 0 &&
        ts.includes(x) &&
        ts.includes(t) &&
        ts.every((y) => y === t || mineSet.has(y) || captured.has(y) || siblings.has(y))
      );
    });
  /**
   * #214: a lead step (#203) may be funded from this turn's deploy on a conceded border too, as
   * #212 lets it attack out of a held one: the deploy there is sized for the attack and leaves
   * with it (the border stays conceded: nothing is spent on its hold). Left out, the closest
   * bonus's enemy member beside a conceded border had no source at all, and the deploy went to a
   * farther bonus. Never my commander's territory (rule 1k: it is never conceded either).
   */
  const leadConceded = (x: number, t: number) => leadSteps.has(t) && conceded.has(x) && !myCommanders.has(x);
  /**
   * #214: lead steps captured on that allowance alone (a conceded source funded from this turn's
   * deploy, the capture completing nothing it is in). Pass 2 tries the bonus's completion before
   * taking one alone.
   */
  const fundedOnConceded = new Set<number>();
  const concededSource = (x: number, t: number, cost: number) => concededSourceBase(x, t, cost) || leadConceded(x, t);
  /**
   * #212: a lead step (#203) may attack out of a border held under `balanced` — locked so its armies
   * stay put for its hold — when this turn's deploy covers the attack and the hold together. Left
   * locked, the closest bonus's enemy member beside a held stack had no source at all, and the
   * deploy went to a farther bonus. Never my commander's territory (rule 1k: nothing leaves it).
   */
  const holdSource = (x: number, t: number) => leadSteps.has(t) && locked.has(x) && !conceded.has(x) && !myCommanders.has(x);
  /**
   * What a held border `x` keeps once the lead step on `t` leaves (in `avail` terms; it may exceed
   * the armies there: the deploy covers the rest): what holds it against the threat left once `t`
   * is taken, and at least what {@link keepOf} keeps.
   */
  const holdKeep = (x: number, t: number) => {
    const b = borderAt(x, (n) => captured.has(n) || n === t);
    const need = b ? Math.max(0, holdArmies(b.threat) - unitsAt(x)) : 0;
    return Math.max(need - (stayAt(x) - avail.get(x)!), keepOf(x, t));
  };
  /**
   * #416: under #319's bind (plan/spread-bind.ts), `x` beside the nearest bonus's missing members may not attack
   * `t` unless `t` is a member of that bonus.
   */
  const barred = (x: number, t: number) => ps.bind !== undefined && ps.bind.from.has(x) && !ps.bind.members.has(t);
  /** Enemy commanders' territories attacked as a commander strike (rule 1s): exempt from R3. */
  const strikes = new Set<number>();
  /** #272: captures out of a conceded border into a bonus (plan/conceded-out.ts), which R3 does not refuse. */
  const r3Exempt = new Set<number>();
  /**
   * Defenders assumed at a target attacked to finish its owner off: its armies plus that
   * owner's full deploy estimate (the worst case). Other targets: their armies now.
   */
  const worstCase = new Map<number, number>();
  /** Players this plan eliminates (rule 1e, every territory taken for sure), for the move-order caveat (#127). */
  const finishedOff = new Set<number>();
  const defendersAt = (t: number) => worstCase.get(t) ?? defenceAt(t);
  /**
   * #240 review: the defenders a capture's survivors and trade are judged against. A repulsed
   * territory sized for its owner's deploy (its worst case, so no "assumes" warning) is judged against
   * the defenders there now, as the plan without the evidence judges it — whose #120 sizing adds
   * survivors over those same defenders — so the evidence changes what is sent, never how the
   * capture ranks or whether R3 keeps it. Every other target: {@link defendersAt}.
   */
  const defendersSeen = (t: number) => {
    const rep = leadSteps.has(t) ? undefined : repulsed.get(t);
    return rep && worstCase.get(t) === rep.defenders + rep.extra ? defenceAt(t) : defendersAt(t);
  };
  /**
   * Capture `t` from its best source. A conceded border is never deployed to: it attacks
   * out only with the armies already on it (unless every territory I hold is conceded,
   * when there is nowhere better). `force` names the source (it may be locked) and the
   * armies on it that stay out of the attack. `fromConceded` (rule 4e only) names the one conceded
   * border that may attack out with deploys too: they leave with the attack. `bare` (#214): a lead
   * step toward the closest bonus or in a completion, which may be retried at its bare cost.
   */
  const tryCapture = (
    t: number,
    reason: string,
    force?: { from: number; keep: number },
    fromConceded?: number,
    bare = false,
  ): boolean => {
    // B2 (T1): a truce's covered territory is never captured, whichever pass asks.
    if (pc.truce.noTarget(t)) return false;
    // #203: a lead step lands even if its owner deploys there first (its survivors counted so) —
    // assumed while it is tried, kept only when it is taken.
    const lead = leadSteps.get(t);
    // #240: a territory my attacks failed on repeatedly, its owner reinforcing it, is sized the same way.
    // #240 review: not while rule 4e's contact ranking tries it at its plain size (ps.plainRepulsed).
    const rep = lead === undefined && !ps.plainRepulsed ? repulsed.get(t) : undefined;
    // #272 review: a repulsed size below the owner's deploy estimate is sent, but is no worst case.
    const sized = lead ?? (rep?.sure ? rep : undefined);
    const fresh = !worstCase.has(t);
    const sure = sized !== undefined && fresh;
    if (sure) worstCase.set(t, sized.defenders + sized.extra);
    shortAt = undefined;
    belowEven = undefined;
    combinedR3 = false;
    // #240 review: the target ranks on its plain cost; the capture sends at least the sure size
    // (finish-off may size it larger itself), and is not made when that does not fit.
    const ranked = targets.get(t)!;
    if (rep && rep.cost > ranked.cost) targets.set(t, { ...ranked, cost: rep.cost });
    let ok = captureOnce(t, reason, force, fromConceded);
    if (rep) targets.set(t, ranked);
    if (sure && !ok) worstCase.delete(t);
    // #240 review: the sure size of a repulsed territory the turn cannot fund now may still be paid
    // from the leftover, as the plan without the evidence pays its #120 sizing (after the holds and the
    // reserve). When the source's armies and the whole budget could reach it, the capture is taken at
    // its plain size, pending: planTurn drops it once the margin has run if it is still short of the
    // sure size. A refusal (R3, a trade, a hold) stands, as for the sure try.
    const shortNow = shortAt as Omit<Extract<LeadTry, { kind: 'short' }>, 'kind'> | undefined;
    if (
      rep &&
      fresh &&
      !ok &&
      shortNow?.from !== undefined &&
      shortNow.spare + Math.max(0, ps.budget) >= rep.cost &&
      ps.refusal === undefined &&
      belowEven === undefined &&
      !combinedR3
    ) {
      shortAt = undefined;
      ok = captureOnce(t, reason, force, fromConceded);
      if (ok) ps.repulsedPending.add(t);
    }
    // #214: a step toward the closest bonus (or in a completion) the turn cannot fund at its sure
    // cost is retried at its bare cost — a sure capture of the defenders standing there now, the
    // basis rule 4f ranks the bonuses on. No worst case: #120's warning then says what it faces if
    // the owner deploys there first. Never a territory my attacks failed on repeatedly (#240 review:
    // it is attacked only at the size that lands). Only a funding shortfall retries (an R3 or trade refusal of the
    // sure step stands), and the target keeps its sure cost for every later try.
    // #214 review: shortAt is set before tryCombined runs, so a combined capture refused for a
    // below-even trade (belowEven) or by R3 (combinedR3, which sets no refusal) is a refusal too.
    if (bareOn && lead !== undefined && !repulsed.has(t) && sure && bare && !ok && shortAt !== undefined && ps.refusal === undefined && belowEven === undefined && !combinedR3) {
      const tg = targets.get(t)!;
      const cheap = costAt(t);
      const note = leadNote(t);
      if (cheap !== null && cheap < tg.cost && reason.endsWith(note)) {
        targets.set(t, { ...tg, cost: cheap });
        shortAt = undefined;
        ok = captureOnce(t, reason.slice(0, reason.length - note.length) + leadNote(t, tg.cost), force, fromConceded);
        targets.set(t, tg);
        if (ok) bareTaken.add(t);
      }
    }
    if (lead) {
      // Set inside captureOnce (control flow does not see it).
      const short = shortAt as Omit<Extract<LeadTry, { kind: 'short' }>, 'kind'> | undefined;
      const r = ps.refusal;
      if (ok) leadTry.delete(t);
      else if (r?.kind === 'r3') leadTry.set(t, { kind: 'r3' });
      else if (r?.kind === 'trade') leadTry.set(t, { kind: 'trade', lost: r.lost, killed: r.killed });
      else if (short) leadTry.set(t, { kind: 'short', ...short });
    }
    return ok;
  };
  /**
   * #203: the source the last {@link captureOnce} found short, what it could spare and what deploy
   * could reach it then; #212: for a held border, `hold` is what its hold still lacked (its spare is 0).
   */
  let shortAt: Omit<Extract<LeadTry, { kind: 'short' }>, 'kind'> | undefined;
  const captureOnce = (
    t: number,
    reason: string,
    force?: { from: number; keep: number },
    fromConceded?: number,
  ): boolean => {
    ps.refusal = undefined;
    fundedOnConceded.delete(t);
    if (spared.has(t)) return false;
    const tg = targets.get(t)!;
    // My commander's territory keeps what holds it (rule 1k). Under No-Split nothing is kept: the
    // whole stack moves, and a territory that must hold issues no order (#124).
    const spare = (x: number) =>
      noSplit
        ? avail.get(x)!
        : force
          ? avail.get(x)! - Math.max(force.keep, coverOf(x))
          : holdSource(x, t)
            ? avail.get(x)! - holdKeep(x, t)
            : movableFor(x, t);
    if (force && orderOf(force.from)) return false;
    // #416: under #319's bind, never from beside the nearest bonus's missing members (plan/spread-bind.ts).
    if (force && barred(force.from, t)) return false;
    /** No-Split: why `x` must hold instead (it would send at least the capture's cost). */
    const held = (x: number) => mustHold(x, t, Math.max(avail.get(x)!, tg.cost));
    if (force) {
      // The caller says why (another source may still take it).
      const h = held(force.from);
      if (h) {
        ps.refusal = { kind: 'must-hold', ...h };
        return false;
      }
    }
    const open = (x: number) =>
      (!locked.has(x) || (!force && holdSource(x, t))) && (!conceded.has(x) || x === fromConceded || concededSource(x, t, tg.cost));
    // No-Split (#124): a covered exit (#179) issues no order — it would send its whole stack.
    const usable = (x: number) => open(x) && !held(x) && !(noSplit && coverOf(x) > 0) && !barred(x, t);
    const sources = force
      ? [force.from]
      : tg.sources.filter((x) => usable(x) && !orderOf(x)).sort((a, b) => avail.get(b)! - avail.get(a)! || a - b);
    const needAt = (x: number) => Math.max(0, tg.cost - spare(x));
    // Sorted by armies, the first source needs the fewest deploys; under Local Deployment
    // another may have more room (its bonus pool), so take the first that can afford it. #212: a
    // held border's armies are not all free, so a lead step takes the first source that can afford
    // it, else the one needing the fewest deploys.
    const src =
      local || leadSteps.has(t)
        ? (sources.find((x) => needAt(x) <= spareAt(x)) ??
          (leadSteps.has(t) ? [...sources].sort((a, b) => needAt(a) - needAt(b) || a - b)[0] : sources[0]))
        : sources[0];
    const need = src === undefined ? Infinity : needAt(src);
    // No single source can afford it: try a combined capture (never for a forced source).
    if (src === undefined || need > spareAt(src)) {
      shortAt =
        src === undefined
          ? {
              spare: 0,
              reach: 0,
              // #212: why no neighbour could attack it, for the skip line.
              ...(leadSteps.has(t)
                ? {
                    blocked: [...tg.sources].sort(byNum).map((x) => ({
                      from: x,
                      why: (myCommanders.has(x)
                        ? 'commander'
                        : orderOf(x)
                          ? 'order'
                          : // Unreachable today: a locked border left is a holdSource (so open), a
                            // conceded one is funded from deploy (#214), and only No-Split fails
                            // `usable` otherwise, which turns lead steps off. Kept so the label
                            // stays exhaustive if that ever changes.
                            'locked') as LeadBlock,
                    })),
                  }
                : {}),
            }
          : {
              from: src,
              spare: Math.max(0, spare(src)),
              reach: Math.max(0, spareAt(src)),
              ...(holdSource(src, t) && spare(src) < 0 ? { hold: -spare(src) } : {}),
            };
      if (force) return false;
      if (tryCombined(t, reason)) return true;
      const trade = belowEven;
      // No-Split: name a source that could have taken it alone but already issues an order.
      // Its order already carries its whole stack (#124): count that stack as what it could have sent.
      const split = tg.sources.find(
        (x) => usable(x) && orderOf(x) && Math.max(0, needAt(x) - orderOf(x)!.armies) <= spareAt(x),
      );
      // No-Split: or one that could, but must hold its border (#124).
      const holder = split === undefined ? tg.sources.find((x) => open(x) && !orderOf(x) && held(x) && needAt(x) <= spareAt(x)) : undefined;
      if (split !== undefined) {
        warnSplit(split, `the attack on ${label(t)} is not planned`);
        ps.refusal = { kind: 'split', from: split };
      } else if (holder !== undefined) {
        const h = held(holder)!;
        warnHold(h, `the attack on ${label(t)} is not planned`);
        ps.refusal = { kind: 'must-hold', ...h };
      } else if (trade) ps.refusal = { kind: 'trade', ...trade };
      return false;
    }
    // #121: the deploys beyond what the attack alone needs keep a safe border holding.
    // #212: a held border's are what it keeps for its hold.
    const fromHold = !force && holdSource(src, t);
    const forHold = noSplit || force || fromHold ? 0 : Math.min(need, keepOf(src, t));
    // #172: the source keeps what a stack two steps away needs (when that binds, not its border's hold).
    const far = noSplit || force || ps.spendKeeps || pass.relaxAttacks ? null : twoStepHold(src, (n) => n === t);
    const farKeep = far ? twoStepKeep(src, (n) => n === t) : 0;
    const farBinds = far !== null && farKeep > 0 && farKeep >= keepOf(src, t);
    // #214: judged on the state the source was opened under, before the attack spends it.
    const viaLead = !fromHold && !force && need > 0 && src !== fromConceded && leadConceded(src, t) && !concededSourceBase(src, t, tg.cost);
    deploy(src, need);
    // No-Split: the whole stack goes, every army deployed there so far included (#124).
    const sent = noSplit ? Math.max(tg.cost, avail.get(src)!) : tg.cost;
    avail.set(src, avail.get(src)! - sent);
    captured.add(t);
    const survivors = sent - straightKills(defendersSeen(t), rates.defensiveKillRate);
    // A commander strike is never refused by R3: killing the commander eliminates a player.
    if (!strikes.has(t) && !r3Exempt.has(t) && !defensible(t, survivors, sent - survivors)) {
      // Undo: under a guarded goal a bonus that falls next turn is not completed.
      avail.set(src, avail.get(src)! + sent - need);
      const left = (deployed.get(src) ?? 0) - need;
      if (left > 0) deployed.set(src, left);
      else deployed.delete(src);
      ps.budget += need;
      captured.delete(t);
      ps.refusal = { kind: 'r3' };
      return false;
    }
    survivorsAt.set(t, survivors);
    captureOrder.push(t);
    captureUndo.set(t, () => avail.set(src, avail.get(src)! + sent));
    moves.push({ from: src, to: t, armies: sent, kind: 'attack', reason, winChance: chanceOf(sent, defenceAt(t)) });
    if (tg.enemy && !worstCase.has(t))
      warnings.push(`Attack on enemy ${label(t)} assumes its owner does not reinforce it first.`);
    rationale.push(
      `Attack ${label(t)} from ${label(src)} with ${sent}${need ? ` (deploy ${need} there)` : ''}${
        sent > tg.cost ? `, the whole stack (No-Split; ${tg.cost} would take it)` : ''
      }: ${reason}.`,
    );
    if (fromHold) {
      // #212: the deploy garrisons it too: its hold is funded (no hold pass deploys there again).
      heldBorders.add(src);
      const th = borderAt(src, (n) => captured.has(n));
      if (th)
        rationale.push(
          `${label(src)} keeps ${stayAt(src)} to hold its border against the ~${th.threat} threat once the attack on ${label(t)} leaves: it is held, and the deploy covers the attack and the hold together (#212).`,
        );
    } else if (viaLead) {
      fundedOnConceded.add(t);
      rationale.push(
        `${label(src)} is conceded, but the deploy there leaves with the attack on ${label(t)}: a lead step into a bonus (rule 4f's order) may be funded on a conceded source, the deploy sized for the attack alone (#214).`,
      );
    } else if (farBinds) rationale.push(twoStepCite(src, far!, (c) => `The attack on ${label(t)} leaves ${label(src)} ${c}.`));
    else if (forHold > 0) {
      const th = borderAt(src, (n) => captured.has(n));
      if (th)
        rationale.push(
          `Deploy ${forHold} to ${label(src)} so it still holds its border after the attack on ${label(t)} (${stayAt(src)} stay against a threat of ${th.threat}).`,
        );
    }
    return true;
  };
  if (reserve) rationale.push(`Hold a reserve of ${reserve} out of captures.`);

  // ---- 3a. combined (multi-source) captures (R4) ----
  /**
   * The cheapest combined capture of `t` (fewest sources) under exact 0%-luck,
   * straight-round arithmetic, or `null` when even every eligible source together
   * (plus the deploys left) cannot take it.
   */
  const combinedPlan = (t: number): Combined | null => {
    const tg = targets.get(t)!;
    // A commander takes no partial damage, so softening one is not plain arithmetic: never combined.
    if (unitsAt(t) > 0) return null;
    const eligible = tg.sources
      .filter(
        (x) =>
          !locked.has(x) &&
          !conceded.has(x) &&
          !myCommanders.has(x) &&
          !barred(x, t) &&
          avail.get(x)! > 0 &&
          !orderOf(x) &&
          !(noSplit && coverOf(x) > 0) &&
          !mustHold(x, t, avail.get(x)!),
      )
      .sort((a, b) => avail.get(b)! - avail.get(a)! || a - b);
    const off = rates.offensiveKillRate;
    const def = rates.defensiveKillRate;
    for (let k = 2; k <= eligible.length; k++) {
      const finisher = eligible[0]!;
      let left = defendersAt(t);
      // The defenders there now: under a worst case (more assumed) a softener must not take
      // it either if the reinforcement never comes.
      let real = armiesOf(t);
      const softeners: Softener[] = [];
      for (const x of eligible.slice(1, k).sort(byNum)) {
        // Never kill the last defender: the finisher's attack is the one that moves in. Under
        // No-Split the whole stack goes (#124): a stack that would kill the last one is no softener.
        // #121: a safe border keeps what holds it (its survivors come home, but may arrive late).
        let a = noSplit ? avail.get(x)! : Math.min(avail.get(x)!, movableFor(x, t));
        while (a > 0 && straightKills(a, off) >= Math.min(left, real)) {
          if (noSplit) a = 0;
          else a--;
        }
        const kills = straightKills(a, off);
        if (a <= 0 || kills <= 0) continue;
        const lost = Math.min(a, straightKills(left, def));
        softeners.push({ from: x, armies: a, kills, before: left, survivors: a - lost });
        left -= kills;
        real -= kills;
      }
      if (!softeners.length) continue;
      const take = armiesToTake(left, rates);
      if (take === null) return null;
      // No-Split: the finisher sends its whole stack too.
      const armies = noSplit ? Math.max(take, avail.get(finisher)!) : take;
      // #121: the finisher keeps what holds a safe border too; deploys cover the rest.
      const need = Math.max(0, armies - (noSplit ? avail.get(finisher)! : movableFor(finisher, t)));
      if (need > spareAt(finisher)) continue;
      const survivors = armies - straightKills(left, def);
      return { softeners, finisher, armies, need, left, survivors };
    }
    return null;
  };
  const tryCombined = (t: number, reason: string): boolean => {
    belowEven = undefined;
    combinedR3 = false;
    const plan = combinedPlan(t);
    if (!plan) return false;
    const tg = targets.get(t)!;
    const n = plan.softeners.length + 1;
    if (luck > 0 || (s.roundingMode !== undefined && s.roundingMode !== 'StraightRound')) {
      const why = luck > 0 ? `luck is ${Math.round(luck * 100)}%` : `this game uses ${s.roundingMode} rounding`;
      const w = `Multi-source capture of ${label(t)} skipped: no single source can afford its ${tg.cost}, and ${n} sources together could only at 0% luck under straight rounding, but ${why}.`;
      if (!warnings.includes(w)) warnings.push(w);
      return false;
    }
    // Rule 0p.3 (#72): behind on armies, no trade below even. The softeners lose more than
    // they kill by design (each attacks a stack larger than it can take), so a combined capture
    // of a player's territory can lose more than the whole stack it destroys.
    // Rule 4e in contact (#107) asks the same of its enemy captures.
    const even = (armiesBehind || ps.evenTradesOnly) && tg.enemy;
    if (even) {
      const lost =
        plan.softeners.reduce((n, x) => n + x.armies - x.survivors, 0) + plan.armies - plan.survivors;
      const killed = plan.softeners.reduce((n, x) => n + x.kills, 0) + plan.left;
      if (lost > killed) {
        if (armiesBehind) {
          if (!badTrades.has(t)) badTrades.set(t, { lost, killed });
          skipOffence(t, `a trade below even while behind on armies (loses ${lost} for ${killed})`);
        }
        belowEven = { lost, killed };
        return false;
      }
    }
    // #265 review: what each source keeps back from this attack (#121, #172, #179), read before the
    // capture lands, so a later rebalance never spends it. Not under No-Split: the rebalance never
    // runs there, no keep sizes a whole-stack order, and reading one marks a two-step hold that
    // shaped nothing as binding (keepOf records it for the report).
    const keeps = noSplit
      ? new Map<number, number>()
      : new Map([...plan.softeners.map((x) => x.from), plan.finisher].map((x) => [x, keepOf(x, t)] as const));
    const before = { avail: new Map(avail), incoming: new Map(incoming), deployed: new Map(deployed), budget: ps.budget };
    deploy(plan.finisher, plan.need);
    for (const x of plan.softeners) {
      avail.set(x.from, avail.get(x.from)! - x.armies);
      incoming.set(x.from, (incoming.get(x.from) ?? 0) + x.survivors);
    }
    avail.set(plan.finisher, avail.get(plan.finisher)! - plan.armies);
    captured.add(t);
    // #422: what the combined capture loses — every softener's dead and the finisher's.
    const lost = plan.softeners.reduce((n, x) => n + x.armies - x.survivors, 0) + plan.armies - plan.survivors;
    if (!defensible(t, plan.survivors, lost)) {
      for (const [k, v] of before.avail) avail.set(k, v);
      incoming.clear();
      for (const [k, v] of before.incoming) incoming.set(k, v);
      deployed.clear();
      for (const [k, v] of before.deployed) deployed.set(k, v);
      ps.budget = before.budget;
      captured.delete(t);
      combinedR3 = true;
      return false;
    }
    survivorsAt.set(t, plan.survivors);
    combined.add(t);
    captureOrder.push(t);
    captureUndo.set(t, () => {
      for (const x of plan.softeners) {
        avail.set(x.from, avail.get(x.from)! + x.armies);
        incoming.set(x.from, (incoming.get(x.from) ?? 0) - x.survivors);
      }
      avail.set(plan.finisher, avail.get(plan.finisher)! + plan.armies);
    });
    for (const x of plan.softeners)
      moves.push({
        from: x.from,
        to: t,
        armies: x.armies,
        kind: 'attack',
        reason: `wears ${label(t)} down for a combined capture (${reason})`,
        winChance: chanceOf(x.armies, x.before),
      });
    moves.push({
      from: plan.finisher,
      to: t,
      armies: plan.armies,
      kind: 'attack',
      reason,
      winChance: chanceOf(plan.armies, plan.left),
    });
    if (tg.enemy && !worstCase.has(t))
      warnings.push(`Attack on enemy ${label(t)} assumes its owner does not reinforce it first.`);
    const order = [...plan.softeners.map((x) => x.from), plan.finisher].map(label).join(', then ');
    warnings.push(
      `The capture of ${label(t)} combines ${n} attacks that must run in this order (${order}): the first ${n === 2 ? 'one fails' : `${n - 1} fail`} by design, only wearing the defenders down; the arithmetic is exact only at 0% luck under straight rounding.`,
    );
    rationale.push(combinedLine(t, plan, reason));
    combinedPlans.set(t, { plan, reason, start: defendersAt(t), real: armiesOf(t), keeps, even });
    return true;
  };
  /** The rationale line of a combined capture (rule 3a). */
  const combinedLine = (t: number, plan: Combined, reason: string) =>
    `Attack ${label(t)} with ${plan.softeners.length + 1} attacks (no single source can afford its ${targets.get(t)!.cost}): ${plan.softeners
      .map((x) => `from ${label(x.from)} with ${x.armies} (kills ${x.kills} of ${x.before}; ${x.survivors} survive and stay)`)
      .join(', then ')}, then from ${label(plan.finisher)} with ${plan.armies}${plan.need ? ` (deploy ${plan.need} there)` : ''}, taking the last ${plan.left}: ${reason}.`;
  /**
   * #265: each combined capture as built — the defenders it was sized on (`start`; `real`, those
   * standing there now), what each source kept back from it (`keeps`: keepOf, #121/#172/#179; empty under No-Split) and
   * whether it had to trade at least even (`even`, rule 0p.3 / 4e) — for {@link rebalanceCombined}.
   * An entry whose moves have changed since (a restore, a capture undone) is ignored there.
   */
  const combinedPlans = new Map<
    number,
    { plan: Combined; reason: string; start: number; real: number; keeps: Map<number, number>; even: boolean }
  >();
  /**
   * #265: once the captures are known, a combined capture one of whose sources is a weak member of
   * a bonus this turn completes (`weakMember`, plan/completed.ts) is rebalanced at the same kills to
   * leave armies on it: every split of the same sources that still takes the target — each softener
   * killing fewer than the defenders it meets, the finisher taking the rest with no new deploy,
   * landing at least as many survivors — and leaves every other source as it held (never below
   * what it kept back when the capture was built — the #121 safe-border keep, the #172 two-step
   * hold, the #179 cover — and a border that held after the captures still holds), never trading
   * below even where the capture had to (rule 0p.3 / 4e), is judged by the armies it leaves on the
   * weak members up to their holds, then the smallest change, then the fewest armies lost: once the
   * members hold, no more is moved. Only one that leaves them more is taken. Live, a 14 + 18 capture could have been 15 + 17
   * for the same kills and left its 1-army member beside an enemy that could deploy 5 one more army.
   * Never under No-Split (each order sends its whole stack) and only at the 0%-luck straight-round
   * arithmetic a combined capture is built on. `stays` is planPass's view of a territory's armies.
   */
  const rebalanceCombined = (
    weakMember: (id: number) => { threat: number; need: number; bonusId: number } | undefined,
    stays: (id: number) => number,
  ) => {
    if (noSplit) return;
    const off = rates.offensiveKillRate;
    const def = rates.defensiveKillRate;
    for (const t of [...combined].sort(byNum)) {
      const rec = combinedPlans.get(t);
      if (!rec || !captured.has(t)) continue;
      const { plan, reason, start, real, keeps, even } = rec;
      const attackOf = (from: number, armies: number) =>
        moves.find((m) => m.kind === 'attack' && m.to === t && m.from === from && m.armies === armies);
      const softMoves = plan.softeners.map((x) => attackOf(x.from, x.armies));
      const finMove = attackOf(plan.finisher, plan.armies);
      if (!finMove || softMoves.some((m) => !m)) continue;
      if (moves.filter((m) => m.kind === 'attack' && m.to === t).length !== plan.softeners.length + 1) continue;
      const sources = [...plan.softeners.map((x) => x.from), plan.finisher];
      const weak = new Map(sources.flatMap((x) => {
        const w = weakMember(x);
        return w ? [[x, w] as const] : [];
      }));
      if (!weak.size) continue;
      const orig = new Map([...plan.softeners.map((x) => [x.from, x.armies] as const), [plan.finisher, plan.armies] as const]);
      const origSurv = new Map(plan.softeners.map((x) => [x.from, x.survivors] as const));
      const staysNow = new Map(sources.map((x) => [x, stays(x)] as const));
      /** A source's armies after a split: `sent` out, `back` of its softener survivors home. */
      const after = (x: number, sent: number, back: number) => staysNow.get(x)! - (sent - orig.get(x)!) + (back - (origSurv.get(x) ?? 0));
      /** Whether a source other than a weak member is left as it held: never weaker, or still holding (what it sends is capped by `cap`). */
      const fine = (x: number, left: number) => {
        if (left >= staysNow.get(x)!) return true;
        const b = borderAt(x, (n) => captured.has(n));
        if (!b) return true;
        const held = (toTake(staysNow.get(x)! + unitsAt(x)) ?? Infinity) > b.threat;
        return held && (toTake(left + unitsAt(x)) ?? Infinity) > b.threat;
      };
      const kept = (x: number, left: number) => Math.min(left, staysNow.get(x)! + weak.get(x)!.need);
      // A weak member never sends more (judge refuses it); any other source spends only what it
      // did not keep back when the capture was built.
      const cap = (x: number) => orig.get(x)! + (weak.has(x) ? avail.get(x)! : Math.max(0, avail.get(x)! - keeps.get(x)!));
      type Split = { soft: Softener[]; armies: number; left: number; survivors: number; score: number; lost: number; change: number };
      const judge = (soft: Softener[], armies: number, left: number): Split | null => {
        const survivors = armies - straightKills(left, def);
        if (survivors < plan.survivors) return null;
        let score = 0;
        let lost = armies - survivors;
        let change = Math.abs(armies - plan.armies);
        for (const x of [...soft.map((y) => ({ from: y.from, sent: y.armies, back: y.survivors })), { from: plan.finisher, sent: armies, back: 0 }]) {
          const left2 = after(x.from, x.sent, x.back);
          if (weak.has(x.from)) {
            if (left2 < staysNow.get(x.from)!) return null;
            score += kept(x.from, left2);
          } else if (!fine(x.from, left2)) return null;
        }
        for (const y of soft) {
          lost += y.armies - y.survivors;
          change += Math.abs(y.armies - orig.get(y.from)!);
        }
        // Every split kills all `start` defenders.
        if (even && lost > start) return null;
        return { soft, armies, left, survivors, score, lost, change };
      };
      const better = (a: Split, b: Split | null) =>
        !b || a.score > b.score || (a.score === b.score && (a.change < b.change || (a.change === b.change && a.lost < b.lost)));
      let best: Split | null = judge(plan.softeners, plan.armies, plan.left);
      if (!best) continue;
      const baseline = best.score;
      let tried = 0;
      const walk = (i: number, left: number, realLeft: number, soft: Softener[]) => {
        if (++tried > 100_000) return;
        if (i === plan.softeners.length) {
          const armies = armiesToTake(left, rates);
          if (armies === null || armies < 1 || armies > cap(plan.finisher)) return;
          const s2 = judge(soft, armies, left);
          if (s2 && better(s2, best)) best = s2;
          return;
        }
        const x = plan.softeners[i]!.from;
        for (let a = 1; a <= cap(x); a++) {
          const kills = straightKills(a, off);
          if (kills >= Math.min(left, realLeft)) break;
          if (kills <= 0) continue;
          const lost = Math.min(a, straightKills(left, def));
          walk(i + 1, left - kills, realLeft - kills, [...soft, { from: x, armies: a, kills, before: left, survivors: a - lost }]);
        }
      };
      walk(0, start, real, []);
      const chosen = best as Split | null;
      if (!chosen || chosen.score <= baseline) continue;
      // Apply: the moves, what each source has left, the survivors home and on the target.
      for (const [k, y] of chosen.soft.entries()) {
        const was = plan.softeners[k]!;
        avail.set(y.from, avail.get(y.from)! - (y.armies - was.armies));
        incoming.set(y.from, (incoming.get(y.from) ?? 0) + (y.survivors - was.survivors));
        const m = softMoves[k]!;
        m.armies = y.armies;
        m.winChance = chanceOf(y.armies, y.before);
      }
      avail.set(plan.finisher, avail.get(plan.finisher)! - (chosen.armies - plan.armies));
      finMove.armies = chosen.armies;
      finMove.winChance = chanceOf(chosen.armies, chosen.left);
      survivorsAt.set(t, chosen.survivors);
      const next: Combined = { softeners: chosen.soft, finisher: plan.finisher, armies: chosen.armies, need: plan.need, left: chosen.left, survivors: chosen.survivors };
      const line = rationale.indexOf(combinedLine(t, plan, reason));
      if (line >= 0) rationale[line] = combinedLine(t, next, reason);
      combinedPlans.set(t, { plan: next, reason, start, real, keeps, even });
      captureUndo.set(t, () => {
        for (const x of next.softeners) {
          avail.set(x.from, avail.get(x.from)! + x.armies);
          incoming.set(x.from, (incoming.get(x.from) ?? 0) - x.survivors);
        }
        avail.set(next.finisher, avail.get(next.finisher)! + next.armies);
      });
      const changed = [...next.softeners.map((x) => [x.from, x.armies] as const), [next.finisher, next.armies] as const]
        .filter(([x, a]) => a !== orig.get(x))
        .map(([x, a]) => `${label(x)} ${a}, not ${orig.get(x)}`);
      changed[0] = changed[0]!.replace(/ (\d+), not/, ' sends $1, not');
      const killed = start;
      const held = [...weak.entries()]
        .map(([x, w]) => {
          const left = stays(x);
          return `${label(x)}, a member of bonus ${bonusName(w.bonusId)} completed this turn, keeps ${left} against the ~${w.threat} threat${
            (toTake(left + unitsAt(x)) ?? Infinity) > w.threat ? ' (it holds)' : ''
          }`;
        })
        .join('; ');
      rationale.push(
        `Rebalance the combined capture of ${label(t)}: ${changed.join(', and ')} — the same ${killed} killed — so ${held}.`,
      );
    }
  };
  return { belowEven, movableFor, keepOf, concededSource, siblings, fundedOnConceded, strikes, r3Exempt, worstCase, finishedOff, defendersAt, defendersSeen, tryCapture, shortAt, captureOnce, combinedPlan, tryCombined, rebalanceCombined, bareOn, bareTaken };
}

/** Pass 1 (complete a bonus, all or nothing) and pass 2 (advance one a capture at a time, rule 4c(c), 4d). */
export function bonusPasses(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  hd: Holds,
  tgt: Targets,
  prev: ReturnType<typeof captureRules> & ReturnType<typeof captureHelper>,
) {
  const {
    g, s, guarded, capturePaybackTurns: paybackTurns, territories: state, label, bonusName, mineSet, incomeGain, incomeAfter, defenceAt,
    bonusTs, completedBy, inFocus,
  } = pc;
  const {
    warnings, rationale, deployed, avail, captured, combined, moves, survivorsAt, captureOrder, staged, incoming,
  } = ps;
  const { heldNow, gainWith } = book;
  const { heldBorders, keptIncome, stayAt } = hd;
  const {
    targets, leadSteps, leadTry, leadNote, bonusTarget, frontierDelta, targetScoreCost, frontierOf, startHold,
    toFinish, byCloseness, committing, denials, emptyEnemies,
  } = tgt;
  const { worstCase, tryCapture, siblings, fundedOnConceded, bareOn } = prev;
  // ---- pass 1: complete a bonus this turn (all or nothing) ----
  /** Snapshot the captures, deploys and notes so far; the result undoes everything since. */
  const snapshot = () => {
    const snap = {
      budget: ps.budget,
      anchor: ps.anchor,
      deployed: new Map(deployed),
      avail: new Map(avail),
      incoming: new Map(incoming),
      combined: new Set(combined),
      survivorsAt: new Map(survivorsAt),
      staged: new Map(staged),
      worstCase: new Map(worstCase),
      heldBorders: new Set(heldBorders),
      captureOrder: captureOrder.length,
      moves: moves.length,
      rationale: rationale.length,
      warnings: warnings.length,
    };
    return () => {
      ps.budget = snap.budget;
      ps.anchor = snap.anchor;
      deployed.clear();
      for (const [k, v] of snap.deployed) deployed.set(k, v);
      for (const [k, v] of snap.avail) avail.set(k, v);
      incoming.clear();
      for (const [k, v] of snap.incoming) incoming.set(k, v);
      for (const m of moves.splice(snap.moves)) captured.delete(m.to);
      combined.clear();
      for (const t of snap.combined) combined.add(t);
      survivorsAt.clear();
      for (const [k, v] of snap.survivorsAt) survivorsAt.set(k, v);

      staged.clear();
      for (const [k, v] of snap.staged) staged.set(k, v);
      // A lead step's sure sizing (#203) goes with its undone capture.
      worstCase.clear();
      for (const [k, v] of snap.worstCase) worstCase.set(k, v);
      // A held border a lead step garrisoned (#212) is owed its hold again.
      heldBorders.clear();
      for (const k of snap.heldBorders) heldBorders.add(k);
      captureOrder.length = snap.captureOrder;
      rationale.length = snap.rationale;
      warnings.length = snap.warnings;
    };
  };
  /** `last` (#214): a step the completion tries after its siblings, whatever it costs. */
  const complete = (p: BonusPlan, last?: number) => {
    if (!p.completable) return;
    const todo = p.remaining
      .filter((t) => !captured.has(t))
      .sort((a, b) => Number(a === last) - Number(b === last) || targets.get(a)!.cost - targets.get(b)!.cost || a - b);
    if (!todo.length) return;
    const first = moves.length;
    const restore = snapshot();
    const before = incomeGain(heldNow());
    const worth = p.net === p.value ? `+${p.value}` : `+${p.value}, net +${p.net}`;
    // #214: each step counts the others this completion plans (it is undone whole if one fails).
    for (const t of todo) siblings.add(t);
    const why = (t: number) => `completes bonus ${bonusName(p.bonusId)} (${worth})${leadNote(t)}`;
    let ok = todo.every((t) => tryCapture(t, why(t)));
    // #214: when the sure-sized steps cannot all be funded, the completion is tried again: every
    // step at its sure size first (one that fails is passed over), then the ones that failed with a
    // lead step retried at its bare cost — so a bare step never takes the deploy another step's
    // sure size would have had.
    if (!ok && bareOn && todo.some((t) => leadSteps.has(t))) {
      // #214 review: a retry that fails too must not leave the skip line reading a state it undid:
      // a bare step it took erased its member's "its bonus's step …" entry, and a sibling found
      // short after it was measured with that step's deploy spent. Those go back to what the sure
      // try said; a refusal the retry found (R3, a trade) stands.
      const afterSure = new Map(leadTry);
      restore();
      const failed = todo.filter((t) => !tryCapture(t, why(t)));
      let bareLanded = false;
      ok = failed.every((t) => {
        const landed = tryCapture(t, why(t), undefined, undefined, true);
        bareLanded ||= landed;
        return landed;
      });
      if (!ok)
        for (const t of todo) {
          const now = leadTry.get(t);
          const was = afterSure.get(t);
          if (now === undefined ? was !== undefined : now.kind === 'short' && bareLanded && was !== undefined) leadTry.set(t, was!);
        }
    }
    siblings.clear();
    // Rule 4c: completing it must not lower income (its members' negative bonuses included).
    if (ok && !p.focus && incomeGain(heldNow()) < before) {
      const net = incomeGain(heldNow()) - before;
      restore();
      const line = `Do not complete bonus ${bonusName(p.bonusId)} (${worth}): with this turn's other captures it changes income by ${net} (its members complete negative bonuses).`;
      // Pass 2's retry (#214) may refuse what pass 1 already did: say it once.
      if (!rationale.includes(line)) rationale.push(line);
      return;
    }
    if (ok) {
      // The leftover's expansion stack is a finisher, never a combined capture's softener: its extra
      // armies would only come home (No-Split: leave with its failing attack).
      const done = moves.slice(first);
      const finisher = done.find(
        (m, i) => m.kind === 'attack' && !done.slice(i + 1).some((o) => o.kind === 'attack' && o.to === m.to),
      );
      ps.anchor ??= (finisher ?? moves[first])?.from;
      return;
    }
    restore();
  };

  // ---- pass 2: advance a bonus one capture at a time ----
  /** Bonuses whose staging was refused (rule 4c(c)), so the rationale says it once. */
  const unstaged = new Set<number>();
  /**
   * Rule 4c(c): capturing `t` toward `p` lowers income this turn. It is a staging step, taken
   * only when the bonus completes within PAYBACK_TURNS (k turns: its other missing members'
   * capture cost / the income left after this step, rounded up, at least 1; none left:
   * refused) and the penalties until then —
   * at most k × every penalty its missing members carry — are repaid by its net worth within
   * PAYBACK_TURNS turns of completion. Returns the capture's reason and rationale line, or
   * `null` when refused.
   */
  const stage = (p: BonusPlan, t: number): { reason: string; note: string } | null => {
    const rest = p.remaining.filter((x) => x !== t && !captured.has(x));
    let restCost = 0;
    for (const x of rest) {
      const st = state.get(x);
      restCost += !st || st.owner.kind === 'unknown' || st.armies === null ? Infinity : (captureCost(defenceAt(x), s) ?? Infinity);
    }
    const penalty = p.value - p.net;
    const step = gainWith([t]);
    // The income left once this step (and this turn's other captures) lands: the staging
    // capture itself lowers it, so the turns to finish are counted at that income (#70).
    const after = incomeAfter(new Set([...heldNow(), t]));
    const turns = after > 0 ? Math.max(1, Math.ceil(restCost / after)) : Infinity;
    const interim = turns * penalty;
    if (turns <= paybackTurns && interim <= paybackTurns * p.net) {
      return {
        note: `Stage bonus ${bonusName(p.bonusId)} with ${label(t)} (${step} income until it completes): its other ${rest.length} missing member${rest.length === 1 ? '' : 's'} cost ${restCost}, ~${turns} turns at income ${after} (after this step); ${turns} turns × ${penalty} = ${interim} of penalties at most, repaid within ${paybackTurns} turns of completion (${paybackTurns} × +${p.net} = ${paybackTurns * p.net}).`,
        reason: `stages bonus ${bonusName(p.bonusId)} (+${p.value}, net +${p.net} once complete; ${step} income until then)`,
      };
    }
    if (!unstaged.has(p.bonusId)) {
      unstaged.add(p.bonusId);
      rationale.push(
        `Do not take ${label(t)} toward bonus ${bonusName(p.bonusId)}: it costs ${step} income until the bonus completes, ${
          restCost === Infinity
            ? 'and the rest of the bonus cannot be costed (fog)'
            : `~${turns} turns away (${restCost} armies at income ${after} after this step); ${turns} × ${penalty} = ${interim} of penalties is not repaid by ${paybackTurns} × +${p.net}`
        }.`,
      );
    }
    return null;
  };
  /**
   * Captures rule 4d's budget stopped, with the frontier they would have left (for the warning;
   * dropped, with their rationale lines, if a later pass takes them after all).
   */
  const stopped: { t: number; holdCost: number; income: number; deployable?: number }[] = [];
  /**
   * #281: vacated territories (and, the owner's extension, empty enemy territories on the same front)
   * rule 4d let through though they add a border facing an enemy, with the rationale line the report
   * states for each one the plan still takes.
   */
  const denied = new Map<number, string>();
  /** The start of rule 4d's rationale line for a stopped `t` (one per attempt that differed). */
  const stoppedLine = (t: number) => `Do not take ${label(t)}: it adds a border facing an enemy without completing a bonus,`;
  /**
   * #426: whether only the fog faces `t` once taken: no neighbour not mine is a player's territory shown with
   * its armies (a stack in view). A player's territory whose armies the fog hides, or one not shown at all,
   * is the fog.
   */
  const fogOnlyFaces = (t: number): boolean =>
    neighborsOf(g, t).every((n) => {
      if (mineSet.has(n)) return true;
      const st = state.get(n);
      return !(st?.owner.kind === 'player' && pc.foe(st.owner.playerId) && visibleState(st));
    });
  /**
   * Rule 4d's frontier budget, judged with `t` just captured: under a guarded goal, a capture
   * that adds a border facing an enemy without completing a bonus (and not focused) is stopped
   * when holding the frontier next turn would then need more than the next income, and more than
   * it needed at the start of the turn. Returns the rationale line when stopped, else `null`.
   */
  const outgrows = (t: number): string | null => {
    if (!guarded || inFocus(t)) return null;
    const held = heldNow();
    if (completedBy(held).some((id) => g.bonusById.get(id)!.value > 0 && bonusTs.get(id)!.includes(t))) return null;
    const stays = (x: number) => (mineSet.has(x) ? stayAt(x) : (survivorsAt.get(x) ?? 0));
    const without = new Set([...held].filter((x) => x !== t));
    if (frontierDelta(without, [t], stays).enemy <= 0) return null;
    const f = frontierOf(held, stays);
    const next = keptIncome(held);
    const start = startHold();
    if (f.holdCost <= next) return null;
    if (f.holdCost <= start) return null;
    // #281: land a static seat left, which a live stack beside it takes free next turn: the border
    // comes either way, so the hold cost alone never refuses it (the capture still spends only what
    // stands above its source's hold).
    const d = denials.get(t);
    if (d) {
      denied.set(t, denialLine(pc, t, d));
      return null;
    }
    // #281 (the owner's extension): an empty enemy territory whose border faces only what my borders
    // beside it already face moves the front one step; a border to a new stack is judged as any.
    const e = emptyEnemies.get(t);
    if (e?.sameFront) {
      denied.set(t, emptyEnemyLine(pc, t, e));
      return null;
    }
    // #426: a no-loss neutral whose new border faces only the fog (no player's territory beside it shown with
    // its armies): its hold cost prices a stack nobody has seen, and the capture risks only the armies that
    // land. Not in a 1v1, where #297's gate budget prices the one opponent's floating deploy wherever it is.
    // The owner's cap (2026-11-22): only while the hold the capture adds is at most the next income (1×);
    // over it, rule 4d decides as before (a golden synthetic board let one through at 85 against an income of 9).
    const adds = f.holdCost - frontierOf(without, stays).holdCost;
    if (adds <= next && noLossNeutral(pc, tgt, t) && fogOnlyFaces(t)) {
      denied.set(
        t,
        `Take ${label(t)} though holding the frontier next turn would then need ${f.holdCost} (the next income is ${next}): its defenders kill none of the attackers, only the fog faces its new border and the ${adds} it adds are within that income, so all it risks is the armies that land there (#426).`,
      );
      return null;
    }
    const why = `${stoppedLine(t)} and the frontier would then need ${f.holdCost} next turn to hold (${f.enemyBorders} enemy-facing borders), more than the next income of ${next} and more than the ${start} it needed at the start of the turn.`;
    if (!stopped.some((x) => x.t === t)) stopped.push({ t, holdCost: f.holdCost, income: next });
    return why;
  };
  /** #593: the bonuses this turn's captures could complete (rule 4f's plans): their steps are no dead advance. */
  const completableIds = new Set(tgt.plans.filter((p) => p.completable).map((p) => p.bonusId));
  const completableNow = (id: number) => completableIds.has(id);
  /** #593: every attack on `t` leaves a conceded border with no deploy: it spends only armies given up anyway. */
  const givenUp = (t: number) =>
    moves.every((m) => m.kind !== 'attack' || m.to !== t || (hd.conceded.has(m.from) && !(deployed.get(m.from) ?? 0)));
  /**
   * Capture `t` for expansion, unless rule 4d's frontier budget stops it (then everything is undone), or (#593) it
   * advances only bonuses whose other member this plan concedes ({@link deadAdvanceOf}).
   * `bare` (#214): a lead step toward the closest bonus, which may be retried at its bare cost.
   * `force` (rule 5b, #218): the source, and the armies on it that stay out of the attack.
   */
  const tryExpand = (t: number, reason: string, bare = false, force?: { from: number; keep: number }): boolean => {
    const restore = snapshot();
    if (!tryCapture(t, reason, force, undefined, bare)) return false;
    // #593: never advance a bonus whose other member this plan concedes (its armies go to the next candidate). A
    // capture every attack of which leaves a conceded border with no deploy spends armies given up anyway; a
    // no-loss one (#426) risks only what lands.
    const dead = noLossNeutral(pc, tgt, t) ? null : deadAdvanceOf(pc, t, heldNow(), hd.conceded, tgt.deadBonuses, completableNow);
    if (dead && !givenUp(t)) {
      restore();
      // Said once per territory and bonus (an outer undo may take the line back with the rest).
      for (const d of dead) {
        const line = deadAdvanceLine(pc, t, d);
        if (!rationale.includes(line)) rationale.push(line);
      }
      return false;
    }
    const why = outgrows(t);
    if (why === null) {
      ps.expanded.add(t);
      return true;
    }
    restore();
    if (leadSteps.has(t)) leadTry.set(t, { kind: 'frontier' });
    if (!rationale.includes(why)) rationale.push(why);
    return false;
  };
  const advance = (p: BonusPlan) => {
    /**
     * #214: the bonus closest to completion (rule 4f's order: the first with a step still to take),
     * whose lead steps may be retried at their bare cost — the cost it was ranked on.
     */
    // #214 review: only while rule 4f commits to the closest bonus — otherwise `byCloseness` is
    // just the score order, and its first bonus is not the closest.
    const closest =
      bareOn && committing && byCloseness.find((q) => q.remaining.some((x) => bonusTarget(x) && !captured.has(x))) === p;
    const todo = p.remaining
      .filter((t) => bonusTarget(t) && !captured.has(t))
      .sort((a, b) => targetScoreCost(a) - targetScoreCost(b) || targets.get(a)!.cost - targets.get(b)!.cost || a - b);
    /**
     * Whether a step funded on a conceded source was met (once: its bonus's completion was tried,
     * then the step was weighed; any later one is taken as it comes).
     */
    let whole = false;
    /** Everything a run of steps changes, for {@link weigh}; the result undoes it. */
    const checkpoint = () => {
      const restore = snapshot();
      const tried = new Map(leadTry);
      const stops = stopped.length;
      const refused = new Set(unstaged);
      return () => {
        restore();
        leadTry.clear();
        for (const [k, v] of tried) leadTry.set(k, v);
        stopped.length = stops;
        unstaged.clear();
        for (const k of refused) unstaged.add(k);
      };
    };
    /**
     * #214 review: a step funded on a conceded source alone, its bonus's completion refused, is
     * taken now or after the bonus's other steps, whichever plans more captures (a tie: whichever
     * leaves more of this turn's deploy; a tie again: after). Taken first, it could sink most of
     * the deploy into the conceded border and crowd out a sibling a held border funds for less;
     * taken last, it could lose a pair that fits only in its order. Runs the rest of `queue` too.
     */
    const weigh = (t: number, rest: number[], bare: boolean) => {
      const back = checkpoint();
      run([t, ...rest], bare);
      const now = { captures: captured.size, budget: ps.budget };
      back();
      run([...rest, t], bare);
      if (captured.size > now.captures || (captured.size === now.captures && ps.budget >= now.budget)) return;
      back();
      run([t, ...rest], bare);
    };
    /** `bare` (#214): the closest bonus's second round, its lead steps retried at their bare cost. */
    const run = (queue: number[], bare = false) => {
      for (let i = 0; i < queue.length; i++) {
        const t = queue[i]!;
        if (captured.has(t)) continue;
        const lead = leadSteps.get(t);
        // #203: a lead step never lowers income (as a lead strike).
        if (lead && gainWith([t]) < 0) continue;
        const stepping = !lead && !p.focus && gainWith([t]) < 0 ? stage(p, t) : undefined;
        if (stepping === null) continue;
        const worth = p.net === p.value ? `+${p.value}` : `+${p.value}, net +${p.net}`;
        const reason =
          (stepping?.reason ?? `advances bonus ${bonusName(p.bonusId)} (${worth}, ${toFinish(p.cost, p)})`) + leadNote(t);
        // Only a lead step (#203) can be funded on a conceded source.
        const before = whole || !lead ? undefined : snapshot();
        const tried = before && new Map(leadTry);
        if (!tryExpand(t, reason, bare)) continue;
        if (before && fundedOnConceded.has(t)) {
          /*
           * #214: a step funded on a conceded source completes nothing on its own, and taken first it
           * can block the completion: rule 1c's guard then judges the sibling's capture with the deploy
           * already sunk into the conceded border (and refuses it), or the sibling alone is stopped by
           * rule 4d. The bonus is completed whole instead when pass 1 can with that step last (it then
           * completes the bonus under #122's exception, and the guard judges the completion as such);
           * only otherwise is the step weighed against the bonus's other steps.
           */
          whole = true;
          before();
          complete(p, t);
          if (p.remaining.every((x) => captured.has(x))) return;
          leadTry.clear();
          for (const [k, v] of tried!) leadTry.set(k, v);
          weigh(t, queue.slice(i + 1), bare);
          return;
        }
        ps.anchor ??= moves[moves.length - 1]!.from;
        if (stepping) {
          staged.set(t, p.bonusId);
          rationale.push(stepping.note);
        }
      }
    };
    run(todo);
    // #214: the closest bonus's lead steps the sure sizing could not fund are retried at their bare
    // cost, once every step has had its sure try (a bare step never takes a sure one's deploy).
    if (closest) run(todo.filter((t) => leadSteps.has(t) && !captured.has(t)), true);
  };
  return { snapshot, complete, unstaged, stage, stopped, stoppedLine, denied, outgrows, givenUp, completableNow, tryExpand, advance };
}
