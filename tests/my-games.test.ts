import { afterEach, describe, expect, it } from 'vitest';
import { Reader, Writer } from '../src/protocol/codec.js';
import { Method, MyGamesFilterType, writeGetMyGamesParams } from '../src/protocol/methods.js';
import { listMyGames, MY_GAMES_WINDOWS } from '../src/tools/my-games.js';
import {
  anyUnreadChat,
  bootSoon,
  bootView,
  isOpening,
  minutesText,
  OPENING_LAST_TURN,
  type BootClock,
  briefGameLine,
  chatGameIds,
  GAME_INFO,
  GAME_INFO_PLAYER,
  MY_GAMES_RETURN,
  MyGamesFormatError,
  myGamesTeams,
  readMyGames,
  summarizeMyGames,
  unflaggedFinished,
  unreadChatOf,
  type MyGame,
} from '../src/my-games.js';
import { WarappBundle } from '../src/protocol/bundle.js';
import { MY_GAMES_BUNDLE } from './protocol/my-games-bundle.js';
import { EMAIL, liveHarness, payload, textOf, type Harness } from './helpers.js';
import { writeMyGamesReturn, type SyntheticGame } from './protocol/my-games-bundle.js';
import { writeGameDetailsAndChat, type SyntheticSeat } from './protocol/chat-bundle.js';
import { untrustedText } from '../src/tools/common.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

// Synthetic ids: the invite token wraps the in-game id in two check digits each end.
const ME = { token: '4412345677', inGame: 123456 };
const SIGNED_IN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ME.token}</p>` };

const PLAYING = 3;
const DISTRIBUTING = 5;
const WAITING = 2;
const FINISHED = 4;
const P_PLAYING = 2;
const P_ELIMINATED = 3;
const P_INVITED = 1;

const GAMES: SyntheticGame[] = [
  {
    id: 1001,
    name: 'Committed already',
    lastTurn: 4,
    state: PLAYING,
    players: [
      { id: ME.inGame, name: 'Ann', state: P_PLAYING, committed: true },
      { id: 765432, name: 'Bob', state: P_PLAYING, committed: false },
    ],
  },
  {
    id: 1002,
    name: 'My move',
    lastTurn: 1,
    state: PLAYING,
    players: [
      { id: 765432, name: 'Bob', state: P_PLAYING, committed: true },
      { id: ME.inGame, name: 'Ann', state: P_PLAYING, committed: false },
    ],
  },
  {
    id: 1003,
    name: 'Lobby',
    lastTurn: -1,
    state: WAITING,
    players: [
      { id: ME.inGame, name: 'Ann', state: P_PLAYING, committed: false },
      { id: 222222, name: 'Cy', state: P_INVITED, committed: false },
    ],
  },
  {
    id: 1004,
    name: 'Picking',
    lastTurn: -1,
    state: DISTRIBUTING,
    players: [{ id: ME.inGame, name: 'Ann', state: P_PLAYING, committed: false }],
  },
  {
    id: 1005,
    name: 'Out of it',
    lastTurn: 9,
    state: PLAYING,
    players: [{ id: ME.inGame, name: 'Ann', state: P_ELIMINATED, committed: false }],
  },
];

const myGamesReply = (games: SyntheticGame[] | null) => () => ({ body: (w: Writer) => writeMyGamesReturn(w, games) });

/** The filters a GetMyGames request carried (the bytes after the auth block). */
const filtersOf = (hex: string) => ({
  filterType: Number.parseInt(hex.slice(2, 4), 16),
  count: new DataView(Uint8Array.from(Buffer.from(hex.slice(4, 12), 'hex')).buffer).getInt32(0, true),
  sort: Number.parseInt(hex.slice(12, 14), 16),
});

/** `games`, or per request the games for the count asked (paging, #260). */
async function harness(games: SyntheticGame[] | null | ((count: number) => SyntheticGame[]), pages: Record<string, string> = SIGNED_IN) {
  const sent: string[] = [];
  h = await liveHarness({
    pages,
    warapp: (req) => {
      if (req.method !== Method.GetMyGames) throw new Error(`unexpected method ${req.method}`);
      const hex = Array.from(req.body.raw(req.body.remaining), (b) => b.toString(16).padStart(2, '0')).join('');
      sent.push(hex);
      return myGamesReply(typeof games === 'function' ? games(filtersOf(hex).count) : games)();
    },
  });
  return { params: () => sent.at(-1), sent: () => sent.map(filtersOf) };
}

/** `n` synthetic games being played, ids from 5000. */
const many = (n: number): SyntheticGame[] =>
  Array.from({ length: n }, (_, i) => ({
    id: 5000 + i,
    name: `G${i}`,
    lastTurn: 3,
    state: PLAYING,
    players: [{ id: ME.inGame, name: 'Ann', state: P_PLAYING, committed: true }],
  }));

const FINISHED_GAME: SyntheticGame = {
  id: 1006,
  name: 'Over',
  lastTurn: 12,
  state: FINISHED,
  players: [{ id: ME.inGame, name: 'Ann', state: P_PLAYING, committed: false }],
};

describe('GetMyGames params', () => {
  it('writes the client default filters {4, 10, 2} then bool, int32 0, bool, bool', () => {
    const w = new Writer();
    writeGetMyGamesParams(w);
    const hex = Array.from(w.bytes(), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('01' + '04' + '0a000000' + '02' + '00' + '00000000' + '00' + '00');
  });

  it('writes other filters in the same shape (#260, golden: All, 100 games, the default sort)', () => {
    const w = new Writer();
    writeGetMyGamesParams(w, { filterType: MyGamesFilterType.All, count: 100, sort: 2 });
    const hex = Array.from(w.bytes(), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('01' + '03' + '64000000' + '02' + '00' + '00000000' + '00' + '00');
  });

  it("names the bundle's filter types", () => {
    expect(MyGamesFilterType).toEqual({
      ActiveGames: 0,
      ActiveNotEliminated: 1,
      YourTurn: 2,
      All: 3,
      Default: 4,
      YourTurnOrPendingChat: 5,
      ActiveGameOrPendingChat: 7,
      Finished: 8,
    });
  });
});

describe('listMyGames: every game, the window widened while war.app fills it (#260)', () => {
  const games = (n: number) => many(n).map((g) => ({ id: g.id, name: g.name, lastTurn: 3, stateCode: 3, players: [] }));

  it('asks All with the first window and stops when the reply does not fill it', async () => {
    const asked: Array<Record<string, number>> = [];
    const r = await listMyGames(async (f) => (asked.push({ ...f }), games(3)), [5, 20]);
    expect(asked).toEqual([{ filterType: MyGamesFilterType.All, count: 5, sort: 2 }]);
    expect(r).toMatchObject({ partial: false, requests: 1 });
    expect(r.games).toHaveLength(3);
  });

  it('asks again with the next window while a reply fills the last one', async () => {
    const asked: number[] = [];
    const r = await listMyGames(async (f) => (asked.push(f.count), games(Math.min(f.count, 7))), [2, 4, 8]);
    expect(asked).toEqual([2, 4, 8]);
    expect(r).toMatchObject({ partial: false, requests: 3 });
    expect(r.games).toHaveLength(7);
  });

  it('is partial when the largest window is filled', async () => {
    const r = await listMyGames(async (f) => games(f.count), [2, 4]);
    expect(r).toMatchObject({ partial: true, requests: 2 });
    expect(r.games).toHaveLength(4);
  });

  it('keeps what it read, as partial, when a wider read fails; a failed first read throws', async () => {
    let n = 0;
    const r = await listMyGames(async (f) => {
      if (n++) throw new Error('bridge down');
      return games(f.count);
    }, [2, 4]);
    expect(r).toMatchObject({ partial: true, requests: 2 });
    expect(r.games).toHaveLength(2);
    await expect(listMyGames(async () => Promise.reject(new Error('bridge down')), [2])).rejects.toThrow('bridge down');
  });

  it('asks 100, then 400, then 1600 games', () => {
    expect(MY_GAMES_WINDOWS).toEqual([100, 400, 1600]);
  });
});

describe('warapp_my_games', () => {
  it('pace: reports each multi-day game\'s boot clock, counts the ones under six hours, and session_status warns of them', async () => {
    const H = 3_600_000;
    const near: SyntheticGame = {
      id: 1101,
      name: 'Mega',
      lastTurn: 4,
      state: PLAYING,
      bootTimeMs: 36 * H,
      bankedMs: 8 * H,
      turnForMs: 40 * H,
      players: [
        { id: ME.inGame, name: 'Ann', state: P_PLAYING, committed: false },
        { id: 765432, name: 'Bob', state: P_PLAYING, committed: true },
      ],
    };
    const fast: SyntheticGame = { ...near, id: 1102, name: 'Blitz', realTime: true, bootTimeMs: 5 * 60_000 };
    await harness([near, fast]);
    // With no game list read yet, session_status reads it itself (owner decision 2026-11-23): one GetMyGames.
    const asked = () => h!.exchanges.filter((e) => e.request.method === Method.GetMyGames).length;
    const before = payload(await h!.call('warapp_session_status'));
    expect(asked()).toBe(1);
    expect(before.bootWarning).toMatch(/Boot close: game 1101 in 4h/);
    // A second call reuses that list: no request.
    await h!.call('warapp_session_status');
    expect(asked()).toBe(1);
    const p = payload(await h!.call('warapp_my_games'));
    const games = p.games as Array<Record<string, unknown>>;
    expect(games.find((g) => g.id === 1101)!.boot).toEqual({ bootMinutes: 2160, bankedMinutes: 480, allowanceMinutes: 2640, leftMinutes: 240, soon: true });
    // #504: a real-time game is reported too, close to a boot only at a quarter or less of its time (here 0 left).
    expect(games.find((g) => g.id === 1102)!.boot).toEqual({ bootMinutes: 5, bankedMinutes: 480, allowanceMinutes: 485, leftMinutes: 0, realTime: true, soon: true });
    expect(p.bootSoon).toBe(2);
    expect(p).not.toHaveProperty('openingBootSoon');
    expect(p.bootNote).toMatch(/banked time/);
    const s = payload(await h!.call('warapp_session_status'));
    // A real-time game is not kept for session_status: its turn passes in minutes.
    expect(s.pace).toMatchObject({ bootSoon: [{ id: 1101, leftMinutes: expect.any(Number) }] });
    expect((s.pace as { bootSoon: unknown[] }).bootSoon).toHaveLength(1);
    expect(s.bootWarning).toMatch(/Boot close: game 1101 in 4h/);
  });

  it('#504: an opening turn close to a boot comes first, is counted, and session_status names it first', async () => {
    const H = 3_600_000;
    const seat = (committed = false) => [{ id: ME.inGame, name: 'Ann', state: P_PLAYING, committed }];
    // Turn 6, 2 hours left: close by the six-hour line. Turn 2, 12 hours of 72 left: close by the quarter.
    const late: SyntheticGame = { id: 1201, name: 'Late', lastTurn: 5, state: PLAYING, bootTimeMs: 72 * H, turnForMs: 70 * H, players: seat() };
    const early: SyntheticGame = { id: 1202, name: 'Early', lastTurn: 1, state: PLAYING, bootTimeMs: 72 * H, turnForMs: 60 * H, players: seat() };
    await harness([late, early]);
    const p = payload(await h!.call('warapp_my_games'));
    const games = p.games as Array<{ id: number; boot: Record<string, unknown> }>;
    expect(games.map((g) => g.id)).toEqual([1202, 1201]);
    expect(games[0]!.boot).toMatchObject({ opening: true, openingSoon: true, leftMinutes: 720 });
    expect(p.bootSoon).toBe(2);
    expect(p.openingBootSoon).toBe(1);
    expect(p.bootNote).toMatch(/opening turn/);
    const s = payload(await h!.call('warapp_session_status'));
    expect((s.pace as { bootSoon: Array<{ id: number; opening?: true }> }).bootSoon).toEqual([
      expect.objectContaining({ id: 1202, opening: true }),
      expect.objectContaining({ id: 1201 }),
    ]);
    expect(s.bootWarning).toMatch(/Boot close: game 1202 in 12h \(opening turn\), game 1201 in 2h .*a missed one delays the first bonus/);
  });

  it('lists my games through GetMyGames, waiting-on-me first, states and turns named', async () => {
    const t = await harness(GAMES);
    const res = await h!.call('warapp_my_games');
    const p = payload(res);
    expect(p.untrusted_content).toBe(true);
    const games = p.games as Array<Record<string, unknown>>;
    expect(games.map((g) => [g.id, g.waitingOnYou])).toEqual([
      [1002, true],
      [1004, true],
      [1001, false],
      [1003, false],
      [1005, false],
    ]);
    expect(games[0]).toEqual({
      id: 1002,
      name: 'My move',
      state: 'Playing',
      turn: 2,
      waitingOnYou: true,
      players: [
        { name: 'Bob', state: 'Playing', committed: true },
        { name: 'Ann', state: 'Playing', committed: false },
      ],
      // The game list's unread-chat flags (each false by default in the synthetic list).
      unreadChat: { public: false, team: false, private: false, group: false, toMe: false },
      // Pace: the synthetic list's 3-day boot, no bank, my turn just begun.
      // #504: turn 2 is an opening turn; with all its time left it is not close to a boot.
      boot: { bootMinutes: 4320, bankedMinutes: 0, allowanceMinutes: 4320, leftMinutes: 4320, opening: true, soon: false },
      // #317: this fake answers no GameRefresh, so the details are unread: unknown, never "none".
      surrenderPending: null,
    });
    expect(games[1]).toMatchObject({ state: 'DistributingTerritories', turn: null });
    expect(games[3]).toMatchObject({ state: 'WaitingForPlayers', turn: null });
    expect((games[3]!.players as unknown[])[1]).toEqual({ name: 'Cy', state: 'Invited', committed: false });
    expect(p.waitingOnYou).toBe(2);

    const ex = h!.exchanges[0]!;
    expect(ex.path).toBe('https://war.app/Services?m=GetMyGames&js=1');
    expect(ex.request.email).toBe(EMAIL);
    expect(t.params()).toBe('0103640000000200000000000000');
    expect(p).toMatchObject({ count: 5, listed: 5, complete: true });
    expect(p).not.toHaveProperty('finishedLeftOut');
  });

  it('an account whose token starts with a 0 check digit still finds its seat (#130)', async () => {
    // 07 + 123456 + 98: read as a number the leading 0 is lost and the slice gives 23456.
    await harness(GAMES, { 'https://war.app/InviteToken': '<p>Your invite token is 0712345698</p>' });
    const p = payload(await h!.call('warapp_my_games'));
    expect(p.waitingOnYou).toBe(2);
    expect((p.games as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 1002, waitingOnYou: true });
  });

  it('answers an empty list when war.app sends no games', async () => {
    await harness(null);
    const p = payload(await h!.call('warapp_my_games'));
    expect(p.games).toEqual([]);
    expect(p.waitingOnYou).toBe(0);
  });

  it('refuses when the signed-in account cannot be read', async () => {
    await harness(GAMES, {});
    const res = await h!.call('warapp_my_games');
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/signed in/);
  });

  it('brief: one line per game inside the untrusted envelope, waiting on you first', async () => {
    await harness(GAMES);
    const res = await h!.call('warapp_my_games', { view: 'brief' });
    const text = textOf(res);
    expect(text).not.toContain('\n  ');
    const body = JSON.parse(text) as { untrusted_content: boolean; note: string; data: string[] };
    expect(Object.keys(body)).toEqual(['untrusted_content', 'note', 'data']);
    expect(body.untrusted_content).toBe(true);
    expect(body.note).toMatch(/war\.app players/);
    expect(body.data).toEqual([
      'My move — turn 2 — waiting on you',
      'Picking — DistributingTerritories — waiting on you',
      'Committed already — turn 5 — waiting on others',
      'Lobby — WaitingForPlayers — waiting on others',
      'Out of it — turn 10 — waiting on others',
    ]);
  });

  it('brief: "-- none" when there are no games', async () => {
    await harness([]);
    const body = JSON.parse(textOf(await h!.call('warapp_my_games', { view: 'brief' }))) as { data: string[] };
    expect(body.data).toEqual(['-- none']);
  });
});

describe('warapp_my_games: pending surrenders (#317)', () => {
  const THREE: SyntheticGame[] = [
    {
      id: 2001,
      name: 'Quiet',
      lastTurn: 4,
      state: PLAYING,
      players: [
        { id: ME.inGame, name: 'Ann', state: P_PLAYING, committed: true },
        { id: 765432, name: 'Bob', state: P_PLAYING, committed: true },
      ],
    },
    {
      id: 2002,
      name: 'Bob gives up',
      lastTurn: 7,
      state: PLAYING,
      players: [
        { id: ME.inGame, name: 'Ann', state: P_PLAYING, committed: true },
        { id: 765432, name: 'Bob', state: P_PLAYING, committed: true },
        { id: 222222, name: 'Cy', state: P_PLAYING, committed: true },
      ],
    },
    ...GAMES.filter((g) => g.id === 1003 || g.id === 1005),
  ];
  const DETAILS: Record<number, SyntheticSeat[]> = {
    2001: [{ id: ME.inGame }, { id: 765432 }],
    2002: [{ id: ME.inGame }, { id: 765432, surrendered: true, acceptedBy: [222222] }, { id: 222222 }],
  };

  async function surrenderHarness(fail: number[] = []) {
    const refreshed: Array<{ id: number; chat: boolean; nonChat: boolean }> = [];
    h = await liveHarness({
      pages: SIGNED_IN,
      warapp: (req) => {
        if (req.method === Method.GetMyGames) return myGamesReply(THREE)();
        if (req.method === Method.GameRefresh) {
          const id = req.body.int32();
          refreshed.push({ id, chat: req.body.bool(), nonChat: req.body.bool() });
          if (fail.includes(id)) return { error: { code: 17, message: 'no' } };
          return { body: (w: Writer) => writeGameDetailsAndChat(w, null, DETAILS[id] ?? null) };
        }
        throw new Error(`unexpected method ${req.method}`);
      },
    });
    return refreshed;
  }

  it('reports each game being played: one owed first and counted, a quiet one empty, and a lobby or a game I am out of empty too, unread (#327)', async () => {
    const refreshed = await surrenderHarness();
    const p = payload(await h!.call('warapp_my_games'));
    const games = p.games as Array<Record<string, unknown>>;
    // Only games being played or picked where my seat plays are read (not the lobby, nor the one I am out of).
    expect(refreshed.sort((a, b) => a.id - b.id)).toEqual([
      { id: 2001, chat: false, nonChat: true },
      { id: 2002, chat: false, nonChat: true },
    ]);
    expect(games.map((g) => [g.id, g.waitingOnYou])).toEqual([
      [2002, false],
      [2001, false],
      [1003, false],
      [1005, false],
    ]);
    expect(games[0]!.surrenderPending).toEqual([{ inGameId: 765432, player: null, owedByMe: true, name: untrustedText('Bob') }]);
    expect(games[1]!.surrenderPending).toEqual([]);
    // #327: nothing failed to read there — a lobby has no surrender, and a game I am out of owes none from me.
    expect(games[2]!.surrenderPending).toEqual([]);
    expect(games[3]!.surrenderPending).toEqual([]);
    expect(p.surrenderPending).toBe(1);
    expect(p.waitingOnYou).toBe(0);
    expect(String(p.surrenderNote)).toMatch(/UNVERIFIED live.*null means they could not be read/);
    expect(String(p.surrenderNote)).toMatch(/lobby/);
    expect(String(p.surrenderNote)).not.toMatch(/could not be read\./);
  });

  it('a failed read is null (unknown) and counted in the note, never an empty list', async () => {
    await surrenderHarness([2002]);
    const p = payload(await h!.call('warapp_my_games'));
    const games = p.games as Array<Record<string, unknown>>;
    expect(games.find((g) => g.id === 2002)!.surrenderPending).toBeNull();
    expect(p.surrenderPending).toBe(0);
    expect(String(p.surrenderNote)).toMatch(/The details of 1 game\(s\) could not be read/);
  });

  it('brief reads no details', async () => {
    const refreshed = await surrenderHarness();
    await h!.call('warapp_my_games', { view: 'brief' });
    expect(refreshed).toEqual([]);
  });
});

describe('warapp_my_games: the whole list (#260)', () => {
  it('leaves finished games out unless include_finished, and says how many it left out', async () => {
    await harness([...GAMES, FINISHED_GAME]);
    const p = payload(await h!.call('warapp_my_games'));
    expect((p.games as Array<{ id: number }>).map((g) => g.id)).not.toContain(1006);
    expect(p).toMatchObject({ count: 5, listed: 6, finishedLeftOut: 1, complete: true });
    const all = payload(await h!.call('warapp_my_games', { include_finished: true }));
    expect((all.games as Array<{ id: number; state: string }>).find((g) => g.id === 1006)).toMatchObject({ state: 'Finished' });
    expect(all).toMatchObject({ count: 6, listed: 6, complete: true });
    expect(all).not.toHaveProperty('finishedLeftOut');
  });

  it('pages: a reply that fills the window is asked again with a wider one', async () => {
    const t = await harness((count) => many(Math.min(count, 130)));
    const p = payload(await h!.call('warapp_my_games'));
    expect(t.sent()).toEqual([
      { filterType: MyGamesFilterType.All, count: 100, sort: 2 },
      { filterType: MyGamesFilterType.All, count: 400, sort: 2 },
    ]);
    expect(p).toMatchObject({ count: 130, listed: 130, complete: true });
    expect(p).not.toHaveProperty('warning');
  });

  it('says the list may be partial when war.app fills the widest window', async () => {
    await harness((count) => many(count));
    const p = payload(await h!.call('warapp_my_games'));
    expect(p).toMatchObject({ count: 1600, listed: 1600, complete: false });
    expect(String(p.warning)).toMatch(/may be partial/);
    const body = JSON.parse(textOf(await h!.call('warapp_my_games', { view: 'brief' }))) as { data: string[] };
    expect(body.data.at(-1)).toMatch(/^-- the list may be partial: war\.app returned 1600 games/);
  }, 30_000);
});

describe('briefGameLine', () => {
  const game = (over: Partial<MyGame> = {}): MyGame => ({
    id: 1,
    name: 'G',
    state: 'Playing',
    turn: 3,
    waitingOnYou: false,
    players: [],
    ...over,
  });

  it('flattens whitespace, escapes a note-like name and fits 120 characters', () => {
    expect(briefGameLine(game({ name: 'a\n  b' }))).toBe('a b — turn 3 — waiting on others');
    expect(briefGameLine(game({ name: '-- none' }))).toBe('\\-- none — turn 3 — waiting on others');
    expect(briefGameLine(game({ name: '\\x' }))).toBe('\\\\x — turn 3 — waiting on others');
    expect(briefGameLine(game({ name: '  ' }))).toBe('(untitled) — turn 3 — waiting on others');
    const long = briefGameLine(game({ name: 'Y'.repeat(300), waitingOnYou: true }));
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('… — turn 3 — waiting on you')).toBe(true);
  });

  it('shows the state when the game has no turn yet or is not being played', () => {
    expect(briefGameLine(game({ state: 'Finished', turn: 12 }))).toBe('G — Finished — waiting on others');
    expect(briefGameLine(game({ turn: null }))).toBe('G — Playing — waiting on others');
  });
});

describe('readMyGames / summarizeMyGames', () => {
  type Obj = Record<string, unknown>;
  const stub = (ret: unknown) => ({ readClass: (type: string) => (type === MY_GAMES_RETURN ? ret : null) });
  const reader = (present: boolean) => {
    const w = new Writer();
    w.bool(present);
    return new Reader(w.bytes());
  };
  const ordered = (type: string, values: unknown[]): Obj => {
    const o: Obj = { $type: type };
    values.forEach((v, i) => (o[`f${i}`] = v));
    return o;
  };
  const player = (name: unknown, id: unknown, state: unknown, committed: unknown, team: unknown = -1) =>
    ordered(GAME_INFO_PLAYER, [null, false, committed, 0, false, name, id, state, team, false]);
  const info = (over: Record<number, unknown> = {}) => {
    const v: unknown[] = [1, 2, 's', 3, 4, 5, 1, 77, false, null, 39905, 0, null, 'N', 0, null, [], false, false, false, false, null, FINISHED, false, 0, null, 0];
    for (const [i, x] of Object.entries(over)) v[Number(i)] = x;
    return ordered(GAME_INFO, v);
  };

  it('is empty without a result, or with a null game list', () => {
    expect(readMyGames(stub(null), reader(false))).toEqual([]);
    expect(readMyGames(stub(ordered(MY_GAMES_RETURN, [null, 0])), reader(true))).toEqual([]);
  });

  it('reads GameInfo field 20, the seen-end-game-window flag (#523), only when set and a boolean', () => {
    const [seen] = readMyGames(stub(ordered(MY_GAMES_RETURN, [[info({ 20: true, 22: 4 })], 0])), reader(true));
    expect(seen!.seenEndGame).toBe(true);
    const [unseen] = readMyGames(stub(ordered(MY_GAMES_RETURN, [[info({ 20: false, 22: 4 })], 0])), reader(true));
    expect(unseen).not.toHaveProperty('seenEndGame');
    const [odd] = readMyGames(stub(ordered(MY_GAMES_RETURN, [[info({ 20: 1, 22: 4 })], 0])), reader(true));
    expect(odd).not.toHaveProperty('seenEndGame');
  });

  it('skips null list items and names unknown codes by number', () => {
    const games = readMyGames(
      stub(ordered(MY_GAMES_RETURN, [[null, info({ 22: 42, 16: [null, player('Zed', 9, 77, false)] })], 0])),
      reader(true),
    );
    expect(games).toEqual([
      {
        id: 77,
        name: 'N',
        lastTurn: 0,
        stateCode: 42,
        players: [{ id: 9, name: 'Zed', stateCode: 77, committed: false }],
        unreadChat: { group: false, private: false, public: false, team: false },
        boot: { bootMs: 5, bankedMs: 0, turnForMs: 0, realTime: false },
      },
    ]);
    const [g] = summarizeMyGames(games, 1);
    expect(g).toMatchObject({ state: '42', turn: 1, players: [{ name: 'Zed', state: '77', committed: false }] });
  });

  it('keeps minified field names that start with "$", dropping only the interpreter metadata', () => {
    // The live bundle names two GameInfoPlayer fields `$c` and `$a`; only `$type` and
    // `$ctorError` are the interpreter's own keys.
    const live: Obj = {
      $type: GAME_INFO_PLAYER,
      $c: null,
      GG: false,
      lh: true,
      pF: 0,
      ep: false,
      Wa: 'Ann',
      $a: 123456,
      Xa: 2,
      Re: -1,
      VF: false,
      $ctorError: 'ignored',
    };
    const [g] = readMyGames(stub(ordered(MY_GAMES_RETURN, [[info({ 16: [live] })], 0])), reader(true));
    expect(g!.players).toEqual([{ id: 123456, name: 'Ann', stateCode: 2, committed: true }]);
  });

  it("reads a player's team (C1), kept only when it carries one; a team that is not a number is left out", () => {
    const [g] = readMyGames(
      stub(
        ordered(MY_GAMES_RETURN, [
          [info({ 16: [player('Ann', 1, 2, false, 0), player('Bob', 2, 2, false, 1), player('Cy', 3, 2, false), player('Di', 4, 2, false, 'x')] })],
          0,
        ]),
      ),
      reader(true),
    );
    expect(g!.players).toEqual([
      { id: 1, name: 'Ann', stateCode: 2, committed: false, team: 0 },
      { id: 2, name: 'Bob', stateCode: 2, committed: false, team: 1 },
      { id: 3, name: 'Cy', stateCode: 2, committed: false },
      { id: 4, name: 'Di', stateCode: 2, committed: false },
    ]);
    expect([...myGamesTeams([g!], 77)]).toEqual([
      [1, 0],
      [2, 1],
    ]);
    expect(myGamesTeams([g!], 78).size).toBe(0);
  });

  it('reads the four unread-chat flags (fields 8, 17, 18, 23; #311) and leaves them out when one is not a boolean', () => {
    const [g] = readMyGames(stub(ordered(MY_GAMES_RETURN, [[info({ 8: true, 17: false, 18: true, 23: false })], 0])), reader(true));
    expect(g!.unreadChat).toEqual({ group: true, private: false, public: true, team: false });
    expect(unreadChatOf([g!], 77)).toEqual(g!.unreadChat);
    expect(unreadChatOf([g!], 78)).toBeUndefined();
    expect(anyUnreadChat(g!.unreadChat)).toBe(true);
    expect(anyUnreadChat({ group: false, private: false, public: false, team: false })).toBe(false);
    expect(anyUnreadChat(undefined)).toBe(false);
    // Read loosely: a field that is not a boolean leaves the flags unknown, and the list still reads.
    const [odd] = readMyGames(stub(ordered(MY_GAMES_RETURN, [[info({ 23: 1 })], 0])), reader(true));
    expect(odd).not.toHaveProperty('unreadChat');
    expect(odd!.id).toBe(77);
    // A finished game whose flags did not read is still a chat candidate (#311): the flags are UNVERIFIED live,
    // and dropping it would hide its chat without a word.
    expect(chatGameIds([odd!])).toEqual([77]);
    expect(unflaggedFinished([odd!, g!])).toEqual([77]);
  });

  it('reads the flags through a bundle by read order (the synthetic GameInfo)', () => {
    const bundle = new WarappBundle(MY_GAMES_BUNDLE, 'test');
    const w = new Writer();
    writeMyGamesReturn(w, [
      { id: 5, name: 'a', lastTurn: 1, state: PLAYING, players: [], unread: { team: true } },
      { id: 6, name: 'b', lastTurn: 1, state: PLAYING, players: [], unread: { group: true, private: true, public: true } },
    ]);
    const games = readMyGames(bundle, new Reader(w.bytes()));
    expect(games.map((g) => g.unreadChat)).toEqual([
      { group: false, private: false, public: false, team: true },
      { group: true, private: true, public: true, team: false },
    ]);
  });

  it('chatGameIds lists a finished game when war.app flags its chat unread, or when its flags do not read (#311)', () => {
    const flags = (over: Partial<Record<'group' | 'private' | 'public' | 'team', boolean>> = {}) => ({
      group: false,
      private: false,
      public: false,
      team: false,
      ...over,
    });
    const g = (id: number, stateCode: number, unreadChat?: ReturnType<typeof flags>) => ({
      id,
      name: '',
      lastTurn: 1,
      stateCode,
      players: [],
      ...(unreadChat ? { unreadChat } : {}),
    });
    expect(
      chatGameIds([
        g(9, FINISHED, flags({ private: true })),
        g(3, PLAYING),
        g(8, FINISHED, flags()),
        g(7, FINISHED),
        g(4, FINISHED, flags({ group: true })),
        g(2, 2),
        g(1, DISTRIBUTING),
      ]),
    ).toEqual([1, 2, 3, 4, 7, 9]);
  });

  it('treats a null player list as no players and a null name as empty', () => {
    const [g] = readMyGames(stub(ordered(MY_GAMES_RETURN, [[info({ 16: null, 13: null })], 0])), reader(true));
    expect(g).toMatchObject({ name: '', players: [] });
  });

  it('throws a format error when the reply is not the documented shape', () => {
    const bad = (ret: unknown) => () => readMyGames(stub(ret), reader(true));
    expect(bad('nope')).toThrow(MyGamesFormatError);
    expect(bad(ordered(MY_GAMES_RETURN, ['x']))).toThrow(/game list/);
    expect(bad(ordered(MY_GAMES_RETURN, [[{ $type: 'other' }]]))).toThrow(/GameInfo/);
    expect(bad(ordered(MY_GAMES_RETURN, [[info({ 7: 'not an id' })]]))).toThrow(/GameInfo/);
    expect(bad(ordered(MY_GAMES_RETURN, [[ordered(GAME_INFO, [1, 2])]]))).toThrow(/GameInfo/);
    expect(bad(ordered(MY_GAMES_RETURN, [[info({ 16: [player('A', 'x', 2, false)] })]]))).toThrow(/GameInfoPlayer/);
    expect(bad(ordered(MY_GAMES_RETURN, [[info({ 16: ['p'] })]]))).toThrow(/GameInfoPlayer/);
  });

  it('throws a format error on a record with a field inserted, though every position read still type-checks (#133)', () => {
    const bad = (ret: unknown) => () => readMyGames(stub(ret), reader(true));
    const inserted = (o: Obj, at: number, value: unknown): Obj => {
      const { $type, ...rest } = o;
      const values = Object.values(rest);
      values.splice(at, 0, value);
      return ordered(String($type), values);
    };
    // An int before the state: the state would silently read the inserted field.
    expect(bad(ordered(MY_GAMES_RETURN, [[inserted(info(), 22, PLAYING)]]))).toThrow(MyGamesFormatError);
    expect(bad(ordered(MY_GAMES_RETURN, [[inserted(info(), 22, PLAYING)]]))).toThrow(/GameInfo has 28 fields, not 27/);
    // An int before a player's state: the same for the player.
    const shiftedPlayer = inserted(player('A', 9, P_PLAYING, false), 7, P_ELIMINATED);
    expect(bad(ordered(MY_GAMES_RETURN, [[info({ 16: [shiftedPlayer] })]]))).toThrow(/GameInfoPlayer has 11 fields, not 10/);
    // A field dropped from the end is as much a layout change.
    const short = ordered(GAME_INFO, Object.values(info()).slice(1, -1));
    expect(bad(ordered(MY_GAMES_RETURN, [[short]]))).toThrow(MyGamesFormatError);
  });
});

describe('pace: the boot clock', () => {
  const H = 3_600_000;
  const clock = (over: Partial<BootClock> = {}): BootClock => ({ bootMs: 36 * H, bankedMs: 8 * H, turnForMs: 0, realTime: false, ...over });

  it('is boot time plus bank, less how long my turn has run, only while the game waits on me', () => {
    expect(bootView(clock({ turnForMs: 40 * H }), true)).toEqual({ bootMinutes: 2160, bankedMinutes: 480, allowanceMinutes: 2640, leftMinutes: 240, soon: true });
    expect(bootView(clock({ turnForMs: 40 * H }), false)).toMatchObject({ allowanceMinutes: 2640, leftMinutes: null, soon: false });
    expect(bootView(clock({ turnForMs: 50 * H }), true)).toMatchObject({ leftMinutes: 0, soon: true });
    expect(bootView(clock({ turnForMs: 10 * H }), true)!.soon).toBe(false);
  });

  it('says nothing for a game with no boot time or an unread clock', () => {
    expect(bootView(clock({ bootMs: 0 }), true)).toBeUndefined();
    expect(bootView(clock({ bootMs: 922_336_666_814_565 }), true)).toBeUndefined();
    expect(bootView(undefined, true)).toBeUndefined();
  });

  it('brief names a boot under six hours away', () => {
    const g: MyGame = { id: 1, name: 'G', state: 'Playing', turn: 3, waitingOnYou: true, players: [], boot: bootView(clock({ turnForMs: 40 * H }), true)! };
    expect(briefGameLine(g)).toBe('G — turn 3 — waiting on you — boot in 4h');
    expect(minutesText(2640)).toBe('1d 20h');
    expect(minutesText(45)).toBe('45m');
  });
});

describe('#504: an opening turn close to a boot', () => {
  const H = 3_600_000;
  // A 3-day boot, no bank: a quarter is 18 hours.
  const clock = (over: Partial<BootClock> = {}): BootClock => ({ bootMs: 72 * H, bankedMs: 0, turnForMs: 0, realTime: false, ...over });

  it('is picks or turns 1 to 4', () => {
    expect(OPENING_LAST_TURN).toBe(4);
    expect(isOpening(5, -1)).toBe(true); // distributing territories
    expect(isOpening(3, 0)).toBe(true); // turn 1
    expect(isOpening(3, 3)).toBe(true); // turn 4
    expect(isOpening(3, 4)).toBe(false); // turn 5
    expect(isOpening(3, -1)).toBe(false);
    expect(isOpening(2, -1)).toBe(false); // a lobby
  });

  it('flags an opening turn from a quarter of its time left, a later turn only under six hours', () => {
    // 12 hours left of 72: past a quarter, not yet under six hours.
    const opening = bootView(clock({ turnForMs: 60 * H }), true, true)!;
    expect(opening).toEqual({ bootMinutes: 4320, bankedMinutes: 0, allowanceMinutes: 4320, leftMinutes: 720, opening: true, soon: true, openingSoon: true });
    expect(bootView(clock({ turnForMs: 60 * H }), true, false)).toEqual({ bootMinutes: 4320, bankedMinutes: 0, allowanceMinutes: 4320, leftMinutes: 720, soon: false });
    // Exactly a quarter left is flagged; one minute more is not.
    expect(bootView(clock({ turnForMs: 54 * H }), true, true)!.openingSoon).toBe(true);
    expect(bootView(clock({ turnForMs: 54 * H - 60_000 }), true, true)).not.toHaveProperty('openingSoon');
    // Under six hours an opening turn is flagged whatever the share (a short boot).
    expect(bootView(clock({ bootMs: 20 * H, turnForMs: 14 * H + 60_000 }), true, true)).toMatchObject({ leftMinutes: 359, openingSoon: true });
    // Not waiting on me: no time left counts, nothing flagged.
    expect(bootView(clock({ turnForMs: 60 * H }), false, true)).toMatchObject({ leftMinutes: null, opening: true, soon: false });
  });

  it('flags a real-time turn only at a quarter of its time or less (no six-hour line)', () => {
    const rt = (turnForMs: number) => bootView({ bootMs: 5 * 60_000, bankedMs: 0, turnForMs, realTime: true }, true, false)!;
    expect(rt(60_000)).toEqual({ bootMinutes: 5, bankedMinutes: 0, allowanceMinutes: 5, leftMinutes: 4, realTime: true, soon: false });
    expect(rt(4 * 60_000)).toMatchObject({ leftMinutes: 1, soon: true });
    expect(bootSoon(1, { allowanceMinutes: 5, realTime: true })).toBe(true);
    expect(bootSoon(2, { allowanceMinutes: 5, realTime: true })).toBe(false);
    expect(bootSoon(359, { allowanceMinutes: 4320 })).toBe(true);
    expect(bootSoon(360, { allowanceMinutes: 4320 })).toBe(false);
  });

  it('puts an opening turn close to a boot first among the games waiting on me, soonest first', () => {
    const me = 77;
    const raw = (id: number, lastTurn: number, turnForMs: number) => ({
      id,
      name: `G${id}`,
      lastTurn,
      stateCode: 3,
      players: [{ id: me, name: 'Me', stateCode: 2, committed: false }],
      boot: clock({ turnForMs }),
    });
    const out = summarizeMyGames([raw(1, 9, 70 * H), raw(2, 1, 60 * H), raw(3, 0, 0), raw(4, 2, 66 * H)], me);
    // Game 1 (turn 10, 2 h left) is close to a boot but not an opening turn: it keeps its place after the openings.
    expect(out.map((g) => g.id)).toEqual([4, 2, 1, 3]);
    expect(out.map((g) => g.boot?.openingSoon === true)).toEqual([true, true, false, false]);
    expect(briefGameLine(out[0]!)).toBe('G4 — turn 3 — waiting on you — opening turn, boot in 6h');
    expect(briefGameLine(out[2]!)).toBe('G1 — turn 10 — waiting on you — boot in 2h');
  });
});

describe('pace on the mega game fixture (game 45736172 settings, name-free)', () => {
  it('its 2,160-minute boot and 480-minute starting bank give a 44-hour first turn', async () => {
    const { readFileSync } = await import('node:fs');
    const { normalizeGame } = await import('../src/normalize.js');
    const raw = JSON.parse(readFileSync(new URL('./fixtures/gamefeed-settings-45736172.json', import.meta.url), 'utf8')) as unknown;
    const rules = normalizeGame(raw).endRules!;
    expect(rules.directBootMinutes).toBe(2160);
    expect(rules.bankingBoot).toEqual({ bankMinutes: 60, initialBankMinutes: 480 });
    const v = bootView({ bootMs: rules.directBootMinutes! * 60_000, bankedMs: rules.bankingBoot!.initialBankMinutes * 60_000, turnForMs: 0, realTime: false }, true)!;
    expect(v.allowanceMinutes).toBe(2640);
    expect(minutesText(v.allowanceMinutes)).toBe('1d 20h');
  });
});

describe('warapp_session_status pace without a list', () => {
  it('says why when its own read of the game list fails', async () => {
    h = await liveHarness({
      pages: SIGNED_IN,
      warapp: () => {
        throw new Error('list down');
      },
    });
    const s = payload(await h.call('warapp_session_status'));
    expect(s).not.toHaveProperty('pace');
    expect(s.paceUnread).toEqual(expect.any(String));
  });
});
