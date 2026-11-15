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
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readEnvVar, type EnvSource } from '@chrischall/mcp-utils';
import type { MapGraph } from './analysis/graph.js';
import { observeTurn, type ObserveInput, type ObservedPrimitives, type TurnPrimitives } from './analysis/opponent-profile.js';
import type { TurnBoard } from './analysis/opponents.js';
import { withPathLock } from './path-lock.js';
import { BOARD_CACHE_MAX_AGE_MS } from './trend.js';

export const PROFILE_ENV = 'WARAPP_PLAYER_PROFILE';
/** Game files kept: the newest by last write. */
export const MAX_PROFILE_GAME_FILES = 200;

/** Whether opponent profiling is on: yes (local and hosted) unless `WARAPP_PLAYER_PROFILE` is `off`, `0`, `false` or `no`. */
export function profileEnabled(env: EnvSource = process.env): boolean {
  const v = readEnvVar(PROFILE_ENV, { env });
  return v === undefined || !/^(off|0|false|no)$/i.test(v.trim());
}

/** What the profile tool says of its store: `kept` (stored per game), `not-kept` (on, but no data dir to keep it in) or `off`. */
export function profileState(env: EnvSource, dataDir: string | undefined): 'kept' | 'not-kept' | 'off' {
  if (!profileEnabled(env)) return 'off';
  return dataDir ? 'kept' : 'not-kept';
}

export const profileGamesDir = (dir: string) => join(dir, 'profiles', 'games');
export const profileGamePath = (dir: string, gameId: number, playerId: number) => join(profileGamesDir(dir), `${gameId}-${playerId}.json`);

interface ProfileGameFile {
  version: 1;
  gameId: number;
  playerId: number;
  /** Turn → opponent id → what it did on that turn. */
  turns: Record<string, Record<string, TurnPrimitives>>;
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

/** The stored turns of a game as `playerId` saw it; `{}` when absent or unusable. */
async function readTurns(dir: string, gameId: number, playerId: number): Promise<Record<string, Record<string, TurnPrimitives>>> {
  try {
    const f: unknown = JSON.parse(await readFile(profileGamePath(dir, gameId, playerId), 'utf8'));
    if (!isRec(f) || f.version !== 1 || f.gameId !== gameId || f.playerId !== playerId || !isRec(f.turns)) return {};
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
    return out;
  } catch {
    return {};
  }
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
  /** My boards of the game, each with my orders on that turn when known (`boardHistory` plus the live board). */
  boards: readonly TurnBoard[];
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
async function prune(dir: string): Promise<void> {
  try {
    const folder = profileGamesDir(dir);
    const files: { path: string; mtime: number }[] = [];
    for (const name of await readdir(folder)) {
      if (!/^\d+-\d+\.json$/.test(name)) continue;
      const path = join(folder, name);
      try {
        files.push({ path, mtime: (await stat(path)).mtimeMs });
      } catch {
        // Gone already.
      }
    }
    files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    const cutoff = Date.now() - BOARD_CACHE_MAX_AGE_MS;
    for (const [i, f] of files.entries())
      if (i >= MAX_PROFILE_GAME_FILES || f.mtime < cutoff) await unlink(f.path).catch(() => undefined);
  } catch {
    // No folder yet.
  }
}

/**
 * Observe every consecutive pair of `input.boards` and store each turn's record, overwriting that
 * turn's entry (planning a turn twice rewrites, never adds); turns not observed this time stay.
 * Writes nothing when profiling is off or nothing could be observed. Never throws; `false` when
 * nothing was written.
 */
export async function recordBehaviour(dir: string, input: BehaviourInput, env: EnvSource = process.env): Promise<boolean> {
  if (!profileEnabled(env)) return false;
  try {
    const observed = observeBoards(input);
    if (!observed.size) return false;
    const path = profileGamePath(dir, input.gameId, input.me);
    return await withPathLock(path, async () => {
      const turns = await readTurns(dir, input.gameId, input.me);
      for (const [t, byOpponent] of observed) {
        const entry: Record<string, TurnPrimitives> = {};
        for (const [o, p] of [...byOpponent].sort(([a], [b]) => a - b)) entry[String(o)] = p;
        turns[String(t)] = entry;
      }
      const body: ProfileGameFile = { version: 1, gameId: input.gameId, playerId: input.me, turns };
      await mkdir(profileGamesDir(dir), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
      await rename(tmp, path);
      await prune(dir);
      return true;
    });
  } catch {
    return false;
  }
}
