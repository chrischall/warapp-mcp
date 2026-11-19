// warapp_submit_turn with the targeted card plays (PLAN-TEAMS part D): Spy, Reconnaissance,
// Surveillance, Airlift, Gift, Diplomacy and Sanctions. Synthetic fixtures only: made-up ids,
// the hand-written mini-bundle, and bytes built by the encoder.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Writer, type DecodedRequest, type ReplyFrame } from '../src/protocol/codec.js';
import { Method, writeSendOrdersParams, type TurnOrder } from '../src/protocol/methods.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticCard, type SyntheticTerritory } from './protocol/live-bundle.js';
import { buildGraph } from '../src/analysis/graph.js';
import type { Card } from '../src/cards.js';
import type { Player } from '../src/normalize.js';
import { adviseCards } from '../src/tools/card-advice.js';
import { board as boardOf, fixtureMap, mine as mineState } from './analysis/helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
// Synthetic GameFeed ids: the in-game id wrapped in two check digits each end.
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const CAT = { feed: '5523456711', inGame: 234567 };
const ME_PAGE = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };

// Synthetic card GUIDs.
const SPY = '12121212343434345656565678787878';
const REC = '21212121434343436565656587878787';
const SUR = '31313131535353537575757597979797';
const AIR = '55555555666666667777777788888888';
const GIF = '9a9a9a9a8b8b8b8b7c7c7c7c6d6d6d6d';
const DIP = 'abababababababababababababababab';
const SAN = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
const CMDR = 'ef0123456789abcdef0123456789abcd';
const HAND: SyntheticCard[] = [
  { id: SPY, type: 2 },
  { id: REC, type: 10 },
  { id: SUR, type: 11 },
  { id: AIR, type: 6 },
  { id: GIF, type: 7 },
];
const DIPLOMACY_HAND: SyntheticCard[] = [
  { id: DIP, type: 8 },
  { id: SAN, type: 9 },
];

const piece = { NumPieces: 6, InitialPieces: 0, MinimumPiecesPerTurn: 0, Weight: 1.0 };

function settings(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...(lobbyFixture().settings as Record<string, unknown>),
    SpyCard: { ...piece, Duration: 1, CanSpyOnNeutral: false },
    SurveillanceCard: { ...piece, Duration: 1 },
    GiftCard: piece,
    MaxCardsHold: 9,
    ...extra,
  };
}

/** Ann, Bob and Cat are playing; with `team`, Ann and Cat are teammates against Bob. */
function game(opts: { team?: boolean; settings?: Record<string, unknown>; turns?: string; bob?: Record<string, string> } = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const who = [
    { id: ANN.feed, name: 'Ann', team: '0' },
    { id: BOB.feed, name: 'Bob', team: '1', ...opts.bob },
    { id: CAT.feed, name: 'Cat', team: '0' },
  ];
  const players = (f.players as Array<Record<string, string>>).slice(0, 3).map((p, i) => {
    const { team, ...rest } = who[i]!;
    return { ...p, ...rest, ...(opts.team ? { team } : {}) };
  });
  return { ...f, state: 'Playing', numberOfTurns: opts.turns ?? '2', players, settings: opts.settings ?? settings() };
}

// Fixture map: 159 – 161 – 157 form bonus 118 (+2); 158 borders all three; 135 borders 159 and 158.
const BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 1, owner: CAT.inGame, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 7 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

type Routes = Partial<Record<number, (req: DecodedRequest) => Partial<ReplyFrame>>>;
function server(hand: SyntheticCard[], board: SyntheticTerritory[] = BOARD) {
  const sent: Uint8Array[] = [];
  const r: Routes = {
    [Method.GetLatestGameInfo]: () => ({
      body: (w) => writeLatestGameInfo(w, board, [ANN.inGame, BOB.inGame, CAT.inGame], { [ANN.inGame]: hand }),
    }),
    [Method.SendOrders]: (req) => {
      sent.push(req.body.raw(req.body.remaining));
      return { body: (w) => w.bool(true).bool(false) };
    },
  };
  const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
    const f = r[req.method];
    if (!f) throw new Error(`unexpected method ${req.method}`);
    return f(req);
  };
  return { sent, warapp };
}

const expectedBytes = (orders: TurnOrder[], turn: number) => {
  const w = new Writer();
  writeSendOrdersParams(w, GAME, ANN.inGame, orders, turn);
  return Array.from(w.bytes());
};

async function confirmed(args: Record<string, unknown>) {
  const preview = payload(await h!.call('warapp_submit_turn', args));
  expect(preview.confirmToken).toEqual(expect.any(String));
  return { preview, result: payload(await h!.call('warapp_submit_turn', { ...args, confirmToken: preview.confirmToken })) };
}

const DEPLOY = { kind: 'deploy', territory: 159, armies: 5 };

interface Preview {
  preview: { warnings?: string[]; willSend: { orders: Array<Record<string, unknown>> } };
}

describe('submit_turn plays the targeted cards (PLAN-TEAMS part D, UNVERIFIED live)', () => {
  it('sends Spy, Reconnaissance, Surveillance, Airlift and Gift in their bundle phases, warning the encoding is unverified', async () => {
    const s = server(HAND);
    const turnDone = game({ turns: '3' });
    h = await liveHarness({ feed: [game(), game(), turnDone], pages: ME_PAGE, warapp: s.warapp });
    const { preview, result } = await confirmed({
      game_id: GAME,
      orders: [
        { kind: 'card', card: 'Gift', target: 161, player: 'Bob' },
        { kind: 'card', card: AIR, from: 'Hornwood', to: 161, armies: 8 },
        DEPLOY,
        { kind: 'card', card: 'Spy', player: BOB.feed },
        { kind: 'card', card: 'Reconnaissance', target: 135 },
        { kind: 'card', card: 'Surveillance', bonus: 118 },
      ],
    });
    expect(Array.from(s.sent[0]!)).toEqual(
      expectedBytes(
        [
          { kind: 'card', card: 'Spy', cardId: SPY, player: BOB.inGame },
          { kind: 'card', card: 'Reconnaissance', cardId: REC, target: 135 },
          { kind: 'card', card: 'Surveillance', cardId: SUR, bonus: 118 },
          { kind: 'deploy', territoryId: 159, armies: 5 },
          { kind: 'card', card: 'Airlift', cardId: AIR, from: 159, to: 161, armies: 8 },
          { kind: 'card', card: 'Gift', cardId: GIF, player: BOB.inGame, target: 161 },
        ],
        3,
      ),
    );
    const view = preview as unknown as Preview;
    const warnings = view.preview.warnings?.join('\n') ?? '';
    expect(warnings).toMatch(/UNVERIFIED encoding: the Gift, Spy, Reconnaissance, Surveillance card plays/);
    // #296: the Airlift play was verified live 2026-11-16, so it is no longer named.
    expect(warnings).not.toMatch(/UNVERIFIED encoding:[^\n]*Airlift/);
    expect(warnings).toMatch(/Gift: territory 161 .* go to player 7176543229 before the attacks/);
    // The preview names targets by id, every name delimited.
    const gift = view.preview.willSend.orders.find((o) => (o.card as { name: string }).name === 'Gift')!;
    expect(gift).toMatchObject({ target: { id: 161 }, player: { id: Number(BOB.feed) } });
    expect(String((gift.player as { name: string }).name)).toMatch(/⟦Bob⟧/);
    expect(result).toMatchObject({ status: 'resolved', cardPlayCheck: expect.stringMatching(/not yet verified live/) });
  });

  it('sends Diplomacy and Sanctions after the Blockade phase', async () => {
    const s = server(DIPLOMACY_HAND);
    h = await liveHarness({ feed: [game(), game(), game({ turns: '3' })], pages: ME_PAGE, warapp: s.warapp });
    await confirmed({
      game_id: GAME,
      orders: [
        { kind: 'card', card: 'Sanctions', player: 'Bob' },
        { kind: 'card', card: 'Diplomacy', players: ['Ann', 'Cat'] },
        DEPLOY,
      ],
    });
    expect(Array.from(s.sent[0]!)).toEqual(
      expectedBytes(
        [
          { kind: 'deploy', territoryId: 159, armies: 5 },
          { kind: 'card', card: 'Diplomacy', cardId: DIP, players: [ANN.inGame, CAT.inGame] },
          { kind: 'card', card: 'Sanctions', cardId: SAN, player: BOB.inGame },
        ],
        3,
      ),
    );
  });

  it('counts an Airlift out of a territory in what it can move afterwards, and nothing airlifted in', async () => {
    const s = server(HAND);
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: s.warapp });
    // 159 holds 6 + 5 deployed - 8 airlifted = 3, so 2 may attack (one stands guard).
    const ok = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [{ kind: 'card', card: 'Airlift', from: 159, to: 161, armies: 8 }, DEPLOY, { kind: 'move', from: 159, to: 158, armies: 2 }],
    });
    expect(ok.isError).toBeFalsy();
    const over = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [{ kind: 'card', card: 'Airlift', from: 159, to: 161, armies: 8 }, DEPLOY, { kind: 'move', from: 159, to: 158, armies: 3 }],
    });
    expect(textOf(over)).toMatch(/send 3 armies from .*at most 2 this turn \(one army stands guard\), counting this turn's Airlift/);
    // 161 holds 3: the 8 airlifted onto it cannot move again this turn, so it still sends at most 2.
    const flown = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [{ kind: 'card', card: 'Airlift', from: 159, to: 161, armies: 8 }, DEPLOY, { kind: 'move', from: 161, to: 158, armies: 3 }],
    });
    expect(textOf(flown)).toMatch(/send 3 armies from .*at most 2 this turn/);
    expect(s.sent).toEqual([]);
  });

  it('an Airlift alone carries no unverified-encoding warning and no cardPlayCheck: verified live (#296)', async () => {
    const s = server(HAND);
    h = await liveHarness({ feed: [game(), game(), game({ turns: '3' })], pages: ME_PAGE, warapp: s.warapp });
    const { preview, result } = await confirmed({
      game_id: GAME,
      orders: [{ kind: 'card', card: 'Airlift', from: 159, to: 161, armies: 8 }, DEPLOY],
    });
    expect((preview as unknown as Preview).preview.warnings?.join('\n') ?? '').not.toMatch(/UNVERIFIED encoding/);
    expect(result).toMatchObject({ status: 'resolved' });
    expect(result).not.toHaveProperty('cardPlayCheck');
    expect(s.sent).toHaveLength(1);
  });

  it('airlifts my commander to my own territory, written as a special unit', async () => {
    const board = BOARD.map((t) => (t.id === 159 ? { ...t, units: [{ kind: 'commander' as const, id: CMDR, owner: ANN.inGame }] } : t));
    const s = server(HAND, board);
    const commanders = settings({ Commanders: true });
    h = await liveHarness({
      feed: [game({ settings: commanders }), game({ settings: commanders }), game({ settings: commanders, turns: '3' })],
      pages: ME_PAGE,
      warapp: s.warapp,
    });
    await confirmed({ game_id: GAME, orders: [{ kind: 'card', card: 'Airlift', from: 159, to: 161, armies: 2, commander: true }, DEPLOY] });
    expect(Array.from(s.sent[0]!)).toEqual(
      expectedBytes(
        [
          { kind: 'deploy', territoryId: 159, armies: 5 },
          { kind: 'card', card: 'Airlift', cardId: AIR, from: 159, to: 161, armies: 2, commander: { id: CMDR, owner: ANN.inGame } },
        ],
        3,
      ),
    );
  });

  it('airlifts to a teammate, warning the armies become theirs', async () => {
    const s = server(HAND);
    h = await liveHarness({ feed: [game({ team: true })], pages: ME_PAGE, warapp: s.warapp });
    const r = await h.call('warapp_submit_turn', { game_id: GAME, orders: [{ kind: 'card', card: 'Airlift', from: 159, to: 157, armies: 4 }, DEPLOY] });
    expect(r.isError).toBeFalsy();
    expect((payload(r) as unknown as Preview).preview.warnings?.join('\n')).toMatch(/4 armies landing on territory 157 become your teammate's/);
  });

  it('warns that a Diplomacy card not naming me does not protect me', async () => {
    const s = server(DIPLOMACY_HAND);
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: s.warapp });
    const r = await h.call('warapp_submit_turn', { game_id: GAME, orders: [{ kind: 'card', card: 'Diplomacy', players: ['Bob', 'Cat'] }, DEPLOY] });
    expect(r.isError).toBeFalsy();
    expect((payload(r) as unknown as Preview).preview.warnings?.join('\n')).toMatch(/does not name you/);
  });

  it('warns that the moves from a gifted territory will not run', async () => {
    const s = server(HAND);
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: s.warapp });
    const r = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [{ kind: 'card', card: 'Gift', target: 159, player: 'Cat' }, DEPLOY, { kind: 'move', from: 159, to: 158, armies: 3 }],
    });
    expect(r.isError).toBeFalsy();
    expect((payload(r) as unknown as Preview).preview.warnings?.join('\n')).toMatch(/moves from it in these orders will not run/);
  });

  it('allows Sanctions on a teammate when the percentage is negative (a boost), and refuses an opponent then', async () => {
    const boost = settings({ SanctionsCard: { ...piece, Duration: 1, Percentage: -0.5 } });
    const s = server(DIPLOMACY_HAND);
    h = await liveHarness({ feed: [game({ team: true, settings: boost })], pages: ME_PAGE, warapp: s.warapp });
    const ok = await h.call('warapp_submit_turn', { game_id: GAME, orders: [{ kind: 'card', card: 'Sanctions', player: 'Cat' }, DEPLOY] });
    expect(ok.isError).toBeFalsy();
    const no = await h.call('warapp_submit_turn', { game_id: GAME, orders: [{ kind: 'card', card: 'Sanctions', player: 'Bob' }, DEPLOY] });
    expect(textOf(no)).toMatch(/percentage is negative .*not go on an opponent/);
  });

  it("spies on the neutral (target 0) when the game's Spy card can, by 0 or by name (G2)", async () => {
    const neutralSpy = settings({ SpyCard: { ...piece, Duration: 1, CanSpyOnNeutral: true } });
    for (const player of [0, 'neutral']) {
      const s = server(HAND);
      h = await liveHarness({ feed: [game({ settings: neutralSpy }), game({ settings: neutralSpy }), game({ settings: neutralSpy, turns: '3' })], pages: ME_PAGE, warapp: s.warapp });
      const { preview } = await confirmed({ game_id: GAME, orders: [{ kind: 'card', card: 'Spy', player }, DEPLOY] });
      expect(Array.from(s.sent[0]!)).toEqual(
        expectedBytes([{ kind: 'card', card: 'Spy', cardId: SPY, player: 0 }, { kind: 'deploy', territoryId: 159, armies: 5 }], 3),
      );
      const spy = (preview as unknown as Preview).preview.willSend.orders.find((o) => (o.card as { name: string }).name === 'Spy')!;
      expect(spy).toMatchObject({ player: { id: 0, name: expect.stringMatching(/neutral/) } });
      await h.harness.close();
      h = undefined;
    }
  });

  it('airlifts my commander alone (armies 0 with commander: the validator does not check the count) (G2)', async () => {
    const board = BOARD.map((t) => (t.id === 159 ? { ...t, units: [{ kind: 'commander' as const, id: CMDR, owner: ANN.inGame }] } : t));
    const s = server(HAND, board);
    const commanders = settings({ Commanders: true });
    h = await liveHarness({
      feed: [game({ settings: commanders }), game({ settings: commanders }), game({ settings: commanders, turns: '3' })],
      pages: ME_PAGE,
      warapp: s.warapp,
    });
    await confirmed({ game_id: GAME, orders: [{ kind: 'card', card: 'Airlift', from: 159, to: 161, armies: 0, commander: true }, DEPLOY] });
    expect(Array.from(s.sent[0]!)).toEqual(
      expectedBytes(
        [
          { kind: 'deploy', territoryId: 159, armies: 5 },
          { kind: 'card', card: 'Airlift', cardId: AIR, from: 159, to: 161, armies: 0, commander: { id: CMDR, owner: ANN.inGame } },
        ],
        3,
      ),
    );
  });

  it('names an opponent receiving a Gift as an opponent, by id, in its own preview line (G2)', async () => {
    const s = server(HAND);
    h = await liveHarness({ feed: [game({ team: true })], pages: ME_PAGE, warapp: s.warapp });
    const r = await h.call('warapp_submit_turn', { game_id: GAME, orders: [{ kind: 'card', card: 'Gift', target: 161, player: 'Bob' }, DEPLOY] });
    expect(r.isError).toBeFalsy();
    const warnings = (payload(r) as unknown as Preview).preview.warnings ?? [];
    expect(warnings).toContainEqual(expect.stringMatching(/^Gift to an opponent: territory 161 goes to player 7176543229, an opponent \(not you or a teammate\)/));
    expect(warnings.join('\n')).not.toMatch(/Bob/);
    // A Gift to a teammate has no such line.
    await h.harness.close();
    const s2 = server(HAND);
    h = await liveHarness({ feed: [game({ team: true })], pages: ME_PAGE, warapp: s2.warapp });
    const mate = await h.call('warapp_submit_turn', { game_id: GAME, orders: [{ kind: 'card', card: 'Gift', target: 161, player: 'Cat' }, DEPLOY] });
    expect(((payload(mate) as unknown as Preview).preview.warnings ?? []).join('\n')).not.toMatch(/Gift to an opponent/);
  });

  const commanderBoard = BOARD.map((t) => (t.id === 159 ? { ...t, units: [{ kind: 'commander' as const, id: CMDR, owner: ANN.inGame }] } : t));
  const refusals: Array<{
    name: string;
    orders: Array<Record<string, unknown>>;
    message: RegExp;
    hand?: SyntheticCard[];
    board?: SyntheticTerritory[];
    team?: boolean;
    settings?: Record<string, unknown>;
    bob?: Record<string, string>;
  }> = [
    { name: 'a card not in the hand', orders: [{ kind: 'card', card: 'Diplomacy', players: ['Ann', 'Bob'] }], message: /hold no Diplomacy card/ },
    {
      name: 'a card not in play in this game',
      orders: [{ kind: 'card', card: 'Gift', target: 161, player: 'Bob' }],
      settings: settings({ GiftCard: 'none' }),
      message: /Gift card is not in play/,
    },
    { name: 'a Gift with no recipient', orders: [{ kind: 'card', card: 'Gift', target: 161 }], message: /A Gift card needs `player`/ },
    { name: 'a field the card does not take', orders: [{ kind: 'card', card: 'Spy', player: 'Bob', target: 159 }], message: /A Spy card takes no target\./ },
    { name: 'a Gift of a territory not mine', orders: [{ kind: 'card', card: 'Gift', target: 158, player: 'Cat' }], message: /not yours .*error 212/ },
    { name: 'a Gift to myself', orders: [{ kind: 'card', card: 'Gift', target: 161, player: 'Ann' }], message: /cannot go to yourself.*error 211/ },
    {
      name: 'a Gift to a player no longer playing',
      orders: [{ kind: 'card', card: 'Gift', target: 161, player: 'Bob' }],
      bob: { state: 'SurrenderAccepted' },
      message: /no longer playing.*error 210/,
    },
    {
      name: 'a Gift of a territory holding my commander (to a teammate)',
      orders: [{ kind: 'card', card: 'Gift', target: 159, player: 'Cat' }],
      board: commanderBoard,
      team: true,
      message: /holds a commander, which cannot be gifted.*error 536/,
    },
    {
      name: 'an Airlift of my commander to a teammate',
      orders: [{ kind: 'card', card: 'Airlift', from: 159, to: 157, armies: 1, commander: true }],
      board: commanderBoard,
      team: true,
      settings: settings({ Commanders: true }),
      message: /commander cannot be airlifted to a teammate.*error 537/,
    },
    { name: 'an Airlift from a territory not mine', orders: [{ kind: 'card', card: 'Airlift', from: 158, to: 161, armies: 1 }], message: /error 182/ },
    { name: 'an Airlift to a territory neither mine nor a teammate\'s', orders: [{ kind: 'card', card: 'Airlift', from: 159, to: 158, armies: 1 }], message: /error 183/ },
    { name: 'an Airlift to an opponent outside a team game', orders: [{ kind: 'card', card: 'Airlift', from: 159, to: 157, armies: 1 }], message: /error 183/ },
    { name: 'an Airlift to the same territory', orders: [{ kind: 'card', card: 'Airlift', from: 159, to: 159, armies: 1 }], message: /error 184/ },
    {
      name: 'an Airlift of more armies than stand there',
      orders: [{ kind: 'card', card: 'Airlift', from: 161, to: 159, armies: 4 }],
      message: /airlift 4 armies from .*at most 3 stand there/,
    },
    {
      name: 'a commander airlifted with no commanders in the game',
      orders: [{ kind: 'card', card: 'Airlift', from: 159, to: 161, armies: 1, commander: true }],
      message: /no commanders/,
    },
    {
      name: 'a commander both airlifted and moved',
      orders: [
        { kind: 'card', card: 'Airlift', from: 159, to: 161, armies: 1, commander: true },
        { kind: 'move', from: 159, to: 158, armies: 1, commander: true },
      ],
      board: commanderBoard,
      settings: settings({ Commanders: true }),
      message: /both airlifted and taken along/,
    },
    { name: 'a Diplomacy naming me twice', orders: [{ kind: 'card', card: 'Diplomacy', players: ['Ann', ANN.feed] }], hand: DIPLOMACY_HAND, message: /one player twice.*error 214/ },
    {
      name: 'a Diplomacy between teammates',
      orders: [{ kind: 'card', card: 'Diplomacy', players: ['Ann', 'Cat'] }],
      hand: DIPLOMACY_HAND,
      team: true,
      message: /on one team.*error 214/,
    },
    { name: 'Sanctions on a teammate', orders: [{ kind: 'card', card: 'Sanctions', player: 'Cat' }], hand: DIPLOMACY_HAND, team: true, message: /not go on your teammate/ },
    { name: 'Sanctions on myself', orders: [{ kind: 'card', card: 'Sanctions', player: 'Ann' }], hand: DIPLOMACY_HAND, message: /not go on yourself/ },
    { name: 'a Spy on a teammate', orders: [{ kind: 'card', card: 'Spy', player: 'Cat' }], team: true, message: /cannot target your teammate.*error 80/ },
    { name: 'a Spy on myself', orders: [{ kind: 'card', card: 'Spy', player: 'Ann' }], message: /cannot target yourself.*error 80/ },
    {
      name: 'Surveillance on a bonus worth 0',
      orders: [{ kind: 'card', card: 'Surveillance', bonus: 118 }],
      settings: settings({ OverriddenBonuses: [{ bonusID: 118, value: 0 }] }),
      message: /worth 0 .*error 224/,
    },
    {
      name: 'a Spy on the neutral when the game\'s Spy card cannot (G2)',
      orders: [{ kind: 'card', card: 'Spy', player: 0 }],
      message: /cannot spy on the neutral.*error 225/,
    },
    {
      name: 'an Airlift of no armies without the commander (G2)',
      orders: [{ kind: 'card', card: 'Airlift', from: 159, to: 161, armies: 0 }],
      message: /sends at least one army, not 0.*|0 armies only with `commander`/,
    },
    {
      name: 'a Diplomacy naming a second player no longer playing: the validator checks both (G2)',
      orders: [{ kind: 'card', card: 'Diplomacy', players: ['Ann', 'Bob'] }],
      hand: DIPLOMACY_HAND,
      bob: { state: 'SurrenderAccepted' },
      message: /no longer playing.*error 381/,
    },
    { name: 'a Spy on a player with no in-game id', orders: [{ kind: 'card', card: 'Spy', player: 'Bob' }], bob: { id: '1001' }, message: /no in-game id/ },
  ];

  it.each(refusals)('refuses $name, sending nothing', async (c) => {
    const s = server(c.hand ?? HAND, c.board ?? BOARD);
    h = await liveHarness({
      feed: [game({ ...(c.team ? { team: true } : {}), ...(c.settings ? { settings: c.settings } : {}), ...(c.bob ? { bob: c.bob } : {}) })],
      pages: ME_PAGE,
      warapp: s.warapp,
    });
    const res = await h.call('warapp_submit_turn', { game_id: GAME, orders: [...c.orders, DEPLOY] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(c.message);
    expect(s.sent).toEqual([]);
  });
});

// Bomb and Emergency Blockade (#G1): encoded from the bundle's GameOrderPlayCardBomb (tag 20, phase 30) and
// GameOrderPlayCardAbandon (tag 8, phase 37) writers, UNVERIFIED live (V9). Refusals mirror GameValidateOrders.
const BOMB = '13131313242424243535353546464646';
const WALL = '03030303141414142525252536363636';
const WALL2 = '03030303141414142525252536363637';
const COMBAT_HAND: SyntheticCard[] = [
  { id: BOMB, type: 13 },
  { id: WALL, type: 3 },
];
const combatSettings = (extra: Record<string, unknown> = {}) =>
  settings({ BombCard: piece, EmergencyBlockadeCard: { ...piece, MultiplyAmount: 3 }, ...extra });

describe('submit_turn plays Bomb and Emergency Blockade (UNVERIFIED live)', () => {
  it('sends a Bomb (phase 30) and an Emergency Blockade (phase 37) after the deploys and before the moves', async () => {
    const s = server(COMBAT_HAND);
    const cs = combatSettings();
    h = await liveHarness({ feed: [game({ settings: cs }), game({ settings: cs }), game({ settings: cs, turns: '3' })], pages: ME_PAGE, warapp: s.warapp });
    const { preview, result } = await confirmed({
      game_id: GAME,
      orders: [
        { kind: 'move', from: 159, to: 158, armies: 9 },
        { kind: 'card', card: 'Emergency Blockade', target: 161 },
        { kind: 'card', card: BOMB, target: 'Bolton Moors' },
        DEPLOY,
      ],
    });
    expect(Array.from(s.sent[0]!)).toEqual(
      expectedBytes(
        [
          { kind: 'deploy', territoryId: 159, armies: 5 },
          { kind: 'card', card: 'Bomb', cardId: BOMB, target: 158 },
          { kind: 'card', card: 'EmergencyBlockade', cardId: WALL, target: 161 },
          { kind: 'move', from: 159, to: 158, armies: 9 },
        ],
        3,
      ),
    );
    const warnings = (preview as unknown as Preview).preview.warnings?.join('\n') ?? '';
    expect(warnings).toMatch(/UNVERIFIED encoding: the Emergency Blockade, Bomb card plays/);
    expect(warnings).toMatch(/Emergency Blockade: territory 161 turns neutral .*× 3/);
    expect(warnings).toMatch(/Bomb: territory 158's armies .*halved after the deploys/);
    expect(result).toMatchObject({ status: 'resolved', cardPlayCheck: expect.stringMatching(/not yet verified live/) });
  });

  it('warns when the Emergency Blockade gives up a member of a bonus I hold, and when moves leave it', async () => {
    const held = BOARD.map((t) => (t.id === 157 ? { ...t, owner: ANN.inGame } : t));
    const s = server(COMBAT_HAND, held);
    h = await liveHarness({ feed: [game({ settings: combatSettings() })], pages: ME_PAGE, warapp: s.warapp });
    const r = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [{ kind: 'card', card: 'Emergency Blockade', target: 161 }, DEPLOY, { kind: 'move', from: 161, to: 158, armies: 2 }],
    });
    expect(r.isError).toBeFalsy();
    const warnings = (payload(r) as unknown as Preview).preview.warnings?.join('\n') ?? '';
    expect(warnings).toMatch(/territory 161 is in bonus 118, which you hold: the blockade breaks it/);
    expect(warnings).toMatch(/moves from it in these orders will not run/);
  });

  it("plays the Bomb and Emergency Blockade orders warapp_plan_turn's card advice gives, as they are", async () => {
    const player = (id: string, name: string): Player => ({ id: Number(id), name, isAI: false, humanTurnedIntoAI: false, hasCommittedOrders: false, state: 'Playing' });
    const [ann, bob, cat] = [player(ANN.feed, 'Ann'), player(BOB.feed, 'Bob'), player(CAT.feed, 'Cat')];
    const foe = (territoryId: number, armies: number, p: Player) => ({ territoryId, owner: { kind: 'player' as const, playerId: p.id }, armies });
    const hand: Card[] = [
      { id: BOMB, type: 13, name: 'Bomb' },
      { id: WALL, type: 3, name: 'Emergency Blockade' },
    ];
    const cs = combatSettings();
    const { view } = adviseCards({
      game: { players: [ann, bob, cat], settings: { cards: ['Bomb', 'EmergencyBlockade'], raw: cs } },
      me: ann,
      turn: 3,
      info: null,
      hand,
      choice: { required: false, plays: [], discards: [], extraArmies: 0, warnings: [] },
      // #369: the advice board strikes from 135, not 159: Bob's 158 borders 159, so a wall on 161 with 159
      // behind it would be walked around and never advised.
      plan: {
        deploys: [{ territoryId: 135, armies: 5 }],
        moves: [{ from: 135, to: 158, armies: 10, kind: 'attack', reason: '' }],
        moveSlots: ['last'],
        enemyDeploy: 5,
        conceded: [161],
      },
      board: boardOf([mineState(135, 6, ann.id), mineState(161, 3, ann.id), foe(157, 2, cat), foe(158, 7, bob)]),
      graph: buildGraph(fixtureMap()),
      settings: { offensiveKillRate: 60, defensiveKillRate: 70 },
      label: (id) => `T${id}`,
    });
    const orders = [view.bomb?.order, view.emergencyBlockade?.order];
    expect(orders).toEqual([
      { kind: 'card', card: BOMB, target: 158 },
      { kind: 'card', card: WALL, target: 161 },
    ]);
    const s = server(COMBAT_HAND);
    h = await liveHarness({ feed: [game({ settings: cs }), game({ settings: cs }), game({ settings: cs, turns: '3' })], pages: ME_PAGE, warapp: s.warapp });
    await confirmed({ game_id: GAME, orders: [...orders, DEPLOY, { kind: 'move', from: 159, to: 158, armies: 10 }] });
    expect(Array.from(s.sent[0]!)).toEqual(
      expectedBytes(
        [
          { kind: 'deploy', territoryId: 159, armies: 5 },
          { kind: 'card', card: 'Bomb', cardId: BOMB, target: 158 },
          { kind: 'card', card: 'EmergencyBlockade', cardId: WALL, target: 161 },
          { kind: 'move', from: 159, to: 158, armies: 10 },
        ],
        3,
      ),
    );
  });

  // A Bomb on a territory an active truce covers is an attack on the partner: refused like a move into it
  // unless break_agreement is true, and then recorded broken-by-me once the orders are in.
  it('refuses a Bomb on a territory a truce covers without break_agreement; with it, warns and records broken-by-me', async () => {
    const s = server(COMBAT_HAND);
    const cs = combatSettings();
    // record, refused submit, preview, confirm, read back (the turn resolved), then the re-read for the record.
    h = await liveHarness({
      feed: [game({ settings: cs }), game({ settings: cs }), game({ settings: cs }), game({ settings: cs }), game({ settings: cs, turns: '3' })],
      pages: ME_PAGE,
      warapp: s.warapp,
    });
    payload(await h.call('warapp_record_agreement', { game_id: GAME, player: 'Ann', with: 'Bob', status: 'agreed' }));
    const orders = [{ kind: 'card', card: 'Bomb', target: 158 }, DEPLOY];
    const refused = await h.call('warapp_submit_turn', { game_id: GAME, orders });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/These orders break a truce — agreement a1 with player \d+ \(active\): the Bomb \(card play 1\) on 158 attacks a territory it covers: nothing was sent/);
    expect(textOf(refused)).toMatch(/break_agreement: true/);
    expect(s.sent).toEqual([]);
    const { preview, result } = await confirmed({ game_id: GAME, orders, break_agreement: true });
    expect((preview as unknown as Preview).preview.warnings?.join('\n')).toMatch(
      /the Bomb \(card play 1\) on 158 attacks a territory it covers\. break_agreement is true: once these orders are committed the ledger records it broken-by-me/,
    );
    expect(s.sent).toHaveLength(1);
    expect(result).toMatchObject({ status: 'resolved', agreementsBroken: [{ agreement: 'a1', ledger: 'recorded' }] });
    const ledger = JSON.parse(readFileSync(join(h.dataDir, 'relations', `${GAME}-${ANN.feed}.json`), 'utf8')) as { agreements: Array<{ status: string }> };
    expect(ledger.agreements[0]!.status).toBe('broken-by-me');
  });

  it('warapp_check_plan warns that a Bomb or Emergency Blockade in the orders is not simulated', async () => {
    const s = server(COMBAT_HAND);
    const cs = combatSettings();
    h = await liveHarness({ feed: [game({ settings: cs }), game({ settings: cs })], pages: ME_PAGE, warapp: s.warapp });
    const check = async (orders: unknown[]) =>
      payload<{ warnings: string[] }>(await h!.call('warapp_check_plan', { game_id: GAME, orders })).warnings.join('\n');
    const warned = await check([
      { kind: 'card', card: 'Bomb', target: 158 },
      { kind: 'card', card: WALL, target: 161 },
      DEPLOY,
      { kind: 'move', from: 159, to: 158, armies: 10 },
    ]);
    expect(warned).toMatch(/The Bomb on 158 is not simulated: the test fights at its armies before the Bomb halves them\./);
    expect(warned).toMatch(/The Emergency Blockade on 161 is not simulated: the test keeps it yours, armies unchanged\./);
    expect(await check([DEPLOY])).not.toMatch(/not simulated/);
  });

  it('bombs a neutral or fogged territory next to mine', async () => {
    const s = server(COMBAT_HAND);
    h = await liveHarness({ feed: [game({ settings: combatSettings() })], pages: ME_PAGE, warapp: s.warapp });
    const r = await h.call('warapp_submit_turn', { game_id: GAME, orders: [{ kind: 'card', card: 'Bomb', target: 135 }, DEPLOY] });
    expect(r.isError).toBeFalsy();
    expect((payload(r) as unknown as Preview).preview.warnings?.join('\n')).toMatch(/Territory 135 is fogged/);
  });

  const commanderBoard = BOARD.map((t) => (t.id === 161 ? { ...t, units: [{ kind: 'commander' as const, id: CMDR, owner: ANN.inGame }] } : t));
  const refusals: Array<{ name: string; orders: Array<Record<string, unknown>>; message: RegExp; hand?: SyntheticCard[]; board?: SyntheticTerritory[]; team?: boolean; settings?: Record<string, unknown> }> = [
    { name: 'a Bomb with no target', orders: [{ kind: 'card', card: 'Bomb' }], message: /A Bomb card needs `target`/ },
    { name: 'a Bomb naming a player', orders: [{ kind: 'card', card: 'Bomb', target: 158, player: 'Bob' }], message: /A Bomb card takes no player/ },
    { name: 'a Bomb on my own territory', orders: [{ kind: 'card', card: 'Bomb', target: 159 }], message: /cannot bomb your own .*error 526/ },
    { name: 'a Bomb on a teammate', orders: [{ kind: 'card', card: 'Bomb', target: 157 }], team: true, message: /cannot bomb your teammate's .*error 526/ },
    { name: 'a Bomb on a territory next to none of mine', orders: [{ kind: 'card', card: 'Bomb', target: 134 }], message: /next to none of yours .*error 527/ },
    { name: 'a Bomb not in play', orders: [{ kind: 'card', card: 'Bomb', target: 158 }], settings: combatSettings({ BombCard: 'none' }), message: /Bomb card is not in play/ },
    { name: 'an Emergency Blockade on a territory not mine', orders: [{ kind: 'card', card: 'Emergency Blockade', target: 158 }], message: /not yours .*error 95/ },
    {
      name: 'an Emergency Blockade twice on one territory',
      orders: [
        { kind: 'card', card: WALL, target: 161 },
        { kind: 'card', card: WALL2, target: 161 },
      ],
      hand: [...COMBAT_HAND, { id: WALL2, type: 3 }],
      message: /blockaded twice .*error 96/,
    },
    {
      name: 'an Emergency Blockade on my commander',
      orders: [{ kind: 'card', card: 'Emergency Blockade', target: 161 }],
      board: commanderBoard,
      settings: combatSettings({ Commanders: true }),
      message: /holds your commander, so it cannot be blockaded/,
    },
    {
      name: 'an Airlift onto a territory blockaded first',
      orders: [
        { kind: 'card', card: 'Emergency Blockade', target: 161 },
        { kind: 'card', card: 'Airlift', from: 159, to: 161, armies: 2 },
      ],
      hand: [...COMBAT_HAND, { id: AIR, type: 6 }],
      message: /blockaded before the Airlift runs, so the Airlift to it cannot happen/,
    },
  ];

  it.each(refusals)('refuses $name, sending nothing', async (c) => {
    const s = server(c.hand ?? COMBAT_HAND, c.board ?? BOARD);
    const cs = c.settings ?? combatSettings();
    h = await liveHarness({ feed: [game({ settings: cs, ...(c.team ? { team: true } : {}) })], pages: ME_PAGE, warapp: s.warapp });
    const res = await h.call('warapp_submit_turn', { game_id: GAME, orders: [...c.orders, DEPLOY] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(c.message);
    expect(s.sent).toEqual([]);
  });
});
