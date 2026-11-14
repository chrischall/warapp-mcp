// Offline replay of a planned game: the settings a plan needs, kept per game beside the board cache,
// and a loader that rebuilds the planner's inputs from the data directory alone (no request).
//
// `<dataDir>/games/<gameId>.json` is written wherever the board cache is (warapp_plan_turn,
// warapp_track_opponents, warapp_locate_opponents, warapp_get_relations): `{ version: 1, gameId,
// mapId, state, numberOfTurns, players, settings, derived }`. NAME-FREE: players are kept by id
// (with their team, state and AI flags), never by name; the settings are GameFeed's raw settings
// filtered by `sanitizeSettings` (numbers, booleans, numeric strings, a few enum settings and a
// card's `Mode`; no free text such as the creator's message, no mod entries, nothing equal to a
// player's or the game's name), with the overridden bonuses re-written in their verified shape. Read back through
// `normalizeSettings`, they give the planner the same income, kill rates, luck, rounding, fog,
// move order, teams, Local Deployment, commanders, cards and overrides. 0600 in a 0700 folder,
// atomic, best effort (never throws); the newest MAX_GAME_RECORDS games are kept, and a game not
// written for BOARD_CACHE_MAX_AGE_MS is deleted, as its boards are.
//
// The map comes from the persistent map store (src/map-store.ts, base values: `mapOf(game)` applies
// the game's overrides) and the boards and orders from the board cache (src/trend.ts).

import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { MyOrders } from './analysis/opponents.js';
import type { BoardState } from './board.js';
import { readStoredMap, writeJsonAtomic } from './map-store.js';
import { normalizeSettings, parseEndRules, type Game, type GameMap, type GameSettings, type Player } from './normalize.js';
import { BOARD_CACHE_MAX_AGE_MS, readBoardHistory, readCachedOrders, readCachedPlayer } from './trend.js';

/** Games whose settings are kept; the least recently written goes first. */
export const MAX_GAME_RECORDS = 200;

const VERSION = 1;
const GAME_FILE = /^\d+\.json$/;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

export const gamesDir = (dir: string) => join(dir, 'games');
export const gameRecordPath = (dir: string, gameId: number) => join(gamesDir(dir), `${gameId}.json`);

/** Top-level settings whose value is a word (an enum), kept when it is not a name. */
const ENUM_SETTINGS = new Set(['Pace', 'Fog', 'MoveOrder', 'RoundingMode', 'InstantSurrender', 'AutomaticTerritoryDistribution']);
/** Settings never kept: free text, mod entries (their count is kept apart), the overrides (re-written). */
const DROPPED_SETTINGS = new Set(['PersonalMessage', 'Mods', 'OverriddenBonuses']);
/** Keys inside a card's settings (`<Name>Card`) whose value is a word: `cardArmyCeiling` reads `Mode`. */
const CARD_ENUM_KEYS: ReadonlySet<string> = new Set(['Mode']);
const NO_KEYS: ReadonlySet<string> = new Set();
const ENUM = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const NUMERIC = /^\s*-?\d+(\.\d+)?\s*$/;
const LITERAL = /^(true|false|none|null)$/i;
const MAX_DEPTH = 3;

/** `enumKeys`: the keys of this value (an object) whose word values are kept; deeper levels keep none. */
function cleanValue(v: unknown, depth: number, enumOk: boolean, names: ReadonlySet<string>, enumKeys: ReadonlySet<string> = NO_KEYS): unknown {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    if (NUMERIC.test(v) || LITERAL.test(v)) return v;
    return enumOk && ENUM.test(v) && !names.has(v.toLowerCase()) ? v : undefined;
  }
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(v)) return v.map((x) => cleanValue(x, depth + 1, false, names)).filter((x) => x !== undefined);
  if (isRec(v)) {
    const out: Rec = {};
    for (const [k, x] of Object.entries(v)) {
      if (!ENUM.test(k) && !NUMERIC.test(k)) continue;
      const c = cleanValue(x, depth + 1, enumKeys.has(k), names);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

/**
 * GameFeed's raw settings without free text or names: numbers, booleans, numeric strings, the
 * literals true/false/none/null, and the {@link ENUM_SETTINGS} words (and a card's
 * {@link CARD_ENUM_KEYS} words) that are not one of `names` (compared without case); objects to a
 * depth of {@link MAX_DEPTH}.
 */
export function sanitizeSettings(raw: Rec, names: readonly string[]): Rec {
  const lower = new Set(names.map((n) => n.toLowerCase()));
  const out: Rec = {};
  for (const [k, v] of Object.entries(raw)) {
    if (DROPPED_SETTINGS.has(k) || (!ENUM.test(k) && !NUMERIC.test(k))) continue;
    const c = cleanValue(v, 1, ENUM_SETTINGS.has(k), lower, k.endsWith('Card') ? CARD_ENUM_KEYS : NO_KEYS);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

interface Derived {
  mods?: number;
  commerce?: boolean;
  overriddenBonusesUnparsed?: true;
}

function playerRecord(p: Player): Rec {
  return {
    id: p.id,
    ...(p.feedId !== undefined ? { feedId: p.feedId } : {}),
    isAI: p.isAI,
    humanTurnedIntoAI: p.humanTurnedIntoAI,
    ...(p.state !== undefined ? { state: p.state } : {}),
    ...(p.team !== undefined ? { team: p.team } : {}),
  };
}

/** Delete game records older than the board cache keeps, then the oldest beyond the cap. Best effort. */
async function pruneGames(dir: string, keep: number): Promise<void> {
  const folder = gamesDir(dir);
  const cutoff = Date.now() - BOARD_CACHE_MAX_AGE_MS;
  const files: { name: string; at: number }[] = [];
  for (const name of await readdir(folder)) {
    if (!GAME_FILE.test(name) || name === `${keep}.json`) continue;
    try {
      const at = (await stat(join(folder, name))).mtimeMs;
      if (at < cutoff) await unlink(join(folder, name));
      else files.push({ name, at });
    } catch {
      // Gone already.
    }
  }
  const excess = files.length + 1 - MAX_GAME_RECORDS;
  if (excess <= 0) return;
  files.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  for (const f of files.slice(0, excess)) await unlink(join(folder, f.name)).catch(() => {});
}

/** Keep the settings needed to replay `game` (name-free). `false` when it has none or the write failed; never throws. */
export async function writeGameRecord(dir: string, game: Game): Promise<boolean> {
  const s = game.settings;
  if (!s) return false;
  try {
    const names = [...game.players.map((p) => p.name), ...(game.name !== undefined ? [game.name] : [])];
    const settings = sanitizeSettings(s.raw, names);
    if (s.overriddenBonuses) settings.OverriddenBonuses = [...s.overriddenBonuses].map(([bonusID, value]) => ({ bonusID, value }));
    const derived: Derived = {
      ...(s.mods !== undefined ? { mods: s.mods } : {}),
      ...(s.commerce !== undefined ? { commerce: s.commerce } : {}),
      ...(s.overriddenBonusesUnparsed ? { overriddenBonusesUnparsed: true as const } : {}),
    };
    await writeJsonAtomic(gameRecordPath(dir, game.id), gamesDir(dir), {
      version: VERSION,
      gameId: game.id,
      ...(s.mapId !== undefined ? { mapId: s.mapId } : {}),
      state: game.state,
      ...(game.numberOfTurns !== undefined ? { numberOfTurns: game.numberOfTurns } : {}),
      players: game.players.map(playerRecord),
      settings,
      derived,
    });
    await pruneGames(dir, game.id).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function playerOf(p: unknown): Player | undefined {
  if (!isRec(p) || !isInt(p.id)) return undefined;
  const out: Player = {
    id: p.id,
    // Name-free by design: the id stands in for the name.
    name: String(p.id),
    isAI: p.isAI === true,
    humanTurnedIntoAI: p.humanTurnedIntoAI === true,
    hasCommittedOrders: false,
  };
  if (typeof p.feedId === 'string') out.feedId = p.feedId;
  if (typeof p.state === 'string') out.state = p.state;
  if (isInt(p.team)) out.team = p.team;
  return out;
}

/** The game kept for `gameId` (name-free, without its map); `undefined` when absent or unusable. Never throws. */
export async function readGameRecord(dir: string, gameId: number): Promise<Game | undefined> {
  try {
    const r: unknown = JSON.parse(await readFile(gameRecordPath(dir, gameId), 'utf8'));
    if (!isRec(r) || r.version !== VERSION || r.gameId !== gameId || typeof r.state !== 'string' || !isRec(r.settings)) return undefined;
    const settings: GameSettings = normalizeSettings(r.settings);
    const d = isRec(r.derived) ? r.derived : {};
    if (isInt(d.mods)) settings.mods = d.mods;
    if (typeof d.commerce === 'boolean') settings.commerce = d.commerce;
    if (d.overriddenBonusesUnparsed === true) settings.overriddenBonusesUnparsed = true;
    const players = Array.isArray(r.players) ? r.players.map(playerOf).filter((p): p is Player => p !== undefined) : [];
    const game: Game = { id: gameId, state: r.state, players, settings, endRules: parseEndRules(r.settings) };
    if (isInt(r.numberOfTurns)) game.numberOfTurns = r.numberOfTurns;
    return game;
  } catch {
    return undefined;
  }
}

/** What an offline tool needs to rebuild a plan's inputs for one game. */
export interface Replay {
  /** The game as kept (name-free), with its stored map attached when there is one: `mapOf(game)` applies its overrides. */
  game: Game;
  settings: GameSettings;
  /** The stored map (base values), when the map store has it. */
  map: GameMap | undefined;
  /** The account whose fogged view the boards are; `undefined` when no board is cached. */
  playerId: number | undefined;
  /** The cached boards, oldest turn first. */
  boards: { turn: number; board: BoardState }[];
  /** The orders this server sent, by turn. */
  orders: Map<number, MyOrders>;
}

/**
 * Rebuild a game's planner inputs from `dataDir` alone: its kept settings, the stored map and the
 * cached boards and orders. `undefined` when the game has no settings record. Never throws.
 */
export async function loadReplay(dataDir: string, gameId: number): Promise<Replay | undefined> {
  const game = await readGameRecord(dataDir, gameId);
  if (!game) return undefined;
  const settings = game.settings!;
  const map = settings.mapId !== undefined ? await readStoredMap(dataDir, settings.mapId, { maxAgeMs: Number.POSITIVE_INFINITY }) : undefined;
  if (map) game.map = map;
  const playerId = await readCachedPlayer(dataDir, gameId);
  const boards = playerId !== undefined ? await readBoardHistory(dataDir, gameId, playerId) : [];
  const orders = playerId !== undefined ? await readCachedOrders(dataDir, gameId, playerId) : new Map<number, MyOrders>();
  return { game, settings, map, playerId, boards, orders };
}
