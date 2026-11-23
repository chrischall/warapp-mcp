// warapp_get_my_orders: my own orders this turn read back from the live board (LatestGameInfo's first field, the
// client's "active orders"; VERIFIED live 2026-11-22), in the shape warapp_submit_turn takes, so a withdrawn turn
// can be resubmitted as it was. And warapp_uncommit_turn carries them in its preview and result.
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeMap } from '../src/normalize.js';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { untrustedText } from '../src/tools/common.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticOrder, type SyntheticTerritory } from './protocol/live-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
// Synthetic GameFeed ids: the in-game id wrapped in two check digits each end.
const ME = { feed: '3312345644', inGame: 123456 };
const MATE = { feed: '7176543229', inGame: 765432 };
const SIGNED_IN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ME.feed}</p>` };
const map = normalizeMap(lobbyFixture().map);
const NAME = (id: number) => untrustedText(map.territories.find((t) => t.id === id)!.name);
/** A read tool's answer inside the untrusted envelope. */
const data = (r: unknown) => payload<{ data: Record<string, unknown> }>(r).data;
const GIFT = 'e512f968748246768d3d462e063c0e75';

function game(opts: { committed?: boolean; state?: string } = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const base = { isAI: 'False', humanTurnedIntoAI: 'False', state: 'Playing' };
  return {
    ...f,
    id: String(GAME),
    name: 'Synthetic Skirmish',
    state: opts.state ?? 'Playing',
    numberOfTurns: '9',
    players: [
      { ...base, id: ME.feed, name: 'Me', hasCommittedOrders: opts.committed === false ? 'False' : 'True', team: '0' },
      { ...base, id: MATE.feed, name: 'Mate', hasCommittedOrders: 'True', team: '0' },
      { ...base, id: '1001', name: 'Opponent', hasCommittedOrders: 'False', team: '1' },
    ],
  };
}

const BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ME.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ME.inGame, armies: 3 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 2, owner: MATE.inGame, armies: 7 },
];

// The live turn's shape, made-up ids: two deploys, a Gift to the teammate, moves.
const TURN: SyntheticOrder[] = [
  { kind: 'deploy', territory: 159, armies: 4 },
  { kind: 'deploy', territory: 161, armies: 1 },
  { kind: 'card', tag: 13, card: GIFT, ints: [MATE.inGame, 161] },
  { kind: 'move', from: 159, to: 157, armies: 9 },
];

const latest = (orders: readonly SyntheticOrder[] | null) => (req: DecodedRequest): Partial<ReplyFrame> => {
  if (req.method !== Method.GetLatestGameInfo) throw new Error(`unexpected method ${req.method}`);
  return {
    body: (w) =>
      writeLatestGameInfo(w, BOARD, [ME.inGame, MATE.inGame], {}, undefined, undefined, undefined, orders ? { player: ME.inGame, orders } : null),
  };
};

const SUBMIT_SHAPE = [
  { kind: 'deploy', territory: 159, armies: 4 },
  { kind: 'deploy', territory: 161, armies: 1 },
  { kind: 'card', card: GIFT, cardType: 'Gift', target: 161, player: Number(MATE.feed) },
  { kind: 'move', from: 159, to: 157, armies: 9 },
];

describe('warapp_get_my_orders', () => {
  it('is read-only and says it feeds warapp_submit_turn', async () => {
    h = await liveHarness();
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_get_my_orders')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    expect(tool.annotations?.destructiveHint).not.toBe(true);
    expect(tool.description).toMatch(/warapp_submit_turn/);
    expect(tool.description).toMatch(/committed/i);
  });

  it('reads my committed orders back in the shape warapp_submit_turn takes, with names to show', async () => {
    h = await liveHarness({ pages: SIGNED_IN, feed: [game()], warapp: latest(TURN) });
    const r = await h.call('warapp_get_my_orders', { game_id: GAME });
    expect(payload(r).untrusted_content).toBe(true);
    const p = data(r);
    expect(p.game).toMatchObject({ id: GAME, turn: 10 });
    expect(p.committed).toBe(true);
    expect(p.orders).toEqual(SUBMIT_SHAPE);
    const shown = (p.shown as string[]).join('\n');
    expect(shown).toContain(`Deploy 4 on ${NAME(159)}`);
    expect(shown).toMatch(/Gift card/);
    expect(shown).toContain(`${NAME(159)} (159) → ${NAME(157)} (157)`);
    expect(p.unread).toBeUndefined();
    // Read-only: nothing but the board was asked.
    expect(h.exchanges.map((e) => e.path)).not.toContainEqual(expect.stringMatching(/Send|UnCommit/));
  });

  it('orders unknown (null, never "none") when war.app sends no list of them', async () => {
    h = await liveHarness({ pages: SIGNED_IN, feed: [game()], warapp: latest(null) });
    const p = data(await h.call('warapp_get_my_orders', { game_id: GAME }));
    expect(p.committed).toBe(true);
    expect(p.orders).toBeNull();
    expect(String(p.note)).toMatch(/unknown/i);
  });

  it('orders unknown with a warning when the live board cannot be read', async () => {
    h = await liveHarness({
      pages: SIGNED_IN,
      feed: [game()],
      warapp: () => {
        throw new Error('bridge down');
      },
    });
    const p = data(await h.call('warapp_get_my_orders', { game_id: GAME }));
    expect(p.orders).toBeNull();
    expect(String((p.warnings as string[])[0])).toMatch(/could not be read/);
  });

  it('says entered orders that are not committed are unverified', async () => {
    h = await liveHarness({ pages: SIGNED_IN, feed: [game({ committed: false })], warapp: latest(TURN) });
    const p = data(await h.call('warapp_get_my_orders', { game_id: GAME }));
    expect(p.committed).toBe(false);
    expect(p.orders).toEqual(SUBMIT_SHAPE);
    expect(String(p.note)).toMatch(/not committed.*UNVERIFIED/s);
  });

  it('refuses outside a turn phase', async () => {
    h = await liveHarness({ pages: SIGNED_IN, feed: [game({ state: 'Finished' })], warapp: latest(TURN) });
    const res = await h.call('warapp_get_my_orders', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not in a turn phase/i);
  });
});

describe('warapp_uncommit_turn keeps the orders it withdraws', () => {
  it('mentions warapp_get_my_orders in both descriptions', async () => {
    h = await liveHarness();
    const tools = (await h.harness.client.listTools()).tools;
    expect(tools.find((t) => t.name === 'warapp_uncommit_turn')!.description).toMatch(/warapp_get_my_orders/);
    expect(tools.find((t) => t.name === 'warapp_submit_turn')!.description).toMatch(/warapp_get_my_orders/);
  });

  it('carries the committed orders in the preview and the result', async () => {
    const warapp = (req: DecodedRequest): Partial<ReplyFrame> => (req.method === Method.UnCommit ? {} : latest(TURN)(req));
    h = await liveHarness({ pages: SIGNED_IN, feed: [game(), game(), game({ committed: false })], warapp });
    const preview = payload(await h.call('warapp_uncommit_turn', { game_id: GAME }));
    expect(JSON.stringify(preview)).toContain(GIFT);
    const done = payload(await h.call('warapp_uncommit_turn', { game_id: GAME, confirmToken: preview.confirmToken }));
    expect(done.status).toBe('uncommitted');
    expect(done.withdrawnOrders).toEqual(SUBMIT_SHAPE);
  });

  it('withdraws anyway, saying the orders could not be read, when the board is unreadable', async () => {
    const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
      if (req.method === Method.UnCommit) return {};
      throw new Error('bridge down');
    };
    h = await liveHarness({ pages: SIGNED_IN, feed: [game(), game(), game({ committed: false })], warapp });
    const preview = payload(await h.call('warapp_uncommit_turn', { game_id: GAME }));
    expect(JSON.stringify(preview)).toMatch(/could not be read/);
    const done = payload(await h.call('warapp_uncommit_turn', { game_id: GAME, confirmToken: preview.confirmToken }));
    expect(done.status).toBe('uncommitted');
    expect(done.withdrawnOrders).toBeNull();
  });
});
