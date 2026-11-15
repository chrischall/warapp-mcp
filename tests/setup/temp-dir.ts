// Every test run gets its own temporary folder, removed when the run ends.
//
// Many tests make data folders with mkdtemp(tmpdir()) and never remove them. Over a day of runs
// they filled the machine's disk (about a million folders). Setting TMPDIR here, in the main
// process before any worker starts, sends every worker's tmpdir() into one folder per run, and
// the teardown removes it whatever the tests left behind.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let runDir: string | undefined;

export function setup(): void {
  runDir = mkdtempSync(join(tmpdir(), 'warapp-mcp-vitest-'));
  process.env.TMPDIR = runDir;
}

export function teardown(): void {
  if (runDir) rmSync(runDir, { recursive: true, force: true });
}
