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

// Lesson (the 20/80 game, turns 17–19): 58 armies went to a 12-army wasteland for +1 beside the 170
// stack while each gate of the bonus it faced was conceded. Home (+2): 1, 2; its gate 2 faces player 20's
// 20 on 3 (with 4 behind it); Waste (+1): the 6-army neutral 5 beside 1. Income 20; a third player seated.
describe('an untrusted opponent puts the gate before expansion (#275 b)', () => {
  const GATE: GameMap = {
    id: 2,
    name: 'Gate',
    territories: [
      [1, [2, 5]],
      [2, [1, 3]],
      [3, [2, 4]],
      [4, [3]],
      [5, [1]],
    ].map(([id, connectedTo]) => ({ id: id as number, name: `T${id}`, connectedTo: connectedTo as number[] })),
    bonuses: [
      { id: 501, name: 'Home', value: 2, territoryIds: [1, 2], bonusIds: [] },
      { id: 502, name: 'Waste', value: 1, territoryIds: [5], bonusIds: [] },
    ],
    distributionModes: [],
  };
  const gateBoard = board([mine(1, 1), mine(2, 10), enemy(3, 20), enemy(4, 20), neutral(5, 6)]);
  const gatePlan = (over: Partial<PlanInput> = {}) =>
    planTurn({ graph: buildGraph(GATE), board: gateBoard, me: ME, income: 20, settings: STD, game: { players: [{ id: ME }, { id: ENEMY }, { id: 30 }] }, ...over });
  const deployed = (p: TurnPlan, id: number) => p.deploys.filter((d) => d.territoryId === id).reduce((n, d) => n + d.armies, 0);

  it('holds the gate whole before a +1 completion when the two do not both fit', () => {
    // Trusted (estimate 5): the gate needs 5, and both fit.
    const trusted = gatePlan();
    expect(trusted.moves.map((m) => m.to)).toEqual([5]);
    expect(trusted.conceded).toEqual([]);
    // Untrusted at 25: the gate needs 17 (more than 3 × its worth: contested, #118), the wasteland 10.
    const p = gatePlan({ untrusted: [{ player: ENEMY, deploy: 25 }] });
    expect(p.conceded).toEqual([]);
    expect(p.moves.filter((m) => m.kind === 'attack')).toEqual([]);
    expect(10 + deployed(p, 2)).toBeGreaterThanOrEqual(holds(19 + 25));
    expect(p.rationale.join('\n')).toMatch(/Hold bonus Home \(#501\) \(\+2\) whole: .* before any capture: player 20's estimate is untrusted \(#275\)/);
  });

  it('does the same under defend', () => {
    const d = gatePlan({ untrusted: [{ player: ENEMY, deploy: 25 }], options: { goal: 'defend' } });
    expect(d.conceded).toEqual([]);
    expect(d.moves.filter((m) => m.kind === 'attack')).toEqual([]);
  });

  // The owner's second trigger: a gate conceded beside the untrusted stack. At 40 or 60 the gate needs
  // 26 or 38, more than the income of 20; the old plan conceded it, put all 20 on T1 and sent 10 into
  // the +1 wasteland beside the stack. Nothing that pays +1 goes ahead of it: what is left goes on the gate.
  for (const deploy of [40, 60])
    for (const goal of [undefined, 'defend'] as const)
      it(`funds no expansion ahead of a gate conceded beside the untrusted stack (${deploy}${goal ? `, ${goal}` : ''})`, () => {
        const p = gatePlan({ untrusted: [{ player: ENEMY, deploy }], ...(goal ? { options: { goal } } : {}) });
        expect(p.conceded).toEqual([]);
        expect(p.moves.filter((m) => m.kind === 'attack')).toEqual([]);
        expect(deployed(p, 2)).toBe(20);
        expect(p.rationale.join('\n')).toMatch(/T2 \(#2\).*player 20's estimate is untrusted \(#275\)/);
        // Said once, and not contradicted by a concession warning.
        expect(p.warnings.some((w) => /T2 \(#2\) cannot be held .*: conceded$/.test(w))).toBe(false);
        expect(p.warnings.some((w) => /T2 \(#2\).*falls to/.test(w) && /untrusted/.test(w))).toBe(true);
      });

  it('leaves a conceded border facing a trusted opponent to the concession as before', () => {
    // The same gate at a trusted deploy of 60 (enemy_deploy what-if): conceded, the +1 taken.
    const p = gatePlan({ options: { enemyDeploy: 60 } });
    expect(p.conceded).toEqual([2]);
    expect(p.moves.map((m) => m.to)).toEqual([5]);
  });
});
