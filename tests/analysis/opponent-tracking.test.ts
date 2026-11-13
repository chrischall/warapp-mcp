// S3: opponent tracking. A per-game history of my boards is read turn pair by turn pair with
// F1's rules (#69: only territories visible on both boards count); the tracker reports each
// opponent's observed deploys, an income estimate (median of the last three observed turns,
// floored by what it visibly earns), the armies that must be in the fog, and the bonuses it
// could hold that would explain an income gap — candidates, never an assertion.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { trackOpponents, type TurnBoard } from '../../src/analysis/opponents.js';
import { enemyDeployEstimates, planTurn, TRACKED_MIN_TURNS, type PlannerSettings } from '../../src/analysis/planner.js';
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

const enemy = (territoryId: number, armies: number, playerId = ENEMY): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

// My +3 bonus {1, 2}; T2 faces the enemy's T3. The enemy also shows T4 and T5 behind T3.
// Fogged: T6, T7 (+4 bonus 902), T8 (+4 bonus 906 when `twoFits`), T9 (+3 bonus 903 — no fit),
// and T11, in +4 bonus 905 with my T1, so the enemy cannot hold that one.
function makeGraph(twoFits = false) {
  return buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 11],
      [
        [1, 2],
        [2, 3],
        [3, 4],
        [4, 5],
        [5, 6],
        [6, 7],
        [7, 8],
        [8, 9],
        [1, 11],
      ],
      [
        [901, 3, [1, 2]],
        [902, 4, [6, 7]],
        [903, 3, [9]],
        [905, 4, [1, 11]],
        ...(twoFits ? ([[906, 4, [8]]] as [number, number, number[]][]) : []),
      ],
    ),
  );
}
const g = makeGraph();

const FOG = [fogged(6), fogged(7), fogged(8), fogged(9), fogged(11)];
/** One board: my T1/T2 at 5, the enemy's T3/T4/T5 at the given counts, the rest fogged. */
const at = (t3: number, t4 = 2, t5 = 2, rest: TerritoryState[] = FOG): BoardState =>
  board([mine(1, 5), mine(2, 5), enemy(3, t3), enemy(4, t4), enemy(5, t5), ...rest]);
const history = (...boards: [number, BoardState][]): TurnBoard[] => boards.map(([turn, b]) => ({ turn, board: b }));

describe('trackOpponents', () => {
  it('an opponent fully fogged for a turn and seen again: that pair is skipped with a note, never a throw (#83)', () => {
    const hidden = board([mine(1, 5), mine(2, 5), fogged(3), fogged(4), fogged(5), ...FOG]);
    const tracks = trackOpponents(g, history([3, at(10)], [4, hidden], [5, at(20)], [6, at(25)]), ME, STD);
    const t = tracks.find((x) => x.playerId === ENEMY)!;
    expect(t.turns.map((x) => [x.from, x.to])).toEqual([[5, 6]]);
    expect(t.notes.join(' ')).toMatch(/No territory of it in view on turn 4/);
  });

  it('a steady +5/turn opponent: observed 5 each turn, income 5, nothing unaccounted, no gap to explain', () => {
    const [t] = trackOpponents(g, history([3, at(10)], [4, at(15)], [5, at(20)]), ME, STD);
    expect(t).toMatchObject({ playerId: ENEMY, firstSeen: 3, visibleIncome: 5, income: 5, unaccounted: 0, inferred: null });
    expect(t!.turns.map((x) => [x.from, x.to, x.observed])).toEqual([
      [3, 4, 5],
      [4, 5, 5],
    ]);
    expect(t!.incomeTurns).toEqual([3, 4]);
  });

  it('the income estimate is the median of the last three observed turns, floored by the visible income', () => {
    // Observed 6, 6, 11, 7 (turns 3–6): the last three are 6, 11, 7 → median 7.
    const [t] = trackOpponents(g, history([3, at(10)], [4, at(16)], [5, at(22)], [6, at(33)], [7, at(40)]), ME, STD);
    expect(t!.turns.map((x) => x.observed)).toEqual([6, 6, 11, 7]);
    expect(t!.incomeTurns).toEqual([4, 5, 6]);
    expect(t!.income).toBe(7);
    // Flat boards observe 0, but it visibly earns its base 5: the floor wins.
    const [flat] = trackOpponents(g, history([3, at(10)], [4, at(10)], [5, at(10)]), ME, STD);
    expect(flat!.income).toBe(5);
  });

  it('a fog-hidden bonus: an income gap of 4 is explained by the one +4 bonus it could hold', () => {
    // It deploys 9 a turn (base 5 + 4 it earns in the fog).
    const [t] = trackOpponents(g, history([3, at(10)], [4, at(19)], [5, at(28)]), ME, STD);
    expect(t!.income).toBe(9);
    expect(t!.inferred).toMatchObject({ gap: 4, exact: true, more: 0 });
    // 902 fits; 903 (+3) does not; 905 holds my T1, so it cannot be the enemy's.
    expect(t!.inferred!.candidates).toEqual([{ bonusIds: [902], total: 4 }]);
  });

  it('lists every combination that fits rather than asserting one', () => {
    const g2 = makeGraph(true);
    const [t] = trackOpponents(g2, history([3, at(10)], [4, at(19)], [5, at(28)]), ME, STD);
    expect(t!.inferred!.candidates).toEqual([
      { bonusIds: [902], total: 4 },
      { bonusIds: [906], total: 4 },
    ]);
    expect(t!.notes.join(' ')).toMatch(/2 combinations fit/);
  });

  it('unaccounted armies: what it visibly earns but does not show must be in the fog', () => {
    // It visibly holds +4 bonus {3, 4} (a 9 income) but its visible armies stay flat for a
    // turn, then T3 sends 6 into the fog: 9 + (9 + 6) = 24 armies it must hold out of sight.
    const g3 = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5, 6],
        [
          [1, 2],
          [2, 3],
          [3, 4],
          [4, 5],
          [3, 6],
        ],
        [
          [901, 3, [1, 2]],
          [902, 4, [3, 4]],
        ],
      ),
    );
    const b = (t3: number) => board([mine(1, 5), mine(2, 5), enemy(3, t3), enemy(4, 2), enemy(5, 2), fogged(6)]);
    const [t] = trackOpponents(g3, history([3, b(10)], [4, b(10)], [5, b(4)]), ME, STD);
    expect(t!.visibleIncome).toBe(9);
    expect(t!.turns.map((x) => [x.observed, x.net, x.losses, x.earned])).toEqual([
      [0, 0, 0, 9],
      [0, -6, 0, 9],
    ]);
    expect(t!.unaccounted).toBe(24);
    expect(t!.income).toBe(9);
  });

  it('counts captures and losses it was seen to make', () => {
    // Turn 3 → 4: T3 (12) takes my T2 (5 there) and leaves 8 on it, 3 behind. Net over the
    // territories seen both turns (3 − 12) + 8 = −1. The capture cost what my 5 defenders kill
    // at the 70% defensive rate, round(3.5) = 4 (#86's attrition rule, as observeDeploy):
    // observed −1 + 4 = 3 (12 + 3 deployed, 12 attack, 4 die, 8 stand). It earned its base 5,
    // so 5 − (−1) − 4 = 2 armies went unseen.
    const before = board([mine(1, 5), mine(2, 5), enemy(3, 12), enemy(4, 2), enemy(5, 2), ...FOG]);
    const after = board([mine(1, 5), enemy(2, 8), enemy(3, 3), enemy(4, 2), enemy(5, 2), ...FOG]);
    const [t] = trackOpponents(g, history([3, before], [4, after]), ME, STD);
    expect(t!.turns[0]).toMatchObject({ observed: 3, net: -1, losses: 4, earned: 5, captured: [2], fromFog: [] });
    expect(t!.unaccounted).toBe(2);
  });

  it('a capture out of the fog (#86) counts its attrition, not the stack, and the stack leaves the fog', () => {
    // Turn 3 → 4: a 14-army stack from fogged T11 takes my T1 (5 there) and stands 10 on it.
    // No visible territory of it shrank, so the 10 arrived from the fog: a move, not income.
    // Observed = the capture's cost only, round(5 × 0.7) = 4 — never the 10 standing there.
    // The 10 came into view, so they are no longer fog armies: 5 − 10 − 4 < 0 → 0 unaccounted.
    const before = board([mine(1, 5), mine(2, 5), enemy(3, 10), enemy(4, 2), enemy(5, 2), ...FOG]);
    const after = board([enemy(1, 10), mine(2, 5), enemy(3, 10), enemy(4, 2), enemy(5, 2), ...FOG]);
    const [t] = trackOpponents(g, history([3, before], [4, after]), ME, STD);
    expect(t!.turns[0]).toMatchObject({ observed: 4, net: 10, losses: 4, earned: 5, captured: [1], fromFog: [1] });
    expect(t!.unaccounted).toBe(0);
    expect(t!.notes.join(' ')).toMatch(/1 capture out of the fog on turn 3/);
  });

  it('fog reveals are not counted (F1): stacks that come into view are neither deploy nor fog armies', () => {
    // Turn 4 shows T6 and T7 for the first time, 20 each, while it deploys its base 5 on T3.
    const revealed = [enemy(6, 20), enemy(7, 20), fogged(8), fogged(9), fogged(11)];
    const [t] = trackOpponents(g, history([3, at(10)], [4, at(15)], [5, at(20, 2, 2, revealed)]), ME, STD);
    expect(t!.turns.map((x) => [x.observed, x.reveals])).toEqual([
      [5, []],
      [5, [6, 7]],
    ]);
    expect(t!.income).toBe(9); // now visibly holds 902 too: base 5 + 4
    expect(t!.unaccounted).toBe(0);
  });

  it('only consecutive turns are compared; a missing turn is noted', () => {
    const [t] = trackOpponents(g, history([3, at(10)], [4, at(15)], [6, at(30)]), ME, STD);
    expect(t!.turns.map((x) => [x.from, x.to])).toEqual([[3, 4]]);
    expect(t!.notes.join(' ')).toMatch(/turn 5/);
    expect(t!.notes.join(' ')).toMatch(/fewer than 2 observed turns/);
  });

  it('an opponent first seen late is tracked from then on', () => {
    const hidden = board([mine(1, 5), mine(2, 5), fogged(3), fogged(4), fogged(5), ...FOG]);
    const [t] = trackOpponents(g, history([2, hidden], [3, at(10)], [4, at(15)]), ME, STD);
    expect(t!.firstSeen).toBe(3);
    expect(t!.turns.map((x) => x.from)).toEqual([3]);
  });

  it('is deterministic and ignores boards given out of order', () => {
    const h = history([5, at(20)], [3, at(10)], [4, at(15)]);
    expect(trackOpponents(g, h, ME, STD)).toEqual(trackOpponents(g, [...h].sort((a, b) => a.turn - b.turn), ME, STD));
  });

  it('no opponents, or one board: nothing to observe', () => {
    expect(trackOpponents(g, [], ME, STD)).toEqual([]);
    const [t] = trackOpponents(g, history([3, at(10)]), ME, STD);
    expect(t).toMatchObject({ turns: [], income: null, unaccounted: null, inferred: null });
  });
});

describe('the planner uses the tracked income', () => {
  // Observed 6, 6, 11 → median 6; the single-turn figure (turn 5 → 6) is 11.
  const boards = history([3, at(10)], [4, at(16)], [5, at(22)], [6, at(33)]);
  const now = boards.at(-1)!.board;
  const previous = boards.at(-2)!.board;

  it(`with ≥ ${TRACKED_MIN_TURNS} observed turns, in place of the single-turn observed figure`, () => {
    const tracks = trackOpponents(g, boards, ME, STD);
    const [single] = enemyDeployEstimates(g, now, ME, STD, previous);
    expect(single).toMatchObject({ estimate: 11, source: 'observed' });
    const [e] = enemyDeployEstimates(g, now, ME, STD, previous, tracks);
    expect(e).toMatchObject({ estimate: 6, source: 'tracked', tracked: 6 });
    const plan = planTurn({ graph: g, board: now, me: ME, income: 5, settings: STD, previousBoard: previous, turn: 6, tracks });
    expect(plan.rationale.join('\n')).toMatch(/Tracked income for player 20: ~6\/turn.*median of its last 3 observed turns.*in place of the single-turn observed figure/);
    expect(plan.warnings.join('\n')).toMatch(/Enemy deploy estimate for player 20: ~6 \(tracked/);
  });

  it(`fewer than ${TRACKED_MIN_TURNS} observed turns: today's behaviour`, () => {
    const tracks = trackOpponents(g, boards.slice(-2), ME, STD);
    expect(tracks[0]!.turns).toHaveLength(1);
    const input = { graph: g, board: now, me: ME, income: 5, settings: STD, previousBoard: previous, turn: 6 };
    expect(planTurn({ ...input, tracks })).toEqual(planTurn(input));
    const [e] = enemyDeployEstimates(g, now, ME, STD, previous, tracks);
    expect(e).toMatchObject({ estimate: 11, source: 'observed', tracked: null });
  });

  it('the tracked figure never drops below the visible estimate', () => {
    // Its visible bonus 902 (T6, T7 now in view) makes 9; observed only 5s.
    const seen = [enemy(6, 3), enemy(7, 3), fogged(8), fogged(9), fogged(11)];
    const h = history([3, at(10, 2, 2, seen)], [4, at(15, 2, 2, seen)], [5, at(20, 2, 2, seen)]);
    const tracks = trackOpponents(g, h, ME, STD);
    expect(tracks[0]!.income).toBe(9);
    const [e] = enemyDeployEstimates(g, h[2]!.board, ME, STD, h[1]!.board, tracks);
    expect(e!.estimate).toBeGreaterThanOrEqual(9);
  });

  it('a visible neutral rules its bonus out; the nearest fit is listed as approximate', () => {
    // T6 shows neutral, so 902 is out. It deploys 7 a turn: a gap of 2, and 903 (+3) is the
    // only bonus within 1 of it.
    const rest = [neutral(6, 2), fogged(7), fogged(8), fogged(9), fogged(11)];
    const [t] = trackOpponents(g, history([3, at(10, 2, 2, rest)], [4, at(17, 2, 2, rest)], [5, at(24, 2, 2, rest)]), ME, STD);
    expect(t!.inferred).toEqual({ gap: 2, exact: false, candidates: [{ bonusIds: [903], total: 3 }], more: 0 });
    expect(t!.notes.join(' ')).toMatch(/1 combination fits its income gap of 2 approximately/);
  });
});
