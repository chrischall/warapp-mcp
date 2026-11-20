import { afterEach, describe, expect, it } from 'vitest';
import { hiddenLandLine, surrenderLand, winsOnAcceptance } from '../src/analysis/accept-surrender.js';
import type { LiveTerritory } from '../src/live.js';
import type { DecodedRequest, ReplyFrame, Writer } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { readDecisionLog } from '../src/decision-log.js';
import { untrustedText } from '../src/tools/common.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeGameDetailsAndChat, type SyntheticSeat } from './protocol/chat-bundle.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';
import { writeMyGamesReturn } from './protocol/my-games-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
// Synthetic GameFeed ids: the in-game id wrapped in two check digits each end.
const ME = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const CAT = { feed: '5512121233', inGame: 121212 };
const SIGNED_IN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ME.feed}</p>` };

interface FeedPlayer {
  id: string;
  name: string;
  state?: string;
  team?: string;
  humanTurnedIntoAI?: string;
  isAI?: string;
}

const NOT_INSTANT = { InstantSurrender: false, SurrenderedPlayersTurnIntoAIs: false };

function feedGame(players: FeedPlayer[], opts: { state?: string; settings?: Record<string, unknown> } = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const template = (f.players as Array<Record<string, string>>)[0]!;
  return {
    ...f,
    id: String(GAME),
    name: 'Synthetic Brawl',
    state: opts.state ?? 'Playing',
    numberOfTurns: '5',
    settings: { ...(f.settings as Record<string, unknown>), ...NOT_INSTANT, ...opts.settings },
    players: players.map((p) => ({ ...template, hasCommittedOrders: 'True', state: 'Playing', ...p })),
  };
}
const me: FeedPlayer = { id: ME.feed, name: 'Me' };
const bob: FeedPlayer = { id: BOB.feed, name: 'Bob' };
const cat: FeedPlayer = { id: CAT.feed, name: 'Cat' };
const THREE = [me, bob, cat];
const DUEL = [me, bob];

// Fixture map: 158 borders 161, 157, 134, 135 and 159. Bob holds 158; I border it with 159 and 161;
// Cat with 157, 134 and 135.
const BOARD: SyntheticTerritory[] = [
  { id: 158, fogLevel: 2, owner: BOB.inGame, armies: 5 },
  { id: 159, fogLevel: 1, owner: ME.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ME.inGame, armies: 3 },
  { id: 157, fogLevel: 2, owner: CAT.inGame, armies: 2 },
  { id: 134, fogLevel: 2, owner: CAT.inGame, armies: 2 },
  { id: 135, fogLevel: 2, owner: CAT.inGame, armies: 2 },
];

interface Sent {
  gameId: number;
  playerId: number;
  accept: boolean;
  modHook: boolean;
  left: number;
}

/** war.app: the game details (the n-th GameRefresh answered by `details[n]`, the last repeating), the board, and AcceptSurrender. */
function server(opts: {
  details: Array<SyntheticSeat[] | null>;
  board?: SyntheticTerritory[] | null;
  accept?: Partial<ReplyFrame>;
  /** The game list's seats (GetMyGames, for the teams); absent: the list fails and the teams stay unknown. */
  listed?: Array<{ id: number; name: string; team?: number }>;
}) {
  const sent: Sent[] = [];
  let refreshes = 0;
  const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method === Method.GameRefresh) {
      const seats = opts.details[Math.min(refreshes++, opts.details.length - 1)]!;
      return { body: (w: Writer) => writeGameDetailsAndChat(w, null, seats) };
    }
    if (req.method === Method.GetLatestGameInfo) {
      if (opts.board === undefined) throw new Error('no board');
      const board = opts.board;
      return { body: (w: Writer) => writeLatestGameInfo(w, board, [ME.inGame]) };
    }
    if (req.method === Method.GetMyGames && opts.listed) {
      const players = opts.listed.map((p) => ({ ...p, state: 2, committed: true }));
      return { body: (w: Writer) => writeMyGamesReturn(w, [{ id: GAME, name: 'Synthetic Brawl', lastTurn: 5, state: 3, players }]) };
    }
    if (req.method === Method.AcceptSurrender) {
      const r = req.body;
      sent.push({ gameId: r.int32(), playerId: r.int32(), accept: r.bool(), modHook: r.bool(), left: r.remaining });
      return opts.accept ?? { body: (w: Writer) => w.bool(false) };
    }
    throw new Error(`unexpected method ${req.method}`);
  };
  return { sent, warapp };
}

const PENDING: SyntheticSeat[] = [{ id: ME.inGame }, { id: BOB.inGame, surrendered: true }, { id: CAT.inGame }];
const FFA_LIST = [
  { id: ME.inGame, name: 'Me' },
  { id: BOB.inGame, name: 'Bob' },
  { id: CAT.inGame, name: 'Cat' },
];
const ACCEPTED_BY_CAT: SyntheticSeat[] = [{ id: ME.inGame }, { id: BOB.inGame, surrendered: true, acceptedBy: [CAT.inGame] }, { id: CAT.inGame }];

async function confirmed(args: Record<string, unknown>) {
  const preview = payload(await h!.call('warapp_accept_surrender', args));
  expect(preview.confirmToken, JSON.stringify(preview)).toEqual(expect.any(String));
  return h!.call('warapp_accept_surrender', { ...args, confirmToken: preview.confirmToken });
}

describe('surrenderLand', () => {
  const t = (territoryId: number, owner: number, fogged = false): LiveTerritory => ({
    territoryId,
    owner,
    fogged,
    fogLevel: fogged ? 4 : 2,
    armies: fogged ? null : 1,
  });
  const adj = new Map<number, number[]>([
    [1, [2, 3, 4]],
    [2, [1, 5]],
    [3, [1]],
    [4, [1]],
    [5, [2, 6]],
    [6, [5]],
  ]);

  it('counts each neighbour by its territories bordering the land, most first, and the hidden ones', () => {
    const land = surrenderLand([t(1, 9), t(2, 9), t(3, 7), t(4, -1, true), t(5, 8), t(6, 8)], adj, 9);
    expect(land).toEqual({
      territories: [1, 2],
      neighbours: [{ inGameId: 7, bordering: 1 }, { inGameId: 8, bordering: 1 }],
      hiddenNeighbours: 1,
      hiddenOnBoard: 1,
      hiddenLand: null,
    });
    const two = surrenderLand([t(1, 9), t(2, 8), t(3, 7), t(4, 7), t(5, 8)], adj, 9);
    expect(two.neighbours).toEqual([{ inGameId: 7, bordering: 2 }, { inGameId: 8, bordering: 1 }]);
  });

  it('leaves out neutrals and its fogged land', () => {
    expect(surrenderLand([t(1, 9, true), t(2, 0)], adj, 9)).toEqual({
      territories: [],
      neighbours: [],
      hiddenNeighbours: 0,
      // 1 fogged, and 3–6 not on the board at all.
      hiddenOnBoard: 5,
      hiddenLand: null,
    });
  });

  it('#417: its hidden land is unknown while the fog hides any territory (no per-player count), 0 when it hides none', () => {
    const all = [t(1, 9), t(2, 9), t(3, 7), t(4, 7), t(5, 8), t(6, 8)];
    expect(surrenderLand(all, adj, 9)).toMatchObject({ territories: [1, 2], hiddenOnBoard: 0, hiddenLand: 0 });
    const someFog = [t(1, 9), t(2, 9), t(3, 7), t(4, 7), t(5, -1, true), t(6, -1, true)];
    expect(surrenderLand(someFog, adj, 9)).toMatchObject({ territories: [1, 2], hiddenOnBoard: 2, hiddenLand: null });
    expect(hiddenLandLine(surrenderLand(all, adj, 9))).toBe('The fog hides none of the board: its land is the 2 in view.');
    expect(hiddenLandLine(surrenderLand(someFog, adj, 9))).toBe(
      'How many of its territories the fog hides is unknown: the live board gives no per-player count, and 2 territories on the board are hidden, so its hidden land is anywhere from 0 to that. Only the 2 in view are counted here.',
    );
  });
});

describe('winsOnAcceptance', () => {
  const seat = (id: number, mine = false, ai = false) => ({ id, mine, ai });

  it('wins when no one off my side is left, loses when someone is', () => {
    expect(winsOnAcceptance([seat(1, true)], false, false)).toBe(true);
    expect(winsOnAcceptance([seat(1, true), seat(2, true)], false, false)).toBe(true);
    expect(winsOnAcceptance([seat(1, true), seat(3)], false, false)).toBe(false);
  });

  it('a seat handed to an AI keeps playing, unless the AIs give up when one human remains', () => {
    expect(winsOnAcceptance([seat(1, true)], true, false)).toBe(false);
    expect(winsOnAcceptance([seat(1, true)], true, true)).toBe(true);
    expect(winsOnAcceptance([seat(1, true), seat(4, false, true)], false, true)).toBe(true);
  });

  it('is unknown (null) when it hangs on an unread AI setting', () => {
    expect(winsOnAcceptance([seat(1, true)], undefined, false)).toBeNull();
    expect(winsOnAcceptance([seat(1, true), seat(3)], undefined, false)).toBe(false);
  });
});

describe('warapp_accept_surrender', () => {
  it('previews whose seat, the land, its neighbours and the free-for-all advice, and sends nothing until confirmed', async () => {
    const s = server({ details: [PENDING], board: BOARD, listed: FFA_LIST });
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame(THREE)], warapp: s.warapp });
    const p = payload<Record<string, any>>(await h.call('warapp_accept_surrender', { game_id: GAME }));
    const preview = p.preview ?? p;
    expect(preview.advice).not.toMatch(/may be a teammate/);
    const text = JSON.stringify(p);
    expect(text).toContain(`surrender in game ${GAME}`);
    expect(text).toContain('others still owe theirs');
    expect(preview.seat).toEqual({ player: Number(BOB.feed), inGameId: BOB.inGame, name: untrustedText('Bob') });
    expect(preview.landBecomes).toBe('neutral');
    expect(preview.land).toEqual({
      territoriesInView: 1,
      borderedBy: [
        { player: Number(CAT.feed), inGameId: CAT.inGame, name: untrustedText('Cat'), territoriesBordering: 3 },
        { player: Number(ME.feed), inGameId: ME.inGame, name: untrustedText('Me'), territoriesBordering: 2, you: true },
      ],
      hiddenNeighbours: 0,
      // #417: the fixture map's other territories are not on the board: the count is unknown, said plainly.
      hiddenLand: null,
      hiddenOnBoard: expect.any(Number),
      hiddenLine: expect.stringMatching(/^How many of its territories the fog hides is unknown: the live board gives no per-player count, and \d+ territories on the board are hidden, so its hidden land is anywhere from 0 to that\. Only the 1 in view is counted here\.$/),
    });
    expect(preview.othersStillToAccept).toEqual([{ player: Number(CAT.feed), inGameId: CAT.inGame }]);
    // GameFeed ids and in-game ids are never mixed in one field.
    expect(preview.willSend).toEqual({ game: GAME, player: Number(BOB.feed), inGameId: BOB.inGame, accept: true });
    expect(preview.goesThroughNow).toBe(false);
    expect(preview.winsGame).toBe(false);
    expect(preview.advice).toMatch(/ffa-surrender-veto.*player 5512121233 borders.*most territories \(3; you: 2\).*gains most/);
    expect(preview.advice).toMatch(/Its land behind the fog is unknown \(#417\): only what is in view is counted\./);
    // A write preview's sentences name players by id only; the names are in `land.borderedBy`.
    expect(preview.advice).not.toMatch(/Cat/);
    expect(preview.unverified).toMatch(/UNVERIFIED|not yet verified live/);
    expect(s.sent).toEqual([]);
  });

  it('says accepting wins the game when only my side is left, and that mine is the last acceptance owed', async () => {
    const s = server({ details: [[{ id: ME.inGame }, { id: BOB.inGame, surrendered: true }]], board: BOARD.slice(0, 3) });
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame(DUEL)], warapp: s.warapp });
    const p = payload<Record<string, any>>(await h.call('warapp_accept_surrender', { game_id: GAME }));
    const preview = p.preview ?? p;
    expect(preview.goesThroughNow).toBe(true);
    expect(preview.winsGame).toBe(true);
    expect(preview.advice).toMatch(/Accepting wins the game/);
    expect(JSON.stringify(p)).toContain('it goes through');
  });

  it('a seat that goes to an AI is no win, and the land is named as going to an AI', async () => {
    const s = server({ details: [ACCEPTED_BY_CAT], board: BOARD });
    h = await liveHarness({
      pages: SIGNED_IN,
      feed: [feedGame(THREE, { settings: { SurrenderedPlayersTurnIntoAIs: true } })],
      warapp: s.warapp,
    });
    const preview = (p => p.preview ?? p)(payload<Record<string, any>>(await h.call('warapp_accept_surrender', { game_id: GAME })));
    expect(preview.landBecomes).toBe('AI');
    expect(preview.goesThroughNow).toBe(true);
    expect(preview.winsGame).toBe(false);
    expect(preview.advice).toMatch(/goes to an AI/);
  });

  it('without a live board the neighbours are unknown, never empty', async () => {
    const s = server({ details: [PENDING] });
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame(THREE)], warapp: s.warapp });
    const preview = (p => p.preview ?? p)(payload<Record<string, any>>(await h.call('warapp_accept_surrender', { game_id: GAME })));
    expect(preview.land).toBeNull();
    expect(preview.advice).toMatch(/unknown: the live board could not be read/);
    // No game list read: the teams are unknown, and the advice says a neighbour may be a teammate.
    expect(preview.advice).toMatch(/may be a teammate/);
  });

  it('with the teams unknown and another seat left, whether accepting wins is unknown, and the advice says why', async () => {
    // Cat is an AI and the AIs give up once one human is left: by my side alone, accepting would win. But the teams
    // could not be read (no game list), so Cat may be on my side or not: winsGame is unknown, never true.
    const s = server({ details: [[{ id: ME.inGame }, { id: BOB.inGame, surrendered: true }, { id: CAT.inGame }]], board: BOARD });
    h = await liveHarness({
      pages: SIGNED_IN,
      feed: [feedGame([me, bob, { ...cat, isAI: 'True' }], { settings: { AIsSurrenderWhenOneHumanRemains: true } })],
      warapp: s.warapp,
    });
    const preview = (p => p.preview ?? p)(payload<Record<string, any>>(await h.call('warapp_accept_surrender', { game_id: GAME })));
    expect(preview.winsGame).toBeNull();
    expect(preview.advice).not.toMatch(/Accepting wins the game/);
    expect(preview.advice).toMatch(/may be a teammate/);
    expect(s.sent).toEqual([]);
  });

  describe('in a team game', () => {
    const teamDetails: SyntheticSeat[] = [{ id: ME.inGame }, { id: BOB.inGame, surrendered: true }, { id: CAT.inGame }];
    const preview = async (players: FeedPlayer[]) => {
      const s = server({ details: [teamDetails], board: BOARD });
      h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame(players)], warapp: s.warapp });
      const p = (q => q.preview ?? q)(payload<Record<string, any>>(await h.call('warapp_accept_surrender', { game_id: GAME })));
      expect(s.sent).toEqual([]);
      return p;
    };

    it('gives no advice when accepting does not win the game (the free-for-all note does not apply)', async () => {
      const p = await preview([{ ...me, team: '0' }, { ...bob, team: '1' }, { ...cat, team: '1' }]);
      expect(p.winsGame).toBe(false);
      expect(p).not.toHaveProperty('advice');
    });

    it('says accepting wins the game when only my team is left', async () => {
      const p = await preview([{ ...me, team: '0' }, { ...bob, team: '1' }, { ...cat, team: '0' }]);
      expect(p.winsGame).toBe(true);
      expect(p.advice).toMatch(/Accepting wins the game once the others/);
      expect(p.advice).not.toMatch(/ffa-surrender-veto|may be a teammate/);
    });
  });

  it('accepts on confirm with the golden parameters and reports pending when others still owe theirs', async () => {
    const after: SyntheticSeat[] = [{ id: ME.inGame }, { id: BOB.inGame, surrendered: true, acceptedBy: [ME.inGame] }, { id: CAT.inGame }];
    // GameRefresh: the preview's plan, the confirmed plan, then the read-back.
    const s = server({ details: [PENDING, PENDING, after], board: BOARD });
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame(THREE)], warapp: s.warapp });
    const p = payload(await confirmed({ game_id: GAME, player: 'Bob' }));
    expect(s.sent).toEqual([{ gameId: GAME, playerId: BOB.inGame, accept: true, modHook: false, left: 0 }]);
    expect(p).toMatchObject({ status: 'pending', outcome: 'confirmed', player: Number(BOB.feed), inGameId: BOB.inGame });
  });

  it('#437: logs my confirmed acceptance in the decision log once, by the player\'s id', async () => {
    const after: SyntheticSeat[] = [{ id: ME.inGame }, { id: BOB.inGame, surrendered: true, acceptedBy: [ME.inGame] }, { id: CAT.inGame }];
    const s = server({ details: [PENDING, PENDING, after], board: BOARD });
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame(THREE)], warapp: s.warapp });
    expect(payload(await confirmed({ game_id: GAME, player: 'Bob' })).outcome).toBe('confirmed');
    const log = (await readDecisionLog(h.dataDir, GAME))!;
    expect(log.events!.filter((e) => e.kind === 'surrender-accepted-by-me')).toEqual([
      { turn: 6, kind: 'surrender-accepted-by-me', player: Number(BOB.feed), at: expect.any(String) },
    ]);
    expect(JSON.stringify(log)).not.toMatch(/\b(Me|Bob|Cat|Synthetic Brawl)\b/);
  });

  it('reports accepted once GameFeed shows the seat SurrenderAccepted', async () => {
    const s = server({ details: [ACCEPTED_BY_CAT], board: BOARD });
    const done = feedGame([me, { ...bob, state: 'SurrenderAccepted' }, cat]);
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame(THREE), feedGame(THREE), done], warapp: s.warapp });
    const p = payload(await confirmed({ game_id: GAME }));
    expect(s.sent).toHaveLength(1);
    expect(p).toMatchObject({ status: 'accepted', outcome: 'confirmed', theirState: 'SurrenderAccepted' });
  });

  it('reads a seat turned into an AI as accepted only when it was not one already at the preview', async () => {
    // Turned into an AI only after the acceptance: the surrender went through.
    {
      const s = server({ details: [ACCEPTED_BY_CAT], board: BOARD });
      const done = feedGame([me, { ...bob, humanTurnedIntoAI: 'True' }, cat]);
      h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame(THREE), feedGame(THREE), done], warapp: s.warapp });
      const p = payload(await confirmed({ game_id: GAME }));
      expect(p).toMatchObject({ status: 'accepted', outcome: 'confirmed' });
      await h.harness.close();
      h = undefined;
    }
    // Already a human turned into an AI at the preview, and nothing else changed: that is no evidence of acceptance.
    const turned = feedGame([me, { ...bob, humanTurnedIntoAI: 'True' }, cat]);
    const s = server({ details: [PENDING], board: BOARD });
    h = await liveHarness({ pages: SIGNED_IN, feed: [turned], warapp: s.warapp });
    const p = payload(await confirmed({ game_id: GAME }));
    expect(s.sent).toHaveLength(1);
    expect(p).toMatchObject({ status: 'unconfirmed', outcome: 'unconfirmed' });
  });

  it('reports unconfirmed when nothing reads back as changed, and never suggests resending', async () => {
    const s = server({ details: [PENDING], board: BOARD });
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame(THREE)], warapp: s.warapp });
    const p = payload(await confirmed({ game_id: GAME }));
    expect(p).toMatchObject({ status: 'unconfirmed', outcome: 'unconfirmed' });
    expect(String(p.warning)).toMatch(/do not send it again/);
  });

  it('an unanswered acceptance is unknown, nothing read back or resent', async () => {
    const s = server({ details: [PENDING], board: BOARD, accept: { msgNum: 999 } });
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame(THREE)], warapp: s.warapp });
    const p = payload(await confirmed({ game_id: GAME }));
    expect(s.sent).toHaveLength(1);
    expect(p).toMatchObject({ status: 'unknown', outcome: 'unknown' });
    expect(String(p.warning)).not.toMatch(/try again|resend|retry/i);
  });

  it('a surrendering seat with no GameFeed player keeps player null beside its in-game id, and reads back by in-game id', async () => {
    // Seat 42 is in the details but no GameFeed player maps to it: its in-game id is never read as a GameFeed id.
    const AI = 42;
    const before: SyntheticSeat[] = [{ id: ME.inGame }, { id: BOB.inGame }, { id: AI, surrendered: true }];
    const after: SyntheticSeat[] = [{ id: ME.inGame }, { id: BOB.inGame }, { id: AI, surrendered: true, state: 7 }];
    const s = server({ details: [before, before, after], board: BOARD });
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame(DUEL)], warapp: s.warapp });
    const pv = payload<Record<string, any>>(await h.call('warapp_accept_surrender', { game_id: GAME }));
    const preview = pv.preview ?? pv;
    expect(preview.seat).toEqual({ player: null, inGameId: AI, name: null });
    expect(preview.othersStillToAccept).toEqual([{ player: Number(BOB.feed), inGameId: BOB.inGame }]);
    const p = payload(await h.call('warapp_accept_surrender', { game_id: GAME, confirmToken: pv.confirmToken }));
    expect(s.sent).toEqual([{ gameId: GAME, playerId: AI, accept: true, modHook: false, left: 0 }]);
    expect(p).toMatchObject({ status: 'accepted', outcome: 'confirmed', player: null, inGameId: AI });
  });

  it('refuses at execute when the signed-in account changed after the preview, and sends nothing', async () => {
    const OTHER = '9998877766';
    let boardReads = 0;
    const s = server({ details: [PENDING], board: BOARD });
    const pages: Record<string, string> = {};
    Object.defineProperty(pages, 'https://war.app/InviteToken', {
      enumerable: true,
      // The account is mine through the confirmed call's plan (its board read is the second), then another's.
      get: () => `<p>Your invite token is ${boardReads >= 2 ? OTHER : ME.feed}</p>`,
    });
    const warapp = (req: DecodedRequest) => {
      if (req.method === Method.GetLatestGameInfo) boardReads++;
      return s.warapp(req);
    };
    h = await liveHarness({ pages, feed: [feedGame(THREE)], warapp });
    const res = await confirmed({ game_id: GAME });
    expect(res.isError, textOf(res)).toBe(true);
    expect(textOf(res)).toMatch(/account changed/i);
    expect(boardReads).toBe(2);
    expect(s.sent).toEqual([]);
  });

  it.each([
    [186, /taken its surrender back/],
    [4, /game has ended/],
    [7, /One of the two seats .* has left the game/],
    [230, /seat no longer takes part in the game/],
  ])('war.app error %i is worded', async (code, wording) => {
    const s = server({ details: [PENDING], board: BOARD, accept: { error: { code, message: 'nope' } } });
    h = await liveHarness({ pages: SIGNED_IN, feed: [feedGame(THREE)], warapp: s.warapp });
    const res = await confirmed({ game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(wording);
    expect(textOf(res)).toContain(`war.app error ${code}`);
  });

  describe('refusals (nothing sent)', () => {
    const refused = async (feed: unknown, details: Array<SyntheticSeat[] | null>, args: Record<string, unknown>, wording: RegExp) => {
      const s = server({ details, board: BOARD });
      h = await liveHarness({ pages: SIGNED_IN, feed: [feed], warapp: s.warapp });
      const res = await h.call('warapp_accept_surrender', { game_id: GAME, ...args });
      expect(res.isError, textOf(res)).toBe(true);
      expect(textOf(res)).toMatch(wording);
      expect(s.sent).toEqual([]);
      await h.harness.close();
      h = undefined;
    };

    it('no surrender pending, or none from the player named', async () => {
      await refused(feedGame(THREE), [[{ id: ME.inGame }, { id: BOB.inGame }, { id: CAT.inGame }]], {}, /No surrender is pending/);
      await refused(feedGame(THREE), [PENDING], { player: 'Cat' }, /has no surrender pending/);
    });

    it('my acceptance not owed: already given', async () => {
      const mine: SyntheticSeat[] = [{ id: ME.inGame }, { id: BOB.inGame, surrendered: true, acceptedBy: [ME.inGame] }, { id: CAT.inGame }];
      await refused(feedGame(THREE), [mine], {}, /acceptance of that surrender is not owed/);
    });

    it('a finished game, a lobby, a game I am not in, a seat out, an instant-surrender game', async () => {
      await refused(feedGame(THREE, { state: 'Finished' }), [PENDING], {}, /already over/);
      await refused(feedGame(THREE, { state: 'WaitingForPlayers' }), [PENDING], {}, /has not started/);
      await refused(feedGame([bob, cat]), [PENDING], {}, /not a player in game/);
      await refused(feedGame([{ ...me, state: 'Eliminated' }, bob, cat]), [PENDING], {}, /no longer playing/);
      await refused(feedGame(THREE, { settings: { InstantSurrender: true } }), [PENDING], {}, /instant/);
    });

    it('the game details unreadable: whether one is pending cannot be told', async () => {
      await refused(feedGame(THREE), [null], {}, /Could not read game .* details/);
    });

    it('two pending and none named', async () => {
      const two: SyntheticSeat[] = [{ id: ME.inGame }, { id: BOB.inGame, surrendered: true }, { id: CAT.inGame, surrendered: true }];
      await refused(feedGame(THREE), [two], {}, /More than one surrender is pending.*Bob.*Cat/);
    });
  });
});
