// A suspected sign-out is confirmed before the direct leg is walled, war.app's
// real sign-out answer (AuthFailed, server error 3) is recognised, and a hosted
// child retries the direct leg after a backoff instead of never.
//
// Live facts these rest on (2026-11-17, read-only probes, no credential used):
//  - `/Services` with no AuthToken, or a bogus one, answers 200 with a VALID reply
//    frame carrying server error 3 (the client's `AuthFailed`), not a non-frame body.
//  - `GET /InviteToken` signed in answers 200 "Your invite token is N"; signed out
//    it answers 302 to `/LogIn?AuthNeeded=true&ReturnURL=%2FInviteToken`.
//  - A signed-out `/MultiPlayer` answers 200 with no password field and no
//    redirect, so a page alone rarely shows a sign-out.
import { describe, expect, it, vi } from 'vitest';
import type { FetchproxyFetchInit, FetchproxyFetchResult } from '@chrischall/mcp-utils/fetchproxy';
import { encodeReply, toHex } from '../../src/protocol/codec.js';
import { HOST_TOKEN_ENV, SESSION_HOST, type Session } from '../../src/direct/session.js';
import { HOSTED_MARKERS } from '../../src/hosted.js';
import {
  AUTH_FAILED_CODE,
  createDirectFirstBridge,
  DirectBridge,
  isAuthFailedReply,
  SessionExpiredError,
  SIGNED_IN_PROBE_URL,
  signInVerdict,
  toDirectResult,
  WALL_RETRY_BASE_MS,
  WALL_RETRY_MAX_MS,
  type DirectFetch,
  type DirectFetchResult,
  type SessionStore,
} from '../../src/direct/transport.js';
import type { WarappBridge } from '../../src/transport-bridge.js';

// FAKE tokens only — never a real war.app AuthToken.
const FAKE_TOKEN = 'test-auth-token-0123456789';
const HOST_TOKEN = 'synthetic-host-captured-token-0123456789';
const marker = HOSTED_MARKERS[0];
const hostedEnv = () => ({ [marker]: 'x', [HOST_TOKEN_ENV]: HOST_TOKEN }) as NodeJS.ProcessEnv;
const localEnv = {} as NodeJS.ProcessEnv;

const session: Session = { authToken: FAKE_TOKEN, capturedAt: '2026-11-12T00:00:00.000Z', host: SESSION_HOST };
const linkedStore: SessionStore = { read: async () => session };

const OK_FRAME = toHex(encodeReply({ method: 50, msgNum: 1 }));
const AUTH_FAILED_FRAME = toHex(encodeReply({ method: 50, msgNum: 1, error: { code: 3, message: '' } }));
const OTHER_ERROR_FRAME = toHex(encodeReply({ method: 50, msgNum: 1, error: { code: 11, message: 'x' } }));
const BRIDGE_FRAME = 'deadbeef';

const servicesPost: FetchproxyFetchInit = {
  method: 'POST',
  path: 'https://war.app/Services?m=GetMyGames&js=1',
  headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  body: 'abcd',
};
const servicesUrl = 'https://war.app/Services?m=GetMyGames&js=1';

const SIGNED_IN_PAGE: DirectFetchResult = {
  status: 200,
  body: '<p>Your invite token is 12345678901</p>',
  url: SIGNED_IN_PROBE_URL,
};
const SIGNED_OUT_PAGE: DirectFetchResult = {
  status: 200,
  body: '<form id="LoginForm"><input type="password" name="Password"></form>',
  url: 'https://war.app/LogIn?AuthNeeded=true&ReturnURL=%2FInviteToken',
};

/** A direct leg answering the probe with `probe` and everything else with `reply` (read per call). */
function routed(state: { reply: DirectFetchResult; probe: DirectFetchResult | Error }) {
  const calls: Array<{ url: string; method: string; cookie: string | undefined }> = [];
  const fn: DirectFetch = async (url, init) => {
    calls.push({ url, method: init.method, cookie: init.headers.cookie });
    if (url === SIGNED_IN_PROBE_URL && init.method === 'GET') {
      if (state.probe instanceof Error) throw state.probe;
      return state.probe;
    }
    return state.reply;
  };
  return { fn, calls };
}

function fakeBridge() {
  const calls: FetchproxyFetchInit[] = [];
  const bridge = {
    ready: async () => ({
      fetch: async (init: FetchproxyFetchInit): Promise<FetchproxyFetchResult> => {
        calls.push(init);
        return { status: 200, body: BRIDGE_FRAME, url: 'https://war.app/Services' };
      },
    }),
    transport: () => ({ role: null }),
  } as unknown as WarappBridge;
  return { bridge, calls };
}

describe('signInVerdict: what a GET of /InviteToken says about the session', () => {
  it('signed in: the page names the invite token', () => {
    expect(signInVerdict(SIGNED_IN_PAGE)).toBe('signed-in');
  });
  it('signed out: a redirect to the sign-in page, followed or not, or a sign-in form', () => {
    expect(signInVerdict(SIGNED_OUT_PAGE)).toBe('signed-out');
    expect(signInVerdict({ status: 200, body: '', url: 'https://war.app/LogIn?AuthNeeded=true' })).toBe('signed-out');
    expect(
      signInVerdict(toDirectResult({ stopped: true, url: 'https://war.app/LogIn?AuthNeeded=true', hops: 1 })),
    ).toBe('signed-out');
  });
  it('unknown: an error status or a page that says neither', () => {
    expect(signInVerdict({ status: 500, body: 'oops', url: SIGNED_IN_PROBE_URL })).toBe('unknown');
    expect(signInVerdict({ status: 200, body: '<p>maintenance</p>', url: SIGNED_IN_PROBE_URL })).toBe('unknown');
  });
});

describe('isAuthFailedReply: war.app’s own signed-out answer on /Services', () => {
  it('is server error 3 (AuthFailed) in a valid reply frame', () => {
    expect(AUTH_FAILED_CODE).toBe(3);
    expect(isAuthFailedReply(AUTH_FAILED_FRAME)).toBe(true);
  });
  it('is not any other reply, error or body', () => {
    expect(isAuthFailedReply(OK_FRAME)).toBe(false);
    expect(isAuthFailedReply(OTHER_ERROR_FRAME)).toBe(false);
    expect(isAuthFailedReply('<html>x</html>')).toBe(false);
    expect(isAuthFailedReply('abc')).toBe(false);
    expect(isAuthFailedReply('')).toBe(false);
  });
});

describe('DirectBridge confirms a suspected sign-out before calling it one', () => {
  it('an AuthFailed reply with the probe signed out is an expired session; the probe carries the cookie', async () => {
    const leg = routed({ reply: { status: 200, body: AUTH_FAILED_FRAME, url: servicesUrl }, probe: SIGNED_OUT_PAGE });
    const err = await new DirectBridge(linkedStore, leg.fn).fetch(servicesPost).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect(JSON.stringify([(err as Error).message, (err as { hint?: string }).hint])).not.toContain(FAKE_TOKEN);
    expect(leg.calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', servicesUrl],
      ['GET', SIGNED_IN_PROBE_URL],
    ]);
    expect(leg.calls[1]!.cookie).toBe(`AuthToken=${FAKE_TOKEN}`);
  });

  it('an AuthFailed reply with the probe signed in passes through (the call fails, the session is not walled)', async () => {
    const leg = routed({ reply: { status: 200, body: AUTH_FAILED_FRAME, url: servicesUrl }, probe: SIGNED_IN_PAGE });
    const res = await new DirectBridge(linkedStore, leg.fn).fetch(servicesPost);
    expect(res.body).toBe(AUTH_FAILED_FRAME);
  });

  it('a non-frame /Services reply, a 401 and a 403 pass through when the probe shows the session signed in', async () => {
    for (const reply of [
      { status: 200, body: '', url: servicesUrl },
      { status: 200, body: 'No post data', url: servicesUrl },
      { status: 401, body: 'Unauthorized', url: servicesUrl },
      { status: 403, body: '<html>Forbidden</html>', url: servicesUrl },
    ]) {
      const leg = routed({ reply, probe: SIGNED_IN_PAGE });
      const res = await new DirectBridge(linkedStore, leg.fn).fetch(servicesPost);
      expect(res).toEqual({ status: reply.status, body: reply.body, url: reply.url });
    }
  });

  it('a probe that cannot tell (it failed, or the page says neither) keeps the old reading: signed out', async () => {
    for (const probe of [new Error('socket hang up'), { status: 502, body: 'bad gateway', url: SIGNED_IN_PROBE_URL }]) {
      const leg = routed({ reply: { status: 200, body: '<html>?</html>', url: servicesUrl }, probe });
      await expect(new DirectBridge(linkedStore, leg.fn).fetch(servicesPost)).rejects.toBeInstanceOf(SessionExpiredError);
    }
  });

  it('a GET of /InviteToken is its own probe: no second request', async () => {
    const leg = routed({ reply: SIGNED_OUT_PAGE, probe: SIGNED_OUT_PAGE });
    await expect(
      new DirectBridge(linkedStore, leg.fn).fetch({ method: 'GET', path: SIGNED_IN_PROBE_URL }),
    ).rejects.toBeInstanceOf(SessionExpiredError);
    expect(leg.calls).toHaveLength(1);
  });

  it('a normal reply is never probed', async () => {
    const leg = routed({ reply: { status: 200, body: OK_FRAME, url: servicesUrl }, probe: SIGNED_OUT_PAGE });
    await new DirectBridge(linkedStore, leg.fn).fetch(servicesPost);
    expect(leg.calls).toHaveLength(1);
  });
});

describe('the hosted router retries the direct leg after a backoff', () => {
  function hostedRouter(state: { reply: DirectFetchResult; probe: DirectFetchResult | Error }, env = hostedEnv()) {
    let t = Date.parse('2026-11-17T00:00:00.000Z');
    const leg = routed(state);
    const fp = fakeBridge();
    const log = vi.fn();
    const router = createDirectFirstBridge({
      store: linkedStore,
      makeBridge: () => fp.bridge,
      env,
      mode: 'auto',
      directFetch: leg.fn,
      log,
      now: () => t,
    });
    const directPosts = () => leg.calls.filter((c) => c.method === 'POST').length;
    return { router, leg, fp, log, directPosts, advance: (ms: number) => (t += ms), at: () => t };
  }

  it('a signed-out wall lifts after the backoff; a direct success clears it', async () => {
    const state = { reply: { status: 200, body: AUTH_FAILED_FRAME, url: servicesUrl }, probe: SIGNED_OUT_PAGE as DirectFetchResult };
    const r = hostedRouter(state);
    const get: FetchproxyFetchInit = { method: 'GET', path: 'https://war.app/MultiPlayer' };
    state.reply = SIGNED_OUT_PAGE;
    await (await r.router.ready()).fetch(get);
    expect(r.router.status().transport).toBe('fetchproxy');
    const wall = r.router.wall();
    expect(wall).toMatchObject({ kind: 'session', since: new Date(r.at()).toISOString() });
    expect(wall?.retryAt).toBe(new Date(r.at() + WALL_RETRY_BASE_MS).toISOString());
    expect(JSON.stringify(wall)).not.toContain(HOST_TOKEN);

    // Before the backoff: the bridge serves, the direct leg is not asked.
    const before = r.leg.calls.length;
    r.advance(WALL_RETRY_BASE_MS - 1);
    await (await r.router.ready()).fetch(servicesPost);
    expect(r.leg.calls.length).toBe(before);

    // After it: the direct leg is asked again, and a success puts the router back on it.
    state.reply = { status: 200, body: OK_FRAME, url: servicesUrl };
    r.advance(1);
    const res = await (await r.router.ready()).fetch(servicesPost);
    expect(res.body).toBe(OK_FRAME);
    expect(r.router.status().transport).toBe('direct');
    expect(r.router.wall()).toBeNull();
    expect(r.router.sessionStale()).toBe(false);
  });

  it('each consecutive wall doubles the backoff, up to the cap', async () => {
    const state = { reply: SIGNED_OUT_PAGE, probe: SIGNED_OUT_PAGE as DirectFetchResult };
    const r = hostedRouter(state);
    const get: FetchproxyFetchInit = { method: 'GET', path: 'https://war.app/MultiPlayer' };
    let expected = WALL_RETRY_BASE_MS;
    for (let i = 0; i < 8; i++) {
      await (await r.router.ready()).fetch(get);
      const wall = r.router.wall()!;
      expect(Date.parse(wall.retryAt!) - Date.parse(wall.since)).toBe(expected);
      r.advance(expected);
      expected = Math.min(expected * 2, WALL_RETRY_MAX_MS);
    }
  });

  it('a write at retry time that reaches war.app signed out is still never re-sent over the bridge', async () => {
    const state = { reply: SIGNED_OUT_PAGE, probe: SIGNED_OUT_PAGE as DirectFetchResult };
    const r = hostedRouter(state);
    await (await r.router.ready()).fetch({ method: 'GET', path: 'https://war.app/MultiPlayer' });
    r.advance(WALL_RETRY_BASE_MS);
    state.reply = { status: 200, body: AUTH_FAILED_FRAME, url: servicesUrl };
    const bridgeBefore = r.fp.calls.length;
    const err = await (await r.router.ready()).fetch(servicesPost).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect((err as Error).message).toMatch(/not re-sent/i);
    expect(r.fp.calls.length).toBe(bridgeBefore);
    expect(r.directPosts()).toBe(1);
  });

  it('locally a session wall still waits for a relink: no time-based retry', async () => {
    const state = { reply: SIGNED_OUT_PAGE, probe: SIGNED_OUT_PAGE as DirectFetchResult };
    const r = hostedRouter(state, localEnv);
    await (await r.router.ready()).fetch({ method: 'GET', path: 'https://war.app/MultiPlayer' });
    expect(r.router.wall()).toMatchObject({ kind: 'session', retryAt: null });
    const before = r.leg.calls.length;
    r.advance(WALL_RETRY_MAX_MS * 4);
    await (await r.router.ready()).fetch(servicesPost);
    expect(r.leg.calls.length).toBe(before);
    expect(r.router.status().transport).toBe('fetchproxy');
  });

  it('checkSession: a signed-in probe lifts the wall at once; signed out marks it stale', async () => {
    const state = { reply: SIGNED_OUT_PAGE, probe: SIGNED_OUT_PAGE as DirectFetchResult };
    const r = hostedRouter(state);
    await (await r.router.ready()).fetch({ method: 'GET', path: 'https://war.app/MultiPlayer' });
    expect(await r.router.checkSession()).toBe('signed-out');
    expect(r.router.sessionStale()).toBe(true);
    expect(r.router.status().transport).toBe('fetchproxy');

    state.probe = SIGNED_IN_PAGE;
    expect(await r.router.checkSession()).toBe('signed-in');
    expect(r.router.status().transport).toBe('direct');
    expect(r.router.wall()).toBeNull();
    expect(r.router.sessionStale()).toBe(false);
  });

  it('checkSession without a session sends nothing', async () => {
    const leg = routed({ reply: SIGNED_IN_PAGE, probe: SIGNED_IN_PAGE });
    const router = createDirectFirstBridge({
      store: { read: async () => null },
      makeBridge: () => fakeBridge().bridge,
      env: localEnv,
      mode: 'auto',
      directFetch: leg.fn,
      log: () => {},
    });
    expect(await router.checkSession()).toBe('none');
    expect(leg.calls).toHaveLength(0);
  });
});
