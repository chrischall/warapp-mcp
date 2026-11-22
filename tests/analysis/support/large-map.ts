// A synthetic very large map for the pick advisor's scaling tests (every id and name is made up): a W×H grid
// of territories cut into rectangular bonuses, like the 3,066-territory / 173-bonus map the live failure came from.
import { buildGraph, type MapGraph } from '../../../src/analysis/graph.js';
import type { GameMap } from '../../../src/normalize.js';

export interface LargeMap {
  graph: MapGraph;
  pickable: number[];
}

/** `cols × rows` territories (ids 1…), 4-neighbour grid, bonuses of `bw × bh` blocks (value 2–10 by block). */
export function largeMap(cols: number, rows: number, bw: number, bh: number): LargeMap {
  const id = (c: number, r: number) => r * cols + c + 1;
  const territories = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const connectedTo: number[] = [];
      if (c + 1 < cols) connectedTo.push(id(c + 1, r));
      if (r + 1 < rows) connectedTo.push(id(c, r + 1));
      territories.push({ id: id(c, r), name: `T${id(c, r)}`, connectedTo });
    }
  const bonuses = [];
  let b = 1;
  for (let r0 = 0; r0 < rows; r0 += bh)
    for (let c0 = 0; c0 < cols; c0 += bw) {
      const ids: number[] = [];
      for (let r = r0; r < Math.min(rows, r0 + bh); r++) for (let c = c0; c < Math.min(cols, c0 + bw); c++) ids.push(id(c, r));
      bonuses.push({ id: b, name: `B${b}`, value: 2 + (b % 9), territoryIds: ids, bonusIds: [] });
      b++;
    }
  const map: GameMap = { id: 24591, name: 'Synthetic Big', territories, bonuses, distributionModes: [] };
  return { graph: buildGraph(map), pickable: territories.map((t) => t.id) };
}

/** About 3,066 territories in about 170 bonuses. */
export const bigUs = () => largeMap(66, 47, 6, 3);
