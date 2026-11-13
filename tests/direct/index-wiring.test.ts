import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_HOST, writeSession } from '../../src/direct/session.js';
import { HOSTED_MARKERS } from '../../src/hosted.js';
import type { Writer } from '../../src/protocol/codec.js';
import { Method } from '../../src/protocol/methods.js';
import { liveHarness, payload, type Harness } from '../helpers.js';
import { writeMyGamesReturn, type SyntheticGame } from '../protocol/my-games-bundle.js';

/**
 * M4 index wiring: registerAllTools builds the direct-first bridge from the
 * session store + the fetchproxy bridge and shares that ONE bridge across the
 * live tools, the push socket and the session tools. These assert the session
 * tools observe the real router — not a stub — by watching the active leg flip
 * after a live call falls back (no session is linked in the harness's temp dir,
 * so the direct leg throws SessionNotLinkedError and the router switches to the
 * browser bridge for the rest of the process).
 */

const ME = { token: '4412345677', inGame: 123456 };
const SIGNED_IN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ME.token}</p>` };
const GAMES: SyntheticGame[] = [
  {
    id: 1001,
    name: 'My move',
    lastTurn: 1,
    state: 3,
    players: [{ id: ME.inGame, name: 'Ann', state: 2, committed: false }],
  },
];

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

describe('warapp_session_status is wired to the shared direct-first bridge', () => {
  it('reports the direct leg and no linked session before any bridged call', async () => {
    h = await liveHarness();
    const p = payload<{ linked: boolean; activeTransport: string; hint?: string }>(await h.call('warapp_session_status'));
    expect(p.linked).toBe(false);
    expect(p.activeTransport).toBe('direct');
    expect(String(p.hint)).toContain('warapp_link_session');
  });

  it('flips to the browser bridge after a live call falls back (the same bridge the tools use)', async () => {
    h = await liveHarness({
      pages: SIGNED_IN,
      warapp: (req) => {
        if (req.method !== Method.GetMyGames) throw new Error(`unexpected method ${req.method}`);
        return { body: (w: Writer) => writeMyGamesReturn(w, GAMES) };
      },
    });
    // A live tool: the direct leg throws SessionNotLinkedError (no session in
    // the temp data dir), the router falls back to the mock browser bridge.
    const games = payload<{ data?: unknown }>(await h.call('warapp_my_games'));
    expect(games).toBeTruthy();
    // The session tool sees the SAME router: it is now on the fetchproxy leg.
    const p = payload<{ linked: boolean; activeTransport: string }>(await h.call('warapp_session_status'));
    expect(p.activeTransport).toBe('fetchproxy');
    expect(p.linked).toBe(false);
  });
});

/**
 * Direct mode is local-only, enforced in code (src/hosted.ts): on a hosted
 * child (any HOSTED_MARKERS variable set) the link tool is not served, the
 * session store reads as empty — a session file already in the data dir is
 * never read — the router is pinned to the browser bridge whatever
 * WARAPP_TRANSPORT says, and no hint points at linking a session.
 */
describe('hosted: the direct transport is never used', () => {
  const FAKE_TOKEN = 'test-hosted-auth-token';
  const LINK = 'warapp_link_session';

  async function withSessionFile(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-hosted-'));
    // Written as a local process would (no marker), before the hosted child starts.
    await writeSession({ authToken: FAKE_TOKEN, capturedAt: '2026-11-12T10:00:00.000Z', host: SESSION_HOST }, {
      MCP_DATA_DIR: dir,
    });
    return dir;
  }

  for (const marker of HOSTED_MARKERS) {
    describe(marker, () => {
      it('does not list the link tool, and no tool description points at it', async () => {
        h = await liveHarness({ env: { [marker]: 'x' } });
        const tools = (await h.harness.client.listTools()).tools;
        expect(tools.map((t) => t.name)).not.toContain(LINK);
        expect(tools.map((t) => t.name)).toContain('warapp_session_status');
        expect(JSON.stringify(tools)).not.toContain(LINK);
      });

      it('rides the bridge with a session file present and WARAPP_TRANSPORT=direct; nothing goes direct', async () => {
        const dataDir = await withSessionFile();
        const directFetch = vi.fn(async (url: string) => ({ status: 200, body: '', url }));
        h = await liveHarness({
          dataDir,
          env: { [marker]: 'x', WARAPP_TRANSPORT: 'direct' },
          directFetch,
          pages: SIGNED_IN,
          warapp: (req) => {
            if (req.method !== Method.GetMyGames) throw new Error(`unexpected method ${req.method}`);
            return { body: (w: Writer) => writeMyGamesReturn(w, GAMES) };
          },
        });
        const games = await h.call('warapp_my_games');
        expect(games.isError).toBeFalsy();
        const res = await h.call('warapp_session_status');
        const p = payload<Record<string, unknown>>(res);
        expect(p).toMatchObject({ hosted: true, linked: false, activeTransport: 'fetchproxy' });
        expect(JSON.stringify(res)).not.toContain(LINK);
        expect(JSON.stringify(res)).not.toContain(FAKE_TOKEN);
        const health = await h.call('warapp_healthcheck');
        expect(JSON.stringify(health)).not.toContain(FAKE_TOKEN);
        expect(directFetch).not.toHaveBeenCalled();
        expect(h.bridge.requests.length).toBeGreaterThan(0);
      });

      it('leaves linking a session out of every failure hint', async () => {
        h = await liveHarness({ env: { [marker]: 'x' } });
        for (const [tool, args] of [
          ['warapp_list_open_games', {}],
          ['warapp_begin_turn', { game_id: 1001 }],
          ['warapp_surrender', { game_id: 1001 }],
          ['warapp_uncommit_turn', { game_id: 1001 }],
        ] as const) {
          const res = await h.call(tool, args);
          expect(res.isError, tool).toBe(true);
          expect(JSON.stringify(res), tool).not.toContain(LINK);
        }
      });
    });
  }

  it('without a marker, the same session file and WARAPP_TRANSPORT=direct use the direct leg (control)', async () => {
    const dataDir = await withSessionFile();
    const directFetch = vi.fn(async (url: string) => ({ status: 200, body: '<p>open games</p>', url }));
    h = await liveHarness({ dataDir, env: { WARAPP_TRANSPORT: 'direct' }, directFetch });
    expect((await h.harness.client.listTools()).tools.map((t) => t.name)).toContain(LINK);
    const p = payload<Record<string, unknown>>(await h.call('warapp_session_status'));
    expect(p).toMatchObject({ linked: true, activeTransport: 'direct' });
    expect(p.hosted).toBeUndefined();
    await h.call('warapp_list_open_games');
    expect(directFetch).toHaveBeenCalled();
  });
});
