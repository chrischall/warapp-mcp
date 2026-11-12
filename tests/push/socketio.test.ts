import { afterEach, describe, expect, it } from 'vitest';
import { decodeRequest, fromHex } from '../../src/protocol/codec.js';
import { Method } from '../../src/protocol/methods.js';
import { PushListener } from '../../src/push/listener.js';
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

  it('reconnects with doubling backoff after failures, and resets it once connected', async () => {
    const r = rig();
    r.socket.failHandshake(
      { status: 503, body: '', url: '' },
      { status: 200, body: 'not a handshake', url: '' },
      { status: 200, body: 'x:15:10:websocket', url: '' },
    );
    const { c, errors } = client(r, { initialBackoffMs: 100, maxBackoffMs: 300 });
    c.start();
    await c.whenConnected();
    expect(r.sleeps).toEqual([100, 200, 300]);
    expect(errors[0]).toMatch(/HTTP 503/);
    expect(errors[1]).toMatch(/handshake/);
    expect(errors[2]).toMatch(/xhr-polling/);
    expect(c.connectCount).toBe(1);
    // A disconnect packet ends the session; the next one starts with the initial delay again.
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

  it('a failed subscribe on a live session does not throw from watch; the reconnect re-subscribes', async () => {
    const r = rig();
    let failPosts = false;
    const inner = r.transport;
    r.transport = async () => {
      const t = await inner();
      return {
        fetch: (init) => (failPosts && init.method === 'POST' ? Promise.reject(new Error('bridge down')) : t.fetch(init)),
      };
    };
    const l = listener(r);
    await l.watch([1]);
    await until(() => subscribedTopics(r).length === 1, 'subscribe');
    failPosts = true;
    await expect(l.watch([2])).resolves.toBeUndefined();
    failPosts = false;
    r.socket.push('0::');
    await until(() => subscribedTopics(r).length === 2, 're-subscribe');
    expect(subscribedTopics(r)[1]).toEqual({ sid: 'sid2', topics: ['Game.1', 'Game.2'] });
  });
});
