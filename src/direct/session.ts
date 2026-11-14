// The signed-in war.app session for the chrome-less "direct" transport.
//
// The AuthToken cookie is a FULL-ACCOUNT credential (live-verified 2026-11-12
// to authenticate both the server-rendered pages and the binary /Services
// protocol on its own). It is stored at `<dataDir>/session.json`
// (`WARAPP_SESSION_FILE` overrides): directory `0700` (an existing directory
// of ours is tightened to it; another user's is refused, and so is root's when
// others can write to it; on macOS any ACL on our directory and on the file is
// removed, since mode bits do not govern ACLs), file `0600`, written atomically through a randomly named tmp file
// created exclusively (never an existing file, never through a symlink) and
// renamed into place, so a crash never leaves a half-written token.
//
// SECURITY: treat the AuthToken exactly like WARAPP_API_TOKEN — never log it,
// never put it in a tool result, never leave it in an error or hint string.
// {@link scrubToken} removes it from any upstream string BY VALUE (reusing
// mcp-utils `stripBearer`, so a `Cookie:`/`Bearer`-prefixed form is caught too,
// and src/redact.ts, so its encoded spellings are too).
//
// Deferred, like every other credential in this server: nothing here runs at
// import time, the server boots without a session, and a missing OR corrupt
// file reads as `null` — never a throw.
//
// LOCAL-ONLY: on a hosted child (src/hosted.ts) the store reads as empty — a
// session file already in the data dir is never read — and refuses to write.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { McpToolError, readEnvVar, type EnvSource } from '@chrischall/mcp-utils';
import { stripBearer } from '@chrischall/mcp-utils/fetchproxy';
import { dataDir } from '../config.js';
import { isHosted } from '../hosted.js';
import { scrubSecrets } from '../redact.js';

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
 * {@link writeSession} makes the containing directory `0700`, so the variable
 * should name a file in a directory of its own, not a shared folder.
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
  if (isHosted(env)) return null;
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
  if (isHosted(env)) return null;
  try {
    return parseSession(JSON.parse(readFileSync(sessionFilePath(env), 'utf8')));
  } catch {
    return null;
  }
}

/** What {@link writeSession} does with the session file's directory. */
type SessionDirVerdict = 'ok' | 'tighten' | 'refuse';

/**
 * Judge the session directory from its `stat` and this process's uid
 * (`undefined` where there are no POSIX owners: nothing to check). Ours with
 * any group/other bit → `tighten` (to `0700`). Root's and writable by group or
 * others → `refuse` (someone else could plant or swap files in it). Another
 * user's → `refuse` whatever its mode bits say: we could write into it only
 * through an ACL its owner controls, and the owner could add an inheritable
 * entry that reaches the session file.
 */
export function sessionDirVerdict(st: { mode: number; uid: number }, myUid: number | undefined): SessionDirVerdict {
  if (myUid === undefined) return 'ok';
  if (st.uid === myUid) return (st.mode & 0o077) !== 0 ? 'tighten' : 'ok';
  if (st.uid !== 0) return 'refuse';
  return (st.mode & 0o022) !== 0 ? 'refuse' : 'ok';
}

const run = promisify(execFile);

/**
 * macOS ACLs: the mode bits do not govern them, so `chmod 0700` leaves an
 * "everyone allow read" entry in place, and an inheritable one on the
 * directory is copied onto every file created in it — the session file
 * included, whatever mode it was created with. On darwin these strip and
 * detect an extended ACL with the system tools (Node has no ACL API). Linux
 * POSIX ACLs need nothing here: their named entries are capped by the mask,
 * which `0700`/`0600` set to nothing. Paths are absolute (never read as flags).
 */
const MACOS_ACLS = process.platform === 'darwin';

/**
 * Whether `ls -led` output lists an ACL entry (` 0: group:everyone allow …` on
 * a line after the first). The mode string's `+` is not enough: with extended
 * attributes as well, macOS prints `@` there instead.
 */
export function lsShowsAcl(stdout: string): boolean {
  return stdout
    .split('\n')
    .slice(1)
    .some((line) => /^\s*\d+: /.test(line));
}

async function hasAcl(path: string): Promise<boolean> {
  const { stdout } = await run('/bin/ls', ['-led', path]);
  return lsShowsAcl(stdout);
}

/** Remove every ACL entry from `path` (ours), then refuse unless none is left. */
async function stripAcl(path: string, what: string): Promise<void> {
  await run('/bin/chmod', ['-N', path]);
  if (await hasAcl(path)) {
    throw new McpToolError(`Refusing to store the war.app session: could not remove the access control list on ${what}.`, {
      hint: 'Point WARAPP_SESSION_FILE (or MCP_DATA_DIR) at a directory only you can read, with no ACL (`ls -le`).',
    });
  }
}

/** A fresh, unpredictable tmp file name next to `path`. */
export function sessionTmpPath(path: string): string {
  return `${path}.${randomBytes(16).toString('hex')}.tmp`;
}

/**
 * Store a session: the directory is created `0700` (an existing one of ours is
 * tightened to `0700`; one others can write to that is not ours is refused),
 * and the file is written `0600` atomically — a randomly named tmp file,
 * created exclusively (it never opens an existing file or follows a symlink),
 * then renamed over the target; the tmp file is removed if anything fails.
 * Unlike {@link readSession} this propagates I/O errors, so a deliberate link
 * action can report that it failed.
 */
export async function writeSession(session: Session, env: EnvSource = process.env): Promise<void> {
  if (isHosted(env)) {
    throw new McpToolError('The direct transport is local-only: a hosted server never stores a war.app session.', {
      kind: 'unknown',
    });
  }
  const path = resolve(sessionFilePath(env));
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode applies only to a directory it creates.
  const st = await stat(dir);
  const myUid = process.getuid?.();
  const verdict = sessionDirVerdict(st, myUid);
  if (verdict === 'refuse') {
    throw new McpToolError(`Refusing to store the war.app session in ${dir}: it is not yours, and others could reach files in it.`, {
      hint: 'Point WARAPP_SESSION_FILE (or MCP_DATA_DIR) at a directory of your own that only you can write to.',
    });
  }
  if (verdict === 'tighten') await chmod(dir, 0o700);
  if (MACOS_ACLS) {
    // Before the file exists: an inheritable entry would be copied onto it at
    // creation, and a reader that opened it then would keep that access.
    if (st.uid === myUid) await stripAcl(dir, dir);
    else if (await hasAcl(dir)) {
      throw new McpToolError(`Refusing to store the war.app session in ${dir}: it carries an access control list and is not yours.`, {
        hint: 'Point WARAPP_SESSION_FILE (or MCP_DATA_DIR) at a directory of your own that only you can read.',
      });
    }
  }
  const tmp = sessionTmpPath(path);
  // 'wx' = O_CREAT | O_EXCL: fails on any existing entry, a symlink included.
  const file = await open(tmp, 'wx', 0o600);
  try {
    try {
      // Still empty: make sure it carries nothing but 0600 before the token goes in.
      await file.chmod(0o600);
      if (MACOS_ACLS) await stripAcl(tmp, 'the session file');
      await file.writeFile(JSON.stringify(session));
    } finally {
      await file.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** Remove the stored session. A no-op (never throws) when none is linked. */
export async function clearSession(env: EnvSource = process.env): Promise<void> {
  await rm(sessionFilePath(env), { force: true });
}

/** The marker a scrubbed AuthToken leaves behind. */
const SCRUBBED = '[warapp-session]';

/**
 * Remove `token` from `s` by value — the raw value and its
 * {@link stripBearer}-normalised form (so a `Cookie: AuthToken=…` or
 * `Bearer …` slice is caught), each in every spelling src/redact.ts knows
 * (JSON-escaped, percent-encoded, form-encoded), so a token echoed in a URL,
 * a form body or a JSON string is caught. Wire this around any upstream string
 * that could carry the session, the way the GameFeed client scrubs the email
 * and API token. A falsy token leaves `s` unchanged.
 */
export function scrubToken(s: string, token: string | null | undefined): string {
  if (!token) return s;
  return scrubSecrets(s, [token, stripBearer(token)], SCRUBBED);
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
function errorCarriesToken(err: unknown, tokens: ReadonlyArray<string | null | undefined>): boolean {
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
