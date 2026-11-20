// #419: map-record entries kept before #419 hold no winner income curve, so they count for no fog pace. The end-of-game
// records (src/finished-store.ts) keep each captured game's history boards (the first and last 30), from which the
// winners' curves are read again here: no request, this server's state only. Run by warapp_backfill_history. Name-free
// like the stores: a record's players are labelled by position (`anonymousHistoryOfRecord`), winners matched to the
// map entry by their start territories. Never throws.
import { basename } from 'node:path';
import { curvePoints, type IncomeCurve } from '../analysis/game-lessons.js';
import { turnIncomes } from '../analysis/finished-game.js';
import { applyBonusOverrides } from '../analysis/overrides.js';
import { anonymousHistoryOfRecord, listFinishedRecords, readFinishedRecord } from '../finished-store.js';
import { fillWinnerCurves, readMapRecord } from '../lessons-store.js';
import { readStoredMap } from '../map-store.js';
import { normalizeSettings } from '../normalize.js';
import { graphOf } from './common.js';

export interface WinnerCurveBackfill {
  /** Map entries given their winners' curves. */
  filled: number;
  /** Entries that needed one and could not get it (no history boards, map, settings or matching winner). */
  unfilled: number;
}

/** Fill the winners' curves of every map-record entry kept without them, from the end-of-game records. Never throws. */
export async function backfillWinnerCurves(dataDir: string): Promise<WinnerCurveBackfill> {
  const out: WinnerCurveBackfill = { filled: 0, unfilled: 0 };
  let paths: string[];
  try {
    paths = await listFinishedRecords(dataDir);
  } catch {
    return out;
  }
  for (const path of paths) {
    try {
      const rec = await readFinishedRecord(path);
      if (typeof rec === 'string' || rec.status !== 'captured') continue;
      const settings = rec.settings ? normalizeSettings(rec.settings) : undefined;
      const mapId = rec.mapId ?? settings?.mapId;
      if (mapId === undefined) continue;
      const key = basename(path, '.json');
      const mr = await readMapRecord(dataDir, mapId);
      const entry = mr === 'unreadable' ? undefined : mr.entries.find((e) => e.key === key);
      if (!entry || entry.winners.every((w) => w.income)) continue;
      const h = anonymousHistoryOfRecord(rec);
      const map = await readStoredMap(dataDir, mapId, { maxAgeMs: Number.POSITIVE_INFINITY });
      if (typeof h === 'string' || !map || !settings) {
        out.unfilled++;
        continue;
      }
      const graph = graphOf(applyBonusOverrides(map, settings));
      const winners = h.players.filter((p) => p.state === 'Won').map((p) => p.id);
      const boards = [...h.boards].sort((a, b) => a.turn - b.turn);
      const ids = h.players.map((p) => p.id);
      const curves = new Map<number, IncomeCurve>(winners.map((w) => [w, []]));
      for (const b of boards) {
        const inc = turnIncomes(graph, b.board, ids, settings);
        for (const w of winners) {
          const x = inc.get(w);
          if (x) curves.get(w)!.push({ afterTurn: b.turn, income: x.income });
        }
      }
      const start = boards[0];
      const startOf = (w: number) =>
        start && start.turn === 0
          ? start.board.territories.flatMap((t) => (t.owner.kind === 'player' && t.owner.playerId === w ? [t.territoryId] : []))
          : [];
      const r = await fillWinnerCurves(
        dataDir,
        mapId,
        key,
        winners.map((w) => ({ territories: startOf(w), income: curvePoints(curves.get(w)!) })),
      );
      if (r === 'filled') out.filled++;
      else if (r !== 'missing') out.unfilled++;
    } catch {
      out.unfilled++;
    }
  }
  return out;
}
