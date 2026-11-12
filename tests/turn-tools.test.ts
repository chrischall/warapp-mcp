import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Writer, type DecodedRequest, type ReplyFrame } from '../src/protocol/codec.js';
import { Method, writeSendOrdersParams, type TurnOrder } from '../src/protocol/methods.js';
import { plannerSettings, turnOrdersArg, validateTurn } from '../src/tools/turn.js';
import { normalizeMap } from '../src/normalize.js';
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
  multiSourceCaptures: Named[];
  untrusted_content?: boolean;
}

describe('warapp_plan_turn', () => {
  it('warns that the income may be off when a setting the model does not compute is on (#38)', async () => {
    const settings = { ...(lobbyFixture().settings as Record<string, unknown>), ArmyCap: 3 };
    h = await liveHarness({ feed: [game('Playing', { settings })], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.warnings.join('\n')).toMatch(/income 5 may be off.*army cap/i);
  });

  it('plans from the live board: deploys and moves by name and id, expected bonuses, and submit-shaped orders', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    // R3: completing bonus 118 leaves all three members facing Bob's ~11 with a next income
    // of 7, so `balanced` refuses it (see below); `expand` ignores defence and completes it.
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', goal: 'expand' }));
    expect(p.untrusted_content).toBe(true);
    expect(p.game).toEqual({ id: GAME, name: 'Synthetic lobby game', turn: 3 });
    expect(p.player).toEqual({ id: Number(ANN.feed), name: 'Ann' });
    expect(p.goal).toBe('expand');
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

  it('the default goal (balanced) does not complete a bonus it cannot hold next turn (R3)', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.goal).toBe('balanced');
    expect(p.expected.bonusesCompleted).toEqual([]);
    expect(p.moves.some((m) => m.kind === 'attack')).toBe(false);
    expect(p.warnings.join('\n')).toMatch(
      /completing Broken Branch Riverlords \(#118\) leaves .* \(#\d+\) indefensible \(player \d+ can take it for \d+; next income 7\): not completed/,
    );
    expect(p.rationale.join('\n')).toMatch(/Do not complete bonus Broken Branch Riverlords \(#118\)/);
  });

  it('defaults to the signed-in account, found by its invite token', async () => {
    h = await liveHarness({
      feed: [game('Playing')],
      pages: { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` },
      warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }),
    });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, goal: 'expand' }));
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

  it('keeps the borders of the bonus this turn completes (R2), warning they can still fall', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    // R3: `defend` (like `balanced`) no longer completes this indefensible bonus; `expand`
    // still does, and R2's re-valuation keeps its borders under every goal.
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', goal: 'expand' }));
    expect(p.goal).toBe('expand');
    // Both threatened borders protect +0 at the start of the turn, but capturing Widow's Watch
    // completes bonus 118 around them: they are kept (not conceded, nothing withdrawn).
    expect(p.expected.bonusesCompleted).toEqual([{ id: 118, name: 'Broken Branch Riverlords', value: 2 }]);
    expect(p.conceded).toEqual([]);
    expect(p.warnings.join('\n')).not.toMatch(/: conceded/);
    expect(p.moves.every((m) => m.kind === 'attack')).toBe(true);
    expect(p.cardAdvice).toBeNull();
    for (const id of [159, 161]) {
      expect(p.rationale.join('\n')).toContain(`Keep ${mapName(id)} (#${id}) (not conceded)`);
      // The 5 income cannot make both safe against Bob's ~11: each says the bonus can fall.
      expect(p.warnings.join('\n')).toContain(`${mapName(id)} (#${id}) is kept for the bonus this turn completes`);
    }
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

  it('reports a combined (multi-source) capture by name, with its attack order (R4)', async () => {
    // Widow's Watch (12 neutrals) borders Sheepshead Hills and Ramsgate, and needs 20: either's
    // 10 movable + 5 income fall short alone. Ramsgate's 10 kill 6 first (and fail by design);
    // Sheepshead Hills then takes the last 6 with 10.
    const multi: SyntheticTerritory[] = [
      { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 11 },
      { id: 1567, fogLevel: 1, owner: ANN.inGame, armies: 11 },
      { id: 157, fogLevel: 2, owner: 0, armies: 12 },
      { id: 158, fogLevel: 4, owner: -1, armies: 0, fogged: true },
      { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
    ];
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(multi) }) });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', focus: [118] }));
    expect(p.multiSourceCaptures).toEqual([{ id: 157, name: mapName(157) }]);
    expect(p.moves.filter((m) => m.kind === 'attack').map((m) => [m.from.id, m.to.id, m.armies])).toEqual([
      [1567, 157, 10],
      [161, 157, 10],
    ]);
    expect(p.warnings.join('\n')).toMatch(/combines 2 attacks that must run in this order/);
    // A plan with no combined capture reports an empty list.
    await h.harness.close();
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    const q = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(q.multiSourceCaptures).toEqual([]);
  });

  it('reports the enemy deploy estimate; enemy_deploy overrides it', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(BOARD) }) });
    // Bob shows 7 next to Ann and holds no visible bonus: clamp(5 + 0, 5, round(0.75 × 7)) = 5.
    const def = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(def.enemyDeploy).toBe(5);
    expect(def.warnings.join('\n')).toMatch(
      /Enemy deploy estimate for player \d+: ~5 \(base 5 \+ visible bonuses \+0 = 5.*largest stack next to me \(7\).*unknown/,
    );
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
    const p = payload<PlanPayload>(
      await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', view: 'full', goal: 'expand' }),
    );
    expect(p.moves[0]!.reason).toMatch(/completes bonus/);
    expect(p.settings).toEqual({
      offensiveKillRate: 60,
      defensiveKillRate: 70,
      luckModifier: 0,
      roundingMode: 'StraightRound',
      oneArmyStandsGuard: true,
      multiAttack: false,
      baseIncome: 5,
      allowTransferOnly: true,
      // G4: the rules the planner obeys are always echoed, off or on.
      localDeployments: false,
      noSplit: false,
    });
  });

  it('the plan and submit descriptions say kill rates, Local Deployment and No-Split are obeyed (G4)', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({}) });
    const { tools } = await h.harness.client.listTools();
    for (const name of ['warapp_plan_turn', 'warapp_submit_turn']) {
      const d = tools.find((t) => t.name === name)!.description!;
      expect(d, name).toMatch(/kill rates/);
      expect(d, name).toMatch(/Local Deployment/);
      expect(d, name).toMatch(/No-Split/);
    }
  });

  it('sizes attacks and threats at the game\'s kill rates (20/80), not 60/70 (G1, issue #28)', async () => {
    const f = lobbyFixture();
    const settings = { ...(f.settings as Record<string, unknown>), OffensiveKillRate: 20, DefensiveKillRate: 80 };
    // Sheepshead Hills holds 8 (7 movable): Widow's Watch's 2 neutrals cost
    // armiesToTake(2) = max(ceil(150 / 20) = 8, round(1.6) + 1 = 3) = 8 at 20/80 (3 at 60/70).
    const b = BOARD.map((t) => (t.id === 161 ? { ...t, armies: 8 } : t));
    h = await liveHarness({ feed: [game('Playing', { settings })], warapp: routes({ [Method.GetLatestGameInfo]: board(b) }) });
    const p = payload<PlanPayload>(
      await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', goal: 'expand', view: 'full' }),
    );
    expect(p.settings).toMatchObject({ offensiveKillRate: 20, defensiveKillRate: 80 });
    expect(p.moves.filter((m) => m.kind === 'attack')).toEqual([
      expect.objectContaining({ from: { id: 161, name: mapName(161) }, to: { id: 157, name: mapName(157) }, armies: 8 }),
    ]);
    expect(p.deploys.find((d) => d.territory.id === 161)?.armies).toBeGreaterThanOrEqual(1);
    expect(p.orders).toContainEqual({ kind: 'move', from: 161, to: 157, armies: 8 });
    // Bob's ~11 next door cannot take Hornwood's 6 at 20/80 (it needs 28), nor Sheepshead Hills.
    expect(p.warnings.join('\n')).not.toMatch(/could be taken next turn/);
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
    expect(p.deploys.reduce((s, d) => s + d.armies, 0)).toBe(5);
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
    // The base income feeds each opponent's deploy estimate.
    expect(plannerSettings({ cards: [], raw: {}, minimumArmyBonus: 3 })).toEqual({ baseIncome: 3 });
    // Local Deployment (G2): passed through when on.
    expect(plannerSettings({ cards: [], raw: {}, localDeployments: true })).toEqual({ localDeployments: true });
    // No-Split (G3): passed through when on.
    expect(plannerSettings({ cards: [], raw: {}, noSplit: true })).toEqual({ noSplit: true });
    expect(plannerSettings({ cards: [], raw: {}, noSplit: false })).toEqual({});
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

  it('error 11 names the modelled income and where to read war.app\'s own number (#38)', async () => {
    const s = ordersServer({ error: { code: 11, message: 'x' } });
    h = await liveHarness({ feed: [game('Playing')], pages: ME_PAGE, warapp: s.warapp });
    const res = await confirmed({ game_id: GAME, orders: GOOD });
    expect(res.isError).toBe(true);
    const all = JSON.stringify(res);
    expect(all).toMatch(/war\.app error 11/);
    expect(all).toMatch(/modelled income was 5/);
    expect(all).toMatch(/armies per turn/);
  });

  it('when the income model is uncertain (army cap), a deploy total that differs warns instead of refusing (#38)', async () => {
    const s = ordersServer();
    const settings = { ...(lobbyFixture().settings as Record<string, unknown>), ArmyCap: 3 };
    h = await liveHarness({ feed: [game('Playing', { settings })], pages: ME_PAGE, warapp: s.warapp });
    const preview = payload(await h.call('warapp_submit_turn', { game_id: GAME, orders: [{ kind: 'deploy', territory: 159, armies: 4 }] }));
    expect(preview.confirmToken).toEqual(expect.any(String));
    const text = JSON.stringify(preview);
    expect(text).toMatch(/deploy 4 armies.*modelled income is 5/);
    expect(text).toMatch(/army cap/i);
    expect(s.sent).toEqual([]);
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

describe('Local Deployment in the turn tools (G2, issue #29)', () => {
  const ME_PAGE = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };
  // Ann holds bonus 118 (+2: 159, 161, 157) and Oldcastle 453745 (outside it): income 5 + 2 = 7,
  // of which 5 may go anywhere and 2 only inside bonus 118.
  const BONUS = [159, 161, 157];
  const LOCAL_BOARD: SyntheticTerritory[] = [
    { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 2 },
    { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 2 },
    { id: 157, fogLevel: 1, owner: ANN.inGame, armies: 2 },
    { id: 453745, fogLevel: 1, owner: ANN.inGame, armies: 1 },
    { id: 1567, fogLevel: 1, owner: 0, armies: 2 },
    { id: 23473, fogLevel: 1, owner: 0, armies: 3 },
    { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 7 },
  ];
  const localSettings = () => ({ ...(lobbyFixture().settings as Record<string, unknown>), LocalDeployments: true });

  it('(f) warapp_plan_turn keeps bonus armies inside the bonus when LocalDeployments is on', async () => {
    h = await liveHarness({
      feed: [game('Playing', { settings: localSettings() })],
      warapp: routes({ [Method.GetLatestGameInfo]: board(LOCAL_BOARD) }),
    });
    const p = payload<PlanPayload>(
      await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', goal: 'expand', view: 'full' }),
    );
    expect(p.income).toBe(7);
    expect(p.settings).toMatchObject({ localDeployments: true });
    const sum = (ids: number[] | null) =>
      p.deploys.filter((d) => (ids ? ids.includes(d.territory.id) : true)).reduce((s, d) => s + d.armies, 0);
    expect(sum(null)).toBe(7);
    expect(sum(BONUS)).toBeGreaterThanOrEqual(2);
    expect(7 - sum(BONUS)).toBeLessThanOrEqual(5);
    expect(p.rationale.join('\n')).toMatch(
      /Local Deployment: bonus Broken Branch Riverlords \(#118\)'s \+2 may only be deployed on its territories/,
    );
  });

  it('(e) warapp_submit_turn refuses bonus armies deployed outside the bonus, sending nothing', async () => {
    const sent: unknown[] = [];
    const warapp = routes({
      [Method.GetLatestGameInfo]: board(LOCAL_BOARD),
      [Method.SendOrders]: () => {
        sent.push(1);
        return { body: (w) => w.bool(true).bool(false) };
      },
    });
    h = await liveHarness({ feed: [game('Playing', { settings: localSettings() })], pages: ME_PAGE, warapp });
    const res = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [{ kind: 'deploy', territory: 453745, armies: 7 }],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Local Deployment/);
    expect(textOf(res)).toMatch(/Broken Branch Riverlords \(bonus 118\)/);
    expect(textOf(res)).toMatch(/2 too many/);
    expect(sent).toEqual([]);
    // The correct split is accepted.
    const ok = payload(
      await h.call('warapp_submit_turn', {
        game_id: GAME,
        orders: [
          { kind: 'deploy', territory: 453745, armies: 5 },
          { kind: 'deploy', territory: 161, armies: 2 },
        ],
      }),
    );
    expect(ok.confirmToken).toEqual(expect.any(String));
    expect(sent).toEqual([]);
  });

  describe('validateTurn', () => {
    const map = normalizeMap(lobbyFixture().map);
    const live = LOCAL_BOARD.map((t) => ({
      territoryId: t.id,
      fogLevel: t.fogLevel,
      fogged: t.fogged ?? false,
      owner: t.owner,
      armies: t.armies,
    }));
    const T = (id: number) => ({ id, name: mapName(id) });
    const run = (deploys: Array<[number, number]>, localDeployments?: boolean) =>
      validateTurn({
        map,
        board: live,
        myInGameId: ANN.inGame,
        income: 7,
        guard: true,
        deploys: deploys.map(([id, armies]) => ({ territory: T(id), armies })),
        moves: [],
        ...(localDeployments !== undefined ? { localDeployments } : {}),
      });

    it('refuses a pooled-income deploy that spends bonus armies outside the bonus, naming it and the overspend', () => {
      expect(() => run([[453745, 6], [159, 1]], true)).toThrow(
        /Local Deployment: these orders deploy 6 armies outside the held bonuses' own pools, but only 5 may go anywhere this turn \(1 too many\)\. Broken Branch Riverlords \(bonus 118\): \+2 earned, only 1 deployed inside it/,
      );
    });

    it('a deploy total that differs from a certain income is refused; an uncertain one returns a warning (#38)', () => {
      const args = {
        map,
        board: live,
        myInGameId: ANN.inGame,
        income: 7,
        guard: true,
        deploys: [{ territory: T(161), armies: 6 }],
        moves: [],
      };
      expect(() => validateTurn(args)).toThrow(/deploy 6 armies, but your income is 7/);
      expect(validateTurn({ ...args, deploys: [{ territory: T(161), armies: 7 }] })).toEqual({ warnings: [] });
      const r = validateTurn({ ...args, incomeUncertain: ['This game has an army cap, which can cut income; not modelled.'] });
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toMatch(/deploy 6 armies.*modelled income is 7.*army cap/i);
    });

    it('accepts the correct split, and any split when the flag is off', () => {
      expect(() => run([[453745, 5], [159, 1], [157, 1]], true)).not.toThrow();
      expect(() => run([[161, 7]], true)).not.toThrow();
      expect(() => run([[453745, 7]], false)).not.toThrow();
      expect(() => run([[453745, 7]])).not.toThrow();
    });
  });
});

describe('No-Split in the turn tools (G3, issue #31)', () => {
  const ME_PAGE = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };
  // Ann holds only Oldcastle 453745 (12), which borders the neutrals White Harbor 23473 (1)
  // and Ramsgate 1567 (1): without No-Split it attacks both from the one territory.
  const SPLIT_BOARD: SyntheticTerritory[] = [
    { id: 453745, fogLevel: 1, owner: ANN.inGame, armies: 12 },
    { id: 23473, fogLevel: 1, owner: 0, armies: 1 },
    { id: 1567, fogLevel: 1, owner: 0, armies: 1 },
  ];
  const settingsWith = (noSplit: boolean) => ({
    ...(lobbyFixture().settings as Record<string, unknown>),
    NoSplit: noSplit,
  });
  const plan = async (noSplit: boolean) => {
    h = await liveHarness({
      feed: [game('Playing', { settings: settingsWith(noSplit) })],
      warapp: routes({ [Method.GetLatestGameInfo]: board(SPLIT_BOARD) }),
    });
    const p = payload<PlanPayload>(
      await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', goal: 'expand', view: 'full' }),
    );
    await h.harness.close();
    h = undefined;
    return p;
  };

  it('(g) warapp_plan_turn issues one attack per territory when NoSplit is on', async () => {
    const off = await plan(false);
    expect(off.moves.filter((m) => m.from.id === 453745 && m.kind === 'attack')).toHaveLength(2);
    const on = await plan(true);
    expect(on.settings).toMatchObject({ noSplit: true });
    const fromOldcastle = on.moves.filter((m) => m.from.id === 453745);
    expect(fromOldcastle).toHaveLength(1);
    const dropped = [23473, 1567].find((id) => id !== fromOldcastle[0]!.to.id)!;
    expect(on.warnings.join('\n')).toMatch(
      new RegExp(`No-Split: ${mapName(453745)} \\(#453745\\) already attacks .*so the attack on ${mapName(dropped)} \\(#${dropped}\\) is not planned`),
    );
  });

  it('(e) warapp_submit_turn refuses two orders from one territory, sending nothing', async () => {
    const sent: unknown[] = [];
    const warapp = routes({
      [Method.GetLatestGameInfo]: board(SPLIT_BOARD),
      [Method.SendOrders]: () => {
        sent.push(1);
        return { body: (w) => w.bool(true).bool(false) };
      },
    });
    h = await liveHarness({ feed: [game('Playing', { settings: settingsWith(true) })], pages: ME_PAGE, warapp });
    const res = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [
        { kind: 'deploy', territory: 453745, armies: 5 },
        { kind: 'move', from: 453745, to: 23473, armies: 2 },
        { kind: 'move', from: 453745, to: 1567, armies: 2 },
      ],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(new RegExp(`No-Split: ${mapName(453745)} \\(453745\\) issues 2 attacks/transfers`));
    expect(sent).toEqual([]);
    const ok = payload(
      await h.call('warapp_submit_turn', {
        game_id: GAME,
        orders: [
          { kind: 'deploy', territory: 453745, armies: 5 },
          { kind: 'move', from: 453745, to: 23473, armies: 2 },
        ],
      }),
    );
    expect(ok.confirmToken).toEqual(expect.any(String));
    expect(sent).toEqual([]);
  });
});
