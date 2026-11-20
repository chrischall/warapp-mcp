// Issue #298 (second half): while an enemy stack roams inside a bonus I am building, garrison the
// members of mine it can reach. #122 credits a member its share of a bonus only while every missing
// member is a visible neutral, so a member beside the enemy stack that took the last one was worth
// +0 and left to fall, and the bonus was then fed piecemeal one member at a time. On a synthetic
// map (every id and name here is made up):
//   Bonus Fen (+5): 41 42 43 44. Mine: 41 (2), 42 (2), 43 (2). Enemy 44 (5) inside it, beside 42
//   and 43; enemy 45 (1) behind it. Neutral 46 (2) beside 41, outside the bonus. Income 6. On the
//   previous board 44 held 1: the stack of 5 arrived since (or 44 was mine: it took it from me).
//     41 ─ 42 ─ 44(e) ─ 45(e)
//     |    |    |
//     46   43 ──┘
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const RATES: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70 };
const players = [{ id: ME }, { id: ENEMY }];

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, string, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Roaming',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, name, value, territoryIds]) => ({ id, name, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const enemy = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: ENEMY },
  armies,
});
const stays = (p: TurnPlan, id: number, start: number) =>
  start +
  (p.deploys.find((d) => d.territoryId === id)?.armies ?? 0) -
  p.moves.filter((m) => m.from === id).reduce((s, m) => s + m.armies, 0);

const MAP = makeMap(
  [41, 42, 43, 44, 45, 46],
  [[41, 42], [42, 43], [42, 44], [43, 44], [44, 45], [41, 46]],
  [[741, 'Fen', 5, [41, 42, 43, 44]]],
);
const BOARD = board([mine(41, 2), mine(42, 2), mine(43, 2), enemy(44, 5), enemy(45, 1), neutral(46, 2)], true);

const plan = (previousBoard?: ReturnType<typeof board>) =>
  planTurn({
    graph: buildGraph(MAP),
    board: BOARD,
    me: ME,
    income: 6,
    settings: RATES,
    game: { players, turn: 7 },
    // #420: the total hold cap off: these test an earlier hold rule, not the cap.
    options: { holdCap: false, adapt: true },
    ...(previousBoard ? { previousBoard } : {}),
  });
const before = (t44: TerritoryState) =>
  board([mine(41, 2), mine(42, 2), mine(43, 2), t44, enemy(45, 1), neutral(46, 2)], true);
const heldAgainstStack = (p: TurnPlan) =>
  // Enemy 44: 5 armies, 4 movable + its deploy (the floor, 5).
  [42, 43].filter((t) => !p.conceded.includes(t) && (armiesToTake(stays(p, t, 2), RATES) ?? 0) > 4 + 5);

describe('#298: a member the stack roaming inside my bonus can reach is garrisoned', () => {
  for (const [name, t44] of [
    ['grew there', enemy(44, 1)],
    ['took it from me', mine(44, 1)],
  ] as const)
    describe(`the stack ${name}`, () => {
      const p = plan(before(t44));
      it('values the members beside the stack by their share of the bonus', () => {
        expect(p.rationale.join('\n')).toMatch(/T42 \(#42\).*protects \+[1-9]/);
      });
      it('holds at least one of them against the stack and its owner deploy', () => {
        expect(heldAgainstStack(p).length).toBeGreaterThan(0);
      });
    });

  it('a stack that stood there already (or no previous board) is no roaming stack: no share', () => {
    for (const p of [plan(), plan(before(enemy(44, 5)))]) {
      expect(p.rationale.join('\n')).not.toMatch(/T42 \(#42\).*protects \+[1-9]/);
    }
  });
});
