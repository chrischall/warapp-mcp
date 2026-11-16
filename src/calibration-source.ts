// What the calibration harness (#318, scripts/calibrate.mjs) scores, read from the data directory alone:
// the end-of-game records (src/finished-store.ts), each the one history read its game had (P2). No
// request is ever made here. A record is matched to its game's settings record (src/replay.ts) when that
// is still kept: the ids put back by matching keys (`historyOfRecord`), the stored map, and my cached
// boards and orders, which the calibration (a) needs. A record whose settings record aged out (the
// newest 200 kept, 60 days) is read on its own: its own settings shape, the stored map by its map id,
// the players labelled by position (`anonymousHistoryOfRecord`, a key is never reversed) and no cached
// boards (they are found by game id, which the record does not hold), so it feeds the opening
// benchmark (b) only. What could not be scored is counted by reason; the harness prints it. Never throws.
import type { GameMap, GameSettings } from './normalize.js';
import { normalizeSettings } from './normalize.js';
import { anonymousHistoryOfRecord, finishedPath, historyOfRecord, listFinishedRecords, readFinishedRecord, type RecordHistory } from './finished-store.js';
import { readStoredMap } from './map-store.js';
import type { TurnBoard } from './analysis/opponents.js';
import { playerRecordSalt } from './player-record-store.js';
import { gamesDir, loadReplay } from './replay.js';
import { readdir } from 'node:fs/promises';

/** One finished game to score. */
export interface CalibrationInput {
  /** `settings-record`: matched to the game's settings record; `record-only`: read on its own. */
  source: 'settings-record' | 'record-only';
  history: RecordHistory;
  settings: GameSettings;
  /** The stored map (base values; the settings' overrides are applied by the caller). */
  map: GameMap;
  /** My cached boards with the orders this server sent (none for `record-only`). */
  cached: TurnBoard[];
}

/** Why a captured record was not scored. */
export type SkipReason = 'no-settings' | 'no-map' | 'captured-without-boards';

export interface CalibrationSources {
  inputs: CalibrationInput[];
  /** Records by status (`unreadable` included), plus `missing`: settings records with no record yet. */
  statuses: Record<string, number>;
  /** Captured records left out, by reason. */
  skipped: Partial<Record<SkipReason, number>>;
}

const count = (o: Record<string, number>, k: string) => {
  o[k] = (o[k] ?? 0) + 1;
};

async function settingsRecordIds(dir: string): Promise<number[]> {
  const names = await readdir(gamesDir(dir)).catch(() => [] as string[]);
  return names
    .filter((n) => /^\d+\.json$/.test(n))
    .map((n) => Number(n.slice(0, -5)))
    .sort((a, b) => a - b);
}

/** Every finished game the data directory can score, and what it cannot. Never throws. */
export async function calibrationSources(dir: string): Promise<CalibrationSources> {
  const out: CalibrationSources = { inputs: [], statuses: {}, skipped: {} };
  const salt = await playerRecordSalt(dir).catch(() => undefined);
  // The settings records by the record path they would match.
  const byPath = new Map<string, NonNullable<Awaited<ReturnType<typeof loadReplay>>>>();
  for (const id of await settingsRecordIds(dir)) {
    const replay = await loadReplay(dir, id);
    if (!salt || !replay || replay.playerId === undefined) {
      count(out.statuses, 'missing');
      continue;
    }
    byPath.set(finishedPath(dir, salt, replay.playerId, id), replay);
  }
  const paths = salt ? await listFinishedRecords(dir) : [];
  const seen = new Set<string>();
  for (const path of paths) {
    seen.add(path);
    const rec = await readFinishedRecord(path);
    if (typeof rec === 'string') {
      count(out.statuses, rec);
      continue;
    }
    count(out.statuses, rec.status);
    if (rec.status !== 'captured') continue;
    const replay = byPath.get(path);
    const matched = replay ? historyOfRecord(rec, salt!, [replay.playerId!, ...replay.game.players.map((p) => p.id)]) : undefined;
    const history = matched && typeof matched === 'object' ? matched : anonymousHistoryOfRecord(rec);
    if (typeof history === 'string') {
      count(out.skipped, 'captured-without-boards');
      continue;
    }
    const fromReplay = matched !== undefined && typeof matched === 'object';
    const settings = fromReplay ? replay!.settings : rec.settings ? normalizeSettings(rec.settings) : undefined;
    if (!settings) {
      count(out.skipped, 'no-settings');
      continue;
    }
    const mapId = rec.mapId ?? settings.mapId;
    const map = (fromReplay ? replay!.map : undefined) ?? (mapId !== undefined ? await readStoredMap(dir, mapId, { maxAgeMs: Number.POSITIVE_INFINITY }) : undefined);
    if (!map) {
      count(out.skipped, 'no-map');
      continue;
    }
    const cached: TurnBoard[] =
      fromReplay && replay!.playerId === history.me
        ? replay!.boards.map((b) => {
            const o = replay!.orders.get(b.turn);
            return { turn: b.turn, board: b.board, ...(o ? { orders: o } : {}) };
          })
        : [];
    out.inputs.push({ source: fromReplay ? 'settings-record' : 'record-only', history, settings, map, cached });
  }
  // A settings record whose game has no record: its pass has not run (or the record was pruned).
  for (const path of byPath.keys()) if (!seen.has(path)) count(out.statuses, 'missing');
  return out;
}
