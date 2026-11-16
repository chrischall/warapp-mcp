// Marking a game's chat read on war.app (#311): warapp_mark_chat_read, a confirm-gated write sending
// RegisterChatView (43), read back from GetMyGames' unread-chat flags. warapp_get_chat's and
// warapp_chat_inbox's `mark_seen` stay local (read-only tools). Synthetic ids and messages only;
// nothing reaches war.app.
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeGameDetailsAndChat, type SyntheticMessage } from './protocol/chat-bundle.js';
import { writeMyGamesReturn, type SyntheticGame } from './protocol/my-games-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const SIGNED_IN_ANN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };
const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 10, min));

const CHAT: SyntheticMessage[] = [
  { id: 1, date: at(1), from: ANN.inGame, text: 'gl hf', turn: 1 },
  { id: 2, date: at(2), from: BOB.inGame, text: 'truce?', privateTo: ANN.inGame, turn: 1 },
  { id: 3, date: at(3), from: BOB.inGame, text: 'push north', channel: 1, turn: 2 },
  { id: 4, date: at(4), from: BOB.inGame, text: 'hello', turn: 2 },
  { id: 5, date: at(5), from: BOB.inGame, group: 9, text: 'group line' },
];

function feedGame(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>).map((p, i) =>
    i === 0 ? { ...p, id: ANN.feed, name: 'Ann' } : i === 1 ? { ...p, id: BOB.feed, name: 'Bob' } : p,
  );
  return { ...f, id: String(GAME), name: 'G', state: 'Playing', numberOfTurns: '2', players, ...extra };
}

type Mark = { gameId: number; pub: string | null; team: string | null; priv: Array<[number, string | null]> | null; groups: Array<[number, string | null]> | null };
type Reply = Partial<ReplyFrame> | { status: number; body: string; url: string };

/**
 * A fake war.app: GameRefresh answers `chat`; the game list shows `unread`; a mark clears the flags (unless
 * `keepUnread`) or answers `markReply`; once a mark came in, `listReply` answers the list instead (the read-back).
 */
function warapp(
  opts: { chat?: SyntheticMessage[]; unread?: SyntheticGame['unread']; keepUnread?: boolean; markReply?: () => Reply; listReply?: () => Reply } = {},
) {
  const marks: Mark[] = [];
  const game: SyntheticGame = {
    id: GAME,
    name: 'G',
    lastTurn: 1,
    state: 3,
    players: [],
    unread: opts.unread ?? { public: true, team: true, private: true, group: true },
  };
  const dict = (r: DecodedRequest['body']) => (r.bool() ? [...(r.dict((x) => x.int32(), (x) => x.string()) ?? [])] : null);
  const handler = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method === Method.GameRefresh) return { body: (w) => writeGameDetailsAndChat(w, opts.chat ?? CHAT) };
    if (req.method === Method.GetMyGames) {
      if (marks.length && opts.listReply) return opts.listReply() as Partial<ReplyFrame>;
      return { body: (w) => writeMyGamesReturn(w, [game]) };
    }
    if (req.method === Method.RegisterChatView) {
      const r = req.body;
      marks.push({ gameId: r.int32(), pub: r.string(), team: r.string(), priv: dict(r), groups: dict(r) });
      if (opts.markReply) return opts.markReply() as Partial<ReplyFrame>;
      if (!opts.keepUnread) game.unread = {};
      return { body: (w) => w.bool(false) };
    }
    throw new Error(`unexpected method ${req.method}`);
  };
  return { marks, handler };
}

const methods = () => h!.exchanges.map((e) => e.request.method);

async function confirmed(args: Record<string, unknown>) {
  const preview = payload(await h!.call('warapp_mark_chat_read', args));
  expect(preview.confirmToken).toEqual(expect.any(String));
  return h!.call('warapp_mark_chat_read', { ...args, confirmToken: preview.confirmToken });
}

describe('mark_seen stays on this machine: the chat reads never write to war.app (#311)', () => {
  it('warapp_get_chat mark_seen marks locally and sends no read mark', async () => {
    const fake = warapp();
    h = await liveHarness({ feed: [feedGame()], pages: SIGNED_IN_ANN, warapp: fake.handler });
    const p = payload(await h.call('warapp_get_chat', { game_id: GAME, mark_seen: true }));
    expect(p.markedSeen).toEqual(['public', 'team', 'private', 'unknown']);
    expect(fake.marks).toEqual([]);
    expect(methods()).not.toContain(Method.RegisterChatView);
    expect(methods()).not.toContain(Method.GetMyGames);
    expect(p).not.toHaveProperty('readOnWarapp');
  });

  it('both chat reads are read-only by their annotations', async () => {
    h = await liveHarness({ feed: [feedGame()] });
    const tools = (await h.harness.client.listTools()).tools;
    for (const name of ['warapp_get_chat', 'warapp_chat_inbox']) {
      expect(tools.find((x) => x.name === name)?.annotations, name).toMatchObject({ readOnlyHint: true });
    }
  });
});

describe('warapp_mark_chat_read (#311)', () => {
  it('is a confirm-gated, idempotent, non-destructive write', async () => {
    h = await liveHarness();
    const t = (await h.harness.client.listTools()).tools.find((x) => x.name === 'warapp_mark_chat_read');
    expect(t?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(t?.description).toMatch(/RegisterChatView/);
    expect(t?.description).toMatch(/reaches no other player/);
  });

  it('previews by ids only (no message text, no names) and sends nothing until confirmed', async () => {
    const fake = warapp();
    h = await liveHarness({ feed: [feedGame()], pages: SIGNED_IN_ANN, warapp: fake.handler });
    const preview = payload(await h.call('warapp_mark_chat_read', { game_id: GAME }));
    expect(preview.confirmToken).toEqual(expect.any(String));
    const text = JSON.stringify(preview);
    expect(text).toContain(String(GAME));
    expect(text).toContain(ANN.feed);
    expect(text).not.toMatch(/truce\?|push north|hello|group line|Bob/);
    expect(fake.marks).toEqual([]);
    expect(methods()).not.toContain(Method.RegisterChatView);
  });

  it('marks every channel: the highest id on each, private by counterpart, groups by id; confirmed by the list', async () => {
    const fake = warapp();
    h = await liveHarness({ feed: [feedGame()], pages: SIGNED_IN_ANN, warapp: fake.handler });
    const p = payload(await confirmed({ game_id: GAME }));
    expect(fake.marks).toEqual([{ gameId: GAME, pub: '4', team: '3', priv: [[BOB.inGame, '2']], groups: [[9, '5']] }]);
    expect(methods().slice(-2)).toEqual([Method.RegisterChatView, Method.GetMyGames]);
    expect(p).toMatchObject({ status: 'read', outcome: 'confirmed', gameId: GAME, channels: ['public', 'team', 'private', 'unknown'] });
    expect(String(p.unverified)).toMatch(/UNVERIFIED live/);
  });

  it('a web read GameFeed filled (#313) still marks by the web ids; GameFeed\'s added lines mark nothing', async () => {
    const fake = warapp({ chat: CHAT.slice(0, 1) });
    const chat = [
      { playerID: ANN.inGame, message: 'gl hf', date: at(1).toISOString() },
      { playerID: BOB.inGame, message: 'Bob surrendered', date: at(9).toISOString() },
    ];
    h = await liveHarness({ feed: [feedGame({ chat })], pages: SIGNED_IN_ANN, warapp: fake.handler });
    const p = payload(await confirmed({ game_id: GAME }));
    expect(fake.marks).toEqual([{ gameId: GAME, pub: '1', team: '-1', priv: null, groups: null }]);
    expect(p).toMatchObject({ outcome: 'confirmed', channels: ['public'] });
  });

  it('one channel marks only that channel, the others sent as -1, and is judged on its own flag', async () => {
    const fake = warapp({ keepUnread: true });
    h = await liveHarness({ feed: [feedGame()], pages: SIGNED_IN_ANN, warapp: fake.handler });
    const p = payload(await confirmed({ game_id: GAME, channel: 'public' }));
    expect(fake.marks).toEqual([{ gameId: GAME, pub: '4', team: '-1', priv: null, groups: null }]);
    expect(p).toMatchObject({ status: 'unconfirmed', outcome: 'unconfirmed', channels: ['public'], stillUnread: ['public'] });
  });

  it('war.app not answering is unknown and never resent; nothing read back', async () => {
    const fake = warapp({ markReply: () => ({ status: 502, body: 'bad gateway', url: 'https://war.app/Services' }) });
    h = await liveHarness({ feed: [feedGame()], pages: SIGNED_IN_ANN, warapp: fake.handler });
    const p = payload(await confirmed({ game_id: GAME }));
    expect(fake.marks).toHaveLength(1);
    expect(p).toMatchObject({ status: 'unknown', outcome: 'unknown', warning: expect.stringMatching(/not resent/) });
    // Nothing is read back after a send war.app did not answer.
    expect(methods().at(-1)).toBe(Method.RegisterChatView);
  });

  it('war.app refusing is an error (nothing changed), never a result', async () => {
    const fake = warapp({ markReply: () => ({ error: { code: 17, message: 'not in game' } }) });
    h = await liveHarness({ feed: [feedGame()], pages: SIGNED_IN_ANN, warapp: fake.handler });
    const res = await confirmed({ game_id: GAME });
    expect(res.isError).toBe(true);
    expect(fake.marks).toHaveLength(1);
  });

  it('a read-back that fails, or a list without the game, is unconfirmed', async () => {
    h = await liveHarness({
      feed: [feedGame()],
      pages: SIGNED_IN_ANN,
      warapp: warapp({ listReply: () => ({ error: { code: 1, message: 'boom' } }) }).handler,
    });
    expect(payload(await confirmed({ game_id: GAME }))).toMatchObject({
      status: 'unconfirmed',
      outcome: 'unconfirmed',
      warning: expect.stringMatching(/could not be read back/),
    });
    await h.harness.close();
    h = await liveHarness({
      feed: [feedGame()],
      pages: SIGNED_IN_ANN,
      warapp: warapp({ listReply: () => ({ body: (w) => writeMyGamesReturn(w, []) }) }).handler,
    });
    expect(payload(await confirmed({ game_id: GAME }))).toMatchObject({
      status: 'unconfirmed',
      outcome: 'unconfirmed',
      warning: expect.stringMatching(/did not show this game's unread flags/),
    });
  });

  it('refuses with the account unknown, a chat read only from GameFeed, nothing to mark, or a chat already read', async () => {
    const chat = [{ playerID: BOB.inGame, message: 'hi' }];
    h = await liveHarness({ feed: [feedGame({ chat })] });
    const noMe = await h.call('warapp_mark_chat_read', { game_id: GAME });
    expect(noMe.isError).toBe(true);
    expect(textOf(noMe)).toMatch(/signed in/);
    await h.harness.close();

    h = await liveHarness({
      feed: [feedGame({ chat })],
      pages: SIGNED_IN_ANN,
      warapp: (req) => {
        if (req.method === Method.GameRefresh) return { error: { code: 17, message: 'x' } };
        throw new Error(`unexpected method ${req.method}`);
      },
    });
    const feedOnly = await h.call('warapp_mark_chat_read', { game_id: GAME });
    expect(feedOnly.isError).toBe(true);
    expect(textOf(feedOnly)).toMatch(/GameFeed, which gives no message ids/);
    await h.harness.close();

    // #313: the web read answered with no message while GameFeed holds some: no message id to mark, and
    // retrying from a fresh tab would not help, so the refusal says what war.app's web read returned.
    const webEmpty = warapp({ chat: [] });
    h = await liveHarness({ feed: [feedGame({ chat: [...chat, { playerID: BOB.inGame, message: 'gg' }] })], pages: SIGNED_IN_ANN, warapp: webEmpty.handler });
    const shortWeb = await h.call('warapp_mark_chat_read', { game_id: GAME });
    expect(shortWeb.isError).toBe(true);
    expect(textOf(shortWeb)).toMatch(/web read of game 12345678 returned no messages \(GameFeed holds 2\)/);
    expect(textOf(shortWeb)).toMatch(/no message id to mark/);
    expect(textOf(shortWeb)).not.toMatch(/retry/);
    expect(webEmpty.marks).toEqual([]);
    await h.harness.close();

    const empty = warapp({ chat: [] });
    h = await liveHarness({ feed: [feedGame()], pages: SIGNED_IN_ANN, warapp: empty.handler });
    const nothing = await h.call('warapp_mark_chat_read', { game_id: GAME });
    expect(nothing.isError).toBe(true);
    expect(textOf(nothing)).toMatch(/No message/);
    await h.harness.close();

    const read = warapp({ unread: {} });
    h = await liveHarness({ feed: [feedGame()], pages: SIGNED_IN_ANN, warapp: read.handler });
    const already = await h.call('warapp_mark_chat_read', { game_id: GAME });
    expect(already.isError).toBe(true);
    expect(textOf(already)).toMatch(/already shows/);
    expect(read.marks).toEqual([]);
  });
});
