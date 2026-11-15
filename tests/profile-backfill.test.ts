// #264: a game that finished before per-game profile files were kept (#263) still has its boards (and
// my orders) in the board cache. The first read that shows it finished — warapp_get_game, or
// warapp_profile_opponents on it — observes those boards once and folds them (a backfill), with no
// request beyond the GameFeed read; teammates never, unknown teams never, never twice. Synthetic
// three-player game on the anonymized lobby fixture's map (the boards of
// tests/profile-opponents-tools.test.ts): Bob reinforces every territory I attack, Cat never does.
import { existsSync, readFileSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { MyOrders } from '../src/analysis/opponents.js';
import type { BoardState } from '../src/board.js';
import { normalizeMap } from '../src/normalize.js';
import { profileGamePath, profilePlayersPath, profilePopulationPath, readProfileHistory, recordBehaviour } from '../src/profile-store.js';
import { graphOf } from '../src/tools/common.js';
import { NOTHING_TO_FOLD } from '../src/tools/profile-hook.js';
import { writeTeamRecord } from '../src/tools/team-source.js';
import { boardCachePath, writeBoardCache, writeOrdersCache } from '../src/trend.js';
import { liveHarness, lobbyFixture, payload, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
const ME = 3312345644;
const BOB = 7176543229;
const CAT = 5524681355;

/** The game as GameFeed shows it: `Finished` (I won) or in progress; with `teams`, Ann and Bob on team 0. */
function game(state: 'Finished' | 'Playing', o: { teams?: boolean; noMap?: boolean } = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const ids = [ME, BOB, CAT];
  const players = (f.players as Array<Record<string, string>>).slice(0, 3).map((p, i) => ({
    ...p,
    id: String(ids[i]),
    name: ['Ann', 'Bob', 'Cat'][i]!,
    state: state === 'Playing' ? 'Playing' : i === 0 ? 'Won' : i === 1 ? 'SurrenderAccepted' : 'Eliminated',
    ...(o.teams ? { team: i < 2 ? '0' : '1' } : {}),
  }));
  const { map: _map, ...rest } = f as Record<string, unknown>;
  return { ...(o.noMap ? rest : f), id: String(GAME), state, numberOfTurns: '6', players };
}

// As in tests/profile-opponents-tools.test.ts: I attack Bob's 158 from 161 and Cat's 135 from 159 each turn.
const CAT_135 = [4, 3, 2, 1];
const ANN_159 = [20, 18, 16, 15, 13];
function board(turn: number): BoardState {
  const t = (territoryId: number, playerId: number, armies: number) => ({ territoryId, owner: { kind: 'player' as const, playerId }, armies });
  const cat = turn <= 4 ? t(135, CAT, CAT_135[turn - 1]!) : t(135, ME, 1);
  return { source: 'browser', verified: true, territories: [t(161, ME, 6), t(158, BOB, 2), t(159, ME, ANN_159[turn - 1]!), cat] };
}
const orders = (): MyOrders => ({
  deploys: [{ territoryId: 161, armies: 4 }],
  moves: [
    { from: 161, to: 158, armies: 5 },
    { from: 159, to: 135, armies: 2 },
  ],
  cards: [],
});

/** The board cache a game played before #263 left: turns 1–5 with my orders on 1–4, written `daysAgo` days ago. */
async function cache(dir: string, daysAgo = 3): Promise<void> {
  for (let t = 1; t <= 5; t++) await writeBoardCache(dir, GAME, ME, t, board(t));
  for (let t = 1; t <= 4; t++) await writeOrdersCache(dir, GAME, ME, t, orders());
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  utimesSync(boardCachePath(dir, GAME), at, at);
}

interface Fold {
  status: string;
  source?: string;
  reason?: string;
  note?: string;
  opponents?: { id: number; turns: number }[];
}
const getGame = async (hh: Harness) => payload<{ game: { id: number }; profileFold?: Fold }>(await hh.call('warapp_get_game', { game_id: GAME }));
const past = async (dir: string, id: number) => {
  const r = await readProfileHistory(dir, [id], {}, {});
  if (typeof r !== 'object') throw new Error(String(r));
  return r.players.get(id);
};

describe('the backfill of a finished game (#264)', () => {
  it('warapp_get_game observes the cached boards once and folds them, marked as a backfill', async () => {
    h = await liveHarness({ feed: [game('Finished')] });
    const dir = h.dataDir;
    await cache(dir, 10);
    // A free-for-all, as the kept team record says (no game list is read).
    await writeTeamRecord(dir, GAME, new Map());
    const r = await getGame(h);
    expect(r.profileFold).toEqual({ status: 'folded', source: 'backfill', opponents: [{ id: CAT, turns: 4 }, { id: BOB, turns: 4 }].sort((a, b) => a.id - b.id) });
    const file = JSON.parse(readFileSync(profileGamePath(dir, GAME, ME), 'utf8')) as { folded?: string; backfill?: boolean; turns: object };
    expect(file).toMatchObject({ folded: 'live', backfill: true });
    expect(Object.keys(file.turns)).toEqual(['1', '2', '3', '4']);
    expect(await past(dir, BOB)).toMatchObject({ games: 1, past: { reinforce: { e: 4, n: 4 }, turns: 4 } });
    expect(await past(dir, CAT)).toMatchObject({ games: 1, past: { reinforce: { e: 0, n: 4 } } });
    const text = readFileSync(profilePlayersPath(dir), 'utf8');
    expect(text).toContain('"ending":"SurrenderAccepted"');
    for (const id of [ME, BOB, CAT, GAME]) expect(text).not.toContain(String(id));
    // The file ages with the board cache it came from: it is deleted when the board cache would be.
    expect(Math.abs(statSync(profileGamePath(dir, GAME, ME)).mtimeMs - statSync(boardCachePath(dir, GAME)).mtimeMs)).toBeLessThan(1000);
    // Once only: a second read finds it folded and changes nothing.
    const stores = [readFileSync(profilePlayersPath(dir), 'utf8'), readFileSync(profilePopulationPath(dir), 'utf8')];
    expect((await getGame(h)).profileFold).toEqual({ status: 'already-folded' });
    expect([readFileSync(profilePlayersPath(dir), 'utf8'), readFileSync(profilePopulationPath(dir), 'utf8')]).toEqual(stores);
  });

  it('never folds it twice, even once the per-game file is gone', async () => {
    h = await liveHarness({ feed: [game('Finished')] });
    const dir = h.dataDir;
    await cache(dir);
    await writeTeamRecord(dir, GAME, new Map());
    expect((await getGame(h)).profileFold?.status).toBe('folded');
    // The file bound (or the age rule) removed the file; the board cache is still there.
    unlinkSync(profileGamePath(dir, GAME, ME));
    expect((await getGame(h)).profileFold).toEqual({ status: 'already-folded' });
    expect(existsSync(profileGamePath(dir, GAME, ME))).toBe(false);
    expect(await past(dir, BOB)).toMatchObject({ games: 1, past: { reinforce: { e: 4, n: 4 } } });
  });

  it('never folds a teammate: with GameFeed putting Bob on my team, only Cat is folded', async () => {
    h = await liveHarness({ feed: [game('Finished', { teams: true })] });
    const dir = h.dataDir;
    await cache(dir);
    expect((await getGame(h)).profileFold).toEqual({ status: 'folded', source: 'backfill', opponents: [{ id: CAT, turns: 4 }] });
    expect(await past(dir, BOB)).toBeUndefined();
    expect(await past(dir, CAT)).toMatchObject({ games: 1 });
    expect(readFileSync(profileGamePath(dir, GAME, ME), 'utf8')).not.toContain(String(BOB));
  });

  it('folds nothing while the teams cannot be known without a request, and says counts start with this build', async () => {
    h = await liveHarness({ feed: [game('Finished')] });
    const dir = h.dataDir;
    await cache(dir);
    const r = await getGame(h);
    expect(r.profileFold).toEqual({ status: 'nothing', reason: 'teams-unknown', note: NOTHING_TO_FOLD });
    expect(NOTHING_TO_FOLD).toMatch(/counts start with games played on this build/);
    expect(existsSync(profileGamePath(dir, GAME, ME))).toBe(false);
    expect(existsSync(profilePlayersPath(dir))).toBe(false);
  });

  it('says so when no board of the game is cached, or none pair up into a turn', async () => {
    h = await liveHarness({ feed: [game('Finished')] });
    expect((await getGame(h)).profileFold).toMatchObject({ status: 'nothing', reason: 'no-boards' });
    await writeBoardCache(h.dataDir, GAME, ME, 3, board(3));
    await writeTeamRecord(h.dataDir, GAME, new Map());
    expect((await getGame(h)).profileFold).toMatchObject({ status: 'nothing', reason: 'no-turns', note: NOTHING_TO_FOLD });
    expect(existsSync(profilePlayersPath(h.dataDir))).toBe(false);
  });

  it('reports nothing and writes nothing with WARAPP_PLAYER_PROFILE=off, or for a game in progress', async () => {
    h = await liveHarness({ feed: [game('Finished')], env: { WARAPP_PLAYER_PROFILE: 'off' } });
    await cache(h.dataDir);
    await writeTeamRecord(h.dataDir, GAME, new Map());
    expect((await getGame(h)).profileFold).toBeUndefined();
    expect(existsSync(profileGamePath(h.dataDir, GAME, ME))).toBe(false);
    expect(existsSync(profilePlayersPath(h.dataDir))).toBe(false);
    await h.harness.close();
    h = await liveHarness({ feed: [game('Playing')] });
    await cache(h.dataDir);
    await writeTeamRecord(h.dataDir, GAME, new Map());
    expect((await getGame(h)).profileFold).toBeUndefined();
    expect(existsSync(profilePlayersPath(h.dataDir))).toBe(false);
  });

  it('a game whose per-game file was kept while it was played folds that file (live), not its boards', async () => {
    h = await liveHarness({ feed: [game('Playing'), game('Finished')] });
    const dir = h.dataDir;
    await cache(dir);
    await writeTeamRecord(dir, GAME, new Map());
    // Turn 1 and 2 only, kept while it was played.
    const graph = graphOf(normalizeMap(game('Playing').map));
    const boards = [1, 2, 3].map((t) => ({ turn: t, board: board(t), ...(t < 3 ? { orders: orders() } : {}) }));
    await recordBehaviour(dir, { gameId: GAME, me: ME, graph, settings: {}, opponents: [BOB, CAT], boards }, {});
    await getGame(h); // Playing: nothing.
    const r = await getGame(h);
    expect(r.profileFold).toEqual({ status: 'folded', source: 'live', opponents: [{ id: CAT, turns: 2 }, { id: BOB, turns: 2 }].sort((a, b) => a.id - b.id) });
    expect(JSON.parse(readFileSync(profileGamePath(dir, GAME, ME), 'utf8')).backfill).toBeUndefined();
  });
});

describe('warapp_profile_opponents on a finished game (#264)', () => {
  interface Finished {
    game: { id: number; state: string };
    profile: string;
    fold: Fold;
    opponents?: unknown;
  }
  const profile = async (hh: Harness) => payload<Finished>(await hh.call('warapp_profile_opponents', { game_id: GAME }));

  it('folds it instead of refusing, reporting what was folded, and asks the bridge nothing', async () => {
    h = await liveHarness({
      feed: [game('Finished')],
      warapp: () => {
        throw new Error('the bridge must not be asked');
      },
    });
    await cache(h.dataDir);
    await writeTeamRecord(h.dataDir, GAME, new Map());
    const p = await profile(h);
    expect(p.game).toMatchObject({ id: GAME, state: 'Finished' });
    expect(p.profile).toBe('kept');
    expect(p.fold).toMatchObject({ status: 'folded', source: 'backfill' });
    expect(p.fold.opponents!.map((o) => o.id).sort()).toEqual([BOB, CAT].sort());
    expect((await profile(h)).fold).toEqual({ status: 'already-folded' });
  });

  it('says counts start with games played on this build when nothing can be folded', async () => {
    h = await liveHarness({ feed: [game('Finished')] });
    const p = await profile(h);
    expect(p.fold).toEqual({ status: 'nothing', reason: 'no-boards', note: NOTHING_TO_FOLD });
  });

  it('with profiling off says so and folds nothing', async () => {
    h = await liveHarness({ feed: [game('Finished')], env: { WARAPP_PLAYER_PROFILE: 'off' } });
    await cache(h.dataDir);
    await writeTeamRecord(h.dataDir, GAME, new Map());
    const p = await profile(h);
    expect(p.profile).toBe('off');
    expect(p.fold).toEqual({ status: 'off' });
    expect(existsSync(profilePlayersPath(h.dataDir))).toBe(false);
  });

  it('still refuses a game neither being played nor finished', async () => {
    const lobby = { ...game('Playing'), state: 'WaitingForPlayers' };
    h = await liveHarness({ feed: [lobby] });
    const r = await h.call('warapp_profile_opponents', { game_id: GAME });
    expect(r.isError).toBe(true);
  });
});
