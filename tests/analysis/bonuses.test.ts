import { describe, expect, it } from 'vitest';
import { analyzeBonus, analyzeBonuses, bonusTerritories, rankBonuses } from '../../src/analysis/bonuses.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { fixtureMap, tinyMap } from './helpers.js';

describe('bonusTerritories', () => {
  const g = buildGraph(tinyMap());

  it('returns a plain bonus’s territories sorted', () => {
    expect(bonusTerritories(g, 102)).toEqual([4, 5]);
  });

  it('flattens superbonuses through member bonuses', () => {
    expect(bonusTerritories(g, 104)).toEqual([1, 2, 3, 4, 5]);
  });

  it('survives cycles and unknown ids', () => {
    const map = tinyMap();
    map.bonuses.push(
      { id: 201, name: 'X', value: 1, territoryIds: [7], bonusIds: [202, 999] },
      { id: 202, name: 'Y', value: 1, territoryIds: [6], bonusIds: [201] },
    );
    const g2 = buildGraph(map);
    expect(bonusTerritories(g2, 201)).toEqual([6, 7]);
    expect(bonusTerritories(g2, 999)).toEqual([]);
  });

  it('answers a repeat call from the graph’s own cache, and the answer cannot be changed', () => {
    const first = bonusTerritories(g, 104);
    expect(bonusTerritories(g, 104)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    // The cache belongs to one graph: another graph of the same map has its own.
    expect(bonusTerritories(buildGraph(tinyMap()), 104)).not.toBe(first);
    expect(bonusTerritories(buildGraph(tinyMap()), 104)).toEqual([...first]);
  });
});

describe('analyzeBonus', () => {
  const g = buildGraph(tinyMap());

  it('finds borders, entry points and ratios', () => {
    expect(analyzeBonus(g, 101)).toEqual({
      bonusId: 101,
      name: 'A',
      value: 3,
      territoryIds: [1, 2, 3],
      memberBonusIds: [],
      isSuperbonus: false,
      borderTerritoryIds: [3],
      entryPointIds: [4],
      valuePerTerritory: 1,
      valuePerBorder: 3,
      score: 0.75,
    });
    const b = analyzeBonus(g, 102)!;
    expect(b.borderTerritoryIds).toEqual([4, 5]);
    expect(b.entryPointIds).toEqual([3, 6]);
    expect(b.valuePerBorder).toBe(1);
    expect(b.score).toBe(0.5);
  });

  it('treats a superbonus as its flattened territory set', () => {
    const s = analyzeBonus(g, 104)!;
    expect(s.isSuperbonus).toBe(true);
    expect(s.memberBonusIds).toEqual([101, 102]);
    expect(s.territoryIds).toEqual([1, 2, 3, 4, 5]);
    expect(s.borderTerritoryIds).toEqual([5]);
    expect(s.entryPointIds).toEqual([6]);
    expect(s.score).toBeCloseTo(4 / 6, 10);
  });

  it('uses the full value per border when a bonus has no border', () => {
    const map = tinyMap();
    map.territories.push({ id: 8, name: 'Island', connectedTo: [] });
    map.bonuses.push({ id: 105, name: 'Isle', value: 2, territoryIds: [8], bonusIds: [] });
    const isle = analyzeBonus(buildGraph(map), 105)!;
    expect(isle.borderTerritoryIds).toEqual([]);
    expect(isle.valuePerBorder).toBe(2);
    expect(isle.score).toBe(2);
  });

  it('returns undefined for an unknown bonus and zeroes an empty one', () => {
    expect(analyzeBonus(g, 999)).toBeUndefined();
    const map = tinyMap();
    map.bonuses.push({ id: 106, name: 'Empty', value: 5, territoryIds: [], bonusIds: [] });
    const e = analyzeBonus(buildGraph(map), 106)!;
    expect(e.valuePerTerritory).toBe(0);
    expect(e.score).toBe(0);
  });
});

describe('rankBonuses', () => {
  const g = buildGraph(tinyMap());

  it('ranks positive bonuses by score, dropping value ≤ 0 by default', () => {
    expect(rankBonuses(g).map((b) => b.name)).toEqual(['A', 'S', 'B']);
  });

  it('honours minValue and limit', () => {
    expect(rankBonuses(g, { minValue: 0 }).map((b) => b.name)).toEqual(['A', 'S', 'B', 'C']);
    expect(rankBonuses(g, { limit: 1 }).map((b) => b.name)).toEqual(['A']);
  });

  it('breaks score ties by value, then size, then id', () => {
    const map = tinyMap();
    map.bonuses = [
      { id: 2, name: 'second', value: 1, territoryIds: [6], bonusIds: [] },
      { id: 1, name: 'first', value: 1, territoryIds: [7], bonusIds: [] },
    ];
    // 6 has two borders' worth of neighbours but one border territory; 7 likewise.
    expect(rankBonuses(buildGraph(map)).map((b) => b.name)).toEqual(['first', 'second']);
  });

  it('is deterministic over the fixture and skips non-positive bonuses', () => {
    const fg = buildGraph(fixtureMap());
    const a = rankBonuses(fg);
    const b = rankBonuses(fg);
    expect(a).toEqual(b);
    expect(a.length).toBe(372 - 56);
    expect(a.every((x) => x.value > 0)).toBe(true);
    for (let i = 1; i < a.length; i++) expect(a[i - 1]!.score).toBeGreaterThanOrEqual(a[i]!.score);
    expect(analyzeBonuses(fg)).toHaveLength(372);
  });
});
