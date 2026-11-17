// #291: a gate gets credit for what its loss opens, and the territory behind a conceded border is not
// treated as interior. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { opensBehind } from '../../src/analysis/opens.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  return {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const enemy = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const outOf = (p: TurnPlan, t: number) => p.moves.filter((m) => m.from === t);

describe('opensBehind (#291)', () => {
  // T1 is the only way from the enemy's T2 to my T3–T6; B901 (+10) is T5 and T6.
  const edges: [number, number][] = [
    [1, 2],
    [1, 3],
    [3, 4],
    [4, 5],
    [5, 6],
  ];
  const g = buildGraph(makeMap([1, 2, 3, 4, 5, 6], edges, [[901, 10, [5, 6]]]));
  const holdings = new Set([1, 3, 4, 5, 6]);
  const source = (x: number) => x === 2;

  it('names my territories every route from a source reaches only through it, and the held bonuses among them', () => {
    expect(opensBehind(g, holdings, source, 1, new Set())).toEqual({ ids: [3, 4, 5, 6], bonuses: [901], income: 10 });
  });

  it('opens nothing when another route reaches them', () => {
    const g2 = buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7], [...edges, [6, 7]], [[901, 10, [5, 6]]]));
    expect(opensBehind(g2, holdings, (x) => x === 2 || x === 7, 1, new Set())).toEqual({ ids: [], bonuses: [], income: 0 });
  });

  it('leaves out its own bonuses and a bonus with a member already counted elsewhere', () => {
    const g3 = buildGraph(makeMap([1, 2, 3, 4, 5, 6], edges, [[901, 10, [5, 6]], [902, 3, [1, 3]]]));
    expect(opensBehind(g3, holdings, source, 1, new Set()).bonuses).toEqual([901]);
    expect(opensBehind(g, holdings, source, 1, new Set([6]))).toMatchObject({ bonuses: [], income: 0 });
  });
});

describe('#291 1: a conceded gate gets credit for what its loss opens', () => {
  // My T1 (2) is the only way from player 20's T2 (9) to my T3, T4 (1 each) and the +10 bonus B901
  // (T5, T6). Holding T1 needs ~10 against 9 + its ~5 deploy. Without #291 T1 protects nothing (no
  // bonus holds it, its loss cuts nothing off) and is conceded; with it T1 protects half of the +10
  // its loss opens, and is held.
  const run = (gate: boolean) =>
    planTurn({
      graph: buildGraph(
        makeMap(
          [1, 2, 3, 4, 5, 6, 7],
          [[1, 2], [1, 3], [3, 4], [4, 5], [5, 6], ...(gate ? [] : ([[2, 6]] as [number, number][])), [6, 7]],
          [[901, 10, [5, 6]]],
        ),
      ),
      board: board([mine(1, 2), enemy(2, 9, 20), mine(3, 1), mine(4, 1), mine(5, 1), mine(6, 1), neutral(7, 30)]),
      me: ME,
      income: 15,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }], turn: 6 },
      options: { goal: 'balanced', enemyDeploy: 5 },
    });

  it('the only way in: held, and the rationale names what its loss opens', () => {
    const p = run(true);
    expect(p.conceded).not.toContain(1);
    expect(p.deploys.some((d) => d.territoryId === 1)).toBe(true);
    expect(p.rationale.join('\n')).toMatch(/T1 \(#1\) is the only way in to T3 \(#3\), T4 \(#4\), T5 \(#5\), T6 \(#6\) \(\+10 income\): losing it opens them to the enemy, so its value counts half of that \(\+5\) \(#291\)/);
  });

  it('with another way in, its loss opens nothing: no credit, it protects +0 as before', () => {
    const p = run(false);
    expect(p.rationale.join('\n')).not.toMatch(/is the only way in/);
    expect(p.rationale.join('\n')).toMatch(/protects \+0\)/);
  });
});

describe('#291 2: the territory behind a conceded border keeps a hold against the stack two steps away', () => {
  // My T1 (1) faces player 20's 34 on T2 and is conceded: T3's 20 could not make it hold (#257). Behind
  // it T3 (21) is the only way from T1 into my +5 bonus B901 (T4, T5); T3 is not in it. T3 also links to
  // my T6 → T7, which faces player 20's T8 (3): rule 6 moved T3's idle armies toward that front, leaving
  // T3 at 1 right behind the border it concedes. Now T3 keeps what holds it against the stack that can
  // take T1 this turn and attack it next (with next turn's income, it can).
  const plan = () =>
    planTurn({
      graph: buildGraph(
        makeMap(
          [1, 2, 3, 4, 5, 6, 7, 8],
          [
            [1, 2],
            [1, 3],
            [3, 4],
            [4, 5],
            [3, 6],
            [6, 7],
            [7, 8],
          ],
          [[901, 5, [4, 5]]],
        ),
      ),
      board: board([mine(1, 1), enemy(2, 34, 20), mine(3, 21), mine(4, 1), mine(5, 1), mine(6, 1), mine(7, 5), enemy(8, 3, 20)]),
      me: ME,
      income: 5,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }], turn: 12 },
      options: { goal: 'balanced', enemyDeploy: 5 },
    });

  it('keeps a two-step hold on T3 instead of moving its armies away', () => {
    const p = plan();
    expect(p.conceded).toContain(1);
    expect(outOf(p, 3)).toEqual([]);
    expect(p.rationale.join('\n')).toMatch(/Hold T3 \(#3\) against a stack two steps away \(kept 21 on T3 \(#3\): player 20 can reach it next turn from T2 \(#2\) via T1 \(#1\)/);
  });
});

describe('#291 2, review: a stack that can make the conceded border hold still steps into it (#257)', () => {
  // As above, but T2 holds 30: T3's 20 make T1 hold, which cuts the reach through it. The two-step hold on
  // T3 must not keep those armies home: they hold T1 itself.
  it('T3 transfers into T1 and T1 is held after all', () => {
    const p = planTurn({
      graph: buildGraph(
        makeMap([1, 2, 3, 4, 5, 6, 7, 8], [[1, 2], [1, 3], [3, 4], [4, 5], [3, 6], [6, 7], [7, 8]], [[901, 5, [4, 5]]]),
      ),
      board: board([mine(1, 1), enemy(2, 30, 20), mine(3, 21), mine(4, 1), mine(5, 1), mine(6, 1), mine(7, 5), enemy(8, 3, 20)]),
      me: ME,
      income: 5,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }], turn: 12 },
      options: { goal: 'balanced', enemyDeploy: 5 },
    });
    expect(p.conceded).not.toContain(1);
    expect(outOf(p, 3)).toEqual([expect.objectContaining({ to: 1, armies: 20 })]);
  });
});
