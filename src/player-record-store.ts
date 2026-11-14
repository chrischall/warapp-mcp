// The cross-game player record on disk (docs/PLAN-TEAMS.md A2, owner decision D5 of 2026-11-14: ON,
// local and hosted — a hosted child keeps it in its per-user data dir). At
// `<dataDir>/relations/players.json`: per player, the entries of `src/analysis/player-record.ts`.
// The player is keyed by an HMAC of its GameFeed id under a local secret salt
// (`<dataDir>/relations/players.salt`, 0600, made on first use), and each entry by an HMAC of the
// game and the agreement: the file holds no player id, game id or name, and without the salt it
// cannot be joined to a game or a player. Bounded (`MAX_RECORD_ENTRIES` per player,
// `MAX_RECORD_PLAYERS` players). Isolated so it can be switched off: `WARAPP_PLAYER_RECORD=off`
// (or `0` / `false`) and nothing here reads or writes. Best effort: never throws.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readEnvVar, type EnvSource } from '@chrischall/mcp-utils';
import { MAX_RECORD_PLAYERS, upsertEntry, type RecordEntry } from './analysis/player-record.js';
import { relationsDir } from './relations-store.js';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

const SALT = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{32}$/;

export const playerRecordPath = (dir: string) => join(relationsDir(dir), 'players.json');
export const playerRecordSaltPath = (dir: string) => join(relationsDir(dir), 'players.salt');

/** Whether the cross-game record is on: yes unless `WARAPP_PLAYER_RECORD` is `off`, `0` or `false`. */
export function playerRecordEnabled(env: EnvSource = process.env): boolean {
  const v = readEnvVar('WARAPP_PLAYER_RECORD', { env });
  return v === undefined || !/^(off|0|false|no)$/i.test(v.trim());
}

/** The salt for `dir`, made on first use; `undefined` when it can be neither read nor written. */
export async function playerRecordSalt(dir: string): Promise<string | undefined> {
  const path = playerRecordSaltPath(dir);
  try {
    const text = (await readFile(path, 'utf8')).trim();
    if (SALT.test(text)) return text;
  } catch {
    // Not there yet.
  }
  try {
    await mkdir(relationsDir(dir), { recursive: true, mode: 0o700 });
    const salt = randomBytes(16).toString('hex');
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, salt, { mode: 0o600 });
    await rename(tmp, path);
    return salt;
  } catch {
    return undefined;
  }
}

const hmac = (salt: string, text: string) => createHmac('sha256', salt).update(text).digest('hex').slice(0, 32);

/** A player's key in the record: never the id itself. */
export const playerKey = (salt: string, playerId: number) => hmac(salt, `player:${playerId}`);
/** An agreement's key in the record: never the game id or agreement id themselves. */
export const entryKey = (salt: string, gameId: number, agreementId: string) => hmac(salt, `agreement:${gameId}:${agreementId}`);

interface RecordFile {
  version: 1;
  players: Record<string, { entries: RecordEntry[] }>;
}

function entryOf(v: unknown): RecordEntry | undefined {
  // Entries are this module's own writes: checked for shape, not re-derived.
  if (!isRec(v) || typeof v.key !== 'string' || !HASH.test(v.key) || typeof v.outcome !== 'string' || typeof v.updated !== 'number') return undefined;
  if (!isRec(v.format) || !isRec(v.terms)) return undefined;
  return v as unknown as RecordEntry;
}

async function readFileRecord(dir: string): Promise<RecordFile> {
  try {
    const c: unknown = JSON.parse(await readFile(playerRecordPath(dir), 'utf8'));
    if (!isRec(c) || !isRec(c.players)) return { version: 1, players: {} };
    const players: RecordFile['players'] = {};
    for (const [k, v] of Object.entries(c.players)) {
      if (!HASH.test(k) || !isRec(v) || !Array.isArray(v.entries)) continue;
      const entries = v.entries.map(entryOf).filter((e): e is RecordEntry => e !== undefined);
      if (entries.length) players[k] = { entries };
    }
    return { version: 1, players };
  } catch {
    return { version: 1, players: {} };
  }
}

const latest = (p: { entries: RecordEntry[] }) => p.entries.reduce((m, e) => Math.max(m, e.updated), 0);

async function writeFileRecord(dir: string, file: RecordFile): Promise<void> {
  const keys = Object.keys(file.players)
    .sort((a, b) => latest(file.players[b]!) - latest(file.players[a]!) || (a < b ? -1 : 1))
    .slice(0, MAX_RECORD_PLAYERS)
    .sort();
  const bounded: RecordFile = { version: 1, players: Object.fromEntries(keys.map((k) => [k, file.players[k]!])) };
  const path = playerRecordPath(dir);
  await mkdir(relationsDir(dir), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(bounded), { mode: 0o600 });
  await rename(tmp, path);
}

/** The entries on record for `playerId`; `[]` when none or off. Never throws. */
export async function readPlayerEntries(dir: string, playerId: number, env?: EnvSource): Promise<RecordEntry[]> {
  if (!playerRecordEnabled(env)) return [];
  try {
    const salt = await playerRecordSalt(dir);
    if (!salt) return [];
    return (await readFileRecord(dir)).players[playerKey(salt, playerId)]?.entries ?? [];
  } catch {
    return [];
  }
}

/**
 * Update `playerId`'s entries: `update` gets the salt (to key entries) and the current entries and
 * returns the entries to upsert. `true` when written; `false` when off or it failed. Never throws.
 */
export async function updatePlayerEntries(
  dir: string,
  playerId: number,
  update: (salt: string, entries: readonly RecordEntry[]) => readonly RecordEntry[],
  env?: EnvSource,
): Promise<boolean> {
  if (!playerRecordEnabled(env)) return false;
  try {
    const salt = await playerRecordSalt(dir);
    if (!salt) return false;
    const file = await readFileRecord(dir);
    const key = playerKey(salt, playerId);
    let entries = file.players[key]?.entries ?? [];
    for (const e of update(salt, entries)) entries = upsertEntry(entries, e);
    file.players[key] = { entries };
    await writeFileRecord(dir, file);
    return true;
  } catch {
    return false;
  }
}
