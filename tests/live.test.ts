import { describe, expect, it } from 'vitest';
import {
  inGameId,
  LiveBoardFormatError,
  playersByInGameId,
  readLiveStanding,
  boardStateFromLive,
  toBoardState,
  type ClassReader,
} from '../src/live.js';
import { normalizePlayer, type Player } from '../src/normalize.js';
import { Reader, Writer } from '../src/protocol/codec.js';
import { WarappBundle } from '../src/protocol/bundle.js';
import { LIVE_BUNDLE, writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';

const bundle = new WarappBundle(LIVE_BUNDLE, 'test');

function body(territories: SyntheticTerritory[] | null, players: number[] = []): Reader {
  const w = new Writer();
  writeLatestGameInfo(w, territories, players);
  return new Reader(w.bytes());
}

const player = (id: string, name: string): Player => normalizePlayer({ id, name });

describe('inGameId', () => {
  it('drops the two leading and two trailing check digits', () => {
    expect(inGameId({ id: 31123456729 })).toBe(1234567);
    expect(inGameId({ id: 5076543288 })).toBe(765432);
  });

  it('the check digits vary per player — not a fixed 64…16 wrapper', () => {
    expect(inGameId({ id: 6412345616 })).toBe(123456);
    expect(inGameId({ id: 9912345601 })).toBe(123456);
  });

  it('keeps the digits GameFeed sent when the number would lose a leading zero', () => {
    const p = player('0712345698', 'Zero');
    expect(p.id).toBe(712345698);
    expect(p.feedId).toBe('0712345698');
    expect(inGameId(p)).toBe(123456);
    expect(player('3312345644', 'Plain').feedId).toBeUndefined();
  });

  it('refuses an id too short to carry check digits', () => {
    expect(() => inGameId({ id: 1000 })).toThrow(/not a GameFeed player id/);
  });

  it('playersByInGameId skips ids that cannot be unwrapped', () => {
    const map = playersByInGameId([player('1000', 'Short'), player('3312345644', 'Ann')]);
    expect([...map.keys()]).toEqual([123456]);
  });
});

describe('readLiveStanding', () => {
  it('reads every territory standing in the pick phase', () => {
    const r = body([
      { id: 1, fogLevel: 2, owner: -2, armies: 2 },
      { id: 2, fogLevel: 2, owner: 0, armies: 4 },
    ]);
    expect(readLiveStanding(bundle, r)).toEqual([
      { territoryId: 1, fogLevel: 2, fogged: false, owner: -2, armies: 2 },
      { territoryId: 2, fogLevel: 2, fogged: false, owner: 0, armies: 4 },
    ]);
    expect(r.remaining).toBe(0);
  });

  it('mid-game: a fogged territory has no armies', () => {
    const out = readLiveStanding(
      bundle,
      body(
        [
          { id: 7, fogLevel: 1, owner: 123456, armies: 5 },
          { id: 8, fogLevel: 4, owner: -1, armies: 0, fogged: true },
        ],
        [123456],
      ),
    );
    expect(out).toEqual([
      { territoryId: 7, fogLevel: 1, fogged: false, owner: 123456, armies: 5 },
      { territoryId: 8, fogLevel: 4, fogged: true, owner: -1, armies: null },
    ]);
  });

  it('no result, or no standing, is null', () => {
    const w = new Writer();
    w.bool(false);
    expect(readLiveStanding(bundle, new Reader(w.bytes()))).toBeNull();
    expect(readLiveStanding(bundle, body(null))).toBeNull();
  });

  it('a standing with no territory dict is null', () => {
    const fake: ClassReader = {
      readClass: () => ({ $type: 'x', s: { $type: 'warlight.shared.GameStanding', a: [], b: null } }),
    };
    const w = new Writer();
    w.bool(true);
    expect(readLiveStanding(fake, new Reader(w.bytes()))).toBeNull();
  });

  const reading = (info: unknown) => {
    const fake: ClassReader = { readClass: () => info };
    const w = new Writer();
    w.bool(true);
    return () => readLiveStanding(fake, new Reader(w.bytes()));
  };
  const ts = (o: Record<string, unknown>) => ({ $type: 'warlight.shared.TerritoryStanding', ...o });
  const armies = { $type: 'warlight.shared.Armies', f: false, n: 3 };
  const standing = (list: unknown) => ({ $type: 'L', s: { $type: 'warlight.shared.GameStanding', t: list } });

  it('rejects a layout it cannot read rather than guessing', () => {
    expect(reading(null)).toThrow(LiveBoardFormatError);
    expect(reading(standing([[3, ts({ a: 1, b: 3 })]]))).toThrow(/lacks its fields/);
    expect(reading(standing([[3, ts({ a: 1, b: 9, c: armies, d: 0 })]]))).toThrow(/standing 3 reads as territory 9/);
  });

  it('accepts a plain list of standings', () => {
    expect(reading(standing([ts({ a: 1, b: 3, c: armies, d: 0 })]))()).toEqual([
      { territoryId: 3, fogLevel: 1, fogged: false, owner: 0, armies: 3 },
    ]);
  });
});

describe('toBoardState', () => {
  it('keys players by GameFeed id and names every owner kind', () => {
    const players = [player('3312345644', 'Ann')];
    const board = toBoardState(
      [
        { territoryId: 1, fogLevel: 1, fogged: false, owner: 123456, armies: 5 },
        { territoryId: 2, fogLevel: 2, fogged: false, owner: 0, armies: 2 },
        { territoryId: 3, fogLevel: 2, fogged: false, owner: -2, armies: 2 },
        { territoryId: 4, fogLevel: 4, fogged: true, owner: -1, armies: null },
        { territoryId: 5, fogLevel: 1, fogged: false, owner: 777, armies: 1 },
        { territoryId: 6, fogLevel: 3, fogged: false, owner: -5, armies: 1 },
      ],
      players,
    );
    expect(board.source).toBe('browser');
    expect(board.verified).toBe(true);
    expect(board.territories.map((t) => t.owner)).toEqual([
      { kind: 'player', playerId: 3312345644 },
      { kind: 'neutral' },
      { kind: 'available' },
      { kind: 'unknown' },
      { kind: 'player', playerId: 777 },
      { kind: 'unknown' },
    ]);
    expect(board.territories.map((t) => t.fogLevel)).toEqual(['Visible', 'OwnerOnly', 'OwnerOnly', 'Fogged', 'Visible', '3']);
  });
});

describe('boardStateFromLive', () => {
  const me = player('3312345644', 'Me');
  const other = player('5576543288', 'Other');
  const live = [
    { territoryId: 1, fogLevel: 1, fogged: false, owner: 123456, armies: 5 },
    { territoryId: 2, fogLevel: 1, fogged: false, owner: 765432, armies: 4 },
    { territoryId: 3, fogLevel: 2, fogged: false, owner: 0, armies: 2 },
    { territoryId: 4, fogLevel: 2, fogged: false, owner: -2, armies: 2 },
    { territoryId: 5, fogLevel: 4, fogged: true, owner: 123456, armies: null },
  ];

  it('keys my territories by my GameFeed id and names every owner kind', () => {
    const board = boardStateFromLive(live, me, [other]);
    expect(board.source).toBe('browser');
    expect(board.verified).toBe(true);
    expect(board.territories.map((t) => t.owner)).toEqual([
      { kind: 'player', playerId: 3312345644 },
      { kind: 'player', playerId: 5576543288 },
      { kind: 'neutral' },
      { kind: 'available' },
      { kind: 'unknown' },
    ]);
    expect(board.territories.map((t) => t.armies)).toEqual([5, 4, 2, 2, null]);
  });

  it('works with only me known, other players keeping their in-game id', () => {
    const board = boardStateFromLive(live, me);
    expect(board.territories[0]!.owner).toEqual({ kind: 'player', playerId: 3312345644 });
    expect(board.territories[1]!.owner).toEqual({ kind: 'player', playerId: 765432 });
  });

  it('does not duplicate me when the player list already has me', () => {
    const board = boardStateFromLive(live, me, [me, other]);
    expect(board.territories[0]!.owner).toEqual({ kind: 'player', playerId: 3312345644 });
  });
});
