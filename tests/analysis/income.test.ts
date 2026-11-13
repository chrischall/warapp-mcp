// Issue #85: one income rule for every consumer, on a synthetic map whose bonuses overlap
// the way large "(hidden)"-bonus maps do: single-territory negative and positive bonuses,
// overlapping positive groups, a superbonus, a 0-value bonus, and bonus ids that are also
// territory ids. The expected numbers are hand-computed with war.app's client rule
// (docs/WARAPP-API.md "Income — overlapping, negative and superbonuses").

import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import { boardIncome, analyzePlayer } from '../../src/analysis/player.js';
import { enemyDeployEstimates, incomeFor, planTurn } from '../../src/analysis/planner.js';
import { normalizeMap, type GameSettings } from '../../src/normalize.js';
import { board, mine, neutral, overlapRawMap } from './helpers.js';

const ANN = 10;
const BOB = 20;

const g = buildGraph(normalizeMap(overlapRawMap()));
const settings: GameSettings = { cards: [], raw: {}, minimumArmyBonus: 5, bonusArmyPer: 0 };
const rules = { base: 5, per: 0 };
// Ann holds 1–5, Bob 6 and 7, 8 is neutral.
const state = board([mine(1, 3), mine(2, 3), mine(3, 3), mine(4, 3), mine(5, 6), mine(6, 4, BOB), mine(7, 4, BOB), neutral(8, 2)]);
const ANN_HELD = new Set([1, 2, 3, 4, 5]);
// war.app: base 5 (no per-territory armies), + positives 1 + 4 + 3 + 5 = 13, − negatives 2 + 1 = 3.
const ANN_INCOME = 5 + 13 - 3;

describe('boardIncome — the one income rule (#85)', () => {
  it('counts every fully held bonus once, negatives and superbonuses included', () => {
    const inc = boardIncome(g, ANN_HELD, rules);
    expect(inc.total).toBe(ANN_INCOME);
    expect(inc.base).toBe(5);
    expect(inc.perTerritory).toBe(0);
    expect(inc.bonuses.map((b) => [b.bonusId, b.value])).toEqual([
      [1, -2],
      [2, -1],
      [3, 1],
      [10, 4],
      [11, 3],
      [20, 5],
    ]);
  });

  it('reads a superbonus member id that is also a territory as the territory', () => {
    // Realm lists 3, which is territory 3 and bonus 3: as a territory it is already inside North.
    expect(g.bonusById.get(20)!.territoryIds).toEqual([3]);
    expect(g.bonusById.get(20)!.bonusIds).toEqual([10, 11]);
    // Holding 1–3 only completes North (and the hidden ones), not Realm or East.
    expect(boardIncome(g, new Set([1, 2, 3]), rules).total).toBe(5 - 2 - 1 + 1 + 4);
  });

  it('never goes below 0 (war.app zeroes the income when the negatives exceed it)', () => {
    expect(boardIncome(g, new Set([1, 2]), { base: 2, per: 0 }).total).toBe(0);
    expect(boardIncome(g, new Set([1]), { base: 2, per: 0 }).total).toBe(0);
  });

  it('per-territory armies replace the base when larger, then the bonuses apply', () => {
    // max(1, floor(5 / 1)) = 5, + 13 − 3.
    expect(boardIncome(g, ANN_HELD, { base: 1, per: 1 }).total).toBe(5 + 10);
    expect(boardIncome(g, ANN_HELD, { base: 1, per: 1 }).perTerritory).toBe(5);
  });

  it('a 0-value bonus is held but adds nothing', () => {
    const bob = boardIncome(g, new Set([6, 7]), rules);
    expect(bob.bonuses.map((b) => b.bonusId)).toEqual([13]);
    expect(bob.total).toBe(5);
  });
});

describe('every income consumer agrees on the overlapping-bonus map (#85)', () => {
  it('analyzePlayer, incomeFor (plan_turn and submit_turn) give the hand-computed income', () => {
    expect(analyzePlayer(g, state, ANN, settings).income.total).toBe(ANN_INCOME);
    expect(incomeFor(g, state, ANN, settings)).toBe(ANN_INCOME);
  });

  it("the enemy deploy estimate's base + bonuses is the same rule for the opponent", () => {
    const [bob] = enemyDeployEstimates(g, state, ANN, { baseIncome: 5, bonusArmyPer: 0 });
    expect(bob!.base + bob!.bonusIncome).toBe(boardIncome(g, new Set([6, 7]), rules).total);
  });

  it("the plan deploys exactly the income, and its next income is the rule applied to next turn's holdings", () => {
    const plan = planTurn({ graph: g, board: state, me: ANN, income: ANN_INCOME, settings: { baseIncome: 5, bonusArmyPer: 0 } });
    expect(plan.deploys.reduce((s, d) => s + d.armies, 0)).toBe(ANN_INCOME);
    const after = new Set([...ANN_HELD, ...plan.expected.captures]);
    expect(plan.expected.nextIncome).toBe(boardIncome(g, after, rules).total);
  });

  it("this turn's card armies are not carried into the next income", () => {
    const plan = planTurn({
      graph: g,
      board: state,
      me: ANN,
      income: ANN_INCOME + 7,
      cardArmies: 7,
      settings: { baseIncome: 5, bonusArmyPer: 0 },
    });
    expect(plan.deploys.reduce((s, d) => s + d.armies, 0)).toBe(ANN_INCOME + 7);
    const after = new Set([...ANN_HELD, ...plan.expected.captures]);
    expect(plan.expected.nextIncome).toBe(boardIncome(g, after, rules).total);
  });
});
