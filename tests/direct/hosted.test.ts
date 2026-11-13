import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSession, readSessionSync, SESSION_HOST, sessionFilePath, writeSession } from '../../src/direct/session.js';
import { createDirectFirstBridge } from '../../src/direct/transport.js';
import { HOSTED_MARKERS, isHosted } from '../../src/hosted.js';
import * as stats from '../../src/stats.js';
import type { WarappBridge } from '../../src/transport-bridge.js';

// Direct mode is local-only, enforced in code: on a hosted child the session
// store reads as empty and refuses writes, and the router is pinned to the
// browser bridge whatever WARAPP_TRANSPORT says. A FAKE token only.
const FAKE_TOKEN = 'test-hosted-auth-token';
const session = { authToken: FAKE_TOKEN, capturedAt: '2026-11-12T10:00:00.000Z', host: SESSION_HOST } as const;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'warapp-hosted-'));
  await writeSession(session, { MCP_DATA_DIR: dir });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('stats re-exports the shared hosted check', () => {
  expect(stats.isHosted).toBe(isHosted);
  expect(stats.HOSTED_MARKERS).toBe(HOSTED_MARKERS);
});

for (const marker of HOSTED_MARKERS) {
  describe(marker, () => {
    const hosted = () => ({ MCP_DATA_DIR: dir, [marker]: 'x' });

    it('reads an existing session file as empty', async () => {
      expect(await readSession({ MCP_DATA_DIR: dir })).not.toBeNull();
      expect(await readSession(hosted())).toBeNull();
      expect(readSessionSync(hosted())).toBeNull();
    });

    it('refuses to store a session on the host', async () => {
      const other = join(dir, 'other.json');
      await expect(writeSession(session, { ...hosted(), WARAPP_SESSION_FILE: other })).rejects.toThrow(/local-only/);
      expect(existsSync(other)).toBe(false);
      expect(existsSync(sessionFilePath({ MCP_DATA_DIR: dir }))).toBe(true);
    });

    it('pins the router to the bridge even with WARAPP_TRANSPORT=direct and a store that has a session', async () => {
      const directFetch = vi.fn(async (url: string) => ({ status: 200, body: 'x', url }));
      const bridgeFetch = vi.fn(async () => ({ status: 200, body: 'ok', url: 'https://war.app/InviteToken' }));
      const log = vi.fn();
      const router = createDirectFirstBridge({
        store: { read: async () => session },
        makeBridge: () =>
          ({ ready: async () => ({ fetch: bridgeFetch }), transport: () => ({}) }) as unknown as WarappBridge,
        env: { ...hosted(), WARAPP_TRANSPORT: 'direct' },
        directFetch,
        log,
      });
      expect(router.status().transport).toBe('fetchproxy');
      await (await router.ready()).fetch({ method: 'GET', path: 'https://war.app/InviteToken' });
      expect(directFetch).not.toHaveBeenCalled();
      expect(bridgeFetch).toHaveBeenCalledTimes(1);
      expect(router.status().transport).toBe('fetchproxy');
      router.sessionLinked();
      expect(router.status().transport).toBe('fetchproxy');
      expect(JSON.stringify(log.mock.calls)).not.toContain('warapp_link_session');
    });
  });
}
