// #235 (a later comment): a free-for-all border that holds against each opponent alone is never
// conceded because two of them together could take it — even when I lead (#201), where the hold
// is sized for them together only while that pays; and (b) a border whose loss cuts my holdings in
// two protects what it cuts off. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
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
const outOf = (p: TurnPlan, t: number) => p.moves.filter((m) => m.from === t);

describe('#235: the FFA leader never concedes a border on two opponents together', () => {
  // My T1 (12, no bonus) faces player 20's T2 and player 30's T3, 9 armies each. Each alone (8 + its
  // ~5 deploy) cannot take it; the two together can. I lead on strength (my 60 on T4); T1, T4 and T6
  // form a triangle, so losing T1 cuts nothing off. Holding T1 against both together costs more than
  // CONCEDE_FACTOR × its worth: it is held against each alone, and the pile-on is a warning.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6],
      [
        [1, 2],
        [1, 3],
        [1, 4],
        [1, 6],
        [4, 6],
        [4, 5],
      ],
    ),
  );
  const input = (adapt: boolean): PlanInput => ({
    graph: g,
    board: board([mine(1, 12), enemy(2, 9, 20), enemy(3, 9, 30), mine(4, 60), neutral(5, 50), mine(6, 2)]),
    me: ME,
    income: 10,
    settings: STD,
    game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 8 },
    options: adapt ? { adapt: true, enemyDeploy: 5 } : { goal: 'balanced', enemyDeploy: 5 },
  });

  it('leading: held against each alone, not conceded, nothing withdrawn', () => {
    const p = planTurn(input(true));
    expect(p.profile.ranking?.leader).toBe(ME);
    expect(p.conceded).not.toContain(1);
    expect(outOf(p, 1)).toEqual([]);
    expect(p.warnings.join('\n')).not.toMatch(/T1 \(#1\) cannot be held/);
    expect(p.rationale.join('\n')).toMatch(
      /I lead this free-for-all \(#201\), but holding T1 \(#1\) against players 20 and 30 attacking together needs \d+ \(protects \+0, worth ~1\.2\): more than CONCEDE_FACTOR × its worth, so it is sized for the strongest single opponent \(~13\), as FFA players attack alone/,
    );
    expect(p.rationale.join('\n')).not.toMatch(/T1 \(#1\) is held against players 20 and 30 attacking together/);
    // #128's warning still says the two together could take it.
    expect(p.warnings.join('\n')).toMatch(/T1 \(#1\) holds against each opponent alone, but players 20 and 30 attacking it in the same turn/);
  });

  it('not adapting: the same (each player judged alone, the pile-on a warning)', () => {
    const p = planTurn(input(false));
    expect(p.conceded).not.toContain(1);
    expect(outOf(p, 1)).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(/T1 \(#1\) holds against each opponent alone, but players 20 and 30/);
  });
});

describe('#235: a border whose loss cuts my holdings in two protects what it cuts off', () => {
  // My T1 (5) joins my T4 (60, the +2 bonus B901 alone) to my T6, T7, T8. Player 20's T2 (9) faces T1:
  // 8 + its ~5 deploy take 5. Losing T1 leaves T4 cut off from the rest: T1 protects +2 (B901's
  // income) and its worth counts T4's 60 armies (/ PAYBACK_TURNS), so it is held, not conceded.
  const edges: [number, number][] = [
    [1, 2],
    [1, 4],
    [1, 6],
    [6, 7],
    [7, 8],
    [4, 5],
  ];
  const run = (linked: boolean) =>
    planTurn({
      graph: buildGraph(makeMap([1, 2, 4, 5, 6, 7, 8], linked ? edges : [...edges, [4, 8]], [[901, 2, [4]]])),
      board: board([mine(1, 5), enemy(2, 9, 20), mine(4, 60), neutral(5, 80), mine(6, 1), mine(7, 1), mine(8, 1)]),
      me: ME,
      income: 7,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }], turn: 8 },
      options: { goal: 'balanced', enemyDeploy: 5 },
    });

  it('a cut vertex: held, the cut named in the rationale', () => {
    const p = run(true);
    expect(p.conceded).not.toContain(1);
    expect(p.deploys.some((d) => d.territoryId === 1)).toBe(true);
    expect(p.rationale.join('\n')).toMatch(
      /T1 \(#1\) links my holdings: losing it cuts off T4 \(#4\) \(60 armies, \+2 income\) from the rest, so it protects \+2 more and its worth counts those 60 armies/,
    );
    expect(p.rationale.join('\n')).toMatch(/Deploy \d+ to T1 \(#1\) so it holds \(protects \+2\)/);
  });

  it('with another link (T4–T8), nothing is cut off: conceded as before', () => {
    const p = run(false);
    expect(p.conceded).toContain(1);
    expect(p.rationale.join('\n')).not.toMatch(/links my holdings/);
  });
});
