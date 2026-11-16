// #276: with One Army Must Stand Guard off an advancing stack loses nothing per step — no army is
// left behind on the territory it leaves, nor on the one it takes on the way. The two-step reach
// (`twoStepReaches`, lookahead.ts) and the planner's two-step hold (#172) must count it whole.
// Synthetic map and made-up ids only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { twoStepReaches } from '../../src/analysis/lookahead.js';
import { straightKills } from '../../src/analysis/combat.js';
import { planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const DEPLOY = 5;
const STACK = 30;
const NEUTRAL = 8;

//   T3 (enemy 30) ─ T2 (neutral 8) ─ T1 (+12 bonus, mine 28) ─ T4 (mine 50) ─ T5 (enemy 60)
//
// Rule 6 sends T1's idle armies to the front at T4; the two-step hold keeps back what T1 needs.
const MAP: GameMap = {
  id: 1,
  name: 'Whole',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2, 4] },
    { id: 2, name: 'T2', connectedTo: [1, 3] },
    { id: 3, name: 'T3', connectedTo: [2] },
    { id: 4, name: 'T4', connectedTo: [1, 5] },
    { id: 5, name: 'T5', connectedTo: [4] },
  ],
  bonuses: [{ id: 101, name: 'B101', value: 12, territoryIds: [1], bonusIds: [] }],
  distributionModes: [],
};
const enemy = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: ENEMY }, armies });
const B = board([mine(1, 28), neutral(2, NEUTRAL), enemy(3, STACK), mine(4, 50), enemy(5, 60)]);
const settings = (guard: boolean): PlannerSettings => ({ offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: guard });
const reach = (guard: boolean) =>
  twoStepReaches({ graph: buildGraph(MAP), board: B, me: ME, opponents: [{ id: ENEMY, deploy: DEPLOY }], settings: settings(guard) }).find(
    (r) => r.territory === 1,
  )!;

describe('guard off: a stack arrives whole two steps on (#276)', () => {
  it('twoStepReaches counts every army: the stack, two deploys, less only the armies the neutral kills', () => {
    const lost = straightKills(NEUTRAL, 70);
    const off = reach(false);
    expect(off).toMatchObject({ from: 3, via: 2, territory: 1 });
    expect(off.attackers).toBe(STACK + 2 * DEPLOY - lost);
  });

  it('with the guard on the same advance leaves one army behind at each step', () => {
    expect(reach(true).attackers).toBe(reach(false).attackers - 2);
    expect(reach(true).needs).toBeLessThanOrEqual(reach(false).needs);
  });

  it("the planner's two-step hold keeps what the whole stack needs, one army more than with the guard on", () => {
    const plan = (guard: boolean) =>
      planTurn({
        graph: buildGraph(MAP),
        board: B,
        me: ME,
        income: 40,
        settings: settings(guard),
        game: { players: [{ id: ME }, { id: ENEMY }], turn: 7 },
        options: { goal: 'balanced', enemyDeploy: DEPLOY },
      });
    const kept = (guard: boolean) => {
      const p = plan(guard);
      const r = reach(guard);
      expect(p.rationale.join('\n')).toContain(`kept ${r.needs} on T1 (#1): player 20 can reach it next turn from T3 (#3) via T2 (#2) (~${r.attackers} attacking; it needs ${r.needs} to hold))`);
      const leaving = p.moves.filter((m) => m.from === 1).reduce((n, m) => n + m.armies, 0);
      return 28 + (p.deploys.find((d) => d.territoryId === 1)?.armies ?? 0) - leaving;
    };
    // 34 attacking need 21 (the guard off) where 32 need 20 (the guard on).
    expect(reach(false)).toMatchObject({ attackers: 34, needs: 21 });
    expect(kept(false)).toBe(21);
    expect(kept(true)).toBe(20);
  });
});
