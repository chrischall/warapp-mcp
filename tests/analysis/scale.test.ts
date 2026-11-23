import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import { farSummary, LARGE_GAME_OPPONENTS, nearPlayers, opponentScope } from '../../src/analysis/scale.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine } from './helpers.js';

/** Territories 1..n in a line. */
function line(n: number): GameMap {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  return {
    id: 1,
    name: 'Line',
    territories: ids.map((id) => ({ id, name: `T${id}`, connectedTo: ids.filter((x) => Math.abs(x - id) === 1) })),
    bonuses: [],
    distributionModes: [],
  };
}

describe('opponent scope in large games', () => {
  const n = 30;
  const g = buildGraph(line(n));
  // Me (player 1) on territory 1; player p on territory p for 2..30: 29 opponents.
  const open = board(Array.from({ length: n }, (_, i) => mine(i + 1, 3, i + 1)));
  const opponents = Array.from({ length: n - 1 }, (_, i) => i + 2);

  it('without fog, near is every owner within two steps of my land', () => {
    expect([...nearPlayers(g, open, 1)].sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('under fog, every player in view is near too', () => {
    const b = board([mine(1, 3, 1), mine(2, 3, 2), fogged(3), mine(10, 4, 10), ...Array.from({ length: 20 }, (_, i) => fogged(11 + i))]);
    expect([...nearPlayers(g, b, 1)].sort((a, b) => a - b)).toEqual([2, 10]);
  });

  it('scopes only past the threshold, so small games keep every opponent', () => {
    const few = opponents.slice(0, LARGE_GAME_OPPONENTS);
    expect(opponentScope(g, open, 1, few)).toEqual({ large: false, near: few, far: [] });
    const s = opponentScope(g, open, 1, opponents);
    expect(s.large).toBe(true);
    expect(s.near).toEqual([2, 3]);
    expect(s.far).toEqual(opponents.slice(2));
  });

  it('sums the far opponents and names the biggest', () => {
    const est = new Map([
      [4, 10],
      [5, 30],
      [6, 30],
    ]);
    const s = farSummary([4, 5, 6, 7], (p) => est.get(p));
    expect(s).toMatchObject({ count: 4, estimatedDeploy: 70, biggest: { player: 5, deploy: 30 } });
    expect(farSummary([7], () => undefined)).toMatchObject({ count: 1, estimatedDeploy: null, biggest: null });
  });
});
