// The end-of-game pass (#312 E1): once per finished game of mine, its history read once and kept
// name-free at <dataDir>/finished/<hmac>.json. Triggers: warapp_get_game, warapp_wait_for_turn's read,
// and the warapp_my_games sweep. Synthetic GameFeed answers only; no war.app traffic.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapCache, WarappClient } from '../src/client.js';
import { rememberGameMap, writeStoredMap } from '../src/map-store.js';
import { normalizeMap } from '../src/normalize.js';
import { finishedDir, finishedPath, historyOfRecord, type FinishedRecord } from '../src/finished-store.js';
import { lessonsPath, mapRecordDir, mapRecordPath } from '../src/lessons-store.js';
import { profilePlayersPath } from '../src/profile-store.js';
import { playerKey, playerRecordSalt } from '../src/player-record-store.js';
import { Method } from '../src/protocol/methods.js';
import type { Writer } from '../src/protocol/codec.js';
import { writePickList } from '../src/pick-list.js';
import { recordOutlook } from '../src/outlook-log.js';
import { CREDS, liveHarness, payload, stubFetch, type Harness } from './helpers.js';
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
    expect(r.endOfGame).toEqual({ status: 'captured', turns: 3, processed: { profiles: 'folded', map: 'kept', lessons: 'kept' } });
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
    // #318: the history's boards are kept too (owners by key), so the calibration harness reads this record, never war.app.
    const back = historyOfRecord(rec as unknown as FinishedRecord, salt, [ANN, BOB]);
    expect(typeof back === 'object' && back.boards.map((b) => [b.turn, b.board.territories.map((t) => [t.territoryId, t.owner.kind === 'player' ? t.owner.playerId : t.owner.kind, t.armies])])).toEqual([
      [0, [[1, ANN, 5], [2, 'neutral', 2], [5, 'neutral', 2], [6, BOB, 5]]],
      [1, [[1, ANN, 4], [2, ANN, 3], [5, BOB, 4], [6, BOB, 4]]],
      [2, [[1, BOB, 6], [2, BOB, 1], [5, BOB, 4], [6, BOB, 1]]],
    ]);
    const path = finishedPath(dir, salt, ANN, GAME);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, 'utf8');
    for (const s of [String(ANN), String(BOB), String(GAME), 'Ann', 'Bob', 'Secret', 'free text']) expect(text).not.toContain(s);

    // Again: already processed, nothing read.
    const again = payload(await h.call('warapp_get_game', { game_id: GAME }));
    expect(again.endOfGame).toEqual({ status: 'already-processed' });
    expect(historyCalls(h)).toBe(1);
  });

  it('#312 E2: a captured history is folded into the profiles, the map record and the lessons, name-free', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    h = await liveHarness({ feed: [finished(), withHistory()], dataDir: dir, pages: SIGNED_IN });
    payload(await h.call('warapp_get_game', { game_id: GAME }));
    const salt = (await playerRecordSalt(dir))!;

    // Part C: Bob's turns from the history, folded as `history`.
    const players = JSON.parse(readFileSync(profilePlayersPath(dir), 'utf8'));
    const bob = players.players[playerKey(salt, BOB)];
    expect(bob.games).toBe(1);
    expect(bob.entries).toHaveLength(1);
    expect(bob.entries[0]).toMatchObject({ source: 'history', format: '1v1', ending: 'Won', turnsSeen: 2 });

    // The map's record: my start region and income curve, the winner's start and pace.
    const rec = JSON.parse(readFileSync(mapRecordPath(dir, 77), 'utf8'));
    expect(rec).toMatchObject({ version: 1, mapId: 77, games: 1, outcomes: { eliminated: 1 } });
    expect(rec.entries[0]).toMatchObject({
      format: '1v1',
      seats: 2,
      result: 'eliminated',
      turns: 2,
      me: { territories: [1], bonuses: [100], income: [5, 8, 0], income4: null, income8: null },
      winners: [{ territories: [6], bonuses: [200], income4: null, income8: null }],
    });

    // The lessons: how I lost, no flat income in a 2-turn game.
    const lessons = JSON.parse(readFileSync(lessonsPath(dir), 'utf8'));
    expect(lessons.byFormat['1v1']).toMatchObject({ games: 1, outcomes: { eliminated: 1 }, howLost: { 'last-territories': 1 }, flat: { n: 0, sum: 0 } });
    expect(lessons.entries[0]).toMatchObject({ result: 'eliminated', flatAfterTurn: null, howLost: { cause: 'last-territories', turn: 2 } });

    for (const path of [mapRecordPath(dir, 77), lessonsPath(dir), profilePlayersPath(dir)]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const text = readFileSync(path, 'utf8');
      for (const x of [String(ANN), String(BOB), String(GAME), 'Ann', 'Bob', 'Secret']) expect(text).not.toContain(x);
    }
  });

  it('#312: the final outlook line this server logged is kept in the record, name-free (any status)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    await recordOutlook(dir, GAME, ANN, {
      state: 'losing',
      heldTurns: 2,
      k: 3,
      threshold: 2.4,
      basis: 'Bob is ahead (secret words).',
      turns: [{ turn: 2, mine: 10, strongest: { playerId: BOB, low: 30, high: 60 }, ratio: { low: 0.17, high: 0.33 }, changed: 1, state: 'losing', estimated: true }],
    });
    h = await liveHarness({ feed: [finished(), withHistory()], dataDir: dir, pages: SIGNED_IN });
    payload(await h.call('warapp_get_game', { game_id: GAME }));
    const rec = await record(dir);
    expect(rec.outlook).toEqual({ turn: 2, state: 'losing', heldTurns: 2, ratio: { low: 0.17, high: 0.33 }, estimated: true });
    const text = readFileSync(finishedPath(dir, (await playerRecordSalt(dir))!, ANN, GAME), 'utf8');
    for (const s of [String(ANN), String(BOB), 'secret words', 'Bob']) expect(text).not.toContain(s);
  });

  it('#312: a game this server never planned keeps no outlook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    h = await liveHarness({ feed: [finished(), withHistory()], dataDir: dir, pages: SIGNED_IN });
    payload(await h.call('warapp_get_game', { game_id: GAME }));
    expect(await record(dir)).not.toHaveProperty('outlook');
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
    expect(third.endOfGame).toEqual({ status: 'captured', turns: 3, processed: { profiles: 'folded', map: 'kept', lessons: 'kept' } });
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
    // Off means off: not even the signed-in account is read (no InviteToken page through the bridge).
    expect(h.bridge.requests.some((r) => r.path.includes('InviteToken'))).toBe(false);
    expect(existsSync(finishedDir(dir))).toBe(false);
    expect(existsSync(lessonsPath(dir))).toBe(false);
    expect(existsSync(mapRecordDir(dir))).toBe(false);
  });

  it('#312 E2: a game of three seats whose teams are unknown folds no profile, but keeps the map record and lessons', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    const CAT = 5512345655;
    const three = (o: Record<string, unknown> = {}) =>
      finished({
        players: [
          { id: String(ANN), name: 'Ann', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Eliminated' },
          { id: String(BOB), name: 'Bob', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Won' },
          { id: String(CAT), name: 'Cat', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Eliminated' },
        ],
        ...o,
      });
    const hist = three({
      standing0: [terr(1, ANN, 5), terr(2, 'Neutral', 2), terr(3, CAT, 5), terr(5, 'Neutral', 2), terr(6, BOB, 5)],
      standing1: [terr(1, ANN, 4), terr(2, ANN, 3), terr(3, CAT, 5), terr(5, BOB, 4), terr(6, BOB, 4)],
      standing2: [terr(1, BOB, 6), terr(2, BOB, 1), terr(3, BOB, 5), terr(5, BOB, 4), terr(6, BOB, 1)],
    });
    h = await liveHarness({ feed: [three(), hist], dataDir: dir, pages: SIGNED_IN });
    const r = payload(await h.call('warapp_get_game', { game_id: GAME }));
    expect(r.endOfGame).toMatchObject({ status: 'captured', processed: { profiles: 'teams-unknown', map: 'kept', lessons: 'kept' } });
    expect(existsSync(profilePlayersPath(dir))).toBe(false);
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
    expect(readdirSync(finishedDir(dir)).filter((n) => n !== 'processed.json')).toHaveLength(3);
  });

  it('a pass that spent its history read is never read again in this process, even when nothing could be kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    // The finished folder cannot be written (a read-only or full data dir): the record cannot land.
    mkdirSync(finishedDir(dir), { recursive: true });
    chmodSync(finishedDir(dir), 0o500);
    const over = { id: GAME, name: 'Over', lastTurn: 2, state: 4, players: [{ id: 123456, name: 'Ann', state: 3, committed: false }] };
    h = await liveHarness({
      feed: [withHistory()],
      dataDir: dir,
      pages: SIGNED_IN,
      warapp: (req) => {
        if (req.method !== Method.GetMyGames) throw new Error(`unexpected method ${req.method}`);
        return { body: (w: Writer) => writeMyGamesReturn(w, [over]) };
      },
    });
    try {
      const first = payload(await h.call('warapp_my_games'));
      expect(first.endOfGame).toEqual({ processed: [{ gameId: GAME, status: 'failed' }], pending: 0 });
      expect(historyCalls(h)).toBe(1);
      const second = payload(await h.call('warapp_my_games'));
      expect(second).not.toHaveProperty('endOfGame');
      expect(historyCalls(h)).toBe(1);
      // A read that shows the game finished does not spend another history request either.
      const viaGet = payload(await h.call('warapp_get_game', { game_id: GAME }));
      expect(viaGet.endOfGame).toEqual({ status: 'attempted' });
      expect(historyCalls(h)).toBe(1);
    } finally {
      chmodSync(finishedDir(dir), 0o700);
    }
  });

  it('a history read that shows the game not mine, or not finished, is not read again by the sweep', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    mkdirSync(dir, { recursive: true });
    const over = (id: number) => ({ id, name: `Over ${id}`, lastTurn: 2, state: 4, players: [{ id: 123456, name: 'Ann', state: 3, committed: false }] });
    const notSeated = finished({ players: [{ id: String(BOB), name: 'Bob', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Won' }] });
    h = await liveHarness({
      feed: [notSeated, finished({ state: 'Playing' })],
      dataDir: dir,
      pages: SIGNED_IN,
      warapp: (req) => {
        if (req.method !== Method.GetMyGames) throw new Error(`unexpected method ${req.method}`);
        return { body: (w: Writer) => writeMyGamesReturn(w, [over(1002), over(1001)]) };
      },
    });
    const first = payload(await h.call('warapp_my_games'));
    expect(first.endOfGame).toEqual({
      processed: [
        { gameId: 1002, status: 'not-a-player' },
        { gameId: 1001, status: 'not-finished' },
      ],
      pending: 0,
    });
    expect(historyCalls(h)).toBe(2);
    expect(payload(await h.call('warapp_my_games'))).not.toHaveProperty('endOfGame');
    expect(historyCalls(h)).toBe(2);
  });

  it('warapp_get_game asks the signed-in account at most once per finished game when it cannot be read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    h = await liveHarness({ feed: [finished()], dataDir: dir, pages: {} });
    const invite = () => h!.bridge.requests.filter((r) => r.path.includes('InviteToken')).length;
    expect(payload(await h.call('warapp_get_game', { game_id: GAME })).endOfGame).toEqual({ status: 'account-unknown' });
    const asked = invite();
    expect(asked).toBeGreaterThan(0);
    expect(payload(await h.call('warapp_get_game', { game_id: GAME })).endOfGame).toEqual({ status: 'account-unknown' });
    expect(invite()).toBe(asked);
    expect(historyCalls(h)).toBe(0);
  });
});

describe('the sweep and the store bound (P2: a processed game is never read again)', () => {
  /** A fresh copy of the module, as a new process (a restart, another hosted child) sees it: no memo. */
  async function freshProcess() {
    vi.resetModules();
    return import('../src/tools/end-of-game.js');
  }

  it('with more finished games than the store keeps, no game is read twice, whatever else is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    const { calls, fetchImpl } = stubFetch(withHistory());
    const client = new WarappClient({ env: CREDS, fetchImpl, sleep: async () => undefined });
    const deps = { client, dataDir: dir, env: {} };
    const keep = 4;
    const games = [1006, 1005, 1004, 1003, 1002, 1001]; // newest first, more than the store keeps
    const reads = () => calls.filter((c) => c.url.includes('GetHistory=true')).map((c) => Number(/GameID=(\d+)/.exec(c.url)![1]));
    for (let round = 0; round < 8; round++) {
      const eog = await freshProcess();
      await eog.sweepFinished(deps, ANN, games, { keep });
      // Records for games the sweep does not list (warapp_get_game on an old game) land in the same store.
      if (round >= 3 && round <= 5) {
        const fresh = await freshProcess();
        await fresh.endOfGame(deps, 500 + round, ANN, undefined, { keep });
      }
    }
    const read = reads();
    expect(read.length).toBeGreaterThan(0);
    expect(new Set(read).size).toBe(read.length);
    expect(readdirSync(finishedDir(dir)).filter((n) => n !== 'processed.json').length).toBeLessThanOrEqual(keep);
  });
});

describe('P2: the one history read asks no map and never refreshes one (#312)', () => {
  async function freshProcess() {
    vi.resetModules();
    return import('../src/tools/end-of-game.js');
  }
  /** A GameFeed that honours GetMap=false (the stubs do not): no `map` in the reply then. */
  function feedServer(body: Record<string, unknown>) {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      const reply = String(url).includes('GetMap=false') ? Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'map')) : body;
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }
  const history = (calls: string[]) => calls.filter((u) => u.includes('GetHistory=true'));

  it('with no map cached: the history read (GetMap=false), then one map-only read, never a second history read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    const { calls, fetchImpl } = feedServer(withHistory());
    const client = new WarappClient({ env: CREDS, fetchImpl, sleep: async () => undefined, mapCache: new MapCache(), dataDir: () => dir });
    const r = await (await freshProcess()).endOfGame({ client, dataDir: dir, env: {} }, GAME, ANN, undefined);
    expect(r).toMatchObject({ status: 'captured', processed: { map: 'kept', lessons: 'kept' } });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/GetHistory=true.*GetMap=false/);
    expect(calls[1]).not.toMatch(/GetHistory|GetMap=false/);
    expect(await record(dir)).not.toHaveProperty('noMap');
  });

  it('with the map cached: one request in all, even when the standing names land the cached map lacks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    await writeStoredMap(dir, normalizeMap(MAP));
    await rememberGameMap(dir, GAME, 77);
    const { calls, fetchImpl } = feedServer({ ...withHistory(), standing: [terr(9, BOB, 3)] });
    const client = new WarappClient({ env: CREDS, fetchImpl, sleep: async () => undefined, mapCache: new MapCache(), dataDir: () => dir });
    const r = await (await freshProcess()).endOfGame({ client, dataDir: dir, env: {} }, GAME, ANN, undefined);
    expect(r.status).toBe('captured');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/GetMap=false/);
  });

  it('a failed map-only read keeps the record without the map, and the history is not read again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      if (!String(url).includes('GetMap=false')) return new Response('down', { status: 503 });
      const { map: _map, ...body } = withHistory();
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const client = new WarappClient({ env: CREDS, fetchImpl, sleep: async () => undefined, mapCache: new MapCache(), dataDir: () => dir });
    const r = await (await freshProcess()).endOfGame({ client, dataDir: dir, env: {} }, GAME, ANN, undefined);
    expect(r).toMatchObject({ status: 'captured', processed: { map: 'no-map' } });
    expect(history(calls)).toHaveLength(1);
    expect(await record(dir)).toMatchObject({ noMap: true });
  });

  it.each([503, 429, 500])('a %i on the history read sends ONE GetHistory request (no client retry) and records read-failed', async (status) => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response('down', { status });
    }) as typeof fetch;
    const client = new WarappClient({ env: CREDS, fetchImpl, sleep: async () => undefined, mapCache: new MapCache(), dataDir: () => dir });
    const r = await (await freshProcess()).endOfGame({ client, dataDir: dir, env: {} }, GAME, ANN, undefined);
    expect(r).toMatchObject({ status: 'read-failed', failure: { reason: 'request-failed' } });
    expect(history(calls)).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(await record(dir)).toMatchObject({ status: 'read-failed' });
  });

  it('the processed mark outlives the record bound: a pruned game is never read again, in any process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    const { calls, fetchImpl } = stubFetch(withHistory());
    const client = new WarappClient({ env: CREDS, fetchImpl, sleep: async () => undefined });
    const deps = { client, dataDir: dir, env: {} };
    for (const id of [2001, 2002, 2003]) await (await freshProcess()).endOfGame(deps, id, ANN, undefined, { keep: 1 });
    expect(readdirSync(finishedDir(dir)).filter((n) => n !== 'processed.json')).toHaveLength(1);
    const eog = await freshProcess();
    for (const id of [2001, 2002]) {
      expect(await eog.needsEndOfGame(dir, {}, id, ANN)).toBe(false);
      expect((await eog.endOfGame(deps, id, ANN, undefined, { keep: 1 })).status).toBe('already-processed');
    }
    expect(history(calls.map((c) => c.url))).toHaveLength(3);
  });

  it('a first pass from the history the caller read (include_history) leaves the lasting mark too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    const { calls, fetchImpl } = stubFetch(withHistory());
    const client = new WarappClient({ env: CREDS, fetchImpl, sleep: async () => undefined });
    const deps = { client, dataDir: dir, env: {} };
    const read = await client.getGame(GAME, { history: true, settings: true });
    const first = await (await freshProcess()).endOfGame(deps, GAME, ANN, read, { history: read, retry: true, keep: 1 });
    expect(first).toMatchObject({ status: 'captured', turns: 3 });
    expect(existsSync(join(finishedDir(dir), 'processed.json'))).toBe(true);
    // Another game's record prunes this one; the mark still says it was processed, in any process.
    await (await freshProcess()).endOfGame(deps, 3001, ANN, undefined, { keep: 1 });
    expect(existsSync(finishedPath(dir, (await playerRecordSalt(dir))!, ANN, GAME))).toBe(false);
    const before = history(calls.map((c) => c.url)).length;
    const eog = await freshProcess();
    expect(await eog.needsEndOfGame(dir, {}, GAME, ANN)).toBe(false);
    expect((await eog.endOfGame(deps, GAME, ANN, undefined, { keep: 1 })).status).toBe('already-processed');
    expect(history(calls.map((c) => c.url))).toHaveLength(before);
  });

  it('a reply showing the game still in play leaves no lasting mark: a later process reads it once it ends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-'));
    const { calls, fetchImpl } = stubFetch(finished({ state: 'Playing' }), withHistory());
    const deps = { client: new WarappClient({ env: CREDS, fetchImpl, sleep: async () => undefined }), dataDir: dir, env: {} };
    expect((await (await freshProcess()).endOfGame(deps, GAME, ANN, undefined)).status).toBe('not-finished');
    expect((await (await freshProcess()).endOfGame(deps, GAME, ANN, undefined)).status).toBe('captured');
    expect(history(calls.map((c) => c.url))).toHaveLength(2);
  });
});
