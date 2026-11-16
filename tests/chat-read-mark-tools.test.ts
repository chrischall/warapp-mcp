// warapp_get_chat's `mark_seen: true` also marks the chat read on war.app (#311): RegisterChatView (43), read
// back from GetMyGames' unread-chat flags. Synthetic ids and messages only; nothing reaches war.app.
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { liveHarness, lobbyFixture, payload, type Harness } from './helpers.js';
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

/** A fake war.app: GameRefresh answers CHAT; a mark clears the game's flags (unless `keepUnread`) or answers `markReply`. */
function warapp(opts: { keepUnread?: boolean; markReply?: () => Reply; listReply?: () => Reply } = {}) {
  const marks: Mark[] = [];
  const game: SyntheticGame = {
    id: GAME,
    name: 'G',
    lastTurn: 1,
    state: 3,
    players: [],
    unread: { public: true, team: true, private: true, group: true },
  };
  const dict = (r: DecodedRequest['body']) => (r.bool() ? [...(r.dict((x) => x.int32(), (x) => x.string()) ?? [])] : null);
  const handler = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method === Method.GameRefresh) return { body: (w) => writeGameDetailsAndChat(w, CHAT) };
    if (req.method === Method.GetMyGames) {
      if (opts.listReply) return opts.listReply() as Partial<ReplyFrame>;
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

describe('warapp_get_chat mark_seen marks the chat read on war.app (#311)', () => {
  it('without mark_seen nothing is marked, here or there', async () => {
    const fake = warapp();
    h = await liveHarness({ feed: [feedGame()], pages: SIGNED_IN_ANN, warapp: fake.handler });
    const p = payload(await h.call('warapp_get_chat', { game_id: GAME }));
    expect(fake.marks).toEqual([]);
    expect(methods()).not.toContain(Method.GetMyGames);
    expect(p).not.toHaveProperty('readOnWarapp');
  });

  it('marks every channel: the highest id on each, private by counterpart, groups by id; then confirmed by the list', async () => {
    const fake = warapp();
    h = await liveHarness({ feed: [feedGame()], pages: SIGNED_IN_ANN, warapp: fake.handler });
    const p = payload(await h.call('warapp_get_chat', { game_id: GAME, mark_seen: true }));
    expect(fake.marks).toEqual([{ gameId: GAME, pub: '4', team: '3', priv: [[BOB.inGame, '2']], groups: [[9, '5']] }]);
    // The local mark first, then war.app's, then the read-back.
    expect(methods().slice(-2)).toEqual([Method.RegisterChatView, Method.GetMyGames]);
    expect(p.markedSeen).toEqual(['public', 'team', 'private', 'unknown']);
    expect(p.readOnWarapp).toEqual({ outcome: 'confirmed', channels: ['public', 'team', 'private', 'unknown'] });
    expect(String(p.readOnWarappNote)).toMatch(/reaches no other player.*UNVERIFIED live/);
  });

  it('one channel marks only that channel, the others sent as -1 and judged on its own flag', async () => {
    const fake = warapp({ keepUnread: true });
    h = await liveHarness({ feed: [feedGame()], pages: SIGNED_IN_ANN, warapp: fake.handler });
    const p = payload(await h.call('warapp_get_chat', { game_id: GAME, channel: 'public', mark_seen: true }));
    expect(fake.marks).toEqual([{ gameId: GAME, pub: '4', team: '-1', priv: null, groups: null }]);
    expect(p.readOnWarapp).toMatchObject({ outcome: 'unconfirmed', channels: ['public'], why: expect.stringMatching(/still shows unread messages on public/) });
  });

  it('war.app not answering is unknown and never resent; no read-back; the chat is still read', async () => {
    const fake = warapp({ markReply: () => ({ status: 502, body: 'bad gateway', url: 'https://war.app/Services' }) });
    h = await liveHarness({ feed: [feedGame()], pages: SIGNED_IN_ANN, warapp: fake.handler });
    const p = payload<{ messages: unknown[] } & Record<string, unknown>>(await h.call('warapp_get_chat', { game_id: GAME, mark_seen: true }));
    expect(p.messages).toHaveLength(5);
    expect(fake.marks).toHaveLength(1);
    expect(methods()).not.toContain(Method.GetMyGames);
    expect(p.readOnWarapp).toMatchObject({ outcome: 'unknown', channels: ['public', 'team', 'private', 'unknown'] });
  });

  it('war.app refusing is not applied', async () => {
    const fake = warapp({ markReply: () => ({ error: { code: 17, message: 'not in game' } }) });
    h = await liveHarness({ feed: [feedGame()], pages: SIGNED_IN_ANN, warapp: fake.handler });
    const p = payload(await h.call('warapp_get_chat', { game_id: GAME, mark_seen: true }));
    expect(p.readOnWarapp).toMatchObject({ outcome: 'not_applied', channels: [], why: expect.stringMatching(/refused/) });
    expect(methods()).not.toContain(Method.GetMyGames);
  });

  it('a read-back that fails, or a list without the game, is unconfirmed', async () => {
    h = await liveHarness({
      feed: [feedGame()],
      pages: SIGNED_IN_ANN,
      warapp: warapp({ listReply: () => ({ error: { code: 1, message: 'boom' } }) }).handler,
    });
    expect(payload(await h.call('warapp_get_chat', { game_id: GAME, mark_seen: true })).readOnWarapp).toMatchObject({
      outcome: 'unconfirmed',
      why: expect.stringMatching(/could not be read back/),
    });
    await h.harness.close();
    h = await liveHarness({
      feed: [feedGame()],
      pages: SIGNED_IN_ANN,
      warapp: warapp({ listReply: () => ({ body: (w) => writeMyGamesReturn(w, []) }) }).handler,
    });
    expect(payload(await h.call('warapp_get_chat', { game_id: GAME, mark_seen: true })).readOnWarapp).toMatchObject({
      outcome: 'unconfirmed',
      why: expect.stringMatching(/did not show this game's unread flags/),
    });
  });

  it('read from GameFeed (no message ids), or with the account unknown, nothing is sent to war.app', async () => {
    const chat = [{ playerID: BOB.inGame, message: 'hi' }];
    h = await liveHarness({ feed: [feedGame({ chat })] });
    const p = payload(await h.call('warapp_get_chat', { game_id: GAME, mark_seen: true }));
    expect(p.source).toBe('gamefeed');
    expect(p.readOnWarapp).toMatchObject({ outcome: 'not_applied', why: expect.stringMatching(/account could not be read/) });
    expect(methods()).not.toContain(Method.RegisterChatView);
    await h.harness.close();
    h = await liveHarness({
      feed: [feedGame({ chat })],
      pages: SIGNED_IN_ANN,
      warapp: (req) => {
        if (req.method === Method.GameRefresh) return { error: { code: 17, message: 'x' } };
        throw new Error(`unexpected method ${req.method}`);
      },
    });
    const q = payload(await h.call('warapp_get_chat', { game_id: GAME, mark_seen: true }));
    expect(q.source).toBe('gamefeed');
    expect(q.readOnWarapp).toMatchObject({ outcome: 'not_applied', why: expect.stringMatching(/GameFeed, which gives no message ids/) });
    expect(methods()).not.toContain(Method.RegisterChatView);
  });

  it('a chat with nothing to mark sends nothing', async () => {
    h = await liveHarness({
      feed: [feedGame()],
      pages: SIGNED_IN_ANN,
      warapp: (req) => {
        if (req.method === Method.GameRefresh) return { body: (w) => writeGameDetailsAndChat(w, []) };
        throw new Error(`unexpected method ${req.method}`);
      },
    });
    const p = payload(await h.call('warapp_get_chat', { game_id: GAME, mark_seen: true }));
    expect(p.readOnWarapp).toMatchObject({ outcome: 'not_applied', why: expect.stringMatching(/No message/) });
  });

  it('is a write by its annotations only for the read mark: never destructive, idempotent, open-world', async () => {
    h = await liveHarness({ feed: [feedGame()] });
    const t = (await h.harness.client.listTools()).tools.find((x) => x.name === 'warapp_get_chat');
    expect(t?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(t?.description).toMatch(/reaches no other player/);
  });
});
