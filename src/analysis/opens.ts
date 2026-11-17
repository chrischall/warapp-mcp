// #291: what the loss of a territory of mine OPENS to the enemy. #235 counts what a loss cuts off from my own
// holdings; a gate cuts nothing off — it is the only way the enemy gets in. Its opened set is every territory of
// mine that every route from an enemy or the fog (a `source`) reaches only through it: with it taken out of the
// graph, no source reaches them, yet they lie behind it. Routes run through any territory (an enemy can take a
// neutral or one of mine on its way), so this is the map's own chokepoint, not a guess at the enemy's path.
// Pure and deterministic (neighbours as the graph lists them, ids ascending in the result).
import { bonusTerritories } from './bonuses.js';
import { neighborsOf, type MapGraph } from './graph.js';

/** What losing a territory of mine opens to the enemy ({@link opensBehind}). */
export interface Opened {
  /** My territories every route from a source reaches only through it (it left out). */
  ids: number[];
  /** The positive bonuses I hold in full with a member among them (none containing it, none in `skip`). */
  bonuses: number[];
  /** Their summed value. */
  income: number;
}

const byNum = (a: number, b: number) => a - b;

/**
 * What losing my `t` opens (see the header). `holdings`: my territories; `isSource(x)`: `x` is an enemy's or
 * hidden. A bonus already counted elsewhere — one with a member in `skip` (what losing `t` cuts off, #235; a
 * guard-off breach, #275) — and one containing `t` (its own value already counts in full) are left out, so nothing
 * is counted twice. Empty when `t` is no chokepoint.
 */
export function opensBehind(
  g: MapGraph,
  holdings: ReadonlySet<number>,
  isSource: (x: number) => boolean,
  t: number,
  skip: ReadonlySet<number>,
): Opened {
  const empty: Opened = { ids: [], bonuses: [], income: 0 };
  const ids = g.map.territories.map((x) => x.id);
  const sources = ids.filter((x) => x !== t && isSource(x));
  if (!sources.length) return empty;
  // Everything a source reaches with `t` taken out.
  const reached = new Set<number>(sources);
  const queue = [...sources];
  while (queue.length) {
    const x = queue.shift()!;
    for (const n of neighborsOf(g, x))
      if (n !== t && !reached.has(n)) {
        reached.add(n);
        queue.push(n);
      }
  }
  // Behind `t`: what it reaches through territories no source reaches. Mine among them are what it opens.
  const behind = new Set<number>();
  const q2 = neighborsOf(g, t).filter((n) => !reached.has(n));
  for (const n of q2) behind.add(n);
  while (q2.length) {
    const x = q2.shift()!;
    for (const n of neighborsOf(g, x))
      if (n !== t && !reached.has(n) && !behind.has(n)) {
        behind.add(n);
        q2.push(n);
      }
  }
  const opened = [...behind].filter((x) => holdings.has(x)).sort(byNum);
  if (!opened.length) return empty;
  const set = new Set(opened);
  const bonuses: number[] = [];
  let income = 0;
  for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
    if (b.value <= 0) continue;
    const ts = bonusTerritories(g, b.id);
    if (!ts.length || ts.includes(t) || !ts.every((x) => holdings.has(x))) continue;
    if (!ts.some((x) => set.has(x)) || ts.some((x) => skip.has(x))) continue;
    bonuses.push(b.id);
    income += b.value;
  }
  return { ids: opened, bonuses, income };
}
