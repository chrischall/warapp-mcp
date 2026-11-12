import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
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
}

const me = (state = 'Playing'): FeedPlayer => ({ id: ME.feed, name: 'Me', state });
const opp = (n: number, state = 'Playing'): FeedPlayer => ({ id: String(1000 + n), name: `Opponent ${n}`, state });

/** A GameFeed game `GAME_ID` named `name` in `state` with `players`. */
function feedGame(players: FeedPlayer[], state = 'Playing', name = 'Synthetic Duel'): Record<string, unknown> {
  const f = lobbyFixture();
  const template = (f.players as Array<Record<string, string>>)[0]!;
  return {
    ...f,
    id: String(GAME_ID),
    name,
    state,
    numberOfTurns: '5',
    players: players.map((p) => ({ ...template, ...p })),
  };
}

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
    expect(text).toContain('This ENDS your game Synthetic Duel');
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
  });

  it('reports a 3-player surrender as pending the others\' acceptance, not surrendered', async () => {
    const s = surrenderServer();
    h = await harness([feedGame(THREE)], s.warapp);
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(s.sent).toHaveLength(1);
    expect(p.status).toBe('pending');
    expect(String(p.message)).toMatch(/accept/i);
  });

  it('reports unchanged when GameFeed still shows a 1v1 being played', async () => {
    const s = surrenderServer();
    h = await harness([feedGame(DUEL)], s.warapp);
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(s.sent).toHaveLength(1);
    expect(p.status).toBe('unchanged');
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

  it('refuses a game the signed-in account is not playing in', async () => {
    const s = surrenderServer();
    h = await harness([feedGame([opp(1), opp(2)])], s.warapp);
    const res = await h.call('warapp_surrender', { game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not playing in/i);
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
    expect(String(p.warning)).toMatch(/warapp_get_game/);
    expect(String(p.warning)).not.toMatch(/try again|resend|retry/i);
  });

  describe('undo', () => {
    it('previews taking back the pending surrender, then sends surrender=false', async () => {
      const s = surrenderServer();
      h = await harness([feedGame(THREE, 'Playing', 'Synthetic Brawl')], s.warapp);
      const preview = payload(await h.call('warapp_surrender', { game_id: GAME_ID, undo: true }));
      const text = JSON.stringify(preview);
      expect(text).toContain('take back your pending surrender in Synthetic Brawl');
      expect(text).not.toContain('ENDS');
      expect(s.sent).toEqual([]);
      const p = payload(await h.call('warapp_surrender', { game_id: GAME_ID, undo: true, confirmToken: preview.confirmToken }));
      expect(s.sent).toEqual([{ gameId: GAME_ID, surrender: false, trailing: false, left: 0 }]);
      expect(p.status).toBe('taken_back');
    });

    it('reports surrendered when the others accepted before the take-back landed', async () => {
      const s = surrenderServer();
      const after = feedGame([me('SurrenderAccepted'), opp(1), opp(2)]);
      h = await harness([feedGame(THREE), feedGame(THREE), after], s.warapp);
      const p = payload(await confirmed({ game_id: GAME_ID, undo: true }));
      expect(p.status).toBe('surrendered');
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
});
