// #593 (item 4): never advance a bonus whose other member this same plan concedes. A capture that adds to a bonus
// without completing it is refused while the plan concedes another member of that bonus I hold, and its armies are
// left to the plan's other orders. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { straightKills } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlanOptions } from '../../src/analysis/planner.js';
import { deadAdvanceLine, deadAdvanceOf } from '../../src/analysis/plan/dead-advance.js';
import type { GameMap } from '../../src/normalize.js';
import { syntheticInput, SYNTHETIC_COUNT } from './golden/corpus.js';
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

// My border T1 (2 armies) faces player 20's 30 on T7: it is conceded. My interior T2 (10) borders T3, a 2-army
// neutral of B901 (+4: T1, T2, T3, T4 — T4 one step further), and T5, a 2-army neutral of B902 (+3: T5, T6).
const EDGES: [number, number][] = [
  [1, 7],
  [7, 8],
  [1, 2],
  [2, 3],
  [3, 4],
  [2, 5],
  [5, 6],
];
const g = buildGraph(
  makeMap(
    [1, 2, 3, 4, 5, 6, 7, 8],
    EDGES,
    [
      [901, 4, [1, 2, 3, 4]],
      [902, 3, [5, 6]],
    ],
  ),
);
const input = (threat: number, options: PlanOptions = {}, extra: Partial<PlanInput> = {}, gate = 2): PlanInput => ({
  graph: g,
  board: board([mine(1, gate), mine(2, 10), neutral(3, 2), neutral(4, 2), neutral(5, 2), neutral(6, 4), enemy(7, threat), enemy(8, 3)]),
  me: ME,
  income: 5,
  settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
  game: { players: [{ id: ME }, { id: 20 }], turn: 6 },
  options: { adapt: true, enemyDeploy: 5, ...options },
  ...extra,
});
const attacksOn = (p: ReturnType<typeof planTurn>, t: number) => p.moves.filter((m) => m.kind === 'attack' && m.to === t);

describe('#593: no advance into a bonus the same plan concedes a member of', () => {
  it('the advance is refused, named in the rationale, and the other bonus is still advanced', () => {
    const p = planTurn(input(30));
    expect(p.conceded).toContain(1);
    expect(attacksOn(p, 3)).toEqual([]);
    expect(p.rationale).toContain(
      "Do not take T3 (#3) toward bonus B901 (#901): this plan concedes its member T1 (#1), so the capture builds a bonus this turn gives up: its armies are left to the plan's other orders (#593).",
    );
    expect(attacksOn(p, 5)).toHaveLength(1);
  });

  it('with the member held, the advance stands', () => {
    const p = planTurn(input(2, {}, {}, 20));
    expect(p.conceded).not.toContain(1);
    expect(attacksOn(p, 3).length).toBeGreaterThan(0);
    expect(p.rationale.join('\n')).not.toMatch(/#593/);
  });

  it('a focused bonus is advanced all the same', () => {
    const p = planTurn(input(30, { focusBonusIds: [901] }));
    expect(attacksOn(p, 3).length).toBeGreaterThan(0);
    expect(p.rationale.join('\n')).not.toMatch(/#593/);
  });

  it('a bonus an earlier plan of this turn found dead (`deadAdvance`) is refused from the start, said as carried', () => {
    // The member is held here (threat 2), so only the carried set refuses the advance.
    const p = planTurn(input(2, {}, { deadAdvance: new Map([[901, [1]]]) }, 20));
    expect(attacksOn(p, 3)).toEqual([]);
    expect(p.rationale).toContain(
      "Do not take T3 (#3) toward bonus B901 (#901): the plan that took it conceded its member T1 (#1), so the capture builds a bonus this turn gives up: its armies are left to the plan's other orders (#593).",
    );
  });

  it('a capture that completes the bonus is no advance', () => {
    // B903 (+4) is T1, T2 and T3 only: taking T3 completes it, and rule 1c keeps the conceded T1 (#18).
    const g3 = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5, 6, 7, 8],
        EDGES,
        [
          [903, 4, [1, 2, 3]],
          [902, 3, [5, 6]],
        ],
      ),
    );
    const p = planTurn({ ...input(30), graph: g3 });
    expect(attacksOn(p, 3).length).toBeGreaterThan(0);
    expect(p.rationale.join('\n')).not.toMatch(/#593/);
  });
});

describe('#593: deadAdvanceOf', () => {
  const gx = buildGraph(
    makeMap(
      [1, 2, 3, 4],
      [
        [1, 2],
        [2, 3],
        [3, 4],
      ],
      [
        [1, 4, [1, 2, 3]],
        [2, 2, [3, 4]],
        [3, -2, [3]],
      ],
    ),
  );
  const state = new Map<number, TerritoryState>([
    [1, mine(1, 2)],
    [2, mine(2, 2)],
    [3, neutral(3, 2)],
    [4, mine(4, 2)],
  ]);
  const bonusTs = new Map(gx.map.bonuses.map((b) => [b.id, b.territoryIds] as const));
  const bonusesWith = new Map<number, number[]>();
  for (const b of gx.map.bonuses) for (const t of b.territoryIds) bonusesWith.set(t, [...(bonusesWith.get(t) ?? []), b.id]);
  const pc = (focus: number[] = []) => ({
    g: gx,
    territories: state,
    mineSet: new Set([1, 2, 4]),
    bonusTs,
    bonusesWith,
    inFocus: (t: number) => focus.includes(t),
    vacated: new Map<number, number>(),
    foe: (p: number) => p !== ME,
  });
  const held = new Set([1, 2, 4]);

  // `held` is what I hold once this turn's captures land: T1 alone, so no capture of T3 completes B1 or B2.
  it('null while another positive bonus the capture advances keeps every member', () => {
    // T3 is in B1 (T1 conceded) and B2 (T4 held, not conceded): it still advances B2. The negative B3 does not count.
    expect(deadAdvanceOf(pc(), 3, new Set([1]), new Set([1]), new Map())).toBeNull();
  });

  it('every positive bonus dead: each named with its conceded members', () => {
    expect(deadAdvanceOf(pc(), 3, new Set([1]), new Set([1, 4]), new Map())).toEqual([
      { bonusId: 1, members: [1], carried: false },
      { bonusId: 2, members: [4], carried: false },
    ]);
  });

  it('completing any bonus it is in, focused, or already mine: null', () => {
    expect(deadAdvanceOf(pc(), 3, held, new Set([1, 4]), new Map())).toBeNull();
    expect(deadAdvanceOf(pc([3]), 3, new Set([1]), new Set([1, 4]), new Map())).toBeNull();
    expect(deadAdvanceOf(pc(), 2, new Set([1]), new Set([1]), new Map())).toBeNull();
  });

  it('a carried bonus counts dead with its earlier members', () => {
    expect(deadAdvanceOf(pc(), 3, new Set([1]), new Set([4]), new Map([[1, [1]]]))).toEqual([
      { bonusId: 1, members: [1], carried: true },
      { bonusId: 2, members: [4], carried: false },
    ]);
    expect(
      deadAdvanceLine({ label: (id) => `T${id} (#${id})`, bonusName: (id) => `B${id} (#${id})` }, 3, { bonusId: 1, members: [1, 2], carried: true }),
    ).toBe(
      "Do not take T3 (#3) toward bonus B1 (#1): the plan that took it conceded its members T1 (#1), T2 (#2), so the capture builds a bonus this turn gives up: its armies are left to the plan's other orders (#593).",
    );
  });
});

describe('#593: no finished plan advances a bonus it concedes a member of (golden synthetic boards)', () => {
  it('every 10th synthetic board', () => {
    const bad: string[] = [];
    for (let i = 0; i < SYNTHETIC_COUNT; i += 10) {
      const inp = syntheticInput(i);
      const p = planTurn(inp);
      const conceded = new Set(p.conceded);
      const start = new Map(inp.board.territories.map((t) => [t.territoryId, t]));
      const mineAt = new Set(inp.board.territories.filter((t) => t.owner.kind === 'player' && t.owner.playerId === inp.me).map((t) => t.territoryId));
      const after = new Set([...mineAt, ...p.expected.captures]);
      for (const m of p.moves) {
        if (m.kind !== 'attack' || !/^(advances bonus|expands territory)/.test(m.reason) || !p.expected.captures.includes(m.to)) continue;
        const st = start.get(m.to);
        if (st?.owner.kind !== 'neutral' || conceded.has(m.from)) continue;
        // A no-loss capture (#426: its defenders kill none of the attackers) is exempt.
        if (straightKills(st.armies ?? 0, inp.settings?.defensiveKillRate ?? 70) === 0) continue;
        const bonuses = inp.graph.map.bonuses.filter((b) => b.value > 0 && b.territoryIds.includes(m.to));
        if (!bonuses.length || bonuses.some((b) => b.territoryIds.every((t) => after.has(t)))) continue;
        if (bonuses.every((b) => b.territoryIds.some((t) => t !== m.to && mineAt.has(t) && conceded.has(t)))) bad.push(`s${i}: #${m.to}`);
      }
    }
    expect(bad).toEqual([]);
  }, 120_000);
});

describe('#593 (owner, 2026-11-27): an advance that breaks the bonus for the opponent attacking the conceded member is allowed', () => {
  // B5 (+4) is T1 – T2 – T3 in a line. My T1 is conceded to player 20's stack on T6 (beside T1 only); T3 does not border T1.
  const gx = buildGraph(
    makeMap(
      [1, 2, 3, 6, 7],
      [
        [1, 2],
        [2, 3],
        [1, 6],
        [3, 7],
      ],
      [[5, 4, [1, 2, 3]]],
    ),
  );
  const bonusTs = new Map(gx.map.bonuses.map((b) => [b.id, b.territoryIds] as const));
  const bonusesWith = new Map<number, number[]>([
    [1, [5]],
    [2, [5]],
    [3, [5]],
  ]);
  const pcOf = (state: Map<number, TerritoryState>) => ({
    g: gx,
    territories: state,
    mineSet: new Set([1, 7]),
    bonusTs,
    bonusesWith,
    inFocus: () => false,
    vacated: new Map<number, number>(),
    foe: (p: number) => p !== ME,
  });
  const base = (t2: TerritoryState, t3: TerritoryState) =>
    new Map<number, TerritoryState>([
      [1, mine(1, 2)],
      [2, t2],
      [3, t3],
      [6, enemy(6, 30)],
      [7, mine(7, 10)],
    ]);

  it('taking the attacker\'s own member of the bonus breaks his hold on it: allowed', () => {
    expect(deadAdvanceOf(pcOf(base(neutral(2, 2), enemy(3, 2))), 3, new Set([1, 7]), new Set([1]), new Map())).toBeNull();
  });

  it('taking the one member he would still lack once my conceded member falls keeps him from completing it: allowed', () => {
    expect(deadAdvanceOf(pcOf(base(enemy(2, 2), neutral(3, 2))), 3, new Set([1, 7]), new Set([1]), new Map())).toBeNull();
  });

  it('a neutral when he would still lack another member, or a member of a player not attacking it: still refused', () => {
    expect(deadAdvanceOf(pcOf(base(neutral(2, 2), neutral(3, 2))), 3, new Set([1, 7]), new Set([1]), new Map())).toEqual([
      { bonusId: 5, members: [1], carried: false },
    ]);
    expect(deadAdvanceOf(pcOf(base(neutral(2, 2), enemy(3, 2, 30))), 3, new Set([1, 7]), new Set([1]), new Map())).toEqual([
      { bonusId: 5, members: [1], carried: false },
    ]);
  });
});
