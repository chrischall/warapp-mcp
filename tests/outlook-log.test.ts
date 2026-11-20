import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameOutlook } from '../src/analysis/outlook.js';
import { contractFinalOutlook, finalOutlookOf, outlookLogPath, readOutlookLog, recordFinalResult, recordOutlook, recordResult } from '../src/outlook-log.js';

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
  it('concurrent writes to one game in one process do not share a temp file: each lands, none is left behind', async () => {
    await recordOutlook(dir, 7001, 1001, outlook(4));
    const results = ['Won', 'Eliminated', 'Won', 'SurrenderAccepted', 'Eliminated', 'Won'];
    const written = await Promise.all(results.map((r) => recordResult(dir, 7001, 1001, r)));
    expect(written).toEqual(results.map(() => true));
    expect((await readdir(join(dir, 'outlook'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(results).toContain((await readOutlookLog(dir, 7001, 1001))?.result);
  });

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

  it('#436: keeps each turn\'s incomes and lean, and the surrender line on the latest (figures only)', async () => {
    const o = outlook(7, 'even');
    o.lean = 'behind';
    o.turns[0] = {
      ...o.turns[0]!,
      income: {
        mine: 5,
        theirs: { playerId: 2001, low: 9, high: 14, estimate: 12 },
        ratio: { low: 0.36, high: 0.56, estimate: 0.42 },
        calibrated: true,
        lean: 'behind',
      },
      state: 'even',
      lean: 'behind',
    };
    o.surrenderLine = {
      crossed: true,
      turnsBelow: 3,
      needed: 3,
      myIncome: 5,
      theirIncome: 12,
      playerId: 2001,
      line: 8,
      calibrated: true,
      advice: 'Surrender line crossed (advice only).',
    };
    await recordOutlook(dir, 7001, 1001, o);
    const log = await readOutlookLog(dir, 7001, 1001);
    expect(log?.turns['7']?.income).toEqual({ mine: 5, low: 9, high: 14, estimate: 12, lean: 'behind', calibrated: true });
    expect(log?.latest?.surrenderLine).toEqual({ crossed: true, turnsBelow: 3, line: 8 });
    // #454: the state keeps its four values; the income reading is the additive `lean`, per turn and on the latest.
    expect(log?.turns['7']).toMatchObject({ state: 'even', lean: 'behind' });
    expect(log?.latest).toMatchObject({ state: 'even', lean: 'behind' });
    expect(finalOutlookOf(log!)).toMatchObject({ state: 'even', lean: 'behind' });
  });

  it('#454: reads a log written with ahead, behind or unknown as the state (#453, a few hours) as even with that lean', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(dir, 'outlook'), { recursive: true });
    const old = {
      gameId: 7003,
      playerId: 1001,
      turns: {
        '5': { mine: 40, low: 20, high: 30, ratio: { low: 1.33, high: 2 }, state: 'behind' },
        '6': { mine: 40, low: 20, high: 30, ratio: { low: 1.33, high: 2 }, state: 'unknown' },
        '7': { mine: 40, low: 20, high: 30, ratio: { low: 1.33, high: 2 }, state: 'stalemate' },
      },
      latest: { turn: 6, state: 'ahead', heldTurns: 3, basis: 'b' },
    };
    await writeFile(outlookLogPath(dir, 7003), JSON.stringify(old));
    const log = (await readOutlookLog(dir, 7003, 1001))!;
    expect(log.turns['5']).toMatchObject({ state: 'even', lean: 'behind' });
    expect(log.turns['6']).toMatchObject({ state: 'even', lean: 'unknown' });
    expect(log.turns['7']).toEqual(old.turns['7']);
    expect(log.latest).toMatchObject({ state: 'even', lean: 'ahead' });
    expect(finalOutlookOf(log)).toMatchObject({ turn: 6, state: 'even', lean: 'ahead' });
    // A finished record's final outlook #453 wrote reads alike; a contract one is left as it is.
    expect(contractFinalOutlook({ turn: 6, state: 'unknown' as never, heldTurns: 3 })).toEqual({ turn: 6, state: 'even', lean: 'unknown', heldTurns: 3 });
    expect(contractFinalOutlook({ turn: 6, state: 'losing', heldTurns: 3 })).toEqual({ turn: 6, state: 'losing', heldTurns: 3 });
    // Rewritten in the new shape on the next record.
    await recordOutlook(dir, 7003, 1001, outlook(8, 'even'));
    const raw = JSON.parse(await readFile(outlookLogPath(dir, 7003), 'utf8')) as { turns: Record<string, { state: string; lean?: string }> };
    expect(raw.turns['5']).toMatchObject({ state: 'even', lean: 'behind' });
  });

  it('#283: keeps each turn\'s armies and income, mine and the strongest side\'s, with its id (name-free)', async () => {
    const o = outlook(6, 'losing');
    o.turns[0] = {
      ...o.turns[0]!,
      strongest: { playerId: 2001, low: 20, high: null, team: 2, players: [2001, 2002] },
      figures: { mine: { armies: 25, income: 5 }, strongest: { armies: 8, income: 4 } },
      state: 'losing',
    };
    await recordOutlook(dir, 7001, 1001, o);
    expect((await readOutlookLog(dir, 7001, 1001))?.turns['6']).toEqual({
      mine: 40,
      low: 20,
      high: null,
      ratio: { low: 0, high: 2 },
      state: 'losing',
      figures: { mine: { armies: 25, income: 5 }, strongest: { playerId: 2001, team: 2, armies: 8, income: 4 } },
    });
  });

  it('#304: keeps each turn\'s evidence (the incomes compared, each opponent\'s frontier read, thin) and the latest\'s', async () => {
    const o = outlook(7, 'even');
    o.evidence = {
      incomes: { mine: 8, theirs: 6, playerId: 2001, source: 'tracked' },
      opponents: [{ playerId: 2001, income: 6, source: 'tracked', coverage: 0.33, thin: true, read: '1 of ~3 frontier territories (33%)' }],
      thin: true,
    };
    o.turns[0] = { ...o.turns[0]!, evidence: o.evidence };
    await recordOutlook(dir, 7001, 1001, o);
    const log = await readOutlookLog(dir, 7001, 1001);
    expect(log?.turns['7']?.evidence).toEqual({
      incomes: { mine: 8, theirs: 6, playerId: 2001, source: 'tracked' },
      opponents: [{ playerId: 2001, income: 6, source: 'tracked', coverage: 0.33, thin: true }],
      thin: true,
    });
    expect(log?.latest?.evidence).toEqual(log?.turns['7']?.evidence);
  });

  it('#312: logs a turn read on the likely high as estimated, and the final outlook is kept name-free', async () => {
    const o = outlook(9, 'losing');
    o.turns[0] = { ...o.turns[0]!, state: 'losing', estimated: true };
    o.evidence = { incomes: null, opponents: [{ playerId: 2001, income: 7, source: 'tracked', coverage: 0.4, thin: true, coverageWords: 'x' } as never], thin: true };
    await recordOutlook(dir, 7001, 1001, outlook(8, 'even'));
    await recordOutlook(dir, 7001, 1001, o);
    const log = (await readOutlookLog(dir, 7001, 1001))!;
    expect(log.turns['9']?.estimated).toBe(true);
    expect(log.turns['8']).not.toHaveProperty('estimated');
    const final = finalOutlookOf(log);
    expect(final).toEqual({ turn: 9, state: 'losing', heldTurns: 1, ratio: { low: 0, high: 2 }, estimated: true, thin: true });
    // No id, no words.
    expect(JSON.stringify(final)).not.toMatch(/2001|1001|7001|basis/);
    expect(finalOutlookOf({ gameId: 7001, playerId: 1001, turns: {} })).toBeUndefined();
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

describe('#436: the chat standing read from the outlook log', () => {
  it('maps the income lean: ahead and behind as the standing, unknown as unknown', async () => {
    const { standingFromOutlook } = await import('../src/tools/chat-advice.js');
    const log = (state: GameOutlook['state'], lean?: GameOutlook['lean']) => ({
      gameId: 1,
      playerId: 2,
      turns: { '5': { mine: 40, low: 20, high: 30, ratio: { low: 1.33, high: 2 }, state: state ?? 'even', ...(lean ? { lean } : {}) } },
      latest: { turn: 5, state, ...(lean ? { lean } : {}), heldTurns: 3, basis: '' },
    });
    // #454: the lean rides beside an even state.
    expect(standingFromOutlook(log('even', 'ahead'))?.standing).toBe('ahead');
    expect(standingFromOutlook(log('even', 'behind'))?.standing).toBe('behind');
    expect(standingFromOutlook(log('even', 'unknown'))?.standing).toBe('unknown');
    expect(standingFromOutlook(log('even'))?.standing).toBe('even');
    expect(standingFromOutlook(log('stalemate'))?.standing).toBe('even');
    // A log written with the lean as the state (#453) still reads.
    expect(standingFromOutlook(log('behind' as GameOutlook['state']))?.standing).toBe('behind');
  });
});
