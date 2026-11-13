// Local Deployment (GameFeed `LocalDeployments`): armies earned from a bonus may
// only be deployed on that bonus's territories; the rest of the income (base
// income, per-territory income, card armies) may go anywhere. Which income is
// "anywhere" is UNVERIFIED beyond the bonus rule itself — see docs/WARAPP-API.md.
// Pure and deterministic.

import { bonusTerritories } from './bonuses.js';
import type { MapGraph } from './graph.js';

/** One held bonus's armies, deployable only on its own territories. */
export interface DeployPool {
  bonusId: number;
  name: string;
  /** Armies in the pool (the bonus's value; trimmed only when the income is smaller than every pool together). */
  value: number;
  /** Every territory of the bonus (superbonus members flattened), sorted. */
  territoryIds: number[];
}

export interface DeployPools {
  /** Armies that may be deployed anywhere: the income minus every bonus pool. */
  anywhere: number;
  /** One pool per held bonus worth more than 0, innermost (fewest territories) first, then by id. */
  bonuses: DeployPool[];
  /** Armies cut from the pools because the income was smaller than their sum (0 normally). */
  trimmed: number;
}

/**
 * The deploy pools for a player holding `held` with this turn's `income`: one per
 * fully held bonus of positive value (a superbonus gets its own pool over all its
 * territories, beside its member bonuses' pools), and the rest anywhere.
 */
export function deployPools(g: MapGraph, held: ReadonlySet<number>, income: number): DeployPools {
  const bonuses: DeployPool[] = [];
  for (const b of g.map.bonuses) {
    if (b.value <= 0) continue;
    const ts = bonusTerritories(g, b.id);
    if (!ts.length || !ts.every((t) => held.has(t))) continue;
    bonuses.push({ bonusId: b.id, name: b.name, value: b.value, territoryIds: [...ts] });
  }
  bonuses.sort((a, b) => a.territoryIds.length - b.territoryIds.length || a.bonusId - b.bonusId);
  const total = bonuses.reduce((s, p) => s + p.value, 0);
  let trimmed = 0;
  // Never more pooled armies than the income: trim the outermost pools first.
  for (let i = bonuses.length - 1, over = total - Math.max(0, income); i >= 0 && over > 0; i--) {
    const cut = Math.min(over, bonuses[i]!.value);
    bonuses[i]!.value -= cut;
    over -= cut;
    trimmed += cut;
  }
  return { anywhere: Math.max(0, income - (total - trimmed)), bonuses, trimmed };
}

export interface PoolCharge {
  /** Deployed armies no bonus pool could absorb: they draw on {@link DeployPools.anywhere}. */
  anywhereUsed: number;
  /** Armies each bonus pool absorbed, by bonus id. */
  used: Map<number, number>;
}

/**
 * Charge deploys (armies by territory) to the pools so that as few armies as possible
 * draw on the anywhere pool: a maximum flow from the deployed territories to the bonus
 * pools that contain them (each pool capped at its value). The deploys are valid
 * exactly when `anywhereUsed ≤ anywhere`.
 *
 * Exact for any bonus layout — nested (member bonuses inside a superbonus) or
 * overlapping without nesting. A greedy pass (innermost pool first, lowest territory
 * first) seeds the flow; augmenting paths then move armies between pools until no
 * more can be absorbed (Ford–Fulkerson; deterministic: BFS in pool and id order).
 */
export function chargeDeploys(pools: DeployPools, deploys: ReadonlyMap<number, number>): PoolCharge {
  const ps = pools.bonuses;
  const left = new Map([...deploys].filter(([, n]) => n > 0).sort(([a], [b]) => a - b));
  /** flow[i]: armies from each territory charged to pool i. */
  const flow = ps.map(() => new Map<number, number>());
  const room = ps.map((p) => p.value);
  const add = (i: number, t: number, n: number) => {
    const f = (flow[i]!.get(t) ?? 0) + n;
    if (f) flow[i]!.set(t, f);
    else flow[i]!.delete(t);
    room[i]! -= n;
    left.set(t, left.get(t)! - n);
  };
  // Greedy seed: innermost pool first, its lowest territories first.
  ps.forEach((p, i) => {
    for (const t of p.territoryIds) {
      const take = Math.min(left.get(t) ?? 0, room[i]!);
      if (take > 0) add(i, t, take);
    }
  });
  const members = ps.map((p) => new Set(p.territoryIds));
  // Augment: from a territory with armies left, through pools (forward: any pool holding
  // the territory) and back (a territory already charged to that pool), to a pool with room.
  for (;;) {
    const start = [...left].filter(([, n]) => n > 0).map(([t]) => t);
    if (!start.length || room.every((r) => r <= 0)) break;
    const viaPool = new Map<number, number>(); // pool → territory it was reached from
    const viaTerr = new Map<number, number>(); // territory → pool it was reached from (-1: a start)
    for (const t of start) viaTerr.set(t, -1);
    const queue = [...start];
    let end = -1;
    while (queue.length && end < 0) {
      const t = queue.shift()!;
      for (let i = 0; i < ps.length && end < 0; i++) {
        if (viaPool.has(i) || !members[i]!.has(t)) continue;
        viaPool.set(i, t);
        if (room[i]! > 0) {
          end = i;
          break;
        }
        for (const u of [...flow[i]!.keys()].sort((a, b) => a - b)) {
          if (viaTerr.has(u)) continue;
          viaTerr.set(u, i);
          queue.push(u);
        }
      }
    }
    if (end < 0) break;
    // Walk the path back from the pool with room to its start; the bottleneck is the
    // pool's room, the start's armies left, and each reversed charge.
    const path: Array<[pool: number, terr: number]> = [];
    for (let i = end; ; ) {
      const t = viaPool.get(i)!;
      path.push([i, t]);
      const back = viaTerr.get(t)!;
      if (back < 0) break;
      i = back;
    }
    let n = Math.min(room[end]!, left.get(path[path.length - 1]![1])!);
    for (let k = 0; k < path.length - 1; k++) n = Math.min(n, flow[path[k + 1]![0]]!.get(path[k]![1])!);
    // Each step charges `terr` to `pool`; each earlier pool on the path releases the same territory.
    for (let k = 0; k < path.length; k++) {
      const [i, t] = path[k]!;
      add(i, t, n);
      if (k + 1 < path.length) add(path[k + 1]![0], t, -n);
    }
  }
  const used = new Map<number, number>();
  ps.forEach((p, i) => used.set(p.bonusId, p.value - room[i]!));
  let anywhereUsed = 0;
  for (const n of left.values()) anywhereUsed += n;
  return { anywhereUsed, used };
}
