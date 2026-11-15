// PLAN-TEAMS C3: the planner with a teammate, on synthetic 2v2 boards (every id and name is made up).
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const MATE = 11;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const PLAYERS = [
  { id: ME, team: 0 },
  { id: MATE, team: 0 },
  { id: 20, team: 1 },
  { id: 21, team: 1 },
];

function lineMap(n: number): GameMap {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  return {
    id: 1,
    name: 'Line',
    territories: ids.map((id) => ({ id, name: `T${id}`, connectedTo: ids.filter((x) => Math.abs(x - id) === 1) })),
    bonuses: [],
    distributionModes: [],
  };
}
const player = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

describe("C3.1: a teammate's territory is no front for idle armies", () => {
  // 1 (enemy 20) ─ 2 (my teammate) ─ 3 4 5 6 (mine, 20 idle on 4) ─ 7 (a 60-army neutral).
  // No enemy is reachable through my territories, so idle armies head for the nearest territory
  // not mine: the teammate's 2 is two steps from 4, the neutral 7 three. A teammate's territory is
  // no front, so they head right, for the neutral.
  const g = buildGraph(lineMap(7));
  const b = board([player(1, 5, 20), player(2, 5, MATE), mine(3, 2), mine(4, 20), mine(5, 2), mine(6, 2), neutral(7, 60)]);
  const plan = planTurn({ graph: g, board: b, me: ME, income: 5, settings: STD, game: { players: PLAYERS, turn: 8 }, options: { adapt: true } });
  it('moves the idle stack toward the neutral, not toward the teammate', () => {
    const from4 = plan.moves.filter((m) => m.from === 4 && m.kind === 'transfer');
    expect(from4.map((m) => m.to)).toEqual([5]);
    expect(plan.moves.some((m) => m.to === 3 && m.kind === 'transfer')).toBe(false);
  });
  it('a no-team game still heads for the nearest territory not mine', () => {
    const solo = planTurn({
      graph: g,
      board: board([neutral(1, 5), neutral(2, 5), mine(3, 2), mine(4, 20), mine(5, 2), mine(6, 2), neutral(7, 60)]),
      me: ME,
      income: 5,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }], turn: 8 },
      options: { adapt: true },
    });
    expect(solo.moves.filter((m) => m.from === 4 && m.kind === 'transfer').map((m) => m.to)).toEqual([3]);
  });
});

describe("C3.2: the plan's standing sums my team", () => {
  // Me on 1–2, my teammate on 3–4 (a +6 bonus), neutral 5, player 20 on 6–7, player 21 on 8: all in view.
  const g = buildGraph({
    ...lineMap(8),
    bonuses: [{ id: 101, name: 'B101', value: 6, territoryIds: [3, 4], bonusIds: [] }],
  });
  const b = board([mine(1, 5), mine(2, 5), player(3, 5, MATE), player(4, 5, MATE), neutral(5, 2), player(6, 5, 20), player(7, 5, 20), player(8, 5, 21)]);
  it("counts my teammate's income on my side, and the enemy team's together", () => {
    const plan = planTurn({ graph: g, board: b, me: ME, income: 5, settings: { ...STD, baseIncome: 5 }, game: { players: PLAYERS, turn: 8 }, options: { adapt: true } });
    // My team 5 + 11 = 16 against team 1's 5 + 5 = 10: ahead (alone, 5 against 5 read even).
    expect(plan.profile?.standing).toBe('ahead');
    expect(plan.profile?.notes.join('\n')).toMatch(/my team's income 16 \(mine 5, player 11 ~11\) against the strongest enemy team, team 1 \(~10: player 20 ~5, player 21 ~5/);
  });
});

describe('C3.3: one owner per bonus', () => {
  // 1 2 (bonus 101, +3, neutrals) ─ 3 (mine, 12) ─ 4 (neutral) 5 (my teammate): bonus 102, +5 ─ 6 7 (neutrals) ─ 8 (player 20).
  // Bonus 102 pays whoever holds 4 and 5; my teammate holds 5, so it is not mine to complete.
  const g = buildGraph({
    ...lineMap(8),
    bonuses: [
      { id: 101, name: 'B101', value: 3, territoryIds: [1, 2], bonusIds: [] },
      { id: 102, name: 'B102', value: 5, territoryIds: [4, 5], bonusIds: [] },
    ],
  });
  const settings = { ...STD, baseIncome: 5 };
  const b = board([neutral(1, 2), neutral(2, 2), mine(3, 12), neutral(4, 2), player(5, 5, MATE), neutral(6, 2), neutral(7, 2), player(8, 5, 20)]);
  const plan = planTurn({ graph: g, board: b, me: ME, income: 5, settings, game: { players: PLAYERS, turn: 3 }, options: { adapt: true } });
  it("never works toward a bonus with my teammate's territory in it", () => {
    const text = plan.rationale.join('\n');
    expect(text).toMatch(/Skip bonus B102 \(#102\): my teammate holds T5 \(#5\)/);
    expect(text).not.toMatch(/B102 \(#102\) 11/);
    expect(plan.moves.some((m) => /advances bonus B102/.test(m.reason))).toBe(false);
    expect(plan.moves.some((m) => m.to === 2 && /advances bonus B101/.test(m.reason))).toBe(true);
  });
  it('ignores a focus on such a bonus, with a warning', () => {
    const focused = planTurn({
      graph: g,
      board: b,
      me: ME,
      income: 5,
      settings,
      game: { players: PLAYERS, turn: 3 },
      options: { adapt: true, focusBonusIds: [102] },
    });
    expect(focused.warnings.join('\n')).toMatch(/Focus on bonus B102 \(#102\) ignored: my teammate holds T5 \(#5\)/);
    expect(focused.moves.some((m) => /B102/.test(m.reason))).toBe(false);
  });
  it('reports no shared bonus when I hold none of it', () => {
    expect(plan.team).toBeUndefined();
  });
  it('reports each shared bonus and who is nearer to holding it', () => {
    // 102 grows to 3–5: I hold 3, my teammate 5 (tied, 4 neutral); 103 is 6–8 with my teammate on 6
    // and 7 and me on 8 (my teammate nearer); 104 (7 alone) is my teammate's only.
    const g2 = buildGraph({
      ...lineMap(9),
      bonuses: [
        { id: 102, name: 'B102', value: 5, territoryIds: [3, 4, 5], bonusIds: [] },
        { id: 103, name: 'B103', value: 4, territoryIds: [6, 7, 8], bonusIds: [] },
        { id: 104, name: 'B104', value: 2, territoryIds: [7], bonusIds: [] },
      ],
    });
    const b2 = board([neutral(1, 2), neutral(2, 2), mine(3, 12), neutral(4, 2), player(5, 5, MATE), player(6, 3, MATE), player(7, 3, MATE), mine(8, 4), player(9, 5, 20)]);
    const p2 = planTurn({ graph: g2, board: b2, me: ME, income: 5, settings, game: { players: PLAYERS, turn: 3 }, options: { adapt: true } });
    expect(p2.team?.sharedBonuses).toEqual([
      { bonusId: 102, value: 5, mine: [3], teammates: [{ player: MATE, territories: [5] }], others: [4], nearer: null },
      { bonusId: 103, value: 4, mine: [8], teammates: [{ player: MATE, territories: [6, 7] }], others: [], nearer: MATE },
    ]);
    // 103 has nothing left that I could attack, so it is skipped without a line.
    expect(p2.rationale.join('\n')).not.toMatch(/B103/);
  });
  it('a no-team game still works toward the bonus and reports no team', () => {
    const solo = planTurn({
      graph: g,
      board: board([neutral(1, 2), neutral(2, 2), mine(3, 12), neutral(4, 2), neutral(5, 2), neutral(6, 2), neutral(7, 2), player(8, 5, 20)]),
      me: ME,
      income: 5,
      settings,
      game: { players: [{ id: ME }, { id: 20 }], turn: 3 },
      options: { adapt: true },
    });
    expect(solo.moves.some((m) => /advances bonus B102|completes bonus B102/.test(m.reason))).toBe(true);
    expect(solo.team).toBeUndefined();
  });
});

/** My teammate's entered orders (V5), as the live board carries them. */
const entered = (
  orders: { deploys?: { territoryId: number; armies: number }[]; moves?: { from: number; to: number; armies: number; mode: 'attack' | 'transfer' | 'attack-transfer' }[] },
  playerId = MATE,
) => ({
  teammateOrders: [{ playerId, orders: { deploys: orders.deploys ?? [], moves: orders.moves ?? [], cards: [], discards: [], unread: [] }, picks: null }],
});
const graphOf = (territories: [number, number[]][], bonuses: GameMap['bonuses'] = []) =>
  buildGraph({ id: 1, name: 'M', territories: territories.map(([id, c]) => ({ id, name: `T${id}`, connectedTo: c })), bonuses, distributionModes: [] });

describe('C3.4: focus on the opponent my teammate attacks', () => {
  // 1 (mine) faces 2 (player 20, a +3 bonus) and 3 (player 21, a +3 bonus), equal in every way; 7 and 8
  // keep each opponent alive beyond them. My teammate on 5 faces player 21's 6.
  const g = graphOf(
    [[1, [2, 3, 4]], [2, [1, 7]], [3, [1, 8]], [4, [1, 5]], [5, [4, 6]], [6, [5]], [7, [2]], [8, [3]]],
    [
      { id: 201, name: 'B201', value: 3, territoryIds: [2], bonusIds: [] },
      { id: 202, name: 'B202', value: 3, territoryIds: [3], bonusIds: [] },
    ],
  );
  const settings = { ...STD, baseIncome: 5 };
  const at = (stack: number) =>
    board([mine(1, stack), player(2, 2, 20), player(3, 2, 21), mine(4, 3), player(5, 5, MATE), player(6, 3, 21), player(7, 2, 20), player(8, 2, 21)]);
  const plan = (stack: number, income: number, extra: object = {}, players: { id: number; team?: number }[] = PLAYERS) =>
    planTurn({ graph: g, board: { ...at(stack), ...extra }, me: ME, income, settings, game: { players, turn: 8 }, options: { adapt: true } });
  const attacks = (p: ReturnType<typeof plan>) => p.moves.filter((m) => m.kind === 'attack').map((m) => m.to);

  it('breaks the bonus of the opponent my teammate is attacking, of two equal breaks', () => {
    expect(attacks(plan(6, 8))).toEqual([2]);
    const focused = plan(6, 8, entered({ moves: [{ from: 5, to: 6, armies: 4, mode: 'attack-transfer' }] }));
    expect(attacks(focused)).toEqual([3]);
    expect(focused.rationale.join('\n')).toMatch(
      /Team focus \(PLAN-TEAMS C3\.4\): T3 \(#3\) \(player 21\) ranks above T2 \(#2\) \(player 20\), which is otherwise equal: my teammate \(player 11\) attacks player 21/,
    );
  });
  it('ranks the same way in the contact fallback (rule 4e), and says why', () => {
    expect(attacks(plan(4, 5))).toEqual([2]);
    const focused = plan(4, 5, entered({ moves: [{ from: 5, to: 6, armies: 4, mode: 'attack' }] }));
    expect(attacks(focused)).toEqual([3]);
    expect(focused.rationale.join('\n')).toMatch(/T2 \(#2\) is ranked after T3 \(#3\): they are otherwise equal, and my teammate attacks player 21 this turn/);
  });
  it('a transfer is no attack, and an unequal option still wins', () => {
    const transfer = plan(6, 8, entered({ moves: [{ from: 5, to: 4, armies: 4, mode: 'transfer' }] }));
    expect(attacks(transfer)).toEqual([2]);
    expect(transfer.rationale.join('\n')).not.toMatch(/Team focus/);
  });
  it("a no-team game never reads another player's orders", () => {
    const solo = plan(6, 8, entered({ moves: [{ from: 5, to: 6, armies: 4, mode: 'attack' }] }), [{ id: ME }, { id: MATE }, { id: 20 }, { id: 21 }]);
    expect(solo.rationale.join('\n')).not.toMatch(/Team focus/);
  });
});

describe("C3.5: support for a teammate's border (advisory)", () => {
  // 1 ─ 4 (mine, 12 idle: nothing to attack, no enemy beside it) ─ 5 (my teammate, 3) ─ 6 (player 20, 10) ─ 7 (player 21).
  const g = graphOf([[1, [4]], [4, [1, 5]], [5, [4, 6]], [6, [5, 7]], [7, [6]]]);
  const b = board([mine(1, 2), mine(4, 12), player(5, 3, MATE), player(6, 10, 20), player(7, 2, 21)]);
  const settings = { ...STD, baseIncome: 5 };
  const plan = (extra: object) => planTurn({ graph: g, board: { ...b, ...extra }, me: ME, income: 5, settings, game: { players: PLAYERS, turn: 8 }, options: { adapt: true } });
  const withMate = plan(entered({ deploys: [{ territoryId: 5, armies: 2 }] }));
  it('lists the border that falls given their deploys, and the idle armies of mine that make it hold', () => {
    // 5 holds 3 + 2 = 5 against player 20's 9 movable + ~5 deploy = 14: 9 hold, so 4 short; 4 has 17 idle.
    expect(withMate.team?.support).toEqual([{ territory: 5, teammate: MATE, armies: 5, threat: 14, player: 20, need: 4, from: [{ territory: 4, armies: 4 }] }]);
  });
  it('never puts it in the orders (a move onto a teammate is unverified, V7)', () => {
    expect(withMate.moves.some((m) => m.to === 5)).toBe(false);
    const without = plan({});
    expect(withMate.deploys).toEqual(without.deploys);
    expect(withMate.moves).toEqual(without.moves);
  });
  it('says nothing without their orders, or when their deploys hold it', () => {
    expect(plan({}).team).toBeUndefined();
    expect(plan(entered({ deploys: [{ territoryId: 5, armies: 8 }] })).team).toBeUndefined();
  });
  it("counts their orders out of the border, and finds no support my idle armies cannot give", () => {
    // Their attack out leaves 5 on 1: 14 short of holding against 14; 4's 17 idle still cover it.
    const out = plan(entered({ deploys: [{ territoryId: 5, armies: 2 }], moves: [{ from: 5, to: 6, armies: 4, mode: 'attack' }] }));
    expect(out.team?.support?.[0]).toMatchObject({ territory: 5, armies: 1, need: 8 });
    const thin = planTurn({
      graph: g,
      board: { ...board([mine(1, 2), mine(4, 2), player(5, 1, MATE), player(6, 30, 20), player(7, 2, 21)]), ...entered({}) },
      me: ME,
      income: 1,
      settings,
      game: { players: PLAYERS, turn: 8 },
      options: { adapt: true },
    });
    expect(thin.team?.support).toBeUndefined();
  });
});

describe("C3.5: support allots each of my idle armies once", () => {
  // 1 ─ 4 (mine, nothing to attack) ─ 5 and 8 (my teammate, 3 each) ─ 6 (player 20, 10) and 9 (player 21, 12).
  // 4 borders both of their borders: 5 needs 6 of my armies, 8 needs 8.
  const g = graphOf([[1, [4]], [4, [1, 5, 8]], [5, [4, 6]], [6, [5]], [8, [4, 9]], [9, [8]]]);
  const settings = { ...STD, baseIncome: 5 };
  const plan = (stack: number) =>
    planTurn({
      graph: g,
      board: { ...board([mine(1, 2), mine(4, stack), player(5, 3, MATE), player(6, 10, 20), player(8, 3, MATE), player(9, 12, 21)]), ...entered({}) },
      me: ME,
      income: 5,
      settings,
      game: { players: PLAYERS, turn: 8 },
      options: { adapt: true },
    });
  it('never offers the same idle armies to two borders: the one needing fewest first', () => {
    // 6 + 5 deployed = 11 on 4, 10 idle: 6 for 5 leaves 4, short of 8's 8.
    expect(plan(6).team?.support).toEqual([{ territory: 5, teammate: MATE, armies: 3, threat: 14, player: 20, need: 6, from: [{ territory: 4, armies: 6 }] }]);
  });
  it('offers both when the idle armies cover both', () => {
    // 10 + 5 = 15 on 4, 14 idle: 6 for 5 and 8 for 8.
    expect(plan(10).team?.support?.map((s) => [s.territory, s.from])).toEqual([
      [5, [{ territory: 4, armies: 6 }]],
      [8, [{ territory: 4, armies: 8 }]],
    ]);
  });
});

describe('C3.6: joint captures (advisory)', () => {
  // 4 (mine) and 5 (my teammate) both face player 20's 6 (20 armies); neither takes it alone.
  const g = graphOf([[1, [4]], [4, [1, 5, 6]], [5, [4, 6]], [6, [4, 5, 7]], [7, [6]]]);
  const settings = { ...STD, baseIncome: 5, luckModifier: 0, roundingMode: 'StraightRound' };
  const b = board([mine(1, 2), mine(4, 26), player(5, 16, MATE), player(6, 20, 20), player(7, 2, 21)]);
  const attack = entered({ deploys: [{ territoryId: 5, armies: 2 }], moves: [{ from: 5, to: 6, armies: 17, mode: 'attack-transfer' }] });
  const plan = (extra: object, moveOrder?: string) =>
    planTurn({
      graph: g,
      board: { ...b, ...extra },
      me: ME,
      income: 5,
      settings,
      game: { players: PLAYERS, turn: 8, ...(moveOrder ? { moveOrder } : {}) },
      options: { adapt: true },
    });
  it("resolves their entered attack with my idle armies, in both orders, on the turn simulator", () => {
    const p = plan(attack);
    expect(p.team?.jointCaptures).toEqual([
      {
        target: 6,
        owner: 20,
        teammate: [{ player: MATE, from: 5, armies: 17 }],
        mine: [{ from: 4, armies: 16 }],
        inPlan: false,
        cases: [
          { first: ME, captured: true, by: MATE, capturedIfReinforced: false },
          { first: MATE, captured: true, by: ME, capturedIfReinforced: false },
        ],
        exact: true,
      },
    ]);
    // Reported only: the plan's orders are the ones it makes without their orders.
    const without = plan({});
    expect(p.moves).toEqual(without.moves);
    expect(p.deploys).toEqual(without.deploys);
  });
  it('under a cyclic order says whose attack must go first (either, here)', () => {
    expect(plan(attack, 'Cycle').team?.jointCaptures?.[0]?.mustGoFirst).toBeNull();
    expect(plan(attack, 'Random').team?.jointCaptures?.[0]).not.toHaveProperty('mustGoFirst');
  });
  it('a target their attack takes alone is no joint capture', () => {
    const alone = plan(entered({ deploys: [{ territoryId: 5, armies: 30 }], moves: [{ from: 5, to: 6, armies: 45, mode: 'attack' }] }));
    expect(alone.team?.jointCaptures).toBeUndefined();
  });
});
