// The move order of a planning pass (#127, #179; rule 1s; #133): Order Priority for a commander
// strike, the schedule of the moves (the protected first order, early, sure, filler and last
// slots), the first-mover warnings on finishing a player off, the exits of an opponent down to a few
// territories, the Order Priority advice and the move-position lines. planPass runs them where they
// ran before: Order Priority for a strike after the transfers (rule 6), before the expected outcome;
// the schedule after the "Not attacking" line, before the offence list is built.
import { neighborsOf } from '../graph.js';
import {
  captureCost,
  FEW_TERRITORIES,
  ORDER_PRIORITY_MIN_ARMIES,
  type OpponentExits,
  type PlannedMove,
} from './shared.js';
import { straightKills } from '../combat.js';
import { indexAfterAll, MoveSlot, opponentOrdersBefore, scheduleMoves, type MoverPosition } from '../schedule.js';
import type { Captures } from './captures.js';
import type { Holds } from './holds.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Threats } from './threats.js';
import { byNum } from './util.js';


/** Order Priority for a strike (rule 1s): `strikeCard` when the threat to my commander advised the card. */
export function strikeOrderPriority(pc: PlanCtx, ps: PlanState, threats: Threats, hd: Holds, struck: ReadonlySet<number>) {
  const { opts, territories: state, label, unitsAt, toTake, myCommanders } = pc;
  const { warnings, rationale } = ps;
  const { borderAt } = threats;
  const { stayAt } = hd;
  // ---- Order Priority for a strike (rule 1s) ----
  // war.app interleaves both players' attacks, so a struck player's stacks next to my commander
  // may attack before the strike lands. Judged on what stays on my commander's territory once
  // every planned deploy and move is in (a strike from it thins it), against the STRUCK players'
  // visible stacks only: moving first kills their commander before they attack, but does nothing
  // against a third player, so a threat from someone else is no reason to spend the card.
  const commanderThreatened = [...myCommanders].some((c) => {
    const b = borderAt(c, (n) => {
      const st = state.get(n);
      return !(st?.owner.kind === 'player' && struck.has(st.owner.playerId));
    });
    return b !== null && (toTake(stayAt(c) + unitsAt(c)) ?? Infinity) <= b.threat;
  });
  /** The threat to my commander, not a withdrawal, advised Order Priority for the strike (rule 1s). */
  let strikeCard = false;
  const strikeWho = [...struck].sort(byNum).map((p) => `player ${p}`).join(' and ');
  if (struck.size && commanderThreatened) {
    const where = [...myCommanders].map(label).join(', ');
    const who = strikeWho;
    if (opts.holdsOrderPriority) {
      strikeCard = true;
      rationale.push(
        `Play Order Priority: my commander's territory ${where} is threatened this turn by what is left on it after this turn's orders, and with the card my attacks resolve first, so the strike on ${who}'s commander lands before its attacks.`,
      );
    } else
      warnings.push(
        `My attacks and ${who}'s interleave this turn, so its stacks may attack my commander's territory ${where} before the strike lands, and what is left on it after this turn's orders would fall; I hold no Order Priority card to make my attacks resolve first.`,
      );
  }

  return { strikeCard, strikeWho };
}

/** The schedule of the moves (#127), the Order Priority advice, and the exits of an opponent down to a few (#179). */
export function scheduleOrders(
  pc: PlanCtx,
  ps: PlanState,
  threats: Threats,
  hd: Holds,
  caps: Captures,
  struck: ReadonlySet<number>,
  strikeCard: boolean,
  strikeWho: string,
) {
  const {
    g, s, opts, foe, deployOf, territories: state, label, mine, mineSet, armiesOf, unitsAt, defenceAt, guard, rates,
    toTake,
  } = pc;
  const { warnings, rationale, captured, combined, moves } = ps;
  const { deployReaching, ownedBy, fogEdge } = threats;
  const { conceded, stayAt } = hd;
  const { strikes, worstCase, finishedOff } = caps;
  // ---- 7. schedule the moves (#127) ----
  // Orders zigzag (the first mover's 1st, the other's 1st and 2nd, …), so the place of a move in
  // the list decides what it meets. One order is protected when Order Priority is advised.
  const CONCEDED_ORDER = /; play Order Priority so it goes first\.$/;
  /** The strike Order Priority protects (rule 1s), when the threat to my commander advised the card. */
  const strikeOrder = strikeCard ? moves.find((m) => m.kind === 'attack' && strikes.has(m.to)) : undefined;
  /**
   * #179: the strike that eliminates a player finished off (rule 1e) — the attack on its largest
   * stack (most armies plus special units, then lowest id): the one that can flee or strike first.
   * Else a commander strike (rule 1s) the threat to my commander did not already protect
   * (`commander`): it ends a player too, and the commander can walk away before it lands.
   * A combined capture there (rule 3a) has no such strike: its first attack only wears the stack
   * down, and Order Priority moves only my first order ahead, so the card cannot secure it.
   */
  const kill = (() => {
    for (const p of [...finishedOff].sort(byNum)) {
      const target = [...(ownedBy.get(p) ?? [])]
        .filter((t) => moves.some((m) => m.kind === 'attack' && m.to === t))
        .sort((a, b) => armiesOf(b) + unitsAt(b) - (armiesOf(a) + unitsAt(a)) || a - b)[0];
      const order = target === undefined ? undefined : moves.find((m) => m.kind === 'attack' && m.to === target);
      if (order) return { p, order, attacks: moves.filter((m) => m.kind === 'attack' && m.to === target).length, commander: false };
    }
    // Else a strike on a commander (rule 1s) that no threat to mine advised the card for: it too
    // ends a player, and the commander can walk away before it lands.
    if (strikeOrder) return undefined;
    for (const t of [...strikes].sort(byNum)) {
      const st = state.get(t);
      if (st?.owner.kind !== 'player' || !struck.has(st.owner.playerId)) continue;
      const order = moves.find((m) => m.kind === 'attack' && m.to === t);
      if (order) return { p: st.owner.playerId, order, attacks: moves.filter((m) => m.kind === 'attack' && m.to === t).length, commander: true };
    }
    return undefined;
  })();
  if (!strikeOrder && kill && combined.has(kill.order.to))
    warnings.push(
      `The strike that eliminates player ${kill.p} is a combined capture of ${label(kill.order.to)} (${kill.attacks} attacks that must run in order): Order Priority moves only my first order ahead, so it cannot secure the kill; its stack can still flee or strike before the capture lands.`,
    );
  const killOrder = strikeOrder || (kill && combined.has(kill.order.to)) ? undefined : kill?.order;
  const outOfConceded = moves.filter((m) => conceded.has(m.from) && m !== strikeOrder && m !== killOrder);
  /** My first order: the one Order Priority would protect. Checked against the schedule below. */
  let firstOrder: PlannedMove | undefined =
    strikeOrder ?? killOrder ?? [...outOfConceded].sort((a, b) => b.armies - a.armies || a.from - b.from || a.to - b.to)[0];
  /** The visible stacks of one player next to `t` plus its deploy: what can reach `t` this turn. */
  const reachOf = (t: number) => {
    const byPlayer = new Map<number, number>();
    for (const n of neighborsOf(g, t)) {
      const st = state.get(n);
      if (st?.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null) continue;
      const p = st.owner.playerId;
      byPlayer.set(p, (byPlayer.get(p) ?? deployOf(p)) + Math.max(0, st.armies - guard) + unitsAt(n));
    }
    return byPlayer.size ? Math.max(...byPlayer.values()) : null;
  };
  const facesEnemy = (t: number) =>
    neighborsOf(g, t).some((n) => {
      const st = state.get(n);
      return st?.owner.kind === 'player' && foe(st.owner.playerId);
    });
  const lastWhy = new Map<PlannedMove, string>();
  const slotOf = (m: PlannedMove): MoveSlot => {
    if (m === firstOrder) return MoveSlot.Protected;
    if (m.kind === 'transfer') return conceded.has(m.from) || facesEnemy(m.to) ? MoveSlot.Early : MoveSlot.Filler;
    if (conceded.has(m.from)) return MoveSlot.Early;
    const st = state.get(m.to);
    if (st?.owner.kind === 'player') {
      if (worstCase.has(m.to) || strikes.has(m.to)) return MoveSlot.Sure;
      lastWhy.set(m, `${label(m.to)} (player ${st.owner.playerId}'s stack can attack first; attacking second fights its survivors)`);
      return MoveSlot.Last;
    }
    // A neutral another player can reach: early only when my survivors hold against its capture
    // of that neutral (sized as mine are), at most what its stacks next to it plus its deploy send.
    const near = reachOf(m.to);
    if (near === null) return MoveSlot.Filler;
    const reach = Math.min(near, captureCost(defenceAt(m.to), s) ?? near);
    const survivors = m.armies - Math.min(m.armies, straightKills(defenceAt(m.to), rates.defensiveKillRate));
    if ((toTake(survivors) ?? Infinity) > reach) return MoveSlot.Sure;
    lastWhy.set(m, `${label(m.to)} (another player can send ~${reach} at it, which would take my ${survivors} survivors: taken last, mine is the capture that stands)`);
    return MoveSlot.Last;
  };
  // "Eliminated even if it reinforces" holds only if my attacks land before its own orders: moving
  // first, it can move between its territories or take a thin border of mine, and survive.
  for (const p of opts.movesFirst ? [] : [...finishedOff].sort(byNum)) {
    const theirs = ownedBy.get(p) ?? [];
    /** Its stacks next to my `b` plus the deploy that can reach them (as the cover sizes it, #179). */
    const reach = (b: number) => {
      const adj = neighborsOf(g, b).filter((n) => theirs.includes(n));
      return deployReaching(p, adj) + adj.reduce((a, n) => a + Math.max(0, armiesOf(n) - guard) + unitsAt(n), 0);
    };
    const exposed = mine.filter(
      (b) => neighborsOf(g, b).some((n) => theirs.includes(n)) && (toTake(stayAt(b) + unitsAt(b)) ?? Infinity) <= reach(b),
    );
    const most = Math.max(0, ...exposed.map(reach));
    warnings.push(
      `Eliminating player ${p} assumes my attacks land before its own orders: they interleave, so if it moves first it can move between its territories${exposed.length ? `, or take ${exposed.map(label).join(' or ')} (what this plan leaves there falls to its ~${most})` : ''}, and survive.`,
    );
  }
  // ---- #179: the exits of an opponent down to a few territories ----
  // Each of its stacks can move to its own neighbours, take a neutral its movable armies plus the
  // deploy that can reach it take, or take a territory of mine that falls to that (what this plan
  // leaves there).
  const exits: OpponentExits[] = [];
  for (const [p, theirs] of [...ownedBy].sort((a, b) => a[0] - b[0])) {
    // Its land bordering the fog, it may hold more there: not known to be down to a few.
    if (theirs.length > FEW_TERRITORIES || (fogEdge(p).length && !finishedOff.has(p))) continue;
    const stacks = theirs.map((t) => {
      const movable = Math.max(0, armiesOf(t) - guard) + unitsAt(t);
      const reach = movable + deployReaching(p, [t]);
      const next = [...neighborsOf(g, t)].sort(byNum);
      return {
        territory: t,
        movable,
        own: next.filter((n) => theirs.includes(n)),
        neutrals: next.filter((n) => {
          const st = state.get(n);
          return st?.owner.kind === 'neutral' && st.armies !== null && !captured.has(n) && (captureCost(defenceAt(n), s) ?? Infinity) <= reach;
        }),
        mine: next.filter((n) => mineSet.has(n) && (toTake(stayAt(n) + unitsAt(n)) ?? Infinity) <= reach),
      };
    });
    exits.push({ player: p, stacks });
    if (!finishedOff.has(p) || opts.movesFirst) continue;
    for (const x of stacks)
      for (const n of x.neutrals) {
        const by = neighborsOf(g, n).filter((y) => mineSet.has(y) || captured.has(y)).sort(byNum);
        warnings.push(
          `player ${p}'s stack on ${label(x.territory)} can flee onto ${label(n)} before my attack lands and survive there; ${by.length ? `${by.map(label).join(' or ')} borders it: retake it next turn` : 'nothing of mine borders it'}.`,
        );
      }
  }
  const decided = [...moves];
  /** Within a slot, a larger early move first: one grouped early transfer beats several small ones. */
  const rankOf = (m: PlannedMove) => (slotOf(m) === MoveSlot.Early ? m.armies : 0);
  let scheduled = scheduleMoves(decided, slotOf, rankOf);
  if (firstOrder && scheduled[0] !== firstOrder) {
    // A move it depends on (one into its source, say) must run before it, so it is not my first
    // order, and the card protects only that one: my first order is whatever the schedule puts first.
    const head = scheduled[0]!;
    if (firstOrder === killOrder)
      warnings.push(
        `The strike that eliminates player ${kill!.p} cannot be my first order: ${label(head.from)} → ${label(head.to)} must run before it.`,
      );
    if (firstOrder === strikeOrder) {
      const r = rationale.findIndex((l) => l.startsWith("Play Order Priority: my commander's territory"));
      if (r >= 0) rationale.splice(r, 1);
      warnings.push(
        `The strike on ${strikeWho}'s commander cannot be my first order: ${label(head.from)} → ${label(head.to)} must run before it, so Order Priority would not make it land before ${strikeWho}'s attacks on my commander's territory.`,
      );
    }
    firstOrder = outOfConceded.includes(head) ? head : undefined;
    lastWhy.clear();
    scheduled = scheduleMoves(decided, slotOf, rankOf);
  }
  moves.splice(0, moves.length, ...scheduled);
  // Order Priority moves only my first order ahead of the opponent's first: spend the card only
  // for that order — the strike rule 1s advised it for, else a move out of a conceded border that
  // saves enough — when I hold one, and when I do not move first anyway.
  /** Why Order Priority is not advised for the protected first order, if not. */
  let why: string | undefined;
  if (!firstOrder) ps.cardAdvice = null;
  else {
    const n = firstOrder.armies;
    /** #179: a strike that ends a player is protected even moving first when the opponent may hold the card too. */
    const decisive = firstOrder === strikeOrder || firstOrder === killOrder;
    const contested = decisive && opts.movesFirst === true && opts.opponentsMayHoldOrderPriority === true;
    why = opts.movesFirst && !contested
      ? "I move first this turn, so my first order already runs before any of the opponent's"
      : firstOrder === strikeOrder
        ? undefined
        : !opts.holdsOrderPriority
          ? 'I hold no Order Priority card to play'
          : n < ORDER_PRIORITY_MIN_ARMIES && !opts.orderPriorityForced && firstOrder !== killOrder
            ? `it saves only ${n} ${n === 1 ? 'army' : 'armies'}, under the ${ORDER_PRIORITY_MIN_ARMIES} a card is worth`
            : undefined;
    ps.cardAdvice = why === undefined ? 'order-priority' : null;
    const mayHold = (who: string) =>
      `I move first this turn, but ${who} may hold an Order Priority card: two cancel, so mine keeps this order first`;
    if (firstOrder === killOrder && ps.cardAdvice) {
      const units = unitsAt(firstOrder.to);
      const stack = `${armiesOf(firstOrder.to)}${units ? ` armies and special units worth ${units}` : ''}`;
      const what = kill!.commander
        ? `the strike on player ${kill!.p}'s commander, which eliminates it (${stack} there), before the commander can move away`
        : `the strike that eliminates player ${kill!.p}, on its largest stack (${stack}), the one that could flee or strike first`;
      rationale.push(
        `Play Order Priority: ${label(firstOrder.from)} → ${label(firstOrder.to)} is ${what}; ${contested ? mayHold(`player ${kill!.p}`) : `with the card it is my first order and runs before player ${kill!.p}'s first`}.`,
      );
    }
    if (firstOrder === strikeOrder && contested) {
      const r = rationale.findIndex((l) => l.startsWith("Play Order Priority: my commander's territory"));
      if (r >= 0) rationale[r] = `${rationale[r]} ${mayHold(strikeWho)}.`;
    } else if (firstOrder === strikeOrder && opts.movesFirst) {
      // Rule 1s advised the card before it knew I move first: take that line back.
      const r = rationale.findIndex((l) => l.startsWith("Play Order Priority: my commander's territory"));
      if (r >= 0) rationale.splice(r, 1);
      rationale.push("Order Priority is not needed for the strike: I move first this turn, so my first order already runs before any of the opponent's.");
    }
  }
  // Each move out of a conceded border says where it stands: the protected first order, or early
  // but possibly too late (the card protects one order only).
  const top = firstOrder && conceded.has(firstOrder.from) ? label(firstOrder.from) : undefined;
  for (let i = 0; i < warnings.length; i++) {
    if (!CONCEDED_ORDER.test(warnings[i]!)) continue;
    const head = warnings[i]!.replace(CONCEDED_ORDER, '');
    const isTop = top !== undefined && (head.startsWith(`The withdrawal from ${top} only`) || head.startsWith(`The attack out of ${top} only`));
    warnings[i] = !isTop
      ? `${head}; it is listed early, but only my first order can run before the opponent's first, so it may come too late.`
      : why === undefined
        ? `${head}; play Order Priority: it is my first order, and the card runs it before the opponent's first.`
        : `${head}; it is my first order (Order Priority not advised: ${why}).`;
  }
  const lasts = scheduled.filter((m) => lastWhy.has(m)).map((m) => lastWhy.get(m)!);
  if (lasts.length || scheduled.some((m, i) => m !== decided[i])) {
    rationale.push(
      `Move order (#127): ${firstOrder ? `${label(firstOrder.from)} → ${label(firstOrder.to)} first; ` : ''}withdrawals and transfers into borders the enemy can break early, attacks that land even if the owner deploys there first next, uncontested captures and interior transfers as filler${lasts.length ? `, and last ${lasts.join('; ')}` : ''}.`,
    );
  }

  // Where each move put last lands among the opponent's orders (two players only: with more,
  // the interleave runs through every player). An Order Priority played (and not matched) makes me
  // the first mover for the turn, whichever I was.
  const foes = [
    ...new Set([...state.values()].flatMap((st) => (st.owner.kind === 'player' && foe(st.owner.playerId) ? [st.owner.playerId] : []))),
  ];
  const lastMoves = scheduled.filter((m) => lastWhy.has(m));
  if (foes.length === 1 && lastMoves.length) {
    const p = foes[0]!;
    const mover: MoverPosition =
      opts.movesFirst === true || ps.cardAdvice === 'order-priority'
        ? 'first'
        : opts.movesFirst === false
          ? 'second'
          : 'unknown';
    const orders = (ownedBy.get(p) ?? []).filter((t) => Math.max(0, armiesOf(t) - guard) + unitsAt(t) > 0).length;
    const need = indexAfterAll(orders, mover);
    const items = lastMoves.map((m) => {
      const k = scheduled.indexOf(m) + 1;
      const before =
        mover === 'unknown'
          ? `after ${opponentOrdersBefore(k, 'first')} of player ${p}'s orders if I move first, ${opponentOrdersBefore(k, 'second')} if it does`
          : `after ${opponentOrdersBefore(k, mover)} of player ${p}'s orders (${mover === 'first' ? 'I move' : 'it moves'} first)`;
      const short = need - k;
      return `${label(m.to)} is my order ${k}: ${before}; player ${p} has ${orders} ${orders === 1 ? 'territory' : 'territories'} in view with armies to move, so it runs after them all${short > 0 ? ` from order ${need} (${short} more ${short === 1 ? 'order' : 'orders'} above it)` : ''}.`;
    });
    rationale.push(`Move position (#127): ${items.join(' ')}`);
  }

  return { slotOf, facesEnemy, exits };
}
