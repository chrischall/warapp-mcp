import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  asBool,
  asInt,
  asNum,
  feedErrorOf,
  normalizeGame,
  normalizeMap,
  normalizePlayer,
  normalizeSettings,
} from '../src/normalize.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/gamefeed-lobby-map39905.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('scalar coercion', () => {
  it('asInt reads integer strings and numbers, rejects the rest', () => {
    expect(asInt('-1')).toBe(-1);
    expect(asInt('64154874316')).toBe(64154874316);
    expect(asInt(7)).toBe(7);
    expect(asInt(' 12 ')).toBe(12);
    expect(asInt('1.5')).toBeUndefined();
    expect(asInt('abc')).toBeUndefined();
    expect(asInt('')).toBeUndefined();
    expect(asInt(null)).toBeUndefined();
    expect(asInt(2.5)).toBeUndefined();
  });

  it('asNum reads any finite number or numeric string', () => {
    expect(asNum('0.6')).toBe(0.6);
    expect(asNum(2880.0)).toBe(2880);
    expect(asNum('null')).toBeUndefined();
    expect(asNum(Number.NaN)).toBeUndefined();
  });

  it('asBool reads True/False strings (any case) and booleans', () => {
    expect(asBool('True')).toBe(true);
    expect(asBool('False')).toBe(false);
    expect(asBool('true')).toBe(true);
    expect(asBool(false)).toBe(false);
    expect(asBool('yes')).toBeUndefined();
    expect(asBool(undefined)).toBeUndefined();
  });
});

describe('feedErrorOf', () => {
  it('returns the error string of an error body', () => {
    expect(feedErrorOf({ termsOfUse: 'x', error: 'Auth failed' })).toBe('Auth failed');
  });
  it('returns undefined for a game body or a non-object', () => {
    expect(feedErrorOf({ id: '1' })).toBeUndefined();
    expect(feedErrorOf(null)).toBeUndefined();
    expect(feedErrorOf({ error: 42 })).toBeUndefined();
  });
});

describe('normalizeMap (lobby fixture, map 39905)', () => {
  const map = normalizeMap(FIXTURE.map);

  it('reads id, name and every territory and bonus', () => {
    expect(map.id).toBe(39905);
    expect(map.name).toBe('A Song of Westeros and the Free Cities');
    expect(map.territories).toHaveLength(761);
    expect(map.bonuses).toHaveLength(372);
  });

  it('types territories: numeric id, parsed coords, numeric neighbours', () => {
    const t = map.territories.find((x) => x.id === 1)!;
    expect(t).toEqual({ id: 1, name: 'Lands of Always Winter', coords: { x: 230.55, y: 216.7 }, connectedTo: [3120, 2, 3] });
  });

  it('has a symmetric adjacency graph', () => {
    const byId = new Map(map.territories.map((t) => [t.id, t]));
    for (const t of map.territories) {
      for (const n of t.connectedTo) expect(byId.get(n)?.connectedTo).toContain(t.id);
    }
  });

  it('types bonuses, keeping zero and negative values', () => {
    expect(map.bonuses.find((b) => b.id === 1)).toEqual({
      id: 1,
      name: 'House Stark',
      value: 6,
      territoryIds: [4266622],
      bonusIds: [],
    });
    expect(map.bonuses.find((b) => b.name === 'The Sorrows')?.value).toBe(-4);
    expect(map.bonuses.find((b) => b.name === 'Iron Islands Ships 1')?.value).toBe(0);
  });

  it('reads an id that is both a territory id and a bonus id as a territory', () => {
    // Ids 1..382 name both territories and bonuses on this map; a bonus member
    // is a territory whenever one exists (e.g. "The Twins" in House Frey).
    const frey = map.bonuses.find((b) => b.name === 'House Frey')!;
    expect(frey.territoryIds).toContain(273);
    expect(frey.bonusIds).toEqual([]);
    expect(map.bonuses.every((b) => b.bonusIds.length === 0)).toBe(true);
  });

  it('reads distribution modes', () => {
    expect(map.distributionModes[0]).toEqual({ id: 1, name: 'All Capitals/Cities/Ruins', type: 'normal' });
  });
});

describe('normalizeMap (superbonuses)', () => {
  const raw = {
    id: '7',
    name: 'Tiny',
    territories: [
      { id: '1', name: 'A', coords: '1,2', connectedTo: [2] },
      { id: '2', name: 'B', connectedTo: ['1', 3] },
      { id: '3', name: 'C', coords: 'garbage', connectedTo: [2] },
    ],
    bonuses: [
      { id: '10', name: 'AB', value: '2', territoryIDs: [1, 2] },
      { id: '11', name: 'C', value: '1', territoryIDs: [3] },
      { id: '20', name: 'Super', value: '5', territoryIDs: [10, 11, 99] },
    ],
  };

  it('splits a bonus member into territoryIds vs bonusIds, and drops unknown ids into unknownIds', () => {
    const map = normalizeMap(raw);
    expect(map.bonuses.find((b) => b.id === 20)).toEqual({
      id: 20,
      name: 'Super',
      value: 5,
      territoryIds: [],
      bonusIds: [10, 11],
      unknownIds: [99],
    });
  });

  it('tolerates missing/garbage coords and string neighbour ids', () => {
    const map = normalizeMap(raw);
    expect(map.territories[1]).toEqual({ id: 2, name: 'B', connectedTo: [1, 3] });
    expect(map.territories[2]!.coords).toBeUndefined();
    expect(map.distributionModes).toEqual([]);
  });

  it('throws a format error on a map without territories', () => {
    expect(() => normalizeMap({ id: '1', name: 'x' })).toThrow(/unexpected shape/);
    expect(() => normalizeMap({})).toThrow(/unexpected shape/);
  });
});

describe('normalizePlayer', () => {
  it('turns string scalars into real types', () => {
    expect(
      normalizePlayer({
        id: '64154874316',
        name: 'P',
        isAI: 'False',
        humanTurnedIntoAI: 'True',
        hasCommittedOrders: 'True',
        color: '#ff7d00',
        state: 'Playing',
      }),
    ).toEqual({
      id: 64154874316,
      name: 'P',
      isAI: false,
      humanTurnedIntoAI: true,
      hasCommittedOrders: true,
      color: '#ff7d00',
      state: 'Playing',
    });
  });
});

describe('normalizeSettings', () => {
  const s = normalizeSettings(FIXTURE.settings);

  it('digests the strategy-relevant settings', () => {
    expect(s).toMatchObject({
      mapId: 39905,
      pace: 'MultiDay',
      fog: 'Foggy',
      offensiveKillRate: 60,
      defensiveKillRate: 70,
      luckModifier: 0,
      roundingMode: 'StraightRound',
      oneArmyStandsGuard: true,
      minimumArmyBonus: 5,
      bonusArmyPer: 0,
      armyCap: null,
      multiAttack: false,
      localDeployments: false,
      commanders: false,
      distributionMode: 1,
      territoryLimit: 3,
      initialPlayerArmiesPerTerritory: 8,
      initialNonDistributionArmies: 2,
    });
  });

  it('lists enabled cards only', () => {
    expect(s.cards).toEqual(['Reinforcement', 'Blockade', 'Airlift', 'Diplomacy', 'Sanctions', 'Reconnaissance']);
  });

  it('keeps the raw settings for the full view', () => {
    expect(s.raw.Map).toBe(39905);
  });

  it('coerces string-typed settings too', () => {
    const t = normalizeSettings({ Map: '5', OffensiveKillRate: '50', OneArmyStandsGuard: 'False', ArmyCap: '100' });
    expect(t.mapId).toBe(5);
    expect(t.offensiveKillRate).toBe(50);
    expect(t.oneArmyStandsGuard).toBe(false);
    expect(t.armyCap).toBe(100);
  });

  it('reads kill rates sent as decimals, so a supplied rate never falls back to 60/70 (G1)', () => {
    const t = normalizeSettings({ OffensiveKillRate: '20.0', DefensiveKillRate: '80.0' });
    expect(t.offensiveKillRate).toBe(20);
    expect(t.defensiveKillRate).toBe(80);
    const u = normalizeSettings({ OffensiveKillRate: 30.0, DefensiveKillRate: 75 });
    expect([u.offensiveKillRate, u.defensiveKillRate]).toEqual([30, 75]);
    expect(normalizeSettings({ OffensiveKillRate: 'x' }).offensiveKillRate).toBeUndefined();
  });
});

describe('normalizeGame (lobby fixture)', () => {
  const game = normalizeGame(FIXTURE);

  it('types the header', () => {
    expect(game).toMatchObject({
      id: 12345678,
      name: 'Synthetic lobby game',
      state: 'WaitingForPlayers',
      numberOfTurns: -1,
      created: '2026-01-01T00:00:00',
      lastTurnTime: '2026-01-01T00:00:00',
    });
  });

  it('types the players', () => {
    expect(game.players).toHaveLength(9);
    expect(game.players[0]).toMatchObject({ id: 1000, isAI: false, hasCommittedOrders: false, state: 'Playing' });
  });

  it('has settings and no standing in a lobby', () => {
    expect(game.settings?.mapId).toBe(39905);
    expect(game.standing).toBeUndefined();
  });

  it('omits settings when the feed did not send them', () => {
    const { settings: _s, ...rest } = FIXTURE;
    expect(normalizeGame(rest).settings).toBeUndefined();
  });

  it('parses a standing (loosely) and passes history and chat through', () => {
    const g = normalizeGame({
      ...FIXTURE,
      state: 'Playing',
      numberOfTurns: '3',
      standing: [{ terrID: '1', ownedBy: '1000', armies: '5', fogLevel: 'Visible' }],
      history: [{ turn: '1' }],
      chat: [{ text: 'hi' }],
    });
    expect(g.numberOfTurns).toBe(3);
    expect(g.standing?.territories).toEqual([
      { territoryId: 1, owner: { kind: 'player', playerId: 1000 }, armies: 5, fogLevel: 'Visible' },
    ]);
    expect(g.standing?.verified).toBe(false);
    expect(g.history).toEqual([{ turn: '1' }]);
    expect(g.chat).toEqual([{ text: 'hi' }]);
  });

  it('throws a format error when the body is not a game', () => {
    expect(() => normalizeGame({ termsOfUse: 'x' })).toThrow(/unexpected shape/);
  });
});
