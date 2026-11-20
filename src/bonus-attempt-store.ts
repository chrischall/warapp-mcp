// The bonus attempt memory on disk (#298): per game and account, at
// `<dataDir>/bonus-attempts/<gameId>-<playerId>.json`, the contested bonuses whose completion my plans
// attempted (each attempt's turn, whether it was all-in, whether the next board showed it failed) and
// the drops in force. Ids and numbers only, never a name; 0600 in a 0700 directory, written atomically
// under the in-process path lock (the siege store's pattern, src/siege-store.ts). Written by
// warapp_plan_turn on a plan that is not a what-if and read back as `PlanInput.bonusAttempts`. Reads are
// loose: an unusable file is no memory, an unusable record or attempt is dropped; nothing here throws.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withPathLock } from './path-lock.js';
import type { BonusAttempt, BonusAttemptMemory, BonusAttemptRecord } from './analysis/plan/bonus-attempts.js';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

export const bonusAttemptsDir = (dir: string) => join(dir, 'bonus-attempts');
export const bonusAttemptsPath = (dir: string, gameId: number, playerId: number) => join(bonusAttemptsDir(dir), `${gameId}-${playerId}.json`);

function attemptOf(v: unknown): BonusAttempt | undefined {
  if (!isRec(v) || !isInt(v.turn) || typeof v.allIn !== 'boolean') return undefined;
  return { turn: v.turn, allIn: v.allIn, ...(typeof v.failed === 'boolean' ? { failed: v.failed } : {}) };
}

function recordOf(v: unknown): BonusAttemptRecord | undefined {
  if (!isRec(v) || !isInt(v.bonusId) || !Array.isArray(v.attempts)) return undefined;
  const attempts = v.attempts.map(attemptOf).filter((a): a is BonusAttempt => a !== undefined);
  const drop = isRec(v.drop) && isInt(v.drop.from) && isInt(v.drop.until) ? { from: v.drop.from, until: v.drop.until } : undefined;
  return { bonusId: v.bonusId, attempts, ...(drop ? { drop } : {}) };
}

/** The attempt memory kept for `gameId` as `playerId`; `undefined` when none or unusable. Never throws. */
export async function readBonusAttempts(dir: string, gameId: number, playerId: number): Promise<BonusAttemptMemory | undefined> {
  try {
    const c: unknown = JSON.parse(await readFile(bonusAttemptsPath(dir, gameId, playerId), 'utf8'));
    if (!isRec(c) || c.gameId !== gameId || c.playerId !== playerId || !Array.isArray(c.bonuses)) return undefined;
    return { bonuses: c.bonuses.map(recordOf).filter((r): r is BonusAttemptRecord => r !== undefined) };
  } catch {
    return undefined;
  }
}

/** Write the attempt memory, atomically, 0600. `true` when written; never throws. */
export async function writeBonusAttempts(dir: string, gameId: number, playerId: number, memory: BonusAttemptMemory): Promise<boolean> {
  const path = bonusAttemptsPath(dir, gameId, playerId);
  return withPathLock(path, async () => {
    try {
      await mkdir(bonusAttemptsDir(dir), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify({ gameId, playerId, bonuses: memory.bonuses }), { mode: 0o600 });
      await rename(tmp, path);
      return true;
    } catch {
      return false;
    }
  });
}
