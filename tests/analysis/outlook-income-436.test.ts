import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { gameOutlook, INCOME_AHEAD_RATIO, INCOME_BEHIND_RATIO, SURRENDER_TURNS } from '../../src/analysis/outlook.js';
import type { TurnBoard } from '../../src/analysis/opponents.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

// #436 (owner decision of 2026-11-20): the outlook follows both incomes and their trend, reads `unknown`
// when the income range spans both thresholds, makes no lead claim at low coverage, gets a pace line, and
// reports the surrender line (my income under two-thirds of the strongest opponent's calibrated estimate for
// three turns running, with no bonus in reach that closes the gap) as advice only.

const ME = 10;
const FOE = 20;

/** T1–T8 in a line; bonus 1 = T1–T3 (+`west`), bonus 2 = T6–T8 (+5), bonus 3 = T4 alone (+`b3`). */
function line(b3 = 0, west = 5): GameMap {
  const ids = Array.from({ length: 8 }, (_, i) => i + 1);
  return {
    id: 1,
    name: 'Line',
    territories: ids.map((id) => ({ id, name: `T${id}`, connectedTo: ids.filter((x) => Math.abs(x - id) === 1) })),
    bonuses: [
      ...(west ? [{ id: 1, name: 'West', value: west, territoryIds: [1, 2, 3], bonusIds: [] }] : []),
      { id: 2, name: 'East', value: 5, territoryIds: [6, 7, 8], bonusIds: [] },
      ...(b3 ? [{ id: 3, name: 'Middle', value: b3, territoryIds: [4], bonusIds: [] }] : []),
    ],
    distributionModes: [],
  };
}
const foe = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: FOE }, armies });
const game = { players: [{ id: ME }, { id: FOE }] };
const start = { territories: 3, armiesPerTerritory: 5 };
const turns = (from: number, boards: ReturnType<typeof board>[]): TurnBoard[] => boards.map((b, i) => ({ turn: from + i, board: b }));

/** In full view: me on T1–T2 and T3 neutral (income 5), the foe on T6–T8 (its bonus: income 10). */
const trailing = (a: number, b: number) =>
  board([mine(1, a), mine(2, a), neutral(3, 2), neutral(4, 2), neutral(5, 2), foe(6, b), foe(7, b), foe(8, b)]);
/** In full view: me on T1–T3 (income 10), the foe on T6–T7 (income 5). */
const leading = (a: number, b: number) =>
  board([mine(1, a), mine(2, a), mine(3, a), neutral(4, 2), neutral(5, 2), foe(6, b), foe(7, b), neutral(8, 2)]);
/** The same, with only the foe's T6 in view. */
const leadingThin = (a: number, b: number) =>
  board([mine(1, a), mine(2, a), mine(3, a), neutral(4, 2), fogged(5), foe(6, b), fogged(7), fogged(8)]);

describe('outlook incomes (#436)', () => {
  it('reads behind on incomes the strength ratio calls even, and crosses the surrender line after three turns', () => {
    // No bonus 1 here: nothing in reach closes the gap.
    const o = gameOutlook({ graph: buildGraph(line(0, 0)), me: ME, boards: turns(4, [trailing(10, 10), trailing(10, 10), trailing(10, 10)]), game });
    const last = o.turns.at(-1)!;
    expect(last.income).toMatchObject({ mine: 5, theirs: { playerId: FOE, low: 10, high: 10, estimate: 10 }, lean: 'behind' });
    expect(o.state).toBe('behind');
    expect(o.surrenderLine).toMatchObject({ crossed: true, turnsBelow: SURRENDER_TURNS, myIncome: 5, theirIncome: 10, playerId: FOE });
    expect(o.surrenderLine!.advice).toMatch(/advice only/);
    expect(o.basis).toMatch(/Surrender line crossed/);
  });

  it('names the bonus in reach that would close the gap', () => {
    // Me on T3 only, beside T4 (+5): my income 5 against the foe's 10 (bonus 2): 5 + 5 ≥ ⅔ × 10.
    const b = (a: number) =>
      board([neutral(1, 2), neutral(2, 2), mine(3, a), neutral(4, 2), foe(5, 5), foe(6, 5), foe(7, 5), foe(8, 5)]);
    const o = gameOutlook({ graph: buildGraph(line(5)), me: ME, boards: turns(4, [b(10), b(10), b(10)]), game });
    expect(o.turns.at(-1)!.income!.lean).toBe('behind');
    expect(o.surrenderLine).toMatchObject({ crossed: false, turnsBelow: 3, closer: { bonus: 3, value: 5 } });
    expect(o.surrenderLine!.advice).toMatch(/bonus 3 \(\+5\)/);
  });

  it('reads ahead on incomes in full view, but makes no lead claim on thin evidence', () => {
    const g = buildGraph(line());
    const open = gameOutlook({ graph: g, me: ME, boards: turns(4, [leading(10, 10), leading(10, 10), leading(10, 10)]), game });
    expect(open.turns.at(-1)!.income!.lean).toBe('ahead');
    expect(open.state).toBe('ahead');
    const thin = gameOutlook({ graph: g, me: ME, boards: turns(4, [leadingThin(10, 10), leadingThin(10, 12), leadingThin(10, 14)]), game: { ...game, start } });
    const last = thin.turns.at(-1)!;
    expect(last.evidence!.thin).toBe(true);
    expect(last.income!.lean).toBe('unknown');
    expect(last.income!.noLeadClaim).toBe(true);
    expect(thin.state).not.toBe('ahead');
    expect(thin.basis).toMatch(/no lead is claimed/i);
  });

  it('reads unknown when the calibrated range spans both thresholds', () => {
    // A +20 bonus on the fogged T5 lets the foe earn up to 30 a turn, so ÷ 0.3 stays under its could-earn cap.
    const map = line();
    const g = buildGraph({ ...map, bonuses: [...map.bonuses, { id: 4, name: 'Pass', value: 20, territoryIds: [5], bonusIds: [] }] });
    const boards = turns(4, [leadingThin(10, 10), leadingThin(10, 12), leadingThin(10, 14)]);
    const plain = gameOutlook({ graph: g, me: ME, boards, game: { ...game, start } });
    const low = plain.turns.at(-1)!.income!.theirs.low;
    // Past games read this band at 0.3× the truth: the estimate is the tracked figure ÷ 0.3.
    const o = gameOutlook({ graph: g, me: ME, boards, game: { ...game, start }, calibration: { '25-50': { geoMean: 0.3, n: 20 } } });
    const inc = o.turns.at(-1)!.income!;
    expect(inc.calibrated).toBe(true);
    expect(inc.theirs.estimate).toBe(Math.round(low / 0.3));
    expect(inc.ratio.low).toBeLessThanOrEqual(INCOME_BEHIND_RATIO);
    expect(inc.ratio.high!).toBeGreaterThanOrEqual(INCOME_AHEAD_RATIO);
    expect(inc.lean).toBe('unknown');
    // A band with too few samples is not used.
    const few = gameOutlook({ graph: g, me: ME, boards, game: { ...game, start }, calibration: { '25-50': { geoMean: 0.3, n: 2 } } });
    expect(few.turns.at(-1)!.income!.calibrated).toBe(false);
  });

  it('never lets the calibrated estimate or the top of the range pass what the opponent could earn', () => {
    // The foe could hold T5–T8 at most: 4 territories (5) + East (+5) = 10 a turn. Its tracked 5 ÷ 0.1 would read 50.
    const g = buildGraph(line());
    const boards = turns(4, [leadingThin(10, 10), leadingThin(10, 12), leadingThin(10, 14)]);
    const plain = gameOutlook({ graph: g, me: ME, boards, game: { ...game, start } });
    expect(plain.turns.at(-1)!.income!.theirs.low).toBe(5);
    const o = gameOutlook({ graph: g, me: ME, boards, game: { ...game, start }, calibration: { '25-50': { geoMean: 0.1, n: 20 } } });
    const inc = o.turns.at(-1)!.income!;
    expect(inc.calibrated).toBe(true);
    expect(inc.theirs).toMatchObject({ low: 5, estimate: 10, high: 10 });
    // My 10 against a could-earn 10 is not behind, and no surrender line is crossed on an unreachable income.
    expect(inc.lean).not.toBe('behind');
    expect(o.surrenderLine?.crossed ?? false).toBe(false);
  });

  it('calibration deepens a deficit the tracked figure shows, never creates one: no behind lean or surrender turn on it alone', () => {
    // Me on T1–T3 with no West bonus (income 5) against the foe's tracked 5 under fog; past games read its band at 0.5×.
    const g = buildGraph(line(0, 0));
    const boards = turns(4, [leadingThin(10, 10), leadingThin(10, 12), leadingThin(10, 14)]);
    const o = gameOutlook({ graph: g, me: ME, boards, game: { ...game, start }, calibration: { '25-50': { geoMean: 0.5, n: 20 } } });
    const inc = o.turns.at(-1)!.income!;
    expect(inc).toMatchObject({ mine: 5, theirs: { low: 5, estimate: 10 }, calibrated: true });
    // Mine is under two-thirds of the calibrated 10 but not under the tracked 5: the two disagree, so unknown.
    expect(inc.ratio.estimate!).toBeLessThanOrEqual(INCOME_BEHIND_RATIO);
    expect(inc.lean).toBe('unknown');
    expect(inc.calibratedOnly).toBe(true);
    expect(o.surrenderLine).toBeUndefined();
    expect(o.basis).toMatch(/unknown: only the calibrated estimate reads behind/);
  });

  it('a calibrated estimate under the line counts when the tracked figure already shows me behind', () => {
    // The foe's T6 grows 7 a turn: tracked 7 against my 5 (behind, but above two-thirds); calibrated 10.
    const g = buildGraph(line(0, 0));
    const boards = turns(4, [leadingThin(10, 10), leadingThin(10, 17), leadingThin(10, 24)]);
    const o = gameOutlook({ graph: g, me: ME, boards, game: { ...game, start }, calibration: { '25-50': { geoMean: 0.7, n: 20 } } });
    const inc = o.turns.at(-1)!.income!;
    expect(inc).toMatchObject({ mine: 5, theirs: { low: 7, estimate: 10 }, calibrated: true, lean: 'behind' });
    expect(inc.calibratedOnly).toBeUndefined();
    expect(o.surrenderLine).toMatchObject({ crossed: false, turnsBelow: 2, calibrated: true });
  });

  it('gives a pace line: both incomes and their change per turn', () => {
    const grow = [trailing(10, 10), trailing(10, 10), board([mine(1, 10), mine(2, 10), mine(3, 2), neutral(4, 2), neutral(5, 2), foe(6, 10), foe(7, 10), foe(8, 10)])];
    const o = gameOutlook({ graph: buildGraph(line()), me: ME, boards: turns(4, grow), game });
    expect(o.pace).toMatchObject({ from: 4, to: 6, mine: { income: 10, perTurn: 2.5 }, theirs: { playerId: FOE, income: 10, perTurn: 0 } });
    expect(o.basis).toMatch(/Pace: my income 10 \(\+2\.5\/turn over turns 4–6\) against player 20's ~10 \(\+0\/turn\)/);
  });

  it('follows the trend: an even reading whose incomes head below the line reads behind', () => {
    // Me 10 → 10 → 10, the foe 10 → 12 → 14 (T5, then T4, each a +2 bonus): 0.71 now, ⅝ a turn on.
    const b = (t5: boolean, t4: boolean) =>
      board([mine(1, 10), mine(2, 10), mine(3, 10), t4 ? foe(4, 10) : neutral(4, 2), t5 ? foe(5, 10) : neutral(5, 2), foe(6, 10), foe(7, 10), foe(8, 10)]);
    const map = line(2);
    const big = buildGraph({ ...map, bonuses: [...map.bonuses, { id: 4, name: 'Five', value: 2, territoryIds: [5], bonusIds: [] }] });
    const o = gameOutlook({ graph: big, me: ME, boards: turns(4, [b(false, false), b(true, false), b(true, true)]), game });
    const inc = o.turns.at(-1)!.income!;
    expect(inc.ratio.estimate!).toBeGreaterThan(INCOME_BEHIND_RATIO);
    expect(inc.trend).toMatchObject({ mine: 0, theirs: 2 });
    expect(inc.lean).toBe('behind');
    expect(inc.byTrend).toBe(true);
  });
});
