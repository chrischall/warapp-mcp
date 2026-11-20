// #415 task 4b: chat can block a turn — warapp_submit_turn and warapp_plan_turn under WARAPP_CHAT_BLOCKS_TURN
// (off by default). Synthetic names only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { CHAT_BLOCKS_NOTE } from '../src/tools/chat-advice.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const ME_PAGE = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };

function game(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>).map((p, i) =>
    i === 0 ? { ...p, id: ANN.feed, name: 'Ann' } : i === 1 ? { ...p, id: BOB.feed, name: 'Bob' } : p,
  );
  return { ...f, state: 'Playing', numberOfTurns: '2', players, ...extra };
}

// Ann holds 159 and 161; Bob's 158 borders both, so Bob is in contact this turn.
const BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 7 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

const TIME = '2026-11-20T10:01:00';
/** A threat naming me (Ann) by name, from Bob (in contact), on this turn: a block. */
const THREAT = [{ playerID: BOB.inGame, message: 'I will attack Ann', date: TIME, turn: 2 }];
/** Banter and an income check: never a block. */
const QUIET = [
  { playerID: BOB.inGame, message: 'income check?', date: TIME, turn: 2 },
  { playerID: BOB.inGame, message: 'lol nice', date: '2026-11-20T10:02:00', turn: 2 },
];

const GOOD = [
  { kind: 'deploy', territory: 159, armies: 3 },
  { kind: 'deploy', territory: 161, armies: 2 },
];

function server() {
  const sent: number[] = [];
  const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method === Method.GetLatestGameInfo) return { body: (w) => writeLatestGameInfo(w, BOARD, [ANN.inGame]) };
    if (req.method === Method.SendOrders) {
      sent.push(req.method);
      return { body: (w) => w.bool(true).bool(false) };
    }
    throw new Error(`unexpected method ${req.method}`);
  };
  return { sent, warapp };
}

const submitted = game({ numberOfTurns: '3' });

describe('warapp_submit_turn and unread chat (#415 task 4b)', () => {
  it('gate off (the default): never refuses; the preview names the would-be block, and the chat costs no request', async () => {
    const s = server();
    h = await liveHarness({ feed: [game({ chat: THREAT }), game({ chat: THREAT }), submitted], pages: ME_PAGE, warapp: s.warapp });
    const preview = payload<{ confirmToken: string; preview: { chatWarnings?: string[] } }>(await h.call('warapp_submit_turn', { game_id: GAME, orders: GOOD }));
    expect(preview.confirmToken).toEqual(expect.any(String));
    expect(preview.preview.chatWarnings).toEqual([expect.stringMatching(/^would block with WARAPP_CHAT_BLOCKS_TURN=on: message 2026-11-20T10:01:00 \(player 7176543229, turn 2, threat\)/)]);
    expect(JSON.stringify(preview.preview.chatWarnings)).not.toMatch(/attack Ann|Bob/);
    // The chat came in the game read the tool already makes: one GameFeed request, GetChat=true; nothing else asked.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toContain('GetChat=true');
    expect(h.exchanges.map((e) => e.request.method)).toEqual([Method.GetMyGames, Method.GetLatestGameInfo]);
    const r = payload(await h.call('warapp_submit_turn', { game_id: GAME, orders: GOOD, confirmToken: preview.confirmToken }));
    expect(r).toMatchObject({ status: 'resolved', outcome: 'confirmed' });
    expect(s.sent).toHaveLength(1);
    expect(r).not.toHaveProperty('chatReviewed');
  });

  it('the same request count with and without chat', async () => {
    const counts: number[][] = [];
    for (const chat of [undefined, THREAT]) {
      const s = server();
      h = await liveHarness({ feed: [game(chat ? { chat } : {})], pages: ME_PAGE, warapp: s.warapp });
      await h.call('warapp_submit_turn', { game_id: GAME, orders: GOOD });
      counts.push([h.calls.length, h.exchanges.length, h.bridge.requests.length]);
      await h.harness.close();
      h = undefined;
    }
    expect(counts[1]).toEqual(counts[0]);
  });

  it('gate on: refuses before sending, naming the message by id, sender id, intent and why', async () => {
    const s = server();
    h = await liveHarness({ feed: [game({ chat: THREAT })], pages: ME_PAGE, warapp: s.warapp, env: { WARAPP_CHAT_BLOCKS_TURN: 'on' } });
    const r = await h.call('warapp_submit_turn', { game_id: GAME, orders: GOOD });
    expect(r.isError).toBe(true);
    const text = textOf(r);
    expect(text).toMatch(/WARAPP_CHAT_BLOCKS_TURN=on/);
    expect(text).toContain(`message ${TIME}`);
    expect(text).toContain(`player ${BOB.feed}`);
    expect(text).toContain('threat');
    expect(text).toMatch(/borders me this turn/);
    expect(text).toMatch(/chat_reviewed/);
    expect(text).not.toMatch(/confirmToken/);
    expect(s.sent).toEqual([]);
  });

  it('gate on: income checks and banter never block', async () => {
    const s = server();
    h = await liveHarness({ feed: [game({ chat: QUIET })], pages: ME_PAGE, warapp: s.warapp, env: { WARAPP_CHAT_BLOCKS_TURN: 'on' } });
    const preview = payload<{ confirmToken: string; preview: Record<string, unknown> }>(await h.call('warapp_submit_turn', { game_id: GAME, orders: GOOD }));
    expect(preview.confirmToken).toEqual(expect.any(String));
    expect(preview.preview).not.toHaveProperty('chatWarnings');
  });

  it('gate on: chat_reviewed passes, the result records chatReviewed, and the decision log marks the message', async () => {
    const s = server();
    h = await liveHarness({
      feed: [game({ chat: THREAT }), game({ chat: THREAT }), submitted],
      pages: ME_PAGE,
      warapp: s.warapp,
      env: { WARAPP_CHAT_BLOCKS_TURN: 'on' },
    });
    const args = { game_id: GAME, orders: GOOD, chat_reviewed: true };
    const preview = payload<{ confirmToken: string; preview: { chatWarnings?: string[] } }>(await h.call('warapp_submit_turn', args));
    expect(preview.preview.chatWarnings).toEqual([expect.stringMatching(/^chat_reviewed is true: message 2026-11-20T10:01:00/)]);
    const r = payload<Record<string, unknown>>(await h.call('warapp_submit_turn', { ...args, confirmToken: preview.confirmToken }));
    expect(r.outcome).toBe('confirmed');
    expect(r.chatReviewed).toEqual({ blocks: [{ case: 'threat', intent: 'threat', from: Number(BOB.feed), messageIds: [TIME] }] });
    expect(s.sent).toHaveLength(1);
    const log = readFileSync(join(h.dataDir, 'decisions', `${GAME}.json`), 'utf8');
    expect(JSON.parse(log).turns['3'].chat).toEqual([
      { time: TIME, turn: 2, from: Number(BOB.feed), channel: 'unknown', toMe: false, intents: ['threat'], confidence: 'high', blocks: true },
    ]);
    expect(log).not.toMatch(/attack Ann|Bob/);
  });

  it('gate on: a message marked seen since no longer blocks', async () => {
    const s = server();
    h = await liveHarness({ feed: [game({ chat: THREAT })], pages: ME_PAGE, warapp: s.warapp, env: { WARAPP_CHAT_BLOCKS_TURN: 'on' } });
    expect((await h.call('warapp_submit_turn', { game_id: GAME, orders: GOOD })).isError).toBe(true);
    // warapp_get_chat's mark_seen writes only this machine's cursor (the web read is unrouted: GameFeed's chat answers).
    const read = await h.call('warapp_get_chat', { game_id: GAME, mark_seen: true });
    expect(read.isError, textOf(read)).toBeFalsy();
    const preview = payload<{ confirmToken?: string; preview: Record<string, unknown> }>(await h.call('warapp_submit_turn', { game_id: GAME, orders: GOOD }));
    expect(preview.confirmToken).toEqual(expect.any(String));
    expect(preview.preview).not.toHaveProperty('chatWarnings');
    expect(s.sent).toEqual([]);
  });
});

describe('warapp_plan_turn reports the chat blocks (#415 task 4b)', () => {
  it('lists them in `chat` with the gate state, logs them, and the orders do not change', async () => {
    const plan = async (extra: Record<string, unknown>, env: Record<string, string> = {}) => {
      const s = server();
      h = await liveHarness({ feed: [game(extra)], pages: ME_PAGE, warapp: s.warapp, env });
      const p = payload<Record<string, unknown> & { chat?: Record<string, unknown> }>(await h.call('warapp_plan_turn', { game_id: GAME }));
      const log = (() => {
        try {
          return readFileSync(join(h!.dataDir, 'decisions', `${GAME}.json`), 'utf8');
        } catch {
          return '';
        }
      })();
      await h.harness.close();
      h = undefined;
      return { p, log };
    };
    const quiet = await plan({});
    const loud = await plan({ chat: THREAT });
    const on = await plan({ chat: THREAT }, { WARAPP_CHAT_BLOCKS_TURN: 'on' });
    expect(loud.p.chat?.chatBlocks).toEqual([
      expect.objectContaining({ case: 'threat', intent: 'threat', from: Number(BOB.feed), messageIds: [TIME], line: expect.stringContaining('threat') }),
    ]);
    expect(loud.p.chat?.chatBlocksGate).toBe('off');
    expect(on.p.chat?.chatBlocksGate).toBe('on');
    expect(loud.p.chat?.chatBlocksNote).toBe(CHAT_BLOCKS_NOTE);
    for (const k of ['goal', 'deploys', 'moves', 'orders', 'expected']) expect(loud.p[k], k).toEqual(quiet.p[k]);
    expect(JSON.parse(loud.log).turns['3'].chat).toEqual([expect.objectContaining({ time: TIME, intents: ['threat'], blocks: true })]);
  });

  it('banter gives no chatBlocks', async () => {
    const s = server();
    h = await liveHarness({ feed: [game({ chat: QUIET })], pages: ME_PAGE, warapp: s.warapp });
    const p = payload<{ chat: Record<string, unknown> }>(await h.call('warapp_plan_turn', { game_id: GAME }));
    expect(p.chat).not.toHaveProperty('chatBlocks');
  });
});
