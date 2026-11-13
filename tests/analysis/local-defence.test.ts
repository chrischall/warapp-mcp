// Issue #103: under Local Deployment a held bonus's own armies defend it. Its pool can be
// deployed nowhere else, so the holding cost judged against its worth leaves the pool out;
// the pool goes to its most threatened border (never an interior member while a border is
// threatened) and stays there; and its garrisons are withdrawn only when it truly cannot be
// held — withdrawing turns "might lose it" into "certainly loses it". Synthetic maps only:
// every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { chargeDeploys, deployPools } from '../../src/analysis/local-deploy.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const LOCAL: PlannerSettings = { ...STD, localDeployments: true };

function makeMap(bonuses: [number, number, number[]][]): GameMap {
  //   T8 (enemy) ─ T1 ─ T2 ─ T3 ─ T9 (enemy)      Fort (+3) = T1, T2, T3 (T2 interior)
  //                     │                           Vale (+4) = T4, T5
  //                     T4 ─ T5 ─ T6 ─ T7 ─ T10     Glen (+3) = T6, T7; T10 a 2-neutral
  const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const edges: [number, number][] = [[1, 2], [2, 3], [2, 4], [4, 5], [5, 6], [6, 7], [1, 8], [3, 9], [7, 10]];
  return {
    id: 1,
    name: 'LocalDefence',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({
      id,
      name: ({ 50: 'Fort', 51: 'Vale', 52: 'Glen' } as Record<number, string>)[id]!,
      value,
      territoryIds,
      bonusIds: [],
    })),
    distributionModes: [],
  };
}
const FORT: [number, number, number[]] = [50, 3, [1, 2, 3]];
const ALL = makeMap([FORT, [51, 4, [4, 5]], [52, 3, [6, 7]]]);
const FORT_ONLY = makeMap([FORT]);

const enemy = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: ENEMY },
  armies,
});
/** Fort's two borders hold 3 each; the enemy has `e8 - 1` and 1 movable next to them. */
const fortBoard = (e8: number): BoardState =>
  board([mine(1, 3), mine(2, 1), mine(3, 3), mine(4, 1), mine(5, 1), mine(6, 1), mine(7, 1), enemy(8, e8), enemy(9, 2), neutral(10, 2)]);
const plan = (map: GameMap, b: BoardState, income: number, settings: PlannerSettings) =>
  planTurn({ graph: buildGraph(map), board: b, me: ME, income, settings, options: { goal: 'balanced', enemyDeploy: 9 } });

const deployedTo = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
const deploySum = (p: TurnPlan) => p.deploys.reduce((s, d) => s + d.armies, 0);
const movesFrom = (p: TurnPlan, ids: number[]) => p.moves.filter((m) => ids.includes(m.from));
const withdrawals = (p: TurnPlan) => p.moves.filter((m) => m.reason === 'withdraws from a conceded border');
/** Armies Fort's pool absorbs (with Local Deployment). */
const fortPool = (map: GameMap, p: TurnPlan, income: number) => {
  const held = new Set([1, 2, 3, 4, 5, 6, 7]);
  const pools = deployPools(buildGraph(map), held, income);
  const use = chargeDeploys(pools, new Map(p.deploys.map((d) => [d.territoryId, d.armies])));
  expect(use.anywhereUsed).toBeLessThanOrEqual(pools.anywhere);
  return use.used.get(50) ?? 0;
};

/** The plan passes warapp_submit_turn's validator with the same settings. */
function valid(map: GameMap, p: TurnPlan, b: BoardState, income: number, localDeployments: boolean) {
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
    localDeployments,
  }).warnings;
}

describe('Local Deployment: a bonus\'s own armies defend it (#103)', () => {
  // Income 15 = 5 free + Fort 3 + Vale 4 + Glen 3. Threats: T1 6 movable + ~9 = 15 (needs 8
  // more), T3 1 + ~9 = 10 (needs 3 more): 11 in all, more than 3 × Fort's worth (~3.6).
  const b = fortBoard(7);

  it('(a) the #103 shape: Fort\'s 3 go on its most threatened border, nothing moves out, no garrison is withdrawn', () => {
    const p = plan(ALL, b, 15, LOCAL);
    // The free 5 and Fort's 3 all go on T1, the more threatened border; none on the interior T2.
    expect(deployedTo(p, 1)).toBe(8);
    expect(deployedTo(p, 2)).toBe(0);
    expect(fortPool(ALL, p, 15)).toBe(3);
    // Nothing leaves Fort: no withdrawal, no transfer out of its members.
    expect(movesFrom(p, [1, 2, 3])).toEqual([]);
    expect(withdrawals(p)).toEqual([]);
    const w = p.warnings.join('\n');
    expect(w).toMatch(
      /Bonus Fort \(#50\) \(\+3\) is conceded but might still hold: each of its 2 threatened borders could be held with its own 3 local armies and the 5 free ones, so its garrisons stay/,
    );
    // The room it had was 8 (Fort's 3 + the free 5), not the whole income of 15.
    expect(w).toMatch(/conceding bonus Fort \(#50\) \(\+3\): holding all 2 threatened borders \(T1 \(#1\), T3 \(#3\)\) needs 11, more than the 8 armies left to deploy/);
    expect(w).not.toMatch(/withdrawal from/);
    expect(p.rationale.join('\n')).toMatch(/Keep the 2 movable armies on T1 \(#1\) \(not withdrawn\): bonus Fort \(#50\) might still hold/);
    expect(deploySum(p)).toBe(15);
    expect(valid(ALL, p, b, 15, true)).toEqual([]);
  });

  it('(b) the cost net of the pool flips a concession to a hold when the pool covers the gap', () => {
    // Fort alone: income 15 = 12 free + Fort 3. Holding needs 11 > 3 × ~3.6 = 10.8, so with
    // the flag off it is conceded; net of its pool, 8 ≤ 10.8, and it is held whole.
    const off = plan(FORT_ONLY, b, 15, STD);
    expect(off.warnings.join('\n')).toMatch(/conceding bonus Fort \(#50\) \(\+3\): .* needs 11, more than 3 × its worth \(~3\.6\)/);
    expect(off.conceded).toEqual([1, 3]);
    const on = plan(FORT_ONLY, b, 15, LOCAL);
    expect(on.conceded).toEqual([]);
    expect(on.rationale.join('\n')).toMatch(/Hold bonus Fort \(#50\) \(\+3\) whole: its 2 threatened borders need 11 in all/);
    expect(deployedTo(on, 1)).toBeGreaterThanOrEqual(8);
    expect(deployedTo(on, 3)).toBeGreaterThanOrEqual(3);
    expect(withdrawals(on)).toEqual([]);
    expect(valid(FORT_ONLY, on, b, 15, true)).toEqual([]);
    // A pool that does not cover the gap leaves the concession: the factor test sees the net.
    const huge = fortBoard(13); // T1 now needs 12 more: 15 in all, 12 net of the pool > 10.8.
    const still = plan(FORT_ONLY, huge, 15, LOCAL);
    expect(still.warnings.join('\n')).toMatch(/needs 15 \(12 beyond its own 3 local armies\), more than 3 × its worth/);
  });

  it('(c) a bonus that truly cannot be held still concedes; its pool still stays inside it, on a border', () => {
    // T1 faces 29 movable + ~9: holding it needs far more than Fort's 3 and the 5 free armies.
    const hopeless = fortBoard(30);
    const p = plan(ALL, hopeless, 15, LOCAL);
    expect(p.conceded).toEqual([1, 3]);
    const w = p.warnings.join('\n');
    expect(w).toMatch(
      /Bonus Fort \(#50\) \(\+3\) cannot be held: T1 \(#1\) needs \d+, more than its own 3 local armies and all 5 free ones could give it, so its garrisons withdraw \(it is lost either way\)/,
    );
    expect(w).not.toMatch(/might still hold/);
    expect(withdrawals(p).map((m) => m.from)).toEqual([1, 3]);
    // Fort's 3 go on its most threatened border, never on the interior T2.
    expect(deployedTo(p, 2)).toBe(0);
    expect(deployedTo(p, 1)).toBe(3);
    expect(fortPool(ALL, p, 15)).toBe(3);
    expect(p.rationale.join('\n')).toMatch(/Deploy bonus Fort \(#50\)'s 3 to T1 \(#1\): Local Deployment keeps them inside the bonus, and it is its most threatened border/);
    expect(deploySum(p)).toBe(15);
    expect(valid(ALL, p, hopeless, 15, true)).toEqual([]);
  });

  it('(d) flag off: today\'s plan exactly — conceded, both garrisons withdrawn, everything on the expansion', () => {
    const off = plan(ALL, b, 15, STD);
    expect(plan(ALL, b, 15, { ...STD, localDeployments: false })).toEqual(off);
    expect(off.deploys).toEqual([{ territoryId: 7, armies: 15 }]);
    expect(off.moves).toEqual([
      { from: 1, to: 2, armies: 2, kind: 'transfer', reason: 'withdraws from a conceded border' },
      { from: 3, to: 2, armies: 2, kind: 'transfer', reason: 'withdraws from a conceded border' },
      { from: 7, to: 10, armies: 3, kind: 'attack', reason: 'expands territory', winChance: 1 },
    ]);
    expect(off.warnings).toContain(
      'conceding bonus Fort (#50) (+3): holding all 2 threatened borders (T1 (#1), T3 (#3)) needs 11, more than 3 × its worth (~3.6)',
    );
    expect(off.warnings.join('\n')).not.toMatch(/might still hold|cannot be held:/);
  });

  it('(e) every plan passes validateTurn with the same settings', () => {
    for (const e8 of [2, 5, 7, 10, 13, 20, 30])
      for (const income of [10, 12, 15, 20])
        for (const [map, held] of [
          [ALL, true],
          [FORT_ONLY, false],
        ] as const)
          for (const localDeployments of [false, true]) {
            const bb = fortBoard(e8);
            // Without Vale and Glen, the income is free + Fort's 3.
            const inc = held ? Math.max(income, 10) : income;
            const p = plan(map, bb, inc, { ...STD, localDeployments });
            const ctx = `e8 ${e8} income ${inc} ${held ? 'all' : 'fort'} local ${localDeployments}`;
            expect(valid(map, p, bb, inc, localDeployments), ctx).toEqual([]);
            expect(deploySum(p), ctx).toBe(inc);
            // Fort's pool never lands on its interior while a border is threatened.
            if (localDeployments) expect(deployedTo(p, 2), ctx).toBe(0);
          }
  });
});
