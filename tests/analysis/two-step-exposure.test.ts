// Issue #172: the planner never empties a held bonus that a stack two steps away can reach next
// turn by taking the territory in between this turn — the look-ahead warapp_check_plan reports as
// `exposedNextTurn`, one computation (lookahead.ts) for both. Synthetic maps only: every id and
// name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { twoStepReaches } from '../../src/analysis/lookahead.js';
import { winChance } from '../../src/analysis/combat.js';
import { HOLD_FALL_CHANCE, planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { stressPlan } from '../../src/analysis/stress.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'TwoSteps',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const player = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const leaving = (p: TurnPlan, id: number) => p.moves.filter((m) => m.from === id).reduce((n, m) => n + m.armies, 0);
const deployedTo = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;

function valid(map: GameMap, p: TurnPlan, b: BoardState, income: number) {
  const names = new Map(map.territories.map((t) => [t.id, t.name]));
  const ref = (id: number) => ({ id, name: names.get(id)! });
  return validateTurn({
    map,
    board: b.territories.map(
      (t): LiveTerritory => ({
        territoryId: t.territoryId,
        fogLevel: 1,
        fogged: false,
        owner: t.owner.kind === 'player' ? t.owner.playerId : t.owner.kind === 'neutral' ? OWNER_NEUTRAL : -1,
        armies: t.armies,
      }),
    ),
    myInGameId: ME,
    income,
    guard: true,
    deploys: p.deploys.map((d) => ({ territory: ref(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: ref(m.from), to: ref(m.to), armies: m.armies })),
  }).warnings;
}

// The reported shape: T1 a one-territory +12 bonus (B101) holding 28. Its front is T4 (mine, 50),
// beside an enemy 60 on T5; a weak 8-army neutral T2 lies between T1 and an enemy stack on T3.
//
//   T3 (enemy) ─ T2 (neutral 8) ─ T1 (+12, 28) ─ T4 (mine 50) ─ T5 (enemy 60)
//
// Rule 6 sends T1's idle armies to T4 (the front is two steps off through T4); taking T2 this
// turn puts the T3 stack beside T1 next turn.
const EDGES: [number, number][] = [[1, 2], [2, 3], [1, 4], [4, 5]];
const IDS = [1, 2, 3, 4, 5];
const KEEP: [number, number, number[]][] = [[101, 12, [1]]];
const reportedMap = makeMap(IDS, EDGES, KEEP);
const reported = (stack: number) => board([mine(1, 28), neutral(2, 8), player(3, stack, ENEMY), mine(4, 50), player(5, 60, ENEMY)]);
// Income 40 (bonuses elsewhere): T1's 28 plus next turn's 40 can reach what it needs.
const plan = (map: GameMap, b: BoardState, income = 40) =>
  planTurn({
    graph: buildGraph(map),
    board: b,
    me: ME,
    income,
    settings: STD,
    game: { players: [{ id: ME }, { id: ENEMY }], turn: 7 },
    options: { goal: 'balanced', enemyDeploy: 5 },
  });

describe('a held bonus a stack two steps away can reach keeps its hold (#172)', () => {
  it('the reported shape: the +12 bonus is not emptied toward the front', () => {
    const b = reported(98);
    const p = plan(reportedMap, b);
    // 98 + 5 take T2 and attack on with ~100: T1 needs far more than its 28, so nothing leaves.
    expect(leaving(p, 1)).toBe(0);
    expect(p.rationale.join('\n')).toMatch(
      /kept 28 on T1 \(#1\): player 20 can reach it next turn from T3 \(#3\) via T2 \(#2\) \(~\d+ attacking; it needs \d+ to hold\)/,
    );
    expect(valid(reportedMap, p, b, 40)).toEqual([]);
  });

  it('the hold is the same computation check_plan reports (and check_plan is unchanged by it)', () => {
    const b = reported(98);
    const g = buildGraph(reportedMap);
    const report = stressPlan({ graph: g, board: b, me: ME, deploys: [], moves: [], opponents: [{ id: ENEMY, deploy: 5 }], settings: STD });
    const reaches = twoStepReaches({ graph: g, board: b, me: ME, opponents: [{ id: ENEMY, deploy: 5 }], settings: STD });
    expect(reaches).toEqual([expect.objectContaining({ territory: 1, from: 3, via: 2, falls: true })]);
    const r = reaches[0]!;
    expect(report.exposedNextTurn).toEqual([
      { territory: 1, armies: r.armies, opponent: ENEMY, from: 3, via: 2, attackers: r.attackers, needs: r.needs, bonusesLost: [{ id: 101, value: 12 }], incomeLost: 12 },
    ]);
    const p = plan(reportedMap, b);
    expect(p.rationale.join('\n')).toContain(`it needs ${r.needs} to hold`);
  });

  it('keeps only what it needs: a stack too small to matter does not block the transfer', () => {
    const b = reported(12);
    const g = buildGraph(reportedMap);
    const r = twoStepReaches({ graph: g, board: b, me: ME, opponents: [{ id: ENEMY, deploy: 5 }], settings: STD });
    // 12 + 5 take T2 and come on with a handful: T1 needs a few, not 28.
    const needs = Math.max(0, ...r.filter((x) => x.territory === 1).map((x) => x.needs));
    expect(needs).toBeLessThan(15);
    const p = plan(reportedMap, b);
    expect(leaving(p, 1)).toBeGreaterThan(0);
    expect(28 + deployedTo(p, 1) - leaving(p, 1)).toBeGreaterThanOrEqual(needs);
    expect(valid(reportedMap, p, b, 40)).toEqual([]);
  });

  it('a stack three steps away does not block the transfer', () => {
    // T6 (neutral) between T2 and the stack: T3 is three steps from T1.
    const map = makeMap([1, 2, 3, 4, 5, 6], [[1, 2], [2, 6], [6, 3], [1, 4], [4, 5]], KEEP);
    const b = board([mine(1, 28), neutral(2, 8), player(3, 98, ENEMY), mine(4, 50), player(5, 60, ENEMY), neutral(6, 8)]);
    const p = plan(map, b);
    expect(leaving(p, 1)).toBe(27);
    expect(p.rationale.join('\n')).not.toMatch(/can reach it next turn/);
    expect(valid(map, p, b, 40)).toEqual([]);
  });

  it('a territory protecting nothing is not held at the expense of the front', () => {
    const map = makeMap(IDS, EDGES, [[101, 12, [4, 1, 2]]]);
    const b = reported(98);
    const p = plan(map, b);
    expect(leaving(p, 1)).toBe(27);
    expect(p.rationale.join('\n')).not.toMatch(/can reach it next turn/);
    expect(valid(map, p, b, 40)).toEqual([]);
  });

  it('a hold it cannot make even with next turn\'s income is not kept (its armies serve the front)', () => {
    const b = reported(98);
    const g = buildGraph(reportedMap);
    const r = twoStepReaches({ graph: g, board: b, me: ME, opponents: [{ id: ENEMY, deploy: 5 }], settings: STD })[0]!;
    // 28 + 17 fall short of what T1 needs: keeping them home saves nothing.
    expect(28 + 17).toBeLessThan(r.needs);
    const p = plan(reportedMap, b, 17);
    expect(leaving(p, 1)).toBe(27 + deployedTo(p, 1));
    expect(p.rationale.join('\n')).not.toMatch(/can reach it next turn/);
    expect(valid(reportedMap, p, b, 17)).toEqual([]);
  });

  it('under Local Deployment a hold only its own pool and the free income could make is hopeless', () => {
    // T4 is a +25 bonus of its own: of next turn's 40, only T1's pool (12) and the 3 free can land
    // on T1. 28 + 15 fall short of what T1 needs against ~100; 28 + 40 would not.
    const map = makeMap(IDS, EDGES, [...KEEP, [102, 25, [4]]]);
    const b = reported(98);
    const g = buildGraph(map);
    const r = twoStepReaches({ graph: g, board: b, me: ME, opponents: [{ id: ENEMY, deploy: 5 }], settings: STD }).find((x) => x.territory === 1)!;
    expect(28 + 15).toBeLessThan(r.needs);
    expect(28 + 40).toBeGreaterThanOrEqual(r.needs);
    const run = (localDeployments: boolean) =>
      planTurn({
        graph: g,
        board: b,
        me: ME,
        income: 40,
        settings: { ...STD, localDeployments },
        game: { players: [{ id: ME }, { id: ENEMY }], turn: 7 },
        options: { goal: 'balanced', enemyDeploy: 5 },
      });
    expect(leaving(run(false), 1)).toBe(0);
    const p = run(true);
    expect(leaving(p, 1)).toBe(27 + deployedTo(p, 1));
    expect(p.rationale.join('\n')).not.toMatch(/can reach it next turn/);
  });

  it('an attack out of it keeps the hold too', () => {
    // T6, a 2-neutral worth +3 on its own, lies beside T1 only: T1 attacks it with deploys, never
    // with the armies that hold it against the reach.
    const map = makeMap([...IDS, 6], [...EDGES, [1, 6]], [...KEEP, [102, 3, [6]]]);
    const b = board([...reported(98).territories, neutral(6, 2)]);
    const g = buildGraph(map);
    const r = twoStepReaches({ graph: g, board: b, me: ME, opponents: [{ id: ENEMY, deploy: 5 }], settings: STD }).find((x) => x.territory === 1)!;
    const p = plan(map, b);
    expect(p.moves).toContainEqual(expect.objectContaining({ from: 1, to: 6, kind: 'attack' }));
    expect(28 + deployedTo(p, 1) - leaving(p, 1)).toBeGreaterThanOrEqual(r.needs);
    expect(p.rationale.join('\n')).toMatch(/Attack T6 \(#6\) from T1 \(#1\) with 3 \(deploy 3 there\)/);
    expect(p.rationale.join('\n')).toMatch(/The attack on T6 \(#6\) leaves T1 \(#1\) its hold \(kept \d+ on T1 \(#1\): player 20 can reach it next turn from T3 \(#3\) via T2 \(#2\)/);
    expect(valid(map, p, b, 40)).toEqual([]);
  });

  // Review of #172: a reach whose stack, or whose territory in between, a LATER order of the same
  // plan takes is no reach at all; the attacks sized before that order must not keep against it.
  // Two randomized boards (made-up ids) where it did.
  const fogged = (territoryId: number): TerritoryState => ({ territoryId, owner: { kind: 'unknown' }, armies: null });
  const sweep = (ids: number[], edges: [number, number][], bonuses: [number, number, number[]][], b: BoardState, income: number, enemyDeploy: number, goal?: 'defend') => {
    const map = makeMap(ids, edges, bonuses);
    const p = planTurn({
      graph: buildGraph(map),
      board: b,
      me: ME,
      income,
      settings: STD,
      game: { players: [{ id: ME }, { id: ENEMY }], turn: 5 },
      options: { ...(goal ? { goal } : {}), enemyDeploy },
    });
    return { map, p };
  };

  it('a plan that also takes the stack and the territory in between is not cut short by the hold', () => {
    // T1, a one-territory +5 bonus on 8, faces a reach from the stack on T13 via the neutral T3. The
    // plan presses T7, T10 and T13 (taking the stack) and takes T3 from T1: neither is a reach then.
    const b = board([
      mine(1, 8), mine(2, 11), neutral(3, 1), fogged(4), mine(5, 15), fogged(6), player(7, 5, ENEMY), mine(8, 7),
      fogged(9), player(10, 3, ENEMY), mine(11, 8), mine(12, 13), player(13, 10, ENEMY),
    ]);
    const { map, p } = sweep(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      [[1, 2], [1, 3], [1, 5], [1, 7], [2, 10], [2, 13], [3, 4], [3, 6], [3, 13], [3, 9], [4, 12], [5, 13], [5, 12], [6, 9], [7, 8], [7, 11], [11, 12]],
      [[100, 5, [1]], [101, 1, [2, 3, 4]], [102, 0, [5, 6, 7, 8]], [103, 2, [9, 10, 11]], [104, 4, [12, 13]]],
      b, 6, 5, 'defend',
    );
    expect(p.expected.captures).toEqual(expect.arrayContaining([3, 7, 13]));
    expect(p.moves).toContainEqual(expect.objectContaining({ from: 1, to: 3, kind: 'attack' }));
    expect(p.moves).toContainEqual(expect.objectContaining({ from: 1, to: 7, kind: 'attack' }));
    expect(p.rationale.join('\n')).not.toMatch(/Do not take T3/);
    expect(p.rationale.join('\n')).not.toMatch(/can reach it next turn/);
    expect(valid(map, p, b, 6)).toEqual([]);
  });

  it('an attack out of a guarded territory is sized in full when the plan takes the territory in between later', () => {
    // T3 (in B100, held) faces a reach from T9 via the neutral T6; the plan takes T9 too.
    const b = board([
      mine(1, 23), mine(2, 12), mine(3, 13), player(4, 2, ENEMY), mine(5, 10), neutral(6, 6), neutral(7, 5),
      neutral(8, 6), player(9, 2, ENEMY), player(10, 2, ENEMY), neutral(11, 1), neutral(12, 2), player(13, 1, ENEMY), mine(14, 8),
    ]);
    const { map, p } = sweep(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      [[1, 2], [1, 9], [2, 3], [2, 5], [2, 9], [2, 10], [2, 11], [3, 4], [3, 6], [3, 7], [3, 8], [5, 7], [5, 8], [5, 13], [5, 6], [6, 12], [6, 9], [7, 14], [7, 11]],
      [[100, 2, [1, 2, 3]], [101, 2, [4, 5, 6]], [102, 3, [7, 8]], [103, 4, [9, 10]], [104, 0, [11, 12, 13, 14]]],
      b, 25, 9,
    );
    const onT4 = p.moves.find((m) => m.from === 3 && m.to === 4)!;
    expect(onT4.reason).toMatch(/sized for its full ~9 deploy/);
    expect(p.rationale.join('\n')).not.toMatch(/can reach it next turn/);
    expect(valid(map, p, b, 25)).toEqual([]);
  });

  it('a hold that rules out an order says why, even when no order of its own keeps it', () => {
    // T11, a one-territory +1 bonus on 11 (2 more arrive from the conceded T10), can be reached from
    // the stack on T12 via T10. Its hold rules out the attack on T3 that would advance B100: the
    // plan has no order out of T11 to say so, so it says it at the end.
    const b = board([
      neutral(1, 6), fogged(2), neutral(3, 3), mine(4, 8), mine(5, 4), fogged(6), mine(7, 28), neutral(8, 5), fogged(9),
      mine(10, 3), mine(11, 11), player(12, 5, ENEMY), player(13, 4, ENEMY),
    ]);
    const map = makeMap(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      [[1, 2], [1, 4], [1, 8], [1, 10], [1, 6], [2, 3], [2, 6], [2, 7], [3, 11], [4, 5], [4, 8], [7, 9], [7, 11], [9, 13], [9, 11], [10, 11], [10, 12]],
      [[100, 4, [1, 2, 3, 4]], [101, 2, [5, 6]], [102, 4, [7, 8]], [103, 3, [9, 10]], [104, 1, [11]], [105, 4, [12, 13]]],
    );
    const p = planTurn({ graph: buildGraph(map), board: b, me: ME, income: 4, settings: STD, game: { players: [{ id: ME }, { id: ENEMY }], turn: 1 } });
    expect(p.moves.filter((m) => m.from === 11)).toEqual([]);
    expect(p.rationale.join('\n')).toMatch(
      /Orders out of T11 \(#11\) leave it its hold \(kept 13 on T11 \(#11\): player 20 can reach it next turn from T12 \(#12\) via T10 \(#10\) \(~\d+ attacking; it needs \d+ to hold\)\)\./,
    );
    expect(valid(map, p, b, 4)).toEqual([]);
  });

  it('under luck the hold is measured as a one-step hold is: it falls at most HOLD_FALL_CHANCE of the time', () => {
    const LUCK: PlannerSettings = { ...STD, luckModifier: 0.16 };
    const b = reported(12);
    const g = buildGraph(reportedMap);
    const r = twoStepReaches({ graph: g, board: b, me: ME, opponents: [{ id: ENEMY, deploy: 5 }], settings: LUCK }).find((x) => x.territory === 1)!;
    // The luck-free need (check_plan's) against the luck-aware one the one-step holds use.
    let held = 0;
    while (winChance(r.attackers, held, { offensiveKillRate: 60, defensiveKillRate: 70, luck: 0.16 }) > HOLD_FALL_CHANCE) held++;
    expect(held).toBeGreaterThan(r.needs);
    const p = planTurn({
      graph: g,
      board: b,
      me: ME,
      income: 40,
      settings: LUCK,
      game: { players: [{ id: ME }, { id: ENEMY }], turn: 7 },
      options: { goal: 'balanced', enemyDeploy: 5 },
    });
    expect(p.rationale.join('\n')).toContain(`it needs ${held} to hold`);
    expect(28 + deployedTo(p, 1) - leaving(p, 1)).toBeGreaterThanOrEqual(held);
    expect(valid(reportedMap, p, b, 40)).toEqual([]);
  });

  it('every plan passes validateTurn', () => {
    for (const stack of [1, 4, 10, 20, 40, 98])
      for (const income of [5, 12, 17, 30]) {
        const b = reported(stack);
        const p = plan(reportedMap, b, income);
        expect(valid(reportedMap, p, b, income), `stack ${stack} income ${income}`).toEqual([]);
      }
  });
});
