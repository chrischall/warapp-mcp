// warapp_backfill_history's per-game report: a finished record summarised, and one game's standing. Synthetic only.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLLECTOR_VERSION, readFinishedSummary } from '../src/finished-store.js';
import { gameStanding } from '../src/tools/end-of-game.js';

const dir = mkdtempSync(join(tmpdir(), 'warapp-summary-'));
const file = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};

describe('readFinishedSummary', () => {
  it('missing, and unreadable: not JSON, another version, an unknown status', async () => {
    expect(await readFinishedSummary(join(dir, 'none.json'))).toBe('missing');
    expect(await readFinishedSummary(file('a.json', '{'))).toBe('unreadable');
    expect(await readFinishedSummary(file('b.json', JSON.stringify({ version: 2, status: 'captured' })))).toBe('unreadable');
    expect(await readFinishedSummary(file('c.json', JSON.stringify({ version: 1, status: 'won' })))).toBe('unreadable');
  });

  it('a capture: its turns, boards, stats version, kinds, result and collector', async () => {
    const p = file(
      'd.json',
      JSON.stringify({
        version: 1,
        collector: COLLECTOR_VERSION,
        status: 'captured',
        me: 'k',
        turns: [{}, {}],
        boards: [{}],
        stats: { version: 3, turnsRead: 2, players: {} },
        kinds: ['team', 7],
        outcome: { result: 'lost', turn: 2, outTurn: 2, winners: [] },
      }),
    );
    expect(await readFinishedSummary(p)).toEqual({ status: 'captured', collector: 1, turns: 2, boards: 1, statsVersion: 3, kinds: ['team'], result: 'lost' });
  });

  it('a failure keeps its codes; a record kept before the collector field (or a bad one) reads 0', async () => {
    expect(await readFinishedSummary(file('e.json', JSON.stringify({ version: 1, status: 'read-failed', me: 'k', failure: { reason: 'request-failed', kind: 'http' } })))).toEqual({
      status: 'read-failed',
      collector: 0,
      failure: { reason: 'request-failed', kind: 'http' },
    });
    expect(await readFinishedSummary(file('f.json', JSON.stringify({ version: 1, collector: -1, status: 'history-unreadable', me: 'k', failure: { reason: 'absent' } })))).toMatchObject({
      collector: 0,
      failure: { reason: 'absent' },
    });
  });
});

describe('gameStanding', () => {
  it('nothing to tell without a data directory or with profiling off', async () => {
    expect(await gameStanding({ dataDir: undefined, env: {} }, 1, 2)).toEqual({ state: 'unknown' });
    expect(await gameStanding({ dataDir: dir, env: { WARAPP_PLAYER_PROFILE: 'off' } }, 1, 2)).toEqual({ state: 'unknown' });
  });

  it('no salt yet: not processed', async () => {
    expect(await gameStanding({ dataDir: mkdtempSync(join(tmpdir(), 'warapp-summary-empty-')), env: {} }, 1, 2)).toEqual({ state: 'not-processed' });
  });
});
