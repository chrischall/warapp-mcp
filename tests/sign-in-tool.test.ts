import { McpToolError } from '@chrischall/mcp-utils';
import { createTestHarness, type TestHarness } from '@chrischall/mcp-utils/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOSTED_MARKERS } from '../src/hosted.js';
import { registerAllTools } from '../src/tools/index.js';
import { textOf } from './helpers.js';

// warapp_sign_in (#333 part B): the capture of mcp-host's hosted sign-in flow.
// SYNTHETIC credentials only; the sign-in itself is a seam (tests/direct/sign-in.test.ts covers it).
const EMAIL = 'test@example.com';
const PASSWORD = 'synthetic-password-1';
const FAKE_TOKEN = 'synthetic-auth-token-0123456789';
const hostedEnv = { [HOSTED_MARKERS[0]]: 'x' };

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(
  env: Record<string, string>,
  signIn = vi.fn(async (_creds: { email: string; password: string }, _opts: { signal?: AbortSignal }) => ({ authToken: FAKE_TOKEN })),
) {
  harness = await createTestHarness((s) => registerAllTools(s, { env, signIn }));
  return { harness, signIn };
}

describe('warapp_sign_in', () => {
  it('is registered only on a hosted child: locally warapp_link_session stays the way', async () => {
    const local = await start({});
    const names = (await local.harness.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('warapp_sign_in');
    expect(names).toContain('warapp_link_session');
    await local.harness.close();
    const hosted = await start(hostedEnv);
    const hostedNames = (await hosted.harness.client.listTools()).tools.map((t) => t.name);
    expect(hostedNames).toContain('warapp_sign_in');
    expect(hostedNames).not.toContain('warapp_link_session');
  });

  it('takes exactly the email and password, and is annotated as a non-read-only, non-idempotent sign-in', async () => {
    const { harness: h } = await start(hostedEnv);
    const tool = (await h.client.listTools()).tools.find((t) => t.name === 'warapp_sign_in')!;
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(['email', 'password']);
    expect([...(tool.inputSchema.required ?? [])].sort()).toEqual(['email', 'password']);
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(tool.description).toMatch(/sign-in flow only/);
    expect(tool.description).toMatch(/never stored/);
  });

  it('returns only { authToken }, a top-level key mcp-host’s capture reads', async () => {
    const { harness: h, signIn } = await start(hostedEnv);
    const res = await h.client.callTool({ name: 'warapp_sign_in', arguments: { email: EMAIL, password: PASSWORD } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({ authToken: FAKE_TOKEN });
    expect(textOf(res)).not.toContain(EMAIL);
    expect(textOf(res)).not.toContain(PASSWORD);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn.mock.calls[0]![0]).toEqual({ email: EMAIL, password: PASSWORD });
  });

  it('a refusal is an isError carrying the refusal’s text, called once', async () => {
    const signIn = vi.fn(async (_creds: { email: string; password: string }, _opts: { signal?: AbortSignal }): Promise<{ authToken: string }> => {
      throw new McpToolError('war.app refused the sign-in: the email or password is not right.', { kind: 'credential_rejected' });
    });
    const { harness: h } = await start(hostedEnv, signIn);
    const res = await h.client.callTool({ name: 'warapp_sign_in', arguments: { email: EMAIL, password: PASSWORD } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/email or password is not right/);
    expect(textOf(res)).not.toContain(PASSWORD);
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it('refuses a missing password without signing in', async () => {
    const { harness: h, signIn } = await start(hostedEnv);
    const res = await h.client.callTool({ name: 'warapp_sign_in', arguments: { email: EMAIL } });
    expect(res.isError).toBe(true);
    expect(signIn).not.toHaveBeenCalled();
  });
});
