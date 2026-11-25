// Issue #567 part 1 (owner decision 2026-11-25): the #418 rise cap yields to a turn read from at least
// RISE_LOW_COVERAGE of its frontier: the hold never stays below that turn's low end (every ambiguous
// army read as a move, at most its could-earn cap). Every board here is synthetic.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { incomeBasis, RISE_LOW_COVERAGE, trackOpponents } from '../../src/analysis/opponents.js';
import type { PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const line = (n: number) => Array.from({ length: n - 1 }, (_, i) => [i + 1, i + 2] as [number, number]);
function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({ id, name: `T${id}`, connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)) })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const enemy = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: ENEMY }, armies });

describe('#567: the rise cap yields to a well-read turn\'s low end', () => {
  // My +30 bonus {1, 2, 3} (600 on T3); its T4 between my T3 and its T5, T5 beside the fog T6–T9: walk-ins
  // onto T5 are held at 1.3× a turn (#418); on turn 10 T4, beside no fog, grows by 29 too (2 of 3 frontier read).
  const g = buildGraph(makeMap(range(1, 9), line(9), [[101, 30, [1, 2, 3]], [102, 20, [6, 7]], [103, 25, [8, 9]]]));
  const fog = range(6, 9).map(fogged);
  const at = (t4: number, t5: number) => board([mine(1, 1), mine(2, 1), mine(3, 600), enemy(4, t4), enemy(5, t5), ...fog]);
  const history = (xs: [number, number][]) => xs.map(([a, b], i) => ({ turn: 8 + i, board: at(a, b) }));

  it('the +29 the turn surely deployed (2/3 of its frontier read) stands, not the 17 the cap held', () => {
    expect(RISE_LOW_COVERAGE).toBe(0.6);
    const [t] = trackOpponents(g, history([[1, 5], [1, 50], [1, 95], [30, 140]]), ME, STD);
    expect(t!.turns.at(-1)!.coverage!.share).toBeCloseTo(2 / 3);
    expect(t!.turns.at(-1)!.low).toBe(29);
    expect(t!.income).toBe(29);
    expect(t!.incomeMethod).toBe('max-observed');
    expect(t!.incomeRise).toBeUndefined();
  });

  it('held at the low end when the reading goes above it', () => {
    expect(
      incomeBasis({ incomeMethod: 'rise-capped', incomeTurns: [8, 9, 10], observedRange: { min: 10, max: 40 }, incomeRise: { read: 40, before: 13, low: 29 } }),
    ).toBe(
      'max observed over turns 8–10, observed 10–40, held at the +29 a turn read from 60% or more of its frontier surely deployed (above 1.3× the ~13 before it): no turn read in full reached 40',
    );
  });

  it('no turn whose low end is above the hold: the hold stands (17)', () => {
    const [t] = trackOpponents(g, history([[1, 5], [1, 50], [1, 95], [1, 140]]), ME, STD);
    expect(t!.income).toBe(17);
    expect(t!.incomeRise).toEqual({ read: 26, before: 13 });
  });
});
