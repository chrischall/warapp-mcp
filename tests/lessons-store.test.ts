// The per-map record and the lessons store (#312 E2): name-free, keyed by game key, a game processed
// again replaces its share, bounded, 0600, and a file that does not parse is never overwritten.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  lessonsPath,
  MAX_LESSON_ENTRIES,
  MAX_MAP_ENTRIES,
  mapRecordDir,
  mapRecordPath,
  calibrationSummary,
  lessonsSummary,
  mapRecordStarts,
  mapRecordSummary,
  readLessons,
  readMapRecord,
  recordLessons,
  recordMapGame,
  type LessonEntry,
  type MapEntry,
} from '../src/lessons-store.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'warapp-mcp-lessons-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const key = (n: number) => n.toString(16).padStart(32, '0');
const mapEntry = (n: number, o: Partial<MapEntry> = {}): MapEntry => ({
  key: key(n),
  format: '1v1',
  seats: 2,
  result: 'eliminated',
  turns: 12,
  me: { territories: [1], bonuses: [100], income: [5, 6, 7], income4: 8, income8: 9 },
  winners: [{ territories: [6], bonuses: [200], income4: 12, income8: 30 }],
  ...o,
});
const lesson = (n: number, o: Partial<LessonEntry> = {}): LessonEntry => ({
  key: key(n),
  format: 'ffa',
  seats: 4,
  result: 'eliminated',
  flatAfterTurn: 6,
  howLost: { cause: 'last-territories', turn: 14 },
  calibration: { 'under-25': { n: 2, sum: 0.6, sq: 0.2, logSum: -2.5, under: 2, over: 0 } },
  ...o,
});

describe('the per-map record', () => {
  it('keeps each game once, moves its outcome when it is processed again, and summarizes the pace', async () => {
    const dir = tmp();
    expect(await recordMapGame(dir, 77, mapEntry(1))).toBe('kept');
    expect(await recordMapGame(dir, 77, mapEntry(2, { result: 'won', winners: [{ territories: [1], bonuses: [100], income4: 10, income8: 26 }] }))).toBe('kept');
    expect(await recordMapGame(dir, 77, mapEntry(1, { result: 'surrendered' }))).toBe('kept');
    const rec = await readMapRecord(dir, 77);
    if (rec === 'unreadable') throw new Error('unreadable');
    expect(rec.games).toBe(2);
    expect(rec.outcomes).toEqual({ surrendered: 1, won: 1 });
    expect(rec.entries.map((e) => e.key)).toEqual([key(2), key(1)]);
    expect(mapRecordSummary(rec)).toEqual({
      games: 2,
      outcomes: { surrendered: 1, won: 1 },
      pace: { winners: { income4: 11, income8: 28 }, mine: { income4: 8, income8: 9 } },
    });
    expect(statSync(mapRecordPath(dir, 77)).mode & 0o777).toBe(0o600);
    expect(statSync(mapRecordDir(dir)).mode & 0o777).toBe(0o700);
  });

  it('keeps at most MAX_MAP_ENTRIES games per map (their counts stay) and the newest maps', async () => {
    const dir = tmp();
    for (let i = 1; i <= MAX_MAP_ENTRIES + 3; i++) await recordMapGame(dir, 5, mapEntry(i));
    const rec = await readMapRecord(dir, 5);
    if (rec === 'unreadable') throw new Error('unreadable');
    expect(rec.entries).toHaveLength(MAX_MAP_ENTRIES);
    expect(rec.games).toBe(MAX_MAP_ENTRIES + 3);
    const other = tmp();
    for (const m of [10, 11, 12]) {
      await recordMapGame(other, m, mapEntry(1), 3);
      const old = new Date(Date.now() - (20 - m) * 60_000);
      utimesSync(mapRecordPath(other, m), old, old);
    }
    await recordMapGame(other, 13, mapEntry(1), 3);
    expect(readdirSync(mapRecordDir(other)).sort()).toEqual(['11.json', '12.json', '13.json']);
  });

  it('never overwrites a record that does not parse', async () => {
    const dir = tmp();
    mkdirSync(mapRecordDir(dir), { recursive: true });
    writeFileSync(mapRecordPath(dir, 9), '{not json');
    expect(await recordMapGame(dir, 9, mapEntry(1))).toBe('failed');
    expect(readFileSync(mapRecordPath(dir, 9), 'utf8')).toBe('{not json');
    writeFileSync(mapRecordPath(dir, 9), JSON.stringify({ version: 2, mapId: 9, games: 0, outcomes: {}, entries: [] }));
    expect(await readMapRecord(dir, 9)).toBe('unreadable');
    expect(await recordMapGame(dir, 9, mapEntry(1))).toBe('failed');
  });
});

describe('the lessons store', () => {
  it('adds a game to its format\'s totals once, replacing its share when processed again', async () => {
    const dir = tmp();
    expect(await recordLessons(dir, lesson(1))).toBe('kept');
    expect(await recordLessons(dir, lesson(2, { format: '1v1', result: 'won', howLost: null, flatAfterTurn: null, calibration: {} }))).toBe('kept');
    expect(await recordLessons(dir, lesson(1, { flatAfterTurn: 8, howLost: { cause: 'commander', turn: 10 } }))).toBe('kept');
    const f = await readLessons(dir);
    if (f === 'unreadable') throw new Error('unreadable');
    expect(f.byFormat.ffa).toEqual({
      games: 1,
      outcomes: { eliminated: 1 },
      howLost: { commander: 1 },
      flat: { n: 1, sum: 8 },
      calibration: { 'under-25': { n: 2, sum: 0.6, sq: 0.2, logSum: -2.5, under: 2, over: 0 } },
    });
    expect(f.byFormat['1v1']).toEqual({ games: 1, outcomes: { won: 1 }, howLost: {}, flat: { n: 0, sum: 0 }, calibration: {} });
    expect(f.entries).toHaveLength(2);
    expect(statSync(lessonsPath(dir)).mode & 0o777).toBe(0o600);
  });

  it('a game whose format changes moves between formats', async () => {
    const dir = tmp();
    await recordLessons(dir, lesson(1));
    await recordLessons(dir, lesson(1, { format: 'team' }));
    const f = await readLessons(dir);
    if (f === 'unreadable') throw new Error('unreadable');
    expect(Object.keys(f.byFormat)).toEqual(['team']);
  });

  it('keeps at most MAX_LESSON_ENTRIES entries; the dropped ones stay counted', async () => {
    const dir = tmp();
    for (let i = 1; i <= MAX_LESSON_ENTRIES + 2; i++) await recordLessons(dir, lesson(i, { calibration: {} }));
    const f = await readLessons(dir);
    if (f === 'unreadable') throw new Error('unreadable');
    expect(f.entries).toHaveLength(MAX_LESSON_ENTRIES);
    expect(f.byFormat.ffa!.games).toBe(MAX_LESSON_ENTRIES + 2);
  });

  it('never overwrites a store that does not parse, nor one with a malformed total', async () => {
    const dir = tmp();
    writeFileSync(lessonsPath(dir), '[]');
    expect(await recordLessons(dir, lesson(1))).toBe('failed');
    expect(readFileSync(lessonsPath(dir), 'utf8')).toBe('[]');
    writeFileSync(lessonsPath(dir), JSON.stringify({ version: 1, byFormat: { ffa: { games: 'x' } }, entries: [] }));
    expect(await recordLessons(dir, lesson(1))).toBe('failed');
    expect(existsSync(lessonsPath(dir))).toBe(true);
  });
});

describe('the read-only views (#312 E3)', () => {
  it('a map record by start bonus: my results per bonus my start touched, and the winners\' start bonuses', () => {
    const rec = {
      version: 1 as const,
      mapId: 3,
      games: 3,
      outcomes: { won: 1, eliminated: 2 },
      entries: [
        mapEntry(1, { result: 'won', me: { territories: [1], bonuses: [100, 101], income: [], income4: 9, income8: 20 }, winners: [{ territories: [1], bonuses: [100, 101], income4: 9, income8: 20 }] }),
        mapEntry(2),
        mapEntry(3, { winners: [{ territories: [7], bonuses: [200], income4: 14, income8: null }] }),
      ],
    };
    expect(mapRecordStarts(rec)).toEqual({
      mine: [
        { bonusId: 100, games: 3, outcomes: { won: 1, eliminated: 2 } },
        { bonusId: 101, games: 1, outcomes: { won: 1 } },
      ],
      winners: [
        { bonusId: 200, games: 2 },
        { bonusId: 100, games: 1 },
        { bonusId: 101, games: 1 },
      ],
    });
  });

  it('a calibration summary: count, mean, geometric mean and the shares read low and high, by band', () => {
    const s = calibrationSummary({
      'under-25': { n: 4, sum: 2, sq: 1.25, logSum: 4 * Math.log(0.4), under: 3, over: 0 },
      '75-up': { n: 2, sum: 2.2, sq: 2.42, logSum: 2 * Math.log(1.1), under: 0, over: 0 },
    });
    expect(s).toEqual({
      'under-25': { n: 4, mean: 0.5, geoMean: 0.4, low: 0.75, high: 0 },
      '75-up': { n: 2, mean: 1.1, geoMean: 1.1, low: 0, high: 0 },
    });
  });

  it('the lessons summary: per format the games, outcomes, how lost, the mean flat turn and the calibration, and every format together', () => {
    const file = {
      version: 1 as const,
      byFormat: {
        ffa: {
          games: 3,
          outcomes: { eliminated: 2, won: 1 },
          howLost: { 'last-territories': 2 },
          flat: { n: 2, sum: 13 },
          calibration: { 'under-25': { n: 2, sum: 0.6, sq: 0.2, logSum: 2 * Math.log(0.3), under: 2, over: 0 } },
        },
        '1v1': {
          games: 1,
          outcomes: { won: 1 },
          howLost: {},
          flat: { n: 0, sum: 0 },
          calibration: { 'under-25': { n: 2, sum: 1.4, sq: 1, logSum: 2 * Math.log(0.7), under: 0, over: 0 } },
        },
      },
      entries: [],
    };
    expect(lessonsSummary(file)).toEqual({
      games: 4,
      byFormat: {
        '1v1': { games: 1, outcomes: { won: 1 }, howLost: {}, flatAfterTurn: null, calibration: { 'under-25': { n: 2, mean: 0.7, geoMean: 0.7, low: 0, high: 0 } } },
        ffa: {
          games: 3,
          outcomes: { eliminated: 2, won: 1 },
          howLost: { 'last-territories': 2 },
          flatAfterTurn: { games: 2, mean: 6.5 },
          calibration: { 'under-25': { n: 2, mean: 0.3, geoMean: 0.3, low: 1, high: 0 } },
        },
      },
      calibration: { 'under-25': { n: 4, mean: 0.5, geoMean: 0.46, low: 0.5, high: 0 } },
    });
  });
});
