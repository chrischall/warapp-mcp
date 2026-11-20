// The review export (#437 task 5, `scripts/review-export.mjs`, a LOCAL dev script: never a tool, never in
// CI). A strategy review reads one file per game instead of reconstructing it from six stores: this joins,
// for each game, what this server kept of it — the decision log (#412, with #437's per-turn additions, its
// events, seats, join context, opponents and picks phase), the end-of-game record (src/finished-store.ts:
// outcome, kinds, the history's truth), the game's entry in its map's record and in the lessons
// (src/lessons-store.ts, by `finishedGameKey`), the settings record (src/replay.ts: state, turns, seats by
// id) and the stored map's name and size — plus an `index.json` of every game with which sources exist.
//
// Name-free: every store it reads is (player ids, the map's own names, HMAC keys); the settings record's
// player names are never read back (`readGameRecord` puts the id in their place) and only ids are written.
// The decision log's encoded boards and the planner's replay `input` are left out (`hasInput` says whether
// a turn kept one: `scripts/replay-decisions.mjs` replays those); `boards: true` adds each logged turn's
// board rebuilt whole (`boardAt`). It makes no request and writes nothing to the data dir. The export is
// 0600 files in a 0700 folder; an existing folder others can read is refused, never chmod-ed.
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { GameKind } from './analysis/finished-game.js';
import { profileFormatOf, type ProfileFormat } from './analysis/opponent-profile.js';
import type { BoardState } from './board.js';
import {
  boardAt,
  decisionLogPath,
  decisionsDir,
  readDecisionLog,
  type DecisionEntry,
  type DecisionLog,
} from './decision-log.js';
import { finishedPath, readFinishedRecord, type FinishedRecord } from './finished-store.js';
import {
  lessonsPath,
  mapRecordPath,
  readLessons,
  readMapRecord,
  type ExcludedKind,
  type LessonEntry,
  type MapEntry,
} from './lessons-store.js';
import { readStoredMap } from './map-store.js';
import type { Game } from './normalize.js';
import { finishedGameKey, playerRecordSalt } from './player-record-store.js';
import { gameRecordPath, gamesDir, readGameRecord } from './replay.js';
import { readCachedPlayer } from './trend.js';

/** Whether a source was found: `excluded` for a lottery or no-show game counted apart from the store. */
export type SourceState = 'present' | 'missing' | 'unreadable' | 'excluded';

export interface ReviewSources {
  decisionLog: Exclude<SourceState, 'excluded'>;
  finished: Exclude<SourceState, 'excluded'>;
  settingsRecord: 'present' | 'missing';
  map: 'present' | 'missing';
  mapRecord: SourceState;
  lessons: SourceState;
}

/** A logged turn as exported: the entry without its encoded board and replay input. */
export type ReviewTurn = Omit<DecisionEntry, 'board' | 'input'> & {
  /** The planner's replay input was kept (compaction drops it on unremarkable turns). */
  hasInput: boolean;
  /** With `boards`: the board seen, rebuilt whole; `null` when its delta chain is broken. */
  board?: BoardState | null;
};

/** One game, joined. */
export interface ReviewGame {
  version: 1;
  gameId: number;
  /** My account in the game: the log's, else the board cache's, else the seat the finished record is keyed by. */
  playerId: number | null;
  /** The finished record's kinds; `null` for a game with no record (still running, or never processed). */
  kinds: GameKind[] | null;
  format: ProfileFormat | null;
  map: { id: number; name?: string; territories?: number } | null;
  outcome: FinishedRecord['outcome'] | null;
  /** Completed turns: the finished record's, else the settings record's, else the newest logged turn. */
  turns: number | null;
  /** The settings record's game, by id only. */
  game: { state: string; numberOfTurns?: number; players: { id: number; team?: number; state?: string; ai?: true }[] } | null;
  decisionLog: {
    status: DecisionLog['status'];
    turns: Record<string, ReviewTurn>;
    accuracySummary?: DecisionLog['accuracySummary'];
    truthMissing?: number[];
  } | null;
  events: NonNullable<DecisionLog['events']> | null;
  eventsDropped?: number;
  seats: DecisionLog['seats'] | null;
  join: DecisionLog['join'] | null;
  opponents: DecisionLog['opponents'] | null;
  picks: DecisionLog['picks'] | null;
  finished: FinishedRecord | null;
  mapRecord: { entry: MapEntry | null; excluded?: ExcludedKind } | null;
  lessons: { entry: LessonEntry | null; excluded?: ExcludedKind } | null;
  sources: ReviewSources;
}

/** One line of `index.json`. */
export interface ReviewIndexEntry {
  gameId: number;
  kinds: GameKind[] | null;
  format: ProfileFormat | null;
  mapId: number | null;
  mapName: string | null;
  outcome: string | null;
  turns: number | null;
  sources: ReviewSources;
}

export interface ReviewOptions {
  /** Rebuild every logged turn's board. */
  boards?: boolean;
}

const idsIn = async (folder: string): Promise<number[]> =>
  (await readdir(folder).catch(() => [] as string[])).filter((n) => /^\d{1,12}\.json$/.test(n)).map((n) => Number(n.slice(0, -5)));

/** Every game with a decision log (readable or not) or a settings record, ascending. Never throws. */
export async function reviewGameIds(dir: string): Promise<number[]> {
  const ids = new Set([...(await idsIn(decisionsDir(dir))), ...(await idsIn(gamesDir(dir)))]);
  return [...ids].sort((a, b) => a - b);
}

function reviewTurns(log: DecisionLog, boards: boolean): Record<string, ReviewTurn> {
  const out: Record<string, ReviewTurn> = {};
  for (const [k, e] of Object.entries(log.turns)) {
    const { board, input, ...rest } = e;
    const t: ReviewTurn = { ...rest, hasInput: input !== undefined };
    if (boards && board) t.board = boardAt(log, Number(k)) ?? null;
    out[k] = t;
  }
  return out;
}

const gameOf = (g: Game): NonNullable<ReviewGame['game']> => ({
  state: g.state,
  ...(g.numberOfTurns !== undefined ? { numberOfTurns: g.numberOfTurns } : {}),
  players: g.players.map((p) => ({
    id: p.id,
    ...(p.team !== undefined ? { team: p.team } : {}),
    ...(p.state !== undefined ? { state: p.state } : {}),
    ...(p.isAI ? { ai: true as const } : {}),
  })),
});

const newestTurn = (log: DecisionLog): number | null => {
  const ks = Object.keys(log.turns).filter((k) => /^\d+$/.test(k)).map(Number);
  return ks.length ? Math.max(...ks) : null;
};

/**
 * The finished record for `gameId`: tried as `me` when known, else as each seat of the settings record
 * (a legacy game keeps no log or board cache naming my account; the record's name is an HMAC, so only a
 * seat id can match it). Never throws.
 */
async function findFinished(
  dir: string,
  salt: string | undefined,
  gameId: number,
  me: number | undefined,
  game: Game | undefined,
): Promise<{ me?: number; record: FinishedRecord | 'missing' | 'unreadable' }> {
  if (!salt) return { record: 'missing' };
  const candidates = me !== undefined ? [me] : (game?.players.map((p) => p.id) ?? []);
  for (const id of candidates) {
    const r = await readFinishedRecord(finishedPath(dir, salt, id, gameId));
    if (r !== 'missing') return { me: id, record: r };
  }
  return { record: 'missing' };
}

/** What a store keyed by `finishedGameKey` holds for the game: its entry, or that it was counted apart. */
function keyedEntry<E extends { key: string }>(
  path: string,
  store: { entries: E[]; excluded?: { keys: { key: string; kind: ExcludedKind }[] } } | 'unreadable',
  key: string | undefined,
): { state: SourceState; value: { entry: E | null; excluded?: ExcludedKind } | null } {
  if (store === 'unreadable') return { state: 'unreadable', value: null };
  if (!key || !existsSync(path)) return { state: 'missing', value: null };
  const entry = store.entries.find((e) => e.key === key);
  if (entry) return { state: 'present', value: { entry } };
  const apart = store.excluded?.keys.find((k) => k.key === key);
  if (apart) return { state: 'excluded', value: { entry: null, excluded: apart.kind } };
  return { state: 'missing', value: null };
}

/** One game joined from the data dir; `undefined` when it has neither a decision log nor a settings record. Never throws. */
export async function reviewGame(dir: string, gameId: number, opts: ReviewOptions = {}): Promise<ReviewGame | undefined> {
  const logExists = existsSync(decisionLogPath(dir, gameId));
  const log = logExists ? await readDecisionLog(dir, gameId) : undefined;
  const game = await readGameRecord(dir, gameId);
  if (!logExists && !game && !existsSync(gameRecordPath(dir, gameId))) return undefined;
  const salt = await playerRecordSalt(dir).catch(() => undefined);
  const cached = log?.playerId ?? (await readCachedPlayer(dir, gameId));
  const found = await findFinished(dir, salt, gameId, cached, game);
  const me = cached ?? found.me;
  const finished = typeof found.record === 'object' ? found.record : null;

  const mapId = finished?.mapId ?? game?.settings?.mapId;
  const stored = mapId !== undefined ? await readStoredMap(dir, mapId, { maxAgeMs: Number.POSITIVE_INFINITY }) : undefined;
  const key = salt && me !== undefined ? finishedGameKey(salt, me, gameId) : undefined;
  const mapRecord =
    mapId !== undefined ? keyedEntry(mapRecordPath(dir, mapId), await readMapRecord(dir, mapId), key) : { state: 'missing' as const, value: null };
  const lessons = keyedEntry(lessonsPath(dir), await readLessons(dir), key);

  const format = finished?.format ?? log?.join?.flags.format ?? (game?.players.length ? profileFormatOf(game.players) : null);
  return {
    version: 1,
    gameId,
    playerId: me ?? null,
    kinds: finished?.kinds ?? null,
    format,
    map: mapId !== undefined ? { id: mapId, ...(stored ? { name: stored.name, territories: stored.territories.length } : {}) } : null,
    outcome: finished?.outcome ?? null,
    turns: finished?.outcome?.turn ?? game?.numberOfTurns ?? (log ? newestTurn(log) : null),
    game: game ? gameOf(game) : null,
    decisionLog: log
      ? {
          status: log.status,
          turns: reviewTurns(log, opts.boards === true),
          ...(log.accuracySummary ? { accuracySummary: log.accuracySummary } : {}),
          ...(log.truthMissing ? { truthMissing: log.truthMissing } : {}),
        }
      : null,
    events: log?.events ?? null,
    ...(log?.eventsDropped ? { eventsDropped: log.eventsDropped } : {}),
    seats: log?.seats ?? null,
    join: log?.join ?? null,
    opponents: log?.opponents ?? null,
    picks: log?.picks ?? null,
    finished,
    mapRecord: mapRecord.value,
    lessons: lessons.value,
    sources: {
      decisionLog: log ? 'present' : logExists ? 'unreadable' : 'missing',
      finished: found.record === 'unreadable' ? 'unreadable' : finished ? 'present' : 'missing',
      settingsRecord: game ? 'present' : 'missing',
      map: stored ? 'present' : 'missing',
      mapRecord: mapRecord.state,
      lessons: lessons.state,
    },
  };
}

const indexEntry = (g: ReviewGame): ReviewIndexEntry => ({
  gameId: g.gameId,
  kinds: g.kinds,
  format: g.format,
  mapId: g.map?.id ?? null,
  mapName: g.map?.name ?? null,
  outcome: g.outcome?.result ?? null,
  turns: g.turns,
  sources: g.sources,
});

/** The export folder: made 0700, or an existing one only when no one else can read it. Throws otherwise. */
async function privateFolder(out: string): Promise<void> {
  const s = await stat(out).catch(() => undefined);
  if (!s) {
    await mkdir(out, { recursive: true, mode: 0o700 });
    // `mode` is masked by the umask: set it outright on the folder made here.
    await chmod(out, 0o700);
    return;
  }
  if (!s.isDirectory()) throw new Error(`${out} is not a directory`);
  if (s.mode & 0o077) throw new Error(`${out} is readable by others: use a new folder or chmod 700 it`);
}

async function writePrivate(path: string, body: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/**
 * Write `game-<id>.json` per game (every game `reviewGameIds` lists, or `game` alone) and `index.json`
 * into `out`. Throws when the folder is not private or `game` has no data.
 */
export async function exportReview(
  dir: string,
  out: string,
  opts: ReviewOptions & { game?: number } = {},
): Promise<{ games: number; out: string }> {
  const ids = opts.game !== undefined ? [opts.game] : await reviewGameIds(dir);
  const games: ReviewGame[] = [];
  for (const id of ids) {
    const g = await reviewGame(dir, id, opts);
    if (g) games.push(g);
  }
  if (opts.game !== undefined && !games.length) throw new Error(`game ${opts.game}: no data (no decision log or settings record)`);
  await privateFolder(out);
  for (const g of games) await writePrivate(join(out, `game-${g.gameId}.json`), g);
  await writePrivate(join(out, 'index.json'), { version: 1, games: games.map(indexEntry) });
  return { games: games.length, out };
}
