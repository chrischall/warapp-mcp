import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, type TestHarness } from '@chrischall/mcp-utils/test';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { MapCache } from '../src/client.js';
import { registerAllTools } from '../src/tools/index.js';
import { mockWarappBridge } from './bridge-mock.js';
import { CREDS, payload, textOf } from './helpers.js';

// A made-up 4-territory map and finished games on it, as GameFeed scalars (strings).
const RAW_MAP = {
  id: '777',
  name: 'Test Map',
  territories: [1, 2, 3, 4].map((id) => ({
    id: String(id),
    name: `Land ${id}`,
    connectedTo: [id === 1 ? 2 : 1],
  })),
  bonuses: [
    { id: '1', name: 'North', value: '2', territoryIDs: [1, 2] },
    { id: '2', name: 'South', value: '2', territoryIDs: [3, 4] },
  ],
  distributionModes: [],
};

function rawGame(id: number, state = 'Finished') {
  return {
    id: String(id),
    state,
    name: 'test game',
    numberOfTurns: '2',
    players: [
      { id: '1001', name: 'alpha', state: 'Won', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False' },
      { id: '1002', name: 'beta', state: 'Eliminated', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False' },
    ],
    settings: { Map: '777' },
    map: RAW_MAP,
    history: [
      { turnNumber: '0', standing: [{ terrID: '1', ownedBy: '1001', armies: '2' }, { terrID: '3', ownedBy: '1002', armies: '2' }] },
      { turnNumber: '1', standing: [{ terrID: '1', ownedBy: '1001' }, { terrID: '2', ownedBy: '1001' }, { terrID: '3', ownedBy: '1002' }] },
    ],
  };
}

interface H {
  harness: TestHarness;
  urls: string[];
  call: (args: Record<string, unknown>) => Promise<CallToolResult>;
}
let open: H | undefined;
afterEach(async () => {
  await open?.harness.close();
  open = undefined;
});

/** A harness whose fake war.app answers GameIDFeed with `ids` and GameFeed per game id. */
async function harness(
  env: Record<string, string>,
  ids: number[] = [],
  games: Record<number, unknown> = {},
  feed: { fail: boolean } = { fail: false },
): Promise<H> {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    urls.push(u);
    if (feed.fail && /GameIDFeed/.test(u)) return new Response('upstream down', { status: 503 });
    const id = Number(/GameID=(\d+)/.exec(u)?.[1]);
    const body = /GameIDFeed/.test(u) ? { gameIDs: ids } : (games[id] ?? { error: 'ServerGameKeyNotFound' });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const { bridge } = mockWarappBridge(() => {
    throw new Error('no bridge traffic expected');
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'warapp-mcp-stats-tool-'));
  const h = await createTestHarness((s) =>
    registerAllTools(s, {
      env: { ...CREDS, MCP_DATA_DIR: dataDir, ...env },
      fetchImpl,
      sleep: async () => {},
      mapCache: new MapCache(),
      bridge,
    }),
  );
  open = {
    harness: h,
    urls,
    call: (args) => h.client.callTool({ name: 'warapp_map_stats', arguments: args }) as Promise<CallToolResult>,
  };
  return open;
}

describe('warapp_map_stats', () => {
  it('is off by default: refuses with how to enable it, and makes no request', async () => {
    const h = await harness({});
    const res = await h.call({ map_id: 777 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/WARAPP_STATS=1/);
    expect(h.urls).toEqual([]);
  });

  it('is off when hosted even with WARAPP_STATS=1, and makes no request', async () => {
    const h = await harness({ WARAPP_STATS: '1', MCP_HOST_METER_FILE: '/tmp/meter' });
    const res = await h.call({ map_id: 777 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/hosted/i);
    expect(h.urls).toEqual([]);
  });

  it('collects finished ladder games, then reports the map’s stats with names', async () => {
    const ids = [21, 22, 23, 24, 25, 26];
    const h = await harness({ WARAPP_STATS: '1' }, ids, Object.fromEntries(ids.map((id) => [id, rawGame(id)])));
    const p = payload<Record<string, any>>(await h.call({ map_id: 777, ladder_id: 0 }));
    expect(h.urls[0]).toBe('https://war.app/API/GameIDFeed?LadderID=0');
    expect(h.urls.filter((u) => /GameFeed\?GameID=\d+&GetHistory=true/.test(u))).toHaveLength(6);
    expect(p.collected).toMatchObject({ ladderId: 0, feedGames: 6, fetched: 6, newlyCached: 6, failed: 0 });
    expect(p.map).toEqual({ id: 777, name: 'Test Map' });
    expect(p.stats.sampleSize).toBe(6);
    expect(p.stats.lowSample).toBe(false);
    expect(p.stats.mostPicked[0]).toMatchObject({ territoryId: 1, name: 'Land 1', picks: 6, winnerPicks: 6 });
    // Six players per bonus: enough games, too few players for a bonus win rate (#132).
    expect(p.stats.winRateByStartingBonus).toEqual([
      { bonusId: 1, name: 'North', players: 6, wins: 6, winRate: 1, lowSample: true },
      { bonusId: 2, name: 'South', players: 6, wins: 0, winRate: 0, lowSample: true },
    ]);
    expect(p.stats.unreadableGames).toBe(0);
    expect(p.stats.firstBonusTurn).toMatchObject({ completed: 6, median: 1 });

    // A second call: every game is cached — only the feed is asked.
    h.urls.length = 0;
    const again = payload<Record<string, any>>(await h.call({ map_id: 777 }));
    expect(h.urls).toEqual(['https://war.app/API/GameIDFeed?LadderID=0']);
    expect(again.collected).toMatchObject({ cacheHits: 6, fetched: 0 });
  });

  it('honours max_new_games and says when the sample is too small', async () => {
    const ids = [31, 32, 33];
    const h = await harness({ WARAPP_STATS: '1' }, ids, Object.fromEntries(ids.map((id) => [id, rawGame(id)])));
    const p = payload<Record<string, any>>(await h.call({ map_id: 777, max_new_games: 2 }));
    expect(p.collected).toMatchObject({ fetched: 2, remaining: 1 });
    expect(p.stats.lowSample).toBe(true);
    expect(p.stats.note).toMatch(/fewer than 5/);
  });

  it('a game that errors is skipped and counted', async () => {
    const h = await harness({ WARAPP_STATS: '1' }, [41, 42], { 41: rawGame(41) });
    const p = payload<Record<string, any>>(await h.call({ map_id: 777 }));
    expect(p.collected).toMatchObject({ fetched: 2, newlyCached: 1, failed: 1 });
    expect(p.stats.sampleSize).toBe(1);
  });

  it('says so when no finished game on the map is cached yet', async () => {
    const h = await harness({ WARAPP_STATS: '1' }, [], {});
    const p = payload<Record<string, any>>(await h.call({ map_id: 5 }));
    expect(p.stats).toBeUndefined();
    expect(p.message).toMatch(/no finished games/i);
  });

  it('max_new_games: 0 reads the cache only — no feed request', async () => {
    const ids = [51, 52];
    const h = await harness({ WARAPP_STATS: '1' }, ids, Object.fromEntries(ids.map((id) => [id, rawGame(id)])));
    await h.call({ map_id: 777 });
    h.urls.length = 0;
    const p = payload<Record<string, any>>(await h.call({ map_id: 777, max_new_games: 0 }));
    expect(h.urls).toEqual([]);
    expect(p.collected).toMatchObject({ cacheOnly: true });
    expect(p.stats.sampleSize).toBe(2);
  });

  it('when the feed fails but the map has cached games, returns them with a warning', async () => {
    const ids = [61, 62];
    const feed = { fail: false };
    const h = await harness({ WARAPP_STATS: '1' }, ids, Object.fromEntries(ids.map((id) => [id, rawGame(id)])), feed);
    await h.call({ map_id: 777 });
    feed.fail = true;
    const res = await h.call({ map_id: 777 });
    expect(res.isError).toBeFalsy();
    const p = payload<Record<string, any>>(res);
    expect(p.stats.sampleSize).toBe(2);
    expect(p.warning).toMatch(/feed/i);
    expect(p.collected).toBeUndefined();
  });

  it('when the feed fails and nothing on the map is cached, the error stands', async () => {
    const h = await harness({ WARAPP_STATS: '1' }, [], {}, { fail: true });
    const res = await h.call({ map_id: 777 });
    expect(res.isError).toBe(true);
  });

  it('rejects a bad max_new_games before any request', async () => {
    const h = await harness({ WARAPP_STATS: '1' });
    const res = await h.call({ map_id: 777, max_new_games: 51 });
    expect(res.isError).toBe(true);
    expect(h.urls).toEqual([]);
  });
});
