// runWebSocketSession driven directly (#133: src/push/websocket.ts branch coverage): the edges the
// SocketIoClient-level tests in websocket.test.ts do not reach. Everything is synthetic.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/direct/session.js';
import {
  defaultWebSocketFactory,
  runWebSocketSession,
  WebSocketUnavailableError,
  type WebSocketLeg,
  type WebSocketSessionHooks,
} from '../../src/push/websocket.js';
import { FAKE_TOKEN, type FakeWebSocket, fakeWsServer, manualTimers } from './fake-websocket.js';

const SESSION: Session = { authToken: FAKE_TOKEN, capturedAt: '2026-11-12T00:00:00.000Z', host: 'war.app' };
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(opts: { heartbeat?: number; running?: boolean; onConnected?: WebSocketSessionHooks['onConnected'] } = {}) {
  const server = fakeWsServer({ autoConnect: false, ...(opts.heartbeat !== undefined ? { heartbeat: opts.heartbeat } : {}) });
  const leg: WebSocketLeg = { select: () => true, session: async () => SESSION, fetch: server.fetch, open: server.open };
  const timers = manualTimers();
  const messages: string[] = [];
  let closer: (() => void) | undefined;
  let sender: ((packet: string) => Promise<void>) | undefined;
  let connects = 0;
  const hooks: WebSocketSessionHooks = {
    running: () => opts.running ?? true,
    now: () => 0,
    setTimer: timers.setTimer,
    onConnected:
      opts.onConnected ??
      (async (send) => {
        connects++;
        sender = send;
      }),
    onMessage: (d) => messages.push(d),
    setCloser: (c) => {
      closer = c;
    },
  };
  const run = runWebSocketSession(leg, hooks);
  run.catch(() => {});
  const socket = async (): Promise<FakeWebSocket> => {
    for (let i = 0; i < 50 && !server.sockets[0]; i++) await flush();
    return server.sockets[0]!;
  };
  return { server, leg, timers, messages, run, socket, stop: () => closer?.(), sender: () => sender, connects: () => connects };
}

describe('runWebSocketSession edges', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a non-200 handshake falls back, naming the status', async () => {
    const s = setup();
    s.server.failHandshake({ status: 503, body: '', url: 'https://war.app/socket.io/1/' });
    await expect(s.run).rejects.toThrow(WebSocketUnavailableError);
    await expect(s.run).rejects.toThrow(/HTTP 503/);
  });

  it('an upgrade that throws falls back, even when what is thrown is not an Error', async () => {
    const leg: WebSocketLeg = {
      select: () => true,
      session: async () => SESSION,
      fetch: fakeWsServer().fetch,
      open: () => {
        throw 'no sockets here';
      },
    };
    const hooks = { running: () => true, now: () => 0, setTimer: manualTimers().setTimer, onConnected: async () => {}, onMessage: () => {}, setCloser: () => {} };
    const run = runWebSocketSession(leg, hooks);
    await expect(run).rejects.toThrow(WebSocketUnavailableError);
    await expect(run).rejects.toThrow(/upgrade failed: no sockets here/);
  });

  it('a first packet that is not the connect packet falls back', async () => {
    const s = setup();
    (await s.socket()).receive('2::');
    await expect(s.run).rejects.toThrow(WebSocketUnavailableError);
    await expect(s.run).rejects.toThrow(/no connect packet/);
  });

  it('decodes binary frames (ArrayBuffer and a typed array) and stringifies anything else', async () => {
    const s = setup();
    const ws = await s.socket();
    ws.receive('1::');
    ws.onmessage?.({ data: new TextEncoder().encode('3:::aa').buffer });
    ws.onmessage?.({ data: new TextEncoder().encode('3:::bb') });
    ws.onmessage?.({ data: 3 }); // "3": a message packet with no data separator -> ignored
    await flush();
    expect(s.messages).toEqual(['aa', 'bb']);
    s.stop();
    await expect(s.run).resolves.toBeUndefined();
  });

  it('a second connect packet does not connect twice; a noop packet is ignored', async () => {
    const s = setup();
    const ws = await s.socket();
    ws.receive('1::');
    ws.receive('1::');
    ws.receive('8::');
    await flush();
    expect(s.connects()).toBe(1);
    s.stop();
    await s.run;
  });

  it('an error packet with no reason says so, and rejects as a disconnect once connected', async () => {
    const s = setup();
    const ws = await s.socket();
    ws.receive('1::');
    ws.receive('7:::');
    await expect(s.run).rejects.toThrow(/refused the push socket \(no reason\)/);
    await expect(s.run).rejects.not.toBeInstanceOf(WebSocketUnavailableError);
  });

  it('a heartbeat of 0 arms no timer', async () => {
    const s = setup({ heartbeat: 0 });
    const ws = await s.socket();
    ws.receive('1::');
    await flush();
    expect(s.timers.timers).toEqual([]);
    s.stop();
    await s.run;
  });

  it('send after the session ended refuses; messages after the end are dropped', async () => {
    const s = setup();
    const ws = await s.socket();
    ws.receive('1::');
    await flush();
    const send = s.sender()!;
    const late = ws.onmessage!; // a handler captured before the end (an event already queued)
    s.stop();
    await s.run;
    await expect(send('2::')).rejects.toThrow(/not connected/);
    late({ data: '3:::cc' });
    await flush();
    expect(s.messages).toEqual([]);
  });

  it('a hook that throws a non-Error ends the session with a scrubbed message', async () => {
    const s = setup({
      onConnected: async () => {
        throw `boom ${FAKE_TOKEN}`;
      },
    });
    (await s.socket()).receive('1::');
    const err = await s.run.then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/push WebSocket failed: boom/);
    expect(err?.message).not.toContain(FAKE_TOKEN);
  });

  it("socket errors: the error's message, a nested error.message, or none", async () => {
    for (const [ev, want] of [
      [{ message: 'reset' }, /failed: reset\.$/],
      [{ error: { message: 'tls' } }, /failed: tls\.$/],
      [null, /WebSocket failed\.$/],
      [{ message: '' }, /WebSocket failed\.$/],
    ] as const) {
      const s = setup();
      (await s.socket()).onerror?.(ev);
      await expect(s.run).rejects.toThrow(want);
    }
  });

  it('a session that is no longer running ends at once', async () => {
    const s = setup({ running: false });
    await expect(s.run).resolves.toBeUndefined();
    expect((await s.socket()).closed).toBe(true);
  });

  it('the default factory refuses on a Node with no built-in WebSocket', () => {
    vi.stubGlobal('WebSocket', undefined);
    expect(() => defaultWebSocketFactory('wss://war.app/socket.io/1/websocket/x', { headers: {} })).toThrow(/no built-in WebSocket/);
  });

  it('the default factory asks for ArrayBuffer binary frames', () => {
    const made: Array<{ url: string; opts: unknown }> = [];
    class Fake {
      binaryType = 'blob';
      constructor(url: string, opts: unknown) {
        made.push({ url, opts });
      }
    }
    vi.stubGlobal('WebSocket', Fake);
    const ws = defaultWebSocketFactory('wss://war.app/socket.io/1/websocket/x', { headers: { Cookie: 'AuthToken=t' } }) as unknown as Fake;
    expect(ws.binaryType).toBe('arraybuffer');
    expect(made).toEqual([{ url: 'wss://war.app/socket.io/1/websocket/x', opts: { headers: { Cookie: 'AuthToken=t' } } }]);
  });
});
