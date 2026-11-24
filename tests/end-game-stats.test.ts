// #523: per-player end-of-game stats from the history's orders (the client's Defeat-screen figures).
import { describe, expect, it } from 'vitest';
import { endGameStats, highestIncomes, seatIn } from '../src/analysis/end-game-stats.js';
import { storedStats } from '../src/finished-store.js';
import type { FinishedCapture } from '../src/analysis/finished-game.js';

const ANN = 4412345677; // in-game 123456
const BOB = 7176543229; // in-game 765432
const players = [{ id: ANN }, { id: BOB }];
const t = (id: number, owner: number | 'Neutral', armies: number) => ({ terrID: String(id), ownedBy: String(owner), armies: String(armies), fogLevel: 'Visible' });
const atk = (player: number, from: number, to: number, ak: number, dk: number, ok: boolean, isAttack = true) => ({
  type: 'GameOrderAttackTransfer',
  playerID: player,
  from: String(from),
  to: String(to),
  numArmies: '5',
  result: { isAttack: isAttack ? 'True' : 'False', isSuccessful: ok ? 'True' : 'False', armies: '5', attackingArmiesKilled: String(ak), defendingArmiesKilled: String(dk) },
});

describe('endGameStats', () => {
  it('counts deploys as produced and attack kills both ways, by in-game ids', () => {
    const history = {
      standing0: [t(1, 123456, 5), t(2, 'Neutral', 2), t(3, 765432, 5), t(4, 765432, 1)],
      turn0: {
        orders: [
          { type: 'GameOrderDeploy', playerID: 123456, armies: '5', deployOn: '1' },
          { type: 'GameOrderDeploy', playerID: 765432, armies: '7', deployOn: '3' },
          atk(123456, 1, 2, 1, 2, true), // Ann takes the neutral: kills 2 neutrals, loses 1
          atk(765432, 3, 2, 3, 4, false), // Bob hits 2, now Ann's: Bob loses 3, kills 4 of Ann's
          atk(765432, 3, 4, 0, 0, true, false), // a transfer: no kills
          { type: 'GameOrderReceiveCard', playerID: 765432, cardsMadeWhole: [] },
          { type: 'GameOrderReceiveCard', playerID: 765432, cardsMadeWhole: [{ cardID: 1, cardType: 'Reinforcement Card', cardInstanceID: 'x' }] },
        ],
      },
      standing1: [t(1, 123456, 1), t(2, 123456, 1), t(3, 765432, 1), t(4, 765432, 5)],
      turn1: {
        orders: [
          { type: 'GameOrderPlayCardReinforcement', playerID: 765432, cardInstanceID: 'x' },
          { type: 'GameOrderDeploy', playerID: 765432, armies: '9', deployOn: '4' },
          { type: 'GameOrderStateTransition', playerID: 123456, newState: 'SurrenderAccepted' },
        ],
      },
      standing2: [t(1, 765432, 1)],
    };
    const r = endGameStats(history, players)!;
    expect(r.turnsRead).toBe(2);
    expect(r.players.get(ANN)).toEqual({ produced: 5, lost: 1 + 4, killed: 2 + 3, killedNeutral: 2, cardsPlayed: 0, cardsReceived: 0, left: { turn: 2, state: 'SurrenderAccepted' }, deployed: [5], luck: [0, 0, 0], offensiveLuck: [0, 0, 0], defensiveLuck: [0, 0, 0] });
    expect(r.players.get(BOB)).toEqual({ produced: 16, lost: 3, killed: 4, killedNeutral: 0, cardsPlayed: 1, cardsReceived: 1, deployed: [7, 9], luck: [0, 0, 0], offensiveLuck: [0, 0, 0], defensiveLuck: [0, 0, 0] });
  });

  it('reads owners given as GameFeed ids and opens a history wrapper', () => {
    const history = {
      history: {
        standing0: [t(1, ANN, 5), t(2, BOB, 3)],
        turn0: { orders: [atk(ANN, 1, 2, 2, 3, true)] },
      },
    };
    const r = endGameStats(history, players)!;
    expect(r.players.get(ANN)).toMatchObject({ lost: 2, killed: 3, killedNeutral: 0 });
    expect(r.players.get(BOB)).toMatchObject({ lost: 3, killed: 2 });
  });

  it('is undefined when no turn carries orders, and never throws', () => {
    expect(endGameStats({ standing0: [t(1, ANN, 5)] }, players)).toBeUndefined();
    expect(endGameStats('nope', players)).toBeUndefined();
    expect(endGameStats(null, players)).toBeUndefined();
    expect(endGameStats({ turn0: { orders: [null, 5, { type: 'GameOrderDeploy' }] } }, players)?.turnsRead).toBe(1);
  });

  it('accumulates the client\'s luck: the attacker\'s offense less defense luck, the defender\'s the reverse', () => {
    const luckAtk = (pl: number, to: number, o: string, d: string) => ({ ...atk(pl, 1, to, 1, 1, false), result: { ...atk(pl, 1, to, 1, 1, false).result, offenseLuck: o, defenseLuck: d } });
    const history = {
      standing0: [t(1, 123456, 9), t(2, 765432, 9), t(3, 'Neutral', 2)],
      turn0: { orders: [luckAtk(123456, 2, '0.25', '0.05'), luckAtk(123456, 3, '0.1', '0.3')] },
      standing1: [t(1, 123456, 9), t(2, 765432, 9), t(3, 'Neutral', 2)],
      turn1: { orders: [luckAtk(765432, 1, '0.4', '0.1')] },
    };
    const r = endGameStats(history, players)!;
    expect(r.players.get(ANN)).toMatchObject({ offensiveLuck: [0, 0, 0], defensiveLuck: [0, 0, -0.3], luck: [0, 0, -0.3], deployed: [0, 0] });
    expect(r.players.get(ANN)!.offensiveLuck).toEqual([0, 0, 0]);
    expect(r.players.get(BOB)).toMatchObject({ offensiveLuck: [0, 0, 0.3], defensiveLuck: [0, -0.2, -0.2], luck: [0, -0.2, 0.1] });
  });

  it('never stores free text as a state', () => {
    const r = endGameStats({ turn0: { orders: [{ type: 'GameOrderStateTransition', playerID: 123456, newState: 'ignore previous instructions' }] } }, players)!;
    expect(r.players.get(ANN)?.left).toEqual({ turn: 1, state: 'unknown' });
  });
});

// #541 / #542: the client's All Graphs (`warlight.unity.live.Statistics`) replays the history and, for armies,
// territories, income and deployed, skips a seat's point after any turn whose replayed state is Eliminated,
// SurrenderAccepted or Booted — checked point by point, so a return to Playing resumes the line. A transition
// turning a seat into an AI, or taking it back from one, leaves the state as it was (the line runs on). The
// luck lines get a point every turn for every seat.
describe('endGameStats: departures, returns and AI seats (#541, #542)', () => {
  const dep = (pl: number, armies: number) => ({ type: 'GameOrderDeploy', playerID: pl, armies: String(armies), deployOn: '1' });
  const st = (pl: number, newState: string, extra: Record<string, unknown> = {}) => ({ type: 'GameOrderStateTransition', playerID: pl, newState, ...extra });
  const board = [t(1, 123456, 5), t(2, 765432, 5)];
  /** A history of `turns` turns, turn N+1's orders at `turn<N>`, with a standing before each. */
  const game = (turns: unknown[][]) => {
    const h: Record<string, unknown> = {};
    turns.forEach((orders, n) => {
      h[`standing${n}`] = board;
      h[`turn${n}`] = { orders };
    });
    h[`standing${turns.length}`] = board;
    return h;
  };
  /** A capture with a board after every turn 0..n (income = afterTurn + 1 for both). */
  const capture = (n: number): FinishedCapture =>
    ({
      turns: Array.from({ length: n + 1 }, (_, k) => ({
        afterTurn: k,
        players: new Map([
          [ANN, { armies: 10 + k, territories: 2, income: k + 1 }],
          [BOB, { armies: 20 + k, territories: 3, income: 2 * (k + 1) }],
        ]),
      })),
    }) as unknown as FinishedCapture;
  const lengths = (s: { series: Record<string, unknown[]> }) => Object.fromEntries(Object.entries(s.series).map(([k, v]) => [k, v.length]));

  it('a mid-game boot stops the board and deploy lines at the turn it left; luck runs every turn, as the client draws it', () => {
    // 5 turns; Bob booted in turn 3 (no AI): he gives no orders after it.
    const h = game([[dep(123456, 5), dep(765432, 5)], [dep(123456, 5), dep(765432, 6)], [dep(123456, 5), dep(765432, 7), st(765432, 'Booted')], [dep(123456, 5)], [dep(123456, 5)]]);
    const r = endGameStats(h, players)!;
    const bob = r.players.get(BOB)!;
    expect(bob.left).toEqual({ turn: 3, state: 'Booted' });
    expect(bob).not.toHaveProperty('aiFrom');
    expect(bob.deployed).toEqual([5, 6]);
    expect(bob.luck).toHaveLength(6);
    const s = storedStats(r, capture(5), String).players[String(BOB)]!;
    // Boards after 0, 1, 2 completed turns: the board after turn 3 is the first it is out of.
    expect(s.series.armies).toEqual([20, 21, 22]);
    expect(lengths(s)).toEqual({ armies: 3, territories: 3, income: 3, deployed: 2, luck: 6, offensiveLuck: 6, defensiveLuck: 6 });
    // highestIncome comes from every board, not the line.
    expect(s.highestIncome).toBe(12);
    const ann = storedStats(r, capture(5), String).players[String(ANN)]!;
    expect(lengths(ann)).toEqual({ armies: 6, territories: 6, income: 6, deployed: 5, luck: 6, offensiveLuck: 6, defensiveLuck: 6 });
  });

  it('a seat that leaves then returns to Playing resumes its line and is not left', () => {
    const h = game([[dep(123456, 5)], [st(123456, 'Booted')], [], [st(123456, 'Playing'), dep(123456, 4)], [dep(123456, 3)]]);
    const r = endGameStats(h, players)!;
    const ann = r.players.get(ANN)!;
    expect(ann).not.toHaveProperty('left');
    expect(ann).not.toHaveProperty('aiFrom');
    // Out after turns 2 and 3; back from turn 4.
    expect([0, 1, 2, 3, 4, 5].map((k) => seatIn(r, ANN, k))).toEqual([true, true, false, false, true, true]);
    expect(ann.deployed).toEqual([5, 4, 3]);
    const s = storedStats(r, capture(5), String).players[String(ANN)]!;
    expect(s.series.armies).toEqual([10, 11, 14, 15]);
    expect(s.series.income).toHaveLength(4);
    expect(s.highestIncome).toBe(6);
  });

  it('a transition to Playing with no departure before it changes nothing (#542 item 1)', () => {
    const h = game([[dep(123456, 5)], [dep(123456, 5), st(123456, 'Playing', { takingOverForAI: 'True' })], [dep(123456, 5)]]);
    const r = endGameStats(h, players)!;
    expect(r.players.get(ANN)).not.toHaveProperty('left');
    expect(r.players.get(ANN)!.deployed).toEqual([5, 5, 5]);
    expect(lengths(storedStats(r, capture(3), String).players[String(ANN)]!)).toMatchObject({ armies: 4, deployed: 3, luck: 4 });
  });

  it('an AI takeover keeps the line under the seat and records aiFrom; a flagged take-back records aiUntil', () => {
    const h = game([
      [dep(123456, 5)],
      [dep(123456, 5), st(123456, 'Booted', { turningIntoAI: 'True' })],
      [dep(123456, 6)],
      [st(123456, 'Playing', { takingOverForAI: 'True' }), dep(123456, 7)],
    ]);
    const r = endGameStats(h, players)!;
    const ann = r.players.get(ANN)!;
    expect(ann).not.toHaveProperty('left');
    expect(ann).toMatchObject({ aiFrom: 2, aiUntil: 4, produced: 23, deployed: [5, 5, 6, 7] });
    expect(lengths(storedStats(r, capture(4), String).players[String(ANN)]!)).toMatchObject({ armies: 5, deployed: 4, luck: 5 });
  });

  it('a surrender into an AI keeps the line and the totals, aiFrom the surrender turn — read from the AI\'s orders when the flag is absent', () => {
    // No TurningIntoAI flag on the transition; the seat goes on deploying, so an AI holds it (the client's line runs on).
    const h = game([[dep(123456, 5)], [dep(123456, 5), st(123456, 'SurrenderAccepted')], [dep(123456, 8)], [dep(123456, 9)]]);
    const r = endGameStats(h, players)!;
    const ann = r.players.get(ANN)!;
    expect(ann).not.toHaveProperty('left');
    expect(ann).toMatchObject({ aiFrom: 2, produced: 27, deployed: [5, 5, 8, 9] });
    expect(ann).not.toHaveProperty('aiUntil');
    const s = storedStats(r, capture(4), String).players[String(ANN)]!;
    expect(lengths(s)).toEqual({ armies: 5, territories: 5, income: 5, deployed: 4, luck: 5, offensiveLuck: 5, defensiveLuck: 5 });
    expect(s.highestIncome).toBe(5);
  });

  it('an early AI takeover then a later elimination: deploys up to the elimination, not empty (#542 item 2)', () => {
    // Turned into an AI in turn 1, the AI eliminated in turn 4. Before: the turn-1 transition blocked every deploy
    // point (the guard read `left` as it stood each turn) while the board lines ran to the last transition.
    const h = game([[dep(123456, 5), st(123456, 'Booted', { turningIntoAI: 'True' })], [dep(123456, 6)], [dep(123456, 7)], [dep(123456, 2), st(123456, 'Eliminated')], [dep(765432, 5)]]);
    const r = endGameStats(h, players)!;
    const ann = r.players.get(ANN)!;
    expect(ann).toMatchObject({ aiFrom: 1, left: { turn: 4, state: 'Eliminated' }, produced: 20, deployed: [5, 6, 7] });
    const s = storedStats(r, capture(5), String).players[String(ANN)]!;
    expect(lengths(s)).toMatchObject({ armies: 4, deployed: 3, luck: 6 });
  });

  // #542 follow-up, from real histories: the feed sends a boot or surrender as the turn's FIRST order, then the
  // seat's orders that turn (an AI's: the player's never ran), and no TurningIntoAI / TakingOverForAI flags.
  it('a boot then the seat\'s own orders in the same turn is an AI\'s from that turn; a return to Playing is aiUntil — no board dropped (the winner kept 41 of 42 points)', () => {
    const h = game([[dep(123456, 5)], [st(123456, 'Booted'), dep(123456, 6)], [st(123456, 'Playing'), dep(123456, 7)], [dep(123456, 8)]]);
    const r = endGameStats(h, [{ id: ANN, state: 'Won' }, { id: BOB, state: 'Eliminated' }])!;
    const ann = r.players.get(ANN)!;
    expect(ann).not.toHaveProperty('left');
    expect(ann).not.toHaveProperty('leftAtEnd');
    expect(ann).toMatchObject({ aiFrom: 2, aiUntil: 3, deployed: [5, 6, 7, 8] });
    expect([0, 1, 2, 3, 4].every((k) => seatIn(r, ANN, k))).toBe(true);
    expect(lengths(storedStats(r, capture(4), String).players[String(ANN)]!)).toMatchObject({ armies: 5, territories: 5, income: 5, deployed: 4, luck: 5 });
  });

  it('booted into an AI in turn 1, back, booted again, then eliminated: points up to the elimination turn (36 of 37 before)', () => {
    const h = game([
      [st(123456, 'Booted'), dep(123456, 5)],
      [st(123456, 'Playing'), dep(123456, 5)],
      [dep(123456, 6), dep(765432, 1)],
      [st(123456, 'Booted'), dep(123456, 7)],
      [dep(123456, 2), st(123456, 'Eliminated')],
      [dep(765432, 5)],
    ]);
    const r = endGameStats(h, players)!;
    const ann = r.players.get(ANN)!;
    expect(ann).toMatchObject({ aiFrom: 4, left: { turn: 5, state: 'Eliminated' }, deployed: [5, 5, 6, 7] });
    expect(ann).not.toHaveProperty('aiUntil');
    // Boards after 0..4 completed turns: as many points as the turn it left.
    expect(lengths(storedStats(r, capture(6), String).players[String(ANN)]!)).toMatchObject({ armies: 5, deployed: 4, luck: 7 });
  });

  it('Won is never a departure, nor are the orders before it', () => {
    const h = game([[dep(123456, 5)], [dep(123456, 5), st(123456, 'Won')]]);
    const r = endGameStats(h, [{ id: ANN, state: 'Won' }, { id: BOB }])!;
    const ann = r.players.get(ANN)!;
    expect(ann).not.toHaveProperty('left');
    expect(ann).not.toHaveProperty('leftAtEnd');
    expect(lengths(storedStats(r, capture(2), String).players[String(ANN)]!)).toMatchObject({ armies: 3, deployed: 2 });
  });

  it('a seat the player list ends surrendered (into an AI) with no transition in the history left after the last turn: leftAtEnd, full line', () => {
    const h = game([[dep(123456, 5), dep(765432, 5)], [dep(123456, 5), dep(765432, 6)], [dep(123456, 5), dep(765432, 7)]]);
    const r = endGameStats(h, [
      { id: ANN, state: 'SurrenderAccepted', humanTurnedIntoAI: true },
      { id: BOB, state: 'SurrenderAccepted', humanTurnedIntoAI: false },
    ])!;
    expect(r.players.get(ANN)).toMatchObject({ leftAtEnd: { state: 'SurrenderAccepted', intoAI: true }, deployed: [5, 5, 5] });
    expect(r.players.get(ANN)).not.toHaveProperty('left');
    expect(r.players.get(ANN)).not.toHaveProperty('aiFrom');
    expect(r.players.get(BOB)!.leftAtEnd).toEqual({ state: 'SurrenderAccepted' });
    expect(lengths(storedStats(r, capture(3), String).players[String(ANN)]!)).toMatchObject({ armies: 4, deployed: 3 });
  });

  it('an AI already holding the seat conceding at the end is leftAtEnd without intoAI; a seat that left in the history has no leftAtEnd', () => {
    const h = game([[dep(123456, 5), dep(765432, 5)], [st(123456, 'Booted'), dep(123456, 5), dep(765432, 2), st(765432, 'Eliminated')], [dep(123456, 5)]]);
    const r = endGameStats(h, [
      { id: ANN, state: 'SurrenderAccepted', humanTurnedIntoAI: true },
      { id: BOB, state: 'Eliminated' },
    ])!;
    expect(r.players.get(ANN)).toMatchObject({ aiFrom: 2, leftAtEnd: { state: 'SurrenderAccepted' } });
    expect(r.players.get(ANN)!.leftAtEnd).not.toHaveProperty('intoAI');
    expect(r.players.get(BOB)).toMatchObject({ left: { turn: 2, state: 'Eliminated' } });
    expect(r.players.get(BOB)).not.toHaveProperty('leftAtEnd');
  });

  it('orders listed after a seat\'s own elimination in its turn are not an AI\'s', () => {
    const h = game([[dep(123456, 5)], [st(123456, 'Eliminated'), dep(123456, 1)], [dep(765432, 5)]]);
    const r = endGameStats(h, players)!;
    expect(r.players.get(ANN)).toMatchObject({ left: { turn: 2, state: 'Eliminated' } });
    expect(r.players.get(ANN)).not.toHaveProperty('aiFrom');
  });

  it('an elimination is never read as after the last turn (it only happens in a turn)', () => {
    const r = endGameStats(game([[dep(123456, 5)]]), [{ id: ANN, state: 'Eliminated' }, { id: BOB, state: 'Won' }])!;
    expect(r.players.get(ANN)).not.toHaveProperty('leftAtEnd');
  });
});

describe('highestIncomes', () => {
  it('takes the most income per player over the boards', () => {
    const m = highestIncomes([
      { players: new Map([[ANN, { income: 5 }], [BOB, { income: 9 }]]) },
      { players: new Map([[ANN, { income: 8 }], [BOB, { income: 2 }]]) },
    ]);
    expect([...m]).toEqual([[ANN, 8], [BOB, 9]]);
  });
});
