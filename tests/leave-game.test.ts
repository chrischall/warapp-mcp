import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeMyGamesReturn, type SyntheticGame } from './protocol/my-games-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

// Synthetic account: the GameFeed id wraps the in-game id (123456) in check digits.
const ME = { feed: '3312345644', inGame: 123456 };
const SIGNED_IN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ME.feed}</p>` };
const GAME_ID = 4017;

interface FeedPlayer {
  id: string;
  name: string;
  state: string;
}

const me = (state = 'Playing'): FeedPlayer => ({ id: ME.feed, name: 'Me', state });
const host: FeedPlayer = { id: '1000', name: 'Host', state: 'Playing' };

/** A GameFeed game `GAME_ID` in `state` with `players`; `mods` sets the settings' Mods. */
function feedGame(players: FeedPlayer[], state = 'WaitingForPlayers', mods?: unknown): Record<string, unknown> {
  const f = lobbyFixture();
  const template = (f.players as Array<Record<string, string>>)[0]!;
  const { map: _map, ...rest } = f;
  return {
    ...rest,
    id: String(GAME_ID),
    name: 'Synthetic Lobby',
    state,
    numberOfTurns: '-1',
    players: players.map((p) => ({ ...template, ...p })),
    settings: { ...(f.settings as Record<string, unknown>), ...(mods !== undefined ? { Mods: mods } : {}) },
  };
}

const SEATED = feedGame([host, me()]);
const LEFT = feedGame([host, me('Declined')]);
const GONE = feedGame([host]);

type Routes = Partial<Record<number, (req: DecodedRequest, n: number) => Partial<ReplyFrame>>>;

interface Sent {
  gameId: number;
  modHook: boolean;
  left: number;
}

function leaveServer(reply: Partial<ReplyFrame> = { body: (w) => w.bool(false) }, extra: Routes = {}) {
  const sent: Sent[] = [];
  const warapp = (req: DecodedRequest, n: number): Partial<ReplyFrame> => {
    if (req.method === Method.DeclineGame) {
      const r = req.body;
      sent.push({ gameId: r.int32(), modHook: r.bool(), left: r.remaining });
      return reply;
    }
    const f = extra[req.method];
    if (!f) throw new Error(`unexpected method ${req.method}`);
    return f(req, n);
  };
  return { sent, warapp };
}

/** GameFeed answers: the preview's plan, the confirmed call's plan, then the read-back (the last repeating). */
async function harness(feed: unknown[], warapp?: (req: DecodedRequest, n: number) => Partial<ReplyFrame>) {
  return liveHarness({ pages: SIGNED_IN, feed, ...(warapp ? { warapp } : {}) });
}

async function confirmed(args: Record<string, unknown>) {
  const preview = payload(await h!.call('warapp_leave_game', args));
  expect(preview.confirmToken).toEqual(expect.any(String));
  return h!.call('warapp_leave_game', { ...args, confirmToken: preview.confirmToken });
}

describe('warapp_leave_game (#217)', () => {
  it('is a confirm-gated, destructive, non-idempotent write that reaches other people', async () => {
    h = await liveHarness();
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_leave_game')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(tool.description).toMatch(/DeclineGame/);
    expect(tool.description).toMatch(/WaitingForPlayers|lobby/i);
  });

  it('previews the leave, warns that it gives up the seat, and sends nothing until confirmed', async () => {
    const s = leaveServer();
    h = await harness([SEATED], s.warapp);
    const preview = payload(await h.call('warapp_leave_game', { game_id: GAME_ID }));
    const text = JSON.stringify(preview);
    expect(text).toContain('Synthetic Lobby');
    expect(text).toMatch(/gives up your seat/i);
    expect(text).toMatch(/chat/i);
    expect(s.sent).toEqual([]);
  });

  it('sends DeclineGame (64) with the game id and the mod-hook flag false, and reports left once GameFeed shows the seat declined', async () => {
    const s = leaveServer();
    h = await harness([SEATED, SEATED, LEFT], s.warapp);
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(s.sent).toEqual([{ gameId: GAME_ID, modHook: false, left: 0 }]);
    expect(p).toMatchObject({ status: 'left', game: { id: GAME_ID, name: 'Synthetic Lobby' } });
    expect(p.outcome).toBe('confirmed');
  });

  it('reports left when GameFeed no longer lists the account at all', async () => {
    const s = leaveServer();
    h = await harness([SEATED, SEATED, GONE], s.warapp);
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(p.status).toBe('left');
  });

  it('passes on the reply\'s "chat removed" flag, but never decides success from it', async () => {
    const s = leaveServer({ body: (w) => w.bool(true) }, { [Method.GetMyGames]: () => ({ body: (w) => w.bool(false) }) });
    h = await harness([SEATED, SEATED, LEFT], s.warapp);
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(p).toMatchObject({ status: 'left', chatRemoved: true });
    await h.harness.close();
    // The same reply with GameFeed still showing the seat: not left.
    h = await harness([SEATED], leaveServer({ body: (w) => w.bool(true) }, { [Method.GetMyGames]: () => ({ body: (w) => w.bool(false) }) }).warapp);
    const q = payload(await confirmed({ game_id: GAME_ID }));
    expect(q.status).toBe('unconfirmed');
    expect(q.outcome).toBe('unconfirmed');
    expect(String(q.warning)).toMatch(/still/i);
  });

  it('falls back to my games when GameFeed cannot be read: a listed lobby showing me Declined is left; Playing is not', async () => {
    const lobby = (state: number): SyntheticGame => ({
      id: GAME_ID,
      name: 'Synthetic Lobby',
      lastTurn: -1,
      state: 2,
      players: [
        { id: 1000, name: 'Host', state: 2, committed: false },
        { id: ME.inGame, name: 'Me', state, committed: false },
      ],
      openSeats: [-1],
      maxPlayers: null,
    });
    const broken = { termsOfUse: 'x', error: 'Something broke' };
    for (const [state, status] of [[5, 'left'], [2, 'unconfirmed']] as const) {
      const s = leaveServer(undefined, { [Method.GetMyGames]: () => ({ body: (w) => writeMyGamesReturn(w, [lobby(state)]) }) });
      h = await harness([SEATED, SEATED, broken], s.warapp);
      const p = payload(await confirmed({ game_id: GAME_ID }));
      expect(p.status, `state ${state}`).toBe(status);
      await h.harness.close();
      h = undefined;
    }
  });

  it('a lobby missing from my games is not proof of leaving (the list is paged): unconfirmed', async () => {
    const s = leaveServer(undefined, { [Method.GetMyGames]: () => ({ body: (w) => writeMyGamesReturn(w, []) }) });
    h = await harness([SEATED, SEATED, { termsOfUse: 'x', error: 'Something broke' }], s.warapp);
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(p.status).toBe('unconfirmed');
  });

  it('refuses a game that has started, pointing to surrender, without sending', async () => {
    const s = leaveServer();
    h = await harness([feedGame([host, me()], 'Playing')], s.warapp);
    const res = await h.call('warapp_leave_game', { game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not a lobby|has started|WaitingForPlayers/i);
    expect(textOf(res)).toMatch(/warapp_surrender/);
    expect(s.sent).toEqual([]);
  });

  it('refuses a lobby the signed-in account holds no seat in (absent, invited or already declined)', async () => {
    for (const players of [[host], [host, me('Invited')], [host, me('Declined')]]) {
      const s = leaveServer();
      h = await harness([feedGame(players)], s.warapp);
      const res = await h.call('warapp_leave_game', { game_id: GAME_ID });
      expect(res.isError, JSON.stringify(players)).toBe(true);
      expect(textOf(res)).toMatch(/not a player|no seat|not seated/i);
      expect(s.sent).toEqual([]);
      await h.harness.close();
      h = undefined;
    }
  });

  it('refuses a mod game (a mod may hook the leave), without sending', async () => {
    const s = leaveServer();
    h = await harness([feedGame([host, me()], 'WaitingForPlayers', [{ id: 1 }])], s.warapp);
    const res = await h.call('warapp_leave_game', { game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/mod/i);
    expect(s.sent).toEqual([]);
  });

  it('refuses when the signed-in account cannot be read', async () => {
    const s = leaveServer();
    h = await liveHarness({ feed: [SEATED], warapp: s.warapp });
    const res = await h.call('warapp_leave_game', { game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Could not tell which war\.app account is signed in/);
    expect(s.sent).toEqual([]);
  });

  it.each([
    [191, /you created|your own/i],
    [88, /deleted/i],
  ])('war.app error %i is a refusal in the client\'s terms', async (code, wording) => {
    const s = leaveServer({ error: { code, message: 'nope' } });
    h = await harness([SEATED], s.warapp);
    const res = await confirmed({ game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(wording);
    expect(textOf(res)).toContain(`war.app error ${code}`);
  });

  it.each([17, 4, 7])('war.app error %i (not in the game / player state) is read back like the client, not trusted', async (code) => {
    const s = leaveServer({ error: { code, message: 'nope' } });
    h = await harness([SEATED, SEATED, LEFT], s.warapp);
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(p.status).toBe('left');
    expect(p.outcome).toBe('confirmed');
  });

  it('war.app error 4 with the seat still held reads back as not applied, worded from game state', async () => {
    const s = leaveServer({ error: { code: 4, message: 'nope' } });
    h = await harness([SEATED, SEATED, SEATED], s.warapp);
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(p.status).not.toBe('left');
    expect(p.outcome).not.toBe('confirmed');
  });

  it('refuses when the settings cannot be read (whether the game uses mods is unknown), sending nothing', async () => {
    const { settings: _s, ...noSettings } = SEATED;
    const s = leaveServer();
    h = await harness([noSettings], s.warapp);
    const res = await h.call('warapp_leave_game', { game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/settings could not be read/);
    expect(s.sent).toEqual([]);
  });

  it('a transport failure is unknown and never resent', async () => {
    let calls = 0;
    h = await harness([SEATED], () => {
      calls += 1;
      return { msgNum: 999 };
    });
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(p.status).toBe('unknown');
    expect(p.outcome).toBe('unknown');
    expect(calls).toBe(1);
    expect(String(p.warning)).toMatch(/warapp_my_games|warapp_get_game/);
    expect(String(p.warning)).not.toMatch(/try again|resend|retry/i);
  });
});
