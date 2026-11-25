// What the calibration harness (#318, scripts/calibrate.mjs) scores: the end-of-game records alone, the
// one history read per finished game (P2), matched to the game's settings record when it is still kept,
// read on their own (their own settings, the stored map) when it aged out. Synthetic only.
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardState } from '../src/board.js';
import { calibrationSources } from '../src/calibration-source.js';
import { calibrationHarness } from '../src/tools/calibration-harness.js';
import { finishedDir, finishedPath, finishedRecordOf, writeFinishedRecord } from '../src/finished-store.js';
import { writeStoredMap } from '../src/map-store.js';
import { normalizeMap, type Game } from '../src/normalize.js';
import { playerSaltForWrite } from '../src/player-record-store.js';
import { gameRecordPath, nameFreeSettings, writeGameRecord } from '../src/replay.js';
import { writeBoardCache, writeOrdersCache } from '../src/trend.js';

const ANN = 4412345677;
const BOB = 7176543229;
const MAP = normalizeMap({
  id: '77',
  name: 'Line',
  territories: [1, 2, 3].map((id) => ({ id: String(id), name: `T${id}`, connectedTo: [id - 1, id + 1].filter((n) => n >= 1 && n <= 3) })),
  bonuses: [{ id: '100', name: 'West', value: '3', territoryIDs: [1, 2] }],
});

function game(id: number): Game {
  return {
    id,
    name: 'Secret',
    state: 'Finished',
    numberOfTurns: 1,
    players: [
      { id: ANN, name: 'Ann', isAI: false, humanTurnedIntoAI: false, hasCommittedOrders: false, state: 'Won' },
      { id: BOB, name: 'Bob', isAI: false, humanTurnedIntoAI: false, hasCommittedOrders: false, state: 'Eliminated' },
    ],
    settings: { raw: { Map: '77', MinimumArmyBonus: '5' }, mapId: 77, minimumArmyBonus: 5 } as never,
  } as Game;
}

const board = (owner3: number): BoardState => ({
  source: 'gamefeed',
  verified: false,
  territories: [
    { territoryId: 1, owner: { kind: 'player', playerId: ANN }, armies: 5 },
    { territoryId: 2, owner: { kind: 'neutral' }, armies: 2 },
    { territoryId: 3, owner: { kind: 'player', playerId: owner3 }, armies: 4 },
  ],
});

async function keep(dir: string, salt: string, id: number, status: 'captured' | 'read-failed' = 'captured') {
  const g = game(id);
  await writeFinishedRecord(
    dir,
    finishedPath(dir, salt, ANN, id),
    finishedRecordOf({ salt, me: ANN, status, game: g, settings: nameFreeSettings(g), mapId: 77, boards: [{ turn: 0, board: board(BOB) }, { turn: 1, board: board(ANN) }] }),
  );
}

describe('calibrationSources (#318)', () => {
  it('matches a record to its settings record (my cached boards with it), and reads one whose settings record aged out on its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-calsrc-'));
    const salt = (await playerSaltForWrite(dir))!;
    await writeStoredMap(dir, MAP);
    for (const id of [501, 502]) {
      await writeGameRecord(dir, game(id));
      await keep(dir, salt, id);
    }
    await writeBoardCache(dir, 501, ANN, 1, board(BOB));
    // 502's settings record aged out: the record keeps its own settings.
    unlinkSync(gameRecordPath(dir, 502));
    // A settings record whose game was never processed, and a failed pass.
    await writeGameRecord(dir, game(503));
    await keep(dir, salt, 504, 'read-failed');

    const r = await calibrationSources(dir);
    expect(r.statuses).toEqual({ captured: 2, 'read-failed': 1, missing: 1 });
    expect(r.inputs.map((i) => i.source).sort()).toEqual(['record-only', 'settings-record']);
    const matched = r.inputs.find((i) => i.source === 'settings-record')!;
    expect(matched.history.me).toBe(ANN);
    expect(matched.cached.map((b) => b.turn)).toEqual([1]);
    const alone = r.inputs.find((i) => i.source === 'record-only')!;
    // Labels, not ids: the key is never reversed.
    expect(alone.history.me).toBe(1);
    expect(alone.history.players.map((p) => p.id)).toEqual([1, 2]);
    expect(alone.cached).toEqual([]);
    expect(alone.settings.mapId).toBe(77);
    expect(alone.map.id).toBe(77);
    expect(r.skipped).toEqual({});
  });

  it('#569: the harness (warapp_calibration harness: true, scripts/calibrate.mjs) runs over the same records, aggregates only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-calsrc-'));
    const salt = (await playerSaltForWrite(dir))!;
    await writeStoredMap(dir, MAP);
    for (const id of [511, 512]) {
      await writeGameRecord(dir, game(id));
      await keep(dir, salt, id);
    }
    await writeBoardCache(dir, 511, ANN, 1, board(BOB));
    unlinkSync(gameRecordPath(dir, 512));
    const r = await calibrationHarness(dir, { turns: 1 });
    expect(r.counts.histories).toEqual({ captured: 2 });
    expect(r.counts.recordOnly).toBe(1);
    expect(r.counts.benchmarked).toBeGreaterThan(0);
    expect(r.benchmark).toHaveProperty('all');
    expect(r.byEra).toBeDefined();
    const text = JSON.stringify(r);
    for (const id of ['511', '512', String(ANN), String(BOB), 'Ann', 'Bob', 'Secret']) expect(text).not.toContain(id);
  });

  it('skips a record without a stored map or settings, and says why', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-calsrc-'));
    const salt = (await playerSaltForWrite(dir))!;
    await keep(dir, salt, 601);
    const g = game(602);
    await writeFinishedRecord(dir, finishedPath(dir, salt, ANN, 602), finishedRecordOf({ salt, me: ANN, status: 'captured', game: g, boards: [{ turn: 0, board: board(BOB) }] }));
    mkdirSync(finishedDir(dir), { recursive: true });
    writeFileSync(join(finishedDir(dir), `${'f'.repeat(32)}.json`), '{');
    const r = await calibrationSources(dir);
    expect(r.inputs).toEqual([]);
    expect(r.skipped).toEqual({ 'no-map': 1, 'no-settings': 1 });
    expect(r.statuses).toEqual({ captured: 2, unreadable: 1 });
  });

  it('reads nothing with no salt (no pass ever ran)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-calsrc-'));
    await writeGameRecord(dir, game(701));
    expect(await calibrationSources(dir)).toEqual({ inputs: [], statuses: { missing: 1 }, skipped: {} });
  });

  it('#503: recovers a record-only game id from a local cache of it, and reads whether it was planned, my boot turn, failed attacks and sent turns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-calsrc-'));
    const salt = (await playerSaltForWrite(dir))!;
    await writeStoredMap(dir, MAP);
    const g = game(45_700_001);
    const base = finishedRecordOf({ salt, me: ANN, status: 'captured', game: g, settings: nameFreeSettings(g), mapId: 77, boards: [{ turn: 0, board: board(BOB) }, { turn: 1, board: board(ANN) }] });
    // Planned (an outlook line), my seat booted on turn 3, a failed attack on turn 2.
    await writeFinishedRecord(dir, finishedPath(dir, salt, ANN, 45_700_001), {
      ...base,
      outlook: { turn: 3, state: 'even', heldTurns: 1 },
      outcome: { result: 'booted', turn: 5, outTurn: 3, leftTurn: 3, winners: [] },
      failedAttacks: [{ turn: 2, to: 2, from: [1], sent: 3, before: { owner: 'neutral', armies: 2 }, after: { owner: 'neutral', armies: 1 } }],
    });
    // No settings record, but the board cache (with the orders sent on turn 1) still names the game.
    await writeBoardCache(dir, 45_700_001, ANN, 1, board(BOB));
    await writeOrdersCache(dir, 45_700_001, ANN, 1, { deploys: [{ territoryId: 1, armies: 5 }], moves: [] });
    // A record nothing local names: no id.
    const g2 = game(45_700_002);
    await writeFinishedRecord(dir, finishedPath(dir, salt, ANN, 45_700_002), finishedRecordOf({ salt, me: ANN, status: 'captured', game: g2, settings: nameFreeSettings(g2), mapId: 77, boards: [{ turn: 0, board: board(BOB) }] }));
    const r = await calibrationSources(dir);
    const named = r.inputs.find((i) => i.opening.gameId !== undefined)!;
    expect(named.source).toBe('record-only');
    expect(named.opening).toEqual({ gameId: 45_700_001, planned: true, bootedTurn: 3, failedAttackTurns: [2], sentTurns: [1] });
    const anon = r.inputs.find((i) => i.opening.gameId === undefined)!;
    expect(anon.opening).toEqual({ planned: false, bootedTurn: null, failedAttackTurns: [], sentTurns: [] });
  });
});
