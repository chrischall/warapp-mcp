// The previous turn's board, for the planner's threat trend. Best effort and
// never throws: GameFeed's `GetHistory` standing for the previous turn when the
// feed sends one (UNVERIFIED for games in progress — see docs/WARAPP-API.md),
// else the board this server planned on for the previous turn, cached on disk
// (the newest CACHED_TURNS turns per game, planned or tracked: opponent tracking
// reads the whole history).
//
// The cache holds only the player's own fogged view (what the live board
// showed them), at `<dataDir>/boards/<gameId>.json`; a game's file not written for
// 60 days is deleted on the first write of a process.
//
// Beside the boards, the same file keeps the orders this server sent for a turn
// (`warapp_submit_turn`, #119): my own orders are measurements of what an opponent
// deployed (analysis/opponents.ts `measureOrders`). Orders sent from the web client
// stay unknown, which changes nothing; a confirmed `warapp_uncommit_turn` drops the
// turn's cached orders, so a resend from the web client does not leave them standing.
//
// And, by turn, the next income the plan of that turn expected (`expected.nextIncome`, #194): the
// next turn's plan compares its income with it ("since last turn").
//
// And (#275 b) the survival side store: by turn, the deploy estimate each opponent was planned
// against (`estimates`), and the opponents whose estimate a tripwire marked untrusted
// (`tripwires`, src/analysis/tripwire.ts). Player ids and numbers only, never a name.
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boardFromStanding, type BoardState, type TerritoryState } from './board.js';
import { playersByInGameId } from './live.js';
import type { MyOrders } from './analysis/opponents.js';
import type { TripKind, Tripwire } from './analysis/tripwire.js';
import type { Game, Player } from './normalize.js';
import { asInt } from './scalars.js';

export type TrendSource = 'history' | 'cache';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

const STANDING_KEYS = ['standing', 'standings', 'latestStanding', 'Standing'] as const;
const NUMBER_KEYS = ['turnNumber', 'turn', 'number', 'TurnNumber'] as const;
/** Keys that wrap a history's turns (#302: GameFeed's spelling is unverified). */
const WRAPPER_KEYS = ['turns', 'Turns', 'history', 'History', 'standings', 'Standings'] as const;
const DISTRIBUTION_KEYS = ['distributionStanding', 'DistributionStanding'] as const;
const STANDING_KEY = /^standing_?(\d+)$/i;

/** How a history is read (#302). */
export interface HistoryOptions {
  /**
   * The game's completed turns (GameFeed `numberOfTurns`): with top-level `standing<N>` keys it
   * decides whether `standing0` is the start (the last N reaches it) or the board after the first
   * turn (the last N is one short). UNVERIFIED either way.
   */
  numberOfTurns?: number;
}

function standingOf(entry: unknown): unknown {
  if (!isRec(entry)) return entry;
  for (const k of STANDING_KEYS) if (entry[k] !== undefined) return entry[k];
  return entry;
}

/** History entries as (completed turns, raw standing), with the layout they were read in. */
interface Parsed {
  entries: Array<[number, unknown]>;
  /** How the entries were found, e.g. `array`, `wrapper:turns>array`, `numbered-keys`, `standing-keys+1+distribution`. */
  layout: string;
  /** What the history was: `array`, `object`, `string` (did not parse as JSON), or another `typeof`. */
  shape: string;
}

/** History entries in any of the plausible layouts (#302). Throws only on a hostile getter (callers catch). */
function parseHistory(history: unknown, opts: HistoryOptions = {}): Parsed {
  if (typeof history === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(history);
    } catch {
      return { entries: [], layout: 'none', shape: 'string' };
    }
    const inner = parseHistory(parsed, opts);
    return { ...inner, layout: `json>${inner.layout}` };
  }
  if (Array.isArray(history)) {
    const entries: Array<[number, unknown]> = history.map((e, i) => {
      let n: number | undefined;
      if (isRec(e)) for (const k of NUMBER_KEYS) n ??= asInt(e[k]);
      return [n ?? i, standingOf(e)];
    });
    return { entries, layout: 'array', shape: 'array' };
  }
  if (!isRec(history)) return { entries: [], layout: 'none', shape: history === null ? 'null' : typeof history };
  for (const k of WRAPPER_KEYS) {
    const v = history[k];
    if (v === undefined) continue;
    const inner = parseHistory(v, opts);
    return { ...inner, layout: `wrapper:${k}>${inner.layout}`, shape: 'object' };
  }
  let dist: unknown;
  for (const k of DISTRIBUTION_KEYS) dist ??= history[k];
  const standings: Array<[number, unknown]> = [];
  for (const [k, v] of Object.entries(history)) {
    const m = STANDING_KEY.exec(k);
    if (m) standings.push([Number(m[1]), standingOf(v)]);
  }
  if (standings.length) {
    // Top-level `standing<N>` keys (#302), `turn<N>` beside them being orders: is standing0 the
    // start, or the board after the first turn? The game's completed turns decide when the last N
    // reaches them or falls one short; else a distribution standing beside them puts standing0 one on.
    const last = Math.max(...standings.map(([n]) => n));
    const t = opts.numberOfTurns;
    const offset = t !== undefined && last >= t ? 0 : t !== undefined && last === t - 1 ? 1 : dist !== undefined ? 1 : 0;
    const entries: Array<[number, unknown]> = standings.map(([n, v]) => [n + offset, v]);
    if (dist !== undefined && !entries.some(([n]) => n === 0)) entries.push([0, standingOf(dist)]);
    return {
      entries,
      layout: `standing-keys${offset ? '+1' : ''}${dist !== undefined ? '+distribution' : ''}`,
      shape: 'object',
    };
  }
  const entries: Array<[number, unknown]> = [];
  for (const [k, v] of Object.entries(history)) {
    const m = /^(?:turn)?_?(\d+)$/i.exec(k);
    if (m) entries.push([Number(m[1]), standingOf(v)]);
  }
  if (dist !== undefined && !entries.some(([n]) => n === 0)) entries.push([0, standingOf(dist)]);
  return { entries, layout: 'numbered-keys', shape: 'object' };
}

/**
 * The standing after `completedTurns` turns from a raw `GetHistory` payload,
 * with owners keyed by GameFeed player id; `undefined` when it is absent or
 * unusable. An entry's number is read as the count of completed turns its
 * standing reflects (an assumption: the shape is unverified, #302). The first
 * entry of that number that parses wins. Never throws.
 */
export function boardFromHistory(
  history: unknown,
  completedTurns: number,
  players: readonly Player[],
  opts: HistoryOptions = {},
): BoardState | undefined {
  try {
    for (const [n, raw] of parseHistory(history, opts).entries) {
      if (n !== completedTurns) continue;
      const board = feedOwners(boardFromStanding(raw), players);
      if (board) return board;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** A parsed board with in-game owner ids mapped back to GameFeed player ids. */
function feedOwners(board: BoardState | undefined, players: readonly Player[]): BoardState | undefined {
  if (!board) return undefined;
  const byInGame = playersByInGameId(players);
  const feedIds = new Set(players.map((p) => p.id));
  return {
    ...board,
    territories: board.territories.map((t): TerritoryState => {
      if (t.owner.kind !== 'player' || feedIds.has(t.owner.playerId)) return t;
      const p = byInGame.get(t.owner.playerId);
      return p ? { ...t, owner: { kind: 'player', playerId: p.id } } : t;
    }),
  };
}

/**
 * Every usable standing in a raw `GetHistory` payload, ascending by entry
 * number (completed turns, as {@link boardFromHistory} reads it), owners keyed
 * by GameFeed player id. Entries that do not parse are left out; the first of
 * two entries with one number that parses wins. Never throws.
 */
export function historyBoards(
  history: unknown,
  players: readonly Player[],
  opts: HistoryOptions = {},
): Array<{ turn: number; board: BoardState }> {
  try {
    const seen = new Set<number>();
    const out: Array<{ turn: number; board: BoardState }> = [];
    for (const [turn, raw] of parseHistory(history, opts).entries) {
      if (seen.has(turn)) continue;
      const board = feedOwners(boardFromStanding(raw), players);
      if (!board) continue;
      seen.add(turn);
      out.push({ turn, board });
    }
    return out.sort((a, b) => a.turn - b.turn);
  } catch {
    return [];
  }
}

/** At most this many key names go into a report (#302). */
const MAX_REPORTED_KEYS = 40;
/** A key name that may be reported: an identifier, never free text. */
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** The key names of a reply or entry worth reporting: identifiers only, capped (#302). */
export function safeKeys(keys: readonly string[]): string[] {
  return keys.filter((k) => SAFE_KEY.test(k)).slice(0, MAX_REPORTED_KEYS);
}

/** Why a history did not read (#302), name-free: key names, counts and the layout only. */
export interface HistoryUnreadable {
  /**
   * `absent`: the reply carried no history the reader knows; `not-json`: a string that did not parse;
   * `no-turns`: a history with no entry the reader knows; `no-standing`: entries, none a board;
   * `no-player-land`: boards on which no player of the game holds land (map statistics need one);
   * `no-starts` (map statistics): the first board where land is held shows none of the game's players.
   */
  reason: 'absent' | 'not-json' | 'no-turns' | 'no-standing' | 'no-player-land' | 'no-starts';
  /** The reply's top-level key names (identifiers only, capped). */
  keys: string[];
  /** What the history was (`array`, `object`, `string`, …), when there was one. */
  shape?: string;
  /** Entries found. */
  turns?: number;
  /** An object history's own key names (identifiers only, capped). */
  historyKeys?: string[];
  /** The first entry's key names (identifiers only, capped). */
  entryKeys?: string[];
}

/** A history that read (#302): the boards found and the layout they were read in. */
export interface HistoryRead {
  turns: number;
  first: number;
  last: number;
  layout: string;
}

/**
 * Whether a game's history reads, and if not why (#302): one live call then shows GameFeed's real
 * shape. `needPlayerLand` (map statistics) also asks that some board shows a player of the game
 * holding land. Name-free; never throws.
 */
export function historyReport(
  game: Pick<Game, 'history' | 'players' | 'numberOfTurns' | 'feedKeys'>,
  opts: { needPlayerLand?: boolean } = {},
): { read: HistoryRead } | { unreadable: HistoryUnreadable } {
  const keys = safeKeys(game.feedKeys ?? []);
  if (game.history === undefined) return { unreadable: { reason: 'absent', keys } };
  let parsed: Parsed;
  try {
    parsed = parseHistory(game.history, game.numberOfTurns !== undefined ? { numberOfTurns: game.numberOfTurns } : {});
  } catch {
    parsed = { entries: [], layout: 'none', shape: 'object' };
  }
  const { entries, shape, layout } = parsed;
  if (shape === 'string') return { unreadable: { reason: 'not-json', keys, shape } };
  if (!entries.length) {
    const own = isRec(game.history) ? { historyKeys: safeKeys(Object.keys(game.history)) } : {};
    return { unreadable: { reason: 'no-turns', keys, shape, ...own } };
  }
  const boards = historyBoards(game.history, game.players, game.numberOfTurns !== undefined ? { numberOfTurns: game.numberOfTurns } : {});
  if (!boards.length) {
    const first = entries[0]![1];
    const entryKeys = isRec(first) ? { entryKeys: safeKeys(Object.keys(first)) } : {};
    return { unreadable: { reason: 'no-standing', keys, shape, turns: entries.length, ...entryKeys } };
  }
  if (opts.needPlayerLand) {
    const ids = new Set(game.players.map((p) => p.id));
    const land = boards.some(({ board }) => board.territories.some((t) => t.owner.kind === 'player' && ids.has(t.owner.playerId)));
    if (!land) return { unreadable: { reason: 'no-player-land', keys, shape, turns: boards.length } };
  }
  return { read: { turns: boards.length, first: boards[0]!.turn, last: boards[boards.length - 1]!.turn, layout } };
}

/** Where the last planned boards of a game are cached. */
export const boardCachePath = (dir: string, gameId: number) => join(dir, 'boards', `${gameId}.json`);

/**
 * Turns kept per game: enough history for opponent tracking (an estimate over the
 * last three observed turns needs four boards; more shows where the armies went
 * since an opponent was first seen), and a turn planned again (another goal, or
 * after a hand override) still finds the board of the turn before it.
 */
export const CACHED_TURNS = 10;
/**
 * Turns of the survival store's estimates kept per game (#275 review): every turn of a game, not only the
 * boards' newest {@link CACHED_TURNS}, since the tripwire's stock bound reads every turn's kept estimate
 * from turn 1 (and reads no stock with a turn missing). Numbers only, a few per turn.
 */
export const SURVIVAL_TURNS = 200;

/** A game's cached boards not written for this long are deleted (finished or abandoned games). */
export const BOARD_CACHE_MAX_AGE_MS = 60 * 86_400_000;
const BOARD_FILE = /^\d+\.json$/;
/** Board directories pruned by this process: once is enough. */
const pruned = new Set<string>();

/** Delete the board caches of games not written for {@link BOARD_CACHE_MAX_AGE_MS}. Best effort. */
async function pruneBoardCaches(dir: string): Promise<void> {
  const boards = join(dir, 'boards');
  if (pruned.has(boards)) return;
  pruned.add(boards);
  const cutoff = Date.now() - BOARD_CACHE_MAX_AGE_MS;
  try {
    for (const name of await readdir(boards)) {
      if (!BOARD_FILE.test(name)) continue;
      const file = join(boards, name);
      try {
        if ((await stat(file)).mtimeMs < cutoff) await unlink(file);
      } catch {
        // Gone already, or unreadable: leave it.
      }
    }
  } catch {
    // No board directory yet.
  }
}

interface CachedBoards {
  gameId: number;
  playerId: number;
  turns: Record<string, BoardState>;
  /** The orders this server sent, by turn (#119); absent when none were. */
  orders?: Record<string, MyOrders>;
  /** The next income the plan of each turn expected (#194); absent when none was planned. */
  expected?: Record<string, number>;
  /** #275: by turn, each opponent's deploy estimate the plan used, by player id. */
  estimates?: Record<string, Record<string, number>>;
  /** #275: the opponents whose estimate is untrusted, and why. */
  tripwires?: Tripwire[];
}

type RawCache = {
  turns: Record<string, unknown>;
  orders: Record<string, unknown>;
  expected: Record<string, unknown>;
  estimates: Record<string, unknown>;
  tripwires: unknown[];
};

const EMPTY = (): RawCache => ({ turns: {}, orders: {}, expected: {}, estimates: {}, tripwires: [] });

/** The raw cache for `gameId` as `playerId` saw it: boards, orders and expected incomes by turn; empty when absent or unusable. */
async function readCache(dir: string, gameId: number, playerId: number): Promise<RawCache> {
  try {
    const c: unknown = JSON.parse(await readFile(boardCachePath(dir, gameId), 'utf8'));
    if (!isRec(c) || c.gameId !== gameId || c.playerId !== playerId) return EMPTY();
    const rest = {
      orders: isRec(c.orders) ? c.orders : {},
      expected: isRec(c.expected) ? c.expected : {},
      estimates: isRec(c.estimates) ? c.estimates : {},
      tripwires: Array.isArray(c.tripwires) ? (c.tripwires as unknown[]) : [],
    };
    if (isRec(c.turns)) return { turns: c.turns, ...rest };
    // A single-board cache written before turns were kept.
    if (typeof c.turn === 'number') return { turns: { [String(c.turn)]: c.board }, ...rest };
    return { turns: {}, ...rest };
  } catch {
    return EMPTY();
  }
}

/** The cache's optional parts as written back: the orders, expected incomes and survival store, when any are kept. */
function extras(cache: RawCache): Pick<CachedBoards, 'orders' | 'expected' | 'estimates' | 'tripwires'> {
  return {
    ...(Object.keys(cache.orders).length ? { orders: cache.orders as Record<string, MyOrders> } : {}),
    ...(Object.keys(cache.expected).length ? { expected: cache.expected as Record<string, number> } : {}),
    ...(Object.keys(cache.estimates).length ? { estimates: cache.estimates as Record<string, Record<string, number>> } : {}),
    ...(cache.tripwires.length ? { tripwires: cache.tripwires as Tripwire[] } : {}),
  };
}

/** The cached boards by turn for `gameId` as `playerId` saw them; `{}` when absent or unusable. */
async function readCachedTurns(dir: string, gameId: number, playerId: number): Promise<Record<string, unknown>> {
  return (await readCache(dir, gameId, playerId)).turns;
}

/** The newest `keep` ({@link CACHED_TURNS} by default) numeric keys of `rec` at or below `upTo`, ascending. */
function newestTurns(rec: Record<string, unknown>, upTo = Infinity, keep = CACHED_TURNS): number[] {
  return Object.keys(rec)
    .filter((k) => /^\d+$/.test(k) && Number(k) <= upTo)
    .map(Number)
    .sort((a, b) => b - a)
    .slice(0, keep)
    .sort((a, b) => a - b);
}

/** Write a game's cache file atomically, then prune old games. */
async function writeCache(dir: string, body: CachedBoards): Promise<void> {
  const path = boardCachePath(dir, body.gameId);
  await mkdir(join(dir, 'boards'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
  await rename(tmp, path);
  await pruneBoardCaches(dir);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Cached orders, loosely: unusable entries are dropped, never thrown on. */
function ordersOf(o: unknown): MyOrders | undefined {
  if (!isRec(o) || !Array.isArray(o.deploys) || !Array.isArray(o.moves)) return undefined;
  return {
    deploys: (o.deploys as unknown[])
      .filter((d): d is Rec => isRec(d) && isNum(d.territoryId) && isNum(d.armies))
      .map((d) => ({ territoryId: d.territoryId as number, armies: d.armies as number })),
    moves: (o.moves as unknown[])
      .filter((m): m is Rec => isRec(m) && isNum(m.from) && isNum(m.to) && isNum(m.armies))
      .map((m) => ({ from: m.from as number, to: m.to as number, armies: m.armies as number, ...(m.commander === true ? { commander: true as const } : {}) })),
    ...(Array.isArray(o.sent)
      ? {
          sent: (o.sent as unknown[])
            .filter((m): m is Rec => isRec(m) && isNum(m.from) && isNum(m.to))
            .map((m) => ({
              from: m.from as number,
              to: m.to as number,
              ...(m.transferOnly === true ? { transferOnly: true as const } : {}),
              ...(m.commander === true ? { commander: true as const } : {}),
            })),
        }
      : {}),
    ...(Array.isArray(o.cards)
      ? {
          cards: (o.cards as unknown[])
            .filter((c): c is Rec => isRec(c) && typeof c.card === 'string')
            .map((c) => ({
              card: c.card as string,
              ...(isNum(c.from) ? { from: c.from } : {}),
              ...(isNum(c.to) ? { to: c.to } : {}),
              ...(isNum(c.target) ? { target: c.target } : {}),
            })),
        }
      : {}),
  };
}

/** The orders this server sent for `gameId` as `playerId`, by turn (#119); empty when none. Never throws. */
export async function readCachedOrders(dir: string, gameId: number, playerId: number): Promise<Map<number, MyOrders>> {
  const { orders } = await readCache(dir, gameId, playerId);
  const out = new Map<number, MyOrders>();
  for (const turn of newestTurns(orders)) {
    const o = ordersOf(orders[String(turn)]);
    if (o) out.set(turn, o);
  }
  return out;
}

/**
 * Cache the deploys and moves this server sent for turn `turn` of `gameId` as `playerId` (#119),
 * keeping the newest {@link CACHED_TURNS} turns of orders and every cached board; the newest send
 * for a turn wins. Never throws.
 */
export async function writeOrdersCache(
  dir: string,
  gameId: number,
  playerId: number,
  turn: number,
  orders: MyOrders,
): Promise<boolean> {
  try {
    const cache = await readCache(dir, gameId, playerId);
    const all = { ...cache.orders, [String(turn)]: { deploys: orders.deploys, moves: orders.moves, ...(orders.sent ? { sent: orders.sent } : {}), ...(orders.cards ? { cards: orders.cards } : {}) } };
    const kept: Record<string, MyOrders> = {};
    for (const n of newestTurns(all)) kept[String(n)] = all[String(n)] as MyOrders;
    await writeCache(dir, { gameId, playerId, turns: cache.turns as Record<string, BoardState>, ...extras(cache), orders: kept });
    return true;
  } catch {
    return false;
  }
}

/**
 * Forget the orders cached for turn `turn` of `gameId` as `playerId` (they were withdrawn with
 * warapp_uncommit_turn, so they may never run and no longer measure that turn), keeping every
 * other turn and every board. Writes nothing when none are cached. Never throws.
 */
export async function dropOrdersCache(dir: string, gameId: number, playerId: number, turn: number): Promise<boolean> {
  try {
    const cache = await readCache(dir, gameId, playerId);
    if (!(String(turn) in cache.orders)) return true;
    const orders = { ...cache.orders } as Record<string, MyOrders>;
    delete orders[String(turn)];
    await writeCache(dir, { gameId, playerId, turns: cache.turns as Record<string, BoardState>, ...extras(cache), orders });
    return true;
  } catch {
    return false;
  }
}

/**
 * The board this server planned on for `gameId`, only when it was planned for
 * `playerId` on exactly turn `turn`; `undefined` otherwise. Never throws.
 */
export async function readBoardCache(
  dir: string,
  gameId: number,
  playerId: number,
  turn: number,
): Promise<BoardState | undefined> {
  return boardOf((await readCachedTurns(dir, gameId, playerId))[String(turn)]);
}

/** A cached board, loosely: unusable entries are dropped, never thrown on. */
function boardOf(b: unknown): BoardState | undefined {
  if (!isRec(b) || !Array.isArray(b.territories)) return undefined;
  const territories = (b.territories as unknown[]).filter(
    (t): t is TerritoryState =>
      isRec(t) &&
      typeof t.territoryId === 'number' &&
      isRec(t.owner) &&
      (typeof t.armies === 'number' || t.armies === null),
  );
  return { source: b.source === 'gamefeed' ? 'gamefeed' : 'browser', verified: b.verified === true, territories };
}

/**
 * Every board cached for `gameId` as `playerId` saw it, oldest turn first, only turns below
 * `before` when given; `[]` when there are none. Never throws.
 */
export async function readBoardHistory(
  dir: string,
  gameId: number,
  playerId: number,
  before?: number,
): Promise<{ turn: number; board: BoardState }[]> {
  const turns = await readCachedTurns(dir, gameId, playerId);
  const out: { turn: number; board: BoardState }[] = [];
  for (const [k, v] of Object.entries(turns)) {
    if (!/^\d+$/.test(k)) continue;
    const turn = Number(k);
    if (before !== undefined && turn >= before) continue;
    const board = boardOf(v);
    if (board) out.push({ turn, board });
  }
  return out.sort((a, b) => a.turn - b.turn);
}

/**
 * The next income the plan of turn `turn` of `gameId` expected (#194), as `playerId` planned it;
 * `undefined` when that turn was not planned here or the figure is unusable. Never throws.
 */
export async function readExpectedIncome(
  dir: string,
  gameId: number,
  playerId: number,
  turn: number,
): Promise<number | undefined> {
  const v = (await readCache(dir, gameId, playerId)).expected[String(turn)];
  return isNum(v) && v >= 0 ? v : undefined;
}

/**
 * Cache the board just planned on (turn `turn` of `gameId`, as `playerId` sees
 * it), keeping the newest {@link CACHED_TURNS} turns; a different player's
 * cache is replaced. With `expectedNextIncome` (a plan's `expected.nextIncome`,
 * #194), that figure is kept for the turn too, the newest plan of a turn winning;
 * without it, the turn's figure already kept stays. Never throws.
 */
export async function writeBoardCache(
  dir: string,
  gameId: number,
  playerId: number,
  turn: number,
  board: BoardState,
  expectedNextIncome?: number,
): Promise<boolean> {
  try {
    const cache = await readCache(dir, gameId, playerId);
    // A team game's teammate orders are this turn's entries, not the board: never cached (C1).
    const { teammateOrders: _entries, ...plain } = board;
    const kept = { ...cache.turns, [String(turn)]: plain };
    const turns: Record<string, BoardState> = {};
    for (const n of newestTurns(kept, turn)) turns[String(n)] = kept[String(n)] as BoardState;
    const allExpected = { ...cache.expected, ...(expectedNextIncome !== undefined ? { [String(turn)]: expectedNextIncome } : {}) };
    const expected: Record<string, unknown> = {};
    for (const n of newestTurns(allExpected, turn)) expected[String(n)] = allExpected[String(n)];
    await writeCache(dir, { gameId, playerId, turns, ...extras({ ...cache, expected }) });
    return true;
  } catch {
    return false;
  }
}

/**
 * The player whose view is cached for `gameId` (the file keeps one account's boards), for offline
 * replay (src/replay.ts); `undefined` when there is no usable cache. Never throws.
 */
export async function readCachedPlayer(dir: string, gameId: number): Promise<number | undefined> {
  try {
    const c: unknown = JSON.parse(await readFile(boardCachePath(dir, gameId), 'utf8'));
    return isRec(c) && c.gameId === gameId && typeof c.playerId === 'number' ? c.playerId : undefined;
  } catch {
    return undefined;
  }
}

const TRIP_KINDS: ReadonlySet<string> = new Set<TripKind>(['fog-stack', 'capture', 'held-attack']);

/** A kept tripwire, loosely: `undefined` when unusable. */
function tripwireOf(w: unknown): Tripwire | undefined {
  if (!isRec(w) || typeof w.kind !== 'string' || !TRIP_KINDS.has(w.kind)) return undefined;
  const nums = ['player', 'since', 'until', 'territory', 'observed', 'allowed', 'implied'] as const;
  if (!nums.every((k) => isNum(w[k]))) return undefined;
  return {
    player: w.player as number,
    since: w.since as number,
    until: w.until as number,
    kind: w.kind as TripKind,
    territory: w.territory as number,
    observed: w.observed as number,
    allowed: w.allowed as number,
    implied: w.implied as number,
  };
}

/** #275: the survival side store for `gameId` as `playerId` sees it. */
export interface Survival {
  /** Turn → opponent → the deploy estimate the plan used. */
  estimates: Map<number, Map<number, number>>;
  /** The untrusted marks kept (running or not: the reader decides). */
  tripwires: Tripwire[];
}

/** The survival side store (#275 b) kept for `gameId` as `playerId`; empty when none. Never throws. */
export async function readSurvival(dir: string, gameId: number, playerId: number): Promise<Survival> {
  const cache = await readCache(dir, gameId, playerId);
  const estimates = new Map<number, Map<number, number>>();
  for (const turn of newestTurns(cache.estimates, Infinity, SURVIVAL_TURNS)) {
    const rec = cache.estimates[String(turn)];
    if (!isRec(rec)) continue;
    const row = new Map<number, number>();
    for (const [k, v] of Object.entries(rec)) if (/^\d+$/.test(k) && isNum(v) && v >= 0) row.set(Number(k), v);
    if (row.size) estimates.set(turn, row);
  }
  const tripwires = cache.tripwires.map(tripwireOf).filter((w): w is Tripwire => w !== undefined);
  return { estimates, tripwires };
}

/**
 * Keep turn `turn`'s opponent estimates and the untrusted marks now running (#275 b) for `gameId` as
 * `playerId`, with the newest {@link SURVIVAL_TURNS} turns of estimates; the marks replace those kept.
 * Never throws.
 */
export async function writeSurvival(
  dir: string,
  gameId: number,
  playerId: number,
  turn: number,
  s: { estimates: ReadonlyMap<number, number>; tripwires: readonly Tripwire[] },
): Promise<boolean> {
  try {
    const cache = await readCache(dir, gameId, playerId);
    const all = { ...cache.estimates, [String(turn)]: Object.fromEntries([...s.estimates].map(([p, e]) => [String(p), e])) };
    const estimates: Record<string, unknown> = {};
    for (const n of newestTurns(all, Infinity, SURVIVAL_TURNS)) estimates[String(n)] = all[String(n)];
    await writeCache(dir, {
      gameId,
      playerId,
      turns: cache.turns as Record<string, BoardState>,
      ...extras({ ...cache, estimates, tripwires: [...s.tripwires] }),
    });
    return true;
  } catch {
    return false;
  }
}
