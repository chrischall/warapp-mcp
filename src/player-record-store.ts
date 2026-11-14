// The cross-game player record on disk (docs/PLAN-TEAMS.md A2, D5's default: on, local only — never
// hosted — and counts only). At `<dataDir>/relations/players.json`: per player, the counts of
// `src/analysis/player-record.ts` and when they last changed, nothing more. The player is keyed by an
// HMAC of its GameFeed id under a local secret salt (`<dataDir>/relations/players.salt`, 0600, made
// on first use): the file holds no player id, game id or name. Bounded (`MAX_RECORD_PLAYERS`).
// Off on a hosted child (`isHosted`, src/hosted.ts) whatever the environment says, and switched off
// locally by `WARAPP_PLAYER_RECORD=off` (or `0` / `false` / `no`): then nothing here reads or writes.
// Best effort: never throws.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readEnvVar, type EnvSource } from '@chrischall/mcp-utils';
import { addCounts, COUNT_KEYS, isZero, MAX_RECORD_PLAYERS, ZERO_COUNTS, type RecordCounts } from './analysis/player-record.js';
import { isHosted } from './hosted.js';
import { relationsDir } from './relations-store.js';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

const SALT = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{32}$/;

export const playerRecordPath = (dir: string) => join(relationsDir(dir), 'players.json');
export const playerRecordSaltPath = (dir: string) => join(relationsDir(dir), 'players.salt');

/** Whether the cross-game record is on: never hosted; locally yes unless `WARAPP_PLAYER_RECORD` is `off`, `0`, `false` or `no`. */
export function playerRecordEnabled(env: EnvSource = process.env): boolean {
  if (isHosted(env)) return false;
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

/** A player's key in the record: never the id itself. */
export const playerKey = (salt: string, playerId: number) => createHmac('sha256', salt).update(`player:${playerId}`).digest('hex').slice(0, 32);

interface PlayerCounts {
  counts: RecordCounts;
  /** When the counts last changed (ms since the epoch): only to drop the stalest past the bound. */
  updated: number;
}
interface RecordFile {
  version: 2;
  players: Record<string, PlayerCounts>;
}

const count = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function countsOf(v: unknown): PlayerCounts | undefined {
  if (!isRec(v) || !isRec(v.counts) || typeof v.updated !== 'number') return undefined;
  const c = v.counts;
  if (!COUNT_KEYS.every((k) => count(c[k]))) return undefined;
  const counts: RecordCounts = { ...ZERO_COUNTS };
  for (const k of COUNT_KEYS) counts[k] = c[k] as number;
  return { counts, updated: v.updated };
}

async function readFileRecord(dir: string): Promise<RecordFile> {
  try {
    const c: unknown = JSON.parse(await readFile(playerRecordPath(dir), 'utf8'));
    if (!isRec(c) || !isRec(c.players)) return { version: 2, players: {} };
    const players: RecordFile['players'] = {};
    for (const [k, v] of Object.entries(c.players)) {
      const p = HASH.test(k) ? countsOf(v) : undefined;
      if (p) players[k] = p;
    }
    return { version: 2, players };
  } catch {
    return { version: 2, players: {} };
  }
}

async function writeFileRecord(dir: string, file: RecordFile): Promise<void> {
  const keys = Object.keys(file.players)
    .sort((a, b) => file.players[b]!.updated - file.players[a]!.updated || (a < b ? -1 : 1))
    .slice(0, MAX_RECORD_PLAYERS)
    .sort();
  const bounded: RecordFile = { version: 2, players: Object.fromEntries(keys.map((k) => [k, file.players[k]!])) };
  const path = playerRecordPath(dir);
  await mkdir(relationsDir(dir), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(bounded), { mode: 0o600 });
  await rename(tmp, path);
}

/** The counts on record for `playerId`; `undefined` when none, unusable or off. Never throws. */
export async function readPlayerCounts(dir: string, playerId: number, env?: EnvSource): Promise<RecordCounts | undefined> {
  if (!playerRecordEnabled(env)) return undefined;
  try {
    const salt = await playerRecordSalt(dir);
    if (!salt) return undefined;
    return (await readFileRecord(dir)).players[playerKey(salt, playerId)]?.counts;
  } catch {
    return undefined;
  }
}

/**
 * Add `delta` to `playerId`'s counts. `true` when written (or when there was nothing to add);
 * `false` when off or it failed. Never throws.
 */
export async function addPlayerCounts(dir: string, playerId: number, delta: RecordCounts, env?: EnvSource, now = Date.now()): Promise<boolean> {
  if (!playerRecordEnabled(env)) return false;
  if (isZero(delta)) return true;
  try {
    const salt = await playerRecordSalt(dir);
    if (!salt) return false;
    const file = await readFileRecord(dir);
    const key = playerKey(salt, playerId);
    file.players[key] = { counts: addCounts(file.players[key]?.counts ?? ZERO_COUNTS, delta), updated: now };
    await writeFileRecord(dir, file);
    return true;
  } catch {
    return false;
  }
}
