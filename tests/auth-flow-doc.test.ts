import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '@chrischall/mcp-utils/test';
import { registerAllTools } from '../src/tools/index.js';
import { HOST_TOKEN_ENV } from '../src/direct/session.js';
import { claudeMd } from './helpers/claude-md.js';

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
    for (const step of FLOW.steps) {
      const tool = hostedTools.find((t) => t.name === step.tool);
      expect(tool, step.tool).toBeDefined();
      // An argument the tool does not take, or one it requires and is not sent, is an
      // isError — which mcp-host reads as a refused credential, ending the login.
      expect(tool!.inputSchema.required ?? []).toEqual([]);
      expect(Object.keys(step.args ?? {})).toEqual([]);
    }
  });

  it('the capture tool is registered on a hosted child and takes exactly the args the flow sends', () => {
    const tool = hostedTools.find((t) => t.name === FLOW.capture!.tool) as
      | { inputSchema: { required?: string[]; properties?: Record<string, unknown> } }
      | undefined;
    expect(tool).toBeDefined();
    const sent = Object.keys(FLOW.capture!.args ?? {}).sort();
    expect([...(tool!.inputSchema.required ?? [])].sort()).toEqual(sent);
    expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual(sent);
  });

  it('mint.yaml declares the password flow by path, inside auth, now that warapp_sign_in is registered (part B)', () => {
    expect(hostedTools.some((t) => t.name === 'warapp_sign_in')).toBe(true);
    const auth = mint.slice(mint.indexOf('\nauth:'), mint.indexOf('\nenv:'));
    // mcp-host reads a string `auth.flow` as a path inside the package (flowPath):
    // plain relative segments, fetched at the registration's pin.
    const flows = [...auth.matchAll(/^ {2}flow: (\S+)$/gm)].map((m) => m[1]);
    expect(flows).toEqual(['docs/examples/warapp-auth-flow.json']);
    expect(mint.match(/^\s+flow(Path)?:/gm)).toHaveLength(1);
    // An npm-sourced registration reads it from the published tarball (jsDelivr at the pin).
    const pkg = JSON.parse(read('../package.json')) as { files: string[] };
    expect(pkg.files).toContain('docs/examples/warapp-auth-flow.json');
    expect(mint).toMatch(/WARAPP_AUTH_TOKEN/);
  });

  it('the password help says, in so many words, it is used once to sign in and never stored', () => {
    const [password] = FLOW.steps.flatMap((s) => s.prompt ?? []);
    expect(password!.help).toMatch(/^Used once to sign in, never stored\b/);
  });
});

describe('no paste-the-cookie flow until warapp_sign_in takes a cookie', () => {
  // warapp_sign_in takes only `email` and `password` (both required): a flow that captured
  // with `{ auth_token }` would get a schema isError, which mcp-host reads as a refused
  // credential — the login ends and the collected credentials are deleted. So no document,
  // hint or manifest offers one until that mode is built and its capture args are tested here.
  it('ships no paste flow document and mint.yaml offers none', () => {
    expect(existsSync(new URL('../docs/examples/warapp-auth-flow-paste.json', import.meta.url))).toBe(false);
    expect(mint).not.toMatch(/auth-flow-paste|paste-the-cookie/);
  });

  it('the capture tool takes no cookie argument', () => {
    const tool = hostedTools.find((t) => t.name === 'warapp_sign_in') as
      | { inputSchema: { properties?: Record<string, unknown> } }
      | undefined;
    expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual(['email', 'password']);
  });
});

describe('hiding warapp_sign_in with enabledTools is an owner choice whose costs the docs state', () => {
  // mcp-host's `enabledTools` gate is fail-closed: once set, resources/list and prompts/list
  // come back empty and resources/read is refused, and a tool a later release adds stays hidden
  // until the list is edited by hand. This server registers resources hosted, so hiding the
  // sign-in tool that way costs them; the docs must say so rather than present it as free.
  const planDirect = read('../docs/PLAN-DIRECT.md');
  const registration = planDirect.slice(planDirect.indexOf('### Registration change'));
  const step3 = registration.slice(registration.indexOf('\n3. '), registration.indexOf('\n4. '));
  const claude = claudeMd();
  const bullet = claude.slice(claude.indexOf('**`warapp_sign_in` (part B'), claude.indexOf('- **End of game (#178).**'));
  const signInHeader = read('../src/tools/sign-in.ts').split('\nimport ')[0]!;

  it('a hosted child does register resources, so the cost is real', async () => {
    const { resources } = await harness.client.listResources();
    expect(resources.map((r) => r.uri)).toContain('warapp://strategy');
  });

  it('PLAN-DIRECT step 3 is optional and names both costs', () => {
    expect(step3).toMatch(/optional/i);
    expect(step3).toMatch(/warapp:\/\/strategy/);
    expect(step3).toMatch(/resources/i);
    expect(step3).toMatch(/later release/i);
  });

  it('the CLAUDE.md bullet and the tool header no longer say the registration should hide it', () => {
    for (const text of [bullet, signInHeader]) {
      expect(text).not.toMatch(/registration should hide it/);
      expect(text).toMatch(/resources/);
      expect(text).toMatch(/later release/);
    }
  });
});

describe('the docs state that the flow makes a password sign-in mandatory for a new connection', () => {
  // Once the registration carries the authFlow, mcp-host ends a login with no grant when the
  // capture is an isError (login-flow.ts, authorize.ts): every refusal kind, not only a wrong
  // password. So a new connection needs one successful war.app password sign-in, and the bridge
  // is a fallback only for connections made before the flow and for a session that expires later.
  const planDirect = read('../docs/PLAN-DIRECT.md');
  const registration = planDirect.slice(planDirect.indexOf('### Registration change'));
  const step2 = registration.slice(registration.indexOf('\n2. '), registration.indexOf('\n3. '));
  const readme = read('../README.md');
  const hostedReadme = readme.slice(readme.indexOf('**Hosted (mcp-host).**'), readme.indexOf('## Tools'));
  const claude = claudeMd();
  const claudeHosted = claude.slice(claude.indexOf('**Hosted, the direct leg serves only'), claude.indexOf('- **End of game (#178).**'));

  it('no doc says a bot check or a connection that never signed in falls back to the bridge', () => {
    for (const text of [planDirect, readme, claude, mint]) {
      expect(text).not.toMatch(/leaves the connection on the\s+browser bridge/);
      expect(text).not.toMatch(/a connection that has not signed in yet\)/);
      expect(text).not.toMatch(/a connection that has not signed in since it was added, uses the browser bridge/);
    }
  });

  it('PLAN-DIRECT puts the trade-off in front of the step that adds the flow, as the owner\'s decision', () => {
    const decision = step2.slice(0, step2.indexOf('mcp-host set'));
    expect(decision).toMatch(/owner's decision/i);
    expect(decision).toMatch(/successful war\.app\s+password sign-in/);
    expect(decision).toMatch(/edge_blocked/);
    expect(decision).toMatch(/clear/);
  });

  it('the README, CLAUDE.md and mint.yaml each state it', () => {
    for (const text of [hostedReadme, claudeHosted, mint]) {
      expect(text).toMatch(/successful\s+(?:#\s+)?war\.app\s+(?:#\s+)?password\s+(?:#\s+)?sign-in/);
    }
  });
});
