// Chokepoints: articulation points, bridge edges between bonus clusters, and
// low-degree territories that connect clusters. Pure and deterministic.

import { bonusTerritories } from './bonuses.js';
import { neighborsOf, type MapGraph } from './graph.js';

const byNum = (a: number, b: number) => a - b;

interface Cuts {
  points: number[];
  bridges: [number, number][];
}

// Iterative Tarjan (no recursion: real maps run to thousands of territories).
function cuts(g: MapGraph): Cuts {
  const disc = new Map<number, number>();
  const low = new Map<number, number>();
  const points = new Set<number>();
  const bridges: [number, number][] = [];
  let time = 0;
  const roots = [...g.territoryById.keys()].sort(byNum);
  for (const root of roots) {
    if (disc.has(root)) continue;
    disc.set(root, time);
    low.set(root, time++);
    let rootChildren = 0;
    const stack: { v: number; parent: number | null; i: number }[] = [{ v: root, parent: null, i: 0 }];
    while (stack.length) {
      const f = stack[stack.length - 1]!;
      const ns = neighborsOf(g, f.v);
      if (f.i < ns.length) {
        const w = ns[f.i++]!;
        if (!disc.has(w)) {
          disc.set(w, time);
          low.set(w, time++);
          if (f.v === root) rootChildren++;
          stack.push({ v: w, parent: f.v, i: 0 });
        } else if (w !== f.parent) {
          low.set(f.v, Math.min(low.get(f.v)!, disc.get(w)!));
        }
        continue;
      }
      stack.pop();
      const p = stack[stack.length - 1];
      if (!p) continue;
      low.set(p.v, Math.min(low.get(p.v)!, low.get(f.v)!));
      if (p.parent !== null && low.get(f.v)! >= disc.get(p.v)!) points.add(p.v);
      if (low.get(f.v)! > disc.get(p.v)!) bridges.push(p.v < f.v ? [p.v, f.v] : [f.v, p.v]);
    }
    if (rootChildren > 1) points.add(root);
  }
  bridges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { points: [...points].sort(byNum), bridges };
}

/** Territories whose removal disconnects the map, sorted. */
export function articulationPoints(g: MapGraph): number[] {
  return cuts(g).points;
}

/** Edges whose removal disconnects the map, as sorted `[low, high]` pairs. */
export function findBridges(g: MapGraph): [number, number][] {
  return cuts(g).bridges;
}

const primaryCache = new WeakMap<MapGraph, Map<number, number>>();

/**
 * A territory's cluster: the smallest bonus (by flattened size, then id) that
 * contains it, or `null` when it is in none. Bonuses overlap heavily on real
 * maps, so the smallest one is the meaningful "home" region.
 */
export function primaryBonusOf(g: MapGraph, territoryId: number): number | null {
  let index = primaryCache.get(g);
  if (!index) {
    index = new Map();
    const sizes = new Map<number, number>();
    for (const b of [...g.map.bonuses].sort((a, b) => a.id - b.id)) {
      const ts = bonusTerritories(g, b.id);
      for (const t of ts) {
        const cur = index.get(t);
        if (cur === undefined || ts.length < sizes.get(cur)!) index.set(t, b.id);
      }
      sizes.set(b.id, ts.length);
    }
    primaryCache.set(g, index);
  }
  return index.get(territoryId) ?? null;
}

export type ChokepointReason = 'articulation' | 'bridge' | 'low-degree-connector';

export interface Chokepoint {
  territoryId: number;
  name: string;
  degree: number;
  /** In the order articulation, bridge, low-degree-connector. */
  reasons: ChokepointReason[];
  /** The territory's cluster (see {@link primaryBonusOf}). */
  bonusId: number | null;
  /** Other clusters among its neighbours, sorted. */
  connectsBonusIds: number[];
}

export interface ChokepointOptions {
  /** Highest degree that still counts as a low-degree connector (default 2). */
  maxConnectorDegree?: number;
}

/**
 * Chokepoints: articulation points; endpoints of bridge edges whose two ends
 * lie in different clusters; and territories of degree ≤ `maxConnectorDegree`
 * touching at least two distinct clusters (their own included). Ordered by
 * number of reasons desc, then degree asc, then id asc.
 */
export function findChokepoints(g: MapGraph, opts: ChokepointOptions = {}): Chokepoint[] {
  const maxDeg = opts.maxConnectorDegree ?? 2;
  const { points, bridges } = cuts(g);
  const art = new Set(points);
  const bridgeEnds = new Set<number>();
  for (const [a, b] of bridges) {
    const ca = primaryBonusOf(g, a);
    const cb = primaryBonusOf(g, b);
    if (ca !== null && cb !== null && ca !== cb) {
      bridgeEnds.add(a);
      bridgeEnds.add(b);
    }
  }
  const out: Chokepoint[] = [];
  for (const id of [...g.territoryById.keys()].sort(byNum)) {
    const ns = neighborsOf(g, id);
    const own = primaryBonusOf(g, id);
    const others = new Set<number>();
    for (const n of ns) {
      const c = primaryBonusOf(g, n);
      if (c !== null && c !== own) others.add(c);
    }
    const clusters = others.size + (own !== null ? 1 : 0);
    const reasons: ChokepointReason[] = [];
    if (art.has(id)) reasons.push('articulation');
    if (bridgeEnds.has(id)) reasons.push('bridge');
    if (ns.length <= maxDeg && clusters >= 2) reasons.push('low-degree-connector');
    if (!reasons.length) continue;
    out.push({
      territoryId: id,
      name: g.territoryById.get(id)!.name,
      degree: ns.length,
      reasons,
      bonusId: own,
      connectsBonusIds: [...others].sort(byNum),
    });
  }
  return out.sort((a, b) => b.reasons.length - a.reasons.length || a.degree - b.degree || a.territoryId - b.territoryId);
}
