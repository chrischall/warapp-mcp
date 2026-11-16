import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_TOKEN_ENV,
  hostedSession,
  hostedTokenState,
  readSession,
  readSessionSync,
  SESSION_HOST,
  sessionFilePath,
  writeSession,
} from '../../src/direct/session.js';
import { createDirectFirstBridge, SessionExpiredError, type DirectFetch } from '../../src/direct/transport.js';
import { HOSTED_MARKERS } from '../../src/hosted.js';
import type { Writer } from '../../src/protocol/codec.js';
import { Method } from '../../src/protocol/methods.js';
import type { WarappBridge } from '../../src/transport-bridge.js';
import { accountUnknown } from '../../src/tools/write-kit.js';
import { liveHarness, payload, type Harness } from '../helpers.js';
import { writeMyGamesReturn, type SyntheticGame } from '../protocol/my-games-bundle.js';

// Hosted direct mode (#333, part A): mcp-host captures war.app's AuthToken into
// WARAPP_AUTH_TOKEN; the hosted child rides the direct leg from it, in memory,
// with the bridge as its fallback. SYNTHETIC tokens only — never a real one.
const HOST_TOKEN = 'synthetic-host-captured-token-0123456789';
const FILE_TOKEN = 'synthetic-file-token-should-never-be-read';
const LINK = 'warapp_link_session';
const marker = HOSTED_MARKERS[0];
const hostedEnv = (extra: Record<string, string> = {}) => ({ [marker]: 'x', [HOST_TOKEN_ENV]: HOST_TOKEN, ...extra });

describe('hostedSession: the host-captured token, read from the env', () => {
  it('names the variable WARAPP_AUTH_TOKEN', () => {
    expect(HOST_TOKEN_ENV).toBe('WARAPP_AUTH_TOKEN');
  });

  it('gives an in-memory session marked as the host’s when hosted', () => {
    const s = hostedSession(hostedEnv());
    expect(s).toMatchObject({ authToken: HOST_TOKEN, host: SESSION_HOST, origin: 'host' });
    expect(hostedTokenState(hostedEnv())).toBe('ok');
  });

  it('trims whitespace and a leading AuthToken= the capture may carry', () => {
    expect(hostedSession(hostedEnv({ [HOST_TOKEN_ENV]: `  AuthToken=${HOST_TOKEN}\n` }))?.authToken).toBe(HOST_TOKEN);
  });

  it('is absent without the variable, and absent when not hosted', () => {
    expect(hostedSession({ [marker]: 'x' })).toBeNull();
    expect(hostedTokenState({ [marker]: 'x' })).toBe('none');
    expect(hostedSession({ [HOST_TOKEN_ENV]: HOST_TOKEN })).toBeNull();
  });

  for (const bad of ['short', 'has space inside it 12345', 'semi;colon-token-12345678', 'quote"token-1234567890', `x${'\u0001'}y-token-123456789`, 'a'.repeat(5000)]) {
    it(`refuses a malformed value (${JSON.stringify(bad.slice(0, 12))}…) without echoing it`, () => {
      expect(hostedSession(hostedEnv({ [HOST_TOKEN_ENV]: bad }))).toBeNull();
      expect(hostedTokenState(hostedEnv({ [HOST_TOKEN_ENV]: bad }))).toBe('malformed');
    });
  }
});

describe('the session store when hosted with a captured token', () => {
  it('reads the env token, never the session file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-hosted-direct-'));
    await writeSession({ authToken: FILE_TOKEN, capturedAt: '2026-11-12T10:00:00.000Z', host: SESSION_HOST }, { MCP_DATA_DIR: dir });
    const env = hostedEnv({ MCP_DATA_DIR: dir });
    expect((await readSession(env))?.authToken).toBe(HOST_TOKEN);
    expect(readSessionSync(env)?.authToken).toBe(HOST_TOKEN);
  });

  it('still refuses to write a session file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-hosted-direct-'));
    const env = hostedEnv({ MCP_DATA_DIR: dir });
    await expect(
      writeSession({ authToken: HOST_TOKEN, capturedAt: '2026-11-12T10:00:00.000Z', host: SESSION_HOST }, env),
    ).rejects.toThrow(/never stores/);
    expect(existsSync(sessionFilePath(env))).toBe(false);
  });

  it('locally the variable is ignored: only the session file counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-local-'));
    expect(await readSession({ MCP_DATA_DIR: dir, [HOST_TOKEN_ENV]: HOST_TOKEN })).toBeNull();
    await writeSession({ authToken: FILE_TOKEN, capturedAt: '2026-11-12T10:00:00.000Z', host: SESSION_HOST }, { MCP_DATA_DIR: dir });
    expect((await readSession({ MCP_DATA_DIR: dir, [HOST_TOKEN_ENV]: HOST_TOKEN }))?.authToken).toBe(FILE_TOKEN);
  });
});

const fakeBridge = (fetch: ReturnType<typeof vi.fn>) =>
  ({ ready: async () => ({ fetch }), transport: () => ({}) }) as unknown as WarappBridge;

describe('the router when hosted with a captured token', () => {
  it('rides the direct leg with the env token, never a stored session', async () => {
    const directFetch = vi.fn<DirectFetch>(async (url) => ({ status: 200, body: 'page', url }));
    const bridgeFetch = vi.fn();
    const router = createDirectFirstBridge({
      store: { read: async () => ({ authToken: FILE_TOKEN, capturedAt: '2026-11-12T10:00:00.000Z', host: SESSION_HOST }) },
      makeBridge: () => fakeBridge(bridgeFetch),
      env: hostedEnv(),
      directFetch,
      log: () => {},
    });
    expect(router.status().transport).toBe('direct');
    await (await router.ready()).fetch({ method: 'GET', path: '/InviteToken' });
    expect(directFetch).toHaveBeenCalledTimes(1);
    expect(directFetch.mock.calls[0]![1].headers.cookie).toBe(`AuthToken=${HOST_TOKEN}`);
    expect(bridgeFetch).not.toHaveBeenCalled();
  });

  it('falls back to the bridge when signed out, and says to Sign in on the connection, not to link', async () => {
    const directFetch = vi.fn<DirectFetch>(async () => ({ status: 200, body: '', url: 'https://war.app/LogIn' }));
    const bridgeFetch = vi.fn(async () => ({ status: 200, body: 'ok', url: 'https://war.app/InviteToken' }));
    const log = vi.fn();
    const router = createDirectFirstBridge({
      store: { read: async () => null },
      makeBridge: () => fakeBridge(bridgeFetch),
      env: hostedEnv(),
      directFetch,
      log,
    });
    await (await router.ready()).fetch({ method: 'GET', path: '/InviteToken' });
    expect(bridgeFetch).toHaveBeenCalledTimes(1);
    expect(router.status().transport).toBe('fetchproxy');
    expect(router.sessionStale()).toBe(true);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toMatch(/Sign in/);
    expect(logged).not.toContain(LINK);
    expect(logged).not.toContain(HOST_TOKEN);
  });

  it('never re-sends a write that reached war.app; the error says Sign in, never link, never a tab', async () => {
    const directFetch = vi.fn<DirectFetch>(async () => ({ status: 200, body: 'not a frame', url: 'https://war.app/Services?m=x' }));
    const bridgeFetch = vi.fn();
    const router = createDirectFirstBridge({
      store: { read: async () => null },
      makeBridge: () => fakeBridge(bridgeFetch),
      env: hostedEnv(),
      directFetch,
      log: () => {},
    });
    const err = await (await router.ready())
      .fetch({ method: 'POST', path: '/Services?m=x&js=1', body: 'abcd' })
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(SessionExpiredError);
    const msg = (err as Error).message;
    expect(msg).toMatch(/not re-sent/);
    expect(msg).toMatch(/Sign in/);
    expect(msg).not.toContain(LINK);
    expect(msg).not.toMatch(/\btab\b/);
    expect(bridgeFetch).not.toHaveBeenCalled();
  });

  it('scrubs the env token from an upstream error', async () => {
    const directFetch = vi.fn<DirectFetch>(async () => {
      throw new Error(`socket hang up sending Cookie: AuthToken=${HOST_TOKEN} (${encodeURIComponent(HOST_TOKEN)})`);
    });
    const router = createDirectFirstBridge({
      store: { read: async () => null },
      makeBridge: () => fakeBridge(vi.fn()),
      env: hostedEnv(),
      directFetch,
      log: () => {},
    });
    const err = await (await router.ready())
      .fetch({ method: 'GET', path: '/InviteToken' })
      .then(() => undefined, (e: unknown) => e);
    expect(JSON.stringify({ m: (err as Error).message, s: (err as Error).stack })).not.toContain(HOST_TOKEN);
  });

  it('without the variable, hosted stays pinned to the bridge (byte-identical to before)', async () => {
    const directFetch = vi.fn<DirectFetch>();
    const bridgeFetch = vi.fn(async () => ({ status: 200, body: 'ok', url: 'https://war.app/InviteToken' }));
    const router = createDirectFirstBridge({
      store: { read: async () => null },
      makeBridge: () => fakeBridge(bridgeFetch),
      env: { [marker]: 'x' },
      directFetch,
      log: () => {},
    });
    expect(router.status().transport).toBe('fetchproxy');
    await (await router.ready()).fetch({ method: 'GET', path: '/InviteToken' });
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('with a malformed variable, hosted stays pinned to the bridge', async () => {
    const directFetch = vi.fn<DirectFetch>();
    const router = createDirectFirstBridge({
      store: { read: async () => null },
      makeBridge: () => fakeBridge(vi.fn(async () => ({ status: 200, body: 'ok', url: 'https://war.app/' }))),
      env: hostedEnv({ [HOST_TOKEN_ENV]: 'bad token' }),
      directFetch,
      log: () => {},
    });
    expect(router.status().transport).toBe('fetchproxy');
  });
});

describe('accountUnknown on a host-signed-in connection', () => {
  it('points at Sign in on the connection, never a tab or the link tool', () => {
    const hint = accountUnknown({ hosted: true, hostSignIn: true }).hint ?? '';
    expect(hint).toMatch(/Sign in/);
    expect(hint).not.toMatch(/\btab\b/);
    expect(hint).not.toContain(LINK);
    expect(accountUnknown({ hosted: true }).hint).toBe(accountUnknown(true).hint);
  });
});

const ME = { token: '4412345677', inGame: 123456 };
const GAMES: SyntheticGame[] = [
  { id: 1001, name: 'My move', lastTurn: 1, state: 3, players: [{ id: ME.inGame, name: 'Ann', state: 2, committed: false }] },
];

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

describe('registerAllTools hosted with a captured token', () => {
  it('serves over the direct leg; status and healthcheck say host-captured, never the token or an age', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'warapp-hosted-direct-'));
    const directFetch = vi.fn<DirectFetch>(async (url) => ({ status: 200, body: '<p>open games</p>', url }));
    h = await liveHarness({ dataDir, env: hostedEnv(), directFetch });
    const tools = (await h.harness.client.listTools()).tools;
    expect(tools.map((t) => t.name)).not.toContain(LINK);
    expect(JSON.stringify(tools)).not.toContain(LINK);

    await h.call('warapp_list_open_games');
    expect(directFetch).toHaveBeenCalled();
    expect(directFetch.mock.calls[0]![1].headers.cookie).toBe(`AuthToken=${HOST_TOKEN}`);
    expect(h.bridge.requests.length).toBe(0);

    const res = await h.call('warapp_session_status');
    const p = payload<Record<string, unknown>>(res);
    expect(p).toMatchObject({ hosted: true, linked: 'host-captured', activeTransport: 'direct' });
    expect(p).not.toHaveProperty('capturedAt');
    expect(p).not.toHaveProperty('ageSeconds');
    expect(JSON.stringify(res)).not.toContain(HOST_TOKEN);
    expect(JSON.stringify(res)).not.toContain(LINK);

    const health = await h.call('warapp_healthcheck');
    expect(JSON.stringify(health)).not.toContain(HOST_TOKEN);
    expect(JSON.stringify(health)).toContain('host-captured');
    expect(JSON.stringify(health)).not.toContain('ageSeconds');

    // Nothing was written for the session: no session file in the data dir.
    expect(readdirSync(dataDir)).not.toContain('session.json');
  });

  it('after a sign-out, status says to Sign in on the connection', async () => {
    const directFetch = vi.fn<DirectFetch>(async () => ({ status: 200, body: '', url: 'https://war.app/LogIn' }));
    h = await liveHarness({
      env: hostedEnv(),
      directFetch,
      pages: { 'https://war.app/InviteToken': `<p>Your invite token is ${ME.token}</p>` },
      warapp: (req) => {
        if (req.method !== Method.GetMyGames) throw new Error(`unexpected method ${req.method}`);
        return { body: (w: Writer) => writeMyGamesReturn(w, GAMES) };
      },
    });
    await h.call('warapp_my_games');
    const res = await h.call('warapp_session_status');
    const p = payload<Record<string, unknown>>(res);
    expect(p).toMatchObject({ hosted: true, linked: 'host-captured', activeTransport: 'fetchproxy', sessionExpired: true });
    expect(String(p.hint)).toMatch(/Sign in/);
    expect(JSON.stringify(res)).not.toContain(LINK);
    expect(JSON.stringify(res)).not.toContain(HOST_TOKEN);
  });

  it('without the variable, hosted status is unchanged (bridge, not linked)', async () => {
    h = await liveHarness({ env: { [marker]: 'x' } });
    const p = payload<Record<string, unknown>>(await h.call('warapp_session_status'));
    expect(p).toMatchObject({ hosted: true, linked: false, activeTransport: 'fetchproxy' });
  });
});
