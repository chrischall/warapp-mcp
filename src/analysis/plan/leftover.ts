// Rule 5, the leftover deploy (#72, #102, #103, #121, #124, #125, #163, #215; #133): the income no
// capture or hold took goes, in order, to the borders that fall without the armies withdrawn into
// them unless I am known to move first (#215), to the borders short of their hold before the strike stack,
// to a conceded border it can make hold after all (its withdrawal taken back), then to the strike
// stack, the short borders' comfortable margins, the step it saves toward, the expansion stack,
// the most fogged border or the biggest stack — split against a Bomb when it concentrates for
// nothing — and under Local Deployment each pool's rest inside its bonus. planPass runs it where
// it ran before: after rule 1c's second reconsideration and the strike stack's choice, before the
// strike stack is spent.
import { neighborsOf } from '../graph.js';
import { chargeDeploys } from '../local-deploy.js';
import { COMFORT_MARGIN, type PlannedMove } from './shared.js';
import { lateArrivals, type Holds } from './holds.js';
import type { DeployBook } from './orders.js';
import type { SaveStep } from './stand-still.js';
import type { PlanCtx, PlanState } from './state.js';
import type { StrikeStack } from './strike.js';
import type { Targets } from './targets.js';
import type { Threats } from './threats.js';

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
  // ---- leftover deploy ----
  if (ps.budget > 0) {
    // #215: armies withdrawn into a border hold it only if I move first: when the opponent moves
    // first, its first order (an all-in there) runs before my transfer in. Unless I am known to
    // move first, the leftover first makes each open border that falls without them hold on its
    // own — the worse order — most at stake first, when it can afford it whole; the steps below
    // then count them only for comfort. One that holds only with them is named in the report.
    for (const b of [...borders.values()].sort((x, y) => valueOf(y.id) - valueOf(x.id) || x.id - y.id)) {
      const late = lateArrivals(pc, ps, b.id);
      // No-Split (#124): a deploy on a territory that issues an order leaves with it, holding nothing.
      if (late <= 0 || !open(b.id) || orderOf(b.id)) continue;
      const own = stays(b.id) - late + unitsAt(b.id);
      if ((toTake(own) ?? Infinity) > b.threat) continue;
      let d = 0;
      while ((toTake(own + d) ?? Infinity) <= b.threat) d++;
      if (d > ps.budget || d > roomAt(b.id)) continue;
      rationale.push(
        `Deploy ${d} to ${label(b.id)} so it holds whoever moves first (protects +${valueOf(b.id)}): the ${late} withdrawn into it land after player ${b.player}'s attack if it moves first, and without them its ${own + d - unitsAt(b.id)} need ${toTake(own + d)} to take, above the ~${b.threat} threat.`,
      );
      deploy(b.id, d);
      locked.add(b.id);
    }
  }
  if (ps.budget > 0) {
    const foggedNext = (id: number) =>
      neighborsOf(g, id).filter((n) => {
        const st = state.get(n);
        return !captured.has(n) && (!st || st.owner.kind === 'unknown' || st.armies === null);
      }).length;
    const short = [...borders.values()]
      // No-Split (#124): a deploy on a territory that issues an order leaves with it, holding nothing.
      .filter((b) => open(b.id) && !orderOf(b.id))
      .map((b) => ({ ...b, take: toTake(stays(b.id) + unitsAt(b.id)) }))
      .filter((b) => b.take !== null && b.take <= COMFORT_MARGIN * b.threat)
      .sort((a, b) => valueOf(b.id) - valueOf(a.id) || a.take! / a.threat - b.take! / b.threat || a.id - b.id);
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
      }
    // #121: before any comfort margin, a conceded border that the leftover can make hold is held
    // after all (live, a border short by 2 was conceded while 5 went to one that already held,
    // and it fell with 15 armies). Only where the leftover would otherwise buy comfort margins
    // (no strike stack), from what is left once every held border that would fall as it stands
    // has its hold; best worth per army first. Its withdrawal is taken back, unless the
    // territory it went to needs those armies to hold; a border that attacks out, my
    // commander's, or one whose garrison already stays is not revived.
    if (!stack && short.length) {
      let falling = 0;
      for (const b of borders.values()) {
        if (conceded.has(b.id) || orderOf(b.id)) continue;
        let d = 0;
        while ((toTake(stayAt(b.id) + d + unitsAt(b.id)) ?? Infinity) <= b.threat) d++;
        falling += d;
      }
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
          return { t, d, out, threat: b.threat };
        })
        .filter(({ out }) => {
          if (!out) return true;
          // The territory the withdrawal went to keeps holding without it.
          const dest = borders.get(out.to);
          if (!dest || conceded.has(out.to)) return true;
          const at = stayAt(out.to) + unitsAt(out.to);
          const heldWith = (toTake(at) ?? Infinity) > dest.threat;
          return !heldWith || (toTake(at - out.armies) ?? Infinity) > dest.threat;
        })
        .sort((a, b) => b.t.worth / Math.max(1, b.d) - a.t.worth / Math.max(1, a.d) || a.d - b.d || a.t.id - b.t.id);
      for (const { t, d, out, threat } of revivable) {
        if (d > ps.budget - falling || d > roomAt(t.id)) continue;
        if (out) {
          moves.splice(moves.indexOf(out), 1);
          avail.set(t.id, avail.get(t.id)! + out.armies);
          const inc = (incoming.get(out.to) ?? 0) - out.armies;
          if (inc > 0) incoming.set(out.to, inc);
          else incoming.delete(out.to);
          const r = rationale.findIndex((l) => l.startsWith(`Withdraw ${out.armies} from ${label(t.id)} to `));
          if (r >= 0) rationale.splice(r, 1);
          const w = warnings.findIndex((l) => l.startsWith(`The withdrawal from ${label(t.id)} only executes`));
          if (w >= 0) warnings.splice(w, 1);
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
    }
    let where: number;
    let why: string;
    let lock = false;
    /** #163: the leftover concentrates for one attack (strike, saving, expansion): no Bomb split. */
    let concentrating = false;
    if (stack) {
      lock = true;
      concentrating = true;
      where = stack.id;
      why = `one strike stack on the border facing player ${stack.player}, the strongest opponent (~${stack.income} income, ${stack.source}), not spread`;
    } else if (short[0]) {
      // #121: spread to each short border's comfortable margin, in order, before any border gets
      // more (two symmetric borders at an exact hold ended as 16 and 7); the rest goes to the first.
      let spread = false;
      if (short.length > 1)
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
          spread = true;
        }
      lock = true;
      where = short[0].id;
      why = spread
        ? `the rest, once every short border has its comfortable margin, to the one with the most at stake (protects +${valueOf(where)})`
        : `the held border with the most at stake (protects +${valueOf(where)}), still short of a comfortable margin over the ~${short[0].threat} threat`;
    } else if (saving) {
      where = saving.from;
      why = `save toward ${label(saving.t)} (${saving.cost} to take), the next step of bonus ${bonusName(saving.bonusId)}, which this turn cannot afford`;
      lock = true;
      concentrating = true;
    } else if (expansion !== undefined && open(expansion)) {
      where = expansion;
      why = 'the stack working on the top expansion';
      lock = true;
      concentrating = true;
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
        n = roomAt(where);
      }
    }
    if (n > 0) {
      rationale.push(`Deploy the leftover ${n} to ${label(where)}: ${why}.`);
      deploy(where, n);
      // Keep a strike or expansion stack there: the transfer step must not walk it back as "idle
      // interior" armies. Only when it got deploys (under Local Deployment it may get none).
      if (lock) locked.add(where);
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
