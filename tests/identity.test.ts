import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MapCache, WarappClient } from '../src/client.js';
import { SESSION_HOST, writeSession, type Session } from '../src/direct/session.js';
import { createDirectFirstBridge, type DirectFetch, type SessionStore } from '../src/direct/transport.js';
import { createLiveContext, IDENTITY_TTL_MS } from '../src/tools/live-context.js';
import { Writer } from '../src/protocol/codec.js';
import { OPEN_GAMES_URL } from '../src/open-games.js';
import { mockWarappBridge } from './bridge-mock.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeGameInfo } from './protocol/my-games-bundle.js';

/**
 * "Me" is whoever the InviteToken page says is signed in. Which account that is
 * can change under a running process: a relink, or the direct session expiring
 * so the router falls back to a browser tab signed in as someone else. The
 * cached identity must follow — and every write re-reads it before its preview.
 * Synthetic accounts and fake tokens only.
 */

const A = '3312345644';
const B = '5512345699';
const INVITE = 'https://war.app/InviteToken';
const page = (token: string) => `<p>Your invite token is ${token}</p>`;
const SIGNED_OUT = { status: 200, body: '<form><input type="password" name="pw"></form>', url: 'https://war.app/SignIn' };

const client = new WarappClient({ env: {}, fetchImpl: async () => new Response('{}'), mapCache: new MapCache() });
const unusedBundle = async () => {
  throw new Error('unused');
};

describe('createLiveContext: the cached identity', () => {
  /** A context whose InviteToken page answers `who()` and whose state key is `key()`. */
  function ctxWith(opts: { who: () => string | null; key?: () => string; now?: () => number }) {
    let fetches = 0;
    const { bridge } = mockWarappBridge(() => {
      fetches += 1;
      const w = opts.who();
      return w === null ? { status: 500, body: '', url: INVITE } : { status: 200, body: page(w), url: INVITE };
    });
    const ctx = createLiveContext({
      client,
      bridge,
      bundle: unusedBundle,
      ...(opts.key ? { identity: async () => opts.key!() } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    return { ctx, fetches: () => fetches };
  }

  it('is discarded when the transport state changes', async () => {
    let who = A;
    let key = 'direct|linked-at-1';
    const c = ctxWith({ who: () => who, key: () => key });
    expect(await c.ctx.myInviteToken()).toBe(Number(A));
    expect(await c.ctx.myInviteToken()).toBe(Number(A));
    expect(c.fetches()).toBe(1);
    who = B;
    key = 'fetchproxy|linked-at-1';
    expect(await c.ctx.myInviteToken()).toBe(Number(B));
    expect(c.fetches()).toBe(2);
  });

  it('expires after a short lifetime even when nothing visible changed', async () => {
    let who = A;
    let t = 1_000_000;
    const c = ctxWith({ who: () => who, key: () => 'k', now: () => t });
    expect(await c.ctx.myInviteToken()).toBe(Number(A));
    who = B;
    t += IDENTITY_TTL_MS - 1;
    expect(await c.ctx.myInviteToken()).toBe(Number(A));
    t += 2;
    expect(await c.ctx.myInviteToken()).toBe(Number(B));
    expect(c.fetches()).toBe(2);
  });

  it('is bypassed by a fresh read, which refreshes it', async () => {
    let who = A;
    const c = ctxWith({ who: () => who, key: () => 'k' });
    expect(await c.ctx.myInviteToken()).toBe(Number(A));
    who = B;
    expect(await c.ctx.myInviteToken({ fresh: true })).toBe(Number(B));
    expect(await c.ctx.myInviteToken()).toBe(Number(B));
    expect(c.fetches()).toBe(2);
  });

  it('is discarded explicitly by forgetIdentity', async () => {
    let who = A;
    const c = ctxWith({ who: () => who, key: () => 'k' });
    expect(await c.ctx.myInviteToken()).toBe(Number(A));
    who = B;
    c.ctx.forgetIdentity();
    expect(await c.ctx.myInviteToken()).toBe(Number(B));
  });

  it('never caches a failed read: the next call retries', async () => {
    let who: string | null = null;
    const c = ctxWith({ who: () => who, key: () => 'k' });
    expect(await c.ctx.myInviteToken()).toBeUndefined();
    who = A;
    expect(await c.ctx.myInviteToken()).toBe(Number(A));
    expect(c.fetches()).toBe(2);
    // A failed fresh read does not leave the old success behind either.
    who = null;
    expect(await c.ctx.myInviteToken({ fresh: true })).toBeUndefined();
    who = B;
    expect(await c.ctx.myInviteToken()).toBe(Number(B));
  });

  it('an older read finishing after a fresh one never overwrites it', async () => {
    // The first InviteToken read is held open and answers A; the fresh read that
    // starts after it answers B at once.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    const { bridge } = mockWarappBridge(async () => {
      calls += 1;
      if (calls === 1) {
        await held;
        return { status: 200, body: page(A), url: INVITE };
      }
      return { status: 200, body: page(B), url: INVITE };
    });
    const ctx = createLiveContext({ client, bridge, bundle: unusedBundle, identity: async () => 'k' });
    const slow = ctx.myInviteToken();
    await new Promise((r) => setTimeout(r, 0));
    expect(await ctx.myInviteToken({ fresh: true })).toBe(Number(B));
    release();
    expect(await slow).toBe(Number(A));
    // The cache holds the fresh read's B, not the slower, older A.
    expect(await ctx.myInviteToken()).toBe(Number(B));
    expect(calls).toBe(2);
  });

  it('an older failed read finishing after a fresh success does not discard it', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    const { bridge } = mockWarappBridge(async () => {
      calls += 1;
      if (calls === 1) {
        await held;
        return { status: 500, body: '', url: INVITE };
      }
      return { status: 200, body: page(B), url: INVITE };
    });
    const ctx = createLiveContext({ client, bridge, bundle: unusedBundle, identity: async () => 'k' });
    const slow = ctx.myInviteToken();
    await new Promise((r) => setTimeout(r, 0));
    expect(await ctx.myInviteToken({ fresh: true })).toBe(Number(B));
    release();
    expect(await slow).toBeUndefined();
    expect(await ctx.myInviteToken()).toBe(Number(B));
    expect(calls).toBe(2);
  });
});

describe('the identity follows the real direct-first router', () => {
  /** A router over a mutable session store, a scripted direct leg and a mock browser bridge. */
  function routed() {
    const state = {
      session: { authToken: 'test-auth-token', capturedAt: '2026-11-12T10:00:00.000Z', host: SESSION_HOST } as Session,
      direct: A as string | 'signed-out',
      tab: B,
    };
    const store: SessionStore = { read: async () => state.session };
    const directFetch: DirectFetch = async (url) =>
      state.direct === 'signed-out' ? SIGNED_OUT : { status: 200, body: url === INVITE ? page(state.direct) : '<p>ok</p>', url };
    const { bridge: fetchproxy } = mockWarappBridge((req) =>
      req.path === INVITE ? { status: 200, body: page(state.tab), url: INVITE } : { status: 200, body: '<p>ok</p>', url: req.path },
    );
    const bridge = createDirectFirstBridge({
      store,
      makeBridge: () => fetchproxy,
      mode: 'auto',
      directFetch,
      env: {},
      log: () => {},
    });
    const ctx = createLiveContext({ client, bridge, bundle: unusedBundle, identity: () => bridge.identityState() });
    return { state, bridge, ctx };
  }

  it('a relink to another account: the next resolve is the new account', async () => {
    const r = routed();
    expect(await r.ctx.myInviteToken()).toBe(Number(A));
    r.state.session = { ...r.state.session, capturedAt: '2026-11-12T11:00:00.000Z' };
    r.state.direct = B;
    expect(await r.ctx.myInviteToken()).toBe(Number(B));
  });

  it('the direct session expires and the router falls back to a tab signed in as someone else', async () => {
    const r = routed();
    expect(await r.ctx.myInviteToken()).toBe(Number(A));
    r.state.direct = 'signed-out';
    // Any bridged call notices the expiry and moves the router to the browser tab.
    await r.ctx.fetchPage('https://war.app/MultiPlayer');
    expect(r.bridge.status().transport).toBe('fetchproxy');
    expect(await r.ctx.myInviteToken()).toBe(Number(B));
  });

  it('a leg change while the InviteToken read is in flight: the old answer is not kept under the new state', async () => {
    const state = {
      session: { authToken: 'test-auth-token', capturedAt: '2026-11-12T10:00:00.000Z', host: SESSION_HOST } as Session,
    };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let inviteReached!: () => void;
    const reached = new Promise<void>((r) => (inviteReached = r));
    // The InviteToken read on the direct leg is held open and then answers A;
    // any other direct call answers a sign-in form, which moves the router.
    const directFetch: DirectFetch = async (url) => {
      if (url === INVITE) {
        inviteReached();
        await held;
        return { status: 200, body: page(A), url };
      }
      return SIGNED_OUT;
    };
    const { bridge: fetchproxy } = mockWarappBridge((req) =>
      req.path === INVITE ? { status: 200, body: page(B), url: INVITE } : { status: 200, body: '<p>ok</p>', url: req.path },
    );
    const bridge = createDirectFirstBridge({
      store: { read: async () => state.session },
      makeBridge: () => fetchproxy,
      mode: 'auto',
      directFetch,
      env: {},
      log: () => {},
    });
    const ctx = createLiveContext({ client, bridge, bundle: unusedBundle, identity: () => bridge.identityState() });
    const inFlight = ctx.myInviteToken();
    await reached;
    // A concurrent call finds the session expired and moves the router to the tab.
    await ctx.fetchPage('https://war.app/Profile?p=1');
    expect(bridge.status().transport).toBe('fetchproxy');
    release();
    expect(await inFlight).toBe(Number(A));
    // The tab is signed in as B: a non-fresh resolve must re-read, not return A.
    expect(await ctx.myInviteToken()).toBe(Number(B));
  });

  it('the state key never carries the session token', async () => {
    const r = routed();
    expect(await r.bridge.identityState()).not.toContain('test-auth-token');
  });
});

describe('a write previews for the account that will act', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.harness.close();
    h = undefined;
  });

  const GAME_ID = 4001;
  function feedGame(seated: string): Record<string, unknown> {
    const f = lobbyFixture();
    const template = (f.players as Array<Record<string, string>>)[0]!;
    return {
      ...f,
      id: String(GAME_ID),
      name: 'Synthetic Duel',
      state: 'Playing',
      numberOfTurns: '5',
      players: [
        { ...template, id: seated, name: 'Seated', state: 'Playing' },
        { ...template, id: '1001', name: 'Opponent', state: 'Playing' },
      ],
    };
  }

  it('surrender: after the direct session expires, the preview is checked against the tab account', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'warapp-mcp-identity-'));
    await writeSession({ authToken: 'test-auth-token', capturedAt: '2026-11-12T10:00:00.000Z', host: SESSION_HOST }, {
      MCP_DATA_DIR: dataDir,
    });
    let expired = false;
    const directFetch: DirectFetch = async (url) =>
      expired ? SIGNED_OUT : { status: 200, body: url === INVITE ? page(A) : '', url };
    h = await liveHarness({
      dataDir,
      directFetch,
      pages: { [INVITE]: page(B) },
      // GameFeed: A's game for the first preview, then B's, then A's again.
      feed: [feedGame(A), feedGame(B), feedGame(A)],
    });
    const first = payload(await h.call('warapp_surrender', { game_id: GAME_ID }));
    expect(first.confirmToken).toEqual(expect.any(String));

    expired = true;
    // B is now the signed-in account: B's game previews, A's game is refused.
    const second = payload(await h.call('warapp_surrender', { game_id: GAME_ID }));
    expect(second.confirmToken).toEqual(expect.any(String));
    const third = await h.call('warapp_surrender', { game_id: GAME_ID });
    expect(third.isError).toBe(true);
    expect(textOf(third)).toMatch(/not a player in game/i);
  });

  /** A game where both A and B hold a seat, so each passes the precondition checks. */
  function sharedGame(): Record<string, unknown> {
    const f = lobbyFixture();
    const template = (f.players as Array<Record<string, string>>)[0]!;
    return {
      ...f,
      id: String(GAME_ID),
      name: 'Synthetic FFA',
      state: 'Playing',
      numberOfTurns: '5',
      players: [
        { ...template, id: A, name: 'Alpha', state: 'Playing' },
        { ...template, id: B, name: 'Bravo', state: 'Playing' },
        { ...template, id: '1001', name: 'Opponent', state: 'Playing' },
      ],
    };
  }

  /** A linked direct session that answers as A until `expire()`; the tab behind the bridge is B. */
  async function switchingHarness(opts: { elicitation?: NonNullable<Parameters<typeof liveHarness>[0]>['elicitation'] } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), 'warapp-mcp-identity-'));
    await writeSession({ authToken: 'test-auth-token', capturedAt: '2026-11-12T10:00:00.000Z', host: SESSION_HOST }, {
      MCP_DATA_DIR: dataDir,
    });
    const state = { expired: false };
    const directFetch: DirectFetch = async (url) =>
      state.expired ? SIGNED_OUT : { status: 200, body: url === INVITE ? page(A) : '', url };
    const harness = await liveHarness({
      dataDir,
      directFetch,
      pages: { [INVITE]: page(B) },
      feed: [sharedGame()],
      ...(opts.elicitation ? { elicitation: opts.elicitation } : {}),
    });
    return { h: harness, expire: () => (state.expired = true) };
  }

  const sent = (x: Harness, method: string) => x.exchanges.some((e) => e.path.includes(`m=${method}&`));

  it('the preview names the account the write is bound to', async () => {
    const s = await switchingHarness();
    h = s.h;
    const first = payload<{ preview: Record<string, unknown> }>(await h.call('warapp_surrender', { game_id: GAME_ID }));
    expect(JSON.stringify(first.preview.account)).toContain(A);
  });

  it("a confirmToken minted for A's preview is refused once B is signed in, and nothing is sent", async () => {
    const s = await switchingHarness();
    h = s.h;
    const first = payload(await h.call('warapp_surrender', { game_id: GAME_ID }));
    expect(first.confirmToken).toEqual(expect.any(String));
    s.expire();
    const r = await h.call('warapp_surrender', { game_id: GAME_ID, confirmToken: first.confirmToken });
    expect(r.isError).toBe(true);
    expect(sent(h, 'Surrender')).toBe(false);
  });

  it("chat: A's confirmToken does not send as B", async () => {
    const s = await switchingHarness();
    h = s.h;
    const first = payload(await h.call('warapp_send_chat', { game_id: GAME_ID, message: 'gg' }));
    expect(first.confirmToken).toEqual(expect.any(String));
    s.expire();
    const r = await h.call('warapp_send_chat', { game_id: GAME_ID, message: 'gg', confirmToken: first.confirmToken });
    expect(r.isError).toBe(true);
    expect(sent(h, 'SendChat')).toBe(false);
  });

  it('elicitation: an account change while the user confirms asks again, for the new account', async () => {
    const messages: string[] = [];
    let flip: () => void = () => {};
    const s = await switchingHarness({
      elicitation: (req) => {
        messages.push(JSON.stringify(req));
        flip();
        return { action: 'accept', content: { confirmed: true } };
      },
    });
    flip = s.expire;
    h = s.h;
    await h.call('warapp_surrender', { game_id: GAME_ID });
    // The approval given while A was signed in is not B's: B is asked for their own.
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain(A);
    expect(messages[1]).toContain(B);
  });

  it('elicitation: an account change after the last plan, before execute, refuses and sends nothing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'warapp-mcp-identity-'));
    await writeSession({ authToken: 'test-auth-token', capturedAt: '2026-11-12T10:00:00.000Z', host: SESSION_HOST }, {
      MCP_DATA_DIR: dataDir,
    });
    // The direct session answers as A for the plan reads, and signs out at the
    // read execute makes, so the router falls back to the tab signed in as B.
    let elicited = false;
    let readsSinceElicit = 0;
    let expired = false;
    const directFetch: DirectFetch = async (url) => {
      if (url === INVITE && elicited && ++readsSinceElicit === 2) expired = true;
      return expired ? SIGNED_OUT : { status: 200, body: url === INVITE ? page(A) : '', url };
    };
    h = await liveHarness({
      dataDir,
      directFetch,
      pages: { [INVITE]: page(B) },
      feed: [sharedGame()],
      elicitation: () => {
        elicited = true;
        return { action: 'accept', content: { confirmed: true } };
      },
    });
    const r = await h.call('warapp_surrender', { game_id: GAME_ID });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/account changed/i);
    expect(sent(h, 'Surrender')).toBe(false);
  });

  /**
   * Every write re-reads the account for its plan (`fresh: true`), not only
   * surrender. First the account is A, then it becomes C, who holds no seat
   * that would let the write through. A first call reads A (warming the cache);
   * after the switch nothing moves the transport state before the plan reads
   * "me", so a cached read would still say A and a fresh one finds C.
   * - `expiry` (as for surrender): a linked direct session answers as A and the
   *   tab behind the bridge is C; the session then expires. The direct leg
   *   serves the same fake war.app (frames and pages) as the bridge.
   * - `tab`: no direct session; the tab itself signs in as C. Used for join,
   *   whose plan reads the open games page alongside "me": over an expired
   *   session that read moves the router, which would discard the cache anyway.
   */
  const C = '5598765499';
  const C_IN_GAME = 987654;

  async function switchingAccount(opts: { feed: unknown[]; pages?: Record<string, string>; via: 'expiry' | 'tab' }) {
    const dataDir = mkdtempSync(join(tmpdir(), 'warapp-mcp-identity-'));
    const pages: Record<string, string> = { ...opts.pages, [INVITE]: page(opts.via === 'tab' ? A : C) };
    const state = { expired: false };
    let ref: Harness | undefined;
    let invitesAsA = 0;
    let directFetch: DirectFetch | undefined;
    if (opts.via === 'expiry') {
      await writeSession({ authToken: 'test-auth-token', capturedAt: '2026-11-12T10:00:00.000Z', host: SESSION_HOST }, {
        MCP_DATA_DIR: dataDir,
      });
      directFetch = async (url, init) => {
        if (state.expired) return SIGNED_OUT;
        const r =
          url === INVITE
            ? { status: 200, body: page(A), url }
            : await ref!.bridge.server.request(init.method, url, {
                headers: init.headers,
                ...(init.body !== undefined ? { body: init.body } : {}),
              });
        if (url === INVITE) invitesAsA += 1;
        return { status: r.status, body: r.body, url: r.url ?? url };
      };
    }
    ref = await liveHarness({ dataDir, ...(directFetch ? { directFetch } : {}), pages, feed: opts.feed });
    const bridged = () => ref!.bridge.requests.filter((r) => r.path === INVITE).length;
    return {
      h: ref,
      /** InviteToken reads that answered A. */
      readsAsA: () => (opts.via === 'tab' ? bridged() : invitesAsA),
      switchAccount: () => {
        if (opts.via === 'tab') pages[INVITE] = page(C);
        else state.expired = true;
      },
    };
  }

  /** GameFeed game GAME_ID with A and an opponent seated (C is not). */
  function gameWithA(extra: Record<string, unknown> = {}, me: Record<string, string> = {}): Record<string, unknown> {
    const f = lobbyFixture();
    const template = (f.players as Array<Record<string, string>>)[0]!;
    return {
      ...f,
      id: String(GAME_ID),
      name: 'Synthetic Duel',
      state: 'Playing',
      numberOfTurns: '5',
      players: [
        { ...template, id: A, name: 'Alpha', state: 'Playing', hasCommittedOrders: 'False', ...me },
        { ...template, id: '1001', name: 'Opponent', state: 'Playing', hasCommittedOrders: 'False' },
      ],
      ...extra,
    };
  }

  const hexOf = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  /** An OpenGames page listing lobby 3001, which C has already joined (A has not). */
  function lobbyWithC(): string {
    const w = new Writer().int32(1);
    writeGameInfo(w, {
      id: 3001,
      name: 'Plain FFA',
      lastTurn: -1,
      state: 2,
      players: [
        { id: 111111, name: 'Host', state: 2, committed: false },
        { id: C_IN_GAME, name: 'Charlie', state: 2, committed: false },
      ],
      openSeats: [-1],
      maxPlayers: null,
    });
    return `<html><script type="text/plain" id="AllOpenGamesData">${hexOf(w.bytes())}</script></html>`;
  }

  const freshCases: Array<{
    tool: string;
    args: Record<string, unknown>;
    feed: unknown[];
    pages?: Record<string, string>;
    via?: 'expiry' | 'tab';
    /** What the second call says once the plan reads C. */
    refusal: RegExp;
  }> = [
    {
      tool: 'warapp_uncommit_turn',
      args: { game_id: GAME_ID },
      feed: [gameWithA({}, { hasCommittedOrders: 'True' })],
      refusal: /not a player in game/i,
    },
    {
      tool: 'warapp_begin_turn',
      args: { game_id: GAME_ID },
      feed: [gameWithA({ numberOfTurns: '0', settings: { ...(lobbyFixture().settings as object), MoveOrder: 'NoLuckCycle' } })],
      refusal: /not a player in game 4001/i,
    },
    {
      tool: 'warapp_join_game',
      args: { game_id: 3001 },
      feed: [{ ...lobbyFixture(), id: '3001', state: 'WaitingForPlayers' }],
      pages: { [OPEN_GAMES_URL]: lobbyWithC() },
      via: 'tab',
      refusal: /already joined/i,
    },
    {
      tool: 'warapp_submit_turn',
      args: { game_id: GAME_ID, orders: [{ kind: 'deploy', territory: 159, armies: 5 }] },
      feed: [gameWithA()],
      refusal: /signed-in war\.app account is not a player in game/i,
    },
    {
      // `player` omitted: "me" is resolved fresh, and C holds no seat.
      tool: 'warapp_submit_picks',
      args: { game_id: GAME_ID, territories: [1] },
      feed: [gameWithA({ state: 'DistributingTerritories', numberOfTurns: '-1' })],
      refusal: /signed-in war\.app account is not a player in game/i,
    },
    {
      // `player` named: the signed-in check itself is fresh.
      tool: 'warapp_submit_picks',
      args: { game_id: GAME_ID, player: 'Alpha', territories: [1] },
      feed: [gameWithA({ state: 'DistributingTerritories', numberOfTurns: '-1' })],
      refusal: /⟦Alpha⟧ is not the signed-in/i,
    },
  ];

  for (const c of freshCases) {
    it(`${c.tool}${'player' in c.args ? ' (player named)' : ''}: the plan re-reads the account, so an account that changed since is not still read as A`, async () => {
      const s = await switchingAccount({ feed: c.feed, via: c.via ?? 'expiry', ...(c.pages ? { pages: c.pages } : {}) });
      h = s.h;
      const first = await h.call(c.tool, c.args);
      // The first plan read A (and cached it), whatever it then decided.
      expect(s.readsAsA()).toBeGreaterThan(0);
      expect(textOf(first)).not.toMatch(c.refusal);
      s.switchAccount();
      const second = await h.call(c.tool, c.args);
      expect(second.isError, textOf(second)).toBe(true);
      expect(textOf(second)).toMatch(c.refusal);
    });
  }
});
