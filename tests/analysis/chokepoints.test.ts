import { describe, expect, it } from 'vitest';
import { articulationPoints, findBridges, findChokepoints, primaryBonusOf } from '../../src/analysis/chokepoints.js';
import { buildGraph } from '../../src/analysis/graph.js';
import type { GameMap } from '../../src/normalize.js';
import { fixtureMap, tinyMap } from './helpers.js';

describe('graph cuts', () => {
  const g = buildGraph(tinyMap());

  it('finds articulation points', () => {
    expect(articulationPoints(g)).toEqual([3, 4, 5, 6]);
  });

  it('finds bridges as sorted pairs', () => {
    expect(findBridges(g)).toEqual([
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 7],
    ]);
  });

  it('handles a root with several children and disconnected parts', () => {
    const map = tinyMap();
    // A star: 10 in the middle of 11, 12; plus an isolated 13.
    map.territories.push(
      { id: 10, name: 'hub', connectedTo: [11, 12] },
      { id: 11, name: 'a', connectedTo: [10] },
      { id: 12, name: 'b', connectedTo: [10] },
      { id: 13, name: 'alone', connectedTo: [] },
    );
    const g2 = buildGraph(map);
    expect(articulationPoints(g2)).toContain(10);
    expect(findBridges(g2)).toContainEqual([10, 11]);
  });

  it('does not flag cycles', () => {
    const map = tinyMap();
    map.territories.find((t) => t.id === 7)!.connectedTo.push(1); // closes the ring
    const g2 = buildGraph(map);
    expect(articulationPoints(g2)).toEqual([]);
    expect(findBridges(g2)).toEqual([]);
  });
});

describe('primaryBonusOf', () => {
  it('is the smallest containing bonus, or null', () => {
    const g = buildGraph(tinyMap());
    expect(primaryBonusOf(g, 3)).toBe(101); // A (3) beats S (5)
    expect(primaryBonusOf(g, 6)).toBe(103);
    expect(primaryBonusOf(g, 7)).toBeNull();
  });
});

describe('findChokepoints', () => {
  const g = buildGraph(tinyMap());

  it('combines articulation points, cluster bridges and low-degree connectors', () => {
    const cps = findChokepoints(g);
    expect(cps.map((c) => [c.territoryId, c.reasons])).toEqual([
      [4, ['articulation', 'bridge', 'low-degree-connector']],
      [5, ['articulation', 'bridge', 'low-degree-connector']],
      [6, ['articulation', 'bridge', 'low-degree-connector']],
      [3, ['articulation', 'bridge']],
    ]);
    const four = cps[0]!;
    expect(four).toMatchObject({ name: 'T4', degree: 2, bonusId: 102, connectsBonusIds: [101] });
  });

  it('lets the low-degree cut-off be raised', () => {
    const three = findChokepoints(g, { maxConnectorDegree: 3 }).find((c) => c.territoryId === 3)!;
    expect(three.reasons).toEqual(['articulation', 'bridge', 'low-degree-connector']);
  });

  it('runs deterministically on the fixture', () => {
    const fg = buildGraph(fixtureMap());
    const a = findChokepoints(fg);
    expect(a).toEqual(findChokepoints(fg));
    expect(a.length).toBeGreaterThan(0);
    for (const c of a) expect(c.reasons.length).toBeGreaterThan(0);
  });
});

describe('findChokepoints: what really blocks', () => {
  const mapOf = (edges: [number, number][], bonuses: { id: number; ts: number[] }[]): GameMap => {
    const ids = [...new Set(edges.flat())].sort((a, b) => a - b);
    return {
      id: 9,
      name: 'Cuts',
      territories: ids.map((id) => ({
        id,
        name: `T${id}`,
        connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
      })),
      bonuses: bonuses.map((b) => ({ id: b.id, name: `B${b.id}`, value: 1, territoryIds: b.ts, bonusIds: [] })),
      distributionModes: [],
    };
  };

  it('never lists a dead end: a territory with one neighbour blocks nothing', () => {
    // 1 ─ 2 ─ 3 ─ 4      1 is a dead end and its own bonus; 3-4-5 is a triangle.
    //          ╲ ╱
    //           5
    const g = buildGraph(
      mapOf(
        [[1, 2], [2, 3], [3, 4], [3, 5], [4, 5]],
        [{ id: 201, ts: [1] }, { id: 202, ts: [2] }, { id: 203, ts: [3, 4, 5] }],
      ),
    );
    expect(findChokepoints(g).map((c) => c.territoryId)).toEqual([2, 3]);
  });

  it('lists true cut points before narrow passages that a route can go around', () => {
    // Ring 1-2-3-4, then 4 ─ 5 and the triangle 5-6-7: only 4 and 5 cut the map.
    const g = buildGraph(
      mapOf(
        [[1, 2], [2, 3], [3, 4], [1, 4], [4, 5], [5, 6], [5, 7], [6, 7]],
        [{ id: 301, ts: [1] }, { id: 302, ts: [2, 3] }, { id: 303, ts: [4, 5, 6, 7] }],
      ),
    );
    const cps = findChokepoints(g);
    expect(cps.map((c) => c.territoryId)).toEqual([4, 5, 1, 2, 3]);
    expect(cps.slice(0, 2).every((c) => c.reasons.includes('articulation'))).toBe(true);
    expect(cps.slice(2).every((c) => !c.reasons.includes('articulation'))).toBe(true);
  });

  it('on the fixture, no chokepoint is a dead end and the cut points come first', () => {
    const g = buildGraph(fixtureMap());
    const cps = findChokepoints(g);
    expect(cps.every((c) => c.degree >= 2)).toBe(true);
    const firstOther = cps.findIndex((c) => !c.reasons.includes('articulation'));
    const lastCut = cps.map((c) => c.reasons.includes('articulation')).lastIndexOf(true);
    if (firstOther !== -1) expect(lastCut).toBeLessThan(firstOther);
  });
});
