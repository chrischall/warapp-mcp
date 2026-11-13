import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import type { GameMap } from '../../src/normalize.js';
import { mapNotes, mapNotesMarkdown } from '../../src/strategy/map-notes.js';

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
});

describe('mapNotes: income targets from the opening simulation', () => {
  it('absent without an opening to simulate', () => {
    expect(mapNotes({ graph }).incomeTargets).toBeUndefined();
  });

  it('with an opening: income by turn, never falling, from the base income up', () => {
    const n = mapNotes({ graph, settings: { minimumArmyBonus: 5 }, opening: { players: 2, territoryLimit: 2 } });
    const t = n.incomeTargets!;
    expect(t.map((x) => x.turn)).toEqual([1, 2, 3, 4]);
    expect(t[0]!.income).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < t.length; i++) expect(t[i]!.income).toBeGreaterThanOrEqual(t[i - 1]!.income);
    expect(t.at(-1)!.income).toBeGreaterThan(5);
    const named = new Set(MAP.bonuses.map((b) => b.name));
    for (const x of t) for (const b of x.bonuses) expect(named.has(b)).toBe(true);
  });
});

describe('mapNotesMarkdown', () => {
  it('renders the ranked bonuses and chokepoints', () => {
    const md = mapNotesMarkdown(MAP.name, mapNotes({ graph }));
    expect(md).toContain('Charlie');
    expect(md).toContain('T5');
    expect(md).toMatch(/^# /m);
  });
});
