import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardState } from '../src/board.js';
import { writeStoredMap } from '../src/map-store.js';
import { normalizeGame, normalizeMap, type Game } from '../src/normalize.js';
import {
  gameRecordPath,
  loadReplay,
  MAX_GAME_RECORDS,
  readGameRecord,
  sanitizeSettings,
  writeGameRecord,
} from '../src/replay.js';
import { writeBoardCache, writeOrdersCache } from '../src/trend.js';
import { mapOf } from '../src/tools/map.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/gamefeed-lobby-map39905.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const tmp = () => mkdtempSync(join(tmpdir(), 'warapp-replay-'));

/** The fixture as a game in progress, with a few settings the planner reads and some text that must not be kept. */
function gameOf(over: Record<string, unknown> = {}, id = 12345678): Game {
  const settings = {
    ...(FIXTURE.settings as Record<string, unknown>),
    PersonalMessage: 'Hello from Player 1, good luck',
    LocalDeployments: 'True',
    Commanders: true,
    LuckModifier: '0.16',
    OffensiveKillRate: '55',
    OverriddenBonuses: [{ bonusID: 1, value: 9 }],
    Mods: [{ Name: 'Some mod', Id: 3 }],
    SomeNewSetting: 'Player 2',
    ...over,
  };
  const players = (FIXTURE.players as Record<string, unknown>[]).map((p, i) => (i < 2 ? { ...p, team: String(i) } : p));
  const g = normalizeGame({ ...FIXTURE, id: String(id), state: 'Playing', numberOfTurns: '4', players, settings });
  g.map = normalizeMap(FIXTURE.map);
  return g;
}

const board = (armies: number): BoardState => ({
  source: 'browser',
  verified: true,
  territories: [{ territoryId: 1, owner: { kind: 'player', playerId: 1000 }, armies }],
});

describe('the per-game replay record', () => {
  it('writes <dir>/games/<gameId>.json, 0600 in a 0700 folder, atomically', async () => {
    const dir = tmp();
    expect(await writeGameRecord(dir, gameOf())).toBe(true);
    const path = gameRecordPath(dir, 12345678);
    expect(path).toBe(join(dir, 'games', '12345678.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'games')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(dir, 'games'))).toEqual(['12345678.json']);
  });

  it('is name-free: no player name, game name, personal message or mod text', async () => {
    const dir = tmp();
    await writeGameRecord(dir, gameOf());
    const text = readFileSync(gameRecordPath(dir, 12345678), 'utf8');
    for (const s of ['Player 1', 'Player 2', 'Synthetic lobby game', 'Hello', 'Some mod', 'PersonalMessage']) expect(text).not.toContain(s);
  });

  it('keeps what a plan needs: the settings read back as the game had them, players by id and team', async () => {
    const dir = tmp();
    const g = gameOf();
    await writeGameRecord(dir, g);
    const back = await readGameRecord(dir, 12345678);
    expect(back).toBeDefined();
    const s = back!.settings!;
    const o = g.settings!;
    for (const k of [
      'mapId', 'pace', 'fog', 'offensiveKillRate', 'defensiveKillRate', 'luckModifier', 'roundingMode', 'moveOrder',
      'oneArmyStandsGuard', 'minimumArmyBonus', 'bonusArmyPer', 'armyCap', 'multiAttack', 'localDeployments', 'noSplit',
      'commanders', 'allowTransferOnly', 'allowAttackOnly', 'allowPercentageAttacks', 'distributionMode', 'territoryLimit',
      'initialPlayerArmiesPerTerritory', 'initialNonDistributionArmies', 'initialNeutralsInDistribution', 'cards',
      'overriddenBonuses', 'wastelands', 'commerce', 'mods',
    ] as const) {
      expect([k, s[k]]).toEqual([k, o[k]]);
    }
    expect(s.offensiveKillRate).toBe(55);
    expect(s.localDeployments).toBe(true);
    expect(s.overriddenBonuses).toEqual(new Map([[1, 9]]));
    expect(s.mods).toBe(1);
    expect(s.raw.ReinforcementCard).toEqual((o.raw as Record<string, unknown>).ReinforcementCard);
    expect(s.raw.MaxCardsHold).toBe(5);
    expect(back!.endRules).toEqual(g.endRules);
    expect(back!.id).toBe(12345678);
    expect(back!.state).toBe('Playing');
    expect(back!.numberOfTurns).toBe(4);
    expect(back!.players.map((p) => [p.id, p.team, p.state, p.isAI])).toEqual(g.players.map((p) => [p.id, p.team, p.state, p.isAI]));
    expect(back!.players.every((p) => p.name === String(p.id))).toBe(true);
  });

  it('keeps an unreadable override list flagged as unreadable', async () => {
    const dir = tmp();
    await writeGameRecord(dir, gameOf({ OverriddenBonuses: 'not json' }));
    expect((await readGameRecord(dir, 12345678))!.settings!.overriddenBonusesUnparsed).toBe(true);
  });

  it('writes nothing for a game without settings, and never throws', async () => {
    const dir = tmp();
    const g = gameOf();
    delete g.settings;
    expect(await writeGameRecord(dir, g)).toBe(false);
    const bad = tmp();
    writeFileSync(join(bad, 'games'), 'a file, not a folder');
    expect(await writeGameRecord(bad, gameOf())).toBe(false);
  });

  it('reads a bad, foreign or other-version file as nothing', async () => {
    const dir = tmp();
    expect(await readGameRecord(dir, 5)).toBeUndefined();
    mkdirSync(join(dir, 'games'));
    writeFileSync(gameRecordPath(dir, 5), '{');
    expect(await readGameRecord(dir, 5)).toBeUndefined();
    writeFileSync(gameRecordPath(dir, 5), JSON.stringify({ version: 1, gameId: 6, state: 'Playing', players: [], settings: {} }));
    expect(await readGameRecord(dir, 5)).toBeUndefined();
    writeFileSync(gameRecordPath(dir, 5), JSON.stringify({ version: 9, gameId: 5, state: 'Playing', players: [], settings: {} }));
    expect(await readGameRecord(dir, 5)).toBeUndefined();
    writeFileSync(gameRecordPath(dir, 5), JSON.stringify({ version: 1, gameId: 5, state: 'Playing', players: [{ id: 'x' }, 7], settings: {} }));
    expect((await readGameRecord(dir, 5))!.players).toEqual([]);
  });

  it(`keeps the newest ${MAX_GAME_RECORDS} games`, async () => {
    const dir = tmp();
    for (let i = 1; i <= MAX_GAME_RECORDS; i++) {
      await writeGameRecord(dir, gameOf({}, i));
      utimesSync(gameRecordPath(dir, i), Date.now() / 1000 - 1000 + i, Date.now() / 1000 - 1000 + i);
    }
    await writeGameRecord(dir, gameOf({}, 99999));
    const names = readdirSync(join(dir, 'games'));
    expect(names).toHaveLength(MAX_GAME_RECORDS);
    expect(names).not.toContain('1.json');
    expect(names).toContain('99999.json');
  });
});

describe('sanitizeSettings', () => {
  it('keeps numbers, booleans, numeric strings and the enum settings; drops free text and player names', () => {
    const out = sanitizeSettings(
      { Fog: 'Foggy', Pace: 'Player', Weird: 'Bob', Num: '12.5', Flag: 'False', N: null, Card: { Mode: 1, Note: 'hi there' }, Deep: { a: { b: { c: { d: 1 } } } } },
      ['player'],
    );
    expect(out).toEqual({ Fog: 'Foggy', Num: '12.5', Flag: 'False', N: null, Card: { Mode: 1 }, Deep: { a: { b: {} } } });
  });
});

describe('loadReplay', () => {
  it('rebuilds the planner inputs offline: the game, its settings, the stored map and the cached boards', async () => {
    const dir = tmp();
    const g = gameOf();
    await writeStoredMap(dir, g.map!);
    await writeGameRecord(dir, g);
    await writeBoardCache(dir, g.id, 1000, 3, board(4));
    await writeBoardCache(dir, g.id, 1000, 4, board(6));
    await writeOrdersCache(dir, g.id, 1000, 3, { deploys: [{ territoryId: 1, armies: 2 }], moves: [] });
    const r = await loadReplay(dir, g.id);
    expect(r).toBeDefined();
    expect(r!.playerId).toBe(1000);
    expect(r!.boards.map((b) => b.turn)).toEqual([3, 4]);
    expect(r!.boards[1]!.board).toEqual(board(6));
    expect(r!.orders.get(3)).toEqual({ deploys: [{ territoryId: 1, armies: 2 }], moves: [] });
    expect(r!.map).toEqual(g.map);
    expect(r!.game.map).toEqual(g.map);
    expect(r!.settings.mapId).toBe(39905);
    // Overrides apply per game, on top of the stored base values.
    expect(mapOf(r!.game).bonuses.find((b) => b.id === 1)!.value).toBe(9);
    expect(r!.map!.bonuses.find((b) => b.id === 1)!.value).toBe(g.map!.bonuses.find((b) => b.id === 1)!.value);
  });

  it('gives the record without a map or boards when those are not cached', async () => {
    const dir = tmp();
    await writeGameRecord(dir, gameOf());
    const r = await loadReplay(dir, 12345678);
    expect(r!.map).toBeUndefined();
    expect(r!.game.map).toBeUndefined();
    expect(r!.boards).toEqual([]);
    expect(r!.playerId).toBeUndefined();
  });

  it('is undefined when the game has no record', async () => {
    expect(await loadReplay(tmp(), 1)).toBeUndefined();
  });
});
