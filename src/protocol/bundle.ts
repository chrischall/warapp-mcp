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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Reader } from './codec.js';
import { BundleInterpreter, parseBundle, type InterpOptions } from './interp.js';

/** A page that loads the game client (the homepage does not). */
export const DEFAULT_PAGE_URL = 'https://war.app/MultiPlayer';
/** Hosts a bundle may be served from (the host itself or any subdomain). */
export const BUNDLE_HOSTS = ['war.app', 'warappcdn.com'];

export type BundleErrorKind = 'no-script' | 'bad-url' | 'bad-version' | 'bad-bundle';

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

  constructor(
    src: string,
    readonly version: string,
    opts: InterpOptions = {},
  ) {
    this.interp = new BundleInterpreter(parseBundle(src), opts);
  }

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
}

/** Discover, fetch (or reuse the cached copy of) and load the current client bundle. */
export async function loadBundle(opts: BundleLoaderOptions): Promise<WarappBundle> {
  const pageUrl = opts.pageUrl ?? DEFAULT_PAGE_URL;
  const { url, version } = discoverBundleUrl(await opts.fetchText(pageUrl), pageUrl);
  const dir = join(opts.dataDir, 'bundle');
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
  return new WarappBundle(src, version, opts.interp);
}

/** Loads the bundle once per process; a failed load is retried on the next call. */
export class BundleProvider {
  private pending: Promise<WarappBundle> | null = null;

  constructor(private readonly opts: BundleLoaderOptions) {}

  get(): Promise<WarappBundle> {
    if (!this.pending) {
      this.pending = loadBundle(this.opts);
      this.pending.catch(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }
}
