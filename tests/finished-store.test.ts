// The end-of-game records (#312 E1): bounded, and a record's state read loosely. Synthetic only.
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { finishedDir, finishedPath, finishedRecordOf, readFinishedState, writeFinishedRecord } from '../src/finished-store.js';

const SALT = '0123456789abcdef0123456789abcdef';

describe('the end-of-game store', () => {
  it('keeps only the newest records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-fin-'));
    for (const g of [1, 2, 3]) {
      const path = finishedPath(dir, SALT, 1001, g);
      await writeFinishedRecord(dir, path, finishedRecordOf({ salt: SALT, me: 1001, status: 'read-failed', failure: { reason: 'request-failed' } }), 2);
      utimesSync(path, g, g);
    }
    await writeFinishedRecord(dir, finishedPath(dir, SALT, 1001, 4), finishedRecordOf({ salt: SALT, me: 1001, status: 'read-failed' }), 2);
    expect(readdirSync(finishedDir(dir))).toHaveLength(2);
    expect(await readFinishedState(finishedPath(dir, SALT, 1001, 1))).toBe('missing');
    expect(await readFinishedState(finishedPath(dir, SALT, 1001, 4))).toEqual({ status: 'read-failed' });
  });

  it('reads another version or status as unreadable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-fin-'));
    mkdirSync(finishedDir(dir), { recursive: true });
    const path = finishedPath(dir, SALT, 1001, 5);
    writeFileSync(path, JSON.stringify({ version: 2, status: 'captured' }));
    expect(await readFinishedState(path)).toBe('unreadable');
    writeFileSync(path, JSON.stringify({ version: 1, status: 'odd' }));
    expect(await readFinishedState(path)).toBe('unreadable');
    writeFileSync(path, '[]');
    expect(await readFinishedState(path)).toBe('unreadable');
  });
});
