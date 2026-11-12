// The signed-in war.app session for the chrome-less "direct" transport.
//
// The AuthToken cookie is a FULL-ACCOUNT credential (live-verified 2026-11-12
// to authenticate both the server-rendered pages and the binary /Services
// protocol on its own). It is stored at `<dataDir>/session.json`
// (`WARAPP_SESSION_FILE` overrides), with the same on-disk hygiene as the
// board cache (src/trend.ts): directory `0700`, file `0600`, written
// atomically (tmp + rename) so a crash never leaves a half-written token.
//
// SECURITY: treat the AuthToken exactly like WARAPP_API_TOKEN — never log it,
// never put it in a tool result, never leave it in an error or hint string.
// {@link scrubToken} removes it from any upstream string BY VALUE (reusing
// mcp-utils `stripBearer`, so a `Cookie:`/`Bearer`-prefixed form is caught too).
//
// Deferred, like every other credential in this server: nothing here runs at
// import time, the server boots without a session, and a missing OR corrupt
// file reads as `null` — never a throw.
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { McpToolError, readEnvVar, type EnvSource } from '@chrischall/mcp-utils';
import { stripBearer } from '@chrischall/mcp-utils/fetchproxy';
import { dataDir } from '../config.js';

/** The only host a session is ever stored for. */
export const SESSION_HOST = 'war.app';

/** A linked war.app session: the AuthToken, when it was captured, and its host. */
export interface Session {
  /** The `AuthToken` cookie value — a full-account credential. */
  authToken: string;
  /** When the token was captured, as an ISO-8601 string. */
  capturedAt: string;
  /** Always {@link SESSION_HOST}; a file for any other host is ignored. */
  host: typeof SESSION_HOST;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Where the session is stored: `WARAPP_SESSION_FILE` if set, else
 * `<dataDir>/session.json` (the same `dataDir` the client bundle cache uses).
 */
export function sessionFilePath(env: EnvSource = process.env): string {
  return readEnvVar('WARAPP_SESSION_FILE', { env }) ?? join(dataDir(env), 'session.json');
}

/** Parse a decoded session record, returning `null` for any unusable shape. */
function parseSession(raw: unknown): Session | null {
  if (!isRec(raw)) return null;
  const { authToken, capturedAt, host } = raw;
  if (typeof authToken !== 'string' || authToken.length === 0) return null;
  if (typeof capturedAt !== 'string' || capturedAt.length === 0) return null;
  if (host !== SESSION_HOST) return null;
  return { authToken, capturedAt, host };
}

/**
 * The linked session, or `null` when none is linked or the file is missing or
 * unusable (wrong shape, wrong host, not JSON). Never throws.
 */
export async function readSession(env: EnvSource = process.env): Promise<Session | null> {
  try {
    return parseSession(JSON.parse(await readFile(sessionFilePath(env), 'utf8')));
  } catch {
    return null;
  }
}

/**
 * {@link readSession}'s synchronous twin, for the one caller that needs the
 * session inside a synchronous getter (the adaptive healthcheck's `path`, which
 * reports only the non-secret linked/`capturedAt` facts — never the token).
 * Same guarantees: a missing or corrupt file reads as `null`, never a throw.
 */
export function readSessionSync(env: EnvSource = process.env): Session | null {
  try {
    return parseSession(JSON.parse(readFileSync(sessionFilePath(env), 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Store a session, creating the directory `0700` and the file `0600`, written
 * atomically (write a per-pid tmp file, then rename over the target). Unlike
 * {@link readSession} this propagates I/O errors, so a deliberate link action
 * can report that it failed.
 */
export async function writeSession(session: Session, env: EnvSource = process.env): Promise<void> {
  const path = sessionFilePath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(session), { mode: 0o600 });
  await rename(tmp, path);
}

/** Remove the stored session. A no-op (never throws) when none is linked. */
export async function clearSession(env: EnvSource = process.env): Promise<void> {
  await rm(sessionFilePath(env), { force: true });
}

/** The marker a scrubbed AuthToken leaves behind. */
const SCRUBBED = '[warapp-session]';

/**
 * Remove `token` from `s` by value — the raw value, its
 * {@link stripBearer}-normalised form (so a `Cookie: AuthToken=…` or
 * `Bearer …` slice is caught) and its URL-encoded form (so a token echoed in
 * a URL or form body is caught). Wire this around any upstream string that
 * could carry the session, the way the GameFeed client scrubs the email and
 * API token. A falsy token leaves `s` unchanged.
 */
export function scrubToken(s: string, token: string | null | undefined): string {
  if (!token) return s;
  const bare = stripBearer(token);
  // Longest first, so a longer form is never left half-scrubbed by a shorter one.
  const values = [...new Set([token, bare, encodeURIComponent(token), encodeURIComponent(bare)])]
    .filter((v) => v.length > 0)
    .sort((a, b) => b.length - a.length);
  let out = s;
  for (const value of values) out = out.split(value).join(SCRUBBED);
  return out;
}

/** Every string an error carries that could reach a caller: message, hint, stack, and its cause chain. */
function errorStrings(err: unknown, depth = 0): string[] {
  if (depth > 4 || typeof err !== 'object' || err === null) return typeof err === 'string' ? [err] : [];
  const e = err as { message?: unknown; hint?: unknown; stack?: unknown; cause?: unknown };
  const own = [e.message, e.hint, e.stack].filter((v): v is string => typeof v === 'string');
  return [...own, ...errorStrings(e.cause, depth + 1)];
}

/**
 * Whether any of `tokens` (in any {@link scrubToken} form) appears anywhere in
 * `err` — its message, hint, stack, or a short `cause` chain.
 */
export function errorCarriesToken(err: unknown, tokens: ReadonlyArray<string | null | undefined>): boolean {
  const strings = errorStrings(err);
  return tokens.some((t) => !!t && strings.some((s) => scrubToken(s, t) !== s));
}

/**
 * `err` with every form of each of `tokens` removed: returned unchanged when
 * none appears anywhere in it (message, hint, stack, cause chain); otherwise
 * rebuilt as an {@link McpToolError} carrying the scrubbed message and hint and
 * the original `kind`/`status`, with NO `cause` (the cause is where a token
 * could still hide) and a fresh stack.
 */
export function scrubError(err: unknown, tokens: ReadonlyArray<string | null | undefined>): unknown {
  if (!errorCarriesToken(err, tokens)) return err;
  // Longest first, so a token inside a longer one (the AuthToken inside the
  // whole captured Cookie header) never leaves the longer one half-scrubbed.
  const ordered = tokens.filter((t): t is string => !!t).sort((a, b) => b.length - a.length);
  const scrub = (s: string) => ordered.reduce<string>((acc, t) => scrubToken(acc, t), s);
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    message?: unknown;
    hint?: unknown;
    kind?: unknown;
    status?: unknown;
  };
  const message = scrub(typeof e.message === 'string' ? e.message : String(err));
  const kind = err instanceof McpToolError && err.kind ? err.kind : 'transport';
  return new McpToolError(message, {
    kind,
    ...(typeof e.status === 'number' ? { status: e.status } : {}),
    ...(typeof e.hint === 'string' ? { hint: scrub(e.hint) } : {}),
  });
}
