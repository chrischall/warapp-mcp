// G3 (issue #31): No-Split. With the game's NoSplit setting on, a territory issues
// at most one AttackTransfer (attack or transfer) per turn. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { LiveTerritory } from '../../src/live.js';
import type { GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const NOSPLIT: PlannerSettings = { ...STD, noSplit: true };

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
/** Moves per source territory. */
const perSource = (p: TurnPlan) => {
  const n = new Map<number, number>();
  for (const m of p.moves) n.set(m.from, (n.get(m.from) ?? 0) + 1);
  return n;
};

describe('planTurn — No-Split (G3)', () => {
  // T1 (mine) borders two cheap neutrals: T2 (1 army, no bonus) and T3 (2 armies, bonus B+2 alone).
  //   T2 ─ T1 ─ T3
  const g = buildGraph(
    makeMap(
      [1, 2, 3],
      [
        [1, 2],
        [1, 3],
      ],
      [[50, 2, [3]]],
    ),
  );
  const s = board([mine(1, 10), neutral(2, 1), neutral(3, 2)]);

  it('(a) flag off (or absent) plans exactly as today: both neutrals from one source', () => {
    const today = planTurn({ graph: g, board: s, me: ME, income: 5, settings: STD });
    expect(attacks(today).map((m) => [m.from, m.to])).toEqual([
      [1, 3],
      [1, 2],
    ]);
    expect(planTurn({ graph: g, board: s, me: ME, income: 5, settings: { ...STD, noSplit: false } })).toEqual(today);
    expect(today.warnings.join('\n')).not.toMatch(/No-Split/);
    expect(today.rationale.join('\n')).not.toMatch(/No-Split/);
  });

  it('(b) flag on: one attack only (the better one: it completes the bonus); a warning names the dropped one', () => {
    const p = planTurn({ graph: g, board: s, me: ME, income: 5, settings: NOSPLIT });
    // armiesToTake(2) at 60/70 = max(ceil(150 / 60) = 3, round(1.4) + 1 = 2) = 3.
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 3, armies: 3 })]);
    expect(p.moves).toHaveLength(1);
    expect(p.expected.captures).toEqual([3]);
    expect(p.expected.bonusesCompleted).toEqual([50]);
    expect(deploySum(p)).toBe(5);
    const w = p.warnings.join('\n');
    expect(w).toMatch(/No-Split: T1 \(#1\) already attacks T3 \(#3\), so the attack on T2 \(#2\) is not planned/);
    // The planned amount is kept; whether No-Split also forces all-in is unverified.
    expect(w).toMatch(/No-Split is on: .*unverified/);
    expect(p.rationale.join('\n')).toMatch(/No-Split: each territory issues at most one attack or transfer/);
  });

  it('(b) another source still takes a target a split source had to drop', () => {
    // T4 (mine, 5) also borders T2: T2 is taken from T4 instead of being dropped.
    const g2 = buildGraph(
      makeMap(
        [1, 2, 3, 4],
        [
          [1, 2],
          [1, 3],
          [4, 2],
        ],
        [[50, 2, [3]]],
      ),
    );
    const p = planTurn({
      graph: g2,
      board: board([mine(1, 10), neutral(2, 1), neutral(3, 2), mine(4, 5)]),
      me: ME,
      income: 5,
      settings: NOSPLIT,
    });
    expect(attacks(p).map((m) => [m.from, m.to])).toEqual([
      [1, 3],
      [4, 2],
    ]);
    expect(p.warnings.join('\n')).not.toMatch(/is not planned/);
  });

  it('(c) a transfer and an attack from one source: only the attack is kept, the transfer is warned', () => {
    // T2 ─ T1 ─ T4 ─ T5(fogged). T1 takes T2; its idle remainder would walk to T4.
    const g3 = buildGraph(
      makeMap(
        [1, 2, 4, 5],
        [
          [1, 2],
          [1, 4],
          [4, 5],
        ],
      ),
    );
    const s3 = board([mine(1, 10), neutral(2, 1), mine(4, 1), fogged(5)]);
    const off = planTurn({ graph: g3, board: s3, me: ME, income: 0, settings: STD, options: { goal: 'expand' } });
    expect(off.moves.map((m) => [m.from, m.to, m.kind])).toEqual([
      [1, 2, 'attack'],
      [1, 4, 'transfer'],
    ]);
    const on = planTurn({ graph: g3, board: s3, me: ME, income: 0, settings: NOSPLIT, options: { goal: 'expand' } });
    expect(on.moves.map((m) => [m.from, m.to, m.kind, m.armies])).toEqual([[1, 2, 'attack', 2]]);
    expect(on.warnings.join('\n')).toMatch(
      /No-Split: T1 \(#1\) already attacks T2 \(#2\), so its 7 idle armies are not transferred to T4 \(#4\)/,
    );
  });

  it('(d) a combined (R4) capture is still planned: each source issues one order', () => {
    //   T1 ─ T3 ─ T2
    const g4 = buildGraph(
      makeMap(
        [1, 2, 3],
        [
          [1, 3],
          [2, 3],
        ],
      ),
    );
    const s4 = board([mine(1, 15), mine(2, 15), neutral(3, 15)]);
    const off = planTurn({ graph: g4, board: s4, me: ME, income: 5, settings: STD });
    const on = planTurn({ graph: g4, board: s4, me: ME, income: 5, settings: NOSPLIT });
    expect(attacks(on)).toEqual([
      expect.objectContaining({ from: 2, to: 3, armies: 14 }),
      expect.objectContaining({ from: 1, to: 3, armies: 11 }),
    ]);
    expect(on.moves).toEqual(off.moves);
    expect(on.deploys).toEqual(off.deploys);
    expect(on.multiSourceCaptures).toEqual([3]);
    expect([...perSource(on).values()].every((n) => n === 1)).toBe(true);
  });

  it('a conceded border that already attacked out keeps its remainder (no withdrawal split)', () => {
    // T1 (6) is threatened by a big enemy on T4 and protects nothing: conceded. It
    // completes bonus B60 (+1, T2 alone: a 1-army neutral) with what is on it; the
    // rest would withdraw to T3.
    //   T2 ─ T1 ─ T3,  T1 ─ T4 (enemy 30)
    const g5 = buildGraph(
      makeMap(
        [1, 2, 3, 4],
        [
          [1, 2],
          [1, 3],
          [1, 4],
        ],
        [[60, 1, [2]]],
      ),
    );
    const s5 = board([mine(1, 6), neutral(2, 1), mine(3, 2), enemy(4, 30)]);
    const off = planTurn({ graph: g5, board: s5, me: ME, income: 5, settings: STD });
    expect(off.conceded).toEqual([1]);
    const fromOne = off.moves.filter((m) => m.from === 1).map((m) => m.kind);
    expect(fromOne.sort()).toEqual(['attack', 'transfer']);
    const on = planTurn({ graph: g5, board: s5, me: ME, income: 5, settings: NOSPLIT });
    expect(on.moves.filter((m) => m.from === 1)).toEqual([expect.objectContaining({ to: 2, kind: 'attack' })]);
    expect(on.warnings.join('\n')).toMatch(
      /No-Split: T1 \(#1\) already attacks T2 \(#2\), so its 3 remaining armies are not withdrawn to T3 \(#3\)/,
    );
  });

  it('property: on random boards, flag on → at most one order per source; flag off → identical to absent', () => {
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
      for (let b = 0; b < int(0, 3); b++) {
        const members = ids.filter(() => r() < 0.4);
        if (members.length) bonuses.push([100 + b, int(-1, 5), members]);
      }
      const gr = buildGraph(makeMap(ids, edges, bonuses));
      const entries: TerritoryState[] = ids.map((id) => {
        const k = id === 1 ? 0 : int(0, 4);
        if (k === 0) return mine(id, int(0, 20));
        if (k === 1) return enemy(id, int(1, 12));
        if (k === 2) return fogged(id);
        return neutral(id, int(0, 6));
      });
      const settings: PlannerSettings = { offensiveKillRate: int(20, 100), defensiveKillRate: int(0, 100) };
      const goals = ['expand', 'complete-bonus', 'defend', 'balanced'] as const;
      const input: PlanInput = {
        graph: gr,
        board: board(entries),
        me: ME,
        income: int(0, 12),
        settings,
        options: { goal: goals[int(0, 3)] },
      };
      const ctx = `seed ${seed}`;
      const plain = planTurn(input);
      expect(planTurn({ ...input, settings: { ...settings, noSplit: false } }), ctx).toEqual(plain);
      const p = planTurn({ ...input, settings: { ...settings, noSplit: true } });
      for (const [from, k] of perSource(p)) expect(k, `${ctx} from ${from}`).toBe(1);
      expect(deploySum(p), ctx).toBe(input.income);
    }
  });
});

describe('validateTurn — No-Split (G3)', () => {
  //   T2 ─ T1 ─ T3
  const map = makeMap(
    [1, 2, 3],
    [
      [1, 2],
      [1, 3],
    ],
  );
  const live: LiveTerritory[] = [
    { territoryId: 1, fogLevel: 1, fogged: false, owner: 7, armies: 10 },
    { territoryId: 2, fogLevel: 1, fogged: false, owner: 0, armies: 1 },
    { territoryId: 3, fogLevel: 1, fogged: false, owner: 0, armies: 2 },
  ];
  const T = (id: number) => ({ id, name: `T${id}` });
  const run = (moves: Array<[number, number, number]>, noSplit?: boolean) =>
    validateTurn({
      map,
      board: live,
      myInGameId: 7,
      income: 5,
      guard: true,
      deploys: [{ territory: T(1), armies: 5 }],
      moves: moves.map(([from, to, armies]) => ({ from: T(from), to: T(to), armies })),
      ...(noSplit !== undefined ? { noSplit } : {}),
    });

  it('(e) refuses two AttackTransfers from one source, naming the territory', () => {
    expect(() =>
      run(
        [
          [1, 2, 2],
          [1, 3, 3],
        ],
        true,
      ),
    ).toThrow(/No-Split: T1 \(1\) issues 2 attacks\/transfers \(to T2 \(2\), T3 \(3\)\), but this game allows one per territory/);
  });

  it('(e) accepts one order per source, and splits when the flag is off', () => {
    expect(() => run([[1, 3, 14]], true)).not.toThrow();
    const split: Array<[number, number, number]> = [
      [1, 2, 2],
      [1, 3, 3],
    ];
    expect(() => run(split, false)).not.toThrow();
    expect(() => run(split)).not.toThrow();
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
