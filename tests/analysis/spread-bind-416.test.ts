// #416 part 4 (owner 2026-11-22): while #319 fires, pass-3 plain expansion and advances into other bonuses may not
// spend deploys, or armies on a territory beside the nearest bonus's missing members, until that bonus's reachable
// steps are funded. Holds keep their places. Synthetic map: every id and name is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const P2 = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

// Near (+3) is 1-2-3: I hold 1 (6 armies), 2 and 3 are neutrals of 4 — two reachable steps of 6, more than one
// turn's deploy. My other nine territories, 10–18, lie in a chain off 1 in no bonus. Plain neutrals of 1: 40 beside
// 1 (beside Near's missing members), 41 beside 15 (4 armies: its own armies take it), 42 beside 13 (2 armies: it
// needs a deploy). The opponent sits on 99, behind a neutral of 5 (60) off 18.
const EDGES: [number, number][] = [
  [1, 2],
  [1, 3],
  [2, 3],
  [1, 10],
  [1, 40],
  [15, 41],
  [13, 42],
  [18, 60],
  [60, 99],
];
for (let t = 10; t < 18; t++) EDGES.push([t, t + 1]);
const IDS = [1, 2, 3, ...Array.from({ length: 9 }, (_, i) => 10 + i), 40, 41, 42, 60, 99];
const MAP: GameMap = {
  id: 1,
  name: 'Bind',
  territories: IDS.map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: EDGES.filter(([x, y]) => x === id || y === id).map(([x, y]) => (x === id ? y : x)),
  })),
  bonuses: [{ id: 500, name: 'Near', value: 3, territoryIds: [1, 2, 3], bonusIds: [] }],
  distributionModes: [],
};
const g = buildGraph(MAP);

/** `contact`: the opponent's 99 borders 18 directly (a hold to fund) instead of behind 60. */
function field(contact = false): BoardState {
  const armies: Record<number, number> = { 1: 6, 15: 4 };
  const ts: TerritoryState[] = IDS.map((id) => {
    if (id === 99) return { territoryId: 99, owner: { kind: 'player', playerId: P2 }, armies: 5 };
    if (id === 1 || (id >= 10 && id <= 18)) return mine(id, armies[id] ?? 2);
    if (id === 2 || id === 3) return neutral(id, 4);
    if (id === 60) return contact ? { territoryId: 60, owner: { kind: 'player', playerId: P2 }, armies: 3 } : neutral(id, 5);
    return neutral(id, 1);
  });
  return board(ts);
}
const plan = (turn: number, income = 5, contact = false): TurnPlan =>
  planTurn({ graph: g, board: field(contact), me: ME, income, settings: { ...STD, baseIncome: 5 }, game: { players: [{ id: ME }, { id: P2 }], turn } });
const attacked = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack').map((m) => m.to).sort((a, b) => a - b);
const deployedTo = (p: TurnPlan) => new Map(p.deploys.map((d) => [d.territoryId, d.armies]));
const bindLine = (p: TurnPlan) => p.rationale.find((r) => r.includes('#319 binds'));

const t18 = (p: TurnPlan) => [...p.warnings, ...p.rationale].filter((l) => l.includes('T18 (#18)') && !l.includes('idle interior'));

describe('#319 binds the deploys to the nearest bonus (#416)', () => {
  it('funds the nearest bonus first: no deploy and no army beside its missing members goes to plain expansion until its steps are taken', () => {
    const p = plan(4);
    expect(p.warnings.some((w) => w.includes('#319'))).toBe(true);
    // Near's first step is taken as before; 3 (6 more) is out of this turn's reach.
    expect(p.moves.find((m) => m.to === 2)).toMatchObject({ from: 1, armies: 6, kind: 'attack' });
    // 40 (beside 1, which borders Near's missing 3) and 42 (it needs a deploy) wait; 41 is taken by 15's own armies.
    expect(attacked(p)).toEqual([2, 41]);
    // Every deploy goes to 1: Near's step this turn, the rest toward 3 next turn.
    expect([...deployedTo(p)]).toEqual([[1, 5]]);
    expect(bindLine(p)).toBe(
      "#319 binds the deploys (#416): until Near (#500)'s reachable steps (T2 (#2), T3 (#3)) are taken, plain expansion and advances into other bonuses spend no deploys and no armies on T1 (#1).",
    );
  });

  it('changes nothing when #319 does not fire (turn 7): plain expansion spends deploys as before', () => {
    const p = plan(7);
    expect(p.warnings.some((w) => w.includes('#319'))).toBe(false);
    expect(bindLine(p)).toBeUndefined();
    expect(attacked(p)).toEqual([2, 40, 41, 42]);
    expect(deployedTo(p).get(13)).toBe(1);
  });

  it('once the steps are funded the rest flows as before', () => {
    // Income 8: Near completes (both steps funded), then 42 takes its deploy, as on turn 7 with no #319.
    const p = plan(4, 8);
    const q = plan(7, 8);
    expect(p.warnings.some((w) => w.includes('#319'))).toBe(true);
    expect(attacked(p)).toEqual([2, 3, 41, 42]);
    expect(p.deploys).toEqual(q.deploys);
    expect(p.moves).toEqual(q.moves);
    expect(bindLine(p)).toBeUndefined();
  });

  it('holds keep their places: the border facing the opponent is judged as without the bind', () => {
    const p = plan(4, 5, true);
    const q = plan(7, 5, true);
    expect(p.warnings.some((w) => w.includes('#319'))).toBe(true);
    expect(bindLine(p)).toBeDefined();
    expect(t18(p)).toEqual(t18(q));
    expect(t18(p).length).toBeGreaterThan(0);
  });
});
