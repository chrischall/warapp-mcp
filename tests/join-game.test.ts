import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Writer } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { OPEN_GAMES_URL } from '../src/open-games.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeGameInfo, type SyntheticGame } from './protocol/my-games-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

// Synthetic account: GameFeed id wraps the in-game id in check digits.
const ME = { feed: '3312345644', inGame: 123456 };
const SIGNED_IN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ME.feed}</p>` };

const WAITING = 2;
const P_PLAYING = 2;
const HOST = { id: 111111, name: 'Host', state: P_PLAYING, committed: false };

const OPEN: Record<string, SyntheticGame> = {
  plain: { id: 3001, name: 'Plain FFA', lastTurn: -1, state: WAITING, players: [HOST], openSeats: [-1, -1], maxPlayers: null, bootTimeMs: 3 * 86_400_000 },
  full: { id: 3002, name: 'No room', lastTurn: -1, state: WAITING, players: [HOST], openSeats: [], maxPlayers: null },
  teams: { id: 3003, name: 'Teams', lastTurn: -1, state: WAITING, players: [{ ...HOST, team: 0 }], openSeats: [1, 0], maxPlayers: null },
  coins: { id: 3004, name: 'Coin game', lastTurn: -1, state: WAITING, players: [HOST], openSeats: [-1], maxPlayers: null, entryFee: 25, prize: 40 },
  scenario: { id: 3005, name: 'Scenario', lastTurn: -1, state: WAITING, players: [HOST], openSeats: [-1], maxPlayers: null, settings: { distribution: -3 } },
  mods: { id: 3006, name: 'Modded', lastTurn: -1, state: WAITING, players: [HOST], openSeats: [-1], maxPlayers: null, settings: { settingsString: '3;f;;p;p;m' } },
};

const hexOf = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();

function openGamesPage(games: readonly SyntheticGame[] = Object.values(OPEN)): string {
  const w = new Writer().int32(games.length);
  for (const g of games) writeGameInfo(w, g);
  return `<html><script type="text/plain" id="AllOpenGamesData">${hexOf(w.bytes())}</script></html>`;
}

/** A GameFeed lobby for `id`; `withMe` seats the signed-in account. */
function feedGame(id: number, withMe: boolean): Record<string, unknown> {
  const f = lobbyFixture();
  const players = f.players as Array<Record<string, string>>;
  return {
    ...f,
    id: String(id),
    state: 'WaitingForPlayers',
    players: withMe ? [...players.slice(0, 1), { ...players[0]!, id: ME.feed, name: 'Me', state: 'Playing' }] : players.slice(0, 1),
  };
}

type Routes = Partial<Record<number, (req: DecodedRequest, n: number) => Partial<ReplyFrame>>>;
function routes(r: Routes) {
  return (req: DecodedRequest, n: number): Partial<ReplyFrame> => {
    const f = r[req.method];
    if (!f) throw new Error(`unexpected method ${req.method}`);
    return f(req, n);
  };
}

interface Sent {
  gameId: number;
  colour: boolean;
  team: number;
  slot: boolean;
  modHook: boolean;
  left: number;
}

function joinServer(reply: Partial<ReplyFrame> = { body: (w) => w.bool(true).bool(false).bool(false) }, extra: Routes = {}) {
  const sent: Sent[] = [];
  const warapp = routes({
    [Method.AcceptOpenSeat]: (req) => {
      const r = req.body;
      sent.push({ gameId: r.int32(), colour: r.bool(), team: r.int32(), slot: r.bool(), modHook: r.bool(), left: r.remaining });
      return reply;
    },
    ...extra,
  });
  return { sent, warapp };
}

async function harness(opts: { feed?: unknown[]; warapp?: ReturnType<typeof joinServer>['warapp']; games?: SyntheticGame[] } = {}) {
  return liveHarness({
    pages: { [OPEN_GAMES_URL]: openGamesPage(opts.games), ...SIGNED_IN },
    ...(opts.feed ? { feed: opts.feed } : {}),
    ...(opts.warapp ? { warapp: opts.warapp } : {}),
  });
}

async function confirmed(name: string, args: Record<string, unknown>) {
  const preview = payload(await h!.call(name, args));
  expect(preview.confirmToken).toEqual(expect.any(String));
  return h!.call(name, { ...args, confirmToken: preview.confirmToken });
}

describe('warapp_join_game', () => {
  it('previews the game (name, pace, seats, rules) and sends nothing until confirmed', async () => {
    const s = joinServer();
    h = await harness({ warapp: s.warapp });
    const preview = payload(await h.call('warapp_join_game', { game_id: 3001 }));
    const text = JSON.stringify(preview);
    expect(text).toContain('Plain FFA');
    expect(text).toContain('multi-day');
    expect(text).toContain('"openSeats":2');
    expect(text).toContain('Automatic distribution');
    expect(s.sent).toEqual([]);
  });

  it('joins on confirm with AcceptOpenSeat and reports joined when GameFeed lists the account', async () => {
    const s = joinServer();
    h = await harness({ warapp: s.warapp, feed: [feedGame(3001, true)] });
    const p = payload(await confirmed('warapp_join_game', { game_id: 3001 }));
    expect(s.sent).toEqual([{ gameId: 3001, colour: false, team: -1, slot: false, modHook: false, left: 0 }]);
    expect(p).toMatchObject({ status: 'joined', game: { id: 3001, name: 'Plain FFA' } });
  });

  it('says the join is unconfirmed when neither GameFeed nor my games lists the account', async () => {
    const s = joinServer(undefined, { [Method.GetMyGames]: () => ({ body: (w) => w.bool(false) }) });
    h = await harness({ warapp: s.warapp, feed: [feedGame(3001, false)] });
    const p = payload(await confirmed('warapp_join_game', { game_id: 3001 }));
    expect(s.sent).toHaveLength(1);
    expect(p.status).toBe('unconfirmed');
    expect(String(p.warning)).toMatch(/could not confirm/i);
  });

  it('reports a vacation the join ended', async () => {
    const s = joinServer({ body: (w) => w.bool(true).bool(true).bool(false) });
    h = await harness({ warapp: s.warapp, feed: [feedGame(3001, true)] });
    const p = payload(await confirmed('warapp_join_game', { game_id: 3001 }));
    expect(p).toMatchObject({ status: 'joined', vacationEnded: true });
  });

  it('refuses a game that is not on the open games list', async () => {
    h = await harness();
    const res = await h.call('warapp_join_game', { game_id: 9999 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not on war\.app's open games list/i);
  });

  it('refuses a full game', async () => {
    h = await harness();
    const res = await h.call('warapp_join_game', { game_id: 3002 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no open seat/i);
  });

  it('refuses a team game unless allow_team, then takes the first open seat\'s team', async () => {
    const s = joinServer();
    h = await harness({ warapp: s.warapp, feed: [feedGame(3003, true)] });
    const res = await h.call('warapp_join_game', { game_id: 3003 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/team game.*allow_team/is);
    const p = payload(await confirmed('warapp_join_game', { game_id: 3003, allow_team: true }));
    expect(p.status).toBe('joined');
    expect(s.sent[0]).toMatchObject({ gameId: 3003, team: 1 });
  });

  it('refuses a coin entry fee unless accept_entry_fee', async () => {
    const s = joinServer();
    h = await harness({ warapp: s.warapp, feed: [feedGame(3004, true)] });
    const res = await h.call('warapp_join_game', { game_id: 3004 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/25 coins.*accept_entry_fee/is);
    const preview = payload(await h.call('warapp_join_game', { game_id: 3004, accept_entry_fee: true }));
    expect(JSON.stringify(preview)).toContain('"entryFeeCoins":25');
  });

  it('refuses a custom-scenario game', async () => {
    h = await harness();
    const res = await h.call('warapp_join_game', { game_id: 3005 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/custom scenario/i);
  });

  it('refuses a game with mods', async () => {
    h = await harness();
    const res = await h.call('warapp_join_game', { game_id: 3006 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/mods/i);
  });

  it.each([
    [254, /your slot was assigned to someone else by the game creator/],
    [750, /the slot you joined is no longer available/],
    [473, /don't have enough coins to join this game/],
    [120, /open seat is no longer available/],
  ])('a war.app refusal %i is an error in the client wording', async (code, wording) => {
    const s = joinServer({ error: { code, message: 'nope' } });
    h = await harness({ warapp: s.warapp });
    const res = await confirmed('warapp_join_game', { game_id: 3001 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(wording);
    expect(textOf(res)).toContain(`war.app error ${code}`);
  });

  it('an unanswered join is reported as unknown, not as safe to retry', async () => {
    h = await harness({ warapp: routes({ [Method.AcceptOpenSeat]: () => ({ msgNum: 999 }) }) });
    const p = payload(await confirmed('warapp_join_game', { game_id: 3001 }));
    expect(p.status).toBe('unknown');
    expect(String(p.warning)).toMatch(/may already have joined.*warapp_my_games/is);
  });
});
