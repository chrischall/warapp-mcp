// My own orders this turn (warapp_get_my_orders): LatestGameInfo's first field, a list of GameOrder — the
// client's "active orders", which it shows again in "Modify orders". VERIFIED live 2026-11-22: a committed turn
// read back exactly (two deploys, a Gift, six moves). Projected into the shape warapp_submit_turn takes. The
// fixture mirrors that live shape with made-up ids.
import { describe, expect, it } from 'vitest';
import { readLatestGameInfo } from '../src/live.js';
import { myOrdersOf, readMyOrderList } from '../src/my-orders.js';
import type { Player } from '../src/normalize.js';
import { WarappBundle } from '../src/protocol/bundle.js';
import { Reader, Writer } from '../src/protocol/codec.js';
import { LIVE_BUNDLE, writeLatestGameInfo, type SyntheticOrder } from './protocol/live-bundle.js';

const bundle = new WarappBundle(LIVE_BUNDLE, 'test');
// Synthetic GameFeed ids: the in-game id wrapped in two check digits each end.
const ME = { feed: '3312345644', inGame: 123456 };
const MATE = { feed: '7176543229', inGame: 765432 };
const GIFT = 'e512f968748246768d3d462e063c0e75';
const DELAY = '0123456789abcdef0123456789abcdef';
const LIFT = 'fedcba9876543210fedcba9876543210';
const BLOCK = '11111111222222223333333344444444';
const DROP = '55555555666666667777777788888888';
const CMDR = '00112233445566778899aabbccddeeff';

const player = (id: string, name: string): Player => ({ id: Number(id), name, isAI: false, humanTurnedIntoAI: false, hasCommittedOrders: true });
const PLAYERS = [player(ME.feed, 'Me'), player(MATE.feed, 'Mate')];

function info(orders: readonly SyntheticOrder[] | null | undefined, opts: { mates?: boolean } = {}): unknown {
  const w = new Writer();
  writeLatestGameInfo(
    w,
    [{ id: 1, fogLevel: 1, owner: ME.inGame, armies: 3 }],
    [ME.inGame],
    {},
    opts.mates ? { [MATE.inGame]: { orders: [{ kind: 'deploy', territory: 9, armies: 1 }] } } : undefined,
    undefined,
    undefined,
    orders === undefined ? undefined : orders === null ? null : { player: ME.inGame, orders },
  );
  return readLatestGameInfo(bundle, new Reader(w.bytes()));
}

// The live turn's shape: deploys, the Gift between them and the moves, then the moves.
const LIVE_TURN: SyntheticOrder[] = [
  { kind: 'deploy', territory: 110, armies: 9 },
  { kind: 'deploy', territory: 116, armies: 6 },
  { kind: 'card', tag: 13, card: GIFT, ints: [MATE.inGame, 142] },
  { kind: 'move', from: 283, to: 170, armies: 1 },
  { kind: 'move', from: 114, to: 131, armies: 1 },
  { kind: 'move', from: 131, to: 134, armies: 8 },
];

describe('readMyOrderList', () => {
  it('is undefined (unknown) when war.app sent no list of my orders', () => {
    expect(readMyOrderList(info(null))).toBeUndefined();
    expect(readMyOrderList(info(undefined))).toBeUndefined();
    expect(readMyOrderList(null)).toBeUndefined();
  });

  it('an empty list names no orders field, so it is unknown too (never "no orders")', () => {
    expect(readMyOrderList(info([]))).toBeUndefined();
  });

  it("never takes a teammate's entered orders for mine", () => {
    expect(readMyOrderList(info(null, { mates: true }))).toBeUndefined();
  });

  it('reads the list of my orders, in order', () => {
    expect(readMyOrderList(info(LIVE_TURN))?.map((o) => (o as { $type: string }).$type)).toEqual([
      'warlight.shared.GameOrderDeploy',
      'warlight.shared.GameOrderDeploy',
      'warlight.shared.GameOrderPlayCardGift',
      'warlight.shared.GameOrderAttackTransfer',
      'warlight.shared.GameOrderAttackTransfer',
      'warlight.shared.GameOrderAttackTransfer',
    ]);
  });
});

describe('myOrdersOf', () => {
  it('is null (unknown) when no list was sent', () => {
    expect(myOrdersOf(info(null), PLAYERS)).toBeNull();
  });

  it('projects the live turn into warapp_submit_turn orders, the Gift recipient by GameFeed id', () => {
    expect(myOrdersOf(info(LIVE_TURN), PLAYERS)).toEqual({
      orders: [
        { kind: 'deploy', territory: 110, armies: 9 },
        { kind: 'deploy', territory: 116, armies: 6 },
        { kind: 'card', card: GIFT, cardType: 'Gift', target: 142, player: Number(MATE.feed) },
        { kind: 'move', from: 283, to: 170, armies: 1 },
        { kind: 'move', from: 114, to: 131, armies: 1 },
        { kind: 'move', from: 131, to: 134, armies: 8 },
      ],
      unread: [],
    });
  });

  it('keeps move options, an Airlift, a Blockade, a discard and Order Delay above the move it delays', () => {
    const got = myOrdersOf(
      info([
        { kind: 'deploy', territory: 7, armies: 5 },
        { kind: 'card', tag: 12, card: LIFT, from: 7, to: 30, armies: 4, units: [{ kind: 'commander', id: CMDR, owner: ME.inGame }] },
        { kind: 'card', tag: 18, card: BLOCK, ints: [12] },
        { kind: 'move', from: 7, to: 8, armies: 50, mode: 2, percent: true },
        { kind: 'card', tag: 11, card: DELAY },
        { kind: 'move', from: 7, to: 10, armies: 2, mode: 1, attackTeammates: true, units: [{ kind: 'commander', id: CMDR, owner: ME.inGame }] },
        { kind: 'discard', card: DROP },
        { kind: 'event' },
      ]),
      PLAYERS,
    );
    expect(got).toEqual({
      orders: [
        { kind: 'deploy', territory: 7, armies: 5 },
        { kind: 'card', card: LIFT, cardType: 'Airlift', from: 7, to: 30, armies: 4, commander: true },
        { kind: 'card', card: BLOCK, cardType: 'Blockade', target: 12 },
        { kind: 'move', from: 7, to: 8, armies: 50, mode: 'transfer-only', percent: true },
        { kind: 'card', card: DELAY, cardType: 'Order Delay', before: 2 },
        { kind: 'move', from: 7, to: 10, armies: 2, mode: 'attack-only', attack_teammates: true, commander: true },
        { kind: 'discard', card: DROP },
      ],
      unread: ['GameOrderEvent'],
    });
  });

  it('Order Delay after every move carries no `before`', () => {
    const got = myOrdersOf(info([{ kind: 'move', from: 7, to: 8, armies: 1 }, { kind: 'card', tag: 11, card: DELAY }]), PLAYERS);
    expect(got?.orders[1]).toEqual({ kind: 'card', card: DELAY, cardType: 'Order Delay' });
  });

  it('a card naming a player who is not in the game is unread, never resubmitted with a wrong id', () => {
    const got = myOrdersOf(info([{ kind: 'card', tag: 13, card: GIFT, ints: [999999, 142] }]), PLAYERS);
    expect(got).toEqual({ orders: [], unread: ['GameOrderPlayCardGift (player 999999 is not in the game)'] });
  });
});
