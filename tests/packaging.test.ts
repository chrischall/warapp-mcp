import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '@chrischall/mcp-utils/test';
import { registerAllTools } from '../src/tools/index.js';
import { PRESSURE_FACTOR } from '../src/analysis/planner.js';

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
  const WRITES = [
    'warapp_submit_picks',
    'warapp_submit_turn',
    'warapp_send_chat',
    'warapp_join_game',
    'warapp_surrender',
    'warapp_begin_turn',
    'warapp_uncommit_turn',
  ];
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
    const NOT_SUPPORTED = /(never submits (turn )?orders|nothing submits orders|turn orders[^.]*not supported|only two tools write|(two|three) tools write)/i;
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

describe('packaging for the smarter planner (phase 6)', () => {
  const doc = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const readme = doc('../README.md');
  const claude = doc('../CLAUDE.md');
  const skill = doc('../skills/warapp-mcp/SKILL.md');
  const api = doc('../docs/WARAPP-API.md');

  it('README and the skill explain the balanced plan, concessions, card advice and the trend', () => {
    for (const [file, text] of [['README.md', readme], ['skills/warapp-mcp/SKILL.md', skill]] as const) {
      for (const s of ['balanced', 'conceded', 'cardAdvice', 'trendSource', 'Order Priority']) expect(text, file).toContain(s);
    }
    // The skill says when to pick defend over the default.
    expect(skill).toMatch(/pick `?defend`? when/i);
  });

  it('CLAUDE.md summarizes the planner rules, concede/withdraw and the trend', () => {
    expect(claude).toMatch(/PLAN-PLANNER-2\.md/);
    for (const s of ['protected value', 'CONCEDE_FACTOR', 'withdraw', 'Order Priority', 'MIN_EXPANSION_SHARE', 'BREAK_WEIGHT', 'previousBoard'])
      expect(claude).toContain(s);
  });

  it('README states the fog pressure gate from PRESSURE_FACTOR, its margin and that it is all or nothing (#60)', () => {
    const flat = readme.replace(/\s+/g, ' ');
    expect(flat).toContain(`at most ${PRESSURE_FACTOR}× a typical neutral capture`);
    expect(flat).toMatch(/full estimated deploy plus a margin/);
    expect(flat).toMatch(/one visible territory too costly blocks the pressure on all of them/);
  });

  it('WARAPP-API.md marks GetHistory for a game in progress as unverified', () => {
    expect(api).toMatch(/GetHistory` for a game in progress — UNVERIFIED/);
  });
});

describe('packaging for open games (phase 10)', () => {
  const claude = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8');
  const protocol = readFileSync(new URL('../docs/WEB-PROTOCOL.md', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  it('CLAUDE.md says open games come from the page payload and joining is AcceptOpenSeat, confirm-gated', () => {
    const line = claude.split('\n').find((l) => l.includes('AllOpenGamesData')) ?? '';
    expect(line).toMatch(/\/MultiPlayer\/OpenGames/);
    expect(claude).toMatch(/AcceptOpenSeat/);
    expect(claude).toMatch(/warapp_join_game[^\n]*confirm|confirm[^\n]*warapp_join_game/i);
  });

  it('WEB-PROTOCOL.md documents the open-games payload and AcceptOpenSeat', () => {
    const section = protocol.slice(protocol.indexOf('## Open games'));
    expect(protocol.indexOf('## Open games')).toBeGreaterThan(-1);
    for (const s of ['AllOpenGamesData', 'warlight.shared.GameInfo', 'GameOpenSeat', 'AcceptOpenSeatReturn', 'prerequisites']) {
      expect(section, s).toContain(s);
    }
    for (const code of ['254', '473', '750']) expect(section, code).toContain(code);
    const methods = protocol.slice(protocol.indexOf('## Methods'), protocol.indexOf('## Replies'));
    for (const m of ['GetOpenGames', 'AcceptGame', 'AcceptOpenSeat', 'AcceptOpenAutoGame', 'GetOpenAutoGame', 'DeclineGame', 'GetGameSettings']) {
      expect(methods, m).toContain(m);
    }
  });

  it('README counts warapp_join_game among the confirm-gated writes', () => {
    expect(readme).toMatch(/confirmation-gated/);
    const gated = readme.slice(readme.indexOf('confirmation-gated') - 200, readme.indexOf('confirmation-gated'));
    expect(gated).toContain('warapp_join_game');
  });
});

describe('packaging for surrender (phase 11)', () => {
  const claude = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const skill = readFileSync(new URL('../skills/warapp-mcp/SKILL.md', import.meta.url), 'utf8');
  const protocol = readFileSync(new URL('../docs/WEB-PROTOCOL.md', import.meta.url), 'utf8');

  it('CLAUDE.md lists warapp_surrender among the confirm-gated write tools', () => {
    const bullet = claude.slice(claude.indexOf('tools write'), claude.indexOf('tools write') + 400);
    expect(bullet).toMatch(/confirm-gated/);
    expect(bullet).toContain('warapp_surrender');
  });

  it('README counts warapp_surrender among the confirm-gated writes and only-reads exceptions', () => {
    const gated = readme.slice(readme.indexOf('confirmation-gated') - 200, readme.indexOf('confirmation-gated'));
    expect(gated).toContain('warapp_surrender');
    const reads = readme.slice(readme.indexOf('Everything except'), readme.indexOf('only reads'));
    expect(reads).toContain('warapp_surrender');
  });

  it('the skill names warapp_surrender as a confirm-gated write in the change group', () => {
    const head = skill.slice(skill.indexOf('tools write'), skill.indexOf('tools write') + 300);
    expect(head).toContain('warapp_surrender');
    expect(skill).toMatch(/warapp_surrender[^\n]*\*\*change\*\*|\*\*change\*\*[^.]*warapp_surrender/s);
  });

  it('WEB-PROTOCOL.md documents Surrender (67): parameters, errors and the multi-player pending rule', () => {
    const methods = protocol.slice(protocol.indexOf('## Methods'), protocol.indexOf('## Replies'));
    expect(methods).toMatch(/\| 67 \| \*\*Surrender\*\*/);
    expect(methods).toMatch(/\| 68 \| AcceptSurrender/);
    const start = protocol.indexOf('## Surrender');
    expect(start).toBeGreaterThan(-1);
    const section = protocol.slice(start, protocol.indexOf('\n## ', start + 1));
    expect(section).toMatch(/verified/i);
    expect(section).toContain('m=Surrender&js=1');
    expect(section).toMatch(/int32[^\n]*game id/);
    for (const s of ['bool', 'vacation', 'false', 'AcceptSurrender', 'GameFeed']) expect(section, s).toContain(s);
    for (const code of ['**4**', '**7**', '**230**']) expect(section, code).toContain(code);
    expect(section).toMatch(/pending/i);
    expect(section).toMatch(/more than two players/);
  });
});

describe('packaging for the pick advisor (#36)', () => {
  const doc = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const readme = doc('../README.md');
  const claude = doc('../CLAUDE.md');
  const skill = doc('../skills/warapp-mcp/SKILL.md');

  it('docs/STRATEGY.md cites the community picking guides by URL and marks what is encoded', () => {
    const strategy = doc('../docs/STRATEGY.md');
    for (const url of [
      'https://war.app/Forum/434535-1v1-ladder-strategic-picking-guide',
      'https://war.app/Forum/811395-general-strategy-guidelines',
      'https://war.app/Forum/99097-good-1v1-strategies',
      'https://war.app/Forum/621189-ffa-strategy',
      'https://war.app/wiki/Combat_Basics',
      'https://war.app/wiki/Luck_Modifier',
    ])
      expect(strategy, url).toContain(url);
    expect(strategy).toMatch(/encoded/i);
    expect(strategy).toMatch(/not encoded/i);
    expect(strategy).toContain('src/analysis/picks.ts');
  });

  it('CLAUDE.md, README and the skill describe warapp_plan_picks as read-only, feeding warapp_submit_picks', () => {
    const bullet = claude.split('\n').find((l) => l.includes('warapp_plan_picks')) ?? '';
    expect(bullet).toMatch(/read-only/i);
    expect(claude).toContain('docs/STRATEGY.md');
    const row = readme.split('\n').find((l) => l.startsWith('| `warapp_plan_picks`')) ?? '';
    expect(row).toMatch(/Read-only/);
    expect(row).toContain('warapp_submit_picks');
    expect(skill).toMatch(/warapp_plan_picks[^\n]*warapp_submit_picks/);
  });
});

describe('packaging for the speed first turn (#44)', () => {
  const claude = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const skill = readFileSync(new URL('../skills/warapp-mcp/SKILL.md', import.meta.url), 'utf8');
  const protocol = readFileSync(new URL('../docs/WEB-PROTOCOL.md', import.meta.url), 'utf8');

  it('README and CLAUDE.md count warapp_begin_turn among the confirm-gated writes', () => {
    const gated = readme.slice(readme.indexOf('confirmation-gated') - 250, readme.indexOf('confirmation-gated'));
    expect(gated).toContain('warapp_begin_turn');
    const reads = readme.slice(readme.indexOf('Everything except'), readme.indexOf('only reads'));
    expect(reads).toContain('warapp_begin_turn');
    const bullet = claude.slice(claude.indexOf('tools write'), claude.indexOf('tools write') + 400);
    expect(bullet).toContain('warapp_begin_turn');
  });

  it('the skill names warapp_begin_turn in the change group and warns that Begin starts the timer', () => {
    const head = skill.slice(skill.indexOf('tools write'), skill.indexOf('tools write') + 300);
    expect(head).toContain('warapp_begin_turn');
    expect(skill).toMatch(/warapp_begin_turn[^\n]*\*\*change\*\*|\*\*change\*\*[^.]*warapp_begin_turn/s);
    expect(skill).toMatch(/Begin[^\n]*timer/);
  });

  it('WEB-PROTOCOL.md documents BeginFirstTurn (78) as read from the bundle, not verified live', () => {
    const methods = protocol.slice(protocol.indexOf('## Methods'), protocol.indexOf('## Replies'));
    expect(methods).toMatch(/\| 78 \| \*\*BeginFirstTurn\*\*/);
    const start = protocol.indexOf('## Begin first turn');
    expect(start).toBeGreaterThan(-1);
    const section = protocol.slice(start, protocol.indexOf('\n## ', start + 1));
    expect(section).toMatch(/not verified live/i);
    expect(section).toContain('m=BeginFirstTurn&js=1');
    expect(section).toMatch(/int32[^\n]*game id/);
    expect(section).toContain('NoLuckCycle');
    expect(section).toMatch(/timer/);
  });
});

describe('packaging for uncommit (#61)', () => {
  const doc = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const claude = doc('../CLAUDE.md');
  const readme = doc('../README.md');
  const skill = doc('../skills/warapp-mcp/SKILL.md');
  const protocol = doc('../docs/WEB-PROTOCOL.md');

  it('CLAUDE.md lists warapp_uncommit_turn among the confirm-gated write tools', () => {
    const bullet = claude.slice(claude.indexOf('tools write'), claude.indexOf('tools write') + 400);
    expect(bullet).toMatch(/confirm-gated/);
    expect(bullet).toContain('warapp_uncommit_turn');
  });

  it('README counts warapp_uncommit_turn among the confirm-gated writes and only-reads exceptions', () => {
    const gated = readme.slice(readme.indexOf('confirmation-gated') - 250, readme.indexOf('confirmation-gated'));
    expect(gated).toContain('warapp_uncommit_turn');
    const reads = readme.slice(readme.indexOf('Everything except'), readme.indexOf('only reads'));
    expect(reads).toContain('warapp_uncommit_turn');
  });

  it('the skill names warapp_uncommit_turn as a confirm-gated write in the change group', () => {
    const head = skill.slice(skill.indexOf('tools write'), skill.indexOf('tools write') + 300);
    expect(head).toContain('warapp_uncommit_turn');
    expect(skill).toMatch(/warapp_uncommit_turn[^\n]*\*\*change\*\*|\*\*change\*\*[^.]*warapp_uncommit_turn/s);
  });

  it('WEB-PROTOCOL.md documents UnCommit (80) as verified from the bundle, not live', () => {
    const methods = protocol.slice(protocol.indexOf('## Methods'), protocol.indexOf('## Replies'));
    expect(methods).toMatch(/\| 80 \| \*\*UnCommit\*\*/);
    const start = protocol.indexOf('## UnCommit');
    expect(start).toBeGreaterThan(-1);
    const section = protocol.slice(start, protocol.indexOf('\n## ', start + 1));
    expect(section).toContain('m=UnCommit&js=1');
    expect(section).toMatch(/int32[^\n]*game id/);
    expect(section).toMatch(/bundle/i);
    expect(section).toMatch(/not (yet )?(verified|captured) live/i);
    for (const code of ['**99**', '**4**', '**7**', '**230**']) expect(section, code).toContain(code);
    expect(section).toMatch(/hasCommittedOrders/);
  });
});

describe('packaging for map statistics (S6)', () => {
  const doc = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

  it('mint.yaml never turns map statistics on (they stay off when hosted)', () => {
    expect(doc('../mint.yaml')).not.toMatch(/WARAPP_STATS/);
  });

  it('README documents WARAPP_STATS as opt-in and local-only', () => {
    const row = doc('../README.md').split('\n').find((l) => l.startsWith('| `WARAPP_STATS`'));
    expect(row).toBeDefined();
    expect(row).toMatch(/local/i);
    expect(row).toMatch(/hosted/i);
  });

  it('WARAPP-API.md marks the game-ID feed unverified', () => {
    const api = doc('../docs/WARAPP-API.md');
    const start = api.indexOf('## Game-ID feed');
    expect(start).toBeGreaterThan(-1);
    const end = api.indexOf('\n## ', start + 1);
    const section = api.slice(start, end === -1 ? undefined : end);
    expect(section).toContain('/API/GameIDFeed');
    expect(section).toMatch(/UNVERIFIED/);
  });
});

describe('docs agree on the confirm-gated writes (#133)', () => {
  const doc = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  // The writes, counted from the code: every tool registered through `defineGatedWrite`.
  const toolsDir = new URL('../src/tools/', import.meta.url);
  const gated = readdirSync(toolsDir)
    .filter((f) => f.endsWith('.ts') && f !== 'write-kit.ts')
    .flatMap((f) => {
      const src = readFileSync(new URL(f, toolsDir), 'utf8');
      return [...src.matchAll(/defineGatedWrite\([\s\S]*?name: '(warapp_\w+)'/g)].map((m) => m[1]!);
    })
    .sort();
  const words = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
  // How the store-facing prose names each write.
  const plain: Record<string, RegExp> = {
    warapp_begin_turn: /\bbegin/i,
    warapp_join_game: /\bjoin/i,
    warapp_link_session: /\blink/i,
    warapp_send_chat: /\bchat/i,
    warapp_submit_picks: /\bpicks\b/i,
    warapp_submit_turn: /\bturn orders\b/i,
    warapp_surrender: /\bsurrender/i,
    warapp_uncommit_turn: /\bwithdraw/i,
  };
  const sentenceWith = (text: string, re: RegExp) => text.split(/(?<=[.:])\s+/).find((s) => re.test(s)) ?? '';

  it('finds the writes in the code, each with a plain-words name', () => {
    expect(gated.length).toBeGreaterThan(0);
    expect(Object.keys(plain).sort()).toEqual(gated);
  });

  it('CLAUDE.md and the skill give the count and name every write', () => {
    for (const [name, text] of [
      ['CLAUDE.md', doc('../CLAUDE.md')],
      ['SKILL.md', doc('../skills/warapp-mcp/SKILL.md')],
    ] as const) {
      const at = text.indexOf(`${words[gated.length]} tools write, all confirm-gated`);
      expect(at, name).toBeGreaterThan(-1);
      const list = text.slice(at, text.indexOf('.', text.indexOf('warapp_', at)) + 400);
      for (const tool of gated) expect(list, `${name}: ${tool}`).toContain(`\`${tool}\``);
    }
  });

  it('README lists every write as the only non-reads and as confirmation-gated', () => {
    const readme = doc('../README.md');
    const reads = readme.slice(readme.indexOf('Everything except'), readme.indexOf('only reads'));
    const gate = readme.slice(readme.indexOf('## Confirming writes'), readme.indexOf('are confirmation-gated'));
    for (const tool of gated) {
      expect(reads, tool).toContain(`\`${tool}\``);
      expect(gate, tool).toContain(`\`${tool}\``);
    }
  });

  it('the manifest, the marketplace entry and the server banner name every write as confirm-gated', () => {
    const manifest = (read('../manifest.json') as { description: string }).description;
    const market = (read('../.claude-plugin/marketplace.json') as { metadata: { description: string } }).metadata
      .description;
    const index = doc('../src/index.ts');
    const banner = index.slice(index.indexOf('banner:'), index.indexOf('});', index.indexOf('banner:')));
    for (const [name, text] of [
      ['manifest.json', manifest],
      ['marketplace.json', market],
      ['banner', banner],
    ] as const) {
      const sentence = sentenceWith(text, /confirm-gated/);
      for (const tool of gated) expect(sentence, `${name}: ${tool}`).toMatch(plain[tool]!);
    }
  });

  it('mint.yaml names every write a hosted server registers (warapp_link_session is local-only)', () => {
    const mint = doc('../mint.yaml');
    const summary = mint.slice(mint.indexOf('\nsummary:'), mint.indexOf('\nexamples:')).replace(/\s+/g, ' ');
    const sentence = sentenceWith(summary, /after you confirm/);
    for (const tool of gated.filter((t) => t !== 'warapp_link_session')) expect(sentence, tool).toMatch(plain[tool]!);
  });

  it('no doc still says the tracked income is a median (#100: the maximum)', () => {
    for (const p of ['../CLAUDE.md', '../skills/warapp-mcp/SKILL.md', '../README.md', '../docs/PLAN-STRATEGY.md']) {
      expect(doc(p), p).not.toMatch(/income estimate \(median/i);
    }
  });
});
