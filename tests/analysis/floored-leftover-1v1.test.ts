// A lost 1v1 (2026-11-27): in contact, a home bonus too dear to hold whole was floored (#118) and the
// rest of the income went to an advance into a bonus far from done; the opponent broke the home bonus
// with one stack. Rule 0p.1 ranks an advance below every hold, but a floored unit was only spread over
// its borders after the captures, so the advance took the armies first. Now, in a 1v1 in contact, the
// floored units take what is left before the first advance that completes nothing.
//
// Synthetic map (every id and name made up): three held +4 bonuses B601 {1,2}, B602 {3,4}, B603 {5,6},
// each with one 2-army border (1, 3, 5) facing an enemy 6-stack (11, 13, 15), the opponent deploying
// ~30. The interior 6 borders the neutral +5 B604 {21,22,23,24}: taking 21 advances it (12 to finish).
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanOptions, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD: PlannerSettings = {
  offensiveKillRate: 60,
  defensiveKillRate: 70,
  oneArmyStandsGuard: true,
  luckModifier: 0,
  roundingMode: 'StraightRound',
};

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Floored',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const foe = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: FOE },
  armies,
});
const g = buildGraph(
  makeMap(
    [1, 2, 3, 4, 5, 6, 11, 13, 15, 21, 22, 23, 24],
    [
      [1, 2], [3, 4], [5, 6], [2, 4], [4, 6],
      [1, 11], [3, 13], [5, 15], [11, 13], [13, 15],
      [6, 21], [21, 22], [22, 23], [23, 24],
    ],
    [
      [601, 4, [1, 2]],
      [602, 4, [3, 4]],
      [603, 4, [5, 6]],
      [604, 5, [21, 22, 23, 24]],
    ],
  ),
);
const BOARD = board([
  mine(1, 2), mine(2, 1), mine(3, 2), mine(4, 1), mine(5, 2), mine(6, 1),
  foe(11, 6), foe(13, 6), foe(15, 6),
  neutral(21, 2), neutral(22, 2), neutral(23, 2), neutral(24, 2),
]);
const plan = (income: number, options: PlanOptions = {}, players = [{ id: ME }, { id: FOE }]) =>
  planTurn({
    graph: g,
    board: BOARD,
    me: ME,
    income,
    settings: STD,
    game: { players, turn: 8 },
    options: { adapt: true, enemyDeploy: 30, ...options },
  });
const deployedTo = (p: TurnPlan, id: number) => p.deploys.filter((d) => d.territoryId === id).reduce((n, d) => n + d.armies, 0);
const advances = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack' && m.to === 21);

describe('lost 1v1: a floored home bonus takes the leftover before a far advance', () => {
  for (const income of [17, 22]) {
    describe(`income ${income}`, () => {
      const p = plan(income);
      it('makes no advance into the far bonus', () => {
        expect(advances(p)).toEqual([]);
        expect(deployedTo(p, 6)).toBe(0);
      });
      it('spends the whole income on the floored borders and concedes nothing', () => {
        expect(deployedTo(p, 1) + deployedTo(p, 3) + deployedTo(p, 5)).toBe(income);
        expect(p.conceded).toEqual([]);
      });
      it('says why', () => {
        expect(p.rationale.join('\n')).toMatch(
          /1v1 in contact: what is left goes to the borders of B601 \(#601\) \(\+4\), B602 \(#602\) \(\+4\), B603 \(#603\) \(\+4\) before any advance that completes nothing this turn/,
        );
      });
    });
  }

  it('at income 22 the one deploy can no longer break all three home bonuses at once', () => {
    expect(plan(22).warnings).toContain(
      "Player 20's ~30 deploy can still break 2 of bonuses B601 (#601), B602 (#602) and B603 (#603) (20 of it needed): +8 at risk this turn.",
    );
  });

  it('leaves a free-for-all as it was: the advance still goes ahead', () => {
    const ffa = plan(17, {}, [{ id: ME }, { id: FOE }, { id: 30 }]);
    expect(advances(ffa).length).toBe(1);
    expect(ffa.rationale.join('\n')).not.toMatch(/what is left goes to the borders of/);
  });

  it('leaves a focused advance alone', () => {
    const p = plan(17, { focusBonusIds: [604] });
    expect(advances(p).length).toBe(1);
  });
});
