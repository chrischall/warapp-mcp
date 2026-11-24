// Emergency Blockade / Blockade through the Airlift pipeline (owner request 2026-11-24, part B): carried out at their
// phases in warapp_check_plan, read back after warapp_submit_turn commits, and `blockadePlan` beside the plain plan.
// Both plays stay UNVERIFIED live. Synthetic fixtures only.
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
const WALL = 'e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0';
const HAND: SyntheticCard[] = [{ id: WALL, type: 3 }];
const piece = { NumPieces: 4, InitialPieces: 0, MinimumPiecesPerTurn: 0, Weight: 1.0 };
const SETTINGS = {
  ...(lobbyFixture().settings as Record<string, unknown>),
  EmergencyBlockadeCard: { ...piece, MultiplyAmount: 4 },
  BlockadeCard: { ...piece, MultiplyAmount: 3 },
  MaxCardsHold: 5,
};

function game(opts: { committed?: boolean } = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const who = [
    { id: ANN.feed, name: 'Ann', ...(opts.committed ? { hasCommittedOrders: 'True' } : {}) },
    { id: BOB.feed, name: 'Bob' },
  ];
  const players = (f.players as Array<Record<string, string>>).slice(0, 2).map((p, i) => ({ ...p, ...who[i]! }));
  return { ...f, state: 'Playing', numberOfTurns: '2', players, settings: SETTINGS };
}

// Fixture map: 159 – 161 – 157 form bonus 118 (+2); Bob's 158 borders all three; 135 borders 159 and 158.
const BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 1, owner: ANN.inGame, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 8 },
  { id: 135, fogLevel: 1, owner: ANN.inGame, armies: 3 },
];

function server(readBack?: SyntheticOrder[], hand: SyntheticCard[] = HAND) {
  const sent: Uint8Array[] = [];
  const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method === Method.GetLatestGameInfo) {
      const mine = sent.length && readBack ? { player: ANN.inGame, orders: readBack } : null;
      return { body: (w) => writeLatestGameInfo(w, BOARD, [ANN.inGame, BOB.inGame], { [ANN.inGame]: hand }, undefined, undefined, undefined, mine) };
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
const PLAY = { kind: 'card', card: 'Emergency Blockade', target: 135 };
const deployBack: SyntheticOrder = { kind: 'deploy', territory: 159, armies: 5 };

describe('warapp_check_plan: the walls carried out at their phases', () => {
  it('simulates an Emergency Blockade instead of warning, and never counts the walled border lost', async () => {
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: server().warapp });
    type Check = { warnings: string[]; notCovered: string[]; atRisk: { territories: Array<{ territory: { id: number } }> } };
    const check = async (orders: unknown[]) => payload<Check>(await h!.call('warapp_check_plan', { game_id: GAME, orders, enemy_deploy: 2, view: 'full' }));
    const open = await check([DEPLOY]);
    const walled = await check([PLAY, DEPLOY]);
    expect(open.atRisk.territories.map((t) => t.territory.id)).toContain(135);
    expect(walled.warnings.join('\n')).not.toMatch(/Emergency Blockade.*not simulated/);
    expect(walled.atRisk.territories.map((t) => t.territory.id)).not.toContain(135);
    expect(walled.notCovered.join('\n')).toMatch(/Emergency Blockades and Blockades/);
  });
});

describe('warapp_submit_turn: the committed wall read back', () => {
  it('verifies the Emergency Blockade\'s card and target', async () => {
    const s = server([deployBack, { kind: 'card', tag: 8, card: WALL, ints: [135] }]);
    h = await liveHarness({ feed: [game(), game(), game({ committed: true })], pages: ME_PAGE, warapp: s.warapp });
    const r = await confirmed({ game_id: GAME, orders: [PLAY, DEPLOY] });
    expect(r.isError).toBeFalsy();
    expect(payload(r)).toMatchObject({ cardReadBack: { status: 'verified', sent: [{ card: WALL, kind: 'EmergencyBlockade', target: 135 }] } });
  });

  it('fails loudly when it reads back on another territory', async () => {
    const s = server([deployBack, { kind: 'card', tag: 8, card: WALL, ints: [161] }]);
    h = await liveHarness({ feed: [game(), game(), game({ committed: true })], pages: ME_PAGE, warapp: s.warapp });
    const r = await confirmed({ game_id: GAME, orders: [PLAY, DEPLOY] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/the EmergencyBlockade play on 135 reads back on 161/);
  });
});

describe('warapp_plan_turn: the wall plan', () => {
  const plan = async (hand: SyntheticCard[]) => {
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: server(undefined, hand).warapp });
    const p = payload<{ orders: unknown[]; blockadePlan?: unknown; blockadePlanNote?: string }>(await h.call('warapp_plan_turn', { game_id: GAME }));
    await h.harness.close();
    h = undefined;
    return p;
  };

  it('appears only with a wall card in hand, the plain orders unchanged', async () => {
    const without = await plan([]);
    const withWall = await plan(HAND);
    expect(without).not.toHaveProperty('blockadePlan');
    expect(withWall).toHaveProperty('blockadePlan');
    expect(withWall.orders).toEqual(without.orders);
  });

  it('plans a Blockade alone too (owner decision 2026-11-24): its plan is the plain orders plus the card, else a note', async () => {
    const BLOCK = 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1';
    const plain = await plan([]);
    const p = await plan([{ id: BLOCK, type: 12 }]);
    expect(p).toHaveProperty('blockadePlan');
    expect(p.orders).toEqual(plain.orders);
    if (p.blockadePlan === null) expect(p.blockadePlanNote).toMatch(/Blockade target\(s\) tried/);
    else {
      const b = p.blockadePlan as { card: string; orders: unknown[]; wall: { target: { id: number } } };
      expect(b.card).toBe('Blockade');
      expect(b.orders).toEqual([...plain.orders, { kind: 'card', card: BLOCK, target: b.wall.target.id }]);
    }
  });
});

describe('warapp_plan_turn: a wall plan offered', () => {
  // Bob holds 161 and 157 of bonus 118; my 159 completes it for him if it falls. Both wall cards in hand.
  const BOTH: SyntheticCard[] = [
    { id: WALL, type: 3 },
    { id: 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1', type: 12 },
  ];
  const denial = (mine: number, bob: number): SyntheticTerritory[] => [
    { id: 159, fogLevel: 1, owner: ANN.inGame, armies: mine },
    { id: 161, fogLevel: 1, owner: BOB.inGame, armies: 2 },
    { id: 157, fogLevel: 1, owner: BOB.inGame, armies: 2 },
    { id: 158, fogLevel: 1, owner: BOB.inGame, armies: bob },
    { id: 135, fogLevel: 1, owner: ANN.inGame, armies: 5 },
  ];
  type Wall = { orders: unknown[]; blockadePlan: { card: string; wall: { target: { id: number }; wall: number; denies: { bonusValue: number } }; orders: unknown[]; cardsLeft: number } };
  const plan = async (board: SyntheticTerritory[]) => {
    const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
      if (req.method === Method.GetLatestGameInfo) return { body: (w) => writeLatestGameInfo(w, board, [ANN.inGame, BOB.inGame], { [ANN.inGame]: BOTH }) };
      throw new Error(`unexpected method ${req.method}`);
    };
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp });
    const p = payload<Wall>(await h.call('warapp_plan_turn', { game_id: GAME }));
    await h.harness.close();
    h = undefined;
    return p;
  };

  it('walls a thin border the stack beside it would take: an Emergency Blockade, planned on the walled board', async () => {
    const p = await plan(denial(3, 12));
    expect(p.blockadePlan).toMatchObject({ card: 'Emergency Blockade', wall: { target: { id: 159 }, wall: 12, denies: { bonusValue: 2 } } });
    expect(p.blockadePlan.orders).toContainEqual({ kind: 'card', card: WALL, target: 159 });
    expect(p.blockadePlan.cardsLeft).toBe(0);
  });

  it('a border the attacks leave mine takes a Blockade instead: the plain orders plus the card', async () => {
    const p = await plan(denial(10, 8));
    expect(p.blockadePlan.card).toBe('Blockade');
    expect(p.blockadePlan.orders).toEqual([...p.orders, { kind: 'card', card: 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1', target: 159 }]);
  });
});
