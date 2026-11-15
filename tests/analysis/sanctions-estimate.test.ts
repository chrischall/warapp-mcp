// G2 (PLAN-TEAMS D3): Sanctions on another player the decoder is sure of cut its deploy estimate when
// the figure is read off the board, and only warn otherwise. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings } from '../../src/analysis/planner.js';
import { applySanctions } from '../../src/analysis/plan/estimates.js';
import type { EnemyDeployEstimate } from '../../src/analysis/plan/shared.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, baseIncome: 5 };
const enemy = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: FOE }, armies });

// T1 (mine) faces the foe's T2; the foe holds bonus 900 = {2, 3} (+10), so it earns 5 + 10 = 15.
const map: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2] },
    { id: 2, name: 'T2', connectedTo: [1, 3] },
    { id: 3, name: 'T3', connectedTo: [2] },
  ],
  bonuses: [{ id: 900, name: 'B900', value: 10, territoryIds: [2, 3], bonusIds: [] }],
  distributionModes: [],
};
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  graph: buildGraph(map),
  board: board([mine(1, 30), enemy(2, 4), enemy(3, 2)]),
  me: ME,
  income: 5,
  settings: STD,
  game: { players: [{ id: ME }, { id: FOE }], turn: 6 },
  ...over,
});

describe('G2: Sanctions on another player in the estimates', () => {
  it('cut a visible-bonus estimate by the client rule, and say so', () => {
    const plain = planTurn(input());
    expect(plain.enemyDeploy).toBe(15);
    const p = planTurn(input({ sanctions: [{ player: FOE, percentage: 0.5, untilTurn: 7 }] }));
    expect(p.enemyDeploy).toBe(8); // round(0.5 × 15), .5 up
    expect(p.warnings.join('\n')).toMatch(/Player 20 is under Sanctions \(50%, until turn 7, .*unverified decoder\): its estimate is cut from ~15 to ~8/);
  });

  it('leave an estimate unchanged without Sanctions on that player', () => {
    const p = planTurn(input({ sanctions: [{ player: 99, percentage: 0.5, untilTurn: 7 }] }));
    expect(p.enemyDeploy).toBe(15);
    expect(p.warnings.join('\n')).not.toMatch(/Sanctions/);
  });

  it('leave an observed, tracked or prior figure whole, marked not applied; a card stays on top of a cut', () => {
    const base = { playerId: FOE, estimate: 15, card: null } as unknown as EnemyDeployEstimate;
    const s = [{ player: FOE, percentage: 0.5, untilTurn: 7 }];
    for (const source of ['observed', 'tracked', 'prior'] as const) {
      const [e] = applySanctions([{ ...base, source }], s);
      expect(e).toMatchObject({ estimate: 15, sanctioned: { applied: false, before: 15, percentages: [0.5] } });
    }
    const [carded] = applySanctions([{ ...base, source: 'visible', estimate: 20, card: { armies: 5, due: 4 } }], s);
    expect(carded).toMatchObject({ estimate: 13, sanctioned: { applied: true, before: 15 } });
    // Two cards compound.
    const [two] = applySanctions([{ ...base, source: 'exact' }], [...s, { player: FOE, percentage: 0.5, untilTurn: 8 }]);
    expect(two).toMatchObject({ estimate: 4, sanctioned: { percentages: [0.5, 0.5], untilTurn: 8 } });
  });
});
