// A fake war.app socket.io v0.9 WebSocket endpoint for the direct push leg:
// a fake HTTPS handshake (the DirectFetch seam) plus a fake WebSocket factory.
// Everything is synthetic: made-up session ids and a made-up AuthToken.
import type { DirectFetch, DirectFetchResult } from '../../src/direct/transport.js';
import type { WebSocketFactory, WebSocketLike } from '../../src/push/websocket.js';

/** A made-up AuthToken — never a real one. */
export const FAKE_TOKEN = 'fake-auth-token-0123456789abcdef';

export class FakeWebSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}

  send(data: string): void {
    if (this.closed) throw new Error('fake socket is closed');
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  // Server side.
  open(): void {
    this.onopen?.({});
  }
  receive(packet: string): void {
    this.onmessage?.({ data: packet });
  }
  serverClose(): void {
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }
  fail(message: string): void {
    this.onerror?.({ message });
  }
}

export interface FakeWsServer {
  /** The fake HTTPS primitive serving the handshake. */
  fetch: DirectFetch;
  /** The fake WebSocket factory. */
  open: WebSocketFactory;
  /** Every handshake request, in order. */
  handshakes: Array<{ url: string; headers: Record<string, string> }>;
  /** Every socket opened, in order. */
  sockets: FakeWebSocket[];
  /** Answer the next handshake(s) with these replies instead of a session. */
  failHandshake: (...answers: Array<DirectFetchResult | Error>) => void;
}

/**
 * A fake server. Handshakes answer `wsN:<heartbeat>:<close>:<transports>`;
 * with `autoConnect` (default true) each socket opens and sends `1::` on the
 * next microtask.
 */
export function fakeWsServer(opts: { heartbeat?: number; transports?: string; autoConnect?: boolean } = {}): FakeWsServer {
  const handshakes: FakeWsServer['handshakes'] = [];
  const sockets: FakeWebSocket[] = [];
  const failures: Array<DirectFetchResult | Error> = [];
  let n = 0;
  return {
    handshakes,
    sockets,
    failHandshake: (...answers) => {
      failures.push(...answers);
    },
    fetch: async (url, init) => {
      handshakes.push({ url, headers: init.headers });
      const fail = failures.shift();
      if (fail instanceof Error) throw fail;
      if (fail) return fail;
      n++;
      return {
        status: 200,
        body: `ws${n}:${opts.heartbeat ?? 15}:10:${opts.transports ?? 'websocket,xhr-polling'}`,
        url,
      };
    },
    open: (url, init) => {
      const s = new FakeWebSocket(url, init.headers);
      sockets.push(s);
      if (opts.autoConnect !== false) {
        queueMicrotask(() => {
          s.open();
          s.receive('1::');
        });
      }
      return s;
    },
  };
}

/** A manual timer: `setTimer` records each armed timer; `fire` runs the live ones. */
export function manualTimers() {
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  return {
    timers,
    setTimer: (ms: number, fn: () => void) => {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    /** Fire every armed, uncancelled timer. */
    fire: () => {
      for (const t of timers.filter((x) => !x.cancelled)) {
        t.cancelled = true;
        t.fn();
      }
    },
    live: () => timers.filter((x) => !x.cancelled),
  };
}
