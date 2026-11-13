// Issue #172: the planner never empties a held bonus that a stack two steps away can reach next
// turn by taking the territory in between this turn — the look-ahead warapp_check_plan reports as
// `exposedNextTurn`, one computation (lookahead.ts) for both. Synthetic maps only: every id and
// name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { twoStepReaches } from '../../src/analysis/lookahead.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
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

  it('every plan passes validateTurn', () => {
    for (const stack of [1, 4, 10, 20, 40, 98])
      for (const income of [5, 12, 17, 30]) {
        const b = reported(stack);
        const p = plan(reportedMap, b, income);
        expect(valid(reportedMap, p, b, income), `stack ${stack} income ${income}`).toEqual([]);
      }
  });
});
