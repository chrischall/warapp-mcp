// #199: the Multi-Attack chain search, shared by the stress test (#180) and the planner's threat
// model. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import { breaksLuckFree, searchChains, type ChainAttack } from '../../src/analysis/chains.js';
import type { SimTerritory } from '../../src/analysis/turn-sim.js';
import type { GameMap } from '../../src/normalize.js';

const RATES = { offensiveKillRate: 60, defensiveKillRate: 70 };

function line(n: number): GameMap {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  return {
    id: 1,
    name: 'Line',
    territories: ids.map((id) => ({ id, name: `T${id}`, connectedTo: [id - 1, id + 1].filter((x) => x >= 1 && x <= n) })),
    bonuses: [],
    distributionModes: [],
  };
}

const at = (entries: [number, SimTerritory][]) => new Map(entries);

function run(
  territories: Map<number, SimTerritory>,
  from: number,
  sending: number,
  over: Partial<Parameters<typeof searchChains>[0]> = {},
): ChainAttack[] {
  const seen: ChainAttack[] = [];
  searchChains({
    graph: buildGraph(line(territories.size)),
    territories,
    from,
    sending,
    guard: 1,
    ...RATES,
    hostile: (_id, t) => t.owner !== 'unknown' && t.owner !== 20,
    onAttack: (a) => seen.push({ ...a, path: [...a.path], sends: [...a.sends] }),
    ...over,
  });
  return seen;
}

describe('breaksLuckFree', () => {
  it('takes a territory when the kills clear it and an attacker lives', () => {
    expect(breaksLuckFree(2, false, { owner: 'neutral', armies: 1 }, RATES)).toBe(true);
    expect(breaksLuckFree(1, false, { owner: 'neutral', armies: 1 }, RATES)).toBe(false);
    expect(breaksLuckFree(5, false, { owner: 'unknown', armies: 0 }, RATES)).toBe(false);
  });
});

describe('searchChains (#199)', () => {
  // 1 ─ 2 ─ 3 ─ 4 ─ 5: 19 armies leave 5 and carry on through the 1s.
  const board = at([
    [1, { owner: 10, armies: 1 }],
    [2, { owner: 10, armies: 1 }],
    [3, { owner: 10, armies: 1 }],
    [4, { owner: 'neutral', armies: 1 }],
    [5, { owner: 20, armies: 20 }],
  ]);

  it('reports every attack tried, the armies it sends and whether it takes the territory', () => {
    const seen = run(board, 5, 19);
    expect(seen.map((a) => [a.path, a.sending, a.captured])).toEqual([
      [[5, 4], 19, true],
      [[5, 4, 3], 17, true],
      [[5, 4, 3, 2], 15, true],
      [[5, 4, 3, 2, 1], 13, true],
    ]);
    expect(seen[1]!.sends).toEqual([19, 17]);
    expect(seen[1]!.survivors).toBe(16);
  });

  it('goes on only from a territory `goOn` allows', () => {
    const seen = run(board, 5, 19, { goOn: (id) => id !== 3 });
    expect(seen.map((a) => a.path.at(-1))).toEqual([4, 3]);
  });

  it('stops at the step and node caps', () => {
    expect(run(board, 5, 19, { maxSteps: 2 }).map((a) => a.path.length)).toEqual([2, 3]);
    expect(run(board, 5, 19, { maxNodes: 2 })).toHaveLength(2);
  });

  it('reports a failed attack and does not go on from it', () => {
    const seen = run(at([[1, { owner: 10, armies: 9 }], [2, { owner: 'neutral', armies: 1 }], [3, { owner: 20, armies: 4 }]]), 3, 3);
    expect(seen.map((a) => [a.path, a.sending, a.captured])).toEqual([
      [[3, 2], 3, true],
      [[3, 2, 1], 1, false],
    ]);
  });
});
