// The targets of a planning pass (#133): the enemy bonuses I could break and the counter-attacks
// (under `balanced`, #72), the territories next to mine a capture may take (rule 2, #203's lead
// steps), what a capture adds to the frontier (rule 4d, #71), the offence report (#72), the
// bonuses worth working toward and their order (rule 4, R3, #70, #101, #125, #167). Read once the
// holds are defined; the capture passes (plan/captures.ts) and the strike passes work from them.
import type { TerritoryState } from '../../board.js';
import { analyzeBonus, bonusTerritories } from '../bonuses.js';
import { straightKills } from '../combat.js';
import { bfsDistances, neighborsOf } from '../graph.js';
import {
  DEFENSE_DISCOUNT,
  HIDDEN_POOL_INCOMES,
  NEUTRAL_BORDER_COST,
  ownerShown,
  TRACKED_MIN_TURNS,
  visibleState,
  WASTELAND_FACTOR,
  type BonusPlan,
  type OffenceEntry,
  type PlanInput,
  type Target,
} from './shared.js';
import type { Holds } from './holds.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Threats } from './threats.js';
import { byNum } from './util.js';


export interface Breakable {
  bonusId: number;
  value: number;
  player: number;
  /** Why an inferred bonus is probably held (absent when every member is visible). */
  probable?: string;
}

export interface Counter {
  player: number;
  from: number;
  to: number;
  costNow: number;
  costThen: number;
}

/**
 * #203: why a bonus pass's last try at a lead step failed, for its "Not attacking" line: short
 * (the source it tried, what that source could spare and what of this turn's deploy could still
 * reach it, both measured then; no source: none was free), refused by R3 or a trade below even,
 * or stopped by rule 4d's frontier budget. A try that succeeds clears it.
 */
export type LeadTry =
  | { kind: 'short'; from?: number; spare: number; reach: number }
  | { kind: 'r3' }
  | { kind: 'trade'; lost: number; killed: number }
  | { kind: 'frontier' };

export type Targets = ReturnType<typeof targetsPhase>;

/** The targets, the frontier costs and the bonus plans, in the order planPass defined them. */
export function targetsPhase(
  pc: PlanCtx,
  ps: PlanState,
  input: PlanInput,
  threats: Threats,
  hd: Holds,
) {
  const c0 = breakTargets(pc, input);
  const c1 = { ...c0, ...captureTargets(pc, ps, input, threats, c0) };
  const c2 = { ...c1, ...frontierCosts(pc, threats, hd, c1) };
  const c3 = { ...c2, ...bonusScoring(pc, ps, threats, c2) };
  const c4 = { ...c3, ...closestBonus(pc, ps, input, c3) };
  return c4;
}

/** The enemy bonuses I could break and the counter-attacks (under `balanced`, #72). */
export function breakTargets(pc: PlanCtx, input: PlanInput) {
  const { g, me, foe, balanced, territories: state, mineSet, unitsAt, costAt } = pc;
  // ---- enemy bonuses I could break (under `balanced`) ----
  // A bonus is breakable when every territory in it is visible and held by one enemy, or (#72)
  // when the opponent tracker infers it behind the fog: its track (over at least
  // TRACKED_MIN_TURNS observed turns) lists it in every combination of bonuses that fits the
  // opponent's income gap (all of them listed), or in its single best fit (the first listed, with
  // fewer bonuses than the next), and on this board every member
  // is that opponent's or hidden. Such a break is "probable".
  const breakable: Breakable[] = [];
  const breakMember = new Set<number>();
  if (balanced) {
    for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
      const ts = bonusTerritories(g, b.id);
      if (b.value <= 0 || !ts.length) continue;
      const owners = new Set<number>();
      let visible = true;
      for (const t of ts) {
        const st = state.get(t);
        if (st?.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null) visible = false;
        else owners.add(st.owner.playerId);
      }
      if (visible && owners.size === 1) {
        breakable.push({ bonusId: b.id, value: b.value, player: [...owners][0]! });
        for (const t of ts) breakMember.add(t);
        continue;
      }
      // Inferred (#72): one opponent's visible members, the rest hidden, and its track fits it.
      if (owners.size !== 1) continue;
      const player = [...owners][0]!;
      const hiddenOrTheirs = ts.every((t) => {
        const st = ownerShown(state.get(t));
        return st === undefined || (st.owner.kind === 'player' && st.owner.playerId === player);
      });
      if (!hiddenOrTheirs) continue;
      const tr = input.tracks?.find((x) => x.playerId === player);
      const fits = tr && tr.income !== null && tr.turns.length >= TRACKED_MIN_TURNS ? tr.inferred?.candidates : undefined;
      if (!fits?.length) continue;
      // "Every" only when the tracker listed every fit (no "and N more"). The best fit must be
      // strictly smaller than the next: equal-sized fits are ordered only by bonus id.
      const more = tr!.inferred!.more;
      const inEvery = more === 0 && fits.every((c) => c.bonusIds.includes(b.id));
      const single = fits.length === 1 && more === 0;
      const inBest =
        fits[0]!.bonusIds.includes(b.id) && (single || (fits[1] !== undefined && fits[0]!.bonusIds.length < fits[1].bonusIds.length));
      if (!inEvery && !inBest) continue;
      breakable.push({
        bonusId: b.id,
        value: b.value,
        player,
        probable: inEvery
          ? 'in every combination of bonuses that fits its income gap'
          : 'in the best fit of its income gap',
      });
      for (const t of ts) breakMember.add(t);
    }
  }

  // ---- counter-attacks (under `balanced`, #72) ----
  // An enemy stack next to me that shrank since the previous board by attacking me: visible on
  // both boards under the same owner (F1, #69), every neighbour visible on both, one of them a
  // territory I held on both, every neighbour that was neither mine nor its owner's unchanged in
  // owner and armies (else it may have expanded or hit a third player), and the shrink not
  // absorbed by its own neighbours' growth (a transfer). The boards cannot tell its attack on me
  // from my failed attack on it (both shrink it next to me), so the rationale says "fighting me":
  // either way it is cheaper to take now. When it is now cheaper to take than it was, it is a strike candidate scored like
  // a break (rule 4a). A member of a breakable bonus is a break instead.
  const counterAt = new Map<number, Counter>();
  if (balanced && input.previousBoard) {
    const before = new Map(input.previousBoard.territories.map((t) => [t.territoryId, t]));
    const heldBy = (st: TerritoryState | undefined, p: number) => st?.owner.kind === 'player' && st.owner.playerId === p;
    for (const [id, st] of [...state].sort((a, b) => a[0] - b[0])) {
      if (st.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null || breakMember.has(id)) continue;
      const p = st.owner.playerId;
      const ns = neighborsOf(g, id);
      if (!ns.some((n) => mineSet.has(n))) continue;
      const was = visibleState(before.get(id));
      if (!heldBy(was, p) || was!.armies! <= st.armies) continue;
      if (!ns.every((n) => visibleState(state.get(n)) && visibleState(before.get(n)))) continue;
      if (!ns.some((n) => mineSet.has(n) && heldBy(before.get(n), me))) continue;
      // Pinned on me: every neighbour that was neither mine nor theirs keeps its owner and armies.
      // A neutral it took (an expansion) or a third player it hit could have spent the shrink.
      const elsewhere = ns.some((n) => {
        const a = state.get(n)!;
        const b = before.get(n)!;
        if (heldBy(b, me) || heldBy(b, p)) return false;
        const owner = (x: TerritoryState) => (x.owner.kind === 'player' ? x.owner.playerId : x.owner.kind);
        return owner(a) !== owner(b) || a.armies !== b.armies;
      });
      if (elsewhere) continue;
      const absorbed = ns.reduce((sum, n) => {
        const a = state.get(n)!;
        const b = before.get(n)!;
        return heldBy(a, p) && heldBy(b, p) ? sum + Math.max(0, a.armies! - b.armies!) : sum;
      }, 0);
      if (was!.armies! - st.armies <= absorbed) continue;
      const costNow = costAt(id);
      const costThen = costAt(id, was!.armies! + unitsAt(id));
      if (costNow === null || costThen === null || costNow >= costThen) continue;
      counterAt.set(id, { player: p, from: was!.armies!, to: st.armies, costNow, costThen });
    }
  }
  return { breakable, breakMember, counterAt };
}

/** Rule 2: the targets next to mine, and the lead steps into a bonus on an army lead (#203). */
export function captureTargets(
  pc: PlanCtx,
  ps: PlanState,
  input: PlanInput,
  threats: Threats,
  prev: ReturnType<typeof breakTargets>,
) {
  const {
    g, foe, profile, auto, goal, balanced, territories: state, label, mineSet, unitsAt, uncounted, uncountedKind,
    defenceAt, bonusTs, costAt, noSplit, leadLever, leadText,
  } = pc;
  const { warnings } = ps;
  const { reinforcementAt, hiddenFoe, hiddenMovable, hiddenPool } = threats;
  const { breakMember, counterAt } = prev;
  // ---- 2. targets ----
  const targets = new Map<number, Target>();
  /**
   * #203: adapting in a free-for-all on a big army lead (the lead strikes' conditions, #167), an
   * enemy member of a positive bonus next to mine (no special unit on it) is a step into that bonus
   * like a neutral one — sized like a lead strike (its defenders plus what its owner may deploy
   * there first), so the bonus passes fund it from this turn's deploy in rule 4f's order, under the
   * Local Deployment pools. Left to the lead strikes, which run once the income is spent, the
   * closest bonus's enemy member lost its deploy to a farther bonus's step.
   */
  const leadSteps = new Map<number, { player: number; defenders: number; extra: number }>();
  const leadStepsOn = auto && balanced && profile.format === 'ffa' && profile.opponents >= 2 && leadLever && !noSplit;
  const leadTry = new Map<number, LeadTry>();
  /** #203: a lead step's capture reason names it, in every bonus pass that takes it. */
  const leadNote = (t: number) => {
    const lead = leadSteps.get(t);
    return lead
      ? ` — player ${lead.player}'s member, taken on my army lead (${leadText()}): sure even if player ${lead.player} deploys its ~${lead.extra} there first (${lead.defenders} + ${lead.extra} defenders)`
      : '';
  };
  for (const t of [...g.territoryById.keys()].sort(byNum)) {
    if (mineSet.has(t)) continue;
    const sources = neighborsOf(g, t).filter((n) => mineSet.has(n));
    if (!sources.length) continue;
    const st = state.get(t);
    const hiddenOwner = hiddenFoe(t);
    if (hiddenOwner !== undefined) {
      // #164: Dense / Heavy fog shows the owner and hides the armies.
      const tr = input.tracks?.find((x) => x.playerId === hiddenOwner);
      const pool = hiddenPool(hiddenOwner);
      const capped = pool.cap !== null && pool.unexplained > pool.cap;
      const bound =
        tr && tr.unexplained !== null
          ? `up to ${hiddenMovable(hiddenOwner)} armies there (player ${hiddenOwner}'s unaccounted armies from the tracker${
              capped
                ? `, ${pool.unexplained} in all, at most ${HIDDEN_POOL_INCOMES} turns of its income in one place: the rest is taken as spread over its hidden territories, and a larger bank there would not show`
                : ''
            }, counted once per border however many of its hidden territories touch it) beyond the guard`
          : 'the guard alone there (no tracker figure for its unaccounted armies)';
      warnings.push(
        `${label(t)} (player ${hiddenOwner}) borders my ${sources.map(label).join(', ')} and its armies are hidden by the fog: the threat from it counts ${bound} plus its deploy, and the win chance of an attack into it is unknown, so none is planned.`,
      );
      continue;
    }
    if (!st || st.owner.kind === 'unknown' || st.armies === null) {
      warnings.push(
        `Fogged territory ${label(t)} borders my ${sources.map(label).join(', ')}: its armies are unknown (fog), so no attack is planned.`,
      );
      continue;
    }
    if (st.owner.kind === 'available') continue;
    // A teammate's territory is never a target (#128).
    if (st.owner.kind === 'player' && !foe(st.owner.playerId)) continue;
    if (uncounted(t)) {
      warnings.push(
        `${label(t)} holds ${uncountedKind(t)}, whose strength the board does not carry: its defence is unknown, so no attack is planned on it.`,
      );
      continue;
    }
    const enemy = st.owner.kind === 'player';
    if (enemy && goal !== 'complete-bonus' && !(balanced && (breakMember.has(t) || counterAt.has(t)))) {
      if (!leadStepsOn || unitsAt(t) > 0 || !g.map.bonuses.some((b) => b.value > 0 && bonusTs.get(b.id)!.includes(t))) continue;
      const defenders = defenceAt(t);
      const extra = reinforcementAt(t);
      const sure = costAt(t, defenders + extra);
      if (sure === null) continue;
      leadSteps.set(t, { player: (st.owner as { playerId: number }).playerId, defenders, extra });
      targets.set(t, { id: t, cost: sure, enemy, sources });
      continue;
    }
    const cost = costAt(t);
    if (cost === null) continue;
    targets.set(t, { id: t, cost, enemy, sources });
  }

  // Bonus passes work toward my own bonuses; under `balanced` enemy targets are only break candidates.
  // #203: a lead step is a bonus target too.
  const bonusTarget = (t: number) => targets.has(t) && !(balanced && targets.get(t)!.enemy && !leadSteps.has(t));
  return { targets, leadSteps, leadStepsOn, leadTry, leadNote, bonusTarget };
}

/** Rule 4d: what a capture adds to the frontier (#71), and the offence report (#72). */
export function frontierCosts(
  pc: PlanCtx,
  threats: Threats,
  hd: Holds,
  prev: ReturnType<typeof breakTargets> & ReturnType<typeof captureTargets>,
) {
  const { g, guarded, mineSet, armiesOf, unitsAt, defenceAt, rates } = pc;
  const { holdArmies, threatAt } = threats;
  const { conceded, stood } = hd;
  const { targets } = prev;
  // ---- 4d. frontier cost (#71) ----
  /** Armies a capture of `t` leaves there: its attack's survivors. */
  const survivorsOf = (t: number) => targets.get(t)!.cost - Math.round((defenceAt(t) * rates.defensiveKillRate) / 100);
  /**
   * `x` as a border when I hold `held` with `have` armies on it: a border when a neighbour is not
   * held; facing an enemy when a visible enemy is next to it, and then `need` is the deploys it
   * needs next turn to hold (the R3 arithmetic: threat = movable + max(deploy, growth) per player).
   */
  const borderOf = (x: number, held: ReadonlySet<number>, have: number) => {
    if (neighborsOf(g, x).every((n) => held.has(n))) return { border: false, enemy: false, need: 0 };
    const th = threatAt(x, (n) => held.has(n));
    if (!th) return { border: true, enemy: false, need: 0 };
    const units = mineSet.has(x) ? unitsAt(x) : 0;
    return { border: true, enemy: true, need: Math.max(0, holdArmies(th.threat) - have - units) };
  };
  /**
   * A border's cost in armies: {@link NEUTRAL_BORDER_COST}, plus its hold need when it faces an
   * enemy under a guarded goal (`expand` and `complete-bonus` ignore defence, as in R3).
   */
  const borderCost = (b: ReturnType<typeof borderOf>, withNeed = true) =>
    b.border ? NEUTRAL_BORDER_COST + (guarded && withNeed ? b.need : 0) : 0;
  /**
   * The marginal frontier of adding `adds` to `base` (#71), in armies: the cost of every border
   * the capture touches after it (the captures and their held neighbours) minus their cost
   * before. Borders it opens add, borders it closes (a neighbour whose last outside neighbour it
   * takes) subtract. `haveOf` gives the armies on each territory (a capture: its survivors).
   * `needOnAdds` false leaves the captures' own hold need out (R3's defence cost already counts it).
   */
  const frontierDelta = (
    base: ReadonlySet<number>,
    adds: readonly number[],
    haveOf: (x: number) => number,
    needOnAdds = true,
  ) => {
    const after = new Set([...base, ...adds]);
    const touched = new Set(adds);
    for (const t of adds) for (const n of neighborsOf(g, t)) if (base.has(n)) touched.add(n);
    let armies = 0;
    let enemy = 0;
    for (const x of touched) {
      const now = borderOf(x, after, haveOf(x));
      armies += borderCost(now, needOnAdds || base.has(x));
      enemy += Number(now.enemy);
      if (!base.has(x)) continue;
      const was = borderOf(x, base, haveOf(x));
      armies -= borderCost(was);
      enemy -= Number(was.enemy);
    }
    return { armies, enemy };
  };
  /** Each target's frontier cost captured alone from my holdings at the start of the turn. */
  const edgeCost = new Map(
    [...targets.keys()].map((t) => [t, frontierDelta(mineSet, [t], (x) => (x === t ? survivorsOf(t) : armiesOf(x))).armies]),
  );
  /** A capture's cost in a score: its armies plus its frontier, at least one army (a cost of 0 stays 0). */
  const scoreCost = (cost: number, frontier: number) => (cost > 0 ? Math.max(1, cost + frontier) : 0);
  /** A target's cost in a score: its capture cost plus the frontier it adds alone. */
  const targetScoreCost = (t: number) => scoreCost(targets.get(t)!.cost, edgeCost.get(t)!);
  /**
   * A break's or counter-attack's cost in a score (#72): it only has to land, not survive the
   * counter-attack, so the captured territory's own hold need is left out. The rest of the
   * frontier change stays: its border weight, and my borders around it (the threat it removes).
   */
  const landScoreCost = (t: number) =>
    scoreCost(
      targets.get(t)!.cost,
      frontierDelta(mineSet, [t], (x) => (x === t ? survivorsOf(t) : armiesOf(x)), false).armies,
    );

  // ---- offence report (#72) ----
  /** The offensive options considered, by kind and target, in the order they were found. */
  const offence = new Map<string, OffenceEntry & { bonusId?: number }>();
  /** Why an offensive capture was not made, by target (the first reason wins). */
  const offenceSkip = new Map<number, string>();
  const skipOffence = (t: number, why: string) => {
    if (!offenceSkip.has(t)) offenceSkip.set(t, why);
  };
  /** Captures of a player's territory refused as a trade below even (rule 0p.3), by target. */
  const badTrades = new Map<number, { lost: number; killed: number }>();
  /**
   * The frontier when I hold `held`: borders, those facing an enemy, and the deploys they need next
   * turn to hold. A conceded border counts as a border but not in the hold cost: the plan gives it
   * up rather than pay for it (a garrison that still stands, #59, is held and counts).
   */
  const frontierOf = (held: ReadonlySet<number>, haveOf: (x: number) => number) => {
    let borders = 0;
    let enemyBorders = 0;
    let holdCost = 0;
    for (const x of [...held].sort(byNum)) {
      const b = borderOf(x, held, haveOf(x));
      borders += Number(b.border);
      enemyBorders += Number(b.enemy);
      if (!conceded.has(x) || stood.has(x)) holdCost += b.need;
    }
    return { borders, enemyBorders, holdCost };
  };
  /** The frontier's hold cost at the start of the turn (my armies then; today's concessions left out). */
  const startHold = () => frontierOf(mineSet, armiesOf).holdCost;
  return { survivorsOf, borderOf, borderCost, frontierDelta, edgeCost, scoreCost, targetScoreCost, landScoreCost, offence, offenceSkip, skipOffence, badTrades, frontierOf, startHold };
}

/** Bonus scoring (rule 4, R3, #70, #101, #125, #167): the bonuses worth working toward, best first. */
export function bonusScoring(
  pc: PlanCtx,
  ps: PlanState,
  threats: Threats,
  prev: ReturnType<typeof breakTargets> & ReturnType<typeof captureTargets> & ReturnType<typeof frontierCosts>,
) {
  const {
    g, s, opts, guarded, focus, paybackTurns, territories: state, label, mineSet, armiesOf, defenceAt, completedOver,
    territoryShare, rates, costOf, costAt, econCostAt,
  } = pc;
  const { rationale } = ps;
  const { exposure } = threats;
  const { targets, bonusTarget, survivorsOf, frontierDelta, scoreCost } = prev;
  // ---- bonus scoring ----
  /** "N armies to finish", naming the fogged members counted in it (#101). */
  const fogNote = (fogged: number, each: number) =>
    fogged ? ` (${fogged} fogged member${fogged === 1 ? '' : 's'} counted at ${each} each)` : '';
  const toFinish = (cost: number, fogged: number, each: number) => `${cost} armies to finish${fogNote(fogged, each)}`;
  const plans: BonusPlan[] = [];
  /** #167: the share of the map's territories that started as wastelands, and what one costs to take and loses. */
  const wasteShare =
    s.wastelands && s.wastelands.count > 0 && s.wastelands.size > 0 && g.territoryById.size > 0
      ? Math.min(1, s.wastelands.count / g.territoryById.size)
      : 0;
  const wasteCost = wasteShare > 0 ? (costOf(s.wastelands!.size) ?? Infinity) : 0;
  const wasteLoss = wasteShare > 0 ? Math.min(wasteCost - 1, straightKills(s.wastelands!.size, rates.defensiveKillRate)) + 1 : 0;
  /** Every positive bonus worth completing (net > 0) still missing members: its armies to finish (rule 4e). */
  const finishCost = new Map<number, { cost: number; value: number; net: number; fogged: number; fogEach: number }>();
  const economicMember = new Set<number>();
  const uneconomicMember = new Set<number>();
  /** Missing members of a negative bonus (not focused): plain expansion never steps into one. */
  const negativeMember = new Set<number>();
  /** #201: a remembered neutral's rationale line (its index) and the bonuses it names. */
  const rememberedSaid = new Map<number, { at: number; bonuses: string[] }>();
  for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
    const isFocus = focus.has(b.id);
    const ts = bonusTerritories(g, b.id);
    const remaining = ts.filter((t) => !mineSet.has(t));
    if (b.value < 0 && !isFocus) {
      // Completing it would cut income: never plan into it (an economic
      // membership elsewhere still wins — see the pass-3 filter).
      for (const t of remaining) {
        uneconomicMember.add(t);
        negativeMember.add(t);
      }
      continue;
    }
    if (b.value <= 0 && !isFocus) continue;
    if (!remaining.length) continue;
    // Cluster as a unit (#70): the negative bonuses its missing members complete come off its
    // worth (on a map without negative bonuses, net = value).
    const rest = new Set(remaining);
    const penalties = completedOver((x) => mineSet.has(x) || rest.has(x), remaining).filter((id) => id !== b.id && g.bonusById.get(id)!.value < 0);
    const penalty = penalties.reduce((n, id) => n + g.bonusById.get(id)!.value, 0);
    // #125: its missing members' per-territory income (Extra Armies for Territories) is income too.
    const perGain = territoryShare(remaining.length);
    const net = b.value + penalty + perGain;
    if (penalty < 0 && remaining.some(bonusTarget))
      rationale.push(
        `Bonus ${b.name} (#${b.id}) (+${b.value}) is worth +${net} net once complete: its missing members also complete ${penalties.length} negative bonus${penalties.length === 1 ? '' : 'es'} (${penalty}), and each step short of completion only adds penalties.`,
      );
    if (net <= 0 && !isFocus) {
      for (const t of remaining) uneconomicMember.add(t);
      if (remaining.some(bonusTarget))
        rationale.push(`Skip bonus ${b.name} (#${b.id}): completing it costs more income than it pays (net ${net}).`);
      continue;
    }
    // Armies to finish (#101): every missing member's capture cost. A fogged member counts at its
    // bonus's costliest visible missing member (it cannot be costed, and counting it as free made
    // the figure jump when it came into view); with none visible, the bonus cannot be costed.
    let cost = 0;
    let worst = 0;
    let fogged = 0;
    // #125: the economy test charges the armies lost, not the armies sent.
    let loss = 0;
    let worstLoss = 0;
    for (const t of remaining) {
      const st = state.get(t);
      if (!st || st.owner.kind === 'unknown' || st.armies === null) {
        // #201: a neutral the picking board showed keeps its size (an owner the fog shows is not one).
        const was = opts.rememberedNeutrals?.get(t);
        if (was === undefined || (st && st.owner.kind === 'player')) {
          fogged++;
          continue;
        }
        const c = costAt(t, was) ?? Infinity;
        cost += c;
        worst = Math.max(worst, c);
        const l = Math.min(c - 1, straightKills(was, rates.defensiveKillRate)) + 1;
        loss += l;
        worstLoss = Math.max(worstLoss, l);
        if (remaining.some(bonusTarget)) {
          // Said once per territory, naming every bonus it is costed in.
          const said = rememberedSaid.get(t);
          const tail = `${label(t)}, fogged now, was a neutral of ${was} on the picking board (#201): costed at that.`;
          if (said) {
            said.bonuses.push(`${b.name} (#${b.id})`);
            rationale[said.at] = `${said.bonuses.join(', ')}: ${tail}`;
          } else {
            rememberedSaid.set(t, { at: rationale.length, bonuses: [`${b.name} (#${b.id})`] });
            rationale.push(`${b.name} (#${b.id}): ${tail}`);
          }
        }
        continue;
      }
      const c = costAt(t) ?? Infinity;
      cost += c;
      worst = Math.max(worst, c);
      const l = econCostAt(t);
      loss += l;
      worstLoss = Math.max(worstLoss, l);
    }
    let fogEach = fogged ? (fogged < remaining.length ? worst : Infinity) : 0;
    let fogLoss = fogged ? (fogged < remaining.length ? worstLoss : Infinity) : 0;
    // #167: with automatic Wastelands, a fogged member may be one: its expected surcharge over an
    // ordinary member is (wastelands ÷ territories on the map) × (a wasteland's cost − this one's).
    if (wasteShare > 0 && fogged && Number.isFinite(fogEach)) {
      const extra = Math.ceil(wasteShare * Math.max(0, wasteCost - fogEach));
      const extraLoss = Math.ceil(wasteShare * Math.max(0, wasteLoss - fogLoss));
      if (extra > 0) {
        fogEach += extra;
        fogLoss += extraLoss;
        if (remaining.some(bonusTarget))
          rationale.push(
            `${b.name} (#${b.id}): its ${fogged} fogged member${fogged === 1 ? '' : 's'} may be ${fogged === 1 ? 'a wasteland' : 'wastelands'} (${s.wastelands!.count} of the map's ${g.territoryById.size} territories start at ${s.wastelands!.size}): +${extra * fogged} armies expected.`,
          );
      }
    }
    cost += fogged * fogEach;
    loss += fogged * fogLoss;
    if (b.value > 0) finishCost.set(b.id, { cost, value: b.value, net, fogged, fogEach });
    const economic = isFocus || (loss <= paybackTurns * net && worstLoss <= WASTELAND_FACTOR * net);
    for (const t of remaining) (economic ? economicMember : uneconomicMember).add(t);
    if (!remaining.some(bonusTarget)) continue;
    if (!economic) {
      rationale.push(
        `Skip bonus ${b.name} (#${b.id}): uneconomic for +${net === b.value ? b.value : `${b.value} (net +${net})`} (${toFinish(cost, fogged, fogEach)}, losing ~${loss}; ${worstLoss} lost on its costliest territory).`,
      );
      continue;
    }
    // R3: what holding the completed bonus's frontier would cost next turn (each
    // remaining member holding the survivors of its capture, mine their armies now).
    let defenseCost = 0;
    if (guarded && remaining.every(bonusTarget)) {
      const rem = new Set(remaining);
      const exposed = exposure(ts, (n) => rem.has(n), (m) => {
        if (!rem.has(m)) return armiesOf(m);
        const c = targets.get(m)!.cost;
        return c - straightKills(defenceAt(m), rates.defensiveKillRate);
      });
      defenseCost = exposed.reduce((sum, e) => sum + e.need, 0);
      if (defenseCost > 0)
        rationale.push(
          `Bonus ${b.name} (#${b.id}) needs ~${defenseCost} more armies next turn to hold its frontier once completed (${exposed.map((e) => `${label(e.id)} ${e.need}`).join(', ')}): its score is +${b.value} / (${cost} + ${DEFENSE_DISCOUNT} × ${defenseCost}).`,
        );
    }
    // #71: the frontier its missing members add (their hold need left out when R3 judged it).
    const reach = remaining.filter((t) => targets.has(t));
    const frontier = frontierDelta(
      mineSet,
      reach,
      (x) => (mineSet.has(x) ? armiesOf(x) : survivorsOf(x)),
      !(guarded && remaining.every(bonusTarget)),
    ).armies;
    plans.push({
      bonusId: b.id,
      value: b.value,
      focus: isFocus,
      remaining,
      completable: remaining.every(bonusTarget),
      cost,
      borders: analyzeBonus(g, b.id)!.borderTerritoryIds.length,
      defenseCost,
      net,
      frontier,
      fogged,
      fogEach,
    });
  }
  const ratio = (p: BonusPlan) => {
    const cost = scoreCost(p.cost + DEFENSE_DISCOUNT * p.defenseCost, p.frontier);
    return cost > 0 ? p.net / cost : Infinity;
  };
  plans.sort(
    (a, b) =>
      Number(b.focus) - Number(a.focus) || ratio(b) - ratio(a) || a.borders - b.borders || a.bonusId - b.bonusId,
  );
  return { fogNote, toFinish, plans, wasteShare, wasteCost, wasteLoss, finishCost, economicMember, uneconomicMember, negativeMember, rememberedSaid, ratio };
}

/** #101: commit to the bonus closest to completion; a break's retake check. */
export function closestBonus(
  pc: PlanCtx,
  ps: PlanState,
  input: PlanInput,
  prev: ReturnType<typeof breakTargets> & ReturnType<typeof captureTargets> & ReturnType<typeof frontierCosts> & ReturnType<typeof bonusScoring>,
) {
  const { g, me, income, profile, territories: state, label, bonusName, mine, mineSet, bonusTs, toTake } = pc;
  const { rationale } = ps;
  const { fogNote, plans } = prev;
  // ---- #101: commit to the closest bonus ----
  // While no bonus is held (and in the opening and expansion phases), expansion goes to the bonus
  // closest to completion — fewest turns to finish at this income (its armies to finish, counting
  // the members I hold, over the income) — then the next closest, instead of one capture into each
  // of several large bonuses by value per army. Bonuses as close as each other keep the score order
  // (value per army, rule 4), except that a bonus advanced last turn (a member captured since
  // `previousBoard`) keeps priority unless another is strictly closer. Focused bonuses come first.
  const holdsBonus = g.map.bonuses.some((b) => {
    const ts = bonusTs.get(b.id)!;
    return b.value > 0 && ts.length > 0 && ts.every((t) => mineSet.has(t));
  });
  // #132: in an FFA, contact with one front still leaves neutrals to expand into: keep committing
  // while any neutral borders a territory of mine.
  const neutralsInReach =
    profile.format === 'ffa' && mine.some((t) => neighborsOf(g, t).some((n) => state.get(n)?.owner.kind === 'neutral'));
  const committing = !holdsBonus || profile.phase === 'opening' || profile.phase === 'expansion' || neutralsInReach;
  const advancedLast = new Set<number>();
  if (input.previousBoard) {
    const before = new Map(input.previousBoard.territories.map((t) => [t.territoryId, t]));
    for (const p of plans) {
      const took = bonusTs.get(p.bonusId)!.some((t) => {
        const o = before.get(t)?.owner;
        return mineSet.has(t) && o !== undefined && o.kind !== 'unknown' && !(o.kind === 'player' && o.playerId === me);
      });
      if (took) advancedLast.add(p.bonusId);
    }
  }
  /**
   * #125: the layers a bonus's missing members are reached in — the farthest one's distance from
   * what I hold. A capture's armies attack no further this turn, so a chain takes a turn a layer
   * however cheap its members are.
   */
  const fromMine = bfsDistances(g, mine);
  const depthOf = (p: BonusPlan) => Math.max(0, ...p.remaining.map((t) => fromMine.get(t) ?? 0));
  /** Turns to finish a bonus at this income, and at least its depth (with no income, its armies to finish). */
  const turnsOf = (p: BonusPlan) => (income > 0 ? Math.max(Math.ceil(p.cost / income), depthOf(p)) : p.cost);
  const scoreRank = new Map(plans.map((p, i) => [p.bonusId, i]));
  /** Bonus plans closest to completion first (focus first; ties: advanced last turn, then the score order). */
  const byCloseness = committing
    ? [...plans].sort(
        (a, b) =>
          Number(b.focus) - Number(a.focus) ||
          turnsOf(a) - turnsOf(b) ||
          Number(advancedLast.has(b.bonusId)) - Number(advancedLast.has(a.bonusId)) ||
          scoreRank.get(a.bonusId)! - scoreRank.get(b.bonusId)!,
      )
    : plans;
  const turnsText = (p: BonusPlan) => {
    const n = turnsOf(p);
    const deep = n > Math.ceil(p.cost / income) ? ` (${n} layers deep)` : '';
    return income > 0 ? `${n} turn${n === 1 ? '' : 's'}${deep}` : 'no income';
  };
  if (committing && byCloseness.length > 1) {
    const why = holdsBonus
      ? `${profile.phase[0]!.toUpperCase()}${profile.phase.slice(1)} phase${
          profile.phase === 'opening' || profile.phase === 'expansion' ? '' : ', neutrals in reach'
        }`
      : 'No bonus held';
    rationale.push(
      `${why}: expansion goes to the bonus closest to completion first — ${byCloseness
        .map(
          (p, i) =>
            `${bonusName(p.bonusId)} ${i ? p.cost : `${p.cost} armies to finish`}${fogNote(p.fogged, p.fogEach)}, ${turnsText(p)}${i || income <= 0 ? '' : ` at income ${income}`}`,
        )
        .join(', ')} — and a farther bonus gets only armies the closer ones cannot use.`,
    );
    const top = byCloseness.find((p) => !p.focus);
    for (const p of byCloseness.filter((x) => advancedLast.has(x.bonusId))) {
      if (p === top)
        rationale.push(
          `${bonusName(p.bonusId)} keeps priority: I advanced it last turn, and no bonus is strictly closer to completion.`,
        );
      else if (top && !p.focus && turnsOf(top) < turnsOf(p))
        rationale.push(
          `${bonusName(p.bonusId)}, advanced last turn, gives way to ${bonusName(top.bonusId)}: it is strictly closer to completion (${turnsText(top)} to finish against ${turnsText(p)}).`,
        );
    }
  }
  /**
   * A break's retake check, by its target: the warning it raised (if any) and what it was
   * judged on, so a top-up that adds survivors re-judges it.
   */
  const retakeChecks = new Map<number, { bonusId: number; survivors: number; counter: number; warning?: string }>();
  const retakeWarning = (t: number, bonusId: number, survivors: number, counter: number): string | undefined => {
    const take = toTake(survivors);
    return take !== null && take <= counter
      ? `${label(t)} can be retaken after it breaks ${bonusName(bonusId)}: ${survivors} survivors need ${take} to take, against ~${counter} next turn.`
      : undefined;
  };
  return { holdsBonus, neutralsInReach, committing, advancedLast, fromMine, depthOf, turnsOf, scoreRank, byCloseness, turnsText, retakeChecks, retakeWarning };
}
