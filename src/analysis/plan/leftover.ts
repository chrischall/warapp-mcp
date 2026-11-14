// Rule 5, the leftover deploy (#72, #102, #103, #121, #124, #125, #163, #215, #218; #133): the income no
// capture or hold took goes, in order, to a conceded border it can make hold after all (its
// withdrawal taken back; only without a strike stack, where the leftover would buy comfort), to
// the borders that fall without the armies withdrawn into them unless I am known to move first
// (#215), to the borders short of their hold before the strike stack, then to the strike
// stack, the short borders' comfortable margins (#218: the rest on the step's source when it
// defends as well), the step it saves toward, the expansion stack (#218: with no front in view,
// the territory central to what I hold instead when the stack lies far from it), the most fogged
// border or the biggest stack — split against a Bomb when it concentrates for
// nothing — and under Local Deployment each pool's rest inside its bonus. planPass runs it where
// it ran before: after rule 1c's second reconsideration and the strike stack's choice, before the
// strike stack is spent.
import { bonusTerritories } from '../bonuses.js';
import { bfsDistances, neighborsOf } from '../graph.js';
import { chargeDeploys } from '../local-deploy.js';
import { COMFORT_MARGIN, type PlannedMove } from './shared.js';

/** #218 (comment): hops the expansion stack may lie farther from my farthest border than the centre before the leftover stays central. */
export const CENTRE_SLACK = 1;
import { knownFirst, lateArrivals, lateNet, type Holds } from './holds.js';
import type { DeployBook } from './orders.js';
import type { SaveStep } from './stand-still.js';
import type { PlanCtx, PlanState } from './state.js';
import type { StrikeStack } from './strike.js';
import type { Targets } from './targets.js';
import type { Border, Threats } from './threats.js';

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
  const { orderOf, deploy, pools, roomAt, valueOf } = book;
  const { borders } = threats;
  const { conceded, kept, garrisoned, stood, threatened, stayAt } = hd;
  const { committing, byCloseness, bonusTarget, targets } = tgt;
  // As the deploy book reads it, restated here so TypeScript narrows `pools` wherever it is tested.
  const local = pools !== null && pools.bonuses.length > 0;
  /** The strike stack rule 0p.3c built this turn (#72), and the leftover it got. */
  let strikeStack: StrikeStack | undefined;
  /** Armies a Local Deployment pool put on each border this turn (#103): never moved out. */
  const poolDeployed = new Map<number, number>();
  /**
   * #125: the capture to save toward — rule 4e's top step it could not afford, else (rule 4f
   * committing) the closest bonus's cheapest missing member in reach when this turn made no capture
   * into that bonus — and its source: my territory beside it (open, not a softener, issuing no
   * order under No-Split) with the most armies free, ties by id.
   */
  const stepSource = (
    open: (x: number) => boolean,
    notSoftening: (x: number) => boolean,
  ): { t: number; bonusId: number; cost: number; from: number } | undefined => {
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
    // Only a step this turn cannot afford: one the plan could take but did not (R3, rule 4c or 4d
    // refused it) is no reason to save.
    if (from === undefined || avail.get(from)! + roomAt(from) >= step.cost) return undefined;
    return { ...step, from };
  };
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
   * The open borders short of a comfortable margin, most at stake first (rule 5). `back`: the
   * withdrawals the revival took back, still counted where they were going, as when this was
   * judged before the revival.
   */
  const shortOf = (bs: Iterable<Border>, back: Map<number, number> = new Map()) =>
    [...bs]
      // No-Split (#124): a deploy on a territory that issues an order leaves with it, holding nothing.
      .filter((b) => open(b.id) && !orderOf(b.id))
      .map((b) => ({ ...b, take: toTake(stays(b.id) + (back.get(b.id) ?? 0) + unitsAt(b.id)) }))
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
  // ---- leftover deploy ----
  // The borders the comfort steps may pick: open before any border is held after all (a revived
  // border's hold is its whole share of the leftover).
  const comfortPool = [...borders.values()].filter((b) => open(b.id));
  // The revival runs only where the leftover would otherwise buy comfort margins (no strike
  // stack, a border short of its margin), and then before the worse-order holds; otherwise the
  // worse-order holds go first, as before.
  const reviving = !stack && ps.budget > 0 && shortOf(comfortPool).length > 0;
  if (!reviving) worseOrderHolds();
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
    const biggest = (ids: number[]) =>
      [...ids].sort((a, b) => armiesOf(b) + (deployed.get(b) ?? 0) - (armiesOf(a) + (deployed.get(a) ?? 0)) || a - b)[0];
    const takenBack = reviving ? holdAfterAll() : undefined;
    if (reviving) worseOrderHolds();
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
        ps.leftoverKept.add(b.id);
      }
    let where: number;
    let why: string;
    let lock = false;
    /** #163: the leftover concentrates for one attack (strike, saving, expansion): no Bomb split. */
    let concentrating = false;
    /** #218 (comment): the leftover stays central: rule 6 keeps it there, not the armies already there. */
    let central = false;
    /** #226 review: the leftover defends `where` or saves there: the #226 margin leaves it. */
    let defends = false;
    if (stack) {
      lock = true;
      concentrating = true;
      where = stack.id;
      why = `one strike stack on the border facing player ${stack.player}, the strongest opponent (~${stack.income} income, ${stack.source}), not spread`;
    } else if (short[0]) {
      defends = true;
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
          ps.leftoverKept.add(b.id);
          spread = true;
        }
      lock = true;
      if (carries(short[0])) {
        // #218: the rest goes to the source, at equal defensive value, and saves toward the step.
        where = src!.id;
        concentrating = true;
        why = `save toward ${label(saving!.t)} (${saving!.cost} to take), the next step of bonus ${bonusName(saving!.bonusId)}, which this turn cannot afford${
          short[0].id === src!.id
            ? `; it is also the held border with the most at stake (protects +${valueOf(src!.id)})`
            : `; it defends as well as ${label(short[0].id)} would (the same ~${short[0].threat} threat from player ${short[0].player}, protects +${valueOf(short[0].id)})`
        }${spread ? ', once every short border has its comfortable margin' : ''}`;
      } else {
        where = short[0].id;
        why = spread
          ? `the rest, once every short border has its comfortable margin, to the one with the most at stake (protects +${valueOf(where)})`
          : `the held border with the most at stake (protects +${valueOf(where)}), still short of a comfortable margin over the ~${short[0].threat} threat`;
      }
    } else if (saving) {
      where = saving.from;
      why = `save toward ${label(saving.t)} (${saving.cost} to take), the next step of bonus ${bonusName(saving.bonusId)}, which this turn cannot afford`;
      defends = true;
      lock = true;
      concentrating = true;
    } else if (expansion !== undefined && open(expansion)) {
      // #218 (comment): with no enemy in view there is no front to go to, and a leftover riding
      // the top expansion walks deeper into one region every turn (live: 14 hops from the nearest
      // front two turns later). When the expansion stack is more than CENTRE_SLACK hops farther
      // from my farthest border than the territory central to what I hold, and its attacks land
      // for sure without the leftover, the leftover stays there.
      // Only once its attacks land for sure: under luck the leftover there raises their odds.
      const sure = moves.every((m) => m.from !== expansion || m.kind !== 'attack' || (m.winChance ?? 1) >= 1);
      const c = noFront && sure ? centre() : undefined;
      if (c && c.id !== expansion && (c.ecc.get(expansion) ?? Infinity) > c.ecc.get(c.id)! + CENTRE_SLACK) {
        where = c.id;
        why = `no enemy is in view, so there is no front to go to: it stays central to what I hold (at most ${c.ecc.get(c.id)} hops from each of my borders, where the stack working on the top expansion, ${label(expansion)}, is ${c.ecc.get(expansion)} from its farthest), ready for wherever a front opens`;
        central = true;
      } else {
        where = expansion;
        why = 'the stack working on the top expansion';
        lock = true;
        concentrating = true;
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
    if (saving && where === saving.from) staging = saving;
    // #163: an opponent may hold a Bomb: a second stack on another open border facing an enemy takes
    // half the leftover, so one bomb halves only one of them (same opponent first, then the bigger
    // stack, then id). Never a strike, saving or expansion stack: each concentrates for one attack
    // (the strike this turn, #72), and a split would halve it for certain where a bomb only may.
    if (bombOn && n >= 2 && borders.has(where) && !concentrating) {
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
        if (defends) ps.leftoverKept.add(second.id);
        n = roomAt(where);
      }
    }
    if (n > 0) {
      rationale.push(`Deploy the leftover ${n} to ${label(where)}: ${why}.`);
      deploy(where, n);
      // Keep a strike or expansion stack there: the transfer step must not walk it back as "idle
      // interior" armies. Only when it got deploys (under Local Deployment it may get none).
      if (lock) locked.add(where);
      if (central) ps.centralKeep.set(where, (ps.centralKeep.get(where) ?? 0) + n);
      if (defends) ps.leftoverKept.add(where);
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
  return { strikeStack, poolDeployed, staging };
}
