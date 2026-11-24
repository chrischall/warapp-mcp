// warapp_plan_turn's Airlift plan (owner request 2026-11-24, part 3): offered ALONGSIDE the plain plan only when I
// hold an Airlift card, with `keep_cards` holding some back; the plain `orders` never change. Synthetic fixtures only.
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { liveHarness, lobbyFixture, payload, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticCard, type SyntheticTerritory } from './protocol/live-bundle.js';

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
const piece = { NumPieces: 4, InitialPieces: 0, MinimumPiecesPerTurn: 0, Weight: 1.0 };
const SETTINGS = { ...(lobbyFixture().settings as Record<string, unknown>), AirliftCard: piece, MaxCardsHold: 5 };

function game(): Record<string, unknown> {
  const f = lobbyFixture();
  const who = [
    { id: ANN.feed, name: 'Ann' },
    { id: BOB.feed, name: 'Bob' },
  ];
  const players = (f.players as Array<Record<string, string>>).slice(0, 2).map((p, i) => ({ ...p, ...who[i]! }));
  return { ...f, state: 'Playing', numberOfTurns: '2', players, settings: SETTINGS };
}

// Fixture map: 159 – 161 – 157 form bonus 118 (+2); Bob's 30 on 158 border all three and 135. My 40 on 1567 stand
// deep (beside only 157, 161 and 453745, all mine); 159 is two steps from them.
const BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 2 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 2 },
  { id: 157, fogLevel: 1, owner: ANN.inGame, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 30 },
  { id: 135, fogLevel: 1, owner: ANN.inGame, armies: 2 },
  { id: 1567, fogLevel: 1, owner: ANN.inGame, armies: 40 },
  { id: 453745, fogLevel: 1, owner: ANN.inGame, armies: 1 },
];

function server(hand: SyntheticCard[]) {
  const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method === Method.GetLatestGameInfo)
      return { body: (w) => writeLatestGameInfo(w, BOARD, [ANN.inGame, BOB.inGame], { [ANN.inGame]: hand }) };
    throw new Error(`unexpected method ${req.method}`);
  };
  return { warapp };
}

type Plan = { orders: unknown[]; airliftPlan?: Record<string, unknown> | null; airliftPlanNote?: string };
async function plan(hand: SyntheticCard[], args: Record<string, unknown> = {}) {
  h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: server(hand).warapp });
  const p = payload<Plan>(await h.call('warapp_plan_turn', { game_id: GAME, ...args }));
  await h.harness.close();
  h = undefined;
  return p;
}

describe('warapp_plan_turn: the Airlift plan beside the plain plan', () => {
  it('adds nothing without an Airlift in hand, and the plain orders are the same with one', async () => {
    const without = await plan([]);
    expect(without).not.toHaveProperty('airliftPlan');
    expect(without).not.toHaveProperty('airliftPlanNote');
    const withCard = await plan([{ id: AIR, type: 6 }]);
    expect(withCard.orders).toEqual(without.orders);
    expect(withCard).toHaveProperty('airliftPlan');
  });

  it('keeps cards in reserve with keep_cards', async () => {
    const p = await plan([{ id: AIR, type: 6 }], { keep_cards: 1 });
    expect(p.airliftPlan).toBeNull();
    expect(p.airliftPlanNote).toMatch(/1 is kept in reserve \(keep_cards\)/);
  });

  it('offers a plan whose orders play the Airlift, with the delta, cards spent and left', async () => {
    const p = await plan([{ id: AIR, type: 6 }, { id: AIR2, type: 6 }], { keep_cards: 1 });
    if (p.airliftPlan === null) throw new Error(p.airliftPlanNote);
    const a = p.airliftPlan as {
      orders: Array<Record<string, unknown>>;
      airlifts: Array<{ from: { id: number }; to: { id: number }; armies: number }>;
      delta: { nextIncomeIfConcededFall: number };
      cardsSpent: number;
      cardsLeft: number;
      keepCards: number;
    };
    expect(a.cardsSpent).toBe(1);
    expect(a.cardsLeft).toBe(1);
    expect(a.keepCards).toBe(1);
    expect(a.delta.nextIncomeIfConcededFall).toBeGreaterThanOrEqual(0);
    const lift = a.airlifts[0]!;
    expect(a.orders).toContainEqual({ kind: 'card', card: AIR, from: lift.from.id, to: lift.to.id, armies: lift.armies });
  });
});
