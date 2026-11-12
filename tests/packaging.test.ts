import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '@chrischall/mcp-utils/test';
import { registerAllTools } from '../src/tools/index.js';

/**
 * Things that otherwise fail only once a tag exists: provenance needs
 * `repository.url`; a scoped name needs `publishConfig.access: public`; `files`
 * must ship the skills and mint.yaml (an npm-sourced mcp-host registration
 * reads the TARBALL); manifest.json's tool roster must match what the server
 * registers, or an mcpb host never shows the missing tool; every version file
 * release-please bumps must be registered in extra-files.
 */
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const pkg = read('../package.json') as {
  name: string;
  version: string;
  mcpName: string;
  repository: { url: string };
  publishConfig?: { access?: string };
  files: string[];
  bin: Record<string, string>;
  allowScripts?: Record<string, boolean>;
};

let registered: Array<{ name: string; description?: string }>;
let harness: TestHarness;
beforeAll(async () => {
  harness = await createTestHarness((s) => registerAllTools(s, { env: {} }));
  registered = (await harness.client.listTools()).tools;
});
afterAll(async () => {
  await harness?.close();
});

describe('packaging', () => {
  it('declares the repository for npm provenance', () => {
    expect(pkg.repository.url).toBe('git+https://github.com/chrischall/warapp-mcp.git');
  });

  it('is published under the @chrischall scope, publicly', () => {
    expect(pkg.name).toBe('@chrischall/warapp-mcp');
    expect(pkg.publishConfig?.access).toBe('public');
    expect(pkg.mcpName).toBe('io.github.chrischall/warapp-mcp');
  });

  it('ships the skills and mint.yaml in the npm tarball', () => {
    expect(pkg.files).toEqual(
      expect.arrayContaining(['dist', 'skills', 'mint.yaml', 'server.json', 'manifest.json', '.claude-plugin', '.mcp.json']),
    );
  });

  it('has a single bin pointing at the bundle', () => {
    expect(pkg.bin).toEqual({ 'warapp-mcp': 'dist/bundle.js' });
  });

  it('blocks install scripts it does not need', () => {
    expect(pkg.allowScripts).toEqual({ esbuild: false, fsevents: false });
  });

  it('manifest.json lists exactly the registered tools, each with a description', () => {
    const manifest = read('../manifest.json') as { tools: Array<{ name: string; description: string }> };
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(registered.map((t) => t.name).sort());
    expect(manifest.tools.filter((t) => !t.description.trim())).toEqual([]);
  });

  it('every registered tool has a description and the warapp_ prefix', () => {
    expect(registered.filter((t) => !t.description?.trim()).map((t) => t.name)).toEqual([]);
    expect(registered.filter((t) => !t.name.startsWith('warapp_')).map((t) => t.name)).toEqual([]);
  });

  it('server.json description fits the registry limit and names the scoped package', () => {
    const server = read('../server.json') as {
      name: string;
      description: string;
      packages: Array<{ identifier: string; version: string }>;
    };
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.name).toBe(pkg.mcpName);
    expect(server.packages.map((p) => p.identifier)).toEqual([pkg.name]);
  });

  it('every version file agrees with package.json', () => {
    const manifest = read('../manifest.json') as { version: string };
    const server = read('../server.json') as { version: string; packages: Array<{ version: string }> };
    const plugin = read('../.claude-plugin/plugin.json') as { version: string };
    const market = read('../.claude-plugin/marketplace.json') as {
      metadata: { version: string };
      plugins: Array<{ version: string }>;
    };
    const rpManifest = read('../.release-please-manifest.json') as Record<string, string>;
    const versions = [
      manifest.version,
      server.version,
      ...server.packages.map((p) => p.version),
      plugin.version,
      market.metadata.version,
      ...market.plugins.map((p) => p.version),
      rpManifest['.'],
    ];
    expect(new Set(versions)).toEqual(new Set([pkg.version]));
  });

  it('release-please bumps every version file', () => {
    const cfg = read('../release-please-config.json') as {
      packages: Record<
        string,
        {
          'package-name': string;
          'initial-version': string;
          'bump-minor-pre-major': boolean;
          'extra-files': Array<string | { path: string; jsonpath: string }>;
        }
      >;
    };
    const root = cfg.packages['.']!;
    expect(root['package-name']).toBe(pkg.name);
    expect(root['initial-version']).toBe('0.1.0');
    expect(root['bump-minor-pre-major']).toBe(true);
    const keys = root['extra-files'].map((f) => (typeof f === 'string' ? f : `${f.path}#${f.jsonpath}`));
    expect(keys).toEqual(
      expect.arrayContaining([
        'manifest.json#$.version',
        'server.json#$.version',
        'server.json#$.packages[*].version',
        '.claude-plugin/plugin.json#$.version',
        '.claude-plugin/marketplace.json#$.plugins[*].version',
        '.claude-plugin/marketplace.json#$.metadata.version',
        'src/version.ts',
      ]),
    );
  });

  it('.mcp.json launches the scoped package', () => {
    const mcp = read('../.mcp.json') as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(mcp.mcpServers.warapp).toEqual({ command: 'npx', args: ['-y', '@chrischall/warapp-mcp'] });
  });

  it('mint.yaml collects both credentials per user and allows only war.app egress', () => {
    const text = readFileSync(new URL('../mint.yaml', import.meta.url), 'utf8');
    expect(text).toMatch(/perUserChild: true/);
    expect(text).toMatch(/name: WARAPP_EMAIL/);
    expect(text).toMatch(/name: WARAPP_API_TOKEN/);
    const egress = text.slice(text.indexOf('\negress:'));
    const hosts = [...egress.matchAll(/^\s+-\s+([a-z0-9.-]+)\s*$/gm)].map((m) => m[1]);
    // war.app (GameFeed, and /Services through the user's tab) plus the CDN the
    // client bundle is downloaded from by Node itself (src/tools/live-context.ts).
    expect(hosts).toEqual(['war.app', 'warappcdn.com']);
  });
});

describe('packaging for the browser bridge (phase 2)', () => {
  const mint = readFileSync(new URL('../mint.yaml', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const claude = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8');
  const WRITES = ['warapp_submit_picks', 'warapp_submit_turn', 'warapp_send_chat'];
  const skill = readFileSync(new URL('../skills/warapp-mcp/SKILL.md', import.meta.url), 'utf8');

  it('mint.yaml persists a data dir and says why (bridge identity + bundle cache)', () => {
    const state = mint.slice(mint.indexOf('\nstate:'), mint.indexOf('\negress:'));
    expect(state).toMatch(/^\s+dataDir: true$/m);
    expect(state).toMatch(/reason:/);
    expect(state).toMatch(/fetchproxy/i);
    expect(state).toMatch(/bundle/i);
  });

  it('mint.yaml notes the registration fields hosting needs and declares the port env', () => {
    expect(mint).toMatch(/bridge: true/);
    expect(mint).toMatch(/bridgePortEnv: WARAPP_WS_PORT/);
    expect(mint).toMatch(/^\s+- name: WARAPP_WS_PORT$/m);
  });

  it('manifest.json and server.json expose WARAPP_WS_PORT as optional', () => {
    const manifest = read('../manifest.json') as {
      server: { mcp_config: { env: Record<string, string> } };
      user_config: Record<string, { required?: boolean }>;
    };
    const ref = manifest.server.mcp_config.env.WARAPP_WS_PORT;
    expect(ref).toMatch(/^\$\{user_config\.(\w+)\}$/);
    const key = /user_config\.(\w+)/.exec(ref!)![1]!;
    expect(manifest.user_config[key]?.required).toBe(false);

    const server = read('../server.json') as {
      packages: Array<{ environmentVariables: Array<{ name: string; isRequired: boolean }> }>;
    };
    const port = server.packages[0]!.environmentVariables.find((v) => v.name === 'WARAPP_WS_PORT');
    expect(port?.isRequired).toBe(false);
  });

  it('no packaging text still calls the server read-only', () => {
    const manifest = read('../manifest.json') as { description: string };
    const server = read('../server.json') as { description: string };
    for (const [file, text] of [
      ['manifest.json', manifest.description],
      ['server.json', server.description],
      ['package.json', (read('../package.json') as { description: string }).description],
      ['.claude-plugin/plugin.json', JSON.stringify(read('../.claude-plugin/plugin.json'))],
      ['.claude-plugin/marketplace.json', JSON.stringify(read('../.claude-plugin/marketplace.json'))],
      ['mint.yaml', mint],
      ['README.md', readme],
      ['CLAUDE.md', claude],
    ] as const) {
      expect(text, file).not.toMatch(/read-only (war\.app|advisor|mcp server)/i);
    }
  });

  it('README names every tool, the bridge requirement and how to pair', () => {
    expect(registered.map((t) => t.name).filter((n) => !readme.includes(n))).toEqual([]);
    expect(readme).toMatch(/ContextMint Bridge/);
    expect(readme).toMatch(/pair/i);
    expect(readme).toMatch(/WARAPP_WS_PORT/);
  });

  it('no doc still says turn orders cannot be submitted', () => {
    const NOT_SUPPORTED = /(never submits (turn )?orders|nothing submits orders|turn orders[^.]*not supported|only two tools write|two tools write)/i;
    for (const [file, text] of [
      ['README.md', readme],
      ['CLAUDE.md', claude],
      ['skills/warapp-mcp/SKILL.md', skill],
      ['mint.yaml', mint],
    ] as const) {
      expect(text, file).not.toMatch(NOT_SUPPORTED);
    }
  });

  it('the store-facing descriptions mention turn submission and the confirmation gate', () => {
    const manifest = read('../manifest.json') as { description: string };
    expect(manifest.description).toMatch(/turn/i);
    expect(manifest.description).toMatch(/confirm/i);
    const summary = mint.slice(mint.indexOf('\nsummary:'), mint.indexOf('\nexamples:'));
    expect(summary).toMatch(/turn/i);
    expect(summary).toMatch(/confirm/i);
  });

  it('README and the skill describe the plan → review → submit flow', () => {
    for (const [file, text] of [['README.md', readme], ['skills/warapp-mcp/SKILL.md', skill]] as const) {
      expect(text.indexOf('warapp_plan_turn'), file).toBeGreaterThan(-1);
      expect(text, file).toMatch(/review/i);
      for (const s of ['resolved', 'committed', 'unknown']) expect(text, file).toContain(s);
    }
  });

  it('CLAUDE.md says how a turn commit is confirmed (game state, never the reply bool)', () => {
    expect(claude).toMatch(/SendOrders/);
    expect(claude).toMatch(/numberOfTurns/);
    expect(claude).toMatch(/hasCommittedOrders/);
    expect(claude).toMatch(/vacation ended/i);
  });

  it('CLAUDE.md names the write tools and the bundle / capture rules', () => {
    for (const w of WRITES) expect(claude).toContain(w);
    expect(claude).toMatch(/confirm/i);
    expect(claude).toMatch(/ujs\.js/);
    expect(claude).toMatch(/captur/i);
  });
});

describe('packaging for my games and scouting (phase 4)', () => {
  const mint = readFileSync(new URL('../mint.yaml', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const claude = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8');
  const skill = readFileSync(new URL('../skills/warapp-mcp/SKILL.md', import.meta.url), 'utf8');
  const BRIDGED = ['warapp_my_games', 'warapp_scout_player'];

  it('CLAUDE.md names GetMyGames, the two scouting pages, the plan and the no-personal-fields rule', () => {
    expect(claude).toMatch(/GetMyGames/);
    expect(claude).toMatch(/\/Profile\?p=/);
    expect(claude).toMatch(/\/CommonGames\?p=/);
    expect(claude).toContain('docs/PLAN-SCOUT.md');
    expect(claude).toMatch(/location/i);
    expect(claude).toMatch(/allowlist/i);
  });

  it('README lists my games and scouting among the bridged tools, and the scout privacy rule', () => {
    const bridge = readme.slice(readme.indexOf('## The browser bridge'), readme.indexOf('### Pairing'));
    for (const t of BRIDGED) expect(bridge, t).toContain(t);
    expect(readme).toMatch(/never returns? (the player's )?location/i);
    const skills = readme.slice(readme.indexOf('## Skills'), readme.indexOf('## Development'));
    expect(skills).toMatch(/scout/i);
    expect(skills).toMatch(/fpx/);
  });

  it('the skill triggers on "which games need me" and scouting', () => {
    const description = skill.slice(0, skill.indexOf('\n---', 4));
    expect(description).toMatch(/which games need me/i);
    expect(description).toMatch(/scout/i);
  });

  it('the store-facing descriptions mention your games and scouting', () => {
    const manifest = read('../manifest.json') as { description: string };
    const summary = mint.slice(mint.indexOf('\nsummary:'), mint.indexOf('\nexamples:'));
    for (const [file, text] of [['manifest.json', manifest.description], ['mint.yaml summary', summary]] as const) {
      expect(text, file).toMatch(/scout/i);
      expect(text, file).toMatch(/waiting on you/i);
    }
  });

  it('mint.yaml keeps within the host\'s 5 examples and leads with the games waiting on you', () => {
    const examples = mint.slice(mint.indexOf('\nexamples:'), mint.indexOf('\nidentity:'));
    const prompts = [...examples.matchAll(/^ {2}- prompt: (.+)$/gm)].map((m) => m[1]!);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.length).toBeLessThanOrEqual(5);
    expect(prompts[0]).toMatch(/waiting on me/i);
    expect(prompts.some((p) => /scout/i.test(p))).toBe(true);
    expect(examples).not.toMatch(/note: .*location/i);
  });
});
