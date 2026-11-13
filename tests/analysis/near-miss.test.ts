// Issue #59: a held +7 bonus's border had 44 armies facing a big stack; the plan said
// "needs 13, only 12 left: conceded", then withdrew all 44 — guaranteeing the loss.
// A near miss on a held bonus's border is funded with everything available; a garrison
// that still holds against the expected attack (movable + deploy estimate, not the trend's
// worst case) is never withdrawn; under Local Deployment the bonus's own pool goes to its
// own threatened border. Synthetic maps only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import {
  NEAR_MISS,
  NEAR_MISS_ARMIES,
  nearMissMargin,
  planTurn,
  type PlanOptions,
  type PlannerSettings,
  type TurnPlan,
} from '../../src/analysis/planner.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, string, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'NearMiss',
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
const deployedTo = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
const deploySum = (p: TurnPlan) => p.deploys.reduce((s, d) => s + d.armies, 0);
const withdrawals = (p: TurnPlan, from: number) => p.moves.filter((m) => m.from === from && m.kind === 'transfer');

//   Mill (+7): 1 2 — mine. 1 (the border) faces enemy stacks on 3 and 4 (fog behind at 5);
//   2 is interior, next to my 6, which borders the 1-army neutral 7 (a cheap expansion).
const MAP = makeMap(
  [1, 2, 3, 4, 5, 6, 7],
  [[1, 2], [1, 3], [1, 4], [3, 5], [4, 5], [2, 6], [6, 7]],
  [[801, 'Mill', 7, [1, 2]]],
);
const g = buildGraph(MAP);
const boardWith = (border: number, e3: number, e4: number): BoardState =>
  board([mine(1, border), mine(2, 3), mine(6, 1), enemy(3, e3), enemy(4, e4), fogged(5), neutral(7, 1)]);
const plan = (b: BoardState, income: number, opts: { options?: PlanOptions; settings?: PlannerSettings; previousBoard?: BoardState } = {}) =>
  planTurn({ graph: g, board: b, me: ME, income, settings: opts.settings ?? STD, options: opts.options, previousBoard: opts.previousBoard });

/** The plan passes warapp_submit_turn's validator. */
function valid(p: TurnPlan, b: BoardState, income: number, localDeployments = false) {
  const names = new Map(MAP.territories.map((t) => [t.id, t.name]));
  const ref = (id: number) => ({ id, name: names.get(id)! });
  const { warnings } = validateTurn({
    map: MAP,
    board: b.territories.map(
      (t): LiveTerritory => ({
        territoryId: t.territoryId,
        fogLevel: t.owner.kind === 'unknown' ? 4 : 1,
        fogged: t.owner.kind === 'unknown',
        owner: t.owner.kind === 'player' ? t.owner.playerId : t.owner.kind === 'neutral' ? OWNER_NEUTRAL : -1,
        armies: t.armies,
      }),
    ),
    myInGameId: ME,
    income,
    guard: true,
    deploys: p.deploys.map((d) => ({ territory: ref(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: ref(m.from), to: ref(m.to), armies: m.armies })),
    localDeployments,
  });
  return warnings;
}

describe('a near miss on a held bonus is funded, never withdrawn (#59)', () => {
  it('NEAR_MISS: 15% of the hold need, or 2 armies, whichever is larger', () => {
    expect(NEAR_MISS).toBe(0.15);
    expect(NEAR_MISS_ARMIES).toBe(2);
    expect(nearMissMargin(13)).toBe(2);
    expect(nearMissMargin(40)).toBe(6);
  });

  it('the arithmetic: 68 + 20 movable + ~5 deploy = 93; 56 armies need 93 to take, 57 need 95', () => {
    expect(armiesToTake(44)).toBe(73);
    expect(armiesToTake(56)).toBe(93);
    expect(armiesToTake(57)).toBe(95);
  });

  // The #59 case: 44 on the border, 69 (and 21) next to it, ~5 deploy, 12 to deploy: the
  // sure hold needs 13, one more than there is.
  const B59 = boardWith(44, 69, 21);

  for (const goal of ['balanced', 'defend'] as const) {
    it(`${goal}: all 12 go on the border, nothing is withdrawn, and a warning says it may fall`, () => {
      const p = plan(B59, 12, { options: { goal } });
      expect(p.conceded).toEqual([]);
      expect(deployedTo(p, 1)).toBe(12);
      expect(deploySum(p)).toBe(12);
      expect(withdrawals(p, 1)).toEqual([]);
      expect(p.moves.some((m) => m.from === 1)).toBe(false);
      expect(p.cardAdvice).toBeNull();
      const w = p.warnings.join('\n');
      expect(w).not.toMatch(/conceded|conceding/);
      expect(w).toMatch(
        /Bonus Mill \(#801\) \(\+7\) is held though short: its 1 threatened border needs 13, only 12 left to deploy, so all 12 go there \(short by 1, within the near-miss margin of 2\); T1 \(#1\) may fall\./,
      );
      expect(valid(p, B59, 12)).toEqual([]);
    });
  }

  it('Local Deployment: the bonus\'s own pool (7) and the 5 anywhere all go to its border, none to the interior', () => {
    const settings = { ...STD, localDeployments: true };
    const p = plan(B59, 12, { settings });
    expect(p.conceded).toEqual([]);
    expect(deployedTo(p, 1)).toBe(12);
    expect(deployedTo(p, 2)).toBe(0);
    expect(deploySum(p)).toBe(12);
    expect(p.moves.some((m) => m.from === 1)).toBe(false);
    expect(valid(p, B59, 12, true)).toEqual([]);
  });

  it('a hopeless border (short by far) is still conceded and withdrawn', () => {
    // 68 + 49 movable + ~5 = 122: holding needs 74 armies, 30 more; 12 is 18 short.
    const b = boardWith(44, 69, 50);
    for (const goal of ['balanced', 'defend'] as const) {
      const p = plan(b, 12, { options: { goal } });
      expect(p.conceded).toEqual([1]);
      expect(deployedTo(p, 1)).toBe(0);
      expect(withdrawals(p, 1)).toEqual([expect.objectContaining({ from: 1, to: 2, armies: 43 })]);
      expect(p.warnings.join('\n')).toMatch(/T1 \(#1\) cannot be held with the 12 armies left to deploy \(needs 30, protects \+7\): conceded/);
      expect(p.warnings.join('\n')).not.toMatch(/held though short/);
      expect(valid(p, b, 12)).toEqual([]);
    }
  });

  it('Local Deployment, hopeless: the pool goes inside the bonus (the interior), the border is withdrawn', () => {
    const b = boardWith(44, 69, 50);
    const p = plan(b, 12, { settings: { ...STD, localDeployments: true } });
    expect(p.conceded).toEqual([1]);
    expect(deployedTo(p, 1)).toBe(0);
    expect(deploySum(p)).toBe(12);
    expect(withdrawals(p, 1)).toHaveLength(1);
    expect(valid(p, b, 12, true)).toEqual([]);
  });

  describe('a garrison that holds against the expected attack', () => {
    // The enemy moved 20 from 3 to 4 last turn: its net deploy is 0 (so ~5), but 4 "grew"
    // +20, so the worst-case threat on 1 is 68 + 20 + 20 = 108; the expected one is
    // movable + deploy = 88 + 5 = 93.
    const then = boardWith(45, 89, 1);
    const now = boardWith(45, 69, 21);

    it('is funded with everything available, though short of the worst case by far', () => {
      // Holding 108 needs 66 (21 more); 45 + 12 = 57 need 95 to take, above the expected 93.
      expect(armiesToTake(65)).toBe(108);
      expect(armiesToTake(66)).toBe(110);
      const p = plan(now, 12, { previousBoard: then });
      expect(p.conceded).toEqual([]);
      expect(deployedTo(p, 1)).toBe(12);
      expect(p.moves.some((m) => m.from === 1)).toBe(false);
      expect(p.warnings.join('\n')).toMatch(
        /Bonus Mill \(#801\) \(\+7\) is held though short: its 1 threatened border needs 21, only 12 left to deploy, so all 12 go there \(enough to hold against the expected ~93 attack \(movable \+ deploy estimate\), not the worst case\); T1 \(#1\) may fall\./,
      );
      expect(valid(p, now, 12)).toEqual([]);
    });

    it('is never withdrawn when the bonus is conceded economically', () => {
      // Mill worth only +1 here, and a far bigger stack: holding 208 needs 39 more than 87,
      // more than 10 × +1 — conceded. But 87 alone need 145 to take, above the expected 143.
      const cheap = buildGraph(makeMap(
        [1, 2, 3, 4, 5, 6, 7],
        [[1, 2], [1, 3], [1, 4], [3, 5], [4, 5], [2, 6], [6, 7]],
        [[801, 'Mill', 1, [1, 2]]],
      ));
      const before = boardWith(87, 139, 1);
      const after = boardWith(87, 69, 71);
      expect(armiesToTake(87)).toBe(145);
      const p = planTurn({ graph: cheap, board: after, me: ME, income: 6, settings: STD, previousBoard: before });
      expect(p.conceded).toEqual([1]);
      expect(withdrawals(p, 1)).toEqual([]);
      expect(p.moves.some((m) => m.from === 1)).toBe(false);
      expect(p.cardAdvice).toBeNull();
      expect(p.rationale.join('\n')).toMatch(
        /Keep the 86 movable armies on T1 \(#1\) \(not withdrawn\): it is a border of held bonus Mill \(#801\), and its 87 armies need 145 to take, above the expected ~143 attack \(movable \+ deploy estimate\)\./,
      );
      expect(valid(p, after, 6)).toEqual([]);
    });
  });
});
