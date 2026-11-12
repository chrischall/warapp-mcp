import { afterEach, describe, expect, it } from 'vitest';
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
