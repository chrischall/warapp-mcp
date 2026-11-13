// The war.app client bundle, fetched at runtime and cached — never vendored.
//
// A war.app page loads the client as `<script src="https://warappcdn.com/js/Release/ujs.js?v=<n>">`.
// The bundle's generated readers are the authority on every wire class layout, and those
// layouts (and the minified names) change between client releases, so this module:
//   1. fetches a war.app page and discovers the current bundle URL and version,
//   2. reuses `<dataDir>/bundle/<version>.js` if present, else downloads and caches it,
//   3. exposes `readClass(typeName | var, reader)` keyed by the stable registered type
//      name (e.g. `warlight.shared.LatestGameInfo`), evaluated by `BundleInterpreter`.
// Fetching is injected so the transport (and tests) decide how pages are retrieved.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Reader } from './codec.js';
import { BundleInterpreter, parseBundle, type DialectCheck, type InterpOptions } from './interp.js';

/** A page that loads the game client (the homepage does not). */
export const DEFAULT_PAGE_URL = 'https://war.app/MultiPlayer';
/** Hosts a bundle may be served from (the host itself or any subdomain). */
export const BUNDLE_HOSTS = ['war.app', 'warappcdn.com'];

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
  /** Cache key: the URL's `v` parameter, else a hash of the URL. */
  version: string;
}

const SCRIPT_RE = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']*\/ujs\.js(?:\?[^"']*)?)["']/i;
const SAFE_VERSION = /^[A-Za-z0-9._-]{1,64}$/;

const hostAllowed = (host: string) => BUNDLE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

/** Find the client bundle's URL and version in a war.app page. */
export function discoverBundleUrl(html: string, pageUrl: string): BundleSource {
  const m = SCRIPT_RE.exec(html);
  if (!m) throw new BundleError('no-script', `no ujs.js script tag on ${pageUrl}`);
  const src = m[1].replace(/&amp;/g, '&');
  const url = new URL(src, pageUrl);
  if (url.protocol !== 'https:') throw new BundleError('bad-url', `bundle URL is not https: ${url.href}`);
  if (!hostAllowed(url.hostname)) throw new BundleError('bad-url', `bundle host not allowed: ${url.hostname}`);
  const v = url.searchParams.get('v');
  const version = v ?? `u-${createHash('sha256').update(url.href).digest('hex').slice(0, 16)}`;
  if (!SAFE_VERSION.test(version) || version === '.' || version === '..') {
    throw new BundleError('bad-version', `bundle version is not a safe file name: ${JSON.stringify(version)}`);
  }
  return { url: url.href, version };
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

  /** Read one instance of a class, by registered type name (or minified var). */
  readClass(typeNameOrVar: string, reader: Reader): unknown {
    return this.interp.readClass(typeNameOrVar, reader);
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
/** A download that never finished: `<version>.js.tmp-<pid>`. */
const PARTIAL_FILE = /^[A-Za-z0-9._-]{1,64}\.js\.tmp-\d+$/;

/**
 * Delete every cached bundle but `keep` (each is ~16 MB, one per client release) and any
 * unfinished download. Best effort: never throws.
 */
async function pruneBundles(dir: string, keep: string): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      if (name === keep || !(BUNDLE_FILE.test(name) || PARTIAL_FILE.test(name))) continue;
      await unlink(join(dir, name)).catch(() => undefined);
    }
  } catch {
    // Nothing to prune.
  }
}

/** The newest cached bundle (by modification time), or undefined. */
async function newestCached(dir: string): Promise<{ version: string; file: string } | undefined> {
  let best: { version: string; file: string; mtime: number } | undefined;
  try {
    for (const name of await readdir(dir)) {
      const m = BUNDLE_FILE.exec(name);
      if (!m) continue;
      const file = join(dir, name);
      const { mtimeMs } = await stat(file);
      if (!best || mtimeMs > best.mtime) best = { version: m[1]!, file, mtime: mtimeMs };
    }
  } catch {
    return undefined;
  }
  return best && { version: best.version, file: best.file };
}

/** Discover, fetch (or reuse the cached copy of) and load the current client bundle. */
export async function loadBundle(opts: BundleLoaderOptions): Promise<WarappBundle> {
  const pageUrl = opts.pageUrl ?? DEFAULT_PAGE_URL;
  const dir = join(opts.dataDir, 'bundle');
  let source: BundleSource;
  try {
    source = discoverBundleUrl(await opts.fetchText(pageUrl), pageUrl);
  } catch (e) {
    // The page naming the current version could not be read (a frozen tab, a signed-out page):
    // a copy already on disk still decodes, rather than failing every live read (#131).
    const cached = await newestCached(dir);
    if (!cached) throw e;
    const b = new WarappBundle(await readFile(cached.file, 'utf8'), cached.version, opts.interp);
    b.fallback = true;
    return b;
  }
  const { url, version } = source;
  const file = join(dir, `${version}.js`);
  let src: string;
  try {
    src = await readFile(file, 'utf8');
  } catch {
    src = await opts.fetchText(url);
    if (!/W\["[\w.$]+"\]=[\w$]+;/.test(src)) {
      throw new BundleError('bad-bundle', `${url} does not look like the war.app client bundle`);
    }
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, src, 'utf8');
    await rename(tmp, file);
  }
  const bundle = new WarappBundle(src, version, opts.interp);
  await pruneBundles(dir, `${version}.js`);
  return bundle;
}

/** How long a fallback bundle is used before the current version is looked up again. */
export const FALLBACK_RETRY_MS = 5 * 60_000;

/** Loads the bundle once per process; a failed load is retried on the next call. */
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
        () => {
          if (this.pending === p) this.pending = null;
        },
      );
    }
    return this.pending;
  }
}
