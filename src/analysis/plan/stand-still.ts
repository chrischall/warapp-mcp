// Rule 4e, never stand still (#104, #107, #112, #114, #121, #125; #133): a plan with no capture at
// all takes the cheapest capture this turn affords — a neutral step toward the closest positive
// bonus, and in the contact and late phases (the contact fallback) an enemy territory at a trade
// of at least even, with every other capture that loses nothing — or says why it stands still.
// planPass runs it where it ran before: after pass 3, before rule 4g's card-piece capture.
import { straightKills } from '../combat.js';
import { neighborsOf } from '../graph.js';
import type { PlannedMove } from './shared.js';
import type { Captures, MustHold } from './captures.js';
import type { Holds } from './holds.js';
import type { DeployBook } from './orders.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Targets } from './targets.js';
import type { Threats } from './threats.js';
import { byNum } from './util.js';


/** #125: the step rule 4e ranked first and could not afford this turn (its size, nothing else). */
export interface SaveStep {
  t: number;
  bonusId: number;
  cost: number;
}

/** What can reach a step this turn, as rule 4e judges it (see `reachOf`). */
export interface Reach {
  from: number | undefined;
  movable: number;
  deploy: number;
  reach: number;
  /** The source is a conceded border: it attacks out (with deploys) rather than withdraw. */
  viaConceded: boolean;
  /** No usable source: why each neighbour of mine is out. */
  blocked: { x: number; why: 'hold' | 'conceded' | 'split' }[];
}

/** A candidate: what reaches it, as {@link reachOf} judges it. */
export type Cand = Reach & { t: number; cost: number };
/**
 * Why a step was not taken: rule 4d's frontier stop (with the frontier it would leave), R3
 * (it completes a bonus that falls next turn), No-Split (a source that could take it already
 * issues an order), a trade below even, a hold it would leave short (contact), or its size.
 */
export type Fail =
  | { kind: '4d'; holdCost: number; income: number }
  | { kind: 'r3' }
  | { kind: 'split'; from: number }
  | { kind: 'trade'; lost: number; killed: number }
  | { kind: 'hold'; from: number; stays: number; spare: number; threat: number }
  | ({ kind: 'must-hold' } & MustHold)
  | { kind: 'size' };

/**
 * The helpers rule 4e works with, over the plan as it stands when each is called: what reaches a
 * step, trying one (and undoing it), what a capture loses and leaves exposed, and why a step was
 * not taken. Creating them changes nothing.
 */
export function standStillKit(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hd: Holds,
  tgt: Targets,
  caps: Captures,
) {
  const {
    income, label, bonusName, unitsAt, defenceAt, bonusTs, rates, chanceOf, toTake, luck, weightedRounding, noSplit,
  } = pc;
  const { warnings, rationale, avail, locked, captured, moves, incoming, survivorsAt, captureUndo } = ps;
  const { heldNow, orderOf, deploy, spareAt } = book;
  const { threatAt } = threats;
  const { conceded, stayAt } = hd;
  const { targets, borderOf } = tgt;
  const { notCompleted, movableFor, concededSource, defendersAt, tryCapture, combinedPlan, snapshot } = caps;
  const WITHDRAWS = 'withdraws from a conceded border';
  /** Armies rule 1b withdrew from conceded `x` this turn (they may attack out instead). */
  const withdrawnFrom = (x: number) =>
    moves.find((m) => m.from === x && m.kind === 'transfer' && m.reason === WITHDRAWS)?.armies ?? 0;
  /**
   * What can reach `t` this turn, as {@link tryCapture} judges it: its best single source's
   * movable armies (my commander's territory keeps what holds it) plus what may still be
   * deployed there. A source that holds its border (locked) or already issues an order
   * (No-Split) is out. A conceded border counts with the armies rule 1b would withdraw and
   * with deploys (#107): rather than stand still it attacks out, and its deploys leave with
   * the attack — but only when no unconceded source can take it alone. On a tie a source that
   * is not conceded wins.
   */
  const reachOf = (t: number): Reach => {
    let best: Reach = { from: undefined, movable: 0, deploy: 0, reach: 0, viaConceded: false, blocked: [] };
    const blocked: Reach['blocked'] = [];
    const tg = targets.get(t)!;
    for (const x of [...tg.sources].sort(byNum)) {
      const back = conceded.has(x) ? withdrawnFrom(x) : 0;
      // A conceded border kept in place (its garrison stays, not withdrawn) is not holding its
      // border: name it as conceded.
      if (back === 0 && locked.has(x)) {
        blocked.push({ x, why: !conceded.has(x) ? 'hold' : orderOf(x) ? 'split' : 'conceded' });
        continue;
      }
      if (back === 0 && orderOf(x)) {
        blocked.push({ x, why: 'split' });
        continue;
      }
      const movable = Math.max(0, movableFor(x, t) + back);
      // Deploys reach a conceded source only through the attack-out path below.
      const viaConceded = conceded.has(x) && !concededSource(x, t, tg.cost);
      const deploy = Math.max(0, spareAt(x));
      const reach = movable + deploy;
      // An unconceded source that can take it alone goes first: a conceded border attacks out
      // only when none can, so its armies are not thrown away for a step another source affords.
      const fits = !conceded.has(x) && reach >= tg.cost;
      const bestFits = best.from !== undefined && !conceded.has(best.from) && best.reach >= tg.cost;
      if (
        best.from === undefined ||
        (fits && !bestFits) ||
        (fits === bestFits && (reach > best.reach || (reach === best.reach && best.viaConceded && !viaConceded)))
      )
        best = { from: x, movable, deploy, reach, viaConceded, blocked: [] };
    }
    return best.from === undefined ? { ...best, blocked } : best;
  };
  /**
   * Undo rule 1b's withdrawal from conceded `x` so it may attack out (#107); the result redoes
   * it. A conceded border never withdrawn (nowhere to go) needs nothing undone.
   */
  const reclaim = (x: number): (() => void) => {
    const i = moves.findIndex((m) => m.from === x && m.kind === 'transfer' && m.reason === WITHDRAWS);
    if (i < 0) return () => {};
    const [m] = moves.splice(i, 1) as [PlannedMove];
    const had = { avail: avail.get(x)!, incoming: incoming.get(m.to) ?? 0, card: ps.cardAdvice };
    avail.set(x, had.avail + m.armies);
    locked.delete(x);
    if (had.incoming - m.armies > 0) incoming.set(m.to, had.incoming - m.armies);
    else incoming.delete(m.to);
    const r = rationale.findIndex((l) => l.startsWith(`Withdraw ${m.armies} from ${label(x)} to `));
    const rLine = r >= 0 ? rationale.splice(r, 1)[0] : undefined;
    const w = warnings.findIndex((l) => l.startsWith(`The withdrawal from ${label(x)} only executes`));
    const wLine = w >= 0 ? warnings.splice(w, 1)[0] : undefined;
    if (!moves.some((o) => o.kind === 'transfer' && o.reason === WITHDRAWS)) ps.cardAdvice = null;
    return () => {
      moves.splice(i, 0, m);
      avail.set(x, had.avail);
      locked.add(x);
      if (had.incoming > 0) incoming.set(m.to, had.incoming);
      else incoming.delete(m.to);
      if (rLine !== undefined) rationale.splice(r, 0, rLine);
      if (wLine !== undefined) warnings.splice(w, 0, wLine);
      ps.cardAdvice = had.card;
    };
  };
  /**
   * What capturing `st` is expected to cost (#112): the defensive kills on its attackers at the
   * game's rates, and the armies sent. One source that can take it alone sends its cost and
   * loses the defenders' kills; otherwise the combined capture rule 3a would plan, its every
   * attack's losses (the softeners' and the finisher's) and armies counted — only with no luck
   * and straight rounding, where rule 3a makes one.
   */
  const lossOf = (st: Reach & { t: number; cost: number }): { lost: number; sent: number } => {
    const single = { lost: Math.min(st.cost, straightKills(defendersAt(st.t), rates.defensiveKillRate)), sent: st.cost };
    // Under luck or weighted rounding a combined capture is never made (rule 3a, `tryCombined`):
    // the single source's sizing is the one the plan would use.
    if (st.from === undefined || st.reach >= st.cost || luck > 0 || weightedRounding) return single;
    const c = combinedPlan(st.t);
    if (!c) return single;
    return {
      lost: c.softeners.reduce((n, x) => n + x.armies - x.survivors, 0) + c.armies - c.survivors,
      sent: c.softeners.reduce((n, x) => n + x.armies, 0) + c.armies,
    };
  };
  /**
   * Every source of the attack on `t` must still hold its border once `t` is taken (#107 in
   * contact; every phase since the opening emptied border stacks live). A source left short gets the deploys still available there that make it hold (they
   * are placed now, so the leftover deploy cannot go elsewhere; the step's undo takes them
   * back). A source that cannot be made to hold is returned, with what stays, the deploys that
   * were available and the threat it faces; else `undefined`. A conceded border is skipped: its
   * armies are given up anyway.
   */
  const holdLeftShort = (t: number): { from: number; stays: number; spare: number; threat: number } | undefined => {
    // No-Split (#124): deploys there would leave with the attack, and a source that must hold
    // never attacks (tryCapture): one that protects nothing may be emptied.
    if (noSplit) return undefined;
    for (const m of moves) {
      if (m.kind !== 'attack' || m.to !== t || conceded.has(m.from)) continue;
      const th = threatAt(m.from, (n) => captured.has(n));
      if (!th) continue;
      const stays = stayAt(m.from);
      const holds = (n: number) => (toTake(stays + n + unitsAt(m.from)) ?? Infinity) > th.threat;
      if (holds(0)) continue;
      const spare = Math.max(0, spareAt(m.from));
      let n = 1;
      while (n <= spare && !holds(n)) n++;
      if (n > spare) return { from: m.from, stays, spare, threat: th.threat };
      deploy(m.from, n);
      rationale.push(
        `Deploy ${n} to ${label(m.from)} so it still holds its border after the attack on ${label(t)} (${stays + n} stay against a threat of ${th.threat}).`,
      );
    }
    return undefined;
  };
  /**
   * Why a step that does not fit failed (#121): a source that keeps what holds its border could
   * have afforded it by spending that garrison — then it is the hold it would leave short (as
   * {@link holdLeftShort} words it), else its size. Tried with the keeps off and undone.
   */
  const sizeOrHold = (st: Cand, reason: string): Fail => {
    const restore = snapshot();
    ps.spendKeeps = true;
    let short: ReturnType<typeof holdLeftShort>;
    try {
      if (st.from !== undefined && conceded.has(st.from)) return { kind: 'size' };
      const ok = tryCapture(st.t, reason);
      short = ok ? holdLeftShort(st.t) : undefined;
    } finally {
      ps.spendKeeps = false;
      restore();
    }
    return short ? { kind: 'hold', ...short } : { kind: 'size' };
  };
  /** The trade of the planned capture of `t`: defenders killed against attackers lost (every attack on it). */
  const tradeOf = (t: number): { lost: number; killed: number } => {
    const sent = moves.filter((m) => m.kind === 'attack' && m.to === t);
    const killed = defendersAt(t);
    if (sent.length === 1) return { lost: straightKills(killed, rates.defensiveKillRate), killed };
    // A combined capture: every attack's losses — the softeners' (their survivors return home)
    // and the finisher's.
    let left = killed;
    let lost = 0;
    for (const m of sent) {
      const kills = Math.min(left, straightKills(m.armies, rates.offensiveKillRate));
      lost += Math.min(m.armies, straightKills(left, rates.defensiveKillRate));
      left -= kills;
    }
    return { lost, killed };
  };
  /**
   * Try one step. From a conceded border (#107) rule 1b's withdrawal is undone first and the
   * border attacks out with deploys, a rationale line saying so. The result undoes it all.
   */
  const attempt = (st: Cand, reason: string): (() => void) | null => {
    const out = st.from !== undefined && conceded.has(st.from) ? st.from : undefined;
    // Neither the snapshot nor a no-op unreclaim puts back the card advice an attack out of a
    // conceded border sets (#114: a candidate only tried and undone must leave none behind).
    const card = ps.cardAdvice;
    const unreclaim = out === undefined ? () => {} : reclaim(out);
    const before = out === undefined ? 0 : movableFor(out, st.t);
    const restore = snapshot();
    if (!tryCapture(st.t, reason, undefined, out)) {
      unreclaim();
      return null;
    }
    const move = [...moves].reverse().find((m) => m.kind === 'attack' && m.to === st.t)!;
    if (out !== undefined && move.from === out) {
      const need = Math.max(0, st.cost - before);
      // Every movable army leaves with the attack: left behind on the conceded border they are
      // lost; at the target they survive.
      const extra = Math.max(0, movableFor(out, st.t));
      if (extra > 0) {
        const sent = move.armies;
        avail.set(out, avail.get(out)! - extra);
        move.armies = sent + extra;
        move.winChance = chanceOf(move.armies, defenceAt(st.t));
        survivorsAt.set(st.t, (survivorsAt.get(st.t) ?? 0) + extra);
        captureUndo.set(st.t, () => avail.set(out, avail.get(out)! + move.armies));
        const head = `Attack ${label(st.t)} from ${label(out)} with ${sent}`;
        let r = rationale.length - 1;
        while (r >= 0 && !rationale[r]!.startsWith(`${head}:`) && !rationale[r]!.startsWith(`${head} (`)) r--;
        if (r >= 0) rationale[r] = `Attack ${label(st.t)} from ${label(out)} with ${move.armies}${rationale[r]!.slice(head.length)}`;
      }
      rationale.push(
        `Attack out of conceded ${label(out)} rather than withdraw: its ${before} movable armies${need ? ` (and ${need} deployed there, which leave with the attack)` : ''} take ${label(st.t)}; one capture is worth more than saving them.`,
      );
      // Like the withdrawal it replaces, the attack only runs if the border is still mine.
      warnings.push(
        `The attack out of ${label(out)} only executes if ${label(out)} is still mine when the order runs; play Order Priority so it goes first.`,
      );
      ps.cardAdvice = 'order-priority';
    } else unreclaim();
    const viaOut = out !== undefined && move.from === out;
    return () => {
      // restore() rewinds to the snapshot, taken after the reclaim and counting moves, lines
      // and warnings by length: a withdrawal already put back is taken out again first, so
      // the rewind removes only this step and the withdrawal is then put back once.
      const unwind = out === undefined || viaOut ? unreclaim : reclaim(out);
      restore();
      unwind();
      ps.cardAdvice = card;
    };
  };
  /**
   * After `t` is captured in the plan (#114): its survivors and the threat they face, when they
   * cannot hold it next turn (rule 4d's border arithmetic: they need deploys), else `undefined`.
   */
  const exposure = (t: number): { survivors: number; threat: number } | undefined => {
    const held = heldNow();
    const survivors = survivorsAt.get(t) ?? 0;
    const b = borderOf(t, held, survivors);
    if (!b.enemy || b.need <= 0) return undefined;
    return { survivors, threat: threatAt(t, (n) => held.has(n))!.threat };
  };
  /** The bonuses `t` would complete that R3 refused, as "name (#id)". */
  const refusedBonuses = (t: number) =>
    [...notCompleted.keys()]
      .filter((id) => bonusTs.get(id)?.includes(t))
      .sort(byNum)
      .map(bonusName);
  /** Why no neighbour of mine can attack `st`: each holds its border, is conceded, or already issues an order. */
  const blockedText = (st: Cand) =>
    `no neighbour of mine can attack it (${st.blocked
      .map(({ x, why }) =>
        why === 'hold'
          ? `${label(x)} stays to hold its border`
          : why === 'conceded'
            ? `${label(x)} is a conceded border whose armies stay there`
            : `${label(x)} already issues an order under No-Split`,
      )
      .join('; ')})`;
  /** "needs C, and at most R can reach it this turn (M movable on S[, a conceded border] + D to deploy[; the holds took H])". */
  const reachText = (st: Cand, held: number) =>
    st.from === undefined
      ? blockedText(st)
      : `it needs ${st.cost}, and at most ${st.reach} can reach it this turn (${st.movable} movable on ${label(st.from)}${
          conceded.has(st.from) ? ', a conceded border,' : ''
        } + ${st.deploy} to deploy${held > 0 ? `; the holds took ${held}` : ''})`;
  /** "S would stay[, S+D with the D deploys left there,] against a threat of T". */
  const holdText = (f: { stays: number; spare: number; threat: number }) =>
    `${f.stays} would stay${f.spare > 0 ? `, ${f.stays + f.spare} with the ${f.spare} deploys left there,` : ''} against a threat of ${f.threat}`;
  /** Why `st` was not taken, as a clause after its name. */
  const failText = (st: Cand, fail: Fail | undefined) => {
    if (fail?.kind === '4d')
      return `is refused by rule 4d's frontier stop: the frontier would then need ${fail.holdCost} next turn to hold, more than the next income of ${fail.income}`;
    if (fail?.kind === 'r3') {
      const names = refusedBonuses(st.t);
      return names.length
        ? `is refused by rule R3: taking it completes bonus ${names.join(', ')}, which could not be held next turn (see "completing ${names[0]} leaves …: not completed")`
        : 'is refused by rule R3: the bonus it completes could not be held next turn';
    }
    if (fail?.kind === 'split')
      return `is not planned under No-Split: ${label(fail.from)} could take it but already issues an order (one attack or transfer per territory)`;
    if (fail?.kind === 'trade')
      return `is not taken: no single source can afford it, and the combined capture loses ${fail.lost} armies for the ${fail.killed} it kills, a trade below even`;
    if (fail?.kind === 'must-hold')
      return `is not planned under No-Split: ${label(fail.from)} could take it, but its whole stack would go and leave ${fail.stays} against the ~${fail.threat} threat to a border that must hold`;
    if (fail?.kind === 'hold')
      return `is not taken: attacking it would leave ${label(fail.from)} unable to hold its border (${holdText(fail)})`;
    if (st.from === undefined) return `cannot be reached: ${blockedText(st)}`;
    // What the holds took before this rule ran (no capture spent anything yet).
    const held = income - ps.budget;
    if (st.reach >= st.cost)
      return `is not taken, though ${st.reach} could reach it (it needs ${st.cost}): no single source can deliver them this turn`;
    if (held > 0 && st.reach + held >= st.cost) return `does not fit what the holds leave: ${reachText(st, held)}`;
    return `does not fit this turn: ${reachText(st, 0)}`;
  };
  return { reachOf, lossOf, holdLeftShort, sizeOrHold, tradeOf, attempt, exposure, blockedText, holdText, failText };
}

// ---- 4e. never stand still (#104, #107) ----
// A plan with no capture at all (no expansion, break, finishing off or strike), in the opening
// or expansion phase or with my armies over the army cap, takes the cheapest affordable neutral
// capture toward the positive bonus with the fewest armies to finish, uneconomic or not. It runs
// after every hold, so it only spends what they leave. Its steps are ranked by what this turn can
// afford (#107): the armies that can reach each (its best source's movable armies plus what may
// still be deployed there) against its cost, then by the bonus's armies to finish. In the contact
// and late phases (#107) enemy territories it can take at a trade of at least even join them,
// ranked by the armies each capture loses (#112), and every other capture that loses nothing
// is taken too.
export function neverStandStill(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hd: Holds,
  tgt: Targets,
  caps: Captures,
): { saveStep: SaveStep | undefined } {
  const {
    g, s, opts, income, foe, profile, auto, goal, deployOf, territories: state, label, bonusName, mine, mineSet,
    armiesOf, unitsAt, uncounted, defenceAt, bonusTs, guard, costAt, toTake, leadLever, clearLeader,
  } = pc;
  const { warnings, rationale, spared, captured } = ps;
  const { gainWith } = book;
  const { growthOf, facing } = threats;
  const { conceded } = hd;
  const { targets, bonusTarget, targetScoreCost, toFinish, plans, finishCost } = tgt;
  const { stopped, outgrows } = caps;
  /**
   * #125: the step rule 4e ranked first and could not afford this turn (its size, nothing else):
   * the leftover saves toward it (rule 5) and idle stacks stage toward it (rule 6).
   */
  let saveStep: { t: number; bonusId: number; cost: number } | undefined;
  if (goal !== 'complete-bonus' && captured.size === 0) {
    const early = profile.phase === 'opening' || profile.phase === 'expansion';
    // In a 1v1 the strike stack (rule 0p.3c, #102) is contact's own answer: it attacks every turn.
    const strikeStackRuns = auto && profile.format === '1v1' && goal !== 'defend' && facing.size > 0;
    // A caller who chose `defend` gets no contact fallback (a `defend` adapt picked still does: its
    // holds come first); one who chose `expand` only its neutral steps.
    const contact =
      (profile.phase === 'contact' || profile.phase === 'late') && !strikeStackRuns && opts.goal !== 'defend';
    const enemyFallback = contact && opts.goal !== 'expand';
    const cap = s.armyCap ?? null;
    const total = mine.reduce((n, id) => n + armiesOf(id), 0) + income;
    const capped = cap !== null && cap > 0 && income > 0 && total > cap * income;
    if (early || capped || contact) {
      /** Ascending, safe for Infinity (a bonus that cannot be costed): Infinity − Infinity is NaN. */
      const asc = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);
      const toward = [...finishCost]
        .filter(([, f]) => f.net > 0)
        .sort(([a, x], [b, y]) => asc(x.cost, y.cost) || y.value - x.value || a - b);
      const bonusRank = new Map(toward.map(([id], i) => [id, i]));
      const {
        reachOf, lossOf, holdLeftShort, sizeOrHold, tradeOf, attempt, exposure, blockedText, holdText, failText,
      } = standStillKit(pc, ps, book, threats, hd, tgt, caps);
      // #107, in contact: every visible enemy territory next to mine (no enemy commander on it)
      // whose capture does not lower income is a candidate. One not already a target is added for this rule (and dropped again
      // unless taken), sized like any capture at the plan's win chance.
      const added: number[] = [];
      const enemyTs: number[] = [];
      if (enemyFallback)
        for (const t of [...g.territoryById.keys()].sort(byNum)) {
          // #179: a buffer left standing is no candidate (its "Not attacking" line says why).
          if (mineSet.has(t) || captured.has(t) || spared.has(t)) continue;
          const st = state.get(t);
          if (st?.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null || uncounted(t)) continue;
          // An enemy commander is rule 1s's, sized for its owner's full deploy: never a fallback.
          if (unitsAt(t) > 0) continue;
          const sources = neighborsOf(g, t).filter((n) => mineSet.has(n));
          if (!sources.length || gainWith([t]) < 0) continue;
          if (!targets.has(t)) {
            const cost = costAt(t);
            if (cost === null) continue;
            targets.set(t, { id: t, cost, enemy: true, sources });
            added.push(t);
          }
          enemyTs.push(t);
        }
      const seen = new Set<number>();
      const steps = toward
        .flatMap(([id, f]) =>
          bonusTs
            .get(id)!
            .filter((t) => targets.has(t) && !targets.get(t)!.enemy && !captured.has(t) && gainWith([t]) >= 0)
            .sort((a, b) => targetScoreCost(a) - targetScoreCost(b) || targets.get(a)!.cost - targets.get(b)!.cost || a - b)
            .map((t, k) => ({ t, id, f, k, cost: targets.get(t)!.cost, ...reachOf(t) })),
        )
        // What this turn can afford first (shortfall 0 fits), then the bonus's armies to finish.
        .sort(
          (a, b) =>
            Math.max(0, a.cost - a.reach) - Math.max(0, b.cost - b.reach) ||
            bonusRank.get(a.id)! - bonusRank.get(b.id)! ||
            a.k - b.k,
        )
        // A territory in several bonuses: once, toward the first.
        .filter(({ t }) => !seen.has(t) && Boolean(seen.add(t)));
      const fewest = steps.length ? Math.min(...steps.map((x) => x.f.cost)) : Infinity;
      const economicLeft = plans.some((p) => p.remaining.some(bonusTarget));
      const why = [
        ...(early
          ? [
              economicLeft
                ? `${profile.phase} phase: no economic capture fits this turn; standing still is worse than the cheapest expansion`
                : `${profile.phase} phase: nothing passed the economy test; standing still is worse than the cheapest expansion`,
            ]
          : contact
            ? [
                `${profile.phase} phase: no capture is planned (${
                  economicLeft ? 'no economic capture fits this turn' : 'nothing passed the economy test'
                }); standing still is worse than the cheapest capture`,
              ]
            : []),
        ...(capped
          ? [
              `my ${total} armies after deploy exceed the army cap of ${cap * income} (${cap}× income ${income}): armies above it are wasted, so spending them is free`,
            ]
          : []),
      ].join('; ');
      const reasonOf = ({ id, f }: (typeof steps)[number]) =>
        `cheapest expansion toward bonus ${bonusName(id)} (+${f.value}, ${toFinish(f.cost, f.fogged, f.fogEach)}, ${
          f.cost === fewest ? 'the fewest of any bonus in reach' : 'the fewest of any bonus with a capture affordable this turn'
        })`;

      // ---- #107, in contact: enemy captures ----
      /** Rule 0p.2's setting: an FFA with two or more opponents left. Applied here with or without adapt. */
      const ffaFronts = profile.format === 'ffa' && profile.opponents >= 2 && !leadLever;
      /**
       * The first territory of mine (by id) player `p` could take next turn — its stacks next to it
       * plus max(its deploy estimate, its fastest growth there) against what taking it needs — or
       * `undefined`: `p` cannot currently attack me.
       */
      const attackableBy = (p: number): number | undefined =>
        mine.find((x) => {
          let movable = 0;
          let growth = 0;
          let next = false;
          for (const n of neighborsOf(g, x)) {
            const st = state.get(n);
            if (st?.owner.kind !== 'player' || st.owner.playerId !== p || st.armies === null) continue;
            next = true;
            movable += Math.max(0, st.armies - guard) + unitsAt(n);
            growth = Math.max(growth, growthOf.get(n)?.growth ?? 0);
          }
          const take = toTake(defenceAt(x));
          return next && take !== null && take <= movable + Math.max(deployOf(p), growth);
        });
      /** What capturing enemy `t` does to a bonus: breaks one its owner holds in full, or advances one of mine. */
      const enemyBonus = (t: number, p: number): { id: number; breaks: boolean } | undefined => {
        const breaks = g.map.bonuses
          .filter((b) => b.value > 0 && bonusTs.get(b.id)!.includes(t))
          .sort((a, b) => b.value - a.value || a.id - b.id)
          .find((b) =>
            bonusTs.get(b.id)!.every((m) => {
              const o = state.get(m)?.owner;
              return o?.kind === 'player' && o.playerId === p;
            }),
          );
        if (breaks) return { id: breaks.id, breaks: true };
        const adv = toward.find(([id]) => bonusTs.get(id)!.includes(t));
        return adv ? { id: adv[0], breaks: false } : undefined;
      };
      const enemySteps = enemyTs.map((t) => {
        const p = (state.get(t)!.owner as { playerId: number }).playerId;
        const from = attackableBy(p);
        return {
          t,
          cost: targets.get(t)!.cost,
          player: p,
          bonus: enemyBonus(t, p),
          /** Its owner can attack me now: the territory of mine it could take. */
          front: from,
          secondFront: ffaFronts && from === undefined && p !== clearLeader,
          ...reachOf(t),
        };
      });
      const enemyReason = (e: (typeof enemySteps)[number]) => {
        if (!e.bonus) return `cheapest capture: takes a territory of player ${e.player}`;
        const v = g.bonusById.get(e.bonus.id)!.value;
        if (e.bonus.breaks) return `cheapest capture: breaks bonus ${bonusName(e.bonus.id)} (+${v}) of player ${e.player}`;
        const f = finishCost.get(e.bonus.id)!;
        return `cheapest capture: advances bonus ${bonusName(e.bonus.id)} (+${v}, ${toFinish(f.cost, f.fogged, f.fogEach)}) from player ${e.player}`;
      };
      /**
       * Every candidate, in the order tried. Outside contact: rule 4e's neutral steps as ranked
       * above. In contact (#107, #112): the neutral steps and the enemy captures together —
       * affordable first, then the armies lost, then the armies sent, then one that breaks or
       * advances a bonus, then (neutral steps) rule 4e's order, then id; under rule 0p.2 a capture
       * that opens a second front (its owner cannot attack me now) only after every other.
       */
      type Pick =
        | { kind: 'neutral'; st: (typeof steps)[number] }
        | { kind: 'enemy'; st: (typeof enemySteps)[number] };
      const shortOf = (x: { cost: number; reach: number }) => Math.max(0, x.cost - x.reach);
      const rank4e = new Map(steps.map((x, i) => [x.t, i]));
      const picks: Pick[] = [
        ...steps.map((st): Pick => ({ kind: 'neutral', st })),
        ...enemySteps.map((st): Pick => ({ kind: 'enemy', st })),
      ];
      const loss = new Map(picks.map((p) => [p.st.t, lossOf(p.st)]));
      /**
       * In contact (#114): the survivors a capture leaves on a border that cannot hold next turn
       * (rule 4d's and R3's arithmetic: survivors against the threat at the expected enemy deploy),
       * with that threat. Absent when it can be held or faces no enemy. Filled below, by a trial of
       * each candidate.
       */
      const risk = new Map<number, { survivors: number; threat: number }>();
      /** A candidate's ranking cost in contact (#114): the armies it loses plus its survivors at risk. */
      const costOfPick = (t: number) => loss.get(t)!.lost + (risk.get(t)?.survivors ?? 0);
      /** "N survivor(s)". */
      const survivorsText = (n: number) => `${n} survivor${n === 1 ? '' : 's'}`;
      /**
       * "loses ~N armies" / "loses no armies": what a capture costs (#112); in contact, and when its
       * border cannot hold next turn, ", and its S survivors may fall next turn" (#114).
       */
      const lossText = (t: number) => {
        const n = loss.get(t)!.lost;
        const r = risk.get(t);
        return `${n === 0 ? 'loses no armies' : `loses ~${n} ${n === 1 ? 'army' : 'armies'}`}${
          r ? `, and its ${survivorsText(r.survivors)} may fall next turn` : ''
        }`;
      };
      // In contact (#112, #114): affordable first, then the cost (the armies the capture loses plus
      // its survivors at risk), then the armies it sends; breaking or advancing a bonus is only a
      // tie-break. Under rule 0p.2 a capture that opens a second front still comes after every other.
      const keyOf = (p: Pick) => [
        p.kind === 'enemy' && p.st.secondFront ? 1 : 0,
        shortOf(p.st),
        costOfPick(p.st.t),
        loss.get(p.st.t)!.sent,
        p.kind === 'enemy' && !p.st.bonus ? 1 : 0,
        p.kind === 'neutral' ? rank4e.get(p.st.t)! : Infinity,
        p.st.t,
      ];
      const reasonFor = (p: Pick) => {
        const r = p.kind === 'neutral' ? reasonOf(p.st) : enemyReason(p.st);
        // In contact the reason names what the capture costs (#112).
        if (!contact) return r;
        const head = p.kind === 'neutral' ? 'cheapest expansion' : 'cheapest capture';
        return `${head} (${lossText(p.st.t)})${r.slice(head.length)}`;
      };
      const failed = new Map<number, Fail>();
      if (contact) {
        // #114: rule 4d is a cost here, not a veto. Each candidate is tried (and undone) to see
        // what its capture leaves exposed; then they are ranked.
        ps.evenTradesOnly = true;
        for (const pick of picks) {
          const undo = attempt(pick.st, '');
          if (!undo) continue;
          const e = exposure(pick.st.t);
          if (e) risk.set(pick.st.t, e);
          undo();
        }
        ps.evenTradesOnly = false;
        picks.sort((a, b) => {
          const x = keyOf(a);
          const y = keyOf(b);
          for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
          return 0;
        });
      }
      let taken: Pick | undefined;
      ps.evenTradesOnly = contact;
      for (const pick of picks) {
        const st = pick.st;
        const undo = attempt(st, reasonFor(pick));
        if (!undo) {
          const r = ps.refusal as typeof ps.refusal;
          failed.set(st.t, r ?? sizeOrHold(st, reasonFor(pick)));
          continue;
        }
        // Every phase, not only contact: a capture that leaves its source to fall is worse than
        // standing still (live, an opening plan sent a 15-stack's every army at a 15-neutral
        // from beside two enemy 15-stacks).
        const short = holdLeftShort(st.t);
        if (short) {
          undo();
          failed.set(st.t, { kind: 'hold', ...short });
          continue;
        }
        // #114: in contact rule 4d is a cost (ranked above), not a veto.
        const stop = contact ? null : outgrows(st.t);
        if (stop === null) {
          taken = pick;
          break;
        }
        undo();
        if (!rationale.includes(stop)) rationale.push(stop);
        const f = stopped.find((x) => x.t === st.t)!;
        failed.set(st.t, { kind: '4d', holdCost: f.holdCost, income: f.income });
      }
      ps.evenTradesOnly = false;
      // #107: in the opening, rule 4d's frontier stop must not make the plan stand still: one
      // capture that grows the frontier is better than none (4d still judges every other capture).
      let waived: { holdCost: number; income: number } | undefined;
      if (!taken && profile.phase === 'opening') {
        const st = steps.find((x) => failed.get(x.t)?.kind === '4d');
        const undo = st ? attempt(st, reasonOf(st)) : null;
        if (st && undo) {
          // The waiver is for the frontier the captured territory adds, never for a source the
          // attack leaves unable to hold: that is checked (and its deploys placed) again here.
          const short = holdLeftShort(st.t);
          if (short) {
            undo();
            failed.set(st.t, { kind: 'hold', ...short });
          } else {
            taken = { kind: 'neutral', st };
            waived = failed.get(st.t) as { holdCost: number; income: number };
          }
        }
      }
      // #112, in contact: after the fallback's capture, every other candidate that loses no armies
      // is taken too, by armies sent, then id — when every hold stays covered and income does not
      // fall. Its survivors at risk never exceed the armies it sends, so rule 4d does not stop one
      // either (#114); the rationale says when the new border may fall. A conceded border never
      // attacks out for one. Why one was not taken is kept for the list of dropped candidates.
      const free: { pick: Pick; exposed?: { survivors: number; threat: number } }[] = [];
      /** Why a candidate that loses nothing was not also taken, as a clause after its name. */
      const freeWhy = new Map<number, string>();
      if (contact && taken) {
        ps.evenTradesOnly = true;
        const others = picks
          .filter((p) => p !== taken && loss.get(p.st.t)!.lost === 0)
          .sort((a, b) => loss.get(a.st.t)!.sent - loss.get(b.st.t)!.sent || a.st.t - b.st.t);
        for (const pick of others) {
          const t = pick.st.t;
          if (captured.has(t)) continue;
          if (gainWith([t]) < 0) {
            freeWhy.set(t, 'is not taken: with the captures planned it would lower next income');
            continue;
          }
          const now: Cand = { ...reachOf(t), t, cost: pick.st.cost };
          if (now.from === undefined) {
            freeWhy.set(t, `cannot be reached after the first capture: ${blockedText(now)}`);
            continue;
          }
          if (conceded.has(now.from)) {
            freeWhy.set(t, `is not taken: only conceded ${label(now.from)} could still attack it, and a conceded border never attacks out for a capture that only costs nothing`);
            continue;
          }
          const undo = attempt(now, reasonFor(pick));
          if (!undo) {
            freeWhy.set(t, failText(now, (ps.refusal as typeof ps.refusal) ?? { kind: 'size' }));
            continue;
          }
          const lost = tradeOf(t).lost;
          if (lost > 0) {
            undo();
            freeWhy.set(t, `is not taken: after the first capture it would lose ~${lost} ${lost === 1 ? 'army' : 'armies'}, so it no longer costs nothing`);
            continue;
          }
          const short = holdLeftShort(t);
          if (short) {
            undo();
            freeWhy.set(t, failText(now, { kind: 'hold', ...short }));
            continue;
          }
          free.push({ pick, exposed: exposure(t) });
        }
        ps.evenTradesOnly = false;
      }
      // Enemy targets added for this rule and not taken are dropped again.
      for (const t of added) if (!captured.has(t)) targets.delete(t);
      // A capture of a player's territory refused as a trade below even, or for a hold it would
      // leave short: said whatever was taken.
      for (const e of enemySteps) {
        const f = failed.get(e.t);
        if (captured.has(e.t)) continue;
        if (f?.kind === 'trade')
          warnings.push(
            `Not attacking ${label(e.t)}: the combined capture loses ${f.lost} armies for the ${f.killed} it kills, a trade below even.`,
          );
        if (f?.kind === 'hold')
          warnings.push(
            `Not attacking ${label(e.t)}: it would leave ${label(f.from)} unable to hold its border (${holdText(f)}).`,
          );
      }
      if (taken) {
        const t = taken.st.t;
        rationale.push(`Take ${label(t)} though no planned capture is economic: ${why}.`);
        if (waived)
          rationale.push(
            `Take ${label(t)} though the frontier would then need ${waived.holdCost} next turn to hold, more than the next income of ${waived.income}: rule 4d's frontier stop is waived for this one capture: in the opening, one capture that grows the frontier is better than none (rule 4d still applies to every other capture).`,
          );
        if (taken.kind === 'enemy') {
          const e = taken.st;
          const { lost, killed } = tradeOf(t);
          rationale.push(`Attack on ${label(t)} kills ${killed} for ${lost} lost: a trade of at least even.`);
          if (ffaFronts)
            rationale.push(
              e.front !== undefined
                ? `Player ${e.player} can already attack me (${label(e.front)}): taking ${label(t)} opens no new front.`
                : `Player ${e.player} cannot attack me now: taking ${label(t)} opens a second front (no second front in an FFA), taken only because no neutral capture fits this turn.`,
            );
        } else {
          // The bonus with the fewest armies to finish was passed over: say why.
          const st = taken.st;
          const closer = st.f.cost > fewest ? steps.find((x) => x.f.cost === fewest) : undefined;
          if (closer) {
            const fail = failed.get(closer.t);
            rationale.push(
              `${bonusName(closer.id)} has fewer armies to finish (${closer.f.cost}), but ${
                fail?.kind === '4d'
                  ? `rule 4d's frontier stop refuses ${label(closer.t)}`
                  : fail?.kind === 'size' || fail === undefined
                    ? closer.from === undefined
                      ? `${label(closer.t)} ${failText(closer, fail)}`
                      : `${label(closer.t)} needs ${closer.cost} and at most ${closer.reach} can reach it this turn`
                    : `${label(closer.t)} ${failText(closer, fail)}`
              }.`,
            );
          }
        }
        for (const { pick, exposed } of free) {
          const t = pick.st.t;
          rationale.push(
            `Also take ${label(t)}: it costs nothing (it loses no armies, every hold stays covered and income does not fall)${
              exposed
                ? `; its ${survivorsText(exposed.survivors)} may fall next turn (a threat of ${exposed.threat} against them), no more than the armies it sends`
                : ''
            }.`,
          );
          if (pick.kind === 'enemy' && ffaFronts && pick.st.secondFront)
            rationale.push(
              `Player ${pick.st.player} cannot attack me now: taking ${label(t)} opens a second front, taken only because it costs nothing.`,
            );
        }
      } else if (picks[0]) {
        const top = picks[0];
        const head =
          top.kind === 'neutral'
            ? `Standing still: no capture is planned, and the cheapest expansion (${label(top.st.t)}, ${top.st.cost} armies, toward bonus ${bonusName(top.st.id)})`
            : `Standing still: no capture is planned, and the cheapest capture (${label(top.st.t)}, ${top.st.cost} armies, a territory of player ${top.st.player})`;
        const tail = `${failText(top.st, failed.get(top.st.t))}.`;
        warnings.push(`${head} ${tail}`);
        const why = failed.get(top.st.t);
        if (top.kind === 'neutral' && (why === undefined || why.kind === 'size'))
          saveStep = { t: top.st.t, bonusId: top.st.id, cost: top.st.cost };
      }
      // #114, in contact: every candidate the fallback considered and dropped leaves a reason (the
      // top one, when nothing is taken, is in the stand-still warning). One already said elsewhere
      // is not repeated: an enemy capture refused as a trade or for a hold has its "Not attacking"
      // warning.
      const dropped = (contact ? picks : []).flatMap((p) => {
        const t = p.st.t;
        if (captured.has(t) || (!taken && p === picks[0])) return [];
        const fail = failed.get(t);
        if (fail && p.kind === 'enemy' && (fail.kind === 'trade' || fail.kind === 'hold')) return [];
        if (fail) return [`${label(t)} ${failText(p.st, fail)}`];
        const why = freeWhy.get(t);
        if (why) return [`${label(t)} ${why}`];
        if (!taken) return [`${label(t)} ${failText(p.st, undefined)}`];
        if (shortOf(p.st) > 0) return [`${label(t)} ${failText(p.st, undefined)}`];
        const after = `is ranked after ${label(taken.st.t)}`;
        if (p.kind === 'enemy' && p.st.secondFront && !(taken.kind === 'enemy' && taken.st.secondFront))
          return [`${label(t)} ${after}: player ${p.st.player} cannot attack me now, so it is tried only after every other capture`];
        const c = costOfPick(t);
        const tc = costOfPick(taken.st.t);
        return [
          `${label(t)} ${after}: it costs ${c} (${lossText(t)}) against ${tc}${c === tc ? ' (ties go by armies sent, then a bonus, then id)' : ''}`,
        ];
      });
      if (dropped.length) rationale.push(`Other candidates not taken: ${dropped.join('; ')}.`);
    }
  }
  return { saveStep };
}
