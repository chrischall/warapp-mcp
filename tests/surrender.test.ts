import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { recordOutlook } from '../src/outlook-log.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

// Synthetic account: GameFeed id wraps the in-game id in check digits.
const ME = { feed: '3312345644' };
const SIGNED_IN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ME.feed}</p>` };
const GAME_ID = 4001;

interface FeedPlayer {
  id: string;
  name: string;
  state: string;
  isAI?: string;
  hasCommittedOrders?: string;
}

const me = (state = 'Playing'): FeedPlayer => ({ id: ME.feed, name: 'Me', state });
const opp = (n: number, state = 'Playing'): FeedPlayer => ({ id: String(1000 + n), name: `Opponent ${n}`, state });

/**
 * A GameFeed game `GAME_ID` named `name` in `state` with `players`; `settings` override the
 * lobby fixture's (whose surrender is instant). Everyone has committed unless a player says not,
 * so no one is close to a boot.
 */
function feedGame(
  players: FeedPlayer[],
  state = 'Playing',
  name = 'Synthetic Duel',
  settings: Record<string, unknown> = {},
): Record<string, unknown> {
  const f = lobbyFixture();
  const template = (f.players as Array<Record<string, string>>)[0]!;
  return {
    ...f,
    id: String(GAME_ID),
    name,
    state,
    numberOfTurns: '5',
    settings: { ...(f.settings as Record<string, unknown>), ...settings },
    players: players.map((p) => ({ ...template, hasCommittedOrders: 'True', ...p })),
  };
}
/** Surrender needs the others' acceptance. */
const VOTE = { InstantSurrender: false };

const DUEL = [me(), opp(1)];
const THREE = [me(), opp(1), opp(2)];

interface Sent {
  gameId: number;
  surrender: boolean;
  trailing: boolean;
  left: number;
}

function surrenderServer(reply: Partial<ReplyFrame> = { body: (w) => w.bool(false) }) {
  const sent: Sent[] = [];
  const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method !== Method.Surrender) throw new Error(`unexpected method ${req.method}`);
    const r = req.body;
    sent.push({ gameId: r.int32(), surrender: r.bool(), trailing: r.bool(), left: r.remaining });
    return reply;
  };
  return { sent, warapp };
}

/**
 * GameFeed answers: the preview's plan, the confirmed call's plan, then the
 * post-send re-read (the last repeating).
 */
async function harness(feed: unknown[], warapp?: (req: DecodedRequest) => Partial<ReplyFrame>) {
  return liveHarness({ pages: SIGNED_IN, feed, ...(warapp ? { warapp } : {}) });
}

async function confirmed(args: Record<string, unknown>) {
  const preview = payload(await h!.call('warapp_surrender', args));
  expect(preview.confirmToken).toEqual(expect.any(String));
  return h!.call('warapp_surrender', { ...args, confirmToken: preview.confirmToken });
}

describe('warapp_surrender', () => {
  it('previews an unmistakable warning and sends nothing until confirmed', async () => {
    const s = surrenderServer();
    h = await harness([feedGame(DUEL)], s.warapp);
    const preview = payload(await h.call('warapp_surrender', { game_id: GAME_ID }));
    const text = JSON.stringify(preview);
    // The sentences name the game by id; its name is only in the delimited `game.name` field.
    expect(text).toContain(`This ENDS your game ${GAME_ID}`);
    expect(text).toContain('"name":"⟦Synthetic Duel⟧"');
    expect(text).toMatch(/you lose it and cannot rejoin/);
    expect(s.sent).toEqual([]);
  });

  it('surrenders a 1v1 on confirm and reports surrendered from GameFeed', async () => {
    const s = surrenderServer();
    const after = feedGame([me('SurrenderAccepted'), opp(1, 'Won')], 'Finished');
    h = await harness([feedGame(DUEL), feedGame(DUEL), after], s.warapp);
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(s.sent).toEqual([{ gameId: GAME_ID, surrender: true, trailing: false, left: 0 }]);
    expect(p).toMatchObject({ status: 'surrendered', game: { id: GAME_ID, name: 'Synthetic Duel' } });
    expect(p.outcome).toBe('confirmed');
  });

  it('reports a 3-player surrender as pending the others\' acceptance when the setting asks for it, not surrendered', async () => {
    const s = surrenderServer();
    h = await harness([feedGame(THREE, 'Playing', 'Synthetic Duel', VOTE)], s.warapp);
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(s.sent).toHaveLength(1);
    expect(p.status).toBe('pending');
    expect(p.outcome).toBe('accepted');
    expect(String(p.message)).toMatch(/accept/i);
  });

  it('reports unchanged when GameFeed still shows a 1v1 being played', async () => {
    const s = surrenderServer();
    h = await harness([feedGame(DUEL)], s.warapp);
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(s.sent).toHaveLength(1);
    expect(p.status).toBe('unchanged');
    expect(p.outcome).toBe('unconfirmed');
    expect(String(p.warning)).toMatch(/warapp_get_game/);
  });

  it('refuses a finished game without sending', async () => {
    const s = surrenderServer();
    h = await harness([feedGame([me('Won'), opp(1, 'Eliminated')], 'Finished')], s.warapp);
    const res = await h.call('warapp_surrender', { game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/already over/i);
    expect(s.sent).toEqual([]);
  });

  it('refuses a lobby: a game that has not started has nothing to surrender (#130)', async () => {
    const s = surrenderServer();
    h = await harness([feedGame(DUEL, 'WaitingForPlayers')], s.warapp);
    for (const undo of [false, true]) {
      const res = await h.call('warapp_surrender', { game_id: GAME_ID, undo });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/has not started/);
    }
    expect(s.sent).toEqual([]);
  });

  it('refuses a game the signed-in account is not playing in', async () => {
    const s = surrenderServer();
    h = await harness([feedGame([opp(1), opp(2)])], s.warapp);
    const res = await h.call('warapp_surrender', { game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/signed-in war\.app account is not a player in game/i);
    expect(s.sent).toEqual([]);
  });

  it('refuses a game the account has already left (eliminated)', async () => {
    h = await harness([feedGame([me('Eliminated'), opp(1), opp(2)])]);
    const res = await h.call('warapp_surrender', { game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no longer playing.*Eliminated/i);
  });

  it.each([
    [4, /game is over/i],
    [7, /no longer in the game/i],
    [230, /no longer in the game/i],
  ])('war.app error %i is mapped to a clear message', async (code, wording) => {
    const s = surrenderServer({ error: { code, message: 'nope' } });
    h = await harness([feedGame(DUEL)], s.warapp);
    const res = await confirmed({ game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(wording);
    expect(textOf(res)).toContain(`war.app error ${code}`);
  });

  it('an unanswered surrender is reported as unknown, never as safe to resend', async () => {
    h = await harness([feedGame(DUEL)], () => ({ msgNum: 999 }));
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(p.status).toBe('unknown');
    expect(p.outcome).toBe('unknown');
    expect(String(p.warning)).toMatch(/warapp_get_game/);
    expect(String(p.warning)).not.toMatch(/try again|resend|retry/i);
  });

  describe('undo', () => {
    it('previews taking back the pending surrender, then sends surrender=false', async () => {
      const s = surrenderServer();
      h = await harness([feedGame(THREE, 'Playing', 'Synthetic Brawl', VOTE)], s.warapp);
      const preview = payload(await h.call('warapp_surrender', { game_id: GAME_ID, undo: true }));
      const text = JSON.stringify(preview);
      expect(text).toContain(`take back your pending surrender in game ${GAME_ID}`);
      expect(text).toContain('"name":"⟦Synthetic Brawl⟧"');
      expect(text).not.toContain('ENDS');
      expect(s.sent).toEqual([]);
      const p = payload(await h.call('warapp_surrender', { game_id: GAME_ID, undo: true, confirmToken: preview.confirmToken }));
      expect(s.sent).toEqual([{ gameId: GAME_ID, surrender: false, trailing: false, left: 0 }]);
      // #130: GameFeed shows no pending surrender, so "still playing" cannot prove one was taken back.
      expect(p.status).toBe('still_playing');
      expect(p.outcome).toBe('accepted');
      expect(String(p.message)).toMatch(/no pending-surrender state/);
    });

    it('reports surrendered when the others accepted before the take-back landed', async () => {
      const s = surrenderServer();
      const after = feedGame([me('SurrenderAccepted'), opp(1), opp(2)], 'Playing', 'Synthetic Duel', VOTE);
      const three = feedGame(THREE, 'Playing', 'Synthetic Duel', VOTE);
      h = await harness([three, three, after], s.warapp);
      const p = payload(await confirmed({ game_id: GAME_ID, undo: true }));
      expect(p.status).toBe('surrendered');
      expect(p.outcome).toBe('confirmed');
    });

    it('refuses when GameFeed shows the surrender already accepted', async () => {
      h = await harness([feedGame([me('SurrenderAccepted'), opp(1), opp(2)])]);
      const res = await h.call('warapp_surrender', { game_id: GAME_ID, undo: true });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/already accepted/i);
    });

    it('refuses in a two-player game, where a surrender is never pending', async () => {
      const s = surrenderServer();
      h = await harness([feedGame(DUEL)], s.warapp);
      const res = await h.call('warapp_surrender', { game_id: GAME_ID, undo: true });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/no pending surrender/i);
      expect(s.sent).toEqual([]);
    });
  });

  describe('the settings and the outlook (#178)', () => {
    it('reads acceptance from the setting, not the player count: an instant surrender in a 3-player game ends it at once', async () => {
      const s = surrenderServer();
      h = await harness([feedGame(THREE)], s.warapp);
      const preview = payload(await h.call('warapp_surrender', { game_id: GAME_ID }));
      const v = preview.preview as Record<string, unknown>;
      expect(v.acceptance).toMatchObject({ needed: false, from: 'setting' });
      expect(JSON.stringify(preview)).not.toMatch(/others must accept/);
      const p = payload(await h.call('warapp_surrender', { game_id: GAME_ID, confirmToken: preview.confirmToken }));
      // Still Playing after an instant surrender is not a pending one.
      expect(p.status).toBe('unchanged');
      expect(p.outcome).toBe('unconfirmed');
    });

    it('refuses to take back an instant surrender in any game, which is never pending', async () => {
      h = await harness([feedGame(THREE)]);
      const res = await h.call('warapp_surrender', { game_id: GAME_ID, undo: true });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/no pending surrender.*instant/i);
    });

    it('allows pending and undo in a two-player game when the setting says surrender is not instant (UNVERIFIED that it waits)', async () => {
      const s = surrenderServer();
      h = await harness([feedGame(DUEL, 'Playing', 'Synthetic Duel', VOTE)], s.warapp);
      const preview = payload(await h.call('warapp_surrender', { game_id: GAME_ID }));
      const v = preview.preview as Record<string, unknown>;
      expect(v.acceptance).toMatchObject({ needed: true, from: 'setting' });
      expect(String((v.acceptance as { note: string }).note)).toMatch(/UNVERIFIED/);
      const p = payload(await h.call('warapp_surrender', { game_id: GAME_ID, confirmToken: preview.confirmToken }));
      expect(p.status).toBe('pending');
      expect(p.outcome).toBe('accepted');
      const undo = payload(await h.call('warapp_surrender', { game_id: GAME_ID, undo: true }));
      expect(undo.confirmToken).toEqual(expect.any(String));
    });

    it('falls back to the player count when the setting cannot be read, and says so', async () => {
      h = await harness([feedGame(THREE, 'Playing', 'Synthetic Duel', { InstantSurrender: 'Mystery' })]);
      const preview = payload(await h.call('warapp_surrender', { game_id: GAME_ID }));
      const v = preview.preview as Record<string, unknown>;
      expect(v.acceptance).toMatchObject({ needed: true, from: 'player count' });
      expect(String((v.acceptance as { note: string }).note)).toMatch(/could not be read/);
    });

    it('says what my land becomes and which opponents are AIs', async () => {
      h = await harness([
        feedGame([me(), { ...opp(1), isAI: 'True' }, opp(2)], 'Playing', 'Synthetic Duel', { SurrenderedPlayersTurnIntoAIs: true }),
      ]);
      const preview = payload(await h.call('warapp_surrender', { game_id: GAME_ID }));
      const v = preview.preview as Record<string, unknown>;
      expect(v.yourLandBecomes).toBe('AI');
      expect(v.aiOpponents).toEqual([{ id: 1001, name: '⟦Opponent 1⟧' }]);
      await h.harness.close();
      h = await harness([feedGame(DUEL)]);
      const plain = payload(await h.call('warapp_surrender', { game_id: GAME_ID })).preview as Record<string, unknown>;
      expect(plain.yourLandBecomes).toBe('neutral');
      expect(plain.aiOpponents).toEqual([]);
    });

    it('shows the outlook warapp_plan_turn last logged, with its basis, or says there is none', async () => {
      h = await harness([feedGame(DUEL)]);
      const none = payload(await h.call('warapp_surrender', { game_id: GAME_ID })).preview as Record<string, unknown>;
      expect(String((none.outlook as { note: string }).note)).toMatch(/warapp_plan_turn/);
      await recordOutlook(h.dataDir, GAME_ID, Number(ME.feed), {
        state: 'losing',
        heldTurns: 3,
        k: 3,
        threshold: 2.4,
        basis: 'Losing for 3 turns running.',
        turns: [{ turn: 5, mine: 10, strongest: { playerId: 1001, low: 40, high: 40 }, ratio: { low: 0.25, high: 0.25 }, changed: 1, state: 'losing' }],
      });
      const p = payload(await h.call('warapp_surrender', { game_id: GAME_ID })).preview as Record<string, unknown>;
      expect(p.outlook).toMatchObject({ turn: 5, state: 'losing', basis: 'Losing for 3 turns running.' });
    });

    it('lists opponents close to a boot, what their seat becomes, and that lastTurnTime is unverified', async () => {
      h = await harness([feedGame([me(), { ...opp(1), hasCommittedOrders: 'False' }, opp(2)])]);
      const preview = payload(await h.call('warapp_surrender', { game_id: GAME_ID }));
      const v = preview.preview as Record<string, unknown>;
      const l = v.leavers as { players: Array<Record<string, unknown>>; unverified: string };
      expect(l.players).toEqual([expect.objectContaining({ id: 1001, becomes: 'neutral', autoBootInMinutes: 0 })]);
      expect(l.unverified).toMatch(/lastTurnTime/);
    });
  });
});
