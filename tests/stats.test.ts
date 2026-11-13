import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GetGameOptions } from '../src/client.js';
import type { Game, GameMap } from '../src/normalize.js';
import {
  cachedRecords,
  isHosted,
  MAX_NEW_GAMES,
  MIN_GAP_MS,
  recordPath,
  UNFINISHED_RETRY_MS,
  StatsCollector,
  statsGate,
  type StatsClient,
} from '../src/stats.js';

const MAP: GameMap = {
  id: 777,
  name: 'Test Map',
  territories: [1, 2, 3, 4].map((id) => ({ id, name: `T${id}`, connectedTo: [] })),
  bonuses: [
    { id: 1, name: 'North', value: 2, territoryIds: [1, 2], bonusIds: [] },
    { id: 2, name: 'South', value: 2, territoryIds: [3, 4], bonusIds: [] },
  ],
  distributionModes: [],
};
const A = 1001;
const B = 1002;

function game(id: number, state = 'Finished', map: GameMap | null = MAP): Game {
  return {
    id,
    state,
    players: [A, B].map((p) => ({
      id: p,
      name: `p${p}`,
      isAI: false,
      humanTurnedIntoAI: false,
      hasCommittedOrders: false,
      state: p === A ? 'Won' : 'Eliminated',
    })),
    ...(map ? { map } : {}),
    history: [
      { turnNumber: 0, standing: [{ terrID: 1, ownedBy: A, armies: 2 }, { terrID: 3, ownedBy: B, armies: 2 }] },
      { turnNumber: 1, standing: [{ terrID: 1, ownedBy: A }, { terrID: 2, ownedBy: A }, { terrID: 3, ownedBy: B }] },
    ],
  };
}

/** A fake WarappClient on a fake clock: every request is stamped with the clock's time. */
function fake(ids: number[], games: Record<number, () => Game> = {}) {
  let clock = 50_000;
  const requests: Array<{ at: number; what: string; opts?: GetGameOptions }> = [];
  const client: StatsClient = {
    async getGameIds({ ladderId }) {
      requests.push({ at: clock, what: `feed:${ladderId}` });
      clock += 30;
      return ids;
    },
    async getGame(id, opts) {
      requests.push({ at: clock, what: `game:${id}`, opts });
      clock += 30;
      const g = games[id];
      if (!g) throw new Error('boom');
      return g();
    },
  };
  const dir = mkdtempSync(join(tmpdir(), 'warapp-stats-test-'));
  const collector = new StatsCollector({
    client,
    dir: () => dir,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { collector, requests, dir, advance };
}

const finished = (...ids: number[]) => Object.fromEntries(ids.map((id) => [id, () => game(id)]));

describe('statsGate (opt-in, never hosted)', () => {
  it('is off unless WARAPP_STATS is truthy', () => {
    expect(statsGate({})).toEqual({ enabled: false, reason: 'off' });
    expect(statsGate({ WARAPP_STATS: '0' })).toEqual({ enabled: false, reason: 'off' });
    expect(statsGate({ WARAPP_STATS: '1' })).toEqual({ enabled: true });
    expect(statsGate({ WARAPP_STATS: 'true' })).toEqual({ enabled: true });
  });

  it('is always off when hosted, whatever WARAPP_STATS says', () => {
    for (const k of ['MCP_HOST_METER_FILE', 'MCP_HOST_CONFIRM_SECRET', 'MCP_BLOB_BASE_URL', 'FLY_MACHINE_ID']) {
      expect(isHosted({ [k]: 'x' }), k).toBe(true);
      expect(statsGate({ WARAPP_STATS: '1', [k]: 'x' }), k).toEqual({ enabled: false, reason: 'hosted' });
    }
    // MCP_DATA_DIR alone is not hosting: a local install may set it.
    expect(isHosted({ MCP_DATA_DIR: '/tmp/x' })).toBe(false);
  });
});

describe('StatsCollector', () => {
  it('fetches each new game with GetHistory and caches finished ones under stats/<mapId>/<gameId>.json', async () => {
    const { collector, requests, dir } = fake([12, 11], finished(11, 12));
    const res = await collector.collect(0);
    expect(res).toMatchObject({ ladderId: 0, feedGames: 2, cacheHits: 0, fetched: 2, newlyCached: 2, failed: 0 });
    expect(requests.map((r) => r.what)).toEqual(['feed:0', 'game:12', 'game:11']);
    // No map download: the fake (like WarappClient with the map cached) attaches it (#148).
    expect(requests[1]!.opts).toEqual({ history: true, settings: true, map: false });
    const rec = JSON.parse(readFileSync(recordPath(dir, 777, 11), 'utf8'));
    expect(rec).toMatchObject({ gameId: 11, mapId: 777 });
    expect(JSON.stringify(rec)).not.toMatch(/p1001|Test Map|North/); // ids only, no names
    expect((await collector.records(777)).map((r) => r.gameId)).toEqual([11, 12]);
  });

  it('downloads a map only for a finished game whose map is not cached, one more request, still 1 s apart (#148)', async () => {
    // The first call (no map download) comes back without a map when it is not cached.
    let calls21 = 0;
    const { collector, requests } = fake([22, 21], {
      21: () => (++calls21 === 1 ? game(21, 'Finished', null) : game(21)),
      22: () => game(22, 'Playing', null),
    });
    const res = await collector.collect(0);
    expect(res).toMatchObject({ fetched: 2, newlyCached: 1, notFinished: 1, failed: 0 });
    expect(requests.map((r) => [r.what, r.opts])).toEqual([
      ['feed:0', undefined],
      ['game:22', { history: true, settings: true, map: false }],
      ['game:21', { history: true, settings: true, map: false }],
      ['game:21', { settings: true }],
    ]);
    expect(requests[3]!.at - requests[2]!.at).toBeGreaterThanOrEqual(MIN_GAP_MS);
  });

  it('leaves at least 1 s between requests (the fake clock sees the gaps), across calls too', async () => {
    const { collector, requests } = fake([3, 2, 1], finished(1, 2, 3));
    await collector.collect(0);
    await collector.collect(0);
    const gaps = requests.slice(1).map((r, i) => r.at - requests[i]!.at);
    expect(gaps.length).toBeGreaterThan(3);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(MIN_GAP_MS);
  });

  it('keeps the 1 s gap when two calls overlap on the shared collector', async () => {
    // Virtual timers: sleep() parks until the driver advances the clock to its due time.
    let clock = 50_000;
    const timers: Array<{ due: number; resolve: () => void }> = [];
    const stamps: number[] = [];
    const client: StatsClient = {
      async getGameIds() {
        stamps.push(clock);
        return [3, 2, 1];
      },
      async getGame(id) {
        stamps.push(clock);
        return game(id);
      },
    };
    const dir = mkdtempSync(join(tmpdir(), 'warapp-stats-test-'));
    const collector = new StatsCollector({
      client,
      dir: () => dir,
      now: () => clock,
      sleep: (ms) => new Promise<void>((resolve) => timers.push({ due: clock + ms, resolve })),
    });
    let done = false;
    const both = Promise.all([collector.collect(1), collector.collect(2)]).then(() => {
      done = true;
    });
    while (!done) {
      // Let real file I/O settle so every caller that is going to park has parked.
      await new Promise((r) => setTimeout(r, 10));
      if (timers.length === 0) continue;
      timers.sort((a, b) => a.due - b.due);
      const t = timers.shift()!;
      clock = Math.max(clock, t.due);
      t.resolve();
    }
    await both;
    const sorted = [...stamps].sort((a, b) => a - b);
    const gaps = sorted.slice(1).map((t, i) => t - sorted[i]!);
    expect(stamps.length).toBeGreaterThan(3);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(MIN_GAP_MS);
  });

  it('tries untried games before ones that already failed this process', async () => {
    const { collector, requests } = fake([3, 2, 1], { 1: () => game(1), 2: () => game(2) });
    expect(await collector.collect(0, 1)).toMatchObject({ fetched: 1, failed: 1 });
    requests.length = 0;
    expect(await collector.collect(0, 1)).toMatchObject({ fetched: 1, newlyCached: 1, failed: 0 });
    expect(requests.map((r) => r.what)).toEqual(['feed:0', 'game:2']);
  });

  it('a cache hit makes no request', async () => {
    const { collector, requests } = fake([2, 1], finished(1, 2));
    await collector.collect(0);
    requests.length = 0;
    const res = await collector.collect(0);
    expect(requests.map((r) => r.what)).toEqual(['feed:0']);
    expect(res).toMatchObject({ cacheHits: 2, fetched: 0 });
  });

  it('a game cached on another map is still a hit', async () => {
    const { collector, requests, dir } = fake([5]);
    mkdirSync(join(dir, 'stats', '999'), { recursive: true });
    writeFileSync(join(dir, 'stats', '999', '5.json'), '{}');
    const res = await collector.collect(0);
    expect(res.cacheHits).toBe(1);
    expect(requests.map((r) => r.what)).toEqual(['feed:0']);
  });

  it('fetches at most max_new_games per call (default 10, capped at 50) and reports the rest', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => 1000 - i);
    const games = finished(...ids);
    const a = fake(ids, games);
    expect(await a.collector.collect(0)).toMatchObject({ fetched: 10, remaining: 50 });
    const b = fake(ids, games);
    expect(await b.collector.collect(0, 3)).toMatchObject({ fetched: 3, remaining: 57 });
    const c = fake(ids, games);
    expect(await c.collector.collect(0, 500)).toMatchObject({ fetched: MAX_NEW_GAMES, remaining: 10 });
  });

  it('skips and counts a failing game, never fatal, and caches nothing for it', async () => {
    const { collector, dir } = fake([3, 2, 1], { 1: () => game(1), 3: () => game(3, 'Finished', null) });
    const res = await collector.collect(0);
    expect(res).toMatchObject({ fetched: 3, newlyCached: 1, failed: 2 });
    expect(existsSync(recordPath(dir, 777, 2))).toBe(false);
    expect((await collector.records(777)).map((r) => r.gameId)).toEqual([1]);
  });

  it('does not cache an unfinished game, and does not fetch it again this process', async () => {
    const { collector, requests, dir } = fake([4], { 4: () => game(4, 'Playing') });
    expect(await collector.collect(0)).toMatchObject({ fetched: 1, notFinished: 1, newlyCached: 0 });
    expect(existsSync(recordPath(dir, 777, 4))).toBe(false);
    requests.length = 0;
    expect(await collector.collect(0)).toMatchObject({ fetched: 0, notFinished: 1 });
    expect(requests.map((r) => r.what)).toEqual(['feed:0']);
  });

  it('retries a game seen unfinished once UNFINISHED_RETRY_MS (1 hour) has passed', async () => {
    let state = 'Playing';
    const { collector, requests, advance, dir } = fake([4], { 4: () => game(4, state) });
    expect(UNFINISHED_RETRY_MS).toBe(60 * 60 * 1000);
    expect(await collector.collect(0)).toMatchObject({ fetched: 1, notFinished: 1 });
    advance(UNFINISHED_RETRY_MS - 5_000);
    requests.length = 0;
    expect(await collector.collect(0)).toMatchObject({ fetched: 0, notFinished: 1 });
    expect(requests.map((r) => r.what)).toEqual(['feed:0']);
    advance(5_000);
    state = 'Finished';
    requests.length = 0;
    expect(await collector.collect(0)).toMatchObject({ fetched: 1, notFinished: 0, newlyCached: 1 });
    expect(requests.map((r) => r.what)).toEqual(['feed:0', 'game:4']);
    expect(existsSync(recordPath(dir, 777, 4))).toBe(true);
  });

  it('overlapping collect() calls writing the same records never collide on the temp file', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => 100 + i);
    const dir = mkdtempSync(join(tmpdir(), 'warapp-stats-test-'));
    const client: StatsClient = {
      async getGameIds() {
        return ids;
      },
      async getGame(id) {
        return game(id);
      },
    };
    // Separate collectors (separate throttles) on one data dir, all in this process.
    const collectors = Array.from(
      { length: 4 },
      () => new StatsCollector({ client, dir: () => dir, now: () => 0, sleep: async () => {} }),
    );
    const results = await Promise.all(collectors.map((c) => c.collect(0, MAX_NEW_GAMES)));
    for (const r of results) expect(r.failed).toBe(0);
    expect((await collectors[0]!.records(777)).map((r) => r.gameId)).toEqual(ids);
  });

  it('does not cache a finished game whose history did not parse, counts it, and skips it this process', async () => {
    const garbled = (id: number): Game => ({ ...game(id), history: 'garbage' });
    const { collector, requests, dir } = fake([8, 7], { 7: () => game(7), 8: () => garbled(8) });
    expect(await collector.collect(0)).toMatchObject({ fetched: 2, newlyCached: 1, unreadable: 1, failed: 0 });
    expect(existsSync(recordPath(dir, 777, 8))).toBe(false);
    requests.length = 0;
    expect(await collector.collect(0)).toMatchObject({ fetched: 0, cacheHits: 1, unreadable: 1 });
    expect(requests.map((r) => r.what)).toEqual(['feed:0']);
  });

  it('drops a cached record whose history did not parse (an older cache), so it is fetched again', async () => {
    const { collector, dir, requests } = fake([9], finished(9));
    mkdirSync(join(dir, 'stats', '777'), { recursive: true });
    const old = {
      gameId: 9,
      mapId: 777,
      turnsSeen: 0,
      players: [{ playerId: A, won: true, starts: [], anchorBonusId: null, firstBonusTurn: null }],
    };
    writeFileSync(join(dir, 'stats', '777', '9.json'), JSON.stringify(old));
    expect(await collector.records(777)).toEqual([]);
    expect(existsSync(recordPath(dir, 777, 9))).toBe(false);
    expect(await collector.collect(0)).toMatchObject({ cacheHits: 0, newlyCached: 1 });
    expect(requests.map((r) => r.what)).toEqual(['feed:0', 'game:9']);
  });

  it('ignores an unreadable record when reading a map, and drops it so it is fetched again', async () => {
    const { collector, dir, requests } = fake([9], finished(9));
    mkdirSync(join(dir, 'stats', '777'), { recursive: true });
    writeFileSync(join(dir, 'stats', '777', '9.json'), 'not json');
    expect(await collector.records(777)).toEqual([]);
    expect(existsSync(recordPath(dir, 777, 9))).toBe(false);
    expect(await collector.collect(0)).toMatchObject({ cacheHits: 0, newlyCached: 1 });
    expect(requests.map((r) => r.what)).toEqual(['feed:0', 'game:9']);
    expect((await collector.records(777)).map((r) => r.gameId)).toEqual([9]);
  });
});

describe('cachedRecords (the cache alone: no request, nothing deleted)', () => {
  it('reads the records already cached for a map, ascending by game id', async () => {
    const { collector, dir, requests } = fake([12, 11], finished(11, 12));
    await collector.collect(0);
    const made = requests.length;
    const records = await cachedRecords(dir, 777);
    expect(records.map((r) => r.gameId)).toEqual([11, 12]);
    expect(records[0]!.players.map((p) => [p.playerId, p.starts])).toEqual([
      [A, [1]],
      [B, [3]],
    ]);
    expect(requests.length).toBe(made);
    expect(await cachedRecords(dir, 778)).toEqual([]);
    expect(await cachedRecords(join(dir, 'missing'), 777)).toEqual([]);
  });

  it('skips a file that is not a readable record, and leaves it where it is', async () => {
    const { collector, dir } = fake([11], finished(11));
    await collector.collect(0);
    writeFileSync(join(dir, 'stats', '777', '9.json'), 'not json');
    writeFileSync(join(dir, 'stats', '777', '10.json'), JSON.stringify({ gameId: 10, mapId: 777, turnsSeen: 0, players: [] }));
    writeFileSync(join(dir, 'stats', '777', '13.json'), JSON.stringify({ ...JSON.parse(readFileSync(recordPath(dir, 777, 11), 'utf8')), gameId: 13, mapId: 778 }));
    expect((await cachedRecords(dir, 777)).map((r) => r.gameId)).toEqual([11]);
    expect(existsSync(recordPath(dir, 777, 9))).toBe(true);
    expect(existsSync(recordPath(dir, 777, 10))).toBe(true);
  });
});
