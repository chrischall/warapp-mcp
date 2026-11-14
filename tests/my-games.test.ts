import { afterEach, describe, expect, it } from 'vitest';
import { Reader, Writer } from '../src/protocol/codec.js';
import { Method, writeGetMyGamesParams } from '../src/protocol/methods.js';
import {
  briefGameLine,
  GAME_INFO,
  GAME_INFO_PLAYER,
  MY_GAMES_RETURN,
  MyGamesFormatError,
  readMyGames,
  summarizeMyGames,
  type MyGame,
} from '../src/my-games.js';
import { EMAIL, liveHarness, payload, textOf, type Harness } from './helpers.js';
import { writeMyGamesReturn, type SyntheticGame } from './protocol/my-games-bundle.js';

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

async function harness(games: SyntheticGame[] | null, pages: Record<string, string> = SIGNED_IN) {
  let params: string | undefined;
  h = await liveHarness({
    pages,
    warapp: (req) => {
      if (req.method !== Method.GetMyGames) throw new Error(`unexpected method ${req.method}`);
      params = Array.from(req.body.raw(req.body.remaining), (b) => b.toString(16).padStart(2, '0')).join('');
      return myGamesReply(games)();
    },
  });
  return { params: () => params };
}

describe('GetMyGames params', () => {
  it('writes the client default filters {4, 10, 2} then bool, int32 0, bool, bool', () => {
    const w = new Writer();
    writeGetMyGamesParams(w);
    const hex = Array.from(w.bytes(), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('01' + '04' + '0a000000' + '02' + '00' + '00000000' + '00' + '00');
  });
});

describe('warapp_my_games', () => {
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
    });
    expect(games[1]).toMatchObject({ state: 'DistributingTerritories', turn: null });
    expect(games[3]).toMatchObject({ state: 'WaitingForPlayers', turn: null });
    expect((games[3]!.players as unknown[])[1]).toEqual({ name: 'Cy', state: 'Invited', committed: false });
    expect(p.waitingOnYou).toBe(2);

    const ex = h!.exchanges[0]!;
    expect(ex.path).toBe('https://war.app/Services?m=GetMyGames&js=1');
    expect(ex.request.email).toBe(EMAIL);
    expect(t.params()).toBe('01040a0000000200000000000000');
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
  const player = (name: unknown, id: unknown, state: unknown, committed: unknown) =>
    ordered(GAME_INFO_PLAYER, [null, false, committed, 0, false, name, id, state, 0, false]);
  const info = (over: Record<number, unknown> = {}) => {
    const v: unknown[] = [1, 2, 's', 3, 4, 5, 1, 77, false, null, 39905, 0, null, 'N', 0, null, [], false, false, false, false, null, FINISHED, false, 0, null, 0];
    for (const [i, x] of Object.entries(over)) v[Number(i)] = x;
    return ordered(GAME_INFO, v);
  };

  it('is empty without a result, or with a null game list', () => {
    expect(readMyGames(stub(null), reader(false))).toEqual([]);
    expect(readMyGames(stub(ordered(MY_GAMES_RETURN, [null, 0])), reader(true))).toEqual([]);
  });

  it('skips null list items and names unknown codes by number', () => {
    const games = readMyGames(
      stub(ordered(MY_GAMES_RETURN, [[null, info({ 22: 42, 16: [null, player('Zed', 9, 77, false)] })], 0])),
      reader(true),
    );
    expect(games).toEqual([
      { id: 77, name: 'N', lastTurn: 0, stateCode: 42, players: [{ id: 9, name: 'Zed', stateCode: 77, committed: false }] },
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
      Re: 0,
      VF: false,
      $ctorError: 'ignored',
    };
    const [g] = readMyGames(stub(ordered(MY_GAMES_RETURN, [[info({ 16: [live] })], 0])), reader(true));
    expect(g!.players).toEqual([{ id: 123456, name: 'Ann', stateCode: 2, committed: true }]);
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
