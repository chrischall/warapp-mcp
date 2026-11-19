// Cards the planner does not play, read against its plan (#163): my Bomb (where halving a stack
// changes a hold, a capture or a commander kill, else hold it), an opponent's Bomb (borders that
// hold only while unbombed), an opponent's Emergency Blockade (attacks that would die against the
// wall) and my own (a conceded border where the wall pays: what it kills plus the bonuses and
// commander behind it the stack could reach only through it, against what I give up; #369). Pure and
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
  /** Territories a truce covers (active or in notice): bombing one breaks the truce, so never a Bomb target (D3). */
  noBomb?: ReadonlySet<number>;
  deploys: readonly { territoryId: number; armies: number }[];
  moves: readonly { from: number; to: number; armies: number; kind: 'attack' | 'transfer' }[];
  /** The deploy assumed for each opponent (the plan's `enemyDeploy`). */
  enemyDeploy: number;
  settings?: KillRates & { oneArmyStandsGuard?: boolean };
}

/** Where my Bomb changes the turn, or that it does not. */
interface BombAdvice {
  /** The territory to bomb; absent: hold the card. */
  target?: number;
  /** What halving it changes. */
  kind?: 'commander' | 'hold' | 'capture';
  why: string;
}

/** A border of mine that holds only while it is not bombed. */
interface BombExposure {
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
interface WallThreat {
  target: number;
  player: number;
  /** My armies sent at it. */
  attackers: number;
  /** The wall: (its armies + the owner's deploy) × the multiplier. */
  wall: number;
}

/** A conceded border where my Emergency Blockade kills more than it gives up. */
interface WallOffer {
  territory: number;
  /** My armies there (this turn's deploy included): what the card gives up. */
  givesUp: number;
  wall: number;
  /** The stack that can reach it, and what attacking the wall costs it. */
  player: number;
  reach: number;
  kills: number;
  /**
   * #369: what the wall keeps that stack from next turn — my territories next to the wall it could
   * reach only through it (empty when it can take the wall), the bonuses I hold that they are in
   * (with `income`, their total a turn) and whether my commander is among them.
   */
  protects: WallProtects;
}

/** What an Emergency Blockade's wall shields behind it (#369). */
interface WallProtects {
  territories: number[];
  bonuses: { bonus: number; value: number }[];
  income: number;
  commander: boolean;
}

/** The common reads over the board and the plan (shared with card-support.ts). */
export function reader(cb: CardBoard) {
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
  /** Each opponent's reach at `t` alone (its movable stacks next to `t` plus its deploy), by player. */
  const reachByPlayer = (t: number) => {
    const by = new Map<number, number>();
    for (const n of neighborsOf(cb.graph, t)) {
      const p = ownerOf(n);
      if (!foe(p) || state.get(n)?.armies === null) continue;
      by.set(p, (by.get(p) ?? cb.enemyDeploy) + Math.max(0, armiesOf(n) - guard));
    }
    return by;
  };
  /** The fewest armies on `t` (its commander there counted apart) that `reach` cannot take. */
  const holdNeed = (reach: number, commander: boolean) => {
    const extra = commander ? COMMANDER_STRENGTH : 0;
    let h = 0;
    while (toTake(h + extra) <= reach) h++;
    return h;
  };
  return { state, guard, rates, ownerOf, isMine, foe, armiesOf, commanderOf, deployAt, outOf, transfersInto, attacksOn, after, toTake, ids, reachOf, reachByPlayer, holdNeed };
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
    if (cb.noBomb?.has(t)) continue;
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
const wallOf = (armies: number, multiplier: number): number => Math.round(Math.max(0, armies) * multiplier);

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
 * Where my Emergency Blockade pays (#163, #369): a border the plan concedes (it cannot hold it),
 * walled with my armies there (this turn's deploy included) times the multiplier. Priced by the board:
 * it gives up the territory and its armies, against what the wall kills of the stack that can reach
 * it (if it attacks) plus what it protects — the income of the bonuses I hold behind it that the stack
 * could reach next turn only through it (one turn of it), and my commander behind it, which always pays.
 * Never when the opponent can go around: something of mine lies behind the wall but the stack reaches
 * all of it as fast another way, so it need never attack the wall. Never on my commander's territory (it
 * would be lost with it), never on one the plan moves armies out of (they would be lost with it: the
 * wall comes before the moves) and never on a member of a bonus I hold whole at the start of the turn
 * (the wall breaks it). The best shields my commander, then by kills plus income over armies given up,
 * then ascending id; `undefined` when none pays.
 */
export function wallOffer(cb: CardBoard, multiplier: number, conceded: readonly number[]): WallOffer | undefined {
  const r = reader(cb);
  const defence = cb.settings?.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  const heldBonuses = (id: number) =>
    cb.graph.map.bonuses.filter((bonus) => {
      if (bonus.value <= 0) return false;
      const members = bonusTerritories(cb.graph, bonus.id);
      return members.includes(id) && members.every(r.isMine);
    });
  const worth = (o: WallOffer) => o.kills + o.protects.income - o.givesUp;
  let best: WallOffer | undefined;
  for (const c of [...conceded].sort((a, b) => a - b)) {
    // A border the plan withdraws from is skipped: the wall turns it neutral before the moves, so
    // the armies the plan moves out of it would be lost with it.
    if (!r.isMine(c) || r.commanderOf(c, (q) => q === cb.me) || heldBonuses(c).length || r.outOf(c) > 0) continue;
    const reach = r.reachOf(c);
    if (!reach) continue;
    const givesUp = r.armiesOf(c) + r.deployAt(c);
    const wall = wallOf(givesUp, multiplier);
    const kills = Math.min(reach.reach, straightKills(wall, defence));
    const shield = wallShield(cb, r, c, reach.player);
    if (shield.goesAround) continue;
    // A wall the stack can take blocks nothing: it walks through and on.
    const blocks = r.toTake(wall) > reach.reach;
    const protects = blocks ? shield.protects : { territories: [], bonuses: [], income: 0, commander: false };
    const offer: WallOffer = { territory: c, givesUp, wall, player: reach.player, reach: reach.reach, kills, protects };
    if (!protects.commander && worth(offer) <= 0) continue;
    if (
      !best ||
      (protects.commander && !best.protects.commander) ||
      (protects.commander === best.protects.commander && worth(offer) > worth(best))
    )
      best = offer;
  }
  return best;
}

/**
 * Behind the wall on `c` (#369): my territories next to `c` that `player`'s stacks beside `c` can reach
 * next turn only through it. One is reachable another way when the player already borders it, or a
 * territory other than `c` borders both it and one of those stacks (two steps either way).
 * `goesAround`: something of mine lies next to `c`, and every piece of it is reachable another way.
 */
function wallShield(cb: CardBoard, r: ReturnType<typeof reader>, c: number, player: number): { protects: WallProtects; goesAround: boolean } {
  const stacks = neighborsOf(cb.graph, c).filter((n) => r.ownerOf(n) === player);
  const behind = neighborsOf(cb.graph, c)
    .filter((n) => n !== c && r.isMine(n))
    .sort((a, b) => a - b);
  const around = (y: number) =>
    neighborsOf(cb.graph, y).some(
      (x) => r.ownerOf(x) === player || (x !== c && stacks.some((s) => neighborsOf(cb.graph, s).includes(x))),
    );
  const territories = behind.filter((y) => !around(y));
  const bonuses = new Map<number, number>();
  for (const bonus of cb.graph.map.bonuses) {
    if (bonus.value <= 0) continue;
    const members = bonusTerritories(cb.graph, bonus.id);
    if (members.every(r.isMine) && territories.some((y) => members.includes(y))) bonuses.set(bonus.id, bonus.value);
  }
  const list = [...bonuses].sort((a, b) => a[0] - b[0]).map(([bonus, value]) => ({ bonus, value }));
  return {
    protects: {
      territories,
      bonuses: list,
      income: list.reduce((a, b) => a + b.value, 0),
      commander: territories.some((y) => r.commanderOf(y, (q) => q === cb.me)),
    },
    goesAround: behind.length > 0 && territories.length === 0,
  };
}
