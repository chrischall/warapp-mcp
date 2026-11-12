// Territory adjacency graph and breadth-first search over a GameMap.
//
// Pure and deterministic: adjacency lists are symmetrized, de-duplicated and
// sorted ascending, so every search visits neighbours in the same order and
// ties always resolve toward the lower territory id.

import type { Bonus, GameMap, Territory } from '../normalize.js';

export interface MapGraph {
  map: GameMap;
  territoryById: ReadonlyMap<number, Territory>;
  bonusById: ReadonlyMap<number, Bonus>;
  /** Sorted, symmetric neighbour lists; every territory has an entry. */
  neighbors: ReadonlyMap<number, readonly number[]>;
}

const EMPTY: readonly number[] = Object.freeze([]);

/**
 * Build the graph. A link is kept when either side declares it (maps are not
 * always symmetric); self-links and links to unknown territories are dropped.
 */
export function buildGraph(map: GameMap): MapGraph {
  const territoryById = new Map(map.territories.map((t) => [t.id, t]));
  const sets = new Map<number, Set<number>>();
  for (const t of map.territories) sets.set(t.id, new Set());
  for (const t of map.territories) {
    for (const n of t.connectedTo) {
      if (n === t.id || !territoryById.has(n)) continue;
      sets.get(t.id)!.add(n);
      sets.get(n)!.add(t.id);
    }
  }
  const neighbors = new Map<number, readonly number[]>();
  for (const [id, s] of sets) neighbors.set(id, [...s].sort((a, b) => a - b));
  return { map, territoryById, bonusById: new Map(map.bonuses.map((b) => [b.id, b])), neighbors };
}

export function neighborsOf(g: MapGraph, id: number): readonly number[] {
  return g.neighbors.get(id) ?? EMPTY;
}

export interface BfsOptions {
  /** Territories the search may enter (sources are always included). */
  passable?: (id: number) => boolean;
}

/** Hop distance from the nearest source to every reachable territory. Unknown sources are ignored. */
export function bfsDistances(g: MapGraph, sources: Iterable<number>, opts: BfsOptions = {}): Map<number, number> {
  const dist = new Map<number, number>();
  const queue: number[] = [];
  for (const s of [...sources].sort((a, b) => a - b)) {
    if (g.territoryById.has(s) && !dist.has(s)) {
      dist.set(s, 0);
      queue.push(s);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head]!;
    const d = dist.get(v)! + 1;
    for (const n of neighborsOf(g, v)) {
      if (dist.has(n) || (opts.passable && !opts.passable(n))) continue;
      dist.set(n, d);
      queue.push(n);
    }
  }
  return dist;
}

/** Shortest path (inclusive of both ends), or `null` when either end is unknown or unreachable. */
export function shortestPath(g: MapGraph, from: number, to: number): number[] | null {
  if (!g.territoryById.has(from) || !g.territoryById.has(to)) return null;
  const prev = new Map<number, number>([[from, from]]);
  const queue = [from];
  for (let head = 0; head < queue.length && !prev.has(to); head++) {
    const v = queue[head]!;
    for (const n of neighborsOf(g, v)) {
      if (prev.has(n)) continue;
      prev.set(n, v);
      queue.push(n);
    }
  }
  if (!prev.has(to)) return null;
  const path = [to];
  for (let v = to; v !== from; ) {
    v = prev.get(v)!;
    path.push(v);
  }
  return path.reverse();
}

/** Hops between two territories, or `null` when unknown or unreachable. */
export function distance(g: MapGraph, from: number, to: number): number | null {
  const p = shortestPath(g, from, to);
  return p ? p.length - 1 : null;
}
