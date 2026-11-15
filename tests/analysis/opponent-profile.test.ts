// Opponent profiling, part A1 (docs/PLAN-PROFILES.md section 8): each primitive in miniature on
// the tiny map (1–2–3 triangle, 3–4–5–6–7 line), with every "no opportunity" exit, and the habits
// re-derived from the same turns stay the same.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import type { MyOrders } from '../../src/analysis/opponents.js';
import {
  estimate,
  estimateHabits,
  habitsOf,
  labelsOf,
  observeTurn,
  type ObserveInput,
  type TurnPrimitives,
} from '../../src/analysis/opponent-profile.js';
import type { BoardState } from '../../src/board.js';
import { board, fogged, mine, neutral, tinyMap } from './helpers.js';

const ME = 10;
const OPP = 20;
const OTHER = 30;
const g = buildGraph(tinyMap());
const its = (id: number, armies: number) => mine(id, armies, OPP);
const other = (id: number, armies: number) => mine(id, armies, OTHER);
const attack = (from: number, to: number, armies: number, deploys: MyOrders['deploys'] = []): MyOrders => ({ deploys, moves: [{ from, to, armies }] });

/** The cards in play default to none; `'unknown'` leaves them unstated (settings not read). */
function observe(
  previous: BoardState,
  current: BoardState,
  orders?: MyOrders,
  settings: ObserveInput['settings'] = {},
  opponents = [OPP],
  cards: readonly string[] | 'unknown' = [],
) {
  return observeTurn({ graph: g, me: ME, previous, current, orders, settings, opponents, ...(cards === 'unknown' ? {} : { cards }) });
}
/** Territories 1 and 2 (3's other neighbours) shown as neutrals, so a test of 3 sees every neighbour. */
const shown = [neutral(1, 2), neutral(2, 2)];
const of = (m: Map<number, TurnPrimitives>, p = OPP) => m.get(p)!;

describe('observeTurn: reinforce', () => {
  // I hold 3 with 10; it holds 4 with 2. 5 armies take 2 defenders with 4 surviving (60/70, exact).
  const before = board([mine(3, 10), its(4, 2)]);

  it('a failed attack that should have captured is an event, with the least extra armies that explain it', () => {
    // It stood on 5: my 5 kill 3, leaving 2; 1 of mine comes back to 3.
    const p = of(observe(before, board([mine(3, 6), its(4, 2)]), attack(3, 4, 5)));
    expect(p.reinforce).toEqual({ n: 1, e: 1, extra: 3 });
    expect(p.iAttacked).toBe(true);
  });

  it('a capture with the exact survivors is an opportunity without an event', () => {
    const p = of(observe(before, board([mine(3, 5), mine(4, 4)]), attack(3, 4, 5)));
    expect(p.reinforce).toEqual({ n: 1, e: 0, extra: 0 });
    expect(p.lostToMe).toEqual([4]);
  });

  it('a capture with fewer survivors than the exact result is an event', () => {
    // 4 defenders kill round(2.8) = 3 of my 5: 2 survive instead of 4: it stood on 4, two above the board.
    const p = of(observe(before, board([mine(3, 5), mine(4, 2)]), attack(3, 4, 5)));
    expect(p.reinforce).toEqual({ n: 1, e: 1, extra: 2 });
  });

  it('an attack too small to capture is an event only when more defenders are left than the exact result', () => {
    const small = board([mine(3, 10), its(4, 4)]);
    // 2 attackers kill 1 of 4: 3 left, exactly as expected.
    expect(of(observe(small, board([mine(3, 8), its(4, 3)]), attack(3, 4, 2))).reinforce).toEqual({ n: 1, e: 0, extra: 0 });
    // 5 left: it stood on 6.
    expect(of(observe(small, board([mine(3, 8), its(4, 5)]), attack(3, 4, 2))).reinforce).toEqual({ n: 1, e: 1, extra: 2 });
  });

  it('gives no opportunity with luck on, weighted rounding, two moves onto the target, the source hit first, a fog reveal or unknown orders', () => {
    const failed = board([mine(3, 6), its(4, 2)]);
    expect(of(observe(before, failed, attack(3, 4, 5), { luckModifier: 0.16 })).reinforce.n).toBe(0);
    expect(of(observe(before, failed, attack(3, 4, 5), { roundingMode: 'WeightedRandom' })).reinforce.n).toBe(0);
    // Two of my moves onto 4 (from 3 and from 5).
    const two: MyOrders = { deploys: [], moves: [{ from: 3, to: 4, armies: 5 }, { from: 5, to: 4, armies: 3 }] };
    expect(of(observe(board([mine(3, 10), its(4, 2), mine(5, 5)]), board([mine(3, 6), its(4, 2), mine(5, 3)]), two)).reinforce.n).toBe(0);
    // The source holds 3 instead of the 5 my orders leave: it was hit first.
    expect(of(observe(before, board([mine(3, 3), mine(4, 4)]), attack(3, 4, 5))).reinforce.n).toBe(0);
    // The source lost to someone: not mine at the end.
    expect(of(observe(before, board([other(3, 2), its(4, 2)]), attack(3, 4, 5))).reinforce.n).toBe(0);
    // The target was hidden on the earlier board: a reveal, not a reading.
    expect(of(observe(board([mine(3, 10), fogged(4)]), failed, attack(3, 4, 5))).reinforce.n).toBe(0);
    // Hidden on the later board.
    expect(of(observe(before, board([mine(3, 6), fogged(4)]), attack(3, 4, 5))).reinforce.n).toBe(0);
    // No orders known.
    expect(of(observe(before, failed)).reinforce.n).toBe(0);
    // An order the source could not pay for (sends what is left).
    expect(of(observe(before, board([mine(3, 1), its(4, 2)]), attack(3, 4, 12))).reinforce.n).toBe(0);
  });

  it('counts a deploy on the source in what my orders leave', () => {
    const p = of(observe(board([mine(3, 3), its(4, 2)]), board([mine(3, 1), mine(4, 4)]), attack(3, 4, 5, [{ territoryId: 3, armies: 3 }])));
    expect(p.reinforce).toEqual({ n: 1, e: 0, extra: 0 });
  });
});

describe('observeTurn: attackedMe, contact, captures', () => {
  it('a capture from me is an attack, orders or not', () => {
    const p = of(observe(board([mine(3, 2), its(4, 9)]), board([its(3, 5), its(4, 1)])));
    expect(p).toMatchObject({ contact: true, attackedMe: true, tookFromMe: [3], lostToMe: [] });
  });

  it('without my orders and without a capture it cannot tell', () => {
    expect(of(observe(board([mine(3, 5), its(4, 9)]), board([mine(3, 2), its(4, 6)]))).attackedMe).toBeNull();
  });

  it('with my orders, fewer armies than they leave on a border it stands beside is an attack; as many is not', () => {
    const orders: MyOrders = { deploys: [{ territoryId: 3, armies: 2 }], moves: [] };
    const prev = board([...shown, mine(3, 5), its(4, 9)]);
    expect(of(observe(prev, board([...shown, mine(3, 4), its(4, 6)]), orders)).attackedMe).toBe(true);
    expect(of(observe(prev, board([...shown, mine(3, 7), its(4, 9)]), orders)).attackedMe).toBe(false);
  });

  it('a neighbour whose owner the earlier board hides may hold the attacker: no reading', () => {
    const orders: MyOrders = { deploys: [], moves: [] };
    // 2 is fogged: another player may stand there and have hit 3.
    expect(of(observe(board([neutral(1, 2), fogged(2), mine(3, 5), its(4, 9)]), board([neutral(1, 2), fogged(2), mine(3, 2), its(4, 9)]), orders)).attackedMe).toBeNull();
    // 1 is not on the board at all: the same.
    expect(of(observe(board([neutral(2, 2), mine(3, 5), its(4, 9)]), board([neutral(2, 2), mine(3, 2), its(4, 9)]), orders)).attackedMe).toBeNull();
  });

  it('a Transfer Only, percentage or Attack Only order out of or into a border leaves it untested (only `sent` holds them)', () => {
    // I hold 2 and 3; 3 sends armies to 2 by an order `moves` leaves out: 3 drops from 5 to 2.
    const prev = board([neutral(1, 2), mine(2, 5), mine(3, 5), its(4, 9)]);
    const now = board([neutral(1, 2), mine(2, 8), mine(3, 2), its(4, 9)]);
    const transferOnly: MyOrders = { deploys: [], moves: [], sent: [{ from: 3, to: 2, transferOnly: true }] };
    expect(of(observe(prev, now, transferOnly)).attackedMe).toBeNull();
    const percentage: MyOrders = { deploys: [], moves: [], sent: [{ from: 3, to: 2 }] };
    expect(of(observe(prev, now, percentage)).attackedMe).toBeNull();
    // Into it: 2 sends to 3 by percentage; 3 is not tested either way.
    const inward: MyOrders = { deploys: [], moves: [], sent: [{ from: 2, to: 3 }] };
    expect(of(observe(prev, board([neutral(1, 2), mine(2, 2), mine(3, 8), its(4, 9)]), inward)).attackedMe).toBeNull();
    // The same drop with the move in `moves` too is no attack: the order is measured.
    const plain: MyOrders = { deploys: [], moves: [{ from: 3, to: 2, armies: 3 }], sent: [{ from: 3, to: 2 }] };
    expect(of(observe(prev, now, plain)).attackedMe).toBe(false);
  });

  it('an Attack Only order onto its territory counts as my attack, a Transfer Only one does not', () => {
    const prev = board([...shown, mine(3, 10), its(4, 2)]);
    const now = board([...shown, mine(3, 6), its(4, 2)]);
    expect(of(observe(prev, now, { deploys: [], moves: [], sent: [{ from: 3, to: 4 }] })).iAttacked).toBe(true);
    expect(of(observe(prev, now, { deploys: [], moves: [], sent: [{ from: 3, to: 4, transferOnly: true }] })).iAttacked).toBe(false);
  });

  it('an Airlift of mine out of or into a border leaves it untested, and an unrecorded one may have', () => {
    const prev = board([...shown, mine(3, 5), its(4, 9)]);
    const now = board([...shown, mine(3, 2), its(4, 9)]);
    const airlift: MyOrders = { deploys: [], moves: [], cards: [{ card: 'Airlift', from: 3, to: 1 }] };
    expect(of(observe(prev, now, airlift, {}, [OPP], ['Airlift'])).attackedMe).toBeNull();
    // Orders cached without their card plays: an Airlift may have run when the game has the card, or its cards are unknown.
    const unrecorded: MyOrders = { deploys: [], moves: [] };
    expect(of(observe(prev, now, unrecorded, {}, [OPP], ['Airlift'])).attackedMe).toBeNull();
    expect(of(observe(prev, now, unrecorded, {}, [OPP], 'unknown')).attackedMe).toBeNull();
    // Recorded as none, or the card not in play: the drop is an attack.
    expect(of(observe(prev, now, { ...unrecorded, cards: [] }, {}, [OPP], ['Airlift'])).attackedMe).toBe(true);
    expect(of(observe(prev, now, unrecorded, {}, [OPP], ['Reinforcement'])).attackedMe).toBe(true);
  });

  it('an Airlift touching an attack, or one that may have run unrecorded, gives no reinforce reading', () => {
    const before = board([mine(3, 10), its(4, 2)]);
    const failed = board([mine(3, 6), its(4, 2)]);
    const o = attack(3, 4, 5);
    expect(of(observe(before, failed, { ...o, cards: [{ card: 'Airlift', from: 7, to: 3 }] }, {}, [OPP], ['Airlift'])).reinforce.n).toBe(0);
    expect(of(observe(before, failed, o, {}, [OPP], ['Airlift'])).reinforce.n).toBe(0);
    expect(of(observe(before, failed, { ...o, cards: [] }, {}, [OPP], ['Airlift'])).reinforce.n).toBe(1);
    // A second order onto the target that only `sent` holds (Attack Only): two moves onto it.
    expect(of(observe(before, failed, { ...o, sent: [{ from: 3, to: 4 }, { from: 5, to: 4 }] })).reinforce.n).toBe(0);
  });

  it('a territory I gave it with a Gift card is no capture; one I may have given unrecorded is not counted', () => {
    const prev = board([mine(3, 2), its(4, 9)]);
    const now = board([its(3, 2), its(4, 9)]);
    const gift: MyOrders = { deploys: [], moves: [], cards: [{ card: 'Gift', target: 3 }] };
    expect(of(observe(prev, now, gift, {}, [OPP], ['Gift']))).toMatchObject({ tookFromMe: [], attackedMe: null });
    // No orders known in a game with Gift (or cards unknown): the change may be a gift.
    expect(of(observe(prev, now, undefined, {}, [OPP], ['Gift']))).toMatchObject({ tookFromMe: [], attackedMe: null });
    expect(of(observe(prev, now, undefined, {}, [OPP], 'unknown'))).toMatchObject({ tookFromMe: [], attackedMe: null });
    // Without the card in play, or with my card plays recorded as none, it is a capture.
    expect(of(observe(prev, now, undefined, {}, [OPP], ['Airlift']))).toMatchObject({ tookFromMe: [3], attackedMe: true });
    expect(of(observe(prev, now, { deploys: [], moves: [], cards: [] }, {}, [OPP], ['Gift']))).toMatchObject({ tookFromMe: [3], attackedMe: true });
  });

  it('a border two players stand beside cannot say which attacked', () => {
    const orders: MyOrders = { deploys: [], moves: [] };
    // 3 borders 4 (its) and 2 (another player's).
    const p = observe(board([neutral(1, 2), mine(3, 5), its(4, 9), other(2, 9)]), board([neutral(1, 2), mine(3, 2), its(4, 9), other(2, 9)]), orders, {}, [OPP, OTHER]);
    expect(of(p).attackedMe).toBeNull();
    expect(of(p, OTHER).attackedMe).toBeNull();
  });

  it('no contact when its territories border none of mine; a fogged neighbour is no contact', () => {
    expect(of(observe(board([mine(1, 5), its(5, 3)]), board([mine(1, 5), its(5, 3)]))).contact).toBe(false);
    expect(of(observe(board([mine(3, 5), fogged(4)]), board([mine(3, 5), fogged(4)]))).contact).toBe(false);
  });
});

describe('observeTurn: stack', () => {
  it('the largest growth and the total over its territories shown on both boards', () => {
    const p = of(observe(board([its(4, 2), its(5, 2), its(6, 2)]), board([its(4, 5), its(5, 3), its(6, 1)])));
    expect(p.stack).toEqual({ top: 3, total: 4 });
  });

  it('null with one territory, with no growth, or when the second is a fog reveal', () => {
    expect(of(observe(board([its(4, 2)]), board([its(4, 5)]))).stack).toBeNull();
    expect(of(observe(board([its(4, 2), its(5, 2)]), board([its(4, 2), its(5, 1)]))).stack).toBeNull();
    expect(of(observe(board([its(4, 2), fogged(5)]), board([its(4, 5), its(5, 9)]))).stack).toBeNull();
  });
});

const turn = (over: Partial<TurnPrimitives> = {}): TurnPrimitives => ({
  contact: false,
  attackedMe: null,
  iAttacked: false,
  reinforce: { n: 0, e: 0, extra: 0 },
  stack: null,
  tookFromMe: [],
  lostToMe: [],
  ...over,
});

describe('habitsOf', () => {
  it('adds the rates, the stacking size and the reinforce extra', () => {
    const h = habitsOf([
      { turn: 3, primitives: turn({ contact: true, attackedMe: true, reinforce: { n: 2, e: 1, extra: 3 }, stack: { top: 3, total: 4 } }) },
      { turn: 4, primitives: turn({ contact: true, attackedMe: false, reinforce: { n: 1, e: 1, extra: 1 }, stack: { top: 1, total: 2 } }) },
      { turn: 5, primitives: turn({ contact: true, attackedMe: null }) },
    ]);
    expect(h.reinforce).toEqual({ e: 2, n: 3 });
    expect(h.reinforceExtra).toEqual({ n: 2, sum: 4 });
    expect(h.attack).toEqual({ e: 1, n: 2 });
    expect(h.stacking).toEqual({ n: 2, sum: 1.25, sq: 0.8125 });
    expect(h.turns).toBe(3);
  });

  it('a first strike needs a fresh contact lasting two turns', () => {
    const fresh = habitsOf([
      { turn: 2, primitives: turn() },
      { turn: 3, primitives: turn({ contact: true, attackedMe: false }) },
      { turn: 4, primitives: turn({ contact: true, attackedMe: true }) },
    ]);
    expect(fresh.firstStrike).toEqual({ e: 1, n: 1 });
    // Contact already on the first turn observed (not turn 1): not a first contact.
    expect(habitsOf([{ turn: 3, primitives: turn({ contact: true, attackedMe: true }) }, { turn: 4, primitives: turn({ contact: true, attackedMe: true }) }]).firstStrike.n).toBe(0);
    // Turn 1 is always fresh; both turns quiet is a non-event.
    expect(habitsOf([{ turn: 1, primitives: turn({ contact: true, attackedMe: false }) }, { turn: 2, primitives: turn({ contact: true, attackedMe: false }) }]).firstStrike).toEqual({ e: 0, n: 1 });
    // Contact lasting one turn: no opportunity.
    expect(habitsOf([{ turn: 1, primitives: turn({ contact: true, attackedMe: false }) }, { turn: 2, primitives: turn() }]).firstStrike.n).toBe(0);
  });

  it('retaliate and retake look two turns ahead, and wait while those turns are unknown', () => {
    const turns = [
      { turn: 5, primitives: turn({ iAttacked: true, lostToMe: [4] }) },
      { turn: 6, primitives: turn({ attackedMe: false }) },
      { turn: 7, primitives: turn({ attackedMe: true, tookFromMe: [4] }) },
    ];
    expect(habitsOf(turns)).toMatchObject({ retaliate: { e: 1, n: 1 }, retake: { e: 1, n: 1 } });
    // Turn 7 not observed yet: neither can be told.
    expect(habitsOf(turns.slice(0, 2))).toMatchObject({ retaliate: { e: 0, n: 0 }, retake: { e: 0, n: 0 } });
    // Both later turns told and quiet: non-events.
    const quiet = [turns[0]!, turns[1]!, { turn: 7, primitives: turn({ attackedMe: false }) }];
    expect(habitsOf(quiet)).toMatchObject({ retaliate: { e: 0, n: 1 }, retake: { e: 0, n: 1 } });
  });

  it('is stable: the same turns in any order, or listed twice, give the same habits', () => {
    const turns = [
      { turn: 1, primitives: turn({ contact: true, attackedMe: false, reinforce: { n: 1, e: 1, extra: 2 } }) },
      { turn: 2, primitives: turn({ contact: true, attackedMe: true, iAttacked: true, lostToMe: [3] }) },
      { turn: 3, primitives: turn({ contact: true, attackedMe: true, tookFromMe: [3], stack: { top: 2, total: 2 } }) },
      { turn: 4, primitives: turn({ contact: true, attackedMe: false }) },
    ];
    const once = habitsOf(turns);
    expect(habitsOf([...turns].reverse())).toEqual(once);
    expect(habitsOf([...turns, ...turns])).toEqual(once);
    expect(habitsOf(turns)).toEqual(once);
  });
});

describe('the estimate and the labels', () => {
  it('shrinks toward the default by K = 4, and names what contributed most', () => {
    expect(estimate(0, 0, 0.5)).toEqual({ value: 0.5, n: 0, confidence: 0, basis: 'default' });
    expect(estimate(6, 6, 0.5)).toEqual({ value: 0.8, n: 6, confidence: 0.6, basis: 'this-game' });
    expect(estimate(0, 6, 0.5)).toEqual({ value: 0.2, n: 6, confidence: 0.6, basis: 'this-game' });
  });

  it('labels only at the confidence bar', () => {
    const base = habitsOf([]);
    expect(labelsOf(estimateHabits({ ...base, reinforce: { e: 6, n: 6 } }))).toEqual(['reinforcer']);
    expect(labelsOf(estimateHabits({ ...base, reinforce: { e: 0, n: 6 } }))).toEqual(['rarely-reinforces']);
    expect(labelsOf(estimateHabits({ ...base, reinforce: { e: 3, n: 3 } }))).toEqual([]);
    expect(labelsOf(estimateHabits({ ...base, attack: { e: 0, n: 8 } }))).toEqual(['turtle']);
  });
});
