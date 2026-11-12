import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeRequest, fromHex } from '../src/protocol/codec.js';
import type { GameUpdate } from '../src/push/listener.js';
import { checkOf, isWaitingOn, waitForTurn, type GameCheck } from '../src/tools/push.js';
import { normalizeGame } from '../src/normalize.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { fakeSocketIo, framed, gameUpdatedHex, type FakeSocketIo } from './push/fake-socket.js';

const GAME = 12345678;
const ANN = '3312345644';
const ME_PAGE = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN}</p>` };

function game(state: string, ann: Record<string, string> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>).map((p, i) =>
    i === 0 ? { ...p, id: ANN, name: 'Ann', ...ann } : p,
  );
  return { ...f, state, numberOfTurns: state === 'Playing' ? '2' : '-1', players, ...extra };
}
const READY = () => game('Playing');
const COMMITTED = () => game('Playing', { hasCommittedOrders: 'True' });

let h: Harness | undefined;
let socket: FakeSocketIo | undefined;
afterEach(async () => {
  socket?.close();
  await h?.harness.close();
  h = undefined;
  socket = undefined;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${what}`);
}

const subscribes = (s: FakeSocketIo) =>
  s.posts
    .filter((p) => p.body.startsWith('3:::'))
    .map((p) => {
      const req = decodeRequest(fromHex(p.body.slice(4)), { hasAuth: false });
      req.body.bool();
      return req.body.list((r) => r.string());
    });

async function setup(feed: unknown[], pages: Record<string, string> = ME_PAGE) {
  socket = fakeSocketIo();
  h = await liveHarness({ feed, pages, socket });
  return { h, socket };
}

const call = (name: string, args: Record<string, unknown>, options?: Parameters<Harness['harness']['client']['callTool']>[1]) =>
  h!.harness.client.callTool({ name, arguments: args }, options) as Promise<CallToolResult>;

describe('warapp_wait_for_turn', () => {
  it('returns at once when a game is already waiting on me, and subscribes to it', async () => {
    const { socket } = await setup([READY()]);
    const p = payload(await call('warapp_wait_for_turn', { game_ids: [GAME] }));
    expect(p.untrusted_content).toBe(true);
    expect(p.status).toBe('your_turn');
    expect(p.ready).toEqual([GAME]);
    expect(p.games).toEqual([{ id: GAME, name: 'Synthetic lobby game', state: 'Playing', turn: 3, waitingOnYou: true }]);
    expect(p.updates).toBe(0);
    expect(p.next).toMatch(/warapp_plan_turn/);
    await until(() => subscribes(socket).length === 1, 'subscribe');
    expect(subscribes(socket)).toEqual([[`Game.${GAME}`]]);
  });

  it('waits for a GameUpdated push, re-reads GameFeed, and resolves when it is my turn', async () => {
    const { h, socket } = await setup([COMMITTED(), READY()]);
    const pending = call('warapp_wait_for_turn', { game_ids: [String(GAME), GAME], timeout_seconds: 60 });
    await until(() => subscribes(socket).length === 1 && h.calls.length === 1, 'subscribe + first check');
    socket.push(framed(`3:::${gameUpdatedHex(999)}`, `3:::${gameUpdatedHex(GAME)}`));
    const p = payload(await pending);
    expect(p.status).toBe('your_turn');
    expect(p.updates).toBe(1);
    expect(p.push).toEqual({ connected: true });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.url).toContain(`GameID=${GAME}`);
  });

  it('keeps waiting when an update is not my turn, then times out', async () => {
    const { h, socket } = await setup([COMMITTED()]);
    const pending = call('warapp_wait_for_turn', { game_ids: [GAME], timeout_seconds: 1 });
    await until(() => subscribes(socket).length === 1 && h.calls.length === 1, 'subscribe + first check');
    socket.push(`3:::${gameUpdatedHex(GAME)}`);
    const p = payload(await pending);
    expect(p.status).toBe('timed_out');
    expect(p).not.toHaveProperty('ready');
    expect(p.updates).toBe(1);
    expect(h.calls).toHaveLength(2);
    expect((p.games as GameCheck[])[0]!.waitingOnYou).toBe(false);
    expect(p.next).toMatch(/again/);
  }, 5000);

  it('says the push socket was down when it times out without one', async () => {
    socket = fakeSocketIo();
    socket.failHandshake(...Array.from({ length: 5 }, () => ({ status: 503, body: '', url: '' })));
    h = await liveHarness({ feed: [COMMITTED()], pages: ME_PAGE, socket });
    const p = payload(await call('warapp_wait_for_turn', { game_ids: [GAME], timeout_seconds: 1 }));
    expect(p.status).toBe('timed_out');
    expect((p.push as Record<string, unknown>).connected).toBe(false);
    expect((p.push as Record<string, unknown>).last_error).toMatch(/HTTP 503/);
    expect(p.next).toMatch(/not connected/);
  }, 5000);

  it('refuses when the signed-in account cannot be read, or is not in the game', async () => {
    await setup([READY()], {});
    const r1 = await call('warapp_wait_for_turn', { game_ids: [GAME] });
    expect(r1.isError).toBe(true);
    expect(textOf(r1)).toMatch(/signed in/);
    await h!.harness.close();
    socket!.close();
    await setup([READY()], { 'https://war.app/InviteToken': '<p>Your invite token is 99000000000</p>' });
    const r2 = await call('warapp_wait_for_turn', { game_ids: [GAME] });
    expect(r2.isError).toBe(true);
    expect(textOf(r2)).toMatch(/not a player in game 12345678/);
  });

  it('validates its inputs', async () => {
    await setup([READY()]);
    expect((await call('warapp_wait_for_turn', { game_ids: [] })).isError).toBe(true);
    expect((await call('warapp_wait_for_turn', { game_ids: Array.from({ length: 21 }, (_, i) => i + 1) })).isError).toBe(true);
    expect((await call('warapp_wait_for_turn', { game_ids: [GAME], timeout_seconds: 1801 })).isError).toBe(true);
  });

  it('reports progress when asked, and stops when the call is cancelled', async () => {
    const { h, socket } = await setup([COMMITTED()]);
    const progress: Array<{ progress: number; total?: number; message?: string }> = [];
    const ac = new AbortController();
    const pending = call('warapp_wait_for_turn', { game_ids: [GAME], timeout_seconds: 600 }, {
      signal: ac.signal,
      onprogress: (p) => progress.push(p),
    });
    await until(() => subscribes(socket).length === 1 && h.calls.length === 1 && progress.length === 1, 'start');
    expect(progress[0]).toMatchObject({ progress: 0, total: 600 });
    expect(progress[0]!.message).toMatch(/Waiting for your turn in 1 game/);
    socket.push(`3:::${gameUpdatedHex(GAME)}`);
    await until(() => progress.length === 2, 'update progress');
    expect(progress[1]!.message).toMatch(/not your turn there yet/);
    ac.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe('warapp_recent_events', () => {
  it('lists pushes newest first, filtered and limited, with the socket state', async () => {
    const { socket } = await setup([READY()]);
    let p = payload(await call('warapp_recent_events', {}));
    expect(p.events).toEqual([]);
    expect(p.listening).toEqual({ started: false, connected: false, watching: [] });
    await call('warapp_wait_for_turn', { game_ids: [GAME] });
    await until(() => subscribes(socket).length === 1, 'subscribe');
    socket.push(framed(`3:::${gameUpdatedHex(GAME)}`, `3:::${gameUpdatedHex(77)}`, `3:::${gameUpdatedHex(GAME)}`));
    for (let i = 0; i < 50; i++) {
      p = payload(await call('warapp_recent_events', {}));
      if ((p.events as unknown[]).length === 3) break;
      await flush();
    }
    const events = p.events as Array<{ game_id: number; at: string }>;
    expect(events.map((e) => e.game_id)).toEqual([GAME, 77, GAME]);
    expect(events[0]!.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(p.listening).toEqual({ started: true, connected: true, watching: [GAME] });
    p = payload(await call('warapp_recent_events', { game_id: 77 }));
    expect((p.events as Array<{ game_id: number }>).map((e) => e.game_id)).toEqual([77]);
    p = payload(await call('warapp_recent_events', { limit: 1 }));
    expect(p.events).toHaveLength(1);
  });
});

describe('waitForTurn', () => {
  function fakePush() {
    const fns = new Set<(u: GameUpdate) => void>();
    const watched: number[][] = [];
    return {
      watched,
      emit: (gameId: number) => fns.forEach((f) => f({ gameId, at: 'now' })),
      listeners: () => fns.size,
      push: {
        watch: async (ids: readonly number[]) => {
          watched.push([...ids]);
        },
        onUpdate: (f: (u: GameUpdate) => void) => {
          fns.add(f);
          return () => fns.delete(f);
        },
      },
    };
  }
  const notReady = (id: number): GameCheck => ({ id, name: null, state: 'Playing', turn: 1, waitingOnYou: false });

  it('records a failed re-read and keeps waiting; ticks progress; cleans up its listener', async () => {
    const fp = fakePush();
    let n = 0;
    const messages: string[] = [];
    const pending = waitForTurn({
      gameIds: [1, 2],
      timeoutMs: 1000,
      push: fp.push,
      progressEveryMs: 5,
      progress: (_ms, m) => messages.push(m),
      check: async (id) => {
        n++;
        if (n === 3) throw new Error('GameFeed down');
        return n >= 4 ? { ...notReady(id), waitingOnYou: true } : notReady(id);
      },
    });
    await until(() => n === 2, 'initial checks');
    expect(fp.watched).toEqual([[1, 2]]);
    await new Promise((r) => setTimeout(r, 20));
    expect(messages.filter((m) => /Still waiting/.test(m)).length).toBeGreaterThan(0);
    fp.emit(2);
    await until(() => n === 3, 'failed re-read');
    fp.emit(2);
    const out = await pending;
    expect(out.status).toBe('your_turn');
    expect(out.errors).toEqual(['Game 2: GameFeed down']);
    expect(out.updates).toBe(2);
    expect(out.games.map((g) => g.waitingOnYou)).toEqual([false, true]);
    expect(fp.listeners()).toBe(0);
  });

  it('rejects at once for an already-aborted signal', async () => {
    const fp = fakePush();
    const ac = new AbortController();
    ac.abort(new Error('gone'));
    await expect(
      waitForTurn({ gameIds: [1], timeoutMs: 1000, push: fp.push, signal: ac.signal, check: async (id) => notReady(id) }),
    ).rejects.toThrow('gone');
    expect(fp.listeners()).toBe(0);
  });
});

describe('isWaitingOn / checkOf', () => {
  const g = (state: string, ann: Record<string, string> = {}) => normalizeGame(game(state, ann));
  it('needs a pick/turn phase, me Playing and not committed', () => {
    expect(isWaitingOn(g('Playing'), Number(ANN))).toBe(true);
    expect(isWaitingOn(g('DistributingTerritories'), Number(ANN))).toBe(true);
    expect(isWaitingOn(g('WaitingForPlayers'), Number(ANN))).toBe(false);
    expect(isWaitingOn(g('Finished'), Number(ANN))).toBe(false);
    expect(isWaitingOn(g('Playing', { hasCommittedOrders: 'True' }), Number(ANN))).toBe(false);
    expect(isWaitingOn(g('Playing', { state: 'Eliminated' }), Number(ANN))).toBe(false);
    expect(isWaitingOn(g('Playing'), 42)).toBe(false);
  });
  it('reports the turn being played, null before the game starts', () => {
    expect(checkOf(g('Playing'), Number(ANN)).turn).toBe(3);
    expect(checkOf(g('DistributingTerritories'), Number(ANN)).turn).toBeNull();
  });
});
