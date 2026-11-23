// #523 close-out: warapp_close_finished_game sends GetEndGameWindowData (85) — what the client sends when it shows a
// finished game's end-of-game window, and what sets SeenEndGameWindow, which drops the game from the app's My Games
// (the Default list). Synthetic answers only (the call itself was verified live 2026-11-23).
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

const ME = { feed: '3312345644', inGame: 123456 };
const SIGNED_IN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ME.feed}</p>` };
const GAME_ID = 4017;

function feedGame(state: string, myState = 'SurrenderAccepted', seated = true): Record<string, unknown> {
  const f = lobbyFixture();
  const template = (f.players as Array<Record<string, string>>)[0]!;
  const { map: _map, ...rest } = f;
  const players = [{ id: '1000', name: 'Winner', state: 'Won' }, ...(seated ? [{ id: ME.feed, name: 'Me', state: myState }] : [])];
  return { ...rest, id: String(GAME_ID), name: 'Synthetic Game', state, numberOfTurns: '28', players: players.map((p) => ({ ...template, ...p })) };
}
const FINISHED = feedGame('Finished');

const listed = (seen: boolean): SyntheticGame => ({
  id: GAME_ID,
  name: 'Synthetic Game',
  lastTurn: 28,
  state: 4,
  players: [
    { id: 1000, name: 'Winner', state: 4, committed: false },
    { id: ME.inGame, name: 'Me', state: 7, committed: false },
  ],
  seenEndGame: seen,
});

/** war.app: GetEndGameWindowData recorded; GetMyGames answers `lists` in turn (the last repeating). */
function server(lists: SyntheticGame[][], reply: Partial<ReplyFrame> = { body: (w) => w.bool(false) }) {
  const sent: { gameId: number; left: number }[] = [];
  let n = 0;
  const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method === Method.GetEndGameWindowData) {
      const r = req.body;
      sent.push({ gameId: r.int32(), left: r.remaining });
      return reply;
    }
    if (req.method === Method.GetMyGames) {
      const l = lists[Math.min(n++, lists.length - 1)]!;
      return { body: (w) => writeMyGamesReturn(w, l) };
    }
    throw new Error(`unexpected method ${req.method}`);
  };
  return { sent, warapp };
}

async function confirmed(args: Record<string, unknown>) {
  const preview = payload(await h!.call('warapp_close_finished_game', args));
  expect(preview.confirmToken).toEqual(expect.any(String));
  return h!.call('warapp_close_finished_game', { ...args, confirmToken: preview.confirmToken });
}

describe('warapp_close_finished_game (#523)', () => {
  it('is a confirm-gated, non-destructive write that reaches no other player', async () => {
    h = await liveHarness();
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_close_finished_game')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(tool.description).toMatch(/GetEndGameWindowData/);
    expect(tool.description).toMatch(/Verified live/);
  });

  it('previews by id, sends nothing until confirmed', async () => {
    const s = server([[listed(false)]]);
    h = await liveHarness({ pages: SIGNED_IN, feed: [FINISHED], warapp: s.warapp });
    const preview = payload(await h.call('warapp_close_finished_game', { game_id: GAME_ID }));
    expect(String(preview.summary ?? JSON.stringify(preview))).toContain(String(GAME_ID));
    expect(s.sent).toEqual([]);
  });

  it('sends GetEndGameWindowData (85) with the game id only, and reports closed once the list shows it seen', async () => {
    const s = server([[listed(false)], [listed(false)], [listed(true)]]);
    h = await liveHarness({ pages: SIGNED_IN, feed: [FINISHED], warapp: s.warapp });
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(s.sent).toEqual([{ gameId: GAME_ID, left: 0 }]);
    expect(p).toMatchObject({ status: 'closed', outcome: 'confirmed', game: { id: GAME_ID } });
  });

  it('is unconfirmed when the list still shows it unseen, or does not list it', async () => {
    for (const after of [[listed(false)], []]) {
      const s = server([[listed(false)], [listed(false)], after]);
      h = await liveHarness({ pages: SIGNED_IN, feed: [FINISHED], warapp: s.warapp });
      const p = payload(await confirmed({ game_id: GAME_ID }));
      expect(p).toMatchObject({ status: 'unconfirmed', outcome: 'unconfirmed' });
      await h.harness.close();
      h = undefined;
    }
  });

  it('refuses a game not finished, one the account did not play, and one already closed, sending nothing', async () => {
    const cases: [Record<string, unknown>, SyntheticGame[], RegExp][] = [
      [feedGame('Playing', 'Playing'), [listed(false)], /not finished|still/i],
      [feedGame('Finished', 'SurrenderAccepted', false), [listed(false)], /did not play|no seat|not.*player/i],
      [FINISHED, [listed(true)], /already closed/i],
    ];
    for (const [game, list, why] of cases) {
      const s = server([list]);
      h = await liveHarness({ pages: SIGNED_IN, feed: [game], warapp: s.warapp });
      const res = await h.call('warapp_close_finished_game', { game_id: GAME_ID });
      expect(res.isError, String(why)).toBe(true);
      expect(textOf(res)).toMatch(why);
      expect(s.sent).toEqual([]);
      await h.harness.close();
      h = undefined;
    }
  });
});
