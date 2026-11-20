// Moving a data dir's history to another data dir (a local install's into a hosted child's
// `MCP_DATA_DIR`): one versioned bundle, gzipped JSON with a manifest (format, version, account id,
// created time, each file's path, sha256 and size) and the files' bytes.
//
// What travels is what war.app cannot give back: the salt behind every hashed key
// (`relations/players.salt`; the keys also carry my account id, so a bundle is one account's), the
// deal record and the per-game ledgers, the opponent profiles, the lessons, the map records and the
// end-of-game records with their processed marks — and, for games still in play only, the per-game
// files the planner reads (boards, game records, outlook, picks, move order, teams, the per-game
// profile turns, siege memory and contested-bonus attempts). Never: credentials (`.env`, `session.json`), the client bundle
// cache, the guess salt, chat cursors, the map cache and stats (all rebuilt), nor the per-game files
// of a finished game. A path outside {@link RULES} is never read on export nor written on import.
//
// Which games are active is read from the local records alone (no request, no credential): a game
// whose end-of-game record or processed mark exists, or whose game record says `Finished`, is
// finished; one whose game record says otherwise is active; one with no game record and no mark is
// unknown and left out.
//
// Import (`warapp_import_state`): every file's sha256 is checked against the manifest before
// anything is written; the bundle's account must be the signed-in one; a salt on record that differs
// from the bundle's refuses unless `replace`, and under `replace` the hashed stores written under the
// old salt (profiles, relations, finished, lessons, maps-record) are moved aside into
// `<dataDir>/state-backups/<time>/`, never deleted — entries under two salts would count a player or a
// game twice. Without `replace` an existing file that differs is kept; under it the bundle's wins and
// the displaced file goes to the same backup. The salt is written first, then every file atomically
// (0600, folders 0700), each under the path lock its store uses. Nothing here returns or prints the
// salt or a file's contents; errors name paths and counts only.
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { withPathLock } from './path-lock.js';
import { finishedGameKey } from './player-record-store.js';

export const STATE_FORMAT = 'warapp-state';
export const STATE_VERSION = 1;
/** The largest bundle accepted (compressed). */
export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
/** The largest bundle unpacked (a gzip bomb stops here). */
export const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
/** Where `replace` moves the old stores. */
export const BACKUP_DIR = 'state-backups';

export class StateBundleError extends Error {
  override name = 'StateBundleError';
}

/** The stores a bundle carries, as the counts name them. */
export const STORES = [
  'salt',
  'playerRecord',
  'ledgers',
  'profiles',
  'profileGames',
  'lessons',
  'mapsRecord',
  'finished',
  'games',
  'boards',
  'outlook',
  'picks',
  'moveOrder',
  'teams',
  'siege',
  'bonusAttempts',
] as const;
export type StoreName = (typeof STORES)[number];

interface Rule {
  store: StoreName;
  /** Folder (relative, '/'-separated) and file-name pattern. */
  dir: string;
  name: RegExp;
  /** Per game: the game id is group 1. Per game and account: the account is group 2. */
  game?: 'game' | 'game-account';
  /** Kept for finished games too (the ledgers), else active games only. */
  allGames?: boolean;
}

const RULES: readonly Rule[] = [
  { store: 'salt', dir: 'relations', name: /^players\.salt$/ },
  { store: 'playerRecord', dir: 'relations', name: /^players\.json$/ },
  { store: 'ledgers', dir: 'relations', name: /^(\d{1,12})-(\d{1,20})\.json$/, game: 'game-account', allGames: true },
  { store: 'profiles', dir: 'profiles', name: /^(players|population)\.json$/ },
  { store: 'profileGames', dir: 'profiles/games', name: /^(\d{1,12})-(\d{1,20})\.json$/, game: 'game-account' },
  { store: 'lessons', dir: '', name: /^lessons\.json$/ },
  { store: 'mapsRecord', dir: 'maps-record', name: /^\d{1,12}\.json$/ },
  { store: 'finished', dir: 'finished', name: /^([0-9a-f]{32}|processed)\.json$/ },
  { store: 'games', dir: 'games', name: /^(\d{1,12})\.json$/, game: 'game' },
  { store: 'boards', dir: 'boards', name: /^(\d{1,12})\.json$/, game: 'game' },
  { store: 'outlook', dir: 'outlook', name: /^(\d{1,12})\.json$/, game: 'game' },
  { store: 'picks', dir: 'picks', name: /^(\d{1,12})\.json$/, game: 'game' },
  { store: 'moveOrder', dir: 'move-order', name: /^(\d{1,12})\.json$/, game: 'game' },
  { store: 'teams', dir: 'teams', name: /^(\d{1,12})\.json$/, game: 'game' },
  { store: 'siege', dir: 'siege', name: /^(\d{1,12})-(\d{1,20})\.json$/, game: 'game-account' },
  // #410: the planner's contested-bonus attempt and drop memory (#405, src/bonus-attempt-store.ts).
  { store: 'bonusAttempts', dir: 'bonus-attempts', name: /^(\d{1,12})-(\d{1,20})\.json$/, game: 'game-account' },
];

/** Top-level entries keyed by the salt: moved aside whole under `replace` when the salt changes. */
const HASHED_ENTRIES = ['relations', 'profiles', 'finished', 'maps-record', 'lessons.json'] as const;

const SALT_PATH = 'relations/players.salt';
const SALT = /^[0-9a-f]{32}$/;

/** The rule a relative path falls under, with its game and account; `undefined` when none. */
function ruleOf(path: string): { rule: Rule; gameId?: number; account?: number } | undefined {
  const slash = path.lastIndexOf('/');
  const dir = slash === -1 ? '' : path.slice(0, slash);
  const name = path.slice(slash + 1);
  for (const rule of RULES) {
    if (rule.dir !== dir) continue;
    const m = rule.name.exec(name);
    if (!m) continue;
    if (!rule.game) return { rule };
    return { rule, gameId: Number(m[1]), ...(rule.game === 'game-account' ? { account: Number(m[2]) } : {}) };
  }
  return undefined;
}

/** The in-process lock a store takes for this file (src/path-lock.ts). */
function lockKey(dir: string, path: string): string {
  // The two cross-game profile stores share one lock (src/profile-store.ts `storeLock`).
  if (path === 'profiles/players.json' || path === 'profiles/population.json') return join(dir, 'profiles', '.store');
  return join(dir, path);
}

export interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
}
export interface Manifest {
  format: typeof STATE_FORMAT;
  version: number;
  accountId: number;
  createdAt: string;
  files: ManifestFile[];
}

export interface ExportResult {
  manifest: Manifest;
  files: { path: string; bytes: Buffer; store: StoreName; sha256: string }[];
  /** What was left out: per-game files of finished games and of games of unknown state (counted by game), other accounts' files. */
  leftOut: { finishedGames: number; unknownGames: number; otherAccountFiles: number };
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

async function listDir(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => [] as string[]);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Every candidate file of the rules under `dir` (regular files only), as relative paths. */
async function candidates(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const sub of [...new Set(RULES.map((r) => r.dir))]) {
    for (const name of await listDir(join(dir, sub))) {
      const rel = sub ? `${sub}/${name}` : name;
      if (!ruleOf(rel)) continue;
      const st = await lstat(join(dir, rel)).catch(() => undefined);
      if (st?.isFile()) out.push(rel);
    }
  }
  return out.sort();
}

/**
 * Collect the export of `dir` for one account (`account`, else the one account the per-account files
 * name). Throws {@link StateBundleError} when there is no valid salt or the account cannot be told.
 */
export async function collectExport(dir: string, opts: { account?: number; now?: Date } = {}): Promise<ExportResult> {
  const saltText = await readFile(join(dir, SALT_PATH), 'utf8').catch(() => undefined);
  const salt = saltText?.trim();
  if (!salt || !SALT.test(salt)) {
    throw new StateBundleError('No usable salt (relations/players.salt) in this data dir, so there is no hashed history to export.');
  }
  const paths = await candidates(dir);
  const accounts = new Set<number>();
  for (const p of paths) {
    const a = ruleOf(p)!.account;
    if (a !== undefined) accounts.add(a);
  }
  // The board caches name the account that planned (`playerId`): the clearest witness.
  const planners = new Set<number>();
  for (const p of paths) {
    if (!p.startsWith('boards/')) continue;
    const c = await readJson(join(dir, p));
    if (isRec(c) && typeof c.playerId === 'number') planners.add(c.playerId);
  }
  let account = opts.account;
  if (account === undefined && planners.size === 1) account = [...planners][0]!;
  if (account === undefined) {
    if (accounts.size !== 1) {
      throw new StateBundleError(
        accounts.size === 0
          ? 'No per-account file names the account; pass --account <your war.app player id>.'
          : `${accounts.size} accounts have files in this data dir; pass --account <your war.app player id>.`,
      );
    }
    account = [...accounts][0]!;
  }
  if (!Number.isSafeInteger(account) || account <= 0) throw new StateBundleError('The account must be a positive integer.');

  // Which games are finished: the end-of-game record or processed mark, else the game record's state.
  const marks = await readJson(join(dir, 'finished', 'processed.json'));
  const marked = new Set(isRec(marks) && Array.isArray(marks.keys) ? marks.keys.filter((k): k is string => typeof k === 'string') : []);
  const status = new Map<number, 'active' | 'finished' | 'unknown'>();
  const statusOf = async (gameId: number) => {
    const known = status.get(gameId);
    if (known) return known;
    const key = finishedGameKey(salt, account!, gameId);
    let s: 'active' | 'finished' | 'unknown';
    const hasRecord = await lstat(join(dir, 'finished', `${key}.json`)).then(() => true, () => false);
    if (marked.has(key) || hasRecord) s = 'finished';
    else {
      const rec = await readJson(join(dir, 'games', `${gameId}.json`));
      s = isRec(rec) && typeof rec.state === 'string' ? (rec.state === 'Finished' ? 'finished' : 'active') : 'unknown';
    }
    status.set(gameId, s);
    return s;
  };

  const files: ExportResult['files'] = [];
  const finishedGames = new Set<number>();
  const unknownGames = new Set<number>();
  let otherAccountFiles = 0;
  for (const p of paths) {
    const { rule, gameId, account: a } = ruleOf(p)!;
    if (a !== undefined && a !== account) {
      otherAccountFiles++;
      continue;
    }
    if (gameId !== undefined && !rule.allGames) {
      const s = await statusOf(gameId);
      if (s === 'finished') {
        finishedGames.add(gameId);
        continue;
      }
      if (s === 'unknown') {
        unknownGames.add(gameId);
        continue;
      }
    }
    const bytes = await readFile(join(dir, p));
    files.push({ path: p, bytes, store: rule.store, sha256: sha256(bytes) });
  }
  return {
    manifest: {
      format: STATE_FORMAT,
      version: STATE_VERSION,
      accountId: account,
      createdAt: (opts.now ?? new Date()).toISOString(),
      files: files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.bytes.length })),
    },
    files,
    leftOut: { finishedGames: finishedGames.size, unknownGames: unknownGames.size, otherAccountFiles },
  };
}

/** The bundle's bytes: gzipped JSON `{ format, version, manifest, files: { path: base64 } }`. */
export function encodeBundle(r: Pick<ExportResult, 'manifest' | 'files'>): Buffer {
  const body = {
    format: STATE_FORMAT,
    version: STATE_VERSION,
    manifest: r.manifest,
    files: Object.fromEntries(r.files.map((f) => [f.path, f.bytes.toString('base64')])),
  };
  return gzipSync(JSON.stringify(body), { level: 9 });
}

/** Write a bundle to `out`, 0600 and atomically; refuses an existing file unless `force`. */
export async function writeBundleFile(out: string, bytes: Uint8Array, opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force && (await lstat(out).then(() => true, () => false))) {
    throw new StateBundleError(`${out} already exists; pass --force to replace it.`);
  }
  const tmp = `${out}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
  try {
    await chmod(tmp, 0o600);
    await rename(tmp, out);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/** A decoded, verified bundle. */
export interface StateBundle {
  manifest: Manifest;
  /** Relative path → bytes, every one matching the manifest. */
  files: Map<string, Buffer>;
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode and verify a bundle: format and version, every path one a store owns (no traversal, no
 * credential), every per-account file the bundle's account, each file's size and sha256 as the
 * manifest says, every `.json` parsing, a salt present and well formed. Throws
 * {@link StateBundleError} naming paths only, never contents.
 */
export function decodeBundle(bytes: Uint8Array): StateBundle {
  if (bytes.length > MAX_BUNDLE_BYTES) throw new StateBundleError(`The bundle is larger than ${MAX_BUNDLE_BYTES} bytes.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES }).toString('utf8'));
  } catch {
    throw new StateBundleError('This is not a warapp-mcp state bundle (not gzipped JSON, or too large unpacked).');
  }
  if (!isRec(parsed) || parsed.format !== STATE_FORMAT) throw new StateBundleError('This is not a warapp-mcp state bundle (wrong format).');
  if (parsed.version !== STATE_VERSION) {
    throw new StateBundleError(`The bundle's format version is not supported here (this server reads version ${STATE_VERSION}).`);
  }
  const m = parsed.manifest;
  if (
    !isRec(m) ||
    m.format !== STATE_FORMAT ||
    m.version !== STATE_VERSION ||
    typeof m.accountId !== 'number' ||
    !Number.isSafeInteger(m.accountId) ||
    m.accountId <= 0 ||
    typeof m.createdAt !== 'string' ||
    !Array.isArray(m.files) ||
    !isRec(parsed.files)
  ) {
    throw new StateBundleError('The bundle manifest is malformed.');
  }
  const accountId = m.accountId;
  const contents = parsed.files as Rec;
  const files = new Map<string, Buffer>();
  const list: ManifestFile[] = [];
  for (const f of m.files) {
    if (!isRec(f) || typeof f.path !== 'string' || typeof f.sha256 !== 'string' || typeof f.size !== 'number') {
      throw new StateBundleError('The bundle manifest has a malformed file entry.');
    }
    const path = f.path;
    const r = ruleOf(path);
    if (!r || path.includes('..') || path.startsWith('/')) throw new StateBundleError(`The bundle carries a path no store owns: ${JSON.stringify(path.slice(0, 80))}.`);
    if (r.account !== undefined && r.account !== accountId) throw new StateBundleError(`The bundle carries a file of another account (${path}).`);
    if (files.has(path)) throw new StateBundleError(`The bundle lists ${path} twice.`);
    const b64 = contents[path];
    if (typeof b64 !== 'string' || !B64.test(b64)) throw new StateBundleError(`The bundle has no readable content for ${path}.`);
    const body = Buffer.from(b64, 'base64');
    if (body.toString('base64') !== b64) throw new StateBundleError(`The content of ${path} is not canonical base64.`);
    if (sha256(body) !== f.sha256) throw new StateBundleError(`The sha256 of ${path} does not match the manifest, so nothing was imported.`);
    if (body.length !== f.size) throw new StateBundleError(`The size of ${path} does not match the manifest.`);
    if (path.endsWith('.json')) {
      try {
        JSON.parse(body.toString('utf8'));
      } catch {
        throw new StateBundleError(`${path} is not valid JSON.`);
      }
    }
    files.set(path, body);
    list.push({ path, sha256: f.sha256, size: f.size });
  }
  for (const p of Object.keys(contents)) if (!files.has(p)) throw new StateBundleError('The bundle carries content the manifest does not list.');
  const salt = files.get(SALT_PATH)?.toString('utf8').trim();
  if (!salt || !SALT.test(salt)) throw new StateBundleError('The bundle has no usable salt (relations/players.salt).');
  return { manifest: { format: STATE_FORMAT, version: STATE_VERSION, accountId, createdAt: m.createdAt, files: list }, files };
}

export type SaltState = 'absent' | 'same' | 'different' | 'malformed';
export interface StoreCount {
  files: number;
  bytes: number;
  /** Not on disk yet. */
  new: number;
  /** On disk, byte for byte. */
  same: number;
  /** On disk, different. */
  differ: number;
}
export interface ImportPlan {
  accountId: number;
  signedIn: number | undefined;
  accountMatches: boolean;
  /** The salt on record against the bundle's (never the salt itself). */
  salt: SaltState;
  createdAt: string;
  stores: Partial<Record<StoreName, StoreCount>>;
  totals: { files: number; bytes: number };
  /** Files on disk that differ from the bundle's (kept without `replace`). */
  conflicts: number;
}

async function saltState(dir: string, bundle: StateBundle): Promise<SaltState> {
  let text: string;
  try {
    text = await readFile(join(dir, SALT_PATH), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'malformed';
  }
  const t = text.trim();
  if (!SALT.test(t)) return 'malformed';
  return t === bundle.files.get(SALT_PATH)!.toString('utf8').trim() ? 'same' : 'different';
}

async function onDisk(path: string): Promise<Buffer | undefined> {
  return readFile(path).catch(() => undefined);
}

/** What an import of `bundle` into `dir` would do, for `signedIn` (the signed-in account). Writes nothing. */
export async function planImport(dir: string, bundle: StateBundle, signedIn: number | undefined): Promise<ImportPlan> {
  const salt = await saltState(dir, bundle);
  const stores: Partial<Record<StoreName, StoreCount>> = {};
  let conflicts = 0;
  let total = 0;
  for (const [path, body] of bundle.files) {
    const store = ruleOf(path)!.rule.store;
    const c = (stores[store] ??= { files: 0, bytes: 0, new: 0, same: 0, differ: 0 });
    c.files++;
    c.bytes += body.length;
    total += body.length;
    const existing = await onDisk(join(dir, path));
    if (!existing) c.new++;
    else if (existing.equals(body)) c.same++;
    else {
      c.differ++;
      if (path !== SALT_PATH) conflicts++;
    }
  }
  return {
    accountId: bundle.manifest.accountId,
    signedIn,
    accountMatches: signedIn === bundle.manifest.accountId,
    salt,
    createdAt: bundle.manifest.createdAt,
    stores,
    totals: { files: bundle.files.size, bytes: total },
    conflicts,
  };
}

export interface ImportResult {
  written: number;
  unchanged: number;
  /** Existing files that differ, kept (no `replace`). */
  kept: number;
  /** Relative folder the old stores and displaced files were moved into (`replace`). */
  backup?: string;
  /** Top-level entries moved aside whole (the hashed stores under the old salt). */
  movedAside?: string[];
  /** Displaced single files moved into the backup. */
  displaced?: number;
}

/** Make `path`'s parent folders (0700) under `root`. */
async function ensureDirs(root: string, rel: string): Promise<void> {
  const parts = rel.split('/').slice(0, -1);
  let cur = root;
  for (const p of parts) {
    cur = join(cur, p);
    await mkdir(cur, { recursive: true, mode: 0o700 });
    await chmod(cur, 0o700);
  }
}

async function writeAtomic(path: string, body: Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, body, { mode: 0o600, flag: 'wx' });
  try {
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/** A fresh backup folder `state-backups/<time>[-n]` (0700), as a relative path. */
async function makeBackup(dir: string, now: Date): Promise<string> {
  await mkdir(join(dir, BACKUP_DIR), { recursive: true, mode: 0o700 });
  await chmod(join(dir, BACKUP_DIR), 0o700);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  for (let n = 0; ; n++) {
    const rel = `${BACKUP_DIR}/${stamp}${n ? `-${n}` : ''}`;
    try {
      await mkdir(join(dir, rel), { mode: 0o700 });
      await chmod(join(dir, rel), 0o700);
      return rel;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n > 100) throw e;
    }
  }
}

/**
 * Import `bundle` into `dir` as `signedIn`. Refuses another account, and a salt on record that is not
 * the bundle's unless `replace` (see the module header). Re-checks everything the plan showed, since
 * the store may have changed since the preview.
 */
export async function applyImport(
  dir: string,
  bundle: StateBundle,
  opts: { signedIn: number | undefined; replace?: boolean; now?: Date },
): Promise<ImportResult> {
  if (opts.signedIn !== bundle.manifest.accountId) {
    throw new StateBundleError(
      `The bundle is for war.app account ${bundle.manifest.accountId}, but ${opts.signedIn === undefined ? 'the signed-in account could not be read' : `account ${opts.signedIn} is signed in`}, so nothing was imported.`,
    );
  }
  // One import at a time per data dir.
  return withPathLock(join(dir, '.state-import'), async () => {
    const salt = await saltState(dir, bundle);
    if ((salt === 'different' || salt === 'malformed') && !opts.replace) {
      throw new StateBundleError(
        `This server already has a ${salt === 'malformed' ? 'malformed' : 'different'} salt, so its hashed history cannot be merged with the bundle's; nothing was imported. Pass replace: true to move this server's hashed stores aside (backed up, not deleted) and take the bundle's.`,
      );
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let backup: string | undefined;
    const backupDir = async () => (backup ??= await makeBackup(dir, opts.now ?? new Date()));
    const movedAside: string[] = [];
    if (opts.replace && salt !== 'same') {
      for (const entry of HASHED_ENTRIES) {
        const from = join(dir, entry);
        if (!(await lstat(from).then(() => true, () => false))) continue;
        const to = join(dir, await backupDir(), entry);
        await withPathLock(entry === 'lessons.json' ? from : join(dir, entry, '.state-import'), () => rename(from, to));
        movedAside.push(entry);
      }
    }
    let written = 0;
    let unchanged = 0;
    let kept = 0;
    let displaced = 0;
    // The salt first: whatever fails after it, what landed is keyed under the salt on record.
    const order = [SALT_PATH, ...[...bundle.files.keys()].filter((p) => p !== SALT_PATH).sort()];
    for (const rel of order) {
      const body = bundle.files.get(rel)!;
      const path = join(dir, rel);
      await withPathLock(lockKey(dir, rel), async () => {
        const existing = await onDisk(path);
        if (existing?.equals(body)) {
          unchanged++;
          return;
        }
        if (existing && !opts.replace) {
          kept++;
          return;
        }
        await ensureDirs(dir, rel);
        if (existing) {
          const b = await backupDir();
          await ensureDirs(join(dir, b), rel);
          await rename(path, join(dir, b, rel));
          displaced++;
        }
        if (rel === SALT_PATH) {
          // Never over a salt another writer made in between (link fails when the file exists).
          const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
          await writeFile(tmp, body, { mode: 0o600, flag: 'wx' });
          try {
            await chmod(tmp, 0o600);
            await link(tmp, path);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
              throw new StateBundleError('A salt was made on this server while importing, so nothing more was imported. Preview the import again.');
            }
            throw e;
          } finally {
            await unlink(tmp).catch(() => undefined);
          }
        } else {
          await writeAtomic(path, body);
        }
        written++;
      });
    }
    return {
      written,
      unchanged,
      kept,
      ...(backup ? { backup } : {}),
      ...(movedAside.length ? { movedAside } : {}),
      ...(displaced ? { displaced } : {}),
    };
  });
}

/** Whole bytes as a short human size ("1.6 MB"). */
export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

