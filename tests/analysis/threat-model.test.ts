// Issue #128: the smaller gaps in the planner's threat model, each on a synthetic map (every id
// and name here is made up).
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Threats',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const player = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const deployedTo = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
const attacksOn = (p: TurnPlan, id: number) => p.moves.filter((m) => m.kind === 'attack' && m.to === id);

describe('teammates are allies (#128)', () => {
  // 1 2 mine (+4); 3 4 a teammate's (+3), 3 holding 20 next to my 2; 5 6 neutral; 7 an enemy far off.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6, 7],
      [[1, 2], [2, 3], [3, 4], [1, 5], [5, 6], [6, 7]],
      [[101, 4, [1, 2]], [102, 3, [3, 4]]],
    ),
  );
  const TEAMMATE = 11;
  const players = [
    { id: ME, team: 0 },
    { id: TEAMMATE, team: 0 },
    { id: 20, team: 1 },
    { id: 21, team: 1 },
  ];
  it("a teammate's stack next to my held bonus is no threat: nothing is conceded or withdrawn", () => {
    const b = board([mine(1, 3), mine(2, 3), player(3, 20, TEAMMATE), player(4, 2, TEAMMATE), neutral(5, 2), neutral(6, 2), player(7, 3, 20)]);
    const plan = planTurn({ graph: g, board: b, me: ME, income: 9, settings: STD, game: { players, turn: 8 }, options: { adapt: true } });
    expect(plan.conceded).toEqual([]);
    expect(plan.moves.filter((m) => m.from === 2 && m.kind === 'transfer')).toEqual([]);
    expect(plan.warnings.join('\n')).not.toMatch(/estimate for player 11/);
    expect(plan.rationale.join('\n')).not.toMatch(/cannot be held economically/);
  });
  it('a weak teammate in reach of a big stack is never attacked', () => {
    const b = board([mine(1, 3), mine(2, 30), player(3, 2, TEAMMATE), player(4, 1, TEAMMATE), neutral(5, 2), neutral(6, 2), player(7, 3, 20)]);
    const plan = planTurn({ graph: g, board: b, me: ME, income: 9, settings: STD, game: { players, turn: 8 }, options: { adapt: true } });
    expect(attacksOn(plan, 3)).toEqual([]);
    expect(attacksOn(plan, 4)).toEqual([]);
    expect(plan.expected.captures).not.toContain(3);
    expect(plan.expected.captures).not.toContain(4);
  });
  it('without the team list the same player is an opponent (unchanged)', () => {
    const b = board([mine(1, 3), mine(2, 30), player(3, 2, TEAMMATE), player(4, 1, TEAMMATE), neutral(5, 2), neutral(6, 2), player(7, 3, 20)]);
    const plan = planTurn({ graph: g, board: b, me: ME, income: 9, settings: STD, options: { adapt: true } });
    expect(attacksOn(plan, 3).length + attacksOn(plan, 4).length).toBeGreaterThan(0);
  });
});
