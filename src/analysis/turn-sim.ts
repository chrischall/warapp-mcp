// One turn of war.app, resolved from every player's orders. Pure and deterministic: no I/O,
// no randomness, and the board it is given is never changed.
//
// The rules are the wiki's (docs/STRATEGY.md "Turn resolution" links each page):
//   - Deployments come before every attack and transfer, and deployed armies may move that turn.
//   - Attack and transfer orders run interleaved in a zigzag over the turn's move order
//     (1 2 … n, n … 2 1, 1 2 … n), each player's next order in each slot. An order that moves
//     no armies takes no slot. An Order Priority card makes its player the first mover for the
//     turn (its first order runs before the others' first, and nothing more); two cancel.
//   - An order is an attack or a transfer by who holds the target WHEN IT RUNS: mine or a
//     teammate's is a transfer, anything else an attack. Attack-only does nothing on a friendly
//     target, transfer-only nothing on any other.
//   - A battle is simultaneous: the attackers kill `offensive kill rate` × their number, the
//     defenders `defensive kill rate` × theirs, each rounded to nearest. The territory is taken
//     when every defender dies and an attacker lives, and all survivors move in; otherwise the
//     survivors stay where they started. When both sides are wiped out the attack fails and one
//     defender stands again.
//   - One army stands guard on every territory unless the game turns that off; an army that
//     arrived this turn can be that guard, a commander cannot (the developer's 2022 update note:
//     to attack out of a commander's territory with no armies, deploy two).
//   - Each army moves once a turn: armies that arrived (by a transfer, by a capture, or back from
//     a failed attack) cannot be ordered on. Under Multi-Attack armies may attack any number of
//     times, but one that transferred is done.
//   - A commander fights as 7 armies, takes damage only after the armies with it, and dies only
//     to 7 damage left over in one battle; its owner is then out and all it held turns neutral.
//     It moves only when an order takes it along, and never onto a teammate's territory.
//
// What the wiki does not state is ASSUMED, and named in `assumptions` whenever a turn relies on
// it: an order sends what its territory can still move when that is fewer than ordered; an order
// from a territory captured earlier in the turn does nothing; losses on a defending territory
// fall first on the armies that could still move; and with the guard off, two sides wiped out
// in one battle still leave one defender; a percentage order (#165) takes its share of what can
// still move, guard excluded. Not modelled: the Limited Attacks mod.
//
// With luck or weighted-random rounding a battle is not determined: each one is resolved at its
// luck-free, straight-rounded expectation and `exact` is false.

import type { BoardState } from '../board.js';
import {
  COMMANDER_STRENGTH,
  DEFAULT_DEFENSIVE_KILL_RATE,
  DEFAULT_OFFENSIVE_KILL_RATE,
  luckFraction,
  straightKills,
} from './combat.js';
import type { MapGraph } from './graph.js';
import { neighborsOf } from './graph.js';

export interface SimSettings {
  offensiveKillRate?: number;
  defensiveKillRate?: number;
  /** Fraction (0.16) or percent (16). Anything above 0 makes the result inexact. */
  luckModifier?: number;
  roundingMode?: string;
  /** Default `true`. */
  oneArmyStandsGuard?: boolean;
  multiAttack?: boolean;
}

export type SimOwner = number | 'neutral' | 'unknown';

export interface SimTerritory {
  owner: SimOwner;
  /** Ordinary armies; 0 for a territory whose armies are hidden. */
  armies: number;
  /** The owner of the commander standing here, when one does. */
  commander?: number;
}

export interface SimDeploy {
  player: number;
  territoryId: number;
  armies: number;
}

export interface SimOrder {
  from: number;
  to: number;
  armies: number;
  /** Default: attack or transfer, by who holds the target when the order runs. */
  mode?: 'attack-only' | 'transfer-only';
  /** Take the commander on `from` along (default: it stays). */
  withCommander?: boolean;
  /**
   * `armies` is a percentage (1–100) of what `from` can still move when the order runs (#165;
   * the client rounds it to nearest, a half down, and never sends more than can move).
   */
  byPercent?: boolean;
  /** A teammate's territory is attacked, not transferred into (#165). */
  attackTeammates?: boolean;
}

export interface SimInput {
  graph: MapGraph;
  board: BoardState;
  /** Start from these territories in place of the board: the end of an earlier simulated turn. */
  start?: ReadonlyMap<number, SimTerritory>;
  deploys: readonly SimDeploy[];
  /** Each player's attack and transfer orders, in the order that player listed them. */
  orders: readonly { player: number; orders: readonly SimOrder[] }[];
  /** This turn's move order, first mover first. Players with orders but not named go last, by id. */
  moveOrder: readonly number[];
  settings?: SimSettings;
  /** Player → team, for games with teams: a teammate's territory is a friendly target. */
  teams?: ReadonlyMap<number, number>;
  /** Players who play an Order Priority card: they move first this turn, in their drawn order. */
  orderPriority?: readonly number[];
}

export type SimSkipReason = 'source-lost' | 'no-armies' | 'not-adjacent' | 'attack-only' | 'transfer-only';

export interface SimEvent {
  player: number;
  /** The order's place in that player's list (0-based). */
  index: number;
  from: number;
  to: number;
  ordered: number;
  /** Armies that actually left (0 for a skipped order). */
  sent: number;
  kind: 'attack' | 'transfer' | 'none';
  result: 'captured' | 'failed' | 'transferred' | 'skipped' | 'unknown';
  reason?: SimSkipReason;
  /** Attacks: ordinary armies killed on each side, and the attacking armies left alive. */
  defendersKilled?: number;
  attackersKilled?: number;
  survivors?: number;
  /** Who held the target when the order ran. */
  targetOwner?: SimOwner;
}

export interface SimResult {
  territories: Map<number, SimTerritory>;
  /** Every order in the order it was reached (skipped ones included). */
  log: SimEvent[];
  /** `false` when luck or weighted rounding leaves the battles undetermined (expectations used). */
  exact: boolean;
  /** The unstated rules this turn's outcome rested on. */
  assumptions: string[];
  /** Players whose commander died this turn, in the order they fell. */
  eliminated: number[];
}

const ASSUME_FEWER = 'An order sent what its territory could still move when that was fewer than ordered (the wiki does not say).';
const ASSUME_LOSSES =
  'Losses on a territory that was attacked fell first on the armies that could still move (the wiki does not say which die).';

const ASSUME_SOURCE_LOST = 'An order from a territory that was captured first did nothing (the wiki does not say).';
const ASSUME_WIPE =
  'With the guard off, an attack that wiped out both sides failed and left one defender (the wiki states this rule under the guard setting).';

const ASSUME_PERCENT =
  'A percentage order took its share of the armies its territory could still move, the guard left out (the client rounds the share; what it counts is not stated).';

/** `pct`% of `n`, rounded to nearest with a half rounded down, as the client works out a percentage order. */
export function percentOf(pct: number, n: number): number {
  const x = (pct / 100) * n;
  const whole = Math.floor(x);
  return x - whole > 0.5 ? whole + 1 : whole;
}

interface Cell extends SimTerritory {
  /** Armies here that have used their move this turn. */
  moved: number;
  /** The commander here has used its move. */
  commanderMoved?: boolean;
}

/** The board as the resolver sees it: hidden territories are `unknown` with no armies. */
export function simTerritories(board: BoardState): Map<number, SimTerritory> {
  const out = new Map<number, SimTerritory>();
  for (const t of board.territories) {
    // Hidden armies make a territory unknown whoever is shown to hold it: it is never a stack of none.
    const owner: SimOwner = t.owner.kind === 'unknown' || t.armies === null ? 'unknown' : t.owner.kind === 'player' ? t.owner.playerId : 'neutral';
    const commander = t.specialUnits?.find((u) => u.kind === 'commander');
    out.set(t.territoryId, {
      owner,
      armies: owner === 'unknown' ? 0 : (t.armies ?? 0),
      ...(commander && owner !== 'unknown' ? { commander: commander.playerId } : {}),
    });
  }
  return out;
}

/** The turn's slots: 1 2 … n, n … 2 1, 1 2 … n, for as long as anyone has orders left. */
function* zigzag(players: readonly number[]): Generator<number> {
  for (let round = 0; ; round++) {
    const row = round % 2 === 0 ? players : [...players].reverse();
    for (const p of row) yield p;
  }
}

export function simulateTurn(input: SimInput): SimResult {
  const s = input.settings ?? {};
  const off = s.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  const def = s.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  const guard = s.oneArmyStandsGuard === false ? 0 : 1;
  const exact = luckFraction(s.luckModifier) === 0 && s.roundingMode !== 'WeightedRandom';
  const teams = input.teams;
  const friendly = (owner: SimOwner, player: number): boolean =>
    owner === player ||
    (typeof owner === 'number' && teams !== undefined && teams.get(owner) !== undefined && teams.get(owner) === teams.get(player));

  const cells = new Map<number, Cell>();
  const ownerAtStart = new Map<number, SimOwner>();
  for (const [id, t] of input.start ?? simTerritories(input.board)) {
    cells.set(id, { ...t, moved: 0 });
    ownerAtStart.set(id, t.owner);
  }
  const assumptions = new Set<string>();
  const eliminated: number[] = [];
  const log: SimEvent[] = [];

  for (const d of input.deploys) {
    const c = cells.get(d.territoryId);
    if (c && c.owner === d.player && d.armies > 0) c.armies += d.armies;
  }

  /** A player whose commander died: everything it holds turns neutral, and its orders stop. */
  const eliminate = (player: number): void => {
    if (eliminated.includes(player)) return;
    eliminated.push(player);
    for (const c of cells.values()) {
      if (c.owner === player) {
        c.owner = 'neutral';
        c.moved = 0;
      }
      if (c.commander === player) delete c.commander;
    }
  };

  /** Carry out one order; `true` when armies (or a commander) actually moved. */
  const execute = (player: number, index: number, o: SimOrder): boolean => {
    const base = { player, index, from: o.from, to: o.to, ordered: o.armies };
    const skip = (reason: SimSkipReason): boolean => {
      log.push({ ...base, sent: 0, kind: 'none', result: 'skipped', reason });
      return false;
    };
    const src = cells.get(o.from);
    const dst = cells.get(o.to);
    if (!src || src.owner !== player) {
      if (src && ownerAtStart.get(o.from) === player) assumptions.add(ASSUME_SOURCE_LOST);
      return skip('source-lost');
    }
    if (!dst || !neighborsOf(input.graph, o.from).includes(o.to)) return skip('not-adjacent');
    const isTransfer = o.attackTeammates ? dst.owner === player : friendly(dst.owner, player);
    if (isTransfer && o.mode === 'attack-only') return skip('attack-only');
    if (!isTransfer && o.mode === 'transfer-only') return skip('transfer-only');
    // A commander goes along only when asked, has not moved, and is not headed for a teammate's land.
    const takesCommander =
      o.withCommander === true && src.commander === player && !src.commanderMoved && !(isTransfer && dst.owner !== player);
    // The armies that have not moved, less the guard — which an army that arrived can be.
    const unmoved = Math.max(0, src.armies - src.moved);
    const movable = Math.max(0, Math.min(unmoved, src.armies - guard));
    const asked = Number.isFinite(o.armies) ? Math.max(0, Math.floor(o.armies)) : 0;
    const want = o.byPercent ? percentOf(Math.min(asked, 100), movable) : asked;
    if (o.byPercent) assumptions.add(ASSUME_PERCENT);
    const sent = Math.min(want, movable);
    if (sent < want && sent > 0) assumptions.add(ASSUME_FEWER);
    if (sent <= 0 && !takesCommander) return skip('no-armies');

    if (dst.owner === 'unknown') {
      // Its defenders are hidden: the armies leave, and what becomes of them is not known.
      src.armies -= sent;
      if (takesCommander) delete src.commander;
      log.push({ ...base, sent, kind: 'attack', result: 'unknown', targetOwner: 'unknown' });
      return true;
    }

    if (isTransfer) {
      src.armies -= sent;
      dst.armies += sent;
      dst.moved += sent;
      if (takesCommander) {
        delete src.commander;
        dst.commander = player;
        dst.commanderMoved = true;
      }
      log.push({ ...base, sent, kind: 'transfer', result: 'transferred', targetOwner: dst.owner });
      return true;
    }

    const targetOwner = dst.owner;
    const defCommander = dst.commander;
    const attackPower = sent + (takesCommander ? COMMANDER_STRENGTH : 0);
    const defencePower = dst.armies + (defCommander !== undefined ? COMMANDER_STRENGTH : 0);
    const damageToDefence = straightKills(attackPower, off);
    const damageToAttack = straightKills(defencePower, def);

    const defendersKilled = Math.min(dst.armies, damageToDefence);
    const defCommanderDies = defCommander !== undefined && damageToDefence - dst.armies >= COMMANDER_STRENGTH;
    const defenceGone = defendersKilled === dst.armies && (defCommander === undefined || defCommanderDies);

    const attackersKilled = Math.min(sent, damageToAttack);
    const attCommanderDies = takesCommander && damageToAttack - sent >= COMMANDER_STRENGTH;
    const survivors = sent - attackersKilled;
    const attackLives = survivors > 0 || (takesCommander && !attCommanderDies);

    const event: SimEvent = { ...base, sent, kind: 'attack', result: 'failed', defendersKilled, attackersKilled, survivors, targetOwner };
    src.armies -= sent;
    if (takesCommander) delete src.commander;

    if (defenceGone && attackLives) {
      event.result = 'captured';
      dst.owner = player;
      dst.armies = survivors;
      dst.moved = s.multiAttack ? 0 : survivors;
      delete dst.commander;
      delete dst.commanderMoved;
      if (takesCommander && !attCommanderDies) {
        dst.commander = player;
        dst.commanderMoved = !s.multiAttack;
      }
    } else {
      // The attack failed: the survivors are back where they started, their move used
      // (under Multi-Attack they may attack again).
      src.armies += survivors;
      src.moved += s.multiAttack ? 0 : survivors;
      if (takesCommander && !attCommanderDies) {
        src.commander = player;
        src.commanderMoved = !s.multiAttack;
      }
      if (defenceGone) {
        // Both sides wiped out: one defender stands again and the territory is kept.
        if (guard === 0) assumptions.add(ASSUME_WIPE);
        dst.armies = 1;
        dst.moved = Math.min(dst.moved, 1);
      } else {
        if (dst.moved > 0 && defendersKilled > 0) assumptions.add(ASSUME_LOSSES);
        dst.armies -= defendersKilled;
        dst.moved = Math.min(dst.moved, dst.armies);
      }
    }
    log.push(event);
    if (defCommanderDies && defCommander !== undefined) eliminate(defCommander);
    if (attCommanderDies) eliminate(player);
    return true;
  };

  const queues = new Map<number, { orders: readonly SimOrder[]; next: number }>();
  for (const p of input.orders) if (p.orders.length) queues.set(p.player, { orders: p.orders, next: 0 });
  const unnamed = [...queues.keys()].filter((p) => !input.moveOrder.includes(p)).sort((a, b) => a - b);
  const drawn = [...input.moveOrder.filter((p) => queues.has(p)), ...unnamed];
  // Order Priority: its players move first this turn, in their drawn order (all playing one cancels).
  const priority = new Set(input.orderPriority ?? []);
  const players = [...drawn.filter((p) => priority.has(p)), ...drawn.filter((p) => !priority.has(p))];

  /** Run that player's next order that moves armies (orders that move none take no slot). */
  const takeSlot = (player: number): void => {
    const q = queues.get(player);
    if (!q || eliminated.includes(player)) return;
    while (q.next < q.orders.length) {
      const index = q.next++;
      if (execute(player, index, q.orders[index]!)) return;
      if (eliminated.includes(player)) return;
    }
  };
  const pending = (): boolean => players.some((p) => !eliminated.includes(p) && queues.get(p)!.next < queues.get(p)!.orders.length);

  if (players.length) {
    for (const p of zigzag(players)) {
      if (!pending()) break;
      takeSlot(p);
    }
  }

  const territories = new Map<number, SimTerritory>();
  for (const [id, c] of cells) {
    territories.set(id, { owner: c.owner, armies: c.armies, ...(c.commander !== undefined ? { commander: c.commander } : {}) });
  }
  return { territories, log, exact, assumptions: [...assumptions], eliminated };
}
