// The end-of-game pass (#312 E1): once per finished game of mine, its history read once and kept
// name-free at <dataDir>/finished/<hmac>.json. Triggers: warapp_get_game, warapp_wait_for_turn's read,
// and the warapp_my_games sweep. Synthetic GameFeed answers only; no war.app traffic.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { finishedDir, finishedPath } from '../src/finished-store.js';
import { playerKey, playerRecordSalt } from '../src/player-record-store.js';
import { Method } from '../src/protocol/methods.js';
import type { Writer } from '../src/protocol/codec.js';
import { writePickList } from '../src/pick-list.js';
import { liveHarness, payload, type Harness } from './helpers.js';
import { fakeSocketIo, type FakeSocketIo } from './push/fake-socket.js';
import { writeMyGamesReturn } from './protocol/my-games-bundle.js';

const GAME = 12345678;
const ANN = 4412345677; // in-game 123456
const BOB = 7176543229;
const SIGNED_IN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN}</p>` };

let h: Harness | undefined;
let socket: FakeSocketIo | undefined;
afterEach(async () => {
  socket?.close();
  await h?.harness.close();
  h = undefined;
  socket = undefined;
});

// A line 1-2-3-4-5-6: bonus 100 = {1,2} worth 3, bonus 200 = {5,6} worth 4.
const MAP = {
  id: '77',
  name: 'Line',
  territories: [1, 2, 3, 4, 5, 6].map((id) => ({ id: String(id), name: `T${id}`, connectedTo: [id - 1, id + 1].filter((n) => n >= 1 && n <= 6) })),
  bonuses: [
    { id: '100', name: 'West', value: '3', territoryIDs: [1, 2] },
    { id: '200', name: 'East', value: '4', territoryIDs: [5, 6] },
  ],
};

const terr = (id: number, owner: number | 'Neutral', armies: number) => ({ terrID: String(id), ownedBy: String(owner), armies: String(armies), fogLevel: 'Visible' });

function finished(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: String(GAME),
    state: 'Finished',
    name: 'Secret Game Name',
    numberOfTurns: '2',
    players: [
      { id: String(ANN), name: 'Ann', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Eliminated' },
      { id: String(BOB), name: 'Bob', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Won' },
    ],
    settings: { Map: '77', MinimumArmyBonus: '5', PersonalMessage: 'free text Ann' },
    map: MAP,
    ...over,
  };
}

/** The finished game with its history: Ann starts on 1, Bob on 6; Ann takes 2; Bob takes 5, then everything. */
const withHistory = () =>
  finished({
    standing0: [terr(1, ANN, 5), terr(2, 'Neutral', 2), terr(5, 'Neutral', 2), terr(6, BOB, 5)],
    standing1: [terr(1, ANN, 4), terr(2, ANN, 3), terr(5, BOB, 4), terr(6, BOB, 4)],
    standing2: [terr(1, BOB, 6), terr(2, BOB, 1), terr(5, BOB, 4), terr(6, BOB, 1)],
  });

async function record(dir: string): Promise<Record<string, unknown>> {
  const salt = await playerRecordSalt(dir);
  return JSON.parse(readFileSync(finishedPath(dir, salt!, ANN, GAME), 'utf8'));
}

const historyCalls = (hh: Harness) => hh.calls.filter((c) => c.url.includes('GetHistory=true')).length;

describe('the end-of-game pass', () => {
  it('warapp_get_game: a finished game of mine is read once with its history and kept name-free', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    await writePickList(dir, GAME, ANN, [1, 3]);
    h = await liveHarness({ feed: [finished(), withHistory()], dataDir: dir, pages: SIGNED_IN });
    const r = payload(await h.call('warapp_get_game', { game_id: GAME }));
    expect(r.endOfGame).toEqual({ status: 'captured', turns: 3 });
    expect(historyCalls(h)).toBe(1);

    const rec = await record(dir);
    const salt = (await playerRecordSalt(dir))!;
    const ann = playerKey(salt, ANN);
    const bob = playerKey(salt, BOB);
    expect(rec).toMatchObject({
      version: 1,
      status: 'captured',
      mapId: 77,
      format: '1v1',
      seats: 2,
      me: ann,
      outcome: { result: 'eliminated', turn: 2, outTurn: 2, winners: [bob] },
      picks: { list: [1, 3] },
      starts: { [ann]: [1], [bob]: [6] },
    });
    expect((rec.turns as Array<{ afterTurn: number; players: Record<string, { income: number; bonuses: number[] }> }>).map((t) => [t.afterTurn, t.players[ann]!.income, t.players[bob]!.income])).toEqual([
      [0, 5, 5],
      [1, 8, 9],
      [2, 0, 12],
    ]);
    expect((rec.settings as Record<string, unknown>).Map).toBe('77');
    const path = finishedPath(dir, salt, ANN, GAME);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, 'utf8');
    for (const s of [String(ANN), String(BOB), String(GAME), 'Ann', 'Bob', 'Secret', 'free text']) expect(text).not.toContain(s);

    // Again: already processed, nothing read.
    const again = payload(await h.call('warapp_get_game', { game_id: GAME }));
    expect(again.endOfGame).toEqual({ status: 'already-processed' });
    expect(historyCalls(h)).toBe(1);
  });

  it('a failed read is recorded and not retried; an explicit include_history re-runs it from that read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    h = await liveHarness({ feed: [finished(), { error: 'Something broke' }, finished(), withHistory()], dataDir: dir, pages: SIGNED_IN });
    const first = payload(await h.call('warapp_get_game', { game_id: GAME }));
    expect(first.endOfGame).toEqual({ status: 'read-failed', failure: { reason: 'request-failed', kind: 'http' } });
    expect(await record(dir)).toMatchObject({ status: 'read-failed', outcome: { result: 'eliminated' } });
    expect(await record(dir)).not.toHaveProperty('turns');

    const second = payload(await h.call('warapp_get_game', { game_id: GAME }));
    expect(second.endOfGame).toEqual({ status: 'already-processed' });
    expect(h.calls).toHaveLength(3);

    const third = payload(await h.call('warapp_get_game', { game_id: GAME, include_history: true }));
    expect(third.endOfGame).toEqual({ status: 'captured', turns: 3 });
    expect(h.calls).toHaveLength(4);
    expect(await record(dir)).toMatchObject({ status: 'captured' });
  });

  it('an unreadable history is recorded with its reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    h = await liveHarness({ feed: [finished(), finished({ history: 'not json' })], dataDir: dir, pages: SIGNED_IN });
    const r = payload(await h.call('warapp_get_game', { game_id: GAME }));
    expect(r.endOfGame).toMatchObject({ status: 'history-unreadable', failure: { reason: 'not-json' } });
    expect(await record(dir)).toMatchObject({ status: 'history-unreadable', failure: { reason: 'not-json' }, outcome: { result: 'eliminated' } });
  });

  it('nothing for a game in progress, a game not mine, or with profiling off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    h = await liveHarness({ feed: [finished({ state: 'Playing' })], dataDir: dir, pages: SIGNED_IN });
    expect(payload(await h.call('warapp_get_game', { game_id: GAME }))).not.toHaveProperty('endOfGame');
    await h.harness.close();

    h = await liveHarness({ feed: [finished()], dataDir: dir, pages: { 'https://war.app/InviteToken': '<p>Your invite token is 5512345699</p>' } });
    expect(payload(await h.call('warapp_get_game', { game_id: GAME })).endOfGame).toEqual({ status: 'not-a-player' });
    expect(historyCalls(h)).toBe(0);
    await h.harness.close();

    h = await liveHarness({ feed: [finished()], dataDir: dir, pages: SIGNED_IN, env: { WARAPP_PLAYER_PROFILE: 'off' } });
    expect(payload(await h.call('warapp_get_game', { game_id: GAME }))).not.toHaveProperty('endOfGame');
    expect(historyCalls(h)).toBe(0);
    expect(existsSync(finishedDir(dir))).toBe(false);
  });

  it('a record that does not parse is never overwritten, and nothing is read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    h = await liveHarness({ feed: [finished(), withHistory()], dataDir: dir, pages: SIGNED_IN });
    await h.call('warapp_get_game', { game_id: GAME });
    const salt = (await playerRecordSalt(dir))!;
    const path = finishedPath(dir, salt, ANN, GAME);
    writeFileSync(path, '{broken');
    const r = payload(await h.call('warapp_get_game', { game_id: GAME, include_history: true }));
    expect(r.endOfGame).toEqual({ status: 'record-unreadable' });
    expect(readFileSync(path, 'utf8')).toBe('{broken');
  });

  it("warapp_wait_for_turn's read runs the pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    socket = fakeSocketIo();
    h = await liveHarness({ feed: [finished(), withHistory()], dataDir: dir, socket, pages: SIGNED_IN });
    const r = await h.call('warapp_wait_for_turn', { game_ids: [GAME], timeout_seconds: 5 });
    expect(payload(r)).toMatchObject({ status: 'game_over' });
    expect(await record(dir)).toMatchObject({ status: 'captured', outcome: { result: 'eliminated' } });
  });

  it('warapp_my_games sweeps my finished games not yet processed, at most two per call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    mkdirSync(dir, { recursive: true });
    const over = (id: number) => ({ id, name: `Over ${id}`, lastTurn: 2, state: 4, players: [{ id: 123456, name: 'Ann', state: 3, committed: false }] });
    const notMine = { id: 9001, name: 'Not mine', lastTurn: 2, state: 4, players: [{ id: 765432, name: 'Bob', state: 4, committed: false }] };
    h = await liveHarness({
      feed: [withHistory()],
      dataDir: dir,
      pages: SIGNED_IN,
      warapp: (req) => {
        if (req.method !== Method.GetMyGames) throw new Error(`unexpected method ${req.method}`);
        return { body: (w: Writer) => writeMyGamesReturn(w, [over(1001), over(1002), over(1003), notMine]) };
      },
    });
    const first = payload(await h.call('warapp_my_games'));
    expect(first.endOfGame).toEqual({
      processed: [
        { gameId: 1003, status: 'captured', turns: 3 },
        { gameId: 1002, status: 'captured', turns: 3 },
      ],
      pending: 1,
    });
    expect(historyCalls(h)).toBe(2);
    const second = payload(await h.call('warapp_my_games'));
    expect(second.endOfGame).toEqual({ processed: [{ gameId: 1001, status: 'captured', turns: 3 }], pending: 0 });
    const third = payload(await h.call('warapp_my_games'));
    expect(third).not.toHaveProperty('endOfGame');
    expect(historyCalls(h)).toBe(3);
    expect(readdirSync(finishedDir(dir))).toHaveLength(3);
  });
});
