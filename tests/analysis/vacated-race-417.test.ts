// #417: the race for vacated land. A static seat's (#270) interior is thin — it deployed on its
// borders — so its fogged land is priced at VACATED_FOG_ARMIES defenders, not at the costliest
// member in view (its border stack), and a vacated territory standing on up to that many is a
// denial (#281: VACATED_MAX_COST covers it). Synthetic map, made-up ids.
//
//   6 ─ 1 ─ 2 ─ 4 ─ 5      1 mine; 2 S's border stack (in view); 4, 5 S's, fogged now
//                          6 a quiet neutral wall behind me; bonus B700 (+3) = 2, 4, 5
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { VACATED_FOG_ARMIES, VACATED_MAX_COST } from '../../src/analysis/plan/vacated.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const A = 20;
const S = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, baseIncome: 5 };

const held = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  return {
    id: 1,
    name: 'Synthetic vacated race',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}

const players = [
  { id: ME, state: 'Playing' },
  { id: A, state: 'Playing' },
  { id: S, state: 'SurrenderAccepted' },
];
const text = (p: TurnPlan) => p.rationale.join('\n');
const attacksOn = (p: TurnPlan, t: number) => p.moves.filter((m) => m.kind === 'attack' && m.to === t);

describe('the race for vacated land (#417)', () => {
  it('a vacated territory on up to VACATED_FOG_ARMIES is a denial', () => {
    expect(VACATED_FOG_ARMIES).toBe(2);
    expect(VACATED_MAX_COST).toBe(3);
    //   6 ─ 1 ─ 2 ─ 3: 2 vacated on 2 armies (costs 3), 3 A's live stack
    const g = buildGraph(makeMap([1, 2, 3, 6], [[6, 1], [1, 2], [2, 3]]));
    const p = planTurn({
      graph: g,
      board: board([mine(1, 10), held(2, 2, S), held(3, 12, A), neutral(6, 40)]),
      me: ME,
      income: 5,
      settings: STD,
      turn: 14,
      game: { players, turn: 14 },
      options: { adapt: true },
    });
    expect(attacksOn(p, 2)).toEqual([expect.objectContaining({ from: 1 })]);
    expect(text(p)).toMatch(/Take T2 \(#2\) though it faces player 20: player 30 left it \(out, no AI\), it costs 3/);
  });

  const g = buildGraph(
    makeMap(
      [1, 2, 4, 5, 6],
      [
        [6, 1],
        [1, 2],
        [2, 4],
        [4, 5],
      ],
      [[700, 3, [2, 4, 5]]],
    ),
  );
  const seen = board([mine(1, 20), held(2, 8, S), held(4, 1, S), held(5, 1, S), neutral(6, 40)]);
  const now = board([mine(1, 20), held(2, 8, S), fogged(4), fogged(5), neutral(6, 40)]);
  const input = (previousBoard?: ReturnType<typeof board>): PlanInput => ({
    graph: g,
    board: now,
    ...(previousBoard ? { previousBoard } : {}),
    me: ME,
    income: 5,
    settings: STD,
    turn: 14,
    game: { players, turn: 14 },
    options: { adapt: true },
  });

  it('fogged land last seen as the static seat\'s is costed at VACATED_FOG_ARMIES, not at its border stack', () => {
    const p = planTurn(input(seen));
    expect(text(p)).toMatch(/B700 \(#700\): T4 \(#4\), fogged now, was player 30's \(out, no AI\): its land behind a border stack stands on 2 at most, so it is costed at 3, not at a stack in view \(#417\)\./);
    expect(text(p)).toMatch(/B700 \(#700\): T5 \(#5\), fogged now, was player 30's/);
    expect(text(p)).not.toMatch(/fogged members? counted at/);
  });

  it('never above the costliest member in view: beside an empty one it counts at that one\'s cost', () => {
    const empty = board([mine(1, 20), held(2, 0, S), fogged(4), fogged(5), neutral(6, 40)]);
    const p = planTurn({ ...input(seen), board: empty });
    expect(text(p)).toMatch(/T4 \(#4\), fogged now, was player 30's \(out, no AI\): .* so it is costed at 1, not at a stack in view \(#417\)\./);
  });

  it('without that sighting, a fogged member is still costed at the costliest one in view', () => {
    const p = planTurn(input());
    expect(text(p)).not.toMatch(/#417/);
    expect(text(p)).toMatch(/2 fogged members counted at/);
  });
});
