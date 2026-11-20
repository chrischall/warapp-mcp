// #277: a held bonus is funded before a second attack sized for the same opponent's one deploy.
// Attacks on a player's territory are sized for its defenders plus that player's whole deploy (#120,
// #201's breaks, #203's lead steps, the #226 margin): its worst case, since the player picks where to
// land. But one deploy reinforces one target, not two: when two or more attacks on one player's
// territories are each sized for its whole deploy, all but one of those sure sizings guard against a
// deploy that cannot be in both places. Live, two attacks of 108 and 122 were each sized for one
// opponent's ~53 while a held +4 bonus, short by a few armies on each of its borders, was left to fall
// to the ~6 of another.
//
// planPass runs this once every attack is sized (after the #226 margin and #240's drops), before the
// warnings on attacks and the reports. Not under No-Split (every attack sends its whole stack) or Local
// Deployment (a deploy cannot move between pools). For each such player, the attack sending the most
// (ties: the earlier order) keeps its size; every other one may give up what it sends beyond its bare
// size (a sure capture of the defenders standing there now) and beyond the deploy on its source, which
// moves with it. A held bonus (rule 1h's unit) that no order leaves and whose every threatened border
// would then hold — what they lack together within PAYBACK_TURNS × its value and that pool — gets those
// deploys (most valuable first): its borders are held, no longer conceded. The source keeps what it
// stood on (the attack and its deploy shrink together).
import type { Captures } from './captures.js';
import { lateArrivals, type Holds } from './holds.js';
import type { DeployBook } from './orders.js';
import type { PlannedMove } from './shared.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Threats } from './threats.js';

/** What a held bonus's border lacks to hold once every order is planned (#215: the worse move order). */
function shortAt(pc: PlanCtx, ps: PlanState, threats: Threats, hd: Holds, id: number): number {
  const b = threats.borderAt(id, (x) => ps.captured.has(x));
  if (!b) return 0;
  const need = Math.max(0, threats.holdArmies(b.threat) - pc.unitsAt(id));
  return Math.max(0, need - (hd.stayAt(id) - lateArrivals(pc, ps, id)));
}

export function fundFromSecondSizing(pc: PlanCtx, ps: PlanState, book: DeployBook, threats: Threats, hd: Holds, caps: Captures): void {
  if (pc.noSplit || book.local) return;
  const { label, bonusName, territories: state, defenceAt, costAt, chanceOf } = pc;
  const { moves, combined, deployed, avail, rationale, warnings } = ps;
  const { worstCase, strikes } = caps;

  // ---- the attacks each sized for their owner's whole deploy, by owner ----
  const byOwner = new Map<number, PlannedMove[]>();
  for (const m of moves) {
    if (m.kind !== 'attack' || combined.has(m.to) || strikes.has(m.to)) continue;
    const st = state.get(m.to);
    if (st?.owner.kind !== 'player') continue;
    const extra = threats.reinforcementAt(m.to);
    const d = defenceAt(m.to);
    const full = costAt(m.to, d + extra);
    if (extra <= 0 || full === null || m.armies < full || (worstCase.get(m.to) ?? 0) < d + extra) continue;
    const list = byOwner.get(st.owner.playerId) ?? [];
    list.push(m);
    byOwner.set(st.owner.playerId, list);
  }
  /** Each attack that may give armies up, with what it may give and the one that keeps its size. */
  const spare = new Map<PlannedMove, { room: number; owner: number; extra: number }>();
  const keepOf = new Map<number, PlannedMove>();
  const ownerOf = (m: PlannedMove) => (state.get(m.to)!.owner as { playerId: number }).playerId;
  /** What each source's deploy still has to give (two attacks from one source share it). */
  const deployLeft = new Map<number, number>();
  for (const [owner, list] of [...byOwner].sort((a, b) => a[0] - b[0])) {
    if (list.length < 2) continue;
    const keep = [...list].sort((a, b) => b.armies - a.armies || moves.indexOf(a) - moves.indexOf(b))[0]!;
    keepOf.set(owner, keep);
    for (const m of list) {
      if (m === keep) continue;
      const bare = costAt(m.to, defenceAt(m.to));
      if (bare === null) continue;
      const free = deployLeft.get(m.from) ?? deployed.get(m.from) ?? 0;
      const room = Math.min(m.armies - bare, free);
      if (room <= 0) continue;
      deployLeft.set(m.from, free - room);
      spare.set(m, { room, owner, extra: threats.reinforcementAt(m.to) });
    }
  }
  if (!spare.size) return;

  // ---- the held bonuses those armies make hold, most valuable first ----
  const units = [...hd.units].sort((a, b) => b.value - a.value || a.bonusId - b.bonusId);
  for (const u of units) {
    if (u.value <= 0) continue;
    const ids = u.members.map((m) => m.id);
    // A border an order leaves (a withdrawal, an attack out) is not one this restores.
    if (moves.some((mv) => ids.includes(mv.from) && (mv.armies > 0 || mv.commander))) continue;
    const short = new Map(ids.map((id) => [id, shortAt(pc, ps, threats, hd, id)] as const));
    const need = [...short.values()].reduce((n, x) => n + x, 0);
    const pool = [...spare.values()].reduce((n, x) => n + x.room, 0);
    if (need <= 0 || need > pool || need > pc.paybackTurns * u.value) continue;

    // Take it from the attacks with the most to give first (ties: the later order).
    const takes: { m: PlannedMove; n: number; before: number }[] = [];
    let left = need;
    for (const [m, x] of [...spare].sort((a, b) => b[1].room - a[1].room || moves.indexOf(b[0]) - moves.indexOf(a[0]))) {
      if (left <= 0) break;
      const n = Math.min(left, x.room);
      left -= n;
      x.room -= n;
      if (x.room <= 0) spare.delete(m);
      takes.push({ m, n, before: m.armies });
      m.armies -= n;
      avail.set(m.from, avail.get(m.from)! + n);
      book.undeploy(m.from, n);
      const d = defenceAt(m.to);
      m.winChance = chanceOf(m.armies, d);
      if (ps.survivorsAt.has(m.to)) ps.survivorsAt.set(m.to, ps.survivorsAt.get(m.to)! - n);
      // What its owner could still deploy there first and lose it to this attack.
      let covered = 0;
      while (covered < x.extra && (costAt(m.to, d + covered + 1) ?? Infinity) <= m.armies) covered++;
      worstCase.set(m.to, d + covered);
    }
    const given: string[] = [];
    for (const id of [...ids].sort((a, b) => a - b)) {
      const n = short.get(id)!;
      if (n > 0) {
        book.deploy(id, n);
        given.push(`${n} to ${label(id)}`);
      }
      ps.locked.add(id);
      hd.heldBorders.add(id);
      if (!hd.conceded.delete(id)) continue;
      const conceding = `${label(id)} cannot be held `;
      for (let i = warnings.length - 1; i >= 0; i--)
        if (warnings[i]!.startsWith(conceding) && warnings[i]!.endsWith(': conceded')) warnings.splice(i, 1);
    }
    u.conceded = false;
    u.contested = false;
    const conceding = `conceding bonus ${bonusName(u.bonusId)} (+${u.value}):`;
    for (let i = warnings.length - 1; i >= 0; i--) if (warnings[i]!.startsWith(conceding)) warnings.splice(i, 1);
    const from = takes
      .map(
        ({ m, n, before }) =>
          `${n} from the attack on ${label(m.to)} from ${label(m.from)} (${before} down to ${m.armies}: still sure against the ${defenceAt(m.to)} there now, and against up to ${worstCase.get(m.to)! - defenceAt(m.to)} deployed there first)`,
      )
      .join(' and ');
    const kept = [...new Map(takes.map(({ m }) => [ownerOf(m), m] as const)).keys()]
      .sort((a, b) => a - b)
      .map((o) => {
        const keep = keepOf.get(o)!;
        return `player ${o}'s ~${threats.reinforcementAt(keep.to)} deploy reinforces one of its targets, not two, and the attack on ${label(keep.to)} keeps its size for it`;
      })
      .join('; ');
    rationale.push(
      `Fund held bonus ${bonusName(u.bonusId)} (+${u.value}) (#277): deploy ${given.join(', ')} so each of its borders holds, ${from}. ${kept[0]!.toUpperCase()}${kept.slice(1)}.`,
    );
  }
}
