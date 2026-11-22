// #432: in a 1v1 in contact whose gates are already short at the start of the turn (the #297 gate budget: every
// border facing the opponent sized for his stack beside it plus his whole deploy, against my income), the payback
// horizon shortens the way #201's decided game shortens it: every payback test counts SHORT_GATES_PAYBACK_TURNS
// turns instead of PAYBACK_TURNS. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanOptions } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const enemy = (territoryId: number, armies: number, playerId = 20): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId }, armies });
function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
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

describe('#432: a 1v1 whose gates are short at the start counts a shorter payback horizon', () => {
  // My 30 on T1 (interior) and my gate T3 facing player 20's T4. T2 and T6, neutral 8s beside T1, make the +2
  // bonus B801: taking both loses ~14, repaid by +2 in 7 turns — inside 10 turns, not inside 5.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6],
      [
        [1, 2],
        [1, 6],
        [1, 3],
        [3, 4],
        [4, 5],
      ],
      [[801, 2, [2, 6]]],
    ),
  );
  const run = (gate: number, theirs: number, options: PlanOptions = { adapt: true, enemyDeploy: 5 }, players = [{ id: ME }, { id: 20 }]) =>
    planTurn({
      graph: g,
      board: board([mine(1, 30), neutral(2, 8), neutral(6, 8), mine(3, gate), enemy(4, theirs), enemy(5, 3)]),
      me: ME,
      income: 10,
      settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
      game: { players, turn: 8 },
      options,
    });
  const skips = (p: ReturnType<typeof planTurn>) => p.rationale.some((l) => /Skip bonus B801/.test(l));

  it('gates that hold: 10 turns of payback, the bonus is economic', () => {
    const p = run(30, 3);
    expect(p.rationale.join('\n')).not.toMatch(/#432/);
    expect(skips(p)).toBe(false);
  });

  it('gates short at the start: the payback tests count 5 turns, and the bonus no longer pays', () => {
    const p = run(5, 40);
    expect(p.rationale.join('\n')).toMatch(
      /Gate budget short \(#432\): in this 1v1 the gates facing player 20 need \d+ more than stands on them against its one floating deploy, more than my income of 10, so every payback test counts 5 turns instead of 10 \(the #201 horizon\)\./,
    );
    expect(skips(p)).toBe(true);
  });

  it('only when adapting, as #201: a goal given keeps 10 turns', () => {
    const p = run(5, 40, { goal: 'balanced', enemyDeploy: 5 });
    expect(p.rationale.join('\n')).not.toMatch(/#432/);
  });

  it('a 1v1 measure only: a free-for-all keeps 10 turns', () => {
    const p = run(5, 40, { adapt: true, enemyDeploy: 5 }, [{ id: ME }, { id: 20 }, { id: 30 }]);
    expect(p.rationale.join('\n')).not.toMatch(/#432/);
  });
});

describe('#432: no wastelands while the gates are short', () => {
  // My 30 on T1 beside T2, a neutral 10 that is the +3 bonus B802 alone: taking it loses ~8, repaid within 5 turns,
  // so the shorter horizon alone still buys it. The game's wastelands start at 10, its ordinary neutrals at 2.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5],
      [
        [1, 2],
        [1, 3],
        [3, 4],
        [4, 5],
      ],
      [[802, 3, [2]]],
    ),
  );
  const run = (gate: number, theirs: number, wastelands = true) =>
    planTurn({
      graph: g,
      board: board([mine(1, 30), neutral(2, 10), mine(3, gate), enemy(4, theirs), enemy(5, 3)]),
      me: ME,
      income: 10,
      settings: {
        offensiveKillRate: 60,
        defensiveKillRate: 70,
        oneArmyStandsGuard: true,
        neutralArmies: 2,
        ...(wastelands ? { wastelands: { count: 3, size: 10 } } : {}),
      },
      game: { players: [{ id: ME }, { id: 20 }], turn: 8 },
      options: { adapt: true, enemyDeploy: 5 },
    });
  const wasteLine = /Skip bonus B802 \(#802\): finishing it means taking the wasteland T2 \(#2\) \(10 armies or more\) while the gates facing player 20 are \d+ short \(#432\)\./;

  it('gates short: the bonus through a wasteland is skipped, and T2 is not taken', () => {
    const p = run(5, 40);
    expect(p.rationale.join('\n')).toMatch(wasteLine);
    expect(p.expected.captures).not.toContain(2);
  });

  it('gates that hold: the wasteland bonus is still built', () => {
    const p = run(30, 3);
    expect(p.rationale.join('\n')).not.toMatch(/#432/);
    expect(p.rationale.some((l) => /Skip bonus B802/.test(l))).toBe(false);
  });

  it('a game without wastelands: a big neutral is judged on the payback test alone', () => {
    const p = run(5, 40, false);
    expect(p.rationale.join('\n')).not.toMatch(wasteLine);
    expect(p.rationale.some((l) => /Skip bonus B802/.test(l))).toBe(false);
  });
});
