// #275 (b): while an opponent's estimate is untrusted (the tripwire, src/analysis/tripwire.ts), a
// border of a bonus I hold is sized for the larger of what tripped it and my own income, not for the
// estimate. Every other border keeps the estimate. Synthetic map; every id is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

//   Home (+6): 1 2 — mine; 2 faces the enemy stack of 10 on 3.
//   7: mine, in no bonus, also beside 3.
//   East (+3): 5 6 — 2-army neutrals reached from 1.
const MAP: GameMap = {
  id: 1,
  name: 'Untrusted',
  territories: [
    [1, [2, 5]],
    [2, [1, 3]],
    [3, [2, 7]],
    [5, [1, 6]],
    [6, [5]],
    [7, [3]],
  ].map(([id, connectedTo]) => ({ id: id as number, name: `T${id}`, connectedTo: connectedTo as number[] })),
  bonuses: [
    { id: 501, name: 'Home', value: 6, territoryIds: [1, 2], bonusIds: [] },
    { id: 502, name: 'East', value: 3, territoryIds: [5, 6], bonusIds: [] },
  ],
  distributionModes: [],
};
const enemy = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: ENEMY }, armies });
const BOARD = board([mine(1, 1), mine(2, 3), enemy(3, 10), neutral(5, 2), neutral(6, 2), mine(7, 3)]);
const at = (p: TurnPlan, id: number) => (BOARD.territories.find((t) => t.territoryId === id)?.armies ?? 0) + (p.deploys.find((d) => d.territoryId === id)?.armies ?? 0);
/** Fewest armies that hold against `threat` attackers. */
const holds = (threat: number) => {
  let a = 0;
  while ((armiesToTake(a, STD) ?? Infinity) <= threat) a++;
  return a;
};

const plan = (over: Partial<PlanInput> = {}) =>
  planTurn({ graph: buildGraph(MAP), board: BOARD, me: ME, income: 20, settings: STD, ...over });

describe('an untrusted estimate (#275 b)', () => {
  it('sizes a held bonus\'s border for the untrusted figure, and says so', () => {
    const trusted = plan();
    // Sized for its estimate (5): the stack of 10 moves 9, 14 attackers.
    expect(at(trusted, 2)).toBeGreaterThanOrEqual(holds(9 + 5));
    expect(at(trusted, 2)).toBeLessThan(holds(9 + 18));
    const p = plan({ untrusted: [{ player: ENEMY, deploy: 18 }] });
    // With the untrusted 18: 27 attackers.
    expect(at(p, 2)).toBeGreaterThanOrEqual(holds(9 + 18));
    expect(p.rationale.some((r) => /untrusted/i.test(r) && /18/.test(r))).toBe(true);
  });

  it('leaves a border outside any held bonus at the estimate', () => {
    const p = plan({ untrusted: [{ player: ENEMY, deploy: 18 }] });
    const line = p.rationale.find((r) => /untrusted/i.test(r))!;
    expect(line).toMatch(/T2 \(#2\)/);
    expect(line).not.toMatch(/#7/);
    expect(at(p, 7)).toBeLessThan(holds(9 + 18));
  });

  it('reads the standing at the untrusted figure, and never even while the mark runs', () => {
    const strong = board([mine(1, 5), mine(2, 10), enemy(3, 10), neutral(5, 2), neutral(6, 2), mine(7, 3)]);
    // Income 20 against its estimate of 5: ahead.
    expect(plan({ board: strong, options: { adapt: true } }).profile.standing).toBe('ahead');
    // Against the untrusted 18 (1.11×): even on the incomes, behind with the mark running; the profile picks defend.
    const p = plan({ board: strong, options: { adapt: true }, untrusted: [{ player: ENEMY, deploy: 18 }] });
    expect(p.profile.standing).toBe('behind');
    expect(p.profile.notes.join(' ')).toMatch(/untrusted \(#275\)/);
    // A what-if enemy_deploy sizes everything itself: the mark is not read.
    expect(plan({ board: strong, options: { adapt: true, enemyDeploy: 5 }, untrusted: [{ player: ENEMY, deploy: 18 }] }).profile.standing).toBe('ahead');
  });

  it('changes nothing under an explicit enemy_deploy, or for an opponent not marked', () => {
    const base = plan({ options: { enemyDeploy: 5 } });
    expect(plan({ options: { enemyDeploy: 5 }, untrusted: [{ player: ENEMY, deploy: 18 }] }).deploys).toEqual(base.deploys);
    expect(plan({ untrusted: [{ player: 99, deploy: 18 }] }).deploys).toEqual(plan().deploys);
  });
});
