import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpToolError } from '@chrischall/mcp-utils';
import type { FetchproxyFetchInit, FetchproxyFetchResult } from '@chrischall/mcp-utils/fetchproxy';
import { SESSION_HOST, type Session } from '../../src/direct/session.js';
import {
  createWarappBridge,
  DirectBridge,
  looksLikeHexFrame,
  looksSignedOut,
  SessionExpiredError,
  SessionNotLinkedError,
  toDirectResult,
  TRANSPORT_ENV,
  warappUrl,
  type DirectFetch,
  type DirectFetchResult,
  type SessionStore,
} from '../../src/direct/transport.js';

// A FAKE token only — never a real war.app AuthToken (see CLAUDE.md: no captures).
const FAKE_TOKEN = 'test-auth-token';
// A synthetic even-length hex reply frame, the shape war.app returns for a
// `/Services?js=1` POST. (Built here, never captured.)
const HEX_FRAME = '0a0b0c0d';
const BRIDGE_FRAME = 'deadbeef';

const session: Session = { authToken: FAKE_TOKEN, capturedAt: '2026-11-12T00:00:00.000Z', host: SESSION_HOST };
const linkedStore = (token = FAKE_TOKEN): SessionStore => ({
  read: async () => ({ ...session, authToken: token }),
});
const emptyStore: SessionStore = { read: async () => null };

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A stubbed direct leg: records every call, answers with `answer`. No network. */
function stubFetch(answer: DirectFetchResult | ((n: number) => DirectFetchResult)): {
  fn: DirectFetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fn: DirectFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return typeof answer === 'function' ? answer(calls.length) : answer;
  };
  return { fn, calls };
}

const servicesPost: FetchproxyFetchInit = {
  method: 'POST',
  path: 'https://war.app/Services?m=GetLatestGameInfo&js=1',
  headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  body: 'abcd',
};

describe('DirectBridge.fetch', () => {
  it('attaches the AuthToken cookie and maps the reply to the bridge shape', async () => {
    const stub = stubFetch({ status: 200, body: HEX_FRAME, url: 'https://war.app/Services' });
    const direct = new DirectBridge(linkedStore(), stub.fn);

    const res = await direct.fetch(servicesPost);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.url).toBe('https://war.app/Services?m=GetLatestGameInfo&js=1');
    expect(stub.calls[0]!.method).toBe('POST');
    expect(stub.calls[0]!.body).toBe('abcd');
    // The cookie carries the session; the caller's own headers are preserved.
    expect(stub.calls[0]!.headers.cookie).toBe(`AuthToken=${FAKE_TOKEN}`);
    expect(stub.calls[0]!.headers['content-type']).toContain('x-www-form-urlencoded');
    expect(res).toEqual({ status: 200, body: HEX_FRAME, url: 'https://war.app/Services' });
  });

  it('resolves a relative path against war.app', async () => {
    const stub = stubFetch({ status: 200, body: '<html>ok</html>', url: 'https://war.app/' });
    const direct = new DirectBridge(linkedStore(), stub.fn);
    await direct.fetch({ method: 'GET', path: '/' });
    expect(stub.calls[0]!.url).toBe('https://war.app/');
  });

  it('throws SessionNotLinkedError (no token leaked) when no session is linked', async () => {
    const stub = stubFetch({ status: 200, body: HEX_FRAME, url: 'https://war.app/Services' });
    const direct = new DirectBridge(emptyStore, stub.fn);
    await expect(direct.fetch(servicesPost)).rejects.toBeInstanceOf(SessionNotLinkedError);
    // The leg was never dialled.
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses to attach the token to any host but war.app', async () => {
    const stub = stubFetch({ status: 200, body: HEX_FRAME, url: 'https://evil.example.com/' });
    const direct = new DirectBridge(linkedStore(), stub.fn);
    await expect(direct.fetch({ method: 'GET', path: 'https://evil.example.com/steal' })).rejects.toBeInstanceOf(
      McpToolError,
    );
    expect(stub.calls).toHaveLength(0);
  });

  it('detects a sign-in redirect as an expired session', async () => {
    const stub = stubFetch({ status: 200, body: '<html>please sign in</html>', url: 'https://war.app/SignIn?r=%2F' });
    const direct = new DirectBridge(linkedStore(), stub.fn);
    await expect(direct.fetch({ method: 'GET', path: 'https://war.app/InviteToken' })).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it('detects a sign-in page body (a password field) as an expired session', async () => {
    const stub = stubFetch({
      status: 200,
      body: '<form><input type="password" name="pw"></form>',
      url: 'https://war.app/InviteToken',
    });
    const direct = new DirectBridge(linkedStore(), stub.fn);
    await expect(direct.fetch({ method: 'GET', path: 'https://war.app/InviteToken' })).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it('detects a /Services reply that is not a hex frame as an expired session', async () => {
    const stub = stubFetch({ status: 200, body: '<html>signed out</html>', url: 'https://war.app/Services' });
    const direct = new DirectBridge(linkedStore(), stub.fn);
    await expect(direct.fetch(servicesPost)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('accepts a GetMapDetails-style no-auth /Services call (a valid hex frame)', async () => {
    const stub = stubFetch({ status: 200, body: HEX_FRAME, url: 'https://war.app/Services' });
    const direct = new DirectBridge(linkedStore(), stub.fn);
    const res = await direct.fetch({ method: 'POST', path: 'https://war.app/Services?m=GetMapDetails&js=1', body: 'ff' });
    expect(res.body).toBe(HEX_FRAME);
    expect(stub.calls[0]!.headers.cookie).toBe(`AuthToken=${FAKE_TOKEN}`);
  });

  it('scrubs the token by value from an upstream error string', async () => {
    const direct = new DirectBridge(linkedStore(), async () => {
      throw new Error(`war.app refused Cookie: AuthToken=${FAKE_TOKEN}`);
    });
    const err = await direct.fetch(servicesPost).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(FAKE_TOKEN);
    expect((err as Error).message).toContain('war.app refused');
  });

  it('never names the token in the typed session errors', async () => {
    const notLinked = new SessionNotLinkedError();
    const expired = new SessionExpiredError();
    expect(JSON.stringify([notLinked.message, expired.message])).not.toContain(FAKE_TOKEN);
  });

  it('propagates a token-free upstream error unchanged', async () => {
    const boom = new Error('network is down');
    const direct = new DirectBridge(linkedStore(), async () => {
      throw boom;
    });
    await expect(direct.fetch(servicesPost)).rejects.toBe(boom);
  });
});

describe('direct-transport helpers', () => {
  it('maps a fetchPublic response (bytes → string) to the bridge shape', () => {
    const bytes = new TextEncoder().encode(HEX_FRAME);
    expect(toDirectResult({ status: 200, body: bytes, url: 'https://war.app/Services' })).toEqual({
      status: 200,
      body: HEX_FRAME,
      url: 'https://war.app/Services',
    });
  });

  it('warappUrl keeps war.app (and subdomains), refuses other hosts, http, and garbage', () => {
    expect(warappUrl('https://war.app/InviteToken')).toBe('https://war.app/InviteToken');
    expect(warappUrl('/Services?m=x&js=1')).toBe('https://war.app/Services?m=x&js=1');
    expect(warappUrl('Services')).toBe('https://war.app/Services');
    expect(warappUrl('https://api.war.app/x')).toBe('https://api.war.app/x');
    expect(() => warappUrl('https://evil.example.com/x')).toThrow(McpToolError);
    expect(() => warappUrl('http://war.app/x')).toThrow(/https/i);
    expect(() => warappUrl('https://[::bad')).toThrow(McpToolError);
  });

  it('looksLikeHexFrame accepts even-length hex only', () => {
    expect(looksLikeHexFrame(' 0a0b ')).toBe(true);
    expect(looksLikeHexFrame('0a0')).toBe(false);
    expect(looksLikeHexFrame('<html>')).toBe(false);
    expect(looksLikeHexFrame('')).toBe(false);
  });

  it('looksSignedOut tolerates unparseable urls and a healthy page', () => {
    expect(looksSignedOut('', { status: 200, body: HEX_FRAME, url: '' })).toBe(false);
    expect(looksSignedOut('https://war.app/InviteToken', { status: 200, body: 'Your invite token is 123', url: 'https://war.app/InviteToken' })).toBe(false);
  });
});

/** The bridge leg a fallback rides: records calls, exposes a health slice. */
function fakeFetchproxy(body = BRIDGE_FRAME) {
  const calls: FetchproxyFetchInit[] = [];
  const status = () => ({ role: 'primary' });
  const runProbe = vi.fn(async () => ({}));
  const transport = {
    async start() {},
    async close() {},
    role: null,
    status,
    runProbe,
    async fetch(init: FetchproxyFetchInit): Promise<FetchproxyFetchResult> {
      calls.push(init);
      return { status: 200, body, url: 'https://war.app/bridge' };
    },
  };
  // The lazy WarappBridge surface the router consumes: ready() + transport().
  const bridge = { transport: () => transport, ready: async () => transport };
  return { calls, bridge: bridge as never };
}

describe('createWarappBridge router', () => {
  afterEach(() => vi.restoreAllMocks());

  it('in auto mode, serves from the direct leg while the session is valid', async () => {
    const stub = stubFetch({ status: 200, body: HEX_FRAME, url: 'https://war.app/Services' });
    const fp = fakeFetchproxy();
    const bridge = createWarappBridge({
      store: linkedStore(),
      makeBridge: () => fp.bridge,
      mode: 'auto',
      directFetch: stub.fn,
    });
    const res = await (await bridge.ready()).fetch(servicesPost);
    expect(res.body).toBe(HEX_FRAME);
    expect(fp.calls).toHaveLength(0);
    expect(bridge.status().transport).toBe('direct');
    expect(bridge.stats().requests.direct).toBe(1);
    expect(bridge.sessionStale()).toBe(false);
  });

  it('in auto mode, a SessionExpiredError falls back to the bridge and marks the token stale', async () => {
    // Direct answers a signed-out page; the bridge answers the frame.
    const stub = stubFetch({ status: 200, body: '<html>signed out</html>', url: 'https://war.app/Services' });
    const fp = fakeFetchproxy();
    const log = vi.fn();
    const bridge = createWarappBridge({
      store: linkedStore(),
      makeBridge: () => fp.bridge,
      mode: 'auto',
      directFetch: stub.fn,
      log,
    });

    const res = await (await bridge.ready()).fetch(servicesPost);

    expect(res.body).toBe(BRIDGE_FRAME);
    expect(fp.calls).toHaveLength(1);
    expect(bridge.status().transport).toBe('fetchproxy');
    expect(bridge.sessionStale()).toBe(true);
    expect(bridge.stats().requests.fetchproxy).toBe(1);
    // A later call goes straight to the bridge — the dead token is not retried.
    await (await bridge.ready()).fetch(servicesPost);
    expect(stub.calls).toHaveLength(1);
    expect(fp.calls).toHaveLength(2);
    // The switch notice never prints the token.
    for (const [msg] of log.mock.calls) expect(String(msg)).not.toContain(FAKE_TOKEN);
  });

  it('in fetchproxy mode, never touches the direct leg', async () => {
    const stub = stubFetch({ status: 200, body: HEX_FRAME, url: 'https://war.app/Services' });
    const fp = fakeFetchproxy();
    const bridge = createWarappBridge({
      store: linkedStore(),
      makeBridge: () => fp.bridge,
      mode: 'fetchproxy',
      directFetch: stub.fn,
    });
    const res = await (await bridge.ready()).fetch(servicesPost);
    expect(res.body).toBe(BRIDGE_FRAME);
    expect(stub.calls).toHaveLength(0);
    expect(bridge.status().transport).toBe('fetchproxy');
    expect(bridge.sessionStale()).toBe(false);
  });

  it('in direct mode, a SessionExpiredError propagates and the bridge is never built', async () => {
    const stub = stubFetch({ status: 200, body: '<html>signed out</html>', url: 'https://war.app/Services' });
    const fp = fakeFetchproxy();
    const bridge = createWarappBridge({
      store: linkedStore(),
      makeBridge: () => fp.bridge,
      mode: 'direct',
      directFetch: stub.fn,
    });
    await expect((await bridge.ready()).fetch(servicesPost)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(fp.calls).toHaveLength(0);
    expect(bridge.status().transport).toBe('direct');
  });

  it('reads the mode from WARAPP_TRANSPORT when none is passed', async () => {
    const stub = stubFetch({ status: 200, body: HEX_FRAME, url: 'https://war.app/Services' });
    const fp = fakeFetchproxy();
    const bridge = createWarappBridge({
      store: linkedStore(),
      makeBridge: () => fp.bridge,
      directFetch: stub.fn,
      env: { [TRANSPORT_ENV]: 'fetchproxy' },
    });
    await (await bridge.ready()).fetch(servicesPost);
    expect(stub.calls).toHaveLength(0);
    expect(fp.calls).toHaveLength(1);
    expect(bridge.status().mode).toBe('fetchproxy');
  });

  it('exposes the bridge healthcheck slice once a bridge exists', async () => {
    const fp = fakeFetchproxy();
    const bridge = createWarappBridge({ store: linkedStore(), makeBridge: () => fp.bridge, mode: 'fetchproxy' });
    const slice = bridge.bridgeTransport();
    expect(slice).toBeDefined();
    expect(typeof slice!.status).toBe('function');
    expect(typeof slice!.runProbe).toBe('function');
  });
});
