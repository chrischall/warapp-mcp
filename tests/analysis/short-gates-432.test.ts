// #432: in a 1v1 in contact whose gates are already short at the start of the turn (the #297 gate budget: every
// border facing the opponent sized for his stack beside it plus his whole deploy, against my income), every
// capture's payback test counts SHORT_GATES_PAYBACK_TURNS turns instead of PAYBACK_TURNS; holds keep PAYBACK_TURNS
// (owner decision 2026-11-22). Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planningInput, planTurn, type PlanInput, type PlanOptions } from '../../src/analysis/planner.js';
import { reserveCommanderMove } from '../../src/analysis/plan/commander.js';
import { noteEstimates, planContext } from '../../src/analysis/plan/estimates.js';
import { applyShortGates } from '../../src/analysis/plan/horizon.js';
import { deployBook } from '../../src/analysis/plan/orders.js';
import { newPlanState } from '../../src/analysis/plan/state.js';
import { threatsPhase } from '../../src/analysis/plan/threats.js';
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

  it("gates short at the start: a capture's payback test counts 5 turns, and the bonus no longer pays", () => {
    const p = run(5, 40);
    expect(p.rationale.join('\n')).toMatch(
      /Gate budget short \(#432\): in this 1v1 the gates facing player 20 need \d+ more than stands on them against its one floating deploy, more than my income of 10, so every capture's payback test counts 5 turns instead of 10 \(holds keep 10\)\./,
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

describe('#432: holds keep 10 turns while the gates are short', () => {
  // The same short gate T3 (5 facing player 20's 40), and my T7 (1) alone the +1 bonus B803, facing player 20's 6 on
  // T8: holding it whole costs 6 — more than 5 turns of its +1, within 10.
  const g = buildGraph(
    makeMap(
      [1, 3, 4, 5, 7, 8],
      [
        [1, 3],
        [3, 4],
        [4, 5],
        [1, 7],
        [7, 8],
      ],
      [[803, 1, [7]]],
    ),
  );
  const input: PlanInput = {
    graph: g,
    board: board([mine(1, 30), mine(3, 5), enemy(4, 40), enemy(5, 3), mine(7, 1), enemy(8, 6)]),
    me: ME,
    income: 10,
    settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
    game: { players: [{ id: ME }, { id: 20 }], turn: 8 },
    options: { adapt: true, enemyDeploy: 5, holdCap: false },
  };
  it('the context the phases read after the threats: captures count 5 turns, holds 10', () => {
    // planPass's steps up to and including #432's (as tests/analysis/plan-strike.test.ts runs them).
    const pi = planningInput(input);
    const ctx = planContext(pi);
    const state = newPlanState();
    noteEstimates(ctx, state);
    const book = deployBook(ctx, state);
    reserveCommanderMove(ctx, state);
    const threats = threatsPhase(ctx, state, pi, book.valueOf);
    expect(applyShortGates(ctx, state, threats)?.turns).toBe(5);
    expect(ctx.capturePaybackTurns).toBe(5);
    expect(ctx.paybackTurns).toBe(10);
  });

  it('the held bonus is still held whole', () => {
    const p = planTurn({
      graph: g,
      board: board([mine(1, 30), mine(3, 5), enemy(4, 40), enemy(5, 3), mine(7, 1), enemy(8, 6)]),
      me: ME,
      income: 10,
      settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
      game: { players: [{ id: ME }, { id: 20 }], turn: 8 },
      options: { adapt: true, enemyDeploy: 5, holdCap: false },
    });
    expect(p.rationale.join('\n')).toMatch(/Gate budget short \(#432\)/);
    expect(p.rationale.join('\n')).toMatch(/Hold bonus B803 \(#803\) \(\+1\) whole/);
    expect(p.deploys.find((d) => d.territoryId === 7)?.armies ?? 0).toBeGreaterThanOrEqual(6);
  });
});

describe('#432: no wastelands while the gates are short', () => {
  // My 30 on T1 beside T2, a neutral 10, which with T6 (a neutral 2 beyond it) makes the +3 bonus B802: finishing it
  // loses ~10, repaid within 5 turns, so the shorter horizon alone still builds it — but not this turn (T6 is not
  // next to mine). T9, another neutral 10 beside T1, is the +3 bonus B804 alone: taking it completes B804 this turn.
  // The game's wastelands start at 10, its ordinary neutrals at 2.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6, 9],
      [
        [1, 2],
        [2, 6],
        [1, 9],
        [1, 3],
        [3, 4],
        [4, 5],
      ],
      [
        [802, 3, [2, 6]],
        [804, 3, [9]],
      ],
    ),
  );
  const run = (gate: number, theirs: number, wastelands = true) =>
    planTurn({
      graph: g,
      board: board([mine(1, 30), neutral(2, 10), neutral(6, 2), neutral(9, 10), mine(3, gate), enemy(4, theirs), enemy(5, 3)]),
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

  it('gates short: the bonus a wasteland only advances is skipped, and T2 is not taken', () => {
    const p = run(5, 40);
    expect(p.rationale.join('\n')).toMatch(wasteLine);
    expect(p.expected.captures).not.toContain(2);
  });

  it('gates short: a wasteland that completes a bonus this turn is still taken', () => {
    const p = run(5, 40);
    expect(p.rationale.some((l) => /Skip bonus B804/.test(l))).toBe(false);
    expect(p.expected.captures).toContain(9);
  });

  it('gates that hold: the wasteland bonus is not skipped for it', () => {
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
