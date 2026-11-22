// #431: a doomed conceded stack attacks out or merges instead of standing. Rule 1b withdraws a conceded
// border's armies toward a border that holds; with no such neighbour they stayed ("… has nowhere to
// withdraw to: its N movable armies stay") even when the expected attack takes the stack. In a finished
// 3-player FFA, pocket stacks of ~1,000-1,800 were lost that way, most of them beside a territory they
// could have taken. Now a doomed one (the expected attack takes it) with nowhere to withdraw moves out
// when the exchange model says that saves more than standing: a capture its whole movable stack makes
// against the owner's estimated deploy, or a merge into a neighbouring conceded stack of mine that then
// holds. Synthetic maps only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanGameContext, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board } from './helpers.js';

const ME = 10;
const BIG = 20;
const OTHER = 30;
const OFF: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: false };
const GAME: PlanGameContext = { players: [ME, BIG, OTHER].map((id) => ({ id })), turn: 29 };

const at = (territoryId: number, armies: number, who: number | 'neutral'): TerritoryState =>
  who === 'neutral'
    ? { territoryId, owner: { kind: 'neutral' }, armies }
    : { territoryId, owner: { kind: 'player', playerId: who }, armies };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'DoomedOut',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}

//   My 3 (40) is a pocket: player 20's 120-stack on 8 beside it, a neutral 4 (`four` armies) beside
//   it and nothing else of mine. My home bonus (+3: 1 and 2) is far away and safe.
const map = makeMap(
  [1, 2, 3, 4, 5, 8, 9],
  [[1, 2], [2, 5], [3, 4], [3, 8], [8, 9], [4, 9]],
  [[900, 3, [1, 2]], [901, 5, [8, 9]]],
);
const g = buildGraph(map);
const pocket = (four: number | null, stack = 40, big = 120): BoardState =>
  board([
    at(1, 5, ME),
    at(2, 5, ME),
    at(3, stack, ME),
    ...(four === null ? [] : [at(4, four, 'neutral')]),
    at(5, 2, 'neutral'),
    at(8, big, BIG),
    at(9, 5, BIG),
  ]);
const plan = (b: BoardState): TurnPlan => planTurn({ graph: g, board: b, me: ME, income: 5, settings: OFF, game: GAME, options: { goal: 'balanced' } });
const from = (p: TurnPlan, x: number) => p.moves.filter((m) => m.from === x);

describe('#431: a doomed conceded stack with nowhere to withdraw', () => {
  it('attacks out with its whole movable stack into a neighbour it takes, instead of standing', () => {
    const p = plan(pocket(4));
    expect(p.conceded ?? []).toContain(3);
    const out = from(p, 3);
    // With the guard off the border keeps one army (next to an enemy): the other 39 go.
    expect(out).toEqual([expect.objectContaining({ to: 4, kind: 'attack', armies: 39 })]);
    expect(p.warnings.join('\n')).not.toMatch(/T3 \(#3\) is conceded and has nowhere to withdraw to/);
    expect(p.rationale.join('\n')).toMatch(
      /T3 \(#3\) is doomed \(#431\): conceded, nowhere to withdraw to, and its 40 need \d+ to take against the expected ~\d+ attack\. Attack T4 \(#4\) with all 39: it holds 4, so ~36 survive, against ~28 killed and none left by standing\./,
    );
  });

  it('stands when no neighbour can be taken and no stack of mine to merge into holds', () => {
    // 4 holds 200: the stack cannot take it, so it stays as before.
    const p = plan(pocket(200));
    expect(from(p, 3)).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(/T3 \(#3\) is conceded and has nowhere to withdraw to: its 39 movable armies stay\./);
  });

  it('stands when the expected attack does not take it (not doomed)', () => {
    // Player 20 has 20 next to it: 40 hold against ~25; the border is still conceded for its worth
    // only when nothing threatens it, so nothing moves out of it here either way.
    const p = plan(pocket(4, 40, 20));
    expect(p.rationale.join('\n')).not.toMatch(/#431/);
  });
});

//   Two pocket stacks of mine side by side, 3 and 6, each facing player 20's 70-stack on 8: alone each
//   falls to it, together they hold. No neighbour can be taken (4 and 7 hold 300).
const pair = makeMap(
  [1, 2, 3, 4, 5, 6, 7, 8, 9],
  [[1, 2], [2, 5], [3, 6], [3, 4], [6, 7], [3, 8], [6, 8], [8, 9]],
  [[900, 3, [1, 2]], [901, 5, [8, 9]]],
);
const gp = buildGraph(pair);

describe('#431: a doomed conceded stack merges into a neighbouring one that then holds', () => {
  it('transfers into the other pocket stack when the merged stack holds against the expected attack', () => {
    const b = board([
      at(1, 5, ME),
      at(2, 5, ME),
      at(3, 40, ME),
      at(6, 40, ME),
      at(4, 300, 'neutral'),
      at(7, 300, 'neutral'),
      at(5, 2, 'neutral'),
      at(8, 70, BIG),
      at(9, 5, BIG),
    ]);
    const p = planTurn({ graph: gp, board: b, me: ME, income: 5, settings: OFF, game: GAME, options: { goal: 'balanced' } });
    const merges = p.moves.filter((m) => m.kind === 'transfer' && (m.from === 3 || m.from === 6));
    expect(merges).toHaveLength(1);
    expect(merges[0]).toEqual(expect.objectContaining({ armies: 39 }));
    expect(p.rationale.join('\n')).toMatch(/is doomed \(#431\).*Merge its 39 into T\d \(#\d\), which then holds/);
  });
});
