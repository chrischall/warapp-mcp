// Issue #179: finishing a player — cover its exits, count the turns, price the elimination and
// order the killing strike first. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardSpecialUnit, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { captureCost, guaranteedFallsReaching, planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine } from './helpers.js';

const ME = 10;
const VICTIM = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, baseIncome: 5 };

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
const enemy = (territoryId: number, armies: number, playerId = VICTIM): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const commander = (playerId: number): BoardSpecialUnit => ({ kind: 'commander', id: `${playerId}`.padStart(32, '0'), playerId });
const withCommander = (t: TerritoryState, playerId: number): TerritoryState => ({ ...t, specialUnits: [commander(playerId)] });
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const attackOn = (p: TurnPlan, to: number) => attacks(p).find((m) => m.to === to);

// Me: 1 2 3 (+ 4 behind); the victim: 5 6 7, holding bonus V (+4) = 6 7. Each of its
// territories faces one of mine. Its estimate is 5 base + 4 = ~9; under Local Deployment
// the +4 lands only on 6 or 7, so 5 can be reinforced with ~5 at most.
const LD_MAP = makeMap(
  [1, 2, 3, 4, 5, 6, 7],
  [[1, 2], [2, 3], [3, 4], [1, 5], [2, 6], [3, 7], [5, 6], [6, 7]],
  [[100, 4, [6, 7]]],
);
const LD_BOARD = board([mine(1, 3), mine(2, 3), mine(3, 3), mine(4, 3), enemy(5, 2), enemy(6, 2), enemy(7, 2)]);

describe('#179 Local Deployment: finishing off sizes each territory for the deploy that can reach it', () => {
  it('guaranteedFallsReaching: a target whose save needs more than can reach it falls for sure', () => {
    // Without reach limits it is guaranteedFalls: the cheapest saves first.
    expect(guaranteedFallsReaching([3, 4], [6, 6], 6)).toBe(1);
    // 4 cannot reach the second target (its pool is elsewhere): it can save only the first.
    expect(guaranteedFallsReaching([3, 3], [6, 2], 6)).toBe(1);
    expect(guaranteedFallsReaching([3, 3], [2, 2], 6)).toBe(2);
    expect(guaranteedFallsReaching([0, 5], [0, 5], 5)).toBe(0);
    expect(guaranteedFallsReaching([], [], 5)).toBe(0);
  });

  it('rule 1e: the territory outside its pooled bonus is sized for its free deploy only', () => {
    const off = planTurn({ graph: buildGraph(LD_MAP), board: LD_BOARD, me: ME, income: 60, settings: STD });
    const on = planTurn({ graph: buildGraph(LD_MAP), board: LD_BOARD, me: ME, income: 60, settings: { ...STD, localDeployments: true } });
    for (const p of [off, on]) expect(p.rationale.join('\n')).toMatch(/Finish off player 20/);
    expect(attackOn(off, 5)!.armies).toBe(captureCost(2 + 9, STD));
    expect(attackOn(on, 5)!.armies).toBe(captureCost(2 + 5, STD));
    expect(attackOn(on, 5)!.reason).toMatch(/~5 of its deploy that can reach it/);
    // The pooled bonus's territories still face all of it.
    expect(attackOn(on, 6)!.armies).toBe(captureCost(2 + 9, STD));
    expect(attackOn(on, 7)!.armies).toBe(captureCost(2 + 9, STD));
  });

  it('rule 1s: a commander outside its pooled bonus is struck sized for its free deploy only', () => {
    const b = board([mine(1, 3), mine(2, 3), mine(3, 3), mine(4, 3), withCommander(enemy(5, 2), VICTIM), enemy(6, 2), enemy(7, 2)], true);
    const on = planTurn({ graph: buildGraph(LD_MAP), board: b, me: ME, income: 30, settings: { ...STD, localDeployments: true } });
    expect(attackOn(on, 5)!.armies).toBe(captureCost(2 + 7 + 5, STD));
    expect(attackOn(on, 5)!.reason).toMatch(/~5 deploy that can reach it/);
    const off = planTurn({ graph: buildGraph(LD_MAP), board: b, me: ME, income: 30, settings: STD });
    expect(attackOn(off, 5)!.armies).toBe(captureCost(2 + 7 + 9, STD));
  });
});
