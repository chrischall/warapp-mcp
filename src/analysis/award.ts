// What the award of picks reveals (#166). Pure and deterministic; no I/O.
//
// Picks are awarded round by round in move order, the order reversing each round, each player
// getting the highest-ranked territory of their own list that is still free (the community wiki's
// Manual distribution page; `pickOutcomes` in ./picks.ts enumerates what a list can yield). So once
// the territories I start on are known, my own list says things about the others:
//  - a territory I listed and was not granted, while a lower-ranked one was, had been taken: it is
//    another player's start. In a two-player game it is the opponent's.
//  - in a two-player game the award order is A B B A A B …, and some granted sets can come about
//    only as the first awarded, others only as the second (my k-th granted pick being list number
//    2k is exactly that case). Under a cyclic move order the award is turn 0 of the cycle, so the
//    first awarded moves second on turn 1 (the wiki's Move order page) and the order alternates.
//  - a commander starts on its owner's first awarded territory (the wiki's Commanders page), so
//    when every award that fits gives the opponent the same first territory of my list, its
//    commander started there.
// With two players the reading is exact: every award that fits what I was granted is enumerated
// (the opponent's own list is unknown, so each of its awards may be any free territory of my list
// or one outside it), and only what holds in all of them is reported. With three or more players
// only the first point is read, and not whose start it is.

import { impliedOpponentStarts } from './picks.js';

export type AwardRole = 'first' | 'second';

export interface AwardReading {
  /** The territories of my list I was granted, in list order. */
  granted: number[];
  /** Territories I start on that my list does not hold (it ran out), ascending. */
  unlisted: number[];
  /** Territories of my list that are another player's start for certain, in list order. */
  opponentStarts: number[];
  /** Two players: `opponentStarts` is every start the opponent has. */
  allStartsKnown: boolean;
  /** Two players: whether I was awarded first or second, when only one of them gives this start. */
  role: AwardRole | null;
  /**
   * Two players: the territory of my list the opponent was awarded first (where its commander
   * starts), when every award that fits gives the same one.
   */
  opponentFirstAward: number | null;
}

/** Search states {@link readAward} explores before it falls back to the rule that needs none. */
export const MAX_AWARD_READ_STATES = 200_000;

const byNum = (a: number, b: number) => a - b;

/**
 * Read the award from my pick list (in priority order) and the territories I hold on the first
 * board after distribution. `null` when the list cannot explain that start (it is not the list
 * the award used, or the board is not the first one), so nothing is inferred from it.
 */
export function readAward(input: { list: readonly number[]; mine: readonly number[]; players: number }): AwardReading | null {
  const list = [...new Set(input.list)];
  const mine = new Set(input.mine);
  const players = Number.isFinite(input.players) ? Math.floor(input.players) : 0;
  const awards = mine.size;
  if (players < 2 || !list.length || !awards) return null;
  const granted = list.filter((t) => mine.has(t));
  const unlisted = [...mine].filter((t) => !list.includes(t)).sort(byNum);
  const exact = players === 2 && list.length <= 30 ? readDuel(list, granted, awards) : undefined;
  if (exact !== undefined) return exact === null ? null : { granted, unlisted, ...exact };

  // Three or more players (or a duel too large to enumerate): only what needs no award order.
  // A list that ran out left me on territories I never listed: every listed one I lack was taken.
  const theirs = unlisted.length ? list.filter((t) => !mine.has(t)) : impliedOpponentStarts(list, granted);
  if (theirs.length > (players - 1) * awards) return null;
  return { granted, unlisted, opponentStarts: theirs, allStartsKnown: false, role: null, opponentFirstAward: null };
}

type DuelReading = Pick<AwardReading, 'opponentStarts' | 'allStartsKnown' | 'role' | 'opponentFirstAward'>;

/** The opponent's first award: not made yet, or a territory outside my list. */
const NOT_YET = -2;
const OUTSIDE = -1;

/**
 * Every two-player award that fits: `null` when none does, `undefined` when the search would pass
 * {@link MAX_AWARD_READ_STATES} states.
 */
function readDuel(list: readonly number[], granted: readonly number[], awards: number): DuelReading | null | undefined {
  const n = list.length;
  const bit = (i: number) => 1 << i;
  let observed = 0;
  list.forEach((t, i) => {
    if (granted.includes(t)) observed |= bit(i);
  });
  const steps = 2 * awards;
  const seen = new Set<string>();
  const fits: { pos: number; theirs: number; first: number }[] = [];
  let states = 0;
  // pos: my place in the award order (0: awarded first). theirs / got: list positions the opponent / I hold.
  const visit = (pos: number, step: number, theirs: number, got: number, first: number): boolean => {
    const key = `${pos}:${step}:${theirs}:${got}:${first}`;
    if (seen.has(key)) return true;
    seen.add(key);
    if (++states > MAX_AWARD_READ_STATES) return false;
    if (step === steps) {
      if (got === observed) fits.push({ pos, theirs, first });
      return true;
    }
    const round = Math.floor(step / 2);
    const slot = step % 2;
    const mover = round % 2 === 0 ? slot : 1 - slot;
    if (mover === pos) {
      let free = -1;
      for (let i = 0; i < n; i++)
        if (!((theirs | got) & bit(i))) {
          free = i;
          break;
        }
      // My list has run out: I am given a territory I never listed.
      if (free < 0) return visit(pos, step + 1, theirs, got, first);
      // I would have been granted a pick I was not: this award does not fit.
      if (!(observed & bit(free))) return true;
      return visit(pos, step + 1, theirs, got | bit(free), first);
    }
    // The opponent: a territory outside my list, or any free one on it that I was not granted.
    if (!visit(pos, step + 1, theirs, got, first === NOT_YET ? OUTSIDE : first)) return false;
    for (let i = 0; i < n; i++) {
      if ((theirs | got | observed) & bit(i)) continue;
      if (!visit(pos, step + 1, theirs | bit(i), got, first === NOT_YET ? i : first)) return false;
    }
    return true;
  };
  for (let pos = 0; pos < 2; pos++) if (!visit(pos, 0, 0, 0, NOT_YET)) return undefined;
  if (!fits.length) return null;

  let certain = ~0;
  for (const f of fits) certain &= f.theirs;
  const opponentStarts = list.filter((_, i) => certain & bit(i));
  const role = fits.every((f) => f.pos === fits[0]!.pos) ? (fits[0]!.pos === 0 ? 'first' : 'second') : null;
  const first = fits.every((f) => f.first === fits[0]!.first) ? fits[0]!.first : NOT_YET;
  return {
    opponentStarts,
    allStartsKnown: opponentStarts.length === awards,
    role,
    opponentFirstAward: first >= 0 ? list[first]! : null,
  };
}

/** Move orders under which the award order carries into the turns (GameFeed's `MoveOrder`). */
const CYCLIC_ORDERS = new Set(['Cycle', 'NoLuckCycle']);

/**
 * Who moves first on `turn` in a two-player game, from my place in the award: under a cyclic
 * order the award is turn 0 of the cycle, so the first awarded moves second on turn 1, first on
 * turn 2, and so on. `null` under a random (or unknown) order or without a role. An Order
 * Priority or Order Delay card played that turn changes it.
 */
export function firstMoverOnTurn(input: { role: AwardRole | null; turn: number | null; moveOrder: string | undefined }): 'me' | 'opponent' | null {
  const { role, turn, moveOrder } = input;
  if (role === null || turn === null || !Number.isInteger(turn) || turn < 1) return null;
  if (moveOrder === undefined || !CYCLIC_ORDERS.has(moveOrder)) return null;
  const firstAwardedMovesFirst = turn % 2 === 0;
  return (role === 'first') === firstAwardedMovesFirst ? 'me' : 'opponent';
}
