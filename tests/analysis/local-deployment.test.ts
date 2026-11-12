// G2 (issue #29): Local Deployment. A held bonus's armies are deployed inside it;
// only the rest of the income may go anywhere. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { chargeDeploys, deployPools } from '../../src/analysis/local-deploy.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral, tinyMap } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const LOCAL: PlannerSettings = { ...STD, localDeployments: true };

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

const enemy = (territoryId: number, armies: number, playerId = ENEMY): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const deploySum = (p: TurnPlan) => p.deploys.reduce((s, d) => s + d.armies, 0);
const deployedOn = (p: TurnPlan, ids: number[]) =>
  p.deploys.filter((d) => ids.includes(d.territoryId)).reduce((s, d) => s + d.armies, 0);
const deployMap = (p: TurnPlan) => new Map(p.deploys.map((d) => [d.territoryId, d.armies]));

describe('deployPools / chargeDeploys', () => {
  it('one pool per held positive bonus, innermost first; the rest anywhere', () => {
    // tinyMap: A (+3) = 1,2,3; B (+2) = 4,5; C (0) = 6; superbonus S (+4) = A + B.
    const g = buildGraph(tinyMap());
    const all = deployPools(g, new Set([1, 2, 3, 4, 5, 6]), 14);
    expect(all.bonuses.map((p) => [p.bonusId, p.value, p.territoryIds])).toEqual([
      [102, 2, [4, 5]],
      [101, 3, [1, 2, 3]],
      [104, 4, [1, 2, 3, 4, 5]],
    ]);
    expect(all.anywhere).toBe(5);
    expect(all.trimmed).toBe(0);
    // Holding A only: one pool.
    expect(deployPools(g, new Set([1, 2, 3]), 8).bonuses.map((p) => p.bonusId)).toEqual([101]);
    expect(deployPools(g, new Set([1, 2, 3]), 8).anywhere).toBe(5);
  });

  it('nested pools: innermost first, so a valid split is never refused', () => {
    const g = buildGraph(tinyMap());
    const pools = deployPools(g, new Set([1, 2, 3, 4, 5, 6]), 14);
    // B's 2 on T4, A's 3 on T1, S's 4 split over T2 and T5, 5 anywhere on T6.
    const ok = chargeDeploys(pools, new Map([[4, 2], [1, 3], [2, 2], [5, 2], [6, 5]]));
    expect(ok.anywhereUsed).toBe(5);
    expect(ok.used).toEqual(new Map([[102, 2], [101, 3], [104, 4]]));
    // All 14 on T6 (outside every bonus): 9 bonus armies spent outside.
    expect(chargeDeploys(pools, new Map([[6, 14]])).anywhereUsed).toBe(14);
  });

  it('trims the outermost pools when the income is smaller than the pools', () => {
    const g = buildGraph(tinyMap());
    const pools = deployPools(g, new Set([1, 2, 3, 4, 5]), 6);
    expect(pools.bonuses.map((p) => p.value)).toEqual([2, 3, 1]);
    expect(pools.trimmed).toBe(3);
    expect(pools.anywhere).toBe(0);
  });
});

describe('planTurn — Local Deployment (G2)', () => {
  //   T1 ─ T2 ─ T3 ─ T4       bonus B9 (+3) = T1, T2
  //              └── T6       T3, T4, T6 are in no bonus
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 6],
      [
        [1, 2],
        [2, 3],
        [3, 4],
        [3, 6],
      ],
      [[9, 3, [1, 2]]],
    ),
  );
  // I hold B9 and T3 (1 army); the targets are outside the bonus, next to T3:
  // T4's 3 neutrals cost 5, T6's 2 cost 3. Income 5 base + 3 bonus = 8.
  const s = board([mine(1, 1), mine(2, 1), mine(3, 1), neutral(4, 3), neutral(6, 2)]);

  it('(a) off: today\'s plan exactly — all 8 on T3 for both captures', () => {
    for (const goal of ['expand', 'balanced'] as const) {
      const off = planTurn({ graph: g, board: s, me: ME, income: 8, settings: STD, options: { goal } });
      expect(planTurn({ graph: g, board: s, me: ME, income: 8, settings: { ...STD, localDeployments: false }, options: { goal } })).toEqual(off);
      expect(off.deploys).toEqual([{ territoryId: 3, armies: 8 }]);
      expect(off.expected.captures).toEqual([4, 6]);
      expect(off.rationale.join('\n')).not.toMatch(/Local Deployment/);
    }
  });

  it('(b) on, +3 bonus, base 5: at most 5 outside the bonus and exactly 3 inside it', () => {
    for (const goal of ['expand', 'balanced'] as const) {
      const p = planTurn({ graph: g, board: s, me: ME, income: 8, settings: LOCAL, options: { goal } });
      expect(deploySum(p)).toBe(8);
      expect(deployedOn(p, [1, 2])).toBe(3);
      expect(deployedOn(p, [3])).toBeLessThanOrEqual(5);
      // 5 on T3 afford T6 (3), not T4 (5) as well.
      expect(attacks(p)).toEqual([expect.objectContaining({ from: 3, to: 6, armies: 3 })]);
      expect(p.expected.captures).toEqual([6]);
      const text = p.rationale.join('\n');
      expect(text).toMatch(/Local Deployment: 5 of the 8 income may be deployed anywhere/);
      expect(text).toMatch(/Local Deployment: bonus B9 \(#9\)'s \+3 may only be deployed on its territories \(T1 \(#1\), T2 \(#2\)\)/);
      const pools = deployPools(g, new Set([1, 2, 3]), 8);
      expect(chargeDeploys(pools, deployMap(p)).anywhereUsed).toBeLessThanOrEqual(pools.anywhere);
    }
  });

  it('(c) two held bonuses: each pool is used only inside its own bonus', () => {
    //   T8 ─ T1 ─ T2 ─ T3 ─ T4 ─ T5 ─ T7     X (+3) = T1, T2;  Y (+2) = T4, T5
    const g2 = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5, 7, 8],
        [
          [8, 1],
          [1, 2],
          [2, 3],
          [3, 4],
          [4, 5],
          [5, 7],
        ],
        [
          [21, 3, [1, 2]],
          [22, 2, [4, 5]],
        ],
      ),
    );
    // T7's 4 cost 6 from T5 (1 army): Y's 2 + 4 of the anywhere 5. T8's 2 cost 3 from T1: X's 3.
    const b2 = board([mine(1, 1), mine(2, 1), mine(3, 1), mine(4, 1), mine(5, 1), neutral(7, 4), neutral(8, 2)]);
    const p = planTurn({ graph: g2, board: b2, me: ME, income: 10, settings: LOCAL, options: { goal: 'expand' } });
    expect(deploySum(p)).toBe(10);
    expect(p.expected.captures).toEqual([7, 8]);
    const pools = deployPools(g2, new Set([1, 2, 3, 4, 5]), 10);
    const use = chargeDeploys(pools, deployMap(p));
    expect(use.anywhereUsed).toBeLessThanOrEqual(5);
    expect(use.used).toEqual(new Map([[21, 3], [22, 2]]));
    expect(deployedOn(p, [1, 2])).toBeGreaterThanOrEqual(3);
    expect(deployedOn(p, [4, 5])).toBeGreaterThanOrEqual(2);
    expect(p.rationale.join('\n')).toMatch(/bonus B21 \(#21\)'s \+3/);
    expect(p.rationale.join('\n')).toMatch(/bonus B22 \(#22\)'s \+2/);
  });

  it('(d) a bonus pool with no use is still deployed inside the bonus, on its most threatened member', () => {
    // No target at all: the anywhere 5 goes to the leftover spot, the bonus's 3 stay inside it.
    const quiet = board([mine(1, 1), mine(2, 1), mine(3, 4), fogged(4), neutral(6, 30)]);
    const p = planTurn({ graph: g, board: quiet, me: ME, income: 8, settings: LOCAL, options: { goal: 'expand' } });
    expect(deploySum(p)).toBe(8);
    expect(deployedOn(p, [1, 2])).toBe(3);
    // No member threatened: ties by id → T1.
    expect(p.deploys).toContainEqual({ territoryId: 1, armies: 3 });
    expect(p.rationale.join('\n')).toMatch(/Deploy bonus B9 \(#9\)'s 3 to T1 \(#1\): Local Deployment keeps them inside the bonus/);

    // An enemy next to T2 makes T2 the most threatened member.
    //   T1 ─ T2 ─ T3,  T2 ─ T5 (enemy)
    const g3 = buildGraph(makeMap([1, 2, 3, 5], [[1, 2], [2, 3], [2, 5]], [[9, 3, [1, 2]]]));
    const q = planTurn({
      graph: g3,
      board: board([mine(1, 1), mine(2, 1), mine(3, 1), enemy(5, 5)]),
      me: ME,
      income: 8,
      settings: LOCAL,
      options: { goal: 'expand', enemyDeploy: 5 },
    });
    expect(deploySum(q)).toBe(8);
    expect(deployedOn(q, [2])).toBeGreaterThanOrEqual(3);
    const pools = deployPools(g3, new Set([1, 2, 3]), 8);
    expect(chargeDeploys(pools, deployMap(q)).anywhereUsed).toBeLessThanOrEqual(pools.anywhere);
  });

  it('a superbonus\'s armies go inside the superbonus', () => {
    // tinyMap, holding A, B (and so S): pools B 2, A 3, S 4; 5 anywhere; income 14.
    const g4 = buildGraph(tinyMap());
    const b4 = board([mine(1, 1), mine(2, 1), mine(3, 1), mine(4, 1), mine(5, 1), mine(6, 1), neutral(7, 2)]);
    const p = planTurn({ graph: g4, board: b4, me: ME, income: 14, settings: LOCAL, options: { goal: 'expand' } });
    expect(deploySum(p)).toBe(14);
    // Only T6 (outside S) borders T7: at most the anywhere 5 go there.
    expect(deployedOn(p, [6])).toBeLessThanOrEqual(5);
    expect(deployedOn(p, [1, 2, 3, 4, 5])).toBeGreaterThanOrEqual(9);
    const pools = deployPools(g4, new Set([1, 2, 3, 4, 5, 6]), 14);
    const use = chargeDeploys(pools, deployMap(p));
    expect(use.anywhereUsed).toBeLessThanOrEqual(5);
    expect(use.used).toEqual(new Map([[102, 2], [101, 3], [104, 4]]));
    expect(p.rationale.join('\n')).toMatch(/bonus S \(#104\)'s \+4 may only be deployed on its territories/);
  });

  it('holding no bonus, the flag changes nothing', () => {
    const s2 = board([mine(1, 1), mine(3, 1), neutral(2, 1), neutral(4, 3), neutral(6, 2)]);
    const off = planTurn({ graph: g, board: s2, me: ME, income: 5, settings: STD });
    expect(planTurn({ graph: g, board: s2, me: ME, income: 5, settings: LOCAL })).toEqual(off);
  });
});

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('planTurn — Local Deployment property (G2)', () => {
  it('off is today\'s plan; on, deploys sum to the income and never break a pool', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
      const n = int(3, 10);
      const ids = Array.from({ length: n }, (_, i) => i + 1);
      const edges: [number, number][] = [];
      for (let i = 2; i <= n; i++) edges.push([i, int(1, i - 1)]);
      for (let k = 0; k < n; k++) {
        const a = int(1, n);
        const b = int(1, n);
        if (a !== b) edges.push([a, b]);
      }
      const bonuses: [number, number, number[]][] = [];
      for (let b = 0; b < int(0, 4); b++) {
        const members = ids.filter(() => r() < 0.4);
        if (members.length) bonuses.push([100 + b, int(-1, 5), members]);
      }
      const g = buildGraph(makeMap(ids, edges, bonuses));
      const entries: TerritoryState[] = ids.map((id) => {
        const k = id === 1 ? 0 : int(0, 5);
        if (k <= 1) return mine(id, int(0, 8));
        if (k === 2) return enemy(id, int(1, 12));
        if (k === 3) return fogged(id);
        return neutral(id, int(0, 12));
      });
      const settings: PlannerSettings = {
        offensiveKillRate: int(40, 100),
        defensiveKillRate: int(0, 100),
        oneArmyStandsGuard: r() < 0.8,
        allowTransferOnly: r() < 0.8,
      };
      const goals = ['expand', 'complete-bonus', 'defend', 'balanced'] as const;
      const held = new Set(entries.filter((e) => e.owner.kind === 'player' && e.owner.playerId === ME).map((e) => e.territoryId));
      const input: PlanInput = {
        graph: g,
        board: board(entries),
        me: ME,
        income: int(0, 16),
        settings,
        options: { goal: goals[int(0, 3)], reserve: int(0, 3) },
      };
      const ctx = `seed ${seed}`;
      const off = planTurn(input);
      expect(planTurn({ ...input, settings: { ...settings, localDeployments: false } }), ctx).toEqual(off);
      const on = planTurn({ ...input, settings: { ...settings, localDeployments: true } });
      expect(deploySum(on), ctx).toBe(input.income);
      for (const d of on.deploys) expect(held.has(d.territoryId), ctx).toBe(true);
      const pools = deployPools(g, held, input.income);
      expect(chargeDeploys(pools, deployMap(on)).anywhereUsed, ctx).toBeLessThanOrEqual(pools.anywhere);
    }
  });
});
