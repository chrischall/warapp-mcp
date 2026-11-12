import { describe, expect, it } from 'vitest';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { analyzePlayer } from '../../src/analysis/player.js';
import { board, fixtureMap, fixtureSettings, fogged, mine, neutral, tinyMap } from './helpers.js';

describe('armiesToTake (straight round, no luck)', () => {
  it('matches the standard 60/70 table', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map((d) => armiesToTake(d))).toEqual([1, 2, 3, 5, 6, 8, 16]);
  });

  it('uses custom kill rates', () => {
    expect(armiesToTake(2, { offensiveKillRate: 100, defensiveKillRate: 0 })).toBe(2);
    expect(armiesToTake(4, { offensiveKillRate: 50, defensiveKillRate: 70 })).toBe(7);
  });

  it('needs survivors to move in under a heavy defensive rate', () => {
    expect(armiesToTake(2, { offensiveKillRate: 100, defensiveKillRate: 100 })).toBe(3);
  });

  it('returns null when attackers cannot kill', () => {
    expect(armiesToTake(1, { offensiveKillRate: 0 })).toBeNull();
    expect(armiesToTake(0, { offensiveKillRate: 0 })).toBe(1);
  });
});

describe('analyzePlayer', () => {
  const g = buildGraph(tinyMap());
  const state = board([
    mine(1, 2),
    mine(2, 2),
    mine(3, 3),
    mine(4, 4),
    mine(5, 5, 20),
    fogged(6),
    mine(7, 9, 20),
  ]);

  it('computes income from base and held bonuses', () => {
    const a = analyzePlayer(g, state, 10, fixtureSettings());
    expect(a.territoryCount).toBe(4);
    expect(a.armies).toBe(11);
    expect(a.heldBonusIds).toEqual([101]);
    expect(a.income).toEqual({
      base: 5,
      perTerritory: 0,
      bonuses: [{ bonusId: 101, name: 'A', value: 3 }],
      total: 8,
    });
  });

  it('adds the per-territory bonus and counts negative held bonuses', () => {
    const map = tinyMap();
    map.bonuses.push({ id: 107, name: 'Cursed', value: -1, territoryIds: [1], bonusIds: [] });
    const a = analyzePlayer(buildGraph(map), state, 10, { cards: [], raw: {}, minimumArmyBonus: 3, bonusArmyPer: 2 });
    expect(a.income.perTerritory).toBe(2);
    expect(a.income.total).toBe(3 + 2 + 3 - 1);
  });

  it('ranks the bonuses closest to completion with armies needed', () => {
    const a = analyzePlayer(g, state, 10, fixtureSettings());
    expect(a.closestBonuses.map((b) => b.name)).toEqual(['S', 'B']);
    const b = a.closestBonuses[1]!;
    expect(b).toMatchObject({
      bonusId: 102,
      value: 2,
      territoryCount: 2,
      ownedCount: 1,
      missingCounts: { neutral: 0, enemy: 1, unknown: 0 },
      armiesNeeded: 8,
      armiesNeededComplete: true,
    });
    expect(b.missing).toEqual([
      { territoryId: 5, name: 'T5', owner: { kind: 'player', playerId: 20 }, armies: 5, armiesToTake: 8 },
    ]);
  });

  it('includes bonuses only reachable from my border, and flags fog', () => {
    const map = tinyMap();
    map.bonuses[2]!.value = 1; // C (territory 6) becomes worth taking
    const s = board([mine(5, 3), fogged(6), neutral(4, 2)]);
    const a = analyzePlayer(buildGraph(map), s, 10);
    const c = a.closestBonuses.find((x) => x.name === 'C')!;
    expect(c.ownedCount).toBe(0);
    expect(c.missingCounts).toEqual({ neutral: 0, enemy: 0, unknown: 1 });
    expect(c.armiesNeeded).toBe(0);
    expect(c.armiesNeededComplete).toBe(false);
    // A is neither owned nor adjacent to territory 5, so it is left out.
    expect(a.closestBonuses.some((x) => x.name === 'A')).toBe(false);
    // Territory 4 is neutral at 2 armies: B needs 3.
    expect(a.closestBonuses.find((x) => x.name === 'B')!.missing[0]!.armiesToTake).toBe(3);
    expect(a.assumptions.join(' ')).toMatch(/default/i);
  });

  it('treats territories absent from the board as unknown', () => {
    const a = analyzePlayer(g, board([mine(3, 2)]), 10);
    const b = a.closestBonuses.find((x) => x.name === 'B')!;
    expect(b.missingCounts.unknown).toBe(2);
    expect(b.missing[0]!.owner).toEqual({ kind: 'unknown' });
  });

  it('honours the limit', () => {
    expect(analyzePlayer(g, state, 10, undefined, { limit: 1 }).closestBonuses).toHaveLength(1);
  });

  it('lists visible threats next to my territories', () => {
    const a = analyzePlayer(g, state, 10, fixtureSettings());
    expect(a.threats).toEqual([{ territoryId: 5, name: 'T5', playerId: 20, armies: 5, adjacentTo: [4] }]);
  });

  it('orders threats by armies, then id', () => {
    const map = tinyMap();
    map.territories.find((t) => t.id === 7)!.connectedTo.push(1);
    const s = board([mine(1, 1), mine(2, 1), mine(7, 9, 20), mine(3, 4, 21), mine(4, 9, 22)]);
    const a = analyzePlayer(buildGraph(map), s, 10);
    expect(a.threats.map((t) => t.territoryId)).toEqual([7, 3]);
  });

  it('records its assumptions', () => {
    const a = analyzePlayer(g, state, 10, {
      cards: [],
      raw: {},
      roundingMode: 'WeightedRandom',
      luckModifier: 0.16,
      offensiveKillRate: 60,
      defensiveKillRate: 70,
    });
    const text = a.assumptions.join(' ');
    expect(text).toMatch(/unverified/i);
    expect(text).toMatch(/WeightedRandom/);
    expect(text).toMatch(/luck/i);
    expect(a.boardVerified).toBe(false);
    const verified = analyzePlayer(g, board(state.territories, true), 10, fixtureSettings());
    expect(verified.assumptions).toEqual([]);
  });

  it('works on the fixture map with a small board', () => {
    const fm = fixtureMap();
    const fg = buildGraph(fm);
    const target = fm.bonuses.find((b) => b.value > 0 && b.territoryIds.length >= 2)!;
    const s = board([mine(target.territoryIds[0]!, 5)]);
    const a = analyzePlayer(fg, s, 10, fixtureSettings());
    expect(a.territoryCount).toBe(1);
    expect(a.closestBonuses.map((b) => b.bonusId)).toContain(target.id);
    expect(a).toEqual(analyzePlayer(fg, s, 10, fixtureSettings()));
  });
});
