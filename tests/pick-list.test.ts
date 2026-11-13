// The pick list kept for reading the award (#166). Ids are made up; files live in a temp dir.
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AwardReading } from '../src/analysis/award.js';
import { PICK_LIST_MAX_AGE_MS, pickListPath, readPickRecord, writeAward, writePickable, writePickList } from '../src/pick-list.js';

const dir = () => mkdtempSync(join(tmpdir(), 'warapp-mcp-picks-'));
const GAME = 4101;
const ME = 5500000011;

const READING: AwardReading = {
  granted: [11, 13, 14],
  unlisted: [],
  opponentStarts: [12],
  allStartsKnown: false,
  role: null,
  opponentFirstAward: null,
};

describe('the stored pick list', () => {
  it('round-trips a list, with no award until one is read', async () => {
    const d = dir();
    expect(await writePickList(d, GAME, ME, [11, 12, 13, 14, 15, 16])).toBe(true);
    expect(await readPickRecord(d, GAME, ME)).toEqual({ gameId: GAME, playerId: ME, list: [11, 12, 13, 14, 15, 16] });
    expect(statSync(pickListPath(d, GAME)).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, 'picks')).mode & 0o777).toBe(0o700);
  });

  it('keeps the award read from it, and a "nothing to read" too', async () => {
    const d = dir();
    await writePickList(d, GAME, ME, [11, 12, 13, 14, 15, 16]);
    expect(await writeAward(d, GAME, ME, READING)).toBe(true);
    expect((await readPickRecord(d, GAME, ME))!.award).toEqual(READING);
    expect(await writeAward(d, GAME, ME, null)).toBe(true);
    expect((await readPickRecord(d, GAME, ME))!.award).toBeNull();
  });

  it('a new list drops the award read from the old one; the same list keeps it', async () => {
    const d = dir();
    await writePickList(d, GAME, ME, [11, 12, 13]);
    await writeAward(d, GAME, ME, READING);
    await writePickList(d, GAME, ME, [11, 12, 13]);
    expect((await readPickRecord(d, GAME, ME))!.award).toEqual(READING);
    await writePickList(d, GAME, ME, [13, 12, 11]);
    expect(await readPickRecord(d, GAME, ME)).toEqual({ gameId: GAME, playerId: ME, list: [13, 12, 11] });
  });

  it('is nobody else\'s: another player or game reads nothing, and an award for them is not written', async () => {
    const d = dir();
    await writePickList(d, GAME, ME, [11, 12, 13]);
    expect(await readPickRecord(d, GAME, ME + 1)).toBeUndefined();
    expect(await readPickRecord(d, GAME + 1, ME)).toBeUndefined();
    expect(await writeAward(d, GAME, ME + 1, READING)).toBe(false);
    expect(await writeAward(d, GAME + 1, ME, READING)).toBe(false);
    expect((await readPickRecord(d, GAME, ME))!.award).toBeUndefined();
  });

  it('reads an unusable file as nothing, never throwing', async () => {
    const d = dir();
    mkdirSync(join(d, 'picks'), { recursive: true });
    for (const body of ['not json', '[]', JSON.stringify({ gameId: GAME, playerId: ME, list: 'x' }), JSON.stringify({ gameId: GAME, playerId: ME, list: [1, 'two'] })]) {
      writeFileSync(pickListPath(d, GAME), body);
      expect(await readPickRecord(d, GAME, ME), body).toBeUndefined();
    }
    // An award that does not look like one is dropped; the list still reads.
    writeFileSync(pickListPath(d, GAME), JSON.stringify({ gameId: GAME, playerId: ME, list: [11, 12], award: { granted: 'no' } }));
    expect(await readPickRecord(d, GAME, ME)).toEqual({ gameId: GAME, playerId: ME, list: [11, 12] });
    expect(await readPickRecord(join(d, 'missing'), GAME, ME)).toBeUndefined();
  });

  it('refuses an empty list or ids that are not positive integers', async () => {
    const d = dir();
    expect(await writePickList(d, GAME, ME, [])).toBe(false);
    expect(await writePickList(d, GAME, ME, [11, 1.5])).toBe(false);
    expect(await writePickList(d, GAME, ME, [11, -2])).toBe(false);
    expect(existsSync(pickListPath(d, GAME))).toBe(false);
  });

  it('deletes lists of games not written for a long time, on the first write of a process', async () => {
    const d = dir();
    mkdirSync(join(d, 'picks'), { recursive: true });
    const old = pickListPath(d, 77);
    const recent = pickListPath(d, 78);
    const other = join(d, 'picks', 'notes.txt');
    for (const f of [old, recent, other]) writeFileSync(f, '{}');
    const past = new Date(Date.now() - PICK_LIST_MAX_AGE_MS - 60_000);
    utimesSync(old, past, past);
    utimesSync(other, past, past);
    await writePickList(d, GAME, ME, [11, 12, 13]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(JSON.parse(readFileSync(pickListPath(d, GAME), 'utf8')).list).toEqual([11, 12, 13]);
  });
});

describe('the pickable territories kept beside the list', () => {
  it('are kept on their own, before any list: sorted, each once', async () => {
    const d = dir();
    expect(await writePickable(d, GAME, ME, [16, 11, 14, 11, 12])).toBe(true);
    expect(await readPickRecord(d, GAME, ME)).toEqual({ gameId: GAME, playerId: ME, pickable: [11, 12, 14, 16] });
    expect(statSync(pickListPath(d, GAME)).mode & 0o777).toBe(0o600);
    // Ids only.
    expect(Object.keys(JSON.parse(readFileSync(pickListPath(d, GAME), 'utf8'))).sort()).toEqual(['gameId', 'pickable', 'playerId']);
  });

  it('with no list there is no award to keep', async () => {
    const d = dir();
    await writePickable(d, GAME, ME, [11, 12, 13]);
    expect(await writeAward(d, GAME, ME, READING)).toBe(false);
    expect(await readPickRecord(d, GAME, ME)).toEqual({ gameId: GAME, playerId: ME, pickable: [11, 12, 13] });
  });

  it('stay when the list is written, changed or read for its award, and the list stays when they are written', async () => {
    const d = dir();
    await writePickable(d, GAME, ME, [11, 12, 13, 14]);
    await writePickList(d, GAME, ME, [12, 11]);
    expect(await readPickRecord(d, GAME, ME)).toEqual({ gameId: GAME, playerId: ME, list: [12, 11], pickable: [11, 12, 13, 14] });
    await writeAward(d, GAME, ME, READING);
    expect(await readPickRecord(d, GAME, ME)).toEqual({ gameId: GAME, playerId: ME, list: [12, 11], pickable: [11, 12, 13, 14], award: READING });
    // The same pickables again change nothing; others replace them and keep the list and its award.
    expect(await writePickable(d, GAME, ME, [14, 13, 12, 11])).toBe(true);
    expect(await writePickable(d, GAME, ME, [11, 12, 15])).toBe(true);
    expect(await readPickRecord(d, GAME, ME)).toEqual({ gameId: GAME, playerId: ME, list: [12, 11], pickable: [11, 12, 15], award: READING });
    await writePickList(d, GAME, ME, [11, 12]);
    expect(await readPickRecord(d, GAME, ME)).toEqual({ gameId: GAME, playerId: ME, list: [11, 12], pickable: [11, 12, 15] });
  });

  it('refuses none, or ids that are not positive integers, and replaces another player\'s record', async () => {
    const d = dir();
    expect(await writePickable(d, GAME, ME, [])).toBe(false);
    expect(await writePickable(d, GAME, ME, [11, 0])).toBe(false);
    expect(await writePickable(d, GAME, ME, [11, 2.5])).toBe(false);
    expect(existsSync(pickListPath(d, GAME))).toBe(false);
    await writePickList(d, GAME, ME + 1, [11, 12]);
    await writePickable(d, GAME, ME, [11, 12, 13]);
    expect(await readPickRecord(d, GAME, ME + 1)).toBeUndefined();
    expect(await readPickRecord(d, GAME, ME)).toEqual({ gameId: GAME, playerId: ME, pickable: [11, 12, 13] });
  });

  it('reads a file with neither a list nor pickables as nothing, and drops unusable pickables', async () => {
    const d = dir();
    mkdirSync(join(d, 'picks'), { recursive: true });
    writeFileSync(pickListPath(d, GAME), JSON.stringify({ gameId: GAME, playerId: ME }));
    expect(await readPickRecord(d, GAME, ME)).toBeUndefined();
    writeFileSync(pickListPath(d, GAME), JSON.stringify({ gameId: GAME, playerId: ME, pickable: ['x'] }));
    expect(await readPickRecord(d, GAME, ME)).toBeUndefined();
    writeFileSync(pickListPath(d, GAME), JSON.stringify({ gameId: GAME, playerId: ME, list: [11, 12], pickable: 'x' }));
    expect(await readPickRecord(d, GAME, ME)).toEqual({ gameId: GAME, playerId: ME, list: [11, 12] });
  });
});
