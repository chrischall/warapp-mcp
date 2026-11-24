// #570: the resolved turn's visible orders, every player's, read from a decoded LatestGameInfo's GameTurn.
// Synthetic shapes in the live-verified layout (field names minified, made-up ids), as tests/cards.test.ts builds.
import { describe, expect, it } from 'vitest';
import type { Player } from '../src/normalize.js';
import { MAX_SEEN_ORDERS, readSeenTurn } from '../src/turn-orders.js';

const ANN = 4412345677; // in-game 123456
const BOB = 7176543229; // in-game 765432
const players = [
  { id: ANN, name: 'Ann', state: 'Playing' },
  { id: BOB, name: 'Bob', state: 'Playing' },
] as unknown as Player[];

const GZ = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
const deploy = (t: number, n: number, player: number) => ({ $type: 'warlight.shared.GameOrderDeploy', t, f: false, n, $a: player, Sf: null, Yg: null });
const move = (from: number, to: number, n: number, player: number, mode = 3) => ({
  $type: 'warlight.shared.GameOrderAttackTransfer',
  at: false,
  m: mode,
  pc: false,
  f: from,
  a: { $type: 'warlight.shared.Armies', n, u: [] },
  t: to,
  $a: player,
  Sf: { $type: 'warlight.shared.GameOrderAttackTransferResult', x: 1 },
  Yg: null,
});
const play = (kind: string, player: number) => {
  const o: Record<string, unknown> = { $type: `warlight.shared.GameOrderPlayCard${kind}`, fe: GZ, $a: player, Yg: null };
  o.Sf = { $type: `warlight.shared.GameOrderPlayCard${kind}Result`, Tc: o };
  return o;
};
const receive = (player: number) => ({ $type: 'warlight.shared.GameOrderReceiveCard', ox: [[12, 1]], LF: [], $a: player, Sf: null, Yg: null });
const turn = (orders: unknown[], index = 17) => ({ $type: 'warlight.shared.GameTurn', Li: null, ac: orders, vh: index, zY: '2026-11-22T00:00:00.000Z' });
const info = (t: unknown) => ({ $type: 'warlight.shared.LatestGameInfo', PN: [], lE: t, vh: 18 });

describe('readSeenTurn (#570)', () => {
  it('reads every visible order with its player, turn 1-based', () => {
    const seen = readSeenTurn(info(turn([deploy(7, 5, 123456), deploy(9, 3, 765432), move(7, 8, 4, 123456), move(9, 10, 2, 765432, 2), play('Reinforcement', 765432), receive(123456)])), players);
    expect(seen).toEqual({
      turn: 18,
      orders: [
        { player: ANN, kind: 'deploy', territoryId: 7, armies: 5 },
        { player: BOB, kind: 'deploy', territoryId: 9, armies: 3 },
        { player: ANN, kind: 'move', from: 7, to: 8, armies: 4, mode: 'attack-transfer' },
        { player: BOB, kind: 'move', from: 9, to: 10, armies: 2, mode: 'transfer' },
        { player: BOB, kind: 'card', card: 'Reinforcement' },
        { player: ANN, kind: 'other', cls: 'GameOrderReceiveCard' },
      ],
    });
  });

  it('gives a player no seat matches as null, and is undefined without a GameTurn', () => {
    expect(readSeenTurn(info(turn([deploy(1, 2, 999)])), players)?.orders[0]?.player).toBeNull();
    expect(readSeenTurn({ $type: 'warlight.shared.LatestGameInfo', vh: 3 }, players)).toBeUndefined();
    expect(readSeenTurn(null, players)).toBeUndefined();
  });

  it('keeps at most MAX_SEEN_ORDERS and counts the rest', () => {
    const many = Array.from({ length: MAX_SEEN_ORDERS + 3 }, (_, i) => deploy(i + 1, 1, 123456));
    const seen = readSeenTurn(info(turn(many)), players)!;
    expect(seen.orders).toHaveLength(MAX_SEEN_ORDERS);
    expect(seen.omitted).toBe(3);
  });
});
