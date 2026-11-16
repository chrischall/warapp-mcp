// warapp_get_notifications and warapp_dismiss_notification (#311): war.app's in-app notifications
// through GetInAppNotifications (317), marked read with AcknowledgeInAppNotifications (319).
// Synthetic replies built by our encoder only; no war.app traffic.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { profileGamePath, profileGamesDir } from '../src/profile-store.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeInAppNotificationsReturn, type SyntheticNotification } from './protocol/notifications-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const ME = { feed: '3312345644', inGame: 123456 };
const SIGNED_IN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ME.feed}</p>` };
const GAME = 4017;
const BOB = 7176543229;
const link = (id: number) => ({ Url: `https://war.app/MultiPlayer?GameID=${id}`, Body: 'Player Somebody did a thing' });

/** A fake war.app holding `items`: lists them by page, marks read on acknowledge (unless `ackWorks` is false). */
function notificationServer(
  items: SyntheticNotification[],
  opts: { ackWorks?: boolean; ackDeletes?: boolean; ackPrepends?: number; ack?: Partial<ReplyFrame> } = {},
) {
  const state = items.map((n) => ({ ...n }));
  const lists: Array<{ start: number; count: number }> = [];
  const acks: string[][] = [];
  const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
    const r = req.body;
    if (req.method === Method.GetInAppNotifications) {
      const start = r.int32();
      const count = r.int32();
      lists.push({ start, count });
      return { body: (w) => writeInAppNotificationsReturn(w, state.slice(start, start + count), state.length) };
    }
    if (req.method === Method.AcknowledgeInAppNotifications) {
      const ids = r.bool() ? (r.list((rr) => rr.string() ?? '') ?? []) : [];
      acks.push(ids);
      if (opts.ack) return opts.ack;
      if (opts.ackPrepends) state.unshift(...Array.from({ length: opts.ackPrepends }, (_, i) => ({ id: String(800_000 + i) })));
      if (opts.ackDeletes) state.splice(0, state.length, ...state.filter((n) => !ids.includes(n.id)));
      else if (opts.ackWorks !== false) for (const n of state) if (ids.includes(n.id)) n.unread = false;
      return { body: () => {} };
    }
    throw new Error(`unexpected method ${req.method}`);
  };
  return { warapp, lists, acks, state };
}

function finishedGame(): Record<string, unknown> {
  const f = lobbyFixture();
  const [a, b] = f.players as Array<Record<string, string>>;
  return {
    ...f,
    id: String(GAME),
    state: 'Finished',
    numberOfTurns: '6',
    players: [
      { ...a, id: ME.feed, name: 'Me', state: 'Won' },
      { ...b, id: String(BOB), name: 'Bob', state: 'SurrenderAccepted' },
    ],
  };
}

describe('warapp_get_notifications', () => {
  it('is read-only and annotated', async () => {
    h = await liveHarness();
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_get_notifications')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    expect(tool.annotations?.destructiveHint).not.toBe(true);
    expect(tool.description).toMatch(/GetInAppNotifications/);
  });

  it('lists the first page name-free: id, kind, game id, time, unread — never the title, body or type field', async () => {
    const s = notificationServer([
      { id: '9001', title: 'Game "Bob\'s war" has ended. You can now view its history', data: link(GAME), unread: true },
      { id: '9002', title: 'Player Somebody invited you', data: { Body: 'Somebody wrote this' }, unread: false, n4: 'GroupInvite' },
    ]);
    h = await liveHarness({ pages: SIGNED_IN, warapp: s.warapp });
    const p = payload(await h.call('warapp_get_notifications', {}));
    expect(s.lists).toEqual([{ start: 0, count: 30 }]);
    expect(p.notifications).toEqual([
      { id: '9001', kind: 'game-ended', gameId: GAME, time: '2026-11-15T12:00:00.000Z', unread: true },
      { id: '9002', kind: 'other', gameId: null, time: '2026-11-15T12:00:00.000Z', unread: false },
    ]);
    expect(p).toMatchObject({ count: 2, unread: 1, total: 2 });
    expect(p.next).toBeUndefined();
    const text = JSON.stringify(p);
    expect(text).not.toMatch(/Somebody|Bob|invited|GroupInvite/);
    expect(text).toMatch(/UNVERIFIED/);
  });

  it('pages with start and next, and filters with unread_only', async () => {
    const many = Array.from({ length: 35 }, (_, i) => ({ id: String(100 + i), unread: i % 2 === 0 }));
    const s = notificationServer(many);
    h = await liveHarness({ pages: SIGNED_IN, warapp: s.warapp });
    const first = payload(await h.call('warapp_get_notifications', {}));
    expect(first).toMatchObject({ count: 30, total: 35, next: 30 });
    const second = payload(await h.call('warapp_get_notifications', { start: 30, unread_only: true }));
    expect(s.lists.at(-1)).toEqual({ start: 30, count: 30 });
    expect((second.notifications as Array<{ id: string }>).map((n) => n.id)).toEqual(['130', '132', '134']);
    expect(second.next).toBeUndefined();
  });

  it('a game-ended notification folds a kept opponent profile of that game, reading the game once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-notif-'));
    mkdirSync(profileGamesDir(dir), { recursive: true });
    const turn = { contact: true, attackedMe: true, iAttacked: false, reinforce: { n: 0, e: 0, extra: 0 }, stack: null, tookFromMe: [], lostToMe: [] };
    writeFileSync(
      profileGamePath(dir, GAME, Number(ME.feed)),
      JSON.stringify({ version: 1, gameId: GAME, playerId: Number(ME.feed), turns: { 1: { [BOB]: turn } } }),
    );
    const s = notificationServer([{ id: '9001', title: 'Game "g" has ended. You can now view its history', data: link(GAME) }]);
    h = await liveHarness({ pages: SIGNED_IN, warapp: s.warapp, feed: [finishedGame()], dataDir: dir });
    const p = payload(await h.call('warapp_get_notifications', {}));
    expect(p.profilesFolded).toEqual([{ gameId: GAME, files: 1 }]);
    expect(JSON.parse(readFileSync(profileGamePath(dir, GAME, Number(ME.feed)), 'utf8')).folded).toBe('live');
    expect(h.calls.filter((c) => c.url.includes('GameFeed'))).toHaveLength(1);
    // Read again: already folded, so GameFeed is not asked.
    const again = payload(await h.call('warapp_get_notifications', {}));
    expect(again.profilesFolded).toBeUndefined();
    expect(h.calls.filter((c) => c.url.includes('GameFeed'))).toHaveLength(1);
  });

  it('asks GameFeed nothing for a game-ended notification with no kept profile, or with profiling off', async () => {
    const s = notificationServer([{ id: '9001', title: 'Game "g" has ended. You can now view its history', data: link(GAME) }]);
    h = await liveHarness({ pages: SIGNED_IN, warapp: s.warapp, feed: [finishedGame()] });
    const p = payload(await h.call('warapp_get_notifications', {}));
    expect(p.profilesFolded).toBeUndefined();
    expect(h.calls.filter((c) => c.url.includes('GameFeed'))).toHaveLength(0);
    await h.harness.close();
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-notif-off-'));
    mkdirSync(profileGamesDir(dir), { recursive: true });
    writeFileSync(profileGamePath(dir, GAME, Number(ME.feed)), JSON.stringify({ version: 1, gameId: GAME, playerId: Number(ME.feed), turns: {} }));
    h = await liveHarness({ pages: SIGNED_IN, warapp: s.warapp, feed: [finishedGame()], dataDir: dir, env: { WARAPP_PLAYER_PROFILE: 'off' } });
    expect(payload(await h.call('warapp_get_notifications', {})).profilesFolded).toBeUndefined();
    expect(h.calls.filter((c) => c.url.includes('GameFeed'))).toHaveLength(0);
  });
});

describe('warapp_dismiss_notification', () => {
  async function confirmed(args: Record<string, unknown>) {
    const preview = payload(await h!.call('warapp_dismiss_notification', args));
    expect(preview.confirmToken).toEqual(expect.any(String));
    return h!.call('warapp_dismiss_notification', { ...args, confirmToken: preview.confirmToken });
  }

  it('is a confirm-gated, idempotent, non-destructive write', async () => {
    h = await liveHarness();
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_dismiss_notification')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(tool.description).toMatch(/AcknowledgeInAppNotifications/);
  });

  it('previews by id and game id only, and sends nothing until confirmed', async () => {
    const s = notificationServer([{ id: '9001', title: 'Player Somebody beat you', data: link(GAME) }]);
    h = await liveHarness({ pages: SIGNED_IN, warapp: s.warapp });
    const preview = payload(await h.call('warapp_dismiss_notification', { ids: ['9001'] }));
    const text = JSON.stringify(preview);
    expect(text).toContain('9001');
    expect(text).toContain(String(GAME));
    expect(text).not.toMatch(/Somebody/);
    expect(s.acks).toEqual([]);
  });

  it('acknowledges the unread ids and reports dismissed once the list reads them read', async () => {
    const s = notificationServer([{ id: '9001' }, { id: '9002' }, { id: '9003', unread: false }]);
    h = await liveHarness({ pages: SIGNED_IN, warapp: s.warapp });
    const p = payload(await confirmed({ ids: ['9001', 9002, '9003'] }));
    expect(s.acks).toEqual([['9001', '9002']]);
    expect(p).toMatchObject({ status: 'dismissed', outcome: 'confirmed', dismissed: ['9001', '9002'], alreadyRead: ['9003'] });
  });

  it('a notification gone from the list on read-back counts as dismissed when the whole list was read', async () => {
    const s = notificationServer([{ id: '9001' }], { ackDeletes: true });
    h = await liveHarness({ pages: SIGNED_IN, warapp: s.warapp });
    const p = payload(await confirmed({ ids: ['9001'] }));
    expect(p).toMatchObject({ status: 'dismissed', outcome: 'confirmed', gone: ['9001'] });
  });

  it('gone from a long list counts as dismissed when the pages read cover where it was', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: String(100 + i) }));
    const s = notificationServer(many, { ackDeletes: true });
    h = await liveHarness({ pages: SIGNED_IN, warapp: s.warapp });
    const p = payload(await confirmed({ ids: ['110'] }));
    expect(p).toMatchObject({ status: 'dismissed', outcome: 'confirmed', gone: ['110'] });
  });

  it('an id the read-back does not reach is unconfirmed, "not seen in the pages read", never confirmed', async () => {
    // 200 notifications, the one dismissed at index 140 (inside the pages a plan reads); the
    // acknowledge brings 50 new ones in on top, pushing it past the pages the read-back reads.
    const many = Array.from({ length: 200 }, (_, i) => ({ id: String(100 + i) }));
    const s = notificationServer(many, { ackPrepends: 50 });
    h = await liveHarness({ pages: SIGNED_IN, warapp: s.warapp });
    const p = payload(await confirmed({ ids: ['240'] }));
    expect(s.acks).toEqual([['240']]);
    expect(p).toMatchObject({ status: 'unconfirmed', outcome: 'unconfirmed', notSeen: ['240'] });
    expect(p.warning).toMatch(/not seen in the pages read/);
    expect(p.dismissed).toBeUndefined();
  });

  it('is unconfirmed when the list still shows an id unread', async () => {
    const s = notificationServer([{ id: '9001' }, { id: '9002' }], { ackWorks: false });
    h = await liveHarness({ pages: SIGNED_IN, warapp: s.warapp });
    const p = payload(await confirmed({ ids: ['9001', '9002'] }));
    expect(p).toMatchObject({ status: 'unconfirmed', outcome: 'unconfirmed', stillUnread: ['9001', '9002'] });
    expect(s.acks).toHaveLength(1);
  });

  it('is unknown, and never resent, when war.app does not answer', async () => {
    const s = notificationServer([{ id: '9001' }], { ack: { msgNum: 999 } });
    h = await liveHarness({ pages: SIGNED_IN, warapp: s.warapp });
    const res = await confirmed({ ids: ['9001'] });
    const p = payload(res);
    expect(p).toMatchObject({ status: 'unknown', outcome: 'unknown' });
    expect(s.acks).toHaveLength(1);
  });

  it('refuses ids not in the list, all already read, or not decimal text', async () => {
    const s = notificationServer([{ id: '9001', unread: false }]);
    h = await liveHarness({ pages: SIGNED_IN, warapp: s.warapp });
    const missing = await h.call('warapp_dismiss_notification', { ids: ['424242'] });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/424242/);
    const read = await h.call('warapp_dismiss_notification', { ids: ['9001'] });
    expect(read.isError).toBe(true);
    expect(textOf(read)).toMatch(/already read/i);
    const bad = await h.call('warapp_dismiss_notification', { ids: ['12a'] });
    expect(bad.isError).toBe(true);
    expect(s.acks).toEqual([]);
  });
});
