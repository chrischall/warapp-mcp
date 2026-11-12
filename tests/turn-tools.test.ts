import { afterEach, describe, expect, it } from 'vitest';
import { Writer, type DecodedRequest, type ReplyFrame } from '../src/protocol/codec.js';
import { Method, writeSendOrdersParams, type TurnOrder } from '../src/protocol/methods.js';
import { plannerSettings, turnOrdersArg } from '../src/tools/turn.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
// Synthetic GameFeed ids: the in-game id wrapped in two check digits each end.
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };

function game(state: string, extra: Record<string, unknown> = {}, ann: Record<string, string> = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>).map((p, i) =>
    i === 0 ? { ...p, id: ANN.feed, name: 'Ann', ...ann } : i === 1 ? { ...p, id: BOB.feed, name: 'Bob' } : p,
  );
  return { ...f, state, numberOfTurns: state === 'Playing' ? '2' : '-1', players, ...extra };
}

function mapName(id: number): string {
  const map = lobbyFixture().map as { territories: Array<{ id: string; name: string }> };
  return map.territories.find((t) => Number(t.id) === id)!.name;
}

// Fixture map: 159 Hornwood – 161 Sheepshead Hills – 157 Widow's Watch form bonus
// 118 (+2); 158 Bolton Moors borders all three of 159/161/157; 135 borders 159 and 158.
const BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 7 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

type Routes = Partial<Record<number, (req: DecodedRequest, n: number) => Partial<ReplyFrame>>>;
function routes(r: Routes) {
  return (req: DecodedRequest, n: number): Partial<ReplyFrame> => {
    const f = r[req.method];
    if (!f) throw new Error(`unexpected method ${req.method}`);
    return f(req, n);
  };
}
const board = (territories: SyntheticTerritory[] | null) => () =>
  ({ body: (w) => writeLatestGameInfo(w, territories, [ANN.inGame]) }) satisfies Partial<ReplyFrame>;

interface Named {
  id: number;
  name: string;
}
interface PlanPayload {
  game: { id: number; name: string | null; turn: number | null };
  player: { id: number; name: string };
  goal: string;
  income: number;
  deploys: Array<{ territory: Named; armies: number }>;
  moves: Array<{ from: Named; to: Named; armies: number; kind: string; reason?: string }>;
  expected: { captures: Named[]; bonusesCompleted: Array<Named & { value: number }>; nextIncome: number };
  warnings: string[];
  rationale: string[];
  orders: Array<Record<string, unknown>>;
  settings?: Record<string, unknown>;
  untrusted_content?: boolean;
}

describe('warapp_plan_turn', () => {
  it('plans from the live board: deploys and moves by name and id, expected bonuses, and submit-shaped orders', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.untrusted_content).toBe(true);
    expect(p.game).toEqual({ id: GAME, name: 'Synthetic lobby game', turn: 3 });
    expect(p.player).toEqual({ id: Number(ANN.feed), name: 'Ann' });
    expect(p.goal).toBe('expand');
    expect(p.income).toBe(5);

    // Widow's Watch (2 neutrals) completes bonus 118: 3 armies at 60% from Sheepshead Hills (3, guard 1).
    expect(p.moves[0]).toEqual({
      from: { id: 161, name: mapName(161) },
      to: { id: 157, name: mapName(157) },
      armies: 3,
      kind: 'attack',
    });
    expect(p.expected.captures).toEqual([{ id: 157, name: mapName(157) }]);
    expect(p.expected.bonusesCompleted).toEqual([{ id: 118, name: 'Broken Branch Riverlords', value: 2 }]);
    expect(p.expected.nextIncome).toBe(7);
    expect(p.deploys.reduce((s, d) => s + d.armies, 0)).toBe(5);
    expect(p.deploys.find((d) => d.territory.id === 161)?.armies).toBeGreaterThanOrEqual(1);
    expect(p.deploys.every((d) => d.territory.name === mapName(d.territory.id))).toBe(true);
    // Bob's 7 next door is a threat; the fogged Knife Hills is never attacked.
    expect(p.warnings.join('\n')).toMatch(/could be taken next turn/);
    expect(p.warnings.join('\n')).toMatch(/Fogged territory/);
    expect(p.moves.some((m) => m.to.id === 135 || m.to.id === 158)).toBe(false);
    expect(p.rationale.length).toBeGreaterThan(0);

    // The orders array: deploys then moves, ids only, exactly what warapp_submit_turn takes.
    expect(p.orders).toEqual([
      ...p.deploys.map((d) => ({ kind: 'deploy', territory: d.territory.id, armies: d.armies })),
      ...p.moves.map((m) => ({ kind: 'move', from: m.from.id, to: m.to.id, armies: m.armies })),
    ]);
    expect(turnOrdersArg.safeParse(p.orders).success).toBe(true);
    expect(p).not.toHaveProperty('settings');

    // One read through the bridge; nothing sent.
    expect(h.exchanges.map((e) => e.request.method)).toEqual([Method.GetLatestGameInfo]);
  });

  it('defaults to the signed-in account, found by its invite token', async () => {
    h = await liveHarness({
      feed: [game('Playing')],
      pages: { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` },
      warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }),
    });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME }));
    expect(p.player).toEqual({ id: Number(ANN.feed), name: 'Ann' });
    expect(p.moves.length).toBeGreaterThan(0);
  });

  it('goal defend holds the threatened border first', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', goal: 'defend' }));
    expect(p.goal).toBe('defend');
    expect(p.rationale.join('\n')).toMatch(/so it holds/);
  });

  it('focus takes bonus names or ids; reserve is held out of captures', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const p = payload<PlanPayload>(
      await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', focus: ['Broken Branch', 116], reserve: 5 }),
    );
    expect(p.rationale.join('\n')).toMatch(/Hold a reserve of 5/);
    expect(p.moves.filter((m) => m.kind === 'attack').every((m) => m.from.id !== 161 || m.armies <= 2)).toBe(true);
  });

  it('an unknown focus bonus is a clear error', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const res = await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', focus: ['No Such Bonus'] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/No bonus matches "No Such Bonus"/);
  });

  it('an ambiguous focus bonus lists the matches', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const res = await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', focus: ['The'] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/"The" matches \d+ bonuses: /);
    expect(h.exchanges).toEqual([]);
  });

  it('full adds move reasons and the settings the plan assumed', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', view: 'full' }));
    expect(p.moves[0]!.reason).toMatch(/completes bonus/);
    expect(p.settings).toEqual({
      offensiveKillRate: 60,
      defensiveKillRate: 70,
      luckModifier: 0,
      roundingMode: 'StraightRound',
      oneArmyStandsGuard: true,
      multiAttack: false,
      allowTransferOnly: true,
    });
  });

  it('warns when my orders are already committed this turn', async () => {
    h = await liveHarness({
      feed: [game('Playing', {}, { hasCommittedOrders: 'True' })],
      warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }),
    });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.warnings[0]).toMatch(/already committed orders/);
  });

  it.each(['WaitingForPlayers', 'DistributingTerritories', 'Finished'])(
    'refuses outside a turn phase (%s) and reads nothing through the bridge',
    async (state) => {
      h = await liveHarness({ feed: [game(state)] });
      const res = await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(new RegExp(`not in a turn phase \\(game state: ${state}\\)`));
      expect(h.exchanges).toEqual([]);
    },
  );

  it('turn is null when GameFeed gives no turn count', async () => {
    const g = game('Playing');
    delete g.numberOfTurns;
    h = await liveHarness({ feed: [g], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.game.turn).toBeNull();
  });
});

describe('plannerSettings', () => {
  it('maps game settings; AllowTransferOnly (the per-order mode toggle) never turns transfers off', () => {
    expect(plannerSettings(undefined)).toEqual({});
    expect(
      plannerSettings({ cards: [], raw: { AllowTransferOnly: false }, offensiveKillRate: 50, luckModifier: 0.16 }),
    ).toEqual({ offensiveKillRate: 50, luckModifier: 0.16 });
  });
});

describe('turnOrdersArg', () => {
  it('takes territories by id or name and rejects a bad order', () => {
    expect(
      turnOrdersArg.safeParse([
        { kind: 'deploy', territory: 'Hornwood', armies: 3 },
        { kind: 'move', from: 159, to: '158', armies: 2 },
      ]).success,
    ).toBe(true);
    expect(turnOrdersArg.safeParse([]).success).toBe(false);
    expect(turnOrdersArg.safeParse([{ kind: 'deploy', territory: 1, armies: 0 }]).success).toBe(false);
    expect(turnOrdersArg.safeParse([{ kind: 'attack', from: 1, to: 2, armies: 1 }]).success).toBe(false);
  });
});

describe('warapp_submit_turn', () => {
  const ME_PAGE = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };
  // Ann: Hornwood 159 (6), Sheepshead Hills 161 (3); income 5; one army stands guard.
  const GOOD = [
    { kind: 'deploy', territory: 'Hornwood', armies: 3 },
    { kind: 'deploy', territory: 161, armies: 2 },
    { kind: 'move', from: 161, to: "Widow's Watch", armies: 4 },
    { kind: 'move', from: 159, to: 158, armies: 8 },
  ];

  function ordersServer(reply: Partial<ReplyFrame> = { body: (w) => w.bool(true).bool(false) }) {
    const sent: Uint8Array[] = [];
    const warapp = routes({
      [Method.GetLatestGameInfo]: board(BOARD),
      [Method.SendOrders]: (req) => {
        sent.push(req.body.raw(req.body.remaining));
        return reply;
      },
    });
    return { sent, warapp };
  }

  const expectedBytes = (orders: TurnOrder[], turn: number) => {
    const w = new Writer();
    writeSendOrdersParams(w, GAME, ANN.inGame, orders, turn);
    return w.bytes();
  };

  async function confirmed(args: Record<string, unknown>) {
    const preview = payload(await h!.call('warapp_submit_turn', args));
    expect(preview.confirmToken).toEqual(expect.any(String));
    return h!.call('warapp_submit_turn', { ...args, confirmToken: preview.confirmToken });
  }

  it('the description says orders reach the game and other players see the results', async () => {
    h = await liveHarness();
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_submit_turn')!;
    expect(tool.description).toMatch(/reach the game/);
    expect(tool.description).toMatch(/other players see the results/);
    expect(tool.annotations?.readOnlyHint).toBe(false);
  });

  it('previews every order by name with the turn number, and sends nothing until confirmed', async () => {
    const s = ordersServer();
    h = await liveHarness({ feed: [game('Playing')], pages: ME_PAGE, warapp: s.warapp });
    const preview = payload(await h.call('warapp_submit_turn', { game_id: GAME, orders: GOOD }));
    expect(preview.confirmToken).toEqual(expect.any(String));
    const text = JSON.stringify(preview);
    for (const id of [159, 161, 157, 158]) expect(text).toContain(JSON.stringify(mapName(id)).slice(1, -1));
    expect(text).toMatch(/"turn":3/);
    expect(s.sent).toEqual([]);
    expect(h.exchanges.map((e) => e.request.method)).toEqual([Method.GetLatestGameInfo]);
  });

  it('sends SendOrders (deploys first, turn = numberOfTurns + 1) and reports resolved when the turn advanced', async () => {
    const s = ordersServer();
    h = await liveHarness({
      feed: [game('Playing'), game('Playing'), game('Playing', { numberOfTurns: '3' })],
      pages: ME_PAGE,
      warapp: s.warapp,
    });
    const reordered = [GOOD[2], GOOD[0], GOOD[3], GOOD[1]];
    const p = payload(await confirmed({ game_id: GAME, player: 'Ann', orders: reordered }));
    expect(s.sent).toHaveLength(1);
    expect(Array.from(s.sent[0]!)).toEqual(
      Array.from(
        expectedBytes(
          [
            { kind: 'deploy', territoryId: 159, armies: 3 },
            { kind: 'deploy', territoryId: 161, armies: 2 },
            { kind: 'move', from: 161, to: 157, armies: 4 },
            { kind: 'move', from: 159, to: 158, armies: 8 },
          ],
          3,
        ),
      ),
    );
    expect(p).toMatchObject({ status: 'resolved', game: GAME, turn: 3 });
    expect(JSON.stringify(p)).not.toMatch(/vacation/i);
  });

  it('reports committed when my orders are marked committed but the turn has not advanced', async () => {
    const s = ordersServer({ body: (w) => w.bool(true).bool(false) });
    h = await liveHarness({
      feed: [game('Playing'), game('Playing'), game('Playing', {}, { hasCommittedOrders: 'True' })],
      pages: ME_PAGE,
      warapp: s.warapp,
    });
    const p = payload(await confirmed({ game_id: GAME, orders: GOOD }));
    expect(s.sent).toHaveLength(1);
    expect(p).toMatchObject({ status: 'committed', turn: 3 });
  });

  it('reports unknown (never success from the reply bool) when game state shows neither', async () => {
    const s = ordersServer({ body: (w) => w.bool(true).bool(true) });
    h = await liveHarness({ feed: [game('Playing')], pages: ME_PAGE, warapp: s.warapp });
    const p = payload(await confirmed({ game_id: GAME, orders: GOOD }));
    expect(p.status).toBe('unknown');
    expect(p.warning).toMatch(/warapp_get_game|warapp_get_live_board/);
  });

  it('reports unknown when the state re-read fails after sending', async () => {
    const s = ordersServer();
    h = await liveHarness({
      feed: [game('Playing'), game('Playing'), { termsOfUse: 'x', error: 'Something broke' }],
      pages: ME_PAGE,
      warapp: s.warapp,
    });
    const p = payload(await confirmed({ game_id: GAME, orders: GOOD }));
    expect(s.sent).toHaveLength(1);
    expect(p.status).toBe('unknown');
    expect(p.warning).toMatch(/Do not resend/i);
  });

  it('a transport failure after sending is unknown, not safe to retry', async () => {
    h = await liveHarness({
      feed: [game('Playing')],
      pages: ME_PAGE,
      warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD), [Method.SendOrders]: () => ({ msgNum: 999 }) }),
    });
    const p = payload(await confirmed({ game_id: GAME, orders: GOOD }));
    expect(p.status).toBe('unknown');
    expect(p.warning).toMatch(/may already have been committed/);
    expect(p.warning).toMatch(/Do not resend/i);
  });

  it('a server refusal is an error (error 11: deployments differ from income)', async () => {
    const s = ordersServer({ error: { code: 11, message: 'x' } });
    h = await liveHarness({ feed: [game('Playing')], pages: ME_PAGE, warapp: s.warapp });
    const res = await confirmed({ game_id: GAME, orders: GOOD });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/war\.app error 11/);
  });

  it('refuses an explicit player who is not the signed-in account, before any preview', async () => {
    const s = ordersServer();
    h = await liveHarness({ feed: [game('Playing')], pages: ME_PAGE, warapp: s.warapp });
    const res = await h.call('warapp_submit_turn', { game_id: GAME, player: 'Bob', orders: GOOD });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/signed-in account/);
    expect(h.exchanges).toEqual([]);
  });

  it('refuses when the signed-in account cannot be determined, even with an explicit player', async () => {
    const s = ordersServer();
    h = await liveHarness({ feed: [game('Playing')], warapp: s.warapp });
    const res = await h.call('warapp_submit_turn', { game_id: GAME, player: 'Ann', orders: GOOD });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Could not tell which war\.app account is signed in/);
    expect(h.exchanges).toEqual([]);
  });

  it('refuses when the signed-in account is not in the game', async () => {
    h = await liveHarness({
      feed: [game('Playing')],
      pages: { 'https://war.app/InviteToken': '<p>Your invite token is 5512345699</p>' },
    });
    const res = await h.call('warapp_submit_turn', { game_id: GAME, orders: GOOD });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not a player in game/);
  });

  it('refuses when my orders are already committed this turn', async () => {
    h = await liveHarness({ feed: [game('Playing', {}, { hasCommittedOrders: 'True' })], pages: ME_PAGE });
    const res = await h.call('warapp_submit_turn', { game_id: GAME, orders: GOOD });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/already committed/);
    expect(textOf(res)).toMatch(/modify/i);
    expect(h.exchanges).toEqual([]);
  });

  it('refuses outside a turn phase', async () => {
    h = await liveHarness({ feed: [game('DistributingTerritories')], pages: ME_PAGE });
    const res = await h.call('warapp_submit_turn', { game_id: GAME, orders: GOOD });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not in a turn phase/);
  });

  it('refuses when GameFeed gives no turn count', async () => {
    const g = game('Playing');
    delete g.numberOfTurns;
    h = await liveHarness({ feed: [g], pages: ME_PAGE });
    const res = await h.call('warapp_submit_turn', { game_id: GAME, orders: GOOD });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/turn number/);
  });

  it('refuses deploys that do not total the income, giving both numbers', async () => {
    h = await liveHarness({ feed: [game('Playing')], pages: ME_PAGE, warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const res = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [{ kind: 'deploy', territory: 159, armies: 4 }],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/deploy 4 armies.*income is 5/);
  });

  it('refuses a deploy or a move source that is not mine', async () => {
    h = await liveHarness({ feed: [game('Playing')], pages: ME_PAGE, warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    let res = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [{ kind: 'deploy', territory: 157, armies: 5 }],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not yours.*\(157\)/);
    res = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [
        { kind: 'deploy', territory: 159, armies: 5 },
        { kind: 'move', from: 135, to: 159, armies: 1 },
      ],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not yours.*\(135\)/);
  });

  it('refuses a move to a territory that is not adjacent', async () => {
    h = await liveHarness({ feed: [game('Playing')], pages: ME_PAGE, warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const res = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [
        { kind: 'deploy', territory: 159, armies: 5 },
        { kind: 'move', from: 159, to: 157, armies: 2 },
      ],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/does not border/);
  });

  it('refuses sending more armies from a territory than it has (deploys included, one stands guard)', async () => {
    h = await liveHarness({ feed: [game('Playing')], pages: ME_PAGE, warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const res = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [
        { kind: 'deploy', territory: 159, armies: 5 },
        { kind: 'move', from: 161, to: 157, armies: 2 },
        { kind: 'move', from: 161, to: 158, armies: 1 },
      ],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/send 3 armies from .*\(161\).* at most 2/);
  });

  it('lets every army move when one army does not stand guard', async () => {
    const f = lobbyFixture();
    const settings = { ...(f.settings as Record<string, unknown>), OneArmyStandsGuard: false };
    const s = ordersServer();
    h = await liveHarness({ feed: [game('Playing', { settings })], pages: ME_PAGE, warapp: s.warapp });
    const preview = payload(
      await h.call('warapp_submit_turn', {
        game_id: GAME,
        orders: [
          { kind: 'deploy', territory: 159, armies: 5 },
          { kind: 'move', from: 161, to: 157, armies: 3 },
        ],
      }),
    );
    expect(preview.confirmToken).toEqual(expect.any(String));
  });

  it('refuses the same move listed twice', async () => {
    h = await liveHarness({ feed: [game('Playing')], pages: ME_PAGE, warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const res = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [
        { kind: 'deploy', territory: 159, armies: 5 },
        { kind: 'move', from: 159, to: 158, armies: 2 },
        { kind: 'move', from: 159, to: 158, armies: 2 },
      ],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/listed twice/);
  });

  it('an unknown territory name is a clear error', async () => {
    h = await liveHarness({ feed: [game('Playing')], pages: ME_PAGE });
    const res = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [{ kind: 'deploy', territory: 'Nowhere At All', armies: 5 }],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/No territory matches "Nowhere At All"/);
  });

  it('changed orders between preview and confirm are refused', async () => {
    const s = ordersServer();
    h = await liveHarness({ feed: [game('Playing')], pages: ME_PAGE, warapp: s.warapp });
    const preview = payload(await h.call('warapp_submit_turn', { game_id: GAME, orders: GOOD }));
    const res = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [{ kind: 'deploy', territory: 159, armies: 5 }],
      confirmToken: preview.confirmToken,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/DRAFT_CHANGED/);
    expect(s.sent).toEqual([]);
  });
});
