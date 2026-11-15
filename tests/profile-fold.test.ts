// Part B2 (docs/PLAN-PROFILES.md section 9): the two name-free stores (players.json, population.json),
// folding a finished game into them without double counting, the fade once per new game, AI seats
// to the pool only, the bounds, corrupt files left alone, and no id, game id or name on disk.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../src/analysis/graph.js';
import { addHabits, emptyHabits, scaleHabits, type Habits } from '../src/analysis/opponent-profile.js';
import type { TurnBoard } from '../src/analysis/opponents.js';
import type { Game } from '../src/normalize.js';
import { playerKey, playerRecordSalt, playerRecordSaltPath, updatePlayerRecord } from '../src/player-record-store.js';
import { ZERO_COUNTS } from '../src/analysis/player-record.js';
import {
  endingOf,
  foldFinishedGame,
  foldGame,
  MAX_PROFILE_ENTRIES,
  MAX_PROFILE_PLAYERS,
  PROFILE_DECAY,
  profileGamePath,
  profilePlayersPath,
  profilePopulationPath,
  readProfileHistory,
  recordBehaviour,
  type FoldInput,
} from '../src/profile-store.js';
import { BOARD_CACHE_MAX_AGE_MS } from '../src/trend.js';
import { board, mine, neutral, tinyMap } from './analysis/helpers.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'warapp-mcp-fold-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// Distinctive ids, so the serialized stores can be searched for them.
const ME = 3312345644;
const BOB = 7176543229;
const BOT = 9988776655;
const GAME = 81234567;
const GAME2 = 81234568;

const habits = (reinforce: [number, number], attack: [number, number] = [0, 0], turns = 5): Habits => ({
  ...emptyHabits(),
  reinforce: { e: reinforce[0], n: reinforce[1] },
  attack: { e: attack[0], n: attack[1] },
  turns,
});
const fold = (o: Partial<FoldInput> & Pick<FoldInput, 'seats'>): FoldInput => ({ me: ME, gameId: GAME, format: '1v1', players: 2, source: 'live', ...o });
const human = (id: number, h: Habits, ending: FoldInput['seats'][number]['ending'] = 'Won') => ({ id, ai: false, habits: h, ending });

async function history(dir: string, id: number, game?: number) {
  const h = await readProfileHistory(dir, [id], game === undefined ? {} : { me: ME, gameId: game }, {});
  if (typeof h !== 'object') throw new Error(`history ${h}`);
  return h;
}

describe('endingOf', () => {
  it('names the final states it knows, else unknown', () => {
    for (const s of ['Won', 'SurrenderAccepted', 'Booted', 'Eliminated', 'EndedByVote'] as const) expect(endingOf(s)).toBe(s);
    expect(endingOf('Playing')).toBe('unknown');
    expect(endingOf(undefined)).toBe('unknown');
  });
});

describe('foldGame', () => {
  it('gives the same totals when a game is folded twice', async () => {
    const dir = tmp();
    const a = habits([3, 4], [1, 2]);
    expect(await foldGame(dir, fold({ seats: [human(BOB, a)] }), {})).toBe('folded');
    const players = readFileSync(profilePlayersPath(dir), 'utf8');
    const population = readFileSync(profilePopulationPath(dir), 'utf8');
    expect(await foldGame(dir, fold({ seats: [human(BOB, a)] }), {})).toBe('folded');
    const h = await history(dir, BOB);
    expect(h.players.get(BOB)).toMatchObject({ games: 1, past: a });
    expect(h.pools.byFormat['1v1']).toEqual(a);
    expect(h.pools.games).toBe(1);
    expect(JSON.parse(readFileSync(profilePopulationPath(dir), 'utf8'))).toEqual(JSON.parse(population));
    const strip = (text: string) => Object.values(JSON.parse(text).players as Record<string, { seq?: number }>).map(({ seq: _s, ...p }) => p);
    expect(strip(readFileSync(profilePlayersPath(dir), 'utf8'))).toEqual(strip(players));
  });

  it('replaces a live entry with a history one, and never a history entry with a live one', async () => {
    const dir = tmp();
    const live = habits([1, 2]);
    const hist = habits([4, 6], [2, 3], 9);
    await foldGame(dir, fold({ seats: [human(BOB, live)] }), {});
    await foldGame(dir, fold({ source: 'history', seats: [human(BOB, hist)] }), {});
    expect((await history(dir, BOB)).players.get(BOB)).toMatchObject({ games: 1, past: hist });
    expect((await history(dir, BOB)).pools.byFormat['1v1']).toEqual(hist);
    await foldGame(dir, fold({ seats: [human(BOB, live)] }), {});
    expect((await history(dir, BOB)).players.get(BOB)!.past).toEqual(hist);
    expect((await history(dir, BOB)).pools.byFormat['1v1']).toEqual(hist);
  });

  it('fades a player once per new game, never on a game folded again', async () => {
    const dir = tmp();
    const a = habits([2, 2]);
    const b = habits([0, 3], [1, 1]);
    await foldGame(dir, fold({ seats: [human(BOB, a)] }), {});
    await foldGame(dir, fold({ gameId: GAME2, seats: [human(BOB, b)] }), {});
    const want = addHabits(scaleHabits(a, PROFILE_DECAY), b);
    expect((await history(dir, BOB)).players.get(BOB)).toMatchObject({ games: 2, past: want });
    // Both again, in either order: nothing more fades, nothing counts twice.
    await foldGame(dir, fold({ seats: [human(BOB, a)] }), {});
    await foldGame(dir, fold({ gameId: GAME2, seats: [human(BOB, b)] }), {});
    expect((await history(dir, BOB)).players.get(BOB)).toMatchObject({ games: 2, past: want });
    // A history entry replacing the faded game keeps its fade.
    const a2 = habits([1, 4]);
    await foldGame(dir, fold({ source: 'history', seats: [human(BOB, a2)] }), {});
    expect((await history(dir, BOB)).players.get(BOB)!.past).toEqual(addHabits(scaleHabits(a2, PROFILE_DECAY), b));
    // The population never fades: the sum of each game's latest entry.
    expect((await history(dir, BOB)).pools.byFormat['1v1']).toEqual(addHabits(a2, b));
  });

  it('leaves this game out of the past it reports for that game, and counts the games met before it', async () => {
    const dir = tmp();
    const a = habits([2, 2]);
    const b = habits([0, 3]);
    await foldGame(dir, fold({ seats: [human(BOB, a)] }), {});
    await foldGame(dir, fold({ gameId: GAME2, seats: [human(BOB, b)] }), {});
    expect((await history(dir, BOB, GAME2)).players.get(BOB)).toMatchObject({ games: 1, past: scaleHabits(a, PROFILE_DECAY) });
  });

  it('keeps AI seats out of every player key and pools them apart', async () => {
    const dir = tmp();
    const bot = habits([5, 5], [3, 3]);
    const bob = habits([1, 2]);
    await foldGame(dir, fold({ format: 'ffa', players: 3, seats: [human(BOB, bob), { id: BOT, ai: true, habits: bot, ending: 'Eliminated' }] }), {});
    const h = await readProfileHistory(dir, [BOB, BOT], {}, {});
    if (typeof h !== 'object') throw new Error();
    expect(h.players.has(BOT)).toBe(false);
    expect(h.pools.ai).toEqual(bot);
    expect(h.pools.byFormat.ffa).toEqual(bob);
    const salt = (await playerRecordSalt(dir))!;
    const stored = JSON.parse(readFileSync(profilePlayersPath(dir), 'utf8'));
    expect(Object.keys(stored.players)).toEqual([playerKey(salt, BOB)]);
  });

  it('keeps the newest entries per player and the most recently updated players', async () => {
    const dir = tmp();
    for (let g = 1; g <= MAX_PROFILE_ENTRIES + 1; g++) await foldGame(dir, fold({ gameId: g, seats: [human(BOB, habits([1, 1]))] }), {});
    const stored = JSON.parse(readFileSync(profilePlayersPath(dir), 'utf8'));
    const salt = (await playerRecordSalt(dir))!;
    expect(stored.players[playerKey(salt, BOB)].entries).toHaveLength(MAX_PROFILE_ENTRIES);
    expect((await history(dir, BOB)).players.get(BOB)!.games).toBe(MAX_PROFILE_ENTRIES + 1);

    const many = Array.from({ length: MAX_PROFILE_PLAYERS }, (_, i) => human(1_000_000 + i, habits([0, 1])));
    const dir2 = tmp();
    await foldGame(dir2, fold({ format: 'ffa', players: many.length + 1, seats: many }), {});
    await foldGame(dir2, fold({ gameId: GAME2, seats: [human(BOB, habits([1, 1]))] }), {});
    const h = await readProfileHistory(dir2, [1_000_000, 1_000_001, BOB], {}, {});
    if (typeof h !== 'object') throw new Error();
    expect([...h.players.keys()].sort()).toEqual([1_000_001, BOB].sort());
  }, 30_000);

  it('never overwrites a corrupt store or salt: reads say unreadable and folds fail', async () => {
    for (const bad of ['players', 'population', 'salt'] as const) {
      const dir = tmp();
      await foldGame(dir, fold({ seats: [human(BOB, habits([1, 1]))] }), {});
      const path = bad === 'players' ? profilePlayersPath(dir) : bad === 'population' ? profilePopulationPath(dir) : playerRecordSaltPath(dir);
      writeFileSync(path, '{not json');
      expect(await foldGame(dir, fold({ gameId: GAME2, seats: [human(BOB, habits([1, 1]))] }), {})).toBe('failed');
      expect(readFileSync(path, 'utf8')).toBe('{not json');
      expect(await readProfileHistory(dir, [BOB], {}, {})).toBe('unreadable');
    }
  });

  it('refuses a store at another version, and reads malformed parts of a version-1 store loosely (dropped, then written back without them)', async () => {
    const dir = tmp();
    await foldGame(dir, fold({ seats: [human(BOB, habits([1, 1]))] }), {});
    const other = JSON.stringify({ ...JSON.parse(readFileSync(profilePlayersPath(dir), 'utf8')), version: 2 });
    writeFileSync(profilePlayersPath(dir), other);
    expect(await foldGame(dir, fold({ gameId: GAME2, seats: [human(BOB, habits([1, 1]))] }), {})).toBe('failed');
    expect(readFileSync(profilePlayersPath(dir), 'utf8')).toBe(other);

    const dir2 = tmp();
    await foldGame(dir2, fold({ seats: [human(BOB, habits([1, 1]))] }), {});
    const stored = JSON.parse(readFileSync(profilePlayersPath(dir2), 'utf8'));
    const pk = Object.keys(stored.players)[0]!;
    stored.players[pk].entries = 'not an array';
    stored.players['f'.repeat(32)] = { seq: 'x' };
    writeFileSync(profilePlayersPath(dir2), JSON.stringify(stored));
    expect(await foldGame(dir2, fold({ gameId: GAME2, seats: [human(BOB, habits([1, 1]))] }), {})).toBe('folded');
    const after = JSON.parse(readFileSync(profilePlayersPath(dir2), 'utf8'));
    expect(Object.keys(after.players)).toEqual([pk]);
  });

  it('reads an empty history before anything is folded, and writes no salt for a read', async () => {
    const dir = tmp();
    const h = await history(dir, BOB);
    expect(h.players.size).toBe(0);
    expect(h.pools.games).toBe(0);
    expect(existsSync(playerRecordSaltPath(dir))).toBe(false);
  });

  it('does nothing when profiling is off', async () => {
    const dir = tmp();
    const off = { WARAPP_PLAYER_PROFILE: 'off' };
    expect(await foldGame(dir, fold({ seats: [human(BOB, habits([1, 1]))] }), off)).toBe('off');
    expect(existsSync(profilePlayersPath(dir))).toBe(false);
    expect(await readProfileHistory(dir, [BOB], {}, off)).toBe('off');
  });

  it('shares one salt with the deal record, so the keys join', async () => {
    const dir = tmp();
    await updatePlayerRecord(dir, BOB, () => ({ delta: { ...ZERO_COUNTS }, entries: [] }), {});
    const salt = (await playerRecordSalt(dir))!;
    await foldGame(dir, fold({ seats: [human(BOB, habits([1, 1]))] }), {});
    expect(await playerRecordSalt(dir)).toBe(salt);
    expect(Object.keys(JSON.parse(readFileSync(profilePlayersPath(dir), 'utf8')).players)).toEqual([playerKey(salt, BOB)]);
  });
});

// ---- the per-game file and the fold triggers ----

const g = buildGraph(tinyMap());
const SMALL_ME = ME;
const SMALL_OPP = BOB;
const SMALL_BOT = BOT;
function boards(): TurnBoard[] {
  const out: TurnBoard[] = [];
  for (let t = 1; t <= 4; t++)
    out.push({
      turn: t,
      board: board([neutral(1, 2), mine(2, 3, SMALL_BOT), mine(3, 5), mine(4, 2 + t, SMALL_OPP), mine(5, 2, SMALL_OPP)]),
      orders: { deploys: [], moves: [], cards: [] },
    });
  return out;
}
const player = (id: number, name: string, state: string, more: Partial<Game['players'][number]> = {}) => ({
  id,
  name,
  state,
  isAI: false,
  humanTurnedIntoAI: false,
  hasCommittedOrders: false,
  ...more,
});
const finished = (state = 'Finished', more: { turnedAI?: boolean } = {}): Game => ({
  id: GAME,
  name: 'Secret Game Name',
  state,
  players: [
    player(SMALL_ME, 'Zebulon Me', 'Won'),
    player(SMALL_OPP, 'Quixotic Rival', 'Eliminated', more.turnedAI ? { humanTurnedIntoAI: true } : {}),
    player(SMALL_BOT, 'Robo Seat', 'Eliminated', { isAI: true }),
  ],
});
async function recorded(dir: string) {
  await recordBehaviour(
    dir,
    {
      gameId: GAME,
      me: SMALL_ME,
      graph: g,
      settings: {},
      cards: [],
      opponents: [SMALL_OPP, SMALL_BOT],
      boards: boards(),
      seats: { format: 'ffa', players: 3, ai: [SMALL_BOT], turnedAI: [] },
    },
    {},
  );
}

describe('foldFinishedGame', () => {
  it('folds a finished game once, marks the per-game file folded, and keeps no id or name in either store', async () => {
    const dir = tmp();
    await recorded(dir);
    expect(await foldFinishedGame(dir, finished('Playing'), {})).toBe(0);
    expect(existsSync(profilePlayersPath(dir))).toBe(false);
    expect(await foldFinishedGame(dir, finished(), {})).toBe(1);
    expect(JSON.parse(readFileSync(profileGamePath(dir, GAME, SMALL_ME), 'utf8')).folded).toBe('live');
    const players = readFileSync(profilePlayersPath(dir), 'utf8');
    const population = readFileSync(profilePopulationPath(dir), 'utf8');
    const h = await readProfileHistory(dir, [SMALL_OPP, SMALL_BOT], {}, {});
    if (typeof h !== 'object') throw new Error();
    expect(h.players.get(SMALL_OPP)!.games).toBe(1);
    expect(h.players.get(SMALL_OPP)!.past.turns).toBe(3);
    expect(h.players.has(SMALL_BOT)).toBe(false);
    expect(h.pools.ai.turns).toBe(3);
    const entry = JSON.parse(players).players[Object.keys(JSON.parse(players).players)[0]!].entries[0];
    expect(entry).toMatchObject({ format: 'ffa', players: 3, turnsSeen: 3, source: 'live', ending: 'Eliminated' });
    // Folded already: a second read of the finished game changes nothing.
    expect(await foldFinishedGame(dir, finished(), {})).toBe(0);
    expect(readFileSync(profilePlayersPath(dir), 'utf8')).toBe(players);
    for (const text of [players, population])
      for (const needle of [String(SMALL_ME), String(SMALL_OPP), String(SMALL_BOT), String(GAME), 'Zebulon', 'Quixotic', 'Robo', 'Secret'])
        expect(text).not.toContain(needle);
  });

  it('leaves a human who became an AI out of the game altogether', async () => {
    const dir = tmp();
    await recorded(dir);
    await foldFinishedGame(dir, finished('Finished', { turnedAI: true }), {});
    const h = await readProfileHistory(dir, [SMALL_OPP], {}, {});
    if (typeof h !== 'object') throw new Error();
    expect(h.players.has(SMALL_OPP)).toBe(false);
    expect(h.pools.byFormat.ffa).toBeUndefined();
    expect(h.pools.ai.turns).toBe(3);
  });

  it('folds and deletes a per-game file untouched past the age limit, its ending unknown', async () => {
    const dir = tmp();
    await recorded(dir);
    const path = profileGamePath(dir, GAME, SMALL_ME);
    const old = (Date.now() - BOARD_CACHE_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(path, old, old);
    // Any later write prunes.
    await recordBehaviour(dir, { gameId: GAME2, me: SMALL_ME, graph: g, settings: {}, cards: [], opponents: [SMALL_OPP], boards: boards() }, {});
    expect(existsSync(path)).toBe(false);
    const stored = JSON.parse(readFileSync(profilePlayersPath(dir), 'utf8'));
    const entries = Object.values(stored.players as Record<string, { entries: { ending?: string }[] }>).flatMap((p) => p.entries);
    expect(entries.map((e) => e.ending)).toEqual(['unknown']);
    expect(statSync(profileGamePath(dir, GAME2, SMALL_ME)).isFile()).toBe(true);
  });

  it('keeps the recorded team format when the finished read carries no team field', async () => {
    const dir = tmp();
    const MATE = 5544332211;
    await recordBehaviour(
      dir,
      {
        gameId: GAME,
        me: SMALL_ME,
        graph: g,
        settings: {},
        cards: [],
        opponents: [SMALL_OPP, SMALL_BOT],
        boards: boards(),
        seats: { format: 'team', players: 4, ai: [SMALL_BOT], turnedAI: [] },
      },
      {},
    );
    // GameFeed's team field is unverified: this read sends none, so the raw seats would say `ffa`.
    const raw: Game = { ...finished(), players: [...finished().players, player(MATE, 'Mate Seat', 'Won')] };
    expect(await foldFinishedGame(dir, raw, {})).toBe(1);
    const stored = JSON.parse(readFileSync(profilePlayersPath(dir), 'utf8'));
    const entries = Object.values(stored.players as Record<string, { entries: { format: string; players: number }[] }>).flatMap((p) => p.entries);
    expect(entries).toEqual([expect.objectContaining({ format: 'team', players: 4 })]);
    const population = JSON.parse(readFileSync(profilePopulationPath(dir), 'utf8'));
    expect(Object.keys(population.totals)).toEqual(['team']);
    expect(JSON.parse(readFileSync(profileGamePath(dir, GAME, SMALL_ME), 'utf8')).seats).toMatchObject({ format: 'team', players: 4 });
  });

  it('does nothing when profiling is off', async () => {
    const dir = tmp();
    await recorded(dir);
    expect(await foldFinishedGame(dir, finished(), { WARAPP_PLAYER_PROFILE: 'off' })).toBe(0);
    expect(existsSync(profilePlayersPath(dir))).toBe(false);
  });
});
