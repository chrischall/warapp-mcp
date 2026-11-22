// Issue #425: a lone foothold in a bonus I do not hold (no other territory of mine in it or beside it)
// was credited the WHOLE bonus value as "the only way in", whatever stood on the rest of the bonus. On
// the 36 finished games' truth boards that branch fired on 285 threatened borders, 276 of them in a
// bonus an enemy already held part of; the bonus was completed later in 7. Since #425 the only-way-in
// branch credits what #122 credits a member of a bonus being built — value × members held ÷ size, and
// only when the bonus passes `building()` — so a foothold in a bonus an enemy holds or roams adds +0.
// Synthetic maps (every id and name here is made up).
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Foothold',
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

//   Bonus B425 (+4): 1 2 3 4. Mine: 1 (lone foothold). Enemy 8 beside 1.
//     8(e) ─ 1 ─ 2 ─ 3 ─ 4
const g = buildGraph(
  makeMap(
    [1, 2, 3, 4, 8],
    [
      [8, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ],
    [[425, 4, [1, 2, 3, 4]]],
  ),
);
const plan = (rest: TerritoryState[]) =>
  planTurn({ graph: g, board: board([mine(1, 2), enemy(8, 6), ...rest]), me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
const text = (p: ReturnType<typeof plan>) => [...p.rationale, ...p.warnings].join('\n');

describe('#425: the only-way-in branch credits the foothold its building share', () => {
  it('a lone foothold in a bonus I am building protects value × held ÷ size (+1), not the whole +4', () => {
    const p = plan([neutral(2, 2), neutral(3, 2), neutral(4, 2)]);
    expect(text(p)).toMatch(/T1 \(#1\).*protects \+1\b/);
    expect(text(p)).not.toMatch(/protects \+4/);
  });

  it('a lone foothold in a bonus an enemy holds a member of protects +0 from it', () => {
    const p = plan([neutral(2, 2), enemy(3, 2), neutral(4, 2)]);
    expect(text(p)).not.toMatch(/protects \+4/);
    expect(text(p)).not.toMatch(/T1 \(#1\).*protects \+[1-9]/);
  });
});
