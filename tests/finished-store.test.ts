// The end-of-game records (#312 E1): bounded, and a record's state read loosely. Synthetic only.
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TerritoryOwner } from '../src/board.js';
import { finishedDir, finishedPath, finishedRecordOf, historyOfRecord, readFinishedRecord, readFinishedState, touchFinished, writeFinishedRecord, type FinishedRecord } from '../src/finished-store.js';
import { playerKey } from '../src/player-record-store.js';

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

  it('never prunes a protected record, nor the one just written; a touched record counts as new', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-fin-'));
    const rec = finishedRecordOf({ salt: SALT, me: 1001, status: 'read-failed' });
    const at = (g: number) => finishedPath(dir, SALT, 1001, g);
    for (const g of [1, 2, 3]) {
      await writeFinishedRecord(dir, at(g), rec, 3);
      utimesSync(at(g), g, g);
    }
    await touchFinished(at(2)); // most recently used now
    await writeFinishedRecord(dir, at(4), rec, 3, new Set([at(1)]));
    // Over by one: 3 goes (the oldest unprotected); 1 is protected, 2 was touched, 4 was just written.
    expect(readdirSync(finishedDir(dir))).toHaveLength(3);
    expect(await readFinishedState(at(3))).toBe('missing');
    for (const g of [1, 2, 4]) expect(await readFinishedState(at(g))).toEqual({ status: 'read-failed' });
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

describe('the history boards in a captured record (#318: the one read feeds the harness)', () => {
  const ANN = 4412345677;
  const BOB = 7176543229;
  const t = (territoryId: number, owner: TerritoryOwner, armies: number | null, fogLevel?: string) => ({ territoryId, owner, armies, ...(fogLevel ? { fogLevel } : {}) });
  const p = (playerId: number): TerritoryOwner => ({ kind: 'player', playerId });
  const boards = [
    { turn: 0, board: { source: 'gamefeed' as const, verified: false, territories: [t(1, p(ANN), 5, 'Visible'), t(2, { kind: 'neutral' }, 2), t(3, { kind: 'available' }, 0)] } },
    {
      turn: 1,
      board: {
        source: 'gamefeed' as const,
        verified: false,
        territories: [t(1, p(ANN), 4), t(2, p(BOB), 3, 'Fogged'), t(3, { kind: 'unknown', raw: '99887766' }, null), t(4, p(55443322), 7)],
      },
    },
  ];
  const players = [
    { id: ANN, name: 'Ann', isAI: false, humanTurnedIntoAI: false, hasCommittedOrders: false, state: 'Eliminated' },
    { id: BOB, name: 'Bob', isAI: false, humanTurnedIntoAI: false, hasCommittedOrders: false, state: 'Won', team: 1 },
  ];
  const rec = () =>
    finishedRecordOf({
      salt: SALT,
      me: ANN,
      status: 'captured',
      game: { players, settings: undefined, name: 'Secret', numberOfTurns: 1 } as never,
      boards,
    });

  it('keeps the boards compactly, owners by player key, never an id or a raw owner value', () => {
    const r = rec();
    expect(r.boardOwners).toEqual([playerKey(SALT, ANN), playerKey(SALT, BOB)]);
    // Board 1 lists another set of territories, so it is kept whole.
    expect(r.boards).toEqual([
      { turn: 0, t: [[1, 0, 5], [2, -1, 2], [3, -2, 0]] },
      { turn: 1, t: [[1, 0, 4], [2, 1, 3, 'Fogged'], [3, -3, null], [4, -3, 7]] },
    ]);
    const text = JSON.stringify(r);
    for (const s of [String(ANN), String(BOB), '99887766', '55443322', 'Ann', 'Bob', 'Secret']) expect(text).not.toContain(s);
  });

  it('keeps a board listing the same territories as the one before it as the changes only, and reads it back whole', () => {
    const same = [
      boards[1]!,
      { turn: 2, board: { source: 'gamefeed' as const, verified: false, territories: [t(1, p(ANN), 4), t(2, p(ANN), 1), t(3, { kind: 'neutral' }, 2), t(4, p(55443322), 7)] } },
      { turn: 3, board: { source: 'gamefeed' as const, verified: false, territories: [t(1, p(ANN), 4), t(2, p(ANN), 1), t(3, { kind: 'neutral' }, 2), t(4, p(55443322), 7)] } },
    ];
    const r = finishedRecordOf({ salt: SALT, me: ANN, status: 'captured', game: { players, settings: undefined, name: 'x', numberOfTurns: 3 } as never, boards: same });
    expect(r.boards!.slice(1)).toEqual([
      { turn: 2, d: true, t: [[2, 0, 1], [3, -1, 2]] },
      { turn: 3, d: true, t: [] },
    ]);
    const back = historyOfRecord(r, SALT, [ANN, BOB]);
    const unknownOwner = (b: (typeof same)[number]) => ({ ...b, board: { ...b.board, territories: b.board.territories.map((x) => (x.territoryId === 3 || x.territoryId === 4) && x.owner.kind !== 'neutral' ? { ...x, owner: { kind: 'unknown' as const } } : x) } });
    expect(typeof back === 'object' && back.boards).toEqual(same.map(unknownOwner));
  });

  it('keeps no boards for a failed pass', () => {
    const r = finishedRecordOf({ salt: SALT, me: ANN, status: 'history-unreadable', boards });
    expect(r.boards).toBeUndefined();
    expect(r.boardOwners).toBeUndefined();
  });

  it('reads the history back by id, given the ids the caller knows (the keys are never reversed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-fin-'));
    const path = finishedPath(dir, SALT, ANN, 9);
    await writeFinishedRecord(dir, path, rec());
    const stored = await readFinishedRecord(path);
    expect(stored).not.toBe('missing');
    const h = historyOfRecord(stored as FinishedRecord, SALT, [BOB, ANN]);
    expect(h).toEqual({
      me: ANN,
      numberOfTurns: null,
      players: [
        { id: ANN, isAI: false, state: 'Eliminated' },
        { id: BOB, isAI: false, team: 1, state: 'Won' },
      ],
      boards: [
        { turn: 0, board: { source: 'gamefeed', verified: false, territories: [t(1, p(ANN), 5), t(2, { kind: 'neutral' }, 2), t(3, { kind: 'available' }, 0)] } },
        {
          turn: 1,
          board: {
            source: 'gamefeed',
            verified: false,
            territories: [t(1, p(ANN), 4), t(2, p(BOB), 3, 'Fogged'), t(3, { kind: 'unknown' }, null), t(4, { kind: 'unknown' }, 7)],
          },
        },
      ],
    });
    // My key among none of the ids: no history; a key not matched reads as an unknown owner.
    expect(historyOfRecord(stored as FinishedRecord, SALT, [BOB])).toBe('unmatched');
    const onlyMe = historyOfRecord(stored as FinishedRecord, SALT, [ANN]);
    expect(typeof onlyMe === 'object' && onlyMe.boards[1]!.board.territories[1]!.owner).toEqual({ kind: 'unknown' });
    expect(historyOfRecord(finishedRecordOf({ salt: SALT, me: ANN, status: 'read-failed' }), SALT, [ANN])).toBe('no-boards');
  });

  it('reads a missing or unparsable record as such', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-fin-'));
    const path = finishedPath(dir, SALT, ANN, 10);
    expect(await readFinishedRecord(path)).toBe('missing');
    mkdirSync(finishedDir(dir), { recursive: true });
    writeFileSync(path, '{');
    expect(await readFinishedRecord(path)).toBe('unreadable');
  });
});
