// #419 (owner decision of 2026-11-20): the map record keeps each winner's income every turn, and the fog
// prior's pace is read from it: the median past winner's income at the turn planned on this map (3 or more
// games of this format and settings), else a relative per-format pace (the median of winner ÷ mine over
// every map's games of this format). Synthetic records only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  formatPaceAt,
  mapPaceAt,
  mapRecordPath,
  MIN_PACE_GAMES,
  readMapRecord,
  recordMapGame,
  type MapEntry,
  type MapRecord,
} from '../src/lessons-store.js';
import { fogPaceFor } from '../src/tools/past-games.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'warapp-mcp-pace-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const key = (n: number) => n.toString(16).padStart(32, '0');
/** A game whose winner earned `w` and I `m` on the boards after turns 0, 1, 2, … */
const game = (n: number, w: (number | null)[] | undefined, m: (number | null)[] = [], o: Partial<MapEntry> = {}): MapEntry => ({
  key: key(n),
  format: '1v1',
  seats: 2,
  result: 'surrendered',
  turns: 12,
  me: { territories: [1], bonuses: [100], income: m, income4: null, income8: null },
  winners: [{ territories: [6], bonuses: [200], ...(w ? { income: w } : {}), income4: null, income8: null }],
  ...o,
});
const rec = (mapId: number, entries: MapEntry[]): MapRecord => ({ version: 1, mapId, games: entries.length, outcomes: {}, entries });

describe('the map record keeps each winner\'s curve (#419)', () => {
  it('round-trips a winner\'s income curve; an entry kept before #419 reads without one', async () => {
    const dir = tmp();
    await recordMapGame(dir, 7, game(1, [5, 7, null, 12]));
    await recordMapGame(dir, 7, game(2, undefined));
    const r = await readMapRecord(dir, 7);
    if (r === 'unreadable') throw new Error('unreadable');
    expect(r.entries[0]!.winners[0]!.income).toEqual([5, 7, null, 12]);
    expect(r.entries[1]!.winners[0]).not.toHaveProperty('income');
  });

  it('a malformed winner curve leaves its entry out, as any malformed field does', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'maps-record'), { recursive: true });
    const bad = { ...game(1, [5]), winners: [{ territories: [6], bonuses: [200], income: ['x'], income4: null, income8: null }] };
    writeFileSync(mapRecordPath(dir, 8), JSON.stringify({ version: 1, mapId: 8, games: 2, outcomes: {}, entries: [bad, game(2, [5, 6])] }));
    const r = await readMapRecord(dir, 8);
    if (r === 'unreadable') throw new Error('unreadable');
    expect(r.entries.map((e) => e.key)).toEqual([key(2)]);
  });
});

describe('mapPaceAt: the median past winner on this map', () => {
  it(`needs ${MIN_PACE_GAMES} games with a winner figure after that turn`, () => {
    expect(MIN_PACE_GAMES).toBe(3);
    const two = rec(7, [game(1, [5, 10, 20]), game(2, [5, 12, 22]), game(3, [5, 14])]);
    expect(mapPaceAt(two, 2)).toBeNull();
    expect(mapPaceAt(two, 1)).toEqual({ income: 12, games: 3 });
  });

  it('the median rounds up; a game with two winners counts once, at its higher', () => {
    const r = rec(7, [
      game(1, [0, 10]),
      game(2, [0, 13]),
      game(3, [0, 4], [], { winners: [{ territories: [], bonuses: [], income: [0, 4], income4: null, income8: null }, { territories: [], bonuses: [], income: [0, 20], income4: null, income8: null }] }),
      game(4, [0, 11]),
    ]);
    // 10, 11, 13, 20: (11 + 13) / 2 = 12.
    expect(mapPaceAt(r, 1)).toEqual({ income: 12, games: 4 });
    const odd = rec(7, [game(1, [0, 10]), game(2, [0, 11]), game(3, [0, 14]), game(4, [0, 15])]);
    // 10, 11, 14, 15: 12.5 → 13.
    expect(mapPaceAt(odd, 1)).toEqual({ income: 13, games: 4 });
  });

  it('reads only the games of the current format and settings (#437)', () => {
    const r = rec(7, [game(1, [0, 10]), game(2, [0, 11]), game(3, [0, 12], [], { format: 'ffa' }), game(4, [0, 13], [], { settings: { key: null, commanders: true } })]);
    expect(mapPaceAt(r, 1, { format: '1v1' })).toEqual({ income: 11, games: 3 });
    expect(mapPaceAt(r, 1, { format: '1v1', commanders: false })).toBeNull();
  });
});

describe('formatPaceAt: the relative per-format pace', () => {
  it('the median of winner ÷ mine after that turn over every map\'s games of the format', () => {
    const recs = [
      rec(1, [game(1, [5, 20], [5, 10]), game(2, [5, 30], [5, 10], { format: 'ffa' })]),
      rec(2, [game(3, [5, 15], [5, 10]), game(4, [5, 40], [5, 20])]),
    ];
    // 1v1: 2, 1.5, 2 → 2.
    expect(formatPaceAt(recs, 1, { format: '1v1' })).toEqual({ ratio: 2, games: 3 });
    expect(formatPaceAt(recs, 1, { format: 'ffa' })).toBeNull();
  });

  it('a game where I had no income then, or no figure, is left out', () => {
    const recs = [rec(1, [game(1, [5, 20], [5, 0]), game(2, [5, 20], [5, null]), game(3, [5, 20], [5, 10]), game(4, undefined, [5, 10])])];
    expect(formatPaceAt(recs, 1, { format: '1v1' })).toBeNull();
  });
});

describe('fogPaceFor: what the plan reads', () => {
  const env = {};
  it('the map\'s own pace when it has 3 games; else the format\'s; else none', async () => {
    const dir = tmp();
    for (const [i, w] of [10, 11, 12].entries()) await recordMapGame(dir, 7, game(i + 1, [5, w], [5, 10]));
    expect(await fogPaceFor(dir, env, 7, { format: '1v1' }, 1)).toEqual({ basis: 'map', afterTurn: 1, games: 3, income: 11 });
    // Map 9 has one game: the format's ratio over every map (11/10, 12/10, 10/10, 30/10 → 1.15).
    await recordMapGame(dir, 9, game(9, [5, 30], [5, 10]));
    expect(await fogPaceFor(dir, env, 9, { format: '1v1' }, 1)).toEqual({ basis: 'format', afterTurn: 1, games: 4, ratio: 1.15 });
    expect(await fogPaceFor(dir, env, 9, { format: 'ffa' }, 1)).toBeUndefined();
  });

  it('off with WARAPP_PLAYER_PROFILE=off, without a data dir, a map or a turn', async () => {
    const dir = tmp();
    for (const [i, w] of [10, 11, 12].entries()) await recordMapGame(dir, 7, game(i + 1, [5, w], [5, 10]));
    expect(await fogPaceFor(dir, { WARAPP_PLAYER_PROFILE: 'off' }, 7, { format: '1v1' }, 1)).toBeUndefined();
    expect(await fogPaceFor(undefined, env, 7, { format: '1v1' }, 1)).toBeUndefined();
    expect(await fogPaceFor(dir, env, undefined, { format: '1v1' }, 1)).toBeUndefined();
    expect(await fogPaceFor(dir, env, 7, { format: '1v1' }, null)).toBeUndefined();
  });
});
