// #250 item 2 (as corrected by the play session): a tracked income set by one turn far above the
// turns before it is right more often than not — the first true reading after turns that deployed
// into the fog. The figure is never lowered for it; the tracker says, in numbers, why the high
// turn is believed (its armies in view plus its losses exceed what its earlier stacks and
// readings could have banked), or hedges when banked armies, or armies only now in view, could
// explain it.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { trackOpponents, type TurnBoard } from '../../src/analysis/opponents.js';
import type { PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

// My T1, T2; the enemy's T3 faces my T2 with every neighbour in view (T2, T4), so its growth there
// is a deploy, never a walk-in. T4 and T5 behind it; T6–T8 fogged, T8 a +70 bonus it could hold
// (it could earn 75 a turn).
const g = buildGraph({
  id: 1,
  name: 'Synthetic',
  territories: [1, 2, 3, 4, 5, 6, 7, 8].map((id) => {
    const edges: [number, number][] = [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 8],
    ];
    return {
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    };
  }),
  bonuses: [{ id: 901, name: 'Big', value: 70, territoryIds: [8], bonusIds: [] }],
  distributionModes: [],
} satisfies GameMap);

const enemy = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: ENEMY },
  armies,
});
const at = (t3: number, t4: TerritoryState = enemy(4, 2), t5: TerritoryState = enemy(5, 2)): BoardState =>
  board([mine(1, 5), mine(2, 5), enemy(3, t3), t4, t5, fogged(6), fogged(7), fogged(8)]);
const history = (...boards: [number, BoardState][]): TurnBoard[] => boards.map(([turn, b]) => ({ turn, board: b }));

describe('#250: a tracked income set by one high turn says why it is believed', () => {
  it('the live shape: +8, +5, then +66 with more in view than it could have banked: the income stays 66 and the warning says why', () => {
    const [t] = trackOpponents(g, history([7, at(20)], [8, at(28)], [9, at(33)], [10, at(99)]), ME, STD);
    expect(t!.turns.map((x) => x.observed)).toEqual([8, 5, 66]);
    expect(t!.income).toBe(66);
    expect(t!.incomeMethod).toBe('max-observed');
    expect(t!.incomeJump).toMatchObject({
      turn: 9,
      observed: 66,
      before: 8,
      since: 7,
      armiesBefore: 24,
      earnedSince: 18,
      armiesNow: 103,
      lossesSeen: 0,
      cameIntoView: 0,
      verdict: 'supported',
    });
    const line = t!.warnings.find((w) => /one turn/.test(w));
    expect(line).toMatch(/turn 9 \+66/);
    expect(line).toMatch(/103/);
    expect(line).toMatch(/24/);
    expect(line).toMatch(/18/);
    expect(line).toMatch(/by 61/);
    expect(line).toMatch(/could not have banked/);
    expect(t!.notes).toContain(line);
  });

  it('a stack it had in view before and lost from view since could explain the jump: hedged, the income unchanged', () => {
    // On turn 7 it showed 80 on T5; T5 is out of view after. The +66 on T3 still reads as deploy.
    const hidden = fogged(5);
    const [t] = trackOpponents(
      g,
      history([7, at(20, enemy(4, 2), enemy(5, 80))], [8, at(28, enemy(4, 2), hidden)], [9, at(33, enemy(4, 2), hidden)], [10, at(99, enemy(4, 2), hidden)]),
      ME,
      STD,
    );
    expect(t!.turns.map((x) => x.observed)).toEqual([8, 5, 66]);
    expect(t!.income).toBe(66);
    expect(t!.incomeJump).toMatchObject({ verdict: 'banked', armiesBefore: 102, earnedSince: 18, armiesNow: 101 });
    const line = t!.warnings.find((w) => /one turn/.test(w));
    expect(line).toMatch(/could be armies it had banked/);
    expect(line).toMatch(/101/);
    expect(line).toMatch(/120/);
    expect(line).not.toMatch(/could not have banked/);
  });

  it('only the armies that came into view since make it exceed: hedged as a possible reveal, the income unchanged', () => {
    // 80 on T5 on turn 7, out of view after; on turn 10 the fogged T6 shows 50: a reveal, never income.
    const hidden = fogged(5);
    const b10 = board([mine(1, 5), mine(2, 5), enemy(3, 99), enemy(4, 2), hidden, enemy(6, 50), fogged(7), fogged(8)]);
    const [t] = trackOpponents(
      g,
      history([7, at(20, enemy(4, 2), enemy(5, 80))], [8, at(28, enemy(4, 2), hidden)], [9, at(33, enemy(4, 2), hidden)], [10, b10]),
      ME,
      STD,
    );
    expect(t!.turns.map((x) => x.observed)).toEqual([8, 5, 66]);
    expect(t!.income).toBe(66);
    // 151 in view now > 102 + 18, but not without the 50 that came into view.
    expect(t!.incomeJump).toMatchObject({ verdict: 'reveal', armiesBefore: 102, earnedSince: 18, armiesNow: 151, cameIntoView: 50 });
    const line = t!.warnings.find((w) => /one turn/.test(w));
    expect(line).toMatch(/50 armies that came into view/);
    expect(line).toMatch(/could be old armies/);
    expect(line).not.toMatch(/could not have banked/);
  });

  it('a capture from a neutral in view on every board is no reveal: the big deploy then the attack is believed', () => {
    // T4 a neutral 2 in view on turns 7–10. +8, +5, then +65 on T3, which takes T4 with 78 and keeps 19.
    const n4 = neutral(4, 2);
    const [t] = trackOpponents(g, history([7, at(20, n4)], [8, at(28, n4)], [9, at(33, n4)], [10, at(19, enemy(4, 78))]), ME, STD);
    expect(t!.turns.map((x) => x.observed)).toEqual([8, 5, 65]);
    expect(t!.incomeJump).toMatchObject({ verdict: 'supported', armiesBefore: 22, armiesNow: 99, cameIntoView: 0 });
    const line = t!.warnings.find((w) => /one turn/.test(w));
    expect(line).toMatch(/could not have banked/);
    expect(line).not.toMatch(/could be old armies/);
    expect(line).not.toMatch(/came into view/);
  });

  it('a territory hidden on the first board of the evidence still counts as come into view, though held in view since', () => {
    // T4 hidden on turn 7, a neutral 2 in view on turns 8–9, then taken with 78: its armies may be old ones.
    const n4 = neutral(4, 2);
    const [t] = trackOpponents(
      g,
      history([7, at(20, fogged(4))], [8, at(28, n4)], [9, at(33, n4)], [10, at(19, enemy(4, 78))]),
      ME,
      STD,
    );
    expect(t!.incomeJump).toMatchObject({ verdict: 'reveal', cameIntoView: 78 });
    expect(t!.warnings.find((w) => /one turn/.test(w))).toMatch(/could be old armies/);
  });

  it('a territory out of view on a board between counts as come into view, though shown on the first', () => {
    // T4 a neutral 2 on turn 7, hidden on turn 8, a neutral again on turn 9, then taken with 78.
    const n4 = neutral(4, 2);
    const [t] = trackOpponents(
      g,
      history([7, at(20, n4)], [8, at(28, fogged(4))], [9, at(33, n4)], [10, at(19, enemy(4, 78))]),
      ME,
      STD,
    );
    expect(t!.incomeJump).toMatchObject({ verdict: 'reveal', cameIntoView: 78 });
  });

  it('with its starting armies known, the whole game weighs it: more than it could have had at the earlier rate is believed, whatever came into view', () => {
    // The reveal shape above, in a game where it started with 3 × 2 = 6: at 8 a turn through turn 9
    // it received at most 6 + 72 = 78, and it shows 151.
    const hidden = fogged(5);
    const b10 = board([mine(1, 5), mine(2, 5), enemy(3, 99), enemy(4, 2), hidden, enemy(6, 50), fogged(7), fogged(8)]);
    const boards = history([7, at(20, enemy(4, 2), enemy(5, 80))], [8, at(28, enemy(4, 2), hidden)], [9, at(33, enemy(4, 2), hidden)], [10, b10]);
    const players = [{ id: ME }, { id: ENEMY }];
    const [small] = trackOpponents(g, boards, ME, STD, { players, start: { territories: 3, armiesPerTerritory: 2 } });
    expect(small!.income).toBe(66);
    expect(small!.incomeJump).toMatchObject({
      verdict: 'supported',
      cameIntoView: 50,
      stock: { start: 6, rate: 8, turns: 9, received: 78, lossesAll: 0 },
    });
    const line = small!.warnings.find((w) => /one turn/.test(w));
    expect(line).toMatch(/at most 78 \(starting armies 6 \+ 8 × 9 turns\)/);
    expect(line).toMatch(/151, more by 73/);
    expect(line).toMatch(/could not have had at that rate/);
    // The earlier readings are lower bounds too: this proves some turn was higher, not the jump turn.
    expect(line).toMatch(/does not prove the high turn itself/);
    expect(line).not.toMatch(/Do not lower it/);
    // Started with 20 × 5 = 100: 100 + 72 = 172 covers the 151, so the reveal hedge stands.
    const [big] = trackOpponents(g, boards, ME, STD, { players, start: { territories: 20, armiesPerTerritory: 5 } });
    expect(big!.income).toBe(66);
    expect(big!.incomeJump).toMatchObject({ verdict: 'reveal', stock: { received: 172 } });
    expect(big!.warnings.join(' ')).toMatch(/could be old armies.*could have received up to 172 by turn 9 \(starting armies 100 \+ 8 × 9 turns\), enough for the 151/);
  });

  it('the whole-game rate is the most it was seen to earn on any turn before the jump, not only the two just before it', () => {
    // +30 on turn 4, then +8, +5, then +47 on turn 7. An 80 on T5 in view on turns 4–5 and out of
    // view after could explain the jump (112 in view against 132 + 18 banked). At 8 a turn the whole
    // game would read 6 + 8 × 7 = 62 against the 112 and call it believed; it was seen to earn 30 on
    // turn 4, and at 30 a turn 6 + 210 = 216 covers it: the hedge stands.
    const h = fogged(5);
    const [t] = trackOpponents(
      g,
      history(
        [4, at(20, enemy(4, 2), enemy(5, 80))],
        [5, at(50, enemy(4, 2), enemy(5, 80))],
        [6, at(58, enemy(4, 2), h)],
        [7, at(63, enemy(4, 2), h)],
        [8, at(110, enemy(4, 2), h)],
      ),
      ME,
      STD,
      { players: [{ id: ME }, { id: ENEMY }], start: { territories: 3, armiesPerTerritory: 2 } },
    );
    expect(t!.turns.map((x) => x.observed)).toEqual([30, 8, 5, 47]);
    expect(t!.income).toBe(47);
    expect(t!.incomeJump).toMatchObject({
      turn: 7,
      before: 8,
      since: 5,
      armiesBefore: 132,
      armiesNow: 112,
      verdict: 'banked',
      stock: { start: 6, rate: 30, turns: 7, received: 216 },
    });
    const line = t!.warnings.find((w) => /one turn/.test(w));
    expect(line).toMatch(/could be armies it had banked/);
    expect(line).toMatch(/\(30 a turn\) it could have received up to 216/);
    expect(line).not.toMatch(/could not have had/);
  });

  it('growth beside the fog read as deploy on the jump turn may be a stack walking out of it: hedged, never believed on it alone', () => {
    // +30 on turn 4 carries a bound of 60, so on turn 7 the 40 that appear on T5 (beside the fogged
    // T6) read as deploy: +45, low +5. All 40 could be a stack out of the fog: 112 in view, less
    // those 40, is no more than the 54 it had on turn 5 plus the 18 it was seen to earn since.
    const evidence = (t5: number) =>
      trackOpponents(
        g,
        history([4, at(20)], [5, at(50)], [6, at(58)], [7, at(63)], [8, at(68, enemy(4, 2), enemy(5, t5))]),
        ME,
        STD,
      )[0]!;
    for (const [t5, observed] of [
      [42, 45],
      [57, 60],
    ] as const) {
      const t = evidence(t5);
      expect(t.turns.map((x) => x.observed)).toEqual([30, 8, 5, observed]);
      expect(t.turns.at(-1)).toMatchObject({ low: 5, high: observed });
      expect(t.income).toBe(observed);
      expect(t.incomeJump).toMatchObject({ turn: 7, ambiguous: t5 - 2, low: 5, high: observed });
      expect(t.incomeJump!.verdict).not.toBe('supported');
      expect(t.incomeJump!.cameIntoView).toBeGreaterThanOrEqual(t5 - 2);
      const line = t.warnings.find((w) => /one turn/.test(w))!;
      expect(line).toMatch(new RegExp(`turn 7 reads \\+5 to \\+${observed}`, 'i'));
      expect(line).not.toMatch(/could not have banked/);
      expect(line).not.toMatch(/Do not lower it/);
    }
  });

  it('a stack in view on the first board of the evidence, out of view between and back after, counts only what it gained as come into view', () => {
    // 80 on T5 on turn 7 (in the armies it had then), hidden on turns 8–9, 80 again on turn 10: no
    // reveal, so 99 + 2 + 80 = 181 against 102 + 18 is believed. At 100 the 20 more may be a reveal.
    const hidden = fogged(5);
    const evidence = (t5: number) =>
      trackOpponents(
        g,
        history(
          [7, at(20, enemy(4, 2), enemy(5, 80))],
          [8, at(28, enemy(4, 2), hidden)],
          [9, at(33, enemy(4, 2), hidden)],
          [10, at(99, enemy(4, 2), enemy(5, t5))],
        ),
        ME,
        STD,
      )[0]!;
    const back = evidence(80);
    expect(back.incomeJump).toMatchObject({ verdict: 'supported', armiesBefore: 102, armiesNow: 181, cameIntoView: 0 });
    expect(back.warnings.find((w) => /one turn/.test(w))).toMatch(/could not have banked/);
    expect(evidence(100).incomeJump).toMatchObject({ armiesNow: 201, cameIntoView: 20 });
  });

  it('names the part of the jump that stands on territory it took from me', () => {
    // +8, +5, then on turn 9 it deploys on T3 and takes my T2 (5 armies, my orders unknown): 70 stand there.
    const b10 = board([mine(1, 5), enemy(2, 70), enemy(3, 19), enemy(4, 2), enemy(5, 2), fogged(6), fogged(7), fogged(8)]);
    const [t] = trackOpponents(g, history([7, at(20)], [8, at(28)], [9, at(33)], [10, b10]), ME, STD);
    expect(t!.incomeJump?.fromMe).toMatchObject({ territories: [2], armies: 70, guardPriced: true });
    const line = t!.warnings.find((w) => /one turn/.test(w));
    expect(line).toMatch(/70 of them on territory 2, taken from me on turn 9/);
    expect(line).toMatch(/priced at the guard I may have left/);
  });

  it('carried after the window moves on (no decay, #119): the line still names the turn that set it', () => {
    const [t] = trackOpponents(
      g,
      history([7, at(20)], [8, at(28)], [9, at(33)], [10, at(99)], [11, at(99)], [12, at(99)], [13, at(99)]),
      ME,
      STD,
    );
    expect(t!.income).toBe(66);
    expect(t!.incomeMethod).toBe('carried');
    expect(t!.incomeJump).toMatchObject({ turn: 9, verdict: 'supported', since: 7 });
    expect(t!.warnings.join(' ')).toMatch(/~66\/turn rests on one turn: turn 9 \+66/);
  });

  it('no jump: a steady reading, or a high turn under twice the turns before it, adds no line', () => {
    const [steady] = trackOpponents(g, history([7, at(20)], [8, at(28)], [9, at(36)], [10, at(44)]), ME, STD);
    expect(steady!.incomeJump).toBeUndefined();
    expect(steady!.warnings.join(' ')).not.toMatch(/one turn/);
    const [twice] = trackOpponents(g, history([7, at(20)], [8, at(28)], [9, at(33)], [10, at(49)]), ME, STD);
    expect(twice!.income).toBe(16);
    expect(twice!.incomeJump).toBeUndefined();
  });

  it('a jump on the first observed turn has no turn before it to stand out from: no line', () => {
    const [t] = trackOpponents(g, history([9, at(33)], [10, at(99)]), ME, STD);
    expect(t!.incomeJump).toBeUndefined();
  });
});
