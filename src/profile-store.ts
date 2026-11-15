// The in-game opponent profile on disk (docs/PLAN-PROFILES.md A2; owner decision P4 of 2026-11-15:
// on, local and hosted — a hosted child keeps it in its per-user data dir).
//
// `<dataDir>/profiles/games/<gameId>-<myId>.json` (version 1): per turn T, per opponent, what that
// opponent did between my boards of T and T+1 (`TurnPrimitives`, src/analysis/opponent-profile.ts).
// It holds real ids, like the board cache beside it (src/trend.ts), and only gameplay counts: no
// name, no chat, no time of play. Every turn ever observed is kept (the board cache keeps ten);
// observing a turn again overwrites that turn's entry, so planning a turn twice never adds.
//
// Same guarantees as the board cache: 0600 files in a 0700 folder, atomic writes (under the
// in-process path lock), best effort, never throws; an unusable file reads as empty; only the newest
// `MAX_PROFILE_GAME_FILES` game files are kept, and none unwritten for the board cache's age limit
// (`BOARD_CACHE_MAX_AGE_MS`). `WARAPP_PLAYER_PROFILE=off` (or `0` / `false` / `no`): nothing here
// reads or writes.
//
// Across games (B2) two name-free stores sit beside it:
// - `<dataDir>/profiles/players.json` (version 1): per player, keyed by the deal record's
//   `playerKey` under the one shared salt (`playerSaltForWrite`, src/player-record-store.ts), so the
//   two join in memory and neither holds an id: up to `MAX_PROFILE_ENTRIES` per-game entries (each
//   keyed by an HMAC of my account and the game) and the faded totals by format; at most
//   `MAX_PROFILE_PLAYERS` players, the least recently updated dropped first (by a counter, never a
//   clock: no time of play is kept).
// - `<dataDir>/profiles/population.json` (version 1): the totals per format over every human
//   opponent, a pooled `ai` profile, a games count, and one entry per folded game (bounded) so a game
//   folded again replaces its own contribution. It never fades.
// `foldGame` adds a game by the difference between its new entry and the one stored under the same
// key, so folding twice, or a `history` entry replacing a `live` one, never counts twice; a game new
// to a player first fades that player's totals (and every entry's weight) by `PROFILE_DECAY`. AI
// seats go to the pool only; a human who became an AI is left out of the game altogether (no turn of
// the change is known, V4). A finished game is folded by `foldFinishedGame` on the first read that
// shows it finished (warapp_get_game, warapp_wait_for_turn's re-read); its per-game file is then
// marked `folded: 'live'` and kept until the age rule deletes it (part C, which would read the
// game's history first, is not built), and a file reaching that age unfolded is folded with every
// ending `unknown`, then deleted. A store or salt that exists but is not JSON, not an object or not
// version 1 is never overwritten: reads say `unreadable`, folds fail. Inside a version-1 store the
// read is loose, like the board cache's: a malformed player record, entry or total is dropped (an
// `entries` that is not an array reads as none), and the next fold writes the store back without it.
//
// Folding is idempotent only while the game's entry is still stored: `foldGame` finds "this game
// again" among a player's last `MAX_PROFILE_ENTRIES` entries and the population's last
// `MAX_POPULATION_ENTRIES`. A game folded again after its entry was dropped (part C's history
// replacement arriving that late) is faded and counted a second time. Likewise the
// `MAX_PROFILE_GAME_FILES` bound can fold a game still in progress (endings `unknown`) and delete
// its file; if play goes on, `recordBehaviour` starts a new file with the later turns only, and the
// fold at the finish replaces the earlier entry with that shorter one, so the turns before the
// eviction leave the totals. Both are rare today (30 games with one opponent, 200 games in play);
// part C must guard them (a kept tombstone of folded keys, or merging into the stored entry) before
// it relies on refolding.
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readEnvVar, type EnvSource } from '@chrischall/mcp-utils';
import type { MapGraph } from './analysis/graph.js';
import {
  addHabits,
  emptyHabits,
  habitsOf,
  observeTurn,
  PROFILE_DECAY,
  PROFILE_FORMATS,
  profileFormatOf,
  scaleHabits,
  type Habits,
  type ObserveInput,
  type ObservedPrimitives,
  type ProfileFormat,
  type TurnPrimitives,
} from './analysis/opponent-profile.js';
import type { TurnBoard } from './analysis/opponents.js';
import type { Game } from './normalize.js';
import { withPathLock } from './path-lock.js';
import { playerKey, playerRecordSalt, playerRecordSaltPath, playerSaltForWrite, profileGameKey } from './player-record-store.js';
import { holdsSeat } from './player-states.js';
import { isTeamGame, teammatesOf } from './teams.js';
import { BOARD_CACHE_MAX_AGE_MS } from './trend.js';

export const PROFILE_ENV = 'WARAPP_PLAYER_PROFILE';
/** Game files kept: the newest by last write. */
export const MAX_PROFILE_GAME_FILES = 200;

/** Whether opponent profiling is on: yes (local and hosted) unless `WARAPP_PLAYER_PROFILE` is `off`, `0`, `false` or `no`. */
export function profileEnabled(env: EnvSource = process.env): boolean {
  const v = readEnvVar(PROFILE_ENV, { env });
  return v === undefined || !/^(off|0|false|no)$/i.test(v.trim());
}

/**
 * What the profile tool says of its store: `kept` (stored per game), `not-kept` (on, but no data dir to
 * keep it in; the tool passes none while a game's teams are unknown) or `off`.
 */
export function profileState(env: EnvSource, dataDir: string | undefined): 'kept' | 'not-kept' | 'off' {
  if (!profileEnabled(env)) return 'off';
  return dataDir ? 'kept' : 'not-kept';
}

export const profileGamesDir = (dir: string) => join(dir, 'profiles', 'games');
export const profileGamePath = (dir: string, gameId: number, playerId: number) => join(profileGamesDir(dir), `${gameId}-${playerId}.json`);

/** The seats of a game as recorded, for a fold that has no GameFeed read (the age rule). */
export interface ProfileSeats {
  format: ProfileFormat;
  /** Players seated. */
  players: number;
  /** AI seats (pooled, never keyed). */
  ai: number[];
  /** Humans who became an AI (left out of a fold). */
  turnedAI: number[];
}

interface ProfileGameFile {
  version: 1;
  gameId: number;
  playerId: number;
  /** Turn → opponent id → what it did on that turn. */
  turns: Record<string, Record<string, TurnPrimitives>>;
  /** The seats when last recorded. */
  seats?: ProfileSeats;
  /** Folded into the cross-game stores, from what (B2). */
  folded?: 'live' | 'history';
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const ids = (v: unknown): number[] | undefined => (Array.isArray(v) && v.every(isInt) ? [...v] : undefined);

/** One stored record, loosely: `undefined` when unusable. */
function primitivesOf(v: unknown): TurnPrimitives | undefined {
  if (!isRec(v) || typeof v.contact !== 'boolean' || typeof v.iAttacked !== 'boolean') return undefined;
  if (v.attackedMe !== null && typeof v.attackedMe !== 'boolean') return undefined;
  const r = v.reinforce;
  if (!isRec(r) || !isInt(r.n) || !isInt(r.e) || !isInt(r.extra)) return undefined;
  const s = v.stack;
  if (s !== null && !(isRec(s) && isInt(s.top) && isInt(s.total))) return undefined;
  const took = v.tookFromMe === null ? null : ids(v.tookFromMe);
  const lost = ids(v.lostToMe);
  if (took === undefined || !lost) return undefined;
  return {
    contact: v.contact,
    attackedMe: v.attackedMe as boolean | null,
    iAttacked: v.iAttacked,
    reinforce: { n: r.n, e: r.e, extra: r.extra },
    stack: s === null ? null : { top: (s as Rec).top as number, total: (s as Rec).total as number },
    tookFromMe: took,
    lostToMe: lost,
  };
}

const seatsOf = (v: unknown): ProfileSeats | undefined =>
  isRec(v) && PROFILE_FORMATS.includes(v.format as ProfileFormat) && isInt(v.players) && ids(v.ai) && ids(v.turnedAI)
    ? { format: v.format as ProfileFormat, players: v.players, ai: ids(v.ai)!, turnedAI: ids(v.turnedAI)! }
    : undefined;

/** A game file as `playerId` saw it; `turns` empty when absent or unusable. */
async function readGameFile(dir: string, gameId: number, playerId: number): Promise<Omit<ProfileGameFile, 'version' | 'gameId' | 'playerId'>> {
  try {
    const f: unknown = JSON.parse(await readFile(profileGamePath(dir, gameId, playerId), 'utf8'));
    if (!isRec(f) || f.version !== 1 || f.gameId !== gameId || f.playerId !== playerId || !isRec(f.turns)) return { turns: {} };
    const out: Record<string, Record<string, TurnPrimitives>> = {};
    for (const [t, byOpponent] of Object.entries(f.turns)) {
      if (!/^\d+$/.test(t) || !isRec(byOpponent)) continue;
      const kept: Record<string, TurnPrimitives> = {};
      for (const [o, p] of Object.entries(byOpponent)) {
        const v = /^\d+$/.test(o) ? primitivesOf(p) : undefined;
        if (v) kept[o] = v;
      }
      out[t] = kept;
    }
    const seats = seatsOf(f.seats);
    return {
      turns: out,
      ...(seats ? { seats } : {}),
      ...(f.folded === 'live' || f.folded === 'history' ? { folded: f.folded } : {}),
    };
  } catch {
    return { turns: {} };
  }
}

/** The stored turns of a game as `playerId` saw it; `{}` when absent or unusable. */
async function readTurns(dir: string, gameId: number, playerId: number): Promise<Record<string, Record<string, TurnPrimitives>>> {
  return (await readGameFile(dir, gameId, playerId)).turns;
}

/**
 * Every turn stored for `gameId` as `playerId` saw it, by opponent, oldest turn first; an empty map
 * when none, or when profiling is off. Never throws.
 */
export async function readProfileTurns(
  dir: string,
  gameId: number,
  playerId: number,
  env: EnvSource = process.env,
): Promise<Map<number, ObservedPrimitives[]>> {
  const out = new Map<number, ObservedPrimitives[]>();
  if (!profileEnabled(env)) return out;
  const turns = await readTurns(dir, gameId, playerId);
  for (const t of Object.keys(turns).map(Number).sort((a, b) => a - b))
    for (const [o, primitives] of Object.entries(turns[String(t)]!)) {
      const list = out.get(Number(o)) ?? [];
      list.push({ turn: t, primitives });
      out.set(Number(o), list);
    }
  return out;
}

/** What {@link recordBehaviour} observes: the game, my seat, my opponents, and my boards with my orders. */
export interface BehaviourInput {
  gameId: number;
  me: number;
  graph: MapGraph;
  settings: ObserveInput['settings'];
  /** The cards in play by name; absent when the game's settings were not read (any card may be). */
  cards?: readonly string[] | undefined;
  /** My opponents (never me, never a teammate). */
  opponents: readonly number[];
  /** My known teammates: whatever the file holds for them (kept before the teams were known) is dropped. */
  teammates?: readonly number[] | undefined;
  /** My boards of the game, each with my orders on that turn when known (`boardHistory` plus the live board). */
  boards: readonly TurnBoard[];
  /** The game's seats, kept for a fold by the age rule (B2). */
  seats?: ProfileSeats | undefined;
}

/**
 * The turns `input.boards` lets me observe: one entry per pair of boards of consecutive turns T and
 * T+1, the turn T, by opponent. A pair with a board read from GameFeed's `GetHistory` (`source:
 * 'history'`, unverified for a game in progress) is not observed: stored primitives come from the
 * live boards this server cached only (principle 6). Pure.
 */
export function observeBoards(input: BehaviourInput): Map<number, Map<number, TurnPrimitives>> {
  const sorted = [...input.boards].sort((a, b) => a.turn - b.turn);
  const out = new Map<number, Map<number, TurnPrimitives>>();
  for (let i = 0; i + 1 < sorted.length; i++) {
    const was = sorted[i]!;
    const now = sorted[i + 1]!;
    if (now.turn !== was.turn + 1 || was.source === 'history' || now.source === 'history') continue;
    out.set(
      was.turn,
      observeTurn({
        graph: input.graph,
        me: input.me,
        previous: was.board,
        current: now.board,
        orders: was.orders,
        settings: input.settings,
        opponents: input.opponents,
        ...(input.cards !== undefined ? { cards: input.cards } : {}),
      }),
    );
  }
  return out;
}

/**
 * Keep only the newest {@link MAX_PROFILE_GAME_FILES} game files, and none not written for
 * {@link BOARD_CACHE_MAX_AGE_MS} (the board cache's own age rule: no id-bearing file outlives it,
 * B2). Best effort.
 */
async function prune(dir: string, env: EnvSource): Promise<void> {
  try {
    const folder = profileGamesDir(dir);
    const files: { path: string; mtime: number; gameId: number; playerId: number }[] = [];
    for (const name of await readdir(folder)) {
      const m = /^(\d+)-(\d+)\.json$/.exec(name);
      if (!m) continue;
      const path = join(folder, name);
      try {
        files.push({ path, mtime: (await stat(path)).mtimeMs, gameId: Number(m[1]), playerId: Number(m[2]) });
      } catch {
        // Gone already.
      }
    }
    files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    const cutoff = Date.now() - BOARD_CACHE_MAX_AGE_MS;
    for (const [i, f] of files.entries()) {
      if (i < MAX_PROFILE_GAME_FILES && f.mtime >= cutoff) continue;
      // An unfolded game going out: folded first, every ending unknown (B2), when its seats were kept.
      await withPathLock(f.path, async () => {
        const file = await readGameFile(dir, f.gameId, f.playerId);
        if (!file.folded && file.seats) await foldFile(dir, f.gameId, f.playerId, file, file.seats, () => 'unknown', env);
        await unlink(f.path).catch(() => undefined);
      }).catch(() => undefined);
    }
  } catch {
    // No folder yet.
  }
}

/**
 * Observe every consecutive pair of `input.boards` and store each turn's record, overwriting that
 * turn's entry (planning a turn twice rewrites, never adds); turns not observed this time stay.
 * Every entry for one of `input.teammates` is dropped. Writes nothing when profiling is off, or when
 * nothing could be observed and no teammate's entry was there. Never throws; `false` when nothing
 * was written.
 */
export async function recordBehaviour(dir: string, input: BehaviourInput, env: EnvSource = process.env): Promise<boolean> {
  if (!profileEnabled(env)) return false;
  try {
    const observed = observeBoards(input);
    const friends = new Set((input.teammates ?? []).map(String));
    if (!observed.size && !friends.size) return false;
    const path = profileGamePath(dir, input.gameId, input.me);
    const written = await withPathLock(path, async () => {
      const stored = await readGameFile(dir, input.gameId, input.me);
      const turns = stored.turns;
      // Never keep a teammate: an entry written while the teams were unknown goes now.
      let dropped = false;
      for (const entry of Object.values(turns))
        for (const o of Object.keys(entry))
          if (friends.has(o)) {
            delete entry[o];
            dropped = true;
          }
      if (!observed.size && !dropped) return false;
      for (const [t, byOpponent] of observed) {
        const entry: Record<string, TurnPrimitives> = {};
        for (const [o, p] of [...byOpponent].sort(([a], [b]) => a - b)) if (!friends.has(String(o))) entry[String(o)] = p;
        turns[String(t)] = entry;
      }
      const seats = input.seats ?? stored.seats;
      const body: ProfileGameFile = {
        version: 1,
        gameId: input.gameId,
        playerId: input.me,
        turns,
        ...(seats ? { seats } : {}),
        ...(stored.folded ? { folded: stored.folded } : {}),
      };
      await writeGameFile(path, body);
      return true;
    });
    if (written) await prune(dir, env);
    return written;
  } catch {
    return false;
  }
}

async function writeGameFile(path: string, body: ProfileGameFile): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
  await rename(tmp, path);
}

// ---- across games (B2) ----

export { PROFILE_DECAY };
/** Per-game entries kept per player (the oldest dropped first; their counts stay in the totals). */
export const MAX_PROFILE_ENTRIES = 30;
/** Players kept (the least recently updated dropped first). */
export const MAX_PROFILE_PLAYERS = 1000;
/** Per-game entries the population keeps, so a game folded again replaces its own contribution. */
export const MAX_POPULATION_ENTRIES = 500;

export const profilePlayersPath = (dir: string) => join(dir, 'profiles', 'players.json');
export const profilePopulationPath = (dir: string) => join(dir, 'profiles', 'population.json');
/** One lock for both stores: a fold changes them together. */
const storeLock = (dir: string) => join(dir, 'profiles', '.store');

const ENDINGS = ['Won', 'SurrenderAccepted', 'Booted', 'Eliminated', 'EndedByVote'] as const;
export type ProfileEnding = (typeof ENDINGS)[number] | 'unknown';

/** A player's final state as a profile ending (`PLAYER_STATE_NAMES`, src/player-states.ts): anything else is `unknown`. */
export function endingOf(state: string | undefined): ProfileEnding {
  return (ENDINGS as readonly string[]).includes(state ?? '') ? (state as ProfileEnding) : 'unknown';
}

/** One opponent's seat in a game being folded. */
export interface FoldSeat {
  id: number;
  /** An AI seat: pooled, never keyed. */
  ai: boolean;
  habits: Habits;
  ending: ProfileEnding;
}
export interface FoldInput {
  /** My account (part of the game's key only). */
  me: number;
  gameId: number;
  format: ProfileFormat;
  /** Players seated. */
  players: number;
  /** `live`: from my boards; `history`: from the finished game's history (part C), which replaces a live entry. */
  source: 'live' | 'history';
  /** My opponents (never me, a teammate, or a human who became an AI). */
  seats: readonly FoldSeat[];
}

interface ProfileEntry {
  /** HMAC of my account and the game: no game id. */
  key: string;
  format: ProfileFormat;
  players: number;
  turnsSeen: number;
  source: 'live' | 'history';
  habits: Habits;
  ending?: ProfileEnding;
  /** What its counts weigh in the totals now: 1, × `PROFILE_DECAY` for every game folded after it. */
  weight: number;
}
interface StoredProfile {
  /** When it last changed, as the file's counter (no clock). */
  seq: number;
  /** Games folded for it, every one (its entries are bounded). */
  games: number;
  totals: Partial<Record<ProfileFormat, Habits>>;
  entries: ProfileEntry[];
}
interface PlayersFile {
  version: 1;
  seq: number;
  players: Record<string, StoredProfile>;
}
interface PopulationEntry {
  key: string;
  format: ProfileFormat;
  source: 'live' | 'history';
  humans: Habits;
  ai: Habits;
}
interface PopulationFile {
  version: 1;
  games: number;
  totals: Partial<Record<ProfileFormat, Habits>>;
  ai: Habits;
  entries: PopulationEntry[];
}

const HASH = /^[0-9a-f]{32}$/;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const rateOf = (v: unknown) => (isRec(v) && num(v.e) && num(v.n) ? { e: v.e, n: v.n } : undefined);

/** Stored counts, loosely: `undefined` when any is missing. */
function habitsFrom(v: unknown): Habits | undefined {
  if (!isRec(v)) return undefined;
  const r = rateOf(v.reinforce);
  const a = rateOf(v.attack);
  const f = rateOf(v.firstStrike);
  const rt = rateOf(v.retaliate);
  const rk = rateOf(v.retake);
  const x = v.reinforceExtra;
  const s = v.stacking;
  if (!r || !a || !f || !rt || !rk || !num(v.turns)) return undefined;
  if (!isRec(x) || !num(x.n) || !num(x.sum) || !isRec(s) || !num(s.n) || !num(s.sum) || !num(s.sq)) return undefined;
  return { reinforce: r, reinforceExtra: { n: x.n, sum: x.sum }, attack: a, firstStrike: f, stacking: { n: s.n, sum: s.sum, sq: s.sq }, retaliate: rt, retake: rk, turns: v.turns };
}

function totalsFrom(v: unknown): Partial<Record<ProfileFormat, Habits>> {
  const out: Partial<Record<ProfileFormat, Habits>> = {};
  if (!isRec(v)) return out;
  for (const f of PROFILE_FORMATS) {
    const h = habitsFrom(v[f]);
    if (h) out[f] = h;
  }
  return out;
}

const isFormat = (v: unknown): v is ProfileFormat => PROFILE_FORMATS.includes(v as ProfileFormat);

function entryFrom(v: unknown): ProfileEntry | undefined {
  if (!isRec(v) || typeof v.key !== 'string' || !HASH.test(v.key) || !isFormat(v.format) || !isInt(v.players) || !isInt(v.turnsSeen)) return undefined;
  if ((v.source !== 'live' && v.source !== 'history') || !num(v.weight)) return undefined;
  const habits = habitsFrom(v.habits);
  if (!habits) return undefined;
  const ending = v.ending === 'unknown' || (ENDINGS as readonly unknown[]).includes(v.ending) ? (v.ending as ProfileEnding) : undefined;
  return { key: v.key, format: v.format, players: v.players, turnsSeen: v.turnsSeen, source: v.source, habits, ...(ending ? { ending } : {}), weight: v.weight };
}

/**
 * Read a store: `missing` (empty), the parsed object, or `unreadable` (exists, not JSON or not an
 * object). Callers refuse a wrong version as `unreadable` and read the rest loosely: a malformed part
 * is dropped, never a reason to refuse the store.
 */
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

async function readPlayers(dir: string): Promise<PlayersFile | 'unreadable'> {
  const v = await readStore(profilePlayersPath(dir));
  if (v === 'unreadable') return v;
  if (v === 'missing') return { version: 1, seq: 0, players: {} };
  if (v.version !== 1 || !isRec(v.players)) return 'unreadable';
  const players: Record<string, StoredProfile> = {};
  for (const [k, p] of Object.entries(v.players)) {
    if (!HASH.test(k) || !isRec(p) || !isInt(p.seq) || !isInt(p.games) || !Array.isArray(p.entries)) continue;
    players[k] = { seq: p.seq, games: p.games, totals: totalsFrom(p.totals), entries: p.entries.map(entryFrom).filter((e): e is ProfileEntry => e !== undefined) };
  }
  return { version: 1, seq: isInt(v.seq) ? v.seq : 0, players };
}

async function readPopulation(dir: string): Promise<PopulationFile | 'unreadable'> {
  const v = await readStore(profilePopulationPath(dir));
  if (v === 'unreadable') return v;
  if (v === 'missing') return { version: 1, games: 0, totals: {}, ai: emptyHabits(), entries: [] };
  if (v.version !== 1) return 'unreadable';
  const entries: PopulationEntry[] = [];
  for (const e of Array.isArray(v.entries) ? v.entries : []) {
    if (!isRec(e) || typeof e.key !== 'string' || !HASH.test(e.key) || !isFormat(e.format)) continue;
    if (e.source !== 'live' && e.source !== 'history') continue;
    const humans = habitsFrom(e.humans);
    const ai = habitsFrom(e.ai);
    if (humans && ai) entries.push({ key: e.key, format: e.format, source: e.source, humans, ai });
  }
  return { version: 1, games: isInt(v.games) ? v.games : 0, totals: totalsFrom(v.totals), ai: habitsFrom(v.ai) ?? emptyHabits(), entries };
}

async function writeStore(path: string, body: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
  await rename(tmp, path);
}

const sumOf = (list: readonly Habits[]) => list.reduce((a, h) => addHabits(a, h), emptyHabits());
const sumTotals = (t: Partial<Record<ProfileFormat, Habits>>) => sumOf(PROFILE_FORMATS.flatMap((f) => (t[f] ? [t[f]] : [])));
const bump = (t: Partial<Record<ProfileFormat, Habits>>, f: ProfileFormat, h: Habits, scale: number) => {
  t[f] = addHabits(t[f] ?? emptyHabits(), h, scale);
};

/**
 * Fold one game into the cross-game stores (B2): each human seat's entry under its player key,
 * the totals moved by the difference from the entry already stored for this game (zero the first
 * time), a player's totals faded once when the game is new to it; AI seats into the AI pool only. A
 * `live` entry never replaces a `history` one. `folded` when written; `off` when profiling is off;
 * `failed` when it could not be (a store or salt that is not JSON, not an object or not version 1 is
 * never overwritten; malformed parts inside a version-1 store are dropped on read, so they are not
 * written back). Idempotent only while this game's entry is still stored (see the file header). Never
 * throws.
 */
export async function foldGame(dir: string, input: FoldInput, env: EnvSource = process.env): Promise<'folded' | 'off' | 'failed'> {
  if (!profileEnabled(env)) return 'off';
  try {
    return await withPathLock(storeLock(dir), async () => {
      const players = await readPlayers(dir);
      const population = await readPopulation(dir);
      if (players === 'unreadable' || population === 'unreadable') return 'failed';
      const salt = await playerSaltForWrite(dir);
      if (!salt) return 'failed';
      const key = profileGameKey(salt, input.me, input.gameId);
      const seats = [...input.seats].sort((a, b) => a.id - b.id);

      // Each human seat, under its player key.
      for (const seat of seats) {
        if (seat.ai) continue;
        const pk = playerKey(salt, seat.id);
        const p: StoredProfile = players.players[pk] ?? { seq: 0, games: 0, totals: {}, entries: [] };
        const old = p.entries.find((e) => e.key === key);
        if (old?.source === 'history' && input.source === 'live') continue;
        if (!old) {
          // A game new to this player: everything before it fades once.
          for (const f of PROFILE_FORMATS) if (p.totals[f]) p.totals[f] = scaleHabits(p.totals[f]!, PROFILE_DECAY);
          for (const e of p.entries) e.weight = Math.round(e.weight * PROFILE_DECAY * 1e9) / 1e9;
          p.games++;
        }
        const weight = old?.weight ?? 1;
        if (old) bump(p.totals, old.format, old.habits, -old.weight);
        bump(p.totals, input.format, seat.habits, weight);
        const entry: ProfileEntry = {
          key,
          format: input.format,
          players: input.players,
          turnsSeen: seat.habits.turns,
          source: input.source,
          habits: seat.habits,
          ending: seat.ending,
          weight,
        };
        p.entries = [...p.entries.filter((e) => e.key !== key), entry].slice(-MAX_PROFILE_ENTRIES);
        p.seq = ++players.seq;
        players.players[pk] = p;
      }

      // The population: humans by format, AIs pooled; replaced as a whole for a game folded again.
      const humans = sumOf(seats.filter((s) => !s.ai).map((s) => s.habits));
      const ai = sumOf(seats.filter((s) => s.ai).map((s) => s.habits));
      const old = population.entries.find((e) => e.key === key);
      if (!(old?.source === 'history' && input.source === 'live')) {
        if (old) {
          bump(population.totals, old.format, old.humans, -1);
          population.ai = addHabits(population.ai, old.ai, -1);
        } else population.games++;
        bump(population.totals, input.format, humans, 1);
        population.ai = addHabits(population.ai, ai, 1);
        population.entries = [...population.entries.filter((e) => e.key !== key), { key, format: input.format, source: input.source, humans, ai }].slice(-MAX_POPULATION_ENTRIES);
      }
      for (const f of PROFILE_FORMATS) if (population.totals[f] && isEmpty(population.totals[f]!)) delete population.totals[f];

      // Bound the players: the least recently updated go first.
      const keys = Object.keys(players.players)
        .sort((a, b) => players.players[b]!.seq - players.players[a]!.seq || (a < b ? -1 : 1))
        .slice(0, MAX_PROFILE_PLAYERS)
        .sort();
      await writeStore(profilePlayersPath(dir), { version: 1, seq: players.seq, players: Object.fromEntries(keys.map((k) => [k, players.players[k]!])) });
      await writeStore(profilePopulationPath(dir), population);
      return 'folded';
    });
  } catch {
    return 'failed';
  }
}

const isEmpty = (h: Habits) => JSON.stringify(h) === JSON.stringify(emptyHabits());

/** What the cross-game stores say for the players asked about. */
export interface ProfileHistory {
  /** Per player on record: games met (this game left out) and its faded totals over every format (this game's contribution left out). */
  players: Map<number, { games: number; past: Habits }>;
  pools: {
    byFormat: Partial<Record<ProfileFormat, Habits>>;
    /** Every format together. */
    all: Habits;
    ai: Habits;
    /** Games folded. */
    games: number;
  };
}

/**
 * The cross-game record for `ids`, with `game` (when given: my account and the game being read) left
 * out of each player's past and its games count. Empty when nothing is on record (a read never makes
 * the salt); `unreadable` when a store or the salt cannot be parsed; `off` when profiling is off.
 * Never throws, never writes.
 */
export async function readProfileHistory(
  dir: string,
  ids: readonly number[],
  game: { me?: number; gameId?: number },
  env: EnvSource = process.env,
): Promise<ProfileHistory | 'unreadable' | 'off'> {
  if (!profileEnabled(env)) return 'off';
  try {
    const players = await readPlayers(dir);
    const population = await readPopulation(dir);
    if (players === 'unreadable' || population === 'unreadable') return 'unreadable';
    const pools = { byFormat: population.totals, all: sumTotals(population.totals), ai: population.ai, games: population.games };
    const out: ProfileHistory = { players: new Map(), pools };
    const saltText = await readFile(playerRecordSaltPath(dir), 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : ''));
    if (saltText === null) return out;
    const salt = await playerRecordSalt(dir);
    if (!salt) return 'unreadable';
    const thisGame = game.me !== undefined && game.gameId !== undefined ? profileGameKey(salt, game.me, game.gameId) : undefined;
    for (const id of ids) {
      const p = players.players[playerKey(salt, id)];
      if (!p) continue;
      const own = thisGame ? p.entries.find((e) => e.key === thisGame) : undefined;
      let past = sumTotals(p.totals);
      if (own) past = addHabits(past, own.habits, -own.weight);
      const games = p.games - (own ? 1 : 0);
      if (games > 0 || !isEmpty(past)) out.players.set(id, { games, past });
    }
    return out;
  } catch {
    return 'unreadable';
  }
}

/** Fold one stored game file. Marks nothing. */
async function foldFile(
  dir: string,
  gameId: number,
  me: number,
  file: { turns: Record<string, Record<string, TurnPrimitives>> },
  seats: ProfileSeats,
  ending: (id: number) => ProfileEnding,
  env: EnvSource,
): Promise<'folded' | 'off' | 'failed'> {
  const byOpponent = new Map<number, ObservedPrimitives[]>();
  for (const t of Object.keys(file.turns).map(Number).sort((a, b) => a - b))
    for (const [o, primitives] of Object.entries(file.turns[String(t)]!)) {
      const list = byOpponent.get(Number(o)) ?? [];
      list.push({ turn: t, primitives });
      byOpponent.set(Number(o), list);
    }
  const turned = new Set(seats.turnedAI);
  const ai = new Set(seats.ai);
  const out: FoldSeat[] = [];
  for (const [id, turns] of [...byOpponent].sort(([a], [b]) => a - b)) {
    if (id === me || turned.has(id)) continue;
    out.push({ id, ai: ai.has(id), habits: habitsOf(turns), ending: ending(id) });
  }
  if (!out.length) return 'folded';
  return foldGame(dir, { me, gameId, format: seats.format, players: seats.players, source: 'live', seats: out }, env);
}

/** The seats of `game` as a fold reads them. */
export function profileSeatsOf(game: Pick<Game, 'players'>): ProfileSeats {
  return {
    format: profileFormatOf(game.players),
    players: game.players.filter((p) => holdsSeat(p.state)).length,
    ai: game.players.filter((p) => p.isAI).map((p) => p.id).sort((a, b) => a - b),
    turnedAI: game.players.filter((p) => p.humanTurnedIntoAI).map((p) => p.id).sort((a, b) => a - b),
  };
}

/**
 * The seats a finished read folds under. GameFeed's team field is unverified (the profile tool
 * resolves teams from GetMyGames when it is missing), so a read with no team carries no evidence
 * about the format: the format and seat count recorded from the team-resolved game stand, and only
 * the AI seats come from the final read.
 */
function seatsForFold(raw: ProfileSeats, recorded: ProfileSeats | undefined, rawHasTeams: boolean): ProfileSeats {
  if (rawHasTeams || !recorded) return raw;
  return { ...raw, format: recorded.format, players: recorded.players };
}

/**
 * On a read that shows `game` finished: fold every per-game file of it not folded yet (one per
 * account of mine that recorded it), with each player's final state as its ending, and mark it
 * `folded: 'live'`. Only opponents in GameFeed's player list, never a teammate, never a human who
 * became an AI. The number of files folded; 0 when the game is not finished, profiling is off, or
 * nothing was there. Never throws.
 */
export async function foldFinishedGame(dir: string, game: Pick<Game, 'id' | 'state' | 'players'>, env: EnvSource = process.env): Promise<number> {
  if (!profileEnabled(env) || game.state !== 'Finished') return 0;
  let folded = 0;
  try {
    const prefix = `${game.id}-`;
    const names = (await readdir(profileGamesDir(dir)).catch(() => [] as string[])).filter((n) => n.startsWith(prefix) && /^\d+-\d+\.json$/.test(n)).sort();
    const raw = profileSeatsOf(game);
    const byId = new Map(game.players.map((p) => [p.id, p]));
    for (const name of names) {
      const me = Number(name.slice(prefix.length, -'.json'.length));
      const mePlayer = byId.get(me);
      if (!mePlayer) continue;
      const friends = new Set(teammatesOf(game.players, mePlayer).map((p) => p.id));
      const path = profileGamePath(dir, game.id, me);
      const done = await withPathLock(path, async () => {
        const file = await readGameFile(dir, game.id, me);
        if (file.folded) return false;
        const seats = seatsForFold(raw, file.seats, isTeamGame(game.players));
        // Only players of this game, never a teammate.
        const turns: Record<string, Record<string, TurnPrimitives>> = {};
        for (const [t, byOpponent] of Object.entries(file.turns))
          turns[t] = Object.fromEntries(Object.entries(byOpponent).filter(([o]) => byId.has(Number(o)) && !friends.has(Number(o))));
        const r = await foldFile(dir, game.id, me, { turns }, seats, (id) => endingOf(byId.get(id)?.state), env);
        if (r !== 'folded') return false;
        await writeGameFile(path, { version: 1, gameId: game.id, playerId: me, turns: file.turns, seats, folded: 'live' });
        return true;
      });
      if (done) folded++;
    }
  } catch {
    // Best effort.
  }
  return folded;
}
