// The process's war.app turn-notification listener: one push socket per
// process (many processes sharing the bridge port collide — it must live in
// the MCP server's own long-lived process), started lazily on first use,
// subscribed to `Game.<id>` for every game anyone has asked to watch. Each
// GameUpdated push becomes `{ gameId, at }`; the push carries no detail, so a
// consumer re-reads GameFeed for that game.
//
// Transport: the direct WebSocket while the active transport is the direct leg
// (src/push/websocket.ts), else — and as the fallback when the WebSocket
// cannot be brought up — xhr-polling over the bridge. After any reconnect,
// pushes sent during the gap are lost: `onReconnect` tells consumers to
// re-read GameFeed.
import type { ExtrasUp } from '../protocol/codec.js';
import { gameTopic } from '../protocol/methods.js';
import {
  CLIENT_VERSION,
  INITIAL_SERVER_INFO_A,
  INITIAL_SERVER_INFO_B,
  PLATFORM_WEBSITE,
} from '../protocol/rpc.js';
import {
  parsePushFrame,
  SocketIoClient,
  subscribeFrameHex,
  type PushTransportName,
  type SocketIoClientOptions,
  type SocketTransport,
} from './socketio.js';
import type { SetTimer, WebSocketLeg } from './websocket.js';

export interface GameUpdate {
  gameId: number;
  /** ISO time the push was received. */
  at: string;
}

export interface PushStatus {
  started: boolean;
  connected: boolean;
  /** Game ids subscribed (or to be subscribed on connect). */
  watching: number[];
  /** Topics war.app refused, with its error code. */
  refused: Record<string, number>;
  /** The push transport of the current (or last) session, once one has started. */
  transport?: PushTransportName;
  lastError?: string;
}

export interface PushListenerOptions {
  transport: () => Promise<SocketTransport>;
  /** The direct WebSocket leg (src/push/websocket.ts `pushWebSocketLeg`); absent: xhr-polling only. */
  webSocket?: WebSocketLeg;
  /** The WebSocket heartbeat timer (tests). */
  setTimer?: SetTimer;
  /** MessageExtrasUp for Subscribe frames (default: the web client's values). */
  extras?: () => ExtrasUp;
  /** How many recent events to keep. Default 100. */
  maxEvents?: number;
  now?: () => number;
  /** Passed to the socket (tests). */
  sleep?: SocketIoClientOptions['sleep'];
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export const DEFAULT_MAX_EVENTS = 100;

const defaultExtras = (): ExtrasUp => ({
  dict: new Map(),
  client: CLIENT_VERSION,
  serverInfoVersionA: INITIAL_SERVER_INFO_A,
  serverInfoVersionB: INITIAL_SERVER_INFO_B,
  fDb: null,
  kFa: null,
  platform: PLATFORM_WEBSITE,
});

export class PushListener {
  private readonly socket: SocketIoClient;
  private readonly extras: () => ExtrasUp;
  private readonly maxEvents: number;
  private readonly now: () => number;
  private readonly games = new Set<number>();
  /** Game ids sent in a Subscribe on the current session. */
  private subscribed = new Set<number>();
  private readonly refused = new Map<string, number>();
  private readonly events: GameUpdate[] = [];
  private readonly listeners = new Set<(u: GameUpdate) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private nextMsgNum = 1;

  constructor(opts: PushListenerOptions) {
    this.extras = opts.extras ?? defaultExtras;
    this.maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.now = opts.now ?? Date.now;
    this.socket = new SocketIoClient({
      transport: opts.transport,
      now: this.now,
      onMessage: (data) => this.onMessage(data),
      onReconnect: () => {
        for (const fn of this.reconnectListeners) fn();
      },
      ...(opts.webSocket ? { webSocket: opts.webSocket } : {}),
      ...(opts.setTimer ? { setTimer: opts.setTimer } : {}),
      onConnect: async () => {
        this.subscribed = new Set();
        await this.subscribePending();
      },
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      ...(opts.initialBackoffMs !== undefined ? { initialBackoffMs: opts.initialBackoffMs } : {}),
      ...(opts.maxBackoffMs !== undefined ? { maxBackoffMs: opts.maxBackoffMs } : {}),
    });
  }

  /**
   * Watch these games: start the socket if needed and subscribe to any not
   * yet subscribed. Never throws for a socket failure — the socket keeps
   * reconnecting in the background and subscribes on connect.
   */
  async watch(gameIds: readonly number[]): Promise<void> {
    for (const id of gameIds) this.games.add(id);
    this.socket.start();
    if (this.socket.connected) {
      try {
        await this.subscribePending();
      } catch {
        // The session failed; the reconnect re-subscribes everything.
      }
    }
  }

  /** Listen for GameUpdated pushes; returns the unsubscribe. */
  onUpdate(fn: (u: GameUpdate) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * Listen for reconnects (every connect after the first, once re-subscribed):
   * pushes during the gap were lost, so re-read GameFeed. Returns the unsubscribe.
   */
  onReconnect(fn: () => void): () => void {
    this.reconnectListeners.add(fn);
    return () => {
      this.reconnectListeners.delete(fn);
    };
  }

  /** The most recent events, newest first. */
  recent(limit = this.maxEvents): GameUpdate[] {
    return this.events.slice(-limit).reverse();
  }

  status(): PushStatus {
    const s: PushStatus = {
      started: this.socket.started,
      connected: this.socket.connected,
      watching: [...this.games].sort((a, b) => a - b),
      refused: Object.fromEntries(this.refused),
    };
    const transport = this.socket.transport;
    if (transport !== undefined) s.transport = transport;
    const err = this.socket.lastError;
    if (err !== undefined) s.lastError = err;
    return s;
  }

  stop(): void {
    this.socket.stop();
  }

  private async subscribePending(): Promise<void> {
    const pending = [...this.games].filter((g) => !this.subscribed.has(g));
    if (!pending.length) return;
    for (const g of pending) this.subscribed.add(g);
    try {
      await this.socket.sendMessage(subscribeFrameHex(pending.map(gameTopic), this.nextMsgNum++, this.extras()));
    } catch (e) {
      for (const g of pending) this.subscribed.delete(g);
      throw e;
    }
  }

  private onMessage(data: string): void {
    const msg = parsePushFrame(data);
    if (!msg) return;
    if (msg.kind === 'subscribe-reply') {
      for (const [topic, code] of msg.rejected) this.refused.set(topic, code);
      return;
    }
    if (msg.kind !== 'game-updated') return;
    const update: GameUpdate = { gameId: msg.gameId, at: new Date(this.now()).toISOString() };
    this.events.push(update);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    for (const fn of this.listeners) fn(update);
  }
}

const perTransport = new WeakMap<object, PushListener>();

/**
 * The one listener for a bridge (so for the process: index.ts shares one
 * bridge across connections). Built on first use; the socket starts on the
 * first `watch`.
 */
export function pushListenerFor(key: object, opts: PushListenerOptions): PushListener {
  let l = perTransport.get(key);
  if (!l) {
    l = new PushListener(opts);
    perTransport.set(key, l);
  }
  return l;
}
