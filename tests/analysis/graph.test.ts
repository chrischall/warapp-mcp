import { describe, expect, it } from 'vitest';
import { bfsDistances, buildGraph, distance, neighborsOf, shortestPath } from '../../src/analysis/graph.js';
import { fixtureMap, tinyMap } from './helpers.js';

describe('buildGraph', () => {
  it('symmetrizes, dedupes and sorts adjacency', () => {
    const g = buildGraph(tinyMap());
    expect(neighborsOf(g, 7)).toEqual([6]);
    expect(neighborsOf(g, 6)).toEqual([5, 7]);
    expect(neighborsOf(g, 3)).toEqual([1, 2, 4]);
  });

  it('drops self-loops and links to unknown territories', () => {
    const map = tinyMap();
    map.territories[0]!.connectedTo.push(1, 999, 2);
    const g = buildGraph(map);
    expect(neighborsOf(g, 1)).toEqual([2, 3]);
    expect(neighborsOf(g, 999)).toEqual([]);
  });

  it('indexes territories and bonuses', () => {
    const g = buildGraph(tinyMap());
    expect(g.territoryById.get(4)?.name).toBe('T4');
    expect(g.bonusById.get(104)?.name).toBe('S');
  });

  it('builds the 761-territory fixture with a symmetric graph', () => {
    const g = buildGraph(fixtureMap());
    expect(g.territoryById.size).toBe(761);
    for (const [id, ns] of g.neighbors) for (const n of ns) expect(neighborsOf(g, n)).toContain(id);
  });
});

describe('BFS', () => {
  const g = buildGraph(tinyMap());

  it('finds the shortest path, preferring lower ids on ties', () => {
    expect(shortestPath(g, 1, 7)).toEqual([1, 3, 4, 5, 6, 7]);
    expect(shortestPath(g, 7, 1)).toEqual([7, 6, 5, 4, 3, 1]);
    expect(shortestPath(g, 4, 4)).toEqual([4]);
  });

  it('returns null for unknown or unreachable territories', () => {
    expect(shortestPath(g, 1, 999)).toBeNull();
    expect(distance(g, 999, 1)).toBeNull();
    const map = tinyMap();
    map.territories.push({ id: 8, name: 'Island', connectedTo: [] });
    const g2 = buildGraph(map);
    expect(shortestPath(g2, 1, 8)).toBeNull();
    expect(distance(g2, 1, 8)).toBeNull();
  });

  it('measures distance in hops', () => {
    expect(distance(g, 1, 7)).toBe(5);
    expect(distance(g, 2, 2)).toBe(0);
  });

  it('computes multi-source distances, ignoring unknown sources', () => {
    const d = bfsDistances(g, [1, 7, 999]);
    expect(Object.fromEntries(d)).toEqual({ 1: 0, 2: 1, 3: 1, 4: 2, 5: 2, 6: 1, 7: 0 });
  });

  it('respects a passable filter', () => {
    const d = bfsDistances(g, [1], { passable: (id) => id !== 5 });
    expect(d.has(6)).toBe(false);
    expect(d.get(4)).toBe(2);
  });

  it('works across the fixture map', () => {
    const fg = buildGraph(fixtureMap());
    const ids = [...fg.territoryById.keys()].sort((a, b) => a - b);
    const path = shortestPath(fg, ids[0]!, ids[ids.length - 1]!);
    if (path) {
      for (let i = 1; i < path.length; i++) expect(neighborsOf(fg, path[i - 1]!)).toContain(path[i]);
      expect(distance(fg, ids[0]!, ids[ids.length - 1]!)).toBe(path.length - 1);
    }
  });
});
