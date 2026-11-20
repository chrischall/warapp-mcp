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
  recordLessonsExcluded,
  recordMapExcluded,
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

describe('#437: lottery and no-show games counted apart', () => {
  it('the map record keeps them out of its games and entries, counted once each, and takes back a game counted before', async () => {
    const dir = tmp();
    await recordMapGame(dir, 9, mapEntry(1));
    await recordMapGame(dir, 9, mapEntry(2, { result: 'won' }));
    expect(await recordMapExcluded(dir, 9, key(3), 'lottery')).toBe('excluded');
    expect(await recordMapExcluded(dir, 9, key(3), 'lottery')).toBe('excluded');
    // Game 2 was counted, then read as a no-show: its share comes out.
    expect(await recordMapExcluded(dir, 9, key(2), 'no-show')).toBe('excluded');
    const rec = await readMapRecord(dir, 9);
    if (rec === 'unreadable') throw new Error('unreadable');
    expect(rec.games).toBe(1);
    expect(rec.outcomes).toEqual({ eliminated: 1 });
    expect(rec.entries.map((e) => e.key)).toEqual([key(1)]);
    expect(rec.excluded).toEqual({ lottery: 1, noShow: 1, keys: [{ key: key(3), kind: 'lottery' }, { key: key(2), kind: 'no-show' }] });
    expect(mapRecordSummary(rec).excluded).toEqual({ lottery: 1, noShow: 1 });
    // Counted again later (read as a normal game): out of the excluded counts.
    await recordMapGame(dir, 9, mapEntry(3));
    const again = await readMapRecord(dir, 9);
    if (again === 'unreadable') throw new Error('unreadable');
    expect(again.excluded).toEqual({ lottery: 0, noShow: 1, keys: [{ key: key(2), kind: 'no-show' }] });
    expect(again.games).toBe(2);
  });

  it('the lessons keep them out of every total, counted once each, and take back a game counted before', async () => {
    const dir = tmp();
    await recordLessons(dir, lesson(1));
    await recordLessons(dir, lesson(2, { result: 'won', howLost: null }));
    expect(await recordLessonsExcluded(dir, key(2), 'lottery')).toBe('excluded');
    expect(await recordLessonsExcluded(dir, key(4), 'no-show')).toBe('excluded');
    expect(await recordLessonsExcluded(dir, key(4), 'no-show')).toBe('excluded');
    const file = await readLessons(dir);
    if (file === 'unreadable') throw new Error('unreadable');
    expect(file.byFormat.ffa).toMatchObject({ games: 1, outcomes: { eliminated: 1 } });
    expect(file.entries.map((e) => e.key)).toEqual([key(1)]);
    expect(file.excluded).toEqual({ lottery: 1, noShow: 1, keys: [{ key: key(2), kind: 'lottery' }, { key: key(4), kind: 'no-show' }] });
    expect(lessonsSummary(file)).toMatchObject({ games: 1, excluded: { lottery: 1, noShow: 1 } });
  });

  it('a malformed excluded block makes the store unreadable (never overwritten); old files without it still read', async () => {
    const dir = tmp();
    writeFileSync(lessonsPath(dir), JSON.stringify({ version: 1, byFormat: {}, entries: [], excluded: { lottery: 'x' } }));
    expect(await readLessons(dir)).toBe('unreadable');
    expect(await recordLessonsExcluded(dir, key(1), 'lottery')).toBe('failed');
    const old = tmp();
    writeFileSync(lessonsPath(old), JSON.stringify({ version: 1, byFormat: {}, entries: [] }));
    expect(await readLessons(old)).toEqual({ version: 1, byFormat: {}, entries: [] });
  });

  it('entries keep their kinds and settings', async () => {
    const dir = tmp();
    await recordMapGame(dir, 4, mapEntry(1, { kinds: ['team'], settings: { key: 'sha256:0123456789abcdef', localDeployments: true, commanders: false } }));
    await recordLessons(dir, lesson(1, { kinds: ['legacy'] }));
    const rec = await readMapRecord(dir, 4);
    const file = await readLessons(dir);
    if (rec === 'unreadable' || file === 'unreadable') throw new Error('unreadable');
    expect(rec.entries[0]).toMatchObject({ kinds: ['team'], settings: { key: 'sha256:0123456789abcdef', localDeployments: true, commanders: false } });
    expect(file.entries[0]!.kinds).toEqual(['legacy']);
  });
});

describe('#437: the map record filtered by the game\'s format and settings', () => {
  const rec = {
    version: 1 as const,
    mapId: 7,
    games: 4,
    outcomes: { eliminated: 2, won: 2 },
    entries: [
      mapEntry(1, { format: 'ffa', seats: 4, winners: [{ territories: [6], bonuses: [200], income4: 20, income8: 40 }] }),
      mapEntry(2, { format: 'team', seats: 4, result: 'won', winners: [{ territories: [1], bonuses: [100], income4: 6, income8: 10 }], settings: { key: null, localDeployments: true, commanders: false } }),
      mapEntry(3, { format: 'team', seats: 4, result: 'won', winners: [{ territories: [1], bonuses: [300], income4: 8, income8: 12 }], settings: { key: null, localDeployments: false } }),
      mapEntry(4, { format: 'team', seats: 4, winners: [{ territories: [1], bonuses: [400], income4: 10, income8: 14 }] }),
    ],
  };
  it('without a filter: every entry, as before', () => {
    expect(mapRecordSummary(rec)).toEqual({
      games: 4,
      outcomes: { eliminated: 2, won: 2 },
      pace: { winners: { income4: 9, income8: 13 }, mine: { income4: 8, income8: 9 } },
    });
  });
  it('by format: only that format\'s entries, with how many matched', () => {
    const s = mapRecordSummary(rec, { format: 'team' });
    expect(s).toEqual({
      games: 3,
      outcomes: { won: 2, eliminated: 1 },
      pace: { winners: { income4: 8, income8: 12 }, mine: { income4: 8, income8: 9 } },
      matched: { by: { format: 'team' }, entries: 3, of: 4, settingsUnknown: 0 },
    });
  });
  it('by Local Deployment and Commanders too: an entry that kept no such flag matches, counted as unknown', () => {
    const s = mapRecordSummary(rec, { format: 'team', localDeployments: true, commanders: false });
    expect(s.matched).toEqual({ by: { format: 'team', localDeployments: true, commanders: false }, entries: 2, of: 4, settingsUnknown: 1 });
    expect(s.games).toBe(2);
    expect(mapRecordStarts(rec, { format: 'team', localDeployments: true }).winners.map((w) => w.bonusId)).toEqual([100, 400]);
  });
});
