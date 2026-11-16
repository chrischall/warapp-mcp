// mcp-host's egress proxy (HTTPS_PROXY + NODE_USE_ENV_PROXY=1): global fetch honours it, a
// custom undici dispatcher does not, and a direct socket is silently dropped. The sign-in and
// the direct leg build their own dispatcher, so they must send through the proxy themselves.
// No socket is opened here: the proxy agent is a MockAgent (or a real ProxyAgent never used).
import { MockAgent, ProxyAgent, type Dispatcher } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';

const netguard = vi.hoisted(() => ({ created: 0, fetchPublicCalls: [] as { dispatcher?: unknown }[] }));
vi.mock('@chrischall/mcp-utils/netguard', async (importOriginal) => {
  const real = await importOriginal<typeof import('@chrischall/mcp-utils/netguard')>();
  return {
    ...real,
    createPublicOnlyDispatcher: (...args: Parameters<typeof real.createPublicOnlyDispatcher>) => {
      netguard.created++;
      return real.createPublicOnlyDispatcher(...args);
    },
    fetchPublic: (url: string, opts: Parameters<typeof real.fetchPublic>[1]) => {
      netguard.fetchPublicCalls.push({ dispatcher: opts?.dispatcher });
      return real.fetchPublic(url, opts);
    },
  };
});

const { egressDispatcher, egressProxyConfigured, EGRESS_PROXY_INVALID } = await import('../../src/direct/egress.js');
const { createSignInFetch, signIn, SIGN_IN_URL } = await import('../../src/direct/sign-in.js');
const { createDirectFetch } = await import('../../src/direct/transport.js');
const { pushWebSocketLeg } = await import('../../src/push/websocket.js');

const PROXY = 'http://127.0.0.1:18080';

afterEach(() => {
  netguard.created = 0;
  netguard.fetchPublicCalls.length = 0;
});

/** A MockAgent standing in for the proxy agent, recording that it was closed. */
function proxyStandIn() {
  const mock = new MockAgent();
  mock.disableNetConnect();
  let closed = false;
  const realClose = mock.close.bind(mock);
  mock.close = (async () => {
    closed = true;
    return realClose();
  }) as typeof mock.close;
  const made: URL[] = [];
  const make = (url: URL): Dispatcher => {
    made.push(url);
    return mock;
  };
  return { mock, make, made, closed: () => closed };
}

describe('egressDispatcher', () => {
  it('is undefined with no proxy configured', () => {
    expect(egressDispatcher({})).toBeUndefined();
    expect(egressProxyConfigured({})).toBe(false);
  });

  it('is a ProxyAgent for HTTPS_PROXY, and for https_proxy', async () => {
    for (const key of ['HTTPS_PROXY', 'https_proxy']) {
      const agent = egressDispatcher({ [key]: PROXY });
      expect(agent).toBeInstanceOf(ProxyAgent);
      await agent!.close();
      expect(egressProxyConfigured({ [key]: PROXY })).toBe(true);
    }
  });

  it('hands the parsed proxy URL to the agent factory', () => {
    const s = proxyStandIn();
    expect(egressDispatcher({ HTTPS_PROXY: PROXY }, s.make)).toBe(s.mock);
    expect(s.made.map((u) => u.href)).toEqual([`${PROXY}/`]);
  });

  it('refuses an invalid proxy URL clearly, never echoing it', () => {
    for (const bad of ['not a url', 'ftp://127.0.0.1:21', 'http://user:hunter22secret@']) {
      let err: unknown;
      try {
        egressDispatcher({ HTTPS_PROXY: bad });
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ message: expect.stringContaining(EGRESS_PROXY_INVALID) });
      expect(String((err as Error).message)).not.toContain('hunter22secret');
      expect(egressProxyConfigured({ HTTPS_PROXY: bad })).toBe(true);
    }
  });
});

describe('the sign-in through the egress proxy', () => {
  it('sends through the proxy agent when HTTPS_PROXY is set, and closes it', async () => {
    const s = proxyStandIn();
    s.mock.get('https://war.app').intercept({ path: '/LogIn', method: 'GET' }).reply(200, 'page');
    const fetch = createSignInFetch({ env: { HTTPS_PROXY: PROXY }, proxyAgent: s.make });
    const res = await fetch(SIGN_IN_URL, { method: 'GET', headers: {}, signal: new AbortController().signal });
    expect(res.body).toBe('page');
    expect(s.made).toHaveLength(1);
    expect(netguard.created).toBe(0);
    expect(s.closed()).toBe(true);
  });

  it('uses the public-only dispatcher without a proxy, as before', async () => {
    const fetch = createSignInFetch({ env: {} });
    await expect(fetch(SIGN_IN_URL, { method: 'GET', headers: {}, signal: AbortSignal.timeout(2000) })).rejects.toThrow();
    expect(netguard.created).toBe(1);
  });

  it('refuses an invalid proxy before anything is sent, saying why', async () => {
    const err = await signIn(
      { email: 'test@example.com', password: 'pw-not-real' },
      { env: { HTTPS_PROXY: 'not a url' } },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ message: expect.stringContaining(EGRESS_PROXY_INVALID) });
    expect(netguard.created).toBe(0);
  });

  it('keeps the transport refusal text when the proxy cannot be reached', async () => {
    const s = proxyStandIn(); // no intercept: the request fails inside the agent
    const err = await signIn(
      { email: 'test@example.com', password: 'pw-not-real' },
      { fetch: createSignInFetch({ env: { HTTPS_PROXY: PROXY }, proxyAgent: s.make }) },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ kind: 'transport', message: 'Could not reach war.app to sign in. Nothing was sent to war.app.' });
  });
});

describe('the direct leg through the egress proxy', () => {
  it('passes the proxy agent to fetchPublic when HTTPS_PROXY is set, and closes it', async () => {
    const s = proxyStandIn();
    s.mock.get('https://war.app').intercept({ path: '/MultiPlayer', method: 'GET' }).reply(200, 'ok');
    const fetch = createDirectFetch({ env: { HTTPS_PROXY: PROXY }, proxyAgent: s.make });
    const res = await fetch('https://war.app/MultiPlayer', { method: 'GET', headers: {} });
    expect(res).toMatchObject({ status: 200, body: 'ok' });
    expect(netguard.fetchPublicCalls).toEqual([{ dispatcher: s.mock }]);
    expect(s.closed()).toBe(true);
  });

  it('keeps the war.app-only host check with a proxy', async () => {
    const s = proxyStandIn();
    const fetch = createDirectFetch({ env: { HTTPS_PROXY: PROXY }, proxyAgent: s.make });
    await expect(fetch('https://example.invalid/', { method: 'GET', headers: {} })).rejects.toThrow();
  });

  it('lets netguard build its public-only dispatcher without a proxy, as before', async () => {
    const fetch = createDirectFetch({ env: {} });
    await expect(
      fetch('https://war.app/MultiPlayer', { method: 'GET', headers: {}, signal: AbortSignal.timeout(2000) }),
    ).rejects.toThrow();
    expect(netguard.fetchPublicCalls).toEqual([{ dispatcher: undefined }]);
  });

  it('refuses an invalid proxy URL clearly, never connecting directly', async () => {
    const fetch = createDirectFetch({ env: { HTTPS_PROXY: 'not a url' } });
    await expect(fetch('https://war.app/MultiPlayer', { method: 'GET', headers: {} })).rejects.toThrow(EGRESS_PROXY_INVALID);
    expect(netguard.fetchPublicCalls).toEqual([]);
  });
});

describe('the push WebSocket with an egress proxy', () => {
  const direct = { status: () => ({ transport: 'direct' as const }) };
  const noSession = async () => null;

  it('is not selected when a proxy is configured (xhr-polling over the router instead)', () => {
    expect(pushWebSocketLeg(direct, noSession, {}, { HTTPS_PROXY: PROXY }).select()).toBe(false);
    expect(pushWebSocketLeg(direct, noSession, {}, { HTTPS_PROXY: 'not a url' }).select()).toBe(false);
  });

  it('is selected on the direct leg with no proxy, as before', () => {
    expect(pushWebSocketLeg(direct, noSession, {}, {}).select()).toBe(true);
  });
});
