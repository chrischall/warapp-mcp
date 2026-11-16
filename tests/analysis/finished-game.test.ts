// The end-of-game capture (#312 E1), pure parts: the outcome from the player states, each player's
// income and bonuses by turn from the history boards, the starts, the turn I was out, and what stood
// on the target of each failed attack of mine. Synthetic maps and boards only.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import type { MyOrders } from '../../src/analysis/opponents.js';
import {
  captureFinished,
  failedAttacks,
  outcomeOf,
  outTurnOf,
  startsOf,
  turnIncomes,
} from '../../src/analysis/finished-game.js';
import { buildGraph } from '../../src/analysis/graph.js';
import type { GameMap, GameSettings } from '../../src/normalize.js';

const ME = 1001;
const FOE = 1002;

// A line 1-2-3-4-5-6, bonus 100 = {1,2} worth 3, bonus 200 = {5,6} worth 4.
const MAP: GameMap = {
  id: 77,
  name: 'line',
  territories: [1, 2, 3, 4, 5, 6].map((id) => ({ id, name: `t${id}`, connectedTo: [id - 1, id + 1].filter((n) => n >= 1 && n <= 6) })),
  bonuses: [
    { id: 100, name: 'west', value: 3, territoryIds: [1, 2], bonusIds: [] },
    { id: 200, name: 'east', value: 4, territoryIds: [5, 6], bonusIds: [] },
  ],
  distributionModes: [],
};
const G = buildGraph(MAP);
const SETTINGS = { minimumArmyBonus: 5, bonusArmyPer: 0 } as unknown as GameSettings;

const t = (territoryId: number, owner: number | 'neutral', armies: number | null): TerritoryState => ({
  territoryId,
  owner: owner === 'neutral' ? { kind: 'neutral' } : { kind: 'player', playerId: owner },
  armies,
});
const board = (...ts: TerritoryState[]): BoardState => ({ source: 'gamefeed', verified: false, territories: ts });

describe('outcomeOf', () => {
  const players = (mine: string, other = 'Won') => [
    { id: ME, state: mine },
    { id: FOE, state: other },
  ];
  it('names my end from my state', () => {
    expect(outcomeOf(players('Won', 'Eliminated'), ME)).toBe('won');
    expect(outcomeOf(players('Eliminated'), ME)).toBe('eliminated');
    expect(outcomeOf(players('SurrenderAccepted'), ME)).toBe('surrendered');
    expect(outcomeOf(players('Booted'), ME)).toBe('booted');
    expect(outcomeOf(players('EndedByVote', 'EndedByVote'), ME)).toBe('ended-by-vote');
  });
  it('another state is a loss when someone else won, else unknown', () => {
    expect(outcomeOf(players('Playing'), ME)).toBe('lost');
    expect(outcomeOf(players('Playing', 'Playing'), ME)).toBe('unknown');
    expect(outcomeOf(players('Won'), 9999)).toBe('unknown');
  });
});

describe('turnIncomes', () => {
  it('is base + full bonuses (+ per-territory when on), with the bonuses held, territories and armies', () => {
    const b = board(t(1, ME, 3), t(2, ME, 4), t(3, ME, 1), t(5, FOE, 2), t(6, FOE, 2), t(4, 'neutral', 2));
    const out = turnIncomes(G, b, [ME, FOE], SETTINGS);
    expect(out.get(ME)).toEqual({ income: 8, territories: 3, armies: 8, bonuses: [100] });
    expect(out.get(FOE)).toEqual({ income: 9, territories: 2, armies: 4, bonuses: [200] });
    // Per-territory income replaces the base when larger (1 per territory here).
    const per = turnIncomes(G, b, [ME], { minimumArmyBonus: 2, bonusArmyPer: 1 } as unknown as GameSettings);
    expect(per.get(ME)!.income).toBe(3 + 3);
  });
  it('a player with no land earns nothing; hidden armies read as null', () => {
    const b = board(t(1, ME, null), t(4, 'neutral', 2));
    const out = turnIncomes(G, b, [ME, FOE], SETTINGS);
    expect(out.get(ME)!.armies).toBeNull();
    expect(out.get(FOE)).toEqual({ income: 0, territories: 0, armies: 0, bonuses: [] });
  });
});

describe('startsOf and outTurnOf', () => {
  const boards = [
    { turn: 0, board: board(t(1, ME, 2), t(6, FOE, 2), t(3, 'neutral', 2)) },
    { turn: 1, board: board(t(1, ME, 5), t(2, ME, 1), t(6, FOE, 7)) },
    { turn: 2, board: board(t(1, FOE, 3), t(2, FOE, 1), t(6, FOE, 7)) },
  ];
  it('starts are the first board where each player holds land', () => {
    expect(startsOf(boards, [ME, FOE])).toEqual(new Map([[ME, [1]], [FOE, [6]]]));
  });
  it('out is the first board after my land where I hold none', () => {
    expect(outTurnOf(boards, ME)).toBe(2);
    expect(outTurnOf(boards, FOE)).toBeNull();
  });
});

describe('failedAttacks', () => {
  // Turn 3 (played on the board after 2 turns): I attack 3 from 2 with 4 and from... it stays the foe's.
  const before = board(t(1, ME, 6), t(2, ME, 8), t(3, FOE, 7), t(4, 'neutral', 2));
  const after = board(t(1, ME, 6), t(2, ME, 4), t(3, FOE, 3), t(4, ME, 1));
  const boards = [
    { turn: 2, board: before },
    { turn: 3, board: after },
  ];
  const orders: MyOrders = {
    deploys: [{ territoryId: 2, armies: 5 }],
    moves: [
      { from: 2, to: 3, armies: 4 },
      { from: 1, to: 3, armies: 1 },
      { from: 2, to: 4, armies: 2 },
      { from: 1, to: 2, armies: 1 },
    ],
  };
  it('reads what stood on a target my attacks did not take, from the history boards around my turn', () => {
    expect(failedAttacks(boards, new Map([[3, orders]]), ME)).toEqual([
      { turn: 3, to: 3, from: [1, 2], sent: 5, before: { owner: FOE, armies: 7 }, after: { owner: FOE, armies: 3 } },
    ]);
  });
  it('needs both boards and my orders', () => {
    expect(failedAttacks(boards, new Map([[2, orders]]), ME)).toEqual([]);
    expect(failedAttacks([boards[0]!], new Map([[3, orders]]), ME)).toEqual([]);
  });
});

describe('captureFinished', () => {
  it('puts the pieces together', () => {
    const boards = [
      { turn: 0, board: board(t(1, ME, 2), t(6, FOE, 2)) },
      { turn: 1, board: board(t(1, ME, 3), t(2, ME, 2), t(6, FOE, 2), t(5, FOE, 2)) },
    ];
    const c = captureFinished({
      graph: G,
      settings: SETTINGS,
      me: ME,
      players: [
        { id: ME, state: 'Won' },
        { id: FOE, state: 'Eliminated' },
      ],
      numberOfTurns: 1,
      boards,
      orders: new Map(),
    });
    expect(c.outcome).toEqual({ result: 'won', turn: 1, outTurn: null, winners: [ME] });
    expect(c.starts).toEqual(new Map([[ME, [1]], [FOE, [6]]]));
    expect(c.turns.map((x) => [x.afterTurn, x.players.get(ME)!.income, x.players.get(FOE)!.income])).toEqual([
      [0, 5, 5],
      [1, 8, 9],
    ]);
    expect(c.failedAttacks).toEqual([]);
  });
});
