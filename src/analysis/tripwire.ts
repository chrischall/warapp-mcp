// The broken-estimate tripwire (#275 b). Pure and deterministic.
//
// An opponent's deploy estimate is a floor: what the board proves it earns. Five of eighteen lost
// games were lost to holds sized for one (an estimate of 15 met 70–120; 41 met about 170). One
// observation that the estimate cannot explain is enough to stop trusting it: when what an opponent
// did needed TRIP_RATIO (1.5) × or more of what its estimate allowed, and at least TRIP_MIN_EXCESS
// armies more, its estimate is marked untrusted for UNTRUSTED_TURNS turns (`activeTripwires`; the
// tools keep the marks in the board cache, src/trend.ts, by player id only).
//
// The observations, each read off two consecutive boards of mine (the previous turn's and this one's):
//   fog-stack    a stack of its comes out of the fog (visible now, not on the previous board) larger
//                than the armies last seen there (when it held it then) plus its estimate for every
//                turn since that board. When no board here shows it, since turn 1 and with its whole
//                start credited (`start`: territories × armies each — every start may have walked in
//                there); with its start unknown such a stack is not read. When a board showed it and the
//                start is known, never below its whole stock (every start plus its estimate for every turn
//                so far) less its armies in view elsewhere now: armies banked under the fog since early on
//                walk in unseen, and no sighting credits them. With the start unknown there is no stock
//                to bound them: a stack with a territory within reach (as below) hidden on every board
//                since its sighting is not read at all. A stack walking in is not
//                income (#123 lesson 5): its armies that left view or shrank are credited too: for each other
//                territory, from its latest sighting since the stack's own and when within reach (graph
//                distance at most the turns since that sighting), its movable armies then less its
//                movable armies there now (all of them when hidden now or another's). Under Multi-Attack,
//                or when the settings do not say, a chain covers many hops in one turn: every such
//                territory is within reach, whatever its distance;
//   capture      it took a territory of mine or a visible neutral that needed more attackers
//                (`armiesToTake` of the defenders) than its stacks beside it could move (a commander of
//                its counted as COMMANDER_STRENGTH, 7) plus its estimate. Never when a territory beside it was hidden on the previous board (a
//                stack of its could have stood there), when a third player stood beside it, under
//                Multi-Attack or when the settings do not say (a chain lands from further), or when my
//                orders that turn are unknown
//                and could have moved armies out of mine (or attacked the neutral) first. My orders are
//                known only with `sent` (an older cache is unknown): a Transfer Only, Attack Only or
//                percentage order, which `sent` lists and `moves` leaves out, sends an unknown count, so
//                none may leave the territory of mine nor go into the neutral;
//   held-attack  an attack of mine (my cached orders) failed on a territory of its that held: the
//                defenders it took to hold (one more than my attackers kill) beyond the armies there
//                (its commander there counted as 7, as on its stacks beside it),
//                its estimate and its stacks beside it that could move in. With no luck and straight
//                rounding only, not under Multi-Attack or when the settings do not say (a chain brings
//                armies from beyond its stacks beside it), and not when a territory beside it was hidden.
//                An order sends what is
//                left, so not from a source another stack could have hit first (a territory beside the
//                source, the target aside, hidden or holding a movable stack not mine on the previous
//                board), nor from one that ended with fewer armies than my orders left it; and only what
//                the source had left after its earlier orders in list order, so not from a source an
//                order outside `moves` (Transfer Only, Attack Only, percentage) left too, nor with my
//                orders cached before `sent` existed. A Transfer Only order
//                (flagged in `sent`) attacks nothing, and a player a Diplomacy card may have kept at
//                peace with me (`peace`) is not read. The target's own stack attacking my source cannot
//                fake a trip: what it sends leaves the defence.
// A board from GameFeed's GetHistory (`source: 'history'`, unverified and parsed loosely, as the
// opponent-profile observer treats it) may show less than war.app did: nothing is read when the previous
// board is one, a fog-stack's last sighting never comes from one, and with one since that sighting only
// the stock bound reads the stack (none without the start).
// Cards: nothing is read when an opponent may hold an Airlift (`airlift`, the caller's card clock): one
// lands armies on any territory it holds, into a target, a fogged stack or one beside a capture, and
// reads as income. No capture and no held attack is read when an opponent may hold a Bomb (`bomb`): one
// runs before the attacks (phase 30) and halves my attack's source (beside the target by definition: the
// source still ends at the guard plus survivors, so the check on it misses it) or a territory of mine it
// then takes (half the defenders counted). A Bomb only kills, so a stack out of the fog is still read.
// Players: a player out of the game whose seat no AI plays (`staticSeats`, #270) is never read, nor one
// the caller has no estimate for (`estimateAt` undefined: never compared against 0). Another player's
// armies are never credited to it: a held attack is not read with any player but it beside the target
// (its teammate may have sent armies in; a third may have moved), and a fog stack is not read for a player
// with a teammate (`teams`), whose armies may have walked in. A Reinforcement card is income: the estimate compared carries it from the turn the
// card clock says one can be in hand (#164).
// `implied` is the deploy per turn the observation needs: what the estimate should have been.
// The estimate compared is the one the plan used that turn (`estimateAt`), the caller's to supply.

import type { BoardState, TerritoryState } from '../board.js';
import { armiesToTake, COMMANDER_STRENGTH, luckFraction, straightKills } from './combat.js';
import type { MapGraph } from './graph.js';
import { bfsDistances, neighborsOf } from './graph.js';
import type { MyOrders } from './opponents.js';
import { visibleState } from './plan/shared.js';
import type { SimSettings } from './turn-sim.js';

/** An observation trips when it needs at least this many times what the estimate allows. */
export const TRIP_RATIO = 1.5;
/** …and at least this many armies more (small numbers are noise). */
export const TRIP_MIN_EXCESS = 5;
/** Turns an opponent's estimate stays untrusted, the turn of the observation included. */
export const UNTRUSTED_TURNS = 3;

export type TripKind = 'fog-stack' | 'capture' | 'held-attack';

export interface TripObservation {
  player: number;
  /** The turn whose board shows it. */
  turn: number;
  kind: TripKind;
  territory: number;
  /** Armies the observation needed. */
  observed: number;
  /** What the estimate allowed. */
  allowed: number;
  /** The deploy per turn it implies. */
  implied: number;
}

/** An opponent whose estimate is untrusted from turn `since` to turn `until`, and the observation that tripped it. */
export interface Tripwire {
  player: number;
  since: number;
  until: number;
  kind: TripKind;
  territory: number;
  observed: number;
  allowed: number;
  implied: number;
}

export interface TripBoard {
  turn: number;
  board: BoardState;
  /** My orders on that turn, when this server sent them. */
  orders?: MyOrders;
  /** Read from GameFeed's GetHistory (unverified, parsed loosely): never a sighting, never the previous board. */
  source?: 'history';
}

export interface TripInput {
  graph: MapGraph;
  /** My boards, oldest first; the last is the turn being played. */
  boards: readonly TripBoard[];
  me: number;
  settings?: SimSettings;
  teams?: ReadonlyMap<number, number>;
  /** Every player's start (the settings' TerritoryLimit × InitialPlayerArmiesPerTerritory), when known and even: never in a custom scenario. */
  start?: { territories: number; armiesPerTerritory: number };
  /** An opponent may hold an Airlift card by now: nothing is read (armies it lands look like income). */
  airlift?: boolean;
  /** An opponent may hold a Bomb card by now: no capture or held attack is read (a Bomb halves the source or the defenders first). */
  bomb?: boolean;
  /** #270: players out of the game whose seat no AI plays: never read. */
  staticSeats?: ReadonlySet<number> | ReadonlyMap<number, unknown>;
  /** Players a Diplomacy card in force may have kept from my attacks: no held attack is read on them. */
  peace?: ReadonlySet<number>;
  /** The deploy estimate the plan used for `player` on turn `turn`; undefined when it has none (the player is not read). */
  estimateAt: (player: number, turn: number) => number | undefined;
}

const byNum = (a: number, b: number) => a - b;

export function brokenEstimates(input: TripInput): TripObservation[] {
  const { graph, me, boards } = input;
  const now = boards.at(-1);
  const prev = boards.at(-2);
  if (!now || !prev || prev.turn !== now.turn - 1 || input.airlift) return [];
  // A history board may show less than war.app did: stacks would look out of the fog.
  if (now.source === 'history' || prev.source === 'history') return [];
  const T = now.turn;
  const s = input.settings ?? {};
  // Multi-Attack on, or the settings do not say: a chain moves armies many hops in one turn.
  const chains = s.multiAttack !== false;
  const rates = { offensiveKillRate: s.offensiveKillRate, defensiveKillRate: s.defensiveKillRate };
  const guard = s.oneArmyStandsGuard === false ? 0 : 1;
  const exact = luckFraction(s.luckModifier) === 0 && (s.roundingMode === undefined || s.roundingMode === 'StraightRound');
  const teams = input.teams;
  const friend = (p: number) => p === me || (teams !== undefined && teams.get(p) !== undefined && teams.get(p) === teams.get(me));
  const index = (b: BoardState) => new Map(b.territories.map((t) => [t.territoryId, t]));
  const cur = index(now.board);
  const before = index(prev.board);
  const playerOf = (t: TerritoryState | undefined): number | undefined => (t?.owner.kind === 'player' ? t.owner.playerId : undefined);
  const est = (p: number, turn: number) => Math.max(0, input.estimateAt(p, turn) ?? 0);
  /** `p` has a teammate in the game: another player's armies may stand for its own. */
  const hasMate = (p: number) => {
    const team = teams?.get(p);
    return team !== undefined && team >= 0 && [...teams!].some(([q, t]) => q !== p && t === team);
  };
  const out: TripObservation[] = [];
  const trip = (o: Omit<TripObservation, 'turn'>) => {
    if (o.observed >= TRIP_RATIO * o.allowed && o.observed - o.allowed >= TRIP_MIN_EXCESS) out.push({ ...o, turn: T });
  };
  /** Every neighbour of `id` was in view on the previous board. */
  const clearAround = (id: number) => neighborsOf(graph, id).every((n) => visibleState(before.get(n)) !== undefined);
  /** `p`'s commanders on `t`, each fighting as {@link COMMANDER_STRENGTH}. */
  const commanders = (t: TerritoryState | undefined, p: number) =>
    (t?.specialUnits ?? []).filter((u) => u.kind === 'commander' && u.playerId === p).length * COMMANDER_STRENGTH;
  /** What `p` could move from its stacks beside `id` on the previous board, a commander counted as 7. */
  const stacksBeside = (id: number, p: number) =>
    neighborsOf(graph, id).reduce((n, x) => {
      const t = visibleState(before.get(x));
      return n + (playerOf(t) === p ? Math.max(0, t!.armies! - guard) + commanders(t, p) : 0);
    }, 0);
  // My orders, known only with `sent`: `moves` leaves out Transfer Only, Attack Only and percentage
  // orders (`myOrdersOf`), which `sent` lists. Orders cached before `sent` existed are unknown.
  const myOrders = prev.orders?.sent ? prev.orders : undefined;
  /** An order of mine matching `match` that `sent` lists but `moves` lacks: its armies are unknown. */
  const unlisted = (match: (m: { from: number; to: number }) => boolean): boolean =>
    myOrders !== undefined && myOrders.sent!.filter(match).length > myOrders.moves.filter(match).length;
  /**
   * #123 lesson 5: the armies of `p` that could have walked into `id` since `since[0]`: per other territory
   * within reach, from its latest sighting among `since` (reach = the turns from that board to now), its
   * movable armies then less its movable armies there now (all of them when hidden now or not its).
   * A stack seen in two places on two boards may be counted twice: generous, never a false alarm.
   */
  const walkIn = (id: number, p: number, since: readonly TripBoard[]): number => {
    const dist = bfsDistances(graph, [id]);
    const latest = new Map<number, { turn: number; armies: number }>();
    for (const b of since) {
      for (const t of b.board.territories) {
        const v = visibleState(t);
        if (!v || t.territoryId === id) continue;
        latest.set(t.territoryId, { turn: b.turn, armies: playerOf(v) === p ? v.armies! : 0 });
      }
    }
    let credit = 0;
    for (const [x, seen] of [...latest].sort((a, b) => a[0] - b[0])) {
      const d = dist.get(x);
      if (d === undefined || (!chains && d > T - seen.turn)) continue;
      const then = Math.max(0, seen.armies - guard);
      const v = visibleState(cur.get(x));
      const nowArmies = v && playerOf(v) === p ? Math.max(0, v.armies! - guard) : 0;
      credit += Math.max(0, then - nowArmies);
    }
    return credit;
  };

  /** Some territory within `reach` of `id` (any distance under chains) is hidden on every board in `since`. */
  const hiddenSince = (id: number, since: readonly TripBoard[], reach: number): boolean => {
    const dist = bfsDistances(graph, [id]);
    const boardsSince = since.map((b) => index(b.board));
    for (const [x, d] of dist) {
      if (x === id || (!chains && d > reach)) continue;
      if (boardsSince.every((b) => visibleState(b.get(x)) === undefined)) return true;
    }
    return false;
  };

  for (const id of [...cur.keys()].sort(byNum)) {
    const t = visibleState(cur.get(id));
    const p = playerOf(t);
    if (p === undefined || friend(p) || !graph.territoryById.has(id)) continue;
    // #270: a static seat deploys nothing; a player with no estimate is never compared against 0.
    if (input.staticSeats?.has(p) || input.estimateAt(p, T - 1) === undefined) continue;
    const was = visibleState(before.get(id));
    const armies = t!.armies!;

    // fog-stack: out of the fog this turn.
    if (!was) {
      // Its teammate's armies may have walked in under the fog: they are not its income.
      if (hasMate(p)) continue;
      let last: TripBoard | undefined;
      for (const b of boards.slice(0, -1)) if (b.source !== 'history' && visibleState(index(b.board).get(id))) last = b;
      // Never seen: its start may have walked in; unknown, nothing is read.
      if (!last && !input.start) continue;
      const since = last ? boards.slice(boards.indexOf(last), -1) : [];
      // A history board since that sighting may have hidden a stack walking in: only the stock bound reads it.
      if (!input.start && since.some((b) => b.source === 'history')) continue;
      // A territory within reach hidden on every board since the sighting may have banked a stack that
      // walked in unseen; no sighting credits it, and only the stock (the start) bounds it: not read.
      if (!input.start && last && hiddenSince(id, since, T - last.turn)) continue;
      const startArmies = input.start ? input.start.territories * input.start.armiesPerTerritory : 0;
      const from = last?.turn ?? 1;
      const seen = last ? visibleState(index(last.board).get(id)) : undefined;
      const base = seen ? (playerOf(seen) === p ? seen.armies! : 0) : startArmies;
      let deploys = 0;
      for (let k = from; k < T; k++) deploys += est(p, k);
      const turns = Math.max(1, T - from);
      const walked = last ? walkIn(id, p, since.filter((b) => b.source !== 'history')) : 0;
      let allowed = base + deploys + walked;
      let implied = Math.ceil((armies - base - walked) / turns);
      if (last && input.start) {
        // Armies banked under the fog since early on (#123 lesson 5, #250) walk in unseen: its whole
        // stock (every start and every turn's estimate) less its armies in view elsewhere now.
        let stock = startArmies;
        for (let k = 1; k < T; k++) stock += est(p, k);
        let elsewhere = 0;
        for (const [x, st] of cur) {
          const v = visibleState(st);
          if (x !== id && v && playerOf(v) === p) elsewhere += v.armies!;
        }
        if (stock - elsewhere > allowed) {
          allowed = stock - elsewhere;
          implied = Math.ceil((armies + elsewhere - startArmies) / Math.max(1, T - 1));
        }
      }
      trip({ player: p, kind: 'fog-stack', territory: id, observed: armies, allowed, implied });
      continue;
    }

    // capture: it holds what was mine or a visible neutral's.
    const wasOwner = playerOf(was);
    if (wasOwner !== p && (wasOwner === me || was.owner.kind === 'neutral')) {
      if (chains || input.bomb || !clearAround(id)) continue;
      const third = neighborsOf(graph, id).some((n) => {
        const o = playerOf(visibleState(before.get(n)));
        return o !== undefined && o !== p && o !== me;
      });
      if (third) continue;
      let defenders = was.armies!;
      if (wasOwner === me) {
        if (!myOrders || unlisted((m) => m.from === id)) continue;
        const out = myOrders.moves.filter((m) => m.from === id).reduce((n, m) => n + m.armies, 0);
        const added = myOrders.deploys.filter((d) => d.territoryId === id).reduce((n, d) => n + d.armies, 0);
        defenders = Math.max(guard, defenders + added - out);
      } else {
        // My own attack on the neutral would have worn it down first.
        const mineBeside = neighborsOf(graph, id).some((n) => playerOf(before.get(n)) === me);
        if (mineBeside && (!myOrders || myOrders.sent!.some((m) => m.to === id))) continue;
      }
      const needed = armiesToTake(defenders, rates);
      if (needed === null) continue;
      const stacks = stacksBeside(id, p);
      trip({ player: p, kind: 'capture', territory: id, observed: needed, allowed: stacks + est(p, T - 1), implied: needed - stacks });
      continue;
    }

    // held-attack: my attack on its territory failed, and it still holds it.
    // Not when another player stood beside the target (its teammate may have sent armies in), nor when a
    // Bomb may have halved my source first.
    const otherBeside = neighborsOf(graph, id).some((n) => {
      const o = playerOf(visibleState(before.get(n)));
      return o !== undefined && o !== p && !friend(o);
    });
    if (wasOwner === p && exact && !chains && !input.bomb && !otherBeside && myOrders && clearAround(id) && !input.peace?.has(p)) {
      const transferOnly = new Set(myOrders.sent!.filter((m) => m.transferOnly).map((m) => `${m.from}:${m.to}`));
      const fromIds = [...new Set(myOrders.moves.filter((m) => m.to === id && !transferOnly.has(`${m.from}:${id}`)).map((m) => m.from))].sort(byNum);
      let attackers = 0;
      for (const f of fromIds) {
        const src = visibleState(before.get(f));
        const after = visibleState(cur.get(f));
        if (playerOf(src) !== me || playerOf(after) !== me) continue;
        // An order out of it that `moves` leaves out took an unknown share first.
        if (unlisted((m) => m.from === f)) continue;
        const added = myOrders.deploys.filter((d) => d.territoryId === f).reduce((n, d) => n + d.armies, 0);
        // An order sends what is left: in list order, each order out of the source takes from what the
        // earlier ones left (transfers in are not counted: they may land after it).
        let left = Math.max(0, src!.armies! + added - guard);
        let sent = 0;
        for (const m of myOrders.moves) {
          if (m.from !== f) continue;
          const took = Math.min(m.armies, left);
          left -= took;
          if (m.to === id) sent += took;
        }
        // Another stack beside the source could have shrunk it first: my attack then sent less.
        const exposed = neighborsOf(graph, f).some((n) => {
          if (n === id) return false;
          const t = visibleState(before.get(n));
          if (!t) return true;
          const o = playerOf(t);
          return o !== undefined && !friend(o) && t.armies! > guard;
        });
        if (exposed) continue;
        // …or it ended below what my orders left it (survivors and transfers in only add).
        const outAll = myOrders.moves.filter((m) => m.from === f).reduce((n, m) => n + m.armies, 0);
        const inAll = myOrders.moves.filter((m) => m.to === f).reduce((n, m) => n + m.armies, 0);
        if (after!.armies! < src!.armies! + added - outAll + inAll) continue;
        attackers = Math.max(attackers, sent);
      }
      if (attackers <= 0) continue;
      const defenders = straightKills(attackers, s.offensiveKillRate ?? 60) + 1;
      const stacks = stacksBeside(id, p);
      // Its commander on the target defends as 7 more.
      const standing = was.armies! + commanders(was, p);
      trip({
        player: p,
        kind: 'held-attack',
        territory: id,
        observed: defenders,
        allowed: standing + est(p, T - 1) + stacks,
        implied: defenders - standing - stacks,
      });
    }
  }
  return out;
}

/**
 * The opponents whose estimates are untrusted on `turn`: the marks kept (`stored`) still running, and
 * a mark from each fresh observation (the one implying most per player). A player marked again starts
 * its {@link UNTRUSTED_TURNS} over, keeping whichever observation implies more. Ascending by player.
 */
export function activeTripwires(stored: readonly Tripwire[], fresh: readonly TripObservation[], turn: number): Tripwire[] {
  const by = new Map<number, Tripwire>();
  for (const w of stored) if (w.until >= turn && w.since <= turn) by.set(w.player, w);
  const newest = new Map<number, TripObservation>();
  for (const o of fresh) {
    const had = newest.get(o.player);
    if (!had || o.implied > had.implied) newest.set(o.player, o);
  }
  for (const [p, o] of newest) {
    const had = by.get(p);
    const keep = had && had.implied > o.implied ? had : { ...o };
    by.set(p, {
      player: p,
      since: o.turn,
      until: o.turn + UNTRUSTED_TURNS - 1,
      kind: keep.kind,
      territory: keep.territory,
      observed: keep.observed,
      allowed: keep.allowed,
      implied: keep.implied,
    });
  }
  return [...by.values()].sort((a, b) => a.player - b.player);
}
