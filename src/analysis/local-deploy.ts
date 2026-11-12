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
    bonuses.push({ bonusId: b.id, name: b.name, value: b.value, territoryIds: ts });
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
 * Charge deploys (armies by territory) to the pools: each bonus pool, innermost
 * first, absorbs what was deployed on its territories (up to its value); the rest
 * draws on the anywhere pool. Innermost-first is exact when bonuses nest (member
 * bonuses inside a superbonus); the deploys are valid when `anywhereUsed ≤ anywhere`.
 */
export function chargeDeploys(pools: DeployPools, deploys: ReadonlyMap<number, number>): PoolCharge {
  const left = new Map([...deploys].filter(([, n]) => n > 0));
  const used = new Map<number, number>();
  for (const p of pools.bonuses) {
    let room = p.value;
    for (const t of p.territoryIds) {
      if (room <= 0) break;
      const n = left.get(t) ?? 0;
      const take = Math.min(n, room);
      if (take <= 0) continue;
      left.set(t, n - take);
      room -= take;
    }
    used.set(p.bonusId, p.value - room);
  }
  let anywhereUsed = 0;
  for (const n of left.values()) anywhereUsed += n;
  return { anywhereUsed, used };
}
