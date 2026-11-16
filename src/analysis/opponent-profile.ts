// Opponent profiling, part A (docs/PLAN-PROFILES.md section 8): what one opponent DID on one turn,
// read off two consecutive boards of my own view and my orders between them, as countable
// primitives; and the habits those primitives add up to over a game.
//
// A habit is events and opportunities (a rate `{ e, n }`) or a running size (`{ n, sum, sq }`):
// counts, never a story. Pure and deterministic: no I/O, no clock, ids ascending. Territory states
// go through the planner's visibility rules (`visibleState`, `ownerShown`): a territory not shown on
// both boards contributes nothing, so a fog reveal is never a change (#69).
//
// Profiles INFORM ONLY (owner decision P1): nothing here is read by the planner.
import type { BoardState, TerritoryState } from '../board.js';
import { luckFraction, straightKills, armiesToTake, specialUnitStrength, DEFAULT_DEFENSIVE_KILL_RATE, DEFAULT_OFFENSIVE_KILL_RATE } from './combat.js';
import { neighborsOf, type MapGraph } from './graph.js';
import type { MyOrders } from './opponents.js';
import { ownerShown, visibleState, type PlannerSettings } from './plan/shared.js';
import { holdsSeat } from '../player-states.js';
import { isTeamGame } from '../teams.js';

/** What one opponent did on one turn (board T → board T+1), as counts. */
export interface TurnPrimitives {
  /** Board T shows a territory of its next to one of mine. */
  contact: boolean;
  /** It attacked me this turn; `null` when that cannot be told. */
  attackedMe: boolean | null;
  /** I sent a non-transfer move onto a territory board T showed as its. */
  iAttacked: boolean;
  /** Attacks of mine that measure whether it reinforced the target (`n`), those where it did (`e`), and the least armies above the board's count that explain them (`extra`, summed). */
  reinforce: { n: number; e: number; extra: number };
  /** Where its visible growth went: the largest growth on one territory and the total; `null` with fewer than two territories or no growth. */
  stack: { top: number; total: number } | null;
  /** Territories it took from me, ascending; `null` when captures cannot be told (a Gift of mine may have gone unrecorded). */
  tookFromMe: number[] | null;
  /** Territories I took from it, ascending. */
  lostToMe: number[];
}

export interface ObserveInput {
  graph: MapGraph;
  /** My GameFeed id. */
  me: number;
  /** The board of turn T. */
  previous: BoardState;
  /** The board of turn T+1. */
  current: BoardState;
  /** My orders on turn T, when known. */
  orders?: MyOrders | undefined;
  /** `multiAttack` absent: the settings did not say, and it may be on. */
  settings: Pick<PlannerSettings, 'offensiveKillRate' | 'defensiveKillRate' | 'luckModifier' | 'roundingMode' | 'oneArmyStandsGuard' | 'multiAttack'>;
  /** The players observed: my opponents (never me, never a teammate). */
  opponents: readonly number[];
  /**
   * The cards in play (GameFeed settings, by name); absent when the settings were not read, where any
   * card may be. Decides whether a card play my orders do not record (`orders.cards` absent) could
   * have moved my armies (Airlift) or given a territory away (Gift).
   */
  cards?: readonly string[] | undefined;
}

const byNum = (a: number, b: number) => a - b;
const ownerOf = (t: TerritoryState | undefined): number | undefined => (t?.owner.kind === 'player' ? t.owner.playerId : undefined);
/** The owner when the board shows it (visible or owner-only). */
const shownOwner = (t: TerritoryState | undefined) => ownerOf(ownerShown(t));
/** The owner and armies when the board shows both. */
const seen = (t: TerritoryState | undefined): { owner: number | undefined; armies: number } | undefined => {
  const v = visibleState(t);
  return v ? { owner: ownerOf(v), armies: v.armies! } : undefined;
};

/**
 * Whether combat is exact (0% luck, straight rounding): the only games where an attack's result
 * says how many defenders it met.
 */
export function exactCombat(s: ObserveInput['settings']): boolean {
  return luckFraction(s.luckModifier) === 0 && s.roundingMode !== 'WeightedRandom';
}

/** The least defenders, from `from` up, an attack of `armies` fails against (exact combat); `from` when none is found within the bound. */
function leastFailing(armies: number, from: number, off: number, def: number): number {
  for (let d = Math.max(0, from); d < from + 10_000; d++) {
    const need = armiesToTake(d, { offensiveKillRate: off, defensiveKillRate: def });
    if (need === null || armies < need) return d;
  }
  return from;
}

/**
 * One primitive record per opponent for turn T, keyed by player id (opponents ascending).
 *
 * - `attackedMe`: a territory mine on T is its on T+1; or (orders known) a territory mine on both
 *   boards, next to a visible stack of its and of no other player, holds fewer armies than T's count
 *   + my deploys − my moves out + my transfers in (a transfer in counts only from a source next to no
 *   other player's territory, which nobody could have hit first). Survivors of a move out that did
 *   not surely land (its target not mine on T+1, as after a failed attack or a transfer that met a
 *   territory taken first, or entered by another order of mine too, which may have retaken it after
 *   this move failed) may come back and cover a hit, so such a border still reads yes on a drop but never tests a "no";
 *   nor does one a move of mine enters from a territory not mine on T (a Multi-Attack chain through
 *   a territory I took this turn: armies the figure leaves out), nor one whose moves out leave it at
 *   the guard or less (war.app sends what is left, so a hit landing first shrinks the move, not the
 *   border: a withdrawal of every movable army).
 *   Under Multi-Attack (or when the settings do not say) a border is read only when every territory
 *   within two steps has its owner shown on T and none is another player's: a third player may have
 *   chained through the shown neighbour (or a neutral) into mine, and the drop would be blamed on it.
 *   A longer chain is not ruled out. Without orders only a capture says
 *   so, else `null`; with orders and no testable territory, `null` too.
 * - `reinforce`: one opportunity per attack of mine onto X (its, with D armies on T) when combat is
 *   exact, it is my only move onto X, X carries no special unit, no move of mine leaves X, X shows its
 *   armies on T+1 (still its, or mine), and my source S is mine on both boards with no transfer in,
 *   affordable orders out, every other move out of it surely landed (as above), no special unit of mine on it (a
 *   commander going along fights as 7, which the move's armies do not count), and exactly the armies
 *   my orders leave (on a capture), or those plus at most the A armies sent (on a failure: an X
 *   weaker than D kills fewer, so more come back). An event when X stood stronger than D: captured
 *   with fewer survivors than the exact result, or not captured with more defenders left than the
 *   exact result against D (which covers an attack big enough to take D that failed); an X weaker
 *   than D is an opportunity without an event. `extra` is the least defenders above D explaining it.
 * - `stack`: over its territories visible on both boards, growth = max(0, now − then).
 * - `tookFromMe` / `lostToMe`: ownership changes between it and me, owners shown on both boards;
 *   `tookFromMe` is `null` (cannot tell) when a Gift of mine may have gone unrecorded, and then a
 *   quiet border never makes `attackedMe` false (only a drop makes it true).
 *
 * Assumed for `reinforce`: on a failure, the armies back on S are the exact result against the
 * defenders X's survivors imply (else no reading: a capture it took back later in the turn returns
 * none). On a capture, a later fight that thins my survivors on X is not told apart from defenders
 * above D, and reads as an event.
 *
 * My orders as cached (`MyOrders`): `moves` holds only plain orders; a percentage, Attack Only or
 * Transfer Only order is in `sent` alone, and card plays in `cards`. A territory such an order leaves
 * or enters, or one of my Airlifts touches, is never tested for `attackedMe` and gives no `reinforce`
 * reading (its armies are not known); `iAttacked` counts every non-transfer order of `sent`. When the
 * orders do not record card plays (`cards` absent: a cache written before they were) and the game may
 * have Airlift, nothing is tested from armies at all, and when it may have Gift — orders unknown
 * included — captures cannot be told (`tookFromMe: null`; it may have been my gift), so a game with
 * Gift and no orders of mine never reads one, nor counts a turn as one without. A territory recorded as my Gift is no capture
 * either. Not filtered: its own Gift of a territory to me reads as `lostToMe` (my orders cannot say).
 */
export function observeTurn(input: ObserveInput): Map<number, TurnPrimitives> {
  const { graph, me, previous, current, orders, settings } = input;
  const was = new Map(previous.territories.map((t) => [t.territoryId, t]));
  const now = new Map(current.territories.map((t) => [t.territoryId, t]));
  const off = settings.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  const def = settings.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  const guard = settings.oneArmyStandsGuard === false ? 0 : 1;
  const exact = exactCombat(settings);
  const ids = [...new Set(previous.territories.map((t) => t.territoryId))].sort(byNum);
  const mineWas = (id: number) => shownOwner(was.get(id)) === me;
  const mineNow = (id: number) => shownOwner(now.get(id)) === me;

  const deploys = new Map<number, number>();
  for (const d of orders?.deploys ?? []) deploys.set(d.territoryId, (deploys.get(d.territoryId) ?? 0) + d.armies);
  const moves = orders?.moves ?? [];
  const sent = orders?.sent ?? [];
  const transferOnly = new Set(sent.filter((m) => m.transferOnly).map((m) => `${m.from}:${m.to}`));
  // Card plays my orders may not record (A1): absent from the cache, in a game that may have the card.
  const mayHave = (card: string) => input.cards === undefined || input.cards.includes(card);
  const cardsUnknown = orders?.cards === undefined;
  const airliftUnknown = cardsUnknown && mayHave('Airlift');
  const giftUnknown = cardsUnknown && mayHave('Gift');
  const gifted = new Set((orders?.cards ?? []).flatMap((c) => (c.card === 'Gift' && c.target !== undefined ? [c.target] : [])));
  // Territories whose armies my plain moves do not account for: an order only `sent` holds, or an Airlift.
  const untested = new Set<number>();
  const plain = (a: { from: number; to: number }) => moves.filter((m) => m.from === a.from && m.to === a.to).length;
  const sentCount = (a: { from: number; to: number }) => sent.filter((m) => m.from === a.from && m.to === a.to).length;
  for (const m of sent)
    if (sentCount(m) > plain(m)) {
      untested.add(m.from);
      untested.add(m.to);
    }
  for (const c of orders?.cards ?? [])
    if (c.card === 'Airlift') for (const t of [c.from, c.to]) if (t !== undefined) untested.add(t);
  /** Every neighbour of `id` has its owner shown on board T (no hidden player could have hit it). */
  const allShown = (id: number) => neighborsOf(graph, id).every((n) => ownerShown(was.get(n)) !== undefined);
  // Multi-Attack (or unstated, so maybe on): a player can chain captures in one turn.
  const multiAttack = settings.multiAttack !== false;
  /** The territories within two steps of `id`, itself left out. */
  const twoSteps = (id: number) => {
    const out = new Set<number>();
    for (const n of neighborsOf(graph, id)) {
      out.add(n);
      for (const m of neighborsOf(graph, n)) out.add(m);
    }
    out.delete(id);
    return [...out];
  };
  const outOf = (id: number) => moves.filter((m) => m.from === id);
  const into = (id: number) => moves.filter((m) => m.to === id);
  const sum = (ms: readonly { armies: number }[]) => ms.reduce((n, m) => n + Math.max(0, m.armies), 0);
  /** A move of mine that surely ended on its target: the target is mine after the turn and no other
   *  order of mine entered it (another could have failed first and been retaken, or retaken it after
   *  this one met it taken), so none of its survivors can have gone back to the source. */
  const landed = (m: { to: number }) => mineNow(m.to) && into(m.to).length === 1 && !untested.has(m.to);
  /** A player's territory next to `id` on board T, other than me. */
  const enemiesNext = (id: number) => {
    const out = new Set<number>();
    for (const n of neighborsOf(graph, id)) {
      const o = shownOwner(was.get(n));
      if (o !== undefined && o !== me) out.add(o);
    }
    return out;
  };

  const result = new Map<number, TurnPrimitives>();
  for (const p of [...input.opponents].sort(byNum)) {
    if (p === me) continue;
    const ownsWas = (id: number) => shownOwner(was.get(id)) === p;
    const ownsNow = (id: number) => shownOwner(now.get(id)) === p;

    const contact = ids.some((id) => ownsWas(id) && neighborsOf(graph, id).some(mineWas));
    const tookFromMe = giftUnknown ? null : ids.filter((id) => mineWas(id) && ownsNow(id) && !gifted.has(id));
    const lostToMe = ids.filter((id) => ownsWas(id) && mineNow(id));
    const iAttacked =
      moves.some((m) => ownsWas(m.to) && m.armies > 0 && !transferOnly.has(`${m.from}:${m.to}`)) ||
      sent.some((m) => ownsWas(m.to) && !m.transferOnly && sentCount(m) > plain(m));

    // attackedMe
    let attackedMe: boolean | null = tookFromMe?.length ? true : null;
    if (attackedMe === null && orders && !airliftUnknown) {
      let tested = false;
      for (const id of ids) {
        if (untested.has(id)) continue;
        const a = seen(was.get(id));
        const b = seen(now.get(id));
        if (a?.owner !== me || b?.owner !== me) continue;
        const stacks = neighborsOf(graph, id).filter((n) => {
          const s = seen(was.get(n));
          return s !== undefined && s.owner === p && s.armies > 0;
        });
        if (!stacks.length) continue;
        const others = enemiesNext(id);
        if (others.size !== 1 || !allShown(id)) continue;
        // Under Multi-Attack a third player may have chained through its territory (or a neutral) into
        // mine and the drop would be blamed on it: only a border with every territory within two steps
        // shown, none another player's, is read (a longer chain is not ruled out).
        if (
          multiAttack &&
          twoSteps(id).some((t) => {
            const o = shownOwner(was.get(t));
            return ownerShown(was.get(t)) === undefined || (o !== undefined && o !== me && o !== p);
          })
        )
          continue;
        const transfersIn = into(id).filter((m) => mineWas(m.from));
        if (transfersIn.some((m) => enemiesNext(m.from).size > 0 || !allShown(m.from))) continue;
        const expected = a.armies + (deploys.get(id) ?? 0) - sum(outOf(id)) + sum(transfersIn);
        if (b.armies < expected) {
          attackedMe = true;
          break;
        }
        // A move out that did not surely land (a failed attack, a transfer that met a territory taken
        // first, or a move into a territory another order of mine also entered, which may have been
        // taken or retaken in between) may send survivors back, which can cover a hit: no "no" here.
        // A move out that drains it to the guard sends only what is left: a hit landing first shrinks
        // the move, not the border, which still ends at `expected`: no "no" from here either.
        const drained = outOf(id).some((m) => m.armies > 0) && expected <= guard;
        // A move in from a territory not mine on T (one I took this turn: a Multi-Attack chain) brings
        // armies the figure leaves out, which can cover a hit: a drop is still a yes, never a "no".
        const chainedIn = into(id).some((m) => m.armies > 0 && !mineWas(m.from));
        if (!drained && !chainedIn && !outOf(id).some((m) => m.armies > 0 && !landed(m))) tested = true;
      }
      // A quiet border is a "no" only when captures can be told too (a capture elsewhere would be a yes).
      if (attackedMe === null && tested && tookFromMe !== null) attackedMe = false;
    }

    // reinforce
    const reinforce = { n: 0, e: 0, extra: 0 };
    if (exact && orders && !airliftUnknown) {
      for (const m of moves) {
        const x = seen(was.get(m.to));
        if (!x || x.owner !== p || m.armies <= 0) continue;
        if (untested.has(m.from) || untested.has(m.to)) continue;
        if (transferOnly.has(`${m.from}:${m.to}`)) continue;
        if (into(m.to).length !== 1 || outOf(m.to).length) continue;
        if (specialUnitStrength(visibleState(was.get(m.to))?.specialUnits) > 0) continue;
        const xNow = seen(now.get(m.to));
        if (!xNow || (xNow.owner !== p && xNow.owner !== me)) continue;
        const captured = xNow.owner === me;
        // The source: mine on both boards, not hit first.
        const sWas = seen(was.get(m.from));
        const sNow = seen(now.get(m.from));
        if (sWas?.owner !== me || sNow?.owner !== me) continue;
        // A commander of mine may go with the attack (fighting as 7): its kills are not `m.armies`'.
        if (visibleState(was.get(m.from))?.specialUnits?.some((u) => u.playerId === me)) continue;
        if (into(m.from).length) continue;
        const sent = outOf(m.from);
        const available = sWas.armies + (deploys.get(m.from) ?? 0);
        if (sum(sent) > available - guard) continue;
        if (sent.some((o) => o !== m && !landed(o))) continue;
        const base = available - sum(sent);
        const A = m.armies;
        const D = x.armies;
        const K = straightKills(A, off);
        let d: number;
        if (captured) {
          if (sNow.armies !== base) continue;
          // The least defenders from D up whose kills leave what stands on X: D itself when more
          // survived than the exact result (X weaker than shown: an opportunity, not an event).
          d = D;
          while (d < D + 10_000 && A - straightKills(d, def) > xNow.armies) d++;
        } else {
          // At most A come back (fewer defenders than D kill fewer of mine); less than none: S was hit.
          const returned = sNow.armies - base;
          if (returned < 0 || returned > A) continue;
          d = Math.max(leastFailing(A, D, off, def), xNow.armies > 0 ? xNow.armies + K : 0);
          // What comes back must be the exact result against the defenders X's survivors imply: a
          // capture it took back later in the turn (none back, X its again) or another fight on X
          // does not match and is no reading.
          const met = xNow.armies > 0 ? xNow.armies + K : d;
          if (A - Math.min(A, straightKills(met, def)) !== returned) continue;
        }
        reinforce.n++;
        if (d > D) {
          reinforce.e++;
          reinforce.extra += d - D;
        }
      }
    }

    // stack
    let top = 0;
    let total = 0;
    let both = 0;
    for (const id of ids) {
      const a = seen(was.get(id));
      const b = seen(now.get(id));
      if (a?.owner !== p || b?.owner !== p) continue;
      both++;
      const g = Math.max(0, b.armies - a.armies);
      total += g;
      top = Math.max(top, g);
    }
    const stack = both >= 2 && total >= 1 ? { top, total } : null;

    result.set(p, { contact, attackedMe, iAttacked, reinforce, stack, tookFromMe, lostToMe });
  }
  return result;
}

/** Events out of opportunities. */
export interface Rate {
  e: number;
  n: number;
}
/** A running size: how many readings, their sum and their sum of squares. */
export interface Size {
  n: number;
  sum: number;
  sq: number;
}

export const HABIT_NAMES = ['reinforce', 'attack', 'firstStrike', 'stacking', 'retaliate', 'retake'] as const;
export type HabitName = (typeof HABIT_NAMES)[number];

/** One opponent's habits over a game. */
export interface Habits {
  reinforce: Rate;
  /** The armies above the board's count per reinforce event: `n` events, `sum` armies (a mean, no spread). */
  reinforceExtra: { n: number; sum: number };
  attack: Rate;
  firstStrike: Rate;
  stacking: Size;
  retaliate: Rate;
  retake: Rate;
  /** Turns observed. */
  turns: number;
}

/** One observed turn of one opponent. */
export interface ObservedPrimitives {
  turn: number;
  primitives: TurnPrimitives;
}

/**
 * The habits of one opponent from its observed turns (any order; each turn once). Habits that span
 * turns are recomputed from the whole list, so re-deriving never double-counts:
 * - `reinforce`: Σ events ÷ Σ opportunities;
 * - `attack`: turns in contact where it attacked me ÷ turns in contact where that could be told;
 * - `firstStrike`: its first contact with me (the turn before observed without contact, or turn 1)
 *   that lasted two turns, an event when it attacked me on either; counted only when both turns
 *   could be told or one says it did;
 * - `stacking`: the mean of `top ÷ total` over turns with a stack;
 * - `retaliate`: turns I attacked it, an event when it attacked me on one of the next two turns;
 *   counted only when both are observed and told, or one says it did;
 * - `retake`: territories I took from it, an event when it took them back within two turns;
 *   counted only when both turns are observed with their captures told, or it did.
 */
export function habitsOf(turns: readonly ObservedPrimitives[]): Habits {
  const by = new Map<number, TurnPrimitives>();
  for (const t of turns) by.set(t.turn, t.primitives);
  const order = [...by.keys()].sort(byNum);
  const h: Habits = {
    reinforce: { e: 0, n: 0 },
    reinforceExtra: { n: 0, sum: 0 },
    attack: { e: 0, n: 0 },
    firstStrike: { e: 0, n: 0 },
    stacking: { n: 0, sum: 0, sq: 0 },
    retaliate: { e: 0, n: 0 },
    retake: { e: 0, n: 0 },
    turns: order.length,
  };
  /** Whether either of the next two turns says yes (`true`), both say no (`false`), or it cannot be told (`null`). */
  const within2 = (t: number, test: (p: TurnPrimitives) => boolean | null): boolean | null => {
    const a = by.get(t + 1);
    const b = by.get(t + 2);
    const ra = a ? test(a) : null;
    const rb = b ? test(b) : null;
    if (ra === true || rb === true) return true;
    return ra === false && rb === false ? false : null;
  };
  const count = (r: Rate, v: boolean | null) => {
    if (v === null) return;
    r.n++;
    if (v) r.e++;
  };
  for (const t of order) {
    const p = by.get(t)!;
    h.reinforce.e += p.reinforce.e;
    h.reinforce.n += p.reinforce.n;
    h.reinforceExtra.n += p.reinforce.e;
    h.reinforceExtra.sum += p.reinforce.extra;
    if (p.contact && p.attackedMe !== null) count(h.attack, p.attackedMe);
    if (p.stack && p.stack.total > 0) {
      const share = p.stack.top / p.stack.total;
      h.stacking.n++;
      h.stacking.sum += share;
      h.stacking.sq += share * share;
    }
    if (p.iAttacked) count(h.retaliate, within2(t, (q) => q.attackedMe));
    for (const id of p.lostToMe) count(h.retake, within2(t, (q) => (q.tookFromMe === null ? null : q.tookFromMe.includes(id))));
  }
  // The first contact: the earliest turn in contact.
  const first = order.find((t) => by.get(t)!.contact);
  if (first !== undefined) {
    const before = by.get(first - 1);
    const fresh = first <= 1 || (before !== undefined && !before.contact);
    const next = by.get(first + 1);
    if (fresh && next?.contact) {
      const a = by.get(first)!.attackedMe;
      const b = next.attackedMe;
      if (a === true || b === true) count(h.firstStrike, true);
      else if (a === false && b === false) count(h.firstStrike, false);
    }
  }
  return h;
}

// ---- the estimate (B1): this game pooled with past games, shrunk toward the population or a default ----

/** How many opportunities the prior weighs as (docs/PLAN-PROFILES.md B1). */
export const PROFILE_PRIOR_WEIGHT = 4;
/** The least confidence at which a habit gives a label. */
export const PROFILE_MIN_CONFIDENCE = 0.5;
/** The neutral prior per habit, until part 0's pooled rates replace them. */
export const HABIT_DEFAULTS: Readonly<Record<HabitName, number>> = {
  reinforce: 0.5,
  attack: 0.4,
  firstStrike: 0.3,
  stacking: 0.7,
  retaliate: 0.5,
  retake: 0.4,
};
/**
 * The least opportunities (readings, for a size) a population pool needs for one habit before its
 * rate replaces the constant default as that habit's prior: fewer, and the next pool (or the default)
 * is used. A pool of a handful would swing the prior on one game.
 */
export const POPULATION_MIN_OPPORTUNITIES = 10;

/** A player's totals from earlier games are multiplied by this when a game new to it is folded (B2). */
export const PROFILE_DECAY = 0.9;

/** The formats profiles are pooled by. */
export const PROFILE_FORMATS = ['1v1', 'ffa', 'team'] as const;
export type ProfileFormat = (typeof PROFILE_FORMATS)[number];

/** A game's format for pooling: a team game, else `1v1` with two seats held, else `ffa`. */
export function profileFormatOf(players: readonly { state?: string | undefined; team?: number | null | undefined }[]): ProfileFormat {
  if (isTeamGame(players)) return 'team';
  return players.filter((p) => holdsSeat(p.state)).length <= 2 ? '1v1' : 'ffa';
}

/** No counts at all. */
export function emptyHabits(): Habits {
  return {
    reinforce: { e: 0, n: 0 },
    reinforceExtra: { n: 0, sum: 0 },
    attack: { e: 0, n: 0 },
    firstStrike: { e: 0, n: 0 },
    stacking: { n: 0, sum: 0, sq: 0 },
    retaliate: { e: 0, n: 0 },
    retake: { e: 0, n: 0 },
    turns: 0,
  };
}

/** Rounded to 1e-6, so faded totals do not drift with float noise (and a cancelled count is 0). */
const tidy = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
};

/** `a + scale × b`, count by count (`scale` −1 takes `b` back out). */
export function addHabits(a: Habits, b: Habits, scale = 1): Habits {
  const rate = (x: Rate, y: Rate): Rate => ({ e: tidy(x.e + scale * y.e), n: tidy(x.n + scale * y.n) });
  return {
    reinforce: rate(a.reinforce, b.reinforce),
    reinforceExtra: { n: tidy(a.reinforceExtra.n + scale * b.reinforceExtra.n), sum: tidy(a.reinforceExtra.sum + scale * b.reinforceExtra.sum) },
    attack: rate(a.attack, b.attack),
    firstStrike: rate(a.firstStrike, b.firstStrike),
    stacking: { n: tidy(a.stacking.n + scale * b.stacking.n), sum: tidy(a.stacking.sum + scale * b.stacking.sum), sq: tidy(a.stacking.sq + scale * b.stacking.sq) },
    retaliate: rate(a.retaliate, b.retaliate),
    retake: rate(a.retake, b.retake),
    turns: tidy(a.turns + scale * b.turns),
  };
}

/** Every count × `f` (the fade). */
export const scaleHabits = (h: Habits, f: number): Habits => addHabits(emptyHabits(), h, f);

/**
 * What weighed most in an estimate: this game's counts, the player's past games (`history` when at
 * least half of what that past counts was read from finished games' histories, #312 E3), or the prior.
 */
export type HabitBasis = 'this-game' | 'past-games' | 'history' | 'population' | 'default';

export interface HabitEstimate {
  /** The estimate: the counts shrunk toward the prior. */
  value: number;
  /** Opportunities (or readings) behind it: this game's plus the past games' faded ones. */
  n: number;
  /** n ÷ (n + K). */
  confidence: number;
  /** What contributed most: this game's counts, the player's past games (`history`: mostly read from finished games' histories), or the prior (the population pool or the constant default). */
  basis: HabitBasis;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** `(p0 × K + e) ÷ (K + n)` from this game's counts alone, its confidence and basis. */
export function estimate(events: number, n: number, p0: number, k = PROFILE_PRIOR_WEIGHT): HabitEstimate {
  return blend({ e: events, n }, { e: 0, n: 0 }, p0, 'default', k);
}

/**
 * `(p0 × K + e) ÷ (K + n)` with `e` and `n` this game's and the past's together. The basis is the
 * largest weight of this game's `n`, the past's `n` and the prior's K; the prior wins a tie, then
 * this game. A past basis reads `history` when `fromHistory` (the part of the past folded from
 * finished games' histories) holds at least half of the past's `n` (#312 E3); the value never changes.
 */
function blend(game: Rate, past: Rate, p0: number, prior: 'population' | 'default', k = PROFILE_PRIOR_WEIGHT, fromHistory?: Rate): HabitEstimate {
  const e = game.e + past.e;
  const n = game.n + past.n;
  let basis: HabitBasis = prior;
  let weight = k;
  if (game.n > weight) {
    basis = 'this-game';
    weight = game.n;
  }
  if (past.n > weight) basis = fromHistory && fromHistory.n > 0 && 2 * fromHistory.n >= past.n ? 'history' : 'past-games';
  return { value: round2((p0 * k + e) / (k + n)), n: round2(n), confidence: round2(n / (n + k)), basis };
}

/** What the estimate pools with this game's counts. */
export interface EstimatePriors {
  /** The player's faded totals from earlier games (never this game's). */
  past?: Habits | undefined;
  /** The part of `past` folded from finished games' histories (#312 E3): names the basis `history`, never changes a value. */
  pastHistory?: Habits | undefined;
  /**
   * Population pools, tried in order per habit: the first with {@link POPULATION_MIN_OPPORTUNITIES}
   * or more gives that habit's prior (all players in this format, then all players; the AI pool for
   * an AI seat). None: the constant default.
   */
  pools?: readonly Habits[] | undefined;
}

/** Every habit's estimate from a game's counts, pooled with the past and shrunk toward the prior (B1). */
export function estimateHabits(h: Habits, priors: EstimatePriors = {}): Record<HabitName, HabitEstimate> {
  const past = priors.past ?? emptyHabits();
  const pools = priors.pools ?? [];
  const prior = (name: HabitName, pick: (x: Habits) => { e: number; n: number }): { p0: number; from: 'population' | 'default' } => {
    for (const pool of pools) {
      const r = pick(pool);
      if (r.n >= POPULATION_MIN_OPPORTUNITIES) return { p0: r.e / r.n, from: 'population' };
    }
    return { p0: HABIT_DEFAULTS[name], from: 'default' };
  };
  const rate = (name: Exclude<HabitName, 'stacking'>) => {
    const p = prior(name, (x) => x[name]);
    return blend(h[name], past[name], p.p0, p.from, PROFILE_PRIOR_WEIGHT, priors.pastHistory?.[name]);
  };
  const size = (x: Habits) => ({ e: x.stacking.sum, n: x.stacking.n });
  const s = prior('stacking', size);
  return {
    reinforce: rate('reinforce'),
    attack: rate('attack'),
    firstStrike: rate('firstStrike'),
    stacking: blend(size(h), size(past), s.p0, s.from, PROFILE_PRIOR_WEIGHT, priors.pastHistory ? size(priors.pastHistory) : undefined),
    retaliate: rate('retaliate'),
    retake: rate('retake'),
  };
}

export const PROFILE_LABELS = ['reinforcer', 'rarely-reinforces', 'stacker', 'spreader', 'rusher', 'turtle', 'avenger', 'retakes'] as const;
export type ProfileLabel = (typeof PROFILE_LABELS)[number];

/** One fixed counter-play line per label the plan gives one (docs/PLAN-PROFILES.md B1; `spreader` has none). */
export const COUNTER_PLAY: Readonly<Partial<Record<ProfileLabel, string>>> = {
  reinforcer: 'Attack two of its territories in one turn (it deploys on one), or size for its deploy.',
  'rarely-reinforces': 'Attack at the bare cost; spend the saving elsewhere.',
  stacker: 'Hold in full where its stack is; expect one push.',
  rusher: 'Garrison at first contact; no leftover on expansion.',
  turtle: 'Out-expand it; a quiet border with it tends to stay quiet.',
  avenger: 'Do not poke; strike only to cripple, and garrison the source.',
  retakes: 'A capture from it needs a garrison that survives its counter.',
};

/** Turns back from the one being played within which an attack on me withholds `turtle` (#264). */
export const TURTLE_QUIET_TURNS = 2;

/** When an opponent last attacked me, against the turn being played, for {@link labelsOf} (#264). */
export interface LabelRecency {
  /** {@link lastAttackTurn} of its observed turns. */
  lastAttackTurn?: number | null;
  /** The turn being played; `null` or absent when unknown (recency is then not judged). */
  turn?: number | null;
}

const attackedRecently = (r: LabelRecency): boolean =>
  r.lastAttackTurn != null && r.turn != null && r.lastAttackTurn >= r.turn - TURTLE_QUIET_TURNS;

/**
 * The last turn an opponent attacked me (#264): the latest observed turn whose primitives say it did
 * (`attackedMe`, or a territory it took from me); `null` when none does. A turn T is what happened
 * between my boards of T and T + 1, so on turn N an attack on N − 1 or N − 2 is "the last two turns".
 */
export function lastAttackTurn(turns: readonly ObservedPrimitives[]): number | null {
  let last: number | null = null;
  for (const t of turns)
    if ((t.primitives.attackedMe === true || (t.primitives.tookFromMe?.length ?? 0) > 0) && (last === null || t.turn > last)) last = t.turn;
  return last;
}

/**
 * The labels the estimates earn, each only at {@link PROFILE_MIN_CONFIDENCE} or more, in a fixed order.
 *
 * Withheld until the second part-0 report (review of the first, 2026-11-15):
 * - `stacker` / `spreader`: the pooled stacking mean is ~0.74, so a fixed 0.75 bar labels most
 *   opponents and 0.45 none; and a stack that stays put is board state as much as habit.
 * - `rusher`: `firstStrike` counts once per opponent-game, so its confidence bar needs about a fifth
 *   meeting with the same player; it cannot fire in practice.
 * `turtle` is given only on this game's counts: the first report could not separate a quiet player
 * from a quiet game, so a quiet past is not carried into a label. Nor is it given when it attacked me
 * within the last {@link TURTLE_QUIET_TURNS} turns (`recent`, #264): a quiet rate beside a fresh
 * attack gives the wrong picture of that border.
 */
export function labelsOf(e: Record<HabitName, HabitEstimate>, recent: LabelRecency = {}): ProfileLabel[] {
  const sure = (x: HabitEstimate) => x.confidence >= PROFILE_MIN_CONFIDENCE;
  const out: ProfileLabel[] = [];
  if (sure(e.reinforce) && e.reinforce.value >= 0.6) out.push('reinforcer');
  if (sure(e.reinforce) && e.reinforce.value <= 0.3) out.push('rarely-reinforces');
  if (sure(e.attack) && e.attack.basis === 'this-game' && e.attack.value <= 0.2 && !attackedRecently(recent)) out.push('turtle');
  if (sure(e.retaliate) && e.retaliate.value >= 0.6) out.push('avenger');
  if (sure(e.retake) && e.retake.value >= 0.6) out.push('retakes');
  return out;
}
