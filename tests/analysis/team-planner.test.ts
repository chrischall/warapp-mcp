// PLAN-TEAMS C3: the planner with a teammate, on synthetic 2v2 boards (every id and name is made up).
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const MATE = 11;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const PLAYERS = [
  { id: ME, team: 0 },
  { id: MATE, team: 0 },
  { id: 20, team: 1 },
  { id: 21, team: 1 },
];

function lineMap(n: number): GameMap {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  return {
    id: 1,
    name: 'Line',
    territories: ids.map((id) => ({ id, name: `T${id}`, connectedTo: ids.filter((x) => Math.abs(x - id) === 1) })),
    bonuses: [],
    distributionModes: [],
  };
}
const player = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

describe("C3.1: a teammate's territory is no front for idle armies", () => {
  // 1 (enemy 20) ─ 2 (my teammate) ─ 3 4 5 6 (mine, 20 idle on 4) ─ 7 (a 60-army neutral).
  // No enemy is reachable through my territories, so idle armies head for the nearest territory
  // not mine: the teammate's 2 is two steps from 4, the neutral 7 three. A teammate's territory is
  // no front, so they head right, for the neutral.
  const g = buildGraph(lineMap(7));
  const b = board([player(1, 5, 20), player(2, 5, MATE), mine(3, 2), mine(4, 20), mine(5, 2), mine(6, 2), neutral(7, 60)]);
  const plan = planTurn({ graph: g, board: b, me: ME, income: 5, settings: STD, game: { players: PLAYERS, turn: 8 }, options: { adapt: true } });
  it('moves the idle stack toward the neutral, not toward the teammate', () => {
    const from4 = plan.moves.filter((m) => m.from === 4 && m.kind === 'transfer');
    expect(from4.map((m) => m.to)).toEqual([5]);
    expect(plan.moves.some((m) => m.to === 3 && m.kind === 'transfer')).toBe(false);
  });
  it('a no-team game still heads for the nearest territory not mine', () => {
    const solo = planTurn({
      graph: g,
      board: board([neutral(1, 5), neutral(2, 5), mine(3, 2), mine(4, 20), mine(5, 2), mine(6, 2), neutral(7, 60)]),
      me: ME,
      income: 5,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }], turn: 8 },
      options: { adapt: true },
    });
    expect(solo.moves.filter((m) => m.from === 4 && m.kind === 'transfer').map((m) => m.to)).toEqual([3]);
  });
});
