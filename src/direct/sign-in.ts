// Signing in to war.app with an email and password, for mcp-host's hosted
// sign-in flow (#333, part B; owner decision "Build it, token only").
//
// The flow (docs/examples/warapp-auth-flow.json) asks for the war.app password
// once, masked, and calls `warapp_sign_in` as its `capture`: the result's
// `authToken` becomes the per-user secret WARAPP_AUTH_TOKEN, which the hosted
// child then rides the direct leg on (src/direct/session.ts `hostedSession`).
// The password is used for this one exchange and never stored.
//
// The exchange, as traced live on #333 (one cookie-less GET, nothing submitted):
//  1. GET https://war.app/LogIn — it sets `jses_WS60`, `FirstReferrer` and
//     `AWSELB` before any sign-in; they are carried to the POST.
//  2. POST the form `LoginForm` to the same URL: exactly `Email`, `Password`,
//     `KeepSignedIn=on` (no hidden fields, no captcha on the page).
//  3. Success is an `AuthToken` cookie set on ANY hop: the POST's answer or a
//     redirect after it (how a success answers is not verified live yet).
//
// Rules:
//  - ONE attempt, never retried: war.app (like every service) may count failed
//    sign-ins, and mcp-host treats a refused credential as terminal anyway.
//  - The password is sent once: every redirect, after the POST too, is followed
//    as a GET without a body (a 307/308 included), so it is never re-sent.
//  - Every hop is the exact origin https://war.app; a redirect anywhere else is
//    refused without being requested. Redirects are followed by hand, a few at
//    most, so each hop's Set-Cookie is read.
//  - The result is `{ authToken }` and nothing else about the account. A
//    refusal (wrong credentials, a bot check, a network failure) is an error
//    whose message and hint never hold the email, the password or any cookie
//    value: each is scrubbed BY VALUE, and the cause chain is dropped.
//  - The single-hop fetch goes through mcp-utils netguard's public-only
//    dispatcher (a name that resolves or rebinds inward is refused), with one
//    deadline over the whole exchange and a byte cap on each body. With an
//    egress proxy configured (HTTPS_PROXY: mcp-host's only way out) it goes
//    through a proxy agent instead (src/direct/egress.ts); a proxy that is set
//    but unusable is refused before anything is sent.
import { detectEdgeBlock, McpToolError, type McpToolErrorKind } from '@chrischall/mcp-utils';
import { createPublicOnlyDispatcher } from '@chrischall/mcp-utils/netguard';
import { type Dispatcher, fetch as undiciFetch } from 'undici';
import type { EnvSource } from '@chrischall/mcp-utils';
import { defaultProxyAgent, egressProxyUrl, type ProxyAgentFactory } from './egress.js';
import { scrubSecrets, type SecretValue } from '../redact.js';
import { isPlausibleAuthToken, SESSION_HOST } from './session.js';
import { hasPasswordInput } from './transport.js';

/** The one origin the sign-in talks to. */
const ORIGIN = `https://${SESSION_HOST}`;

/** war.app's sign-in page; its form posts to the page's own URL (#333 trace). */
export const SIGN_IN_URL = `${ORIGIN}/LogIn`;

/** The cookie that carries the signed-in session. */
const AUTH_COOKIE = 'AuthToken';

/** Redirects followed after the GET, and after the POST (each as a GET). */
const MAX_REDIRECTS = 3;

/** A cookie value this long or longer is scrubbed from refusal text. */
const MIN_SCRUBBED_COOKIE = 6;

/** One deadline (ms) over the whole exchange: every hop and every body read. */
export const SIGN_IN_TIMEOUT_MS = 30_000;

/** Byte cap on each response body (the sign-in page is a few tens of KB). */
export const SIGN_IN_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** One HTTP response, never a followed redirect. */
export interface SignInResponse {
  status: number;
  /** Lower-cased header names; `set-cookie` is in {@link setCookies} instead. */
  headers: Record<string, string>;
  /** Every `Set-Cookie` header of this response, one string each. */
  setCookies: string[];
  body: string;
}

/** A single-hop request primitive: it must NOT follow redirects. A test seam. */
export type SignInFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<SignInResponse>;

/** The credentials the flow passes. Never logged, never in an error. */
export interface SignInCredentials {
  email: string;
  password: string;
}

/** What a sign-in returns: the session cookie's value, and nothing else. */
export interface SignInResult {
  authToken: string;
}

export interface SignInOptions {
  /** The single-hop fetch. Defaults to {@link createSignInFetch}'s public-only fetch. */
  fetch?: SignInFetch;
  /** The deadline over the whole exchange (ms). Defaults to {@link SIGN_IN_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** The caller's cancellation. */
  signal?: AbortSignal;
  /** Env for the egress proxy read by the default fetch (default `process.env`). */
  env?: EnvSource;
}

/** Options for {@link createSignInFetch}. */
export interface SignInFetchOptions {
  /** Send through this dispatcher, left open (tests). Default: the egress proxy, else public-only. */
  dispatcher?: Dispatcher;
  maxBytes?: number;
  /** Env for the egress proxy (default `process.env`). */
  env?: EnvSource;
  /** Builds the proxy agent (a test seam; default undici's `ProxyAgent`). */
  proxyAgent?: ProxyAgentFactory;
}

/**
 * The default single-hop fetch: undici, redirects never followed, through the
 * egress proxy when one is configured (src/direct/egress.ts), else through a
 * public-only dispatcher. A proxy that is set but unusable throws here, before
 * any request.
 */
export function createSignInFetch(opts: SignInFetchOptions = {}): SignInFetch {
  const maxBytes = opts.maxBytes ?? SIGN_IN_MAX_BODY_BYTES;
  // Read (and a bad proxy refused) now, before any request; an agent is built per hop and closed.
  const proxy = opts.dispatcher ? undefined : egressProxyUrl(opts.env ?? process.env);
  const makeProxy = opts.proxyAgent ?? defaultProxyAgent;
  return async (url, init) => {
    const owned = opts.dispatcher ? undefined : proxy ? makeProxy(proxy) : createPublicOnlyDispatcher();
    try {
      const res = await undiciFetch(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        redirect: 'manual',
        dispatcher: opts.dispatcher ?? owned!,
        signal: init.signal,
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (k.toLowerCase() !== 'set-cookie') headers[k.toLowerCase()] = v;
      });
      const setCookies = res.headers.getSetCookie();
      const body = await readCapped(res.body as AsyncIterable<Uint8Array> | null, maxBytes);
      return { status: res.status, headers, setCookies, body };
    } finally {
      await owned?.close().catch(() => {});
    }
  };
}

/** A response body as text, refusing past `maxBytes`. */
async function readCapped(body: AsyncIterable<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new McpToolError(`war.app's sign-in answered with more than ${maxBytes} bytes.`, { kind: 'too_large' });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The cookie a `Set-Cookie` header sets, or `null` for a deletion (an empty
 * value, `Max-Age` of zero or less, or an `Expires` in the past) — the value is
 * then `null` so the jar drops it.
 */
export function parseSetCookie(header: string, now: number = Date.now()): { name: string; value: string | null } | null {
  const [pair = '', ...attrs] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  if (!name) return null;
  let value: string | null = pair.slice(eq + 1).trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
  for (const attr of attrs) {
    const i = attr.indexOf('=');
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? '' : attr.slice(i + 1).trim();
    if (key === 'max-age' && /^-?\d+$/.test(v) && Number(v) <= 0) value = null;
    if (key === 'expires') {
      const t = Date.parse(v);
      if (!Number.isNaN(t) && t <= now) value = null;
    }
  }
  if (value === '') value = null;
  return { name, value };
}

/** Whether `url` is exactly on https://war.app (no other port, no userinfo). */
function onWarapp(url: URL): boolean {
  return url.origin === ORIGIN && url.username === '' && url.password === '';
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Bot-check markup: a captcha widget or a hosted challenge script. */
const CHALLENGE_MARKUP =
  /g-recaptcha|grecaptcha|recaptcha\/api|h-captcha|hcaptcha\.com|cf-turnstile|challenges\.cloudflare\.com/i;

/** Why the sign-in was refused, as the error's kind and message. */
const NOT_RETRIED = 'It was not retried, because war.app may count failed sign-ins.';

function refusal(kind: McpToolErrorKind, message: string, hint?: string): McpToolError {
  return new McpToolError(message, { kind, ...(hint ? { hint } : {}) });
}

/** A bot check answered instead of war.app's page: the credential was never judged. */
function challenge(what: string): McpToolError {
  return refusal(
    'edge_blocked',
    `war.app answered the sign-in with ${what}, which this connector cannot answer. ${NOT_RETRIED}`,
    'Wait a while and use Sign in on the connection again. Until then the connection still works through the war.app tab (the browser bridge); if it keeps happening, report it.',
  );
}

/** A bot check on a response, or `null`: an edge block, a 429, a 403 or captcha markup. */
function challengeIn(res: SignInResponse): McpToolError | null {
  const edge = detectEdgeBlock({ body: res.body, headers: res.headers, status: res.status });
  if (edge) return challenge(`a ${edge.vendor} bot check`);
  if (res.status === 429) return challenge('"too many requests" (HTTP 429)');
  if (CHALLENGE_MARKUP.test(res.body)) return challenge('a captcha');
  if (res.status === 403) return challenge('a refusal (HTTP 403)');
  return null;
}

/**
 * Sign in to war.app once with `email` and `password` and return the
 * `AuthToken` cookie it sets. Throws an {@link McpToolError} on any refusal —
 * `credential_rejected` (the form came back), `edge_blocked` (a captcha, a CDN
 * challenge, 403 or 429), `transport` / `timeout` (network), `http` / `unknown`
 * otherwise — whose text never holds the email, the password or a cookie value.
 */
export async function signIn(creds: SignInCredentials, opts: SignInOptions = {}): Promise<SignInResult> {
  const jar = new Map<string, string>();
  // Cookie values shorter than MIN_SCRUBBED_COOKIE are not secrets (`FirstReferrer=x`) and would
  // shred every word holding that letter; the email and the password are scrubbed whatever their length.
  const secrets = (): SecretValue[] => [
    { value: creds.email, anyCase: true },
    creds.password,
    ...[...jar.values()].filter((v) => v.length >= MIN_SCRUBBED_COOKIE),
  ];
  try {
    return await exchange(creds, jar, opts);
  } catch (err) {
    throw scrubbed(err, secrets());
  }
}

async function exchange(creds: SignInCredentials, jar: Map<string, string>, opts: SignInOptions): Promise<SignInResult> {
  if (!creds.email.trim() || !creds.password) {
    throw refusal('no_credential', 'Signing in to war.app needs both the email and the password; nothing was sent.');
  }
  const fetchHop = opts.fetch ?? createSignInFetch(opts.env ? { env: opts.env } : {});
  const timeoutMs = opts.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let posted = false;

  const hop = async (url: URL, method: 'GET' | 'POST', body?: string): Promise<SignInResponse> => {
    const headers: Record<string, string> = { accept: 'text/html,application/xhtml+xml' };
    if (jar.size > 0) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers.origin = ORIGIN;
      headers.referer = SIGN_IN_URL;
    }
    let res: SignInResponse;
    try {
      res = await fetchHop(url.href, { method, headers, ...(body !== undefined ? { body } : {}), signal });
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      const after = posted
        ? ' The sign-in may or may not have reached war.app; it was not retried.'
        : ' Nothing was sent to war.app.';
      if (timeout.aborted) {
        throw refusal('timeout', `war.app did not answer the sign-in within ${Math.round(timeoutMs / 1000)} s.${after}`);
      }
      if (err instanceof McpToolError && err.kind === 'too_large') throw err;
      throw refusal('transport', `Could not reach war.app to sign in.${after}`);
    }
    for (const header of res.setCookies) {
      const c = parseSetCookie(header);
      if (!c) continue;
      if (c.value === null) jar.delete(c.name);
      else jar.set(c.name, c.value);
    }
    return res;
  };

  /**
   * Follow `res`'s redirects (as GETs, within war.app) until a final answer or, once the POST
   * has gone, the AuthToken. Before the POST an AuthToken ends nothing: it is not this
   * account's (the page phase drops it), and stopping on a redirect would read as no form.
   */
  const follow = async (from: URL, first: SignInResponse): Promise<{ url: URL; res: SignInResponse }> => {
    let url = from;
    let res = first;
    for (let n = 0; ; n++) {
      if (posted && jar.has(AUTH_COOKIE)) return { url, res };
      const location = REDIRECTS.has(res.status) ? res.headers.location : undefined;
      if (!location) return { url, res };
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw refusal('unknown', `war.app redirected the sign-in to an address that does not parse. ${NOT_RETRIED}`);
      }
      if (!onWarapp(next)) {
        throw refusal('unknown', `war.app redirected the sign-in away from ${ORIGIN}; it was not followed. ${NOT_RETRIED}`);
      }
      if (n >= MAX_REDIRECTS) {
        throw refusal('unknown', `war.app redirected the sign-in more than ${MAX_REDIRECTS} times. ${NOT_RETRIED}`);
      }
      url = next;
      res = await hop(url, 'GET');
    }
  };

  // 1. The sign-in page, for its cookies (and to see its form before any attempt).
  const page = await follow(new URL(SIGN_IN_URL), await hop(new URL(SIGN_IN_URL), 'GET'));
  const pageCheck = challengeIn(page.res);
  if (pageCheck) throw pageCheck;
  if (page.res.status !== 200 || !hasPasswordInput(page.res.body)) {
    throw refusal(
      'http',
      `war.app's sign-in page did not show its form (HTTP ${page.res.status}); no password was sent.`,
      'war.app may be down or have changed its sign-in page. Try Sign in again later.',
    );
  }
  // A session from the page alone is not this account's: only one the POST earns counts.
  jar.delete(AUTH_COOKIE);

  // 2. The one attempt.
  const form = new URLSearchParams({ Email: creds.email.trim(), Password: creds.password, KeepSignedIn: 'on' });
  posted = true;
  const postUrl = new URL(SIGN_IN_URL);
  const done = await follow(postUrl, await hop(postUrl, 'POST', form.toString()));

  // 3. Success is the AuthToken, set on any hop.
  const token = jar.get(AUTH_COOKIE);
  if (token) {
    if (isPlausibleAuthToken(token)) return { authToken: token };
    // Kept, it would be a secret the hosted child ignores (src/direct/session.ts `hostedSession`).
    throw refusal(
      'unknown',
      'war.app signed in, but its session cookie is not in a shape this connector can use; it was not kept.',
      'war.app may have changed its session cookie. Report this; nothing was retried.',
    );
  }

  const check = challengeIn(done.res);
  if (check) throw check;
  // The form came back (on the POST's answer, or after a redirect to the sign-in page).
  if (hasPasswordInput(done.res.body)) {
    throw refusal(
      'credential_rejected',
      `war.app refused the sign-in: the email or password is not right (its sign-in form came back). ${NOT_RETRIED}`,
      'Check the war.app password (and the email on this connection), then use Sign in on the connection again.',
    );
  }
  throw refusal(
    done.res.status >= 400 ? 'http' : 'unknown',
    `war.app answered the sign-in (HTTP ${done.res.status}) without setting a session. ${NOT_RETRIED}`,
    'war.app may have changed how it signs in. Try Sign in again later.',
  );
}

/** `err` rebuilt with every secret scrubbed out of its message and hint, and no cause. */
function scrubbed(err: unknown, secrets: SecretValue[]): McpToolError {
  const e = err as { message?: unknown; hint?: unknown; kind?: unknown };
  const scrub = (s: string) => scrubSecrets(s, secrets);
  const message = scrub(typeof e?.message === 'string' ? e.message : String(err));
  const kind: McpToolErrorKind = err instanceof McpToolError && err.kind ? err.kind : 'unknown';
  return new McpToolError(message, { kind, ...(typeof e?.hint === 'string' ? { hint: scrub(e.hint) } : {}) });
}
