// The capture passes of a planning pass (#133): R3's completion check, No-Split's must-hold
// (#124), the capture helper and combined (multi-source) captures (R4, rule 3a), and the bonus
// passes — pass 1 completes a bonus this turn, pass 2 advances one a capture at a time (rule
// 4c(c), rule 4d's frontier budget). planPass runs the passes, the strikes and pass 3 with them.
import { bonusTerritories } from '../bonuses.js';
import { armiesToTake, straightKills } from '../combat.js';
import { captureCost, type BonusPlan, type TwoStepPass } from './shared.js';
import type { DeployBook } from './orders.js';
import type { Holds } from './holds.js';
import type { PlanCtx, PlanState } from './state.js';
import type { LeadBlock, LeadTry, Targets } from './targets.js';
import type { Threats } from './threats.js';
import { byNum } from './util.js';


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
    unitsAt, defenceAt, bonusTs, completedBy, guard, toTake, noSplit, myCommanders,
  } = pc;
  const { warnings, rationale, deployed, avail, captured, survivorsAt, incoming } = ps;
  const { guardAt, valueOf } = book;
  const { holdArmies, threatAt, exposure, borderAt } = threats;
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
   */
  const defensible = (t: number, survivors: number): boolean => {
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
      const th = threatAt(m, (n) => captured.has(n) && n !== t && !mineSet.has(n));
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
    for (const b of completes) {
      const exposed = exposedOf(b.id);
      const total = exposed.reduce((sum, e) => sum + e.added, 0);
      const before = [...earlier].reduce((n, [id, need]) => n + (exposed.some((e) => e.id === id) ? 0 : need), 0);
      const held = exposed.filter((e) => mineSet.has(e.id)).reduce((sum, e) => sum + e.added, 0);
      const anyway = exposed.filter((e) => e.added < e.need);
      // A completion that adds no exposure (total 0) is never refused: refusing it saves nothing,
      // whatever the earlier completions need (it only adds income).
      if (total === 0 || total + before <= nextIncome + Math.min(spare, held)) {
        if (anyway.length && guarded)
          rationale.push(
            `Complete bonus ${bonusName(b.id)} though ${anyway.map((e) => label(e.id)).join(', ')} may fall next turn: ${anyway.length === 1 ? 'it is' : 'they are'} exposed whether or not it is completed, so refusing would save nothing.`,
          );
        continue;
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
    g, s, reserve, label, mine, mineSet, armiesOf, unitsAt, defenceAt, rates, chanceOf, luck, noSplit, myCommanders,
    armiesBehind, costAt,
  } = pc;
  const {
    warnings, rationale, deployed, avail, locked, spared, captured, combined, moves, survivorsAt, captureOrder,
    captureUndo, incoming,
  } = ps;
  const { coverOf, orderOf, warnSplit, deploy, spareAt, local } = book;
  const { borderAt, safeAtStart, holdArmies } = threats;
  const { conceded, heldBorders, keepFor, stayAt, twoStepBound, twoStepCite, twoStepHold, twoStepKeep } = hd;
  const { targets, leadSteps, leadTry, leadNote, skipOffence, badTrades } = tgt;
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
  /** Enemy commanders' territories attacked as a commander strike (rule 1s): exempt from R3. */
  const strikes = new Set<number>();
  /**
   * Defenders assumed at a target attacked to finish its owner off: its armies plus that
   * owner's full deploy estimate (the worst case). Other targets: their armies now.
   */
  const worstCase = new Map<number, number>();
  /** Players this plan eliminates (rule 1e, every territory taken for sure), for the move-order caveat (#127). */
  const finishedOff = new Set<number>();
  const defendersAt = (t: number) => worstCase.get(t) ?? defenceAt(t);
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
    const sure = lead !== undefined && !worstCase.has(t);
    if (sure) worstCase.set(t, lead.defenders + lead.extra);
    shortAt = undefined;
    belowEven = undefined;
    combinedR3 = false;
    let ok = captureOnce(t, reason, force, fromConceded);
    if (sure && !ok) worstCase.delete(t);
    // #214: a step toward the closest bonus (or in a completion) the turn cannot fund at its sure
    // cost is retried at its bare cost — a sure capture of the defenders standing there now, the
    // basis rule 4f ranks the bonuses on. No worst case: #120's warning then says what it faces if
    // the owner deploys there first. Only a funding shortfall retries (an R3 or trade refusal of the
    // sure step stands), and the target keeps its sure cost for every later try.
    // #214 review: shortAt is set before tryCombined runs, so a combined capture refused for a
    // below-even trade (belowEven) or by R3 (combinedR3, which sets no refusal) is a refusal too.
    if (bareOn && sure && bare && !ok && shortAt !== undefined && ps.refusal === undefined && belowEven === undefined && !combinedR3) {
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
    const usable = (x: number) => open(x) && !held(x) && !(noSplit && coverOf(x) > 0);
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
    const survivors = sent - straightKills(defendersAt(t), rates.defensiveKillRate);
    // A commander strike is never refused by R3: killing the commander eliminates a player.
    if (!strikes.has(t) && !defensible(t, survivors)) {
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
    if ((armiesBehind || ps.evenTradesOnly) && tg.enemy) {
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
    const before = { avail: new Map(avail), incoming: new Map(incoming), deployed: new Map(deployed), budget: ps.budget };
    deploy(plan.finisher, plan.need);
    for (const x of plan.softeners) {
      avail.set(x.from, avail.get(x.from)! - x.armies);
      incoming.set(x.from, (incoming.get(x.from) ?? 0) + x.survivors);
    }
    avail.set(plan.finisher, avail.get(plan.finisher)! - plan.armies);
    captured.add(t);
    if (!defensible(t, plan.survivors)) {
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
    rationale.push(
      `Attack ${label(t)} with ${n} attacks (no single source can afford its ${tg.cost}): ${plan.softeners
        .map((x) => `from ${label(x.from)} with ${x.armies} (kills ${x.kills} of ${x.before}; ${x.survivors} survive and stay)`)
        .join(', then ')}, then from ${label(plan.finisher)} with ${plan.armies}${plan.need ? ` (deploy ${plan.need} there)` : ''}, taking the last ${plan.left}: ${reason}.`,
    );
    return true;
  };
  return { belowEven, movableFor, keepOf, concededSource, siblings, fundedOnConceded, strikes, worstCase, finishedOff, defendersAt, tryCapture, shortAt, captureOnce, combinedPlan, tryCombined, bareOn, bareTaken };
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
    g, s, guarded, paybackTurns, territories: state, label, bonusName, mineSet, incomeGain, incomeAfter, defenceAt,
    bonusTs, completedBy, inFocus,
  } = pc;
  const {
    warnings, rationale, deployed, avail, captured, combined, moves, survivorsAt, captureOrder, staged, incoming,
  } = ps;
  const { heldNow, gainWith } = book;
  const { heldBorders, keptIncome, stayAt } = hd;
  const {
    targets, leadSteps, leadTry, leadNote, bonusTarget, frontierDelta, targetScoreCost, frontierOf, startHold,
    toFinish, byCloseness, committing,
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
  const stopped: { t: number; holdCost: number; income: number }[] = [];
  /** The start of rule 4d's rationale line for a stopped `t` (one per attempt that differed). */
  const stoppedLine = (t: number) => `Do not take ${label(t)}: it adds a border facing an enemy without completing a bonus,`;
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
    if (f.holdCost <= next || f.holdCost <= start) return null;
    const why = `${stoppedLine(t)} and the frontier would then need ${f.holdCost} next turn to hold (${f.enemyBorders} enemy-facing borders), more than the next income of ${next} and more than the ${start} it needed at the start of the turn.`;
    if (!stopped.some((x) => x.t === t)) stopped.push({ t, holdCost: f.holdCost, income: next });
    return why;
  };
  /**
   * Capture `t` for expansion, unless rule 4d's frontier budget stops it (then everything is undone).
   * `bare` (#214): a lead step toward the closest bonus, which may be retried at its bare cost.
   */
  const tryExpand = (t: number, reason: string, bare = false): boolean => {
    const restore = snapshot();
    if (!tryCapture(t, reason, undefined, undefined, bare)) return false;
    const why = outgrows(t);
    if (why === null) return true;
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
          (stepping?.reason ?? `advances bonus ${bonusName(p.bonusId)} (${worth}, ${toFinish(p.cost, p.fogged, p.fogEach)})`) + leadNote(t);
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
  return { snapshot, complete, unstaged, stage, stopped, stoppedLine, outgrows, tryExpand, advance };
}
