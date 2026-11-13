import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { registerAllTools } from '../src/tools/index.js';
import { EMAIL, TOKEN, lobbyFixture } from './helpers.js';

/**
 * The two skills shipped in the npm tarball (`files: skills`):
 * - skills/warapp-mcp — how to drive this server's tools;
 * - skills/warapp-api — curl + jq over GameFeed with a sourced helper script.
 *
 * The helper runs under BOTH bash and zsh against a local GameFeed stand-in
 * (real curl, real jq), and every recipe the skill documents is executed
 * against the anonymized lobby fixture in both shells.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKILLS = join(ROOT, 'skills');
const HELPER = join(SKILLS, 'warapp-api', 'scripts', 'warapp.sh');
const SCOUT = join(SKILLS, 'warapp-api', 'references', 'scout.mjs');
const FIXTURES = join(ROOT, 'tests', 'fixtures');
const read = (p: string) => readFileSync(p, 'utf8');
// zsh is not installed on the Ubuntu CI runner; the zsh run happens wherever it exists
// (every dev Mac). The static zsh-safety check below runs everywhere regardless.
const hasShell = (sh: string) => spawnSync(sh, ['-c', 'true']).status === 0;
const SHELLS = (['bash', 'zsh'] as const).filter((sh) => sh === 'bash' || hasShell(sh));
if (!SHELLS.includes('zsh' as never)) it.skip('zsh helper run (zsh is not installed here)', () => {});
const bashVersion = (sh: string) => spawnSync(sh, ['--version']).stdout?.toString().split('\n')[0];
const LOCALE_SHELLS: string[] = [
  ...SHELLS,
  ...(hasShell('/bin/bash') && bashVersion('/bin/bash') !== bashVersion('bash') ? ['/bin/bash'] : []),
];

function frontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return {};
  return Object.fromEntries(
    m[1]!.split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]),
  );
}

describe('skill files', () => {
  it('ships exactly the two skills, each with a name matching its folder and a description', () => {
    const dirs = readdirSync(SKILLS).sort();
    expect(dirs).toEqual(['warapp-api', 'warapp-mcp']);
    for (const d of dirs) {
      const fm = frontmatter(read(join(SKILLS, d, 'SKILL.md')));
      expect(fm.name, d).toBe(d);
      expect((fm.description ?? '').length, d).toBeGreaterThan(80);
      expect((fm.description ?? '').length, d).toBeLessThanOrEqual(1024);
    }
  });

  it('warapp-mcp names every served tool and has an "In context groups" section', async () => {
    const harness = await createTestHarness((s) => registerAllTools(s, { env: {} }));
    const names = (await harness.client.listTools()).tools.map((t) => t.name);
    await harness.close();
    const md = read(join(SKILLS, 'warapp-mcp', 'SKILL.md'));
    expect(names.filter((n) => !md.includes(n))).toEqual([]);
    expect(md).toMatch(/^## In context groups$/m);
  });

  it('the helper never names a shell variable `path` or `status` (zsh specials)', () => {
    const src = read(HELPER);
    expect(src).not.toMatch(/(^|[\s;(])(local\s+[^\n]*\b)?(path|status)=/m);
    expect(src).not.toMatch(/\blocal\b[^\n]*\b(path|status)\b/);
    expect(src).not.toMatch(/\$\{?(path|status)\b/);
  });

  it('the helper keeps the token off curl\'s argv (body goes in on stdin)', () => {
    const src = read(HELPER);
    expect(src).toMatch(/--data-binary @-/);
    expect(src).not.toMatch(/APIToken=\$/);
  });

  it('the helper runs curl with URL globbing off', () => {
    expect(read(HELPER)).toMatch(/curl\s[^\n]*(--globoff|\s-g\b)/);
  });
});

// ---------------------------------------------------------------------------
// A local GameFeed stand-in.

interface Seen {
  query: URLSearchParams;
  form: URLSearchParams;
}
let server: Server;
let base: string;
let seen: Seen[] = [];
let answer: (s: Seen) => unknown = () => lobbyFixture();
let scratch: string;
/** A stand-in `fpx` on PATH: serves the synthetic scout pages, logs its argv. */
let stubBin: string;
/** A stand-in `curl` for the refusal tests: logs that it ran and fails, so a regression
 * there never sends anything to a real host. */
let noNetBin: string;

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });
}

/** The fixture as war.app sends it: the map is `{}` when GetMap=false. */
function gamefeed(s: Seen): unknown {
  if (s.form.get('Email') !== EMAIL || s.form.get('APIToken') !== TOKEN) {
    return { termsOfUse: 'x', error: 'Auth failed' };
  }
  const game = lobbyFixture();
  if (s.query.get('GetMap') === 'false') game.map = {};
  if (s.query.get('GetSettings') !== 'true') delete game.settings;
  return game;
}

beforeAll(async () => {
  stubBin = mkdtempSync(join(tmpdir(), 'warapp-fpx-'));
  const fpx = join(stubBin, 'fpx');
  writeFileSync(
    fpx,
    `#!/bin/sh
# fpx stand-in: GET only, profile warapp only, war.app pages from the synthetic fixtures.
printf '%s\\n' "$*" >> "$FPX_LOG"
[ "$1" = get ] || { echo "stub fpx: only get" >&2; exit 1; }
case " $* " in *" -p warapp "*) ;; *) echo "stub fpx: needs -p warapp" >&2; exit 1 ;; esac
case "$2" in
  https://war.app/Profile\\?p=[0-9]*) cat "${join(FIXTURES, 'scout-profile.html')}" ;;
  https://war.app/CommonGames\\?p=[0-9]*) cat "${join(FIXTURES, 'scout-common.html')}" ;;
  *) echo "stub fpx: unexpected url $2" >&2; exit 4 ;;
esac
`,
  );
  chmodSync(fpx, 0o755);
  noNetBin = mkdtempSync(join(tmpdir(), 'warapp-nonet-'));
  writeFileSync(join(noNetBin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CURL_LOG"\nexit 7\n`);
  chmodSync(join(noNetBin, 'curl'), 0o755);
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const s: Seen = { query: url.searchParams, form: new URLSearchParams(await body(req)) };
    if (req.method !== 'POST' || url.pathname !== '/API/GameFeed') {
      res.writeHead(404).end('nope');
      return;
    }
    seen.push(s);
    const out = answer(s);
    res.writeHead(200, { 'content-type': 'application/json' }).end(typeof out === 'string' ? out : JSON.stringify(out));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(stubBin, { recursive: true, force: true });
  rmSync(noNetBin, { recursive: true, force: true });
});
afterEach(() => {
  seen = [];
  answer = gamefeed;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Source the helper in `shell` and run `script`, against the stand-in. */
function run(shell: string, script: string, env: Record<string, string | undefined> = {}): Promise<Run> {
  scratch ||= mkdtempSync(join(tmpdir(), 'warapp-skill-'));
  const fullEnv: Record<string, string> = {
    PATH: `${stubBin}:${process.env.PATH ?? ''}`,
    HOME: scratch,
    FPX_LOG: join(scratch, 'fpx.log'),
    SCOUT,
    PLAYER: '7176543229',
    WARAPP_BASE_URL: base,
    WARAPP_EMAIL: EMAIL,
    WARAPP_API_TOKEN: TOKEN,
    WARAPP_ENV_FILE: join(scratch, 'absent.env'),
    WARAPP_CACHE_DIR: join(scratch, 'cache'),
    GAME: '45670418',
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete fullEnv[k];
    else fullEnv[k] = v;
  }
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-c', `. "$1" || exit 99\n${script}`, shell, HELPER],
      { env: fullEnv, cwd: scratch },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: unknown }).code as number) : 0;
        resolve({ code: typeof code === 'number' ? code : -1, stdout, stderr });
      },
    );
  });
}

/** Run with curl replaced by a stub; `curlCalls` reads back how often it was run. */
async function runNoNet(shell: string, script: string, env: Record<string, string | undefined> = {}) {
  scratch ||= mkdtempSync(join(tmpdir(), 'warapp-skill-'));
  const log = join(scratch, 'curl.log');
  const r = await run(shell, script, { PATH: `${noNetBin}:${stubBin}:${process.env.PATH ?? ''}`, CURL_LOG: log, ...env });
  let curlCalls = 0;
  try {
    curlCalls = read(log).split('\n').filter(Boolean).length;
  } catch {
    curlCalls = 0;
  }
  return { ...r, curlCalls };
}

const noToken = (r: Run) => {
  expect(r.stdout).not.toContain(TOKEN);
  expect(r.stderr).not.toContain(TOKEN);
};

describe.each(SHELLS)('helper under %s', (shell) => {
  it('warapp_game posts the credentials as a form body and omits the map', async () => {
    const r = await run(shell, 'warapp_game "$GAME" | jq -r .name');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(String(lobbyFixture().name));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.query.get('GameID')).toBe('45670418');
    expect(seen[0]!.query.get('GetMap')).toBe('false');
    expect(seen[0]!.query.get('GetSettings')).toBe('true');
    expect(seen[0]!.form.get('Email')).toBe(EMAIL);
    expect(seen[0]!.form.get('APIToken')).toBe(TOKEN);
    noToken(r);
  });

  it('url-encodes an email with + and & in it', async () => {
    answer = (s) => ({ ok: s.form.get('Email') });
    const r = await run(shell, 'warapp_feed 7 | jq -r .ok', { WARAPP_EMAIL: 'a+b&c@example.com' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('a+b&c@example.com');
  });

  it('warapp_feed passes extra query parameters through', async () => {
    const r = await run(shell, 'warapp_feed 9 GetHistory=true GetChat=true >/dev/null');
    expect(r.code, r.stderr).toBe(0);
    expect(seen[0]!.query.get('GetHistory')).toBe('true');
    expect(seen[0]!.query.get('GetChat')).toBe('true');
  });

  it.each(['', 'abc', '0', '-3', '12x', '2147483648', '99999999999'])('rejects game id %j locally (exit 1)', async (id) => {
    const r = await run(shell, `warapp_feed '${id}'`);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/game id/i);
    expect(seen).toHaveLength(0);
  });

  it('accepts the largest game id', async () => {
    const r = await run(shell, 'warapp_feed 2147483647 >/dev/null');
    expect(r.code, r.stderr).toBe(0);
  });

  it('without credentials exits 2 and names what is missing', async () => {
    const r = await run(shell, 'warapp_game 5', { WARAPP_EMAIL: undefined, WARAPP_API_TOKEN: undefined });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/WARAPP_EMAIL/);
    expect(r.stderr).toMatch(/WARAPP_API_TOKEN/);
    expect(seen).toHaveLength(0);
  });

  it('reads credentials from the env file, with the host environment winning', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'warapp-skill-'));
    const file = join(scratch, 'warapp.env');
    writeFileSync(file, `# comment\nexport WARAPP_EMAIL="${EMAIL}"\r\nWARAPP_API_TOKEN='${TOKEN}'\nOTHER=1`);
    const r = await run(shell, 'warapp_game 5 | jq -r .id', {
      WARAPP_ENV_FILE: file,
      WARAPP_EMAIL: undefined,
      WARAPP_API_TOKEN: undefined,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(seen[0]!.form.get('Email')).toBe(EMAIL);
    expect(seen[0]!.form.get('APIToken')).toBe(TOKEN);

    writeFileSync(file, `WARAPP_EMAIL=${EMAIL}\nWARAPP_API_TOKEN=wrongtoken`);
    const r2 = await run(shell, 'warapp_game 5 >/dev/null', { WARAPP_ENV_FILE: file, WARAPP_EMAIL: undefined });
    expect(r2.code, r2.stderr).toBe(0);
    expect(seen[1]!.form.get('APIToken')).toBe(TOKEN);
  });

  it('defaults the env file to ~/.config/warapp-mcp/.env', async () => {
    const r = await run(shell, 'mkdir -p "$HOME/.config/warapp-mcp" && printf "WARAPP_EMAIL=%s\\nWARAPP_API_TOKEN=%s\\n" "$E" "$T" > "$HOME/.config/warapp-mcp/.env" && warapp_game 5 >/dev/null', {
      WARAPP_ENV_FILE: undefined,
      WARAPP_EMAIL: undefined,
      WARAPP_API_TOKEN: undefined,
      E: EMAIL,
      T: TOKEN,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(seen[0]!.form.get('APIToken')).toBe(TOKEN);
  });

  it('does not leave the credentials in the calling shell', async () => {
    const r = await run(
      shell,
      'printf "WARAPP_API_TOKEN=%s\\n" "$T" > "$HOME/w.env"; unset T; WARAPP_ENV_FILE="$HOME/w.env" warapp_game 5 >/dev/null || exit 7; set | grep -c deadbeef""cafef00d || true',
      { WARAPP_API_TOKEN: undefined, T: TOKEN },
    );
    expect(r.code, r.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(r.stdout.trim()).toBe('0');
  });

  it('maps "Auth failed" to exit 3 with the token hint, never echoing the token', async () => {
    answer = () => ({ termsOfUse: 'x', error: 'Auth failed' });
    const r = await run(shell, 'warapp_game 5');
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/GetAPIToken/);
    noToken(r);
  });

  it('maps ServerGameKeyNotFound to exit 4', async () => {
    answer = () => ({ termsOfUse: 'x', error: 'Loading the game produced an error: ServerGameKeyNotFound' });
    const r = await run(shell, 'warapp_game 5');
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/no game 5/i);
  });

  it('other errors exit 5 with the credentials scrubbed from the message', async () => {
    answer = () => ({ termsOfUse: 'x', error: `weird ${TOKEN} for ${EMAIL}` });
    const r = await run(shell, 'warapp_game 5');
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/weird \[redacted\] for \[redacted\]/);
    noToken(r);
    expect(r.stderr).not.toContain(EMAIL);
  });

  it('a non-JSON answer exits 5', async () => {
    answer = () => '<html>busy</html>';
    const r = await run(shell, 'warapp_game 5');
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/not JSON/i);
  });

  it('an unreachable server exits 5', async () => {
    const r = await run(shell, 'warapp_game 5', { WARAPP_BASE_URL: 'http://127.0.0.1:9' });
    expect(r.code).toBe(5);
  });

  // The helper sends the account's credentials: only to war.app itself, or to a loopback
  // stand-in (the tests' seam). Anything else is refused before a request is made.
  it.each([
    'https://evil.example',
    'http://evil.example',
    'https://war.app.evil.example',
    'https://war.app@evil.example',
    'https://war.app/',
    'https://war.app:8443',
    'http://war.app',
    'HTTPS://war.app',
    'http://127.0.0.2:PORT',
    'http://localhost.evil.example:PORT',
    'http://127.0.0.1.evil.example:PORT',
    'http://127.0.0.1:PORT@evil.example',
    'http://127.0.0.1:PORT/x',
    'http://127.0.0.1',
    'http://127.0.0.1:',
    'https://127.0.0.1:PORT',
    'https://localhost:PORT',
    'http://[::1]:PORT',
    'file:///etc/passwd',
  ])('refuses base URL %j with no request (exit 1)', async (raw) => {
    const url = raw.replace('PORT', String(new URL(base).port));
    const r = await runNoNet(shell, 'warapp_feed 5', { WARAPP_BASE_URL: url });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/WARAPP_BASE_URL/);
    expect(r.curlCalls).toBe(0);
    expect(seen).toHaveLength(0);
    noToken(r);
  });

  it('the curl stub sees an accepted call (so the zero counts above mean something)', async () => {
    const r = await runNoNet(shell, 'warapp_feed 5 GetChat=true');
    expect(r.code).toBe(5);
    expect(r.curlCalls).toBe(1);
  });

  it('accepts a localhost base URL with a port', async () => {
    const r = await run(shell, 'warapp_feed 5 >/dev/null', {
      WARAPP_BASE_URL: `http://localhost:${new URL(base).port}`,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it.each([
    'GetChat=[1-3]',
    'GetChat={true,false}',
    'Get[A-Z]=true',
    'X={a,b}',
    'GetChat=true GetMap=false',
    'GetChat=true;id',
    'GetChat=$(id)',
    'GetChat=`id`',
    'GetChat=a|b',
    'GetChat=a&GetMap=false',
    'GetChat=a#b',
    'GetChat=a%20b',
    'GetChat',
    '=true',
    '1Get=true',
    'Get-Chat=true',
    'GetChat=a\nb',
  ])('refuses extra argument %j with no request (exit 1)', async (arg) => {
    const r = await runNoNet(shell, 'warapp_feed 5 "$ARG"', { ARG: arg });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/argument/i);
    expect(r.curlCalls).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it('warapp_game refuses a bad extra argument too', async () => {
    const r = await runNoNet(shell, 'warapp_game 5 "$ARG"', { ARG: 'GetChat=[1-9]' });
    expect(r.code).toBe(1);
    expect(r.curlCalls).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it('accepts an empty value and the documented parameters', async () => {
    const r = await run(shell, 'warapp_feed 5 GetSettings=true GetMap=false GetHistory=true GetChat=true Foo= >/dev/null');
    expect(r.code, r.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.query.get('Foo')).toBe('');
  });

  it('warapp_map fetches the map once and serves it from the cache after', async () => {
    const r = await run(shell, 'warapp_map "$GAME" | jq -r .id; warapp_map "$GAME" | jq ".territories | length"');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(['39905', '761']);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.query.get('GetMap')).toBeNull();
  });

  it('warapp_map surfaces errors with their exit code', async () => {
    answer = () => ({ termsOfUse: 'x', error: 'Auth failed' });
    const r = await run(shell, 'warapp_map 5');
    expect(r.code).toBe(3);
  });

  it('warapp_map refuses a map id that is not a number', async () => {
    answer = () => ({ ...lobbyFixture(), map: { id: '../../x' } });
    const r = await run(shell, 'warapp_map 5');
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/map/i);
  });
});

// ---------------------------------------------------------------------------
// Every recipe documented in skills/warapp-api/SKILL.md runs against the fixture.

const recipes = [...read(join(SKILLS, 'warapp-api', 'SKILL.md')).matchAll(/<!-- recipe: ([^>]+?) -->\n```sh\n([\s\S]*?)```/g)].map(
  (m) => ({ name: m[1]!, script: m[2]! }),
);

// The character checks again, under every shell that may source the helper, macOS's
// /bin/bash 3.2 included (where it differs from the `bash` on PATH).
describe.each(LOCALE_SHELLS)('helper character checks under %s', (shell) => {
  // A bracket range like [A-Za-z] matches by collation order in some shells under a UTF-8
  // locale (macOS /bin/bash 3.2 lets é, ß and fullwidth letters through), so the helper
  // spells its character set out. Run under a UTF-8 locale to prove it.
  it.each(['A=é', 'Aé=b', 'GetMap=ｔｒｕｅ', 'GetMapＡ=true', 'Æ=1', 'ß=1', 'A=ⅰ'])(
    'refuses non-ASCII extra argument %j under a UTF-8 locale with no request (exit 1)',
    async (arg) => {
      const r = await runNoNet(shell, 'warapp_feed 5 "$ARG"', { ARG: arg, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/argument/i);
      expect(r.curlCalls).toBe(0);
    },
  );

  it.each(['１２３', '٣'])('refuses non-ASCII game id %j under a UTF-8 locale', async (id) => {
    const r = await runNoNet(shell, 'warapp_feed "$ID"', { ID: id, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' });
    expect(r.code).toBe(1);
    expect(r.curlCalls).toBe(0);
  });

  it('refuses a non-ASCII loopback port under a UTF-8 locale', async () => {
    const r = await runNoNet(shell, 'warapp_feed 5', {
      WARAPP_BASE_URL: 'http://127.0.0.1:８０８０',
      LC_ALL: 'en_US.UTF-8',
      LANG: 'en_US.UTF-8',
    });
    expect(r.code).toBe(1);
    expect(r.curlCalls).toBe(0);
  });

});

describe('documented recipes', () => {
  it('documents the player, bonus and standing recipes', () => {
    const names = recipes.map((r) => r.name);
    expect(names.length).toBeGreaterThanOrEqual(5);
    for (const want of ['players', 'bonuses', 'standing']) expect(names.join(' ')).toContain(want);
  });

  it('documents bridge recipes for the profile and common-games pages through fpx profile warapp', () => {
    const md = read(join(SKILLS, 'warapp-api', 'SKILL.md'));
    const scouting = recipes.filter((r) => /\bfpx get\b/.test(r.script));
    expect(scouting.map((r) => r.script).join('\n')).toMatch(/war\.app\/Profile\?p=/);
    expect(scouting.map((r) => r.script).join('\n')).toMatch(/war\.app\/CommonGames\?p=/);
    for (const r of scouting) {
      expect(r.script, r.name).toMatch(/-p warapp\b/);
      expect(r.script, r.name).toMatch(/node "\$SCOUT" (profile|common)/);
    }
    expect(md).toContain('fpx profile add warapp --domain war.app');
    expect(md).toMatch(/fpx pair -p warapp/);
    expect(md).toMatch(/frozen/i);
    expect(md).toMatch(/no bridge/i);
  });

  it('every sh block in the skill is a marked recipe (none escapes the run below)', () => {
    const md = read(join(SKILLS, 'warapp-api', 'SKILL.md'));
    const blocks = [...md.matchAll(/```sh\n/g)].length;
    const setup = [...md.matchAll(/<!-- setup -->\n```sh\n/g)].length;
    expect(blocks).toBe(recipes.length + setup);
  });

  describe.each(SHELLS)('under %s', (shell) => {
    it.each(recipes.map((r) => [r.name, r.script] as const))('%s', async (_name, script) => {
      const r = await run(shell, `set -e\n${script}`);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout.trim().length).toBeGreaterThan(0);
      expect(r.stdout).not.toMatch(/^null$/m);
      noToken(r);
      // Scouting output is an allowlist: the fixture's personal lines never surface.
      expect(r.stdout).not.toMatch(/Springfield|Nowhereland|Location|Joined|example\.com/i);
    });
  });
});
