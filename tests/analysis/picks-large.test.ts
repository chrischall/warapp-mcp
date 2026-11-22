// The pick advisor on a very large map (the 3,066-territory live case that the host could not serve): it must finish
// quickly, offer a valid list, and leave smaller maps exactly as they were. Every id here is made up.
import { describe, expect, it } from 'vitest';
import { LARGE_PICKABLE, LARGE_POOL, LARGE_POOL_MIN, largePool, planPicks, type PickSettings } from '../../src/analysis/picks.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { bigUs, largeMap } from './support/large-map.js';

const SETTINGS: PickSettings = {
  offensiveKillRate: 60,
  defensiveKillRate: 70,
  initialPlayerArmiesPerTerritory: 8,
  minimumArmyBonus: 5,
  initialNonDistributionArmies: 2,
  initialNeutralsInDistribution: 1,
  oneArmyStandsGuard: true,
};

function validList(p: { picks: { territoryId: number }[] }, pickable: readonly number[], n: number) {
  const ids = p.picks.map((x) => x.territoryId);
  expect(ids).toHaveLength(n);
  expect(new Set(ids).size).toBe(n);
  const ok = new Set(pickable);
  expect(ids.every((t) => ok.has(t))).toBe(true);
}

describe('planPicks on a very large map', () => {
  const { graph, pickable } = bigUs();
  const input = { graph, pickable, settings: SETTINGS, players: 25, territoryLimit: 3, maxPicks: 75 };

  it('has the live case’s size, and finishes well inside a 20 s budget with a bounded response', () => {
    expect(graph.map.territories.length).toBeGreaterThanOrEqual(3000);
    expect(graph.map.bonuses.length).toBeGreaterThanOrEqual(170);
    const t0 = Date.now();
    const p = planPicks({ ...input, budgetMs: 20_000 });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(p.partial).toBeUndefined();
    validList(p, pickable, 75);
    expect(JSON.stringify(p).length).toBeLessThan(150_000);
    // Only the territories that score best alone were ranked (the pool for a 20 s budget), said plainly.
    expect(p.candidates!.pickable).toBe(pickable.length);
    expect(p.candidates!.ranked).toBe(Math.max(LARGE_POOL, 75 * 4));
    expect(p.warnings.join('\n')).toMatch(/very large map/);
  }, 60_000);

  it('is deterministic', () => {
    const a = planPicks(input);
    const b = planPicks(input);
    expect(a.picks.map((x) => x.territoryId)).toEqual(b.picks.map((x) => x.territoryId));
  }, 60_000);

  it('out of time returns a well-formed partial list instead of failing', () => {
    // A clock that jumps 1 s per read: the budget is gone as soon as the search starts.
    let now = 0;
    const p = planPicks({ ...input, budgetMs: 500, clock: () => (now += 1000) });
    expect(p.partial).toBe(true);
    expect(p.warnings.join('\n')).toMatch(/time budget ran out/);
    validList(p, pickable, 75);
    // The primary group is the territory limit, the rest the fallback; nothing is cut.
    expect(p.picks.filter((x) => x.group === 'primary')).toHaveLength(3);
    expect(p.groups.primary.territoryIds).toHaveLength(3);
  }, 60_000);

  it('a generous budget widens the pool, and a tight one narrows it (#476)', () => {
    const a = planPicks({ ...input, budgetMs: 20_000 });
    const b = planPicks({ ...input, budgetMs: 40_000 });
    const c = planPicks({ ...input, budgetMs: 1_000 });
    expect(a.candidates!.ranked).toBe(400);
    expect(b.candidates!.ranked).toBe(800);
    expect(c.candidates!.ranked).toBe(Math.max(LARGE_POOL_MIN, 75 * 4));
    for (const p of [a, b]) {
      expect(p.partial).toBeUndefined();
      validList(p, pickable, 75);
    }
  }, 120_000);

  it('a full distribution (every territory dealt) stays near its budget instead of running for minutes', () => {
    // 25 players × 122 territories: the 272 s live case. The list is partial past the budget, never late by much.
    const t0 = Date.now();
    const p = planPicks({ ...input, territoryLimit: 122, maxPicks: 3050, budgetMs: 1_000 });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(p.partial).toBe(true);
    validList(p, pickable, 3050);
  }, 120_000);
});

describe('the pool size for a budget', () => {
  it('is LARGE_POOL at the default 20 s, in proportion otherwise, never below LARGE_POOL_MIN', () => {
    expect(largePool(undefined)).toBe(LARGE_POOL);
    expect(largePool(20_000)).toBe(400);
    expect(largePool(60_000)).toBe(1_200);
    expect(largePool(1)).toBe(LARGE_POOL_MIN);
    expect(largePool(Number.POSITIVE_INFINITY)).toBe(LARGE_POOL);
  });
});

describe('a very large map whose best start is not in its best bonuses by value per member (#476)', () => {
  it('ranks every pickable by its own opening, so a hub outside every bonus is still found', () => {
    // A 520-territory line with 60 one-territory decoy bonuses (+2 each: 2 per member), and off it a hub that is in no
    // bonus but touches four three-territory bonuses (+5 each: 1.67 per member). Ranking bonuses by value per member
    // kept only decoys; the hub's opening is far better, and the exact planner (no pool) takes it.
    const territories: { id: number; name: string; connectedTo: number[] }[] = [];
    for (let i = 1; i <= 520; i++) territories.push({ id: i, name: `L${i}`, connectedTo: i < 520 ? [i + 1] : [] });
    const bonuses: { id: number; name: string; value: number; territoryIds: number[]; bonusIds: number[] }[] = [];
    for (let k = 0; k < 60; k++) bonuses.push({ id: k + 1, name: `D${k + 1}`, value: 2, territoryIds: [10 + k * 8], bonusIds: [] });
    const hubLinks: number[] = [];
    for (let k = 0; k < 4; k++) {
      const ids = [2000 + k * 3, 2001 + k * 3, 2002 + k * 3];
      territories.push({ id: ids[0]!, name: `C${ids[0]}`, connectedTo: [ids[1]!] }, { id: ids[1]!, name: `C${ids[1]}`, connectedTo: [ids[2]!] }, { id: ids[2]!, name: `C${ids[2]}`, connectedTo: [] });
      hubLinks.push(ids[0]!);
      bonuses.push({ id: 100 + k, name: `C${k}`, value: 5, territoryIds: ids, bonusIds: [] });
    }
    territories.push({ id: 1000, name: 'Hub', connectedTo: [...hubLinks, 1] });
    const graph = buildGraph({ id: 9, name: 'Hub', territories, bonuses, distributionModes: [] });
    const pickable = territories.map((t) => t.id);
    const base = { graph, pickable, settings: SETTINGS, players: 2, territoryLimit: 3, maxPicks: 6 };
    const large = planPicks(base);
    const exact = planPicks({ ...base, largeAbove: Number.POSITIVE_INFINITY });
    expect(large.candidates).toBeDefined();
    expect(large.groups.primary.territoryIds).toContain(1000);
    expect(large.groups.primary.score).toBe(exact.groups.primary.score);
  }, 60_000);
});

describe('just above the limit there is no cliff', () => {
  it('a 420-pickable map plans its primary as the exact planner does (the pool holds almost every territory)', () => {
    const { graph, pickable } = largeMap(21, 20, 4, 4);
    for (const players of [2, 6]) {
      const base = { graph, pickable, settings: SETTINGS, players, territoryLimit: 3, maxPicks: players * 3 };
      const large = planPicks(base);
      const exact = planPicks({ ...base, largeAbove: Number.POSITIVE_INFINITY });
      expect(large.candidates!.ranked).toBe(400);
      expect(large.groups.primary.territoryIds).toEqual(exact.groups.primary.territoryIds);
    }
  }, 120_000);
});

describe('planPicks on smaller maps is unchanged', () => {
  it('a map at the limit is planned whole: no candidate pruning, no partial', () => {
    // 20 × 20 = 400 territories, exactly LARGE_PICKABLE.
    const { graph, pickable } = largeMap(20, 20, 4, 4);
    expect(pickable.length).toBe(LARGE_PICKABLE);
    const p = planPicks({ graph, pickable, settings: SETTINGS, players: 6, territoryLimit: 3, maxPicks: 18 });
    expect(p.candidates).toBeUndefined();
    expect(p.partial).toBeUndefined();
    validList(p, pickable, 18);
  }, 60_000);

  it('a budget that is not reached changes nothing on a medium map (6 players) or a 1v1', () => {
    const { graph, pickable } = largeMap(14, 14, 4, 3);
    for (const players of [2, 6]) {
      const base = { graph, pickable, settings: SETTINGS, players, territoryLimit: 3, maxPicks: 3 * players };
      const a = planPicks(base);
      const b = planPicks({ ...base, budgetMs: 10 * 60_000 });
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(b.partial).toBeUndefined();
    }
  }, 60_000);
});

describe('the budget is always reported', () => {
  it('whenever it changes the list, whatever phase it runs out in (#474 review)', () => {
    const { graph, pickable } = largeMap(14, 14, 4, 3);
    // No fallback: the list is the primary alone, so the budget can only run out inside its search.
    const base = { graph, pickable, settings: SETTINGS, players: 2, territoryLimit: 3, maxPicks: 3 };
    const full = planPicks(base).picks.map((x) => x.territoryId);
    let changed = 0;
    for (let k = 0; k < 600; k += 5) {
      let calls = 0;
      const p = planPicks({ ...base, budgetMs: 1, clock: () => (calls++ >= k ? 10 : 0) });
      if (p.picks.map((x) => x.territoryId).join() !== full.join()) {
        changed++;
        expect(p.partial, `clock flips after ${k} reads`).toBe(true);
        expect(p.warnings.join('\n')).toMatch(/time budget ran out/);
      }
    }
    expect(changed).toBeGreaterThan(0);
  }, 120_000);
});

describe('a very large map whose bonuses hold too few territories', () => {
  it('still lists as many picks as asked', () => {
    // 600 territories in a line, but only three small bonuses: far fewer bonus territories than the 30 picks.
    const territories = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, name: `T${i + 1}`, connectedTo: i + 2 <= 600 ? [i + 2] : [] }));
    const bonuses = [0, 1, 2].map((b) => ({ id: b + 1, name: `B${b + 1}`, value: 5, territoryIds: [b * 4 + 1, b * 4 + 2, b * 4 + 3, b * 4 + 4], bonusIds: [] }));
    const graph = buildGraph({ id: 9, name: 'Sparse', territories, bonuses, distributionModes: [] });
    const pickable = territories.map((t) => t.id);
    const p = planPicks({ graph, pickable, settings: SETTINGS, players: 10, territoryLimit: 3, maxPicks: 30 });
    expect(p.candidates).toBeDefined();
    validList(p, pickable, 30);
  }, 60_000);
});
