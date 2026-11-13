// Cards the planner does not play, read against its plan (#163): my Bomb (where halving a stack
// changes a hold, a capture or a commander kill, else hold it), an opponent's Bomb (borders that
// hold only while unbombed), an opponent's Emergency Blockade (attacks that would die against the
// wall) and my own (a conceded border where the wall kills more than I give up). Pure and
// deterministic (ties on ascending territory id); no I/O.
//
// Rules (the wiki's Bomb_Card, Turn_phases, Emergency Blockade; docs/STRATEGY.md): a Bomb hits a
// territory next to one of mine after the deployments and before every move, and kills half its
// armies — a commander is reported unharmed. An Emergency Blockade turns a territory into a
// neutral of its armies (that turn's deploy included) times the multiplier, before the attacks;
// special units count for nothing on it. UNVERIFIED: how war.app rounds the half (each side is
// read in its worst case: a bombed enemy keeps the larger half, a bombed stack of mine the
// smaller) and the wall (rounded to the nearest army here).

import type { BoardState, TerritoryState } from '../board.js';
import { armiesToTake, COMMANDER_STRENGTH, DEFAULT_DEFENSIVE_KILL_RATE, straightKills, type KillRates } from './combat.js';
import { neighborsOf, type MapGraph } from './graph.js';
import { bonusTerritories } from './bonuses.js';

export interface CardBoard {
  graph: MapGraph;
  board: BoardState;
  me: number;
  /** Players on my side (teammates): never a target, never a threat. */
  friends?: ReadonlySet<number>;
  deploys: readonly { territoryId: number; armies: number }[];
  moves: readonly { from: number; to: number; armies: number; kind: 'attack' | 'transfer' }[];
  /** The deploy assumed for each opponent (the plan's `enemyDeploy`). */
  enemyDeploy: number;
  settings?: KillRates & { oneArmyStandsGuard?: boolean };
}

/** Where my Bomb changes the turn, or that it does not. */
export interface BombAdvice {
  /** The territory to bomb; absent: hold the card. */
  target?: number;
  /** What halving it changes. */
  kind?: 'commander' | 'hold' | 'capture';
  why: string;
}

/** A border of mine that holds only while it is not bombed. */
export interface BombExposure {
  territory: number;
  /** My armies there after the plan, and what a bomb would leave (moves out cut first). */
  armies: number;
  bombed: number;
  /** What the opponent can send at it (its stacks next to it plus its deploy). */
  reach: number;
  player: number;
  commander: boolean;
}

/** A planned attack that an Emergency Blockade on its target would stop. */
export interface WallThreat {
  target: number;
  player: number;
  /** My armies sent at it. */
  attackers: number;
  /** The wall: (its armies + the owner's deploy) × the multiplier. */
  wall: number;
}

/** A conceded border where my Emergency Blockade kills more than it gives up. */
export interface WallOffer {
  territory: number;
  /** My armies there (this turn's deploy included): what the card gives up. */
  givesUp: number;
  wall: number;
  /** The stack that can reach it, and what attacking the wall costs it. */
  player: number;
  reach: number;
  kills: number;
}

/** The common reads over the board and the plan. */
function reader(cb: CardBoard) {
  const state = new Map<number, TerritoryState>(cb.board.territories.map((t) => [t.territoryId, t]));
  const guard = cb.settings?.oneArmyStandsGuard === false ? 0 : 1;
  const rates: KillRates = {
    ...(cb.settings?.offensiveKillRate !== undefined ? { offensiveKillRate: cb.settings.offensiveKillRate } : {}),
    ...(cb.settings?.defensiveKillRate !== undefined ? { defensiveKillRate: cb.settings.defensiveKillRate } : {}),
  };
  const ownerOf = (t: number) => {
    const o = state.get(t)?.owner;
    return o?.kind === 'player' ? o.playerId : undefined;
  };
  const isMine = (t: number) => ownerOf(t) === cb.me;
  const foe = (p: number | undefined): p is number => p !== undefined && p !== cb.me && !cb.friends?.has(p);
  const armiesOf = (t: number) => state.get(t)?.armies ?? 0;
  const commanderOf = (t: number, who: (p: number) => boolean) =>
    (state.get(t)?.specialUnits ?? []).some((u) => u.kind === 'commander' && who(u.playerId));
  const deployAt = (t: number) => cb.deploys.filter((d) => d.territoryId === t).reduce((a, d) => a + d.armies, 0);
  const outOf = (t: number) => cb.moves.filter((m) => m.from === t).reduce((a, m) => a + m.armies, 0);
  const transfersInto = (t: number) =>
    cb.moves.filter((m) => m.to === t && m.kind === 'transfer' && isMine(m.from)).reduce((a, m) => a + m.armies, 0);
  const attacksOn = (t: number) => cb.moves.filter((m) => m.to === t && m.kind === 'attack').reduce((a, m) => a + m.armies, 0);
  /** My armies on `t` once the plan's deploys and moves have run (captures not counted). */
  const after = (t: number) => armiesOf(t) + deployAt(t) - outOf(t) + transfersInto(t);
  const toTake = (d: number) => armiesToTake(d, rates) ?? Infinity;
  const ids = [...state.keys()].sort((a, b) => a - b);
  /**
   * Each opponent's stacks next to `t` plus its deploy (the strongest one), with `bombed` halved by
   * a bomb. The bomb lands after the deploys, so the worst case is taken: an owner with another
   * stack next to `t` deploys there, unhalved (d + ⌈a/2⌉ + the other stacks, less the guards); one
   * whose only stack next to `t` is the bombed one deploys on it, and the deploy is halved with it
   * (⌈(a + d)/2⌉ less the guard).
   */
  const reachOf = (t: number, bombed?: number) => {
    const by = new Map<number, { others: number; hasOther: boolean; bombed?: number }>();
    for (const n of neighborsOf(cb.graph, t)) {
      const p = ownerOf(n);
      if (!foe(p) || state.get(n)?.armies === null) continue;
      const e = by.get(p) ?? { others: 0, hasOther: false };
      if (n === bombed) e.bombed = armiesOf(n);
      else {
        e.others += Math.max(0, armiesOf(n) - guard);
        e.hasOther = true;
      }
      by.set(p, e);
    }
    const d = cb.enemyDeploy;
    let best: { player: number; reach: number } | undefined;
    for (const [player, e] of [...by].sort((a, b) => a[0] - b[0])) {
      const reach =
        e.bombed === undefined
          ? d + e.others
          : e.hasOther
            ? d + e.others + Math.max(0, Math.ceil(e.bombed / 2) - guard)
            : Math.max(0, Math.ceil((e.bombed + d) / 2) - guard);
      if (!best || reach > best.reach) best = { player, reach };
    }
    return best;
  };
  return { state, guard, rates, ownerOf, isMine, foe, armiesOf, commanderOf, deployAt, outOf, transfersInto, attacksOn, after, toTake, ids, reachOf };
}

const KIND_RANK = { commander: 0, hold: 1, capture: 2 } as const;

/**
 * Where to play my Bomb this turn: an opponent's territory next to mine where halving its armies
 * plus the owner's deploy (a commander unharmed) makes a commander kill, a hold or a capture that
 * fails without it — in that order, then the bigger stack. Else hold the card: the threat of it
 * keeps the opponent from stacking, and is worth more than a blast that changes nothing.
 */
export function bombAdvice(cb: CardBoard): BombAdvice {
  const r = reader(cb);
  const best: { target: number; kind: BombAdvice['kind'] & string; stake: number; why: string }[] = [];
  for (const t of r.ids) {
    const p = r.ownerOf(t);
    if (!r.foe(p) || r.state.get(t)?.armies === null) continue;
    const borders = neighborsOf(cb.graph, t).filter(r.isMine);
    if (!borders.length) continue;
    const n = r.armiesOf(t) + cb.enemyDeploy;
    const left = Math.ceil(n / 2);
    const cmd = r.commanderOf(t, (q) => q === p) ? COMMANDER_STRENGTH : 0;
    const planned = r.attacksOn(t);
    const free = planned + borders.reduce((a, b) => a + Math.max(0, r.after(b) - r.guard), 0);
    const label = `player ${p}'s ${r.armiesOf(t)} + its deploy of ${cb.enemyDeploy} on ${t}`;
    if (cmd > 0 && r.toTake(left + cmd) <= free && r.toTake(n + cmd) > free) {
      best.push({ target: t, kind: 'commander', stake: n, why: `halving ${label} leaves ${left} with its commander, which my ${free} next to it can kill (not the whole ${n})` });
      continue;
    }
    const held = borders.filter((b) => {
      const reach = r.reachOf(b)?.reach ?? 0;
      const bombed = r.reachOf(b, t)?.reach ?? 0;
      const need = r.toTake(r.after(b) + (r.commanderOf(b, (q) => q === cb.me) ? COMMANDER_STRENGTH : 0));
      return need <= reach && need > bombed;
    });
    if (held.length) {
      best.push({ target: t, kind: 'hold', stake: n, why: `halving ${label} leaves too few to take ${held.join(', ')}, which fall${held.length === 1 ? 's' : ''} to it unbombed` });
      continue;
    }
    if (planned > 0 ? r.toTake(n + cmd) > planned && r.toTake(left + cmd) <= planned : r.toTake(left + cmd) <= free && r.toTake(n + cmd) > free) {
      const sent = planned > 0 ? planned : free;
      best.push({ target: t, kind: 'capture', stake: n, why: `halving ${label} lets my ${sent} take it even if the owner deploys there (it needs ${r.toTake(n + cmd)} unbombed)` });
    }
  }
  best.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.stake - a.stake || a.target - b.target);
  const top = best[0];
  if (!top) {
    return {
      why: 'Hold the Bomb: halving no stack next to me changes a hold, a capture or a commander kill this turn, and while I hold it the opponent cannot safely stack.',
    };
  }
  return { target: top.target, kind: top.kind, why: `Bomb ${top.target}: ${top.why}.` };
}

/**
 * My borders (after the plan) that hold against the opponent's reach unbombed but fall once a
 * bomb halves them: the bomb lands after my deploys and before every move, so it halves what
 * stands there (moves out are cut from what is left; transfers in still arrive). Ascending id.
 */
export function bombExposure(cb: CardBoard): BombExposure[] {
  const r = reader(cb);
  const out: BombExposure[] = [];
  for (const b of r.ids) {
    if (!r.isMine(b)) continue;
    const reach = r.reachOf(b);
    if (!reach) continue;
    const cmd = r.commanderOf(b, (q) => q === cb.me);
    const extra = cmd ? COMMANDER_STRENGTH : 0;
    const armies = r.after(b);
    const kept = Math.floor((r.armiesOf(b) + r.deployAt(b)) / 2);
    const bombed = Math.max(0, kept - r.outOf(b)) + r.transfersInto(b);
    if (r.toTake(armies + extra) > reach.reach && r.toTake(bombed + extra) <= reach.reach) {
      out.push({ territory: b, armies, bombed, reach: reach.reach, player: reach.player, commander: cmd });
    }
  }
  return out;
}

/** The wall an Emergency Blockade makes of `armies` at `multiplier` (rounded: unverified). */
export const wallOf = (armies: number, multiplier: number): number => Math.round(Math.max(0, armies) * multiplier);

/**
 * The planned attacks on an opponent's territory that its Emergency Blockade would stop: the
 * owner turns it into a neutral of (its armies + its deploy) × the multiplier before the attacks,
 * and what I send cannot take that. Ascending target id.
 */
export function wallThreats(cb: CardBoard, multiplier: number): WallThreat[] {
  const r = reader(cb);
  const out: WallThreat[] = [];
  for (const t of r.ids) {
    const p = r.ownerOf(t);
    if (!r.foe(p)) continue;
    const attackers = r.attacksOn(t);
    if (attackers <= 0) continue;
    const wall = wallOf(r.armiesOf(t) + cb.enemyDeploy, multiplier);
    if (r.toTake(wall) > attackers) out.push({ target: t, player: p, attackers, wall });
  }
  return out;
}

/**
 * Where my Emergency Blockade pays: a border the plan concedes, where the wall of my armies there
 * (this turn's deploy included) times the multiplier kills more of the stack that can reach it
 * than the armies I give up — never on my commander's territory (it would be lost with it),
 * never on one the plan moves armies out of (they would be lost with it: the wall comes before the
 * moves) and never on a member of a bonus I hold whole at the start of the turn (I need it). The best by
 * kills over armies given up, then ascending id; `undefined` when none pays.
 */
export function wallOffer(cb: CardBoard, multiplier: number, conceded: readonly number[]): WallOffer | undefined {
  const r = reader(cb);
  const defence = cb.settings?.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  const held = (id: number) =>
    cb.graph.map.bonuses.some((bonus) => {
      if (bonus.value <= 0) return false;
      const members = bonusTerritories(cb.graph, bonus.id);
      return members.includes(id) && members.every(r.isMine);
    });
  let best: WallOffer | undefined;
  for (const c of [...conceded].sort((a, b) => a - b)) {
    // A border the plan withdraws from is skipped: the wall turns it neutral before the moves, so
    // the armies the plan moves out of it would be lost with it.
    if (!r.isMine(c) || r.commanderOf(c, (q) => q === cb.me) || held(c) || r.outOf(c) > 0) continue;
    const reach = r.reachOf(c);
    if (!reach) continue;
    const givesUp = r.armiesOf(c) + r.deployAt(c);
    const wall = wallOf(givesUp, multiplier);
    const kills = Math.min(reach.reach, straightKills(wall, defence));
    if (kills <= givesUp) continue;
    const offer: WallOffer = { territory: c, givesUp, wall, player: reach.player, reach: reach.reach, kills };
    if (!best || kills - givesUp > best.kills - best.givesUp) best = offer;
  }
  return best;
}
