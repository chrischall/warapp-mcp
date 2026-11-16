import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '@chrischall/mcp-utils/test';
import { registerAllTools } from '../src/tools/index.js';
import { HOST_TOKEN_ENV } from '../src/direct/session.js';

/**
 * The mcp-host `authFlow` documents for hosted direct mode (#333), checked here
 * against mcp-host's own rules as far as they can be checked offline
 * (packages/core/src/auth-flow.ts: `authFlowSchema` + `requireAuthFlowSupport`,
 * docs/REGISTERING.md "authFlow"). mcp-host refuses a bad flow only when the
 * registration is written; a mistake found here instead costs a test run, not
 * a person's war.app sign-in attempt.
 */
type Arg = string | number | boolean | { from: string };
type Prompt = { name: string; label: string; type?: string; help?: string; options?: unknown[] };
type Step = {
  tool: string;
  args?: Record<string, Arg>;
  prompt?: Prompt[];
  carry?: string[];
  title?: string;
  description?: string;
  link?: unknown;
};
type Flow = { steps: Step[]; capture?: { tool: string; args?: Record<string, Arg>; path?: string; into: string } };

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const FLOW = JSON.parse(read('../docs/examples/warapp-auth-flow.json')) as Flow;
const PASTE = JSON.parse(read('../docs/examples/warapp-auth-flow-paste.json')) as Flow;
const mint = read('../mint.yaml');

/** The `auth.fields` names mint.yaml collects up front: in the value bag before step 1. */
const authFields = (() => {
  const auth = mint.slice(mint.indexOf('\nauth:'), mint.indexOf('\nenv:'));
  return [...auth.matchAll(/^\s+- name: ([A-Z0-9_]+)$/gm)].map((m) => m[1]!);
})();
/** The `env` names mint.yaml declares: set by the registration, so not a capture target. */
const envNames = (() => {
  const env = mint.slice(mint.indexOf('\nenv:'), mint.indexOf('\nstate:'));
  return [...env.matchAll(/^\s+- name: ([A-Z0-9_]+)$/gm)].map((m) => m[1]!);
})();

// mcp-host's RESERVED_AUTH_FIELD_NAMES and loader-env tier (packages/core/src/reserved-env.ts).
const HOST_SET = new Set([
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS',
  'MCP_BLOB_BASE_URL', 'MCP_BLOB_SIGNING_KEY', 'MCP_HOST_METER_FILE', 'MCP_DATA_DIR', 'MCP_HOST_CONFIRM_SECRET',
]);
const LOADER_PREFIXES = ['LD_', 'DYLD_', 'MALLOC_', 'BASH_FUNC_'];
const BAG_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const ALLOWED_STEP_KEYS = new Set(['tool', 'args', 'prompt', 'carry', 'title', 'description', 'link']);

/**
 * mcp-host's coherence check, mirrored: every `{from}` names something the
 * auth fields, an earlier carry or a prompt answered by then provides; no name
 * is prompted or carried twice; the capture never writes over an auth field,
 * a host-set variable or a loader variable. Returns the problems, empty when
 * the flow would be accepted.
 */
function problems(flow: Flow, fields: string[], hostEnv: string[]): string[] {
  const out: string[] = [];
  if (!Array.isArray(flow.steps) || flow.steps.length < 1 || flow.steps.length > 6) out.push('1–6 steps');
  for (const key of Object.keys(flow)) if (key !== 'steps' && key !== 'capture') out.push(`unknown key ${key}`);
  const scope = new Set(fields);
  const fromRef = (where: string, args: Record<string, Arg> | undefined) => {
    for (const [arg, value] of Object.entries(args ?? {})) {
      if (!BAG_NAME.test(arg)) out.push(`${where}: bad arg name ${arg}`);
      if (typeof value === 'object' && !scope.has(value.from)) out.push(`${where}: ${arg} from unknown "${value.from}"`);
    }
  };
  flow.steps.forEach((step, i) => {
    const where = `step ${i + 1} (${step.tool})`;
    for (const key of Object.keys(step)) if (!ALLOWED_STEP_KEYS.has(key)) out.push(`${where}: unknown key ${key}`);
    if (!step.tool || step.tool.length > 128) out.push(`${where}: tool`);
    if ((step.title?.length ?? 1) > 120) out.push(`${where}: title over 120`);
    if ((step.description?.length ?? 0) > 600) out.push(`${where}: description over 600`);
    if ((step.prompt?.length ?? 0) > 4) out.push(`${where}: over 4 prompts`);
    if (step.link && !step.prompt?.length) out.push(`${where}: a link on a step that asks nothing`);
    for (const p of step.prompt ?? []) {
      if (!BAG_NAME.test(p.name)) out.push(`${where}: bad prompt name ${p.name}`);
      if (!p.label || p.label.length > 120) out.push(`${where}: prompt label`);
      if (p.type !== undefined && !['text', 'password', 'choice'].includes(p.type)) out.push(`${where}: prompt type`);
      if (p.type === 'choice' && !p.options?.length) out.push(`${where}: choice without options`);
      if ((p.help?.length ?? 0) > 300) out.push(`${where}: help over 300`);
      if (scope.has(p.name)) out.push(`${where}: prompts "${p.name}" already in scope`);
      scope.add(p.name);
    }
    fromRef(where, step.args);
    for (const name of step.carry ?? []) {
      if (scope.has(name)) out.push(`${where}: carries "${name}" already in scope`);
      scope.add(name);
    }
  });
  const capture = flow.capture;
  if (capture) {
    fromRef('capture', capture.args);
    if (capture.path !== undefined && !BAG_NAME.test(capture.path)) out.push('capture: bad path');
    if (!ENV_NAME.test(capture.into)) out.push('capture: into must be UPPER_SNAKE');
    if (HOST_SET.has(capture.into) || hostEnv.includes(capture.into)) out.push(`capture into host-set ${capture.into}`);
    if (LOADER_PREFIXES.some((p) => capture.into.startsWith(p))) out.push(`capture into loader ${capture.into}`);
    if (fields.includes(capture.into)) out.push(`capture over authField ${capture.into}`);
  }
  return out;
}

let hostedTools: Array<{ name: string; inputSchema: { required?: string[] } }>;
let harness: TestHarness;
beforeAll(async () => {
  // A hosted child: mcp-host's marker variables set, no captured token yet.
  harness = await createTestHarness((s) => registerAllTools(s, { env: { MCP_HOST_METER_FILE: '/tmp/meter' } }));
  hostedTools = (await harness.client.listTools()).tools as typeof hostedTools;
});
afterAll(async () => {
  await harness?.close();
});

describe('docs/examples/warapp-auth-flow.json (hosted direct mode, #333)', () => {
  it('is a flow mcp-host accepts against the fields mint.yaml collects', () => {
    expect(authFields).toEqual(['WARAPP_EMAIL', 'WARAPP_API_TOKEN']);
    expect(problems(FLOW, authFields, envNames)).toEqual([]);
  });

  it('the coherence mirror is live: it refuses the mistakes mcp-host refuses', () => {
    const bad = structuredClone(FLOW);
    bad.capture!.args!.password = { from: 'pasword' };
    expect(problems(bad, authFields, envNames)).toEqual(['capture: password from unknown "pasword"']);
    expect(problems({ ...FLOW, capture: { ...FLOW.capture!, into: 'WARAPP_API_TOKEN' } }, authFields, envNames)).toEqual([
      'capture over authField WARAPP_API_TOKEN',
    ]);
    expect(problems({ ...FLOW, capture: { ...FLOW.capture!, into: 'WARAPP_WS_PORT' } }, authFields, envNames)).toEqual([
      'capture into host-set WARAPP_WS_PORT',
    ]);
    expect(problems({ ...FLOW, capture: { ...FLOW.capture!, into: 'MCP_DATA_DIR' } }, authFields, envNames)).toEqual([
      'capture into host-set MCP_DATA_DIR',
    ]);
    // Without the auth fields the email reference has nothing to read.
    expect(problems(FLOW, [], envNames)).toEqual(['capture: email from unknown "WARAPP_EMAIL"']);
  });

  it('requires a child per caller (mcp-host refuses a flow without perUserChild)', () => {
    expect(mint).toMatch(/^identity:\n(?:\s+#.*\n)*\s+perUserChild: true$/m);
  });

  it('captures war.app’s AuthToken into the variable the hosted child reads, never a host-set one', () => {
    expect(FLOW.capture).toEqual({
      tool: 'warapp_sign_in',
      args: { email: { from: 'WARAPP_EMAIL' }, password: { from: 'password' } },
      path: 'authToken',
      into: HOST_TOKEN_ENV,
    });
    expect(HOST_TOKEN_ENV).toBe('WARAPP_AUTH_TOKEN');
    expect(envNames).not.toContain(HOST_TOKEN_ENV);
    expect(authFields).not.toContain(HOST_TOKEN_ENV);
  });

  it('asks for the password once, masked, and says it is used once and never stored', () => {
    const prompts = FLOW.steps.flatMap((s) => s.prompt ?? []);
    expect(prompts.map((p) => p.name)).toEqual(['password']);
    const [password] = prompts;
    expect(password!.type).toBe('password');
    expect(password!.help).toMatch(/used once/i);
    expect(password!.help).toMatch(/never stored/i);
    // The sign-in is the capture: one war.app attempt, and the token goes straight
    // to the sealed per-user secret instead of through the gateway-readable bag.
    expect(FLOW.steps.some((s) => s.tool === 'warapp_sign_in')).toBe(false);
    expect(FLOW.steps.flatMap((s) => s.carry ?? [])).toEqual([]);
  });

  it('every step tool exists on a hosted child and takes the args the flow sends', () => {
    for (const flow of [FLOW, PASTE]) {
      for (const step of flow.steps) {
        const tool = hostedTools.find((t) => t.name === step.tool);
        expect(tool, step.tool).toBeDefined();
        // An argument the tool does not take, or one it requires and is not sent, is an
        // isError — which mcp-host reads as a refused credential, ending the login.
        expect(tool!.inputSchema.required ?? []).toEqual([]);
        expect(Object.keys(step.args ?? {})).toEqual([]);
      }
    }
  });

  it('mint.yaml declares no flow until warapp_sign_in is registered (part B)', () => {
    const signIn = hostedTools.some((t) => t.name === 'warapp_sign_in');
    if (!signIn) expect(mint).not.toMatch(/^\s+flow(Path)?:/m);
    expect(mint).toMatch(/WARAPP_AUTH_TOKEN/);
    expect(mint).toMatch(/docs\/examples\/warapp-auth-flow\.json/);
  });
});

describe('docs/examples/warapp-auth-flow-paste.json (the captcha fallback)', () => {
  it('is a flow mcp-host accepts, asks for no password and captures the same variable', () => {
    expect(problems(PASTE, authFields, envNames)).toEqual([]);
    const prompts = PASTE.steps.flatMap((s) => s.prompt ?? []);
    expect(prompts.map((p) => [p.name, p.type])).toEqual([['cookie', 'password']]);
    expect(JSON.stringify(PASTE)).not.toMatch(/"password"\s*:\s*\{/);
    expect(PASTE.capture).toMatchObject({ tool: 'warapp_sign_in', path: 'authToken', into: HOST_TOKEN_ENV });
  });
});
