// Teammates' entered orders and picks (C1, docs/PLAN-TEAMS.md): projected from the decoded LatestGameInfo's
// TeammateOrders dict, found by its registered type name. Tolerant: an entry it cannot read is unknown, never an
// error. The synthetic bundle (tests/protocol/live-bundle.ts) is hand-written in the client's shape.
import { describe, expect, it } from 'vitest';
import { readLatestGameInfo } from '../src/live.js';
import type { Player } from '../src/normalize.js';
import { WarappBundle } from '../src/protocol/bundle.js';
import { Reader, Writer } from '../src/protocol/codec.js';
import { readTeammateOrders, teammateOrdersOf, withTeammateOrders } from '../src/team-orders.js';
import type { BoardState } from '../src/board.js';
import { LIVE_BUNDLE, writeLatestGameInfo, type SyntheticTeammateOrders } from './protocol/live-bundle.js';

const bundle = new WarappBundle(LIVE_BUNDLE, 'test');
const ME = 123456;
const MATE = 765432;
const OP = '0123456789abcdef0123456789abcdef';
const RF = 'fedcba9876543210fedcba9876543210';
const DC = '11111111222222223333333344444444';
const CMDR = '00112233445566778899aabbccddeeff';

function info(teammates?: Record<number, SyntheticTeammateOrders | null>): unknown {
  const w = new Writer();
  writeLatestGameInfo(w, [{ id: 1, fogLevel: 1, owner: ME, armies: 3 }], [ME], {}, teammates);
  return readLatestGameInfo(bundle, new Reader(w.bytes()));
}

const player = (id: string, name: string): Player => ({
  id: Number(id),
  name,
  isAI: false,
  humanTurnedIntoAI: false,
  hasCommittedOrders: false,
});

describe('readTeammateOrders', () => {
  it('is undefined (unknown) when the info carries no teammate orders', () => {
    expect(readTeammateOrders(info())).toBeUndefined();
    expect(readTeammateOrders(null)).toBeUndefined();
    expect(readTeammateOrders({ $type: 'other' })).toBeUndefined();
  });

  it("reads a teammate's deploys, moves (mode, percent, attack teammates, commander) and card plays by class name", () => {
    const got = readTeammateOrders(
      info({
        [MATE]: {
          orders: [
            { kind: 'deploy', territory: 7, armies: 5 },
            { kind: 'move', from: 7, to: 8, armies: 6 },
            { kind: 'move', from: 7, to: 9, armies: 50, mode: 2, percent: true },
            { kind: 'move', from: 7, to: 10, armies: 2, mode: 1, attackTeammates: true, units: [{ kind: 'commander', id: CMDR, owner: MATE }] },
            { kind: 'card', tag: 10, card: OP },
            { kind: 'card', tag: 5, card: RF },
            { kind: 'discard', card: DC },
            { kind: 'event' },
          ],
        },
      }),
    );
    expect(got).toEqual(
      new Map([
        [
          MATE,
          {
            inGameId: MATE,
            orders: {
              deploys: [{ territoryId: 7, armies: 5 }],
              moves: [
                { from: 7, to: 8, armies: 6, mode: 'attack-transfer' },
                { from: 7, to: 9, armies: 50, mode: 'transfer', percent: true },
                { from: 7, to: 10, armies: 2, mode: 'attack', attackTeammates: true, commander: true },
              ],
              cards: [
                { cardId: OP, type: 4, name: 'Order Priority' },
                { cardId: RF, type: 1, name: 'Reinforcement' },
              ],
              discards: [{ cardId: DC }],
              unread: ['GameOrderEvent'],
            },
            picks: null,
          },
        ],
      ]),
    );
  });

  it('reads picks (distribution) and keeps "none sent" apart from "nothing entered"', () => {
    const got = readTeammateOrders(info({ [MATE]: { picks: [12, 4, 9] }, 222222: { orders: [] }, 333333: null }));
    expect(got?.get(MATE)).toEqual({ inGameId: MATE, orders: null, picks: [12, 4, 9] });
    expect(got?.get(222222)).toEqual({
      inGameId: 222222,
      orders: { deploys: [], moves: [], cards: [], discards: [], unread: [] },
      picks: null,
    });
    // An entry war.app sent empty (null) says nothing: left out.
    expect(got?.has(333333)).toBe(false);
  });

  it('#435 (V5, verified live 2026-11-22): reads the shape war.app sent for an uncommitted teammate', () => {
    // A decoded LatestGameInfo as read live (ids made up): the dict holds only the teammate's entry (never mine),
    // filled before the teammate commits; Armies carries a leading flag and a null unit list; picks null while playing.
    const live = {
      $type: 'warlight.shared.LatestGameInfo',
      a: [],
      f: [],
      g: [
        [
          MATE,
          {
            $type: 'warlight.shared.TeammateOrders',
            s: 1,
            o: [
              {
                $type: 'warlight.shared.GameOrderAttackTransfer',
                t: false,
                m: 3,
                p: false,
                f: 47,
                a: { $type: 'warlight.shared.Armies', c: false, n: 2, u: null },
                to: 46,
                pl: MATE,
                x: null,
                y: null,
              },
            ],
            k: null,
          },
        ],
      ],
    };
    expect(readTeammateOrders(live)).toEqual(
      new Map([[MATE, { inGameId: MATE, orders: { deploys: [], moves: [{ from: 47, to: 46, armies: 2, mode: 'attack-transfer' }], cards: [], discards: [], unread: [] }, picks: null }]]),
    );
    // A teammate with nothing entered: war.app sent the dict empty, which no value names, so it reads as unknown.
    expect(readTeammateOrders({ ...live, g: [] })).toBeUndefined();
  });

  it('never throws on a malformed entry: what it cannot read is listed as unread', () => {
    const odd = {
      $type: 'warlight.shared.LatestGameInfo',
      k1: 1,
      k4: [
        [MATE, { $type: 'warlight.shared.TeammateOrders', n1: 1, n2: [{ $type: 'warlight.shared.GameOrderDeploy', o1: 'x' }, 'junk', null], n3: ['a', 4] }],
        ['not an id', { $type: 'warlight.shared.TeammateOrders', n1: 1, n2: null, n3: null }],
      ],
    };
    expect(readTeammateOrders(odd)?.get(MATE)).toEqual({
      inGameId: MATE,
      orders: { deploys: [], moves: [], cards: [], discards: [], unread: ['GameOrderDeploy', 'unknown'] },
      picks: [4],
    });
  });
});

describe('teammateOrdersOf', () => {
  it('keys each entry by GameFeed id at the tool boundary, the in-game id when the player is unknown', () => {
    const players = [player('4412345677', 'Ann'), player('3376543299', 'Bob')];
    const got = teammateOrdersOf(info({ [MATE]: { picks: [3] }, 999999: { picks: [5] } }), players);
    expect(got).toEqual([
      { playerId: 3376543299, orders: null, picks: [3] },
      { playerId: 999999, orders: null, picks: [5] },
    ]);
    expect(teammateOrdersOf(info(), players)).toBeUndefined();
  });
});

describe('withTeammateOrders', () => {
  const board: BoardState = { source: 'browser', verified: true, territories: [] };
  const me = player('1212345634', 'Me');
  const mate = player('4476543299', 'Mate');

  it("sets a team game's board teammateOrders by GameFeed id, my own entry left out", () => {
    const got = withTeammateOrders(board, info({ [MATE]: { picks: [3] }, [ME]: { picks: [9] } }), me, [me, mate]);
    expect(got.teammateOrders).toEqual([{ playerId: 4476543299, orders: null, picks: [3] }]);
    expect(board).not.toHaveProperty('teammateOrders');
  });

  it('adds no key to a 1v1 or FFA board (no teammate orders in the info)', () => {
    const got = withTeammateOrders(board, info(), me, [me, mate]);
    expect(got).not.toHaveProperty('teammateOrders');
    expect(got).toBe(board);
    expect(withTeammateOrders(board, undefined, me, [me])).toBe(board);
  });
});
