// #293: under Local Deployment a border faces the opponent's free income plus the pool of a bonus its
// stack there stands in (one it could hold), never a tracked total or a prior above that; a next-turn
// judgement also counts its visible stacks one step behind the front; check_plan's stress replies agree.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { observeDeploy, planTurn, type PlanInput, type PlannerSettings } from '../../src/analysis/planner.js';
import { stressPlan } from '../../src/analysis/stress.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, luckModifier: 0, roundingMode: 'StraightRound' };
const LD: PlannerSettings = { ...STD, localDeployments: true };

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
const foe = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: FOE }, armies });
const text = (p: { warnings: string[]; rationale: string[] }) => [...p.warnings, ...p.rationale].join('\n');

describe('a prior above free income and the local pool never lands on one border (#293)', () => {
  // 1 2 mine (+3 bonus 101); its 3 (12) next to my 2, in no bonus; 4 its own; behind it the fog holds
  // its possible +20 (5 6) and +15 (7 8). A 1v1 that started even: the prior is my income, 30.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6, 7, 8],
      [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [4, 7], [7, 8]],
      [[101, 3, [1, 2]], [102, 20, [5, 6]], [103, 15, [7, 8]]],
    ),
  );
  const b = board([mine(1, 1), mine(2, 20), foe(3, 12), foe(4, 1), fogged(5), fogged(6), fogged(7), fogged(8)]);
  const input = (settings: PlannerSettings): PlanInput => ({
    graph: g,
    board: b,
    me: ME,
    income: 30,
    settings,
    turn: 10,
    game: { players: [{ id: ME }, { id: FOE }], turn: 10, symmetricStart: true },
    options: { goal: 'defend' },
  });

  it('under Local Deployment the gate outside its bonuses faces its free income alone', () => {
    const plan = planTurn(input(LD));
    // 11 movable + its free 5 = 16: 20 hold, no "could be taken" line for T2.
    expect(text(plan)).not.toMatch(/T2 \(#2\) \(20 armies\) could be taken/);
    expect(text(plan)).toMatch(/a prior/);
  });

  it('without Local Deployment the whole prior lands there (unchanged)', () => {
    const plan = planTurn(input(STD));
    expect(text(plan)).toMatch(/T2 \(#2\) \(20 armies\) could be taken next turn: player 20 has 11 movable armies next to it plus ~30 deploy/);
  });

  it('check_plan tries the same bound', () => {
    const stress = (localDeployments: boolean) =>
      stressPlan({
        graph: g,
        board: b,
        me: ME,
        deploys: [],
        moves: [],
        opponents: [{ id: FOE, deploy: 30, base: 5 }],
        settings: STD,
        firstMover: 'opponent',
        ...(localDeployments ? { localDeployments: true } : {}),
      });
    expect(stress(true).safe).toBe(true);
    expect(stress(false).safe).toBe(false);
  });

  it('a pool it could hold out of sight lands on its stack inside that bonus', () => {
    // Its stack now on 5 (in the fogged +20 with 6), next to my 2 by a new edge.
    const g2 = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5, 6, 7, 8],
        [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [4, 7], [7, 8], [2, 5]],
        [[101, 3, [1, 2]], [102, 20, [5, 6]], [103, 15, [7, 8]]],
      ),
    );
    const b2 = board([mine(1, 1), mine(2, 20), neutral(3, 2), foe(4, 1), foe(5, 12), fogged(6), fogged(7), fogged(8)]);
    const plan = planTurn({ ...input(LD), graph: g2, board: b2 });
    // Free 5 + the +20 it could hold there, within the prior's 30: 25.
    expect(text(plan)).toMatch(/T2 \(#2\) \(20 armies\) could be taken next turn: player 20 has 11 movable armies next to it plus ~25 deploy/);
  });
});

describe('a next-turn judgement counts its visible stacks one step behind the front (#293)', () => {
  // 1 2 mine; the bonus 102 (3 4) I can complete by taking 4 (neutral 1) from 3 (mine). Its stack 5 (2)
  // sits next to 4; one step behind, its 6 (25) can walk up this turn and attack next turn.
  const g = buildGraph(
    makeMap([1, 2, 3, 4, 5, 6, 7], [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]], [[102, 4, [3, 4]], [103, 1, [6, 7]]]),
  );
  const b = board([mine(1, 1), mine(2, 1), mine(3, 12), neutral(4, 1), foe(5, 2), foe(6, 25), foe(7, 1)]);
  const plan = (settings: PlannerSettings) =>
    planTurn({ graph: g, board: b, me: ME, income: 5, settings, options: { goal: 'balanced', enemyDeploy: undefined } });

  it('under Local Deployment the completion is judged against the stack behind too', () => {
    const p = plan(LD);
    expect(text(p)).toMatch(/indefensible/);
  });

  it('without Local Deployment it is not (unchanged)', () => {
    const p = plan(STD);
    expect(text(p)).not.toMatch(/indefensible/);
  });
});

describe('under Local Deployment, growth beside the fog outside its pools is not read past its free income (#293)', () => {
  // My 1 beside its 2; its 3 behind 2 (no hidden neighbour); 2 borders the fogged 4. Bonus 101 (5 6) is
  // mine in part, so it could hold no bonus containing 2 or 3.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5, 6], [[1, 2], [2, 3], [2, 4], [1, 5], [5, 6]], [[101, 9, [5, 6]]]));
  const at = (a2: number, a3: number) => board([mine(1, 10), foe(2, a2), foe(3, a3), fogged(4), mine(5, 1), neutral(6, 1)]);

  it('a stack out of the fog is a move beyond the free income', () => {
    const plain = observeDeploy(g, at(20, 1), at(4, 1), FOE, STD, { me: ME, expected: 10 });
    expect(plain.deploy).toBe(16);
    const local = observeDeploy(g, at(20, 1), at(4, 1), FOE, LD, { me: ME, expected: 10, localFree: 5 });
    expect(local.deploy).toBe(5);
    expect(local.grewFromFog).toEqual([2]);
    expect(local.fogGrowth).toBe(11);
    expect(local.localCut).toEqual({ free: 5, territories: [2] });
    expect(plain.localCut).toBeUndefined();
  });

  it('a walk from a neighbour in view nets its shrink, never deploy', () => {
    // 3 sent 10 into 2, which grew 12: a walk of 10 and 2 more.
    const local = observeDeploy(g, at(16, 1), at(4, 11), FOE, LD, { me: ME, expected: 10, localFree: 1 });
    expect(local.deploy).toBe(1);
    expect(local.low).toBe(0);
  });

  it('inside a bonus it could hold the pool may have paid for it (unchanged)', () => {
    const g2 = buildGraph(makeMap([1, 2, 3, 4, 5, 6], [[1, 2], [2, 3], [2, 4], [1, 5], [5, 6]], [[101, 9, [2, 4]]]));
    const local = observeDeploy(g2, at(20, 1), at(4, 1), FOE, LD, { me: ME, expected: 10, localFree: 5 });
    expect(local.deploy).toBe(16);
  });
});
