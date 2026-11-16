// What finished games teach, kept across games (#312 E2; owner decisions P2–P4 of 2026-11-16), name-free:
//
// - `<dataDir>/maps-record/<mapId>.json` (version 1), one per map I finished a game on: the games
//   kept and their outcomes, and per game (at most `MAX_MAP_ENTRIES`, the oldest dropped first, its
//   counts kept) the format, seats, my result, my start region (territories and the bonuses they
//   touch) and income curve, and each winner's start region and income after turns 4 and 8 (the pace
//   to beat). At most `MAX_MAP_RECORDS` maps, the least recently written dropped first.
// - `<dataDir>/lessons.json` (version 1): per format the games, outcomes, how each lost game was lost
//   (a cause, never who), the turn my income first went flat, and the tracker's estimates scored
//   against the true incomes by frontier coverage (#294): aggregates only — a game's entry (at most
//   `MAX_LESSON_ENTRIES`) holds the same counts for that game alone, so processing it again replaces
//   its share, never adds it twice; a dropped entry's counts stay in the totals.
//
// Every game is keyed by `finishedGameKey` (an HMAC of my account and the game under the one shared
// salt): no game or player id, no name, no clock. Territory, bonus and map ids are the map's own,
// public data. 0600 files in 0700 folders, atomic writes under the in-process path lock; a file that
// exists but does not parse (not JSON, not an object, another version, a malformed total) is never
// overwritten (`failed`). Off with `WARAPP_PLAYER_PROFILE=off` (the end-of-game pass does not run).
// Profiles and lessons INFORM ONLY (P1): no planner decision reads any of this.
import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FinishedOutcome } from './analysis/finished-game.js';
import {
  addCalibration,
  COVERAGE_BUCKETS,
  type Calibration,
  type LessonCause,
  type LessonLoss,
  type MapGameFacts,
  type RatioStats,
  type StartRegion,
} from './analysis/game-lessons.js';
import type { ProfileFormat } from './analysis/opponent-profile.js';
import { PROFILE_FORMATS } from './analysis/opponent-profile.js';
import { writeJsonAtomic } from './map-store.js';
import { withPathLock } from './path-lock.js';

export const MAX_MAP_ENTRIES = 50;
export const MAX_MAP_RECORDS = 200;
export const MAX_LESSON_ENTRIES = 500;

export const mapRecordDir = (dir: string) => join(dir, 'maps-record');
export const mapRecordPath = (dir: string, mapId: number) => join(mapRecordDir(dir), `${mapId}.json`);
export const lessonsPath = (dir: string) => join(dir, 'lessons.json');

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const ints = (v: unknown): v is number[] => Array.isArray(v) && v.every(isInt);
const intOrNull = (v: unknown): v is number | null => v === null || isInt(v);
const HASH = /^[0-9a-f]{32}$/;
const isFormat = (v: unknown): v is ProfileFormat => PROFILE_FORMATS.includes(v as ProfileFormat);
const RESULTS: readonly FinishedOutcome[] = ['won', 'lost', 'surrendered', 'eliminated', 'booted', 'ended-by-vote', 'unknown'];
const isResult = (v: unknown): v is FinishedOutcome => RESULTS.includes(v as FinishedOutcome);
const CAUSES: readonly LessonCause[] = ['commander', 'last-territories', 'unknown', 'surrendered', 'booted', 'still-holding'];

/** Read a store: `missing`, the parsed object, or `unreadable` (exists, not JSON or not an object). */
async function readStore(path: string): Promise<Rec | 'missing' | 'unreadable'> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  try {
    const v: unknown = JSON.parse(text);
    return isRec(v) ? v : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

const countsOf = (v: unknown): Record<string, number> | undefined =>
  isRec(v) && Object.values(v).every(isInt) ? Object.fromEntries(Object.entries(v) as [string, number][]) : undefined;
const bumpCount = (c: Record<string, number>, k: string, by: number) => {
  const n = (c[k] ?? 0) + by;
  if (n) c[k] = n;
  else delete c[k];
};

// ---- the per-map record ----

/** One finished game on a map, name-free. */
export interface MapEntry {
  key: string;
  format: ProfileFormat;
  seats: number;
  result: FinishedOutcome;
  /** The game's completed turns at the finish. */
  turns: number | null;
  me: MapGameFacts['me'];
  winners: MapGameFacts['winners'];
}

export interface MapRecord {
  version: 1;
  mapId: number;
  /** Games ever kept for the map (its entries are bounded). */
  games: number;
  /** My results over those games. */
  outcomes: Record<string, number>;
  entries: MapEntry[];
}

const regionOf = (v: unknown): StartRegion | undefined => (isRec(v) && ints(v.territories) && ints(v.bonuses) ? { territories: v.territories, bonuses: v.bonuses } : undefined);

function mapEntryOf(v: unknown): MapEntry | undefined {
  if (!isRec(v) || typeof v.key !== 'string' || !HASH.test(v.key) || !isFormat(v.format) || !isInt(v.seats) || !isResult(v.result) || !intOrNull(v.turns)) return undefined;
  const m = v.me;
  const mine = regionOf(m);
  if (!mine || !isRec(m) || !Array.isArray(m.income) || !m.income.every(intOrNull) || !intOrNull(m.income4) || !intOrNull(m.income8)) return undefined;
  if (!Array.isArray(v.winners)) return undefined;
  const winners: MapEntry['winners'] = [];
  for (const w of v.winners) {
    const r = regionOf(w);
    if (!r || !isRec(w) || !intOrNull(w.income4) || !intOrNull(w.income8)) return undefined;
    winners.push({ ...r, income4: w.income4, income8: w.income8 });
  }
  return {
    key: v.key,
    format: v.format,
    seats: v.seats,
    result: v.result,
    turns: v.turns,
    me: { ...mine, income: m.income as (number | null)[], income4: m.income4, income8: m.income8 },
    winners,
  };
}

/** The record of `mapId`: an empty one when missing, `unreadable` when it cannot be parsed. Never throws. */
export async function readMapRecord(dir: string, mapId: number): Promise<MapRecord | 'unreadable'> {
  try {
    const v = await readStore(mapRecordPath(dir, mapId));
    if (v === 'unreadable') return v;
    if (v === 'missing') return { version: 1, mapId, games: 0, outcomes: {}, entries: [] };
    const outcomes = countsOf(v.outcomes);
    if (v.version !== 1 || v.mapId !== mapId || !isInt(v.games) || !outcomes) return 'unreadable';
    const entries = (Array.isArray(v.entries) ? v.entries : []).map(mapEntryOf).filter((e): e is MapEntry => e !== undefined);
    return { version: 1, mapId, games: v.games, outcomes, entries };
  } catch {
    return 'unreadable';
  }
}

/**
 * Keep one finished game in its map's record: a game already there (by key) is replaced, its outcome
 * moved; a new one counted. `kept`, or `failed` (an unreadable record is never overwritten; a failed
 * write). Never throws.
 */
export async function recordMapGame(dir: string, mapId: number, entry: MapEntry, keep = MAX_MAP_RECORDS): Promise<'kept' | 'failed'> {
  const path = mapRecordPath(dir, mapId);
  try {
    const r = await withPathLock(path, async () => {
      const rec = await readMapRecord(dir, mapId);
      if (rec === 'unreadable') return 'failed' as const;
      const old = rec.entries.find((e) => e.key === entry.key);
      if (old) bumpCount(rec.outcomes, old.result, -1);
      else rec.games++;
      bumpCount(rec.outcomes, entry.result, 1);
      rec.entries = [...rec.entries.filter((e) => e.key !== entry.key), entry].slice(-MAX_MAP_ENTRIES);
      await writeJsonAtomic(path, mapRecordDir(dir), rec);
      return 'kept' as const;
    });
    if (r === 'kept') await pruneMapRecords(dir, keep, path).catch(() => undefined);
    return r;
  } catch {
    return 'failed';
  }
}

async function pruneMapRecords(dir: string, keep: number, protect: string): Promise<void> {
  const folder = mapRecordDir(dir);
  const files: { path: string; at: number }[] = [];
  for (const name of await readdir(folder)) {
    if (!/^\d+\.json$/.test(name)) continue;
    const path = join(folder, name);
    try {
      files.push({ path, at: (await stat(path)).mtimeMs });
    } catch {
      // Gone already.
    }
  }
  if (files.length <= keep) return;
  files.sort((a, b) => a.at - b.at || a.path.localeCompare(b.path));
  let over = files.length - keep;
  for (const f of files) {
    if (over <= 0) break;
    if (f.path === protect) continue;
    await unlink(f.path).catch(() => undefined);
    over--;
  }
}

const median = (xs: readonly number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** What a map's record says in short: games, my results, and the winners' pace beside mine (medians over the kept games). Pure. */
export function mapRecordSummary(rec: MapRecord): {
  games: number;
  outcomes: Record<string, number>;
  pace: { winners: { income4: number | null; income8: number | null }; mine: { income4: number | null; income8: number | null } };
} {
  const of = (xs: (number | null)[]) => median(xs.filter((x): x is number => x !== null));
  const winners = rec.entries.flatMap((e) => e.winners);
  return {
    games: rec.games,
    outcomes: rec.outcomes,
    pace: {
      winners: { income4: of(winners.map((w) => w.income4)), income8: of(winners.map((w) => w.income8)) },
      mine: { income4: of(rec.entries.map((e) => e.me.income4)), income8: of(rec.entries.map((e) => e.me.income8)) },
    },
  };
}

// ---- the lessons ----

/** One finished game's lessons, name-free. */
export interface LessonEntry {
  key: string;
  format: ProfileFormat;
  seats: number;
  result: FinishedOutcome;
  /** The completed turns after which my income first went flat (`flatTurn`); `null` when it never did. */
  flatAfterTurn: number | null;
  howLost: LessonLoss | null;
  /** The tracker's estimates against the truth, by coverage bucket (aggregates of the game's turns). */
  calibration: Calibration;
}

/** The totals of one format. */
export interface LessonTotals {
  games: number;
  outcomes: Record<string, number>;
  /** Lost games by cause. */
  howLost: Record<string, number>;
  /** Games whose income went flat, and the sum of the turns it did (their mean is sum ÷ n). */
  flat: { n: number; sum: number };
  calibration: Calibration;
}

export interface LessonsFile {
  version: 1;
  byFormat: Partial<Record<ProfileFormat, LessonTotals>>;
  entries: LessonEntry[];
}

function statsOf(v: unknown): RatioStats | undefined {
  if (!isRec(v) || !isInt(v.n) || !num(v.sum) || !num(v.sq) || !num(v.logSum) || !isInt(v.under) || !isInt(v.over)) return undefined;
  return { n: v.n, sum: v.sum, sq: v.sq, logSum: v.logSum, under: v.under, over: v.over };
}

function calibrationOf(v: unknown): Calibration | undefined {
  if (!isRec(v)) return undefined;
  const out: Calibration = {};
  for (const [k, s] of Object.entries(v)) {
    if (!(COVERAGE_BUCKETS as readonly string[]).includes(k)) return undefined;
    const x = statsOf(s);
    if (!x) return undefined;
    out[k as keyof Calibration] = x;
  }
  return out;
}

function lossOf(v: unknown): LessonLoss | null | undefined {
  if (v === null) return null;
  if (!isRec(v) || !CAUSES.includes(v.cause as LessonCause) || !intOrNull(v.turn)) return undefined;
  return { cause: v.cause as LessonCause, turn: v.turn };
}

function lessonEntryOf(v: unknown): LessonEntry | undefined {
  if (!isRec(v) || typeof v.key !== 'string' || !HASH.test(v.key) || !isFormat(v.format) || !isInt(v.seats) || !isResult(v.result) || !intOrNull(v.flatAfterTurn)) return undefined;
  const loss = lossOf(v.howLost);
  const calibration = calibrationOf(v.calibration);
  if (loss === undefined || !calibration) return undefined;
  return { key: v.key, format: v.format, seats: v.seats, result: v.result, flatAfterTurn: v.flatAfterTurn, howLost: loss, calibration };
}

function totalsOf(v: unknown): LessonTotals | undefined {
  if (!isRec(v) || !isInt(v.games)) return undefined;
  const outcomes = countsOf(v.outcomes);
  const lost = countsOf(v.howLost);
  const calibration = calibrationOf(v.calibration);
  const f = v.flat;
  if (!outcomes || !lost || !calibration || !isRec(f) || !isInt(f.n) || !num(f.sum)) return undefined;
  return { games: v.games, outcomes, howLost: lost, flat: { n: f.n, sum: f.sum }, calibration };
}

/** The lessons store: empty when missing, `unreadable` when it cannot be parsed (a malformed total too). Never throws. */
export async function readLessons(dir: string): Promise<LessonsFile | 'unreadable'> {
  try {
    const v = await readStore(lessonsPath(dir));
    if (v === 'unreadable') return v;
    if (v === 'missing') return { version: 1, byFormat: {}, entries: [] };
    if (v.version !== 1 || !isRec(v.byFormat)) return 'unreadable';
    const byFormat: LessonsFile['byFormat'] = {};
    for (const [k, t] of Object.entries(v.byFormat)) {
      const totals = totalsOf(t);
      if (!isFormat(k) || !totals) return 'unreadable';
      byFormat[k] = totals;
    }
    const entries = (Array.isArray(v.entries) ? v.entries : []).map(lessonEntryOf).filter((e): e is LessonEntry => e !== undefined);
    return { version: 1, byFormat, entries };
  } catch {
    return 'unreadable';
  }
}

const emptyTotals = (): LessonTotals => ({ games: 0, outcomes: {}, howLost: {}, flat: { n: 0, sum: 0 }, calibration: {} });

/** Move `t` by one entry's share, `scale` +1 (add) or −1 (take back). */
function applyEntry(t: LessonTotals, e: LessonEntry, scale: 1 | -1): void {
  t.games += scale;
  bumpCount(t.outcomes, e.result, scale);
  if (e.howLost) bumpCount(t.howLost, e.howLost.cause, scale);
  if (e.flatAfterTurn !== null) t.flat = { n: t.flat.n + scale, sum: t.flat.sum + scale * e.flatAfterTurn };
  t.calibration = addCalibration(t.calibration, e.calibration, scale);
}

/**
 * Keep one finished game's lessons: its totals moved by the difference from the entry stored for it
 * (so processing a game again replaces its share), the entry kept (at most {@link MAX_LESSON_ENTRIES}).
 * `kept`, or `failed` (an unreadable store is never overwritten; a failed write). Never throws.
 */
export async function recordLessons(dir: string, entry: LessonEntry): Promise<'kept' | 'failed'> {
  const path = lessonsPath(dir);
  try {
    return await withPathLock(path, async () => {
      const file = await readLessons(dir);
      if (file === 'unreadable') return 'failed' as const;
      const old = file.entries.find((e) => e.key === entry.key);
      if (old) {
        const t = file.byFormat[old.format];
        if (t) {
          applyEntry(t, old, -1);
          if (t.games <= 0) delete file.byFormat[old.format];
        }
      }
      const t = file.byFormat[entry.format] ?? emptyTotals();
      applyEntry(t, entry, 1);
      file.byFormat[entry.format] = t;
      file.entries = [...file.entries.filter((e) => e.key !== entry.key), entry].slice(-MAX_LESSON_ENTRIES);
      await writeJsonAtomic(path, dir, file);
      return 'kept' as const;
    });
  } catch {
    return 'failed';
  }
}
