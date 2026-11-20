// The state bundle (export a local install's history, import it into another data dir, e.g. a hosted
// child's MCP_DATA_DIR). Synthetic data dirs only: never the real ~/.config/warapp-mcp.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { finishedGameKey } from '../src/player-record-store.js';
import {
  applyImport,
  collectExport,
  decodeBundle,
  encodeBundle,
  MAX_BUNDLE_BYTES,
  MAX_EXPORT_DECISION_BYTES,
  MAX_UNPACKED_BYTES,
  planImport,
  StateBundleError,
  STATE_FORMAT,
  STATE_VERSION,
  writeBundleFile,
} from '../src/state-bundle.js';

// Every whole-file read the code under test makes, by path (a head read opens the file instead).
const wholeReads = vi.hoisted(() => [] as string[]);
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = ((path: Parameters<typeof real.readFile>[0], ...rest: unknown[]) => {
    wholeReads.push(String(path));
    return (real.readFile as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof real.readFile;
  return { ...real, default: { ...real, readFile }, readFile };
});

const ME = 4412345677;
const OTHER = 7176543229;
const ACTIVE = 111;
const DONE = 222;
const UNKNOWN = 333;
const SALT = 'a'.repeat(32);
const OTHER_SALT = 'b'.repeat(32);

function put(dir: string, rel: string, body: string | object): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
}

/** A local data dir with every store, credentials and the stores that must not travel. */
function localDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'warapp-state-src-'));
  put(dir, '.env', 'WARAPP_EMAIL=secret@example.com\nWARAPP_API_TOKEN=tok-secret\n');
  put(dir, 'session.json', { cookie: 'session-secret' });
  put(dir, 'relations/players.salt', SALT);
  put(dir, 'relations/players.json', { version: 3, players: {} });
  put(dir, `relations/${ACTIVE}-${ME}.json`, { gameId: ACTIVE, playerId: ME, agreements: [], usage: {} });
  put(dir, `relations/${DONE}-${ME}.json`, { gameId: DONE, playerId: ME, agreements: [], usage: {} });
  put(dir, `relations/${ACTIVE}-${OTHER}.json`, { gameId: ACTIVE, playerId: OTHER, agreements: [], usage: {} });
  put(dir, 'profiles/players.json', { version: 1, players: {} });
  put(dir, 'profiles/population.json', { version: 1 });
  put(dir, `profiles/games/${ACTIVE}-${ME}.json`, { version: 1 });
  put(dir, `profiles/games/${DONE}-${ME}.json`, { version: 1 });
  put(dir, 'lessons.json', { version: 1 });
  put(dir, 'maps-record/77.json', { version: 1 });
  put(dir, `finished/${finishedGameKey(SALT, ME, DONE)}.json`, { version: 1, status: 'captured' });
  put(dir, 'finished/processed.json', { version: 1, keys: [finishedGameKey(SALT, ME, DONE)] });
  put(dir, `games/${ACTIVE}.json`, { version: 1, gameId: ACTIVE, state: 'Playing' });
  put(dir, `games/${DONE}.json`, { version: 1, gameId: DONE, state: 'Playing' }); // stale: the finished mark wins
  for (const g of [ACTIVE, DONE, UNKNOWN]) put(dir, `boards/${g}.json`, { gameId: g, playerId: ME });
  for (const s of ['outlook', 'picks', 'move-order', 'teams']) {
    put(dir, `${s}/${ACTIVE}.json`, { gameId: ACTIVE });
    put(dir, `${s}/${DONE}.json`, { gameId: DONE });
  }
  put(dir, `siege/${ACTIVE}-${ME}.json`, { v: 1 });
  put(dir, `bonus-attempts/${ACTIVE}-${ME}.json`, { v: 1 }); // #410
  // #412: decision logs travel for finished games too; another account's (named inside) stays.
  put(dir, `decisions/${ACTIVE}.json`, { version: 1, gameId: ACTIVE, playerId: ME, status: 'active', turns: {} });
  put(dir, `decisions/${DONE}.json`, { version: 1, gameId: DONE, playerId: ME, status: 'compacted', turns: {} });
  put(dir, `decisions/${UNKNOWN}.json`, { version: 1, gameId: UNKNOWN, playerId: OTHER, status: 'active', turns: {} });
  put(dir, 'bundle/known-good.json', { v: 1 });
  put(dir, 'guess-salt', 'c'.repeat(32));
  put(dir, `chat/${ACTIVE}.json`, { v: 1 });
  put(dir, 'maps/77.json', { v: 1 });
  put(dir, 'stats/x.json', { v: 1 });
  put(dir, 'relations/players.json.123.tmp', 'half written');
  return dir;
}

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

async function exported(dir = localDir()) {
  const result = await collectExport(dir, { now: new Date('2026-11-19T12:00:00Z') });
  return { dir, result, bytes: encodeBundle(result) };
}

describe('collectExport', () => {
  it('takes the stores that cannot be rebuilt, and the per-game files of active games only', async () => {
    const { result } = await exported();
    expect(result.manifest.accountId).toBe(ME);
    expect(result.files.map((f) => f.path).sort()).toEqual(
      [
        'relations/players.salt',
        'relations/players.json',
        `relations/${ACTIVE}-${ME}.json`,
        `relations/${DONE}-${ME}.json`,
        'profiles/players.json',
        'profiles/population.json',
        `profiles/games/${ACTIVE}-${ME}.json`,
        'lessons.json',
        'maps-record/77.json',
        `finished/${finishedGameKey(SALT, ME, DONE)}.json`,
        'finished/processed.json',
        `games/${ACTIVE}.json`,
        `boards/${ACTIVE}.json`,
        `outlook/${ACTIVE}.json`,
        `picks/${ACTIVE}.json`,
        `move-order/${ACTIVE}.json`,
        `teams/${ACTIVE}.json`,
        `siege/${ACTIVE}-${ME}.json`,
        `bonus-attempts/${ACTIVE}-${ME}.json`,
        `decisions/${ACTIVE}.json`,
        `decisions/${DONE}.json`,
      ].sort(),
    );
    expect(result.leftOut).toEqual({ finishedGames: 1, unknownGames: 1, otherAccountFiles: 2, decisionLogs: 0 });
  });

  it('bounds the decision logs it carries, newest first, counting the ones left out (#412)', async () => {
    const dir = localDir();
    // Three more of my logs, each about 1 kB, written a day apart (oldest 9001).
    const pad = 'x'.repeat(1000);
    for (const [i, g] of [9001, 9002, 9003].entries()) {
      put(dir, `decisions/${g}.json`, { version: 1, gameId: g, playerId: ME, status: 'compacted', turns: { '1': { pad } } });
      const when = new Date(Date.UTC(2026, 0, 10 + i));
      utimesSync(join(dir, `decisions/${g}.json`), when, when);
    }
    for (const g of [ACTIVE, DONE]) {
      const when = new Date(Date.UTC(2026, 0, 1));
      utimesSync(join(dir, `decisions/${g}.json`), when, when);
    }
    // Room for two of the big ones: the newest two go, the rest (older, small ones too) stay home.
    const result = await collectExport(dir, { decisionBytes: 2500 });
    const kept = result.files.filter((f) => f.store === 'decisions').map((f) => f.path);
    expect(kept.sort()).toEqual(['decisions/9002.json', 'decisions/9003.json']);
    expect(result.leftOut.decisionLogs).toBe(3);
    // The other stores are untouched by the bound.
    expect(result.files.some((f) => f.path === 'relations/players.salt')).toBe(true);
  });

  it('tells a decision log\'s account from its head: a log past the share is never read whole (#412)', async () => {
    const dir = localDir();
    const pad = 'x'.repeat(4000);
    put(dir, 'decisions/9001.json', { version: 1, gameId: 9001, playerId: ME, status: 'compacted', turns: { '1': { pad } } });
    put(dir, 'decisions/9002.json', { version: 1, gameId: 9002, playerId: OTHER, status: 'compacted', turns: { '1': { pad } } });
    const when = new Date(Date.UTC(2026, 0, 10));
    utimesSync(join(dir, 'decisions/9001.json'), when, when);
    wholeReads.length = 0;
    const result = await collectExport(dir, { decisionBytes: 2500 });
    expect(result.files.some((f) => f.path === 'decisions/9001.json')).toBe(false);
    expect(result.leftOut.decisionLogs).toBe(1);
    expect(result.leftOut.otherAccountFiles).toBe(3);
    // Neither big log was read whole: one is another account's (its head says so), one past the share.
    expect(wholeReads.filter((p) => p.endsWith('decisions/9001.json') || p.endsWith('decisions/9002.json'))).toEqual([]);
    // The ones exported are read once each.
    const kept = result.files.filter((f) => f.store === 'decisions').map((f) => f.path);
    for (const k of kept) expect(wholeReads.filter((p) => p.endsWith(k))).toHaveLength(1);
  });

  it('keeps the default decision-log share far under what an import accepts', () => {
    // Base64 inside the JSON is 4/3 of the raw bytes; the rest of the bundle needs its room too.
    expect((MAX_EXPORT_DECISION_BYTES * 4) / 3).toBeLessThanOrEqual(MAX_UNPACKED_BYTES / 4);
    // Even incompressible, the decision logs alone stay under the compressed cap.
    expect((MAX_EXPORT_DECISION_BYTES * 4) / 3).toBeLessThan(MAX_BUNDLE_BYTES);
  });

  it('never includes credentials, the bundle cache, chat, maps, stats or the guess salt', async () => {
    const { result, bytes } = await exported();
    const paths = result.files.map((f) => f.path);
    for (const p of paths) expect(p).not.toMatch(/\.env|session|bundle\/|guess-salt|chat\/|^maps\/|stats\/|\.tmp$/);
    const text = gunzipSync(bytes).toString('utf8');
    for (const s of ['secret@example.com', 'tok-secret', 'session-secret']) expect(text).not.toContain(s);
  });

  it('writes a versioned manifest with each file sha256 and size', async () => {
    const { dir, result } = await exported();
    expect(result.manifest).toMatchObject({ format: STATE_FORMAT, version: STATE_VERSION, createdAt: '2026-11-19T12:00:00.000Z' });
    for (const f of result.manifest.files) {
      const body = readFileSync(join(dir, f.path));
      expect(f).toEqual({ path: f.path, sha256: sha(body), size: body.length });
    }
  });

  it('refuses a dir with no salt (nothing hashed to carry)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-state-src-'));
    await expect(collectExport(dir)).rejects.toThrow(StateBundleError);
  });

  it('refuses when two accounts are on record and none is named, and takes the named one', async () => {
    const dir = localDir();
    put(dir, `profiles/games/${ACTIVE}-${OTHER}.json`, { version: 1 });
    put(dir, `boards/${UNKNOWN}.json`, { gameId: UNKNOWN, playerId: OTHER });
    await expect(collectExport(dir)).rejects.toThrow(/--account/);
    const r = await collectExport(dir, { account: OTHER });
    expect(r.manifest.accountId).toBe(OTHER);
  });

  it('writes the bundle 0600 and refuses to overwrite without force', async () => {
    const { bytes } = await exported();
    const out = join(mkdtempSync(join(tmpdir(), 'warapp-state-out-')), 'state.json.gz');
    await writeBundleFile(out, bytes);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    await expect(writeBundleFile(out, bytes)).rejects.toThrow(/exists/);
    await writeBundleFile(out, bytes, { force: true });
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });
});

describe('decodeBundle', () => {
  it('round-trips', async () => {
    const { result, bytes } = await exported();
    const b = decodeBundle(bytes);
    expect(b.manifest).toEqual(result.manifest);
    expect([...b.files.keys()].sort()).toEqual(result.files.map((f) => f.path).sort());
  });

  /** Re-pack a bundle after `edit` changed its JSON. */
  const repack = (bytes: Uint8Array, edit: (j: { manifest: { files: { path: string; sha256: string }[]; accountId: unknown }; files: Record<string, string> }) => void) => {
    const j = JSON.parse(gunzipSync(bytes).toString('utf8'));
    edit(j);
    return gzipSync(JSON.stringify(j));
  };

  it('refuses a file whose sha256 does not match the manifest', async () => {
    const { bytes } = await exported();
    const bad = repack(bytes, (j) => {
      j.files['lessons.json'] = Buffer.from('{"tampered":true}').toString('base64');
    });
    expect(() => decodeBundle(bad)).toThrow(/sha256/);
  });

  it('refuses a path outside the stores, a credential, or a traversal', async () => {
    const { bytes } = await exported();
    for (const path of ['.env', 'session.json', '../evil.json', 'relations/../../x.json', 'bundle/x.js', '/abs.json']) {
      const bad = repack(bytes, (j) => {
        const body = Buffer.from('{}');
        j.files[path] = body.toString('base64');
        j.manifest.files.push({ path, sha256: sha(body), size: body.length } as never);
      });
      expect(() => decodeBundle(bad), path).toThrow(StateBundleError);
    }
  });

  it('refuses another format, a newer version, junk, and a per-account file of another account', async () => {
    const { bytes } = await exported();
    expect(() => decodeBundle(Buffer.from('not gzip'))).toThrow(StateBundleError);
    expect(() => decodeBundle(gzipSync('{"format":"other"}'))).toThrow(StateBundleError);
    expect(() => decodeBundle(repack(bytes, (j) => ((j as unknown as { version: number }).version = 99)))).toThrow(/version/);
    const other = repack(bytes, (j) => {
      const path = `relations/${ACTIVE}-${OTHER}.json`;
      const body = Buffer.from('{}');
      j.files[path] = body.toString('base64');
      j.manifest.files.push({ path, sha256: sha(body), size: body.length } as never);
    });
    expect(() => decodeBundle(other)).toThrow(/account/);
    // #412: a decision log names its account inside the file.
    const otherLog = repack(bytes, (j) => {
      const path = `decisions/${UNKNOWN}.json`;
      const body = Buffer.from(JSON.stringify({ version: 1, gameId: UNKNOWN, playerId: OTHER, status: 'active', turns: {} }));
      j.files[path] = body.toString('base64');
      j.manifest.files.push({ path, sha256: sha(body), size: body.length } as never);
    });
    expect(() => decodeBundle(otherLog)).toThrow(/account/);
  });

  it('never echoes file contents in an error', async () => {
    const { bytes } = await exported();
    const bad = repack(bytes, (j) => {
      const body = Buffer.from('{"secretValue": oops');
      j.files['lessons.json'] = body.toString('base64');
      const f = j.manifest.files.find((x) => x.path === 'lessons.json')!;
      f.sha256 = sha(body);
      (f as unknown as { size: number }).size = body.length;
    });
    try {
      decodeBundle(bad);
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/secretValue|oops/);
    }
  });
});

describe('planImport and applyImport', () => {
  it('round-trips into an empty dir: every file, 0600 in 0700 folders, nothing else', async () => {
    const { dir, result, bytes } = await exported();
    const target = mkdtempSync(join(tmpdir(), 'warapp-state-dst-'));
    const bundle = decodeBundle(bytes);
    const plan = await planImport(target, bundle, ME);
    expect(plan).toMatchObject({ accountId: ME, signedIn: ME, accountMatches: true, salt: 'absent', conflicts: 0 });
    expect(plan.stores.salt).toEqual({ files: 1, bytes: 32, new: 1, same: 0, differ: 0 });
    const r = await applyImport(target, bundle, { signedIn: ME });
    expect(r).toMatchObject({ written: result.files.length, unchanged: 0, kept: 0 });
    for (const f of result.files) {
      const p = join(target, f.path);
      expect(readFileSync(p)).toEqual(readFileSync(join(dir, f.path)));
      expect(statSync(p).mode & 0o777, f.path).toBe(0o600);
      expect(statSync(dirname(p)).mode & 0o777, f.path).toBe(0o700);
    }
    expect(existsSync(join(target, '.env'))).toBe(false);
    // Again: nothing to write.
    const again = await applyImport(target, bundle, { signedIn: ME });
    expect(again).toMatchObject({ written: 0, unchanged: result.files.length });
  });

  it('refuses a bundle of another account', async () => {
    const { bytes } = await exported();
    const target = mkdtempSync(join(tmpdir(), 'warapp-state-dst-'));
    const bundle = decodeBundle(bytes);
    expect((await planImport(target, bundle, OTHER)).accountMatches).toBe(false);
    await expect(applyImport(target, bundle, { signedIn: OTHER })).rejects.toThrow(/account/);
    expect(existsSync(join(target, 'relations'))).toBe(false);
  });

  it('refuses a different salt unless replace, and writes nothing', async () => {
    const { bytes } = await exported();
    const target = mkdtempSync(join(tmpdir(), 'warapp-state-dst-'));
    put(target, 'relations/players.salt', OTHER_SALT);
    put(target, 'lessons.json', { hosted: true });
    const bundle = decodeBundle(bytes);
    expect((await planImport(target, bundle, ME)).salt).toBe('different');
    await expect(applyImport(target, bundle, { signedIn: ME })).rejects.toThrow(/replace/);
    expect(readFileSync(join(target, 'relations/players.salt'), 'utf8')).toBe(OTHER_SALT);
    expect(JSON.parse(readFileSync(join(target, 'lessons.json'), 'utf8'))).toEqual({ hosted: true });
  });

  it('under replace, moves the hashed stores written under the old salt aside, never deletes them', async () => {
    const { result, bytes } = await exported();
    const target = mkdtempSync(join(tmpdir(), 'warapp-state-dst-'));
    put(target, 'relations/players.salt', OTHER_SALT);
    put(target, 'relations/players.json', { hosted: 'record' });
    put(target, 'profiles/players.json', { hosted: 'profiles' });
    put(target, 'finished/processed.json', { hosted: 'marks' });
    put(target, 'lessons.json', { hosted: 'lessons' });
    put(target, 'maps-record/12.json', { hosted: 'map' });
    put(target, `boards/${ACTIVE}.json`, { hosted: 'board' });
    put(target, 'boards/999.json', { hosted: 'other board' });
    const bundle = decodeBundle(bytes);
    const r = await applyImport(target, bundle, { signedIn: ME, replace: true, now: new Date('2026-11-19T13:00:00Z') });
    expect(r.backup).toMatch(/^state-backups\/2026-11-19T13-00-00-000Z$/);
    const backup = join(target, r.backup!);
    expect(statSync(backup).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(backup, 'relations/players.salt'), 'utf8')).toBe(OTHER_SALT);
    expect(JSON.parse(readFileSync(join(backup, 'profiles/players.json'), 'utf8'))).toEqual({ hosted: 'profiles' });
    expect(JSON.parse(readFileSync(join(backup, 'finished/processed.json'), 'utf8'))).toEqual({ hosted: 'marks' });
    expect(JSON.parse(readFileSync(join(backup, 'lessons.json'), 'utf8'))).toEqual({ hosted: 'lessons' });
    expect(JSON.parse(readFileSync(join(backup, 'maps-record/12.json'), 'utf8'))).toEqual({ hosted: 'map' });
    // A displaced per-game file goes to the backup too; one the bundle does not carry stays where it is.
    expect(JSON.parse(readFileSync(join(backup, `boards/${ACTIVE}.json`), 'utf8'))).toEqual({ hosted: 'board' });
    expect(JSON.parse(readFileSync(join(target, 'boards/999.json'), 'utf8'))).toEqual({ hosted: 'other board' });
    // The bundle is now what is on record, and no entry under the old salt is left beside it.
    expect(readFileSync(join(target, 'relations/players.salt'), 'utf8')).toBe(SALT);
    expect(existsSync(join(target, 'maps-record/12.json'))).toBe(false);
    for (const f of result.files) expect(sha(readFileSync(join(target, f.path))), f.path).toBe(f.sha256);
  });

  it('with the same salt, keeps existing files that differ unless replace', async () => {
    const { bytes } = await exported();
    const target = mkdtempSync(join(tmpdir(), 'warapp-state-dst-'));
    put(target, 'relations/players.salt', SALT);
    put(target, 'lessons.json', { newer: true });
    const bundle = decodeBundle(bytes);
    const plan = await planImport(target, bundle, ME);
    expect(plan).toMatchObject({ salt: 'same', conflicts: 1 });
    const r = await applyImport(target, bundle, { signedIn: ME });
    expect(r.kept).toBe(1);
    expect(JSON.parse(readFileSync(join(target, 'lessons.json'), 'utf8'))).toEqual({ newer: true });
    expect(readdirSync(target)).not.toContain('state-backups');
  });
});
