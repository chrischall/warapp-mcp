// The war.app client bundle, fetched at runtime and cached — never vendored.
//
// A war.app page loads the client as `<script src="https://warappcdn.com/js/Release/ujs.js?v=<n>">`.
// The bundle's generated readers are the authority on every wire class layout, and those
// layouts (and the minified names) change between client releases, so this module:
//   1. fetches a war.app page and discovers the current bundle URL and version,
//   2. reuses `<dataDir>/bundle/<version>.js` if present and it still matches the SHA-256
//      recorded beside it at download (`<version>.js.sha256`), else downloads and caches it,
//   3. exposes `readClass(typeName | var, reader)` keyed by the stable registered type
//      name (e.g. `warlight.shared.LatestGameInfo`), evaluated by `BundleInterpreter`.
// Fetching is injected so the transport (and tests) decide how pages are retrieved.

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Reader } from './codec.js';
import { BundleInterpreter, parseBundle, type DialectCheck, type InterpOptions, type ReadBudget } from './interp.js';

/** A page that loads the game client (the homepage does not). */
export const DEFAULT_PAGE_URL = 'https://war.app/MultiPlayer';
/** The only host the bundle is downloaded from (exactly this host: no subdomain, no port). */
export const BUNDLE_HOST = 'warappcdn.com';
/** The only path the bundle is downloaded from; its `v` query parameter is the only variable. */
export const BUNDLE_PATH = '/js/Release/ujs.js';
/** How long the bundle download may take, headers and body together. */
export const BUNDLE_FETCH_TIMEOUT_MS = 120_000;
/** The most bytes the bundle download may carry (the bundle is about 17 MB). */
export const BUNDLE_MAX_BYTES = 64 * 1024 * 1024;

export type BundleErrorKind = 'no-script' | 'bad-url' | 'bad-version' | 'bad-bundle' | 'dialect-mismatch';

export class BundleError extends Error {
  constructor(
    readonly kind: BundleErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'BundleError';
  }
}

export interface BundleSource {
  url: string;
  /** Cache key: the URL's `v` parameter. */
  version: string;
}

const SCRIPT_RE = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']*\/ujs\.js(?:\?[^"']*)?)["']/i;
const SAFE_VERSION = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Find the client bundle's URL and version in a war.app page. The location is pinned:
 * `https://` + exactly {@link BUNDLE_HOST} + exactly {@link BUNDLE_PATH} + `?v=<version>`,
 * nothing else — the page only gets to choose the version.
 */
export function discoverBundleUrl(html: string, pageUrl: string): BundleSource {
  const m = SCRIPT_RE.exec(html);
  if (!m) throw new BundleError('no-script', `no ujs.js script tag on ${pageUrl}`);
  const src = m[1].replace(/&amp;/g, '&');
  const url = new URL(src, pageUrl);
  if (url.protocol !== 'https:') throw new BundleError('bad-url', `bundle URL is not https: ${url.href}`);
  if (url.host !== BUNDLE_HOST || url.username || url.password) {
    throw new BundleError('bad-url', `bundle host not allowed: ${url.host} (only ${BUNDLE_HOST})`);
  }
  if (url.pathname !== BUNDLE_PATH) {
    throw new BundleError('bad-url', `bundle path not allowed: ${url.pathname} (only ${BUNDLE_PATH})`);
  }
  if (url.hash) throw new BundleError('bad-url', 'bundle URL must not carry a fragment');
  const keys = [...url.searchParams.keys()];
  if (keys.some((k) => k !== 'v') || keys.length > 1) {
    throw new BundleError('bad-url', `bundle URL query must be only ?v=<version>: ${url.search}`);
  }
  const version = url.searchParams.get('v');
  if (version === null) throw new BundleError('bad-version', 'bundle URL carries no version (?v=)');
  if (!SAFE_VERSION.test(version) || version === '.' || version === '..') {
    throw new BundleError('bad-version', `bundle version is not a safe file name: ${JSON.stringify(version)}`);
  }
  return { url: `https://${BUNDLE_HOST}${BUNDLE_PATH}?v=${version}`, version };
}

/** A loaded bundle: reads wire classes by stable type name. */
export class WarappBundle {
  private readonly interp: BundleInterpreter;

  /** Loaded from the cache because the current version could not be looked up. */
  fallback = false;

  constructor(
    src: string,
    readonly version: string,
    opts: InterpOptions = {},
  ) {
    this.interp = new BundleInterpreter(parseBundle(src), opts);
    // The built-in reader helpers are pinned to one client release while the bundle floats:
    // refuse a bundle whose own helpers read differently, rather than decode it wrongly (#131).
    this.dialectCheck = this.interp.verifyDialect();
    if (this.dialectCheck.mismatched.length) {
      throw new BundleError(
        'dialect-mismatch',
        `war.app's client bundle ${version} reads ${this.dialectCheck.mismatched.join(', ')} differently from this ` +
          "server's built-in readers; the client changed and this server needs an update to read it.",
      );
    }
  }

  /** The built-in reader helpers checked against this bundle's own definitions at load. */
  readonly dialectCheck: DialectCheck;

  /** Whether a type name is registered in this bundle. */
  has(typeName: string): boolean {
    return this.interp.bundle.varOf.has(typeName);
  }

  private readonly fieldsCache = new Map<string, string[]>();

  /** The fields `ownerType`'s reader fills from `fieldType`'s reader, in read order (cached). */
  fieldsReadAs(ownerType: string, fieldType: string): string[] {
    const key = `${ownerType}\u0000${fieldType}`;
    let out = this.fieldsCache.get(key);
    if (!out) {
      out = this.interp.fieldsReadAs(ownerType, fieldType);
      this.fieldsCache.set(key, out);
    }
    return [...out];
  }

  /** Read one instance of a class, by registered type name (or minified var); `budget` spans several reads. */
  readClass(typeNameOrVar: string, reader: Reader, budget?: ReadBudget): unknown {
    return this.interp.readClass(typeNameOrVar, reader, budget);
  }
}

export interface BundleLoaderOptions {
  /** The server's data directory; the bundle is cached under `<dataDir>/bundle/`. */
  dataDir: string;
  /** GET a URL as text (through whatever transport the server uses). */
  fetchText: (url: string) => Promise<string>;
  /** The war.app page whose script tag names the bundle (default {@link DEFAULT_PAGE_URL}). */
  pageUrl?: string;
  interp?: InterpOptions;
  /** Clock for {@link BundleProvider}'s fallback expiry (tests). */
  now?: () => number;
}

/** A cached bundle file: `<version>.js`. */
const BUNDLE_FILE = /^([A-Za-z0-9._-]{1,64})\.js$/;
/** A cached bundle's recorded digest: `<version>.js.sha256`, part of that bundle. */
const DIGEST_FILE = /^([A-Za-z0-9._-]{1,64})\.js\.sha256$/;
/**
 * A write that never finished, of a bundle or of its digest: `<version>.js[.sha256].tmp-<pid>`,
 * optionally followed by `-<random>` (what {@link writePrivateAtomic} writes).
 */
const PARTIAL_FILE = /^[A-Za-z0-9._-]{1,64}\.js(?:\.sha256)?\.tmp-(\d+)(?:-[0-9a-f]+)?$/;
/** A partial download older than this is abandoned, whoever wrote it (a pid can be reused). */
const STALE_PARTIAL_MS = 10 * 60_000;

/** Whether process `pid` is running (EPERM: it exists, owned by someone else). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A partial download may be pruned when this process wrote it, its writer is gone, or it is
 * stale; never while another live process may still rename it into place (#140).
 */
async function abandoned(file: string, pid: number): Promise<boolean> {
  if (pid === process.pid || !alive(pid)) return true;
  try {
    return Date.now() - (await stat(file)).mtimeMs > STALE_PARTIAL_MS;
  } catch {
    return false;
  }
}

/**
 * Delete every cached bundle but `keep` (each is ~16 MB, one per client release), its recorded
 * digest with it, and any unfinished download. `keep`'s digest is kept. Best effort: never throws.
 */
async function pruneBundles(dir: string, keep: string): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      if (name === keep || name === `${keep}.sha256`) continue;
      const partial = PARTIAL_FILE.exec(name);
      if (!partial && !BUNDLE_FILE.test(name) && !DIGEST_FILE.test(name)) continue;
      if (partial && !(await abandoned(join(dir, name), Number(partial[1])))) continue;
      await unlink(join(dir, name)).catch(() => undefined);
    }
  } catch {
    // Nothing to prune.
  }
}

/** Cached bundles, newest (by modification time) first. */
async function cachedNewestFirst(dir: string): Promise<{ version: string; file: string }[]> {
  const found: { version: string; file: string; mtime: number }[] = [];
  try {
    for (const name of await readdir(dir)) {
      const m = BUNDLE_FILE.exec(name);
      if (!m) continue;
      const file = join(dir, name);
      try {
        found.push({ version: m[1]!, file, mtime: (await stat(file)).mtimeMs });
      } catch {
        // Gone since the listing (pruned by another process).
      }
    }
  } catch {
    return [];
  }
  return found.sort((a, b) => b.mtime - a.mtime).map(({ version, file }) => ({ version, file }));
}

/**
 * The newest cached bundle that passes {@link readVerified} (its recorded digest and the content
 * check), or undefined. A copy that fails is deleted by that check, never loaded.
 */
async function newestVerified(dir: string): Promise<{ version: string; src: string } | undefined> {
  for (const { version, file } of await cachedNewestFirst(dir)) {
    const src = await readVerified(file, `${file}.sha256`);
    if (src !== null) return { version, src };
  }
  return undefined;
}

/** The content check: a client bundle registers its classes as `W["<type name>"]=<var>;`. */
const looksLikeBundle = (src: string) => /W\["[\w.$]+"\]=[\w$]+;/.test(src);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * Create `dir` (and missing parents) `0700`; when it already exists with group/other bits
 * and this process owns it, tighten it to `0700` (a `mkdir` mode never changes an existing
 * directory). No-op on Windows, which has no POSIX modes.
 */
async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  const st = await stat(dir);
  if ((st.mode & 0o077) !== 0 && st.uid === process.getuid()) await chmod(dir, 0o700);
}

/** Write `data` to `file` `0600` through a fresh temporary file and a rename. */
async function writePrivateAtomic(file: string, data: Buffer | string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/**
 * The cached bundle's text when it still matches the digest recorded at download and still
 * passes the content check; `null` (nothing cached, or the copy was rejected and deleted).
 *
 * This guards against later corruption of, or tampering with, the cache — a truncated write,
 * a disk error, or anything that rewrites the file after it was downloaded — so one bad copy
 * cannot persist across restarts. It is trust on first download: it does not protect against
 * a malicious first download (the digest is computed from what was received), which only the
 * pinned location and the interpreter's own hardening limit. A copy with no digest (cached
 * before digests were recorded) is treated as unverified and downloaded again.
 */
async function readVerified(file: string, digestFile: string): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    return null;
  }
  const digest = await readFile(digestFile, 'utf8').then(
    (d) => d.trim(),
    () => null,
  );
  const src = bytes.toString('utf8');
  if (digest !== null && digest === sha256(bytes) && looksLikeBundle(src)) return src;
  await rm(file, { force: true });
  await rm(digestFile, { force: true });
  return null;
}

/** Discover, fetch (or reuse the verified cached copy of) and load the current client bundle. */
export async function loadBundle(opts: BundleLoaderOptions): Promise<WarappBundle> {
  const pageUrl = opts.pageUrl ?? DEFAULT_PAGE_URL;
  const dir = join(opts.dataDir, 'bundle');
  let source: BundleSource;
  try {
    source = discoverBundleUrl(await opts.fetchText(pageUrl), pageUrl);
  } catch (e) {
    // The page naming the current version could not be read (a frozen tab, a signed-out page):
    // a copy already on disk still decodes, rather than failing every live read (#131).
    // Only a copy that still matches its recorded digest stands in.
    const cached = await newestVerified(dir);
    if (!cached) throw e;
    const b = new WarappBundle(cached.src, cached.version, opts.interp);
    b.fallback = true;
    return b;
  }
  const { url, version } = source;
  const file = join(dir, `${version}.js`);
  const digestFile = `${file}.sha256`;
  let src = await readVerified(file, digestFile);
  if (src === null) {
    src = await opts.fetchText(url);
    if (!looksLikeBundle(src)) {
      throw new BundleError('bad-bundle', `${url} does not look like the war.app client bundle`);
    }
    await ensurePrivateDir(opts.dataDir);
    await ensurePrivateDir(dir);
    const bytes = Buffer.from(src, 'utf8');
    // The bundle first, then its digest: a crash between the two leaves a copy with no
    // digest, which the next load downloads again.
    await writePrivateAtomic(file, bytes);
    await writePrivateAtomic(digestFile, `${sha256(bytes)}\n`);
  }
  const bundle = new WarappBundle(src, version, opts.interp);
  await pruneBundles(dir, `${version}.js`);
  return bundle;
}

/**
 * How long a fallback bundle is used, or a refused (dialect-mismatch) bundle is remembered, before
 * the current version is looked up again.
 */
export const FALLBACK_RETRY_MS = 5 * 60_000;

/**
 * Loads the bundle once per process; a failed load is retried on the next call, except a bundle
 * refused as a dialect mismatch, which is retried after {@link FALLBACK_RETRY_MS}.
 */
export class BundleProvider {
  private pending: Promise<WarappBundle> | null = null;

  constructor(private readonly opts: BundleLoaderOptions) {}

  private fallbackUntil: number | undefined;

  get(): Promise<WarappBundle> {
    const now = this.opts.now ?? Date.now;
    if (this.pending && this.fallbackUntil !== undefined && now() >= this.fallbackUntil) this.pending = null;
    if (!this.pending) {
      this.fallbackUntil = undefined;
      const p = loadBundle(this.opts);
      this.pending = p;
      p.then(
        (b) => {
          // A cached copy stands in only until the version can be looked up again.
          if (b.fallback && this.pending === p) this.fallbackUntil = now() + FALLBACK_RETRY_MS;
        },
        (e) => {
          if (this.pending !== p) return;
          // A bundle this server cannot read stays unreadable: remember the refusal for a while
          // instead of re-reading and re-checking ~16 MB on every live call (#131).
          if (e instanceof BundleError && e.kind === 'dialect-mismatch') this.fallbackUntil = now() + FALLBACK_RETRY_MS;
          else this.pending = null;
        },
      );
    }
    return this.pending;
  }
}
