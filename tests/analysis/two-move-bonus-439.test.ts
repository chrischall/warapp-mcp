// Issue #439: the planner plans one turn ahead, so a large single-territory bonus two moves away
// through a visible neutral was never a two-turn plan: the neutral in between lost to captures that
// complete nothing, and the bonus came a turn late. Such a bonus (+5 or more) now counts as a
// two-turn completion costing the neutral in between plus the bonus territory, and the neutral in
// between is funded ahead of captures that complete nothing. Synthetic map, made-up names.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanGameContext, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const P2 = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const DUEL: PlanGameContext = { players: [{ id: ME }, { id: P2 }], turn: 3 };

//   1 (mine) ─ 6 (a neutral 2) ─ 3 (the city, a neutral 4)
//   1 ─ 4 (a neutral 2, in no bonus) ─ 5 ─ 90 (the opponent, far off)
//   City (+10): 3 — two moves away; 6 and 4 cost the same, and 4 has the lower id.
const EDGES: [number, number][] = [[1, 6], [6, 3], [1, 4], [4, 5], [5, 90]];
const IDS = [1, 3, 4, 5, 6, 90];
const CITY = 501;
const mapWith = (value: number): GameMap => ({
  id: 1,
  name: 'Cities',
  territories: IDS.map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: EDGES.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
  })),
  bonuses: [{ id: CITY, name: 'City', value, territoryIds: [3], bonusIds: [] }],
  distributionModes: [],
});
const player = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const field = (over: TerritoryState[] = []): BoardState => {
  const base = [mine(1, 1), neutral(3, 4), neutral(4, 2), neutral(5, 2), neutral(6, 2), player(90, 3, P2)];
  return board(base.map((t) => over.find((o) => o.territoryId === t.territoryId) ?? t));
};
const plan = (value: number, b: BoardState = field(), extra: Partial<Parameters<typeof planTurn>[0]> = {}): TurnPlan =>
  planTurn({ graph: buildGraph(mapWith(value)), board: b, me: ME, income: 3, settings: STD, game: DUEL, ...extra });
const targets = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack').map((m) => m.to);
const why = (p: TurnPlan) => p.rationale.join('\n');

describe('stage toward a high-value single-territory bonus two moves away (#439)', () => {
  it('takes the neutral in between ahead of a capture that completes nothing', () => {
    const p = plan(10);
    expect(targets(p)).toEqual([6]);
    expect(p.moves.find((m) => m.to === 6)!.reason).toMatch(/two moves away \(#439\)/);
    expect(why(p)).toMatch(
      /Stage toward City \(#501\) \(\+10\), two moves away: T6 \(#6\) now, T3 \(#3\) next turn — 9 armies over two turns \(#439\)\./,
    );
  });

  it('under goal expand too (taken before the advances), and not below +5', () => {
    const p = plan(10, field(), { options: { goal: 'expand' } });
    expect(targets(p)).toEqual([6]);
    expect(why(p)).toMatch(/Stage toward City/);
    expect(targets(plan(4, field(), { options: { goal: 'expand' } }))).toEqual([4]);
  });

  it('a bonus below +5 is not staged toward: the cheaper-id capture goes first, no line', () => {
    const p = plan(4);
    expect(targets(p)).toEqual([4]);
    expect(why(p)).not.toMatch(/#439/);
  });

  it('a fogged bonus territory is costed at its remembered neutral size, and not staged without one', () => {
    const fogged = field([{ territoryId: 3, owner: { kind: 'unknown' }, armies: null }]);
    expect(targets(plan(10, fogged))).toEqual([4]);
    const p = plan(10, fogged, { options: { rememberedNeutrals: new Map([[3, 4]]) } });
    expect(targets(p)).toEqual([6]);
    expect(why(p)).toMatch(/9 armies over two turns/);
  });
});
