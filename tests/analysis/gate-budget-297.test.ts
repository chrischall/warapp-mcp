// #297: in a 1v1 every border facing the opponent is a gate, each sized for his stack beside it plus his whole
// deploy, and every new gate costs that again. The plan reports the gate budget and does not open a gate the
// budget cannot pay for. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
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

// My gates T1 and T2 (10 each) face player 20's T11 and T12; my T3 (30) stands behind both and beside the
// neutral T4 (2), which with T5 makes the +3 bonus B900 — and which borders player 20's T13: taking T4
// opens a third gate. Income 5, his deploy ~5.
const EDGES: [number, number][] = [[1, 2], [2, 3], [1, 3], [3, 4], [4, 5], [1, 11], [2, 12], [4, 13], [11, 12], [12, 13]];
const plan = (stacks: number, players = [{ id: ME }, { id: 20 }]): TurnPlan =>
  planTurn({
    graph: buildGraph(makeMap([1, 2, 3, 4, 5, 11, 12, 13], EDGES, [[900, 3, [4, 5]]])),
    board: board([mine(1, 10), mine(2, 10), mine(3, 30), neutral(4, 2), neutral(5, 2), enemy(11, stacks, 20), enemy(12, stacks, 20), enemy(13, stacks, 20)]),
    me: ME,
    income: 5,
    settings: STD,
    game: { players, turn: 9 },
    options: { adapt: true, enemyDeploy: 5 },
  });

// #603: the gate budget no longer vetoes a capture (the self-play arena measured no gain from it); it stays a report.
describe('#297: the gate budget in a 1v1', () => {
  it('reports the gates: what they need against one floating deploy, what stands on them, the income and the shortfall', () => {
    // Here the strike on T11 and the step into T4 both land, leaving three gates (T2, T4, T11).
    const p = plan(6);
    expect(p.gates).toBeDefined();
    const g = p.gates!;
    expect(g.player).toBe(20);
    expect(g.gates.map((x) => x.id)).toEqual([2, 4, 11]);
    expect(g.need).toBe(g.gates.reduce((n, x) => n + x.needs, 0));
    expect(g.onGates).toBe(g.gates.reduce((n, x) => n + x.armies, 0));
    expect(g.deficit).toBe(g.gates.reduce((n, x) => n + Math.max(0, x.needs - x.armies), 0));
    // The income is the same figure the frontier is judged on; rule 4d now counts the floating deploy once (#603),
    // so its hold cost is at most the gates' summed deficit.
    expect(p.frontier.holdCost).toBeLessThanOrEqual(g.deficit);
    expect(g.income).toBe(p.frontier.income);
    expect(g.short).toBe(Math.max(0, g.deficit - g.income));
    // #603: no veto and no warning any more; the budget is a report.
    expect(p.warnings.join('\n')).not.toMatch(/Gate budget/);
  });

  it('reports a shortfall the gates already had, conceded gates included, without a warning (no capture opened one)', () => {
    // Stacks of 20 beside gates of 10: the plan concedes both and pulls back, but they stay the ways in.
    const p = plan(20);
    expect(p.gates!.gates.map((x) => x.id)).toEqual([1, 2]);
    expect(p.gates!.gates.every((x) => x.conceded)).toBe(true);
    expect(p.gates!.short).toBeGreaterThan(0);
    expect(p.warnings.join('\n')).not.toMatch(/Gate budget/);
  });

  it('is a 1v1 measure only: a free-for-all reports no gate budget and keeps rule 4d as it was', () => {
    const p = plan(6, [{ id: ME }, { id: 20 }, { id: 30 }]);
    expect(p.gates).toBeUndefined();
    expect(p.rationale.join('\n')).not.toMatch(/#297/);
  });
});
