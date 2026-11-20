// Rule 5, the leftover deploy (#72, #102, #103, #121, #124, #125, #163, #215, #218, #265, #268; #133): the
// income no capture or hold took goes, in order, to a conceded border it can make hold after all (its
// withdrawal taken back; only without a strike stack, where the leftover would buy comfort), to
// each member of a bonus this turn's captures complete that falls to the enemy beside it (#265), to
// the borders that fall without the armies withdrawn into them unless I am known to move first
// (#215), to the borders short of their hold before the strike stack, then to the strike
// stack, the territory with the most income at stake as a deterrent guard (#440), the short borders'
// comfortable margins (#218: the rest on the step's source when it
// defends as well; #268: else spread over the borders facing one opponent for equal headroom
// over its deploy), the step it saves toward, the expansion stack (#218: with no front in view,
// the territory central to what I hold instead when the stack lies far from it; #288: with the
// attacks out of it when it has nothing left to attack once they land: first what each next step
// from their targets needs, then the rest offered to another capture, rule 5b's), the most fogged
// border or the biggest stack — split against a Bomb when it concentrates for
// nothing — and under Local Deployment each pool's rest inside its bonus. planPass runs it where
// it ran before: after rule 1c's second reconsideration and the strike stack's choice, before the
// strike stack is spent.
import { bonusTerritories } from '../bonuses.js';
import { straightKills } from '../combat.js';
import { bfsDistances, neighborsOf } from '../graph.js';
import { chargeDeploys } from '../local-deploy.js';
import { plainEconomy, plainEligible } from './after-leftover.js';
import { completedMembers } from './completed.js';
import { COMFORT_MARGIN, type PlannedMove } from './shared.js';

/** #218 (comment): hops the expansion stack may lie farther from my farthest border than the centre before the leftover stays central. */
export const CENTRE_SLACK = 1;
/** #440: the least protected value of the territory a deterrent guard goes to. */
export const DETERRENT_MIN_VALUE = 5;
/** #440: how many times the most any border being topped up protects that territory must protect. */
export const DETERRENT_VALUE_RATIO = 2;
import { knownFirst, lateArrivals, lateNet, type Holds } from './holds.js';
import type { DeployBook } from './orders.js';
import type { SaveStep } from './stand-still.js';
import type { PlanCtx, PlanState } from './state.js';
import { stackFacing, type StrikeStack } from './strike.js';
import type { Targets } from './targets.js';
import type { Border, Threats } from './threats.js';

/** #288: the rest of the leftover, offered to another capture this turn on `at`. */
export interface LeftoverOffer {
  at: number;
  /** Sends it with the attacks out of the expansion stack after all (no capture took it). */
  revert: () => void;
}

/** #288: an attack the leftover may join, and what the next step from its target needs. */
interface JoinStep {
  m: PlannedMove;
  need: number;
  step?: number;
  cost?: number;
  movable: number;
  /** The leftover covers its need whole. */
  funded?: boolean;
}

/** #125: the step the leftover saved toward, and its source, which idle stacks stage toward (rule 6). */
export interface Staging {
  t: number;
  bonusId: number;
  cost: number;
  from: number;
}

/**
 * The leftover deploy (rule 5). `stack` is the strike stack rule 0p.3c chose (plan/strike.ts),
 * `open` and `stays` planPass's views of a border; it returns the strike stack with the leftover
 * it got (only when the leftover reached it), what each Local Deployment pool put on its border
 * (#103), and the step it saved toward (#125).
 */
export function leftoverDeploy(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hd: Holds,
  tgt: Targets,
  saveStep: SaveStep | undefined,
  stack: Omit<StrikeStack, 'deployed'> | undefined,
  open: (id: number) => boolean,
  stays: (id: number) => number,
) {
  const { g, territories: state, label, bonusName, mine, mineSet, armiesOf, unitsAt, toTake, noSplit, bombOn } = pc;
  const { warnings, rationale, deployed, avail, locked, captured, moves, incoming } = ps;
  const { orderOf, deploy, undeploy, pools, roomAt, valueOf } = book;
  const { borders } = threats;
  const { conceded, kept, garrisoned, stood, threatened, stayAt } = hd;
  const { committing, byCloseness, bonusTarget, targets, repulsed } = tgt;
  // As the deploy book reads it, restated here so TypeScript narrows `pools` wherever it is tested.
  const local = pools !== null && pools.bonuses.length > 0;
  /** The strike stack rule 0p.3c built this turn (#72), and the leftover it got. */
  let strikeStack: StrikeStack | undefined;
  /** Armies a Local Deployment pool put on each border this turn (#103): never moved out. */
  const poolDeployed = new Map<number, number>();
  /**
   * #288: the rest of the leftover offered to another capture this turn (its territory), and how to send
   * it with the attacks after all when rule 5b takes nothing from there (planPass calls `revert`).
   */
  let offered: LeftoverOffer | undefined;
  /**
   * #125: the capture to save toward — rule 4e's top step it could not afford, else (rule 4f
   * committing) the closest bonus's cheapest missing member in reach when this turn made no capture
   * into that bonus — and its source: my territory beside it (open, not a softener, issuing no
   * order under No-Split) with the most armies free, ties by id.
   */
  const stepSource = (
    open: (x: number) => boolean,
    notSoftening: (x: number) => boolean,
  ): { t: number; bonusId: number; cost: number; from: number; holdThreat?: number } | undefined => {
    let step = saveStep;
    if (!step && committing) {
      for (const p of byCloseness) {
        if (p.remaining.some((t) => captured.has(t))) return undefined;
        const t = p.remaining
          .filter((x) => bonusTarget(x) && state.get(x)?.owner.kind === 'neutral')
          .sort((a, b) => targets.get(a)!.cost - targets.get(b)!.cost || a - b)[0];
        if (t === undefined) continue;
        step = { t, bonusId: p.bonusId, cost: targets.get(t)!.cost };
        break;
      }
    }
    if (!step || captured.has(step.t)) return undefined;
    const from = neighborsOf(g, step.t)
      .filter((x) => mineSet.has(x) && open(x) && notSoftening(x) && !orderOf(x))
      .sort((a, b) => avail.get(b)! - avail.get(a)! || a - b)[0];
    if (from === undefined) return undefined;
    // Only a step this turn cannot afford: one the plan could take but did not (R3, rule 4c or 4d
    // refused it) is no reason to save. #218 (comment): affording it means sending its cost and
    // still holding the source's border (as rule 4e's hold check judges an attack: armies
    // withdrawn into it count only when I am known to move first) — live, a source that had grown
    // enough to pay for the step by size alone, not for the step and its hold, stopped saving.
    const room = roomAt(from);
    if (avail.get(from)! + room < step.cost) return { ...step, from };
    const b = threats.borderAt(from, (n) => n === step.t);
    if (!b) return undefined;
    const left = stayAt(from) - lateArrivals(pc, ps, from) + room - step.cost;
    if ((toTake(left + unitsAt(from)) ?? Infinity) > b.threat) return undefined;
    return { ...step, from, holdThreat: b.threat };
  };
  /** Why the step is saved toward: its size, or (#218 comment) its size and the source's hold together. */
  const cannotAfford = (x: { from: number; holdThreat?: number }) =>
    x.holdThreat === undefined
      ? 'which this turn cannot afford'
      : `which this turn cannot afford and still hold ${label(x.from)} against the ~${x.holdThreat} threat`;
  /** Set by the leftover deploy (rule 5): the step it saved toward, which idle stacks stage toward (rule 6). */
  let staging: Staging | undefined;
  /**
   * #215: armies withdrawn into a border hold it only if I move first: when the opponent moves
   * first, its first order (an all-in there) runs before my transfer in. Unless I am known to
   * move first, the leftover makes each open border that falls without them hold on its own — the
   * worse order — most at stake first, when it can afford it whole. The steps after it still
   * count the withdrawal (their holds and comfortable margins are judged in the order where it
   * lands in time). One that holds only with the withdrawal is named in the report.
   */
  const worseOrderHolds = () => {
    /**
     * #215 review: what my open `x` (no order of its own under No-Split) needs to hold, or
     * `undefined` when the leftover could not make it hold anyway. `worse`: in the order that is
     * worse for it, the hold this step sizes (`stays − lateNet`: its own orders not yet run,
     * nothing withdrawn into it arrived); otherwise after all my orders (`stays`), the hold the
     * later steps size.
     */
    const fallNeed = (x: Border, worse: boolean): number | undefined => {
      const first = stays(x.id) - (worse ? lateNet(pc, ps, x.id) : 0) + unitsAt(x.id);
      let d = 0;
      while ((toTake(first + d) ?? Infinity) <= x.threat) {
        d++;
        if (d > ps.budget || d > roomAt(x.id)) return undefined;
      }
      return d;
    };
    /**
     * #215 review: the border my first order withdraws into, unless the opponent is known to move
     * first. Moving first, only that withdrawal lands before the opponent's first order (the
     * zigzag gives it two orders before my second), so a border any other withdrawal goes into
     * falls whoever moves first without its worse-order hold. The schedule puts the largest early
     * move first (ties in decision order, schedule.ts); the withdrawals are the early moves known here.
     */
    const firstInto =
      pc.opts.movesFirst === false
        ? undefined
        : moves
            .filter((m) => m.kind === 'transfer' && m.reason === 'withdraws from a conceded border' && lateArrivals(pc, ps, m.to) > 0)
            .reduce<PlannedMove | undefined>((a, m) => (!a || m.armies > a.armies ? m : a), undefined)?.to;
    const order = [...borders.values()].sort((x, y) => valueOf(y.id) - valueOf(x.id) || x.id - y.id);
    for (const [i, b] of order.entries()) {
      const late = lateArrivals(pc, ps, b.id);
      // No-Split (#124): a deploy on a territory that issues an order leaves with it, holding nothing.
      if (late <= 0) continue;
      if (!open(b.id) || orderOf(b.id)) {
        ps.firstOnlySkip.set(b.id, orderOf(b.id) ? 'order' : 'closed');
        continue;
      }
      // #215 review: its own orders have not run either when the opponent moves first.
      const net = lateNet(pc, ps, b.id);
      const own = stays(b.id) - net + unitsAt(b.id);
      if ((toTake(own) ?? Infinity) > b.threat) continue;
      let d = 0;
      while ((toTake(own + d) ?? Infinity) <= b.threat) d++;
      // #215 review: never from what another open border needs to hold whoever moves first — the
      // leftover may be what holds it in both orders, and a border that holds only if I move
      // first is not bought with one that then falls whoever does. For a border with nothing
      // withdrawn into it, or the one my first order goes into, that is what the later steps give
      // it (after all my orders). A border another withdrawal goes into falls whoever moves first
      // without its worse-order hold, which it gets here or not at all: it is kept back only from
      // the border my first order goes into, and only while still to come. Two such borders take
      // their turns most at stake first (keeping each one's hold back from the other, neither
      // was held), and one this step has passed had its turn.
      let reserve = 0;
      for (const [j, x] of order.entries()) {
        if (j === i || conceded.has(x.id) || !open(x.id) || orderOf(x.id)) continue;
        if (x.id === firstInto || lateArrivals(pc, ps, x.id) <= 0) reserve += fallNeed(x, false) ?? 0;
        else if (b.id === firstInto && j > i) reserve += fallNeed(x, true) ?? 0;
      }
      if (d > ps.budget - reserve || d > roomAt(b.id)) {
        ps.firstOnlySkip.set(b.id, d > ps.budget - reserve ? 'budget' : 'room');
        continue;
      }
      const sent = late - net;
      rationale.push(
        `Deploy ${d} to ${label(b.id)} so it holds whoever moves first (protects +${valueOf(b.id)}): the ${late} withdrawn into it land after player ${b.player}'s attack if it moves first, and without them its ${own + d - unitsAt(b.id)}${sent > 0 ? ` (the ${sent} its own orders send out not yet gone)` : ''} need ${toTake(own + d)} to take, above the ~${b.threat} threat.`,
      );
      deploy(b.id, d);
      locked.add(b.id);
    }
  };
  /**
   * #121: before any comfort margin, a conceded border that the leftover can make hold is held
   * after all (live, a border short by 2 was conceded while 5 went to one that already held,
   * and it fell with 15 armies). Only where the leftover would otherwise buy comfort margins
   * (no strike stack), from what is left once every held border that would fall as it stands
   * has its hold; best worth per army first. Its withdrawal is taken back, unless the
   * territory it went to needs those armies to hold; a border that attacks out, my
   * commander's, or one whose garrison already stays is not revived.
   * #215 review: it runs before the worse-order step. A conceded border falls whoever moves
   * first, a border the worse-order step sizes only if the opponent does: the worse-order step
   * taking the budget first left the revival short and lost the conceded border under both
   * orders (and, deployed first, made a border read as comfortable so the revival never ran).
   */
  const holdAfterAll = (): Map<number, number> => {
    /** The withdrawals taken back, by the territory they went to. */
    const takenBack = new Map<number, number>();
    let falling = 0;
    for (const b of borders.values()) {
      if (conceded.has(b.id) || orderOf(b.id)) continue;
      let d = 0;
      while ((toTake(stayAt(b.id) + d + unitsAt(b.id)) ?? Infinity) <= b.threat) d++;
      falling += d;
    }
    /**
     * #215 review: unless I am known to move first, a withdrawal into an open border without an
     * order lands too late to count when the opponent moves first, so the worse-order step would
     * deploy there what holds it without them. A revival whose withdrawal that border needs may
     * then still go ahead, paying that deploy too: the armies it would need to hold without the
     * withdrawal (0 when it holds anyway or when this does not apply; -1 when it never holds).
     */
    const refillFor = (out: PlannedMove): number => {
      if (knownFirst(pc)) return 0;
      const dest = borders.get(out.to);
      if (!dest || conceded.has(out.to) || !open(out.to) || orderOf(out.to)) return 0;
      const at = stayAt(out.to) + unitsAt(out.to);
      if ((toTake(at) ?? Infinity) <= dest.threat) return 0;
      let n = 0;
      while ((toTake(at - out.armies + n) ?? Infinity) <= dest.threat) {
        n++;
        if (n > ps.budget) return -1;
      }
      return n;
    };
    const revivable = threatened
      .filter(
        (t) =>
          conceded.has(t.id) &&
          revivableHere(t.id) &&
          !stood.has(t.id) &&
          !moves.some((m) => m.from === t.id && m.reason !== 'withdraws from a conceded border'),
      )
      .map((t) => {
        const b = borders.get(t.id)!;
        const out = moves.find((m) => m.from === t.id);
        const back = out?.armies ?? 0;
        let d = 0;
        while ((toTake(stayAt(t.id) + back + d + unitsAt(t.id)) ?? Infinity) <= b.threat) d++;
        return { t, d, out, threat: b.threat, refill: out ? refillFor(out) : 0 };
      })
      .filter(({ out, refill }) => {
        if (!out || refill > 0) return true;
        // The territory the withdrawal went to keeps holding without it.
        const dest = borders.get(out.to);
        if (!dest || conceded.has(out.to)) return true;
        const at = stayAt(out.to) + unitsAt(out.to);
        const heldWith = (toTake(at) ?? Infinity) > dest.threat;
        return !heldWith || (toTake(at - out.armies) ?? Infinity) > dest.threat;
      })
      .sort(
        (a, b) =>
          b.t.worth / Math.max(1, b.d + b.refill) - a.t.worth / Math.max(1, a.d + a.refill) ||
          a.d + a.refill - (b.d + b.refill) ||
          a.t.id - b.t.id,
      );
    for (const { t, d, out, threat, refill } of revivable) {
      // A refill is judged again: an earlier revival may have deployed on the same territory.
      const r = out && refill > 0 ? refillFor(out) : 0;
      if (r < 0 || d + r > ps.budget - falling || d > roomAt(t.id) || (out && r > roomAt(out.to))) continue;
      if (out) {
        takenBack.set(out.to, (takenBack.get(out.to) ?? 0) + out.armies);
        moves.splice(moves.indexOf(out), 1);
        avail.set(t.id, avail.get(t.id)! + out.armies);
        const inc = (incoming.get(out.to) ?? 0) - out.armies;
        if (inc > 0) incoming.set(out.to, inc);
        else incoming.delete(out.to);
        const line = rationale.findIndex((l) => l.startsWith(`Withdraw ${out.armies} from ${label(t.id)} to `));
        if (line >= 0) rationale.splice(line, 1);
        const w = warnings.findIndex((l) => l.startsWith(`The withdrawal from ${label(t.id)} only executes`));
        if (w >= 0) warnings.splice(w, 1);
      }
      if (out && r > 0) {
        deploy(out.to, r);
        locked.add(out.to);
        rationale.push(
          `Deploy ${r} to ${label(out.to)} so it holds without the ${out.armies} ${label(t.id)} would have withdrawn into it (${stayAt(out.to) + unitsAt(out.to)} armies need ${toTake(stayAt(out.to) + unitsAt(out.to))} to take, above the ~${borders.get(out.to)!.threat} threat): unless I am known to move first they could land too late to count, so this is spent either way, and ${label(t.id)} is held after all.`,
        );
      }
      conceded.delete(t.id);
      const conceding = `${label(t.id)} cannot be held `;
      for (let i = warnings.length - 1; i >= 0; i--)
        if (warnings[i]!.startsWith(conceding) && warnings[i]!.endsWith(': conceded')) warnings.splice(i, 1);
      if (d > 0) deploy(t.id, d);
      locked.add(t.id);
      rationale.push(
        `Hold ${label(t.id)} after all (not conceded): deploy ${d} there${out ? `, and keep the ${out.armies} that would have withdrawn` : ''}; the leftover covers it before any comfort margin (${stayAt(t.id) + unitsAt(t.id)} armies need ${toTake(stayAt(t.id) + unitsAt(t.id))} to take, above the ~${threat} threat; protects +${t.value}).`,
      );
    }
    if (ps.cardAdvice === 'order-priority' && !moves.some((m) => conceded.has(m.from))) ps.cardAdvice = null;
    return takenBack;
  };
  /**
   * #240 review: what the attacks out of `id` on repulsed territories paid at capture time beyond
   * their plain size (the sure size over what takes the defenders standing there now).
   */
  const repulsedSurplus = (id: number) =>
    moves
      .filter((m) => m.from === id && m.kind === 'attack')
      .reduce((sum, m) => {
        const rep = repulsed.get(m.to);
        const plain = rep ? pc.costAt(m.to) : null;
        return rep && plain !== null && m.armies >= rep.cost ? sum + Math.max(0, rep.cost - plain) : sum;
      }, 0);
  /**
   * #226 review: the leftover deployed on `id` for defence or saving is kept from the #226 margin —
   * except (#240 review) on the source of an attack on a repulsed territory: the plain plan pays the
   * surplus of its sure size from the armies beyond the hold there, and its margin takes the rest
   * beyond the hold, so the margin still takes what the hold does not need (never fewer armies on the
   * attack than without the evidence).
   */
  const keepFromMargin = (id: number) => {
    if (repulsedSurplus(id) <= 0) ps.leftoverKept.add(id);
  };
  /**
   * The open borders short of a comfortable margin, most at stake first (rule 5). `back`: the
   * withdrawals the revival took back, still counted where they were going, as when this was
   * judged before the revival.
   */
  const shortOf = (bs: Iterable<Border>, back: Map<number, number> = new Map(), asPlain = false) =>
    [...bs]
      // No-Split (#124): a deploy on a territory that issues an order leaves with it, holding nothing.
      .filter((b) => open(b.id) && !orderOf(b.id))
      .map((b) => {
        const at = stays(b.id) + (back.get(b.id) ?? 0) + unitsAt(b.id);
        const take = toTake(at);
        // #240 review: an attack out of it on a repulsed territory paid its sure size at capture
        // time, where the plain plan pays the surplus over the plain size later, from the armies
        // beyond the hold (#120). A border that holds is judged for comfort as the plain plan
        // judged it, with that surplus still on it, so the evidence never shrinks the attack. One
        // that would fall without the surplus stays short (the leftover makes it hold), except
        // `asPlain`, which judges every border as the plain plan did (whether to revive a conceded
        // border first).
        if (take === null || (take <= b.threat && !asPlain)) return { ...b, take };
        const surplus = repulsedSurplus(b.id);
        return { ...b, take: surplus > 0 ? toTake(at + surplus) : take };
      })
      .filter((b) => b.take !== null && b.take <= COMFORT_MARGIN * b.threat)
      .sort((a, b) => valueOf(b.id) - valueOf(a.id) || a.take! / a.threat - b.take! / b.threat || a.id - b.id);
  /** #218: the enemy territories next to `id` (visible, not captured this turn), sorted. */
  const foesNext = (id: number) =>
    neighborsOf(g, id)
      .filter((n) => {
        const st = state.get(n);
        return !captured.has(n) && st?.owner.kind === 'player' && pc.foe(st.owner.playerId);
      })
      .join(',');
  /** #218: the bonuses `id` is a member of, sorted. */
  const bonusesOf = (id: number) =>
    [...g.bonusById.values()]
      .filter((x) => bonusTerritories(g, x.id).includes(id))
      .map((x) => x.id)
      .sort((x, y) => x - y)
      .join(',');
  /**
   * #218: equal defensive value — the same player's threat, the same size, from the same enemy
   * territories, protecting as much, in the same bonuses: armies on one defend what armies on the
   * other would.
   */
  const sameDefence = (a: Border, b: Border) =>
    a.player === b.player &&
    a.threat === b.threat &&
    Math.abs(valueOf(a.id) - valueOf(b.id)) < 1e-9 &&
    foesNext(a.id) === foesNext(b.id) &&
    bonusesOf(a.id) === bonusesOf(b.id);
  /** #218 (comment): no enemy territory is in view (one this turn attacks included). */
  const noFront = ![...state.values()].some((st) => st.owner.kind === 'player' && pc.foe(st.owner.playerId));
  /**
   * #218 (comment): the territory central to what I hold — open, issuing no order — with the
   * fewest hops (through my own territories) to the farthest of my borders (a territory of mine
   * next to one I do not hold): in my largest connected holding first, then by that farthest
   * distance, then by the sum of the distances to every border, then by id. `ecc` is each of my
   * territories' farthest distance within its holding.
   */
  const centre = (): { id: number; ecc: Map<number, number> } | undefined => {
    const isBorder = (x: number) => neighborsOf(g, x).some((n) => !mineSet.has(n));
    const ecc = new Map<number, number>();
    const sum = new Map<number, number>();
    const size = new Map<number, number>();
    for (const x of [...mine].sort((a, b) => a - b)) {
      const d = bfsDistances(g, [x], { passable: (n) => mineSet.has(n) });
      let far = 0;
      let total = 0;
      for (const [y, k] of d)
        if (isBorder(y)) {
          far = Math.max(far, k);
          total += k;
        }
      ecc.set(x, far);
      sum.set(x, total);
      size.set(x, d.size);
    }
    const id = [...mine]
      .filter((x) => open(x) && !orderOf(x))
      .sort((a, b) => size.get(b)! - size.get(a)! || ecc.get(a)! - ecc.get(b)! || sum.get(a)! - sum.get(b)! || a - b)[0];
    return id === undefined ? undefined : { id, ecc };
  };
  const { weakMember } = completedMembers(pc, ps, threats, open, stays);
  /**
   * #265: a member of a bonus this turn's captures complete that faces an enemy once they land and
   * falls to it (rule 1c kept it, or the #122 garrison could not fund it) is brought to its hold
   * before any comfort margin, the worse-order holds and the strike stack — it falls whoever moves
   * first, and with it the bonus. Live, a 1-army member beside an empty enemy territory that could
   * deploy 5 stood while the leftover went to a border that already held. Most at stake first, and
   * only a hold the leftover covers in full: armies on a member that still falls are lost with it
   * (one it cannot cover keeps its old place in the comfort steps, and is warned of later). A
   * source of an order is passed over only under No-Split (`orderOf`), where a deploy there would
   * leave with its whole-stack order; otherwise its order's size is fixed and the deploy stays, so a
   * combined capture's source the rebalance could not help is topped up here like any member.
   */
  const holdCompletedMembers = () => {
    const weak = [...mine]
      .filter((id) => !orderOf(id))
      .flatMap((id) => {
        const w = weakMember(id);
        return w ? [{ id, ...w }] : [];
      })
      .sort((a, b) => valueOf(b.id) - valueOf(a.id) || a.need - b.need || a.id - b.id);
    for (const w of weak) {
      const d = w.need;
      if (d > ps.budget || d > roomAt(w.id)) continue;
      deploy(w.id, d);
      locked.add(w.id);
      keepFromMargin(w.id);
      const at = stays(w.id) + unitsAt(w.id);
      rationale.push(
        `Deploy ${d} of the leftover to ${label(w.id)}: it is a member of bonus ${bonusName(w.bonusId)}, completed this turn, and faces the ~${w.threat} threat once this turn's captures land (protects +${valueOf(w.id)}); its ${at - unitsAt(w.id)} armies need ${toTake(at)} to take, before any comfort margin.`,
      );
    }
  };
  // ---- leftover deploy ----
  // The borders the comfort steps may pick: open before any border is held after all (a revived
  // border's hold is its whole share of the leftover).
  const comfortPool = [...borders.values()].filter((b) => open(b.id));
  // The revival runs only where the leftover would otherwise buy comfort margins (no strike
  // stack, a border short of its margin), and then before the worse-order holds; otherwise the
  // worse-order holds go first, as before.
  // #240 review: judged as the plain plan judged it, so a repulsed attack's sure size revives nothing.
  // #420: an opponent's most valuable border keeps its full deploy. When it was conceded while the borders
  // its top-up sizes read comfortable (a 0 top-up leaves a guard-only stack no threat), no border is short
  // and the revival would not run, so the leftover went to a stack nothing threatens: the full-deploy border
  // is revived then too (alone), as it was when its other borders were sized for the full deploy.
  const fullConceded = (() => {
    const { primary, capAt } = threats.oneBorder();
    const out = new Set<number>();
    for (const [player, t] of primary)
      if (conceded.has(t) && [...capAt.values()].some((m) => m.has(player))) out.add(t);
    return out;
  })();
  const shortNow = shortOf(comfortPool, new Map(), true).length > 0;
  const reviving = !stack && ps.budget > 0 && (shortNow || fullConceded.size > 0);
  /** The conceded borders the revival may hold: every one when a border is short, else the #420 full-deploy ones. */
  const revivableHere = (id: number) => shortNow || fullConceded.has(id);
  if (!reviving) {
    holdCompletedMembers();
    worseOrderHolds();
  }
  if (ps.budget > 0) {
    const foggedNext = (id: number) =>
      neighborsOf(g, id).filter((n) => {
        const st = state.get(n);
        return !captured.has(n) && (!st || st.owner.kind === 'unknown' || st.armies === null);
      }).length;
    /** No-Split (#124): an attack that only softens its target; deploys there would leave with it, killing nothing more that matters. */
    const softens = (m: PlannedMove) =>
      noSplit && moves.some((o, i) => i > moves.indexOf(m) && o.kind === 'attack' && o.to === m.to);
    const expansion = ps.anchor ?? moves.find((m) => m.kind === 'attack' && !softens(m))?.from;
    /** Not a softener's source (No-Split): the leftover there would only leave with its failing attack. */
    const notSoftening = (x: number) => {
      const m = orderOf(x);
      return !m || !softens(m);
    };
    const fogged = [...mine].filter((x) => open(x) && notSoftening(x)).sort((a, b) => foggedNext(b) - foggedNext(a) || a - b).find((id) => foggedNext(id) > 0);
    const saving = stepSource(open, notSoftening);
    /**
     * #303: my income flat (#312's rule) and the step saved toward is in a positive bonus whose every
     * member not mine is a visible neutral or held by an opponent earning less than I do: no comfort
     * margin above the exact holds goes ahead of that completion — the leftover saves toward it.
     */
    const flatSave = ((): string | null => {
      const tr = pc.incomeTrend;
      if (!tr?.flat || !saving) return null;
      const value = g.map.bonuses.find((b) => b.id === saving.bonusId)?.value ?? 0;
      if (value <= 0) return null;
      const every = tr.turns[tr.turns.length - 1]!.income;
      const missing = bonusTerritories(g, saving.bonusId).filter((x) => !mineSet.has(x));
      const weak = (x: number) => {
        const o = state.get(x)?.owner;
        if (o?.kind === 'neutral') return true;
        return o?.kind === 'player' && pc.foe(o.playerId) && pc.incomeOfPlayer(o.playerId) < every;
      };
      if (!missing.length || !missing.every(weak)) return null;
      const first = tr.turns[0]!;
      return `my income is flat (${tr.turns.map((t) => t.income).join(', ')} over turns ${first.turn}–${tr.turns[tr.turns.length - 1]!.turn}, slope ${tr.slope}/turn), so no comfort margin above the exact holds goes ahead of completing bonus ${bonusName(saving.bonusId)} (+${value}) from ${
        missing.some((x) => state.get(x)?.owner.kind === 'player') ? 'neutrals and weaker opponents' : 'neutrals'
      } (#303)`;
    })();
    /** #218 (comment): the expansion stack's attacks land for sure without the leftover (under luck it raises their odds). */
    const expansionSure = () => moves.every((m) => m.from !== expansion || m.kind !== 'attack' || (m.winChance ?? 1) >= 1);
    /**
     * #424: with no foe in view because a Diplomacy card in force makes the only one beside me no foe
     * this turn, its border is still the front the card's end reopens: the leftover goes there rather
     * than central or onto the expansion stack (live, it went to an ocean tile while the partner's
     * stacks stood beside me). An open border of mine issuing no order beside a visible stack of an
     * enforced partner, most at stake first, then the biggest partner stack beside it, then id. Only
     * once the expansion stack's attacks land for sure without it, as the centre's rule.
     */
    const partnerFront = (): { id: number; player: number; until?: number } | undefined => {
      if (!noFront || !pc.truce.enforced.size || (expansion !== undefined && !expansionSure())) return undefined;
      const facing = (x: number) => {
        let best: { player: number; armies: number } | undefined;
        for (const n of neighborsOf(g, x)) {
          const st = state.get(n);
          if (captured.has(n) || st?.owner.kind !== 'player' || !pc.truce.enforced.has(st.owner.playerId)) continue;
          const armies = st.armies ?? 0;
          if (!best || armies > best.armies || (armies === best.armies && st.owner.playerId < best.player)) best = { player: st.owner.playerId, armies };
        }
        return best;
      };
      const pick = [...mine]
        .filter((x) => open(x) && !orderOf(x) && roomAt(x) > 0)
        .flatMap((x) => {
          const f = facing(x);
          return f ? [{ id: x, ...f }] : [];
        })
        .sort((a, b) => valueOf(b.id) - valueOf(a.id) || b.armies - a.armies || a.id - b.id)[0];
      if (!pick) return undefined;
      const until = pc.truce.given.find((r) => r.player === pick.player && r.enforced)?.enforcedUntil;
      return { id: pick.id, player: pick.player, ...(until !== undefined ? { until } : {}) };
    };
    const biggest = (ids: number[]) =>
      [...ids].sort((a, b) => armiesOf(b) + (deployed.get(b) ?? 0) - (armiesOf(a) + (deployed.get(a) ?? 0)) || a - b)[0];
    const takenBack = reviving ? holdAfterAll() : undefined;
    if (reviving) {
      holdCompletedMembers();
      worseOrderHolds();
    }
    const short = shortOf(comfortPool, takenBack);
    // Holds before the strike stack: a border kept for the bonus this turn completes (rule 1c:
    // the leftover is its only garrison) is topped up to a comfortable margin, and any other
    // open border that would fall (its take at or below the threat) to just hold. The stack
    // gets the rest.
    if (stack)
      for (const b of short) {
        const kept1c = kept.has(b.id) || garrisoned.has(b.id);
        const bar = kept1c ? COMFORT_MARGIN * b.threat : b.threat;
        const room = roomAt(b.id);
        let d = 0;
        for (;;) {
          const take = toTake(stays(b.id) + d + unitsAt(b.id));
          if (take === null || take > bar || d >= room) break;
          d++;
        }
        if (d <= 0) continue;
        rationale.push(
          `Deploy ${d} to ${label(b.id)} before the strike stack: ${
            garrisoned.has(b.id)
              ? `it is garrisoned for the bonus this turn completes, topped up to a comfortable margin over the ~${b.threat} threat`
              : kept1c
                ? `it is kept for the bonus this turn completes, and the leftover is its only garrison`
                : `it would fall to the ~${b.threat} threat`
          } (protects +${valueOf(b.id)}).`,
        );
        deploy(b.id, d);
        keepFromMargin(b.id);
      }
    /**
     * #268: once every short border has its comfortable margin (`marginFirst`: `lead`'s is still to
     * give, the one short border), the rest is spread over the open borders facing `lead`'s opponent
     * alone that protect something, an army at a time to the one that breaks at the smallest deploy —
     * its armies' take less the stacks beside it, which is the deploy it falls to — ties to the most
     * at stake, then by id:
     * the smallest deploy that breaks any of them is as large as it can be (live, the rest on the
     * border protecting the most left two others to break at ~1.5× the estimate, the third at ~3.5×).
     * One opponent picks one border for its deploy, as the border guess (#204) reads it. Spent through
     * the deploy book, so Local Deployment's pools are respected (a border its pool cannot reach gets
     * nothing more). `undefined`, with nothing spent, when fewer than two such borders exist or every
     * army would go to `lead` anyway (the old rule's deploy, kept as it was).
     */
    const headroomSpread = (lead: Border, marginFirst: boolean): Map<number, number> | undefined => {
      const attacksFrom = (id: number) => moves.some((m) => m.from === id && m.kind === 'attack');
      // My commander's territory is must-hold (#61): the rest stays on it whatever it protects.
      if (attacksFrom(lead.id) || pc.myCommanders.has(lead.id)) return undefined;
      /** Facing `lead`'s opponent alone: its threat is that player's, and no other opponent's stack is beside it. */
      const one = (b: Border) =>
        b.alone === undefined &&
        (b.split?.players ?? [b.player]).every((x) => x === lead.player) &&
        neighborsOf(g, b.id).every((n) => {
          const st = state.get(n);
          return captured.has(n) || st?.owner.kind !== 'player' || !pc.foe(st.owner.playerId) || st.owner.playerId === lead.player;
        });
      const group = [...borders.values()].filter(
        (b) =>
          b.player === lead.player &&
          one(b) &&
          open(b.id) &&
          !orderOf(b.id) &&
          // A border an attack leaves from takes no spread: armies there may size its attack up
          // (#120) rather than stay. When it is `lead`, the old rule's rest stays on it.
          !attacksFrom(b.id) &&
          // Weighted by what it protects: a border protecting nothing draws no armies from one that
          // protects something (all of them when the one with the most at stake protects nothing).
          (valueOf(b.id) > 0 || valueOf(lead.id) <= 0),
      );
      if (group.length < 2 || !group.some((b) => b.id === lead.id)) return undefined;
      const got = new Map<number, number>();
      const give = (id: number) => {
        deploy(id, 1);
        got.set(id, (got.get(id) ?? 0) + 1);
      };
      if (marginFirst)
        while (ps.budget > 0 && roomAt(lead.id) > 0) {
          const take = toTake(stays(lead.id) + unitsAt(lead.id));
          if (take === null || take > COMFORT_MARGIN * lead.threat) break;
          give(lead.id);
        }
      const breaksAt = (b: Border) => {
        const take = toTake(stays(b.id) + unitsAt(b.id));
        return take === null ? Infinity : take - (b.threat - b.deploy);
      };
      while (ps.budget > 0) {
        const next = group
          .filter((b) => roomAt(b.id) > 0)
          .sort((a, b) => breaksAt(a) - breaksAt(b) || valueOf(b.id) - valueOf(a.id) || a.id - b.id)[0];
        if (!next) break;
        give(next.id);
      }
      if (got.size === 0 || (got.size === 1 && got.has(lead.id))) {
        for (const [id, n] of got) undeploy(id, n);
        return undefined;
      }
      const total = [...got.values()].reduce((a, b) => a + b, 0);
      const parts = group
        .filter((b) => got.has(b.id))
        .sort((a, b) => a.id - b.id)
        .map((b) => `${label(b.id)} +${got.get(b.id)}`);
      const least = Math.min(...group.map(breaksAt));
      rationale.push(
        `Spread the leftover ${total} over the borders facing player ${lead.player} (#268), so the smallest deploy that breaks one of them is as large as possible: ${parts.join(', ')}${
          marginFirst ? '' : ', once every short border has its comfortable margin'
        }: none of them now falls to a deploy of less than ~${least} on top of the stacks beside it (threat arithmetic on the deploys, before any move: the headroom table carries out the whole turn and may differ; ${
          pc.untrustedAt(lead.player, lead.id) > 0 && pc.untrustedAt(lead.player, lead.id) >= lead.deploy
            ? `sized for ~${lead.deploy} (untrusted, #275)`
            : `the estimate is ~${lead.deploy}, a floor under fog`
        }); all of it on ${label(lead.id)}, the one with the most at stake (protects +${valueOf(lead.id)}), would leave another to fall to less.`,
      );
      for (const id of got.keys()) {
        locked.add(id);
        keepFromMargin(id);
      }
      return got;
    };
    /**
     * #290 (owner decision 2026-11-19): before the even spread, a border whose enemy stack beside it grew
     * this turn (as the two boards show it) is topped up to hold against that stack plus its owner's whole
     * observed deploy — the estimate, the observed figure before its cap, this turn's high reading (growth
     * beside the fog read as deploy), or the reading #123's bound cut on the track (`newestCut`): a jump
     * kept as a lower bound counts in full — highest protected value first, as far as the leftover goes.
     * The spread itself is unchanged.
     */
    const fundGrown = () => {
      const whole = (b: Border) => {
        const e = pc.estimates.get(b.player);
        return Math.max(b.deploy, grewBy(b), e?.observedRaw ?? 0, e?.observation?.high ?? 0, e?.newestCut?.reading ?? 0);
      };
      /** The most any stack of the border's opponent beside it grew since the previous board, as the boards show it. */
      const grewBy = (b: Border) =>
        Math.max(
          0,
          ...neighborsOf(g, b.id).map((n) => {
            const st = state.get(n);
            const was = threats.previousBoard?.territories.find((t) => t.territoryId === n);
            const same = (t: typeof st) => t?.owner.kind === 'player' && t.owner.playerId === b.player && typeof t.armies === 'number';
            return same(st) && same(was) ? st!.armies! - was!.armies! : 0;
          }),
        );
      const grown = [...borders.values()]
        .filter((b) => grewBy(b) > 0 && open(b.id) && !orderOf(b.id) && !moves.some((m) => m.from === b.id && m.kind === 'attack'))
        .sort((a, b) => valueOf(b.id) - valueOf(a.id) || a.id - b.id);
      for (const b of grown) {
        const bar = b.movable + whole(b);
        let d = 0;
        const room = roomAt(b.id);
        while (d < room && d < ps.budget) {
          const take = toTake(stays(b.id) + d + unitsAt(b.id));
          if (take === null || take > bar) break;
          d++;
        }
        if (d <= 0) continue;
        deploy(b.id, d);
        locked.add(b.id);
        keepFromMargin(b.id);
        rationale.push(
          `Deploy ${d} of the leftover to ${label(b.id)} before the spread (#290): player ${b.player}'s stack beside it grew this turn (+${grewBy(b)}), so it is topped up toward its ${b.movable} movable armies plus its whole observed deploy (~${whole(b)}) (protects +${valueOf(b.id)}).`,
        );
      }
    };
    /**
     * #440: before the leftover tops up a border that already holds, or one a recorded truce covers (T2),
     * the territory with the most income at stake that carries a single-territory bonus of at least
     * DETERRENT_MIN_VALUE gets a deterrent guard. Live (a large FFA), the +8
     * territory that was the hub of nine pair bonuses ended on 3 while 15 armies topped up two low-value
     * borders. That territory (open, issuing no order, not itself a border being topped up) must protect
     * at least DETERRENT_MIN_VALUE and DETERRENT_VALUE_RATIO × the most any border being topped up
     * protects, with an opponent within two steps; it gets armies until taking it needs more than
     * COMFORT_MARGIN × a casual attack (the largest deploy estimate of those opponents, or its own
     * threat when it is a border). The borders that would fall keep what makes them hold (a truce-covered
     * one excepted: the truce covers it). Its armies then stay (`locked`: rule 6 moves none out), and so do
     * they when it already needs more than that to take and gets no deploy.
     */
    const deterrentGuard = (bs: readonly Border[]) => {
      const relaxed = (id: number) => ps.truce?.relaxed.has(id) ?? false;
      const holdNeed = (b: Border) => {
        let d = 0;
        while (d < ps.budget) {
          const take = toTake(stays(b.id) + d + unitsAt(b.id));
          if (take === null || take > b.threat) break;
          d++;
        }
        return d;
      };
      const reserve = bs.filter((b) => !relaxed(b.id)).reduce((sum, b) => sum + holdNeed(b), 0);
      // A territory that carries a large single-territory bonus of its own (a city, a capital), not
      // any member of a held bonus: the issue's case, and the golden corpus's churn stays small.
      const carries = (x: number) =>
        [...g.bonusById.values()].some((b) => b.value >= DETERRENT_MIN_VALUE && bonusTerritories(g, b.id).length === 1 && bonusTerritories(g, b.id)[0] === x);
      const hub = [...mine]
        .filter((x) => open(x) && !orderOf(x) && carries(x))
        .sort((a, b) => valueOf(b) - valueOf(a) || a - b)[0];
      if (hub === undefined || bs.some((b) => b.id === hub)) return;
      const value = valueOf(hub);
      const top = Math.max(0, ...bs.map((b) => valueOf(b.id)));
      if (value < DETERRENT_MIN_VALUE || value < DETERRENT_VALUE_RATIO * top) return;
      const near = new Set([hub, ...neighborsOf(g, hub)].flatMap((x) => [x, ...neighborsOf(g, x)]));
      const foes = [...new Set([...near].flatMap((x) => {
        const st = state.get(x);
        return !captured.has(x) && st?.owner.kind === 'player' && pc.foe(st.owner.playerId) ? [st.owner.playerId] : [];
      }))].sort((a, b) => a - b);
      if (!foes.length) return;
      const casual = Math.max(...foes.map((p) => pc.deployOf(p)), borders.get(hub)?.threat ?? 0);
      const bar = COMFORT_MARGIN * casual;
      const most = Math.min(roomAt(hub), ps.budget - reserve);
      let d = 0;
      while (d < most) {
        const take = toTake(stays(hub) + d + unitsAt(hub));
        if (take === null || take > bar) break;
        d++;
      }
      const against = `${COMFORT_MARGIN} × the ~${casual} ${
        borders.has(hub) && casual === borders.get(hub)!.threat ? 'threat beside it' : `deploy of player ${foes.length === 1 ? foes[0] : foes.join(' or ')} within two steps`
      }`;
      if (d <= 0) {
        // Already at its bar: it needs no deploy, but its armies still stay (rule 6 would otherwise
        // walk them to the front and leave a stronger capital weaker than a topped-up one).
        const at = stays(hub) + unitsAt(hub);
        const take = toTake(at);
        if (take !== null && take <= bar) return;
        locked.add(hub);
        rationale.push(
          `${label(hub)} keeps its ${at} armies as a deterrent guard (#440): it has the most income at stake (protects +${value}, the borders being topped up at most +${top}), and they ${
            take === null ? 'cannot be taken' : `need ${take} to take`
          }, more than ${against}, so none move to the front.`,
        );
        return;
      }
      deploy(hub, d);
      locked.add(hub);
      keepFromMargin(hub);
      const at = stays(hub) + unitsAt(hub);
      rationale.push(
        `Deploy ${d} of the leftover to ${label(hub)} as a deterrent guard (#440): it has the most income at stake (protects +${value}, the borders being topped up at most +${top}), and its ${at} armies now need ${toTake(at)} to take, more than ${against}, before any border that already holds is topped up.`,
      );
    };
    /** #268: the rest spread by {@link headroomSpread}, already deployed: nothing is left for `where`. */
    let spreadRest: Map<number, number> | undefined;
    let where: number;
    let why: string;
    let lock = false;
    /** #163: the leftover concentrates for one attack (strike, saving, expansion): no Bomb split. */
    let concentrating = false;
    /** #218 (comment): the leftover stays central: rule 6 keeps it there, not the armies already there. */
    let central = false;
    /** #424: the Diplomacy partner's border the leftover keeps as the front. */
    let peace: ReturnType<typeof partnerFront>;
    /** #226 review: the leftover defends `where` or saves there: the #226 margin leaves it. */
    let defends = false;
    /** #288: the attacks out of the expansion stack the leftover goes with (it has nothing else left to attack). */
    let joins: PlannedMove[] | undefined;
    /** Territories beside `t` that are neither mine nor captured this turn: what is left to attack from it. */
    const leftToAttack = (t: number) => neighborsOf(g, t).filter((n) => !mineSet.has(n) && !captured.has(n));
    /**
     * #288: a source facing no threat whose every neighbour is mine or captured this turn has nothing
     * left to attack once the captures land, so a leftover there idles: it goes with its attacks whose
     * targets still have a step onward (most steps onward first, then id). Never under No-Split (an
     * order already carries the whole stack), nor with a combined capture or a softener.
     */
    const joinsOf = (src: number): PlannedMove[] | undefined => {
      if (noSplit || borders.has(src) || pc.myCommanders.has(src) || leftToAttack(src).length) return undefined;
      const onward = (t: number) => leftToAttack(t).filter((n) => n !== src).length;
      const out = moves
        .filter(
          (m) =>
            m.kind === 'attack' && m.from === src && captured.has(m.to) && !ps.combined.has(m.to) && state.get(m.to)?.owner.kind === 'neutral' && onward(m.to) > 0,
        )
        .sort((a, b) => onward(b.to) - onward(a.to) || a.to - b.to);
      return out.length ? out : undefined;
    };
    /**
     * #288 (second half): the next step from the target of `m`, an attack out of `src` the leftover may
     * join: the cheapest visible neutral beside it that is neither mine nor captured this turn, and the
     * armies its capture next turn needs beyond those that land movable (0 with no such neutral).
     */
    const nextStep = (m: PlannedMove, src: number): JoinStep => {
      const lands = ps.survivorsAt.get(m.to) ?? m.armies - straightKills(pc.defenceAt(m.to), pc.rates.defensiveKillRate);
      const movable = Math.max(0, lands - pc.guard);
      const best = leftToAttack(m.to)
        .filter((x) => x !== src && state.get(x)?.owner.kind === 'neutral' && typeof state.get(x)?.armies === 'number')
        .map((x) => ({ x, c: pc.costAt(x) }))
        .filter((o): o is { x: number; c: number } => o.c !== null)
        .sort((a, b) => a.c - b.c || a.x - b.x)[0];
      return best ? { m, need: Math.max(0, best.c - movable), step: best.x, cost: best.c, movable } : { m, need: 0, movable };
    };
    /**
     * #288: another capture this turn the rest of the leftover (`left`) can pay for, rule 5b's way: a
     * neutral not captured that passes pass 3's eligibility and economy tests, beside an open territory
     * of mine other than `src` that issues no order, holds no commander of mine and attacks no player,
     * whose armies fall short of its cost by no more than `left` (fewest short first, then cost, id).
     * Not under Local Deployment (the pools decide where the rest may land). Rule 5b judges the hold.
     */
    const otherCapture = (left: number, src: number) => {
      // As rule 5b: never under `complete-bonus` (No-Split never gets here: no join).
      if (local || pc.goal === 'complete-bonus') return undefined;
      const c = [...targets.values()]
        .filter((tg) => state.get(tg.id)?.owner.kind === 'neutral' && !captured.has(tg.id) && !repulsed.has(tg.id) && !pc.truce.noTarget(tg.id))
        .filter((tg) => {
          const gain = book.gainWith([tg.id]);
          return gain >= 0 && plainEligible(pc, tgt, tg.id, false) && !plainEconomy(pc, tgt, tg.id, gain);
        })
        .flatMap((tg) =>
          tg.sources
            .filter(
              (x) =>
                x !== src &&
                mineSet.has(x) &&
                open(x) &&
                !conceded.has(x) &&
                !pc.myCommanders.has(x) &&
                !orderOf(x) &&
                !moves.some((m) => m.from === x && m.kind === 'attack' && state.get(m.to)?.owner.kind === 'player'),
            )
            .map((x) => ({ t: tg.id, at: x, cost: tg.cost, short: tg.cost - avail.get(x)! })),
        )
        .filter((o) => o.short > 0 && o.short <= left)
        .sort((a, b) => a.short - b.short || a.cost - b.cost || a.t - b.t || a.at - b.at)[0];
      return c ? { ...c, n: left } : undefined;
    };
    /** Sends `k` more of `src`'s armies with the attack `m`. */
    const applyTo = (src: number, m: PlannedMove, k: number) => {
      m.armies += k;
      m.winChance = pc.chanceOf(m.armies, pc.defenceAt(m.to));
      avail.set(src, avail.get(src)! - k);
      if (ps.survivorsAt.has(m.to)) ps.survivorsAt.set(m.to, ps.survivorsAt.get(m.to)! + k);
    };
    /** The rationale line of the leftover `k` deployed on `src` and sent with the attacks (`add` more each). */
    const joinLine = (src: number, k: number, steps: readonly JoinStep[], add: ReadonlyMap<PlannedMove, number>) => {
      const parts = steps
        .filter((s) => (add.get(s.m) ?? 0) > 0)
        .map((s) => `the attack on ${label(s.m.to)} (${s.m.armies - add.get(s.m)!} → ${s.m.armies})`);
      const needs = steps
        .filter((s) => s.funded)
        .map((s) => `${label(s.step!)} beside ${label(s.m.to)} takes ${s.cost}, ${s.need} more than the ${s.movable} that would land movable`);
      return `Deploy the leftover ${k} to ${label(src)} and send it with ${parts.join(' and ')} (#288): once this turn's captures land ${label(src)} has nothing left to attack, so a leftover there would idle, while the armies that land fund the next step from there without a deploy${
        needs.length ? ` (${needs.join('; ')})` : ''
      }.`;
    };
    if (stack) {
      lock = true;
      concentrating = true;
      where = stack.id;
      why = `one strike stack on the border facing player ${stack.player}, ${stackFacing(pc, stack)} (~${stack.income} income, ${stack.source}), not spread`;
    } else if (short[0] && flatSave && saving && open(saving.from) && roomAt(saving.from) > 0) {
      // (Under Local Deployment the leftover may not land there: then the margins stand.)
      // #303: the holds already have their exact armies; the margin over them waits behind the completion.
      where = saving.from;
      why = `save toward ${label(saving.t)} (${saving.cost} to take), the next step of bonus ${bonusName(saving.bonusId)}, ${cannotAfford(saving)}: ${flatSave}`;
      defends = true;
      lock = true;
      concentrating = true;
    } else if (short[0]) {
      defends = true;
      deterrentGuard(short);
      // #218: the source of the step the leftover would save toward, when it is an open border:
      // once every short border has its comfortable margin, the rest goes there when it defends
      // as well as the border the rest would go to, and counts toward the step. A margin itself
      // stays on its border: armies on the source do not make another border comfortable.
      const src = saving && open(saving.from) && !orderOf(saving.from) ? borders.get(saving.from) : undefined;
      const carries = (b: Border) => src !== undefined && (b.id === src.id || sameDefence(b, src));
      // #121: spread to each short border's comfortable margin, in order, before any border gets
      // more (two symmetric borders at an exact hold ended as 16 and 7); the rest goes to the first
      // (#218: or to the source that defends as well).
      let spread = false;
      if (short.length > 1 || (carries(short[0]) && short[0].id !== src!.id))
        for (const b of short) {
          const room = roomAt(b.id);
          let d = 0;
          while (d < room) {
            const take = toTake(stays(b.id) + d + unitsAt(b.id));
            if (take === null || take > COMFORT_MARGIN * b.threat) break;
            d++;
          }
          if (d <= 0) continue;
          rationale.push(
            `Deploy ${d} of the leftover to ${label(b.id)}: it brings it to a comfortable margin over the ~${b.threat} threat (protects +${valueOf(b.id)}), before any border gets more.`,
          );
          deploy(b.id, d);
          locked.add(b.id);
          keepFromMargin(b.id);
          spread = true;
        }
      lock = true;
      if (carries(short[0])) {
        // #218: the rest goes to the source, at equal defensive value, and saves toward the step.
        where = src!.id;
        concentrating = true;
        why = `save toward ${label(saving!.t)} (${saving!.cost} to take), the next step of bonus ${bonusName(saving!.bonusId)}, ${cannotAfford(saving!)}${
          short[0].id === src!.id
            ? `; it is also the held border with the most at stake (protects +${valueOf(src!.id)})`
            : `; it defends as well as ${label(short[0].id)} would (the same ~${short[0].threat} threat from player ${short[0].player}, protects +${valueOf(short[0].id)})`
        }${spread ? ', once every short border has its comfortable margin' : ''}`;
      } else {
        where = short[0].id;
        fundGrown();
        spreadRest = headroomSpread(short[0], !spread);
        why = spread
          ? `the rest, once every short border has its comfortable margin, to the one with the most at stake (protects +${valueOf(where)})`
          : `the held border with the most at stake (protects +${valueOf(where)}), still short of a comfortable margin over the ~${short[0].threat} threat`;
      }
    } else if (saving) {
      where = saving.from;
      why = `save toward ${label(saving.t)} (${saving.cost} to take), the next step of bonus ${bonusName(saving.bonusId)}, ${cannotAfford(saving)}`;
      defends = true;
      lock = true;
      concentrating = true;
    } else if ((peace = partnerFront()) !== undefined) {
      where = peace.id;
      why = `the border facing player ${peace.player}, at peace by a Diplomacy card in force${
        peace.until !== undefined ? ` until turn ${peace.until}` : ''
      } — no other enemy is in view, and its border is the front again once the card ends (#424)`;
      defends = true;
      lock = true;
    } else if (expansion !== undefined && open(expansion)) {
      // #218 (comment): with no enemy in view there is no front to go to, and a leftover riding
      // the top expansion walks deeper into one region every turn (live: 14 hops from the nearest
      // front two turns later). When the expansion stack is more than CENTRE_SLACK hops farther
      // from my farthest border than the territory central to what I hold, and its attacks land
      // for sure without the leftover, the leftover stays there.
      // Only once its attacks land for sure: under luck the leftover there raises their odds.
      const c = noFront && expansionSure() ? centre() : undefined;
      if (c && c.id !== expansion && (c.ecc.get(expansion) ?? Infinity) > c.ecc.get(c.id)! + CENTRE_SLACK) {
        where = c.id;
        why = `no enemy is in view, so there is no front to go to: it stays central to what I hold (at most ${c.ecc.get(c.id)} hops from each of my borders, where the stack working on the top expansion, ${label(expansion)}, is ${c.ecc.get(expansion)} from its farthest), ready for wherever a front opens`;
        central = true;
      } else {
        where = expansion;
        why = 'the stack working on the top expansion';
        lock = true;
        concentrating = true;
        joins = joinsOf(expansion);
      }
    } else if (fogged !== undefined) {
      where = fogged;
      why = 'the border with the most fogged neighbours';
    } else {
      const b = biggest(mine.filter((x) => open(x) && notSoftening(x)));
      if (b !== undefined) {
        where = b;
        why = 'my biggest stack';
      } else {
        where = biggest(mine)!;
        why = 'my biggest stack';
        warnings.push(`Every territory I hold is conceded; the leftover ${ps.budget} goes to ${label(where)} anyway.`);
      }
    }
    let n = roomAt(where);
    if (saving && where === saving.from) staging = { t: saving.t, bonusId: saving.bonusId, cost: saving.cost, from: saving.from };
    // #163: an opponent may hold a Bomb: a second stack on another open border facing an enemy takes
    // half the leftover, so one bomb halves only one of them (same opponent first, then the bigger
    // stack, then id). Never a strike, saving or expansion stack: each concentrates for one attack
    // (the strike this turn, #72), and a split would halve it for certain where a bomb only may.
    // #268: a spread rest is already on two or more stacks, which a bomb halves one of.
    if (bombOn && n >= 2 && borders.has(where) && !concentrating && !spreadRest) {
      const facingP = borders.get(where)!.player;
      const second = [...borders.values()]
        .filter((b) => b.id !== where && open(b.id) && !orderOf(b.id) && notSoftening(b.id) && roomAt(b.id) >= 1)
        .sort(
          (a, b) =>
            Number(b.player === facingP) - Number(a.player === facingP) ||
            stays(b.id) - stays(a.id) ||
            a.id - b.id,
        )[0];
      if (second) {
        const half = Math.min(Math.floor(n / 2), roomAt(second.id));
        rationale.push(
          `Deploy ${half} of the leftover to ${label(second.id)}: an opponent may hold a Bomb, which halves one stack before any move, so the leftover makes two stacks rather than one (${label(where)} gets the rest).`,
        );
        deploy(second.id, half);
        locked.add(second.id);
        if (defends) keepFromMargin(second.id);
        n = roomAt(where);
      }
    }
    if (n > 0 && !spreadRest && joins) {
      // #288 (second half, the rule chosen for the owner): extra armies go with an attack only as far as
      // the next step from its target needs them; what is left is offered to another capture this turn
      // (rule 5b takes it, else planPass hands it back here); only the rest still rides the attacks.
      const js = joins;
      const src = where;
      const steps = js.map((m) => nextStep(m, src));
      const add = new Map<PlannedMove, number>();
      let left = n;
      // First each need the leftover covers whole, in the joins' order (most steps onward first), one
      // attack per next step: a share that leaves the step short still costs a deploy next turn.
      const funded = new Set<number>();
      for (const s of steps) {
        if (s.need > 0 && s.need <= left && !funded.has(s.step!)) {
          add.set(s.m, s.need);
          left -= s.need;
          funded.add(s.step!);
          s.funded = true;
        }
      }
      const offer = left > 0 ? otherCapture(left, src) : undefined;
      if (offer) left -= offer.n;
      // The rest rides the attacks as before (#288's first half), an army at a time to the one with the
      // least extra so far (the first among equals): the even split #402 made whenever no need exceeds
      // its share, so a landing that also faces an enemy next turn keeps what it had.
      const spread = (k: number, out: Map<PlannedMove, number>) => {
        for (let a = 0; a < k; a++) {
          const m = js.reduce((best, x) => ((out.get(x) ?? 0) < (out.get(best) ?? 0) ? x : best));
          out.set(m, (out.get(m) ?? 0) + 1);
        }
      };
      spread(left, add);
      const sent = n - (offer?.n ?? 0);
      let firstLine: string | undefined;
      if (sent > 0) {
        deploy(src, sent);
        for (const [m, k] of add) applyTo(src, m, k);
        firstLine = joinLine(src, sent, steps, add);
        rationale.push(firstLine);
        locked.add(src);
      }
      if (offer) {
        deploy(offer.at, offer.n);
        const offerLine = `Deploy ${offer.n} of the leftover to ${label(offer.at)} for another capture this turn (#288): the attacks out of ${label(src)} already carry what the next steps from their targets need, so the rest is offered to a capture (${label(offer.t)}, ${offer.cost} to take) before it rides them.`;
        rationale.push(offerLine);
        offered = {
          at: offer.at,
          revert: () => {
            // No capture took it (rule 5b refused it): it rides the attacks out of the stack after all,
            // unless an order since sent some of it.
            if (avail.get(offer.at)! < offer.n) return;
            undeploy(offer.at, offer.n);
            const i = rationale.indexOf(offerLine);
            if (i >= 0) rationale.splice(i, 1);
            const total = new Map(add);
            spread(offer.n, total);
            deploy(src, offer.n);
            for (const m of js) {
              const k = (total.get(m) ?? 0) - (add.get(m) ?? 0);
              if (k > 0) applyTo(src, m, k);
            }
            const again = joinLine(src, n, steps, total);
            const was = firstLine === undefined ? -1 : rationale.indexOf(firstLine);
            if (was >= 0) rationale[was] = again;
            else rationale.push(again);
            locked.add(src);
          },
        };
      }
    } else if (n > 0 && !spreadRest) {
      rationale.push(`Deploy the leftover ${n} to ${label(where)}: ${why}.`);
      deploy(where, n);
      // Keep a strike or expansion stack there: the transfer step must not walk it back as "idle
      // interior" armies. Only when it got deploys (under Local Deployment it may get none).
      if (lock) locked.add(where);
      if (central) ps.centralKeep.set(where, (ps.centralKeep.get(where) ?? 0) + n);
      if (defends) keepFromMargin(where);
    }
    if (stack) strikeStack = { ...stack, deployed: Math.max(0, n) };
    // Local Deployment: what is left of each bonus pool stays inside its bonus, on its
    // most threatened member (not conceded first; ties by id). One charge, taken before
    // any of these deploys: re-charging after each would let the matching spread a
    // pool's armies over an overlapping pool and strand the latter's.
    if (local && ps.budget > 0) {
      const danger = (id: number) => {
        const b = borders.get(id);
        if (!b) return -Infinity;
        return b.threat - (toTake(stays(id) + unitsAt(id)) ?? Infinity);
      };
      // A conceded border whose garrison stays (#59) is still defended: its pool goes there.
      const lost = (id: number) => conceded.has(id) && !stood.has(id);
      const charged = chargeDeploys(pools, deployed).used;
      for (const p of pools.bonuses) {
        const left = p.value - (charged.get(p.bonusId) ?? 0);
        if (left <= 0) continue;
        // #103: a member next to a threatening enemy always beats an interior one, even a
        // border the plan gave up: the pool can be deployed nowhere else.
        const m = [...p.territoryIds].sort(
          (a, b) =>
            // No-Split (#124): a member that issues an order would send the pool away with it.
            Number(orderOf(a) !== undefined) - Number(orderOf(b) !== undefined) ||
            Number(borders.has(b)) - Number(borders.has(a)) ||
            Number(lost(a)) - Number(lost(b)) ||
            danger(b) - danger(a) ||
            a - b,
        )[0]!;
        rationale.push(
          `Deploy bonus ${p.name} (#${p.bonusId})'s ${left} to ${label(m)}: Local Deployment keeps them inside the bonus, and it is its most threatened ${borders.has(m) ? 'border' : 'member'}${borders.has(m) ? ' (they stay there this turn)' : ''}.`,
        );
        deploy(m, left);
        // Armies deployed from a pool to defend its border are never moved out the same turn.
        if (borders.has(m)) {
          locked.add(m);
          poolDeployed.set(m, (poolDeployed.get(m) ?? 0) + left);
        }
      }
    }
    if (ps.budget > 0) {
      // Unreachable: the leftover deploy filled `where` to its exact room, so no anywhere
      // armies remain, and each pool's unused room (from one maximum charge) went inside
      // it. Never leave income undeployed — but say the plan breaks the pools.
      warnings.push(
        `Local Deployment: ${ps.budget} armies could not be placed within the pools; they go to ${label(where)}, which breaks Local Deployment — war.app may refuse this turn.`,
      );
      deploy(where, ps.budget);
    }
  }
  return { strikeStack, poolDeployed, staging, offered };
}
