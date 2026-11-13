// Issue #102: once rule 0p.3c builds a strike stack in a 1v1, the plan spends it. Every turn the
// stack attacks each adjacent enemy territory it can take at the plan's win chance — breaking or
// retaking a bonus first, then by bonus value, then cheapest — while keeping what holds it
// against the threat left after those attacks. It only grows (deploy, no attack) when nothing in
// reach is worth taking, and the rationale says which. Every map, id and name here is made up.
// Kill rates 60/70, no luck: armiesToTake 5:8 9:15 (holdArmies(t) = fewest a with take(a) > t).
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import type { OpponentTrack } from '../../src/analysis/opponents.js';
import { captureCost, planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, fogged, mine, neutral, ruleAttacks } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const THIRD = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  return {
    id: 1,
    name: 'Synthetic strike',
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
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const why = (p: TurnPlan) => p.rationale.join('\n');

/** A track observed over two turns with `income`. */
function track(playerId: number, income: number, visibleIncome = 5): OpponentTrack {
  const turn = { from: 0, to: 1, observed: income, raw: income, cap: income, counted: [], captured: [], fromFog: [], reveals: [], visibleIncome, earned: income, net: 0, losses: 0, fogArmies: 0, measured: 0, broken: [], brokenValue: 0 };
  return {
    playerId,
    firstSeen: 1,
    lastTurn: 3,
    turns: [
      { ...turn, from: 1, to: 2 },
      { ...turn, from: 2, to: 3 },
    ],
    base: visibleIncome,
    bonusIncome: 0,
    visibleIncome,
    income,
    incomeTurns: [1, 2],
    observedRange: { min: income, max: income },
    incomeMethod: 'max-observed',
    incomeLowered: 0,
    unaccounted: 0,
    visible: 1,
    turnsUnseen: 0,
    turnsUnseenAtLeast: false,
    earnedAtLeast: null,
    warnings: [],
    inferred: null,
    notes: [],
  };
}

/** The plan passes warapp_submit_turn's validator (it throws on a refusal). */
function valid(input: PlanInput, p: TurnPlan) {
  const map = input.graph.map;
  const names = new Map(map.territories.map((t) => [t.id, t.name]));
  const ref = (id: number) => ({ id, name: names.get(id)! });
  validateTurn({
    map,
    board: input.board.territories.map(
      (t): LiveTerritory => ({
        territoryId: t.territoryId,
        fogLevel: t.armies === null ? 4 : 1,
        fogged: t.armies === null,
        owner: t.owner.kind === 'player' ? t.owner.playerId : t.owner.kind === 'neutral' ? OWNER_NEUTRAL : -1,
        armies: t.armies,
      }),
    ),
    myInGameId: ME,
    income: input.income,
    guard: true,
    deploys: p.deploys.map((d) => ({ territory: ref(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: ref(m.from), to: ref(m.to), armies: m.armies })),
  });
}

// The #102 shape. My strike stack T1 (80) faces the opponent's T2 (9) and T3 (5) — two of the
// three members of B500 (+5: T2, T3, fogged T4), which I held in full last turn — and its
// 40-stack on T5. Behind on income: 22 against a tracked 56. After deploying the 22, the stack
// holds 102 (101 movable); the threat after taking T2 and T3 is T5's 39 movable + 56 = 95,
// which 58 hold. T2 costs 15 and T3 8: both fall, and 79 stay.
describe('the strike stack attacks what it can take (#102)', () => {
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6],
      [
        [1, 2],
        [1, 3],
        [1, 5],
        [2, 4],
        [3, 4],
        [5, 6],
      ],
      [[500, 5, [2, 3, 4]]],
    ),
  );
  const now = board([mine(1, 80), enemy(2, 9), enemy(3, 5), fogged(4), enemy(5, 40), fogged(6)]);
  const before = board([mine(1, 60), mine(2, 3), mine(3, 3), mine(4, 3), enemy(5, 40), fogged(6)]);
  const input = (over: Partial<PlanInput> = {}): PlanInput => ({
    graph: g,
    board: now,
    previousBoard: before,
    me: ME,
    income: 22,
    settings: STD,
    tracks: [track(ENEMY, 56)],
    game: { players: [{ id: ME }, { id: ENEMY }] },
    options: { adapt: true },
    ...over,
  });

  it('attacks both members of the bonus it just lost, sized, and the stack keeps its hold', () => {
    const p = planTurn(input());
    expect(p.profile).toMatchObject({ format: '1v1', standing: 'behind' });
    expect(captureCost(9, STD)).toBe(15);
    expect(captureCost(5, STD)).toBe(8);
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 22 }]);
    // Both retake B500 (+5): the cheaper first. T5's 40-stack is not attacked: taking it (66)
    // would leave 13, below the 35 that hold against the opponent's ~56 deploy alone (orders
    // interleave, so it may land that deploy on T5 before the attack).
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([
      [1, 3, 8],
      [1, 2, 15],
    ]);
    expect(p.expected.captures).toEqual([2, 3]);
    expect(why(p)).toMatch(/Attack T2 \(#2\) from the strike stack T1 \(#1\) with 15 \(win chance 100%\): toward retaking bonus B500 \(#500\) \(\+5\), which I held last turn/);
    expect(why(p)).toMatch(/the stack keeps 79, enough to hold against the ~95 threat after the attacks \(needs 58\)/);
    expect(p.offence).toContainEqual(expect.objectContaining({ target: 2, kind: 'strike-attack', cost: 15, value: 5, taken: true }));
    expect(p.offence).toContainEqual(expect.objectContaining({ target: 3, kind: 'strike-attack', cost: 8, value: 5, taken: true }));
    // The stack entry reports a move this turn, not a bare `taken: true`.
    const entry = p.offence.find((o) => o.kind === 'strike' && o.target === 1)!;
    expect(entry).toMatchObject({ taken: true, cost: 22 });
    expect(entry.why).toMatch(/attacks T3 \(#3\), T2 \(#2\) this turn/);
    const t5 = p.offence.find((o) => o.kind === 'strike-attack' && o.target === 5)!;
    expect(t5).toMatchObject({ cost: 66, taken: false });
    expect(t5.why).toMatch(/would leave the stack 13, below the 35 that hold it against the ~56 threat after the attacks/);
    valid(input(), p);
  });

  it('a break or retake goes before a plain capture, even a cheaper one', () => {
    // T5 now holds 4 (cost 6, cheaper than both), but taking it breaks or retakes no bonus. The
    // stack can afford all three (73 stay, 35 hold against the ~56 deploy alone): T3 and T2 still
    // come first in the orders.
    const p = planTurn(input({ board: board([mine(1, 80), enemy(2, 9), enemy(3, 5), fogged(4), enemy(5, 4), fogged(6)]) }));
    expect(attacks(p).map((m) => [m.to, m.armies])).toEqual([
      [3, 8],
      [2, 15],
      [5, 6],
    ]);
    expect(p.offence).toContainEqual(expect.objectContaining({ target: 5, kind: 'strike-attack', value: 0, taken: true }));
  });

  it('FFA: no strike stack, so nothing changes', () => {
    const ffa = input({ game: { players: [{ id: ME }, { id: ENEMY }, { id: THIRD }] } });
    const p = planTurn(ffa);
    expect(p.profile.format).toBe('ffa');
    expect(ruleAttacks(p).filter((m) => m.from === 1 && (m.to === 2 || m.to === 3))).toEqual([]);
    expect(why(p)).not.toMatch(/strike stack/);
    expect(p.offence.filter((o) => o.kind.startsWith('strike'))).toEqual([]);
  });

  it('without adapting: no strike stack, so nothing changes', () => {
    const p = planTurn(input({ options: {} }));
    expect(ruleAttacks(p)).toEqual([]);
    expect(p.offence.filter((o) => o.kind.startsWith('strike'))).toEqual([]);
  });
});

// Nothing adjacent worth taking: my stack T1 (30) faces only the opponent's T2 (40). Taking T2
// needs 66, more than the 39 the stack can send; it grows instead, and the rationale and the
// stack entry say so.
describe('the strike stack grows when nothing in reach is worth taking', () => {
  const g = buildGraph(makeMap([1, 2, 3], [[1, 2], [2, 3]]));
  const input: PlanInput = {
    graph: g,
    board: board([mine(1, 30), enemy(2, 40), enemy(3, 5)]),
    me: ME,
    income: 10,
    settings: STD,
    tracks: [track(ENEMY, 20)],
    game: { players: [{ id: ME }, { id: ENEMY }] },
    options: { adapt: true },
  };

  it('deploys to the stack, attacks nothing, and says why', () => {
    const p = planTurn(input);
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 10 }]);
    expect(attacks(p)).toEqual([]);
    expect(why(p)).toMatch(/Grow the strike stack T1 \(#1\): nothing next to it is worth taking this turn \(T2 \(#2\): it needs 66, more than the 39 the stack can send\)/);
    const entry = p.offence.find((o) => o.kind === 'strike' && o.target === 1)!;
    expect(entry.taken).toBe(false);
    expect(entry.why).toMatch(/it grows: nothing next to it is worth taking this turn/);
    valid(input, p);
  });
});

// A target that would leave the stack below its hold is not attacked. T1 (40) + 10 = 50 faces
// T2 (5) and T5 (51). Taking T2 (8) leaves 42; the threat left is T5's 50 + 20 = 70, which needs
// 43. So T2 is not attacked, and its strike entry says why.
describe('the strike stack keeps its hold', () => {
  const g = buildGraph(makeMap([1, 2, 5, 6], [[1, 2], [1, 5], [5, 6]]));
  const input: PlanInput = {
    graph: g,
    board: board([mine(1, 40), enemy(2, 5), enemy(5, 51), neutral(6, 2)]),
    me: ME,
    income: 10,
    settings: STD,
    tracks: [track(ENEMY, 20)],
    game: { players: [{ id: ME }, { id: ENEMY }] },
    options: { adapt: true },
  };

  it('does not attack a target that would leave the stack below its hold', () => {
    const p = planTurn(input);
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 10 }]);
    expect(attacks(p)).toEqual([]);
    const t2 = p.offence.find((o) => o.kind === 'strike-attack' && o.target === 2)!;
    expect(t2).toMatchObject({ taken: false, cost: 8 });
    expect(t2.why).toMatch(/would leave the stack 42, below the 43 that hold it against the ~70 threat after the attacks/);
    valid(input, p);
  });

  it('with a smaller threat it attacks, until the hold binds', () => {
    // T5 (30): taking T2 leaves 42 against T5's 29 + 20 = 49 (needs 30). T5 itself (50) is more
    // than the 41 the stack can still send.
    const calm = { ...input, board: board([mine(1, 40), enemy(2, 5), enemy(5, 30), neutral(6, 2)]) };
    const p = planTurn(calm);
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([[1, 2, 8]]);
    valid(calm, p);
  });
});

// Rule 4c across the strike: two targets that complete a negative bonus only together. My stack
// T1 (80) faces the opponent's T2 (2) and T3 (2) (its 30-stack T5 sits behind T2); B900 (-3) is
// T2, T3 and my T7. Each capture alone keeps income; both lower it by 3. The stack takes T2 (the
// lower id at equal cost) and refuses T3 with a reason.
describe('the strike stack never lowers income, even jointly', () => {
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 5, 7, 8],
      [
        [1, 2],
        [1, 3],
        [2, 5],
        [2, 7],
        [3, 7],
        [7, 8],
      ],
      [[900, -3, [2, 3, 7]]],
    ),
  );
  const input: PlanInput = {
    graph: g,
    board: board([mine(1, 80), enemy(2, 2), enemy(3, 2), enemy(5, 30), mine(7, 1), neutral(8, 2)]),
    me: ME,
    income: 10,
    settings: STD,
    tracks: [track(ENEMY, 40)],
    game: { players: [{ id: ME }, { id: ENEMY }] },
    options: { adapt: true },
  };

  it('takes one member and refuses the one that would complete the negative bonus', () => {
    const p = planTurn(input);
    expect(p.expected.bonusesCompleted).not.toContain(900);
    expect(p.expected.nextIncome).toBe(10);
    expect(attacks(p).filter((m) => m.from === 1).map((m) => m.to)).toEqual([2]);
    const t3 = p.offence.find((o) => o.kind === 'strike-attack' && o.target === 3)!;
    expect(t3.taken).toBe(false);
    expect(t3.why).toMatch(/lowers next income: it completes negative bonus B900 \(#900\) \(-3\) \(rule 4c\)/);
    valid(input, p);
  });
});

// A stack that got no deploys still attacks. Under Local Deployment all 3 income is B700's pool
// (+3, my interior T8), which can go nowhere else; the stack T1 (60) gets none and still takes the
// adjacent T2 (5): with 18, sized for its 5 defenders plus the opponent's ~6 deploy landing there
// first (#120). Its own offence entry reports the attack at cost 0.
describe('a strike stack with no deploys this turn is still spent', () => {
  const g = buildGraph(makeMap([1, 2, 8, 9], [[1, 2], [1, 8], [2, 9]], [[700, 3, [8]]]));
  const input: PlanInput = {
    graph: g,
    board: board([mine(1, 60), enemy(2, 5), mine(8, 3), enemy(9, 4)]),
    me: ME,
    income: 3,
    settings: { ...STD, localDeployments: true },
    tracks: [track(ENEMY, 6)],
    game: { players: [{ id: ME }, { id: ENEMY }] },
    options: { adapt: true },
  };

  it('attacks from the stack and reports its entry with cost 0', () => {
    const p = planTurn(input);
    expect(p.deploys).toEqual([{ territoryId: 8, armies: 3 }]);
    expect(attacks(p).filter((m) => m.from === 1).map((m) => [m.to, m.armies])).toEqual([[2, 18]]);
    expect(p.offence.find((o) => o.kind === 'strike' && o.target === 1)).toMatchObject({ taken: true, cost: 0 });
    valid(input, p);
  });
});

// Labels: only the first member of an opponent's bonus to fall this turn breaks it. B600 (+4) is
// the opponent's T2 (2) and T3 (3), both next to my stack T1 (80): the break step takes T2, and the
// stack's T3 is a plain capture, not a second "breaks". A retake that cannot finish this turn is
// "toward retaking" (the #102 shape above).
describe('strike effect labels do not overstate', () => {
  const g = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [1, 3], [2, 4], [3, 4]], [[600, 4, [2, 3]]]));
  const input: PlanInput = {
    graph: g,
    board: board([mine(1, 80), enemy(2, 2), enemy(3, 3), fogged(4)]),
    me: ME,
    income: 10,
    settings: STD,
    tracks: [track(ENEMY, 40)],
    game: { players: [{ id: ME }, { id: ENEMY }] },
    options: { adapt: true },
  };

  it('only the first member taken breaks the bonus', () => {
    const p = planTurn(input);
    expect(p.expected.captures).toEqual([2, 3]);
    expect(p.moves.filter((m) => /breaks .*B600/.test(m.reason))).toHaveLength(1);
    const t3 = p.offence.find((o) => o.kind === 'strike-attack' && o.target === 3)!;
    expect(t3).toMatchObject({ taken: true, value: 0 });
    expect(t3.why).toMatch(/takes an adjacent enemy territory/);
    valid(input, p);
  });
});

// Holds take all the income: the stack still attacks. My stack T1 (80) faces the opponent's T2 (9)
// and T3 (5), two members of its B500 (+3: T2, T3, T4). My B700 (+5: T7, T9, 4 each) faces its T8 (4),
// and the 8 income all go to holding T7 and T9 (4 each). The break step takes T3; T2 still falls from the
// stack with no leftover deployed on it, and the rationale says the stack got none. Both are sized
// for the opponent's ~8 deploy landing there first (#120): T2 with 28 (9 + 8), not 15.
describe('a strike stack is spent even when holds take all the income', () => {
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 7, 8, 9],
      [
        [1, 2],
        [1, 3],
        [2, 4],
        [3, 4],
        [7, 8],
        [9, 8],
        [7, 9],
      ],
      [
        [500, 3, [2, 3, 4]],
        [700, 5, [7, 9]],
      ],
    ),
  );
  const input = (income: number): PlanInput => ({
    graph: g,
    board: board([mine(1, 80), enemy(2, 9), enemy(3, 5), enemy(4, 3), mine(7, 4), enemy(8, 4), mine(9, 4)]),
    me: ME,
    income,
    settings: STD,
    tracks: [track(ENEMY, income)],
    game: { players: [{ id: ME }, { id: ENEMY }] },
    options: { adapt: true },
  });

  it('attacks T2 from the stack at 8 income as at 11', () => {
    for (const income of [8, 11]) {
      const p = planTurn(input(income));
      expect(p.profile.format).toBe('1v1');
      expect(attacks(p).filter((m) => m.from === 1).map((m) => m.to).sort()).toEqual([2, 3]);
      valid(input(income), p);
    }
    const p = planTurn(input(8));
    expect(p.deploys.find((d) => d.territoryId === 1)).toBeUndefined();
    expect(why(p)).toMatch(/Attack T2 \(#2\) from the strike stack T1 \(#1\) with 28 \(win chance 100% — sized for its 9 defenders plus the ~8 player 20 may deploy there first \(15 would take it as it stands\)\)/);
    expect(why(p)).toMatch(/No leftover reaches the strike stack T1 \(#1\)/);
    expect(p.offence.find((o) => o.kind === 'strike' && o.target === 1)).toMatchObject({ taken: true, cost: 0 });
  });
});

// A stack with no deploys whose strike leaves it interior keeps what it holds. Under Local
// Deployment all 3 income is B700's pool (my T8); the stack T1 (60) takes the opponent's T2 (5),
// after which T1 sits two steps from the front (T2 faces T9, my T5 faces T6). The transfer step
// must not walk the 44 the rationale says "the stack keeps" over to T5. The attack is sized for
// T2's 5 defenders plus the opponent's ~5 deploy (#120): 16.
describe('a strike stack the strike leaves interior keeps its armies', () => {
  const g = buildGraph(
    makeMap(
      [1, 2, 5, 6, 8, 9],
      [
        [1, 2],
        [1, 8],
        [2, 9],
        [1, 5],
        [5, 6],
      ],
      [[700, 3, [8]]],
    ),
  );
  const input: PlanInput = {
    graph: g,
    board: board([mine(1, 60), enemy(2, 5), mine(5, 20), enemy(6, 4), mine(8, 3), enemy(9, 4)]),
    me: ME,
    income: 3,
    settings: { ...STD, localDeployments: true },
    tracks: [track(ENEMY, 5)],
    game: { players: [{ id: ME }, { id: ENEMY }] },
    options: { adapt: true },
  };

  it('attacks from the stack and transfers nothing out of it', () => {
    const p = planTurn(input);
    expect(attacks(p).filter((m) => m.from === 1).map((m) => [m.to, m.armies])).toEqual([[2, 16]]);
    expect(why(p)).toMatch(/the stack keeps 44/);
    expect(p.moves.filter((m) => m.from === 1 && m.kind === 'transfer')).toEqual([]);
    valid(input, p);
  });
});
