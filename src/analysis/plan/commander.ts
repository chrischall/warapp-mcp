// #274 items 2 and 3: where my commander should stand. Pure and deterministic (ties on ascending id).
//
// A commander within COMMANDER_CLEAR_MOVES moves of an enemy or fogged territory (the distance
// warapp_plan_turn's `commander` block reports) walks one step a turn toward a territory of mine
// farther from every one of them, until it is that many moves clear. It walks only through my
// own land, never onto a territory nearer an enemy than the one it leaves nor onto one beside an
// enemy or the fog (taken before my order runs, the step would turn the commander's transfer into
// an attack): the safest path; and only toward a territory strictly farther than where it stands.
// With no such territory it stays, and rule 1k holds it against the worst case.
import { COMMANDER_STRENGTH } from '../combat.js';
import { bfsDistances, neighborsOf, type MapGraph } from '../graph.js';
import type { DeployBook } from './orders.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Threats } from './threats.js';
import { byNum } from './util.js';

/** Moves from every enemy or fogged territory past which my commander stops walking away. */
export const COMMANDER_CLEAR_MOVES = 3;

/** One step of my commander toward safety (see the header). */
export interface CommanderRetreat {
  from: number;
  to: number;
  /** Moves from `from`, then from `to`, to the nearest enemy or fogged territory. */
  distance: number;
  toDistance: number;
  /** The territory of mine it is heading for, its distance from every enemy, and the steps there. */
  target: number;
  targetDistance: number;
  steps: number;
}

/** Where my commander stands and, when it should walk, its step. */
export interface CommanderPlace {
  territory: number;
  /** Moves to the nearest enemy or fogged territory; `null` with none on the map. */
  distance: number | null;
  retreat?: CommanderRetreat;
  /** The caller kept it where it stands (`commanderWalks: false`): no step is planned. */
  pinned?: true;
}

/**
 * Where my commander on `from` stands, and its step toward safety when it is within `clear` moves
 * of a `hostile` territory and a territory of mine (`isMine`) farther from all of them is reachable
 * through my land without coming nearer one.
 */
export function commanderPlace(
  g: MapGraph,
  from: number,
  isMine: (t: number) => boolean,
  hostile: readonly number[],
  clear: number = COMMANDER_CLEAR_MOVES,
): CommanderPlace {
  const away = bfsDistances(g, hostile);
  const far = (t: number) => away.get(t) ?? Infinity;
  const here = far(from);
  const distance = Number.isFinite(here) ? here : null;
  if (here >= clear) return { territory: from, distance };
  // Through my land, never nearer an enemy than here, and never onto a territory beside one: an
  // enemy that takes the step first would turn my commander's transfer into an attack.
  const floor = Math.max(here, 2);
  const passable = (t: number) => t === from || (isMine(t) && far(t) >= floor);
  const hops = bfsDistances(g, [from], { passable });
  let best: { t: number; score: number; hops: number; d: number } | undefined;
  for (const [t, h] of [...hops].sort((a, b) => a[0] - b[0])) {
    const d = far(t);
    if (t === from || d <= here) continue;
    const score = Math.min(d, clear);
    if (!best || score > best.score || (score === best.score && (h < best.hops || (h === best.hops && d > best.d)))) best = { t, score, hops: h, d };
  }
  if (!best) return { territory: from, distance };
  // The first step on a shortest such path, the one farthest from every enemy (then the lowest id).
  const back = bfsDistances(g, [best.t], { passable });
  const to = neighborsOf(g, from)
    .filter((n) => passable(n) && back.get(n) === best!.hops - 1)
    .sort((a, b) => far(b) - far(a) || byNum(a, b))[0]!;
  const fin = (d: number) => (Number.isFinite(d) ? d : clear);
  return {
    territory: from,
    distance,
    retreat: { from, to, distance: here, toDistance: fin(far(to)), target: best.t, targetDistance: fin(best.d), steps: best.hops },
  };
}

/** The first warning of a plan that walks my commander (#274). */
export function commanderMoveWarning(r: CommanderRetreat, label: (id: number) => string, clear: number = COMMANDER_CLEAR_MOVES): string {
  const moves = (n: number) => `${n} move${n === 1 ? '' : 's'}`;
  return (
    `My commander moves from ${label(r.from)} to ${label(r.to)} this turn (#274): ${label(r.from)} is ${moves(r.distance)} from the nearest enemy or fog, ` +
    `and ${label(r.to)} is ${moves(r.toDistance)}${r.to === r.target ? '' : `, on the way to ${label(r.target)} (${moves(r.targetDistance)}, ${r.steps} steps)`}; ` +
    `it walks one step a turn until it is ${moves(clear)} clear. ${label(r.from)} is no longer must-hold: it is held only for what it is worth itself. ` +
    `The order takes the commander along (the commander option, its encoding not yet verified live), listed as early as the move order allows.`
  );
}

/** Why my commander stays where it is (#274), for the rationale. */
export function commanderStaysLine(place: CommanderPlace, label: (id: number) => string, clear: number = COMMANDER_CLEAR_MOVES): string {
  const where = label(place.territory);
  if (place.pinned) return `My commander stays on ${where}: this plan does not walk it (commanderWalks off).`;
  if (place.distance === null) return `My commander stays on ${where}: no enemy or fogged territory is on the map.`;
  const d = `${place.distance} move${place.distance === 1 ? '' : 's'}`;
  return place.distance >= clear
    ? `My commander stays on ${where}: it is ${d} from the nearest enemy or fog, clear at ${clear} (#274).`
    : `My commander stays on ${where}, ${d} from the nearest enemy or fog: no territory of mine farther from every enemy is reachable through my land without coming nearer one, so it holds there (#274).`;
}

/** The reason a commander's walk carries. */
const stepReason = (r: CommanderRetreat, label: (id: number) => string) =>
  `my commander walks toward safety (#274): ${label(r.to)} is farther from every enemy and the fog than ${label(r.from)} (${r.toDistance} moves, not ${r.distance})`;

/**
 * #274: under No-Split my commander's territory issues one order, so its walk is that order: it is
 * entered before any pass plans (each sees the territory already ordering) and sized at the end
 * ({@link placeCommanderMove}: the whole stack goes with it). The walk wins: a commander strike or a
 * kill that territory could have made is not made (getting the commander out of reach comes first).
 */
export function reserveCommanderMove(pc: Pick<PlanCtx, 'commanderAt' | 'noSplit' | 'label'>, ps: Pick<PlanState, 'moves'>): void {
  const r = pc.commanderAt?.retreat;
  if (!r || !pc.noSplit) return;
  ps.moves.push({ from: r.from, to: r.to, armies: 0, kind: 'transfer', reason: stepReason(r, pc.label), commander: true });
}

/**
 * #274: once every other order is planned, my commander's walk: it rides the move from its
 * territory to the step when there is one, else goes as its own transfer carrying no armies (what
 * it leaves is held only for its own worth). Under No-Split the reserved order sends the whole stack.
 */
export function placeCommanderMove(pc: Pick<PlanCtx, 'commanderAt' | 'noSplit' | 'label'>, ps: Pick<PlanState, 'moves' | 'avail'>): void {
  const r = pc.commanderAt?.retreat;
  if (!r) return;
  const at = ps.moves.find((m) => m.commander);
  if (at) {
    // No-Split's whole stack: what the passes moved into it already, plus anything still idle there.
    at.armies += Math.max(0, ps.avail.get(r.from) ?? 0);
    ps.avail.set(r.from, Math.min(0, ps.avail.get(r.from) ?? 0));
    return;
  }
  const along = ps.moves.find((m) => m.from === r.from && m.to === r.to && m.kind === 'transfer');
  if (along) along.commander = true;
  else ps.moves.push({ from: r.from, to: r.to, armies: 0, kind: 'transfer', reason: stepReason(r, pc.label), commander: true });
}

/**
 * #274: my commander stays where it stood until my first order runs, and the opponent's first order
 * may come before it: the territory it leaves gets the deploys that make it survive one attack
 * there — the strongest stack beside it with its owner's whole deploy (at least my own income, as
 * warapp_submit_turn sizes its replies; a what-if `enemyDeploy` as given), my commander counted.
 * Even when I am known to move first (#274 review): warapp_submit_turn's commander check is not
 * told who moves first and tries the opponent first too, so a walk without this hold would be
 * refused there. Nothing more: once it has walked, the territory is held only for its own worth.
 * The hold where it walks to (rule 1k) is reserved first; when what is left cannot make it hold, all
 * of it goes there and a warning says so. That case, or a fogged neighbour (what hides there cannot
 * be sized), sets `ps.commanderCaught`: only then is Order Priority advised for the walk
 * (plan/move-order.ts). Run after the strikes (a territory `gone` — struck or finished off —
 * threatens nothing), before triage.
 */
export function commanderTransit(
  pc: PlanCtx,
  ps: PlanState,
  book: Pick<DeployBook, 'deploy' | 'roomAt' | 'guardAt'>,
  threats: Pick<Threats, 'deployReaching' | 'bombSized' | 'borderAt'>,
  gone: (n: number) => boolean = () => false,
): void {
  const r = pc.commanderAt?.retreat;
  if (!r) return;
  // A fogged neighbour may hide a stack: no hold can be sized against it.
  if (
    neighborsOf(pc.g, r.from).some((n) => {
      const st = pc.territories.get(n);
      return !gone(n) && (st === undefined || st.owner.kind === 'unknown' || (st.armies === null && st.owner.kind === 'player' && pc.foe(st.owner.playerId)));
    })
  )
    ps.commanderCaught = true;
  const floor = pc.custom ? 0 : Math.max(0, pc.income - pc.cardArmies);
  let threat = 0;
  let by: number | undefined;
  for (const n of [...neighborsOf(pc.g, r.from)].sort(byNum)) {
    const st = pc.territories.get(n);
    if (gone(n) || st?.owner.kind !== 'player' || !pc.foe(st.owner.playerId) || st.armies === null) continue;
    const p = st.owner.playerId;
    const t = Math.max(0, st.armies - pc.guard) + pc.unitsAt(n) + Math.max(floor, pc.custom ? pc.deployOf(p) : threats.deployReaching(p, [n]));
    if (t > threat) [threat, by] = [t, p];
  }
  if (by === undefined) return;
  threat = threats.bombSized(r.from, threat);
  const have = ps.avail.get(r.from)! + book.guardAt(r.from) + pc.unitsAt(r.from) + COMMANDER_STRENGTH;
  // Where it walks to holds it for the rest of the turn (rule 1k there): its hold comes first.
  const dest = threats.borderAt(r.to, gone);
  let reserve = 0;
  if (dest) {
    const there = ps.avail.get(r.to)! + book.guardAt(r.to) + pc.unitsAt(r.to);
    while (reserve <= ps.budget && (pc.toTake(there + reserve) ?? Infinity) <= dest.threat) reserve++;
  }
  const room = Math.max(0, Math.min(book.roomAt(r.from), ps.budget - reserve));
  let need = 0;
  while (need <= room && (pc.toTake(have + need) ?? Infinity) <= threat) need++;
  // `need` past `room`: no deploy there makes it hold.
  const label = pc.label;
  if (need <= room) {
    if (need > 0) {
      book.deploy(r.from, need);
      ps.rationale.push(
        `Deploy ${need} to ${label(r.from)}: my commander walks from it this turn (#274), but until my first order runs the opponent's first attack may land there: with my commander it then holds against ~${threat} (player ${by}'s strongest stack beside it and its whole deploy, never below my own income).`,
      );
    }
    return;
  }
  // Short of it, all that may go there goes there (an attack smaller than the worst case may come).
  ps.commanderCaught = true;
  book.deploy(r.from, room);
  ps.warnings.push(
    `My commander may be caught on ${label(r.from)} before it walks (#274): if the opponent moves first, player ${by}'s first attack there (~${threat}) lands before my first order, and ${room ? `the ${room} deployed there` : 'nothing more deployed there'} cannot make it hold against that (it needs more). Order Priority, when I hold one, runs the walk first.`,
  );
}
