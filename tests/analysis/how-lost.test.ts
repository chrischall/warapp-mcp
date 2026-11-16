// #274 item 5: how a lost game was lost, read from the cached boards alone (synthetic boards).
import { describe, expect, it } from 'vitest';
import { howLost } from '../../src/analysis/how-lost.js';
import type { MyOrders } from '../../src/analysis/opponents.js';
import type { BoardState, TerritoryState } from '../../src/board.js';

const ME = 100;
const OPP = 200;
const OTHER = 300;

const t = (territoryId: number, owner: number | 'fog', armies: number | null, commander?: number): TerritoryState => ({
  territoryId,
  owner: owner === 'fog' ? { kind: 'unknown' } : { kind: 'player', playerId: owner },
  armies,
  ...(commander !== undefined ? { specialUnits: [{ kind: 'commander' as const, id: `c${commander}`, playerId: commander }] } : {}),
});
const board = (...territories: TerritoryState[]): BoardState => ({ source: 'browser', verified: true, territories });

// 1 is my commander's; 2..4 border it; 5 is mine elsewhere.
const adjacency = new Map<number, number[]>([
  [1, [2, 3, 4, 5]],
  [2, [1]],
  [3, [1]],
  [4, [1]],
  [5, [1]],
]);
const RATES = { offensiveKillRate: 60, defensiveKillRate: 70 };

describe('howLost', () => {
  it('reads a commander loss: its territory, what it held after my orders, the attack it took and who bordered it', () => {
    const boards = [
      { turn: 2, board: board(t(1, ME, 300, ME), t(2, OPP, 1), t(3, OPP, 0), t(4, OPP, 1), t(5, ME, 40)) },
      { turn: 3, board: board(t(1, ME, 341, ME), t(2, OPP, 1), t(3, OPP, 0), t(4, OPP, 1), t(5, ME, 50)) },
    ];
    const orders = new Map<number, MyOrders>([[3, { deploys: [{ territoryId: 5, armies: 10 }], moves: [] }]]);
    const r = howLost({ me: ME, boards, orders, adjacency, rates: RATES, turnsCompleted: 3 });
    expect(r).toMatchObject({
      turn: 3,
      turnCertain: true,
      cause: 'commander',
      territoriesHeld: 2,
      commander: { territoryId: 1, armies: 341, deployed: 0, movedOut: 0, movedIn: 0, held: { low: 341, high: 341 }, exact: true },
      neighbours: [{ playerId: OPP, territories: 3, armies: 2 }],
      by: OPP,
    });
    // 341 armies and the commander (7) fall only to 580 attackers at 60/70.
    expect(r!.commander!.attackersNeeded).toBe(580);
  });

  it('counts my deploys and moves on the commander territory as a range, and names no taker when two players border it', () => {
    const boards = [{ turn: 5, board: board(t(1, ME, 20, ME), t(2, OPP, 4), t(3, OTHER, 9), t(4, 'fog', null), t(5, ME, 3)) }];
    const orders = new Map<number, MyOrders>([
      [5, { deploys: [{ territoryId: 1, armies: 6 }], moves: [{ from: 1, to: 2, armies: 10 }, { from: 5, to: 1, armies: 2 }] }],
    ]);
    const r = howLost({ me: ME, boards, orders, adjacency, rates: RATES, turnsCompleted: 9 })!;
    expect(r.turnCertain).toBe(false);
    expect(r.commander).toMatchObject({ armies: 20, deployed: 6, movedOut: 10, movedIn: 2, held: { low: 16, high: 28 } });
    expect(r.commander!.attackersNeeded).toBe(38); // 16 + 7 = 23 defenders
    expect(r.by).toBeNull();
    expect(r.neighbours).toEqual([
      { playerId: OPP, territories: 1, armies: 4 },
      { playerId: OTHER, territories: 1, armies: 9 },
      { playerId: null, territories: 1, armies: null },
    ]);
  });

  it('reads a commander walk on the loss turn at its destination, flagged uncertain (it may have fallen before the walk ran)', () => {
    // My commander walks from 1 to 5 with 10 armies; 5 held 4 and gets 3 deployed.
    const boards = [{ turn: 6, board: board(t(1, ME, 12, ME), t(2, OPP, 30), t(3, OPP, 2), t(5, ME, 4), t(6, OTHER, 8)) }];
    const adj = new Map<number, number[]>([...adjacency, [5, [1, 6]], [6, [5]]]);
    const orders = new Map<number, MyOrders>([
      [
        6,
        {
          deploys: [{ territoryId: 5, armies: 3 }],
          moves: [{ from: 1, to: 5, armies: 10, commander: true }],
          sent: [{ from: 1, to: 5, commander: true }],
          cards: [],
        },
      ],
    ]);
    const r = howLost({ me: ME, boards, orders, adjacency: adj, rates: RATES, turnsCompleted: 6 })!;
    expect(r.commander).toMatchObject({
      territoryId: 5,
      territoryCertain: false,
      walk: { from: 1, to: 5, armies: 10 },
      armies: 4,
      deployed: 3,
      movedOut: 0,
      movedIn: 10,
      // At the destination the commander stands only once the walk has landed.
      held: { low: 17, high: 17 },
    });
    expect(r.commander!.attackersNeeded).toBe(40); // 17 + 7 = 24 defenders
    // Neighbours of both the start and the destination: it fell on one of them.
    expect(r.neighbours).toEqual([
      { playerId: OPP, territories: 2, armies: 32 },
      { playerId: OTHER, territories: 1, armies: 8 },
    ]);
    expect(r.by).toBeNull();
  });

  it('reads a commander walk known only from the orders sent (a percentage order) with no held range', () => {
    const boards = [{ turn: 6, board: board(t(1, ME, 12, ME), t(2, OPP, 30), t(5, ME, 4)) }];
    const orders = new Map<number, MyOrders>([[6, { deploys: [], moves: [], sent: [{ from: 1, to: 5, commander: true }] }]]);
    const r = howLost({ me: ME, boards, orders, adjacency, rates: RATES })!;
    expect(r.commander).toMatchObject({ territoryId: 5, territoryCertain: false, walk: { from: 1, to: 5, armies: null }, held: null, attackersNeeded: null });
  });

  it('marks what the commander territory held uncertain when an order left out of the moves, or an Airlift, touches it', () => {
    const boards = [{ turn: 5, board: board(t(1, ME, 20, ME), t(2, OPP, 4), t(5, ME, 3)) }];
    const plain = howLost({
      me: ME,
      boards,
      orders: new Map([[5, { deploys: [], moves: [{ from: 1, to: 2, armies: 5 }], sent: [{ from: 1, to: 2 }], cards: [] }]]),
      adjacency,
      rates: RATES,
    })!;
    expect(plain.commander).toMatchObject({ territoryId: 1, territoryCertain: true, held: { low: 15, high: 20, uncertain: false } });
    const percent = howLost({
      me: ME,
      boards,
      orders: new Map([[5, { deploys: [], moves: [], sent: [{ from: 1, to: 2 }], cards: [] }]]),
      adjacency,
      rates: RATES,
    })!;
    expect(percent.commander!.held).toEqual({ low: 20, high: 20, uncertain: true });
    const airlift = howLost({
      me: ME,
      boards,
      orders: new Map([[5, { deploys: [], moves: [], sent: [], cards: [{ card: 'Airlift', from: 1, to: 5 }] }]]),
      adjacency,
      rates: RATES,
    })!;
    expect(airlift.commander!.held!.uncertain).toBe(true);
  });

  it('without my orders for that turn, gives what stood on the board and no held range', () => {
    const boards = [{ turn: 4, board: board(t(1, ME, 12, ME), t(2, OPP, 30)) }];
    const r = howLost({ me: ME, boards, orders: new Map(), adjacency, rates: RATES })!;
    expect(r.commander).toMatchObject({ armies: 12, deployed: null, held: null, attackersNeeded: null });
    expect(r.by).toBe(OPP);
  });

  it('marks the attack size inexact with luck', () => {
    const boards = [{ turn: 4, board: board(t(1, ME, 12, ME), t(2, OPP, 30)) }];
    const orders = new Map<number, MyOrders>([[4, { deploys: [], moves: [] }]]);
    const r = howLost({ me: ME, boards, orders, adjacency, rates: { ...RATES, luck: 16 } })!;
    expect(r.commander!.exact).toBe(false);
  });

  it('without a commander of mine on the board, reads the last territories held and who bordered them', () => {
    const boards = [{ turn: 7, board: board(t(1, ME, 5), t(2, OPP, 30), t(3, OPP, 2), t(5, ME, 1)) }];
    const r = howLost({ me: ME, boards, orders: new Map(), adjacency, rates: RATES })!;
    expect(r).toMatchObject({ cause: 'last-territories', territoriesHeld: 2, by: OPP });
    expect(r.lastTerritories).toEqual([
      { territoryId: 1, armies: 5 },
      { territoryId: 5, armies: 1 },
    ]);
    expect(r.commander).toBeUndefined();
  });

  it('says unknown when the game had commanders but the board shows none of mine', () => {
    const boards = [{ turn: 7, board: board(t(1, ME, 5), t(2, OPP, 30)) }];
    const r = howLost({ me: ME, boards, orders: new Map(), adjacency, rates: RATES, commanders: true })!;
    expect(r.cause).toBe('unknown');
  });

  it('gives nothing without a board of mine, and no neighbours without the map', () => {
    expect(howLost({ me: ME, boards: [], orders: new Map(), rates: RATES })).toBeUndefined();
    expect(howLost({ me: ME, boards: [{ turn: 2, board: board(t(2, OPP, 3)) }], orders: new Map(), rates: RATES })).toBeUndefined();
    const r = howLost({ me: ME, boards: [{ turn: 2, board: board(t(1, ME, 3, ME)) }], orders: new Map(), rates: RATES })!;
    expect(r.neighbours).toBeNull();
    expect(r.by).toBeNull();
  });
});
