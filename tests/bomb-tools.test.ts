// The Bomb through the Airlift pipeline (owner request 2026-11-24, part B): carried out at its phase in
// warapp_check_plan, read back after warapp_submit_turn commits, and `bombPlan` beside the plain plan in
// warapp_plan_turn. Synthetic fixtures only: made-up ids and GUIDs, the hand-written mini-bundle.
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
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
const BOMB = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
const HAND: SyntheticCard[] = [{ id: BOMB, type: 13 }];
const piece = { NumPieces: 4, InitialPieces: 0, MinimumPiecesPerTurn: 0, Weight: 1.0 };
const SETTINGS = { ...(lobbyFixture().settings as Record<string, unknown>), BombCard: piece, MaxCardsHold: 5 };

function game(opts: { turns?: string; committed?: boolean } = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const who = [
    { id: ANN.feed, name: 'Ann', ...(opts.committed ? { hasCommittedOrders: 'True' } : {}) },
    { id: BOB.feed, name: 'Bob' },
  ];
  const players = (f.players as Array<Record<string, string>>).slice(0, 2).map((p, i) => ({ ...p, ...who[i]! }));
  return { ...f, state: 'Playing', numberOfTurns: opts.turns ?? '2', players, settings: SETTINGS };
}

// Fixture map: 159 – 161 – 157 form bonus 118 (+2); Bob's 158 borders all three.
const BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 1, owner: ANN.inGame, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 8 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

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
  return h!.call('warapp_submit_turn', { ...args, confirmToken: preview.confirmToken });
}

const DEPLOY = { kind: 'deploy', territory: 159, armies: 5 };
const PLAY = { kind: 'card', card: 'Bomb', target: 158 };
const deployBack: SyntheticOrder = { kind: 'deploy', territory: 159, armies: 5 };

describe('warapp_check_plan: a Bomb carried out at its phase', () => {
  it('is no longer warned of as not simulated, and the stack it halves presses less', async () => {
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: server().warapp });
    type Check = { warnings: string[]; notCovered: string[]; atRisk: { territories: Array<{ territory: { id: number } }> } };
    const check = async (orders: unknown[]) => payload<Check>(await h!.call('warapp_check_plan', { game_id: GAME, orders, enemy_deploy: 2, view: 'full' }));
    const without = await check([DEPLOY]);
    const bombed = await check([PLAY, DEPLOY]);
    expect(bombed.warnings.join('\n')).not.toMatch(/Bomb.*not simulated/);
    expect(bombed.notCovered.join('\n')).toMatch(/Order Priority, Airlifts and Bombs/);
    expect(bombed.atRisk.territories.length).toBeLessThan(without.atRisk.territories.length);
  });
});

describe('warapp_submit_turn: the committed Bomb read back', () => {
  it('verifies the Bomb\'s card and target', async () => {
    const s = server([deployBack, { kind: 'card', tag: 20, card: BOMB, ints: [158] }]);
    h = await liveHarness({ feed: [game(), game(), game({ committed: true })], pages: ME_PAGE, warapp: s.warapp });
    const r = await confirmed({ game_id: GAME, orders: [PLAY, DEPLOY] });
    expect(r.isError).toBeFalsy();
    expect(payload(r)).toMatchObject({ status: 'committed', cardReadBack: { status: 'verified', sent: [{ card: BOMB, kind: 'Bomb', target: 158 }] } });
    expect(payload(r)).not.toHaveProperty('airliftReadBack');
  });

  it('fails loudly when the Bomb is missing, resending nothing', async () => {
    const s = server([deployBack]);
    h = await liveHarness({ feed: [game(), game(), game({ committed: true })], pages: ME_PAGE, warapp: s.warapp });
    const r = await confirmed({ game_id: GAME, orders: [PLAY, DEPLOY] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/the Bomb play on 158 is missing\. Nothing was resent/);
    expect(s.sent).toHaveLength(1);
  });
});

describe('warapp_plan_turn: the Bomb plan', () => {
  it('appears only with a Bomb in hand, the plain orders unchanged', async () => {
    const plain = async (hand: SyntheticCard[]) => {
      const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
        if (req.method === Method.GetLatestGameInfo) return { body: (w) => writeLatestGameInfo(w, BOARD, [ANN.inGame, BOB.inGame], { [ANN.inGame]: hand }) };
        throw new Error(`unexpected method ${req.method}`);
      };
      h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp });
      const p = payload<{ orders: unknown[]; bombPlan?: unknown; bombPlanNote?: string }>(await h.call('warapp_plan_turn', { game_id: GAME }));
      await h.harness.close();
      h = undefined;
      return p;
    };
    const without = await plain([]);
    const withBomb = await plain(HAND);
    expect(without).not.toHaveProperty('bombPlan');
    expect(withBomb).toHaveProperty('bombPlan');
    expect(withBomb.orders).toEqual(without.orders);
    if (withBomb.bombPlan === null) expect(withBomb.bombPlanNote).toMatch(/No Bomb beats the plain plan/);
    else expect((withBomb.bombPlan as { orders: unknown[] }).orders).toContainEqual({ kind: 'card', card: BOMB, target: 158 });
  });
});
