import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardState } from '../src/board.js';
import type { Player } from '../src/normalize.js';
import {
  BOARD_CACHE_MAX_AGE_MS,
  boardCachePath,
  boardFromHistory,
  CACHED_TURNS,
  readBoardCache,
  readBoardHistory,
  writeBoardCache,
} from '../src/trend.js';

// Synthetic GameFeed ids: the in-game id wrapped in two check digits each end.
const ANN = { id: 3312345644, name: 'Ann' } as Player;
const BOB = { id: 7176543229, name: 'Bob' } as Player;
const PLAYERS = [ANN, BOB];

const standing = (bobArmies: number) => [
  { terrID: '1', ownedBy: String(ANN.id), armies: '5', fogLevel: 'Visible' },
  { terrID: '2', ownedBy: '765432', armies: String(bobArmies), fogLevel: 'Visible' },
  { terrID: '3', ownedBy: 'Neutral', armies: '2', fogLevel: 'Fogged' },
];

describe('boardFromHistory', () => {
  it('picks the standing after the requested number of completed turns, in an array of turns', () => {
    const b = boardFromHistory([{ turn: 0, standing: standing(1) }, { turn: 1, standing: standing(3) }], 1, PLAYERS)!;
    expect(b.verified).toBe(false);
    // An in-game owner id is mapped to its GameFeed player id; a GameFeed id stays.
    expect(b.territories).toEqual([
      { territoryId: 1, owner: { kind: 'player', playerId: ANN.id }, armies: 5, fogLevel: 'Visible' },
      { territoryId: 2, owner: { kind: 'player', playerId: BOB.id }, armies: 3, fogLevel: 'Visible' },
      { territoryId: 3, owner: { kind: 'unknown' }, armies: null, fogLevel: 'Fogged' },
    ]);
  });

  it('reads positions, `turns` wrappers and turn-numbered keys', () => {
    const army = (b: BoardState | undefined) => b?.territories.find((t) => t.territoryId === 2)?.armies;
    expect(army(boardFromHistory([standing(1), standing(4)], 1, PLAYERS))).toBe(4);
    expect(army(boardFromHistory({ turns: [standing(1), { standing: standing(6) }] }, 1, PLAYERS))).toBe(6);
    expect(army(boardFromHistory({ turn0: { standing: standing(1) }, turn1: { standing: standing(7) } }, 1, PLAYERS))).toBe(7);
    expect(army(boardFromHistory({ standing2: standing(8), note: 'x' }, 2, PLAYERS))).toBe(8);
    // An owner id belonging to nobody known stays as sent.
    const odd = boardFromHistory([[{ terrID: 2, ownedBy: 99, armies: 1 }]], 0, PLAYERS)!;
    expect(odd.territories[0]!.owner).toEqual({ kind: 'player', playerId: 99 });
  });

  it('is undefined, never a throw, when the turn is missing or the payload is unusable', () => {
    for (const h of [undefined, null, 'x', 42, [], {}, [standing(1)], { turn5: 'nope' }, [[{}]]])
      expect(boardFromHistory(h, 1, PLAYERS)).toBeUndefined();
    const hostile = {};
    Object.defineProperty(hostile, 'turns', {
      get() {
        throw new Error('boom');
      },
    });
    expect(boardFromHistory(hostile, 1, PLAYERS)).toBeUndefined();
  });
});

describe('board cache', () => {
  const board: BoardState = {
    source: 'browser',
    verified: true,
    territories: [
      { territoryId: 1, owner: { kind: 'player', playerId: ANN.id }, armies: 5 },
      { territoryId: 3, owner: { kind: 'unknown' }, armies: null, fogLevel: 'Fogged' },
    ],
  };
  it('prunes the cached boards of games not planned for a long while (#131)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-trend-'));
    mkdirSync(join(dir, 'boards'), { recursive: true });
    const old = boardCachePath(dir, 7);
    const recent = boardCachePath(dir, 8);
    writeFileSync(old, '{}');
    writeFileSync(recent, '{}');
    writeFileSync(join(dir, 'boards', 'notes.txt'), 'keep');
    const longAgo = (Date.now() - BOARD_CACHE_MAX_AGE_MS - 86_400_000) / 1000;
    utimesSync(old, longAgo, longAgo);
    expect(await writeBoardCache(dir, 42, ANN.id, 3, board)).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(boardCachePath(dir, 42))).toBe(true);
    expect(existsSync(join(dir, 'boards', 'notes.txt'))).toBe(true);
  });


  it('round-trips the board for the same game, player and turn only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-trend-'));
    expect(await writeBoardCache(dir, 42, ANN.id, 3, board)).toBe(true);
    expect(JSON.parse(readFileSync(boardCachePath(dir, 42), 'utf8'))).toEqual({
      gameId: 42,
      playerId: ANN.id,
      turns: { '3': board },
    });
    expect(await readBoardCache(dir, 42, ANN.id, 3)).toEqual(board);
    expect(await readBoardCache(dir, 42, ANN.id, 2)).toBeUndefined();
    expect(await readBoardCache(dir, 42, BOB.id, 3)).toBeUndefined();
    expect(await readBoardCache(dir, 43, ANN.id, 3)).toBeUndefined();
  });

  it(`keeps the newest ${CACHED_TURNS} turns, so opponent tracking has a history and re-planning a turn still finds the one before it`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-trend-'));
    const at = (armies: number): BoardState => ({
      ...board,
      territories: [{ territoryId: 1, owner: { kind: 'player', playerId: ANN.id }, armies }],
    });
    await writeBoardCache(dir, 42, ANN.id, 3, at(3));
    await writeBoardCache(dir, 42, ANN.id, 4, at(4));
    await writeBoardCache(dir, 42, ANN.id, 4, at(44)); // turn 4 planned again
    expect(await readBoardCache(dir, 42, ANN.id, 3)).toEqual(at(3));
    expect(await readBoardCache(dir, 42, ANN.id, 4)).toEqual(at(44));
    for (let t = 5; t <= CACHED_TURNS + 3; t++) await writeBoardCache(dir, 42, ANN.id, t, at(t));
    // Turns 3 … CACHED_TURNS + 3: the oldest one is dropped.
    expect(await readBoardCache(dir, 42, ANN.id, 3)).toBeUndefined();
    expect(await readBoardCache(dir, 42, ANN.id, 4)).toEqual(at(44));
    expect(Object.keys((JSON.parse(readFileSync(boardCachePath(dir, 42), 'utf8')) as { turns: object }).turns)).toEqual(
      Array.from({ length: CACHED_TURNS }, (_, i) => String(i + 4)),
    );
    // Another player's plan replaces the file rather than mixing two views.
    await writeBoardCache(dir, 42, BOB.id, 5, at(9));
    expect(await readBoardCache(dir, 42, ANN.id, 4)).toBeUndefined();
    expect(await readBoardCache(dir, 42, BOB.id, 5)).toEqual(at(9));
  });

  it('reads the whole cached history, oldest first, below a turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-trend-'));
    const at = (armies: number): BoardState => ({
      ...board,
      territories: [{ territoryId: 1, owner: { kind: 'player', playerId: ANN.id }, armies }],
    });
    expect(await readBoardHistory(dir, 42, ANN.id)).toEqual([]);
    for (const t of [3, 4, 5]) await writeBoardCache(dir, 42, ANN.id, t, at(t));
    expect(await readBoardHistory(dir, 42, ANN.id)).toEqual([
      { turn: 3, board: at(3) },
      { turn: 4, board: at(4) },
      { turn: 5, board: at(5) },
    ]);
    expect((await readBoardHistory(dir, 42, ANN.id, 5)).map((b) => b.turn)).toEqual([3, 4]);
    expect(await readBoardHistory(dir, 42, BOB.id)).toEqual([]);
    mkdirSync(join(dir, 'boards'), { recursive: true });
    writeFileSync(boardCachePath(dir, 9), 'not json');
    expect(await readBoardHistory(dir, 9, ANN.id)).toEqual([]);
  });

  it('reads a single-board cache from before turns were kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-trend-'));
    mkdirSync(join(dir, 'boards'));
    writeFileSync(boardCachePath(dir, 7), JSON.stringify({ gameId: 7, playerId: ANN.id, turn: 2, board }));
    expect(await readBoardCache(dir, 7, ANN.id, 2)).toEqual(board);
    expect(await readBoardCache(dir, 7, ANN.id, 1)).toBeUndefined();
    await writeBoardCache(dir, 7, ANN.id, 3, board);
    expect(await readBoardCache(dir, 7, ANN.id, 2)).toEqual(board);
    expect(await readBoardCache(dir, 7, ANN.id, 3)).toEqual(board);
  });

  it('reads loosely and never throws on a damaged file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-trend-'));
    mkdirSync(join(dir, 'boards'));
    writeFileSync(boardCachePath(dir, 1), 'not json');
    expect(await readBoardCache(dir, 1, ANN.id, 1)).toBeUndefined();
    writeFileSync(boardCachePath(dir, 4), JSON.stringify({ gameId: 4, playerId: ANN.id }));
    expect(await readBoardCache(dir, 4, ANN.id, 1)).toBeUndefined();
    writeFileSync(boardCachePath(dir, 2), JSON.stringify({ gameId: 2, playerId: ANN.id, turn: 1, board: { territories: 'x' } }));
    expect(await readBoardCache(dir, 2, ANN.id, 1)).toBeUndefined();
    writeFileSync(
      boardCachePath(dir, 3),
      JSON.stringify({
        gameId: 3,
        playerId: ANN.id,
        turn: 1,
        board: { source: 'gamefeed', territories: [{ territoryId: 1, owner: { kind: 'neutral' }, armies: 2 }, { bad: true }] },
      }),
    );
    expect(await readBoardCache(dir, 3, ANN.id, 1)).toEqual({
      source: 'gamefeed',
      verified: false,
      territories: [{ territoryId: 1, owner: { kind: 'neutral' }, armies: 2 }],
    });
  });

  it('a failed write reports false instead of throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-trend-'));
    writeFileSync(join(dir, 'boards'), 'a file where the directory should be');
    expect(await writeBoardCache(dir, 1, ANN.id, 1, board)).toBe(false);
  });
});
