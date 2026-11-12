// The chrome-less "direct" leg and the direct-first bridge.
//
// Live verification (2026-11-12) established that war.app's signed-in session
// is carried by a durable `AuthToken` cookie, and that this cookie ALONE
// authenticates both the server-rendered pages (InviteToken, Profile,
// CommonGames, MultiPlayer) and the binary `/Services` protocol. So every call
// the browser bridge relays can instead be a plain HTTPS request carrying that
// cookie — no persistent Chrome tab in normal operation.
//
// {@link DirectBridge} is that direct leg: it reads the AuthToken from the
// session store (src/direct/session.ts) per call and issues an HTTPS request
// through mcp-utils netguard `fetchPublic` (pinned to public addresses, so a
// name that resolves or rebinds inward is refused, and credentials are dropped
// across origins). It maps the reply into the same `FetchproxyFetchResult`
// shape the browser bridge returns, so the ONE injection point every consumer
// shares (WarappRpc, the page fetches, the healthcheck, the push socket) gains
// direct mode at once.
//
// {@link createWarappBridge} wires the direct leg and the existing fetchproxy
// bridge through mcp-utils `createDirectFirstTransport`: `auto` (default) tries
// direct and falls back to the browser bridge when the session is absent or
// expired; `fetchproxy` is today's behaviour; `direct` never falls back.
//
// SECURITY: the AuthToken is a full-account credential. It is never logged,
// never put in a tool result, never in an error or hint string — upstream
// error strings are scrubbed BY VALUE ({@link scrubToken}). The direct leg
// refuses to attach the cookie to any host but war.app, so the token can never
// be sent elsewhere. Direct mode is LOCAL-ONLY — the hosted path keeps the
// browser bridge and stores no token on the host.
import { EdgeBlockedError, McpToolError } from '@chrischall/mcp-utils';
import {
  createDirectFirstTransport,
  readTransportMode,
  type BridgeHealthcheckTransport,
  type DirectFirstStats,
  type DirectFirstStatus,
  type FetchproxyFetchInit,
  type FetchproxyFetchResult,
  type TransportMode,
} from '@chrischall/mcp-utils/fetchproxy';
import { fetchPublic } from '@chrischall/mcp-utils/netguard';
import type { WarappBridge } from '../transport-bridge.js';
import { SESSION_HOST, scrubToken, type Session } from './session.js';

/** The env var pinning the transport: `direct` | `fetchproxy` | `auto` (default). */
export const TRANSPORT_ENV = 'WARAPP_TRANSPORT';

/** The byte cap on a direct reply (a board/standing reply is a few KB; pages tens of KB). */
export const MAX_DIRECT_BODY_BYTES = 16 * 1024 * 1024;
/** The deadline over a direct request and its body read. */
export const DIRECT_TIMEOUT_MS = 30_000;

/** The session-read surface the direct leg needs (M1's `readSession`, wrapped). */
export interface SessionStore {
  /** The linked session, or `null` when none is linked. Never throws. */
  read(): Promise<Session | null>;
}

/** No war.app session is linked — the router (in `auto`) falls back to the bridge. */
export class SessionNotLinkedError extends McpToolError {
  override name = 'SessionNotLinkedError';
  constructor() {
    super('No war.app session is linked for the direct transport. Run warapp_link_session to capture one.', {
      kind: 'no_credential',
    });
  }
}

/** The linked session is no longer signed in — the router (in `auto`) falls back to the bridge. */
export class SessionExpiredError extends McpToolError {
  override name = 'SessionExpiredError';
  constructor() {
    super('The linked war.app session is no longer signed in. Run warapp_link_session to relink.', {
      kind: 'session_expired',
    });
  }
}

/** A direct HTTPS reply, mapped to the bridge's `{ status, body, url }` shape. */
export interface DirectFetchResult {
  status: number;
  body: string;
  url: string;
}

/** The HTTPS primitive the direct leg issues; the default wraps netguard `fetchPublic`. A test seam. */
export type DirectFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<DirectFetchResult>;

const decoder = new TextDecoder();

/** Map a netguard `fetchPublic` final response to {@link DirectFetchResult}. */
export function toDirectResult(res: { status: number; body: Uint8Array; url: string }): DirectFetchResult {
  return { status: res.status, body: decoder.decode(res.body), url: res.url };
}

/** The default direct leg: a real HTTPS request through netguard `fetchPublic` (public-only, https-only). */
const fetchViaPublic: DirectFetch = async (url, init) => {
  const res = await fetchPublic(url, {
    method: init.method,
    headers: init.headers,
    requireHttps: true,
    maxBytes: MAX_DIRECT_BODY_BYTES,
    timeoutMs: DIRECT_TIMEOUT_MS,
    ...(init.body !== undefined ? { body: init.body } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  return toDirectResult(res);
};

/** Resolve a bridge path to an absolute war.app https URL, refusing any other host. */
export function warappUrl(path: string): string {
  const raw = /^https?:\/\//i.test(path) ? path : `https://${SESSION_HOST}${path.startsWith('/') ? '' : '/'}${path}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new McpToolError(`The direct transport could not parse the request path.`, { kind: 'unknown' });
  }
  if (u.hostname !== SESSION_HOST && !u.hostname.endsWith(`.${SESSION_HOST}`)) {
    // Never attach the full-account cookie to anything but war.app.
    throw new McpToolError(`The direct transport only talks to ${SESSION_HOST}.`, { kind: 'unknown' });
  }
  if (u.protocol !== 'https:') {
    throw new McpToolError('The direct transport requires https.', { kind: 'unknown' });
  }
  return u.href;
}

/** A sign-in page's URL (a login redirect landed here). */
const SIGNIN_PATH = /\/(?:sign-?in|log-?in)\b/i;
/** A sign-in page's body (a password field — game pages never carry one). */
const SIGNIN_BODY = /(?:type|name)\s*=\s*["']?password\b/i;

/** Whether a `/Services?js=1` reply is a valid (even-length hex) reply frame. */
export function looksLikeHexFrame(body: string): boolean {
  const t = body.trim();
  return t.length > 0 && t.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(t);
}

/**
 * Whether a direct reply shows the session is signed out: a login redirect, a
 * sign-in page body, or a `/Services` reply that is not a valid frame.
 */
export function looksSignedOut(requestedUrl: string, res: DirectFetchResult): boolean {
  let finalPath = '';
  try {
    finalPath = new URL(res.url).pathname;
  } catch {
    finalPath = '';
  }
  if (SIGNIN_PATH.test(finalPath)) return true;
  if (SIGNIN_BODY.test(res.body)) return true;
  let reqPath = '';
  try {
    reqPath = new URL(requestedUrl).pathname;
  } catch {
    reqPath = '';
  }
  if (/\/services\b/i.test(reqPath) && !looksLikeHexFrame(res.body)) return true;
  return false;
}

/** Scrub `token` from a thrown error's message (by value); leave token-free errors untouched. */
function scrubThrown(err: unknown, token: string): unknown {
  if (err instanceof Error) {
    const scrubbed = scrubToken(err.message, token);
    if (scrubbed !== err.message) {
      return new McpToolError(scrubbed, { kind: err instanceof McpToolError ? (err.kind ?? 'transport') : 'transport' });
    }
  }
  return err;
}

/**
 * The direct leg: a plain HTTPS request to war.app carrying the linked
 * AuthToken cookie, mapped to the bridge's `.fetch(init)` surface.
 */
export class DirectBridge {
  constructor(
    private readonly store: SessionStore,
    private readonly fetchImpl: DirectFetch = fetchViaPublic,
  ) {}

  async fetch(init: FetchproxyFetchInit, signal?: AbortSignal): Promise<FetchproxyFetchResult> {
    const sess = await this.store.read();
    if (!sess) throw new SessionNotLinkedError();
    const token = sess.authToken;
    // warappUrl refuses a non-war.app host BEFORE the cookie is built.
    const url = warappUrl(init.path);
    const headers: Record<string, string> = { ...(init.headers ?? {}), cookie: `AuthToken=${token}` };
    let res: DirectFetchResult;
    try {
      res = await this.fetchImpl(url, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw scrubThrown(err, token);
    }
    if (looksSignedOut(url, res)) throw new SessionExpiredError();
    return { status: res.status, body: res.body, url: res.url };
  }
}

/** The direct-first bridge, shaped like today's bridge plus the healthcheck slice. */
export interface WarappDirectBridge {
  /** Start-and-fetch: `ready()` resolves to the `{ fetch }` every consumer calls. */
  ready(): Promise<{ fetch(init: FetchproxyFetchInit): Promise<FetchproxyFetchResult> }>;
  /** Which leg the NEXT call rides, for the healthcheck's `path`. */
  status(): DirectFirstStatus;
  /** The bridge's healthcheck slice once a bridge exists; `undefined` while on direct. */
  bridgeTransport(): BridgeHealthcheckTransport | undefined;
  /** A snapshot of the request counters. */
  stats(): DirectFirstStats;
  /**
   * True once a direct→bridge fallback happened this session: the linked token
   * is stale/expired. (The router pins to the bridge after the first wall, so
   * the dead token is not retried — this flag lets the status tool say so.)
   */
  sessionStale(): boolean;
}

/** Options for {@link createWarappBridge}. */
export interface CreateWarappBridgeOptions {
  /** The session store (M1's `readSession`, wrapped). */
  store: SessionStore;
  /** Build the existing fetchproxy bridge leg, lazily (called at most once). */
  makeBridge: () => WarappBridge;
  /** The transport pin; defaults to {@link TRANSPORT_ENV} read from `env`. */
  mode?: TransportMode;
  /** Env for the default `mode` read. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: the direct leg's HTTPS primitive (default netguard `fetchPublic`). */
  directFetch?: DirectFetch;
  /** Where the switch notice goes (default stderr; never prints the token). */
  log?: (message: string) => void;
}

/**
 * Wire the direct leg and the fetchproxy bridge into a direct-first router,
 * returning an object shaped like today's bridge (`ready()` → `{ fetch }`) plus
 * the healthcheck slice. On a direct→bridge fallback the token is marked stale
 * and the router emits the standard switch notice (never printing the token).
 */
export function createWarappBridge(opts: CreateWarappBridgeOptions): WarappDirectBridge {
  const mode = opts.mode ?? readTransportMode(TRANSPORT_ENV, opts.env ? { env: opts.env } : {});
  const direct = new DirectBridge(opts.store, opts.directFetch);
  const legs = createDirectFirstTransport<DirectBridge, WarappBridge>({
    direct,
    bridge: opts.makeBridge,
    mode,
    serverName: 'warapp-mcp',
    hostLabel: SESSION_HOST,
    shouldFallBack: (err) =>
      err instanceof SessionExpiredError || err instanceof SessionNotLinkedError || err instanceof EdgeBlockedError,
    bridgeHealth: (b) => b.transport(),
    ...(opts.log ? { log: opts.log } : {}),
  });

  let stale = false;
  const runOne = async (init: FetchproxyFetchInit): Promise<FetchproxyFetchResult> => {
    const wasDirect = legs.status().transport === 'direct';
    const res = await legs.run((leg, ctx) =>
      leg === direct ? direct.fetch(init, ctx.signal) : (leg as WarappBridge).ready().then((t) => t.fetch(init)),
    );
    // A direct→bridge switch on this call means the linked token is dead.
    if (wasDirect && legs.status().transport === 'fetchproxy') stale = true;
    return res;
  };

  return {
    ready: async () => ({ fetch: (init) => runOne(init) }),
    status: () => legs.status(),
    bridgeTransport: () => legs.bridgeTransport(),
    stats: () => legs.stats(),
    sessionStale: () => stale,
  };
}
