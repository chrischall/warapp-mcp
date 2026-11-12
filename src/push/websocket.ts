// war.app's push channel over a direct WebSocket (GitHub issue #32, verified
// live 2026-11-12) — the chrome-less alternative to xhr-polling over the
// browser bridge, used while the active transport is the direct leg.
//
//   handshake  GET https://war.app/socket.io/1/?t=<ms>   (Cookie: AuthToken=…)
//              →   sid:heartbeat:close:transports         (transports include websocket)
//   socket     wss://war.app/socket.io/1/websocket/<sid>  (same Cookie header)
//
// The server opens with `1::`; a `3:::<hex Subscribe frame>` is acknowledged
// with a 238 reply; `2::` heartbeats are answered with `2::`; pushes arrive as
// `3:::<hex>` (241 GameUpdated). The server may close a healthy socket after
// ~60 s — the caller reconnects (new handshake, new sid, re-subscribe), and
// pushes sent during the gap are lost.
//
// SECURITY: the AuthToken is a full-account credential. The handshake runs
// through the direct leg's DirectBridge (host-locked to war.app by
// `warappUrl`, errors scrubbed by value); the socket URL is built only for
// war.app ({@link websocketUrl}); every error leaving this module is scrubbed.
import type { DirectFirstStatus } from '@chrischall/mcp-utils/fetchproxy';
import type { Session } from '../direct/session.js';
import { scrubToken } from '../direct/session.js';
import { DirectBridge, type DirectFetch } from '../direct/transport.js';
import { parseHandshake, parsePacket, SOCKET_URL } from './packets.js';

/** The slice of a WebSocket the push client uses (Node's global `WebSocket` satisfies it). */
export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

/** Opens a WebSocket with request headers (the Cookie). Tests pass a fake. */
export type WebSocketFactory = (url: string, init: { headers: Record<string, string> }) => WebSocketLike;

/** Arms a one-shot timer; returns its cancel. */
export type SetTimer = (ms: number, fn: () => void) => () => void;

/** The default factory: Node's built-in WebSocket, which accepts a `headers` option. */
export const defaultWebSocketFactory: WebSocketFactory = (url, init) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string, opts: unknown) => WebSocketLike }).WebSocket;
  if (!Ctor) throw new Error('This Node.js has no built-in WebSocket.');
  // The host is the fixed literal wss://war.app (see websocketUrl), so the
  // socket needs no netguard address pinning. Binary frames arrive as
  // ArrayBuffer (Node defaults to Blob, which dataText cannot read).
  const ws = new Ctor(url, init) as WebSocketLike & { binaryType?: string };
  ws.binaryType = 'arraybuffer';
  return ws;
};

export const realSetTimer: SetTimer = (ms, fn) => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearTimeout(t);
};

/** How the push client reaches the direct WebSocket, and when it may. */
export interface WebSocketLeg {
  /** Whether this connection attempt should use the WebSocket (the direct leg is active). */
  select(): boolean | Promise<boolean>;
  /** The linked session; `null` (none linked) falls back to xhr-polling. */
  session(): Promise<Session | null>;
  /** The handshake's HTTPS primitive (default: the direct leg's netguard `fetchPublic`). */
  fetch?: DirectFetch;
  /** The WebSocket factory (default: Node's global `WebSocket`). */
  open?: WebSocketFactory;
}

/**
 * The WebSocket could not be brought up (no session, signed out, the handshake
 * failed or did not offer `websocket`, the upgrade failed, or no connect
 * packet arrived): the caller falls back to xhr-polling over the bridge.
 */
export class WebSocketUnavailableError extends Error {
  override name = 'WebSocketUnavailableError';
}

const WS_HOST = 'war.app';

/** The war.app socket URL for a session id; refuses any sid that could change the path. */
export function websocketUrl(sid: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sid)) throw new Error('war.app returned an unusable push-socket session id.');
  return `wss://${WS_HOST}/socket.io/1/websocket/${sid}`;
}

/**
 * The leg for the process's direct-first bridge: the WebSocket is selected
 * only while the active transport is `direct` (pinned `direct`, or `auto`
 * still on the direct leg); otherwise the push stays on xhr-polling.
 */
export function pushWebSocketLeg(
  bridge: { status(): Pick<DirectFirstStatus, 'transport'> },
  readSession: () => Promise<Session | null>,
  seams: Pick<WebSocketLeg, 'fetch' | 'open'> = {},
): WebSocketLeg {
  return {
    select: () => bridge.status().transport === 'direct',
    session: readSession,
    ...seams,
  };
}

export interface WebSocketSessionHooks {
  running(): boolean;
  now(): number;
  setTimer: SetTimer;
  /** The connect packet arrived: `send` writes a packet on this socket. */
  onConnected(send: (packet: string) => Promise<void>): Promise<void>;
  onMessage(data: string): void;
  /** Register (or clear) the closer `stop()` calls to end the session. */
  setCloser(close: (() => void) | undefined): void;
}

const errMessage = (ev: unknown): string => {
  const m = (ev as { message?: unknown; error?: { message?: unknown } } | null)?.message ??
    (ev as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof m === 'string' && m ? `: ${m}` : '';
};

const dataText = (data: unknown): string =>
  typeof data === 'string'
    ? data
    : data instanceof ArrayBuffer || ArrayBuffer.isView(data)
      ? new TextDecoder().decode(data as ArrayBuffer)
      : String(data);

/**
 * One WebSocket session: handshake, open, wait for `1::`, then serve packets
 * until the socket closes, errors, misses its heartbeat or `stop()` ends it.
 * Rejects with {@link WebSocketUnavailableError} for any failure before the
 * connect packet (the caller falls back), a plain Error after it (the caller
 * reconnects). Resolves only when stopped. Every message is token-scrubbed.
 */
export async function runWebSocketSession(leg: WebSocketLeg, hooks: WebSocketSessionHooks): Promise<void> {
  const sess = await leg.session();
  if (!sess) throw new WebSocketUnavailableError('No war.app session is linked for the push WebSocket.');
  const token = sess.authToken;
  const scrub = (s: string) => scrubToken(s, token);

  let sid: string;
  let heartbeatMs: number;
  try {
    // DirectBridge: host-locked to war.app, cookie attached, errors scrubbed, sign-outs detected.
    const direct = new DirectBridge({ read: async () => sess }, leg.fetch);
    const res = await direct.fetch({ method: 'GET', path: `${SOCKET_URL}?t=${hooks.now()}` });
    if (res.status !== 200) throw new Error(`war.app answered HTTP ${res.status} to the socket handshake.`);
    const hs = parseHandshake(res.body);
    if (!hs.transports.includes('websocket')) throw new Error('war.app did not offer the websocket socket transport.');
    sid = hs.sid;
    heartbeatMs = hs.heartbeatMs;
  } catch (e) {
    throw new WebSocketUnavailableError(scrub(`Push WebSocket handshake failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  let ws: WebSocketLike;
  try {
    ws = (leg.open ?? defaultWebSocketFactory)(websocketUrl(sid), { headers: { Cookie: `AuthToken=${token}` } });
  } catch (e) {
    throw new WebSocketUnavailableError(scrub(`Push WebSocket upgrade failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  await new Promise<void>((resolve, reject) => {
    let connected = false;
    let done = false;
    let cancelTimer: () => void = () => {};
    let chain: Promise<void> = Promise.resolve();

    const finish = (why?: string): void => {
      if (done) return;
      done = true;
      cancelTimer();
      hooks.setCloser(undefined);
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      if (why === undefined) resolve();
      else if (connected) reject(new Error(scrub(why)));
      else reject(new WebSocketUnavailableError(scrub(why)));
    };
    const arm = (): void => {
      cancelTimer();
      if (heartbeatMs > 0) {
        cancelTimer = hooks.setTimer(heartbeatMs, () =>
          finish(
            connected
              ? 'The war.app push WebSocket missed its heartbeat.'
              : 'The war.app push WebSocket did not connect before the heartbeat timeout.',
          ),
        );
      }
    };
    const send = async (packet: string): Promise<void> => {
      if (done) throw new Error('The war.app push socket is not connected.');
      ws.send(packet);
    };
    const handle = async (raw: string): Promise<void> => {
      const p = parsePacket(raw);
      if (!connected && p.type !== 'connect') {
        finish('war.app did not open the push WebSocket (no connect packet).');
        return;
      }
      switch (p.type) {
        case 'connect':
          if (!connected) {
            connected = true;
            await hooks.onConnected(send);
          }
          break;
        case 'heartbeat':
          await send('2::');
          break;
        case 'message':
          hooks.onMessage(p.data);
          break;
        case 'disconnect':
          finish('war.app closed the push WebSocket.');
          break;
        default:
          break;
      }
    };

    hooks.setCloser(() => finish());
    arm();
    ws.onopen = () => arm();
    ws.onmessage = (ev) => {
      if (done) return;
      arm();
      const raw = dataText(ev.data);
      chain = chain
        .then(() => (done ? undefined : handle(raw)))
        .catch((e: unknown) => finish(`The war.app push WebSocket failed: ${e instanceof Error ? e.message : String(e)}`));
    };
    ws.onclose = () => finish(connected ? 'war.app closed the push WebSocket.' : 'The push WebSocket upgrade failed (closed before connecting).');
    ws.onerror = (ev) => finish(`The war.app push WebSocket failed${errMessage(ev)}.`);
    if (!hooks.running()) finish();
  });
}
