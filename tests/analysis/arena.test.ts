import { describe, expect, it } from 'vitest';
import { arenaMap, legal, playArena, plannerBot, spreaderBot, viewOf } from '../../src/analysis/arena.js';
import { buildGraph } from '../../src/analysis/graph.js';

describe('arena', () => {
  it('makes a connected map with bonuses covering every territory', () => {
    const { map } = arenaMap(7);
    const covered = new Set(map.bonuses.flatMap((b) => b.territoryIds));
    expect(covered.size).toBe(map.territories.length);
    expect(arenaMap(7)).toEqual(arenaMap(7));
  });

  it('hides what a player cannot see under fog', () => {
    const { map } = arenaMap(3);
    const g = buildGraph(map);
    const cells = new Map(map.territories.map((t) => [t.id, { owner: 'neutral' as const, armies: 2 }]));
    cells.set(1, { owner: 101 as never, armies: 4 });
    const v = viewOf(g, cells as never, 101, true);
    const hidden = v.territories.filter((t) => t.owner.kind === 'unknown').length;
    expect(hidden).toBeGreaterThan(map.territories.length / 2);
  });

  it('plays a whole game deterministically', () => {
    const a = playArena({ seed: 11, bots: [plannerBot('planner'), spreaderBot()], maxTurns: 12, fog: true });
    const b = playArena({ seed: 11, bots: [plannerBot('planner'), spreaderBot()], maxTurns: 12, fog: true });
    expect(a).toEqual(b);
    expect(a.turns).toBeGreaterThan(0);
    expect(a.incomes[0].length).toBe(a.turns);
  }, 120_000);

  it('plays the research switches and reports each plan', () => {
    let plans = 0;
    const research = plannerBot(
      'research',
      { experiments: ['deploy-once', 'no-short-gates', 'no-gate-stop', 'no-frontier-veto', 'legacy-topup'] },
      () => plans++,
    );
    const r = playArena({ seed: 5, bots: [research, plannerBot('base')], maxTurns: 10, fog: true });
    expect(plans).toBe(r.turns);
    expect(r.winner === null || r.winner === 0 || r.winner === 1).toBe(true);
  }, 120_000);

  it('cuts orders to what war.app would take', () => {
    const out = legal(
      { deploys: [{ territoryId: 1, armies: 4 }, { territoryId: 2, armies: 9 }, { territoryId: 3, armies: 3 }], moves: [{ from: 1, to: 2, armies: 2 }, { from: 9, to: 2, armies: 2 }, { from: 1, to: 3, armies: 0 }] },
      101,
      new Set([1, 3]),
      5,
    );
    expect(out.deploys).toEqual([{ territoryId: 1, armies: 4 }, { territoryId: 3, armies: 1 }]);
    expect(out.moves).toEqual([{ from: 1, to: 2, armies: 2 }]);
  });

  it('decides a game with no fog on points or elimination', () => {
    const r = playArena({ seed: 2, bots: [spreaderBot('a'), spreaderBot('b')], maxTurns: 6, width: 6, height: 5 });
    expect(['points', 'eliminated', 'draw']).toContain(r.by);
  });
});
