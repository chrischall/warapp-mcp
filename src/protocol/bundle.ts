// The war.app client bundle, fetched at runtime and cached — never vendored.
//
// A war.app page loads the client as `<script src="https://warappcdn.com/js/Release/ujs.js?v=<n>">`.
// The bundle's generated readers are the authority on every wire class layout, and those
// layouts (and the minified names) change between client releases, so this module:
//   1. fetches a war.app page and discovers the current bundle URL and version,
//   2. reuses `<dataDir>/bundle/<version>.<sha256>.js` if present and its bytes still hash to the
//      digest in its name, else downloads and caches it,
//   3. exposes `readClass(typeName | var, reader)` keyed by the stable registered type
//      name (e.g. `warlight.shared.LatestGameInfo`), evaluated by `BundleInterpreter`.
// Fetching is injected so the transport (and tests) decide how pages are retrieved.
//
// The cache is content-addressed, because several processes share one cache directory. A cached
// bundle is ONE file whose name carries the SHA-256 of its bytes, written to a private temporary
// file and renamed into place in one step. So there is no moment at which another process can see a
// bundle without its digest (and delete it as unverified), and pruning cannot remove half of a pair:
// there is no pair. A file whose bytes do not hash to its name (a truncated write, a disk error, a
// later edit) is deleted and never loaded. A cache from before this layout (`<version>.js`, with or
// without a `<version>.js.sha256` beside it) is never read: it is downloaded again and the old files
// pruned. Pruning follows #140: an unfinished download (`….tmp-<pid>[-<random>]`) is removed only when
// this process wrote it, its writer is gone, or it is stale — never while another live process may
// still rename it into place.

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withPathLock } from '../path-lock.js';
import type { Reader } from './codec.js';
import {
  BundleInterpreter,
  parseBundle,
  READER_HELPERS,
  REQUIRED_HELPERS,
  type DialectCheck,
  type InterpOptions,
  type ReadBudget,
} from './interp.js';

/** A page that loads the game client (the homepage does not). */
const DEFAULT_PAGE_URL = 'https://war.app/MultiPlayer';
/** The only host the bundle is downloaded from (exactly this host: no subdomain, no port). */
const BUNDLE_HOST = 'warappcdn.com';
/** The only path the bundle is downloaded from; its `v` query parameter is the only variable. */
const BUNDLE_PATH = '/js/Release/ujs.js';
/** How long the bundle download may take, headers and body together. */
export const BUNDLE_FETCH_TIMEOUT_MS = 120_000;
/** The most bytes the bundle download may carry (the bundle is about 17 MB). */
export const BUNDLE_MAX_BYTES = 64 * 1024 * 1024;

type BundleErrorKind = 'no-script' | 'bad-url' | 'bad-version' | 'bad-bundle' | 'dialect-mismatch' | 'dialect-unverified';

export class BundleError extends Error {
  constructor(
    readonly kind: BundleErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'BundleError';
  }
}

interface BundleSource {
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
  const src = m[1]!.replace(/&amp;/g, '&');
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

/** What decoded a board: the bundle version, whether a stand-in did, and its reader-helper check. */
export interface DecoderReport {
  /** The client bundle version the board was decoded with. */
  bundleVersion: string;
  /** A cached copy stood in because the current version could not be looked up (#131). */
  fallback: boolean;
  /** The reader helpers checked at load (#148): verified, and the ones that are not, with why. */
  helpers: { verified: string[]; unverified: string[]; reasons?: Record<string, string> };
  /**
   * The pinned known-good client ({@link KNOWN_GOOD_BUNDLE}) decoded the board because war.app's current
   * client was refused: its version, and why it was refused.
   */
  standInFor?: { version: string; reason: string };
  /**
   * While a stand-in decodes: the build decoding (`version`), the current client it stands in for
   * (`refusedVersion`), when that client was first refused here (`since`, ISO-8601: how long war.app has
   * kept answering the old protocol so far) and why it was refused.
   */
  standIn?: StandInWindow;
}

/** The stand-in window: a build decoding in place of a refused current client, since when. */
export interface StandInWindow {
  version: string;
  refusedVersion: string;
  since: string;
  reason: string;
}

/** What {@link WarappBundle.markDecoded} did with the build's record. */
export type RecordOutcome = 'recorded' | 'unchanged' | 'unreadable' | 'failed';

/** A loaded bundle: reads wire classes by stable type name. */
export class WarappBundle {
  private readonly interp: BundleInterpreter;

  /** Loaded from the cache because the current version could not be looked up. */
  fallback = false;

  /** Set when this is the pinned known-good client standing in for a refused current one. */
  standInFor: { version: string; reason: string } | undefined;

  /** Set while this build stands in for a refused current client: the window (see {@link StandInWindow}). */
  standIn: StandInWindow | undefined;

  /** The SHA-256 of this build's bytes (set by {@link loadBundle}); a build without one is never recorded. */
  digest: string | undefined;

  /** Records this build as one that decoded a live board (set by {@link loadBundle}). */
  recorder: (() => Promise<RecordOutcome>) | undefined;

  private recorded: Promise<RecordOutcome> | undefined;

  /**
   * A live board decoded with this build, every byte consumed: record it as a build that works, so a
   * later client this server cannot read is stood in for by it (the owner, 2026-11-17: fall back
   * gracefully). Once per loaded bundle; never throws.
   */
  markDecoded(): Promise<RecordOutcome> {
    if (this.recorded) return this.recorded.then((r) => (r === 'recorded' ? 'unchanged' : r));
    this.recorded = this.recorder ? this.recorder().catch((): RecordOutcome => 'failed') : Promise.resolve('unchanged');
    return this.recorded;
  }

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
    // The count, flag and byte helpers decode every army count, fog flag and unit count: one this
    // check cannot verify could be a swapped same-width read, which no later check catches (#148).
    const unverifiedRequired = REQUIRED_HELPERS.map((n) => `${READER_HELPERS}.${n}`).filter((k) =>
      this.dialectCheck.unverified.includes(k),
    );
    if (unverifiedRequired.length) {
      throw new BundleError(
        'dialect-unverified',
        `war.app's client bundle ${version} defines ${unverifiedRequired.join(', ')} in a way this server cannot check ` +
          `(${unverifiedRequired.map((k) => this.dialectCheck.reasons?.[k] ?? 'unverified').join('; ')}); those read every ` +
          'army count, so the board is not decoded rather than risk a wrong one. The client changed and this server needs an update.',
      );
    }
  }

  /** The built-in reader helpers checked against this bundle's own definitions at load. */
  readonly dialectCheck: DialectCheck;

  /** What this bundle's decoding rests on, for the tools to show (#148). */
  report(): DecoderReport {
    const { verified, unverified, reasons } = this.dialectCheck;
    return {
      bundleVersion: this.version,
      fallback: this.fallback,
      helpers: { verified: [...verified], unverified: [...unverified], ...(reasons ? { reasons: { ...reasons } } : {}) },
      ...(this.standInFor ? { standInFor: { ...this.standInFor } } : {}),
      ...(this.standIn ? { standIn: { ...this.standIn } } : {}),
    };
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

  /** Read one instance of a class, by registered type name (or minified var); `budget` spans several reads. */
  readClass(typeNameOrVar: string, reader: Reader, budget?: ReadBudget): unknown {
    return this.interp.readClass(typeNameOrVar, reader, budget);
  }
}

interface BundleLoaderOptions {
  /** The server's data directory; the bundle is cached under `<dataDir>/bundle/`. */
  dataDir: string;
  /** GET a URL as text (through whatever transport the server uses). */
  fetchText: (url: string) => Promise<string>;
  /** The war.app page whose script tag names the bundle (default {@link DEFAULT_PAGE_URL}). */
  pageUrl?: string;
  interp?: InterpOptions;
  /** Clock for {@link BundleProvider}'s fallback expiry (tests). */
  now?: () => number;
  /**
   * The client release to decode with when the current one is refused (default {@link KNOWN_GOOD_BUNDLE};
   * `null`: none, the refusal stands).
   */
  knownGood?: KnownGoodBundle | null;
}

/** A client release pinned by version and the SHA-256 of its bytes. */
export interface KnownGoodBundle {
  version: string;
  digest: string;
}

/**
 * The client release the built-in readers (src/protocol/interp.ts `DEFAULT_DIALECT`) and every
 * hand-written encoder are written for: client v6.07, protocol 242. war.app's CDN still serves it by
 * version, byte for byte, and war.app still answers a protocol-242 request in 242's layout. So when
 * the current client is refused (2026-11-17: 639304451701341657 renamed every reader on protocol
 * 243), this one stands in and decodes those replies exactly. Only bytes with this digest are used.
 */
export const KNOWN_GOOD_BUNDLE: KnownGoodBundle = {
  version: '639294131571648437',
  digest: 'dec5cf174f6affb9e4c08802534cf8c6c6496eff977847aaf1497535e3371404',
};

/** The CDN URL of a client release, by version (the location {@link discoverBundleUrl} pins). */
const bundleUrlOf = (version: string) => `https://${BUNDLE_HOST}${BUNDLE_PATH}?v=${version}`;

/** A cached bundle: `<version>.<sha256 of its bytes>.js`. */
const BUNDLE_FILE = /^([A-Za-z0-9._-]{1,64})\.([0-9a-f]{64})\.js$/;
/** A cache file of the earlier layouts, never read, only pruned: `<version>.js` and `<version>.js.sha256`. */
const LEGACY_FILE = /^[A-Za-z0-9._-]{1,64}\.js(?:\.sha256)?$/;
/**
 * A write that never finished: `<version>[.<sha256>].js[.sha256].tmp-<pid>`, optionally followed by
 * `-<random>` (what {@link writePrivateAtomic} writes; the shorter forms are the earlier layouts').
 */
const PARTIAL_FILE = /^[A-Za-z0-9._-]{1,64}(?:\.[0-9a-f]{64})?\.js(?:\.sha256)?\.tmp-(\d+)(?:-[0-9a-f]+)?$/;

/** The cache file name of `version` with these bytes' digest. */
const bundleName = (version: string, digest: string) => `${version}.${digest}.js`;
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

/** This process's unfinished writes (temporary files not yet renamed into place). */
const writing = new Set<string>();

/**
 * A partial download may be pruned when this process wrote it and is no longer writing it, its
 * writer is gone, or it is stale; never while a live process — another one, or a concurrent load
 * in this one — may still rename it into place (#140).
 */
async function abandoned(file: string, pid: number): Promise<boolean> {
  if (pid === process.pid) return !writing.has(file);
  if (!alive(pid)) return true;
  try {
    return Date.now() - (await stat(file)).mtimeMs > STALE_PARTIAL_MS;
  } catch {
    return false;
  }
}

/**
 * Delete every cached bundle but `keep` (each is ~16 MB, one per client release), every file of an
 * earlier cache layout and any abandoned unfinished download. Best effort: never throws.
 */
async function pruneBundles(dir: string, keep: readonly string[]): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      if (keep.includes(name)) continue;
      const partial = PARTIAL_FILE.exec(name);
      if (!partial && !BUNDLE_FILE.test(name) && !LEGACY_FILE.test(name)) continue;
      if (partial && !(await abandoned(join(dir, name), Number(partial[1])))) continue;
      await unlink(join(dir, name)).catch(() => undefined);
    }
  } catch {
    // Nothing to prune.
  }
}

interface CachedBundle {
  version: string;
  digest: string;
  name: string;
  file: string;
}

/** Cached bundles (of `version`, when given), newest (by modification time) first. */
async function cachedNewestFirst(dir: string, version?: string): Promise<CachedBundle[]> {
  const found: (CachedBundle & { mtime: number })[] = [];
  try {
    for (const name of await readdir(dir)) {
      const m = BUNDLE_FILE.exec(name);
      if (!m || (version !== undefined && m[1] !== version)) continue;
      const file = join(dir, name);
      try {
        found.push({ version: m[1]!, digest: m[2]!, name, file, mtime: (await stat(file)).mtimeMs });
      } catch {
        // Gone since the listing (pruned by another process).
      }
    }
  } catch {
    return [];
  }
  return found.sort((a, b) => b.mtime - a.mtime).map(({ mtime: _, ...c }) => c);
}

/**
 * The newest cached bundle (of `version`, when given) that passes {@link readVerified} (the digest in
 * its name and the content check), or undefined. A copy that fails is deleted by that check, never loaded.
 */
async function newestVerified(dir: string, version?: string): Promise<{ version: string; name: string; src: string } | undefined> {
  for (const c of await cachedNewestFirst(dir, version)) {
    const src = await readVerified(c.file, c.digest);
    if (src !== null) return { version: c.version, name: c.name, src };
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
  writing.add(tmp);
  try {
    await writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  } finally {
    writing.delete(tmp);
  }
}

/**
 * The cached bundle's text when its bytes still hash to `digest` (the one in its name) and it still
 * passes the content check; `null` (gone, or the copy was rejected and deleted).
 *
 * This guards against later corruption of, or tampering with, the cache — a truncated write,
 * a disk error, or anything that rewrites the file after it was downloaded — so one bad copy
 * cannot persist across restarts. It is trust on first download: it does not protect against
 * a malicious first download (the digest is computed from what was received), which only the
 * pinned location and the interpreter's own hardening limit. Deleting a rejected copy can race
 * only with another process renaming a good copy of the same bytes to the same name; the cost is
 * one extra download, never an unverified load.
 */
async function readVerified(file: string, digest: string): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    return null;
  }
  const src = bytes.toString('utf8');
  if (sha256(bytes) === digest && looksLikeBundle(src)) return src;
  await rm(file, { force: true });
  return null;
}

/** Whether `e` is the load-time refusal of a client this server cannot read (#131, #148). */
const isDialectRefusal = (e: unknown): e is BundleError =>
  e instanceof BundleError && (e.kind === 'dialect-mismatch' || e.kind === 'dialect-unverified');

/** Write `src` into the cache as `name` (`0700` directories, an atomic `0600` file). */
async function cacheBundle(dataDir: string, dir: string, name: string, src: string): Promise<void> {
  await ensurePrivateDir(dataDir);
  await ensurePrivateDir(dir);
  await writePrivateAtomic(join(dir, name), Buffer.from(src, 'utf8'));
}

/** The record of client builds that decoded a live board, in `<dataDir>/bundle/`. */
export const KNOWN_GOOD_FILE = 'known-good.json';
/** The open stand-in window (the refused client and when it was first refused), in `<dataDir>/bundle/`. */
export const STAND_IN_FILE = 'stand-in.json';
/** How many recorded builds are kept, newest first (each keeps its ~16 MB copy on disk). */
export const MAX_KNOWN_GOOD = 3;

/** A client build that decoded a live board here: its version, the SHA-256 of its bytes, and when. */
export interface RecordedBundle {
  version: string;
  digest: string;
  verifiedAt: string;
}

const DIGEST = /^[0-9a-f]{64}$/;
const isRecorded = (v: unknown): v is RecordedBundle => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.version === 'string' &&
    SAFE_VERSION.test(r.version) &&
    typeof r.digest === 'string' &&
    DIGEST.test(r.digest) &&
    typeof r.verifiedAt === 'string'
  );
};

/**
 * The recorded builds in the bundle directory `dir`, newest first: `[]` when there is no record,
 * `'unreadable'` when the file exists but does not parse (never overwritten). Malformed entries are skipped.
 */
export async function readKnownGood(dir: string): Promise<RecordedBundle[] | 'unreadable'> {
  let text: string;
  try {
    text = await readFile(join(dir, KNOWN_GOOD_FILE), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : 'unreadable';
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const builds = (parsed as { builds?: unknown })?.builds;
    if (!Array.isArray(builds)) return 'unreadable';
    return builds.filter(isRecorded);
  } catch {
    return 'unreadable';
  }
}

/**
 * Record `entry` as a build that decoded a live board: newest first, one entry per version and digest, at
 * most {@link MAX_KNOWN_GOOD}; written `0600` through a temporary file and a rename, under the in-process
 * path lock. A record that does not parse is never overwritten (`'unreadable'`).
 */
export async function recordKnownGood(dataDir: string, entry: RecordedBundle): Promise<RecordOutcome> {
  if (!isRecorded(entry)) return 'failed';
  const dir = join(dataDir, 'bundle');
  const file = join(dir, KNOWN_GOOD_FILE);
  return withPathLock(file, async () => {
    const builds = await readKnownGood(dir);
    if (builds === 'unreadable') return 'unreadable';
    const rest = builds.filter((b) => !(b.version === entry.version && b.digest === entry.digest));
    const next = [entry, ...rest].slice(0, MAX_KNOWN_GOOD);
    try {
      await ensurePrivateDir(dataDir);
      await ensurePrivateDir(dir);
      await writePrivateAtomic(file, `${JSON.stringify({ builds: next }, null, 2)}\n`);
      return 'recorded';
    } catch {
      return 'failed';
    }
  });
}

/** The open stand-in window on disk, or undefined (none, or not readable). */
async function readWindow(dir: string): Promise<{ refusedVersion: string; since: string } | undefined> {
  try {
    const w = JSON.parse(await readFile(join(dir, STAND_IN_FILE), 'utf8')) as Record<string, unknown>;
    if (typeof w.refusedVersion === 'string' && typeof w.since === 'string' && !Number.isNaN(Date.parse(w.since))) {
      return { refusedVersion: w.refusedVersion, since: w.since };
    }
  } catch {
    // None yet.
  }
  return undefined;
}

/**
 * When `refusedVersion` was first refused here: the time kept on disk for that version, else `now`
 * (written, so the window survives a restart). Best effort: a write that fails still returns `now`.
 */
async function openWindow(dataDir: string, dir: string, refusedVersion: string, reason: string, now: number): Promise<string> {
  const kept = await readWindow(dir);
  if (kept?.refusedVersion === refusedVersion) return kept.since;
  const since = new Date(now).toISOString();
  try {
    await ensurePrivateDir(dataDir);
    await ensurePrivateDir(dir);
    await writePrivateAtomic(join(dir, STAND_IN_FILE), `${JSON.stringify({ refusedVersion, since, reason }, null, 2)}\n`);
  } catch {
    // The window is still reported for this load.
  }
  return since;
}

/** The current client loads: the window is closed. Best effort. */
async function closeWindow(dir: string): Promise<void> {
  await rm(join(dir, STAND_IN_FILE), { force: true }).catch(() => undefined);
}

/**
 * A build pinned by version and digest, from the cache or downloaded by version and kept only when its bytes
 * hash to that digest, loaded; `undefined` when it cannot be had or this server refuses it too.
 */
async function loadPinned(
  opts: BundleLoaderOptions,
  dir: string,
  kg: KnownGoodBundle,
): Promise<{ bundle: WarappBundle; name: string } | undefined> {
  const name = bundleName(kg.version, kg.digest);
  let src = await readVerified(join(dir, name), kg.digest);
  if (src === null) {
    let fetched: string;
    try {
      fetched = await opts.fetchText(bundleUrlOf(kg.version));
    } catch {
      return undefined;
    }
    if (sha256(Buffer.from(fetched, 'utf8')) !== kg.digest || !looksLikeBundle(fetched)) return undefined;
    try {
      await cacheBundle(opts.dataDir, dir, name, fetched);
    } catch {
      return undefined;
    }
    src = fetched;
  }
  try {
    const bundle = new WarappBundle(src, kg.version, opts.interp);
    bundle.digest = kg.digest;
    return { bundle, name };
  } catch {
    return undefined;
  }
}

/** Wire `bundle` to record itself once a live board decodes with it. */
function withRecorder(opts: BundleLoaderOptions, bundle: WarappBundle): WarappBundle {
  const now = opts.now ?? Date.now;
  bundle.recorder = async () => {
    if (!bundle.digest) return 'unchanged';
    return recordKnownGood(opts.dataDir, { version: bundle.version, digest: bundle.digest, verifiedAt: new Date(now()).toISOString() });
  };
  return bundle;
}

/** The cache names of every recorded build (they stay on disk: a later refusal may need any of them). */
async function recordedNames(dir: string): Promise<string[]> {
  const builds = await readKnownGood(dir);
  return builds === 'unreadable' ? [] : builds.map((b) => bundleName(b.version, b.digest));
}

/** Discover, fetch (or reuse the verified cached copy of) and load the current client bundle. */
export async function loadBundle(opts: BundleLoaderOptions): Promise<WarappBundle> {
  const pageUrl = opts.pageUrl ?? DEFAULT_PAGE_URL;
  const dir = join(opts.dataDir, 'bundle');
  const kg = opts.knownGood === undefined ? KNOWN_GOOD_BUNDLE : opts.knownGood;
  const now = opts.now ?? Date.now;
  let source: BundleSource;
  try {
    source = discoverBundleUrl(await opts.fetchText(pageUrl), pageUrl);
  } catch (e) {
    // The page naming the current version could not be read (a frozen tab, a signed-out page):
    // a copy already on disk still decodes, rather than failing every live read (#131).
    // Only a copy that still matches its recorded digest stands in, newest first, skipping one
    // this server refuses to read (a client it was never written for).
    for (const c of await cachedNewestFirst(dir)) {
      const src = await readVerified(c.file, c.digest);
      if (src === null) continue;
      try {
        const b = new WarappBundle(src, c.version, opts.interp);
        b.fallback = true;
        b.digest = c.digest;
        return withRecorder(opts, b);
      } catch (err) {
        if (!isDialectRefusal(err)) throw err;
      }
    }
    throw e;
  }
  const { url, version } = source;
  const cached = await newestVerified(dir, version);
  let src: string;
  let name: string;
  if (cached) {
    ({ src, name } = cached);
  } else {
    src = await opts.fetchText(url);
    if (!looksLikeBundle(src)) {
      throw new BundleError('bad-bundle', `${url} does not look like the war.app client bundle`);
    }
    // One file, its digest in its name, made visible by one rename: never a bundle without its digest.
    name = bundleName(version, sha256(Buffer.from(src, 'utf8')));
    await cacheBundle(opts.dataDir, dir, name, src);
  }
  const keepKnownGood = kg ? [bundleName(kg.version, kg.digest)] : [];
  const keepRecorded = await recordedNames(dir);
  let bundle: WarappBundle;
  try {
    bundle = new WarappBundle(src, version, opts.interp);
  } catch (e) {
    if (!isDialectRefusal(e)) throw e;
    // Stand-ins, best first: every build that decoded a live board here (newest first), then the pin.
    const recorded = await readKnownGood(dir);
    const candidates: KnownGoodBundle[] = [
      ...(recorded === 'unreadable' ? [] : recorded.map(({ version: v, digest }) => ({ version: v, digest }))),
      ...(kg ? [kg] : []),
    ].filter((c, i, all) => c.version !== version && all.findIndex((o) => o.version === c.version && o.digest === c.digest) === i);
    for (const c of candidates) {
      const standIn = await loadPinned(opts, dir, c);
      if (!standIn) continue;
      const since = await openWindow(opts.dataDir, dir, version, e.message, now());
      standIn.bundle.standInFor = { version, reason: e.message };
      standIn.bundle.standIn = { version: c.version, refusedVersion: version, since, reason: e.message };
      // All stay: the refused copy so the next lookup does not download it again, the stand-in in use,
      // and every recorded build.
      await pruneBundles(dir, [name, standIn.name, ...keepKnownGood, ...keepRecorded]);
      return withRecorder(opts, standIn.bundle);
    }
    throw e;
  }
  bundle.digest = name.slice(version.length + 1, -'.js'.length);
  await closeWindow(dir);
  await pruneBundles(dir, [name, ...keepKnownGood, ...keepRecorded]);
  return withRecorder(opts, bundle);
}

/**
 * How long a fallback bundle is used, or a refused (dialect-mismatch) bundle is remembered, before
 * the current version is looked up again.
 */
const FALLBACK_RETRY_MS = 5 * 60_000;

/**
 * How long the known-good stand-in is used before the current version is looked up again: re-checking
 * a refused ~16 MB bundle costs seconds of parsing, and a client release changes rarely.
 */
const STAND_IN_RETRY_MS = 60 * 60_000;

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
          if (this.pending !== p) return;
          if (b.standInFor) this.fallbackUntil = now() + STAND_IN_RETRY_MS;
          else if (b.fallback) this.fallbackUntil = now() + FALLBACK_RETRY_MS;
        },
        (e) => {
          if (this.pending !== p) return;
          // A bundle this server cannot read stays unreadable: remember the refusal for a while
          // instead of re-reading and re-checking ~16 MB on every live call (#131).
          if (isDialectRefusal(e)) {
            this.fallbackUntil = now() + FALLBACK_RETRY_MS;
          } else this.pending = null;
        },
      );
    }
    return this.pending;
  }
}
