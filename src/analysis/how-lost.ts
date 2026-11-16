// How a lost game was lost (#274 item 5), read from the boards this server cached while it played.
// Pure and deterministic; no I/O.
//
// The board cached for turn T is the board turn T was planned on, before it resolved, and a player
// eliminated on turn T has no board after it. So the newest cached board on which I hold anything is
// the turn I was most likely eliminated on: certain only when the game ended on that turn
// (`turnsCompleted === T`), since otherwise this server may simply have stopped planning. The cause
// is read from that board:
// - `commander`: my commander stands on it. Losing the commander eliminates a player, and losing every
//   territory at once on a board where I held more is far less likely, so the commander's territory is
//   taken to be what fell (an inference, never seen). Given my cached orders for the turn, what stood
//   there is a range: `low` = armies + my deploys − my moves out (the attack after they left, before my
//   moves in landed), `high` = armies + my deploys + my moves in (after they landed, before any left); the attack that took it needed at least
//   `armiesToTake(low + COMMANDER_STRENGTH)` at the game's kill rates (exact only at 0% luck under
//   straight rounding; with luck an expectation). `held.uncertain` marks a range my orders cannot pin:
//   an order `moves` leaves out (a percentage, Attack Only or Transfer Only one, kept only in `sent`) or
//   an Airlift or other card play touches the territory.
//   When that turn's orders walk the commander (a move flagged `commander`), it is read at the walk's
//   destination, `territoryCertain: false` (it may have fallen on its start before the walk ran): the
//   range there is from after the walk landed (its armies in `low`), and the neighbours are both
//   territories'. A walk known only from `sent` (a percentage order) has no army count and no range.
// - `last-territories`: no commander of mine on the board (and the game was not known to have
//   commanders): the territories I still held, which all fell.
// - `unknown`: the game had commanders but the board shows none of mine (a board cached before
//   special units were decoded).
// Who: the players on the territories next to what fell (by the map's adjacency; a fogged neighbour
// is `playerId: null`). `by` names a taker only when exactly one player borders it and no neighbour
// is fogged. Ids only: names are the tool's business.

import type { BoardState } from '../board.js';
import { armiesToTake, COMMANDER_STRENGTH, luckFraction, type CombatSettings } from './combat.js';
import type { MyOrders } from './opponents.js';

export type LossCause = 'commander' | 'last-territories' | 'unknown';

export interface LossNeighbour {
  /** The player on those territories; `null` for territories whose owner the fog hides. */
  playerId: number | null;
  territories: number;
  /** Their armies in view; `null` when none is in view. */
  armies: number | null;
}

export interface CommanderLoss {
  /** Where the commander was read to fall: its walk's destination when that turn's orders walked it. */
  territoryId: number;
  /** `false` when the orders walked the commander: it may instead have fallen on `walk.from` before the walk ran. */
  territoryCertain: boolean;
  /** That turn's commander walk; `armies` is `null` when only the orders sent record it (a percentage order). */
  walk?: { from: number; to: number; armies: number | null };
  /** The armies on it at the start of the turn (the commander not counted). */
  armies: number;
  /** My deploys there, moves out of it and moves into it that turn; `null` when my orders are not cached. */
  deployed: number | null;
  movedOut: number | null;
  movedIn: number | null;
  /**
   * What stood there when attacked: `low` after my moves out and before my moves in (a walk's armies in
   * at its destination), `high` the reverse. `uncertain` when an order the count leaves out touched it.
   */
  held: { low: number; high: number; uncertain: boolean } | null;
  /** The fewest attackers that take `held.low` armies and the commander; `null` without the orders. */
  attackersNeeded: number | null;
  /** `false` with luck or weighted rounding: the size is then the expectation's. */
  exact: boolean;
}

export interface HowLost {
  /** The newest turn cached with a territory of mine: the turn the loss was most likely on. */
  turn: number;
  /** `true` when the game ended on that very turn, so the loss was on it. */
  turnCertain: boolean;
  cause: LossCause;
  /** The territories I held on that board. */
  territoriesHeld: number;
  commander?: CommanderLoss;
  /** With `last-territories`: what I still held (at most {@link MAX_LAST_TERRITORIES}). */
  lastTerritories?: { territoryId: number; armies: number | null }[];
  /** The players next to what fell, by player id (fogged last); `null` without the map. */
  neighbours: LossNeighbour[] | null;
  /** The only player bordering it, with no fogged neighbour; else `null`. */
  by: number | null;
}

export const MAX_LAST_TERRITORIES = 5;

export interface HowLostInput {
  me: number;
  /** The cached boards, any order. */
  boards: readonly { turn: number; board: BoardState }[];
  /** My cached orders by turn. */
  orders: ReadonlyMap<number, MyOrders>;
  /** The map's adjacency (territory → neighbours); without it no neighbours are read. */
  adjacency?: ReadonlyMap<number, readonly number[]>;
  rates: CombatSettings;
  /** The game's completed turns (GameFeed `numberOfTurns`). */
  turnsCompleted?: number;
  /** The game's Commanders setting, when known. */
  commanders?: boolean;
}

const ownerId = (t: BoardState['territories'][number]): number | null | undefined =>
  t.owner.kind === 'player' ? t.owner.playerId : t.owner.kind === 'unknown' ? null : undefined;

function neighboursOf(board: BoardState, me: number, fallen: readonly number[], adjacency: ReadonlyMap<number, readonly number[]>): LossNeighbour[] {
  const byId = new Map(board.territories.map((t) => [t.territoryId, t]));
  const fallenSet = new Set(fallen);
  const seen = new Set<number>();
  const groups = new Map<number | null, { territories: number; armies: number | null }>();
  for (const f of fallen)
    for (const n of adjacency.get(f) ?? []) {
      if (fallenSet.has(n) || seen.has(n)) continue;
      seen.add(n);
      const t = byId.get(n);
      // Not on the board, mine, neutral or pickable: no attacker there.
      if (!t) continue;
      const owner = ownerId(t);
      if (owner === undefined || owner === me) continue;
      const g = groups.get(owner) ?? { territories: 0, armies: null };
      g.territories++;
      if (owner !== null && t.armies !== null) g.armies = (g.armies ?? 0) + t.armies;
      groups.set(owner, g);
    }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([playerId, g]) => ({ playerId, ...g }));
}

/** How the game was lost, from the newest cached board on which I hold a territory; `undefined` without one. */
export function howLost(input: HowLostInput): HowLost | undefined {
  const { me } = input;
  const mineOn = (b: BoardState) => b.territories.filter((t) => t.owner.kind === 'player' && t.owner.playerId === me);
  const last = [...input.boards].sort((a, b) => b.turn - a.turn).find((b) => mineOn(b.board).length > 0);
  if (!last) return undefined;
  const { turn, board } = last;
  const mine = mineOn(board);
  const cmd = mine.find((t) => t.specialUnits?.some((u) => u.kind === 'commander' && u.playerId === me));
  const cause: LossCause = cmd ? 'commander' : input.commanders ? 'unknown' : 'last-territories';
  const out: HowLost = {
    turn,
    turnCertain: input.turnsCompleted === turn,
    cause,
    territoriesHeld: mine.length,
    neighbours: null,
    by: null,
  };
  let fallen: number[] = [];
  if (cmd) {
    const orders = input.orders.get(turn);
    const start = cmd.territoryId;
    const walkMove = orders?.moves.find((m) => m.commander && m.from === start);
    const walkSent = orders?.sent?.find((m) => m.commander && m.from === start);
    const walk = walkMove
      ? { from: start, to: walkMove.to, armies: walkMove.armies }
      : walkSent
        ? { from: start, to: walkSent.to, armies: null }
        : undefined;
    const id = walk ? walk.to : start;
    const at = walk ? board.territories.find((t) => t.territoryId === id) : cmd;
    const armies = at && ownerId(at) === me ? (at.armies ?? 0) : 0;
    const sum = (xs: readonly { armies: number }[]) => xs.reduce((s, x) => s + x.armies, 0);
    const deployed = orders ? sum(orders.deploys.filter((d) => d.territoryId === id)) : null;
    const movedOut = orders ? sum(orders.moves.filter((m) => m.from === id)) : null;
    const movedIn = orders ? sum(orders.moves.filter((m) => m.to === id)) : null;
    // An order `moves` leaves out (kept only in `sent`), or a card play, touching it: the count is a bound.
    const touches = (m: { from?: number; to?: number; target?: number }) => m.from === id || m.to === id || m.target === id;
    const uncertain =
      !!orders && ((orders.sent?.filter(touches).length ?? 0) > orders.moves.filter(touches).length || (orders.cards ?? []).some(touches));
    // At a walk's destination the commander stands only once the walk has landed: its armies are in `low`.
    const walkIn = walk ? walk.armies : 0;
    const held =
      deployed !== null && movedOut !== null && movedIn !== null && walkIn !== null && (!walk || (at && ownerId(at) === me))
        ? { low: Math.max(0, armies + deployed - movedOut + walkIn), high: armies + deployed + movedIn, uncertain }
        : null;
    out.commander = {
      territoryId: id,
      territoryCertain: !walk,
      ...(walk ? { walk } : {}),
      armies,
      deployed,
      movedOut,
      movedIn,
      held,
      attackersNeeded: held ? armiesToTake(held.low + COMMANDER_STRENGTH, input.rates) : null,
      exact: luckFraction(input.rates.luck) === 0 && input.rates.rounding !== 'WeightedRandom',
    };
    fallen = walk ? [start, id] : [id];
  } else if (cause === 'last-territories') {
    const sorted = [...mine].sort((a, b) => a.territoryId - b.territoryId);
    out.lastTerritories = sorted.slice(0, MAX_LAST_TERRITORIES).map((t) => ({ territoryId: t.territoryId, armies: t.armies }));
    fallen = sorted.map((t) => t.territoryId);
  }
  if (input.adjacency && fallen.length) {
    out.neighbours = neighboursOf(board, me, fallen, input.adjacency);
    const players = out.neighbours.filter((n) => n.playerId !== null);
    out.by = players.length === 1 && players.length === out.neighbours.length ? players[0]!.playerId : null;
  }
  return out;
}
