// #419: map-record entries kept before #419 get their winners' income curves from the history the end-of-game record
// kept (no request), so the fog pace can read them. Synthetic only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardState } from '../src/board.js';
import { finishedGameKey, playerSaltForWrite } from '../src/player-record-store.js';
import { finishedPath, finishedRecordOf, writeFinishedRecord } from '../src/finished-store.js';
import { fillWinnerCurves, readMapRecord, recordMapGame, type MapEntry } from '../src/lessons-store.js';
import { writeStoredMap } from '../src/map-store.js';
import { normalizeMap, type Game } from '../src/normalize.js';
import { nameFreeSettings } from '../src/replay.js';
import { backfillWinnerCurves } from '../src/tools/map-curves.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'warapp-mcp-curves-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const ANN = 4412345677;
const BOB = 7176543229;
const MAP = normalizeMap({
  id: '77',
  name: 'Line',
  territories: [1, 2, 3].map((id) => ({ id: String(id), name: `T${id}`, connectedTo: [id - 1, id + 1].filter((n) => n >= 1 && n <= 3) })),
  bonuses: [{ id: '100', name: 'West', value: '3', territoryIDs: [1, 2] }],
});
const game = (id: number): Game =>
  ({
    id,
    name: 'Secret',
    state: 'Finished',
    numberOfTurns: 2,
    players: [
      { id: ANN, name: 'Ann', isAI: false, humanTurnedIntoAI: false, hasCommittedOrders: false, state: 'Eliminated' },
      { id: BOB, name: 'Bob', isAI: false, humanTurnedIntoAI: false, hasCommittedOrders: false, state: 'Won' },
    ],
    settings: { raw: { Map: '77', MinimumArmyBonus: '5' }, mapId: 77, minimumArmyBonus: 5 } as never,
  }) as Game;
const board = (t1: number, t2: number | 'neutral'): BoardState => ({
  source: 'gamefeed',
  verified: false,
  territories: [
    { territoryId: 1, owner: { kind: 'player', playerId: t1 }, armies: 5 },
    { territoryId: 2, owner: t2 === 'neutral' ? { kind: 'neutral' } : { kind: 'player', playerId: t2 }, armies: 2 },
    { territoryId: 3, owner: { kind: 'player', playerId: ANN }, armies: 4 },
  ],
});
const entry = (key: string, o: Partial<MapEntry> = {}): MapEntry => ({
  key,
  format: '1v1',
  seats: 2,
  result: 'eliminated',
  turns: 2,
  me: { territories: [3], bonuses: [], income: [5, 5, 5], income4: null, income8: null },
  winners: [{ territories: [1], bonuses: [100], income4: null, income8: null }],
  ...o,
});

describe('#419: winner curves for entries kept before it', () => {
  it('backfillWinnerCurves reads the winner\'s curve from the end-of-game record; a second run changes nothing', async () => {
    const dir = tmp();
    const salt = (await playerSaltForWrite(dir))!;
    await writeStoredMap(dir, MAP);
    const g = game(601);
    // Bob starts on T1 (base 5), takes T2 and the +3 bonus.
    const boards = [
      { turn: 0, board: board(BOB, 'neutral') },
      { turn: 1, board: board(BOB, BOB) },
      { turn: 2, board: board(BOB, BOB) },
    ];
    await writeFinishedRecord(dir, finishedPath(dir, salt, ANN, 601), finishedRecordOf({ salt, me: ANN, status: 'captured', game: g, settings: nameFreeSettings(g), mapId: 77, boards }));
    const key = finishedGameKey(salt, ANN, 601);
    await recordMapGame(dir, 77, entry(key));
    expect(await backfillWinnerCurves(dir)).toEqual({ filled: 1, unfilled: 0 });
    const r = await readMapRecord(dir, 77);
    if (r === 'unreadable') throw new Error('unreadable');
    expect(r.entries[0]!.winners[0]!.income).toEqual([5, 8, 8]);
    expect(await backfillWinnerCurves(dir)).toEqual({ filled: 0, unfilled: 0 });
  });

  it('fillWinnerCurves matches winners by their start, keeps a curve already there, and reports a missing game', async () => {
    const dir = tmp();
    const k = '1'.padStart(32, '0');
    const two = entry(k, {
      winners: [
        { territories: [1], bonuses: [], income4: null, income8: null },
        { territories: [3], bonuses: [], income: [9], income4: null, income8: null },
      ],
    });
    await recordMapGame(dir, 5, two);
    expect(await fillWinnerCurves(dir, 5, k, [{ territories: [3], income: [1] }, { territories: [1], income: [7, 8] }])).toBe('filled');
    const r = await readMapRecord(dir, 5);
    if (r === 'unreadable') throw new Error('unreadable');
    expect(r.entries[0]!.winners.map((w) => w.income)).toEqual([[7, 8], [9]]);
    expect(await fillWinnerCurves(dir, 5, k, [{ territories: [1], income: [0] }])).toBe('unchanged');
    expect(await fillWinnerCurves(dir, 5, '2'.padStart(32, '0'), [])).toBe('missing');
  });
});
