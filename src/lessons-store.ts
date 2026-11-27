// What finished games teach, kept across games (#312 E2; owner decisions P2–P4 of 2026-11-16), name-free:
//
// - `<dataDir>/maps-record/<mapId>.json` (version 1), one per map I finished a game on: the games
//   kept and their outcomes, and per game (at most `MAX_MAP_ENTRIES`, the oldest dropped first, its
//   counts kept) the format, seats, my result, my start region (territories and the bonuses they
//   touch) and income curve, and each winner's start region, income curve (#419) and income after turns 4
//   and 8 (the pace to beat). At most `MAX_MAP_RECORDS` maps, the least recently written dropped first.
// - `<dataDir>/lessons.json` (version 1): per format the games, outcomes, how each lost game was lost
//   (a cause, never who), the turn my income first went flat, and the tracker's estimates scored
//   against the true incomes by frontier coverage (#294): aggregates only — a game's entry (at most
//   `MAX_LESSON_ENTRIES`) holds the same counts for that game alone, so processing it again replaces
//   its share, never adds it twice; a dropped entry's counts stay in the totals.
//
// - #437: a lottery or no-show game (`excludedKind`) is in neither store's figures: each keeps
//   `excluded: { lottery, noShow, keys }` instead (a game counted apart once; one counted before is taken
//   back out). Map entries keep the game's kinds and settings key and flags, and the views read only the
//   games matching the current game's format and settings (`MapMatch`).
//
// Every game is keyed by `finishedGameKey` (an HMAC of my account and the game under the one shared
// salt): no game or player id, no name, no clock. Territory, bonus and map ids are the map's own,
// public data. 0600 files in 0700 folders, atomic writes under the in-process path lock; a file that
// exists but does not parse (not JSON, not an object, another version, a malformed total) is never
// overwritten (`failed`). Off with `WARAPP_PLAYER_PROFILE=off` (the end-of-game pass does not run).
// Profiles and lessons INFORM ONLY (P1): no planner decision reads any of this, save the winners' curves
// (#419, owner decision of 2026-11-20: `mapPaceAt` / `formatPaceAt`, thin evidence's upper bound).
import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { GAME_KINDS, type FinishedOutcome, type GameKind } from './analysis/finished-game.js';
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
const kindsOf = (v: unknown): GameKind[] | undefined =>
  Array.isArray(v) && v.every((k) => GAME_KINDS.includes(k as GameKind)) ? (v as GameKind[]) : undefined;

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

// ---- #437: games counted apart ----

/** Excluded games' keys kept per store (the newest), so a game is never counted apart twice. */
export const MAX_EXCLUDED_KEYS = 500;

export type ExcludedKind = 'lottery' | 'no-show';

/**
 * Lottery and no-show games (#437, `EXCLUDED_KINDS`): kept out of the games, outcomes and entries, counted
 * here instead. `keys` (game keys with their kind, oldest first) make the counts idempotent; a key dropped
 * past {@link MAX_EXCLUDED_KEYS} stays counted.
 */
export interface ExcludedGames {
  lottery: number;
  noShow: number;
  keys: { key: string; kind: ExcludedKind }[];
}

const isExcludedKey = (k: unknown): k is { key: string; kind: ExcludedKind } =>
  isRec(k) && typeof k.key === 'string' && HASH.test(k.key) && (k.kind === 'lottery' || k.kind === 'no-show');

/** The excluded block as stored: absent → `null`; malformed → `undefined`. */
function excludedOf(v: unknown): ExcludedGames | null | undefined {
  if (v === undefined) return null;
  if (!isRec(v) || !isInt(v.lottery) || !isInt(v.noShow) || !Array.isArray(v.keys) || !v.keys.every(isExcludedKey)) return undefined;
  return { lottery: v.lottery, noShow: v.noShow, keys: v.keys.map((k) => ({ key: k.key, kind: k.kind })) };
}

const bump = (e: ExcludedGames, kind: ExcludedKind, by: number): Pick<ExcludedGames, 'lottery' | 'noShow'> => ({
  lottery: e.lottery + (kind === 'lottery' ? by : 0),
  noShow: e.noShow + (kind === 'no-show' ? by : 0),
});

/** `ex` with `key` counted apart as `kind` (a key there under another kind moves; the same: unchanged). */
function withExcluded(ex: ExcludedGames | undefined, key: string, kind: ExcludedKind): ExcludedGames {
  const e = withoutExcluded(ex, key, kind) ?? { lottery: 0, noShow: 0, keys: [] };
  if (e.keys.some((k) => k.key === key)) return e;
  return { ...bump(e, kind, 1), keys: [...e.keys, { key, kind }].slice(-MAX_EXCLUDED_KEYS) };
}

/** `ex` without `key` (a game counted apart before, now counted otherwise), unless it is kept as `keep`. */
function withoutExcluded(ex: ExcludedGames | undefined, key: string, keep?: ExcludedKind): ExcludedGames | undefined {
  const old = ex?.keys.find((k) => k.key === key);
  if (!ex || !old || old.kind === keep) return ex;
  return { ...bump(ex, old.kind, -1), keys: ex.keys.filter((k) => k.key !== key) };
}

/** The counts a summary shows (absent when nothing was counted apart). */
const excludedCounts = (ex: ExcludedGames | undefined) => (ex && (ex.lottery || ex.noShow) ? { excluded: { lottery: ex.lottery, noShow: ex.noShow } } : {});

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
  /** #437: the game's kinds (`gameKinds`; never a lottery or no-show: those are counted apart). */
  kinds?: GameKind[];
  /** #437: the game's settings key (`settingsKey`, `null` without settings) and the flags the views filter on. */
  settings?: MapEntrySettings;
}

/** #437: a map entry's settings: the name-free settings key and the flags its pace depends on. */
export interface MapEntrySettings {
  key: string | null;
  localDeployments?: boolean;
  commanders?: boolean;
}

export interface MapRecord {
  version: 1;
  mapId: number;
  /** Games ever kept for the map (its entries are bounded). */
  games: number;
  /** My results over those games. */
  outcomes: Record<string, number>;
  entries: MapEntry[];
  /** #437: lottery and no-show games, counted apart (never in `games`, `outcomes` or `entries`). */
  excluded?: ExcludedGames;
}

const SETTINGS_KEY = /^sha256:[0-9a-f]{16}$/;

/** A map entry's settings as stored; `undefined` when malformed. */
function entrySettingsOf(v: unknown): MapEntrySettings | undefined {
  if (!isRec(v) || !(v.key === null || (typeof v.key === 'string' && SETTINGS_KEY.test(v.key)))) return undefined;
  if ((v.localDeployments !== undefined && typeof v.localDeployments !== 'boolean') || (v.commanders !== undefined && typeof v.commanders !== 'boolean')) return undefined;
  return {
    key: v.key,
    ...(typeof v.localDeployments === 'boolean' ? { localDeployments: v.localDeployments } : {}),
    ...(typeof v.commanders === 'boolean' ? { commanders: v.commanders } : {}),
  };
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
    // #419: the winner's curve, absent on entries kept before it.
    if (w.income !== undefined && !(Array.isArray(w.income) && w.income.every(intOrNull))) return undefined;
    winners.push({ ...r, ...(w.income !== undefined ? { income: w.income as (number | null)[] } : {}), income4: w.income4, income8: w.income8 });
  }
  const kinds = kindsOf(v.kinds);
  const settings = entrySettingsOf(v.settings);
  // An additive field that does not read leaves the entry out, as any malformed field does.
  if ((v.kinds !== undefined && !kinds) || (v.settings !== undefined && !settings)) return undefined;
  return {
    key: v.key,
    format: v.format,
    seats: v.seats,
    result: v.result,
    turns: v.turns,
    me: { ...mine, income: m.income as (number | null)[], income4: m.income4, income8: m.income8 },
    winners,
    ...(kinds ? { kinds } : {}),
    ...(settings ? { settings } : {}),
  };
}

/** The record of `mapId`: an empty one when missing, `unreadable` when it cannot be parsed. Never throws. */
export async function readMapRecord(dir: string, mapId: number): Promise<MapRecord | 'unreadable'> {
  try {
    const v = await readStore(mapRecordPath(dir, mapId));
    if (v === 'unreadable') return v;
    if (v === 'missing') return { version: 1, mapId, games: 0, outcomes: {}, entries: [] };
    const outcomes = countsOf(v.outcomes);
    const excluded = excludedOf(v.excluded);
    if (v.version !== 1 || v.mapId !== mapId || !isInt(v.games) || !outcomes || excluded === undefined) return 'unreadable';
    const entries = (Array.isArray(v.entries) ? v.entries : []).map(mapEntryOf).filter((e): e is MapEntry => e !== undefined);
    return { version: 1, mapId, games: v.games, outcomes, entries, ...(excluded ? { excluded } : {}) };
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
      // #437: a game counted apart before is counted as a game now.
      const excluded = withoutExcluded(rec.excluded, entry.key);
      await writeJsonAtomic(path, mapRecordDir(dir), { ...rec, ...(excluded ? { excluded } : {}) });
      return 'kept' as const;
    });
    if (r === 'kept') await pruneMapRecords(dir, keep, path).catch(() => undefined);
    return r;
  } catch {
    return 'failed';
  }
}

/**
 * #419: give a game's winners kept before #419 their income curves, from the history its end-of-game record kept
 * (`curves`: each winner's start territories and curve). A winner is matched by its start territories, or, with
 * one winner and one curve, as that one; a winner with a curve keeps it. `filled` when one was added, `unchanged`
 * when none could be, `missing` without the record or the game, `failed` on an unreadable record (never
 * overwritten) or a failed write. Never throws.
 */
export async function fillWinnerCurves(
  dir: string,
  mapId: number,
  key: string,
  curves: readonly { territories: readonly number[]; income: (number | null)[] }[],
): Promise<'filled' | 'unchanged' | 'missing' | 'failed'> {
  const path = mapRecordPath(dir, mapId);
  const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && [...a].sort((x, y) => x - y).every((x, i) => x === [...b].sort((p, q) => p - q)[i]);
  try {
    return await withPathLock(path, async () => {
      const rec = await readMapRecord(dir, mapId);
      if (rec === 'unreadable') return 'failed' as const;
      const e = rec.entries.find((x) => x.key === key);
      if (!e) return 'missing' as const;
      let filled = false;
      e.winners = e.winners.map((w) => {
        if (w.income) return w;
        const c = curves.find((x) => same(x.territories, w.territories)) ?? (e.winners.length === 1 && curves.length === 1 ? curves[0] : undefined);
        if (!c) return w;
        filled = true;
        return { territories: w.territories, bonuses: w.bonuses, income: c.income, income4: w.income4, income8: w.income8 };
      });
      if (!filled) return 'unchanged' as const;
      await writeJsonAtomic(path, mapRecordDir(dir), rec);
      return 'filled' as const;
    });
  } catch {
    return 'failed';
  }
}

/**
 * #437: count a lottery or no-show game apart in its map's record: never in its games, outcomes or entries
 * (a game counted there before is taken back out), once per game. `excluded`, or `failed` (an unreadable
 * record is never overwritten; a failed write). Never throws.
 */
export async function recordMapExcluded(dir: string, mapId: number, key: string, kind: ExcludedKind, keep = MAX_MAP_RECORDS): Promise<'excluded' | 'failed'> {
  const path = mapRecordPath(dir, mapId);
  try {
    const r = await withPathLock(path, async () => {
      const rec = await readMapRecord(dir, mapId);
      if (rec === 'unreadable') return 'failed' as const;
      const old = rec.entries.find((e) => e.key === key);
      if (old) {
        bumpCount(rec.outcomes, old.result, -1);
        rec.games = Math.max(0, rec.games - 1);
        rec.entries = rec.entries.filter((e) => e.key !== key);
      }
      await writeJsonAtomic(path, mapRecordDir(dir), { ...rec, excluded: withExcluded(rec.excluded, key, kind) });
      return 'excluded' as const;
    });
    if (r === 'excluded') await pruneMapRecords(dir, keep, path).catch(() => undefined);
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

/**
 * #437: which of a map's games a view reads: the current game's format, and its Local Deployment and
 * Commanders settings when given. An entry that kept no such flag (kept before #437) matches on it.
 */
export interface MapMatch {
  format?: ProfileFormat;
  localDeployments?: boolean | undefined;
  commanders?: boolean | undefined;
}

/** The match without its unset fields. */
const matchBy = (m: MapMatch): MapMatch => ({
  ...(m.format !== undefined ? { format: m.format } : {}),
  ...(m.localDeployments !== undefined ? { localDeployments: m.localDeployments } : {}),
  ...(m.commanders !== undefined ? { commanders: m.commanders } : {}),
});

/** The entries `match` reads, and how many matched only because a flag was not kept. Pure. */
export function matchedEntries(rec: MapRecord, match?: MapMatch): { entries: MapEntry[]; settingsUnknown: number } {
  if (!match) return { entries: rec.entries, settingsUnknown: 0 };
  const m = matchBy(match);
  let settingsUnknown = 0;
  const entries = rec.entries.filter((e) => {
    if (m.format !== undefined && e.format !== m.format) return false;
    let unknown = false;
    for (const flag of ['localDeployments', 'commanders'] as const) {
      if (m[flag] === undefined) continue;
      const kept = e.settings?.[flag];
      if (kept === undefined) unknown = true;
      else if (kept !== m[flag]) return false;
    }
    if (unknown) settingsUnknown++;
    return true;
  });
  return { entries, settingsUnknown };
}

/** The outcomes of `entries`. */
function outcomesOf(entries: readonly MapEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) bumpCount(out, e.result, 1);
  return out;
}

/**
 * What a map's record says in short: games, my results, and the winners' pace beside mine (medians over the
 * kept games). With `match` (#437), only the games of the current game's format (and settings): their games,
 * results and pace, and `matched` says how many of the kept entries matched. `excluded`: lottery and no-show
 * games counted apart. Pure.
 */
export function mapRecordSummary(
  rec: MapRecord,
  match?: MapMatch,
): {
  games: number;
  outcomes: Record<string, number>;
  pace: { winners: { income4: number | null; income8: number | null }; mine: { income4: number | null; income8: number | null } };
  matched?: { by: MapMatch; entries: number; of: number; settingsUnknown: number };
  excluded?: { lottery: number; noShow: number };
} {
  const of = (xs: (number | null)[]) => median(xs.filter((x): x is number => x !== null));
  const { entries, settingsUnknown } = matchedEntries(rec, match);
  const winners = entries.flatMap((e) => e.winners);
  return {
    games: match ? entries.length : rec.games,
    outcomes: match ? outcomesOf(entries) : rec.outcomes,
    pace: {
      winners: { income4: of(winners.map((w) => w.income4)), income8: of(winners.map((w) => w.income8)) },
      mine: { income4: of(entries.map((e) => e.me.income4)), income8: of(entries.map((e) => e.me.income8)) },
    },
    ...(match ? { matched: { by: matchBy(match), entries: entries.length, of: rec.entries.length, settingsUnknown } } : {}),
    ...excludedCounts(rec.excluded),
  };
}

// ---- #419: the fog prior's pace ----

/**
 * #419 (owner decision of 2026-11-20): the past games a pace needs. With fewer on this map (of this format and
 * settings) the pace is the format's, relative to my income; with fewer there too, none.
 */
export const MIN_PACE_GAMES = 3;

/** A game's winner income after `afterTurn` completed turns: the highest of its winners' (`null` when none was kept). */
function winnerAt(e: MapEntry, afterTurn: number): number | null {
  let best: number | null = null;
  for (const w of e.winners) {
    const x = w.income?.[afterTurn];
    if (typeof x === 'number' && (best === null || x > best)) best = x;
  }
  return best;
}

/**
 * #419: the median past winner's income after `afterTurn` completed turns on this map (rounded up), over the
 * games `match` reads (#437), one figure a game (its highest winner); `null` with fewer than
 * {@link MIN_PACE_GAMES} games that kept one. Pure.
 */
export function mapPaceAt(rec: MapRecord, afterTurn: number, match?: MapMatch): { income: number; games: number } | null {
  const xs = matchedEntries(rec, match).entries.flatMap((e) => {
    const w = winnerAt(e, afterTurn);
    return w === null ? [] : [w];
  });
  if (xs.length < MIN_PACE_GAMES) return null;
  return { income: Math.ceil(median(xs)! - 1e-9), games: xs.length };
}

/**
 * #419: the relative per-format pace: the median, over every map's games `match` reads, of the winner's income ÷
 * mine after `afterTurn` completed turns (a game where I earned nothing then, or either figure is missing, left
 * out), rounded to 2 places; `null` with fewer than {@link MIN_PACE_GAMES} games. Pure.
 */
export function formatPaceAt(recs: readonly MapRecord[], afterTurn: number, match?: MapMatch): { ratio: number; games: number } | null {
  const xs: number[] = [];
  for (const rec of recs)
    for (const e of matchedEntries(rec, match).entries) {
      const w = winnerAt(e, afterTurn);
      const m = e.me.income[afterTurn];
      if (w !== null && typeof m === 'number' && m > 0) xs.push(w / m);
    }
  if (xs.length < MIN_PACE_GAMES) return null;
  return { ratio: Math.round(median(xs)! * 100) / 100, games: xs.length };
}

/** Every map record kept (unreadable ones left out), by map id. Never throws. */
export async function readMapRecords(dir: string): Promise<MapRecord[]> {
  const out: MapRecord[] = [];
  let names: string[];
  try {
    names = await readdir(mapRecordDir(dir));
  } catch {
    return out;
  }
  const ids = names.filter((n) => /^\d+\.json$/.test(n)).map((n) => Number(n.slice(0, -5))).sort((a, b) => a - b);
  for (const id of ids) {
    const r = await readMapRecord(dir, id);
    if (r !== 'unreadable') out.push(r);
  }
  return out;
}

/** My results per bonus my start touched, and how often each bonus held a winner's start (#312 E3), most games first then by id. Pure. */
export function mapRecordStarts(
  rec: MapRecord,
  match?: MapMatch,
): {
  mine: { bonusId: number; games: number; outcomes: Record<string, number> }[];
  winners: { bonusId: number; games: number }[];
} {
  const mine = new Map<number, { games: number; outcomes: Record<string, number> }>();
  const winners = new Map<number, number>();
  for (const e of matchedEntries(rec, match).entries) {
    for (const b of e.me.bonuses) {
      const x = mine.get(b) ?? { games: 0, outcomes: {} };
      x.games++;
      bumpCount(x.outcomes, e.result, 1);
      mine.set(b, x);
    }
    // A bonus counts once per game, however many winners started in it.
    for (const b of new Set(e.winners.flatMap((w) => w.bonuses))) winners.set(b, (winners.get(b) ?? 0) + 1);
  }
  const order = (a: { bonusId: number; games: number }, b: { bonusId: number; games: number }) => b.games - a.games || a.bonusId - b.bonusId;
  return {
    mine: [...mine].map(([bonusId, x]) => ({ bonusId, ...x })).sort(order),
    winners: [...winners].map(([bonusId, games]) => ({ bonusId, games })).sort(order),
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
  /** #437: the game's kinds (`gameKinds`; never a lottery or no-show: those are counted apart). */
  kinds?: GameKind[];
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
  /** #437: lottery and no-show games, counted apart (never in a total or an entry). */
  excluded?: ExcludedGames;
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
  const kinds = kindsOf(v.kinds);
  if (loss === undefined || !calibration || (v.kinds !== undefined && !kinds)) return undefined;
  return { key: v.key, format: v.format, seats: v.seats, result: v.result, flatAfterTurn: v.flatAfterTurn, howLost: loss, calibration, ...(kinds ? { kinds } : {}) };
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
    const excluded = excludedOf(v.excluded);
    if (v.version !== 1 || !isRec(v.byFormat) || excluded === undefined) return 'unreadable';
    const byFormat: LessonsFile['byFormat'] = {};
    for (const [k, t] of Object.entries(v.byFormat)) {
      const totals = totalsOf(t);
      if (!isFormat(k) || !totals) return 'unreadable';
      byFormat[k] = totals;
    }
    const entries = (Array.isArray(v.entries) ? v.entries : []).map(lessonEntryOf).filter((e): e is LessonEntry => e !== undefined);
    return { version: 1, byFormat, entries, ...(excluded ? { excluded } : {}) };
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
      // #437: a game counted apart before is counted as a game now.
      const excluded = withoutExcluded(file.excluded, entry.key);
      await writeJsonAtomic(path, dir, { ...file, ...(excluded ? { excluded } : {}) });
      return 'kept' as const;
    });
  } catch {
    return 'failed';
  }
}

/**
 * #437: count a lottery or no-show game apart: never in a format's totals or the entries (a game counted
 * there before has its share taken back), once per game. `excluded`, or `failed` (an unreadable store is
 * never overwritten; a failed write). Never throws.
 */
export async function recordLessonsExcluded(dir: string, key: string, kind: ExcludedKind): Promise<'excluded' | 'failed'> {
  const path = lessonsPath(dir);
  try {
    return await withPathLock(path, async () => {
      const file = await readLessons(dir);
      if (file === 'unreadable') return 'failed' as const;
      const old = file.entries.find((e) => e.key === key);
      if (old) {
        const t = file.byFormat[old.format];
        if (t) {
          applyEntry(t, old, -1);
          if (t.games <= 0) delete file.byFormat[old.format];
        }
        file.entries = file.entries.filter((e) => e.key !== key);
      }
      await writeJsonAtomic(path, dir, { ...file, excluded: withExcluded(file.excluded, key, kind) });
      return 'excluded' as const;
    });
  } catch {
    return 'failed';
  }
}

// ---- the read-only views (#312 E3) ----

/** One coverage band's estimates against the truth, as read: the count, the mean and geometric mean of estimate ÷ truth, and the shares under half and over 1.5×. */
export interface RatioSummary {
  n: number;
  mean: number;
  geoMean: number;
  low: number;
  high: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** A calibration's bands summarized ({@link RatioSummary}); a band with no sample is left out. Pure. */
export function calibrationSummary(c: Calibration): Partial<Record<(typeof COVERAGE_BUCKETS)[number], RatioSummary>> {
  const out: Partial<Record<(typeof COVERAGE_BUCKETS)[number], RatioSummary>> = {};
  for (const k of COVERAGE_BUCKETS) {
    const x = c[k];
    if (!x || x.n <= 0) continue;
    out[k] = { n: x.n, mean: r2(x.sum / x.n), geoMean: r2(Math.exp(x.logSum / x.n)), low: r2(x.under / x.n), high: r2(x.over / x.n) };
  }
  return out;
}

/** The lessons of one format, as read. */
export interface LessonsFormatSummary {
  games: number;
  outcomes: Record<string, number>;
  howLost: Record<string, number>;
  /** The games whose income went flat and the mean completed turns when it did; `null` when none did. */
  flatAfterTurn: { games: number; mean: number } | null;
  calibration: ReturnType<typeof calibrationSummary>;
}

/** The lessons store summarized (#312 E3): per format, and the calibration of every format together. Aggregates only. Pure. */
export function lessonsSummary(file: LessonsFile): {
  games: number;
  byFormat: Partial<Record<ProfileFormat, LessonsFormatSummary>>;
  calibration: ReturnType<typeof calibrationSummary>;
  /** #437: lottery and no-show games counted apart (in no figure above). */
  excluded?: { lottery: number; noShow: number };
} {
  const byFormat: Partial<Record<ProfileFormat, LessonsFormatSummary>> = {};
  let games = 0;
  let all: Calibration = {};
  for (const f of PROFILE_FORMATS) {
    const t = file.byFormat[f];
    if (!t || t.games <= 0) continue;
    games += t.games;
    all = addCalibration(all, t.calibration);
    byFormat[f] = {
      games: t.games,
      outcomes: t.outcomes,
      howLost: t.howLost,
      flatAfterTurn: t.flat.n > 0 ? { games: t.flat.n, mean: r2(t.flat.sum / t.flat.n) } : null,
      calibration: calibrationSummary(t.calibration),
    };
  }
  return { games, byFormat, calibration: calibrationSummary(all), ...excludedCounts(file.excluded) };
}

/**
 * #436: the outlook's calibration — per coverage band, past games' tracked income ÷ the true income
 * (geometric mean and samples): this format's band when it has `min` samples or more, else every format's
 * band together; a band with fewer than `min` either way is left out. Pure.
 */
export function outlookCalibration(
  file: LessonsFile,
  format: ProfileFormat,
  min: number,
  opts: { ownOnly?: boolean } = {},
): Partial<Record<(typeof COVERAGE_BUCKETS)[number], { geoMean: number; n: number }>> {
  let all: Calibration = {};
  for (const f of PROFILE_FORMATS) {
    const t = file.byFormat[f];
    if (t && t.games > 0) all = addCalibration(all, t.calibration);
  }
  const own = file.byFormat[format]?.calibration ?? {};
  const out: Partial<Record<(typeof COVERAGE_BUCKETS)[number], { geoMean: number; n: number }>> = {};
  for (const k of COVERAGE_BUCKETS) {
    const x = (own[k]?.n ?? 0) >= min ? own[k]! : opts.ownOnly ? undefined : all[k];
    if (!x || x.n < min) continue;
    out[k] = { geoMean: r2(Math.exp(x.logSum / x.n)), n: x.n };
  }
  return out;
}
