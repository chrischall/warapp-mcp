// Where a game's teams come from (docs/PLAN-TEAMS.md "Team source"): GameFeed's player team (UNVERIFIED, V1),
// else — in a game of more than two seats where no player carries one — GetMyGames' GameInfoPlayer team, asked
// once per game and kept name-free at <dataDir>/teams/<gameId>.json. Every tool that decides teams uses it.
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { MAX_TEAM_RECORDS, readTeamRecord, TEAM_RECORD_VERSION, teamRecordPath, writeTeamRecord } from '../src/tools/team-source.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';
import { writeMyGamesReturn } from './protocol/my-games-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
// Synthetic GameFeed ids: the in-game id wrapped in two check digits each end.
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const CY = { feed: '5522222211', inGame: 222222 };
const DEE = { feed: '6633333322', inGame: 333333 };
const ME_PAGE = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };

/** Four seats (or the first `seats`), with GameFeed's team on each only when `teams`. */
function game(opts: { teams?: boolean; seats?: number } = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const base = { isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Playing' };
  const team = (t: string) => (opts.teams ? { team: t } : {});
  const players = [
    { ...base, id: ANN.feed, name: 'Ann', ...team('0') },
    { ...base, id: BOB.feed, name: 'Bob', ...team('0') },
    { ...base, id: CY.feed, name: 'Cy', ...team('1') },
    { ...base, id: DEE.feed, name: 'Dee', ...team('1') },
  ].slice(0, opts.seats ?? 4);
  const settings = { ...(f.settings as Record<string, unknown>), SanctionsCard: 'none' };
  return { ...f, id: String(GAME), state: 'Playing', numberOfTurns: '2', players, settings };
}

// Ann holds 159 and 161; Bob, her teammate by the game list, holds 157 and 158 beside them.
const BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 2, owner: BOB.inGame, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 7 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

const LIST_TEAMS = [
  { id: ANN.inGame, name: 'Ann', state: 2, committed: false, team: 4 },
  { id: BOB.inGame, name: 'Bob', state: 2, committed: false, team: 4 },
  { id: CY.inGame, name: 'Cy', state: 2, committed: false, team: 5 },
  { id: DEE.inGame, name: 'Dee', state: 2, committed: false, team: 5 },
];

type Reply = (req: DecodedRequest, n: number) => Partial<ReplyFrame>;
function server(myGames: Reply | 'fail' = () => ({ body: (w) => writeMyGamesReturn(w, [{ id: GAME, name: 'synthetic', lastTurn: 2, state: 3, players: LIST_TEAMS }]) })) {
  return (req: DecodedRequest, n: number): Partial<ReplyFrame> => {
    if (req.method === Method.GetLatestGameInfo) return { body: (w) => writeLatestGameInfo(w, BOARD, [ANN.inGame, BOB.inGame]) };
    if (req.method === Method.GetMyGames) {
      if (myGames === 'fail') throw new Error('game list unavailable');
      return myGames(req, n);
    }
    throw new Error(`unexpected method ${req.method}`);
  };
}
const listReads = () => h!.exchanges.filter((e) => e.request.method === Method.GetMyGames).length;

interface PlanView {
  teamSource?: string;
  team?: { sharedBonuses: unknown[] };
  moves: Array<{ to: { id: number }; kind: string }>;
  warnings: string[];
}

describe('team source: GetMyGames when GameFeed sends no team', () => {
  it('plan_turn treats the teammate the game list names as a teammate, not a target, and asks the list once', async () => {
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: server() });
    const p = payload<PlanView>(await h.call('warapp_plan_turn', { game_id: GAME }));
    expect(p.teamSource).toBe('my-games');
    // Bob's 157 is in the bonus I am building: shared with a teammate, never attacked.
    expect(p.team?.sharedBonuses.length).toBeGreaterThan(0);
    expect(p.moves.filter((m) => (m.to.id === 157 || m.to.id === 158) && m.kind === 'attack')).toEqual([]);
    expect(listReads()).toBe(1);
    // Kept name-free: in-game ids and team numbers only.
    const kept = readFileSync(teamRecordPath(h.dataDir, GAME), 'utf8');
    expect(JSON.parse(kept)).toEqual({
      version: TEAM_RECORD_VERSION,
      gameId: GAME,
      teams: [
        [ANN.inGame, 4],
        [CY.inGame, 5],
        [DEE.inGame, 5],
        [BOB.inGame, 4],
      ],
    });
    expect(kept).not.toMatch(/Ann|Bob|Cy|Dee/);
    // The second plan reads the kept teams: no second request.
    const again = payload<PlanView>(await h.call('warapp_plan_turn', { game_id: GAME }));
    expect(again.teamSource).toBe('my-games');
    expect(listReads()).toBe(1);
  });

  it('without the game list the same board plans Bob as an opponent (the control)', async () => {
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: server('fail') });
    const p = payload<PlanView>(await h.call('warapp_plan_turn', { game_id: GAME }));
    expect(p).not.toHaveProperty('teamSource');
    expect(p).not.toHaveProperty('team');
    // A failed read is not kept: the next call asks again.
    expect(existsSync(teamRecordPath(h.dataDir, GAME))).toBe(false);
    await h.call('warapp_plan_turn', { game_id: GAME });
    expect(listReads()).toBe(2);
  });

  it("submit_turn's teammate set comes from the list: a move into Bob's land is a transfer, not an attack", async () => {
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: server() });
    const res = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [
        { kind: 'deploy', territory: 159, armies: 5 },
        { kind: 'move', from: 159, to: 158, armies: 1 },
      ],
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    const preview = payload<{ preview: { attacks?: unknown[] } }>(res);
    expect(preview.preview.attacks ?? []).toEqual([]);
    expect(JSON.stringify(preview)).not.toMatch(/cannot capture/);
  });

  it('submit_turn without the game list reads the same move into Bob\'s land as an attack (the control)', async () => {
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: server('fail') });
    const res = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [
        { kind: 'deploy', territory: 159, armies: 5 },
        { kind: 'move', from: 159, to: 158, armies: 1 },
      ],
    });
    expect(res.isError, textOf(res)).toBeFalsy();
    const preview = payload<{ preview: { attacks?: unknown[] } }>(res);
    expect((preview.preview.attacks ?? []).length).toBeGreaterThan(0);
  });

  it('check_plan reports the source and counts no teammate as an opponent', async () => {
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: server() });
    const p = payload<{ teamSource?: string }>(
      await h.call('warapp_check_plan', { game_id: GAME, orders: [{ kind: 'deploy', territory: 159, armies: 5 }] }),
    );
    expect(p.teamSource).toBe('my-games');
  });

  it('advise_diplomacy refuses a team game the list names, and record_agreement refuses a teammate as partner', async () => {
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: server() });
    const advice = await h.call('warapp_advise_diplomacy', { game_id: GAME });
    expect(advice.isError).toBe(true);
    expect(textOf(advice)).toMatch(/this is a team game/);
    const rec = await h.call('warapp_record_agreement', { game_id: GAME, with: 'Bob', status: 'agreed' });
    expect(rec.isError).toBe(true);
    expect(textOf(rec)).toMatch(/is your teammate/);
    // Both read the kept teams after the first: one request in all.
    expect(listReads()).toBe(1);
  });

  it('a seat refusal asks no game list: an eliminated player, or one not in the game', async () => {
    const out = game();
    (out.players as Array<Record<string, string>>)[0]!.state = 'Eliminated';
    h = await liveHarness({ feed: [out], pages: ME_PAGE, warapp: server() });
    const advice = await h.call('warapp_advise_diplomacy', { game_id: GAME });
    expect(advice.isError).toBe(true);
    expect(textOf(advice)).toMatch(/no longer playing/);
    for (const tool of ['warapp_track_opponents', 'warapp_locate_opponents', 'warapp_get_relations']) {
      const res = await h.call(tool, { game_id: GAME, player: 'Nobody' });
      expect(res.isError, tool).toBe(true);
    }
    expect(listReads()).toBe(0);
  });

  it('GameFeed with teams: the game list is never asked', async () => {
    h = await liveHarness({ feed: [game({ teams: true })], pages: ME_PAGE, warapp: server() });
    const p = payload<PlanView>(await h.call('warapp_plan_turn', { game_id: GAME }));
    expect(p.teamSource).toBe('gamefeed');
    expect(listReads()).toBe(0);
    expect(existsSync(teamRecordPath(h.dataDir, GAME))).toBe(false);
  });

  it('a 1v1: the game list is never asked', async () => {
    h = await liveHarness({ feed: [game({ seats: 2 })], pages: ME_PAGE, warapp: server() });
    const p = payload<PlanView>(await h.call('warapp_plan_turn', { game_id: GAME }));
    expect(p).not.toHaveProperty('teamSource');
    expect(listReads()).toBe(0);
  });

  it('a free-for-all the list shows without teams is kept as such: asked once, never a team game', async () => {
    const ffa = LIST_TEAMS.map(({ team: _team, ...p }) => p);
    h = await liveHarness({
      feed: [game()],
      pages: ME_PAGE,
      warapp: server(() => ({ body: (w) => writeMyGamesReturn(w, [{ id: GAME, name: 'synthetic', lastTurn: 2, state: 3, players: ffa }]) })),
    });
    expect(payload<PlanView>(await h.call('warapp_plan_turn', { game_id: GAME }))).not.toHaveProperty('teamSource');
    expect(payload<PlanView>(await h.call('warapp_plan_turn', { game_id: GAME }))).not.toHaveProperty('teamSource');
    expect(listReads()).toBe(1);
    expect(await readTeamRecord(h.dataDir, GAME)).toEqual(new Map());
  });

  it('a lobby read is not kept: once the game starts with a fourth player, the list is asked again and gives them their team', async () => {
    const lobby = { ...game({ seats: 3 }), state: 'WaitingForPlayers', numberOfTurns: '-1' };
    const listed = (players: typeof LIST_TEAMS, state: number) => ({
      body: (w: Parameters<NonNullable<ReplyFrame['body']>>[0]) => writeMyGamesReturn(w, [{ id: GAME, name: 'synthetic', lastTurn: 2, state, players }]),
    });
    let asked = 0;
    h = await liveHarness({
      feed: [lobby, game()],
      pages: ME_PAGE,
      // The first read (the lobby) lists the three players seated so far; later reads list all four.
      warapp: server(() => (++asked === 1 ? listed(LIST_TEAMS.slice(0, 3), 1) : listed(LIST_TEAMS, 3))),
    });
    const first = await h.call('warapp_get_team', { game_id: GAME });
    expect(first.isError, textOf(first)).toBeFalsy();
    expect(existsSync(teamRecordPath(h.dataDir, GAME))).toBe(false);
    const started = payload<{ team: { source: string }; opponents: Array<{ id: number; team: number | null }> }>(
      await h.call('warapp_get_team', { game_id: GAME }),
    );
    expect(listReads()).toBe(2);
    expect(started.team.source).toBe('my-games');
    expect(started.opponents.find((o) => o.id === Number(DEE.feed))?.team).toBe(5);
    expect(await readTeamRecord(h.dataDir, GAME)).toEqual(new Map(LIST_TEAMS.map((p) => [p.id, p.team])));
  });

  it('a kept record that lacks a seated player is not trusted: the list is asked again', async () => {
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: server() });
    await writeTeamRecord(h.dataDir, GAME, new Map(LIST_TEAMS.slice(0, 3).map((p) => [p.id, p.team])));
    const p = payload<{ opponents: Array<{ id: number; team: number | null }> }>(await h.call('warapp_get_team', { game_id: GAME }));
    expect(listReads()).toBe(1);
    expect(p.opponents.find((o) => o.id === Number(DEE.feed))?.team).toBe(5);
    expect((await readTeamRecord(h.dataDir, GAME))?.get(DEE.inGame)).toBe(5);
  });

  it('a list that does not hold the game is not kept: teams unknown, asked again next time', async () => {
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: server(() => ({ body: (w) => writeMyGamesReturn(w, []) })) });
    await h.call('warapp_plan_turn', { game_id: GAME });
    await h.call('warapp_plan_turn', { game_id: GAME });
    expect(listReads()).toBe(2);
    expect(existsSync(teamRecordPath(h.dataDir, GAME))).toBe(false);
  });
});

describe('team source: the game list is checked before it is trusted', () => {
  const listed = (players: Array<{ id: number; name: string; state: number; committed: boolean; team?: number }>) => () => ({
    body: (w: Parameters<NonNullable<ReplyFrame['body']>>[0]) => writeMyGamesReturn(w, [{ id: GAME, name: 'synthetic', lastTurn: 2, state: 3, players }]),
  });

  it('every seat on one team is not trusted: teams unknown, nothing kept, asked again', async () => {
    const oneTeam = LIST_TEAMS.map((p) => ({ ...p, team: 4 }));
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: server(listed(oneTeam)) });
    expect(payload<PlanView>(await h.call('warapp_plan_turn', { game_id: GAME }))).not.toHaveProperty('teamSource');
    expect(existsSync(teamRecordPath(h.dataDir, GAME))).toBe(false);
    await h.call('warapp_plan_turn', { game_id: GAME });
    expect(listReads()).toBe(2);
  });

  it('one team among the seats, the rest without one, is not trusted either', async () => {
    const partial = LIST_TEAMS.map((p, i) => (i < 2 ? p : { ...p, team: undefined }));
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: server(listed(partial)) });
    const res = await h.call('warapp_get_team', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(await readTeamRecord(h.dataDir, GAME)).toBeUndefined();
  });

  it('a seat the list leaves out: teams unknown, and the list is asked again at most once per turn', async () => {
    const turn = (n: number) => ({ ...game(), numberOfTurns: String(n) });
    h = await liveHarness({ feed: [turn(2), turn(2), turn(3)], pages: ME_PAGE, warapp: server(listed(LIST_TEAMS.slice(0, 3))) });
    expect((await h.call('warapp_get_team', { game_id: GAME })).isError).toBe(true);
    expect(listReads()).toBe(1);
    // No teams are kept, only the marker that the list left a seat out on this turn.
    expect(await readTeamRecord(h.dataDir, GAME)).toBeUndefined();
    expect(JSON.parse(readFileSync(teamRecordPath(h.dataDir, GAME), 'utf8'))).toEqual({
      version: TEAM_RECORD_VERSION,
      gameId: GAME,
      incompleteTurn: 2,
    });
    // Same turn: not asked again.
    expect((await h.call('warapp_get_team', { game_id: GAME })).isError).toBe(true);
    expect(listReads()).toBe(1);
    // The next turn asks once more.
    expect((await h.call('warapp_get_team', { game_id: GAME })).isError).toBe(true);
    expect(listReads()).toBe(2);
    expect(JSON.parse(readFileSync(teamRecordPath(h.dataDir, GAME), 'utf8')).incompleteTurn).toBe(3);
  });

  it('a seat the list leaves out once, then lists: the marker yields to the full answer on a later turn', async () => {
    let asked = 0;
    const turn = (n: number) => ({ ...game(), numberOfTurns: String(n) });
    h = await liveHarness({
      feed: [turn(2), turn(3)],
      pages: ME_PAGE,
      warapp: server(() => listed(++asked === 1 ? LIST_TEAMS.slice(0, 3) : LIST_TEAMS)()),
    });
    expect((await h.call('warapp_get_team', { game_id: GAME })).isError).toBe(true);
    const p = payload<{ team: { source: string } }>(await h.call('warapp_get_team', { game_id: GAME }));
    expect(p.team.source).toBe('my-games');
    expect(listReads()).toBe(2);
    expect(await readTeamRecord(h.dataDir, GAME)).toEqual(new Map(LIST_TEAMS.map((p) => [p.id, p.team])));
  });

  it('a record kept by another decoder version is ignored: the list is asked again', async () => {
    h = await liveHarness({ feed: [game()], pages: ME_PAGE, warapp: server() });
    mkdirSync(join(h.dataDir, 'teams'), { recursive: true });
    // An old record putting everyone on one team: ignored, never read as teams.
    writeFileSync(
      teamRecordPath(h.dataDir, GAME),
      JSON.stringify({ version: TEAM_RECORD_VERSION - 1, gameId: GAME, teams: LIST_TEAMS.map((p) => [p.id, 4]) }),
    );
    expect(await readTeamRecord(h.dataDir, GAME)).toBeUndefined();
    const p = payload<{ team: { source: string } }>(await h.call('warapp_get_team', { game_id: GAME }));
    expect(p.team.source).toBe('my-games');
    expect(listReads()).toBe(1);
    expect(JSON.parse(readFileSync(teamRecordPath(h.dataDir, GAME), 'utf8')).version).toBe(TEAM_RECORD_VERSION);
  });
});

describe('the kept team record', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'warapp-teams-'));

  it('round-trips, and reads a missing or malformed record as not kept', async () => {
    const d = dir();
    expect(await readTeamRecord(d, 1)).toBeUndefined();
    await writeTeamRecord(d, 1, new Map([[20, 1], [10, 0]]));
    expect(await readTeamRecord(d, 1)).toEqual(new Map([[10, 0], [20, 1]]));
    const bad = (body: unknown) => writeFileSync(teamRecordPath(d, 1), JSON.stringify(body));
    bad({ version: TEAM_RECORD_VERSION + 1, gameId: 1, teams: [] });
    expect(await readTeamRecord(d, 1)).toBeUndefined();
    bad({ version: TEAM_RECORD_VERSION, gameId: 2, teams: [] });
    expect(await readTeamRecord(d, 1)).toBeUndefined();
    bad({ version: TEAM_RECORD_VERSION, gameId: 1, teams: [[10, 'x']] });
    expect(await readTeamRecord(d, 1)).toBeUndefined();
    bad({ version: TEAM_RECORD_VERSION, gameId: 1, teams: [[10, -1]] });
    expect(await readTeamRecord(d, 1)).toBeUndefined();
    writeFileSync(teamRecordPath(d, 1), '{');
    expect(await readTeamRecord(d, 1)).toBeUndefined();
  });

  it(`keeps the newest ${MAX_TEAM_RECORDS} games`, async () => {
    const d = dir();
    mkdirSync(join(d, 'teams'), { recursive: true });
    for (let i = 1; i <= MAX_TEAM_RECORDS; i++) writeFileSync(teamRecordPath(d, i), JSON.stringify({ version: TEAM_RECORD_VERSION, gameId: i, teams: [] }));
    await writeTeamRecord(d, MAX_TEAM_RECORDS + 1, new Map());
    const kept = await Promise.all(Array.from({ length: MAX_TEAM_RECORDS + 1 }, (_, i) => readTeamRecord(d, i + 1)));
    expect(kept.filter((k) => k !== undefined)).toHaveLength(MAX_TEAM_RECORDS);
    expect(kept[MAX_TEAM_RECORDS]).toEqual(new Map());
  });

  it('never throws when the folder cannot be written', async () => {
    const d = dir();
    writeFileSync(join(d, 'teams'), 'not a folder');
    await expect(writeTeamRecord(d, 1, new Map([[1, 0]]))).resolves.toBeUndefined();
  });
});
