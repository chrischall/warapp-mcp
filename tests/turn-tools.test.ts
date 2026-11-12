import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
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
