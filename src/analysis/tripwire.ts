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
//                walk in unseen, and no sighting credits them. The stock is known only when every turn's
//                estimate is the one kept from that turn's plan (`estimateKept`): a stand-in may under-count
//                an opponent whose estimate a bonus break has lowered since, so the start then counts as
//                unknown. With the start known, a stack walking in is not
//                income (#123 lesson 5): its armies that left view or shrank are credited too: for each other
//                territory, every drop of its movable armies between two consecutive sightings since the
//                stack's own, and from the latest sighting to now (all of them when hidden now or another's),
//                each when within reach (graph distance at most the turns from the earlier sighting to now).
//                With the start unknown there is no stock, and a drop in view is net (a stack may walk in
//                while another fills in behind it), so the bound is every army that could reach it: from a
//                board on which every territory within reach (distance at most the turns left) is in view,
//                what stood on it then, its movable armies within reach and its estimates since, boards
//                chained for the least (`reachBound`); with no such chain (a territory within reach hidden
//                on the turn a stack passed it, or a board missing from the cache) it is not read.
//                Not read when Gift may be in play (`gift`) and the territory was last seen another player's:
//                that player (a third one in a free-for-all) may have gifted it with its stack; nor, with a
//                third player in the game (`players`), when no board showed it its own (never seen, last
//                seen neutral): that player may have taken it out of view and gifted it, armies no stock or
//                sighting counts.
//                Under Multi-Attack,
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
//                none may leave the territory of mine nor go into the neutral. A territory my Gift card gave
//                it (`orders.cards`) is no capture, and with my card plays not recorded (`cards` absent) no
//                capture of mine is read when Gift may be in play (`gift`);
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
//                peace with me (`peace`) is not read, nor anyone while a Diplomacy card may have been in
//                force on the turn the attack ran (`diplomacy`: the cards in effect now do not say). A
//                source that lost nothing (it ended at or above what my orders left it plus the armies
//                the attack sent) did not fight: a failed attack on a defender always costs attackers, so
//                the attack never ran (a Diplomacy card, or orders withdrawn in the web client after this
//                server cached them). The target's own stack attacking my source cannot
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
// It carries one card at most, and an opponent may bank several (up to MaxCardsHold) and play them in one
// turn: a capture, a held attack and a stack out of the fog with its start unknown allow every card it may
// hold (`banked`, the caller's card clock), and are not read at all when those cannot be counted. With the
// start known a stack out of the fog is bounded by its stock, which credits a card every turn so far.
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
  /** A Diplomacy card may have been in force on the previous turn (the cards in effect now do not say): no held attack is read. */
  diplomacy?: boolean;
  /** The deploy estimate the plan used for `player` on turn `turn`; undefined when it has none (the player is not read). */
  estimateAt: (player: number, turn: number) => number | undefined;
  /**
   * Whether `estimateAt(player, turn)` is the figure kept from that turn's plan, not a stand-in (default:
   * every one is). Its stock (the start and every turn's estimate) bounds a stack only when every turn is.
   */
  estimateKept?: (player: number, turn: number) => boolean;
  /**
   * Gift may be in play: with my card plays not recorded (`orders.cards` absent), no capture of mine is read,
   * and no stack out of the fog on a territory last seen another player's (it may have been gifted with its stack).
   */
  gift?: boolean;
  /**
   * The players still in the game who may play a card (me included or not): with `gift`, a third one (neither
   * me nor the player read) may have gifted a territory with its stack. Undefined: unknown, one may.
   */
  players?: readonly number[];
  /**
   * Reinforcement armies an opponent may have banked and played at once beyond its estimate (which carries
   * at most one card, #164): added to what a capture, a held attack or a stack out of the fog with its start
   * unknown allows. `Infinity` (the cards cannot be counted): none of them is read. With the start known a
   * stack out of the fog keeps its stock bound.
   */
  banked?: number;
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
  /** Another player than me and `p` may be in the game (`players` unknown: one may). */
  const thirdParty = (p: number) => input.players === undefined || input.players.some((q) => q !== me && q !== p);
  /** Every turn before this one has `p`'s estimate as that turn's plan kept it. */
  const stockKept = (p: number) => {
    if (!input.estimateKept) return true;
    for (let k = 1; k < T; k++) if (!input.estimateKept(p, k)) return false;
    return true;
  };
  // My Gift card plays that turn: a territory I gave away is no capture. Unknown when my card plays were
  // not recorded and Gift may be in play.
  const gifted = new Set((prev.orders?.cards ?? []).flatMap((c) => (c.card === 'Gift' && c.target !== undefined ? [c.target] : [])));
  const giftUnknown = input.gift === true && prev.orders?.cards === undefined;
  // Reinforcement cards banked and played at once: the estimate carries at most one.
  const bank = Math.max(0, input.banked ?? 0);
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
   * #123 lesson 5: the armies of `p` that could have walked into `id` since `since[0]`: per other territory,
   * every drop of its movable armies between consecutive sightings among `since`, and from the latest to now
   * (all of them when hidden now or not its), each within reach (graph distance at most the turns from the
   * earlier sighting to now). A stack seen in two places, or one that left and came back, may be counted
   * twice: generous, never a false alarm.
   */
  const walkIn = (id: number, p: number, since: readonly TripBoard[]): number => {
    const dist = bfsDistances(graph, [id]);
    // Every sighting of each other territory, in turn order: its movable armies of `p` then.
    const sightings = new Map<number, { turn: number; movable: number }[]>();
    for (const b of since) {
      for (const t of b.board.territories) {
        const v = visibleState(t);
        if (!v || t.territoryId === id) continue;
        const list = sightings.get(t.territoryId) ?? [];
        list.push({ turn: b.turn, movable: playerOf(v) === p ? Math.max(0, v.armies! - guard) : 0 });
        sightings.set(t.territoryId, list);
      }
    }
    let credit = 0;
    for (const [x, seen] of [...sightings].sort((a, b) => a[0] - b[0])) {
      const d = dist.get(x);
      if (d === undefined) continue;
      const v = visibleState(cur.get(x));
      const nowMovable = v && playerOf(v) === p ? Math.max(0, v.armies! - guard) : 0;
      // Each drop between consecutive sightings, and from the latest to now: armies that left then had
      // the turns from the earlier sighting to now to walk in (#275 review: a stack seen leaving a
      // territory still in view was lost when only the latest sighting was compared with now).
      const steps = [...seen, { turn: T, movable: nowMovable }];
      for (let i = 0; i + 1 < steps.length; i++) {
        if (!chains && d > T - steps[i]!.turn) continue;
        credit += Math.max(0, steps[i]!.movable - steps[i + 1]!.movable);
      }
    }
    return credit;
  };

  /**
   * #275 review, with the start unknown: the most armies of `p` that can stand on `id` now, from its
   * sighting on `since[0]` (`base`). Every army on `id` now stood on `id` or within reach on any earlier
   * board (graph distance at most the turns left: one step a turn; any distance under chains), or was
   * deployed since. So from a board `j` on which every territory within reach of `id` is in view, the
   * armies on `id` at a later turn `h` are at most those on `id` at `j`, plus its movable armies within
   * `h − j` of `id` on `j`, plus its estimates from `j` to `h − 1`; chaining boards keeps the bound tight
   * (a stack still out of reach on a later board counts nothing). Counting every army within reach, not
   * only the drops seen, credits a stack that walked in while another filled in behind it; a territory
   * hidden on the turn a stack passed it (or a board missing from the cache) bounds nothing through that
   * board. Undefined when no chain of boards in view bounds it.
   */
  const reachBound = (id: number, p: number, base: number, since: readonly TripBoard[]): number | undefined => {
    const dist = bfsDistances(graph, [id]);
    const views = since.map((b) => ({ turn: b.turn, at: index(b.board) }));
    const bound = new Map<number, number>([[views[0]!.turn, base]]);
    const targets = [...views.slice(1).map((v) => v.turn), T];
    for (const h of targets) {
      let best: number | undefined;
      for (const v of views) {
        const from = bound.get(v.turn);
        if (v.turn >= h || from === undefined) continue;
        let within = 0;
        let open = true;
        for (const [x, d] of dist) {
          if (x === id || (!chains && d > h - v.turn)) continue;
          const st = visibleState(v.at.get(x));
          if (!st) {
            open = false;
            break;
          }
          if (playerOf(st) === p) within += Math.max(0, st.armies! - guard);
        }
        if (!open) continue;
        let deploys = 0;
        for (let k = v.turn; k < h; k++) deploys += est(p, k);
        const b = from + within + deploys;
        if (best === undefined || b < best) best = b;
      }
      if (best !== undefined) bound.set(h, best);
    }
    return bound.get(T);
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
      // Its stock is known only with its start and every turn's estimate as that turn's plan kept it: a
      // stand-in (today's figure) may under-count what it earned before a bonus break lowered it.
      const start = input.start && stockKept(p) ? input.start : undefined;
      let last: TripBoard | undefined;
      for (const b of boards.slice(0, -1)) if (b.source !== 'history' && visibleState(index(b.board).get(id))) last = b;
      // Never seen: its start may have walked in; unknown, nothing is read.
      if (!last && !start) continue;
      const since = last ? boards.slice(boards.indexOf(last), -1) : [];
      // A history board since that sighting may have hidden a stack walking in: only the stock bound reads it.
      if (!start && since.some((b) => b.source === 'history')) continue;
      const startArmies = start ? start.territories * start.armiesPerTerritory : 0;
      const from = last?.turn ?? 1;
      const seen = last ? visibleState(index(last.board).get(id)) : undefined;
      // Last seen another player's: with Gift in play it may have given the territory with its stack.
      if (input.gift && seen && seen.owner.kind === 'player' && playerOf(seen) !== p) continue;
      // Never seen, or last seen neutral, with Gift in play and a third player in the game: that player may
      // have taken it out of view and gifted it, its stack with it; neither the stock nor a sighting counts
      // that player's armies.
      if (input.gift && thirdParty(p) && playerOf(seen) !== p) continue;
      // With no stock to bound it, Reinforcement cards banked before the sighting may all land after it.
      if (!start && !Number.isFinite(bank)) continue;
      const base = seen ? (playerOf(seen) === p ? seen.armies! : 0) : startArmies;
      let deploys = 0;
      for (let k = from; k < T; k++) deploys += est(p, k);
      const turns = Math.max(1, T - from);
      let walked: number;
      if (start) walked = last ? walkIn(id, p, since.filter((b) => b.source !== 'history')) : 0;
      else {
        // No stock bounds it: only the armies that could reach it from boards in view (#275 review).
        const reach = reachBound(id, p, base, since);
        if (reach === undefined) continue;
        walked = reach - base - deploys;
      }
      let allowed = base + deploys + walked + (start ? 0 : bank);
      let implied = Math.ceil((armies - base - walked) / turns);
      if (last && start) {
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
      if (chains || input.bomb || !Number.isFinite(bank) || !clearAround(id)) continue;
      const third = neighborsOf(graph, id).some((n) => {
        const o = playerOf(visibleState(before.get(n)));
        return o !== undefined && o !== p && o !== me;
      });
      if (third) continue;
      let defenders = was.armies!;
      if (wasOwner === me) {
        if (!myOrders || unlisted((m) => m.from === id) || giftUnknown || gifted.has(id)) continue;
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
      trip({ player: p, kind: 'capture', territory: id, observed: needed, allowed: stacks + est(p, T - 1) + bank, implied: needed - stacks });
      continue;
    }

    // held-attack: my attack on its territory failed, and it still holds it.
    // Not when another player stood beside the target (its teammate may have sent armies in), nor when a
    // Bomb may have halved my source first.
    const otherBeside = neighborsOf(graph, id).some((n) => {
      const o = playerOf(visibleState(before.get(n)));
      return o !== undefined && o !== p && !friend(o);
    });
    if (wasOwner === p && exact && !chains && !input.bomb && Number.isFinite(bank) && !otherBeside && myOrders && clearAround(id) && !input.peace?.has(p) && !input.diplomacy) {
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
        const floor = src!.armies! + added - outAll + inAll;
        if (after!.armies! < floor) continue;
        // …or it lost nothing: a failed attack on a defender always costs attackers, so it never ran (a
        // Diplomacy card in force then, or orders withdrawn in the web client after this server cached them).
        if (after!.armies! >= floor + sent) continue;
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
        allowed: standing + est(p, T - 1) + stacks + bank,
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
