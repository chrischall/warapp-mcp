// #437 task 1: the per-turn additions at their capture points — warapp_plan_turn writes the build, plannedAt,
// the boot deadlines, the first mover, my hand and the card advice; warapp_check_plan its summary (the
// latest per turn); warapp_submit_turn sentAt, the cards played and its checks. Synthetic ids; the fixture's
// players carry names only to prove none is ever written.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { decisionLogPath, readDecisionLog } from '../src/decision-log.js';
import { serverBuild } from '../src/build-id.js';
import { liveHarness, lobbyFixture, payload, type Harness } from './helpers.js';
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
const ME_PAGE = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };

function game(numberOfTurns: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>).map((p, i) =>
    i === 0 ? { ...p, id: ANN.feed, name: 'Ann' } : i === 1 ? { ...p, id: BOB.feed, name: 'Bob' } : p,
  );
  return { ...f, state: 'Playing', numberOfTurns, players, ...extra };
}

// Ann holds 159 and 161 (bonus 118 with 157); Bob's 158 borders all three; 135 fogged.
const BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 7 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

type Routes = Partial<Record<number, (req: DecodedRequest, n: number) => Partial<ReplyFrame>>>;
const routes = (r: Routes) => (req: DecodedRequest, n: number): Partial<ReplyFrame> => {
  const f = r[req.method];
  if (!f) throw new Error(`unexpected method ${req.method}`);
  return f(req, n);
};
const board = (territories: SyntheticTerritory[]) => () =>
  ({ body: (w) => writeLatestGameInfo(w, territories, [ANN.inGame]) }) satisfies Partial<ReplyFrame>;
const server = (territories: SyntheticTerritory[] = BOARD) =>
  routes({ [Method.GetLatestGameInfo]: board(territories), [Method.SendOrders]: () => ({ body: (w) => w.bool(true).bool(false) }) });

interface PlanPayload {
  goal: string;
  orders: Array<Record<string, unknown>>;
  deploys: Array<{ territory: { id: number }; armies: number }>;
  moves: Array<{ from: { id: number }; to: { id: number }; armies: number }>;
}

const log = () => readDecisionLog(h!.dataDir, GAME);
const fileText = () => readFileSync(decisionLogPath(h!.dataDir, GAME), 'utf8');

async function submit(args: Record<string, unknown>) {
  const preview = payload(await h!.call('warapp_submit_turn', args));
  expect(preview.confirmToken).toEqual(expect.any(String));
  return h!.call('warapp_submit_turn', { ...args, confirmToken: preview.confirmToken });
}

describe('decision log v2 capture (#437 task 1)', () => {
  it('warapp_plan_turn logs the build, plannedAt, the turn start and boot deadlines, the first mover, the hand and the advice', async () => {
    h = await liveHarness({ feed: [game('2')], warapp: server() });
    await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' });
    const e = (await log())!.turns['3']!;
    expect(e.planner).toEqual({ version: expect.any(String), build: serverBuild() });
    // The fixture: lastTurnTime 2026-01-01T00:00:00, AutoBoot and DirectBoot 2880 minutes.
    expect(e.times).toEqual({
      plannedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      turnStartedAt: '2026-01-01T00:00:00.000Z',
      bootAt: { auto: '2026-01-03T00:00:00.000Z', direct: '2026-01-03T00:00:00.000Z' },
    });
    expect('firstMover' in e).toBe(true);
    expect(e.cards).toEqual({ hand: [], advice: [] });
    expect(fileText()).not.toMatch(/\b(Ann|Bob)\b/);
  });

  it('warapp_check_plan logs its summary for the turn (the latest wins), which a later plan keeps', async () => {
    h = await liveHarness({ feed: [game('2')], warapp: server() });
    const orders = [{ kind: 'deploy', territory: 159, armies: 5 }, { kind: 'move', from: 159, to: 158, armies: 10 }];
    expect((await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders })).isError).toBeFalsy();
    let e = (await log())!.turns['3']!;
    expect(e.checks?.checkPlan).toEqual({
      safe: expect.anything(),
      worst: expect.anything(),
      harmful: expect.any(Number),
      considered: expect.any(Number),
      atRisk: { commander: expect.any(Number), territories: expect.any(Number), captures: expect.any(Number), bonuses: expect.any(Number) },
    });
    await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: [{ kind: 'deploy', territory: 161, armies: 5 }], enemy_deploy: 40 });
    e = (await log())!.turns['3']!;
    expect(e.checks?.checkPlan?.whatIf).toBe(true);
    await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' });
    e = (await log())!.turns['3']!;
    expect(e.kind).toBe('planned');
    expect(e.checks?.checkPlan?.whatIf).toBe(true);
    expect(fileText()).not.toMatch(/\b(Ann|Bob)\b/);
  });

  it('warapp_submit_turn logs sentAt, the cards played and its checks', async () => {
    h = await liveHarness({ feed: [game('2')], pages: ME_PAGE, warapp: server() });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect((await submit({ game_id: GAME, player: 'Ann', orders: p.orders })).isError).toBeFalsy();
    const e = (await log())!.turns['3']!;
    expect(e.times?.sentAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(e.times?.plannedAt).toEqual(expect.any(String));
    expect(e.cards).toMatchObject({ hand: [], advice: [], played: [], discarded: 0 });
    const c = e.checks?.submit;
    // No Commanders in the fixture: no commander check.
    expect(c?.commander).toBeNull();
    expect(Array.isArray(c?.headroom)).toBe(true);
    expect(c!.headroom.length).toBeLessThanOrEqual(5);
    for (const r of c!.headroom) expect(Object.keys(r).sort()).toEqual(['from', 'opponent', 'protects', 'takeAt', 'territory']);
    expect(c?.belowPlan).toEqual([]);
    expect(c?.chat).toEqual([]);
    expect(fileText()).not.toMatch(/\b(Ann|Bob)\b/);
  });
});
