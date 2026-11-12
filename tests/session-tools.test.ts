import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHarness, parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { SESSION_HOST, type Session } from '../src/direct/session.js';
import { NoAuthTokenError } from '../src/direct/link.js';
import { registerSessionTools, type SessionToolsDeps } from '../src/tools/session.js';

// A FAKE token only — never a real war.app AuthToken (CLAUDE.md: no captures).
const FAKE_TOKEN = 'test-auth-token';
const CAPTURED_AT = '2026-11-12T10:00:00.000Z';
const session: Session = { authToken: FAKE_TOKEN, capturedAt: CAPTURED_AT, host: SESSION_HOST };

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function harnessWith(deps: Partial<SessionToolsDeps> = {}): Promise<TestHarness> {
  const full: SessionToolsDeps = {
    transport: { activeLeg: () => 'direct', sessionStale: () => false },
    read: async () => session,
    link: async () => ({ capturedAt: CAPTURED_AT, host: SESSION_HOST }),
    now: () => Date.parse('2026-11-12T10:01:00.000Z'),
    ...deps,
  };
  return createTestHarness((s) => registerSessionTools(s, full));
}

const payload = <T = Record<string, unknown>>(r: CallToolResult) => parseToolResult<T>(r);
const textOf = (r: CallToolResult) => (r.content as Array<{ text: string }>)[0]!.text;
const call = (name: string, args: Record<string, unknown> = {}) =>
  h!.client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

describe('warapp_session_status', () => {
  it('reports linked, when it was captured, its age and the active leg — never the token', async () => {
    h = await harnessWith();
    const res = await call('warapp_session_status');
    const p = payload(res);
    expect(p).toMatchObject({
      linked: true,
      host: SESSION_HOST,
      capturedAt: CAPTURED_AT,
      ageSeconds: 60,
      activeTransport: 'direct',
    });
    expect(textOf(res)).not.toContain(FAKE_TOKEN);
  });

  it('reports not-linked and points to warapp_link_session', async () => {
    h = await harnessWith({ read: async () => null });
    const p = payload(await call('warapp_session_status'));
    expect(p.linked).toBe(false);
    expect(p.activeTransport).toBe('direct');
    expect(String(p.hint)).toContain('warapp_link_session');
  });

  it('surfaces "session expired — run warapp_link_session" after a direct→bridge fallback', async () => {
    h = await harnessWith({
      transport: { activeLeg: () => 'fetchproxy', sessionStale: () => true },
    });
    const res = await call('warapp_session_status');
    const p = payload(res);
    expect(p.linked).toBe(true);
    expect(p.sessionExpired).toBe(true);
    expect(p.activeTransport).toBe('fetchproxy');
    expect(String(p.hint)).toContain('warapp_link_session');
    expect(textOf(res)).not.toContain(FAKE_TOKEN);
  });
});

describe('warapp_link_session', () => {
  it('is confirm-gated and reports only success, capturedAt and the active transport', async () => {
    const link = vi.fn(async () => ({ capturedAt: CAPTURED_AT, host: SESSION_HOST as typeof SESSION_HOST }));
    h = await harnessWith({ link });

    // Phase 1: a preview with a confirmToken; nothing captured yet.
    const preview = payload(await call('warapp_link_session'));
    expect(preview.confirmToken).toEqual(expect.any(String));
    expect(link).not.toHaveBeenCalled();
    expect(JSON.stringify(preview)).not.toContain(FAKE_TOKEN);

    // Phase 2: confirmed — the capture runs.
    const res = await call('warapp_link_session', { confirmToken: preview.confirmToken as string });
    const p = payload(res);
    expect(link).toHaveBeenCalledTimes(1);
    expect(p).toMatchObject({ status: 'linked', capturedAt: CAPTURED_AT, host: SESSION_HOST, transport: 'direct' });
    expect(textOf(res)).not.toContain(FAKE_TOKEN);
  });

  it('surfaces a NoAuthTokenError from the capture without leaking anything', async () => {
    h = await harnessWith({
      link: async () => {
        throw new NoAuthTokenError();
      },
    });
    const preview = payload(await call('warapp_link_session'));
    const res = await call('warapp_link_session', { confirmToken: preview.confirmToken as string });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('AuthToken');
    expect(textOf(res)).not.toContain(FAKE_TOKEN);
  });
});
