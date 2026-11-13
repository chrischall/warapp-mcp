// Issue #57: under fog the visible-bonus estimate stays at the base income while the
// opponent's visible armies grow by far more each turn. With the previous board, its
// deploy is estimated from what it visibly gained too, and the larger figure wins.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import {
  defaultEnemyDeploy,
  enemyDeployEstimates,
  planTurn,
  type PlannerSettings,
} from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const OTHER = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

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

const enemy = (territoryId: number, armies: number, playerId = ENEMY): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

/** Fewest armies a territory needs so `threat` attackers cannot take it. */
const holdArmies = (threat: number) => {
  let a = 0;
  while ((armiesToTake(a) ?? Infinity) <= threat) a++;
  return a;
};

// My T1 (a +10 bonus on its own) borders the enemy's T2; T3 and T4 sit behind it,
// T5 is fogged, so the enemy's +3 bonus {2, 3, 4, 5} is never visibly held.
// T6 and T7 hang off T4 (for owner changes); T8 is a neutral next to T4. The +40 bonus
// {6, 7} lies in the fog, so the opponent could hold it: the observed figure's plausibility
// cap (#69: base + every bonus it could hold) stays above what these tests observe.
const g = buildGraph(
  makeMap(
    [1, 2, 3, 4, 5, 6, 7, 8],
    [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [4, 6],
      [4, 7],
      [4, 8],
    ],
    [
      [701, 10, [1]],
      [702, 3, [2, 3, 4, 5]],
      [703, 40, [6, 7]],
    ],
  ),
);
const fog = [fogged(5), fogged(6), fogged(7), fogged(8)];
// Visible enemy armies 5 + 10 + 21 = 36 → 10 + 25 + 38 = 73: +37 in one turn.
const then = board([mine(1, 20), enemy(2, 5), enemy(3, 10), enemy(4, 21), ...fog]);
const now = board([mine(1, 20), enemy(2, 10), enemy(3, 25), enemy(4, 38), ...fog]);

describe('enemy deploy from observed growth (#57)', () => {
  it('estimates at least the observed growth, past the stack cap', () => {
    const [e] = enemyDeployEstimates(g, now, ME, STD, then);
    // Visible: base 5 + bonuses 0, capped at round(0.75 × 10) = 8 → 5. Observed: +37.
    expect(e).toMatchObject({ playerId: ENEMY, base: 5, bonusIncome: 0, stackCap: 8, observed: 37, source: 'observed' });
    expect(e!.estimate).toBeGreaterThanOrEqual(37);
    expect(e!.estimate).toBe(37);
    expect(defaultEnemyDeploy(g, now, ME, STD, then)).toBe(37);
  });

  it('sizes the holds to the observed figure', () => {
    // 9 movable on T2 + 37 = 46 threatens T1's 20 (33 take it); without the history 9 + 5 = 14 does not.
    const p = planTurn({ graph: g, board: now, previousBoard: then, me: ME, income: 12, settings: STD, options: { goal: 'defend' } });
    expect(p.enemyDeploy).toBe(37);
    const w = p.warnings.join('\n');
    expect(w).toMatch(/T1 \(#1\) \(20 armies\) could be taken next turn: player 20 has 9 movable armies next to it plus ~37 deploy/);
    const d = p.deploys.find((x) => x.territoryId === 1)?.armies ?? 0;
    expect(d).toBeGreaterThanOrEqual(holdArmies(9 + 37) - 20);
    expect(p.rationale.join('\n')).toMatch(new RegExp(`Deploy ${holdArmies(9 + 37) - 20} to T1 \\(#1\\) so it holds`));
    expect(armiesToTake(20 + d)).toBeGreaterThan(46);
    expect(p.conceded).toEqual([]);

    const blind = planTurn({ graph: g, board: now, me: ME, income: 12, settings: STD, options: { goal: 'defend' } });
    expect(blind.enemyDeploy).toBe(5);
    expect(blind.warnings.join('\n')).not.toMatch(/could be taken/);
  });

  it('names the source in the warning', () => {
    const p = planTurn({ graph: g, board: now, previousBoard: then, me: ME, income: 12, settings: STD });
    const w = p.warnings.join('\n');
    expect(w).toMatch(/Enemy deploy estimate for player 20: ~37 \(observed \+37\/turn/);
    expect(w).toMatch(/more than base 5 \+ visible bonuses \+0 = 5/);
    // Below the visible figure, the visible source is named and the observation noted.
    const flat = board([mine(1, 20), enemy(2, 6), enemy(3, 10), enemy(4, 21), ...fog]);
    const q = planTurn({ graph: g, board: flat, previousBoard: then, me: ME, income: 12, settings: STD });
    const v = q.warnings.join('\n');
    expect(v).toMatch(/Enemy deploy estimate for player 20: ~5 \(base 5 \+ visible bonuses \+0 = 5/);
    expect(v).toMatch(/observed \+1\/turn since last turn, below that/);
    expect(v).not.toMatch(/\(observed \+/);
  });

  it('does not count growth on a territory that changed owner as deploy', () => {
    // T6: player 30's 4 last turn; T7: my 7 last turn. The enemy took both from T4 (40 → 10),
    // leaving 20 on T6 and 8 on T7. Its visible total went 40 + 0 → 10 + 20 + 8 (−2), and it
    // lost what the defenders killed at 70% (round(2.8) + round(4.9) = 3 + 5, #86):
    // observed = −2 + 8 = 6, not T6's growth (+16).
    const before = board([mine(1, 30), enemy(2, 5), enemy(3, 10), enemy(4, 40), fogged(5), enemy(6, 4, OTHER), mine(7, 7), fogged(8)]);
    const after = board([mine(1, 30), enemy(2, 5), enemy(3, 10), enemy(4, 10), fogged(5), enemy(6, 20), enemy(7, 8), fogged(8)]);
    expect(enemyDeployEstimates(g, after, ME, STD, before)[0]!.observed).toBe(6);
    // However the armies split between T4 and the capture, the figure is the same:
    // what moved in came out of T4.
    const split = board([mine(1, 30), enemy(2, 5), enemy(3, 10), enemy(4, 1), fogged(5), enemy(6, 29), enemy(7, 8), fogged(8)]);
    expect(enemyDeployEstimates(g, split, ME, STD, before)[0]!.observed).toBe(6);
    // A territory under the same owner that shrank counts against the growth (its armies moved).
    const shrank = board([mine(1, 30), enemy(2, 5), enemy(3, 2), enemy(4, 21), ...fog]);
    expect(enemyDeployEstimates(g, shrank, ME, STD, then)[0]!.observed).toBe(0);
  });

  it('a transfer between its own territories is not deploy (net change, not positive growth)', () => {
    // T1-T2-T3-T4 in a line; my T1 is its own +5 bonus. The enemy moved 30 from T4 to T3 and
    // deployed 5: visible 50 → 55. Counting only the growth of T3 would read +35.
    const line = buildGraph(
      makeMap(
        [1, 2, 3, 4],
        [
          [1, 2],
          [2, 3],
          [3, 4],
        ],
        [[801, 5, [1]]],
      ),
    );
    const before = board([mine(1, 15), enemy(2, 10), enemy(3, 5), enemy(4, 35)]);
    const after = board([mine(1, 15), enemy(2, 10), enemy(3, 40), enemy(4, 5)]);
    const [e] = enemyDeployEstimates(line, after, ME, STD, before);
    expect(e).toMatchObject({ observed: 5, estimate: 5, source: 'visible' });
    const input = { graph: line, board: after, me: ME, income: 5, settings: STD, options: { goal: 'defend' as const } };
    const seen = planTurn({ ...input, previousBoard: before });
    const blind = planTurn(input);
    expect(seen.enemyDeploy).toBe(5);
    expect(seen.conceded).toEqual([]);
    expect(seen.deploys).toEqual(blind.deploys);
    // Only ever a floor at 0: a turn of net losses observes nothing.
    const lost = board([mine(1, 15), enemy(2, 3), enemy(3, 5), enemy(4, 35)]);
    expect(enemyDeployEstimates(line, lost, ME, STD, before)[0]!.observed).toBe(0);
  });

  it('counts a visible neutral it captured, never a territory that was fogged', () => {
    // T8 was a visible 2-army neutral; T4 sent 10 (21 → 11) and 9 now sit on T8. Its visible
    // total went 21 → 20 and the neutral's 2 killed round(1.4) = 1 (#86): observed = −1 + 1 = 0,
    // not +9.
    const before = board([mine(1, 30), enemy(2, 5), enemy(3, 10), enemy(4, 21), fogged(5), fogged(6), fogged(7), neutral(8, 2)]);
    const after = board([mine(1, 30), enemy(2, 5), enemy(3, 10), enemy(4, 11), fogged(5), fogged(6), enemy(7, 30), enemy(8, 9)]);
    // T7 was fogged: it may simply have come into view, so it is not counted.
    expect(enemyDeployEstimates(g, after, ME, STD, before)[0]!.observed).toBe(0);
    // With T4 unchanged (visible both times, so the source), the 9 on T8 were deployed (on T4,
    // then moved): +9 + 1.
    const deployed = board([mine(1, 30), enemy(2, 5), enemy(3, 10), enemy(4, 21), fogged(5), fogged(6), enemy(7, 30), enemy(8, 9)]);
    expect(enemyDeployEstimates(g, deployed, ME, STD, before)[0]!.observed).toBe(10);
  });

  it('without a previous board nothing changes', () => {
    const plain = enemyDeployEstimates(g, now, ME, STD);
    expect(plain[0]).toMatchObject({ estimate: 5, observed: null, source: 'visible' });
    expect(defaultEnemyDeploy(g, now, ME, STD)).toBe(5);
    const p = planTurn({ graph: g, board: now, me: ME, income: 12, settings: STD });
    expect(p.warnings.join('\n')).toMatch(/Enemy deploy estimate for player 20: ~5 \(base 5 \+ visible bonuses \+0 = 5/);
    expect(p.warnings.join('\n')).not.toMatch(/observed/);
  });

  it('a caller override still wins over the observed figure', () => {
    const p = planTurn({ graph: g, board: now, previousBoard: then, me: ME, income: 12, settings: STD, options: { enemyDeploy: 6 } });
    expect(p.enemyDeploy).toBe(6);
    expect(p.warnings.join('\n')).toMatch(/~6 \(your estimate\)/);
  });
});
