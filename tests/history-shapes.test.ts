// #302: GameFeed GetHistory on a finished game read as unreadable. Every plausible shape is read,
// and an unreadable one says why, name-free (top-level key names only), so one live call shows
// the real shape. Synthetic replies only.
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeGame, type Game, type GameMap, type Player } from '../src/normalize.js';
import { readableRecord, recordFromGame } from '../src/map-stats.js';
import { StatsCollector, type StatsClient } from '../src/stats.js';
import { boardFromHistory, historyBoards, historyReport } from '../src/trend.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessFor, lobbyFixture, payload, stubFetch, CREDS, type Harness } from './helpers.js';
import { MapCache, WarappClient } from '../src/client.js';

const A = 1001;
const B = 1002;
const PLAYERS = [A, B].map((id) => ({ id, name: `p${id}`, isAI: false, humanTurnedIntoAI: false, hasCommittedOrders: false })) as Player[];

/** A standing after `n` completed turns: A's land grows by one territory per turn. */
const standing = (n: number) => [
  ...Array.from({ length: n + 1 }, (_, i) => ({ terrID: String(i + 1), ownedBy: String(A), armies: '3', fogLevel: 'Visible' })),
  { terrID: '9', ownedBy: String(B), armies: '4', fogLevel: 'Visible' },
];
const held = (b: { territories: Array<{ owner: { kind: string; playerId?: number } }> } | undefined) =>
  b?.territories.filter((t) => t.owner.kind === 'player' && t.owner.playerId === A).length;

describe('historyBoards: the shapes GameFeed may send (#302)', () => {
  it('reads top-level standingN keys after a distributionStanding as one turn on (numberOfTurns = last N + 1)', () => {
    // 3 completed turns: distribution, then standing0..standing2 after turns 1..3; turnN are orders.
    const h = { distributionStanding: standing(0), standing0: standing(1), turn0: { orders: [] }, standing1: standing(2), turn1: {}, standing2: standing(3) };
    const boards = historyBoards(h, PLAYERS, { numberOfTurns: 3 });
    expect(boards.map((b) => [b.turn, held(b.board)])).toEqual([[0, 1], [1, 2], [2, 3], [3, 4]]);
    expect(held(boardFromHistory(h, 2, PLAYERS, { numberOfTurns: 3 }))).toBe(3);
  });

  it('reads standingN as N completed turns when the keys reach numberOfTurns (standing0 the start)', () => {
    const h = { standing0: standing(0), standing1: standing(1), standing2: standing(2) };
    expect(historyBoards(h, PLAYERS, { numberOfTurns: 2 }).map((b) => [b.turn, held(b.board)])).toEqual([[0, 1], [1, 2], [2, 3]]);
  });

  it('without numberOfTurns, a distributionStanding puts standing0 one turn on', () => {
    const h = { distributionStanding: standing(0), standing0: standing(1) };
    expect(historyBoards(h, PLAYERS).map((b) => b.turn)).toEqual([0, 1]);
  });

  it('a distributionStanding with no player land is the board before picks: standing0 is the start, whatever numberOfTurns says', () => {
    // Pre-pick: every territory available or neutral. standing0 is then the board after picks.
    const pre = [{ terrID: '1', ownedBy: 'AvailableForDistribution', armies: '2' }, { terrID: '9', ownedBy: 'Neutral', armies: '2' }];
    const h = { distributionStanding: pre, standing0: standing(0), standing1: standing(1) };
    for (const opts of [{}, { numberOfTurns: 2 }]) {
      const boards = historyBoards(h, PLAYERS, opts);
      expect(boards.map((b) => [b.turn, held(b.board)])).toEqual([[0, 1], [1, 2]]);
    }
    expect(historyReport({ history: h, players: PLAYERS, numberOfTurns: 2 })).toEqual({
      read: { turns: 2, first: 0, last: 1, layout: 'standing-keys+distribution' },
    });
  });

  it('a turnN entry of orders beside standingN never shadows the standing', () => {
    const h = { turn1: { orders: [{ type: 'deploy' }] }, standing1: standing(1) };
    expect(held(boardFromHistory(h, 1, PLAYERS))).toBe(2);
  });

  it('a land-free distributionStanding beside turn-numbered keys is the board before picks, never entry 0', () => {
    const pre = [{ terrID: '1', ownedBy: 'AvailableForDistribution', armies: '2' }, { terrID: '9', ownedBy: 'Neutral', armies: '2' }];
    const h = { distributionStanding: pre, turn1: { standing: standing(1) }, turn2: { standing: standing(2) } };
    expect(historyBoards(h, PLAYERS).map((b) => b.turn)).toEqual([1, 2]);
    // Turn 1's previous board (entry 0) is not the pre-pick board.
    expect(boardFromHistory(h, 0, PLAYERS)).toBeUndefined();
    // With player land it is the start, entry 0, as before.
    expect(historyBoards({ ...h, distributionStanding: standing(0) }, PLAYERS).map((b) => b.turn)).toEqual([0, 1, 2]);
  });

  it('never reads a turnN entry that carries orders as a board, with or without standingN keys', () => {
    // Orders as an `orders` list, and as a bare list of order records: neither is a board, even when
    // an order record carries fields a territory entry would (an id, an owner, armies).
    const orders = [{ type: 'GameOrderDeploy', id: '3', playerID: String(A), armies: '5' }];
    const h = { turn0: orders, turn1: { orders }, turn2: { standing: standing(2) } };
    expect(historyBoards(h, PLAYERS).map((b) => b.turn)).toEqual([2]);
    expect(boardFromHistory(h, 0, PLAYERS)).toBeUndefined();
    expect(historyReport({ players: PLAYERS, history: { turn0: orders } })).toMatchObject({
      // Orders alone are no entry the reader knows; the key names say what came.
      unreadable: { reason: 'no-turns', historyKeys: ['turn0'] },
    });
  });

  it('reads `history` / `standings` wrappers, a JSON string, and entries keyed Standing or territories', () => {
    expect(historyBoards({ history: [standing(0), standing(1)] }, PLAYERS)).toHaveLength(2);
    expect(historyBoards({ standings: [{ turnNumber: 0, Standing: standing(0) }] }, PLAYERS)).toHaveLength(1);
    expect(historyBoards(JSON.stringify([{ turn: 0, standing: { territories: standing(0) } }]), PLAYERS)).toHaveLength(1);
  });

  it('takes the first entry of a number that parses, not merely the first of that number', () => {
    expect(held(boardFromHistory([{ turn: 1, note: 'x' }, { turn: 1, standing: standing(1) }], 1, PLAYERS))).toBe(2);
  });
});

describe('normalizeGame keeps a history sent outside `history` (#302)', () => {
  const base = { id: '5', state: 'Finished', numberOfTurns: '2', players: [] };

  it('collects top-level standingN, turnN and distributionStanding keys', () => {
    const g = normalizeGame({ ...base, distributionStanding: standing(0), standing0: standing(1), turn0: { orders: [] }, standing1: standing(2) });
    expect(Object.keys(g.history as object).sort()).toEqual(['distributionStanding', 'standing0', 'standing1', 'turn0']);
  });

  it('reads `History`, a JSON-string history, and a per-turn `standings` array', () => {
    expect(normalizeGame({ ...base, History: [standing(0)] }).history).toEqual([standing(0)]);
    expect(normalizeGame({ ...base, history: JSON.stringify([standing(0)]) }).history).toEqual([standing(0)]);
    const g = normalizeGame({ ...base, standings: [standing(0), standing(1)] });
    expect(g.history).toEqual({ standings: [standing(0), standing(1)] });
    // A `standings` that is the current board stays the current board, not a history.
    const cur = normalizeGame({ ...base, standings: standing(0) });
    expect(cur.standing?.territories).toHaveLength(2);
    expect(cur.history).toBeUndefined();
  });

  it('leaves history absent when nothing history-like was sent', () => {
    expect(normalizeGame(base).history).toBeUndefined();
  });
});

describe('historyReport: why a history is unreadable, name-free (#302)', () => {
  const g = (extra: Partial<Game>): Game => ({ id: 5, state: 'Finished', numberOfTurns: 2, players: PLAYERS, ...extra });

  it('absent: no history at all, with the reply\'s top-level key names', () => {
    expect(historyReport(g({ feedKeys: ['id', 'state', 'players'] }))).toEqual({
      unreadable: { reason: 'absent', keys: ['id', 'state', 'players'] },
    });
  });

  it('not-json: a string that does not parse', () => {
    expect(historyReport(g({ history: 'garbage', feedKeys: ['history'] }))).toEqual({
      unreadable: { reason: 'not-json', keys: ['history'], shape: 'string' },
    });
  });

  it('no-turns: a history with no entry the reader knows, naming its own keys', () => {
    expect(historyReport(g({ history: { foo: 1, bar: [] }, feedKeys: ['history'] }))).toEqual({
      unreadable: { reason: 'no-turns', keys: ['history'], shape: 'object', historyKeys: ['foo', 'bar'] },
    });
  });

  it('no-standing: entries, none a board, with the count and the first entry\'s key names', () => {
    expect(historyReport(g({ history: [{ date: 'x', orders: [] }, { date: 'y' }] }))).toEqual({
      unreadable: { reason: 'no-standing', keys: [], shape: 'array', turns: 2, entryKeys: ['date', 'orders'] },
    });
  });

  it('no-player-land: boards whose owners are no player of the game (only with needPlayerLand)', () => {
    const h = [[{ terrID: 1, ownedBy: 'Somebody', armies: 2 }]];
    expect(historyReport(g({ history: h }))).toMatchObject({ read: { turns: 1 } });
    const r = historyReport(g({ history: h }), { needPlayerLand: true });
    expect(r).toEqual({ unreadable: { reason: 'no-player-land', keys: [], shape: 'array', turns: 1 } });
    // Never the owner text itself: it may be a name.
    expect(JSON.stringify(r)).not.toContain('Somebody');
  });

  it('a readable history reports its turns and layout', () => {
    const h = { distributionStanding: standing(0), standing0: standing(1), standing1: standing(2) };
    expect(historyReport(g({ history: h }))).toEqual({
      read: { turns: 3, first: 0, last: 2, layout: 'standing-keys+1+distribution' },
    });
  });

  it('caps and filters the key names it reports', () => {
    const keys = [...Array.from({ length: 80 }, (_, i) => `k${i}`), 'a name with spaces'];
    const r = historyReport(g({ feedKeys: keys })) as { unreadable: { keys: string[] } };
    expect(r.unreadable.keys).toHaveLength(40);
    expect(r.unreadable.keys).not.toContain('a name with spaces');
  });
});

const MAP: GameMap = {
  id: 777,
  name: 'Test Map',
  territories: [1, 2, 3, 9].map((id) => ({ id, name: `T${id}`, connectedTo: [] })),
  bonuses: [{ id: 1, name: 'North', value: 2, territoryIds: [1, 2], bonusIds: [] }],
  distributionModes: [],
};

describe('map statistics read the top-level layout and say why a game is unreadable (#302)', () => {
  it('recordFromGame reads starts and the first bonus turn from standingN keys', () => {
    const game: Game = {
      id: 5,
      state: 'Finished',
      numberOfTurns: 2,
      players: PLAYERS.map((p) => ({ ...p, state: p.id === A ? 'Won' : 'Eliminated' })),
      history: { distributionStanding: standing(0), standing0: standing(1), standing1: standing(2) },
    };
    const r = recordFromGame(game, MAP);
    expect(r.turnsSeen).toBe(3);
    expect(r.players.find((p) => p.playerId === A)).toMatchObject({ starts: [1], firstBonusTurn: 1 });
  });

  it('recordFromGame takes the starts from standing0 when the distribution standing holds no player land', () => {
    const pre = [1, 2, 3, 9].map((t) => ({ terrID: String(t), ownedBy: 'AvailableForDistribution', armies: '2' }));
    const game: Game = {
      id: 6,
      state: 'Finished',
      numberOfTurns: 2,
      players: PLAYERS.map((p) => ({ ...p, state: p.id === A ? 'Won' : 'Eliminated' })),
      history: { distributionStanding: pre, standing0: standing(0), standing1: standing(1) },
    };
    const r = recordFromGame(game, MAP);
    expect(r.layout).toBe('standing-keys+distribution');
    // Not standing1's captures: the start is the first board after picks.
    expect(r.players.find((p) => p.playerId === A)).toMatchObject({ starts: [1], firstBonusTurn: 1 });
    expect(r.players.find((p) => p.playerId === B)).toMatchObject({ starts: [9] });
  });

  it('a record read under a retired layout is unreadable (the collector and the cache both judge by readableRecord); one kept before layouts is not', async () => {
    const game: Game = {
      id: 9,
      state: 'Finished',
      numberOfTurns: 1,
      map: MAP,
      players: PLAYERS.map((p) => ({ ...p, state: p.id === A ? 'Won' : 'Eliminated' })),
      history: { standing0: standing(0), standing1: standing(1) },
    };
    const r = recordFromGame(game, MAP);
    expect(r.layout).toBe('standing-keys');
    expect(readableRecord(r)).toBe(true);
    expect(readableRecord(r, new Set(['standing-keys']))).toBe(false);
    // A record cached before layouts were kept has none and stays readable.
    const { layout: _, ...old } = r;
    expect(readableRecord(old, new Set(['standing-keys']))).toBe(true);
  });

  it('the collector lists each unreadable game with its reason', async () => {
    const bad = (id: number): Game => ({ id, state: 'Finished', numberOfTurns: 2, players: PLAYERS, map: MAP, feedKeys: ['id', 'state', 'players'] });
    const client: StatsClient = { getGameIds: async () => [8, 7], getGame: async (id) => bad(id) };
    const dir = mkdtempSync(join(tmpdir(), 'warapp-history-'));
    const c = new StatsCollector({ client, dir: () => dir, now: () => 0, sleep: async () => {} });
    const res = await c.collect(0);
    expect(res.unreadable).toBe(2);
    expect(res.unreadableGames).toEqual([
      { gameId: 8, historyUnreadable: { reason: 'absent', keys: ['id', 'state', 'players'] } },
      { gameId: 7, historyUnreadable: { reason: 'absent', keys: ['id', 'state', 'players'] } },
    ]);
    // Skipped again this process: still listed, with the reason kept, no request.
    expect((await c.collect(0)).unreadableGames).toHaveLength(2);
  });
});

describe('WarappClient keeps the reply\'s top-level key names when the history is asked (#302)', () => {
  const body = { id: '5', state: 'Finished', numberOfTurns: '1', players: [], termsOfUse: 'x', 'odd key!': 1 };
  const client = (f: typeof fetch) => new WarappClient({ env: CREDS, fetchImpl: f, mapCache: new MapCache(), sleep: async () => {} });

  it('with history: feedKeys, safe names only', async () => {
    const { fetchImpl } = stubFetch(body);
    expect((await client(fetchImpl).getGame(5, { history: true, map: false })).feedKeys).toEqual(['id', 'state', 'numberOfTurns', 'players', 'termsOfUse']);
  });

  it('without history: none', async () => {
    const { fetchImpl } = stubFetch(body);
    expect((await client(fetchImpl).getGame(5, { map: false })).feedKeys).toBeUndefined();
  });
});

describe('warapp_get_game says why the history did not read (#302)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.harness.close();
    h = undefined;
  });

  const finished = (): Record<string, unknown> => ({ ...lobbyFixture(), state: 'Finished', numberOfTurns: '2' });

  it('compact and full carry historyUnreadable when asked and unreadable; not otherwise', async () => {
    h = await harnessFor(finished());
    const c = payload(await h.call('warapp_get_game', { game_id: 12345678, include_history: true }));
    expect(c.historyUnreadable).toMatchObject({ reason: 'absent' });
    expect((c.historyUnreadable as { keys: string[] }).keys).toEqual(expect.arrayContaining(['id', 'state', 'players']));
    const full = payload(await h.call('warapp_get_game', { game_id: 12345678, include_history: true, view: 'full' }));
    expect(full.historyUnreadable).toMatchObject({ reason: 'absent' });
    const plain = payload(await h.call('warapp_get_game', { game_id: 12345678 }));
    expect(plain.historyUnreadable).toBeUndefined();
  });

  it('a readable history reports historyRead', async () => {
    const f = finished();
    const id = String((f.players as Array<{ id: string }>)[0]!.id);
    const st = [{ terrID: '1', ownedBy: id, armies: '2' }];
    h = await harnessFor({ ...f, distributionStanding: st, standing0: st, standing1: st });
    const c = payload(await h.call('warapp_get_game', { game_id: 12345678, include_history: true }));
    expect(c.historyRead).toEqual({ turns: 3, first: 0, last: 2, layout: 'standing-keys+1+distribution' });
    expect(c.historyUnreadable).toBeUndefined();
  });
});
