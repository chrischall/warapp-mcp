import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import type { GameMap } from '../../src/normalize.js';
import { mapNotes, mapNotesMarkdown } from '../../src/strategy/map-notes.js';
import { OVERRIDES_UNPARSED } from '../../src/analysis/overrides.js';
import { normalizeMap } from '../../src/normalize.js';
import { lobbyFixture } from '../helpers.js';

/**
 * A line 1 ─ 2 ─ … ─ 8 with three bonuses:
 * Alpha (+3) = 1, 2; Bravo (+2) = 3, 4, 5; Charlie (+5) = 6, 7, 8; and a zero bonus Delta = 4.
 */
const MAP: GameMap = {
  id: 77,
  name: 'Test Line',
  territories: Array.from({ length: 8 }, (_, i) => i + 1).map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: [id - 1, id + 1].filter((x) => x >= 1 && x <= 8),
  })),
  bonuses: [
    { id: 1, name: 'Alpha', value: 3, territoryIds: [1, 2], bonusIds: [] },
    { id: 2, name: 'Bravo', value: 2, territoryIds: [3, 4, 5], bonusIds: [] },
    { id: 3, name: 'Charlie', value: 5, territoryIds: [6, 7, 8], bonusIds: [] },
    { id: 4, name: 'Delta', value: 0, territoryIds: [4], bonusIds: [] },
  ],
  distributionModes: [],
};
const graph = buildGraph(MAP);

describe('mapNotes: bonuses by efficiency', () => {
  it('ranks positive bonuses by value per army to take at the default settings (neutrals of 2 cost 3 each)', () => {
    const n = mapNotes({ graph });
    expect(n.bonuses.map((b) => b.name)).toEqual(['Charlie', 'Alpha', 'Bravo']);
    const charlie = n.bonuses[0]!;
    expect(charlie).toMatchObject({ bonusId: 3, value: 5, territories: 3, armiesToTake: 9, entryPoints: [{ id: 5, name: 'T5' }] });
    expect(charlie.valuePerArmy).toBeCloseTo(0.56, 2);
    const alpha = n.bonuses[1]!;
    expect(alpha.armiesToTake).toBe(6);
    expect(alpha.valuePerArmy).toBe(0.5);
    expect(n.bonuses[2]!.entryPoints.map((e) => e.id)).toEqual([2, 6]);
    expect(n.assumptions.join(' ')).toMatch(/neutral/i);
  });

  it('costs captures at the game settings: bigger neutrals and harsher kill rates', () => {
    const n = mapNotes({ graph, settings: { initialNonDistributionArmies: 4, offensiveKillRate: 60, defensiveKillRate: 70 } });
    // 4 defenders: 6 attackers kill round(3.6) = 4 and lose round(2.8) = 3.
    expect(n.bonuses.find((b) => b.name === 'Alpha')!.armiesToTake).toBe(12);
  });

  it('honours limit', () => {
    expect(mapNotes({ graph, limit: 2 }).bonuses).toHaveLength(2);
  });

  it('says when the game overrides bonus values that could not be read', () => {
    expect(mapNotes({ graph }).assumptions).not.toContain(OVERRIDES_UNPARSED);
    expect(mapNotes({ graph, overridesUnparsed: true }).assumptions).toContain(OVERRIDES_UNPARSED);
  });
});

describe('mapNotes: double borders (#166)', () => {
  // Pair (+3) = 1, 2. Territory 3 borders both of them, territory 4 only the second.
  const map: GameMap = {
    id: 78,
    name: 'Test Wedge',
    territories: [
      { id: 1, name: 'T1', connectedTo: [2, 3] },
      { id: 2, name: 'T2', connectedTo: [1, 3, 4] },
      { id: 3, name: 'T3', connectedTo: [1, 2] },
      { id: 4, name: 'T4', connectedTo: [2] },
    ],
    bonuses: [{ id: 1, name: 'Pair', value: 3, territoryIds: [1, 2], bonusIds: [] }],
    distributionModes: [],
  };

  it('lists the entry points that border two or more of the bonus’s territories', () => {
    const n = mapNotes({ graph: buildGraph(map) });
    const pair = n.bonuses[0]!;
    expect(pair.entryPoints.map((e) => e.id)).toEqual([3, 4]);
    expect(pair.doubleBorders).toEqual([{ id: 3, name: 'T3', touches: 2 }]);
    expect(mapNotesMarkdown(map.name, n)).toContain('entry points: T3 (a double border: next to 2 of its territories), T4');
  });

  it('is empty for a bonus without one, and the markdown is what it was', () => {
    const n = mapNotes({ graph });
    for (const b of n.bonuses) expect(b.doubleBorders).toEqual([]);
    expect(mapNotesMarkdown(MAP.name, n)).toContain('0.56 per army; entry points: T5\n');
  });
});

describe('mapNotes: chokepoints', () => {
  it('lists the territories that cut the map, with the bonuses they join', () => {
    const n = mapNotes({ graph });
    const ids = n.chokepoints.map((c) => c.territoryId);
    expect(ids).toEqual(expect.arrayContaining([2, 3, 5, 6]));
    const five = n.chokepoints.find((c) => c.territoryId === 5)!;
    expect(five.name).toBe('T5');
    expect(five.connects).toContain('Charlie');
  });

  it('limit caps the chokepoint rows too', () => {
    expect(mapNotes({ graph }).chokepoints.length).toBeGreaterThan(2);
    expect(mapNotes({ graph, limit: 2 }).chokepoints).toHaveLength(2);
  });
});

describe('mapNotes: income targets from the opening simulation', () => {
  it('absent without an opening to simulate', () => {
    expect(mapNotes({ graph }).incomeTargets).toBeUndefined();
  });

  it('with an opening: income by turn, never falling, from the base income up', () => {
    const n = mapNotes({
      graph,
      settings: { minimumArmyBonus: 5 },
      opening: { players: 2, territoryLimit: 2, pickable: [1, 2, 3, 4, 5, 6, 7, 8] },
    });
    const t = n.incomeTargets!;
    expect(t.map((x) => x.turn)).toEqual([1, 2, 3, 4]);
    expect(t[0]!.income).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < t.length; i++) expect(t[i]!.income).toBeGreaterThanOrEqual(t[i - 1]!.income);
    expect(t.at(-1)!.income).toBeGreaterThan(5);
    const named = new Set(MAP.bonuses.map((b) => b.name));
    for (const x of t) for (const b of x.bonuses) expect(named.has(b)).toBe(true);
  });
});

describe('mapNotes: income targets come only from territories that can be picked (#132)', () => {
  it('without the pickable territories there are no targets, and the assumptions say why', () => {
    const n = mapNotes({ graph, settings: { minimumArmyBonus: 5 }, opening: { players: 2, territoryLimit: 2 } });
    expect(n.incomeTargets).toBeUndefined();
    expect(n.assumptions.join(' ')).toMatch(/pickable territories.*warapp_plan_picks/i);
  });

  it('a start nobody can pick does not set the pace: only the pickables are simulated', () => {
    // Charlie (+5, 6-8) is the best start when 7 and 8 can be picked; here only Alpha's side can.
    // (Before #166 the comparison had all eight pickable. A bonus is now credited by who can
    // reach it, and with every territory pickable an opponent may start inside Charlie, so the
    // advisor starts on Alpha there too.)
    const all = mapNotes({
      graph,
      settings: { minimumArmyBonus: 5 },
      opening: { players: 2, territoryLimit: 2, pickable: [1, 2, 7, 8] },
    });
    expect(all.incomeTargets![1]!.bonuses).toContain('Charlie');
    const live = mapNotes({
      graph,
      settings: { minimumArmyBonus: 5 },
      opening: { players: 2, territoryLimit: 2, pickable: [1, 2] },
    });
    for (const t of live.incomeTargets!) expect(t.bonuses).not.toContain('Charlie');
    expect(live.incomeTargets![1]!.bonuses).toEqual(['Alpha']);
    expect(live.assumptions.join(' ')).toMatch(/2 territories the game lists as pickable/);
  });

  it('a 1v1 on a large map is quick: only the primary group is searched', () => {
    const map = normalizeMap(lobbyFixture().map);
    const big = buildGraph(map);
    const pickable = map.territories.map((t) => t.id);
    const start = performance.now();
    const n = mapNotes({ graph: big, opening: { players: 2, territoryLimit: 3, pickable } });
    // The fallback search behind it took ~6-10 s here; the primary alone takes well under one.
    expect(performance.now() - start).toBeLessThan(3000);
    expect(n.incomeTargets).toHaveLength(4);
  }, 30_000);
});

describe('mapNotesMarkdown', () => {
  it('renders the ranked bonuses and chokepoints', () => {
    const md = mapNotesMarkdown(MAP.name, mapNotes({ graph }));
    expect(md).toContain('Charlie');
    expect(md).toContain('T5');
    expect(md).toMatch(/^# /m);
  });
});
