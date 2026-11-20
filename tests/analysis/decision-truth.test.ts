// The end-of-game truth beside the decision log's estimates (#412 task 3), pure: every turn's truth from
// the full history (turn T on history board T − 1, the #318 calibration's alignment), each logged turn's
// accuracy and the game's summary. Synthetic map and boards only.
import { describe, expect, it } from 'vitest';
import { decisionTruth, estimateOff, ratioView, type LoggedTurn } from '../../src/analysis/decision-truth.js';
import { buildGraph } from '../../src/analysis/graph.js';
import type { BoardState, TerritoryState } from '../../src/board.js';
import type { GameMap } from '../../src/normalize.js';

const ME = 1001;
const FOE = 1002;

// A line 1-2-3-4-5-6, bonus 100 = {1,2} worth 3, bonus 200 = {5,6} worth 4.
const MAP: GameMap = {
  id: 77,
  name: 'line',
  territories: [1, 2, 3, 4, 5, 6].map((id) => ({ id, name: `t${id}`, connectedTo: [id - 1, id + 1].filter((n) => n >= 1 && n <= 6) })),
  bonuses: [
    { id: 100, name: 'west', value: 3, territoryIds: [1, 2], bonusIds: [] },
    { id: 200, name: 'east', value: 4, territoryIds: [5, 6], bonusIds: [] },
  ],
  distributionModes: [],
};
const G = buildGraph(MAP);
const SETTINGS = { minimumArmyBonus: 5, bonusArmyPer: 0 } as never;

const t = (territoryId: number, owner: number | 'neutral' | 'fog', armies: number | null): TerritoryState => ({
  territoryId,
  owner: owner === 'neutral' ? { kind: 'neutral' } : owner === 'fog' ? { kind: 'unknown' } : { kind: 'player', playerId: owner },
  armies,
  ...(owner === 'fog' ? { fogLevel: 'Fogged' } : {}),
});
const board = (...ts: TerritoryState[]): BoardState => ({ source: 'gamefeed', verified: false, territories: ts });

// The truth: I hold the west bonus (5 + 3 = 8), FOE the east one (5 + 4 = 9) with a big stack on 5.
const real = (n: number) => board(t(1, ME, 4 + n), t(2, ME, 3), t(3, 'neutral', 2), t(4, FOE, 2), t(5, FOE, 10 + n), t(6, FOE, 2));
// My fogged view of the same board: 5 and 6 hidden.
const view = (n: number) => board(t(1, ME, 4 + n), t(2, ME, 3), t(3, 'neutral', 2), t(4, FOE, 2), t(5, 'fog', null), t(6, 'fog', null));
const history = [0, 1, 2].map((n) => ({ turn: n, board: real(n) }));

const logged = new Map<number, LoggedTurn>([
  // Turn 2, played on history board 1: an estimate of 3 against a true 9 (under 0.5×).
  [2, { board: view(1), outlook: 'winning', estimates: [{ player: FOE, estimate: 3, source: 'tracked', coverage: 0.2, thin: true }], myIncome: 8 }],
  // Turn 3: 18 against 9 (over 1.5×).
  [3, { board: view(2), outlook: 'even', estimates: [{ player: FOE, estimate: 18, source: 'prior', coverage: 0.9, thin: false }], myIncome: 8 }],
]);

const run = (extra: Partial<Parameters<typeof decisionTruth>[0]> = {}) =>
  decisionTruth({
    graph: G,
    me: ME,
    opponents: [FOE],
    history,
    numberOfTurns: 3,
    incomeSettings: SETTINGS,
    plannerSettings: {},
    game: { players: [{ id: ME }, { id: FOE }] },
    logged,
    ...extra,
  });

describe('decisionTruth (#412 task 3)', () => {
  it('#437: a territory whose count did not read (a commander standing) is flagged, never a quiet undercount', () => {
    // Board 1: my 2 and FOE's 5 show an owner and no count on a board that hides nothing (where a commander stood).
    const commander = board(t(1, ME, 5), t(2, ME, null), t(3, 'neutral', 2), t(4, FOE, 2), t(5, FOE, null), t(6, FOE, 2));
    const r = run({ history: [{ turn: 0, board: real(0) }, { turn: 1, board: commander }, { turn: 2, board: real(2) }] });
    const truth = r.truth.get(2)!;
    expect(truth.mine).toEqual({ income: 8, armies: 5, territories: 2, armiesUnread: 1 });
    expect(truth.opponents[0]).toMatchObject({ armies: 4, armiesUnread: 1 });
    // A board that read whole carries no flag.
    expect(r.truth.get(1)!.mine).not.toHaveProperty('armiesUnread');
    expect(r.truth.get(1)!.opponents[0]).not.toHaveProperty('armiesUnread');
  });

  it('gives every turn of the game its truth from the board it was played on, logged or not', () => {
    const r = run();
    expect([...r.truth.keys()]).toEqual([1, 2, 3]);
    // Turn 1 was never logged (played in the web client, say): it still gets its truth.
    expect(r.truth.get(1)).toMatchObject({ board: 0, mine: { income: 8, territories: 2 } });
    expect(r.truth.get(2)!.opponents).toEqual([
      // Hidden: only the territories my logged board for turn 2 showed fogged, at their true armies on board 1.
      { player: FOE, income: 9, armies: 2 + 11 + 2, territories: 3, bonuses: [200], hidden: [[5, 11], [6, 2]] },
    ]);
    // A turn with no logged board hides nothing it can name.
    expect(r.truth.get(1)!.opponents[0]!.hidden).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it('scores each logged estimate against the true income, with its source, coverage and thin flag', () => {
    const r = run();
    expect(r.accuracy.get(2)!.estimates).toEqual([{ player: FOE, estimate: 3, truth: 9, ratio: 0.333333, source: 'tracked', coverage: 0.2, thin: true }]);
    expect(r.accuracy.get(3)!.estimates[0]).toMatchObject({ ratio: 2, source: 'prior' });
    // Only logged turns get an accuracy block.
    expect(r.accuracy.has(1)).toBe(false);
  });

  it('counts the fogged territories that hid an enemy stack at least my income', () => {
    const r = run();
    expect(r.accuracy.get(2)!.hiddenStacks).toBe(1); // 11 on 5 ≥ 8; 2 on 6 is not
    expect(r.accuracy.get(2)!.myIncome).toBe(8);
    expect(r.summary.turnsWithHiddenStacks).toBe(2);
  });

  it("compares the logged outlook with the true figures' outlook: right, wrong, or no verdict", () => {
    // Four boards of a steady game: neither side gains on the other, so once the outlook has its
    // OUTLOOK_TURNS (3) turns in a row the true figures read 'even' (turns 3 and 4); turn 2 has only two
    // boards behind it, so the truth gives no state there and no verdict.
    const longer = [0, 1, 2, 3].map((n) => ({ turn: n, board: real(n) }));
    const outlooks = new Map<number, LoggedTurn>([
      [2, { ...logged.get(2)!, outlook: 'winning' }],
      [3, { ...logged.get(3)!, outlook: 'even' }],
      [4, { board: view(3), outlook: 'losing', estimates: [], myIncome: 8 }],
    ]);
    const r = run({ history: longer, numberOfTurns: 4, logged: outlooks });
    expect(r.accuracy.get(2)!.outlook).toEqual({ logged: 'winning', truth: null, right: null });
    expect(r.accuracy.get(3)!.outlook).toEqual({ logged: 'even', truth: 'even', right: true });
    expect(r.accuracy.get(4)!.outlook).toEqual({ logged: 'losing', truth: 'even', right: false });
    expect(r.summary.outlook).toEqual({ right: 1, wrong: 1 });
  });

  it('summarises estimate ÷ truth overall, by coverage band and by source', () => {
    const { summary } = run();
    expect(summary.estimates).toMatchObject({ n: 2, under: 0.5, over: 0.5 });
    expect(summary.estimates!.mean).toBeCloseTo((1 / 3 + 2) / 2, 5);
    expect(summary.estimates!.geoMean).toBeCloseTo(Math.sqrt(2 / 3), 5);
    expect(Object.keys(summary.byCoverage).sort()).toEqual(['75-up', 'under-25']);
    expect(summary.bySource.tracked).toMatchObject({ n: 1, under: 1 });
    expect(summary.bySource.prior).toMatchObject({ n: 1, over: 1 });
    expect(summary.turns).toBe(3);
  });

  it('lists the turns the history itself lacks, never inventing a truth for them', () => {
    const r = run({ numberOfTurns: 5, history: history.filter((b) => b.turn !== 1) });
    expect(r.missing).toEqual([2, 4, 5]);
    expect(r.truth.has(2)).toBe(false);
    expect(r.accuracy.has(2)).toBe(false);
    expect(r.accuracy.has(3)).toBe(true);
  });

  it('is ids and numbers only, and deterministic', () => {
    const a = run();
    const b = run();
    expect(JSON.stringify([...a.truth, ...a.accuracy, a.summary])).toBe(JSON.stringify([...b.truth, ...b.accuracy, b.summary]));
  });

  it('flags an estimate off by more than 1.5× or under 0.5×', () => {
    const r = run();
    expect(estimateOff(r.accuracy.get(2))).toBe(true);
    expect(estimateOff({ estimates: [{ player: FOE, estimate: 9, truth: 9, ratio: 1, source: null, coverage: null, thin: false }], outlook: { logged: null, truth: null, right: null }, myIncome: 5, hiddenStacks: 0 })).toBe(false);
    expect(estimateOff(undefined)).toBe(false);
    expect(ratioView([])).toBeNull();
  });
});
