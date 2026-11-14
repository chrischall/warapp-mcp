// #201: fund holds by the standing (#167's "fund holds in passes"). Ahead, every held bonus is held
// for the worst case before any capture; behind, each border is sized for the expected attack (#59:
// movable armies next to it plus the whole deploy estimate), not the worst case the growth trend
// projects, and the plan says what that gambles. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput } from '../../src/analysis/planner.js';
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

describe('#201: behind, holds are sized for the expected attack', () => {
  // My T1 and T3 (each its own +2 bonus) both face player 20's 6 on T2; player 20 holds +10 B805
  // (T2, T4, T5) and out-earns me. T6, a neutral 2, completes my +3 B806 with T1.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6],
      [
        [1, 2],
        [2, 3],
        [2, 4],
        [4, 5],
        [1, 6],
      ],
      [
        [801, 2, [1]],
        [803, 2, [3]],
        [805, 10, [2, 4, 5]],
        [806, 3, [6]],
      ],
    ),
  );
  const input = (options: PlanInput['options']): PlanInput => ({
    graph: g,
    board: board([mine(1, 3), enemy(2, 6), mine(3, 3), enemy(4, 2), enemy(5, 2), neutral(6, 2)]),
    me: ME,
    income: 5,
    settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
    game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 9 },
    options,
  });

  it('the expected attack counts the whole deploy on each border: one stack beside two borders gambles neither', () => {
    // Player 20's one 6-stack on T2 can take its ~15 deploy and split it over T1 and T3: holding
    // either against the stack alone would understate a sure loss, so each is sized for all ~20.
    const p = planTurn(input({ adapt: true }));
    expect(p.profile.standing).toBe('behind');
    const w = p.warnings.join('\n');
    expect(w).not.toMatch(/Behind \(#201\)/);
    expect(w).not.toMatch(/holds against ~5/);
    // The threat warning never calls a border held while the whole deploy can still take it.
    expect(w).toMatch(/T1 \(#1\) \(3 armies\) could be taken next turn: .* leaving 6 armies \(10 to take; the 20 that can reach it still could\)/);
    expect(w).not.toMatch(/it holds\)/);
    const d = planTurn(input({ goal: 'defend' }));
    expect(p.deploys).toEqual(d.deploys);
  });

  it('a growth trend above the deploy is the gamble: the border is held against the expected attack and restated against the worst case', () => {
    // Player 20's T2 grew 1 → 10 (+9 a turn) against a ~8 deploy (+3 B805): the expected attack on
    // T1 is 9 movable + 8 = ~17, the worst case 9 + 9 = ~18. The plan leaves 11 on T1 (18 to take).
    const g2 = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5, 6],
        [
          [1, 2],
          [2, 3],
          [2, 4],
          [4, 5],
          [1, 6],
        ],
        [
          [801, 2, [1]],
          [803, 2, [3]],
          [805, 3, [2, 4, 5]],
          [806, 3, [6]],
        ],
      ),
    );
    const p = planTurn({
      graph: g2,
      board: board([mine(1, 3), enemy(2, 10), mine(3, 3), enemy(4, 2), enemy(5, 2), neutral(6, 2)]),
      previousBoard: board([mine(1, 3), enemy(2, 1), mine(3, 3), enemy(4, 2), enemy(5, 2), neutral(6, 2)]),
      me: ME,
      income: 12,
      settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
      game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 9 },
      options: { adapt: true },
    });
    expect(p.profile.standing).toBe('behind');
    const w = p.warnings.join('\n');
    expect(w).toMatch(
      /Behind \(#201\): the borders facing player 20 are sized for its expected attack \(its movable armies next to each plus its whole ~8 deploy, #59\), not the worst case its growth per turn projects, and the armies saved go to the captures\. Gambled: T1 \(#1\) \(it holds against the expected ~17, not the worst-case ~18 at its growth of ~9 a turn\) — each falls if player 20 keeps growing at that rate and attacks it\./,
    );
    // T3, short of even the expected attack, is no gamble: its own warning says so.
    expect(w).not.toMatch(/Gambled: [^\n]*T3 \(#3\)/);
    // The gambled border's threat warning is restated against its worst case, never "it holds".
    expect(w).toMatch(/T1 \(#1\) \(3 armies\) could be taken next turn: .* leaving 11 armies \(18 to take; the 18 that can reach it still could\)/);
    expect(w).not.toMatch(/T1 \(#1\) [^\n]*it holds\)/);
  });

  it('a border whose threatening player is eliminated this turn is no gamble: no stale "Behind" line', () => {
    // Player 20's lone T2 grew 1 → 12 (+11 a turn, above its ~5 deploy), so T1 is sized for the
    // expected attack. My 60 on T1 eliminate it (absorbing it catches leader player 30): with T2
    // taken, T1 faces nobody, and the plan says nothing about gambling a border against player 20.
    const g4 = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5, 6],
        [
          [1, 2],
          [1, 6],
          [3, 4],
          [4, 5],
          [5, 6],
        ],
        [
          [801, 1, [1]],
          [803, 4, [3, 4, 5]],
        ],
      ),
    );
    const others = [enemy(3, 40, 30), enemy(4, 30, 30), enemy(5, 30, 30), neutral(6, 2)];
    const p = planTurn({
      graph: g4,
      board: board([mine(1, 60), enemy(2, 12), ...others]),
      previousBoard: board([mine(1, 60), enemy(2, 1), ...others]),
      me: ME,
      income: 5,
      settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
      game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 8 },
      options: { adapt: true },
    });
    expect(p.profile.standing).toBe('behind');
    expect(p.moves.some((m) => m.kind === 'attack' && m.to === 2)).toBe(true);
    expect(p.warnings.join('\n')).not.toMatch(/Behind \(#201\)/);
  });

  it('in an FFA the expected attack is the largest over every adjacent player, never below a stack next to it', () => {
    // T1 faces player 20's 3 on T2 (2 movable + its ~15 deploy) and player 30's 9 on T7 (8 movable
    // + ~5): the expected attack on T1 is the larger, ~17, and no border is gambled below 8.
    const g3 = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5, 6, 7],
        [
          [1, 2],
          [2, 3],
          [2, 4],
          [4, 5],
          [1, 6],
          [1, 7],
        ],
        [
          [801, 2, [1]],
          [803, 2, [3]],
          [805, 10, [2, 4, 5]],
          [806, 3, [6]],
        ],
      ),
    );
    const p = planTurn({
      graph: g3,
      board: board([mine(1, 3), enemy(2, 3), mine(3, 3), enemy(4, 2), enemy(5, 2), neutral(6, 2), enemy(7, 9, 30)]),
      me: ME,
      income: 5,
      settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
      game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 9 },
      options: { adapt: true },
    });
    expect(p.profile.standing).toBe('behind');
    const w = p.warnings.join('\n');
    expect(w).not.toMatch(/Gambled/);
    expect(w).toMatch(/T1 \(#1\) \(3 armies\) could be taken next turn: [^\n]*the 17 that can reach it still could\)/);
  });

  it('never gambles my commander\'s territory: rule 1k holds it against the whole deploy', () => {
    const withCommander = input({ adapt: true });
    withCommander.board = board([
      { ...mine(1, 3), specialUnits: [{ kind: 'commander', id: 'c', playerId: ME }] },
      enemy(2, 6),
      mine(3, 3),
      enemy(4, 2),
      enemy(5, 2),
      neutral(6, 2),
    ]);
    const p = planTurn(withCommander);
    expect(p.profile.standing).toBe('behind');
    const w = p.warnings.join('\n');
    expect(w).not.toMatch(/Gambled: [^\n]*T1 \(#1\)/);
    // Nothing leaves the commander's territory, and it is held against all ~20.
    expect(p.moves.some((m) => m.from === 1)).toBe(false);
    expect(p.rationale.join('\n')).toMatch(/my commander stands there, so it must hold .*need 21 to take, above the ~20 threat/);
  });

  it('an explicit goal sizes each border for the whole deploy, as before', () => {
    const p = planTurn(input({ goal: 'defend' }));
    expect(p.warnings.join('\n')).not.toMatch(/Behind \(#201\)/);
  });
});

describe('#201: ahead, a held bonus never waits behind the expansion share', () => {
  // T1 (11) borders a +3 of neutrals 4, 2, 2; T2 and T3 (2 each, each a held +1) face player 20's
  // 2-army stacks, each needing 3 against a fixed 5 deploy. Income 8 against ~5: ahead.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6, 8, 9],
      [
        [1, 2],
        [1, 3],
        [1, 4],
        [1, 5],
        [1, 6],
        [2, 8],
        [3, 9],
      ],
      [
        [801, 3, [4, 5, 6]],
        [802, 1, [2]],
        [803, 1, [3]],
      ],
    ),
  );
  it('holds each border before any capture, completions included, and never defers it', () => {
    const p = planTurn({
      graph: g,
      board: board([mine(1, 11), mine(2, 2), mine(3, 2), neutral(4, 4), neutral(5, 2), neutral(6, 2), enemy(8, 2), enemy(9, 2)]),
      me: ME,
      income: 8,
      settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
      game: { players: [{ id: ME }, { id: 20 }], turn: 9 },
      options: { adapt: true, enemyDeploy: 5 },
    });
    expect(p.profile.standing).toBe('ahead');
    expect(p.rationale.join('\n')).toMatch(/Ahead \(#201\): every held bonus is held for the worst case/);
    expect(p.rationale.join('\n')).not.toMatch(/after this turn's bonus completions/);
    expect(p.conceded).toEqual([]);
    for (const t of [2, 3]) expect(p.deploys.find((d) => d.territoryId === t)?.armies ?? 0).toBeGreaterThanOrEqual(3);
  });
});
