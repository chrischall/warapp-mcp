import { afterEach, describe, expect, it } from 'vitest';
import { decodeRequest, encodeReply, fromHex, toHex } from '../../src/protocol/codec.js';
import { Method } from '../../src/protocol/methods.js';
import { MAX_SUBSCRIBE_RETRIES, PushListener } from '../../src/push/listener.js';
import { waitForTurn } from '../../src/tools/push.js';
import {
  parseHandshake,
  parsePacket,
  parsePushFrame,
  POST_CONTENT_TYPE,
  SocketIoClient,
  splitPayload,
  subscribeFrameHex,
  type SocketTransport,
} from '../../src/push/socketio.js';
import { mockWarappBridge } from '../bridge-mock.js';
import { fakeSocketIo, framed, gameUpdatedHex, subscribeReplyHex, type FakeSocketIo } from './fake-socket.js';

const EXTRAS = {
  dict: new Map<number, string>(),
  client: 'v6.07.0.1',
  serverInfoVersionA: 1,
  serverInfoVersionB: 2,
  fDb: null,
  kFa: null,
  platform: 15,
};

describe('packet helpers', () => {
  it('parses the handshake', () => {
    expect(parseHandshake('abcDEF123:15:10:websocket,xhr-polling')).toEqual({
      sid: 'abcDEF123',
      heartbeatMs: 15000,
      closeMs: 10000,
      transports: ['websocket', 'xhr-polling'],
    });
    expect(() => parseHandshake('<html>nope</html>')).toThrow(/handshake/);
    expect(() => parseHandshake('a:b')).toThrow(/handshake/);
  });

  it('splits framed and bare payloads', () => {
    expect(splitPayload('')).toEqual([]);
    expect(splitPayload('1::')).toEqual(['1::']);
    expect(splitPayload(framed('2::', '3:::AB', '8::'))).toEqual(['2::', '3:::AB', '8::']);
    // A broken frame stops the split without throwing.
    expect(splitPayload('�x�2::')).toEqual([]);
    expect(splitPayload('�3')).toEqual([]);
  });

  it('parses packet types', () => {
    expect(parsePacket('0::')).toEqual({ type: 'disconnect' });
    expect(parsePacket('1::')).toEqual({ type: 'connect' });
    expect(parsePacket('2::')).toEqual({ type: 'heartbeat' });
    expect(parsePacket('8::')).toEqual({ type: 'noop' });
    expect(parsePacket('3:::ABCD')).toEqual({ type: 'message', data: 'ABCD' });
    expect(parsePacket('3:1::A:B')).toEqual({ type: 'message', data: 'A:B' });
    expect(parsePacket('3::')).toEqual({ type: 'other', raw: '3::' });
    expect(parsePacket('5:::{}')).toEqual({ type: 'other', raw: '5:::{}' });
    expect(parsePacket('7:::1+0')).toEqual({ type: 'error', reason: '1+0' });
    expect(parsePacket('7::')).toEqual({ type: 'error', reason: '' });
  });

  it('builds a Subscribe frame with no auth block', () => {
    const hex = subscribeFrameHex(['Game.42', 'Game.43'], 7, EXTRAS);
    expect(hex).toBe(hex.toUpperCase());
    const req = decodeRequest(fromHex(hex), { hasAuth: false });
    expect(req.method).toBe(Method.Subscribe);
    expect(req.msgNum).toBe(7);
    expect(req.email).toBeNull();
    expect(req.body.bool()).toBe(true);
    expect(req.body.list((r) => r.string())).toEqual(['Game.42', 'Game.43']);
    expect(req.body.string()).toBeNull();
    expect(req.body.remaining).toBe(0);
  });

  it('decodes a GameUpdated push (61 bytes, message number 0x80000000)', () => {
    const hex = gameUpdatedHex(12345678);
    expect(hex.length / 2).toBe(61);
    expect(parsePushFrame(hex)).toEqual({ kind: 'game-updated', gameId: 12345678 });
  });

  it('decodes Subscribe replies, ignores other frames and garbage', () => {
    expect(parsePushFrame(subscribeReplyHex(3, null))).toEqual({ kind: 'subscribe-reply', msgNum: 3, rejected: new Map() });
    expect(parsePushFrame(subscribeReplyHex(4, { 'Game.9': 12 }))).toEqual({
      kind: 'subscribe-reply',
      msgNum: 4,
      rejected: new Map([['Game.9', 12]]),
    });
    expect(parsePushFrame('zz')).toBeUndefined();
    expect(parsePushFrame('F200')).toBeUndefined();
  });
});

interface Rig {
  socket: FakeSocketIo;
  transport: () => Promise<SocketTransport>;
  sleeps: number[];
}

function rig(opts: Parameters<typeof fakeSocketIo>[0] = {}): Rig {
  const socket = fakeSocketIo(opts);
  const { bridge } = mockWarappBridge(socket.handler);
  return { socket, transport: () => bridge.ready(), sleeps: [] };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${what}`);
}

let stoppers: Array<() => void> = [];
afterEach(() => {
  stoppers.forEach((s) => s());
  stoppers = [];
});

function client(r: Rig, extra: Partial<ConstructorParameters<typeof SocketIoClient>[0]> = {}) {
  const messages: string[] = [];
  const errors: string[] = [];
  const c = new SocketIoClient({
    transport: r.transport,
    onMessage: (d) => messages.push(d),
    onError: (e) => errors.push(e.message),
    sleep: async (ms) => {
      r.sleeps.push(ms);
    },
    now: () => 1700000000000,
    ...extra,
  });
  stoppers.push(() => {
    c.stop();
    r.socket.close();
  });
  return { c, messages, errors };
}

describe('SocketIoClient', () => {
  it('handshakes, waits for the connect packet, then delivers messages', async () => {
    const r = rig();
    const { c, messages } = client(r);
    c.start();
    await c.whenConnected();
    expect(c.connected).toBe(true);
    const paths = r.socket.requests.map((q) => `${q.method} ${q.path}`);
    expect(paths[0]).toBe('GET https://war.app/socket.io/1/?t=1700000000000');
    expect(paths[1]).toBe('GET https://war.app/socket.io/1/xhr-polling/sid1?t=1700000000000');
    r.socket.push(framed('3:::AA', '8::', '3:::BB'));
    await until(() => messages.length === 2, 'messages');
    expect(messages).toEqual(['AA', 'BB']);
  });

  it('answers a heartbeat with a POST of 2::', async () => {
    const r = rig();
    const { c } = client(r);
    c.start();
    await c.whenConnected();
    r.socket.push('2::');
    await until(() => r.socket.posts.length === 1, 'heartbeat reply');
    expect(r.socket.posts[0]).toEqual({ sid: 'sid1', body: '2::', contentType: POST_CONTENT_TYPE });
  });

  it('refuses to POST before the connect packet (war.app answers that with 400)', async () => {
    const r = rig();
    const { c } = client(r);
    await expect(c.sendMessage('AB')).rejects.toThrow(/not connected/);
    expect(r.socket.rejectedPosts()).toBe(0);
    expect(r.socket.requests).toHaveLength(0);
  });

  it('the fake enforces connect-before-POST', async () => {
    const r = rig();
    const t = await r.transport();
    await t.fetch({ method: 'GET', path: 'https://war.app/socket.io/1/?t=1' });
    const res = await t.fetch({ method: 'POST', path: 'https://war.app/socket.io/1/xhr-polling/sid1?t=1', body: '2::' });
    expect(res.status).toBe(400);
    expect(r.socket.rejectedPosts()).toBe(1);
  });

  it('reconnects with doubling backoff after failures, and resets it once a session has held', async () => {
    const r = rig();
    let t = 1700000000000;
    r.socket.failHandshake(
      { status: 503, body: '', url: '' },
      { status: 200, body: 'not a handshake', url: '' },
      { status: 200, body: 'x:15:10:websocket', url: '' },
    );
    const { c, errors } = client(r, { initialBackoffMs: 100, maxBackoffMs: 300, now: () => t });
    c.start();
    await c.whenConnected();
    expect(r.sleeps).toEqual([100, 200, 300]);
    expect(errors[0]).toMatch(/HTTP 503/);
    expect(errors[1]).toMatch(/handshake/);
    expect(errors[2]).toMatch(/xhr-polling/);
    expect(c.connectCount).toBe(1);
    // A disconnect packet ends a session that held past the stable mark (not merely connected,
    // #131): the next one starts with the initial delay again.
    await r.socket.idle();
    t += 60_000;
    r.socket.push('0::');
    await until(() => c.connectCount === 2, 'reconnect');
    expect(r.sleeps).toEqual([100, 200, 300, 100]);
    expect(c.lastError).toMatch(/closed/);
    expect(r.socket.handshakes()).toBe(5);
  });

  it('treats a first poll without the connect packet, or a failed poll, as a failed session', async () => {
    const r = rig();
    const { c, errors } = client(r);
    // Session 1: connected; then a poll fails with HTTP 500.
    c.start();
    await c.whenConnected();
    r.socket.push({ status: 500, body: '', url: '' });
    await until(() => errors.length === 1, 'poll failure');
    expect(errors[0]).toMatch(/HTTP 500 to a push-socket poll/);
    await until(() => c.connectCount === 2, 'reconnect');
  });
  it('paces polls that come back at once with nothing to say, instead of re-polling at once (#131)', async () => {
    const r = rig();
    const { c, messages } = client(r, { initialBackoffMs: 100, maxBackoffMs: 300 });
    c.start();
    await c.whenConnected();
    for (const a of ['8::', '', '8::', '8::']) r.socket.push(a);
    await until(() => r.sleeps.length === 4, 'paced polls');
    expect(r.sleeps).toEqual([100, 200, 300, 300]);
    // Something to say resets the pace.
    r.socket.push('3:::AA');
    r.socket.push('8::');
    await until(() => messages.length === 1 && r.sleeps.length === 5, 'reset pace');
    expect(r.sleeps[4]).toBe(100);
    expect(c.connectCount).toBe(1);
  });

  it('caps the pace of empty polls well below the reconnect backoff, so a push is never a minute late (#131)', async () => {
    const r = rig();
    const { c } = client(r, { maxBackoffMs: 60_000 });
    c.start();
    await c.whenConnected();
    for (let i = 0; i < 6; i++) r.socket.push('8::');
    await until(() => r.sleeps.length === 6, 'paced polls');
    expect(r.sleeps).toEqual([1000, 2000, 4000, 5000, 5000, 5000]);
    expect(c.connectCount).toBe(1);
  });

  it('a long poll that ends idle after a while is not paced', async () => {
    const r = rig();
    let t = 1_700_000_000_000;
    const { c } = client(r, { now: () => t, initialBackoffMs: 100 });
    c.start();
    await c.whenConnected();
    await r.socket.idle();
    t += 20_000;
    r.socket.push('8::');
    await r.socket.idle();
    expect(r.sleeps).toEqual([]);
  });

  it('an error packet ends the session, which reconnects with backoff (#131)', async () => {
    const r = rig();
    const { c, errors } = client(r, { initialBackoffMs: 100 });
    c.start();
    await c.whenConnected();
    r.socket.push('7:::1+0');
    await until(() => c.connectCount === 2, 'reconnect');
    expect(errors[0]).toMatch(/refused the push socket/);
    expect(r.sleeps).toEqual([100]);
  });

  it('keeps backing off across sessions that connect then fail at once; a session that held resets it (#131)', async () => {
    const r = rig();
    let t = 1_700_000_000_000;
    const { c } = client(r, { now: () => t, initialBackoffMs: 100, maxBackoffMs: 1000 });
    c.start();
    await c.whenConnected();
    for (let n = 2; n <= 4; n++) {
      r.socket.push('0::');
      await until(() => c.connectCount === n, `connect ${n}`);
    }
    expect(r.sleeps).toEqual([100, 200, 400]);
    // This session stays up past the stable mark before it drops: the next retry starts over.
    await r.socket.idle();
    t += 60_000;
    r.socket.push('0::');
    await until(() => c.connectCount === 5, 'connect 5');
    expect(r.sleeps).toEqual([100, 200, 400, 100]);
  });


  it('default backoff starts at one second and caps at a minute', async () => {
    const r = rig();
    r.socket.failHandshake(...Array.from({ length: 8 }, () => ({ status: 500, body: '', url: '' })));
    const { c } = client(r);
    c.start();
    await c.whenConnected();
    expect(r.sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  it('stops polling after stop()', async () => {
    const r = rig();
    const { c } = client(r);
    c.start();
    c.start(); // idempotent
    await c.whenConnected();
    c.stop();
    expect(c.connected).toBe(false);
    r.socket.close();
    await flush();
    const n = r.socket.requests.length;
    await flush();
    expect(r.socket.requests.length).toBe(n);
  });
});

describe('PushListener', () => {
  function listener(r: Rig, now = () => Date.UTC(2026, 10, 12, 12, 0, 0)) {
    const l = new PushListener({ transport: r.transport, now, sleep: async () => {}, maxEvents: 3 });
    stoppers.push(() => {
      l.stop();
      r.socket.close();
    });
    return l;
  }

  const subscribedTopics = (r: Rig) =>
    r.socket.posts
      .filter((p) => p.body.startsWith('3:::'))
      .map((p) => {
        const req = decodeRequest(fromHex(p.body.slice(4)), { hasAuth: false });
        expect(req.method).toBe(Method.Subscribe);
        req.body.bool();
        return { sid: p.sid, topics: req.body.list((x) => x.string()) };
      });

  it('starts lazily, subscribes on connect, and adds games to a live session', async () => {
    const r = rig();
    const l = listener(r);
    expect(l.status()).toEqual({ started: false, connected: false, watching: [], refused: {} });
    expect(r.socket.requests).toHaveLength(0);
    await l.watch([42, 7]);
    await until(() => subscribedTopics(r).length === 1, 'subscribe');
    expect(subscribedTopics(r)).toEqual([{ sid: 'sid1', topics: ['Game.42', 'Game.7'] }]);
    await l.watch([42, 9]);
    expect(subscribedTopics(r)[1]).toEqual({ sid: 'sid1', topics: ['Game.9'] });
    expect(l.status()).toMatchObject({ started: true, connected: true, watching: [7, 9, 42] });
  });

  it('emits GameUpdated as { gameId, at }, keeps the last N, and records refused topics', async () => {
    const r = rig();
    const l = listener(r);
    const seen: unknown[] = [];
    const off = l.onUpdate((u) => seen.push(u));
    await l.watch([1]);
    await until(() => subscribedTopics(r).length === 1, 'subscribe');
    r.socket.push(framed(`3:::${subscribeReplyHex(1, { 'Game.1': 12 })}`, `3:::${gameUpdatedHex(1)}`));
    await until(() => seen.length === 1, 'update');
    expect(seen[0]).toEqual({ gameId: 1, at: '2026-11-12T12:00:00.000Z' });
    expect(l.status().refused).toEqual({ 'Game.1': 12 });
    r.socket.push(framed(`3:::${gameUpdatedHex(2)}`, `3:::${gameUpdatedHex(3)}`, `3:::${gameUpdatedHex(4)}`, '3:::ZZ'));
    await until(() => seen.length === 4, 'more updates');
    expect(l.recent().map((e) => e.gameId)).toEqual([4, 3, 2]);
    expect(l.recent(1).map((e) => e.gameId)).toEqual([4]);
    off();
    r.socket.push(`3:::${gameUpdatedHex(5)}`);
    await until(() => l.recent(1)[0]!.gameId === 5, 'event after unsubscribe');
    expect(seen).toHaveLength(4);
  });

  it('re-subscribes every watched game after a reconnect', async () => {
    const r = rig();
    const l = listener(r);
    await l.watch([5, 6]);
    await until(() => subscribedTopics(r).length === 1, 'subscribe');
    r.socket.push('0::');
    await until(() => subscribedTopics(r).length === 2, 're-subscribe');
    expect(subscribedTopics(r)[1]).toEqual({ sid: 'sid2', topics: ['Game.5', 'Game.6'] });
  });
  it('tells connect listeners about every connect, the first one included, once subscribed (#131)', async () => {
    const r = rig();
    const l = listener(r);
    const seen: Array<{ reconnect: boolean; subscribed: number }> = [];
    l.onConnect((e) => seen.push({ ...e, subscribed: subscribedTopics(r).length }));
    await l.watch([5]);
    await until(() => seen.length === 1, 'first connect');
    r.socket.push('0::');
    await until(() => seen.length === 2, 'reconnect');
    expect(seen).toEqual([
      { reconnect: false, subscribed: 1 },
      { reconnect: true, subscribed: 2 },
    ]);
  });

  it('retries a failed Subscribe on the live session, without waiting for a reconnect (#131)', async () => {
    const r = rig();
    let failPosts = 0;
    const inner = r.transport;
    r.transport = async () => {
      const t = await inner();
      return {
        fetch: (init) =>
          failPosts > 0 && init.method === 'POST' ? (failPosts--, Promise.resolve({ status: 502, body: '', url: init.path })) : t.fetch(init),
      };
    };
    let wake: () => void = () => {};
    const l = new PushListener({ transport: r.transport, sleep: () => new Promise<void>((res) => (wake = res)) });
    stoppers.push(() => {
      l.stop();
      r.socket.close();
    });
    await l.watch([1]);
    await until(() => subscribedTopics(r).length === 1, 'subscribe');
    failPosts = 1;
    await l.watch([2]);
    expect(l.status().pending).toEqual([2]);
    expect(l.status().lastError).toMatch(/HTTP 502/);
    wake();
    await until(() => subscribedTopics(r).length === 2, 'retried subscribe');
    expect(subscribedTopics(r)[1]).toEqual({ sid: 'sid1', topics: ['Game.2'] });
    expect(r.socket.handshakes()).toBe(1);
    expect(l.status()).not.toHaveProperty('pending');
  });

  it('retries a Subscribe that war.app answered with a server error (#131)', async () => {
    const r = rig();
    const l = listener(r);
    await l.watch([3]);
    await until(() => subscribedTopics(r).length === 1, 'subscribe');
    r.socket.push(`3:::${toHex(encodeReply({ method: Method.Subscribe, msgNum: 1, error: { code: 77, message: 'nope' } }))}`);
    await until(() => subscribedTopics(r).length === 2, 'retried subscribe');
    expect(subscribedTopics(r)[1]).toEqual({ sid: 'sid1', topics: ['Game.3'] });
    expect(l.status().lastError).toMatch(/77/);
  });

  it('a Subscribe that succeeds on retry tells connect listeners, so a wait re-reads its games (#131)', async () => {
    const r = rig();
    let failPosts = 0;
    const inner = r.transport;
    r.transport = async () => {
      const t = await inner();
      return {
        fetch: (init) =>
          failPosts > 0 && init.method === 'POST' ? (failPosts--, Promise.resolve({ status: 502, body: '', url: init.path })) : t.fetch(init),
      };
    };
    let wake: () => void = () => {};
    const l = new PushListener({ transport: r.transport, sleep: () => new Promise<void>((res) => (wake = res)) });
    stoppers.push(() => {
      l.stop();
      r.socket.close();
    });
    await l.watch([1]);
    await until(() => subscribedTopics(r).length === 1, 'subscribe');
    const seen: Array<{ reconnect: boolean; resubscribed?: boolean }> = [];
    l.onConnect((e) => seen.push(e));
    // A wait on game 2 while the socket is connected: its Subscribe fails, the initial check runs.
    failPosts = 1;
    const checks: number[] = [];
    const ac = new AbortController();
    const wait = waitForTurn({
      gameIds: [2],
      timeoutMs: 60_000,
      push: l,
      signal: ac.signal,
      check: async (id) => {
        checks.push(id);
        return { id, name: null, state: 'Playing', turn: 3, waitingOnYou: checks.length > 1 };
      },
    });
    await until(() => checks.length === 1 && l.status().pending?.[0] === 2, 'initial check, subscribe pending');
    // The retry lands: a turn that resolved before it sent no push, so the wait re-reads game 2.
    wake();
    const out = await wait;
    expect(out.status).toBe('your_turn');
    expect(checks).toEqual([2, 2]);
    expect(seen).toEqual([{ reconnect: false, resubscribed: true }]);
    expect(out.reconnects).toBe(0);
  });

  it('a Subscribe refused by war.app then retried tells connect listeners once the retry is sent (#131)', async () => {
    const r = rig();
    const l = listener(r);
    const seen: Array<{ reconnect: boolean; resubscribed?: boolean }> = [];
    l.onConnect((e) => seen.push(e));
    await l.watch([3]);
    await until(() => seen.length === 1, 'first connect');
    r.socket.push(`3:::${toHex(encodeReply({ method: Method.Subscribe, msgNum: 1, error: { code: 77, message: 'nope' } }))}`);
    await until(() => seen.length === 2, 'resubscribed');
    expect(seen).toEqual([{ reconnect: false }, { reconnect: false, resubscribed: true }]);
    expect(subscribedTopics(r)).toHaveLength(2);
  });

  it('forgets a game: it is no longer watched or re-subscribed (#131)', async () => {
    const r = rig();
    const l = listener(r);
    await l.watch([5, 6]);
    await until(() => subscribedTopics(r).length === 1, 'subscribe');
    l.forget([5]);
    expect(l.status().watching).toEqual([6]);
    r.socket.push('0::');
    await until(() => subscribedTopics(r).length === 2, 're-subscribe');
    expect(subscribedTopics(r)[1]).toEqual({ sid: 'sid2', topics: ['Game.6'] });
  });

  it('idles: once every watch is released, the socket stops after the idle delay (#131)', async () => {
    const r = rig();
    const timers: Array<{ ms: number; fn: () => void; cleared: boolean }> = [];
    const l = new PushListener({
      transport: r.transport,
      sleep: async () => {},
      idleMs: 1234,
      idleTimer: (ms, fn) => {
        const t = { ms, fn, cleared: false };
        timers.push(t);
        return () => {
          t.cleared = true;
        };
      },
    });
    stoppers.push(() => {
      l.stop();
      r.socket.close();
    });
    await l.watch([1]);
    await l.watch([1, 2]);
    await until(() => l.status().connected, 'connect');
    l.release([1, 2]);
    expect(timers).toHaveLength(0); // game 1 is still held by the first watch
    l.release([1]);
    expect(timers.map((t) => t.ms)).toEqual([1234]);
    // A new watch before the delay keeps the socket.
    await l.watch([2]);
    expect(timers[0]!.cleared).toBe(true);
    l.release([2]);
    timers[1]!.fn();
    expect(l.status()).toMatchObject({ started: false, connected: false, watching: [] });
  });


  /** A listener whose idle timer the test fires by hand. */
  function idleListener(r: Rig) {
    const timers: Array<() => void> = [];
    const l = new PushListener({
      transport: r.transport,
      sleep: async () => {},
      idleMs: 1000,
      idleTimer: (_ms, fn) => {
        timers.push(fn);
        return () => {};
      },
    });
    stoppers.push(() => {
      l.stop();
      r.socket.close();
    });
    return { l, fireIdle: () => timers.at(-1)!() };
  }

  it('an idle stop then a quick re-watch, with a poll in flight, runs one session loop, not two (#131)', async () => {
    const r = rig();
    const { l, fireIdle } = idleListener(r);
    await l.watch([1]);
    await until(() => l.status().connected, 'connect');
    await r.socket.idle(); // a long poll is in flight on sid1
    l.release([1]);
    fireIdle();
    expect(l.status().started).toBe(false);
    await l.watch([1]);
    await until(() => l.status().connected && r.socket.handshakes() === 2, 'restart');
    for (let i = 0; i < 10; i++) {
      await r.socket.idle();
      r.socket.push('8::');
      await flush();
    }
    await flush();
    expect(r.socket.handshakes()).toBe(2);
  });

  it('after an idle stop and restart, the first connect is not a reconnect (#131)', async () => {
    const r = rig();
    const { l, fireIdle } = idleListener(r);
    const seen: boolean[] = [];
    let reconnects = 0;
    l.onConnect((e) => seen.push(e.reconnect));
    l.onReconnect(() => reconnects++);
    await l.watch([1]);
    await until(() => seen.length === 1, 'first connect');
    l.release([1]);
    fireIdle();
    await l.watch([1]);
    await until(() => seen.length === 2, 'connect after restart');
    expect(seen).toEqual([false, false]);
    expect(reconnects).toBe(0);
    r.socket.push('8::'); // the stopped run's abandoned poll (the oldest waiting) ends quietly
    r.socket.push('0::');
    await until(() => seen.length === 3, 'reconnect');
    expect(seen[2]).toBe(true);
    expect(reconnects).toBe(1);
  });


  it('an idle stop forgets refused topics and the last Subscribe error (#131)', async () => {
    const r = rig();
    const { l, fireIdle } = idleListener(r);
    await l.watch([1]);
    await until(() => subscribedTopics(r).length === 1, 'subscribe');
    r.socket.push(`3:::${subscribeReplyHex(1, { 'Game.1': 12 })}`);
    await until(() => Object.keys(l.status().refused).length === 1, 'refused');
    r.socket.push(`3:::${toHex(encodeReply({ method: Method.Subscribe, msgNum: 99, error: { code: 77, message: 'nope' } }))}`);
    await until(() => /77/.test(l.status().lastError ?? ''), 'subscribe error');
    l.release([1]);
    fireIdle();
    expect(l.status()).toEqual({ started: false, connected: false, watching: [], refused: {}, transport: 'xhr-polling' });
  });

  it('a failed subscribe on a live session does not throw from watch; once its retries run out the reconnect re-subscribes', async () => {
    const r = rig();
    let failPosts = false;
    let refusedPosts = 0;
    const inner = r.transport;
    r.transport = async () => {
      const t = await inner();
      return {
        fetch: (init) =>
          failPosts && init.method === 'POST' ? (refusedPosts++, Promise.reject(new Error('bridge down'))) : t.fetch(init),
      };
    };
    const l = listener(r);
    await l.watch([1]);
    await until(() => subscribedTopics(r).length === 1, 'subscribe');
    failPosts = true;
    await expect(l.watch([2])).resolves.toBeUndefined();
    // The first try, then the retries on the live session (#131), all refused.
    await until(() => refusedPosts === 1 + MAX_SUBSCRIBE_RETRIES, 'retries');
    await flush();
    expect(refusedPosts).toBe(1 + MAX_SUBSCRIBE_RETRIES);
    failPosts = false;
    r.socket.push('0::');
    await until(() => subscribedTopics(r).length === 2, 're-subscribe');
    expect(subscribedTopics(r)[1]).toEqual({ sid: 'sid2', topics: ['Game.1', 'Game.2'] });
  });
});
