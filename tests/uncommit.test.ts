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
const GAME_ID = 4002;

interface FeedPlayer {
  id: string;
  name: string;
  state: string;
  hasCommittedOrders: string;
}

const me = (committed = true, state = 'Playing'): FeedPlayer => ({
  id: ME.feed,
  name: 'Me',
  state,
  hasCommittedOrders: committed ? 'True' : 'False',
});
const opp = (n: number): FeedPlayer => ({ id: String(1000 + n), name: `Opponent ${n}`, state: 'Playing', hasCommittedOrders: 'False' });

/** A GameFeed game `GAME_ID` in `state` with `players`, after `turns` turns. */
function feedGame(players: FeedPlayer[], state = 'Playing', turns = 5): Record<string, unknown> {
  const f = lobbyFixture();
  const template = (f.players as Array<Record<string, string>>)[0]!;
  return {
    ...f,
    id: String(GAME_ID),
    name: 'Synthetic Skirmish',
    state,
    numberOfTurns: String(turns),
    players: players.map((p) => ({ ...template, ...p })),
  };
}

const COMMITTED = feedGame([me(true), opp(1)]);
const UNCOMMITTED = feedGame([me(false), opp(1)]);

interface Sent {
  gameId: number;
  left: number;
}

function uncommitServer(reply: Partial<ReplyFrame> = {}) {
  const sent: Sent[] = [];
  const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method !== Method.UnCommit) throw new Error(`unexpected method ${req.method}`);
    sent.push({ gameId: req.body.int32(), left: req.body.remaining });
    return reply;
  };
  return { sent, warapp };
}

/** GameFeed answers: the preview's plan, the confirmed call's plan, then the post-send re-read (the last repeating). */
async function harness(feed: unknown[], warapp?: (req: DecodedRequest) => Partial<ReplyFrame>) {
  return liveHarness({ pages: SIGNED_IN, feed, ...(warapp ? { warapp } : {}) });
}

async function confirmed(args: Record<string, unknown>) {
  const preview = payload(await h!.call('warapp_uncommit_turn', args));
  expect(preview.confirmToken).toEqual(expect.any(String));
  return h!.call('warapp_uncommit_turn', { ...args, confirmToken: preview.confirmToken });
}

describe('warapp_uncommit_turn', () => {
  it('is a confirm-gated, non-idempotent write that reaches other people', async () => {
    h = await liveHarness();
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_uncommit_turn')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(tool.description).toMatch(/UnCommit|withdraw/i);
  });

  it('previews the withdrawal and sends nothing until confirmed', async () => {
    const s = uncommitServer();
    h = await harness([COMMITTED], s.warapp);
    const preview = payload(await h.call('warapp_uncommit_turn', { game_id: GAME_ID }));
    const text = JSON.stringify(preview);
    expect(text).toContain('Synthetic Skirmish');
    expect(text).toMatch(/turn 6/);
    expect(text).toMatch(/warapp_submit_turn/);
    expect(text).toMatch(/boot/i);
    expect(s.sent).toEqual([]);
  });

  it('sends UnCommit (80) with only the game id and reports uncommitted from GameFeed', async () => {
    const s = uncommitServer();
    h = await harness([COMMITTED, COMMITTED, UNCOMMITTED], s.warapp);
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(s.sent).toEqual([{ gameId: GAME_ID, left: 0 }]);
    expect(p).toMatchObject({ status: 'uncommitted', game: { id: GAME_ID, name: 'Synthetic Skirmish' }, turn: 6 });
    expect(String(p.detail)).toMatch(/warapp_submit_turn/);
  });

  it('reports unconfirmed when GameFeed still shows the orders committed', async () => {
    const s = uncommitServer();
    h = await harness([COMMITTED], s.warapp);
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(s.sent).toHaveLength(1);
    expect(p.status).toBe('unconfirmed');
    expect(String(p.warning)).toMatch(/still/i);
    expect(String(p.warning)).toMatch(/warapp_get_game/);
  });

  it('reports unconfirmed, naming the resolution, when the turn advanced', async () => {
    const s = uncommitServer();
    const advanced = feedGame([me(false), opp(1)], 'Playing', 6);
    h = await harness([COMMITTED, COMMITTED, advanced], s.warapp);
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(p.status).toBe('unconfirmed');
    expect(String(p.warning)).toMatch(/resolved|advanced/i);
  });

  it('reports unconfirmed when GameFeed omits the turn count after the send (a resolved turn also clears the flag)', async () => {
    const s = uncommitServer();
    const { numberOfTurns: _drop, ...noTurns } = UNCOMMITTED;
    h = await harness([COMMITTED, COMMITTED, noTurns], s.warapp);
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(s.sent).toHaveLength(1);
    expect(p.status).toBe('unconfirmed');
    expect(String(p.warning)).toMatch(/turn count/i);
  });

  it('refuses outside a turn phase without sending', async () => {
    const s = uncommitServer();
    h = await harness([feedGame([me(true), opp(1)], 'Finished')], s.warapp);
    const res = await h.call('warapp_uncommit_turn', { game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not in a turn phase/i);
    expect(s.sent).toEqual([]);
  });

  it('refuses when my orders are not committed, sending nothing', async () => {
    const s = uncommitServer();
    h = await harness([UNCOMMITTED], s.warapp);
    const res = await h.call('warapp_uncommit_turn', { game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not committed/i);
    expect(s.sent).toEqual([]);
  });

  it('refuses a game the signed-in account is not playing in', async () => {
    const s = uncommitServer();
    h = await harness([feedGame([opp(1), opp(2)])], s.warapp);
    const res = await h.call('warapp_uncommit_turn', { game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not a player in game/i);
    expect(s.sent).toEqual([]);
  });

  it('refuses when the account has left the game', async () => {
    h = await harness([feedGame([me(true, 'Eliminated'), opp(1), opp(2)])]);
    const res = await h.call('warapp_uncommit_turn', { game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no longer playing.*Eliminated/i);
  });

  it.each([
    [99, /other players committed/i],
    [4, /game is over/i],
    [7, /no longer in the game/i],
    [230, /no longer in the game/i],
  ])('war.app error %i is mapped to a clear message', async (code, wording) => {
    const s = uncommitServer({ error: { code, message: 'nope' } });
    h = await harness([COMMITTED], s.warapp);
    const res = await confirmed({ game_id: GAME_ID });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(wording);
    expect(textOf(res)).toContain(`war.app error ${code}`);
  });

  it('a transport failure is reported as unknown and never retried', async () => {
    let calls = 0;
    h = await harness([COMMITTED], () => {
      calls += 1;
      return { msgNum: 999 };
    });
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(p.status).toBe('unknown');
    expect(calls).toBe(1);
    expect(String(p.warning)).toMatch(/warapp_get_game/);
    expect(String(p.warning)).not.toMatch(/try again|resend|retry/i);
  });

  it('reports unconfirmed when GameFeed cannot be re-read after the send', async () => {
    const s = uncommitServer();
    h = await harness([COMMITTED, COMMITTED, { termsOfUse: 'x', error: 'Something broke' }], s.warapp);
    const p = payload(await confirmed({ game_id: GAME_ID }));
    expect(s.sent).toHaveLength(1);
    expect(p.status).toBe('unconfirmed');
  });
});
