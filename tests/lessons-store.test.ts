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
