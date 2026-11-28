// #436: the outlook's calibration is read from the lessons store: past games' tracked income ÷ the true
// income per coverage band, this format's band when it has enough samples, else every format's together.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MIN_CALIBRATION_SAMPLES } from '../src/analysis/outlook.js';
import { outlookCalibration, recordLessons, type LessonEntry, type LessonsFile } from '../src/lessons-store.js';
import { outlookCalibrationFor, trackCalibrationFor } from '../src/tools/past-games.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'warapp-mcp-ocal-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** n samples, every one at `ratio`. */
const band = (n: number, ratio: number) => ({ n, sum: n * ratio, sq: n * ratio * ratio, logSum: n * Math.log(ratio), under: 0, over: 0 });
const totals = (calibration: LessonEntry['calibration']) => ({ games: 1, outcomes: {}, howLost: {}, flat: { n: 0, sum: 0 }, calibration });

describe('outlook calibration (#436)', () => {
  it("uses this format's band when it has enough samples, else every format's, else none", () => {
    const file: LessonsFile = {
      version: 1,
      byFormat: {
        '1v1': totals({ '25-50': band(10, 0.5), none: band(2, 0.4) }),
        ffa: totals({ '25-50': band(10, 0.8), none: band(4, 0.4), '75-up': band(1, 1) }),
      },
      entries: [],
    };
    const c = outlookCalibration(file, '1v1', 5);
    expect(c['25-50']).toEqual({ geoMean: 0.5, n: 10 });
    // 1v1 has 2 in `none`: the pooled 6 at 0.4 stand in.
    expect(c.none).toEqual({ geoMean: 0.4, n: 6 });
    expect(c['75-up']).toBeUndefined();
  });

  it('reads the store; nothing without a data dir, with profiling off, or with no band', async () => {
    const dir = tmp();
    expect(await outlookCalibrationFor(dir, {}, '1v1')).toBeUndefined();
    const entry: LessonEntry = {
      key: '0'.repeat(32),
      format: '1v1',
      seats: 2,
      result: 'lost',
      flatAfterTurn: null,
      howLost: null,
      calibration: { 'under-25': band(MIN_CALIBRATION_SAMPLES, 0.6) },
    };
    expect(await recordLessons(dir, entry)).toBe('kept');
    expect(await outlookCalibrationFor(dir, {}, '1v1')).toEqual({ 'under-25': { geoMean: 0.6, n: MIN_CALIBRATION_SAMPLES } });
    expect(await outlookCalibrationFor(undefined, {}, '1v1')).toBeUndefined();
    expect(await outlookCalibrationFor(dir, { WARAPP_PLAYER_PROFILE: 'off' }, '1v1')).toBeUndefined();
  });

  it('own format only leaves out a band this format lacks', () => {
    const file: LessonsFile = {
      version: 1,
      byFormat: {
        '1v1': totals({ '25-50': band(10, 0.5), none: band(2, 0.4) }),
        ffa: totals({ '25-50': band(10, 0.8), none: band(4, 0.4) }),
      },
      entries: [],
    };
    expect(outlookCalibration(file, 'ffa', 5, { ownOnly: true })).toEqual({ '25-50': { geoMean: 0.8, n: 10 } });
    expect(outlookCalibration(file, '1v1', 5, { ownOnly: true })).toEqual({ '25-50': { geoMean: 0.5, n: 10 } });
  });
});

describe("the planner's track calibration (#568, narrowed after a lost 1v1)", () => {
  const entry = (format: LessonEntry['format'], key: string, calibration: LessonEntry['calibration']): LessonEntry => ({
    key,
    format,
    seats: format === '1v1' ? 2 : 6,
    result: 'lost',
    flatAfterTurn: null,
    howLost: null,
    calibration,
  });

  it('none in a 1v1, though the outlook still reads its bands', async () => {
    const dir = tmp();
    expect(await recordLessons(dir, entry('1v1', '1'.repeat(32), { '50-75': band(10, 0.3) }))).toBe('kept');
    expect(await outlookCalibrationFor(dir, {}, '1v1')).toEqual({ '50-75': { geoMean: 0.3, n: 10 } });
    expect(await trackCalibrationFor(dir, {}, '1v1')).toBeUndefined();
  });

  it("a free-for-all reads its own bands, never another format's", async () => {
    const dir = tmp();
    expect(await recordLessons(dir, entry('1v1', '2'.repeat(32), { '50-75': band(10, 0.3) }))).toBe('kept');
    // The outlook falls back to every format's band; the planner does not.
    expect(await outlookCalibrationFor(dir, {}, 'ffa')).toEqual({ '50-75': { geoMean: 0.3, n: 10 } });
    expect(await trackCalibrationFor(dir, {}, 'ffa')).toBeUndefined();
    expect(await recordLessons(dir, entry('ffa', '3'.repeat(32), { '25-50': band(MIN_CALIBRATION_SAMPLES, 0.5) }))).toBe('kept');
    expect(await trackCalibrationFor(dir, {}, 'ffa')).toEqual({ '25-50': { geoMean: 0.5, n: MIN_CALIBRATION_SAMPLES } });
  });

  it('nothing without a data dir, with profiling off, or with an unreadable store', async () => {
    expect(await trackCalibrationFor(undefined, {}, 'ffa')).toBeUndefined();
    const dir = tmp();
    expect(await recordLessons(dir, entry('ffa', '4'.repeat(32), { '25-50': band(MIN_CALIBRATION_SAMPLES, 0.5) }))).toBe('kept');
    expect(await trackCalibrationFor(dir, { WARAPP_PLAYER_PROFILE: 'off' }, 'ffa')).toBeUndefined();
    writeFileSync(join(dir, 'lessons.json'), 'not json');
    expect(await trackCalibrationFor(dir, {}, 'ffa')).toBeUndefined();
  });
});
