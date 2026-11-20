// Issue #440: leftover armies went to borders by the hold rule, so the territory carrying the most
// income — a large single-territory bonus behind its borders — ended the turn thin while the leftover
// topped up low-value borders that already held. Before topping up a border that already holds, the
// leftover now gives that territory a deterrent guard: enough that taking it needs more than a
// casual attack (its nearest opponent's whole deploy, at a comfortable margin). Synthetic map,
// made-up names.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanGameContext, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const P2 = 30;
const P3 = 40;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const FFA: PlanGameContext = { players: [{ id: ME }, { id: P2 }, { id: P3 }], turn: 5 };

//   90 (P2) ─ 2 (mine) ─ 1 (mine, the capital) ─ 3 (mine) ─ 91 (P2)
//                    \_______________________________/
//   2 and 3 are joined too, so neither cuts the capital off; 92 (P3) far off, beside 93 (neutral) ─ 3.
const EDGES: [number, number][] = [[1, 2], [1, 3], [2, 3], [2, 90], [3, 91], [3, 93], [93, 92], [90, 94], [91, 94]];
const IDS = [1, 2, 3, 90, 91, 92, 93, 94];
const CAPITAL = 501;
const mapWith = (value: number): GameMap => ({
  id: 1,
  name: 'Capitals',
  territories: IDS.map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: EDGES.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
  })),
  bonuses: [{ id: CAPITAL, name: 'Capital', value, territoryIds: [1], bonusIds: [] }],
  distributionModes: [],
});
const player = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const field = (over: TerritoryState[] = []): BoardState => {
  const base = [mine(1, 3), mine(2, 22), mine(3, 22), player(90, 30, P2), player(91, 30, P2), player(94, 30, P2), player(92, 3, P3), neutral(93, 10)];
  return board(base.map((t) => over.find((o) => o.territoryId === t.territoryId) ?? t));
};
const plan = (value: number, b: BoardState = field(), extra: Partial<Parameters<typeof planTurn>[0]> = {}): TurnPlan =>
  planTurn({ graph: buildGraph(mapWith(value)), board: b, me: ME, income: 10, settings: STD, game: FFA, ...extra });
const deployOn = (p: TurnPlan, t: number) => p.deploys.filter((d) => d.territoryId === t).reduce((s, d) => s + d.armies, 0);
const why = (p: TurnPlan) => p.rationale.join('\n');

describe('a deterrent guard on the territory with the most income at stake (#440)', () => {
  it('gives the +8 capital behind two borders that already hold a guard before their margins', () => {
    const p = plan(8);
    expect(deployOn(p, 1)).toBe(2);
    expect(deployOn(p, 2) + deployOn(p, 3)).toBe(8);
    expect(p.moves.filter((m) => m.from === 1)).toEqual([]);
    expect(why(p)).toMatch(
      /Deploy 2 of the leftover to T1 \(#1\) as a deterrent guard \(#440\): it has the most income at stake \(protects \+8, the borders being topped up at most \+0\), and its 5 armies now need 8 to take, more than 1\.25 × the ~5 deploy of player 30 within two steps/,
    );
    const lines = p.rationale;
    expect(lines.findIndex((l) => l.includes('#440'))).toBeLessThan(lines.findIndex((l) => l.includes('comfortable margin')));
  });

  it.each([5, 6, 8, 12])('a +8 capital already at its bar (%i armies) keeps them: none move out to the front', (at) => {
    const p = plan(8, field([mine(1, at)]));
    expect(deployOn(p, 1)).toBe(0);
    expect(p.moves.filter((m) => m.from === 1)).toEqual([]);
    expect(why(p)).toMatch(new RegExp(`T1 \\(#1\\) keeps its ${at} armies as a deterrent guard \\(#440\\)`));
  });

  it('below +5 the capital gets no guard and its idle armies move to the front as before', () => {
    const p = plan(4);
    expect(deployOn(p, 1)).toBe(0);
    expect(why(p)).not.toMatch(/#440/);
    expect(p.moves.some((m) => m.from === 1 && m.kind === 'transfer')).toBe(true);
  });

  it('a border that falls is held first; the guard gets only what is left', () => {
    // #420: the hold cap off (3 of 4 is past half): this tests #440's order, not the cap.
    const p = plan(8, field([mine(2, 18)]), { income: 4, options: { holdCap: false } });
    expect(deployOn(p, 2)).toBe(3);
    expect(deployOn(p, 1)).toBe(1);
    expect(deployOn(p, 3)).toBe(0);
    expect(why(p)).toMatch(/Deploy 1 of the leftover to T1 \(#1\) as a deterrent guard \(#440\)/);
  });
});
