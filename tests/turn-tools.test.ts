import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Writer, type DecodedRequest, type ReplyFrame } from '../src/protocol/codec.js';
import { Method, writeSendOrdersParams, type TurnOrder } from '../src/protocol/methods.js';
import { plannerSettings, turnOrdersArg } from '../src/tools/turn.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticCard, type SyntheticTerritory } from './protocol/live-bundle.js';

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
  enemyDeploy: number;
  deploys: Array<{ territory: Named; armies: number }>;
  moves: Array<{ from: Named; to: Named; armies: number; kind: string; reason?: string }>;
  expected: { captures: Named[]; bonusesCompleted: Array<Named & { value: number }>; nextIncome: number };
  warnings: string[];
  rationale: string[];
  orders: Array<Record<string, unknown>>;
  settings?: Record<string, unknown>;
  trendSource: 'history' | 'cache' | null;
  conceded: Named[];
  cardAdvice: 'order-priority' | null;
  untrusted_content?: boolean;
}

describe('warapp_plan_turn', () => {
  it('plans from the live board: deploys and moves by name and id, expected bonuses, and submit-shaped orders', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.untrusted_content).toBe(true);
    expect(p.game).toEqual({ id: GAME, name: 'Synthetic lobby game', turn: 3 });
    expect(p.player).toEqual({ id: Number(ANN.feed), name: 'Ann' });
    expect(p.goal).toBe('balanced');
    expect(p.income).toBe(5);
    expect(p.trendSource).toBeNull();
    expect(p).toHaveProperty('conceded');
    expect(p).toHaveProperty('cardAdvice');

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

  it('accepts each goal and describes all four', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    for (const goal of ['balanced', 'expand', 'complete-bonus', 'defend']) {
      const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', goal }));
      expect(p.goal).toBe(goal);
    }
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_plan_turn')!;
    expect(tool.description).toMatch(/"balanced" \(default\)/);
    for (const goal of ['expand', 'complete-bonus', 'defend']) expect(tool.description).toContain(`"${goal}"`);
    const props = (tool.inputSchema as { properties: Record<string, { enum?: string[]; description?: string }> }).properties;
    expect(props.goal!.enum).toEqual(['balanced', 'expand', 'complete-bonus', 'defend']);
    expect(props.goal!.description).toMatch(/balanced \(default\)/);
  });

  it('goal defend triages the threatened border by the income it protects', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', goal: 'defend' }));
    expect(p.goal).toBe('defend');
    // Ann's threatened border is in no held bonus: it protects +0, so it is conceded, not held.
    expect(p.warnings.join('\n')).toMatch(/cannot be held economically \(needs \d+, protects \+0\): conceded/);
    expect(p.rationale.join('\n')).not.toMatch(/so it holds/);
    // The conceded border, by name and id, and the card the withdrawal from it needs.
    expect(p.conceded.length).toBeGreaterThan(0);
    for (const c of p.conceded) {
      expect(c.name).toBe(mapName(c.id));
      expect(p.warnings.join('\n')).toContain(`${c.name} (#${c.id}) cannot be held`);
    }
    // Every territory Ann holds is conceded, so there is nowhere to withdraw to: no card advice.
    expect(p.warnings.join('\n')).toMatch(/is conceded and has nowhere to withdraw to/);
    expect(p.cardAdvice).toBeNull();
  });

  it('reports a conceded border and the Order Priority advice its withdrawal needs', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    // With no enemy deploy, Bob's 6 movable threaten only Sheepshead Hills (3): it protects +0,
    // so it is conceded, and its 2 movable armies withdraw to Hornwood (6), which holds.
    const p = payload<PlanPayload>(
      await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', goal: 'defend', enemy_deploy: 0 }),
    );
    expect(p.conceded).toEqual([{ id: 161, name: mapName(161) }]);
    expect(p.cardAdvice).toBe('order-priority');
    expect(p.moves[0]).toEqual({
      from: { id: 161, name: mapName(161) },
      to: { id: 159, name: mapName(159) },
      armies: 2,
      kind: 'transfer',
    });
    expect(p.deploys.some((d) => d.territory.id === 161)).toBe(false);
    expect(p.warnings.join('\n')).toContain(`play Order Priority so it goes first`);
  });

  it('reports the enemy deploy estimate; enemy_deploy overrides it', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    // Bob shows 7: max(5, round(0.75 × 7)) = 5.
    const def = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(def.enemyDeploy).toBe(5);
    expect(def.warnings.join('\n')).toMatch(/Enemy deploy estimate: .*~5 .*largest visible enemy stack \(7\).*unknown/);
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', enemy_deploy: 0 }));
    expect(p.enemyDeploy).toBe(0);
    expect(p.warnings.join('\n')).toMatch(/~0 \(your estimate\)/);
    const bad = await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', enemy_deploy: -1 });
    expect(bad.isError).toBe(true);
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

describe('warapp_plan_turn — threat trend', () => {
  // The previous turn's standing (turn 3 is being played, so 2 turns are done
  // and the previous board is the one after 1). Bob's Bolton Moors grew 3 → 7.
  const previous = [
    { terrID: 159, ownedBy: ANN.feed, armies: 6, fogLevel: 'Visible' },
    { terrID: 161, ownedBy: ANN.feed, armies: 3, fogLevel: 'Visible' },
    { terrID: 158, ownedBy: String(BOB.inGame), armies: 3, fogLevel: 'Visible' },
  ];
  const building = (from: number, to: number) =>
    new RegExp(`${mapName(158)} \\(#158\\) is building: \\+${to - from}/turn \\(${from} → ${to}\\)`);
  const cacheFile = (dir: string) => join(dir, 'boards', `${GAME}.json`);

  it('(h) uses GetHistory\'s standing for the previous turn when present', async () => {
    h = await liveHarness({
      feed: [game('Playing', { history: [{ turn: 0, standing: [] }, { turn: 1, standing: previous }] })],
      warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }),
    });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.trendSource).toBe('history');
    expect(p.warnings.join('\n')).toMatch(building(3, 7));
    expect(h.calls.some((c) => c.url.includes('GetHistory=true'))).toBe(true);
  });

  it('(h) falls back to the cached board of the previous turn, and caches each planned board', async () => {
    // Turn 3: no history, no cache. The board is cached as turn 3.
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const first = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(first.trendSource).toBeNull();
    expect(first.warnings.join('\n')).not.toMatch(/is building/);
    const cached = JSON.parse(readFileSync(cacheFile(h.dataDir), 'utf8')) as { turns: object; playerId: number };
    expect(cached).toMatchObject({ gameId: GAME, playerId: Number(ANN.feed) });
    expect(Object.keys(cached.turns)).toEqual(['3']);
    const dir = h.dataDir;
    await h.harness.close();

    // Turn 4: Bob's stack grew 7 → 12; the cache (turn 3) is exactly the previous turn.
    const grown = BOARD.map((t) => (t.id === 158 ? { ...t, armies: 12 } : t));
    h = await liveHarness({
      dataDir: dir,
      feed: [game('Playing', { numberOfTurns: '3' })],
      warapp: routes({ [Method.GetLatestGameInfo]: board(grown) }),
    });
    const second = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(second.trendSource).toBe('cache');
    expect(second.warnings.join('\n')).toMatch(building(7, 12));
    expect(Object.keys((JSON.parse(readFileSync(cacheFile(dir), 'utf8')) as { turns: object }).turns)).toEqual(['3', '4']);
  });

  it('(h) planning the same turn twice keeps the trend (the previous turn stays cached)', async () => {
    // Turn 3 planned and cached.
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' });
    const dir = h.dataDir;
    await h.harness.close();

    // Turn 4, planned twice (another goal, then again after a hand override).
    const grown = BOARD.map((t) => (t.id === 158 ? { ...t, armies: 12 } : t));
    h = await liveHarness({
      dataDir: dir,
      feed: [game('Playing', { numberOfTurns: '3' }), game('Playing', { numberOfTurns: '3' })],
      warapp: routes({ [Method.GetLatestGameInfo]: board(grown) }),
    });
    const once = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    const twice = payload<PlanPayload>(
      await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', goal: 'defend' }),
    );
    expect(once.trendSource).toBe('cache');
    expect(twice.trendSource).toBe('cache');
    expect(twice.warnings.join('\n')).toMatch(building(7, 12));
  });

  it('(h) ignores a cache from any turn but the previous one', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' });
    const dir = h.dataDir;
    await h.harness.close();
    // Turn 5 is being played: the cached turn 3 is two turns old.
    h = await liveHarness({
      dataDir: dir,
      feed: [game('Playing', { numberOfTurns: '4' })],
      warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }),
    });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.trendSource).toBeNull();
  });

  it('(h) neither history nor cache, or a failing history read: trendSource null, no throw', async () => {
    h = await liveHarness({
      feed: [game('Playing'), { termsOfUse: 'x', error: 'Something broke' }],
      warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }),
    });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.trendSource).toBeNull();
    expect(p.moves.length).toBeGreaterThan(0);
    expect(existsSync(cacheFile(h.dataDir))).toBe(true);
  });

  it('(h) an unusable history standing is ignored', async () => {
    h = await liveHarness({
      feed: [game('Playing', { history: { turn1: 'garbage' } })],
      warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }),
    });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.trendSource).toBeNull();
  });
});

describe('plannerSettings', () => {
  it('maps game settings; AllowTransferOnly (the per-order mode toggle) never turns transfers off', () => {
    expect(plannerSettings(undefined)).toEqual({});
    expect(
      plannerSettings({ cards: [], raw: { AllowTransferOnly: false }, offensiveKillRate: 50, luckModifier: 0.16 }),
    ).toEqual({ offensiveKillRate: 50, luckModifier: 0.16 });
    // Per-territory income feeds a border's protected value; 0 means off.
    expect(plannerSettings({ cards: [], raw: {}, bonusArmyPer: 3 })).toEqual({ bonusArmyPer: 3 });
    expect(plannerSettings({ cards: [], raw: {}, bonusArmyPer: 0 })).toEqual({});
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

describe('cards in the turn tools', () => {
  const ME_PAGE = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };
  // Synthetic card GUIDs.
  const R1 = '0123456789abcdef0123456789abcdef';
  const OP = 'fedcba9876543210fedcba9876543210';
  const OD = '11111111222222223333333344444444';
  const BL = 'aaaaaaaabbbbbbbbccccccccdddddddd';
  const BL2 = 'aaaaaaaabbbbbbbbccccccccddddddde';
  const AL = '55555555666666667777777788888888';
  const withHand = (hand: SyntheticCard[]) => () =>
    ({ body: (w) => writeLatestGameInfo(w, BOARD, [ANN.inGame, BOB.inGame], { [ANN.inGame]: hand }) }) satisfies Partial<ReplyFrame>;

  interface CardsPayload extends PlanPayload {
    cards: {
      hand: Array<{ id: string; name: string; armies?: number }>;
      maxCardsHold: number | null;
      playRequired: boolean;
      plays: Array<{ id: string; name: string; armies?: number }>;
      armiesFromCards: number;
    };
  }

  function ordersServer(hand: SyntheticCard[]) {
    const sent: Uint8Array[] = [];
    const warapp = routes({
      [Method.GetLatestGameInfo]: withHand(hand),
      [Method.SendOrders]: (req) => {
        sent.push(req.body.raw(req.body.remaining));
        return { body: (w) => w.bool(true).bool(false) };
      },
    });
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
    return h!.call('warapp_submit_turn', { ...args, confirmToken: preview.confirmToken });
  }

  it('plan_turn reports the hand, plays Reinforcement first and plans with its armies', async () => {
    h = await liveHarness({
      feed: [game('Playing')],
      warapp: routes({ [Method.GetLatestGameInfo]: withHand([{ id: R1, type: 1, armies: 5 }, { id: OP, type: 4 }]) }),
    });
    const p = payload<CardsPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.cards.hand.map((c) => c.name)).toEqual(['Reinforcement', 'Order Priority']);
    expect(p.cards.maxCardsHold).toBe(5);
    expect(p.cards.playRequired).toBe(false);
    expect(p.cards.plays).toEqual([{ id: R1, name: 'Reinforcement', armies: 5 }]);
    expect(p.cards.armiesFromCards).toBe(5);
    expect(p.income).toBe(10);
    expect(p.deploys.reduce((s, d) => s + d.armies, 0)).toBe(10);
    expect(p.orders[0]).toEqual({ kind: 'card', card: R1 });
    expect(p.orders.filter((o) => o.kind === 'card')).toHaveLength(1);
    expect(turnOrdersArg.safeParse(p.orders).success).toBe(true);
  });

  it('plan_turn with no cards reports an empty hand and plays nothing', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const p = payload<CardsPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.cards).toEqual({ hand: [], maxCardsHold: 5, playRequired: false, plays: [], armiesFromCards: 0 });
    expect(p.orders.some((o) => o.kind === 'card')).toBe(false);
  });

  it('plan_turn at the hold limit plays Order Priority, else Order Delay, never Blockade', async () => {
    h = await liveHarness({
      feed: [game('Playing')],
      warapp: routes({
        [Method.GetLatestGameInfo]: withHand([
          { id: BL, type: 12 },
          { id: OD, type: 5 },
          { id: OP, type: 4 },
          { id: BL2, type: 12 },
          { id: AL, type: 6 },
        ]),
      }),
    });
    const p = payload<CardsPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.cards.playRequired).toBe(true);
    expect(p.cards.plays).toEqual([{ id: OP, name: 'Order Priority' }]);
    expect(p.orders[0]).toEqual({ kind: 'card', card: OP });
    expect(p.income).toBe(5);
  });

  it('plan_turn warns when a play is required and only Blockade-like cards are held', async () => {
    h = await liveHarness({
      feed: [game('Playing')],
      warapp: routes({
        [Method.GetLatestGameInfo]: withHand([
          { id: BL, type: 12 },
          { id: BL2, type: 12 },
          { id: AL, type: 6 },
          { id: OD.replace(/1/g, '9'), type: 6 },
          { id: OP.replace(/f/g, '0'), type: 8 },
        ]),
      }),
    });
    const p = payload<CardsPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.cards.playRequired).toBe(true);
    expect(p.cards.plays).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(/must play a card/);
  });

  it('submit_turn plays a card by GUID first, counting Reinforcement armies into income', async () => {
    const s = ordersServer([{ id: R1, type: 1, armies: 5 }]);
    h = await liveHarness({
      feed: [game('Playing'), game('Playing'), game('Playing', { numberOfTurns: '3' })],
      pages: ME_PAGE,
      warapp: s.warapp,
    });
    const p = payload(
      await confirmed({
        game_id: GAME,
        orders: [
          { kind: 'deploy', territory: 159, armies: 10 },
          { kind: 'card', card: R1.toUpperCase() },
        ],
      }),
    );
    expect(p).toMatchObject({ status: 'resolved' });
    expect(Array.from(s.sent[0]!)).toEqual(
      expectedBytes(
        [
          { kind: 'card', card: 'Reinforcement', cardId: R1 },
          { kind: 'deploy', territoryId: 159, armies: 10 },
        ],
        3,
      ),
    );
    expect(JSON.stringify(p)).toContain('Reinforcement');
  });

  it('submit_turn takes a card by type name and a Blockade on my own territory', async () => {
    const s = ordersServer([
      { id: OP, type: 4 },
      { id: BL, type: 12 },
    ]);
    h = await liveHarness({ feed: [game('Playing'), game('Playing'), game('Playing', { numberOfTurns: '3' })], pages: ME_PAGE, warapp: s.warapp });
    await confirmed({
      game_id: GAME,
      orders: [
        { kind: 'card', card: 'order priority' },
        { kind: 'card', card: 'Blockade', target: 'Sheepshead Hills' },
        { kind: 'deploy', territory: 159, armies: 5 },
      ],
    });
    expect(Array.from(s.sent[0]!)).toEqual(
      expectedBytes(
        [
          { kind: 'card', card: 'OrderPriority', cardId: OP },
          { kind: 'deploy', territoryId: 159, armies: 5 },
          { kind: 'card', card: 'Blockade', cardId: BL, target: 161 },
        ],
        3,
      ),
    );
  });

  it('submit_turn plays Order Delay alongside another card play, writing it after the moves (phase 50)', async () => {
    const s = ordersServer([
      { id: OP, type: 4 },
      { id: OD, type: 5 },
    ]);
    h = await liveHarness({ feed: [game('Playing'), game('Playing'), game('Playing', { numberOfTurns: '3' })], pages: ME_PAGE, warapp: s.warapp });
    const args = {
      game_id: GAME,
      orders: [
        { kind: 'card', card: 'Order Delay' },
        { kind: 'card', card: OP },
        { kind: 'deploy', territory: 159, armies: 5 },
      ],
    };
    const preview = payload(await h.call('warapp_submit_turn', args));
    expect(preview.confirmToken).toEqual(expect.any(String));
    const text = JSON.stringify(preview);
    expect(text).toContain('Order Delay');
    expect(text).toContain('Order Priority');
    await h.call('warapp_submit_turn', { ...args, confirmToken: preview.confirmToken });
    expect(Array.from(s.sent[0]!)).toEqual(
      expectedBytes(
        [
          { kind: 'card', card: 'OrderPriority', cardId: OP },
          { kind: 'deploy', territoryId: 159, armies: 5 },
          { kind: 'card', card: 'OrderDelay', cardId: OD },
        ],
        3,
      ),
    );
  });

  const refusals: Array<[string, SyntheticCard[], Array<Record<string, unknown>>, RegExp]> = [
    ['a card not in the hand', [{ id: OP, type: 4 }], [{ kind: 'card', card: R1 }, { kind: 'deploy', territory: 159, armies: 5 }], /not in your hand/],
    ['a card type not held', [{ id: OP, type: 4 }], [{ kind: 'card', card: 'Order Delay' }, { kind: 'deploy', territory: 159, armies: 5 }], /hold no Order Delay card/],
    ['an unknown card name', [], [{ kind: 'card', card: 'Joker' }, { kind: 'deploy', territory: 159, armies: 5 }], /No card type matches "Joker"/],
    ['the same card twice', [{ id: OP, type: 4 }], [{ kind: 'card', card: OP }, { kind: 'card', card: OP }, { kind: 'deploy', territory: 159, armies: 5 }], /played twice/],
    ['an unsupported card', [{ id: AL, type: 6 }], [{ kind: 'card', card: AL }, { kind: 'deploy', territory: 159, armies: 5 }], /Airlift.*not supported/],
    ['a Blockade without a target', [{ id: BL, type: 12 }], [{ kind: 'card', card: BL }, { kind: 'deploy', territory: 159, armies: 5 }], /Blockade needs a `target`/],
    ['a Blockade on a territory not mine', [{ id: BL, type: 12 }], [{ kind: 'card', card: BL, target: 158 }, { kind: 'deploy', territory: 159, armies: 5 }], /not yours/],
    ['a target on a card that takes none', [{ id: OP, type: 4 }], [{ kind: 'card', card: OP, target: 159 }, { kind: 'deploy', territory: 159, armies: 5 }], /takes no target/],
    ['deploys that leave out the Reinforcement armies', [{ id: R1, type: 1, armies: 5 }], [{ kind: 'card', card: R1 }, { kind: 'deploy', territory: 159, armies: 5 }], /income is 10/],
    [
      'no card play at the hold limit',
      [
        { id: OP, type: 4 },
        { id: OD, type: 5 },
        { id: BL, type: 12 },
        { id: BL2, type: 12 },
        { id: AL, type: 6 },
      ],
      [{ kind: 'deploy', territory: 159, armies: 5 }],
      /You hold the maximum number of cards, so war\.app requires you to play one this turn/,
    ],
  ];

  it.each(refusals)('submit_turn refuses %s, sending nothing', async (_name, hand, orders, message) => {
    const s = ordersServer(hand);
    h = await liveHarness({ feed: [game('Playing')], pages: ME_PAGE, warapp: s.warapp });
    const res = await h.call('warapp_submit_turn', { game_id: GAME, orders });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(message);
    expect(s.sent).toEqual([]);
  });
});
