// First-class Airlift support at the tool boundary (owner request 2026-11-24): the card state in warapp_get_game,
// warapp_check_plan carrying an Airlift out at its phase, and warapp_submit_turn reading the committed Airlifts
// back (the warapp_get_my_orders read) and failing loudly on a missing or altered one. Synthetic fixtures only:
// made-up ids and GUIDs, the hand-written mini-bundle, and bytes built by the encoder.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Writer, type DecodedRequest, type ReplyFrame } from '../src/protocol/codec.js';
import { Method, writeSendOrdersParams } from '../src/protocol/methods.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticCard, type SyntheticOrder, type SyntheticTerritory } from './protocol/live-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const ME_PAGE = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };
const AIR = '55555555666666667777777788888888';
const AIR2 = '55555555666666667777777799999999';
const HAND: SyntheticCard[] = [
  { id: AIR, type: 6 },
  { id: AIR2, type: 6 },
  { id: 'abababababababababababababababab', type: 1, armies: 5 },
];
const piece = { NumPieces: 4, InitialPieces: 0, MinimumPiecesPerTurn: 0, Weight: 1.0 };
const SETTINGS = { ...(lobbyFixture().settings as Record<string, unknown>), AirliftCard: piece, ReinforcementCard: { ...piece, FixedArmies: 5 }, MaxCardsHold: 5 };

function game(opts: { turns?: string; committed?: boolean } = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const who = [
    { id: ANN.feed, name: 'Ann', ...(opts.committed ? { hasCommittedOrders: 'True' } : {}) },
    { id: BOB.feed, name: 'Bob' },
  ];
  const players = (f.players as Array<Record<string, string>>).slice(0, 2).map((p, i) => ({ ...p, ...who[i]! }));
  return { ...f, state: 'Playing', numberOfTurns: opts.turns ?? '2', players, settings: SETTINGS };
}

// Fixture map: 159 – 161 – 157 form bonus 118 (+2); 158 borders all three; 135 borders 159 and 158.
const BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 1, owner: ANN.inGame, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 7 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

/** The fake war.app: GetLatestGameInfo (with `readBack` as my committed orders once SendOrders came), SendOrders. */
function server(readBack?: SyntheticOrder[]) {
  const sent: Uint8Array[] = [];
  const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method === Method.GetLatestGameInfo) {
      const mine = sent.length && readBack ? { player: ANN.inGame, orders: readBack } : null;
      return { body: (w) => writeLatestGameInfo(w, BOARD, [ANN.inGame, BOB.inGame], { [ANN.inGame]: HAND }, undefined, undefined, undefined, mine) };
    }
    if (req.method === Method.SendOrders) {
      sent.push(req.body.raw(req.body.remaining));
      return { body: (w) => w.bool(true).bool(false) };
    }
    throw new Error(`unexpected method ${req.method}`);
  };
  return { sent, warapp };
}

async function confirmed(args: Record<string, unknown>) {
  const preview = payload(await h!.call('warapp_submit_turn', args));
  expect(preview.confirmToken).toEqual(expect.any(String));
  return { preview, result: await h!.call('warapp_submit_turn', { ...args, confirmToken: preview.confirmToken }) };
}

const DEPLOY = { kind: 'deploy', territory: 159, armies: 5 };
const LIFT = { kind: 'card', card: 'Airlift', from: 159, to: 161, armies: 8 };
const deployBack: SyntheticOrder = { kind: 'deploy', territory: 159, armies: 5 };

describe('warapp_get_game: my card state', () => {
  it('shows the cards I hold by type, the hold limit and the pieces per card in play', async () => {
    const s = server();
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: s.warapp });
    const p = payload<{ cards: Record<string, unknown> }>(await h.call('warapp_get_game', { game_id: GAME }));
    expect(p.cards).toMatchObject({
      held: [
        { type: 1, name: 'Reinforcement', count: 1, armies: 5 },
        { type: 6, name: 'Airlift', count: 2 },
      ],
      total: 3,
      maxCardsHold: 5,
    });
    // The synthetic standing writes no pieces dict, so the pieces read as unknown, never as 0.
    expect(p.cards.pieces).toBeNull();
  });

  it('reads nothing for a game with no card in play', async () => {
    const s = server();
    const noCards = Object.fromEntries(Object.entries(lobbyFixture().settings as Record<string, unknown>).filter(([k]) => !/Card$/.test(k)));
    const plain = { ...game(), settings: noCards };
    h = await liveHarness({ feed: [plain], pages: ME_PAGE, warapp: s.warapp });
    const p = payload(await h.call('warapp_get_game', { game_id: GAME }));
    expect(p).not.toHaveProperty('cards');
    expect(p).not.toHaveProperty('cardsUnread');
  });
});

describe('warapp_check_plan: an Airlift carried out at its phase', () => {
  it('no longer lists the Airlift as ignored, and the border it reinforces is not at risk', async () => {
    const s = server();
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: s.warapp });
    type Check = { notCovered: string[]; atRisk: { territories: Array<{ territory: { id: number } }> } };
    const check = async (orders: unknown[]) => payload<Check>(await h!.call('warapp_check_plan', { game_id: GAME, orders, enemy_deploy: 5, view: 'full' }));
    const without = await check([DEPLOY]);
    const lifted = await check([LIFT, DEPLOY]);
    expect(without.atRisk.territories.map((t) => t.territory.id)).toContain(161);
    expect(lifted.atRisk.territories.map((t) => t.territory.id)).not.toContain(161);
    expect(lifted.notCovered.join('\n')).not.toMatch(/card play other than/);
    expect(lifted.notCovered.join('\n')).toMatch(/apart from your own Order Priority, Airlifts, Bombs, Emergency Blockades and Blockades/);
  });
});

describe('warapp_submit_turn: the committed Airlifts read back', () => {
  it('previews the Airlift with its from, to and armies', async () => {
    const s = server();
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: s.warapp });
    const preview = payload<{ preview: { willSend: { orders: Array<Record<string, unknown>> } } }>(
      await h.call('warapp_submit_turn', { game_id: GAME, orders: [LIFT, DEPLOY] }),
    );
    const lift = preview.preview.willSend.orders.find((o) => (o.card as { name?: string } | undefined)?.name === 'Airlift');
    expect(lift).toMatchObject({ from: { id: 159 }, to: { id: 161 }, armies: 8 });
  });

  it('verifies every Airlift against war.app\'s copy of the committed orders', async () => {
    const s = server([deployBack, { kind: 'card', tag: 12, card: AIR, from: 159, to: 161, armies: 8 }]);
    h = await liveHarness({ feed: [game(), game(), game({ committed: true })], pages: ME_PAGE, warapp: s.warapp });
    const { result } = await confirmed({ game_id: GAME, orders: [LIFT, DEPLOY] });
    expect(result.isError).toBeFalsy();
    expect(payload(result)).toMatchObject({
      status: 'committed',
      airliftReadBack: { status: 'verified', sent: [{ card: AIR, from: 159, to: 161, armies: 8, commander: false }], missing: [], altered: [] },
    });
    expect(s.sent).toHaveLength(1);
  });

  it('fails loudly when an Airlift reads back altered, resending nothing', async () => {
    const s = server([deployBack, { kind: 'card', tag: 12, card: AIR, from: 159, to: 161, armies: 7 }]);
    h = await liveHarness({ feed: [game(), game(), game({ committed: true })], pages: ME_PAGE, warapp: s.warapp });
    const { result } = await confirmed({ game_id: GAME, orders: [LIFT, DEPLOY] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/are committed, but .* the Airlift of 8 from 159 to 161 reads back as 7 from 159 to 161\. Nothing was resent/);
    expect(textOf(result)).toMatch(/warapp_get_my_orders/);
    expect(s.sent).toHaveLength(1);
  });

  it('fails loudly when an Airlift is missing from the committed orders', async () => {
    const s = server([deployBack]);
    h = await liveHarness({ feed: [game(), game(), game({ committed: true })], pages: ME_PAGE, warapp: s.warapp });
    const { result } = await confirmed({ game_id: GAME, orders: [LIFT, DEPLOY] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/the Airlift of 8 from 159 to 161 is missing/);
  });

  it('says the read-back was not possible once the turn resolved at once', async () => {
    const s = server();
    h = await liveHarness({ feed: [game(), game(), game({ turns: '3' })], pages: ME_PAGE, warapp: s.warapp });
    const { result } = await confirmed({ game_id: GAME, orders: [LIFT, DEPLOY] });
    expect(payload(result)).toMatchObject({ status: 'resolved', airliftReadBack: { status: 'not-read' } });
  });

  it('a turn with no Airlift carries no read-back', async () => {
    const s = server([deployBack]);
    h = await liveHarness({ feed: [game(), game(), game({ committed: true })], pages: ME_PAGE, warapp: s.warapp });
    const { result } = await confirmed({ game_id: GAME, orders: [DEPLOY] });
    expect(payload(result)).not.toHaveProperty('airliftReadBack');
  });

  it('refuses an Airlift that leaves no army behind, but not with the guard off', async () => {
    const s = server();
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: s.warapp });
    const all = await h.call('warapp_submit_turn', { game_id: GAME, orders: [{ ...LIFT, armies: 11 }, DEPLOY] });
    expect(textOf(all)).toMatch(/at most 10 can leave .*one stays behind as its guard/);
    await h.harness.close();
    const off = { ...game(), settings: { ...SETTINGS, OneArmyStandsGuard: false } };
    h = await liveHarness({ feed: [off], pages: ME_PAGE, warapp: s.warapp });
    expect((await h.call('warapp_submit_turn', { game_id: GAME, orders: [{ ...LIFT, armies: 11 }, DEPLOY] })).isError).toBeFalsy();
  });
});

describe('the Airlift wire format (recorded fixture)', () => {
  // tests/fixtures/airlift-sendorders.json: the SendOrders body for one deploy and one Airlift, recorded from the
  // encoder whose Airlift play war.app accepted and carried out live 2026-11-16 (#296). It pins the bytes so a
  // change to the encoder cannot pass unnoticed.
  it('encodes the Airlift play byte for byte as recorded', () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'airlift-sendorders.json'), 'utf8')) as {
      game: number;
      player: number;
      turn: number;
      orders: Parameters<typeof writeSendOrdersParams>[3];
      hex: string;
    };
    const w = new Writer();
    writeSendOrdersParams(w, fixture.game, fixture.player, fixture.orders, fixture.turn);
    expect(Buffer.from(w.bytes()).toString('hex')).toBe(fixture.hex);
  });
});
