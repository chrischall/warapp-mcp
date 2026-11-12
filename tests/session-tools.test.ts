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
    transport: { activeLeg: () => 'direct', sessionStale: () => false, sessionLinked: () => {} },
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

  it('reports the push transport once the push socket has run, and omits it before', async () => {
    h = await harnessWith({ pushTransport: () => 'websocket' });
    expect(payload(await call('warapp_session_status')).pushTransport).toBe('websocket');
    await h.close();
    h = await harnessWith({ read: async () => null, pushTransport: () => 'xhr-polling' });
    expect(payload(await call('warapp_session_status')).pushTransport).toBe('xhr-polling');
    await h.close();
    h = await harnessWith({ pushTransport: () => undefined });
    expect(payload(await call('warapp_session_status'))).not.toHaveProperty('pushTransport');
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
      transport: { activeLeg: () => 'fetchproxy', sessionStale: () => true, sessionLinked: () => {} },
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

  it('tells the transport a new session was linked, so a stale flag clears and direct is retried', async () => {
    let stale = true;
    let leg: 'direct' | 'fetchproxy' = 'fetchproxy';
    const sessionLinked = vi.fn(() => {
      stale = false;
      leg = 'direct';
    });
    h = await harnessWith({ transport: { activeLeg: () => leg, sessionStale: () => stale, sessionLinked } });
    const preview = payload(await call('warapp_link_session'));
    const p = payload(await call('warapp_link_session', { confirmToken: preview.confirmToken as string }));
    expect(sessionLinked).toHaveBeenCalledTimes(1);
    expect(p.transport).toBe('direct');
    const status = payload(await call('warapp_session_status'));
    expect(status.sessionExpired).toBeUndefined();
  });

  it('does not reset the transport when the link fails', async () => {
    const sessionLinked = vi.fn();
    h = await harnessWith({
      transport: { activeLeg: () => 'fetchproxy', sessionStale: () => true, sessionLinked },
      link: async () => {
        throw new NoAuthTokenError();
      },
    });
    const preview = payload(await call('warapp_link_session'));
    await call('warapp_link_session', { confirmToken: preview.confirmToken as string });
    expect(sessionLinked).not.toHaveBeenCalled();
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
