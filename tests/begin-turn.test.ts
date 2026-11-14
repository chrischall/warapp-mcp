import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

// Synthetic account: the GameFeed id wraps the in-game id in check digits.
const ME = { feed: '3312345644', inGame: 123456 };
const SIGNED_IN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ME.feed}</p>` };
const GAME_ID = 4001;

const BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ME.inGame, armies: 5 },
  { id: 161, fogLevel: 2, owner: 0, armies: 2 },
];

/** A GameFeed speed-first-turn game (No-luck cycle) on its first turn, the account seated. */
function feedGame(extra: Record<string, unknown> = {}, myState = 'Playing'): Record<string, unknown> {
  const f = lobbyFixture();
  const template = (f.players as Array<Record<string, string>>)[0]!;
  return {
    ...f,
    id: String(GAME_ID),
    name: 'Synthetic Race',
    state: 'Playing',
    numberOfTurns: '0',
    settings: { ...(f.settings as Record<string, unknown>), MoveOrder: 'NoLuckCycle' },
    players: [
      { ...template, id: ME.feed, name: 'Me', state: myState },
      { ...template, id: '7176543229', name: 'Opponent', state: 'Playing' },
    ],
    ...extra,
  };
}

/**
 * A fake war.app: GetLatestGameInfo answers from `boards` in turn (the last
 * repeating; null: no standing; 'fail': a war.app error), BeginFirstTurn records what it was sent and
 * answers `begin`.
 */
function server(boards: Array<SyntheticTerritory[] | null | 'fail'>, begin: Partial<ReplyFrame> = { body: (w) => w.bool(false) }) {
  const begun: Array<{ gameId: number; left: number }> = [];
  let reads = 0;
  const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method === Method.GetLatestGameInfo) {
      const b = boards[Math.min(reads++, boards.length - 1)]!;
      if (b === 'fail') return { error: { code: 99, message: 'read failed' } };
      return { body: (w) => writeLatestGameInfo(w, b, [ME.inGame]) };
    }
    if (req.method === Method.BeginFirstTurn) {
      begun.push({ gameId: req.body.int32(), left: req.body.remaining });
      return begin;
    }
    throw new Error(`unexpected method ${req.method}`);
  };
  return { begun, warapp };
}

async function confirmed(args: Record<string, unknown>) {
  const preview = payload(await h!.call('warapp_begin_turn', args));
  expect(preview.confirmToken).toEqual(expect.any(String));
  return h!.call('warapp_begin_turn', { ...args, confirmToken: preview.confirmToken });
}

describe('warapp_begin_turn', () => {
  it('previews a warning that Begin starts the timer and sends nothing until confirmed', async () => {
    const s = server([null]);
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame()], warapp: s.warapp });
    const preview = payload(await h.call('warapp_begin_turn', { game_id: GAME_ID }));
    const text = JSON.stringify(preview);
    expect(text).toMatch(/starts? (your|the) (first-turn |turn )?timer/i);
    expect(text).toMatch(/plan and submit/i);
    expect(text).toContain('Synthetic Race');
    expect(s.begun).toEqual([]);
  });

  it('on confirm sends BeginFirstTurn with the game id alone, then reads the board back', async () => {
    const s = server([null, null, BOARD]);
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame()], warapp: s.warapp });
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(s.begun).toEqual([{ gameId: GAME_ID, left: 0 }]);
    expect(p).toMatchObject({ status: 'begun', game: { id: GAME_ID, name: 'Synthetic Race' }, territoriesVisible: 2 });
    expect(p.outcome).toBe('confirmed');
    expect(String(p.next)).toMatch(/warapp_plan_turn/);
  });

  it('reports unconfirmed when the board is still hidden after Begin', async () => {
    const s = server([null]);
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame()], warapp: s.warapp });
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(s.begun).toHaveLength(1);
    expect(p.status).toBe('unconfirmed');
    expect(p.outcome).toBe('unconfirmed');
    expect(String(p.warning)).toMatch(/warapp_get_live_board/);
  });

  it('reports unknown (never retried) when the send fails in transport', async () => {
    const s = server([null], { msgNum: 999 });
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame()], warapp: s.warapp });
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(s.begun).toHaveLength(1);
    expect(p.status).toBe('unknown');
    expect(p.outcome).toBe('unknown');
    expect(String(p.warning)).toMatch(/may already/i);
  });

  it('treats war.app error 4 as the client does (ignored) and reads the board back', async () => {
    const s = server([null, null, BOARD], { error: { code: 4, message: 'x' } });
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame()], warapp: s.warapp });
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(p.status).toBe('begun');
    expect(p.outcome).toBe('confirmed');
  });

  it('error 4 with the board still hidden is not begun, never "probably running" (#130)', async () => {
    const s = server([null], { error: { code: 4, message: 'x' } });
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame()], warapp: s.warapp });
    const res = await confirmed({ game_id: GAME_ID });
    expect(res.isError).toBeFalsy();
    const p = payload(res);
    expect(p.status).toBe('not_begun');
    expect(p.outcome).toBe('not_applied');
    expect(String(p.warning)).toMatch(/error 4/);
    expect(String(p.warning)).not.toMatch(/probably running/);
  });

  it('error 4 then a failed read-back stays unconfirmed: nothing was read, so nothing is claimed', async () => {
    const s = server([null, null, 'fail'], { error: { code: 4, message: 'x' } });
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame()], warapp: s.warapp });
    const res = await confirmed({ game_id: GAME_ID });
    expect(res.isError).toBeFalsy();
    const p = payload(res);
    expect(p.status).toBe('unconfirmed');
    expect(p.outcome).toBe('unconfirmed');
    expect(String(p.warning)).toMatch(/could not be read/);
    expect(String(p.warning)).not.toMatch(/did not take effect/);
  });

  it('surfaces any other war.app error', async () => {
    const s = server([null], { error: { code: 88, message: 'x' } });
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame()], warapp: s.warapp });
    const res = await confirmed({ game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/deleted/);
  });

  it('refuses without sending when the board is already visible (Begin was pressed)', async () => {
    const s = server([BOARD]);
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame()], warapp: s.warapp });
    const res = await h.call('warapp_begin_turn', { game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/already/i);
    expect(textOf(res)).toMatch(/warapp_plan_turn/);
    expect(s.begun).toEqual([]);
  });

  it.each([
    ['past the first turn', feedGame({ numberOfTurns: '3' }), /first turn/i],
    ['a lobby', feedGame({ state: 'WaitingForPlayers', numberOfTurns: '-1' }), /not started|lobby/i],
    ['a finished game', feedGame({ state: 'Finished' }), /over|finished/i],
    ['a game without the speed first turn', feedGame({ settings: lobbyFixture().settings }), /speed|Begin/i],
    ['a seat no longer playing', feedGame({}, 'Eliminated'), /no longer playing/i],
  ])('refuses %s without sending', async (_label, game, wording) => {
    const s = server([null]);
    h = await liveHarness({ pages: SIGNED_IN, feed: [game], warapp: s.warapp });
    const res = await h.call('warapp_begin_turn', { game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(wording);
    expect(s.begun).toEqual([]);
  });

  it('refuses a game the signed-in account is not in, and an unknown account, without sending', async () => {
    const s = server([null]);
    h = await liveHarness({
      pages: { 'https://war.app/InviteToken': '<p>Your invite token is 9912345699</p>' },
      feed: [feedGame()],
      warapp: s.warapp,
    });
    const res = await h.call('warapp_begin_turn', { game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/signed-in war\.app account is not a player in game/i);
    await h.harness.close();
    h = await liveHarness({ pages: {}, feed: [feedGame()], warapp: s.warapp });
    const unknown = await h.call('warapp_begin_turn', { game_id: GAME_ID });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/signed in/i);
    expect(s.begun).toEqual([]);
  });
});
