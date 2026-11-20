// #412 task 2: the decision log's capture points — warapp_plan_turn logs the turn's decision (a what-if
// only an observation), warapp_submit_turn logs what was sent and any override, the next plan fills the
// previous turn's outcome, and the tools that write the board cache (and boardHistory's history fill) log
// observations. Synthetic ids; the fixture's players carry names only to prove none is ever written.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { boardAt as rebuiltBoard, decisionLogPath, readDecisionLog } from '../src/decision-log.js';
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
const ME = Number(ANN.feed);
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
// The next turn: Ann took 157 and kept the rest.
const NEXT: SyntheticTerritory[] = BOARD.map((t) => (t.id === 157 ? { ...t, fogLevel: 1, owner: ANN.inGame, armies: 1 } : t));

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

describe('decision log capture (#412 task 2)', () => {
  it('warapp_plan_turn logs the turn planned: board, input, decision, planner version — no player name anywhere', async () => {
    h = await liveHarness({ feed: [game('2')], warapp: server() });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    const l = (await log())!;
    expect(l.playerId).toBe(ME);
    const e = l.turns['3']!;
    expect(e.kind).toBe('planned');
    expect(e.planner?.version).toEqual(expect.any(String));
    expect(e.input).toBeDefined();
    expect(e.decision?.goal).toBe(p.goal);
    expect(e.decision?.deploys).toEqual(p.deploys.map((d) => ({ territoryId: d.territory.id, armies: d.armies })));
    expect(e.decision?.moves.map((m) => [m.from, m.to, m.armies])).toEqual(p.moves.map((m) => [m.from.id, m.to.id, m.armies]));
    expect(rebuiltBoard(l, 3)?.territories.find((t) => t.territoryId === 135)?.armies).toBeNull();
    const text = fileText();
    expect(text).not.toMatch(/\bAnn\b/);
    expect(text).not.toMatch(/\bBob\b/);
  });

  it('a what-if plan (an explicit goal or enemy_deploy) is only an observation, and never replaces the planned entry', async () => {
    h = await liveHarness({ feed: [game('2')], warapp: server() });
    await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', goal: 'defend' });
    let e = (await log())!.turns['3']!;
    expect(e).toMatchObject({ kind: 'observed', source: 'live' });
    expect(e.decision).toBeUndefined();
    await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' });
    await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', enemy_deploy: 30 });
    e = (await log())!.turns['3']!;
    expect(e.kind).toBe('planned');
    expect(e.decision?.enemyDeploy).not.toBe(30);
  });

  it('planning the turn again replaces its entry', async () => {
    h = await liveHarness({ feed: [game('2')], pages: ME_PAGE, warapp: server() });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    await submit({ game_id: GAME, player: 'Ann', orders: p.orders });
    expect((await log())!.turns['3']!.sent).toBeDefined();
    await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' });
    const e = (await log())!.turns['3']!;
    expect(e.kind).toBe('planned');
    expect(e.sent).toBeUndefined();
  });

  it('warapp_submit_turn logs the plan\'s orders as sent with no override', async () => {
    h = await liveHarness({ feed: [game('2')], pages: ME_PAGE, warapp: server() });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    // Logged once war.app took the orders (beside the orders cache), whatever the read-back says.
    expect((await submit({ game_id: GAME, player: 'Ann', orders: p.orders })).isError).toBeFalsy();
    const e = (await log())!.turns['3']!;
    expect(e.kind).toBe('planned');
    expect(e.sent?.deploys).toEqual(e.decision?.deploys);
    expect(e.override).toBeUndefined();
  });

  it('warapp_submit_turn marks other orders an override, by the agent unless told, with the reason as given (names scrubbed)', async () => {
    h = await liveHarness({ feed: [game('2')], pages: ME_PAGE, warapp: server() });
    await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' });
    const mine = [{ kind: 'deploy', territory: 161, armies: 5 }];
    await submit({ game_id: GAME, player: 'Ann', orders: mine, override_reason: 'Bob looks weak; stack 161.' });
    let e = (await log())!.turns['3']!;
    // The whole turn as sent (#412 review): no card, discard or purchase is an empty list, not a gap.
    expect(e.sent).toEqual({ deploys: [{ territoryId: 161, armies: 5 }], moves: [], cards: [], discards: [], purchases: [] });
    expect(e.override).toEqual({ by: 'agent', reason: `Player ${BOB.feed} looks weak; stack 161.` });
    expect(fileText()).not.toMatch(/\bBob\b/);
    // Re-planned and sent by hand.
    await h.harness.close();
    h = await liveHarness({ dataDir: h.dataDir, feed: [game('2')], pages: ME_PAGE, warapp: server() });
    await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' });
    await submit({ game_id: GAME, player: 'Ann', orders: mine, override_by: 'hand' });
    e = (await log())!.turns['3']!;
    expect(e.override).toEqual({ by: 'hand' });
  });

  it('warapp_submit_turn with no plan logged: sent alone, or an override when the caller says the orders came from elsewhere', async () => {
    h = await liveHarness({ feed: [game('2')], pages: ME_PAGE, warapp: server() });
    await submit({ game_id: GAME, player: 'Ann', orders: [{ kind: 'deploy', territory: 161, armies: 5 }] });
    let e = (await log())!.turns['3']!;
    expect(e.sent?.deploys).toEqual([{ territoryId: 161, armies: 5 }]);
    expect(e.override).toBeUndefined();
    await h.harness.close();
    h = await liveHarness({ dataDir: h.dataDir, feed: [game('3')], pages: ME_PAGE, warapp: server() });
    await submit({ game_id: GAME, player: 'Ann', orders: [{ kind: 'deploy', territory: 161, armies: 5 }], override_reason: 'Entered by hand.' });
    e = (await log())!.turns['4']!;
    expect(e.override).toEqual({ by: 'hand', reason: 'Entered by hand.' });
  });

  it('rejects an override_reason over 500 characters', async () => {
    h = await liveHarness({ feed: [game('2')], pages: ME_PAGE, warapp: server() });
    const r = await h.call('warapp_submit_turn', { game_id: GAME, player: 'Ann', orders: [{ kind: 'deploy', territory: 161, armies: 5 }], override_reason: 'x'.repeat(501) });
    expect(r.isError).toBe(true);
  });

  it("the next turn's plan fills the previous turn's outcome", async () => {
    h = await liveHarness({ feed: [game('2')], warapp: server() });
    await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' });
    expect((await log())!.turns['3']!.next).toBeUndefined();
    await h.harness.close();
    h = await liveHarness({ dataDir: h.dataDir, feed: [game('3')], warapp: server(NEXT) });
    await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' });
    const next = (await log())!.turns['3']!.next!;
    expect(next.gained).toEqual([157]);
    expect(next.lost).toEqual([]);
    expect(next.bonusesHeld).toContain(118);
    expect(next.eliminated).toBe(false);
    expect(next.income).toEqual(expect.any(Number));
    expect((await log())!.turns['4']!.next).toBeUndefined();
  });

  it('warapp_track_opponents logs an observation of a turn not planned, and never replaces a planned one', async () => {
    h = await liveHarness({ feed: [game('2')], warapp: server() });
    await h.call('warapp_track_opponents', { game_id: GAME, player: 'Ann' });
    expect((await log())!.turns['3']).toMatchObject({ kind: 'observed', source: 'live' });
    await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' });
    await h.call('warapp_track_opponents', { game_id: GAME, player: 'Ann' });
    expect((await log())!.turns['3']!.kind).toBe('planned');
  });

  it('logs the earlier turns boardHistory fills from GameFeed history as observations', async () => {
    const previous = [
      { terrID: 159, ownedBy: ANN.feed, armies: 6, fogLevel: 'Visible' },
      { terrID: 161, ownedBy: ANN.feed, armies: 3, fogLevel: 'Visible' },
      { terrID: 158, ownedBy: String(BOB.inGame), armies: 3, fogLevel: 'Visible' },
    ];
    h = await liveHarness({ feed: [game('2', { history: [{ turn: 0, standing: [] }, { turn: 1, standing: previous }] })], warapp: server() });
    await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' });
    const l = (await log())!;
    expect(l.turns['2']).toMatchObject({ kind: 'observed', source: 'history' });
    expect(rebuiltBoard(l, 2)?.territories.find((t) => t.territoryId === 158)?.armies).toBe(3);
    expect(l.turns['3']!.kind).toBe('planned');
  });

  it('writes nothing with WARAPP_DECISION_LOG=off', async () => {
    h = await liveHarness({ feed: [game('2')], pages: ME_PAGE, warapp: server(), env: { WARAPP_DECISION_LOG: 'off' } });
    const p = payload<PlanPayload>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    await h.call('warapp_track_opponents', { game_id: GAME, player: 'Ann' });
    await submit({ game_id: GAME, player: 'Ann', orders: p.orders });
    expect(await log()).toBeUndefined();
  });
});
