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

export const SOCKET_URL = 'https://war.app/socket.io/1/';
export const POST_CONTENT_TYPE = 'text/plain;charset=UTF-8';

/** The part of the bridge transport the socket uses. */
export interface SocketTransport {
  fetch(init: FetchproxyFetchInit): Promise<FetchproxyFetchResult>;
}

export interface Handshake {
  sid: string;
  heartbeatMs: number;
  closeMs: number;
  transports: string[];
}

/** Parse a handshake reply `sid:heartbeat:close:transports`; throws on anything else. */
export function parseHandshake(body: string): Handshake {
  const parts = body.trim().split(':');
  const [sid, hb, close, transports] = parts;
  if (parts.length !== 4 || !sid || !/^[A-Za-z0-9_-]+$/.test(sid) || transports === undefined) {
    throw new Error('war.app did not answer the socket handshake with a session.');
  }
  return {
    sid,
    heartbeatMs: (Number(hb) || 0) * 1000,
    closeMs: (Number(close) || 0) * 1000,
    transports: transports.split(','),
  };
}

/** Split a poll body into packets (one bare packet, or the `�<len>�` framing). */
export function splitPayload(body: string): string[] {
  if (!body.startsWith('�')) return body === '' ? [] : [body];
  const out: string[] = [];
  let i = 0;
  while (i < body.length && body[i] === '�') {
    const end = body.indexOf('�', i + 1);
    if (end < 0) break;
    const len = Number(body.slice(i + 1, end));
    if (!Number.isInteger(len) || len < 0) break;
    out.push(body.slice(end + 1, end + 1 + len));
    i = end + 1 + len;
  }
  return out;
}

export type Packet =
  | { type: 'disconnect' }
  | { type: 'connect' }
  | { type: 'heartbeat' }
  | { type: 'message'; data: string }
  | { type: 'noop' }
  | { type: 'other'; raw: string };

/** Parse one packet `type:id:endpoint[:data]`. */
export function parsePacket(raw: string): Packet {
  const type = raw.split(':', 1)[0];
  switch (type) {
    case '0':
      return { type: 'disconnect' };
    case '1':
      return { type: 'connect' };
    case '2':
      return { type: 'heartbeat' };
    case '8':
      return { type: 'noop' };
    case '3': {
      // Data follows the third colon.
      let at = -1;
      for (let n = 0; n < 3; n++) {
        at = raw.indexOf(':', at + 1);
        if (at < 0) return { type: 'other', raw };
      }
      return { type: 'message', data: raw.slice(at + 1) };
    }
    default:
      return { type: 'other', raw };
  }
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
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Reconnect backoff: initial delay, doubled per failure up to `maxBackoffMs`. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
export const DEFAULT_MAX_BACKOFF_MS = 60_000;

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

class Disconnected extends Error {}

/**
 * A long-lived xhr-polling socket.io client. `start()` runs the poll loop in
 * the background; failures reconnect with backoff until `stop()`.
 */
export class SocketIoClient {
  private readonly opts: SocketIoClientOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private running = false;
  private sid: string | undefined;
  private isConnected = false;
  private waiters: Array<() => void> = [];
  private failures = 0;
  private lastErrorMessage: string | undefined;
  private connects = 0;

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

  /** How many times a session has connected. */
  get connectCount(): number {
    return this.connects;
  }

  get lastError(): string | undefined {
    return this.lastErrorMessage;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.run();
  }

  /** Stop polling. An in-flight poll is abandoned, not awaited. */
  stop(): void {
    this.running = false;
    this.disconnect();
  }

  /** Resolves once connected (the connect packet seen on the current session). */
  whenConnected(): Promise<void> {
    if (this.isConnected) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Send a message packet carrying a hex frame. Only once connected. */
  async sendMessage(hex: string): Promise<void> {
    await this.post(`3:::${hex}`);
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
  }

  private markConnected(): void {
    this.isConnected = true;
    this.failures = 0;
    this.connects++;
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  private backoffMs(): number {
    const initial = this.opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    const max = this.opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    return Math.min(max, initial * 2 ** Math.min(this.failures, 30));
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.session();
      } catch (e) {
        this.disconnect();
        if (!this.running) break;
        const err = e instanceof Error ? e : new Error(String(e));
        this.lastErrorMessage = err.message;
        this.opts.onError?.(err);
        const delay = this.backoffMs();
        this.failures++;
        await this.sleep(delay);
      }
    }
  }

  /** One session: handshake, then poll until it fails or the client stops. */
  private async session(): Promise<void> {
    const t = await this.opts.transport();
    const hs = await t.fetch({ method: 'GET', path: `${SOCKET_URL}?t=${this.now()}`, retryOnTimeout: false });
    if (hs.status !== 200) throw new Error(`war.app answered HTTP ${hs.status} to the socket handshake.`);
    const handshake = parseHandshake(hs.body);
    if (!handshake.transports.includes('xhr-polling')) {
      throw new Error('war.app did not offer the xhr-polling socket transport.');
    }
    const sid = handshake.sid;
    this.sid = sid;
    let first = true;
    while (this.running && this.sid === sid) {
      const res = await t.fetch({ method: 'GET', path: this.url(), retryOnTimeout: false });
      if (this.sid !== sid) return;
      if (res.status !== 200) throw new Error(`war.app answered HTTP ${res.status} to a push-socket poll.`);
      const packets = splitPayload(res.body).map(parsePacket);
      if (first && packets[0]?.type !== 'connect') {
        throw new Error('war.app did not open the push socket (no connect packet).');
      }
      first = false;
      for (const p of packets) {
        switch (p.type) {
          case 'connect':
            if (!this.isConnected) {
              this.markConnected();
              await this.opts.onConnect?.();
            }
            break;
          case 'heartbeat':
            await this.post('2::');
            break;
          case 'message':
            this.opts.onMessage(p.data);
            break;
          case 'disconnect':
            throw new Disconnected('war.app closed the push socket.');
          default:
            break;
        }
      }
    }
  }
}
