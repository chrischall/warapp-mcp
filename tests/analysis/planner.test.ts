import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph, neighborsOf } from '../../src/analysis/graph.js';
import {
  captureCost,
  incomeFor,
  PAYBACK_TURNS,
  planTurn,
  type PlanInput,
  type PlannerSettings,
  type TurnPlan,
} from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral, tinyMap } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

/** Build a map from an edge list and bonuses (`[id, value, territories]`). */
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

const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const deploySum = (p: TurnPlan) => p.deploys.reduce((s, d) => s + d.armies, 0);

describe('captureCost', () => {
  it('is armiesToTake with no luck', () => {
    expect(captureCost(2, STD)).toBe(3);
    expect(captureCost(10, {})).toBe(armiesToTake(10));
  });

  it('adds a luck margin: ceil(cost / (1 - luck))', () => {
    expect(captureCost(2, { ...STD, luckModifier: 0.16 })).toBe(4);
    // A percentage is accepted too.
    expect(captureCost(2, { ...STD, luckModifier: 16 })).toBe(4);
    expect(captureCost(0, { ...STD, luckModifier: 0.5 })).toBe(2);
  });

  it('is null when attackers cannot kill', () => {
    expect(captureCost(2, { offensiveKillRate: 0 })).toBeNull();
  });
});

describe('incomeFor', () => {
  it('uses the existing income code', () => {
    const g = buildGraph(tinyMap());
    const s = board([mine(1, 2), mine(2, 2), mine(3, 2)]);
    expect(incomeFor(g, s, ME)).toBe(5 + 3);
    expect(incomeFor(g, s, ME, { cards: [], raw: {}, minimumArmyBonus: 2 })).toBe(2 + 3);
  });
});

describe('planTurn — opening', () => {
  // Three starts (1, 10, 20) with 4 armies each; every other territory is a
  // 2-army neutral. X (value 3) is the best bonus by value per capture cost.
  // Y and Z each have a territory (13, 23) out of reach, so neither can be
  // completed this turn.
  //   X (3): 1 2 3 4     Y (1): 10 11 12 13     Z (1): 20 21 22 23
  const map = makeMap(
    [1, 2, 3, 4, 10, 11, 12, 13, 20, 21, 22, 23],
    [
      [1, 2],
      [1, 3],
      [1, 4],
      [2, 3],
      [10, 11],
      [10, 12],
      [20, 21],
      [20, 22],
      [21, 4],
      [22, 12],
      [12, 13],
      [22, 23],
    ],
    [
      [101, 3, [1, 2, 3, 4]],
      [102, 1, [10, 11, 12, 13]],
      [103, 1, [20, 21, 22, 23]],
    ],
  );
  const g = buildGraph(map);
  const state = board([
    mine(1, 4),
    mine(10, 4),
    mine(20, 4),
    ...[2, 3, 4, 11, 12, 13, 21, 22, 23].map((id) => neutral(id, 2)),
  ]);
  const input: PlanInput = { graph: g, board: state, me: ME, income: 5, settings: STD };

  it('deploys 5 to the start in the best bonus and makes the 3-army captures that fit', () => {
    const p = planTurn(input);
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 5 }]);
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([
      [1, 2, 3],
      [1, 3, 3],
      [10, 11, 3],
      [20, 21, 3],
    ]);
    expect(p.expected.captures).toEqual([2, 3, 11, 21]);
    expect(p.expected.bonusesCompleted).toEqual([]);
    expect(p.expected.nextIncome).toBe(5);
    expect(p.rationale.length).toBeGreaterThan(0);
    for (const m of p.moves) expect(m.reason).toBeTruthy();
  });

  it('never leaves a capture under-armed', () => {
    for (const m of attacks(planTurn(input))) expect(m.armies).toBeGreaterThanOrEqual(armiesToTake(2)!);
  });

  it('is deterministic', () => {
    expect(planTurn(input)).toEqual(planTurn(input));
    const shuffled = board([...state.territories].reverse());
    expect(planTurn({ ...input, board: shuffled })).toEqual(planTurn(input));
  });

  it('holds back a reserve from captures but still deploys it', () => {
    const p = planTurn({ ...input, options: { reserve: 3 } });
    expect(deploySum(p)).toBe(5);
    expect(attacks(p).map((m) => m.to)).toEqual([2, 11, 21]);
    expect(p.rationale.join(' ')).toMatch(/reserve/i);
  });

  it('warns that luck adds margins', () => {
    const p = planTurn({ ...input, settings: { ...STD, luckModifier: 0.16 } });
    expect(p.warnings.join(' ')).toMatch(/luck/i);
    for (const m of attacks(p)) expect(m.armies).toBe(4);
  });

  it('warns about non-straight rounding and an unverified board', () => {
    const p = planTurn({ ...input, settings: { ...STD, roundingMode: 'WeightedRandom' } });
    const text = p.warnings.join(' ');
    expect(text).toMatch(/WeightedRandom/);
    expect(text).toMatch(/unverified/i);
    const v = planTurn({ ...input, board: board(state.territories, true) });
    expect(v.warnings).toEqual([]);
  });
});

describe('planTurn — bonus focus', () => {
  // P (1): 1 2 — one capture from done. Q (10): 4 5 — better value per cost,
  // but 5 is not reachable this turn.
  const g = buildGraph(
    makeMap(
      [1, 2, 4, 5],
      [
        [1, 2],
        [1, 4],
        [4, 5],
      ],
      [
        [201, 1, [1, 2]],
        [202, 10, [4, 5]],
      ],
    ),
  );
  const state = board([mine(1, 1), neutral(2, 2), neutral(4, 2), neutral(5, 2)]);

  it('completes a bonus one capture from done before other expansion', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 3, settings: STD });
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 3 }]);
    expect(attacks(p).map((m) => m.to)).toEqual([2]);
    expect(p.expected.bonusesCompleted).toEqual([201]);
    expect(p.expected.nextIncome).toBe(4);
  });

  it('expands toward the better bonus when nothing can be completed', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 1), neutral(2, 5), neutral(4, 2), neutral(5, 2)]), me: ME, income: 3, settings: STD });
    expect(attacks(p).map((m) => m.to)).toEqual([4]);
  });

  it('puts focused bonuses first', () => {
    const p = planTurn({
      graph: g,
      board: board([mine(1, 1), neutral(2, 5), neutral(4, 2), neutral(5, 2)]),
      me: ME,
      income: 8,
      settings: STD,
      options: { focusBonusIds: [201] },
    });
    expect(attacks(p)[0]!.to).toBe(2);
  });

  it('breaks value-per-cost ties by fewest external borders', () => {
    // Two value-1 bonuses at equal cost; R has 2 borders, S has 1.
    const tg = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5, 6],
        [
          [1, 2],
          [1, 4],
          [2, 3],
          [4, 5],
          [3, 6],
        ],
        [
          [301, 1, [2, 3]],
          [302, 1, [4, 5]],
        ],
      ),
    );
    const s = board([mine(1, 4), neutral(2, 2), neutral(3, 2), neutral(4, 2), neutral(5, 2), neutral(6, 2)]);
    const p = planTurn({ graph: tg, board: s, me: ME, income: 0, settings: STD });
    expect(attacks(p).map((m) => m.to)).toEqual([4]);
  });
});

describe('planTurn — targets', () => {
  // W (2): 2 3 with a 10-army wasteland on 2. V (1): 4.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4],
      [
        [1, 2],
        [1, 3],
        [1, 4],
      ],
      [
        [401, 2, [2, 3]],
        [402, 1, [4]],
      ],
    ),
  );
  const state = board([mine(1, 5), neutral(2, 10), neutral(3, 2), neutral(4, 2)]);

  it('avoids a bonus made uneconomic by a wasteland', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 20, settings: STD });
    expect(attacks(p).map((m) => m.to)).toEqual([4]);
    expect(p.rationale.join(' ')).toMatch(/uneconomic/i);
    expect(PAYBACK_TURNS).toBeGreaterThan(0);
  });

  it('plans into it when focusBonusIds asks', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 20, settings: STD, options: { focusBonusIds: [401] } });
    expect(attacks(p).map((m) => [m.to, m.armies])).toEqual([
      [3, 3],
      [2, 16],
      [4, 3],
    ]);
    expect(p.expected.bonusesCompleted).toEqual([401, 402]);
  });

  it('warns about a fogged target instead of attacking it', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 5), fogged(2), neutral(3, 2), neutral(4, 2)]), me: ME, income: 0, settings: STD });
    expect(p.moves.some((m) => m.to === 2)).toBe(false);
    expect(p.warnings.join(' ')).toMatch(/T2 \(#2\).*fog/i);
  });

  it('treats territories missing from the board as fogged', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 5), neutral(3, 2), neutral(4, 2)]), me: ME, income: 0, settings: STD });
    expect(p.moves.some((m) => m.to === 2)).toBe(false);
    expect(p.warnings.join(' ')).toMatch(/T2/);
  });

  it('attacks visible enemies only under complete-bonus', () => {
    const s = board([mine(1, 9), neutral(2, 10), neutral(3, 2), enemy(4, 2)]);
    const expand = planTurn({ graph: g, board: s, me: ME, income: 0, settings: STD });
    expect(expand.moves.some((m) => m.to === 4)).toBe(false);
    const complete = planTurn({ graph: g, board: s, me: ME, income: 0, settings: STD, options: { goal: 'complete-bonus' } });
    expect(attacks(complete).map((m) => m.to)).toEqual([4]);
    expect(complete.warnings.join(' ')).toMatch(/enemy/i);
  });

  it('never targets territories still up for distribution', () => {
    const s = board([mine(1, 9), neutral(2, 10), neutral(3, 2), { territoryId: 4, owner: { kind: 'available' }, armies: 2 }]);
    expect(planTurn({ graph: g, board: s, me: ME, income: 0, settings: STD }).moves.some((m) => m.to === 4)).toBe(false);
  });

  it('skips targets that cannot be killed', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 5, settings: { ...STD, offensiveKillRate: 0 } });
    expect(attacks(p)).toEqual([]);
    expect(deploySum(p)).toBe(5);
  });

  it('focus decides between bonuses neither of which completes this turn', () => {
    // X (+1): 2, 3   Y (+5): 4, 5 — 3 and 5 are out of reach, and 4 armies fund one capture.
    const fg = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5],
        [
          [1, 2],
          [2, 3],
          [1, 4],
          [4, 5],
        ],
        [
          [601, 1, [2, 3]],
          [602, 5, [4, 5]],
        ],
      ),
    );
    const s = board([mine(1, 4), neutral(2, 2), neutral(3, 2), neutral(4, 2), neutral(5, 2)]);
    const plain = planTurn({ graph: fg, board: s, me: ME, income: 0, settings: STD });
    expect(attacks(plain).map((m) => m.to)).toEqual([4]);
    const focused = planTurn({ graph: fg, board: s, me: ME, income: 0, settings: STD, options: { focusBonusIds: [601] } });
    expect(attacks(focused).map((m) => m.to)).toEqual([2]);
  });

  it('never transfers into a territory that is only being captured this turn', () => {
    // 1 (3 armies) and 2 (4) both border neutral 3; 3 borders fogged 4. 2 takes 3, and
    // 1's only route forward is through 3 — which I do not own yet, so no transfer.
    const tg = buildGraph(
      makeMap(
        [1, 2, 3, 4],
        [
          [1, 3],
          [2, 3],
          [3, 4],
        ],
        [],
      ),
    );
    const p = planTurn({ graph: tg, board: board([mine(1, 3), mine(2, 4), neutral(3, 2), fogged(4)]), me: ME, income: 0, settings: STD });
    expect(attacks(p).map((m) => [m.from, m.to])).toEqual([[2, 3]]);
    expect(p.moves.filter((m) => m.kind === 'transfer')).toEqual([]);
  });

  it('never completes a negative-value bonus unless focused', () => {
    // 2 is the lone member of a -1 bonus: taking it would lower income.
    const ng = buildGraph(makeMap([1, 2], [[1, 2]], [[501, -1, [2]]]));
    const s = board([mine(1, 4), neutral(2, 2)]);
    const p = planTurn({ graph: ng, board: s, me: ME, income: 5, settings: STD });
    expect(p.moves.some((m) => m.to === 2)).toBe(false);
    expect(p.expected.nextIncome).toBeGreaterThanOrEqual(5);
    const focused = planTurn({ graph: ng, board: s, me: ME, income: 5, settings: STD, options: { focusBonusIds: [501] } });
    expect(attacks(focused).map((m) => m.to)).toEqual([2]);
  });

  it('expands into territories outside any bonus', () => {
    const lg = buildGraph(makeMap([1, 2], [[1, 2]], []));
    const p = planTurn({ graph: lg, board: board([mine(1, 4), neutral(2, 2)]), me: ME, income: 0, settings: STD });
    expect(attacks(p).map((m) => m.to)).toEqual([2]);
  });

  it('warns when I own nothing', () => {
    const p = planTurn({ graph: g, board: board([neutral(2, 2)]), me: ME, income: 5, settings: STD });
    expect(p.deploys).toEqual([]);
    expect(p.warnings.join(' ')).toMatch(/no territor/i);
  });
});

describe('planTurn — defence', () => {
  // 1 is my 2-army border next to a 6-army enemy on 2; 3 is a 2-army neutral.
  const g = buildGraph(
    makeMap(
      [1, 2, 3],
      [
        [1, 2],
        [1, 3],
      ],
      [[501, 1, [3]]],
    ),
  );
  const state = board([mine(1, 2), enemy(2, 6), neutral(3, 2)]);

  it('warns that the border could fall next turn', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 5, settings: STD });
    expect(p.warnings.join(' ')).toMatch(/T1 \(#1\).*could be taken/);
    // Expansion goes ahead; leftover lands on the exposed border.
    expect(attacks(p).map((m) => m.to)).toEqual([3]);
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 5 }]);
  });

  it('under defend, deploys so the border holds before expanding', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 5 }]);
    expect(p.moves).toEqual([]);
    // 7 armies need 11 to take; the enemy has 5 movable + ~5 deploy = 10.
    expect(armiesToTake(7)).toBeGreaterThan(5 + 5);
    expect(p.rationale.join(' ')).toMatch(/hold/i);
  });

  it('warns when the border cannot be held with this income', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 2), enemy(2, 30), neutral(3, 2)]), me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
    expect(p.warnings.join(' ')).toMatch(/cannot be held/);
    expect(deploySum(p)).toBe(5);
  });

  it('respects a custom enemy deploy estimate', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 5, settings: STD, options: { goal: 'defend', enemyDeploy: 0 } });
    // Threat 5: 2 armies need 3, so deploy 2 (4 armies need 6 > 5).
    expect(p.deploys[0]).toEqual({ territoryId: 1, armies: 5 });
    expect(p.rationale.join(' ')).toMatch(/Deploy 2 to T1/);
  });

  it('sends leftover to the territory with the most fogged neighbours when no enemy is visible', () => {
    const fg = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5],
        [
          [1, 2],
          [2, 3],
          [2, 4],
          [1, 5],
        ],
        [],
      ),
    );
    const p = planTurn({ graph: fg, board: board([mine(1, 1), mine(2, 1), fogged(3), fogged(4), fogged(5)]), me: ME, income: 4, settings: STD });
    expect(p.deploys).toEqual([{ territoryId: 2, armies: 4 }]);
  });
});

describe('planTurn — transfers', () => {
  // 1 is interior (only next to my 2); 2 borders neutral 3 (wasteland).
  const g = buildGraph(
    makeMap(
      [1, 2, 3],
      [
        [1, 2],
        [2, 3],
      ],
      [[601, 1, [3]]],
    ),
  );
  const state = board([mine(1, 6), mine(2, 1), neutral(3, 30)]);

  it('moves idle interior armies to the front', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 0, settings: STD });
    expect(p.moves).toEqual([expect.objectContaining({ from: 1, to: 2, armies: 5, kind: 'transfer' })]);
  });

  it('does not transfer when transfer-only orders are off', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 0, settings: { ...STD, allowTransferOnly: false } });
    expect(p.moves).toEqual([]);
  });

  it('keeps no guard when one-army-stands-guard is off', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 0, settings: { ...STD, oneArmyStandsGuard: false } });
    expect(p.moves[0]!.armies).toBe(6);
  });

  it('notes that multi-attack chains are not planned', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 0, settings: { ...STD, multiAttack: true } });
    expect(p.rationale.join(' ')).toMatch(/multi-attack/i);
  });
});

// ---- property test: accounting over random small boards ----

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

describe('planTurn — accounting property', () => {
  it('deploys exactly the income, never over-commits, and arms every attack', () => {
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
      const g = buildGraph(makeMap(ids, edges, bonuses));
      const entries: TerritoryState[] = ids.map((id) => {
        const k = id === 1 ? 0 : int(0, 4);
        if (k === 0) return mine(id, int(0, 8));
        if (k === 1) return enemy(id, int(1, 12));
        if (k === 2) return fogged(id);
        return neutral(id, int(0, 12));
      });
      const settings: PlannerSettings = {
        offensiveKillRate: int(40, 100),
        defensiveKillRate: int(0, 100),
        luckModifier: r() < 0.3 ? 0.16 : 0,
        oneArmyStandsGuard: r() < 0.8,
        multiAttack: r() < 0.3,
        allowTransferOnly: r() < 0.8,
      };
      const goals = ['expand', 'complete-bonus', 'defend'] as const;
      const input: PlanInput = {
        graph: g,
        board: board(entries),
        me: ME,
        income: int(0, 12),
        settings,
        options: { goal: goals[int(0, 2)], reserve: int(0, 3) },
      };
      const p = planTurn(input);
      const ctx = `seed ${seed}`;
      expect(planTurn(input), ctx).toEqual(p);

      const byId = new Map(entries.map((e) => [e.territoryId, e]));
      const isMine = (id: number) => byId.get(id)?.owner.kind === 'player' && (byId.get(id)!.owner as { playerId: number }).playerId === ME;
      expect(deploySum(p), ctx).toBe(input.income);
      for (const d of p.deploys) expect(isMine(d.territoryId), ctx).toBe(true);

      const guard = settings.oneArmyStandsGuard ? 1 : 0;
      const out = new Map<number, number>();
      const captured = new Set<number>();
      for (const m of p.moves) {
        expect(neighborsOf(g, m.from), ctx).toContain(m.to);
        expect(isMine(m.from), ctx).toBe(true); // nothing moves out of a fresh capture
        expect(m.armies, ctx).toBeGreaterThan(0);
        out.set(m.from, (out.get(m.from) ?? 0) + m.armies);
        if (m.kind === 'attack') {
          const t = byId.get(m.to)!;
          expect(t.armies, ctx).not.toBeNull();
          expect(isMine(m.to), ctx).toBe(false);
          expect(m.armies, ctx).toBeGreaterThanOrEqual(captureCost(t.armies!, settings)!);
          expect(captured.has(m.to), ctx).toBe(false);
          captured.add(m.to);
        } else {
          expect(isMine(m.to) || captured.has(m.to), ctx).toBe(true);
        }
      }
      for (const [from, n] of out) {
        const dep = p.deploys.find((d) => d.territoryId === from)?.armies ?? 0;
        expect(n, ctx).toBeLessThanOrEqual(byId.get(from)!.armies! + dep - guard);
      }
      expect(p.expected.captures, ctx).toEqual([...captured].sort((a, b) => a - b));
    }
  });
});
