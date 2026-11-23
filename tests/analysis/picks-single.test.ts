// Single-pick distribution on a huge map (mega-game spec part 2): with a territory limit of 1 the advisor ranks
// candidate starts — income at the game's bonus values, wastelands, commander safety — and shows the best 25 with
// reasons, instead of planning groups. Every id here is made up; the map is a grid big enough to count as huge.
import { describe, expect, it } from 'vitest';
import { buildGraph, type MapGraph } from '../../src/analysis/graph.js';
import { planPicks, type PickSettings } from '../../src/analysis/picks.js';
import { HUGE_MAP_TERRITORIES, rankSingleStarts, SINGLE_PICK_SHOWN } from '../../src/analysis/single-pick.js';
import type { Bonus, GameMap } from '../../src/normalize.js';

const W = 40;
const H = 30; // 1,200 territories
const id = (r: number, c: number) => r * W + c + 1;

const SETTINGS: PickSettings = {
  offensiveKillRate: 50,
  defensiveKillRate: 70,
  luckModifier: 0,
  initialPlayerArmiesPerTerritory: 250,
  minimumArmyBonus: 15,
  bonusArmyPer: 1,
  initialNonDistributionArmies: 5,
  initialNeutralsInDistribution: 100,
  localDeployments: true,
  commanders: true,
  oneArmyStandsGuard: false,
};

/** A grid map: 4-way links; `bonuses` laid on it; `cut` links removed (both ways). */
function grid(bonuses: Bonus[], cut: Array<[number, number]> = []): MapGraph {
  const gone = new Set(cut.flatMap(([a, b]) => [`${a}-${b}`, `${b}-${a}`]));
  const territories = [];
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      const t = id(r, c);
      const near = [
        r > 0 ? id(r - 1, c) : 0,
        r < H - 1 ? id(r + 1, c) : 0,
        c > 0 ? id(r, c - 1) : 0,
        c < W - 1 ? id(r, c + 1) : 0,
      ].filter((n) => n && !gone.has(`${t}-${n}`));
      territories.push({ id: t, name: `T${t}`, connectedTo: near });
    }
  const map: GameMap = { id: 1, name: 'Grid', territories, bonuses, distributionModes: [] };
  return buildGraph(map);
}

const bonus = (bid: number, value: number, members: number[]): Bonus => ({ id: bid, name: `B${bid}`, value, territoryIds: members, bonusIds: [] });

/** Pickables spread over the grid every 4 cells (88 of them), plus any extra. */
function spreadPickable(extra: number[] = []): number[] {
  const out = new Set(extra);
  for (let r = 1; r < H; r += 4) for (let c = 1; c < W; c += 4) out.add(id(r, c));
  return [...out].sort((a, b) => a - b);
}

const plan = (graph: MapGraph, pickable: number[], more: Record<string, unknown> = {}) =>
  planPicks({ graph, pickable, settings: SETTINGS, players: 30, territoryLimit: 1, maxPicks: 30, overridden: true, ...more });

describe('single-pick ranking on a huge map', () => {
  it('counts as huge only from HUGE_MAP_TERRITORIES territories, and shows SINGLE_PICK_SHOWN starts', () => {
    expect(W * H).toBeGreaterThanOrEqual(HUGE_MAP_TERRITORIES);
    expect(SINGLE_PICK_SHOWN).toBe(25);
  });

  it('ranks a start on a paying castle first, shows 25 with reasons, and submits the full ranking within the client max', () => {
    const castle = id(13, 21);
    const g = grid([bonus(1, 100, [castle]), bonus(2, 0, [id(5, 5)])]);
    const pickable = spreadPickable([castle]);
    const p = plan(g, pickable);
    expect(p.single).toBeDefined();
    expect(p.single!.starts).toHaveLength(SINGLE_PICK_SHOWN);
    expect(p.single!.starts[0]!.territoryId).toBe(castle);
    expect(p.single!.starts[0]!.firstIncomeTurn).toBe(0);
    expect(p.single!.starts[0]!.reasons!.join('\n')).toMatch(/B1 \(\+100\)/);
    // The submit list is the ranking in priority order, as long as the client allows (players × 1).
    expect(p.picks).toHaveLength(30);
    expect(p.picks[0]!.territoryId).toBe(castle);
    expect(p.picks[0]!.group).toBe('primary');
    expect(p.picks.slice(1).every((x) => x.group === 'fallback')).toBe(true);
    expect(p.picks.slice(0, 25).map((x) => x.territoryId)).toEqual(p.single!.starts.map((s) => s.territoryId));
    expect(new Set(p.picks.map((x) => x.territoryId)).size).toBe(30);
    expect(p.groups.primary.territoryIds).toEqual([castle]);
    expect(p.single!.shown).toEqual({ from: 1, to: 25, of: pickable.length });
  });

  it('a bonus worth 0 pays nothing: a start beside it ranks below one beside a paying bonus', () => {
    const zeroNear = id(9, 9);
    const payNear = id(9, 29);
    // Two-member bonuses one hop from each candidate: one worth 0 (overridden), one worth 30.
    const g = grid([bonus(1, 0, [id(9, 10), id(9, 11)]), bonus(2, 30, [id(9, 30), id(9, 31)])]);
    const r = rankSingleStarts({ graph: g, pickable: spreadPickable([zeroNear, payNear]), settings: SETTINGS, players: 30 });
    const at = (t: number) => r.ranked.findIndex((s) => s.territoryId === t);
    expect(at(payNear)).toBeLessThan(at(zeroNear));
    const pay = r.ranked[at(payNear)]!;
    expect(pay.bonuses.map((b) => b.bonusId)).toEqual([2]);
    expect(pay.nearestPaying).toMatchObject({ bonusId: 2, hops: 1 });
    expect(r.ranked[at(zeroNear)]!.bonuses).toEqual([]);
  });

  it('turns to the first income above the minimum: the turn a bonus completes, or 16 territories at 1 per territory', () => {
    const near = id(17, 17);
    const g = grid([bonus(1, 20, [id(17, 18), id(17, 19)])]);
    const r = rankSingleStarts({ graph: g, pickable: spreadPickable([near]), settings: SETTINGS, players: 30 });
    const s = r.ranked.find((x) => x.territoryId === near)!;
    // Turn 1 takes the neighbour, turn 2 the second member: +20 from then.
    expect(s.firstIncomeTurn).toBe(2);
    expect(s.bonuses).toEqual([expect.objectContaining({ bonusId: 1, turn: 2, value: 20 })]);
    // With no bonus anywhere the only way above 15 is to hold 16 territories.
    const bare = rankSingleStarts({ graph: grid([]), pickable: spreadPickable([near]), settings: SETTINGS, players: 30 });
    const b = bare.ranked.find((x) => x.territoryId === near)!;
    expect(b.firstIncomeTurn).not.toBeNull();
    expect(b.firstIncomeTurn!).toBeGreaterThanOrEqual(2);
    expect(b.bonuses).toEqual([]);
  });

  it('wastelands: one in a paying bonus blocks it, one on an approach shields; both are named', () => {
    const start = id(21, 21);
    const inBonus = id(21, 23);
    const onApproach = id(20, 21);
    const g = grid([bonus(1, 40, [id(21, 22), inBonus])]);
    const neutralArmies = new Map([
      [inBonus, 50],
      [onApproach, 50],
    ]);
    const r = rankSingleStarts({ graph: g, pickable: spreadPickable([start]), settings: SETTINGS, players: 30, neutralArmies });
    const s = r.ranked.find((x) => x.territoryId === start)!;
    expect(s.wastelands.blocking).toEqual([inBonus]);
    expect(s.wastelands.shielding).toEqual([onApproach]);
    expect(s.safety.approaches).toBe(3);
  });

  it('commander safety: of two equal starts, the one with a rival start next door and more approaches ranks lower', () => {
    const exposed = id(25, 10);
    const sheltered = id(25, 30);
    // A rival pickable right beside the exposed start; the sheltered one sits in a corner pocket.
    const rival = id(25, 11);
    const g = grid([bonus(1, 50, [exposed]), bonus(2, 50, [sheltered])], [
      [sheltered, id(24, 30)],
      [sheltered, id(26, 30)],
    ]);
    const r = rankSingleStarts({ graph: g, pickable: spreadPickable([exposed, sheltered, rival]), settings: SETTINGS, players: 30 });
    const a = r.ranked.find((x) => x.territoryId === exposed)!;
    const b = r.ranked.find((x) => x.territoryId === sheltered)!;
    expect(a.safety.nearestStart).toBe(1);
    expect(b.safety.approaches).toBeLessThan(a.safety.approaches);
    expect(b.score).toBeGreaterThan(a.score);
    expect(b.reasons ?? []).toEqual([]);
  });

  it('pages: page 2 details ranks 26–50 and leaves the submit list unchanged', () => {
    const g = grid([bonus(1, 100, [id(13, 21)])]);
    const pickable = spreadPickable([id(13, 21)]);
    const one = plan(g, pickable);
    const two = plan(g, pickable, { singlePage: 2 });
    expect(two.single!.shown).toEqual({ from: 26, to: 50, of: pickable.length });
    expect(two.single!.starts.map((s) => s.territoryId)).toEqual(
      rankSingleStarts({ graph: g, pickable, settings: SETTINGS, players: 30 }).ranked.slice(25, 50).map((s) => s.territoryId),
    );
    expect(two.picks.map((x) => x.territoryId)).toEqual(one.picks.map((x) => x.territoryId));
  });

  it('is cached per map: a second call with the same input reuses the ranking', () => {
    const g = grid([bonus(1, 100, [id(13, 21)])]);
    const input = { graph: g, pickable: spreadPickable([id(13, 21)]), settings: SETTINGS, players: 30 };
    const a = rankSingleStarts(input);
    const b = rankSingleStarts(input);
    expect(a.cached).toBeUndefined();
    expect(b.cached).toBe(true);
    expect(b.ranked).toBe(a.ranked);
  });

  it('out of time: a partial but complete ranking, never cached', () => {
    const g = grid([bonus(1, 100, [id(13, 21)])]);
    let now = 0;
    const p = plan(g, spreadPickable(), { budgetMs: 500, clock: () => (now += 1000) });
    expect(p.partial).toBe(true);
    expect(p.picks).toHaveLength(30);
    expect(p.warnings.join('\n')).toMatch(/time budget ran out/);
  });

  it('leaves every other plan as it was: no overrides, limit 2, a team game, a small map', () => {
    const g = grid([bonus(1, 100, [id(13, 21)])]);
    const pickable = spreadPickable([id(13, 21)]);
    expect(plan(g, pickable, { overridden: false }).single).toBeUndefined();
    expect(plan(g, pickable, { territoryLimit: 2, maxPicks: 60 }).single).toBeUndefined();
    expect(plan(g, pickable, { team: { teammates: 1 } }).single).toBeUndefined();
    const small = buildGraph({ ...g.map, territories: g.map.territories.slice(0, 400).map((t) => ({ ...t, connectedTo: t.connectedTo.filter((n) => n <= 400) })) });
    expect(plan(small, pickable.filter((t) => t <= 400)).single).toBeUndefined();
  });
});
