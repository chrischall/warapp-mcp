import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeRequest, fromHex } from '../src/protocol/codec.js';
import type { GameUpdate } from '../src/push/listener.js';
import { checkOf, coalesced, isWaitingOn, waitForTurn, type GameCheck } from '../src/tools/push.js';
import { normalizeGame } from '../src/normalize.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { fakeSocketIo, framed, gameUpdatedHex, type FakeSocketIo } from './push/fake-socket.js';
import { writeMyGamesReturn, type SyntheticGame } from './protocol/my-games-bundle.js';
import type { Writer } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';

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
  vi.useRealTimers();
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

async function setup(feed: unknown[], pages: Record<string, string> = ME_PAGE, myGames?: SyntheticGame[]) {
  socket = fakeSocketIo();
  h = await liveHarness({
    feed,
    pages,
    socket,
    ...(myGames
      ? {
          warapp: (req: { method: number }) => {
            if (req.method !== Method.GetMyGames) throw new Error(`unexpected method ${req.method}`);
            return { body: (w: Writer) => writeMyGamesReturn(w, myGames) };
          },
        }
      : {}),
  });
  return { h, socket };
}

// In-game id of ANN: the invite token minus two check digits each end.
const ANN_IN_GAME = 123456;
const mine = (id: number, state: number, myState = 2, committed = false): SyntheticGame => ({
  id,
  name: `G${id}`,
  lastTurn: state === 3 ? 1 : -1,
  state,
  players: [{ id: ANN_IN_GAME, name: 'Ann', state: myState, committed }],
});

const call = (name: string, args: Record<string, unknown>, options?: Parameters<Harness['harness']['client']['callTool']>[1]) =>
  h!.harness.client.callTool({ name, arguments: args }, options) as Promise<CallToolResult>;

describe('warapp_wait_for_turn', () => {
  it('returns at once when a game is already waiting on me, without watching it', async () => {
    const { socket } = await setup([READY()]);
    const p = payload(await call('warapp_wait_for_turn', { game_ids: [GAME] }));
    expect(p.untrusted_content).toBe(true);
    expect(p.status).toBe('your_turn');
    expect(p.ready).toEqual([GAME]);
    expect(p.games).toEqual([{ id: GAME, name: 'Synthetic lobby game', state: 'Playing', turn: 3, waitingOnYou: true }]);
    expect(p.updates).toBe(0);
    expect(p.next).toMatch(/warapp_plan_turn/);
    // Nothing to wait for: the push socket is not started and nothing is subscribed (#131).
    await flush();
    expect(socket.handshakes()).toBe(0);
    expect(subscribes(socket)).toEqual([]);
    // A turn check needs no map: never download one for it (#131).
    expect(h!.calls.every((c) => c.url.includes('GetMap=false'))).toBe(true);
  });

  it('waits for a GameUpdated push, re-reads GameFeed, and resolves when it is my turn', async () => {
    const { h, socket } = await setup([COMMITTED(), COMMITTED(), READY()]);
    const pending = call('warapp_wait_for_turn', { game_ids: [String(GAME), GAME], timeout_seconds: 60 });
    // The initial check, then a re-read when the socket first connects (#131).
    await until(() => subscribes(socket).length === 1 && h.calls.length === 2, 'subscribe + first checks');
    socket.push(framed(`3:::${gameUpdatedHex(999)}`, `3:::${gameUpdatedHex(GAME)}`));
    const p = payload(await pending);
    expect(p.status).toBe('your_turn');
    expect(p.updates).toBe(1);
    expect(p.push).toEqual({ connected: true, transport: 'xhr-polling' });
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]!.url).toContain(`GameID=${GAME}`);
  });

  it('re-reads GameFeed after the push socket reconnects, so a turn that came in the gap is not missed', async () => {
    const { h, socket } = await setup([COMMITTED(), COMMITTED(), READY()]);
    const pending = call('warapp_wait_for_turn', { game_ids: [GAME], timeout_seconds: 30 });
    // The initial check, then a re-read when the socket first connects (#131).
    await until(() => subscribes(socket).length === 1 && h.calls.length === 2, 'subscribe + first checks');
    // The server drops the session; no GameUpdated for the turn ever arrives.
    socket.push('0::');
    const p = payload(await pending);
    expect(p.status).toBe('your_turn');
    expect(p.updates).toBe(0);
    expect(p.reconnects).toBe(1);
    expect(h.calls).toHaveLength(3);
    expect(socket.handshakes()).toBe(2);
  }, 5000);

  it('keeps waiting when an update is not my turn, then times out', async () => {
    const { h, socket } = await setup([COMMITTED()]);
    // The wait's timeout is a fake timer: it fires only when the test advances it, never under load.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const tick = () => new Promise((r) => setImmediate(r));
    const pending = call('warapp_wait_for_turn', { game_ids: [GAME], timeout_seconds: 1 });
    // The initial check, then a re-read when the socket first connects (#131).
    for (let i = 0; i < 500 && !(subscribes(socket).length === 1 && h.calls.length === 2); i++) {
      await vi.advanceTimersByTimeAsync(0);
      await tick();
    }
    expect(subscribes(socket)).toHaveLength(1);
    socket.push(`3:::${gameUpdatedHex(GAME)}`);
    for (let i = 0; i < 500 && h.calls.length < 3; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await tick();
    }
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    const p = payload(await pending);
    expect(p.status).toBe('timed_out');
    expect(p).not.toHaveProperty('ready');
    expect(p.updates).toBe(1);
    expect(h.calls).toHaveLength(3);
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
    // Membership is checked before watching: a game I do not play in is never subscribed (#131).
    await flush();
    expect(socket!.handshakes()).toBe(0);
    expect(payload(await call('warapp_recent_events', {})).listening).toMatchObject({ started: false, watching: [] });
  });

  it('without game_ids, watches every game of mine being played or picked, from GetMyGames', async () => {
    const games = [mine(GAME, 3), mine(23456789, 5, 2, true), mine(34567890, 4), mine(45678901, 2), mine(56789012, 3, 3)];
    const other = game('Playing', { hasCommittedOrders: 'True' }, { id: '23456789' });
    const { socket } = await setup([READY(), other], ME_PAGE, games);
    const p = payload(await call('warapp_wait_for_turn', {}));
    expect(p.status).toBe('your_turn');
    expect(p.ready).toEqual([GAME]);
    expect(p.watching).toEqual([GAME, 23456789]);
    // Checked first; one is ready, so neither is subscribed (#131).
    expect(h!.calls.map((c) => new URL(c.url).searchParams.get('GameID')).sort()).toEqual([String(GAME), '23456789']);
    expect(subscribes(socket)).toEqual([]);
  });

  it('without game_ids, refuses when none of my games is in play', async () => {
    await setup([READY()], ME_PAGE, [mine(34567890, 4), mine(45678901, 2), mine(56789012, 3, 3)]);
    const r = await call('warapp_wait_for_turn', {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/none of your war\.app games is being played/i);
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
    await until(() => subscribes(socket).length === 1 && h.calls.length === 2 && progress.length >= 1, 'start');
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
    const { h, socket } = await setup([COMMITTED()]);
    let p = payload(await call('warapp_recent_events', {}));
    expect(p.events).toEqual([]);
    expect(p.listening).toEqual({ started: false, connected: false, watching: [] });
    const ac = new AbortController();
    const waiting = call('warapp_wait_for_turn', { game_ids: [GAME], timeout_seconds: 600 }, { signal: ac.signal });
    await until(() => subscribes(socket).length === 1 && h.calls.length === 2, 'subscribe + first checks');
    socket.push(framed(`3:::${gameUpdatedHex(GAME)}`, `3:::${gameUpdatedHex(77)}`, `3:::${gameUpdatedHex(GAME)}`));
    for (let i = 0; i < 50; i++) {
      p = payload(await call('warapp_recent_events', {}));
      if ((p.events as unknown[]).length === 3) break;
      await flush();
    }
    const events = p.events as Array<{ game_id: number; at: string }>;
    expect(events.map((e) => e.game_id)).toEqual([GAME, 77, GAME]);
    expect(events[0]!.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(p.listening).toEqual({ started: true, connected: true, watching: [GAME], transport: 'xhr-polling' });
    p = payload(await call('warapp_recent_events', { game_id: 77 }));
    expect((p.events as Array<{ game_id: number }>).map((e) => e.game_id)).toEqual([77]);
    p = payload(await call('warapp_recent_events', { limit: 1 }));
    expect(p.events).toHaveLength(1);
    // Once the wait ends, its game is unwatched (#131); the events stay.
    ac.abort();
    await expect(waiting).rejects.toThrow();
    for (let i = 0; i < 50; i++) {
      p = payload(await call('warapp_recent_events', {}));
      if (((p.listening as { watching: number[] }).watching).length === 0) break;
      await flush();
    }
    expect((p.listening as { watching: number[] }).watching).toEqual([]);
    expect(p.events).toHaveLength(3);
  });
});

describe('waitForTurn', () => {
  // Fake timers: the wait's timeout and progress ticks never race the test (no wall-clock sleeps).
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  /** Run due timers and pending promise callbacks until `cond` holds (no time passes). */
  async function settleUntil(cond: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (cond()) return;
      await vi.advanceTimersByTimeAsync(0);
    }
    throw new Error(`never reached: ${what}`);
  }
  function fakePush(subscribesNow = false) {
    const fns = new Set<(u: GameUpdate) => void>();
    const reconnectFns = new Set<(e: { reconnect: boolean }) => void>();
    const watched: number[][] = [];
    const released: number[][] = [];
    return {
      watched,
      released,
      emit: (gameId: number) => fns.forEach((f) => f({ gameId, at: 'now' })),
      listeners: () => fns.size,
      push: {
        watch: async (ids: readonly number[]) => {
          watched.push([...ids]);
          return subscribesNow;
        },
        release: (ids: readonly number[]) => {
          released.push([...ids]);
        },
        onUpdate: (f: (u: GameUpdate) => void) => {
          fns.add(f);
          return () => fns.delete(f);
        },
        onConnect: (f: (e: { reconnect: boolean }) => void) => {
          reconnectFns.add(f);
          return () => reconnectFns.delete(f);
        },
      },
      reconnect: () => reconnectFns.forEach((f) => f({ reconnect: true })),
      connect: (reconnect: boolean) => reconnectFns.forEach((f) => f({ reconnect })),
      reconnectListeners: () => reconnectFns.size,
      connectListeners: () => reconnectFns.size,
    };
  }
  const notReady = (id: number): GameCheck => ({ id, name: null, state: 'Playing', turn: 1, waitingOnYou: false });
  /** A check whose reads the test resolves one at a time. */
  function heldCheck() {
    const reads: Array<{ id: number; resolve: (c: GameCheck) => void }> = [];
    return {
      reads,
      check: (id: number) => new Promise<GameCheck>((resolve) => reads.push({ id, resolve })),
    };
  }

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
    await settleUntil(() => n === 2 && fp.watched.length === 1, 'initial checks');
    expect(fp.watched).toEqual([[1, 2]]);
    await vi.advanceTimersByTimeAsync(20);
    expect(messages.filter((m) => /Still waiting/.test(m))).toHaveLength(4);
    fp.emit(2);
    await settleUntil(() => n === 3, 'failed re-read');
    fp.emit(2);
    const out = await pending;
    expect(out.status).toBe('your_turn');
    expect(out.errors).toEqual(['Game 2: GameFeed down']);
    expect(out.updates).toBe(2);
    expect(out.games.map((g) => g.waitingOnYou)).toEqual([false, true]);
    expect(fp.listeners()).toBe(0);
  });

  it('re-reads every game after a push-socket reconnect (pushes in the gap are lost), then resolves', async () => {
    const fp = fakePush();
    const checks: number[] = [];
    let turnArrived = false;
    const messages: string[] = [];
    const pending = waitForTurn({
      gameIds: [1, 2],
      timeoutMs: 5000,
      push: fp.push,
      progress: (_ms, m) => messages.push(m),
      check: async (id) => {
        checks.push(id);
        return id === 2 && turnArrived ? { ...notReady(id), waitingOnYou: true } : notReady(id);
      },
    });
    await settleUntil(() => checks.length === 2 && fp.watched.length === 1, 'initial checks');
    // Game 2's turn came during the gap: no push for it ever arrives.
    turnArrived = true;
    fp.reconnect();
    const out = await pending;
    expect(out.status).toBe('your_turn');
    expect(checks.slice(2).sort()).toEqual([1, 2]);
    expect(out.updates).toBe(0);
    expect(out.reconnects).toBe(1);
    expect(messages.some((m) => /reconnected/i.test(m))).toBe(true);
    expect(fp.listeners()).toBe(0);
    expect(fp.reconnectListeners()).toBe(0);
  });

  it('does not queue a game twice when a reconnect and a push for it overlap, and keeps waiting', async () => {
    const fp = fakePush();
    const checks: number[] = [];
    const pending = waitForTurn({
      gameIds: [1],
      timeoutMs: 50,
      push: fp.push,
      check: async (id) => {
        checks.push(id);
        return notReady(id);
      },
    });
    await settleUntil(() => checks.length === 1 && fp.watched.length === 1, 'initial check');
    fp.emit(1);
    fp.reconnect();
    fp.reconnect();
    await vi.advanceTimersByTimeAsync(50);
    const out = await pending;
    expect(out.status).toBe('timed_out');
    expect(out.reconnects).toBe(2);
    // The initial read, then one re-read: the push and both reconnects collapse while queued.
    expect(checks).toEqual([1, 1]);
  });

  it('debounces re-reads per game: a burst of pushes is one read in flight and one queued (#131)', async () => {
    const fp = fakePush();
    const { reads, check } = heldCheck();
    const pending = waitForTurn({ gameIds: [1, 2], timeoutMs: 60_000, push: fp.push, check });
    await settleUntil(() => reads.length === 2, 'initial reads');
    reads.forEach((r) => r.resolve(notReady(r.id)));
    await settleUntil(() => fp.watched.length === 1, 'watch');
    for (let i = 0; i < 10; i++) fp.emit(1);
    await settleUntil(() => reads.length === 3, 'first re-read');
    // While game 1's re-read is in flight, a second burst queues one more read, and no more.
    for (let i = 0; i < 10; i++) fp.emit(1);
    fp.emit(2);
    reads[2]!.resolve(notReady(1));
    await settleUntil(() => reads.length === 4, 'queued re-read');
    reads[3]!.resolve(notReady(reads[3]!.id));
    await settleUntil(() => reads.length === 5, 'game 2 re-read');
    reads[4]!.resolve(notReady(reads[4]!.id));
    await vi.advanceTimersByTimeAsync(60_000);
    const out = await pending;
    expect(out.status).toBe('timed_out');
    expect(out.updates).toBe(21);
    expect(reads.map((r) => r.id)).toEqual([1, 2, 1, 1, 2]);
  });

  it('checks membership before watching: a game the check refuses is never watched (#131)', async () => {
    const fp = fakePush();
    const out = waitForTurn({
      gameIds: [1, 2],
      timeoutMs: 5000,
      push: fp.push,
      check: async (id) => {
        if (id === 2) throw new Error('The signed-in war.app account is not a player in game 2.');
        return notReady(id);
      },
    });
    await expect(out).rejects.toThrow(/not a player in game 2/);
    expect(fp.watched).toEqual([]);
    expect(fp.released).toEqual([]);
    expect(fp.listeners()).toBe(0);
    expect(fp.connectListeners()).toBe(0);
  });

  it('re-reads every game when watch() subscribed them on a live session after the initial check (#131)', async () => {
    // The socket was already connected: a turn that resolved between the check and the Subscribe
    // sent no push here, and no connect event follows.
    const fp = fakePush(true);
    const checks: number[] = [];
    const pending = waitForTurn({
      gameIds: [1],
      timeoutMs: 5000,
      push: fp.push,
      check: async (id) => {
        checks.push(id);
        return checks.length > 1 ? { ...notReady(id), waitingOnYou: true } : notReady(id);
      },
    });
    const out = await pending;
    expect(out.status).toBe('your_turn');
    expect(checks).toEqual([1, 1]);
  });

  it('re-reads every game when the socket first connects after the initial check (#131)', async () => {
    // The first wait of a process: watch() returns before the socket connects, the initial check
    // runs, and a turn that resolves before the first Subscribe sends no push to this process.
    const fp = fakePush();
    const checks: number[] = [];
    let turnArrived = false;
    const pending = waitForTurn({
      gameIds: [1],
      timeoutMs: 5000,
      push: fp.push,
      check: async (id) => {
        checks.push(id);
        return turnArrived ? { ...notReady(id), waitingOnYou: true } : notReady(id);
      },
    });
    await settleUntil(() => checks.length === 1 && fp.watched.length === 1, 'initial check');
    turnArrived = true;
    fp.connect(false);
    const out = await pending;
    expect(out.status).toBe('your_turn');
    expect(checks).toEqual([1, 1]);
    expect(out.reconnects).toBe(0);
    expect(fp.connectListeners()).toBe(0);
  });

  it('does not watch a game that has finished, forgets it, and releases its watch when done (#131)', async () => {
    const fp = fakePush();
    const forgotten: number[][] = [];
    const push = { ...fp.push, forget: (ids: readonly number[]) => forgotten.push([...ids]) };
    const pending = waitForTurn({
      gameIds: [1, 2],
      timeoutMs: 20,
      push,
      check: async (id) => (id === 1 ? { ...notReady(id), state: 'Finished' } : notReady(id)),
    });
    await vi.advanceTimersByTimeAsync(20);
    const out = await pending;
    expect(out.status).toBe('timed_out');
    expect(fp.watched).toEqual([[2]]);
    expect(forgotten).toEqual([[1]]);
    expect(fp.released).toEqual([[2]]);
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

describe('coalesced', () => {
  it('runs at most one read per key in flight and one queued; callers while one is queued share it (#131)', async () => {
    const started: Array<{ key: number; resolve: (v: string) => void; reject: (e: Error) => void }> = [];
    const read = coalesced(
      (key: number) => new Promise<string>((resolve, reject) => started.push({ key, resolve, reject })),
    );
    const a = read(1);
    const b = read(1);
    const c = read(1);
    const other = read(2);
    expect(started.map((s) => s.key)).toEqual([1, 2]);
    expect(b).toBe(c);
    started[0]!.resolve('first');
    expect(await a).toBe('first');
    // The queued read starts once the first settles: b and c see data read after they asked.
    await Promise.resolve();
    await Promise.resolve();
    expect(started.map((s) => s.key)).toEqual([1, 2, 1]);
    started[2]!.reject(new Error('down'));
    await expect(b).rejects.toThrow('down');
    await expect(c).rejects.toThrow('down');
    started[1]!.resolve('two');
    expect(await other).toBe('two');
    // Nothing in flight: the next call reads afresh.
    const d = read(1);
    expect(started).toHaveLength(4);
    started[3]!.resolve('again');
    expect(await d).toBe('again');
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
