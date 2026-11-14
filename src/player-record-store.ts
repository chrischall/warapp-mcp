// The cross-game player record on disk (docs/PLAN-TEAMS.md A2, owner decision D5 of 2026-11-14: ON,
// local and hosted — a hosted child keeps it in its per-user data dir, `state.dataDir` in mint.yaml).
// At `<dataDir>/relations/players.json` (version 3): per player, the name-free entries and the
// tallies of `src/analysis/player-record.ts`, and when they last changed. The player is keyed by an
// HMAC of its GameFeed id under a local secret salt (`<dataDir>/relations/players.salt`, 0600), and
// each entry by an HMAC of my account, the game and the agreement (the ledger is per account, so two
// accounts sharing a data dir never collide; entries written before the account was in the key are
// read as they are, `legacyEntryKey`): the file holds no player id, game id or name, and without the
// salt it cannot be joined to a game or a player.
//
// The salt is made only on the write path, never by a read; a salt file that exists but is
// malformed is never replaced (that would orphan every key on record): reads say `unreadable` and
// writes fail until the owner fixes or removes it. A record file that exists but cannot be read or
// parsed (bad JSON, not an object, no `players` object) is treated the same way — never moved aside,
// never overwritten, since writing over it would drop every other player's data: reads say
// `unreadable` and writes fail until the owner fixes or removes it. A missing file is empty.
//
// Bounded (`MAX_RECORD_ENTRIES` per player, `MAX_RECORD_PLAYERS` players). Isolated so it can be
// switched off: `WARAPP_PLAYER_RECORD=off` (or `0` / `false` / `no`) and nothing here reads or
// writes. Reads are loose (versions 1 and 2 are read too; an unusable player or entry is dropped);
// every write is atomic and runs under the in-process path lock (src/path-lock.ts). Never throws.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readEnvVar, type EnvSource } from '@chrischall/mcp-utils';
import {
  addCounts,
  COUNT_KEYS,
  MAX_RECORD_PLAYERS,
  talliesOf,
  upsertEntry,
  ZERO_COUNTS,
  type RecordCounts,
  type RecordEntry,
  type RecordOutcome,
} from './analysis/player-record.js';
import { withPathLock } from './path-lock.js';
import { relationsDir } from './relations-store.js';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

const SALT = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{32}$/;
const OUTCOMES: ReadonlySet<RecordOutcome> = new Set(['open', 'not-agreed', 'kept', 'ended-with-notice', 'broken-by-them', 'broken-by-me']);

export const playerRecordPath = (dir: string) => join(relationsDir(dir), 'players.json');
export const playerRecordSaltPath = (dir: string) => join(relationsDir(dir), 'players.salt');

/** Whether the cross-game record is on: yes (local and hosted) unless `WARAPP_PLAYER_RECORD` is `off`, `0`, `false` or `no`. */
export function playerRecordEnabled(env: EnvSource = process.env): boolean {
  const v = readEnvVar('WARAPP_PLAYER_RECORD', { env });
  return v === undefined || !/^(off|0|false|no)$/i.test(v.trim());
}

type SaltRead = { salt: string } | 'missing' | 'malformed';

async function readSalt(dir: string): Promise<SaltRead> {
  let text: string;
  try {
    text = await readFile(playerRecordSaltPath(dir), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'malformed';
  }
  const salt = text.trim();
  return SALT.test(salt) ? { salt } : 'malformed';
}

/** The salt on record for `dir`; `undefined` when there is none yet or it is malformed. Never makes one. */
export async function playerRecordSalt(dir: string): Promise<string | undefined> {
  const s = await readSalt(dir);
  return typeof s === 'object' ? s.salt : undefined;
}

/** The salt for a write: the one on record, else a new one (never over an existing file); `undefined` when malformed or unwritable. */
async function saltForWrite(dir: string): Promise<string | undefined> {
  const s = await readSalt(dir);
  if (typeof s === 'object') return s.salt;
  if (s === 'malformed') return undefined;
  const path = playerRecordSaltPath(dir);
  await mkdir(relationsDir(dir), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, randomBytes(16).toString('hex'), { mode: 0o600 });
  try {
    // `link` fails when the file exists: another writer's salt is never replaced.
    await link(tmp, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
  const again = await readSalt(dir);
  return typeof again === 'object' ? again.salt : undefined;
}

const hmac = (salt: string, text: string) => createHmac('sha256', salt).update(text).digest('hex').slice(0, 32);

/** A player's key in the record: never the id itself. */
export const playerKey = (salt: string, playerId: number) => hmac(salt, `player:${playerId}`);
/** An agreement's key in the record: my account, the game and the agreement, never the ids themselves. */
export const entryKey = (salt: string, myId: number, gameId: number, agreementId: string) =>
  hmac(salt, `agreement:${myId}:${gameId}:${agreementId}`);
/** The key entries were written under before my account was part of it: still read, and updated in place. */
export const legacyEntryKey = (salt: string, gameId: number, agreementId: string) => hmac(salt, `agreement:${gameId}:${agreementId}`);

/** One player's part of the record. */
export interface PlayerRecordData {
  tallies: RecordCounts;
  entries: RecordEntry[];
}
interface StoredPlayer extends PlayerRecordData {
  /** When it last changed (ms since the epoch): only to drop the stalest past the bound. */
  updated: number;
}
interface RecordFile {
  version: 3;
  players: Record<string, StoredPlayer>;
}

const count = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const intOrNull = (v: unknown) => v === null || (typeof v === 'number' && Number.isInteger(v));

function talliesFrom(v: unknown): RecordCounts | undefined {
  if (!isRec(v) || !COUNT_KEYS.every((k) => count(v[k]))) return undefined;
  const out: RecordCounts = { ...ZERO_COUNTS };
  for (const k of COUNT_KEYS) out[k] = v[k] as number;
  return out;
}

function entryOf(v: unknown): RecordEntry | undefined {
  // Entries are this module's own writes: checked for shape, not re-derived.
  if (!isRec(v) || typeof v.key !== 'string' || !HASH.test(v.key) || !OUTCOMES.has(v.outcome as RecordOutcome) || typeof v.updated !== 'number')
    return undefined;
  if (!isRec(v.format) || !isRec(v.terms) || !intOrNull(v.agreedTurn) || !intOrNull(v.endedTurn)) return undefined;
  return v as unknown as RecordEntry;
}

/** One player as stored, in any version this module wrote; `undefined` when unusable. */
function playerOf(v: unknown): StoredPlayer | undefined {
  if (!isRec(v)) return undefined;
  const entries = Array.isArray(v.entries) ? v.entries.map(entryOf).filter((e): e is RecordEntry => e !== undefined) : [];
  // Version 3 keeps `tallies`, version 2 kept `counts` only, version 1 entries only.
  const tallies = talliesFrom(v.tallies) ?? talliesFrom(v.counts) ?? (entries.length ? talliesOf(entries) : undefined);
  if (!tallies) return undefined;
  const updated = typeof v.updated === 'number' ? v.updated : entries.reduce((m, e) => Math.max(m, e.updated), 0);
  return { tallies, entries, updated };
}

/** The file on record: empty when there is none; `'unreadable'` when one exists but cannot be read or parsed. */
async function readFileRecord(dir: string): Promise<RecordFile | 'unreadable'> {
  let text: string;
  try {
    text = await readFile(playerRecordPath(dir), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { version: 3, players: {} } : 'unreadable';
  }
  let c: unknown;
  try {
    c = JSON.parse(text);
  } catch {
    return 'unreadable';
  }
  if (!isRec(c) || !isRec(c.players)) return 'unreadable';
  const players: RecordFile['players'] = {};
  for (const [k, v] of Object.entries(c.players)) {
    const p = HASH.test(k) ? playerOf(v) : undefined;
    if (p) players[k] = p;
  }
  return { version: 3, players };
}

async function writeFileRecord(dir: string, file: RecordFile): Promise<void> {
  const keys = Object.keys(file.players)
    .sort((a, b) => file.players[b]!.updated - file.players[a]!.updated || (a < b ? -1 : 1))
    .slice(0, MAX_RECORD_PLAYERS)
    .sort();
  const bounded: RecordFile = { version: 3, players: Object.fromEntries(keys.map((k) => [k, file.players[k]!])) };
  const path = playerRecordPath(dir);
  await mkdir(relationsDir(dir), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(bounded), { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * What is on record for `playerId`: its tallies and entries; `null` when nothing is (no salt yet
 * included); `'unreadable'` when the salt file is malformed or the record file cannot be parsed;
 * `'off'` when the record is off. Never throws, never writes.
 */
export async function readPlayerRecord(dir: string, playerId: number, env?: EnvSource): Promise<PlayerRecordData | null | 'unreadable' | 'off'> {
  if (!playerRecordEnabled(env)) return 'off';
  try {
    const s = await readSalt(dir);
    if (s === 'malformed') return 'unreadable';
    if (s === 'missing') return null;
    const file = await readFileRecord(dir);
    if (file === 'unreadable') return 'unreadable';
    const p = file.players[playerKey(s.salt, playerId)];
    return p ? { tallies: p.tallies, entries: p.entries } : null;
  } catch {
    return null;
  }
}

/** The record's state for a tool result: `on`, `off`, or `unreadable` (a malformed salt file or a record file that cannot be parsed). */
export async function playerRecordState(dir: string | undefined, env?: EnvSource): Promise<'on' | 'off' | 'unreadable'> {
  if (!playerRecordEnabled(env)) return 'off';
  if (!dir) return 'on';
  if ((await readSalt(dir).catch(() => 'missing' as const)) === 'malformed') return 'unreadable';
  return (await readFileRecord(dir).catch(() => 'unreadable' as const)) === 'unreadable' ? 'unreadable' : 'on';
}

/**
 * Update `playerId`'s part of the record: `update` gets the salt (to key entries) and what is on
 * record, and returns the tallies to add (`recordDelta`) and the entries to upsert. Read, change and
 * write run under the in-process lock for the file. `updated` when written; `off` when the record is
 * off; `failed` when it could not be (a malformed salt or an unparseable record file included: neither
 * is ever overwritten). Never throws.
 */
export async function updatePlayerRecord(
  dir: string,
  playerId: number,
  update: (salt: string, current: PlayerRecordData) => { delta: RecordCounts; entries: readonly RecordEntry[] },
  env?: EnvSource,
  now = Date.now(),
): Promise<'updated' | 'off' | 'failed'> {
  if (!playerRecordEnabled(env)) return 'off';
  try {
    return await withPathLock(playerRecordPath(dir), async () => {
      const file = await readFileRecord(dir);
      if (file === 'unreadable') return 'failed';
      const salt = await saltForWrite(dir);
      if (!salt) return 'failed';
      const key = playerKey(salt, playerId);
      const current = file.players[key] ?? { tallies: { ...ZERO_COUNTS }, entries: [], updated: 0 };
      const { delta, entries } = update(salt, { tallies: current.tallies, entries: current.entries });
      let next = current.entries;
      for (const e of entries) next = upsertEntry(next, e);
      file.players[key] = { tallies: addCounts(current.tallies, delta), entries: next, updated: now };
      await writeFileRecord(dir, file);
      return 'updated';
    });
  } catch {
    return 'failed';
  }
}
