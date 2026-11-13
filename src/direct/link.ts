// Linking (and relinking) the chrome-less "direct" session.
//
// The direct transport (src/direct/transport.ts) authenticates every war.app
// request with the signed-in `AuthToken` cookie (live-verified 2026-11-12).
// {@link linkSession} captures that cookie ONCE off the user's signed-in
// war.app tab through the browser bridge (mcp-utils `captureBearerHeader`,
// which snapshots the `Cookie` request header via the fetchproxy server's
// `captureRequestHeader`), extracts the `AuthToken` value, and stores it with
// M1's on-disk hygiene. The bridge is touched only here, never on the hot
// path — once linked, every later call is a plain server-side HTTPS request.
//
// SECURITY: the AuthToken is a FULL-ACCOUNT credential. linkSession never
// returns it, never logs it, never puts it in an error: it returns only when
// the capture happened ({@link LinkResult} is `capturedAt` + `host`). Every
// cookie but `AuthToken` is discarded. A capture that yields no AuthToken
// throws {@link NoAuthTokenError} and stores nothing. Direct mode is
// LOCAL-ONLY — the hosted path keeps the browser bridge and stores no token.
import { McpToolError, readPortEnv } from '@chrischall/mcp-utils';
import { captureBearerHeader, type CaptureBearerHeaderOptions } from '@chrischall/mcp-utils/fetchproxy';
import { isHosted } from '../hosted.js';
import { DEFAULT_WS_PORT, SERVER_NAME, WS_PORT_ENV } from '../transport-bridge.js';
import { VERSION } from '../version.js';
import { scrubError, SESSION_HOST, writeSession, type Session } from './session.js';

/** The cookie that carries the signed-in war.app session. */
export const AUTH_COOKIE = 'AuthToken';

/** The capture waits this long (ms) for the signed-in tab to make a request. */
export const DEFAULT_CAPTURE_WINDOW_MS = 60_000;

/** No `AuthToken` cookie was present on the captured war.app request. */
export class NoAuthTokenError extends McpToolError {
  override name = 'NoAuthTokenError';
  constructor() {
    super(
      `No ${AUTH_COOKIE} cookie was found on the war.app request. Sign in to war.app in the bridged tab, then retry.`,
      { kind: 'no_credential' },
    );
  }
}

/**
 * The `AuthToken` value from a `Cookie` header, or `null` when it is absent or
 * empty. Only an exact `AuthToken` cookie counts; every other cookie (and a
 * name that merely ends in `AuthToken`) is ignored.
 */
export function authTokenFromCookie(cookie: string): string | null {
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== AUTH_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/** What {@link linkSession} reports — never the token. */
export interface LinkResult {
  /** When the session was captured, as an ISO-8601 string. */
  capturedAt: string;
  /** Always {@link SESSION_HOST}. */
  host: typeof SESSION_HOST;
}

/** Options for {@link linkSession}. */
export interface LinkSessionOptions {
  /** Env for the port and the stored-file path. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Test seam: capture the raw `Cookie` header off the signed-in war.app tab.
   * Defaults to {@link captureBearerHeader} through the browser bridge.
   */
  capture?: () => Promise<string>;
  /** Test seam: persist the session. Defaults to M1's {@link writeSession}. */
  save?: (session: Session) => Promise<void>;
  /** Clock for `capturedAt`. Defaults to `new Date()`. */
  now?: () => Date;
  /** How long the capture waits for the tab to make a request (ms). */
  windowMs?: number;
  /** The fetchproxy concentrator port. Defaults to `WARAPP_WS_PORT`. */
  port?: number;
  /** Test seam passed through to {@link captureBearerHeader}. */
  createTransport?: CaptureBearerHeaderOptions['createTransport'];
}

/** The default capture: snapshot the `Cookie` header off a war.app request through the bridge. */
function captureWarappCookie(opts: LinkSessionOptions): Promise<string> {
  const env = opts.env ?? process.env;
  return captureBearerHeader({
    captures: [{ host: SESSION_HOST, headerName: 'Cookie' }],
    domains: [SESSION_HOST],
    windowMs: opts.windowMs ?? DEFAULT_CAPTURE_WINDOW_MS,
    serverName: SERVER_NAME,
    version: VERSION,
    // The AuthToken is parsed out of the whole Cookie header ourselves, so keep
    // it intact (no Bearer-stripping) and never reject on length.
    minLength: 1,
    normalise: (raw) => raw,
    port: opts.port ?? readPortEnv(WS_PORT_ENV, DEFAULT_WS_PORT, { env }),
    what: 'your war.app session',
    guidance:
      'Open a signed-in war.app tab (e.g. war.app/MultiPlayer) and load or click into a game so the tab sends a ' +
      'request, then retry.',
    transportOptions: { env },
    ...(opts.createTransport ? { createTransport: opts.createTransport } : {}),
  });
}

/**
 * Capture the signed-in war.app session cookie through the bridge, extract the
 * `AuthToken`, and store it (M1). Returns only {@link LinkResult} — when and
 * where, never the token. Throws {@link NoAuthTokenError} (storing nothing)
 * when the captured cookie carries no `AuthToken`.
 */
export async function linkSession(opts: LinkSessionOptions = {}): Promise<LinkResult> {
  // Local-only: a hosted child never pulls the full-account cookie into memory
  // (the tool is not registered there, and writeSession refuses too).
  if (isHosted(opts.env ?? process.env)) {
    throw new McpToolError('The direct transport is local-only: a hosted server never links a war.app session.', {
      kind: 'unknown',
    });
  }
  const cookie = await (opts.capture ?? (() => captureWarappCookie(opts)))();
  const authToken = authTokenFromCookie(cookie);
  if (!authToken) throw new NoAuthTokenError();
  const capturedAt = (opts.now?.() ?? new Date()).toISOString();
  const session: Session = { authToken, capturedAt, host: SESSION_HOST };
  try {
    await (opts.save ?? ((s: Session) => writeSession(s, opts.env)))(session);
  } catch (err) {
    // Whatever failed after the capture never carries the token or the rest
    // of the captured cookie (other session cookies) out in its error.
    throw scrubError(err, [authToken, cookie]);
  }
  return { capturedAt, host: SESSION_HOST };
}
