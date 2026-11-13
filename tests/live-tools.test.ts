import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { EMAIL, liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
// GameFeed ids wrap the in-game id in two leading and two trailing check digits
// that differ per player (all synthetic).
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const SIGNED_IN_ANN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };

/** The lobby fixture with two wrapped player ids, in a given state. */
function game(state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>).map((p, i) =>
    i === 0 ? { ...p, id: ANN.feed, name: 'Ann' } : i === 1 ? { ...p, id: BOB.feed, name: 'Bob' } : p,
  );
  return { ...f, state, numberOfTurns: state === 'Playing' ? '2' : '-1', players, ...extra };
}

/** A fresh copy of the fixture's GameFeed settings. */
const settingsOf = (): Record<string, unknown> => ({ ...(lobbyFixture().settings as Record<string, unknown>) });

/** Territory names on the fixture map, by id. */
function mapName(id: number): string {
  const map = lobbyFixture().map as { territories: Array<{ id: string; name: string }> };
  return map.territories.find((t) => Number(t.id) === id)!.name;
}

const PICK_BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 2, owner: -2, armies: 2 },
  { id: 161, fogLevel: 2, owner: -2, armies: 2 },
  { id: 157, fogLevel: 2, owner: -2, armies: 2 },
  { id: 158, fogLevel: 2, owner: 0, armies: 4 },
  { id: 135, fogLevel: 2, owner: -2, armies: 2 },
];

const MID_BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 7 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

type Routes = Partial<Record<number, (req: DecodedRequest, n: number) => Partial<ReplyFrame>>>;

/** A fake war.app routing by method id; an unrouted method fails the test loudly. */
function routes(r: Routes) {
  return (req: DecodedRequest, n: number): Partial<ReplyFrame> => {
    const f = r[req.method];
    if (!f) throw new Error(`unexpected method ${req.method}`);
    return f(req, n);
  };
}

const board = (territories: SyntheticTerritory[] | null) => () =>
  ({ body: (w) => writeLatestGameInfo(w, territories, [ANN.inGame]) }) satisfies Partial<ReplyFrame>;

const picksReply = (ids: number[]) => () =>
  ({ body: (w) => w.bool(true).list(ids, (ww, id) => ww.int32(id)) }) satisfies Partial<ReplyFrame>;

/** Phase 1 then phase 2 of a confirm-gated tool. */
async function confirmed(name: string, args: Record<string, unknown>) {
  const preview = payload(await h!.call(name, args));
  expect(preview.confirmToken).toEqual(expect.any(String));
  return h!.call(name, { ...args, confirmToken: preview.confirmToken });
}

describe('warapp_get_live_board', () => {
  it('pick phase: owners as pickable / neutral, by territory name, through GetLatestGameInfo', async () => {
    let params: number | undefined;
    h = await liveHarness({
      feed: [game('DistributingTerritories')],
      warapp: routes({
        [Method.GetLatestGameInfo]: (req) => {
          params = req.body.int32();
          return board(PICK_BOARD)();
        },
      }),
    });
    const res = await h.call('warapp_get_live_board', { game_id: GAME });
    const p = payload(res);
    expect(p.untrusted_content).toBe(true);
    expect(p.game).toEqual({ id: GAME, name: 'Synthetic lobby game', state: 'DistributingTerritories', turn: null });
    const territories = p.territories as Array<Record<string, unknown>>;
    expect(territories).toHaveLength(5);
    expect(territories[0]).toEqual({ id: 159, name: mapName(159), owner: 'pickable', armies: 2 });
    expect(territories[3]).toMatchObject({ id: 158, owner: 'neutral', armies: 4 });
    expect(p.counts).toEqual({ territories: 5, visible: 5, fogged: 0, pickable: 4 });

    const ex = h.exchanges[0]!;
    expect(ex.path).toBe('https://war.app/Services?m=GetLatestGameInfo&js=1');
    expect(ex.request.method).toBe(Method.GetLatestGameInfo);
    expect(ex.request.email).toBe(EMAIL);
    expect(params).toBe(GAME);
  });

  it('mid-game: owners by player name, fogged territories counted not listed', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(MID_BOARD) }) });
    const p = payload(await h.call('warapp_get_live_board', { game_id: GAME }));
    expect((p.game as Record<string, unknown>).turn).toBe(2);
    const territories = p.territories as Array<Record<string, unknown>>;
    expect(territories.map((t) => [t.id, t.owner, t.armies])).toEqual([
      [159, 'Ann', 6],
      [161, 'Ann', 3],
      [157, 'neutral', 2],
      [158, 'Bob', 7],
    ]);
    expect(p.counts).toEqual({ territories: 5, visible: 4, fogged: 1, pickable: 0 });
    const players = p.players as Array<Record<string, unknown>>;
    expect(players[0]).toEqual({ id: Number(ANN.feed), name: 'Ann', visibleTerritories: 2, visibleArmies: 9 });
    expect(players[1]).toEqual({ id: Number(BOB.feed), name: 'Bob', visibleTerritories: 1, visibleArmies: 7 });
    expect(players[2]).toMatchObject({ visibleTerritories: 0 });
  });

  it('full: every territory with raw owner ids, fog flags and levels, and in-game player ids', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(MID_BOARD) }) });
    const p = payload(await h.call('warapp_get_live_board', { game_id: GAME, view: 'full' }));
    const territories = p.territories as Array<Record<string, unknown>>;
    expect(territories).toHaveLength(5);
    expect(territories[0]).toEqual({
      id: 159,
      name: mapName(159),
      owner: 'Ann',
      ownerId: ANN.inGame,
      armies: 6,
      fogged: false,
      fogLevel: 'Visible',
      specialUnits: [],
    });
    expect(territories[4]).toMatchObject({ id: 135, owner: 'fogged', ownerId: -1, armies: null, fogged: true, fogLevel: 'Fogged' });
    const players = p.players as Array<Record<string, unknown>>;
    expect(players[0]!.inGameId).toBe(ANN.inGame);
    expect(players[2]!.inGameId).toBeNull();
    expect(p).not.toHaveProperty('counts');
  });

  const CMDR_ANN = '0123456789abcdef0123456789abcdef';
  const CMDR_BOB = 'fedcba9876543210fedcba9876543210';
  const COMMANDER_BOARD: SyntheticTerritory[] = [
    { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 15, units: [{ kind: 'commander', id: CMDR_ANN, owner: ANN.inGame }] },
    { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
    { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 0, units: [{ kind: 'commander', id: CMDR_BOB, owner: BOB.inGame }] },
    {
      id: 157,
      fogLevel: 1,
      owner: BOB.inGame,
      armies: 2,
      units: [{ kind: 'boss', id: '00112233445566778899aabbccddeeff', owner: BOB.inGame, health: 400 }],
    },
  ];

  it('compact: a commander flag naming its owner on the territory it stands on', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(COMMANDER_BOARD) }) });
    const p = payload(await h.call('warapp_get_live_board', { game_id: GAME }));
    const territories = p.territories as Array<Record<string, unknown>>;
    expect(territories[0]).toEqual({ id: 159, name: mapName(159), owner: 'Ann', armies: 15, commander: 'Ann' });
    expect(territories[1]).not.toHaveProperty('commander');
    expect(territories[2]).toMatchObject({ id: 158, owner: 'Bob', armies: 0, commander: 'Bob' });
    expect(territories[3]).not.toHaveProperty('commander');
  });

  it('full: every special unit with kind, GUID and owner', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(COMMANDER_BOARD) }) });
    const p = payload(await h.call('warapp_get_live_board', { game_id: GAME, view: 'full' }));
    const territories = p.territories as Array<Record<string, unknown>>;
    expect(territories[0]!.specialUnits).toEqual([{ kind: 'commander', id: CMDR_ANN, owner: 'Ann', ownerId: ANN.inGame }]);
    expect(territories[1]!.specialUnits).toEqual([]);
    expect(territories[2]!.specialUnits).toEqual([{ kind: 'commander', id: CMDR_BOB, owner: 'Bob', ownerId: BOB.inGame }]);
    expect(territories[3]!.specialUnits).toEqual([
      { kind: 'boss', id: '00112233445566778899aabbccddeeff', owner: 'Bob', ownerId: BOB.inGame },
    ]);
  });

  it('labels an unlisted owner and an unknown negative owner', async () => {
    h = await liveHarness({
      feed: [game('Playing')],
      warapp: routes({
        [Method.GetLatestGameInfo]: board([
          { id: 159, fogLevel: 1, owner: 4242, armies: 1 },
          { id: 161, fogLevel: 1, owner: -7, armies: 1 },
        ]),
      }),
    });
    const p = payload(await h.call('warapp_get_live_board', { game_id: GAME }));
    expect((p.territories as Array<Record<string, unknown>>).map((t) => t.owner)).toEqual(['player 4242', 'unknown']);
  });

  it('errors clearly when war.app has no board (a lobby)', async () => {
    h = await liveHarness({ feed: [game('WaitingForPlayers')], warapp: routes({ [Method.GetLatestGameInfo]: board(null) }) });
    const res = await h.call('warapp_get_live_board', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no board for game 12345678 yet \(game state: WaitingForPlayers\)/);
  });

  it('a speed first turn (No-luck cycle, turn 1, no standing) says to Begin, not that it is a lobby', async () => {
    const speed = game('Playing', { numberOfTurns: '0', settings: { ...settingsOf(), MoveOrder: 'NoLuckCycle' } });
    h = await liveHarness({ feed: [speed], warapp: routes({ [Method.GetLatestGameInfo]: board(null) }) });
    const res = await h.call('warapp_get_live_board', { game_id: GAME });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/first turn starts when you press Begin/);
    expect(text).toMatch(/warapp_begin_turn/);
    expect(text).toMatch(/plan and submit at once: Begin starts the turn timer/);
    expect(text).not.toMatch(/lobby/i);
  });

  it('a speed first turn whose move order GameFeed does not send is still read as awaiting Begin', async () => {
    const settings = settingsOf();
    delete settings.MoveOrder;
    h = await liveHarness({
      feed: [game('Playing', { numberOfTurns: '0', settings })],
      warapp: routes({ [Method.GetLatestGameInfo]: board(null) }),
    });
    const res = await h.call('warapp_get_live_board', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/press Begin/);
  });

  it('a missing board past turn 1, or in a game without the speed first turn, is not blamed on Begin', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(null) }) });
    const later = await h.call('warapp_get_live_board', { game_id: GAME });
    expect(later.isError).toBe(true);
    expect(textOf(later)).toMatch(/no board for game 12345678 yet \(game state: Playing\)/);
    expect(textOf(later)).not.toMatch(/Begin/);
    await h.harness.close();
    h = await liveHarness({
      feed: [game('Playing', { numberOfTurns: '0' })], // the fixture's MoveOrder is Cycle
      warapp: routes({ [Method.GetLatestGameInfo]: board(null) }),
    });
    const cycle = await h.call('warapp_get_live_board', { game_id: GAME });
    expect(textOf(cycle)).not.toMatch(/Begin/);
  });

  it('a war.app server error surfaces with the client wording', async () => {
    h = await liveHarness({
      feed: [game('Playing')],
      warapp: routes({ [Method.GetLatestGameInfo]: () => ({ error: { code: 88, message: 'x' } }) }),
    });
    const res = await h.call('warapp_get_live_board', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/This game has been deleted\. \(war\.app error 88\)/);
  });
});

describe('warapp_get_my_picks', () => {
  it('reads GetTerritoryPicks for the in-game id (check digits removed) and names the picks', async () => {
    let params: number[] = [];
    h = await liveHarness({
      feed: [game('DistributingTerritories')],
      warapp: routes({
        [Method.GetTerritoryPicks]: (req) => {
          params = [req.body.int32(), req.body.int32()];
          return picksReply([161, 159])();
        },
      }),
    });
    const p = payload(await h.call('warapp_get_my_picks', { game_id: GAME, player: 'Ann' }));
    expect(params).toEqual([GAME, ANN.inGame]);
    expect(p.player).toEqual({ id: Number(ANN.feed), name: 'Ann' });
    expect(p.picks).toEqual([
      { priority: 1, id: 161, name: mapName(161) },
      { priority: 2, id: 159, name: mapName(159) },
    ]);
    expect(p.count).toBe(2);
    expect(p.maxPicks).toBe(6);
  });

  it('a different player gives a different in-game id', async () => {
    let params: number[] = [];
    h = await liveHarness({
      feed: [game('DistributingTerritories')],
      warapp: routes({
        [Method.GetTerritoryPicks]: (req) => {
          params = [req.body.int32(), req.body.int32()];
          return picksReply([])();
        },
      }),
    });
    const p = payload(await h.call('warapp_get_my_picks', { game_id: GAME, player: BOB.feed }));
    expect(params).toEqual([GAME, BOB.inGame]);
    expect(p.picks).toEqual([]);
  });

  it('defaults to the signed-in account, found by its invite token', async () => {
    let params: number[] = [];
    h = await liveHarness({
      feed: [game('DistributingTerritories')],
      pages: { 'https://war.app/InviteToken': `<p>Your invite token is ${BOB.feed}</p>` },
      warapp: routes({
        [Method.GetTerritoryPicks]: (req) => {
          params = [req.body.int32(), req.body.int32()];
          return picksReply([158])();
        },
      }),
    });
    const p = payload(await h.call('warapp_get_my_picks', { game_id: GAME }));
    expect(p.player).toEqual({ id: Number(BOB.feed), name: 'Bob' });
    expect(params).toEqual([GAME, BOB.inGame]);
  });

  it('still asks when the signed-in account is not a player in that game', async () => {
    h = await liveHarness({
      feed: [game('DistributingTerritories')],
      pages: { 'https://war.app/InviteToken': '<p>Your invite token is 9912345699</p>' },
    });
    const res = await h.call('warapp_get_my_picks', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Say which player/);
    expect(h.exchanges).toEqual([]);
  });

  it('asks which player when none is given, and sends nothing', async () => {
    h = await liveHarness({ feed: [game('DistributingTerritories')] });
    const res = await h.call('warapp_get_my_picks', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Ann \(3312345644\)/);
    expect(h.exchanges).toEqual([]);
  });

  it('maxPicks is null when the settings give no territory limit', async () => {
    const f = game('DistributingTerritories');
    const settings = { ...(f.settings as Record<string, unknown>) };
    delete settings.TerritoryLimit;
    h = await liveHarness({ feed: [{ ...f, settings }], warapp: routes({ [Method.GetTerritoryPicks]: picksReply([]) }) });
    expect(payload(await h.call('warapp_get_my_picks', { game_id: GAME, player: 'Ann' })).maxPicks).toBeNull();
  });
});

describe('warapp_submit_picks', () => {
  // Issue #7: SendTerritoryPicks always runs as the bridge's signed-in account, so the gate
  // must never preview picks "for" anyone else.
  it('refuses a player who is not the signed-in account, before any preview or send', async () => {
    h = await liveHarness({
      feed: [game('DistributingTerritories')],
      pages: { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` },
    });
    const res = await h.call('warapp_submit_picks', { game_id: GAME, player: 'Bob', territories: [161] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/signed-in account/i);
    expect(textOf(res)).not.toMatch(/confirmToken/);
    expect(h.exchanges).toEqual([]);
  });

  it('refuses when the signed-in account cannot be determined, even with a player named', async () => {
    h = await liveHarness({ feed: [game('DistributingTerritories')] });
    const res = await h.call('warapp_submit_picks', { game_id: GAME, player: 'Ann', territories: [161] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/signed-in account/i);
    expect(h.exchanges).toEqual([]);
  });


  function picksServer(readBack?: number[]) {
    const sent: Array<{ gameId: number; ids: number[] | null; tail: boolean[] }> = [];
    const warapp = routes({
      [Method.GetLatestGameInfo]: board(PICK_BOARD),
      [Method.SendTerritoryPicks]: (req) => {
        const gameId = req.body.int32();
        const ids = req.body.bool() ? req.body.list((r) => r.int32()) : null;
        sent.push({ gameId, ids, tail: [req.body.bool(), req.body.bool()] });
        return { body: (w) => w.bool(true).bool(false) };
      },
      [Method.GetTerritoryPicks]: () => picksReply(readBack ?? sent.at(-1)?.ids ?? [])(),
    });
    return { sent, warapp };
  }

  it('previews the picks by name and sends nothing until confirmed', async () => {
    const s = picksServer();
    h = await liveHarness({
      pages: SIGNED_IN_ANN, feed: [game('DistributingTerritories')], warapp: s.warapp });
    const preview = payload(await h.call('warapp_submit_picks', { game_id: GAME, player: 'Ann', territories: [161, mapName(159)] }));
    expect(preview.confirmToken).toEqual(expect.any(String));
    const text = JSON.stringify(preview);
    expect(text).toContain(mapName(161));
    expect(text).toContain('Replaces any picks already submitted');
    expect(s.sent).toEqual([]);
    expect(h.exchanges.map((e) => e.request.method)).toEqual([Method.GetLatestGameInfo]);
  });

  it('sends SendTerritoryPicks in priority order, reads them back, and reports verified', async () => {
    const s = picksServer();
    h = await liveHarness({
      pages: SIGNED_IN_ANN, feed: [game('DistributingTerritories')], warapp: s.warapp });
    const res = await confirmed('warapp_submit_picks', { game_id: GAME, player: 'Ann', territories: [161, 159, 135] });
    const p = payload(res);
    expect(s.sent).toEqual([{ gameId: GAME, ids: [161, 159, 135], tail: [false, false] }]);
    expect(p).toMatchObject({ sent: true, verified: true, game: GAME, readBack: [161, 159, 135] });
    expect(p.picks).toEqual([
      { id: 161, name: mapName(161) },
      { id: 159, name: mapName(159) },
      { id: 135, name: mapName(135) },
    ]);
    expect(p).not.toHaveProperty('warning');
    const methods = h.exchanges.map((e) => e.request.method);
    expect(methods.slice(-2)).toEqual([Method.SendTerritoryPicks, Method.GetTerritoryPicks]);
  });

  it('a read-back that differs (even in order) is not verified', async () => {
    const s = picksServer([159, 161]);
    h = await liveHarness({
      pages: SIGNED_IN_ANN, feed: [game('DistributingTerritories')], warapp: s.warapp });
    const p = payload(await confirmed('warapp_submit_picks', { game_id: GAME, player: 'Ann', territories: [161, 159] }));
    expect(p.verified).toBe(false);
    expect(p.readBack).toEqual([159, 161]);
    expect(p.warning).toMatch(/did not read back exactly/);
  });

  it('a shorter read-back is not verified', async () => {
    const s = picksServer([161]);
    h = await liveHarness({
      pages: SIGNED_IN_ANN, feed: [game('DistributingTerritories')], warapp: s.warapp });
    const p = payload(await confirmed('warapp_submit_picks', { game_id: GAME, player: 'Ann', territories: [161, 159] }));
    expect(p.verified).toBe(false);
  });

  it('refuses a territory that is not pickable on the live board', async () => {
    const s = picksServer();
    h = await liveHarness({
      pages: SIGNED_IN_ANN, feed: [game('DistributingTerritories')], warapp: s.warapp });
    const res = await h.call('warapp_submit_picks', { game_id: GAME, player: 'Ann', territories: [161, 158] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Not pickable on the live board: .*\(158\)/);
    expect(textOf(res)).toMatch(/lists as "pickable"/);
    expect(s.sent).toEqual([]);
  });

  it('refuses territories missing from the board, and says picks are closed outside distribution', async () => {
    h = await liveHarness({
      pages: SIGNED_IN_ANN, feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(MID_BOARD) }) });
    const res = await h.call('warapp_submit_picks', { game_id: GAME, player: 'Ann', territories: [157, 1] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/\(157\).*\(1\)/);
    expect(textOf(res)).toMatch(/only open while the game distributes territories \(game state: Playing\)/);
  });

  it('refuses more than twice the territory limit before reading the board', async () => {
    h = await liveHarness({
      pages: SIGNED_IN_ANN, feed: [game('DistributingTerritories')] });
    const res = await h.call('warapp_submit_picks', {
      game_id: GAME,
      player: 'Ann',
      territories: [159, 161, 157, 158, 135, 1, 2],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/at most 6 picks .* got 7/);
    expect(h.exchanges).toEqual([]);
  });

  it('refuses a territory listed twice', async () => {
    h = await liveHarness({
      pages: SIGNED_IN_ANN, feed: [game('DistributingTerritories')] });
    const res = await h.call('warapp_submit_picks', { game_id: GAME, player: 'Ann', territories: [159, mapName(159)] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/listed twice/);
  });

  it('a changed pick list between preview and confirm is refused', async () => {
    const s = picksServer();
    h = await liveHarness({
      pages: SIGNED_IN_ANN, feed: [game('DistributingTerritories')], warapp: s.warapp });
    const preview = payload(await h.call('warapp_submit_picks', { game_id: GAME, player: 'Ann', territories: [161] }));
    const res = await h.call('warapp_submit_picks', {
      game_id: GAME,
      player: 'Ann',
      territories: [159],
      confirmToken: preview.confirmToken,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/DRAFT_CHANGED/);
    expect(s.sent).toEqual([]);
  });
});

describe('warapp_get_chat', () => {
  it('reads GameFeed chat, naming senders, most recent last, as untrusted content', async () => {
    const chat = [
      // GameFeed's chat[].playerID is the IN-GAME id, not the wrapped one.
      { playerID: ANN.inGame, message: 'good luck', time: '11/11/2026 10:00:00' },
      { playerID: String(BOB.inGame), message: 'you too' },
      { playerID: '999', message: 'who?' },
      { message: 'system' },
    ];
    h = await liveHarness({ feed: [game('Playing', { chat })] });
    const res = await h.call('warapp_get_chat', { game_id: GAME, limit: 4 });
    const p = payload(res);
    expect(p.untrusted_content).toBe(true);
    expect(p.messages).toEqual([
      { from: 'Ann', text: 'good luck', time: '11/11/2026 10:00:00' },
      { from: 'Bob', text: 'you too' },
      { from: '999', text: 'who?' },
      { from: null, text: 'system' },
    ]);
    expect(p.count).toBe(4);
    expect(p.shown).toBe(4);
    expect(h.calls[0]!.url).toContain('GetChat=true');
    expect(h.exchanges).toEqual([]);
  });

  it('falls back to a wrapped-id sender match', async () => {
    h = await liveHarness({ feed: [game('Playing', { chat: [{ playerID: ANN.feed, message: 'hi' }] })] });
    expect(payload(await h.call('warapp_get_chat', { game_id: GAME })).messages).toEqual([{ from: 'Ann', text: 'hi' }]);
  });

  it('accepts a wrapped list and string senders', async () => {
    h = await liveHarness({ feed: [game('Playing', { chat: { messages: [{ sender: 'Ann', text: 'hi', date: 5 }] } })] });
    expect(payload(await h.call('warapp_get_chat', { game_id: GAME })).messages).toEqual([
      { from: 'Ann', text: 'hi', time: '5' },
    ]);
  });

  it('passes an unrecognised shape through raw', async () => {
    h = await liveHarness({ feed: [game('Playing', { chat: [{ odd: 1 }] })] });
    expect(payload(await h.call('warapp_get_chat', { game_id: GAME })).raw).toEqual([{ odd: 1 }]);
    await h.harness.close();
    h = await liveHarness({ feed: [game('Playing', { chat: [7] })] });
    expect(payload(await h.call('warapp_get_chat', { game_id: GAME })).raw).toEqual([7]);
    await h.harness.close();
    h = await liveHarness({ feed: [game('Playing', { chat: 'x' })] });
    expect(payload(await h.call('warapp_get_chat', { game_id: GAME })).raw).toBe('x');
  });

  it('no chat is an empty list', async () => {
    h = await liveHarness({ feed: [game('Playing')] });
    expect(payload(await h.call('warapp_get_chat', { game_id: GAME }))).toMatchObject({ messages: [], count: 0 });
  });
});

describe('warapp_send_chat', () => {
  function chatServer(reply: Partial<ReplyFrame> = { body: (w) => w.bool(false) }) {
    const sent: Array<Record<string, unknown>> = [];
    const warapp = routes({
      [Method.SendChat]: (req) => {
        const r = req.body;
        const gameId = r.int32();
        const text = r.string();
        const channel = r.int32();
        const recipient = r.bool() ? r.int32() : null;
        sent.push({ gameId, text, channel, recipient, group: r.bool(), m1: r.string(), m2: r.string(), d1: r.bool(), d2: r.bool(), left: r.remaining });
        return reply;
      },
    });
    return { sent, warapp };
  }

  it('the description warns that a message reaches other players and cannot be unsent', async () => {
    h = await liveHarness();
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_send_chat')!;
    expect(tool.description).toMatch(/reaches other players and cannot be unsent/);
    expect(tool.title).toBe('Send a chat message in a war.app game');
  });

  it('previews a public message and sends nothing until confirmed', async () => {
    const s = chatServer();
    h = await liveHarness({ warapp: s.warapp });
    const preview = payload(await h.call('warapp_send_chat', { game_id: GAME, message: 'gl hf' }));
    expect(JSON.stringify(preview)).toContain('everyone in the game');
    expect(s.sent).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('posts publicly on channel -1 with no recipient', async () => {
    const s = chatServer();
    h = await liveHarness({ warapp: s.warapp });
    const p = payload(await confirmed('warapp_send_chat', { game_id: GAME, message: 'gl hf' }));
    expect(p).toMatchObject({ status: 'sent', game: GAME, to: 'everyone in the game' });
    expect(s.sent).toEqual([
      { gameId: GAME, text: 'gl hf', channel: -1, recipient: null, group: false, m1: null, m2: null, d1: false, d2: false, left: 0 },
    ]);
  });

  it('posts privately to a named player by in-game id', async () => {
    const s = chatServer();
    h = await liveHarness({ feed: [game('Playing')], warapp: s.warapp });
    const p = payload(await confirmed('warapp_send_chat', { game_id: GAME, message: 'truce?', to: 'Bob' }));
    expect(p).toMatchObject({ status: 'sent', to: 'Bob' });
    expect(s.sent[0]).toMatchObject({ text: 'truce?', channel: -1, recipient: BOB.inGame });
  });

  it('a server refusal is an error (nothing was posted)', async () => {
    const s = chatServer({ error: { code: 36, message: 'slow down' } });
    h = await liveHarness({ warapp: s.warapp });
    const res = await confirmed('warapp_send_chat', { game_id: GAME, message: 'spam' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/sending too many messages .*\(war\.app error 36\)/);
  });

  it('an unconfirmed outcome is reported as unknown, not as safe to retry', async () => {
    h = await liveHarness({
      warapp: routes({ [Method.SendChat]: () => ({ msgNum: 999 }) }),
    });
    const p = payload(await confirmed('warapp_send_chat', { game_id: GAME, message: 'hello' }));
    expect(p.status).toBe('unknown');
    expect(p.warning).toMatch(/may already have been posted\. Check warapp_get_chat/);
  });

  it('refuses an empty message', async () => {
    h = await liveHarness();
    const res = await h.call('warapp_send_chat', { game_id: GAME, message: '   ' });
    expect(res.isError).toBe(true);
  });
});

describe('warapp_analyze_board on the live board', () => {
  it('analyzes from the live board when GameFeed sends none', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(MID_BOARD) }) });
    const p = payload(await h.call('warapp_analyze_board', { game_id: GAME, player: 'Ann', view: 'full' }));
    expect(p.boardVerified).toBe(true);
    expect(p.territoryCount).toBe(2);
    expect(p.armies).toBe(9);
    expect(h.exchanges.map((e) => e.request.method)).toEqual([Method.GetLatestGameInfo]);
  });

  it('labels live owners by name in compact', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({ [Method.GetLatestGameInfo]: board(MID_BOARD) }) });
    const p = payload(await h.call('warapp_analyze_board', { game_id: GAME, player: 'Bob' }));
    expect(p.player).toEqual({ id: Number(BOB.feed), name: 'Bob' });
    expect(JSON.stringify(p.threats)).toContain('Ann');
  });
});
