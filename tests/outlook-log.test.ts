import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameOutlook } from '../src/analysis/outlook.js';
import { outlookLogPath, readOutlookLog, recordFinalResult, recordOutlook, recordResult } from '../src/outlook-log.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'warapp-outlook-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const outlook = (turn: number, state: GameOutlook['state'] = null): GameOutlook => ({
  state,
  heldTurns: 1,
  k: 3,
  threshold: 2.4,
  basis: `Turn ${turn} basis.`,
  turns: [
    { turn, mine: 40, strongest: { playerId: 2001, low: 20, high: null }, ratio: { low: 0, high: 2 }, changed: 0, state: 'even' },
  ],
});

describe('outlook log (#178)', () => {
  it('keeps a name-free strength ratio per turn and the latest outlook, per game and player', async () => {
    await recordOutlook(dir, 7001, 1001, outlook(4));
    await recordOutlook(dir, 7001, 1001, outlook(5, 'even'));
    const log = await readOutlookLog(dir, 7001, 1001);
    expect(log?.turns).toEqual({
      '4': { mine: 40, low: 20, high: null, ratio: { low: 0, high: 2 }, state: 'even' },
      '5': { mine: 40, low: 20, high: null, ratio: { low: 0, high: 2 }, state: 'even' },
    });
    expect(log?.latest).toEqual({ turn: 5, state: 'even', heldTurns: 1, basis: 'Turn 5 basis.' });
    const raw = await readFile(outlookLogPath(dir, 7001), 'utf8');
    expect(raw).not.toMatch(/name/i);
  });

  it('records the final result only for a game it already logs', async () => {
    expect(await recordResult(dir, 7002, 1001, 'Won')).toBe(false);
    expect(await readOutlookLog(dir, 7002, 1001)).toBeUndefined();
    await recordOutlook(dir, 7001, 1001, outlook(4));
    expect(await recordResult(dir, 7001, 1001, 'Won')).toBe(true);
    expect((await readOutlookLog(dir, 7001, 1001))?.result).toBe('Won');
  });

  it('reads nothing for another player, or from a file it cannot use, and never throws', async () => {
    await recordOutlook(dir, 7001, 1001, outlook(4));
    expect(await readOutlookLog(dir, 7001, 1002)).toBeUndefined();
    expect(await readOutlookLog(join(dir, 'missing'), 7001, 1001)).toBeUndefined();
    await expect(recordOutlook(join(dir, 'f', '\0bad'), 1, 1, outlook(1))).resolves.toBeUndefined();
  });

  it('recordFinalResult reads the logged player\'s state from a finished game', async () => {
    await recordOutlook(dir, 7001, 1001, outlook(4));
    const players = [{ id: 1001, state: 'Eliminated' }, { id: 1002, state: 'Won' }];
    expect(await recordFinalResult(dir, { id: 7001, state: 'Playing', players })).toBe(false);
    expect(await recordFinalResult(dir, { id: 7001, state: 'Finished', players })).toBe(true);
    expect((await readOutlookLog(dir, 7001, 1001))?.result).toBe('Eliminated');
    expect(await recordFinalResult(dir, { id: 7009, state: 'Finished', players })).toBe(false);
  });
});
