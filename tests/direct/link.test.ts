import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CaptureHeaderDecl } from '@chrischall/mcp-utils/fetchproxy';
import { SESSION_HOST, readSession, type Session } from '../../src/direct/session.js';
import { authTokenFromCookie, linkSession, NoAuthTokenError } from '../../src/direct/link.js';

// A FAKE token only — never a real war.app AuthToken (CLAUDE.md: no captures).
const FAKE_TOKEN = 'abc123';
// A synthetic captured Cookie header: the AuthToken wrapped by two other cookies.
const COOKIE = `FirstReferrer=x; AuthToken=${FAKE_TOKEN}; AWSELB=y`;

describe('authTokenFromCookie', () => {
  it('extracts the AuthToken value and ignores every other cookie', () => {
    expect(authTokenFromCookie(COOKIE)).toBe(FAKE_TOKEN);
  });

  it('returns null when no AuthToken cookie is present', () => {
    expect(authTokenFromCookie('FirstReferrer=x; AWSELB=y')).toBeNull();
  });

  it('returns null for an empty AuthToken value', () => {
    expect(authTokenFromCookie('AuthToken=; AWSELB=y')).toBeNull();
  });

  it('does not match a different cookie whose name ends in the token name', () => {
    // Only an exact `AuthToken` cookie counts, never `XAuthToken`.
    expect(authTokenFromCookie('XAuthToken=nope')).toBeNull();
  });
});

describe('linkSession', () => {
  it('parses the AuthToken out of the captured cookie, ignores the others, and stores it', async () => {
    let saved: Session | undefined;
    const now = new Date('2026-11-12T10:20:30.000Z');

    const result = await linkSession({
      capture: async () => COOKIE,
      save: async (s) => {
        saved = s;
      },
      now: () => now,
    });

    expect(saved).toEqual({ authToken: FAKE_TOKEN, capturedAt: now.toISOString(), host: SESSION_HOST });
    // The reported result carries only when/where — never the token value.
    expect(result).toEqual({ capturedAt: now.toISOString(), host: SESSION_HOST });
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });

  it('throws a typed NoAuthTokenError and stores nothing when the cookie has no AuthToken', async () => {
    const save = vi.fn(async () => {});
    await expect(
      linkSession({ capture: async () => 'FirstReferrer=x; AWSELB=y', save }),
    ).rejects.toBeInstanceOf(NoAuthTokenError);
    expect(save).not.toHaveBeenCalled();
  });

  it('scrubs the token and the whole captured cookie from a failure after the capture', async () => {
    const err = (await linkSession({
      capture: async () => COOKIE,
      save: async () => {
        throw new Error(`EACCES writing {"authToken":"${FAKE_TOKEN}"} from ${COOKIE}`);
      },
    }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('EACCES');
    expect(err.message).not.toContain(FAKE_TOKEN);
    expect(err.message).not.toContain('AWSELB=y');
    expect(String(err.stack)).not.toContain(FAKE_TOKEN);
  });

  it('captures the Cookie header on a war.app request through the bridge capture seam', async () => {
    const decls: CaptureHeaderDecl[] = [];
    let started = false;
    let closed = false;
    const createTransport = () => ({
      start: async () => {
        started = true;
      },
      close: async () => {
        closed = true;
      },
      server: {
        captureRequestHeader: async (decl: CaptureHeaderDecl & { timeoutMs?: number }) => {
          decls.push(decl);
          return COOKIE;
        },
      },
    });

    let saved: Session | undefined;
    // No explicit port / window: exercise the default WARAPP_WS_PORT + capture-window wiring.
    await linkSession({
      save: async (s) => {
        saved = s;
      },
      createTransport,
      env: { WARAPP_WS_PORT: '40000' } as NodeJS.ProcessEnv,
    });

    expect(started).toBe(true);
    expect(closed).toBe(true);
    expect(decls).toHaveLength(1);
    expect(decls[0]).toMatchObject({ host: SESSION_HOST, headerName: 'Cookie' });
    expect(saved?.authToken).toBe(FAKE_TOKEN);
  });

  it('writes a 0600 session file readable by readSession (default save)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-link-'));
    const file = join(dir, 'session.json');
    const env = { WARAPP_SESSION_FILE: file } as NodeJS.ProcessEnv;

    await linkSession({ capture: async () => COOKIE, env });

    const round = await readSession(env);
    expect(round).toMatchObject({ authToken: FAKE_TOKEN, host: SESSION_HOST });
  });
});
