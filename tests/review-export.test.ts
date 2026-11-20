// The review export (#437 task 5, scripts/review-export.mjs; pure-ish part src/review-export.ts): one
// name-free JSON per game joining the decision log, the finished record, the map record entry, the
// lessons entry, the events, picks and join context, plus an index. Synthetic ids; the names only prove
// none is written.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardState } from '../src/board.js';
import { decisionLogPath, decisionsDir, updateDecisionLog, type DecisionLog } from '../src/decision-log.js';
import { finishedPath, finishedRecordOf, writeFinishedRecord } from '../src/finished-store.js';
import { recordLessons, recordMapExcluded, recordMapGame } from '../src/lessons-store.js';
import { writeStoredMap } from '../src/map-store.js';
import { normalizeMap, type Game } from '../src/normalize.js';
import { finishedGameKey, playerSaltForWrite } from '../src/player-record-store.js';
import { nameFreeSettings, writeGameRecord } from '../src/replay.js';
import { exportReview, reviewGame, reviewGameIds } from '../src/review-export.js';

const ANN = 4412345677;
const BOB = 7176543229;
const MAP = normalizeMap({
  id: '77',
  name: 'Line',
  territories: [1, 2, 3].map((id) => ({ id: String(id), name: `T${id}`, connectedTo: [id - 1, id + 1].filter((n) => n >= 1 && n <= 3) })),
  bonuses: [{ id: '100', name: 'West', value: '3', territoryIDs: [1, 2] }],
});

function game(id: number, state = 'Finished'): Game {
  return {
    id,
    name: 'Secret lobby of Ann',
    state,
    numberOfTurns: 2,
    players: [
      { id: ANN, name: 'Ann', isAI: false, humanTurnedIntoAI: false, hasCommittedOrders: false, state: state === 'Finished' ? 'Won' : 'Playing' },
      { id: BOB, name: 'Bob', isAI: false, humanTurnedIntoAI: false, hasCommittedOrders: false, state: state === 'Finished' ? 'Eliminated' : 'Playing' },
    ],
    settings: { raw: { Map: '77', MinimumArmyBonus: '5' }, mapId: 77, minimumArmyBonus: 5 } as never,
  } as Game;
}

const board = (owner3: number, armies1 = 5): BoardState => ({
  source: 'gamefeed',
  verified: false,
  territories: [
    { territoryId: 1, owner: { kind: 'player', playerId: ANN }, armies: armies1 },
    { territoryId: 2, owner: { kind: 'neutral' }, armies: 2 },
    { territoryId: 3, owner: { kind: 'player', playerId: owner3 }, armies: 4 },
  ],
});

/** A log with a full board on turn 1, a delta on turn 2 (with its replay input), events, join, picks and opponents. */
async function writeLog(dir: string, gameId: number): Promise<void> {
  await updateDecisionLog(
    dir,
    gameId,
    ANN,
    (log): DecisionLog => ({
      ...log,
      status: 'finished',
      turns: {
        '1': { kind: 'observed', source: 'live', board: { kind: 'full', ...board(BOB) } },
        '2': {
          kind: 'planned',
          board: { kind: 'delta', base: 1, source: 'gamefeed', verified: false, changed: [{ territoryId: 1, owner: { kind: 'player', playerId: ANN }, armies: 9 }] },
          input: { goal: 'expand' },
          planner: { version: '0.6.0', build: 'git:abc' },
          times: { plannedAt: '2026-11-20T10:00:00.000Z', sentAt: '2026-11-20T10:00:06.000Z' },
          firstMover: { who: 'me', source: 'award', verified: false },
        } as never,
      },
      events: [{ turn: 2, kind: 'eliminated', player: BOB, at: '2026-11-20T10:01:00.000Z' }],
      join: { at: '2026-11-19T10:00:00.000Z', settingsKey: 'sha256:0123456789abcdef', flags: { format: '1v1', seats: 2 }, policy: { broke: [], passed: ['commerce'], unchecked: [] } } as never,
      opponents: { [String(BOB)]: { firstSeen: 1, level: 12 } },
      picks: { advice: { primary: [1], fallback: [2] } as never, advices: 1 },
    }),
    { mode: 'on' },
  );
}

const CAPTURE = {
  outcome: { result: 'won' as const, turn: 2, outTurn: null, leftTurn: null, winners: [ANN] },
  starts: new Map<number, number[]>(),
  turns: [],
  failedAttacks: [],
};

const MAP_FACTS = {
  me: { territories: [1], bonuses: [], income: [5, 5], income4: null, income8: null },
  winners: [],
};

/** Every source of a finished game: settings record, stored map, log, finished record, map entry, lessons. */
async function finishedGame(dir: string, salt: string, gameId: number): Promise<void> {
  const g = game(gameId);
  await writeGameRecord(dir, g);
  await writeLog(dir, gameId);
  await writeFinishedRecord(
    dir,
    finishedPath(dir, salt, ANN, gameId),
    finishedRecordOf({ salt, me: ANN, status: 'captured', game: g, settings: nameFreeSettings(g), mapId: 77, capture: CAPTURE, boards: [{ turn: 0, board: board(BOB) }, { turn: 1, board: board(ANN) }], kinds: [] }),
  );
  const key = finishedGameKey(salt, ANN, gameId);
  await recordMapGame(dir, 77, { key, format: '1v1', seats: 2, result: 'won', turns: 2, ...MAP_FACTS, kinds: [], settings: { key: null } });
  await recordLessons(dir, { key, format: '1v1', seats: 2, result: 'won', flatAfterTurn: null, howLost: null, calibration: {}, kinds: [] });
}

async function dataDir(): Promise<{ dir: string; salt: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-review-'));
  const salt = (await playerSaltForWrite(dir))!;
  await writeStoredMap(dir, MAP);
  return { dir, salt };
}

describe('reviewGame (#437 task 5)', () => {
  it('joins every source of a finished game, name-free, the encoded boards and replay input left out', async () => {
    const { dir, salt } = await dataDir();
    await finishedGame(dir, salt, 501);
    const r = (await reviewGame(dir, 501))!;
    expect(r).toMatchObject({
      gameId: 501,
      playerId: ANN,
      kinds: [],
      format: '1v1',
      map: { id: 77, name: 'Line', territories: 3 },
      outcome: { result: 'won' },
      sources: { decisionLog: 'present', finished: 'present', settingsRecord: 'present', map: 'present', mapRecord: 'present', lessons: 'present' },
    });
    expect(r.decisionLog?.status).toBe('finished');
    const t2 = r.decisionLog!.turns['2']!;
    expect(t2).toMatchObject({ kind: 'planned', hasInput: true, planner: { build: 'git:abc' }, times: { sentAt: '2026-11-20T10:00:06.000Z' } });
    expect(t2).not.toHaveProperty('board');
    expect(t2).not.toHaveProperty('input');
    expect(r.decisionLog!.turns['1']).toMatchObject({ kind: 'observed', hasInput: false });
    expect(r.events).toEqual([{ turn: 2, kind: 'eliminated', player: BOB, at: '2026-11-20T10:01:00.000Z' }]);
    expect(r.join?.settingsKey).toBe('sha256:0123456789abcdef');
    expect(r.picks?.advices).toBe(1);
    expect(r.opponents?.[String(BOB)]?.level).toBe(12);
    expect(r.finished?.status).toBe('captured');
    expect(r.mapRecord).toMatchObject({ entry: { result: 'won', format: '1v1' } });
    expect(r.lessons).toMatchObject({ entry: { result: 'won', howLost: null } });
    expect(r.game).toEqual({ state: 'Finished', numberOfTurns: 2, players: [{ id: ANN, state: 'Won' }, { id: BOB, state: 'Eliminated' }] });
    const text = JSON.stringify(r);
    for (const name of ['Ann', 'Bob', 'Secret']) expect(text).not.toContain(name);
  });

  it('rebuilds every logged turn’s board on request', async () => {
    const { dir, salt } = await dataDir();
    await finishedGame(dir, salt, 502);
    const r = (await reviewGame(dir, 502, { boards: true }))!;
    expect(r.decisionLog!.turns['1']!.board).toEqual(board(BOB));
    expect(r.decisionLog!.turns['2']!.board).toEqual(board(BOB, 9));
  });

  it('finds a legacy game’s finished record (no log, no board cache) by trying the settings record’s seats', async () => {
    const { dir, salt } = await dataDir();
    const g = game(503);
    await writeGameRecord(dir, g);
    await writeFinishedRecord(dir, finishedPath(dir, salt, ANN, 503), finishedRecordOf({ salt, me: ANN, status: 'read-failed', game: g, mapId: 77, kinds: ['legacy'] }));
    const r = (await reviewGame(dir, 503))!;
    expect(r).toMatchObject({ playerId: ANN, kinds: ['legacy'], decisionLog: null, sources: { decisionLog: 'missing', finished: 'present', mapRecord: 'missing', lessons: 'missing' } });
  });

  it('a running game: no finished record, no kinds; the format from the join context', async () => {
    const { dir } = await dataDir();
    await writeGameRecord(dir, game(504, 'Playing'));
    await writeLog(dir, 504);
    const r = (await reviewGame(dir, 504))!;
    expect(r).toMatchObject({ kinds: null, format: '1v1', outcome: null, turns: 2, finished: null, sources: { finished: 'missing' } });
  });

  it('says a game counted apart was excluded from the map record and the lessons', async () => {
    const { dir, salt } = await dataDir();
    const g = game(505);
    await writeGameRecord(dir, g);
    await writeLog(dir, 505);
    await writeFinishedRecord(dir, finishedPath(dir, salt, ANN, 505), finishedRecordOf({ salt, me: ANN, status: 'captured', game: g, mapId: 77, kinds: ['lottery'] }));
    await recordMapExcluded(dir, 77, finishedGameKey(salt, ANN, 505), 'lottery');
    const r = (await reviewGame(dir, 505))!;
    expect(r.kinds).toEqual(['lottery']);
    expect(r.mapRecord).toEqual({ entry: null, excluded: 'lottery' });
    expect(r.sources.mapRecord).toBe('excluded');
  });

  it('reports an unreadable log, and nothing at all for an unknown game', async () => {
    const { dir } = await dataDir();
    await writeGameRecord(dir, game(506, 'Playing'));
    mkdirSync(decisionsDir(dir), { recursive: true });
    writeFileSync(decisionLogPath(dir, 506), '{');
    expect((await reviewGame(dir, 506))!.sources.decisionLog).toBe('unreadable');
    expect(await reviewGame(dir, 999)).toBeUndefined();
  });
});

describe('reviewGameIds and exportReview (#437 task 5)', () => {
  it('lists every game with a log (readable or not) or a settings record, once each, sorted', async () => {
    const { dir } = await dataDir();
    await writeLog(dir, 602);
    await writeGameRecord(dir, game(601, 'Playing'));
    await writeGameRecord(dir, game(602, 'Playing'));
    mkdirSync(decisionsDir(dir), { recursive: true });
    writeFileSync(decisionLogPath(dir, 603), '{');
    expect(await reviewGameIds(dir)).toEqual([601, 602, 603]);
  });

  it('writes one 0600 file per game and an index into a 0700 folder', async () => {
    const { dir, salt } = await dataDir();
    await finishedGame(dir, salt, 701);
    await writeGameRecord(dir, game(702, 'Playing'));
    const out = join(mkdtempSync(join(tmpdir(), 'warapp-mcp-review-out-')), 'export');
    const r = await exportReview(dir, out);
    expect(r).toEqual({ games: 2, out });
    expect(statSync(out).mode & 0o777).toBe(0o700);
    for (const f of ['index.json', 'game-701.json', 'game-702.json']) expect(statSync(join(out, f)).mode & 0o777, f).toBe(0o600);
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    expect(index.games).toEqual([
      {
        gameId: 701,
        kinds: [],
        format: '1v1',
        mapId: 77,
        mapName: 'Line',
        outcome: 'won',
        turns: 2,
        sources: { decisionLog: 'present', finished: 'present', settingsRecord: 'present', map: 'present', mapRecord: 'present', lessons: 'present' },
      },
      {
        gameId: 702,
        kinds: null,
        format: '1v1',
        mapId: 77,
        mapName: 'Line',
        outcome: null,
        turns: 2,
        sources: { decisionLog: 'missing', finished: 'missing', settingsRecord: 'present', map: 'present', mapRecord: 'missing', lessons: 'missing' },
      },
    ]);
    expect(JSON.parse(readFileSync(join(out, 'game-701.json'), 'utf8')).gameId).toBe(701);
    const all = readFileSync(join(out, 'game-701.json'), 'utf8') + readFileSync(join(out, 'index.json'), 'utf8');
    for (const name of ['Ann', 'Bob', 'Secret']) expect(all).not.toContain(name);
  });

  it('exports one game only with `game`, and refuses a folder others can read', async () => {
    const { dir, salt } = await dataDir();
    await finishedGame(dir, salt, 801);
    await writeGameRecord(dir, game(802, 'Playing'));
    const out = mkdtempSync(join(tmpdir(), 'warapp-mcp-review-out-'));
    expect(await exportReview(dir, out, { game: 801 })).toEqual({ games: 1, out });
    expect(existsSync(join(out, 'game-802.json'))).toBe(false);
    const open = mkdtempSync(join(tmpdir(), 'warapp-mcp-review-open-'));
    chmodSync(open, 0o755);
    await expect(exportReview(dir, open)).rejects.toThrow(/readable by others/);
    await expect(exportReview(dir, out, { game: 999 })).rejects.toThrow(/no data/);
  });
});
