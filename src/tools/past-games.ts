// What my own finished games say, read back for the tools (#312 E3): the per-map record (games, my
// results by start region, the winners' pace after turns 4 and 8) and the lessons (how games were
// lost, when my income went flat, and the tracker's estimates scored against the true incomes by
// format and coverage band). Read-only: nothing here writes, requests or throws. Off with
// `WARAPP_PLAYER_PROFILE=off` and without a data directory. Profiles and lessons INFORM ONLY (owner
// decision P1): the views go beside a plan's output, never into a planner input.
import type { EnvSource } from '@chrischall/mcp-utils';
import { PACE_TURNS, startRegion } from '../analysis/game-lessons.js';
import type { MapGraph } from '../analysis/graph.js';
import type { ProfileFormat } from '../analysis/opponent-profile.js';
import { lessonsSummary, mapRecordStarts, mapRecordSummary, readLessons, readMapRecord, type MapRecord } from '../lessons-store.js';
import { profileEnabled } from '../profile-store.js';

/** The note every view carries: where it comes from, and that no plan reads it. */
export const PAST_GAMES_NOTE =
  'From your own finished games (their histories, read once at the end of each game): reported only — no plan, ranking or estimate reads it.';

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
 * in, and the pace (medians of the winners' and my income after turns 4 and 8). Pure.
 */
export function mapRecordView(
  rec: MapRecord,
  o: { bonusName: (id: number) => BonusRef; full: boolean; graph?: MapGraph; picks?: readonly number[] },
) {
  const { mine, winners } = mapRecordStarts(rec);
  const summary = mapRecordSummary(rec);
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
    note: PAST_GAMES_NOTE,
  };
}

/**
 * The pace beside my income on the boards after turns 4 and 8 (warapp_plan_turn): with `turnsCompleted`
 * one of {@link PACE_TURNS} and a record with a figure for it, my income now beside the median winner's
 * and my own past median there; `undefined` otherwise. Pure.
 */
export function paceView(rec: MapRecord, turnsCompleted: number | null, myIncome: number) {
  if (turnsCompleted === null || !(PACE_TURNS as readonly number[]).includes(turnsCompleted)) return undefined;
  const s = mapRecordSummary(rec);
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
      readAs:
        'calibration: per coverage band (the share of its frontier the track read, #294), n turns × opponents scored, the mean and geometric mean of ' +
        'the tracked income ÷ the true income from the history, and the shares read under half (low) and over 1.5× (high).',
      note: PAST_GAMES_NOTE,
    };
  } catch {
    return undefined;
  }
}
