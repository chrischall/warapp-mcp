// Per-bonus geometry: flattened membership, borders, entry points, and an
// "easiest bonus" ranking. Pure and deterministic.

import { neighborsOf, type MapGraph } from './graph.js';

export interface BonusAnalysis {
  bonusId: number;
  name: string;
  value: number;
  /** Every territory, superbonus members flattened, sorted. */
  territoryIds: number[];
  /** Direct member bonuses (non-empty only for a superbonus). */
  memberBonusIds: number[];
  isSuperbonus: boolean;
  /** Territories in the bonus with a neighbour outside it. */
  borderTerritoryIds: number[];
  /** Territories outside the bonus adjacent to it. */
  entryPointIds: number[];
  valuePerTerritory: number;
  /** `value / borders`, or the full value when the bonus has no border. */
  valuePerBorder: number;
  /**
   * Ease score: `value / (territories + borders)` — the cost to take it plus the
   * cost to hold it. Higher is easier. 0 for an empty bonus.
   */
  score: number;
}

const byNum = (a: number, b: number) => a - b;

const flattened = new WeakMap<MapGraph, Map<number, readonly number[]>>();

/**
 * All territories of a bonus, flattening member bonuses (cycle-safe). Unknown bonus → `[]`.
 * Remembered per graph and frozen: the planner asks for the same bonus thousands of times in
 * one plan (it was most of a plan's time on a large map), and a graph's bonuses never change.
 */
export function bonusTerritories(g: MapGraph, bonusId: number): readonly number[] {
  let cache = flattened.get(g);
  if (!cache) flattened.set(g, (cache = new Map()));
  const hit = cache.get(bonusId);
  if (hit) return hit;
  const out = new Set<number>();
  const seen = new Set<number>();
  const visit = (id: number) => {
    const b = g.bonusById.get(id);
    if (!b || seen.has(id)) return;
    seen.add(id);
    for (const t of b.territoryIds) out.add(t);
    for (const sub of b.bonusIds) visit(sub);
  };
  visit(bonusId);
  const ts = Object.freeze([...out].sort(byNum));
  cache.set(bonusId, ts);
  return ts;
}

export function analyzeBonus(g: MapGraph, bonusId: number): BonusAnalysis | undefined {
  const b = g.bonusById.get(bonusId);
  if (!b) return undefined;
  const territoryIds = [...bonusTerritories(g, bonusId)];
  const inside = new Set(territoryIds);
  const borders: number[] = [];
  const entries = new Set<number>();
  for (const t of territoryIds) {
    let border = false;
    for (const n of neighborsOf(g, t)) {
      if (inside.has(n)) continue;
      border = true;
      entries.add(n);
    }
    if (border) borders.push(t);
  }
  const size = territoryIds.length;
  return {
    bonusId: b.id,
    name: b.name,
    value: b.value,
    territoryIds,
    memberBonusIds: [...b.bonusIds].sort(byNum),
    isSuperbonus: b.bonusIds.length > 0,
    borderTerritoryIds: borders,
    entryPointIds: [...entries].sort(byNum),
    valuePerTerritory: size ? b.value / size : 0,
    valuePerBorder: borders.length ? b.value / borders.length : b.value,
    score: size ? b.value / (size + borders.length) : 0,
  };
}

/** Every bonus on the map, in map order. */
export function analyzeBonuses(g: MapGraph): BonusAnalysis[] {
  return g.map.bonuses.map((b) => analyzeBonus(g, b.id)!);
}

export interface RankOptions {
  /** Drop bonuses worth less than this (default 1: only positive bonuses). */
  minValue?: number;
  limit?: number;
}

/** Bonuses ordered easiest first: score desc, then value desc, size asc, id asc. */
export function rankBonuses(g: MapGraph, opts: RankOptions = {}): BonusAnalysis[] {
  const minValue = opts.minValue ?? 1;
  const ranked = analyzeBonuses(g)
    .filter((b) => b.value >= minValue)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.value - a.value ||
        a.territoryIds.length - b.territoryIds.length ||
        a.bonusId - b.bonusId,
    );
  return opts.limit !== undefined ? ranked.slice(0, opts.limit) : ranked;
}
