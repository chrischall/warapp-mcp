// The pick advisor on a very large map (the 3,066-territory live case that the host could not serve): it must finish
// quickly, offer a valid list, and leave smaller maps exactly as they were. Every id here is made up.
import { describe, expect, it } from 'vitest';
import { CANDIDATE_TERRITORIES, LARGE_PICKABLE, planPicks, type PickSettings } from '../../src/analysis/picks.js';
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
    // Only the best bonuses' territories were ranked, said plainly, and the primary is one of them.
    expect(p.candidates!.pickable).toBe(pickable.length);
    expect(p.candidates!.ranked).toBeLessThanOrEqual(Math.max(CANDIDATE_TERRITORIES, 75 * 4));
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

  it('a generous budget changes nothing', () => {
    const a = planPicks(input);
    const b = planPicks({ ...input, budgetMs: 10 * 60_000 });
    expect(b.partial).toBeUndefined();
    expect(b.picks.map((x) => x.territoryId)).toEqual(a.picks.map((x) => x.territoryId));
  }, 60_000);
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
