// The breach cost of a border (#275, pattern 2): with the guard off every interior territory may
// hold 0, so one breach by a large stack puts everything behind the border one move away. Pure and
// deterministic; ties resolve on ascending ids.
//
// The territories a border `t` alone shields are my territories within BREACH_DEPTH (2) steps of it
// through my holdings that face no enemy themselves (no neighbour of a foe, none in the fog), and
// whose only front within BREACH_DEPTH steps (through my holdings) is `t`: a territory a second front
// also reaches is that front's too, so no breach cost is counted twice. Only a hollow territory
// counts (`hollow`, the caller's test: in the planner, none of my territories beside it, itself
// included, holds the stack that would come through; a 120-army stack one step behind answers a
// breach, #214's boards). The cost is the positive
// bonuses I hold in full with a member among them, leaving out every bonus `t` itself is in (losing
// `t` breaks those already). The planner adds per-territory income itself.

import { bonusTerritories } from './bonuses.js';
import type { MapGraph } from './graph.js';
import { neighborsOf } from './graph.js';

/** How far behind a border a breach reaches: the stack takes the border, then walks on. */
export const BREACH_DEPTH = 2;

export interface Breach {
  /** The territories only this border shields, ascending. */
  ids: number[];
  /** The bonuses I hold in full with a member among them, the border's own left out, ascending by id. */
  bonuses: { id: number; value: number }[];
  /** Their positive values, summed. */
  income: number;
}

const byNum = (a: number, b: number) => a - b;

/** My territories within `depth` steps of `from` through `holdings` (`from` itself left out). */
function within(graph: MapGraph, holdings: ReadonlySet<number>, from: number, depth: number): Map<number, number> {
  const dist = new Map<number, number>([[from, 0]]);
  let frontier = [from];
  for (let d = 1; d <= depth; d++) {
    const next: number[] = [];
    for (const x of frontier)
      for (const n of neighborsOf(graph, x))
        if (holdings.has(n) && !dist.has(n)) {
          dist.set(n, d);
          next.push(n);
        }
    frontier = next;
  }
  dist.delete(from);
  return dist;
}

/**
 * What a breach of my border `t` opens (see the header). `front(x)`: my `x` faces an enemy or the
 * fog. `skip`: territories already counted elsewhere (what losing `t` cuts off, #235). `hollow(x)`:
 * a breach walks into `x` (default: always). Empty when `t` is not mine or not a front.
 */
export function breachBehind(
  graph: MapGraph,
  holdings: ReadonlySet<number>,
  front: (x: number) => boolean,
  t: number,
  skip: ReadonlySet<number> = new Set(),
  hollow: (x: number) => boolean = () => true,
): Breach {
  const none: Breach = { ids: [], bonuses: [], income: 0 };
  if (!holdings.has(t) || !front(t)) return none;
  const ids = [...within(graph, holdings, t, BREACH_DEPTH).keys()]
    .filter((x) => !skip.has(x) && !front(x) && hollow(x))
    .filter((x) => [...within(graph, holdings, x, BREACH_DEPTH).keys()].filter(front).every((y) => y === t))
    .sort(byNum);
  if (!ids.length) return none;
  const inside = new Set(ids);
  const bonuses: Breach['bonuses'] = [];
  for (const b of [...graph.bonusById.values()].sort((a, c) => a.id - c.id)) {
    if (b.value <= 0) continue;
    const ts = bonusTerritories(graph, b.id);
    if (!ts.length || ts.includes(t) || !ts.every((x) => holdings.has(x)) || !ts.some((x) => inside.has(x))) continue;
    bonuses.push({ id: b.id, value: b.value });
  }
  return { ids, bonuses, income: bonuses.reduce((n, b) => n + b.value, 0) };
}
