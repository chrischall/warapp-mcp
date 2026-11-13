// war.app's push channel: socket.io v0.9 over xhr-polling, carried by the
// browser bridge (docs/PLAN-CARDS-PUSH.md, "Turn notifications", verified live).
//
//   handshake  GET  https://war.app/socket.io/1/?t=<ms>
//              →    sid:heartbeat:close:transports
//   poll       GET  …/socket.io/1/xhr-polling/<sid>?t=<ms>   (long poll)
//   send       POST …/socket.io/1/xhr-polling/<sid>?t=<ms>   (text/plain)
//
// The FIRST poll of a session must return the connect packet `1::` before
// anything is POSTed — a POST first is HTTP 400. Packets: `0` disconnect,
// `1` connect, `2::` heartbeat (answered with a POST of `2::`), `3:::<data>`
// message, `8` noop; several in one poll are framed `�<len>�<packet>`.
// Messages carry web-client frames as uppercase hex.
import type { FetchproxyFetchInit, FetchproxyFetchResult } from '@chrischall/mcp-utils/fetchproxy';
import { decodeReplyEnvelope, encodeRequest, fromHex, Reader, readExtrasUp, readHeader, toHex, type ExtrasUp } from '../protocol/codec.js';
import { Method, readSubscribeResult, writeSubscribeParams } from '../protocol/methods.js';
import { parseHandshake, parsePacket, SOCKET_URL, splitPayload } from './packets.js';
import { realSetTimer, runWebSocketSession, WebSocketUnavailableError, type SetTimer, type WebSocketLeg } from './websocket.js';

export { parseHandshake, parsePacket, SOCKET_URL, splitPayload, type Handshake, type Packet } from './packets.js';
export const POST_CONTENT_TYPE = 'text/plain;charset=UTF-8';

/** The part of the bridge transport the socket uses. */
export interface SocketTransport {
  fetch(init: FetchproxyFetchInit): Promise<FetchproxyFetchResult>;
}

/** A Subscribe frame (method 238, no auth block) as the uppercase hex a message packet carries. */
export function subscribeFrameHex(topics: readonly string[], msgNum: number, extras: ExtrasUp): string {
  return toHex(
    encodeRequest({
      method: Method.Subscribe,
      msgNum,
      extras,
      email: null,
      params: (w) => writeSubscribeParams(w, topics),
    }),
  );
}

export type PushMessage =
  | { kind: 'game-updated'; gameId: number }
  | { kind: 'subscribe-reply'; msgNum: number; rejected: Map<string, number>; error?: number }
  | { kind: 'other'; method: number };

/**
 * Decode a frame from a message packet. A server push is a request-shaped
 * frame (MessageExtrasUp, no auth): GameUpdated (241) starts with the game id.
 * Returns undefined for anything that does not decode — never throws.
 */
export function parsePushFrame(hex: string): PushMessage | undefined {
  try {
    const bytes = fromHex(hex);
    const r = new Reader(bytes);
    const header = readHeader(r);
    if (header.reply) {
      if (header.method !== Method.Subscribe) return { kind: 'other', method: header.method };
      const env = decodeReplyEnvelope(bytes);
      if (env.error) return { kind: 'subscribe-reply', msgNum: env.msgNum, rejected: new Map(), error: env.error.code };
      return { kind: 'subscribe-reply', msgNum: env.msgNum, rejected: readSubscribeResult(env.body) };
    }
    if (header.method !== Method.GameUpdated) return { kind: 'other', method: header.method };
    readExtrasUp(r);
    return { kind: 'game-updated', gameId: r.int32() };
  } catch {
    return undefined;
  }
}

export interface SocketIoClientOptions {
  /** The started bridge. */
  transport: () => Promise<SocketTransport>;
  /** Each message packet's data (a hex frame). */
  onMessage: (data: string) => void;
  /** Called on every (re)connect, after the connect packet: (re)subscribe here. */
  onConnect?: () => void | Promise<void>;
  /** Called with each session failure, before the backoff. */
  onError?: (error: Error) => void;
  /**
   * Called after every connect but the first (after `onConnect`): pushes sent
   * during the gap were lost, so a consumer re-reads GameFeed.
   */
  onReconnect?: () => void;
  /**
   * The direct WebSocket leg. When present and `select()` is true, each
   * session tries the WebSocket first and falls back to xhr-polling over
   * `transport` when it cannot be brought up. Absent: xhr-polling only.
   */
  webSocket?: WebSocketLeg;
  /** The WebSocket heartbeat timer (tests). */
  setTimer?: SetTimer;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Reconnect backoff: initial delay, doubled per failure up to `maxBackoffMs`. The same pace
   * spaces out polls that come back at once with nothing to say.
   */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** A session connected this long resets the backoff when it ends (default 30 s). */
  stableMs?: number;
  /** A poll answered faster than this with nothing to say is paced (default 1 s). */
  minPollMs?: number;
}

export const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
export const DEFAULT_MAX_BACKOFF_MS = 60_000;
export const DEFAULT_STABLE_MS = 30_000;
export const DEFAULT_MIN_POLL_MS = 1_000;

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

class Disconnected extends Error {}

/** Which socket.io transport a session runs on. */
export type PushTransportName = 'websocket' | 'xhr-polling';

/**
 * A long-lived socket.io client: the direct WebSocket when its leg is selected
 * and comes up, otherwise xhr-polling over the bridge. `start()` runs the
 * session loop in the background; failures reconnect with backoff (a new
 * handshake, a new sid, `onConnect` re-subscribes) until `stop()`.
 */
export class SocketIoClient {
  private readonly opts: SocketIoClientOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private running = false;
  /**
   * The run each loop belongs to, bumped by `start()` and `stop()`. A loop stopped while a poll or
   * a backoff sleep was in flight wakes to a newer generation and exits, even when a later
   * `start()` has set `running` again — otherwise two loops would keep replacing each other's sid
   * (#131).
   */
  private generation = 0;
  private sid: string | undefined;
  private isConnected = false;
  private waiters: Array<() => void> = [];
  private failures = 0;
  private lastErrorMessage: string | undefined;
  private connects = 0;
  /** When the current session connected; undefined until it does. */
  private connectedAt: number | undefined;
  private sender: ((packet: string) => Promise<void>) | undefined;
  private closeSession: (() => void) | undefined;
  private active: PushTransportName | undefined;

  constructor(opts: SocketIoClientOptions) {
    this.opts = opts;
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get started(): boolean {
    return this.running;
  }

  /** How many times a session has connected since the last `start()`. */
  get connectCount(): number {
    return this.connects;
  }

  get lastError(): string | undefined {
    return this.lastErrorMessage;
  }

  /** The transport of the current (or last) session; undefined before the first. */
  get transport(): PushTransportName | undefined {
    return this.active;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // A restart begins afresh: its first connect is not a reconnect (no push gap on this run).
    this.connects = 0;
    this.failures = 0;
    void this.run(++this.generation);
  }

  /** Stop. An in-flight poll is abandoned, not awaited; an open WebSocket is closed. */
  stop(): void {
    this.running = false;
    this.generation++;
    const close = this.closeSession;
    this.closeSession = undefined;
    close?.();
    this.disconnect();
  }

  /** Resolves once connected (the connect packet seen on the current session). */
  whenConnected(): Promise<void> {
    if (this.isConnected) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Send a message packet carrying a hex frame. Only once connected. */
  async sendMessage(hex: string): Promise<void> {
    if (!this.isConnected || !this.sender) throw new Error('The war.app push socket is not connected.');
    await this.sender(`3:::${hex}`);
  }

  private url(): string {
    return `${SOCKET_URL}xhr-polling/${this.sid}?t=${this.now()}`;
  }

  private async post(packet: string): Promise<void> {
    if (!this.isConnected || this.sid === undefined) {
      throw new Error('The war.app push socket is not connected.');
    }
    const t = await this.opts.transport();
    const res = await t.fetch({
      method: 'POST',
      path: this.url(),
      headers: { 'content-type': POST_CONTENT_TYPE },
      body: packet,
    });
    if (res.status !== 200) throw new Error(`war.app answered HTTP ${res.status} to a push-socket send.`);
  }

  private disconnect(): void {
    this.isConnected = false;
    this.sid = undefined;
    this.sender = undefined;
  }

  /** A session saw its connect packet: record it, (re)subscribe, then signal a reconnect. */
  private async markConnected(gen: number, send: (packet: string) => Promise<void>): Promise<void> {
    if (!this.live(gen)) return;
    this.sender = send;
    this.isConnected = true;
    // The backoff is not reset here: a session that connects and fails at once would retry every
    // second forever. It resets when a session that held for `stableMs` ends (#131).
    this.connectedAt = this.now();
    this.connects++;
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
    await this.opts.onConnect?.();
    if (this.connects > 1) this.opts.onReconnect?.();
  }

  private backoffMs(failures = this.failures): number {
    const initial = this.opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    const max = this.opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    return Math.min(max, initial * 2 ** Math.min(failures, 30));
  }

  /** Whether a loop of generation `gen` should keep going. */
  private live(gen: number): boolean {
    return this.running && this.generation === gen;
  }

  private async run(gen: number): Promise<void> {
    while (this.live(gen)) {
      this.connectedAt = undefined;
      try {
        await this.session(gen);
      } catch (e) {
        // A stale loop must not touch the state of the run that replaced it.
        if (!this.live(gen)) break;
        this.disconnect();
        const held = this.connectedAt !== undefined && this.now() - this.connectedAt >= (this.opts.stableMs ?? DEFAULT_STABLE_MS);
        if (held) this.failures = 0;
        const err = e instanceof Error ? e : new Error(String(e));
        this.lastErrorMessage = err.message;
        this.opts.onError?.(err);
        const delay = this.backoffMs();
        this.failures++;
        await this.sleep(delay);
      }
    }
  }

  /** One session: the WebSocket when selected and available, else xhr-polling. */
  private async session(gen: number): Promise<void> {
    const leg = this.opts.webSocket;
    if (leg && (await leg.select())) {
      this.active = 'websocket';
      try {
        await runWebSocketSession(leg, {
          running: () => this.live(gen),
          now: this.now,
          setTimer: this.opts.setTimer ?? realSetTimer,
          onConnected: (send) => this.markConnected(gen, send),
          onMessage: (data) => this.opts.onMessage(data),
          setCloser: (close) => {
            if (this.live(gen)) this.closeSession = close;
            else close?.();
          },
        });
        return;
      } catch (e) {
        if (!(e instanceof WebSocketUnavailableError)) throw e;
        // Fall back to xhr-polling over the bridge for this session.
        this.lastErrorMessage = e.message;
      }
    }
    if (!this.live(gen)) return;
    this.active = 'xhr-polling';
    await this.pollSession(gen);
  }

  /** One xhr-polling session: handshake, then poll until it fails or the client stops. */
  private async pollSession(gen: number): Promise<void> {
    const t = await this.opts.transport();
    const hs = await t.fetch({ method: 'GET', path: `${SOCKET_URL}?t=${this.now()}`, retryOnTimeout: false });
    if (!this.live(gen)) return;
    if (hs.status !== 200) throw new Error(`war.app answered HTTP ${hs.status} to the socket handshake.`);
    const handshake = parseHandshake(hs.body);
    if (!handshake.transports.includes('xhr-polling')) {
      throw new Error('war.app did not offer the xhr-polling socket transport.');
    }
    const sid = handshake.sid;
    this.sid = sid;
    let first = true;
    /** Polls in a row answered at once with nothing to say. */
    let idle = 0;
    while (this.live(gen) && this.sid === sid) {
      const started = this.now();
      const res = await t.fetch({ method: 'GET', path: this.url(), retryOnTimeout: false });
      if (!this.live(gen) || this.sid !== sid) return;
      if (res.status !== 200) throw new Error(`war.app answered HTTP ${res.status} to a push-socket poll.`);
      const packets = splitPayload(res.body).map(parsePacket);
      if (first && packets[0]?.type !== 'connect') {
        throw new Error('war.app did not open the push socket (no connect packet).');
      }
      const wasFirst = first;
      first = false;
      let useful = wasFirst;
      for (const p of packets) {
        if (p.type === 'connect' || p.type === 'heartbeat' || p.type === 'message') useful = true;
        switch (p.type) {
          case 'connect':
            if (!this.isConnected) await this.markConnected(gen, (packet) => this.post(packet));
            break;
          case 'heartbeat':
            await this.post('2::');
            break;
          case 'message':
            this.opts.onMessage(p.data);
            break;
          case 'disconnect':
            throw new Disconnected('war.app closed the push socket.');
          case 'error':
            throw new Error(`war.app refused the push socket (${p.reason || 'no reason'}).`);
          default:
            break;
        }
      }
      // A long poll ends with a noop after a quiet spell; one answered at once with nothing to say
      // (an empty body, a noop, a packet this client ignores) would otherwise re-poll in a tight
      // loop. Pace those like the reconnect backoff (#131).
      if (useful || this.now() - started >= (this.opts.minPollMs ?? DEFAULT_MIN_POLL_MS)) {
        idle = 0;
      } else if (this.live(gen) && this.sid === sid) {
        await this.sleep(this.backoffMs(idle++));
      }
    }
  }
}
