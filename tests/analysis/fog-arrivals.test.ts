// Issue #86: armies that arrive by an attack are a move, not income. An opponent fogged all
// game captured a visible neutral with a huge stack; counting the stack standing there as
// deploy made its income look like the stack. A capture now counts only what it cost (the
// attacker's losses to the previous defenders at the game's kill rates), plus the armies
// standing on it only when the attack's source was visible on both boards (its shrink then
// cancels them). The stack is still a threat to the borders next to it.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake, straightKills } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { enemyDeployEstimates, observeDeploy, planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
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

const enemy = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: ENEMY },
  armies,
});

// A line T1 – T2 – T3 – T4 – T5. My +400 bonus {1, 2} (worth any hold); T3 a visible 3-army neutral next to my
// T2; T4 and T5 lie in the fog (the opponent's, unseen all game).
const g = buildGraph(
  makeMap(
    [1, 2, 3, 4, 5],
    [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ],
    [[901, 400, [1, 2]]],
  ),
);

const before = board([mine(1, 5), mine(2, 5), neutral(3, 3), fogged(4), fogged(5)]);
// The opponent came out of the fog: 556 armies now stand on T3.
const after = board([mine(1, 5), mine(2, 5), enemy(3, 556), fogged(4), fogged(5)]);

/** Fewest armies a territory needs so `threat` attackers cannot take it. */
const holdArmies = (threat: number) => {
  let a = 0;
  while ((armiesToTake(a, STD) ?? Infinity) <= threat) a++;
  return a;
};

describe('armies arriving by an attack are a move, not income (#86)', () => {
  it('a capture from the fog counts only its attrition, never the stack standing on it', () => {
    const cost = straightKills(3, 70);
    expect(observeDeploy(g, after, before, ENEMY, STD)).toMatchObject({
      deploy: cost,
      counted: [3],
      captured: [3],
      fromFog: [3],
      fogArmies: 556,
      reveals: [],
    });
    const [e] = enemyDeployEstimates(g, after, ME, STD, before);
    // The base floor wins, not 556 + 3.
    expect(e).toMatchObject({ playerId: ENEMY, observedRaw: cost, estimate: 5, source: 'visible' });
  });

  it('the arrived stack is still the threat that sizes the hold on my border next to it', () => {
    const p = planTurn({ graph: g, board: after, previousBoard: before, me: ME, income: 400, settings: STD });
    expect(p.enemyDeploy).toBe(5);
    // 555 movable (one stands guard) + the ~5 deploy estimate.
    const threat = 555 + 5;
    const need = holdArmies(threat) - 5;
    // The hold is sized for the stack (the leftover may pile on top of it).
    expect(p.deploys.find((d) => d.territoryId === 2)!.armies).toBeGreaterThanOrEqual(need);
    expect(p.rationale.join('\n')).toMatch(new RegExp(`Deploy ${need} to T2 \\(#2\\) so it holds.*~${threat} threat`));
    expect(p.conceded).toEqual([]);
  });

  it('the rationale keeps the threat apart from the income and counts captures from the fog', () => {
    const p = planTurn({ graph: g, board: after, previousBoard: before, me: ME, income: 400, settings: STD, turn: 12 });
    const r = p.rationale.join('\n');
    expect(r).toMatch(/Observed deploy for player 20, turn 11 → turn 12: \+2\/turn over 1 territories visible on both boards \(1 captured, 1 from the fog\)/);
    expect(r).toMatch(/Player 20's stack next to you: 556 on T3 \(#3\) \(threat\), arrived from the fog by a capture: a move, not income\./);
    expect(r).toMatch(/Player 20's estimated income: ~5\/turn \(1 stack that arrived from the fog not counted in it\)\./);
    // One income line per player, however many stacks arrived from the fog.
    expect(r.match(/estimated income/g)).toHaveLength(1);
    expect(p.warnings.join('\n')).not.toMatch(/~5\d\d/);
  });

  it('a capture from a source visible on both boards nets to the attrition', () => {
    // T4 was visibly the opponent's 600; it sent 556 into T3 (3 defenders kill 2), leaving 44
    // on T4 and 554 on T3: −556 on T4, +554 on T3, +2 lost = 0 deployed.
    const seen = board([mine(1, 5), mine(2, 5), neutral(3, 3), enemy(4, 600), fogged(5)]);
    const moved = board([mine(1, 5), mine(2, 5), enemy(3, 554), enemy(4, 44), fogged(5)]);
    expect(observeDeploy(g, moved, seen, ENEMY, STD)).toMatchObject({ deploy: 0, counted: [3, 4], captured: [3], fromFog: [], fogArmies: 0, reveals: [] });
    // It deployed 5 on T4 first and sent all 561: still exactly its deploy.
    const deployed = board([mine(1, 5), mine(2, 5), enemy(3, 559), enemy(4, 44), fogged(5)]);
    expect(observeDeploy(g, deployed, seen, ENEMY, STD).deploy).toBe(5);
  });

  it('several stacks from the fog in one turn share one income line', () => {
    // T6 – T3 – T2 and T7 – T1: two visible neutrals next to me, both taken from the fog.
    const g7 = buildGraph(
      makeMap(
        [1, 2, 3, 4, 6, 7, 8],
        [
          [1, 2],
          [2, 3],
          [3, 4],
          [1, 7],
          [7, 8],
        ],
        [[901, 400, [1, 2]]],
      ),
    );
    const was = board([mine(1, 5), mine(2, 5), neutral(3, 3), fogged(4), neutral(7, 3), fogged(8)]);
    const now = board([mine(1, 5), mine(2, 5), enemy(3, 300), fogged(4), enemy(7, 200), fogged(8)]);
    const p = planTurn({ graph: g7, board: now, previousBoard: was, me: ME, income: 400, settings: STD });
    const r = p.rationale.join('\n');
    expect(r).toMatch(/stack next to you: 300 on T3 \(#3\) \(threat\)/);
    expect(r).toMatch(/stack next to you: 200 on T7 \(#7\) \(threat\)/);
    expect(r).toMatch(/Player 20's estimated income: ~\d+\/turn \(2 stacks that arrived from the fog not counted in it\)\./);
    expect(r.match(/estimated income/g)).toHaveLength(1);
  });

  it('an unchanged visible neighbour of its own is no source: the stack still came from the fog', () => {
    // T6, the opponent's visible 5 both turns, also touches T3; the 556 came from fogged T4.
    const g6 = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5, 6],
        [
          [1, 2],
          [2, 3],
          [3, 4],
          [4, 5],
          [3, 6],
        ],
        [
          [901, 400, [1, 2]],
          [902, 50, [5, 6]],
        ],
      ),
    );
    const was = board([mine(1, 5), mine(2, 5), neutral(3, 3), fogged(4), fogged(5), enemy(6, 5)]);
    const now = board([mine(1, 5), mine(2, 5), enemy(3, 556), fogged(4), fogged(5), enemy(6, 5)]);
    const cost = straightKills(3, 70);
    expect(observeDeploy(g6, now, was, ENEMY, STD)).toMatchObject({ deploy: cost, counted: [3, 6], captured: [3], fromFog: [3], fogArmies: 556, reveals: [] });
    const [e] = enemyDeployEstimates(g6, now, ME, STD, was);
    expect(e.observedRaw).toBe(cost);
    expect(e.estimate).toBeLessThan(100);
  });

  it('only the armies that left a visible neighbour count as moved; the rest came from the fog', () => {
    // T6 visibly shrank 20 -> 10, but 556 stand on T3 and fogged T4 also touches it: 10 of them
    // moved from T6 (nets to zero), the other 546 arrived from the fog.
    const g6 = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5, 6],
        [
          [1, 2],
          [2, 3],
          [3, 4],
          [4, 5],
          [3, 6],
        ],
        [[901, 400, [1, 2]]],
      ),
    );
    const was = board([mine(1, 5), mine(2, 5), neutral(3, 3), fogged(4), fogged(5), enemy(6, 20)]);
    const now = board([mine(1, 5), mine(2, 5), enemy(3, 556), fogged(4), fogged(5), enemy(6, 10)]);
    const cost = straightKills(3, 70);
    expect(observeDeploy(g6, now, was, ENEMY, STD)).toMatchObject({ deploy: cost, counted: [3, 6], captured: [3], fromFog: [3], fogArmies: 546, reveals: [] });
  });
});
