// What my own finished games say, read back for the tools (#312 E3): the per-map record (games, my
// results by start region, the winners' pace after turns 4 and 8) and the lessons (how games were
// lost, when my income went flat, and the tracker's estimates scored against the true incomes by
// format and coverage band). Read-only: nothing here writes, requests or throws. Off with
// `WARAPP_PLAYER_PROFILE=off` and without a data directory. Profiles and lessons INFORM ONLY (owner
// decision P1): the views go beside a plan's output, never into a planner input — save #419's fog pace
// (`fogPaceFor`, owner decision of 2026-11-20): the past winners' income tops thin evidence's estimate range —
// and #436's outlook calibration (`outlookCalibrationFor`): the tracker's estimate ÷ truth per coverage band
// turns the outlook's income estimates into calibrated ones (the outlook's income lean and surrender line only).
import type { EnvSource } from '@chrischall/mcp-utils';
import { PACE_TURNS, startRegion } from '../analysis/game-lessons.js';
import type { MapGraph } from '../analysis/graph.js';
import type { ProfileFormat } from '../analysis/opponent-profile.js';
import type { FogPace } from '../analysis/plan/shared.js';
import { MIN_CALIBRATION_SAMPLES, type OutlookCalibration } from '../analysis/outlook.js';
import {
  formatPaceAt,
  lessonsSummary,
  outlookCalibration,
  mapPaceAt,
  mapRecordStarts,
  mapRecordSummary,
  readLessons,
  readMapRecord,
  readMapRecords,
  type MapMatch,
  type MapRecord,
} from '../lessons-store.js';
import { profileEnabled } from '../profile-store.js';

/** The note every view carries: where it comes from, and that no plan reads it. */
export const PAST_GAMES_NOTE =
  "From your own finished games (their histories, read once at the end of each game): reported only — no plan or ranking reads it; only the past winners' income per turn tops a thinly read opponent's estimate (#419).";

/** #437: the note beside games counted apart. */
export const EXCLUDED_NOTE = 'Lottery and no-show games are counted apart: they are in no figure here.';

/** #437: the note beside a record read for the current game's format and settings. */
export const MATCHED_NOTE =
  "Only the games of this game's format (and Local Deployment / Commanders setting) are read: `entries` of the `of` kept matched; `settingsUnknown` of them were kept before the setting was.";

/** The `matched` and `excluded` parts a view carries (#437). */
function matchParts(s: ReturnType<typeof mapRecordSummary>) {
  return {
    ...(s.matched ? { matched: { ...s.matched, note: MATCHED_NOTE } } : {}),
    ...(s.excluded ? { excluded: { ...s.excluded, note: EXCLUDED_NOTE } } : {}),
  };
}

/** #437: the map-record match of a game: its format, Local Deployment and Commanders. */
export function mapMatchOf(format: ProfileFormat, settings: { localDeployments?: boolean | undefined; commanders?: boolean | undefined } | undefined): MapMatch {
  return {
    format,
    ...(settings?.localDeployments !== undefined ? { localDeployments: settings.localDeployments } : {}),
    ...(settings?.commanders !== undefined ? { commanders: settings.commanders } : {}),
  };
}

/** Start bonuses listed on the compact views. */
export const MAP_RECORD_COMPACT = 8;

/** The record of `mapId` when it holds a game; `unreadable` when it cannot be parsed; `undefined` otherwise (off, no data dir, no map, none kept). Never throws. */
export async function mapRecordFor(dataDir: string | undefined, env: EnvSource | undefined, mapId: number | undefined): Promise<MapRecord | 'unreadable' | undefined> {
  if (!dataDir || mapId === undefined || !profileEnabled(env ?? process.env)) return undefined;
  try {
    const rec = await readMapRecord(dataDir, mapId);
    return rec === 'unreadable' || rec.games > 0 ? rec : undefined;
  } catch {
    return undefined;
  }
}

type BonusRef = { id: number; name: string };

/**
 * The map record as warapp_plan_picks and warapp_map_stats show it: games, my results, my results per
 * bonus my start touched (`inPrimary` when the given picks touch it too), the bonuses winners started
 * in, and the pace (medians of the winners' and my income after turns 4 and 8). With `match` (#437: the
 * current game's format and settings) only the games that match, and `matched` says how many; `excluded`
 * counts the lottery and no-show games kept apart. Pure.
 */
export function mapRecordView(
  rec: MapRecord,
  o: { bonusName: (id: number) => BonusRef; full: boolean; graph?: MapGraph; picks?: readonly number[]; match?: MapMatch },
) {
  const { mine, winners } = mapRecordStarts(rec, o.match);
  const summary = mapRecordSummary(rec, o.match);
  const primary = o.graph && o.picks ? new Set(startRegion(o.graph, o.picks).bonuses) : undefined;
  const cap = <T>(xs: T[]) => (o.full ? xs : xs.slice(0, MAP_RECORD_COMPACT));
  return {
    games: summary.games,
    outcomes: summary.outcomes,
    myStarts: cap(mine).map((m) => ({ bonus: o.bonusName(m.bonusId), games: m.games, outcomes: m.outcomes, ...(primary ? { inPrimary: primary.has(m.bonusId) } : {}) })),
    winnerStarts: cap(winners).map((w) => ({ bonus: o.bonusName(w.bonusId), games: w.games })),
    pace: Object.fromEntries(
      PACE_TURNS.map((t) => [
        `afterTurn${t}`,
        { winners: t === 4 ? summary.pace.winners.income4 : summary.pace.winners.income8, mine: t === 4 ? summary.pace.mine.income4 : summary.pace.mine.income8 },
      ]),
    ),
    ...(!o.full && (mine.length > MAP_RECORD_COMPACT || winners.length > MAP_RECORD_COMPACT) ? { more: 'view "full" lists every start bonus' } : {}),
    ...matchParts(summary),
    note: PAST_GAMES_NOTE,
  };
}

/**
 * The pace beside my income on the boards after turns 4 and 8 (warapp_plan_turn): with `turnsCompleted`
 * one of {@link PACE_TURNS} and a record with a figure for it, my income now beside the median winner's
 * and my own past median there; `undefined` otherwise. With `match` (#437) only the games of the current
 * game's format and settings. Pure.
 */
export function paceView(rec: MapRecord, turnsCompleted: number | null, myIncome: number, match?: MapMatch) {
  if (turnsCompleted === null || !(PACE_TURNS as readonly number[]).includes(turnsCompleted)) return undefined;
  const s = mapRecordSummary(rec, match);
  const four = turnsCompleted === 4;
  const winners = four ? s.pace.winners.income4 : s.pace.winners.income8;
  const myPast = four ? s.pace.mine.income4 : s.pace.mine.income8;
  if (winners === null && myPast === null) return undefined;
  return {
    afterTurn: turnsCompleted,
    mine: myIncome,
    winners,
    myPast,
    games: s.games,
    ...(winners !== null ? { behindWinners: myIncome < winners } : {}),
    ...matchParts(s),
    note: PAST_GAMES_NOTE,
  };
}

/**
 * The lessons summarized (warapp_track_opponents full): per format the games, results, how the lost ones
 * were lost, the mean turn my income went flat, and the tracker's estimate ÷ the true income by coverage
 * band; `thisFormat` names the game's. `unreadable` when the store cannot be parsed; `undefined` when
 * off, without a data dir, or with no game kept. Never throws.
 */
export async function pastGamesFor(dataDir: string | undefined, env: EnvSource | undefined, format: ProfileFormat) {
  if (!dataDir || !profileEnabled(env ?? process.env)) return undefined;
  try {
    const file = await readLessons(dataDir);
    if (file === 'unreadable') return 'unreadable' as const;
    const s = lessonsSummary(file);
    if (s.games <= 0) return undefined;
    return {
      thisFormat: format,
      ...s,
      ...(s.excluded ? { excluded: { ...s.excluded, note: EXCLUDED_NOTE } } : {}),
      readAs:
        'calibration: per coverage band (the share of its frontier the track read, #294), n turns × opponents scored, the mean and geometric mean of ' +
        'the tracked income ÷ the true income from the history, and the shares read under half (low) and over 1.5× (high).',
      note: PAST_GAMES_NOTE,
    };
  } catch {
    return undefined;
  }
}

/**
 * #419 (owner decision of 2026-11-20): the pace past winners set after `afterTurn` completed turns (the turn
 * planned − 1), the fog prior's upper bound under thin evidence: this map's median winner over its games `match`
 * reads when there are `MIN_PACE_GAMES` (3) or more (`map`), else the median winner ÷ mine over every map's
 * games of the format (`format`), else `undefined` — as with profiling off, no data dir, map or turn. Never throws.
 */
export async function fogPaceFor(
  dataDir: string | undefined,
  env: EnvSource | undefined,
  mapId: number | undefined,
  match: MapMatch,
  afterTurn: number | null,
): Promise<FogPace | undefined> {
  if (!dataDir || mapId === undefined || afterTurn === null || afterTurn < 0 || !profileEnabled(env ?? process.env)) return undefined;
  try {
    const rec = await readMapRecord(dataDir, mapId);
    const own = rec === 'unreadable' ? null : mapPaceAt(rec, afterTurn, match);
    if (own) return { basis: 'map', afterTurn, games: own.games, income: own.income };
    const fmt = formatPaceAt(await readMapRecords(dataDir), afterTurn, match);
    return fmt ? { basis: 'format', afterTurn, games: fmt.games, ratio: fmt.ratio } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * #436 (owner decision of 2026-11-20): the outlook's calibration — past games' tracked income ÷ true income per
 * coverage band, this format's band with `MIN_CALIBRATION_SAMPLES` or more, else every format's
 * (`outlookCalibration`); `undefined` when off, without a data dir, unreadable or with no band. Never throws.
 */
export async function outlookCalibrationFor(dataDir: string | undefined, env: EnvSource | undefined, format: ProfileFormat): Promise<OutlookCalibration | undefined> {
  if (!dataDir || !profileEnabled(env ?? process.env)) return undefined;
  try {
    const file = await readLessons(dataDir);
    if (file === 'unreadable') return undefined;
    const c = outlookCalibration(file, format, MIN_CALIBRATION_SAMPLES);
    return Object.keys(c).length ? c : undefined;
  } catch {
    return undefined;
  }
}
