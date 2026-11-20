// #382: the siege memory on disk, per game and account.
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSiegeMemory, siegePath, writeSiegeMemory } from '../src/siege-store.js';

const memory = { target: 20, turns: [{ turn: 3, opponentIncome: 15, myIncome: 10, breaks: [1, 2] }] };

describe('#382 siege store', () => {
  it('round-trips a game’s siege memory, 0600, name-free', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'siege-'));
    expect(await readSiegeMemory(dir, 7, 10)).toBeUndefined();
    expect(await writeSiegeMemory(dir, 7, 10, memory)).toBe(true);
    expect(await readSiegeMemory(dir, 7, 10)).toEqual(memory);
    expect(await readSiegeMemory(dir, 7, 11)).toBeUndefined();
    expect(statSync(siegePath(dir, 7, 10)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(siegePath(dir, 7, 10), 'utf8'))).toEqual({ gameId: 7, playerId: 10, ...memory });
  });

  it('reads loosely: an unusable file is no memory, an unusable turn is dropped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'siege-'));
    mkdirSync(join(dir, 'siege'), { recursive: true });
    writeFileSync(siegePath(dir, 7, 10), 'not json');
    expect(await readSiegeMemory(dir, 7, 10)).toBeUndefined();
    writeFileSync(
      siegePath(dir, 7, 10),
      JSON.stringify({ gameId: 7, playerId: 10, target: 20, turns: [memory.turns[0], { turn: 'x' }, { turn: 4, opponentIncome: 9, myIncome: 11, breaks: ['a'] }] }),
    );
    expect(await readSiegeMemory(dir, 7, 10)).toEqual({ target: 20, turns: [memory.turns[0], { turn: 4, opponentIncome: 9, myIncome: 11, breaks: [] }] });
  });
});
