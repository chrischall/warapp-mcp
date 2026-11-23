// Unread chat made hard to miss and one step to clear: the game list's unread flags in warapp_my_games, the
// inbox walking every page (`all`), filtered (`only`) and showing both read states (`readState`), and
// warapp_mark_chat_read marking war.app and this machine together (`scope`), several games in one confirm.
// Synthetic ids and messages only; nothing reaches war.app or another player.
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { briefGameLine, type MyGame } from '../src/my-games.js';
import { inboxClock, INBOX_TIME_BUDGET_MS } from '../src/tools/chat-inbox.js';
import { privateToMeUnread, privateToMeWarning, type PlanChatRead } from '../src/tools/chat.js';
import type { LiveContext } from '../src/tools/live-context.js';
import type { Game } from '../src/normalize.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeGameDetailsAndChat, writeSendChatReply, type SyntheticMessage } from './protocol/chat-bundle.js';
import { writeMyGamesReturn, type SyntheticGame } from './protocol/my-games-bundle.js';

let h: Harness | undefined;
const realNow = inboxClock.now;
afterEach(async () => {
  inboxClock.now = realNow;
  await h?.harness.close();
  h = undefined;
});

const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const SIGNED_IN_ANN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };
const PLAYING = 3;
const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 10, min));

const seat = (committed: boolean) => [
  { id: ANN.inGame, name: 'Ann', state: 2, committed },
  { id: BOB.inGame, name: 'Bob', state: 2, committed: true },
];
const listed = (id: number, unread: SyntheticGame['unread'] = {}, opts: { committed?: boolean; state?: number } = {}): SyntheticGame => ({
  id,
  name: `Game ${id}`,
  lastTurn: 2,
  state: opts.state ?? PLAYING,
  players: seat(opts.committed ?? true),
  unread,
});

function feedGame(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>).map((p, i) =>
    i === 0 ? { ...p, id: ANN.feed, name: 'Ann' } : i === 1 ? { ...p, id: BOB.feed, name: 'Bob' } : p,
  );
  return { ...f, id: String(id), name: `Game ${id}`, state: 'Playing', numberOfTurns: '2', players, ...extra };
}

type Mark = { gameId: number };

/** A fake war.app: GetMyGames lists `games` (a mark clears that game's flags); GameRefresh answers each game's chat. */
function warapp(games: SyntheticGame[], chats: Record<number, SyntheticMessage[]>) {
  const marks: Mark[] = [];
  const handler = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method === Method.GetMyGames) return { body: (w) => writeMyGamesReturn(w, games) };
    if (req.method === Method.RegisterChatView) {
      const gameId = req.body.int32();
      marks.push({ gameId });
      const g = games.find((x) => x.id === gameId);
      if (g) g.unread = {};
      return { body: (w) => w.bool(false) };
    }
    if (req.method === Method.GameRefresh) {
      const id = req.body.int32();
      return { body: (w) => writeGameDetailsAndChat(w, chats[id] ?? []) };
    }
    if (req.method === Method.RetrieveChat || req.method === Method.RetrievePrivateMessageHistory) {
      return { body: (w) => writeSendChatReply(w, []) };
    }
    throw new Error(`unexpected method ${req.method}`);
  };
  return { marks, handler };
}

async function confirmed(args: Record<string, unknown>) {
  const preview = payload(await h!.call('warapp_mark_chat_read', args));
  expect(preview.confirmToken).toEqual(expect.any(String));
  return { preview, result: await h!.call('warapp_mark_chat_read', { ...args, confirmToken: preview.confirmToken }) };
}

type InboxGame = {
  id: number;
  newCount: number;
  messages: Array<Record<string, unknown>>;
  readState: { warapp: Record<string, boolean> | null; local: Record<string, number> };
  toMe?: number;
};
type Inbox = { games: InboxGame[]; quiet: number[]; read: number; next?: string; partial?: boolean } & Record<string, unknown>;

describe('briefGameLine: unread chat from the game list flags', () => {
  const game = (over: Partial<MyGame> = {}): MyGame => ({ id: 1, name: 'G', state: 'Playing', turn: 3, waitingOnYou: false, players: [], ...over });
  const flags = (over: Partial<NonNullable<MyGame['unreadChat']>> = {}) => ({ public: false, team: false, private: false, group: false, toMe: false, ...over });

  it('appends unread private first, then the other unread channels; nothing when clear or unknown', () => {
    expect(briefGameLine(game({ unreadChat: flags({ private: true, toMe: true, public: true, team: true }) }))).toBe(
      'G — turn 3 — waiting on others — unread private — unread public, team',
    );
    expect(briefGameLine(game({ unreadChat: flags({ group: true }) }))).toBe('G — turn 3 — waiting on others — unread group');
    expect(briefGameLine(game({ unreadChat: flags() }))).toBe('G — turn 3 — waiting on others');
    expect(briefGameLine(game({ unreadChat: null }))).toBe('G — turn 3 — waiting on others');
  });

  it('still fits 120 characters, shortening the name and keeping the unread tail', () => {
    const line = briefGameLine(game({ name: 'Y'.repeat(300), unreadChat: flags({ private: true, toMe: true, public: true, team: true, group: true }) }));
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.endsWith(' — unread private — unread public, team, group')).toBe(true);
  });
});

describe('warapp_my_games: unread chat per game', () => {
  it('reports the flags per game, counts games with unread private chat, and lists them right after the ones waiting on me', async () => {
    const games = [listed(203), listed(204, { public: true }), listed(202, { private: true }), listed(201, {}, { committed: false })];
    const fake = warapp(games, {});
    h = await liveHarness({ feed: [feedGame(201)], pages: SIGNED_IN_ANN, warapp: fake.handler });
    const p = payload(await h.call('warapp_my_games'));
    const out = p.games as Array<Record<string, unknown>>;
    expect(out.map((g) => g.id)).toEqual([201, 202, 203, 204]);
    expect(out[1]!.unreadChat).toEqual({ public: false, team: false, private: true, group: false, toMe: true });
    expect(out[3]!.unreadChat).toEqual({ public: true, team: false, private: false, group: false, toMe: false });
    expect(p.unreadPrivateGames).toBe(1);
    // No extra request: the flags ride in the list.
    expect(h.exchanges.filter((e) => e.request.method === Method.GetMyGames)).toHaveLength(1);

    const brief = payload<{ data: string[] }>(await h.call('warapp_my_games', { view: 'brief' })).data;
    expect(brief).toEqual([
      'Game 201 — turn 3 — waiting on you',
      'Game 202 — turn 3 — waiting on others — unread private',
      'Game 203 — turn 3 — waiting on others',
      'Game 204 — turn 3 — waiting on others — unread public',
    ]);
  });
});

describe('warapp_chat_inbox: every page, filters and both read states', () => {
  const IDS = Array.from({ length: 25 }, (_, i) => 301 + i);
  const many = () => {
    const chats: Record<number, SyntheticMessage[]> = {};
    for (const id of IDS) chats[id] = [{ id: 1, date: at(1), from: BOB.inGame, text: `hello ${id}`, turn: 1 }];
    chats[325] = [...chats[325]!, { id: 2, date: at(2), from: BOB.inGame, text: 'I accept the truce', privateTo: ANN.inGame, turn: 2 }];
    return chats;
  };

  it('all: true reads 25 games over 3 pages in one call, every message, with the summary', async () => {
    const fake = warapp(IDS.map((id) => listed(id)), many());
    h = await liveHarness({ feed: IDS.map((id) => feedGame(id)), pages: SIGNED_IN_ANN, warapp: fake.handler });
    const p = payload<Inbox>(await h.call('warapp_chat_inbox', { all: true }));
    expect(p.games.map((g) => g.id)).toEqual(IDS);
    expect(p.read).toBe(25);
    expect(p.pages).toBe(3);
    expect(p).not.toHaveProperty('next');
    expect(p).not.toHaveProperty('partial');
    expect(p.summary).toEqual({ newMessages: 26, newPrivateToMe: 1, gamesWithNew: 25 });
    expect(p.games.at(-1)!.messages.map((m) => m.toMe ?? false)).toEqual([false, true]);
  });

  it('all: true stops at the time budget with partial and next', async () => {
    const fake = warapp(IDS.map((id) => listed(id)), many());
    h = await liveHarness({ feed: IDS.map((id) => feedGame(id)), pages: SIGNED_IN_ANN, warapp: fake.handler });
    let t = 0;
    inboxClock.now = () => {
      const v = t;
      t += INBOX_TIME_BUDGET_MS * 0.6;
      return v;
    };
    const p = payload<Inbox>(await h.call('warapp_chat_inbox', { all: true }));
    expect(p.partial).toBe(true);
    expect(p.read).toBe(2);
    expect(p.next).toBe('302');
    expect(p.remaining).toBe(23);
  });

  it('only: "toMe" / "private" show just those messages; the others are counted in filtered', async () => {
    const chats = {
      401: [
        { id: 1, date: at(1), from: BOB.inGame, text: 'public line', turn: 1 },
        { id: 2, date: at(2), from: BOB.inGame, text: 'private line', privateTo: ANN.inGame, turn: 1 },
      ],
      402: [{ id: 1, date: at(1), from: BOB.inGame, text: 'only public', turn: 1 }],
    };
    const fake = warapp([listed(401), listed(402)], chats);
    h = await liveHarness({ feed: [feedGame(401), feedGame(402), feedGame(401), feedGame(402)], pages: SIGNED_IN_ANN, warapp: fake.handler });
    const p = payload<Inbox>(await h.call('warapp_chat_inbox', { only: 'toMe' }));
    expect(p.games.map((g) => g.id)).toEqual([401]);
    expect(p.games[0]!.messages).toHaveLength(1);
    expect(p.games[0]!.messages[0]).toMatchObject({ channel: 'private', toMe: true });
    expect(p.filtered).toEqual([402]);
    // The summary counts every new message read, whatever the filter shows.
    expect(p.summary).toEqual({ newMessages: 3, newPrivateToMe: 1, gamesWithNew: 2 });
    const q = payload<Inbox>(await h.call('warapp_chat_inbox', { only: 'private' }));
    expect(q.games[0]!.messages.map((m) => m.channel)).toEqual(['private']);
  });
});

describe('read-state drift between war.app and this machine', () => {
  const CHAT = { 501: [{ id: 7, date: at(1), from: BOB.inGame, text: 'truce?', turn: 1 }] };

  it('read on war.app, not here: readState shows it, and scope both clears the local mark without resending', async () => {
    const fake = warapp([listed(501, {})], CHAT);
    h = await liveHarness({ feed: [feedGame(501)], pages: SIGNED_IN_ANN, warapp: fake.handler });
    const p = payload<Inbox>(await h.call('warapp_chat_inbox'));
    expect(p.games[0]!.readState).toEqual({
      warapp: { public: false, team: false, private: false, group: false },
      local: { public: 1, team: 0, private: 0 },
    });
    const { preview, result } = await confirmed({ game_id: 501 });
    expect(JSON.stringify(preview)).toMatch(/already read on war\.app/);
    expect(payload(result)).toMatchObject({ gameId: 501, status: 'read', outcome: 'already-read', local: { status: 'marked' } });
    expect(fake.marks).toEqual([]);
    const after = payload<Inbox>(await h.call('warapp_chat_inbox'));
    expect(after.games).toEqual([]);
    expect(after.quiet).toEqual([501]);
  });

  it('read here, not on war.app: the inbox still lists it (union), and scope both sends the war.app mark', async () => {
    const fake = warapp([listed(501, { public: true })], CHAT);
    h = await liveHarness({ feed: [feedGame(501)], pages: SIGNED_IN_ANN, warapp: fake.handler });
    await confirmed({ game_id: 501, scope: 'local' });
    expect(fake.marks).toEqual([]);
    const p = payload<Inbox>(await h.call('warapp_chat_inbox'));
    expect(p.games.map((g) => g.id)).toEqual([501]);
    expect(p.games[0]!.newCount).toBe(0);
    expect(p.games[0]!.readState).toEqual({
      warapp: { public: true, team: false, private: false, group: false },
      local: { public: 0, team: 0, private: 0 },
    });
    expect(p.games[0]!.messages).toEqual([expect.objectContaining({ channel: 'public', seenLocally: true })]);
    const { result } = await confirmed({ game_id: 501 });
    expect(fake.marks).toEqual([{ gameId: 501 }]);
    expect(payload(result)).toMatchObject({ status: 'read', outcome: 'confirmed', local: { status: 'already-seen' } });
  });

  it('read in both: a no-op, no error', async () => {
    const fake = warapp([listed(501, {})], CHAT);
    h = await liveHarness({ feed: [feedGame(501)], pages: SIGNED_IN_ANN, warapp: fake.handler });
    await confirmed({ game_id: 501, scope: 'local' });
    const preview = await h.call('warapp_mark_chat_read', { game_id: 501 });
    expect(preview.isError).toBeFalsy();
    expect(payload(preview).preview).toMatchObject({ nothingToDo: true });
    const { result } = await confirmed({ game_id: 501 });
    expect(result.isError).toBeFalsy();
    expect(payload(result)).toMatchObject({ outcome: 'already-read', local: { status: 'already-seen' } });
    expect(fake.marks).toEqual([]);
  });
});

describe('warapp_mark_chat_read: several games in one confirmation', () => {
  it('previews every game, sends after one confirm, and reports each game', async () => {
    const chats = {
      601: [{ id: 3, date: at(1), from: BOB.inGame, text: 'a', turn: 1 }],
      602: [{ id: 4, date: at(1), from: BOB.inGame, text: 'b', turn: 1 }],
      603: [],
    };
    const fake = warapp([listed(601, { public: true }), listed(602, {}), listed(603, {})], chats);
    // The plan reads each game in the preview and again on confirm: GameFeed answers in call order.
    const round = [feedGame(601), feedGame(602), feedGame(603)];
    h = await liveHarness({ feed: [...round, ...round], pages: SIGNED_IN_ANN, warapp: fake.handler });
    const { preview, result } = await confirmed({ game_ids: [601, 602, 603] });
    expect(JSON.stringify(preview)).not.toMatch(/"a"|"b"|Bob/);
    expect(fake.marks).toEqual([{ gameId: 601 }]);
    const r = payload<{ games: Array<Record<string, unknown>> }>(result);
    expect(r.games).toEqual([
      expect.objectContaining({ gameId: 601, outcome: 'confirmed', local: expect.objectContaining({ status: 'marked' }) }),
      expect.objectContaining({ gameId: 602, outcome: 'already-read', local: expect.objectContaining({ status: 'marked' }) }),
      expect.objectContaining({ gameId: 603, outcome: 'skipped', reason: expect.stringMatching(/No message/) }),
    ]);
  });

  it('refuses when no game named has anything to mark', async () => {
    const fake = warapp([listed(603, {})], { 603: [] });
    h = await liveHarness({ feed: [feedGame(603)], pages: SIGNED_IN_ANN, warapp: fake.handler });
    const res = await h.call('warapp_mark_chat_read', { game_ids: [603] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/No message/);
  });
});

describe('privateToMeWarning (warapp_plan_turn)', () => {
  it('names the sender and quotes the first 80 characters, cleaned as untrusted text', () => {
    const w = privateToMeWarning([{ from: 'Bob', text: `I accept "the truce" ${'x'.repeat(100)}` }]);
    expect(w).toMatch(/^Unread private message to you from ⟦Bob⟧: ⟦I accept ʺthe truceʺ x+\.\.\.⟧\. /);
    expect(w).not.toContain('"the truce"');
    expect(w!.match(/x/g)!.length).toBeLessThan(80);
    expect(privateToMeWarning([])).toBeUndefined();
    expect(privateToMeWarning([{ from: 'Bob', text: 'a' }, { from: 'Cy', text: 'b' }])).toMatch(/and 1 more/);
  });
});

describe('privateToMeUnread (warapp_plan_turn)', () => {
  const me = { token: Number(ANN.feed), inGameId: ANN.inGame };
  const game = { id: 9, players: [] } as unknown as Game;
  const ctx = (rpc: () => never) => ({ dataDir: undefined, rpc: { call: rpc } }) as unknown as LiveContext;

  it('takes an unread private message to me from GameFeed with no request; mine and read ones are left out', async () => {
    const plan: PlanChatRead = {
      summary: { unread: { public: 0, team: 0, private: 1 }, source: 'gamefeed', note: '' },
      lines: [
        { sender: BOB.inGame, text: 'old', turn: 1, channel: 'private', to: ANN.inGame },
        { sender: ANN.inGame, text: 'mine', turn: 1, channel: 'private', to: BOB.inGame },
        { sender: BOB.inGame, text: 'accept', turn: 2, channel: 'private', to: ANN.inGame },
      ],
      fresh: [false, false, true],
      me,
    };
    const got = await privateToMeUnread(ctx(() => { throw new Error('no request expected'); }), game, plan);
    expect(got).toEqual([{ from: String(BOB.inGame), text: 'accept' }]);
  });

  it('asks nothing with no unread message of another player, and never throws when the web read fails', async () => {
    let asked = 0;
    const fail = ctx(() => { asked++; throw new Error('down'); });
    const quiet: PlanChatRead = { summary: { unread: { public: 0, team: 0, private: 0 }, source: 'gamefeed', note: '' }, lines: [], fresh: [], me };
    expect(await privateToMeUnread(fail, game, quiet)).toEqual([]);
    expect(asked).toBe(0);
    const unknown: PlanChatRead = { ...quiet, lines: [{ sender: BOB.inGame, text: 'hi', turn: 1, channel: 'unknown' }], fresh: [true] };
    expect(await privateToMeUnread(fail, game, unknown)).toEqual([]);
    expect(asked).toBe(1);
  });
});
