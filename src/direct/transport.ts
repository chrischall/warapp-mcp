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
// name that resolves or rebinds inward is refused) — or, with an egress proxy
// configured (HTTPS_PROXY, mcp-host's only way out), through a proxy agent for
// it (src/direct/egress.ts), the proxy holding the address table. Every hop must be the exact
// origin https://war.app; a non-GET follows no redirect at all, so its body (the
// account email, the orders) is never re-sent anywhere
// ({@link directFetchOptions}). It maps the reply into the same
// `FetchproxyFetchResult` shape the browser bridge returns, so the ONE
// injection point every consumer shares (WarappRpc, the page fetches, the
// healthcheck, the push socket) gains direct mode at once.
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
// cause chain). The direct leg refuses to attach the cookie to any host but
// war.app itself (no subdomain), so the token can never be sent elsewhere.
// Hosted (src/hosted.ts), the direct leg serves only from the AuthToken
// mcp-host captured at sign-in (WARAPP_AUTH_TOKEN, src/direct/session.ts
// `hostedSession`, in memory, never stored), with the bridge as its fallback
// exactly as locally; without that token {@link createDirectFirstBridge} pins
// the router to the browser bridge whatever WARAPP_TRANSPORT says and its
// session store reads as empty, as before (#333).
import { detectEdgeBlock, EdgeBlockedError, McpToolError, type EnvSource } from '@chrischall/mcp-utils';
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
import { fetchPublic, type PublicFetchResponse, type PublicFetchStopped } from '@chrischall/mcp-utils/netguard';
import { egressDispatcher, type ProxyAgentFactory } from './egress.js';
import { decodeReplyEnvelope, fromHex } from '../protocol/codec.js';
import type { WarappBridge } from '../transport-bridge.js';
import { isHosted } from '../hosted.js';
import { hostedSession, SESSION_HOST, scrubError, type Session } from './session.js';

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
const MAX_DIRECT_BODY_BYTES = 16 * 1024 * 1024;
/** The deadline over a direct request and its body read. */
const DIRECT_TIMEOUT_MS = 30_000;

/** The session-read surface the direct leg needs (M1's `readSession`, wrapped). */
export interface SessionStore {
  /** The linked session, or `null` when none is linked. Never throws. */
  read(): Promise<Session | null>;
}

/**
 * What to do about a signed-out host-captured session: mcp-host runs the sign-in again. Until then the
 * router falls back to the browser bridge, so a paired war.app tab still serves the connection.
 */
export const HOST_SIGN_IN_ADVICE =
  'Use "Sign in" on this war.app connection, or reconnect it (mcp-host signs in to war.app again and captures a ' +
  'new session). Meanwhile, a war.app tab signed in and paired with the browser bridge works, since calls fall ' +
  'back to it.';

/** No war.app session is linked — the router (in `auto`) falls back to the bridge. */
export class SessionNotLinkedError extends McpToolError {
  override name = 'SessionNotLinkedError';
  constructor(opts: { hostSignIn?: boolean } = {}) {
    super(
      opts.hostSignIn
        ? `This connection has no war.app session. ${HOST_SIGN_IN_ADVICE}`
        : 'No war.app session is linked for the direct transport. Run warapp_link_session to capture one.',
      { kind: 'no_credential' },
    );
  }
}

/** The linked session is no longer signed in — the router (in `auto`) falls back to the bridge. */
export class SessionExpiredError extends McpToolError {
  override name = 'SessionExpiredError';
  /** When the expired session was captured (non-secret), so a relink can be told apart. */
  readonly capturedAt: string | undefined;
  /** The session was the one mcp-host captured: the remedy is its Sign in, not warapp_link_session. */
  readonly hostSignIn: boolean;
  constructor(opts: { capturedAt?: string | undefined; notResent?: boolean; hostSignIn?: boolean } = {}) {
    const remedy = opts.hostSignIn ? HOST_SIGN_IN_ADVICE : 'Run warapp_link_session to relink.';
    super(
      (opts.hostSignIn
        ? 'The war.app session this connection signed in with is no longer signed in. '
        : 'The linked war.app session is no longer signed in. ') +
        (opts.notResent
          ? 'The request had already reached war.app, so it was not re-sent over the browser bridge (a write must ' +
            `never be sent twice); later calls use the bridge. Retry, or: ${remedy}`
          : remedy),
      { kind: 'session_expired' },
    );
    this.capturedAt = opts.capturedAt;
    this.hostSignIn = opts.hostSignIn ?? false;
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

/** Whether a request may be re-sent (after it reached war.app, or by a redirect): only a read-only GET/HEAD. */
const isSafeToReplay = (method: string): boolean => /^(?:GET|HEAD)$/i.test(method);

/** The one origin the direct leg talks to: scheme, host and default port. */
const SESSION_ORIGIN = `https://${SESSION_HOST}`;

/** Redirects a direct GET may follow (all within war.app). */
const MAX_DIRECT_GET_REDIRECTS = 5;

/**
 * The status reported for a redirect a non-GET did not follow. netguard's
 * `stopBefore` result carries the target but not the 3xx code, so this stands
 * in for it: not 200, so WarappRpc reports an `http` failure, unless the target
 * is the sign-in page ({@link looksSignedOut} reads the path).
 */
export const UNFOLLOWED_REDIRECT_STATUS = 302;

/** The netguard options the direct leg chooses per request (pure; a test seam). */
interface DirectFetchOptions {
  requireHttps: true;
  /** Every hop's host, the first included: exactly war.app. */
  allowHosts: readonly string[];
  maxRedirects: number;
  /** Asked before each URL is requested (the first included); `true` stops without requesting it. */
  stopBefore: (url: URL) => boolean;
}

/**
 * How the direct leg may follow redirects. Every hop must be the exact host
 * war.app (netguard `allowHosts`, checked on the first URL and on each target
 * before it is requested). A GET follows at most
 * {@link MAX_DIRECT_GET_REDIRECTS} redirects within the exact origin
 * https://war.app (another port or scheme is stopped, not requested). A non-GET follows
 * none: netguard would re-send the method and body on a 307/308, and that body
 * holds the account email and the orders, so the first redirect target is
 * stopped before it is requested (`stopBefore` lets the request itself through
 * and stops everything after it; `maxRedirects: 1` only lets netguard reach
 * that check — with 0 it throws first and the sign-in target is lost). Each
 * call returns fresh state.
 */
export function directFetchOptions(method: string): DirectFetchOptions {
  const base = { requireHttps: true as const, allowHosts: [SESSION_HOST] };
  if (isSafeToReplay(method)) {
    // allowHosts compares the host name only: war.app on another port or scheme is stopped here.
    return { ...base, maxRedirects: MAX_DIRECT_GET_REDIRECTS, stopBefore: (url) => url.origin !== SESSION_ORIGIN };
  }
  let first = true;
  return {
    ...base,
    maxRedirects: 1,
    stopBefore: () => {
      if (first) {
        first = false;
        return false;
      }
      return true;
    },
  };
}

/**
 * Map a netguard `fetchPublic` result to {@link DirectFetchResult}. A stopped
 * result (a non-GET's redirect, not followed) has no body and
 * {@link UNFOLLOWED_REDIRECT_STATUS}, with the target as its URL.
 */
export function toDirectResult(
  res:
    | (Pick<PublicFetchResponse, 'status' | 'body' | 'url'> & {
        headers?: { forEach(cb: (value: string, key: string) => void): void };
      })
    | PublicFetchStopped,
): DirectFetchResult {
  if ('stopped' in res && res.stopped) return { status: UNFOLLOWED_REDIRECT_STATUS, body: '', url: res.url };
  const done = res as Pick<PublicFetchResponse, 'status' | 'body' | 'url'> & {
    headers?: { forEach(cb: (value: string, key: string) => void): void };
  };
  const out: DirectFetchResult = { status: done.status, body: decoder.decode(done.body), url: done.url };
  if (done.headers) {
    // The headers are kept: an edge challenge is read from them (#131).
    const headers: Record<string, string> = {};
    done.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    out.headers = headers;
  }
  return out;
}

/** Options for {@link createDirectFetch}. */
export interface DirectFetchEnv {
  /** Env for the egress proxy, read on each request (default `process.env`). */
  env?: EnvSource;
  /** Builds the proxy agent (a test seam; default undici's `ProxyAgent`). */
  proxyAgent?: ProxyAgentFactory;
}

/**
 * The default direct leg: a real HTTPS request through netguard `fetchPublic`
 * (war.app-only by `allowHosts` and `stopBefore`). With an egress proxy
 * configured (HTTPS_PROXY: mcp-host's only way out, src/direct/egress.ts) it
 * goes through a proxy agent, built per request and closed after; else netguard
 * builds its public-only dispatcher, as before. A proxy that is set but unusable
 * throws before anything is sent: never a direct connection instead.
 */
export function createDirectFetch(opts: DirectFetchEnv = {}): DirectFetch {
  return async (url, init) => {
    const proxy = egressDispatcher(opts.env ?? process.env, opts.proxyAgent);
    try {
      const res = await fetchPublic(url, {
        ...directFetchOptions(init.method),
        method: init.method,
        headers: init.headers,
        maxBytes: MAX_DIRECT_BODY_BYTES,
        timeoutMs: DIRECT_TIMEOUT_MS,
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
        ...(proxy ? { dispatcher: proxy } : {}),
      });
      return toDirectResult(res);
    } finally {
      await proxy?.close().catch(() => {});
    }
  };
}

const fetchViaPublic: DirectFetch = createDirectFetch();

/**
 * Resolve a bridge path to an absolute https URL on the exact host war.app,
 * refusing any other host (a subdomain or look-alike included), userinfo and a
 * non-default port: the full-account cookie goes to war.app and nowhere else.
 */
export function warappUrl(path: string): string {
  const raw = /^https?:\/\//i.test(path) ? path : `https://${SESSION_HOST}${path.startsWith('/') ? '' : '/'}${path}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new McpToolError(`The direct transport could not parse the request path.`, { kind: 'unknown' });
  }
  if (u.hostname !== SESSION_HOST || u.port !== '' || u.username !== '' || u.password !== '') {
    // Never attach the full-account cookie to anything but war.app itself.
    throw new McpToolError(`The direct transport only talks to ${SESSION_HOST}.`, { kind: 'unknown' });
  }
  if (u.protocol !== 'https:') {
    throw new McpToolError('The direct transport requires https.', { kind: 'unknown' });
  }
  return u.href;
}

/** A sign-in page's URL (a login redirect landed here). */
const SIGNIN_PATH = /\/(?:sign-?in|log-?in)\b/i;

/** An `<input` tag's start. */
const INPUT_TAG = /<input(?=[\s/>])/gi;
/** One attribute (name, then an optional double-quoted, single-quoted or bare value), or the tag's end. */
const TAG_ATTR = /\s*(?:(>)|([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+)))?|\/)/y;

/**
 * Regions whose content is not markup: HTML comments and `<script>`, `<style>`,
 * `<textarea>` and `<title>` blocks. An unclosed one — an opener with no `>`
 * included — runs to the end of the body, so the opener always matches and a
 * body of many unclosed openers is read once, not once per opener.
 */
const NOT_MARKUP = /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title)\b[^>]*(?:>|$)[\s\S]*?(?:<\/\1\s*>|$)/gi;

/**
 * Whether an HTML body holds a real password input: an `<input …>` element
 * whose `type` or `name` ATTRIBUTE is `password`. Player-written text on a page
 * (names, taglines) is HTML-escaped, which leaves `=` alone but never yields a
 * tag, and a value such as `value="type=password"` is read as that value, not
 * as an attribute — so nothing a player writes can match. Comments and script,
 * style, textarea and title blocks are skipped first ({@link NOT_MARKUP}): text a
 * page embeds raw inside one (a JSON string, say) is not an element. The cost: a
 * sign-in form that only a script writes into the page is not seen here; the
 * sign-in redirect and the `/Services` non-frame reply still report that session.
 */
export function hasPasswordInput(raw: string): boolean {
  const body = raw.replace(NOT_MARKUP, ' ');
  INPUT_TAG.lastIndex = 0;
  for (let m = INPUT_TAG.exec(body); m; m = INPUT_TAG.exec(body)) {
    TAG_ATTR.lastIndex = INPUT_TAG.lastIndex;
    for (let a = TAG_ATTR.exec(body); a && !a[1]; a = TAG_ATTR.exec(body)) {
      const name = a[2]?.toLowerCase();
      const value = (a[3] ?? a[4] ?? a[5] ?? '').trim().toLowerCase();
      if ((name === 'type' || name === 'name') && value === 'password') return true;
    }
  }
  return false;
}

/** Whether a `/Services?js=1` reply is a valid (even-length hex) reply frame. */
export function looksLikeHexFrame(body: string): boolean {
  const t = body.trim();
  return t.length > 0 && t.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(t);
}

/**
 * Whether a direct reply shows the session is signed out: a login redirect
 * (whatever the final status), or a 200 reply that is a sign-in page (a real
 * password `<input>`, {@link hasPasswordInput} — never a bare `type=password`
 * in the text, which any player can put on a Profile page) or a `/Services`
 * reply that is not a valid frame. Any other status — a 5xx error
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
  if (hasPasswordInput(res.body)) return true;
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
 * The page that says whether the session is signed in (live 2026-11-17): signed in it
 * answers 200 "Your invite token is N"; signed out, a 302 to `/LogIn?AuthNeeded=true`.
 */
export const SIGNED_IN_PROBE_URL = `${SESSION_ORIGIN}/InviteToken`;

/** war.app's `AuthFailed` server error: its `/Services` answer to a signed-out (or unknown) AuthToken. */
export const AUTH_FAILED_CODE = 3;

/** What a probe of {@link SIGNED_IN_PROBE_URL} says about the session. */
export type SignInVerdict = 'signed-in' | 'signed-out' | 'unknown';

const INVITE_TOKEN_TEXT = /Your invite token is\s*\d{5,20}/;

/** Read a reply to {@link SIGNED_IN_PROBE_URL} (pure). Never decides on a reply that says neither. */
export function signInVerdict(res: DirectFetchResult): SignInVerdict {
  let path = '';
  try {
    path = new URL(res.url).pathname;
  } catch {
    path = '';
  }
  if (SIGNIN_PATH.test(path)) return 'signed-out';
  if (res.status !== 200) return 'unknown';
  if (INVITE_TOKEN_TEXT.test(res.body)) return 'signed-in';
  if (hasPasswordInput(res.body)) return 'signed-out';
  return 'unknown';
}

/**
 * Whether a `/Services` reply is war.app's own "not signed in" answer: a valid reply frame
 * carrying server error {@link AUTH_FAILED_CODE} (live 2026-11-17: with no AuthToken, or a
 * bogus one, war.app answers exactly that — never a non-frame body).
 */
export function isAuthFailedReply(body: string): boolean {
  if (!looksLikeHexFrame(body)) return false;
  try {
    return decodeReplyEnvelope(fromHex(body.trim())).error?.code === AUTH_FAILED_CODE;
  } catch {
    return false;
  }
}

const isServicesUrl = (url: string): boolean => {
  try {
    return /\/services\b/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

const isProbeUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.origin === SESSION_ORIGIN && u.pathname === new URL(SIGNED_IN_PROBE_URL).pathname;
  } catch {
    return false;
  }
};

/**
 * The direct leg: a plain HTTPS request to war.app carrying the linked
 * AuthToken cookie, mapped to the bridge's `.fetch(init)` surface.
 *
 * A reply that only SUGGESTS a sign-out (a sign-in redirect or form, a 401/403, a
 * `/Services` reply that is not a frame, or war.app's AuthFailed frame) is confirmed with one
 * GET of {@link SIGNED_IN_PROBE_URL} before it is called one: a probe that shows the
 * session signed in passes the reply through as an ordinary failure, so one odd answer no
 * longer walls a good session; a probe that shows it signed out, or cannot tell, keeps the
 * old reading.
 */
export class DirectBridge {
  constructor(
    private readonly store: SessionStore,
    private readonly fetchImpl: DirectFetch = fetchViaPublic,
    /** A hosted child signed in by mcp-host: its signed-out errors point at Sign in. */
    private readonly hostSignIn = false,
  ) {}

  /** One GET of {@link SIGNED_IN_PROBE_URL} with the session; `none` when no session is linked. Never throws. */
  async checkSignedIn(signal?: AbortSignal): Promise<SignInVerdict | 'none'> {
    const sess = await this.store.read();
    if (!sess) return 'none';
    return this.probe(sess.authToken, signal);
  }

  private async probe(token: string, signal?: AbortSignal): Promise<SignInVerdict> {
    try {
      const res = await this.fetchImpl(SIGNED_IN_PROBE_URL, {
        method: 'GET',
        headers: { cookie: `AuthToken=${token}` },
        ...(signal ? { signal } : {}),
      });
      return signInVerdict(res);
    } catch {
      // Nothing from a failed probe reaches a caller: the token cannot leak through it.
      return 'unknown';
    }
  }

  async fetch(init: FetchproxyFetchInit, signal?: AbortSignal): Promise<FetchproxyFetchResult> {
    const sess = await this.store.read();
    if (!sess) throw new SessionNotLinkedError(this.hostSignIn ? { hostSignIn: true } : {});
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
    // router falls back to the browser bridge, whose real browser passes it (#131). A 200 that is
    // a valid reply frame is war.app's own answer whatever header the edge added beside it: read
    // as a challenge, the router would send a write that already arrived a second time.
    const answered = res.status === 200 && looksLikeHexFrame(res.body);
    if (!answered && (res.status !== 200 || res.headers?.['cf-mitigated'])) {
      const edge = detectEdgeBlock({ body: res.body, ...(res.headers ? { headers: res.headers } : {}), status: res.status });
      if (edge) {
        throw new EdgeBlockedError(res.status, edge.vendor, {
          service: SESSION_HOST,
          method: init.method,
          path: new URL(url).pathname,
        });
      }
    }
    const suspect = looksSignedOut(url, res) || (answered && isServicesUrl(url) && isAuthFailedReply(res.body));
    if (suspect) {
      // A GET of the probe page is its own probe; anything else asks once.
      const verdict = isProbeUrl(url) && isSafeToReplay(init.method) ? signInVerdict(res) : await this.probe(token, signal);
      if (verdict !== 'signed-in') {
        throw new SessionExpiredError({ capturedAt: sess.capturedAt, hostSignIn: this.hostSignIn || sess.origin === 'host' });
      }
    }
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
  /**
   * Why the router left the direct leg, if it has: the kind (`session`: signed out or none
   * linked; `edge`: the site's edge refused the direct request), a short reason, when, and —
   * hosted — when the direct leg is next tried; `retryAt` is `null` locally, where a
   * relink lifts a session wall and an edge wall stays. Never carries the token.
   */
  wall(): WallInfo | null;
  /**
   * Ask war.app whether the session is signed in (one GET of the invite-token page with it),
   * never throwing: `none` with no session (nothing sent). Signed in, any wall is lifted and the
   * stale flag cleared at once; signed out, the stale flag is set.
   */
  checkSession(): Promise<SignInVerdict | 'none'>;
  /**
   * A key for the state that decides which war.app account answers the next
   * call: the active leg, the stale flag and the linked session's capture time.
   * The cached signed-in account (src/tools/live-context.ts) is discarded when it
   * changes. Never contains the token.
   */
  identityState(): Promise<string>;
}

/** Options for {@link createDirectFirstBridge}. */
interface CreateDirectFirstBridgeOptions {
  /** The session store (M1's `readSession`, wrapped). */
  store: SessionStore;
  /** Build the existing fetchproxy bridge leg, lazily. */
  makeBridge: () => WarappBridge;
  /** The transport pin; defaults to {@link TRANSPORT_ENV} read from `env`. Hosted without a captured token: ignored. */
  mode?: TransportMode;
  /** Env for the default `mode` read and the hosted check (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Test seam: the direct leg's HTTPS primitive (default netguard `fetchPublic`, through the egress proxy when one is set). */
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

/**
 * Hosted, the direct leg is tried again this long after the router leaves it: a hosted
 * child cannot be relinked in-process (its session is the one mcp-host injected at spawn, whose
 * capture time never changes), so without a retry one odd answer — or a passing edge challenge —
 * kept it off the direct leg until the process restarted. Each wall in a row doubles the wait,
 * up to {@link WALL_RETRY_MAX_MS}; a direct success starts it over.
 */
export const WALL_RETRY_BASE_MS = 60_000;
/** The longest wait before a hosted child tries the direct leg again. */
export const WALL_RETRY_MAX_MS = 30 * 60_000;

/** The non-secret facts about a wall, for status and the healthcheck. */
export interface WallInfo {
  kind: 'session' | 'edge';
  /** Why, in a few words (never the token). */
  reason: string;
  /** When the router left the direct leg (ISO-8601). */
  since: string;
  /** Hosted: when the direct leg is next tried (ISO-8601); `null` locally. */
  retryAt: string | null;
}

/** Why the router left the direct leg: a session problem (lifted by a relink) or an edge block (sticky locally). */
type Wall = ({ kind: 'session'; capturedAt: string | null } | { kind: 'edge' }) & {
  reason: string;
  since: number;
  retryAt: number | null;
};

/**
 * Wire the direct leg and the fetchproxy bridge into a direct-first router,
 * returning an object shaped like today's bridge (`ready()` → `{ fetch }`) plus
 * the healthcheck slice. On a direct→bridge fallback the router emits a switch
 * notice (never printing the token). A non-GET whose direct attempt reached
 * war.app is never replayed over the bridge. In `auto`, a session-caused wall
 * is lifted when a NEW session is linked, so the direct leg is retried.
 */
export function createDirectFirstBridge(opts: CreateDirectFirstBridgeOptions): WarappDirectBridge {
  // A hosted child never reads a stored session. With the token mcp-host
  // captured at sign-in it rides the direct leg from that token alone (the
  // given store is not consulted) and resolves its mode as a local process
  // does; without one it is pinned to the browser bridge whatever
  // WARAPP_TRANSPORT (or `mode`) says.
  const env = opts.env ?? process.env;
  const hosted = isHosted(env);
  const hostSession = hosted ? hostedSession(env) : null;
  const pinned = hosted && !hostSession;
  const mode: TransportMode = pinned
    ? 'fetchproxy'
    : (opts.mode ?? readTransportMode(TRANSPORT_ENV, opts.env ? { env: opts.env } : {}));
  const store: SessionStore = hosted ? { read: async () => hostSession } : opts.store;
  const hostSignIn = hostSession !== null;
  const direct = new DirectBridge(store, opts.directFetch ?? createDirectFetch({ env }), hostSignIn);
  const log = opts.log ?? ((m: string) => console.error(m));
  const now = opts.now ?? Date.now;

  let wall: Wall | null = null;
  let stale = false;
  let lastRelinkCheck = Number.NEGATIVE_INFINITY;
  /** Walls in a row since the direct leg last answered 200: the hosted backoff's exponent. */
  let wallsInARow = 0;

  const onFallback = ({ error }: { error: unknown }): void => {
    const why =
      error instanceof SessionExpiredError
        ? 'the linked war.app session is signed out'
        : error instanceof SessionNotLinkedError
          ? 'no war.app session is linked'
          : 'the site edge refused the direct request';
    const since = now();
    wallsInARow += 1;
    const retryAt = hosted ? since + Math.min(WALL_RETRY_BASE_MS * 2 ** (wallsInARow - 1), WALL_RETRY_MAX_MS) : null;
    const timing = { reason: why, since, retryAt };
    const next: Wall =
      error instanceof SessionExpiredError
        ? { kind: 'session', capturedAt: error.capturedAt ?? null, ...timing }
        : error instanceof SessionNotLinkedError
          ? { kind: 'session', capturedAt: null, ...timing }
          : { kind: 'edge', ...timing };
    wall = next;
    log(
      `[warapp-mcp] Direct transport unavailable (${why}) — switching to the ContextMint Bridge browser bridge. ` +
        `Keep a ${SESSION_HOST} tab open and approve the pairing prompt in the extension if one appears` +
        (next.kind !== 'session'
          ? '.'
          : hostSignIn
            ? `. ${HOST_SIGN_IN_ADVICE}`
            : hosted
              ? '.'
              : '; run warapp_link_session to return to the direct transport.'),
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

  /** Lift any wall: a fresh router, back on the direct leg. */
  const liftWall = (): void => {
    if (!wall) return;
    wall = null;
    legs = build();
  };

  /** Lift a session-caused wall: a fresh router, back on the direct leg. An edge wall stays. */
  const liftSessionWall = (): void => {
    if (wall?.kind !== 'session') return;
    liftWall();
  };

  /** Behind a session wall: has a DIFFERENT session been linked since (e.g. by another process)? */
  const relinkedSinceWall = async (): Promise<boolean> => {
    if (wall?.kind !== 'session') return false;
    const t = now();
    if (t - lastRelinkCheck < RELINK_CHECK_MS) return false;
    lastRelinkCheck = t;
    const sess = await store.read();
    return sess !== null && sess.capturedAt !== wall.capturedAt;
  };

  const runOne = async (init: FetchproxyFetchInit): Promise<FetchproxyFetchResult> => {
    if (mode === 'auto' && (await relinkedSinceWall())) {
      liftSessionWall();
      stale = false;
    }
    // Hosted: past the backoff, the direct leg is tried again. A write that reaches
    // war.app signed out on it is still never re-sent over the bridge (below).
    if (mode === 'auto' && wall?.retryAt != null && now() >= wall.retryAt) liftWall();
    // A non-GET whose direct attempt reached war.app (it answered signed-out)
    // is never re-sent over the bridge: a write must never be sent twice.
    let reached: SessionExpiredError | undefined;
    return legs.run(async (leg, ctx) => {
      if (leg === direct) {
        try {
          const res = await direct.fetch(init, ctx.signal);
          // Only a 200 proves the session works; a 5xx says nothing about it.
          if (res.status === 200) {
            stale = false;
            wallsInARow = 0;
          }
          return res;
        } catch (err) {
          if (err instanceof SessionExpiredError) {
            stale = true;
            if (!isSafeToReplay(init.method)) reached = err;
          }
          throw err;
        }
      }
      if (reached) {
        throw new SessionExpiredError({ capturedAt: reached.capturedAt, notResent: true, hostSignIn: reached.hostSignIn });
      }
      return (leg as WarappBridge).ready().then((t) => t.fetch(init));
    });
  };

  return {
    ready: async () => ({ fetch: (init) => runOne(init) }),
    status: () => legs.status(),
    bridgeTransport: () => legs.bridgeTransport(),
    stats: () => legs.stats(),
    sessionStale: () => stale,
    wall: () =>
      wall
        ? {
            kind: wall.kind,
            reason: wall.reason,
            since: new Date(wall.since).toISOString(),
            retryAt: wall.retryAt === null ? null : new Date(wall.retryAt).toISOString(),
          }
        : null,
    checkSession: async () => {
      const verdict = await direct.checkSignedIn();
      if (verdict === 'signed-in') {
        stale = false;
        wallsInARow = 0;
        if (mode === 'auto') liftWall();
      } else if (verdict === 'signed-out') {
        stale = true;
      }
      return verdict;
    },
    sessionLinked: () => {
      stale = false;
      if (mode === 'auto') liftSessionWall();
    },
    identityState: async () => {
      const sess = await store.read();
      return JSON.stringify([legs.status().transport, stale, sess?.capturedAt ?? null]);
    },
  };
}
