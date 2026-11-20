// #298: the bonus attempt memory on disk, per game and account (the siege store's pattern).
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bonusAttemptsPath, readBonusAttempts, writeBonusAttempts } from '../src/bonus-attempt-store.js';
import type { BonusAttemptMemory } from '../src/analysis/plan/bonus-attempts.js';

const memory: BonusAttemptMemory = {
  bonuses: [
    { bonusId: 301, attempts: [{ turn: 16, allIn: false, failed: true }, { turn: 17, allIn: false }] },
    { bonusId: 302, attempts: [], drop: { from: 17, until: 19 } },
  ],
};

describe('#298 bonus attempt store', () => {
  it('round-trips a game’s attempt memory, 0600, ids and numbers only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'attempts-'));
    expect(await readBonusAttempts(dir, 7, 10)).toBeUndefined();
    expect(await writeBonusAttempts(dir, 7, 10, memory)).toBe(true);
    expect(await readBonusAttempts(dir, 7, 10)).toEqual(memory);
    expect(await readBonusAttempts(dir, 7, 11)).toBeUndefined();
    expect(statSync(bonusAttemptsPath(dir, 7, 10)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(bonusAttemptsPath(dir, 7, 10), 'utf8'))).toEqual({ gameId: 7, playerId: 10, ...memory });
  });

  it('reads loosely: an unusable file is no memory, an unusable record or attempt is dropped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'attempts-'));
    mkdirSync(join(dir, 'bonus-attempts'), { recursive: true });
    writeFileSync(bonusAttemptsPath(dir, 7, 10), 'not json');
    expect(await readBonusAttempts(dir, 7, 10)).toBeUndefined();
    writeFileSync(
      bonusAttemptsPath(dir, 7, 10),
      JSON.stringify({
        gameId: 7,
        playerId: 10,
        bonuses: [
          { bonusId: 301, attempts: [{ turn: 16, allIn: false, failed: true }, { turn: 'x' }, { turn: 17, allIn: 1 }], drop: { from: 'a' } },
          { bonusId: 'b', attempts: [] },
        ],
      }),
    );
    expect(await readBonusAttempts(dir, 7, 10)).toEqual({ bonuses: [{ bonusId: 301, attempts: [{ turn: 16, allIn: false, failed: true }] }] });
  });
});
