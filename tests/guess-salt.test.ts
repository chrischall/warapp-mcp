// The guess's local salt: created once, private, stable, and part of the seed.
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guessSeed } from '../src/analysis/guess.js';
import { guessSalt, guessSaltPath } from '../src/guess-salt.js';

describe('guessSalt', () => {
  it('is created once in the data directory, 0600, and read back the same', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-salt-'));
    const a = await guessSalt(dir);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(statSync(guessSaltPath(dir)).mode & 0o777).toBe(0o600);
    expect(readFileSync(guessSaltPath(dir), 'utf8')).toBe(a);
    expect(await guessSalt(dir)).toBe(a);
  });

  it('differs between data directories, and without one is stable for the process', async () => {
    const a = await guessSalt(mkdtempSync(join(tmpdir(), 'warapp-mcp-salt-')));
    const b = await guessSalt(mkdtempSync(join(tmpdir(), 'warapp-mcp-salt-')));
    expect(a).not.toBe(b);
    expect(await guessSalt(undefined)).toBe(await guessSalt(undefined));
  });

  it('changes the seed: the game id and turn alone do not give the draw', () => {
    expect(guessSeed(1, 2, 'a'.repeat(32))).not.toBe(guessSeed(1, 2));
    expect(guessSeed(1, 2, 'a'.repeat(32))).toBe(guessSeed(1, 2, 'a'.repeat(32)));
  });
});
