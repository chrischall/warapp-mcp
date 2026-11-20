// #286: a bonus completed this turn left its member short of the stack beside it. Live (an FFA,
// guard on, 0% luck), triage conceded a member facing a large threat; the #272 step then attacked
// out of it "with armies that would otherwise withdraw", advancing an uneconomic bonus; rule 1c
// then kept the border, because the bonus passes had already completed the bonus it is in. The
// armies never would have withdrawn: the border ended 1 army short of its hold ("holds only if I
// move first"). Now a conceded border that rule 1c keeps — a bonus this turn's captures already
// complete contains it — takes no #272 step: its armies stay as its garrison.
// Synthetic maps only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanGameContext, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board } from './helpers.js';

const ME = 10;
const FOE = 20;
const SETTINGS: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70 };
const GAME: PlanGameContext = { players: [ME, FOE, 30, 40].map((id) => ({ id })), turn: 4 };

const at = (territoryId: number, armies: number, who: number | 'neutral'): TerritoryState =>
  who === 'neutral'
    ? { territoryId, owner: { kind: 'neutral' }, armies }
    : { territoryId, owner: { kind: 'player', playerId: who }, armies };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'KeptMember',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}

//   Pass (+2): my 1 (the border, 14 armies) and 2, and the neutral 3 (1 army), taken from my 2.
//   Player 20's 8-stack on 5 borders 1. Dunes (+6): my 7, the neutral 4 (2 armies) beside 1, and
//   more neutral land far off (8..12), so 4 only advances it. My 6 is an interior stack beside 2.
const map = makeMap(
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  [[1, 2], [2, 3], [1, 4], [1, 5], [2, 6], [4, 7], [7, 8], [8, 9], [9, 10], [10, 11], [11, 12], [5, 13]],
  [[100, 2, [1, 2, 3]], [101, 6, [4, 7, 8, 9, 10, 11, 12]]],
);
const g = buildGraph(map);
const b = board([
  at(1, 14, ME),
  at(2, 4, ME),
  at(3, 1, 'neutral'),
  at(4, 2, 'neutral'),
  at(5, 8, FOE),
  at(6, 3, ME),
  at(7, 3, ME),
  at(8, 40, 'neutral'),
  at(9, 40, 'neutral'),
  at(10, 40, 'neutral'),
  at(11, 40, 'neutral'),
  at(12, 40, 'neutral'),
  at(13, 20, FOE),
]);

describe('#286: a member rule 1c keeps takes no #272 step out of it', () => {
  it('the border of the bonus completed this turn keeps its own armies', () => {
    // Its 14 face 7 movable + ~59 deploy (~66): triage concedes it; the leftover is 29.
    const p = planTurn({ graph: g, board: b, me: ME, income: 29, settings: SETTINGS, game: GAME, options: { enemyDeploy: 59 } });
    const text = p.rationale.join('\n');
    // The bonus passes complete Pass, and rule 1c keeps its border.
    expect(p.moves.some((m) => m.kind === 'attack' && m.to === 3)).toBe(true);
    expect(text).toMatch(/Keep T1 \(#1\) \(not conceded\)/);
    // No attack out of the kept border "with armies that would otherwise withdraw".
    expect(p.moves.filter((m) => m.kind === 'attack' && m.from === 1)).toEqual([]);
    expect(text).not.toMatch(/out of conceded T1 \(#1\)/);
    // Its 14 + the leftover 29 = 43 hold against the ~66 whoever moves first (40 did not).
    const warned = p.warnings.join('\n');
    expect(warned).not.toMatch(/T1 \(#1\) is kept for the bonus this turn completes, but/);
    expect(warned).not.toMatch(/T1 \(#1\) holds only if I move first/);
    expect(p.deploys).toContainEqual({ territoryId: 1, armies: 29 });
  });
});
