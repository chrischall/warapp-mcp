// Issue #567 (reporting only): (1) a turn of the income window that surely read more than the income the
// #418 rise cap holds is said (`observedLow` and a warning), never applied; (2) an opponent whose estimate a
// known income moved through #444's scale is named, with by how much. Every board here is synthetic.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { observedLowOf, observedLowWarning, trackOpponents, type ObservedTurn } from '../../src/analysis/opponents.js';
import { planEnemyEstimates, statedShifts, statedShiftWarning } from '../../src/analysis/plan/estimates.js';
import type { PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const enemy = (territoryId: number, armies: number, playerId = ENEMY): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId }, armies });
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const line = (n: number) => Array.from({ length: n - 1 }, (_, i) => [i + 1, i + 2] as [number, number]);

describe('(1) #567: the uncapped low end beside a held income', () => {
  // My +30 bonus {1, 2, 3} (income 35, 600 on T3); its T4 between my T3 and its T5, T5 beside the fog T6–T9.
  // Walk-ins onto T5 are held at RISE_CAP × a turn (#418); on turn 10 T4 (beside no fog) grows by 29 as well.
  const g = buildGraph(makeMap(range(1, 9), line(9), [[101, 30, [1, 2, 3]], [102, 20, [6, 7]], [103, 25, [8, 9]]]));
  const fog = range(6, 9).map(fogged);
  const at = (t4: number, t5: number) => board([mine(1, 1), mine(2, 1), mine(3, 600), enemy(4, t4), enemy(5, t5), ...fog]);
  const history = (xs: [number, number][]) => xs.map(([a, b], i) => ({ turn: 8 + i, board: at(a, b) }));

  it('held at 17 while turn 10 read at least +29 (two thirds of its frontier): reported, the income unchanged', () => {
    const [t] = trackOpponents(g, history([[1, 5], [1, 50], [1, 95], [30, 140]]), ME, STD);
    expect(t!.income).toBe(17);
    expect(t!.incomeMethod).toBe('rise-capped');
    expect(t!.observedLow).toEqual({ low: 29, high: 50, turn: 10, coverage: 2 / 3 });
    expect(t!.warnings).toContain(
      "Player 20's income is held at ~17, but turn 10 read it deploying at least +29, up to +50, from 67% of its frontier (#567): a rise no turn read in full confirmed is held to 1.3× a turn (#418), so the plan sizes its borders for ~17. To test the low end, pass known_income 29 for it to warapp_check_plan (a known income also scales the other opponents' fog prior, #444).",
    );
  });

  it('no turn whose low end is above the income: nothing reported', () => {
    const [t] = trackOpponents(g, history([[1, 5], [1, 50], [1, 95], [1, 140]]), ME, STD);
    expect(t!.incomeMethod).toBe('rise-capped');
    expect(t!.observedLow).toBeUndefined();
    expect(t!.warnings.join('\n')).not.toMatch(/#567/);
  });

  const turn = (from: number, low: number, high: number, cap = 100, share?: number): ObservedTurn =>
    ({ from, to: from + 1, low, high, cap, ...(share !== undefined ? { coverage: { inView: 1, frontier: 1, share, hiddenBonuses: 0 } } : {}) }) as ObservedTurn;

  it('observedLowOf: the highest low end (at most the cap), the newest on a tie; none without an income', () => {
    expect(observedLowOf([turn(1, 30, 40, 100, 0.5), turn(2, 30, 35)], 20)).toEqual({ low: 30, high: 35, turn: 2, coverage: null });
    expect(observedLowOf([turn(1, 300, 400, 50)], 20)).toEqual({ low: 50, high: 50, turn: 1, coverage: null });
    expect(observedLowOf([turn(1, 20, 40)], 20)).toBeNull();
    expect(observedLowOf([turn(1, 30, 40)], null)).toBeNull();
    expect(observedLowOf([], 5)).toBeNull();
  });

  it('the warning under the tripwire, and with no coverage or range', () => {
    expect(observedLowWarning('Ann', 12, { low: 20, high: 20, turn: 4, coverage: null }, 'tripped')).toBe(
      "Player Ann's income is held at ~12, but turn 4 read it deploying at least +20 (#567): the over-read tripwire keeps the readings before its step at most the stepped figure (#418), so the plan sizes its borders for ~12. To test the low end, pass known_income 20 for it to warapp_check_plan (a known income also scales the other opponents' fog prior, #444).",
    );
  });
});

describe('(2) #567: a known income that moved another opponent through #444 is named', () => {
  // My T1–T4 (+5 on T1–T2); A's T5 beside my T4 and the fog, B's T6 beside my T1 and the fog; two +400 bonuses hidden.
  const A = 20;
  const B = 30;
  const ids = [1, 2, 3, 4, 5, 6, 30, 20, 21, 22, 23, 24, 25, 26, 27];
  const edges: [number, number][] = [
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 20],
    [5, 30],
    [1, 6],
    [6, 21],
    ...Array.from({ length: 7 }, (_, i): [number, number] => [20 + i, 21 + i]),
  ];
  const g = buildGraph(makeMap(ids, edges, [[901, 5, [1, 2]], [902, 400, [20, 21, 22, 23]], [903, 400, [24, 25, 26, 27]]]));
  const fog = [20, 21, 22, 23, 24, 25, 26, 27].map((t) => fogged(t));
  const s: BoardState = board([mine(1, 40), mine(2, 3), mine(3, 3), mine(4, 40), enemy(5, 30, A), enemy(6, 30, B), neutral(30, 2), ...fog]);
  const game = { players: [{ id: ME }, { id: A }, { id: B }, { id: 40 }], turn: 12, symmetricStart: true };
  const est = (known?: { player: number; income: number }[]) =>
    planEnemyEstimates({ graph: g, board: s, me: ME, income: 91, settings: { ...STD, baseIncome: 10 }, game, turn: 12, ...(known ? { known } : {}) });

  it("A states 27 against my 91: B's estimate moves from ~91 to ~19, and the warning names both", () => {
    const plain = est();
    const scaled = est([{ player: A, income: 27 }]);
    const shifts = statedShifts(plain.estimates, scaled.estimates, scaled.prior);
    expect(shifts).toEqual([{ player: B, was: 91, now: 19, by: [{ id: A, income: 27 }] }]);
    expect(statedShiftWarning(shifts)).toBe(
      "The known income given (player 20's 27) moved another opponent's estimate: player 30 ~91 → ~19 (#444: a stated income scales the fog prior of every opponent who stated none). To size them without it, leave that known_income out.",
    );
  });

  it('several players moved, by several incomes, named through the namer', () => {
    const by = [
      { id: 1, income: 5 },
      { id: 2, income: 7 },
    ];
    expect(
      statedShiftWarning(
        [
          { player: 3, was: 50, now: 20, by },
          { player: 4, was: 40, now: 30, by },
        ],
        (id) => `P${id}`,
      ),
    ).toBe(
      "The known incomes given (player P1's 5, player P2's 7) moved other opponents' estimates: player P3 ~50 → ~20, player P4 ~40 → ~30 (#444: a stated income scales the fog prior of every opponent who stated none). To size them without it, leave that known_income out.",
    );
  });

  it('nothing scaled, or nothing moved: no shift and no warning', () => {
    const plain = est();
    expect(statedShifts(plain.estimates, est([{ player: A, income: 120 }]).estimates, est([{ player: A, income: 120 }]).prior)).toEqual([]);
    expect(statedShifts(plain.estimates, plain.estimates, plain.prior)).toEqual([]);
    expect(statedShiftWarning([])).toBeNull();
  });
});
