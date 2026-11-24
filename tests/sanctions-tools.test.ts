// Sanctions on yourself when the game sets a negative percentage (owner request 2026-11-24): the card settings in
// warapp_get_game, warapp_check_plan projecting the income it changes next turn, and warapp_submit_turn reading the
// committed Sanctions back (the warapp_get_my_orders read), failing loudly on a missing or retargeted one. Synthetic
// fixtures only: made-up ids and GUIDs, the hand-written mini-bundle, and bytes built by the encoder.
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
const SAN = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
const HAND: SyntheticCard[] = [{ id: SAN, type: 9 }];
const piece = { NumPieces: 10, InitialPieces: 0, MinimumPiecesPerTurn: 0, Weight: 1.0 };
const settingsWith = (pct: number) => ({ ...(lobbyFixture().settings as Record<string, unknown>), SanctionsCard: { ...piece, Duration: 1, Percentage: pct }, MaxCardsHold: 5 });
const BOOST = settingsWith(-0.3);

function game(opts: { turns?: string; committed?: boolean; settings?: Record<string, unknown> } = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const who = [
    { id: ANN.feed, name: 'Ann', ...(opts.committed ? { hasCommittedOrders: 'True' } : {}) },
    { id: BOB.feed, name: 'Bob' },
  ];
  const players = (f.players as Array<Record<string, string>>).slice(0, 2).map((p, i) => ({ ...p, ...who[i]! }));
  return { ...f, state: 'Playing', numberOfTurns: opts.turns ?? '2', players, settings: opts.settings ?? BOOST };
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
const SELF = { kind: 'card', card: 'Sanctions', player: 'Ann' };
const deployBack: SyntheticOrder = { kind: 'deploy', territory: 159, armies: 5 };
const sanctionsBack = (on: number): SyntheticOrder => ({ kind: 'card', tag: 15, card: SAN, ints: [on] });

describe('warapp_get_game: the Sanctions settings', () => {
  it('shows the percentage, its sign and whom the card goes on', async () => {
    const s = server();
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: s.warapp });
    const p = payload<{ cards: { settings: unknown[] } }>(await h.call('warapp_get_game', { game_id: GAME }));
    expect(p.cards.settings).toContainEqual({ type: 9, name: 'Sanctions', duration: 1, percentage: -0.3, effect: 'boost', targets: 'your side' });
  });
});

describe('warapp_check_plan: the income a Sanctions play changes next turn', () => {
  type Check = { income: number; sanctionsPlayed?: Array<Record<string, unknown>>; warnings: string[] };
  const check = async (orders: unknown[]) => payload<Check>(await h!.call('warapp_check_plan', { game_id: GAME, orders, enemy_deploy: 5, view: 'full' }));

  it('projects a negative Sanctions on myself onto next turn: this turn\'s income raised by 30%', async () => {
    const s = server();
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: s.warapp });
    const r = await check([SELF, DEPLOY]);
    const after = Math.round(r.income * 1.3);
    expect(r.sanctionsPlayed).toEqual([{ player: Number(ANN.feed), percentage: -0.3, turns: 1, nextIncome: { before: r.income, after, change: after - r.income } }]);
    expect(r.warnings.join('\n')).toMatch(/Your Sanctions on yourself \(-30%\) raise your income from next turn for 1 turn: \d+ → \d+/);
  });

  it('warns of a negative Sanctions on an opponent and projects nothing for it', async () => {
    const s = server();
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: s.warapp });
    const r = await check([{ ...SELF, player: 'Bob' }, DEPLOY]);
    expect(r.sanctionsPlayed).toEqual([{ player: Number(BOB.feed), percentage: -0.3, turns: 1 }]);
    expect(r.warnings.join('\n')).toMatch(/would raise its income by 30% .*warapp_submit_turn refuses it/);
  });

  it('warns of a positive Sanctions on myself', async () => {
    const s = server();
    h = await liveHarness({ feed: [game({ settings: settingsWith(0.5) })], pages: ME_PAGE, warapp: s.warapp });
    const r = await check([SELF, DEPLOY]);
    expect(r.warnings.join('\n')).toMatch(/Sanctions on yourself would cut that income by 50% .*warapp_submit_turn refuses it/);
  });
});

describe('warapp_submit_turn: the committed Sanctions read back', () => {
  it('verifies the Sanctions against war.app\'s copy of the committed orders', async () => {
    const s = server([deployBack, sanctionsBack(ANN.inGame)]);
    h = await liveHarness({ feed: [game(), game(), game({ committed: true })], pages: ME_PAGE, warapp: s.warapp });
    const { result } = await confirmed({ game_id: GAME, orders: [SELF, DEPLOY] });
    expect(result.isError).toBeFalsy();
    expect(payload(result)).toMatchObject({
      status: 'committed',
      cardReadBack: { status: 'verified', sent: [{ card: SAN, kind: 'Sanctions', player: Number(ANN.feed) }], missing: [], altered: [] },
      cardPlayCheck: expect.stringMatching(/not yet verified live/),
    });
    expect(payload(result)).not.toHaveProperty('airliftReadBack');
    expect(s.sent).toHaveLength(1);
  });

  it('fails loudly when the Sanctions reads back on another player, resending nothing', async () => {
    const s = server([deployBack, sanctionsBack(BOB.inGame)]);
    h = await liveHarness({ feed: [game(), game(), game({ committed: true })], pages: ME_PAGE, warapp: s.warapp });
    const { result } = await confirmed({ game_id: GAME, orders: [SELF, DEPLOY] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(new RegExp(`are committed, but .* the Sanctions on player ${ANN.feed} reads back on player ${BOB.feed}\\. Nothing was resent`));
    expect(textOf(result)).toMatch(/warapp_get_my_orders/);
    expect(s.sent).toHaveLength(1);
  });

  it('fails loudly when the Sanctions is missing from the committed orders', async () => {
    const s = server([deployBack]);
    h = await liveHarness({ feed: [game(), game(), game({ committed: true })], pages: ME_PAGE, warapp: s.warapp });
    const { result } = await confirmed({ game_id: GAME, orders: [SELF, DEPLOY] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(new RegExp(`the Sanctions on player ${ANN.feed} is missing`));
  });

  it('says the read-back was not possible once the turn resolved at once', async () => {
    const s = server();
    h = await liveHarness({ feed: [game(), game(), game({ turns: '3' })], pages: ME_PAGE, warapp: s.warapp });
    const { result } = await confirmed({ game_id: GAME, orders: [SELF, DEPLOY] });
    expect(payload(result)).toMatchObject({ status: 'resolved', cardReadBack: { status: 'not-read' } });
  });

  it('a turn with no Sanctions carries no card read-back', async () => {
    const s = server([deployBack]);
    h = await liveHarness({ feed: [game(), game(), game({ committed: true })], pages: ME_PAGE, warapp: s.warapp });
    const { result } = await confirmed({ game_id: GAME, orders: [DEPLOY] });
    expect(payload(result)).not.toHaveProperty('cardReadBack');
  });
});

describe('the Sanctions wire format (recorded fixture)', () => {
  // tests/fixtures/sanctions-sendorders.json: the SendOrders body for one deploy and a Sanctions play on the player
  // himself, recorded from the encoder (fields from the client bundle's GameOrderPlayCardSanctions writer; the play
  // is not yet verified live). It pins the bytes so a change to the encoder cannot pass unnoticed.
  it('encodes the self-Sanctions play byte for byte as recorded', () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'sanctions-sendorders.json'), 'utf8')) as {
      game: number;
      player: number;
      turn: number;
      orders: Parameters<typeof writeSendOrdersParams>[3];
      hex: string;
    };
    const w = new Writer();
    writeSendOrdersParams(w, fixture.game, fixture.player, fixture.orders, fixture.turn);
    expect(Buffer.from(w.bytes()).toString('hex')).toBe(fixture.hex);
    // The sanctioned player is the sender himself: tag 15, then his in-game id.
    expect(fixture.hex).toContain(`0f${'40e20100'}${'cd'.repeat(16)}`);
  });
});
