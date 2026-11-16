// #275 (pattern 2): a hollow interior with the guard off. Every interior territory may hold 0, so one
// breach by a large stack puts everything behind the border one move away. The breach cost of a border
// (src/analysis/breach.ts) — the income within two moves behind it that only it shields — is reported
// in the headroom table and, with the guard off, counted in the border's value (BREACH_WEIGHT). The garrison
// behind such a border is #276's second line (plan/guard-off.ts), not a rule of its own here. Synthetic
// maps; every id is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { breachBehind } from '../../src/analysis/breach.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { headroomTable } from '../../src/analysis/headroom.js';
import { BREACH_WEIGHT } from '../../src/analysis/plan/shared.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const OFF: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: false };
const ON: PlannerSettings = { ...OFF, oneArmyStandsGuard: true };

function makeMap(n: number, edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  return {
    id: 1,
    name: 'Breach',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const foe = (id: number, armies: number): TerritoryState => mine(id, armies, FOE);

//   1 (enemy) ─ 2 (my border) ─ 3 ─ 4 ─ 5, bonus Inner (+6) = 3, 4; bonus Far (+5) = 5 (three steps back).
const LINE = makeMap(5, [[1, 2], [2, 3], [3, 4], [4, 5]], [[100, 6, [3, 4]], [200, 5, [5]]]);

describe('breachBehind (#275 pattern 2)', () => {
  const g = buildGraph(LINE);
  const front = (x: number) => x === 2;

  it('gives the territories within two steps behind a border that only it shields, and the bonuses they are in', () => {
    expect(breachBehind(g, new Set([2, 3, 4, 5]), front, 2)).toEqual({ ids: [3, 4], bonuses: [{ id: 100, value: 6 }], income: 6 });
  });

  it('leaves out the border\'s own bonus, a bonus not held in full, and what is cut off', () => {
    const own = buildGraph(makeMap(5, [[1, 2], [2, 3], [3, 4], [4, 5]], [[100, 6, [2, 3]], [200, 5, [4, 5]]]));
    // Bonus 100 holds the border itself; 200 is held in full and has 4 inside the reach.
    expect(breachBehind(own, new Set([2, 3, 4, 5]), front, 2)).toEqual({ ids: [3, 4], bonuses: [{ id: 200, value: 5 }], income: 5 });
    // 5 not held: bonus 200 is not mine.
    expect(breachBehind(own, new Set([2, 3, 4]), front, 2).income).toBe(0);
    // A territory already counted (#235's cut) is skipped.
    expect(breachBehind(g, new Set([2, 3, 4, 5]), front, 2, new Set([3, 4]))).toEqual({ ids: [], bonuses: [], income: 0 });
  });

  it('counts nothing a second front also reaches within two steps, and nothing that faces an enemy itself', () => {
    // 4 is a front too: it shields itself, and 3 lies within two steps of both 2 and 4.
    expect(breachBehind(g, new Set([2, 3, 4, 5]), (x) => x === 2 || x === 4, 2).ids).toEqual([]);
    // 1 ─ 2 ─ 3 ─ 4 ─ 5 ─ 6 with 6 a front too: 4 is within two steps of it as well; 3 is only 2's.
    const long = buildGraph(makeMap(6, [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]));
    expect(breachBehind(long, new Set([2, 3, 4, 5, 6]), (x) => x === 2 || x === 6, 2).ids).toEqual([3]);
  });

  it('is empty for a territory that is not mine or not a front', () => {
    expect(breachBehind(g, new Set([3, 4, 5]), front, 2).ids).toEqual([]);
    expect(breachBehind(g, new Set([2, 3, 4, 5]), () => false, 2).ids).toEqual([]);
  });
});

describe('the headroom table reports the breach (#275 pattern 2)', () => {
  it('gives each border the territories only it shields and their income', () => {
    const rows = headroomTable({
      graph: buildGraph(LINE),
      board: board([foe(1, 3), mine(2, 10), mine(3, 0), mine(4, 0), mine(5, 0)]),
      me: ME,
      deploys: [],
      moves: [],
      settings: OFF,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ territory: 2, behind: [3], breach: { territories: [3, 4], income: 6 } });
  });

  it('counts nothing behind a stack that can answer the breach', () => {
    // 3 holds 50: the 3-army stack takes 2 with a deploy of 14 (16 attackers), and 50 answers it.
    const rows = headroomTable({
      graph: buildGraph(LINE),
      board: board([foe(1, 3), mine(2, 10), mine(3, 50), mine(4, 0), mine(5, 0)]),
      me: ME,
      deploys: [],
      moves: [],
      settings: OFF,
    });
    expect(rows[0]!.breach).toEqual({ territories: [], income: 0 });
  });

  it('treats a territory beside the fog as a front of its own', () => {
    //   1 (enemy) ─ 2 ─ 3 ─ 4 ─ 5 (fog): 4 faces the fog, 3 is within two of it.
    const rows = headroomTable({
      graph: buildGraph(LINE),
      board: board([foe(1, 3), mine(2, 10), mine(3, 0), mine(4, 0), fogged(5)]),
      me: ME,
      deploys: [],
      moves: [],
      settings: OFF,
    });
    expect(rows[0]!.breach).toEqual({ territories: [], income: 0 });
  });
});

describe('the planner prices a border by its breach with the guard off (#275 pattern 2)', () => {
  //   1 (enemy, 6) ─ 2 (my border, 1) ─ 3 ─ 4: Inner (+6) = 3, 4 behind it. 2 is in no bonus: alone it
  //   protects nothing, and its 6-army hold costs more than CONCEDE_FACTOR × its worth. Neutral 5 and 6
  //   off 4 (East +3) give the income somewhere else to go. With the guard on the interior holds 1.
  const MAP = makeMap(6, [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6]], [[100, 6, [3, 4]], [300, 3, [5, 6]]]);
  const entries = (interior: number) => [foe(1, 6), mine(2, 1), mine(3, interior), mine(4, interior), neutral(5, 1), neutral(6, 1)];
  const plan = (settings: PlannerSettings, interior: number, over: Partial<PlanInput> = {}): TurnPlan =>
    planTurn({ graph: buildGraph(MAP), board: board(entries(interior)), me: ME, income: 10, settings, ...over });

  it('holds the border the guard-off breach makes worth holding, and says why', () => {
    const p = plan(OFF, 0);
    expect(p.conceded).not.toContain(2);
    const line = p.rationale.find((r) => /#275/.test(r) && /alone shields/.test(r));
    expect(line).toMatch(/T2 \(#2\) alone shields T3 \(#3\), T4 \(#4\)/);
    expect(line).toMatch(new RegExp(`\\+6 income.*\\+${BREACH_WEIGHT * 6}\\b`));
  });

  it('prices no breach behind a stack that can answer it', () => {
    const p = planTurn({
      graph: buildGraph(MAP),
      board: board([foe(1, 6), mine(2, 1), mine(3, 30), mine(4, 0), neutral(5, 1), neutral(6, 1)]),
      me: ME,
      income: 10,
      settings: OFF,
    });
    expect(p.rationale.some((r) => /alone shields/.test(r))).toBe(false);
  });

  it('changes nothing with the guard on', () => {
    const p = plan(ON, 1);
    expect(p.rationale.some((r) => /alone shields/.test(r))).toBe(false);
    expect(p.conceded).toContain(2);
  });
});

describe('one second line with the guard off: #276\'s, never a second one from #275', () => {
  //   1 (enemy stack) ─ 2 (my border) ─ 3 ─ 4: Home (+5) = 3, 4. 3 is the member the stack reaches next.
  //   Neutral 5 off 4 (2 armies) is expansion the income still pays for. #275 brings only the breach
  //   price; the garrison behind a border is #276's second line (plan/guard-off.ts).
  const MAP = makeMap(5, [[1, 2], [2, 3], [3, 4], [4, 5]], [[100, 5, [3, 4]]]);
  const plan = (settings: PlannerSettings, stack: number): TurnPlan =>
    planTurn({
      graph: buildGraph(MAP),
      board: board([foe(1, stack), mine(2, 1), mine(3, 0), mine(4, 3), neutral(5, 1)]),
      me: ME,
      income: 10,
      settings,
    });

  it('names only #276\'s second line, and still makes the capture the income pays for', () => {
    const p = plan(OFF, 40);
    const text = p.rationale.join('\n');
    expect(text).toContain('Second line (#276)');
    expect(text).not.toContain('Second line (#275)');
    expect(p.moves.some((m) => m.kind === 'attack' && m.to === 5)).toBe(true);
  });

  it('keeps none with the guard on', () => {
    expect(plan(ON, 40).rationale.some((r) => /Second line/.test(r))).toBe(false);
  });
});
