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
// {@link createDirectFirstBridge} wires the direct leg and the existing
// fetchproxy bridge (src/transport-bridge.ts `createWarappBridge`) through
// mcp-utils `createDirectFirstTransport`: `auto` (default) tries direct and
// falls back to the browser bridge when the session is absent or expired;
// `fetchproxy` is today's behaviour; `direct` never falls back. A non-GET that
// reached war.app on the direct leg is never replayed over the bridge (a write
// must not be sent twice), and a relink returns `auto` to the direct leg.
//
// SECURITY: the AuthToken is a full-account credential. It is never logged,
// never put in a tool result, never in an error or hint string — upstream
// errors are scrubbed BY VALUE ({@link scrubError}: message, hint, stack and
// cause chain). The direct leg
// refuses to attach the cookie to any host but war.app, so the token can never
// be sent elsewhere. Direct mode is LOCAL-ONLY — the hosted path keeps the
// browser bridge and stores no token on the host.
import { detectEdgeBlock, EdgeBlockedError, McpToolError } from '@chrischall/mcp-utils';
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
import { SESSION_HOST, scrubError, type Session } from './session.js';

/** The env var pinning the transport: `direct` | `fetchproxy` | `auto` (default). */
export const TRANSPORT_ENV = 'WARAPP_TRANSPORT';

/**
 * The slice of a bridge every hot-path consumer (WarappRpc, the page fetches,
 * the push socket) actually uses: `ready()` → `{ fetch }`. Both the fetchproxy
 * `WarappBridge` and the direct-first {@link WarappDirectBridge} satisfy it, so
 * a consumer typed against this takes either and gains direct mode unchanged.
 */
export interface ReadyFetchBridge {
  ready(): Promise<{ fetch(init: FetchproxyFetchInit): Promise<FetchproxyFetchResult> }>;
}

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
  /** When the expired session was captured (non-secret), so a relink can be told apart. */
  readonly capturedAt: string | undefined;
  constructor(opts: { capturedAt?: string | undefined; notResent?: boolean } = {}) {
    super(
      'The linked war.app session is no longer signed in. ' +
        (opts.notResent
          ? 'The request had already reached war.app, so it was not re-sent over the browser bridge (a write must ' +
            'never be sent twice); later calls use the bridge. Retry, or run warapp_link_session to relink.'
          : 'Run warapp_link_session to relink.'),
      { kind: 'session_expired' },
    );
    this.capturedAt = opts.capturedAt;
  }
}

/** A direct HTTPS reply, mapped to the bridge's `{ status, body, url }` shape. */
export interface DirectFetchResult {
  status: number;
  body: string;
  url: string;
  /** Response headers, lower-cased (an edge challenge is read from them). */
  headers?: Record<string, string>;
}

/** The HTTPS primitive the direct leg issues; the default wraps netguard `fetchPublic`. A test seam. */
export type DirectFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<DirectFetchResult>;

const decoder = new TextDecoder();

/** Map a netguard `fetchPublic` final response to {@link DirectFetchResult}. */
export function toDirectResult(res: {
  status: number;
  body: Uint8Array;
  url: string;
  headers?: { forEach(cb: (value: string, key: string) => void): void };
}): DirectFetchResult {
  const out: DirectFetchResult = { status: res.status, body: decoder.decode(res.body), url: res.url };
  if (res.headers) {
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    out.headers = headers;
  }
  return out;
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
 * Whether a direct reply shows the session is signed out: a login redirect
 * (whatever the final status), or a 200 reply that is a sign-in page body or a
 * `/Services` reply that is not a valid frame. Any other status — a 5xx error
 * page above all — is NOT a sign-out: it passes through, so WarappRpc reports
 * it as an `http` failure instead of the router replaying the call over the
 * bridge and marking a good session stale.
 */
export function looksSignedOut(requestedUrl: string, res: DirectFetchResult): boolean {
  let finalPath = '';
  try {
    finalPath = new URL(res.url).pathname;
  } catch {
    finalPath = '';
  }
  if (SIGNIN_PATH.test(finalPath)) return true;
  // The origin refused the credential (an edge challenge is told apart first, by the caller).
  if (res.status === 401 || res.status === 403) return true;
  if (res.status !== 200) return false;
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
      throw scrubError(err, [token]);
    }
    // A CDN/WAF challenge (a 403 with `cf-mitigated`, a challenge page) never reached war.app: the
    // router falls back to the browser bridge, whose real browser passes it (#131).
    if (res.status !== 200 || res.headers?.['cf-mitigated']) {
      const edge = detectEdgeBlock({ body: res.body, ...(res.headers ? { headers: res.headers } : {}), status: res.status });
      if (edge) {
        throw new EdgeBlockedError(res.status, edge.vendor, {
          service: SESSION_HOST,
          method: init.method,
          path: new URL(url).pathname,
        });
      }
    }
    if (looksSignedOut(url, res)) throw new SessionExpiredError({ capturedAt: sess.capturedAt });
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
  /** A snapshot of the request counters (they restart when a relink rebuilds the router). */
  stats(): DirectFirstStats;
  /**
   * True while the linked token is known to be signed out: the direct leg's
   * last answer was a {@link SessionExpiredError}. Cleared when the direct leg
   * succeeds again or a new session is linked ({@link sessionLinked}, or a new
   * `capturedAt` noticed on the next call).
   */
  sessionStale(): boolean;
  /**
   * A new session was just linked (warapp_link_session): clear the stale flag
   * and, in `auto`, return to the direct leg — the router's wall was about the
   * OLD session. An edge-block wall is kept (it is about this client, not the token).
   */
  sessionLinked(): void;
}

/** Options for {@link createDirectFirstBridge}. */
export interface CreateDirectFirstBridgeOptions {
  /** The session store (M1's `readSession`, wrapped). */
  store: SessionStore;
  /** Build the existing fetchproxy bridge leg, lazily. */
  makeBridge: () => WarappBridge;
  /** The transport pin; defaults to {@link TRANSPORT_ENV} read from `env`. */
  mode?: TransportMode;
  /** Env for the default `mode` read. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: the direct leg's HTTPS primitive (default netguard `fetchPublic`). */
  directFetch?: DirectFetch;
  /** Where the switch notice goes (default stderr; never prints the token). */
  log?: (message: string) => void;
  /** Test seam: the clock (ms) used to throttle the relink check (default `Date.now`). */
  now?: () => number;
}

/**
 * Behind a session wall, the session file is re-read (to notice a relink by
 * another process) at most once per this many ms, not on every bridged call.
 */
export const RELINK_CHECK_MS = 5_000;

/** Why the router left the direct leg: a session problem (lifted by a relink) or an edge block (sticky). */
type Wall = { kind: 'session'; capturedAt: string | null } | { kind: 'edge' };

/** Whether a request may be re-sent after it reached war.app (only a read-only GET/HEAD). */
const isSafeToReplay = (method: string): boolean => /^(?:GET|HEAD)$/i.test(method);

/**
 * Wire the direct leg and the fetchproxy bridge into a direct-first router,
 * returning an object shaped like today's bridge (`ready()` → `{ fetch }`) plus
 * the healthcheck slice. On a direct→bridge fallback the router emits a switch
 * notice (never printing the token). A non-GET whose direct attempt reached
 * war.app is never replayed over the bridge. In `auto`, a session-caused wall
 * is lifted when a NEW session is linked, so the direct leg is retried.
 */
export function createDirectFirstBridge(opts: CreateDirectFirstBridgeOptions): WarappDirectBridge {
  const mode = opts.mode ?? readTransportMode(TRANSPORT_ENV, opts.env ? { env: opts.env } : {});
  const direct = new DirectBridge(opts.store, opts.directFetch);
  const log = opts.log ?? ((m: string) => console.error(m));
  const now = opts.now ?? Date.now;

  let wall: Wall | null = null;
  let stale = false;
  let lastRelinkCheck = Number.NEGATIVE_INFINITY;

  const onFallback = ({ error }: { error: unknown }): void => {
    const next: Wall =
      error instanceof SessionExpiredError
        ? { kind: 'session', capturedAt: error.capturedAt ?? null }
        : error instanceof SessionNotLinkedError
          ? { kind: 'session', capturedAt: null }
          : { kind: 'edge' };
    wall = next;
    const why =
      error instanceof SessionExpiredError
        ? 'the linked war.app session is signed out'
        : error instanceof SessionNotLinkedError
          ? 'no war.app session is linked'
          : 'the site edge refused the direct request';
    log(
      `[warapp-mcp] Direct transport unavailable (${why}) — switching to the ContextMint Bridge browser bridge. ` +
        `Keep a ${SESSION_HOST} tab open and approve the pairing prompt in the extension if one appears` +
        (next.kind === 'session' ? '; run warapp_link_session to return to the direct transport.' : '.'),
    );
  };

  const build = () =>
    createDirectFirstTransport<DirectBridge, WarappBridge>({
      direct,
      bridge: opts.makeBridge,
      mode,
      serverName: 'warapp-mcp',
      hostLabel: SESSION_HOST,
      shouldFallBack: (err) =>
        err instanceof SessionExpiredError || err instanceof SessionNotLinkedError || err instanceof EdgeBlockedError,
      bridgeHealth: (b) => b.transport(),
      onFallback,
    });
  let legs = build();

  /** Lift a session-caused wall: a fresh router, back on the direct leg. An edge wall stays. */
  const liftSessionWall = (): void => {
    if (wall?.kind !== 'session') return;
    wall = null;
    legs = build();
  };

  /** Behind a session wall: has a DIFFERENT session been linked since (e.g. by another process)? */
  const relinkedSinceWall = async (): Promise<boolean> => {
    if (wall?.kind !== 'session') return false;
    const t = now();
    if (t - lastRelinkCheck < RELINK_CHECK_MS) return false;
    lastRelinkCheck = t;
    const sess = await opts.store.read();
    return sess !== null && sess.capturedAt !== wall.capturedAt;
  };

  const runOne = async (init: FetchproxyFetchInit): Promise<FetchproxyFetchResult> => {
    if (mode === 'auto' && (await relinkedSinceWall())) {
      liftSessionWall();
      stale = false;
    }
    // A non-GET whose direct attempt reached war.app (it answered signed-out)
    // is never re-sent over the bridge: a write must never be sent twice.
    let reached: SessionExpiredError | undefined;
    return legs.run(async (leg, ctx) => {
      if (leg === direct) {
        try {
          const res = await direct.fetch(init, ctx.signal);
          // Only a 200 proves the session works; a 5xx says nothing about it.
          if (res.status === 200) stale = false;
          return res;
        } catch (err) {
          if (err instanceof SessionExpiredError) {
            stale = true;
            if (!isSafeToReplay(init.method)) reached = err;
          }
          throw err;
        }
      }
      if (reached) throw new SessionExpiredError({ capturedAt: reached.capturedAt, notResent: true });
      return (leg as WarappBridge).ready().then((t) => t.fetch(init));
    });
  };

  return {
    ready: async () => ({ fetch: (init) => runOne(init) }),
    status: () => legs.status(),
    bridgeTransport: () => legs.bridgeTransport(),
    stats: () => legs.stats(),
    sessionStale: () => stale,
    sessionLinked: () => {
      stale = false;
      if (mode === 'auto') liftSessionWall();
    },
  };
}
