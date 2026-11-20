// Issue #361: single-army jabs. At 0% luck under straight rounding one attacking army kills round(0.6) = 1
// defender and dies: a one-for-one trade. The plan spends armies beyond a source's hold on them, one per
// enemy stack, against an opponent I out-earn or out-army, and reports them as attrition. Every map, id
// and name here is made up. Kill rates 60/70, guard on.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  return {
    id: 1,
    name: 'Synthetic jabs',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const enemy = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: ENEMY }, armies });

// My T1 (30) faces the opponent's T5 (4, in no bonus): balanced attacks no plain player territory, and T1
// holds against 3 + a deploy of 5 with plenty to spare. My T2 takes the neutral T3 (so rule 4e's fallback
// does not attack T5).
const MAP = makeMap([1, 2, 3, 5, 6], [[1, 2], [2, 3], [1, 5], [5, 6]], [[1, 2, [1, 2]]]);
const rest = [mine(2, 5), neutral(3, 1), enemy(6, 2)];
const BOARD = board([mine(1, 30), enemy(5, 4), ...rest]);

const input = (s: Partial<PlannerSettings> = {}, b = BOARD): PlanInput => ({
  graph: buildGraph(MAP),
  board: b,
  me: ME,
  income: 7,
  settings: { ...STD, ...s },
  game: { players: [{ id: ME, state: 'Playing' }, { id: ENEMY, state: 'Playing' }] } as PlanInput['game'],
  options: { goal: 'balanced', jabs: true },
});

describe('#361 single-army jabs', () => {
  it('jabs an enemy stack with one army from the armies beyond the hold, and reports it as attrition', () => {
    const p = planTurn(input());
    const jab = p.moves.filter((m) => m.kind === 'attack' && m.to === 5);
    expect(jab).toEqual([expect.objectContaining({ from: 1, to: 5, armies: 1, winChance: 0 })]);
    expect(p.jabs).toEqual([{ from: 1, to: 5, player: ENEMY, defenders: 4, kills: 1, loses: 1, why: 'attrition' }]);
    expect(p.expected.captures).not.toContain(5);
    expect(p.rationale.join('\n')).toMatch(/Jab \(#361\)/);
  });

  it('off unless asked for (outside a siege)', () => {
    expect(planTurn({ ...input(), options: { goal: 'balanced' } }).jabs).toBeUndefined();
  });

  it('never under luck or weighted rounding, nor where one army kills nothing', () => {
    expect(planTurn(input({ luckModifier: 0.15 })).jabs ?? []).toEqual([]);
    expect(planTurn(input({ roundingMode: 'WeightedRandom' })).jabs ?? []).toEqual([]);
    expect(planTurn(input({ offensiveKillRate: 40 })).jabs ?? []).toEqual([]);
  });

  it('never a lone defender (the jab and it destroy each other: nothing traded)', () => {
    const p = planTurn(input({}, board([mine(1, 30), enemy(5, 1), ...rest])));
    expect((p.jabs ?? []).map((j) => j.to)).not.toContain(5);
  });

  it('never against an opponent who out-earns and out-armies me', () => {
    const big = board([mine(1, 30), enemy(5, 40), mine(2, 5), neutral(3, 1), enemy(6, 40)]);
    const p = planTurn({ ...input({}, big), options: { goal: 'balanced', jabs: true, enemyDeploy: 20 } });
    expect(p.jabs ?? []).toEqual([]);
  });
});
