// The siege's memory on disk (#382): per game and account, at `<dataDir>/siege/<gameId>-<playerId>.json`,
// the target and each planned siege turn (the target's income, mine, the bonuses that turn's plan broke).
// Ids and numbers only, never a name; 0600 in a 0700 directory, written atomically under the in-process
// path lock. Written by warapp_plan_turn under `goal: 'siege'` (not with `enemy_deploy`, a what-if) and
// read back as `PlanInput.siegeMemory`. Reads are loose: an unusable file is no memory, an unusable turn
// is dropped; nothing here throws.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withPathLock } from './path-lock.js';
import type { SiegeMemory, SiegeTurnRecord } from './analysis/plan/siege.js';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const siegeDir = (dir: string) => join(dir, 'siege');
export const siegePath = (dir: string, gameId: number, playerId: number) => join(siegeDir(dir), `${gameId}-${playerId}.json`);

function turnOf(v: unknown): SiegeTurnRecord | undefined {
  if (!isRec(v) || !isInt(v.turn) || !isNum(v.opponentIncome) || !isNum(v.myIncome)) return undefined;
  const breaks = Array.isArray(v.breaks) && v.breaks.every(isInt) ? [...(v.breaks as number[])] : [];
  return { turn: v.turn, opponentIncome: v.opponentIncome, myIncome: v.myIncome, breaks };
}

/** The siege memory kept for `gameId` as `playerId`; `undefined` when none or unusable. Never throws. */
export async function readSiegeMemory(dir: string, gameId: number, playerId: number): Promise<SiegeMemory | undefined> {
  try {
    const c: unknown = JSON.parse(await readFile(siegePath(dir, gameId, playerId), 'utf8'));
    if (!isRec(c) || c.gameId !== gameId || c.playerId !== playerId || !isInt(c.target) || !Array.isArray(c.turns)) return undefined;
    return { target: c.target, turns: c.turns.map(turnOf).filter((t): t is SiegeTurnRecord => t !== undefined) };
  } catch {
    return undefined;
  }
}

/** Write the siege memory, atomically, 0600. `true` when written; never throws. */
export async function writeSiegeMemory(dir: string, gameId: number, playerId: number, memory: SiegeMemory): Promise<boolean> {
  const path = siegePath(dir, gameId, playerId);
  return withPathLock(path, async () => {
    try {
      await mkdir(siegeDir(dir), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify({ gameId, playerId, target: memory.target, turns: memory.turns }), { mode: 0o600 });
      await rename(tmp, path);
      return true;
    } catch {
      return false;
    }
  });
}
