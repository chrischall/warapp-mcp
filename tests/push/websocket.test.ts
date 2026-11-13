import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../src/direct/session.js';
import { PushListener } from '../../src/push/listener.js';
import { SocketIoClient, subscribeFrameHex } from '../../src/push/socketio.js';
import { pushWebSocketLeg, websocketUrl, type WebSocketLeg } from '../../src/push/websocket.js';
import { mockWarappBridge } from '../bridge-mock.js';
import { fakeSocketIo, gameUpdatedHex, subscribeReplyHex, type FakeSocketIo } from './fake-socket.js';
import { FAKE_TOKEN, fakeWsServer, manualTimers, type FakeWsServer } from './fake-websocket.js';

const NOW = 1700000000000;
const SESSION: Session = { authToken: FAKE_TOKEN, capturedAt: '2026-11-12T00:00:00.000Z', host: 'war.app' };

const EXTRAS = {
  dict: new Map<number, string>(),
  client: 'v6.07.0.1',
  serverInfoVersionA: 1,
  serverInfoVersionB: 2,
  fDb: null,
  kFa: null,
  platform: 15,
};

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

interface Rig {
  ws: FakeWsServer;
  xhr: FakeSocketIo;
  leg: WebSocketLeg;
  timers: ReturnType<typeof manualTimers>;
  sleeps: number[];
  selectCalls: () => number;
}

function rig(
  opts: { ws?: Parameters<typeof fakeWsServer>[0]; select?: boolean; session?: Session | null } = {},
): Rig {
  const ws = fakeWsServer(opts.ws);
  const xhr = fakeSocketIo();
  let selects = 0;
  const leg: WebSocketLeg = {
    select: () => {
      selects++;
      return opts.select ?? true;
    },
    session: async () => (opts.session === undefined ? SESSION : opts.session),
    fetch: ws.fetch,
    open: ws.open,
  };
  return { ws, xhr, leg, timers: manualTimers(), sleeps: [], selectCalls: () => selects };
}

function client(r: Rig, extra: Partial<ConstructorParameters<typeof SocketIoClient>[0]> = {}) {
  const messages: string[] = [];
  const errors: string[] = [];
  let reconnects = 0;
  const { bridge } = mockWarappBridge(r.xhr.handler);
  const c = new SocketIoClient({
    transport: () => bridge.ready(),
    webSocket: r.leg,
    setTimer: r.timers.setTimer,
    onMessage: (d) => messages.push(d),
    onError: (e) => errors.push(e.message),
    onReconnect: () => {
      reconnects++;
    },
    sleep: async (ms) => {
      r.sleeps.push(ms);
    },
    now: () => NOW,
    initialBackoffMs: 100,
    ...extra,
  });
  stoppers.push(() => {
    c.stop();
    r.xhr.close();
  });
  return { c, messages, errors, reconnects: () => reconnects };
}

describe('push WebSocket transport', () => {
  it('handshakes over HTTPS with the cookie, then opens the wss URL with the Cookie header', async () => {
    const r = rig();
    const { c } = client(r);
    c.start();
    await c.whenConnected();
    expect(r.ws.handshakes).toHaveLength(1);
    expect(r.ws.handshakes[0]!.url).toBe(`https://war.app/socket.io/1/?t=${NOW}`);
    expect(r.ws.handshakes[0]!.headers.cookie).toBe(`AuthToken=${FAKE_TOKEN}`);
    expect(r.ws.sockets).toHaveLength(1);
    expect(r.ws.sockets[0]!.url).toBe('wss://war.app/socket.io/1/websocket/ws1');
    expect(r.ws.sockets[0]!.headers).toEqual({ Cookie: `AuthToken=${FAKE_TOKEN}` });
    expect(c.transport).toBe('websocket');
    // The xhr-polling leg is never touched.
    expect(r.xhr.requests).toHaveLength(0);
  });

  it('only builds a war.app wss URL', () => {
    expect(websocketUrl('abc_DEF-1')).toBe('wss://war.app/socket.io/1/websocket/abc_DEF-1');
    expect(() => websocketUrl('../evil')).toThrow();
    expect(() => websocketUrl('a/b')).toThrow();
  });

  it('answers 2:: with 2:: and delivers message packets', async () => {
    const r = rig();
    const { c, messages } = client(r);
    c.start();
    await c.whenConnected();
    const s = r.ws.sockets[0]!;
    s.receive('2::');
    await until(() => s.sent.includes('2::'), 'heartbeat reply');
    s.receive('3:::ABCD');
    await until(() => messages.length === 1, 'message');
    expect(messages).toEqual(['ABCD']);
    await c.sendMessage('EF01');
    expect(s.sent).toEqual(['2::', '3:::EF01']);
  });

  it('a server close reconnects with a new handshake and sid, and signals the reconnect', async () => {
    const r = rig();
    const { c, errors, reconnects } = client(r);
    c.start();
    await c.whenConnected();
    expect(reconnects()).toBe(0);
    r.ws.sockets[0]!.serverClose();
    await until(() => c.connectCount === 2, 'reconnect');
    await until(() => reconnects() === 1, 'reconnected signal');
    expect(r.ws.handshakes).toHaveLength(2);
    expect(r.ws.sockets[1]!.url).toBe('wss://war.app/socket.io/1/websocket/ws2');
    expect(errors[0]).toMatch(/closed/);
    expect(r.sleeps).toEqual([100]);
    expect(c.transport).toBe('websocket');
  });

  it('a 0:: disconnect packet or a socket error after connecting is a disconnect too', async () => {
    const r = rig();
    const { c } = client(r);
    c.start();
    await c.whenConnected();
    r.ws.sockets[0]!.receive('0::');
    await until(() => c.connectCount === 2, 'reconnect after 0::');
    r.ws.sockets[1]!.fail('boom');
    await until(() => c.connectCount === 3, 'reconnect after error');
    expect(r.ws.sockets[0]!.closed).toBe(true);
    expect(r.ws.sockets[1]!.closed).toBe(true);
  });
  it('a 7::: error packet ends the WebSocket session (#131)', async () => {
    const r = rig();
    const { c, errors } = client(r);
    c.start();
    await c.whenConnected();
    r.ws.sockets[0]!.receive('7:::1+0');
    await until(() => c.connectCount === 2, 'reconnect after 7:::');
    expect(errors[0]).toMatch(/refused the push socket \(1\+0\)/);
  });


  it('missed heartbeats (the handshake heartbeat timeout) reconnect', async () => {
    const r = rig({ ws: { heartbeat: 25 } });
    const { c, errors, reconnects } = client(r);
    c.start();
    await c.whenConnected();
    expect(r.timers.live().map((t) => t.ms)).toEqual([25000]);
    // Any packet re-arms the timer.
    r.ws.sockets[0]!.receive('8::');
    expect(r.timers.live()).toHaveLength(1);
    r.timers.fire();
    await until(() => c.connectCount === 2, 'reconnect after heartbeat timeout');
    expect(errors[0]).toMatch(/heartbeat/);
    expect(r.ws.sockets[0]!.closed).toBe(true);
    await until(() => reconnects() === 1, 'reconnected signal');
  });

  it('falls back to xhr-polling when the handshake does not offer websocket', async () => {
    const r = rig({ ws: { transports: 'xhr-polling,jsonp-polling' } });
    const { c } = client(r);
    c.start();
    await c.whenConnected();
    expect(r.ws.sockets).toHaveLength(0);
    expect(c.transport).toBe('xhr-polling');
    expect(r.xhr.handshakes()).toBe(1);
    expect(c.lastError).toMatch(/websocket/i);
  });

  it('falls back to xhr-polling on a signed-out handshake reply', async () => {
    const r = rig();
    r.ws.failHandshake({ status: 200, body: '<form><input type="password" name="password"></form>', url: 'https://war.app/LogIn' });
    const { c } = client(r);
    c.start();
    await c.whenConnected();
    expect(r.ws.sockets).toHaveLength(0);
    expect(c.transport).toBe('xhr-polling');
    expect(c.lastError).toMatch(/signed in/);
  });

  it('falls back to xhr-polling without a linked session (never opening a socket)', async () => {
    const r = rig({ session: null });
    const { c } = client(r);
    c.start();
    await c.whenConnected();
    expect(r.ws.handshakes).toHaveLength(0);
    expect(r.ws.sockets).toHaveLength(0);
    expect(c.transport).toBe('xhr-polling');
  });

  it('falls back to xhr-polling when the upgrade fails (closed before the connect packet)', async () => {
    const r = rig({ ws: { autoConnect: false } });
    const { c } = client(r);
    c.start();
    await until(() => r.ws.sockets.length === 1, 'socket opened');
    r.ws.sockets[0]!.serverClose();
    await c.whenConnected();
    expect(c.transport).toBe('xhr-polling');
    expect(r.xhr.handshakes()).toBe(1);
  });

  it('a WebSocket that never sends 1:: times out and falls back', async () => {
    const r = rig({ ws: { autoConnect: false } });
    const { c } = client(r);
    c.start();
    await until(() => r.ws.sockets.length === 1, 'socket opened');
    r.ws.sockets[0]!.open();
    r.timers.fire();
    await c.whenConnected();
    expect(c.transport).toBe('xhr-polling');
  });

  it('retries the WebSocket after the xhr-polling fallback session ends', async () => {
    const r = rig();
    r.ws.failHandshake({ status: 200, body: 'ws9:15:10:xhr-polling', url: 'https://war.app/socket.io/1/' });
    const { c } = client(r);
    c.start();
    await c.whenConnected();
    expect(c.transport).toBe('xhr-polling');
    r.xhr.push('0::');
    await until(() => c.connectCount === 2, 'reconnect');
    expect(c.transport).toBe('websocket');
  });

  it('never leaks the AuthToken into an error', async () => {
    const r = rig();
    r.ws.failHandshake(new Error(`connect failed for cookie AuthToken=${FAKE_TOKEN}`));
    const { c, errors } = client(r);
    c.start();
    await c.whenConnected();
    expect(c.transport).toBe('xhr-polling');
    expect(c.lastError).toBeDefined();
    expect(c.lastError).not.toContain(FAKE_TOKEN);
    // Second session: the WebSocket connects, then errors with the token in its event.
    r.xhr.push('0::');
    await until(() => c.connectCount === 2 && c.transport === 'websocket', 'websocket session');
    r.ws.sockets[0]!.fail(`socket error AuthToken=${FAKE_TOKEN}`);
    await until(() => c.connectCount === 3, 'reconnect');
    expect(errors.length).toBeGreaterThan(0);
    for (const e of [...errors, c.lastError ?? '']) expect(e).not.toContain(FAKE_TOKEN);
    expect(errors.join('\n')).toMatch(/\[warapp-session\]/);
  });

  it('bridge mode never touches the WebSocket', async () => {
    const r = rig({ select: false });
    const { c } = client(r);
    c.start();
    await c.whenConnected();
    expect(r.selectCalls()).toBe(1);
    expect(r.ws.handshakes).toHaveLength(0);
    expect(r.ws.sockets).toHaveLength(0);
    expect(c.transport).toBe('xhr-polling');
  });

  it('stop() closes the WebSocket', async () => {
    const r = rig();
    const { c } = client(r);
    c.start();
    await c.whenConnected();
    c.stop();
    expect(c.connected).toBe(false);
    expect(r.ws.sockets[0]!.closed).toBe(true);
    await flush();
    expect(r.ws.handshakes).toHaveLength(1);
  });
});

describe('pushWebSocketLeg selection', () => {
  const read = async () => SESSION;
  it('selects the WebSocket only while the active transport is direct', () => {
    const on = (transport: 'direct' | 'fetchproxy', mode: 'auto' | 'direct' | 'fetchproxy') =>
      pushWebSocketLeg({ status: () => ({ transport, mode }) }, read).select();
    expect(on('direct', 'direct')).toBe(true);
    expect(on('direct', 'auto')).toBe(true);
    expect(on('fetchproxy', 'auto')).toBe(false);
    expect(on('fetchproxy', 'fetchproxy')).toBe(false);
  });
});

describe('PushListener over the WebSocket', () => {
  function listener(r: Rig) {
    let reconnects = 0;
    const { bridge } = mockWarappBridge(r.xhr.handler);
    const l = new PushListener({
      transport: () => bridge.ready(),
      webSocket: r.leg,
      setTimer: r.timers.setTimer,
      extras: () => EXTRAS,
      now: () => Date.UTC(2026, 10, 12, 12, 0, 0),
      sleep: async () => {},
    });
    l.onReconnect(() => {
      reconnects++;
    });
    stoppers.push(() => {
      l.stop();
      r.xhr.close();
    });
    return { l, reconnects: () => reconnects };
  }

  it('sends the exact Subscribe frame after 1::, delivers a 241 push, and re-subscribes after a reconnect', async () => {
    const r = rig();
    const { l, reconnects } = listener(r);
    const seen: number[] = [];
    l.onUpdate((u) => seen.push(u.gameId));
    await l.watch([42]);
    await until(() => (r.ws.sockets[0]?.sent.length ?? 0) === 1, 'subscribe');
    expect(r.ws.sockets[0]!.sent[0]).toBe(`3:::${subscribeFrameHex(['Game.42'], 1, EXTRAS)}`);
    r.ws.sockets[0]!.receive(`3:::${subscribeReplyHex(1, null)}`);
    r.ws.sockets[0]!.receive(`3:::${gameUpdatedHex(42)}`);
    await until(() => seen.length === 1, 'push');
    expect(seen).toEqual([42]);
    expect(l.status()).toMatchObject({ connected: true, transport: 'websocket' });

    r.ws.sockets[0]!.serverClose();
    await until(() => (r.ws.sockets[1]?.sent.length ?? 0) === 1, 're-subscribe');
    expect(r.ws.sockets[1]!.url).toBe('wss://war.app/socket.io/1/websocket/ws2');
    expect(r.ws.sockets[1]!.sent[0]).toBe(`3:::${subscribeFrameHex(['Game.42'], 2, EXTRAS)}`);
    await until(() => reconnects() === 1, 'reconnected signal');
  });
});
