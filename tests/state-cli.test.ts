// `warapp-mcp export-state`: the local CLI that writes the state bundle. Synthetic data dirs only.
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runExportCli } from '../src/state-cli.js';
import { decodeBundle } from '../src/state-bundle.js';

const ME = 4412345677;
const SALT = '0123456789abcdef0123456789abcdef';

function put(dir: string, rel: string, body: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'warapp-state-cli-'));
  put(dir, '.env', 'WARAPP_API_TOKEN=tok-secret\n');
  put(dir, 'relations/players.salt', SALT);
  put(dir, 'lessons.json', '{"privateLesson":"content-marker"}');
  put(dir, `relations/1-${ME}.json`, '{}');
  return dir;
}

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runExportCli(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('warapp-mcp export-state', () => {
  it('writes a 0600 bundle and prints only counts and sizes', async () => {
    const dir = dataDir();
    const file = join(mkdtempSync(join(tmpdir(), 'warapp-state-cli-out-')), 'state.json.gz');
    const r = await run(['--data-dir', dir, '--out', file]);
    expect(r.code).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(decodeBundle(readFileSync(file)).files.size).toBe(3);
    expect(r.out).toMatch(/3 files/);
    expect(r.out).toMatch(/salt: 1 file/);
    for (const s of [SALT, 'content-marker', 'tok-secret', String(ME)]) expect(r.out + r.err).not.toContain(s);
  });

  it('needs --out, and refuses unknown flags', async () => {
    expect((await run(['--data-dir', dataDir()])).code).toBe(2);
    expect((await run(['--bogus'])).code).toBe(2);
  });

  it('reports a refusal without a stack and exits 1', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'warapp-state-cli-'));
    const r = await run(['--data-dir', empty, '--out', join(empty, 'x.gz')]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/salt/);
    expect(r.err).not.toMatch(/at .*\.ts:/);
  });

  it('the entry point dispatches export-state before it loads the env file', () => {
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const dispatch = index.indexOf("'export-state'");
    expect(dispatch).toBeGreaterThan(-1);
    expect(dispatch).toBeLessThan(index.indexOf('loadDotenvSafely({'));
  });
});
