// Issue #104: in a several-player opening, with 5 income and every adjacent neutral at 4 or
// 12, every bonus failed the economy test, so the plan deployed everything to one stack and
// attacked nothing. In the opening and expansion phases — or whenever my armies exceed the
// game's army cap — a plan that would make no capture at all takes the cheapest affordable
// neutral capture toward the bonus with the fewest armies to finish, with armies left after
// every hold. Synthetic maps only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { armiesToTake, straightKills } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { incomeUncertainties } from '../../src/analysis/player.js';
import { planTurn, type PlanGameContext, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap, GameSettings } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const P2 = 30;
const P3 = 40;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const FFA: PlanGameContext = { players: [{ id: ME }, { id: P2 }, { id: P3 }, { id: 50 }], turn: 2 };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, string, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'StandStill',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, name, value, territoryIds]) => ({ id, name, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const player = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

//   My stack on 1 borders four neutrals: 3 (4, Ridge), 4 (4, Vale), 5 (12, Vale), 10 (12, Marsh).
//   2 is mine too, next to 6 (12, Vale) and, in some boards, an enemy on 22.
//   Ridge (+2): 3 7 8 9 — 6 + 3 × 20 = 66 to finish.
//   Vale  (+2): 4 5 6   — 6 + 2 × 20 = 46 to finish: the cheapest bonus.
//   Marsh (+3): 10 11 12 — 3 × 20 = 60 to finish.
//   Every one is uneconomic (over 10 × its value, or one member over 5 × its value).
//   Other players sit far away on 20 and 21.
const EDGES: [number, number][] = [
  [1, 2], [1, 3], [1, 4], [1, 5], [1, 10], [2, 6], [4, 5], [5, 6],
  [3, 7], [7, 8], [8, 9], [10, 11], [11, 12], [9, 20], [12, 21], [2, 22],
];
const IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 20, 21, 22];
const BONUSES: [number, string, number, number[]][] = [
  [201, 'Ridge', 2, [3, 7, 8, 9]],
  [202, 'Vale', 2, [4, 5, 6]],
  [203, 'Marsh', 3, [10, 11, 12]],
];
const MAP = makeMap(IDS, EDGES, BONUSES);
const g = buildGraph(MAP);

// 22 is out of sight unless a board puts an enemy there.
const far = [player(20, 5, P2), player(21, 5, P3)];
const opening = (stack = 11, extra: TerritoryState[] = []): BoardState =>
  board([
    mine(1, stack),
    mine(2, 1),
    neutral(3, 4),
    neutral(4, 4),
    neutral(5, 12),
    neutral(6, 12),
    neutral(7, 12),
    neutral(8, 12),
    neutral(9, 12),
    neutral(10, 12),
    neutral(11, 12),
    neutral(12, 12),
    ...far.filter((t) => !extra.some((e) => e.territoryId === t.territoryId)),
    ...extra,
  ]);

const plan = (
  b: BoardState,
  income: number,
  o: { settings?: PlannerSettings; game?: PlanGameContext; map?: ReturnType<typeof buildGraph> } = {},
) => planTurn({ graph: o.map ?? g, board: b, me: ME, income, settings: o.settings ?? STD, game: o.game ?? FFA });

const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const deploySum = (p: TurnPlan) => p.deploys.reduce((s, d) => s + d.armies, 0);

/** The plan passes warapp_submit_turn's validator. */
function valid(p: TurnPlan, b: BoardState, income: number, map = MAP, guard = true) {
  const names = new Map(map.territories.map((t) => [t.id, t.name]));
  const ref = (id: number) => ({ id, name: names.get(id)! });
  return validateTurn({
    map,
    board: b.territories.map(
      (t): LiveTerritory => ({
        territoryId: t.territoryId,
        fogLevel: 1,
        fogged: false,
        owner: t.owner.kind === 'player' ? t.owner.playerId : t.owner.kind === 'neutral' ? OWNER_NEUTRAL : -1,
        armies: t.armies,
      }),
    ),
    myInGameId: ME,
    income,
    guard,
    deploys: p.deploys.map((d) => ({ territory: ref(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: ref(m.from), to: ref(m.to), armies: m.armies })),
  }).warnings;
}

describe('never stand still in the opening (#104)', () => {
  it('the arithmetic: a 4-neutral takes 6, a 12-neutral 20', () => {
    expect(armiesToTake(4)).toBe(6);
    expect(armiesToTake(12)).toBe(20);
  });

  it('(a) every bonus uneconomic: one capture of a 4-neutral toward the cheapest bonus, sized correctly', () => {
    const b = opening();
    const p = plan(b, 5);
    expect(p.profile.phase).toBe('opening');
    expect(p.rationale.join('\n')).toMatch(/Skip bonus Vale \(#202\): uneconomic/);
    const a = attacks(p);
    expect(a).toHaveLength(1);
    // Vale (46 to finish) beats Ridge (66) and Marsh (60): its 4-neutral on 4, not Ridge's on 3.
    expect(a[0]).toMatchObject({ from: 1, to: 4, armies: 6, kind: 'attack' });
    expect(a[0]!.reason).toMatch(/Vale \(#202\)/);
    expect(a[0]!.reason).toMatch(/46 armies to finish/);
    expect(p.rationale.join('\n')).toMatch(/nothing passed the economy test; standing still is worse than the cheapest expansion/);
    expect(p.expected.captures).toEqual([4]);
    expect(deploySum(p)).toBe(5);
    expect(valid(p, b, 5)).toEqual([]);
  });

  it('(a) ties on armies to finish go to the higher value, then the lower id', () => {
    // Twin (+3) mirrors Vale's 46 to finish with a 4-neutral next to my stack on 13.
    const map = makeMap(
      [...IDS, 13, 14, 15],
      [...EDGES, [1, 13], [13, 14], [14, 15]],
      [...BONUSES, [204, 'Twin', 3, [13, 14, 15]]],
    );
    // Twin: 6 + 20 + 20 = 46, value 3 > Vale's 2. Uneconomic: one member costs 20 > 5 × 3.
    const b = board([...opening().territories, neutral(13, 4), neutral(14, 12), neutral(15, 12)]);
    const p = plan(b, 5, { map: buildGraph(map) });
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 13, armies: 6 })]);
    expect(valid(p, b, 5, map)).toEqual([]);
  });

  it('(a) a capture that needs deploys is funded from the income', () => {
    // A 4-army stack (3 movable) needs 3 more for the 6-army capture.
    const b = opening(4);
    const p = plan(b, 5);
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 4, armies: 6 })]);
    expect(p.deploys.find((d) => d.territoryId === 1)?.armies ?? 0).toBeGreaterThanOrEqual(3);
    expect(valid(p, b, 5)).toEqual([]);
  });

  describe('(b) a threatened hold comes first', () => {
    // Keep (+3) is 1 and 2, mine in full; an enemy stack on 22 threatens 2.
    const map = makeMap(IDS, EDGES, [...BONUSES, [205, 'Keep', 3, [1, 2]]]);
    const kg = buildGraph(map);
    const boardWith = (stack: number, enemy: number, border: number): BoardState => {
      const b = opening(stack, [player(22, enemy, P2)]);
      return board(b.territories.map((t) => (t.territoryId === 2 ? mine(2, border) : t)));
    };

    it('the fallback uses only what the hold leaves', () => {
      // Threat on 2: 4 movable + ~5 deploy = 9; 4 armies need 6 to take, 5 need 8, 6 need 10 — hold with 2.
      expect(armiesToTake(5)).toBe(8);
      expect(armiesToTake(6)).toBe(10);
      const b = boardWith(4, 5, 4);
      const p = plan(b, 5, { map: kg });
      expect(p.conceded).toEqual([]);
      expect(p.deploys.find((d) => d.territoryId === 2)?.armies).toBe(2);
      // 3 left: the stack's 3 movable + 3 deploys take the 4-neutral.
      expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 4, armies: 6 })]);
      expect(p.deploys.find((d) => d.territoryId === 1)?.armies).toBe(3);
      expect(valid(p, b, 5, map)).toEqual([]);
    });

    it('none left: no capture, and a warning says why', () => {
      // Threat on 2: 7 movable + ~5 = 12; 3 armies need all 5 deploys to hold (7 need 11, 8 need 13).
      expect(armiesToTake(7)).toBe(11);
      expect(armiesToTake(8)).toBe(13);
      const b = boardWith(4, 8, 3);
      const p = plan(b, 5, { map: kg });
      expect(p.conceded).toEqual([]);
      expect(p.deploys).toEqual([{ territoryId: 2, armies: 5 }]);
      expect(attacks(p)).toEqual([]);
      expect(p.warnings.join('\n')).toMatch(/standing still.*cheapest expansion.*T4 \(#4\).*Vale \(#202\)/i);
      // #107: the actual reason — without the hold's 5 deploys it would fit (3 movable + 5).
      expect(p.warnings.join('\n')).toMatch(
        /T4 \(#4\), 6 armies, toward bonus Vale \(#202\)\) does not fit what the holds leave: it needs 6, and at most 3 can reach it this turn \(3 movable on T1 \(#1\) \+ 0 to deploy; the holds took 5\)\./,
      );
      expect(valid(p, b, 5, map)).toEqual([]);
    });
  });

  it('(c) an economic bonus exists: the plan is the economic one, no fallback', () => {
    // Vale's other members hold 1: 6 + 2 + 2 = 10 to finish, economic for +2.
    const b = board(
      opening().territories.map((t) => (t.territoryId === 5 || t.territoryId === 6 ? neutral(t.territoryId, 1) : t)),
    );
    const p = plan(b, 5);
    expect(p.rationale.join('\n')).not.toMatch(/standing still/i);
    expect(p.warnings.join('\n')).not.toMatch(/standing still/i);
    expect(attacks(p).map((m) => m.to).sort()).toEqual(expect.arrayContaining([4, 5]));
    for (const m of attacks(p)) expect(m.reason).not.toMatch(/cheapest expansion/);
  });

  it('(c) in contact (no army cap) the fallback fires too (#107): the neutral step, not a second front', () => {
    // Turn 9, in contact with player 30 on 22 (a 1-army stack: no threat to a 6-army border). Before
    // #107 the plan stood still here; now the neutral step toward Vale beats taking 22, which opens a
    // second front against a player that cannot attack me.
    const b = board(
      opening(11, [player(22, 1, P2)]).territories.map((t) => (t.territoryId === 2 ? mine(2, 6) : t)),
    );
    const p = plan(b, 5, { game: { ...FFA, turn: 9 } });
    expect(p.profile.phase).toBe('contact');
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 4, armies: 6 })]);
    expect(p.rationale.join('\n')).toMatch(/contact phase: no capture is planned \(nothing passed the economy test\); standing still is worse than the cheapest capture/);
    expect(p.rationale.join('\n')).not.toMatch(/army cap/);
    expect(valid(p, b, 5)).toEqual([]);
  });

  it('(d) army cap exceeded in a later phase: the fallback fires, and says why', () => {
    const b = board(
      opening(11, [player(22, 1, P2)]).territories.map((t) => (t.territoryId === 2 ? mine(2, 6) : t)),
    );
    // 17 armies + 5 deployed = 22 > 4 × 5 = 20.
    const p = plan(b, 5, { game: { ...FFA, turn: 9 }, settings: { ...STD, armyCap: 4 } });
    expect(p.profile.phase).toBe('contact');
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 4, armies: 6 })]);
    expect(p.rationale.join('\n')).toMatch(/22 armies after deploy exceed the army cap of 20 \(4× income 5\)/);
    expect(valid(p, b, 5)).toEqual([]);
    // Under the cap (5× income = 25) the contact fallback (#107) takes the same step, without the cap's reason.
    const under = plan(b, 5, { game: { ...FFA, turn: 9 }, settings: { ...STD, armyCap: 5 } });
    expect(attacks(under)).toEqual([expect.objectContaining({ from: 1, to: 4, armies: 6 })]);
    expect(under.rationale.join('\n')).not.toMatch(/army cap/);
  });

  it('(e) only negative bonuses nearby: no fallback capture', () => {
    const map = makeMap(
      [1, 2, 3, 4],
      [[1, 2], [1, 3], [1, 4]],
      [
        [301, 'Bog', -1, [3]],
        [302, 'Mire', -2, [4]],
      ],
    );
    const b = board([mine(1, 11), mine(2, 1), neutral(3, 4), neutral(4, 4)]);
    const p = plan(b, 5, { map: buildGraph(map) });
    expect(attacks(p)).toEqual([]);
    expect(p.rationale.join('\n')).not.toMatch(/standing still/i);
    expect(p.warnings.join('\n')).not.toMatch(/standing still/i);
  });

  it('the army cap warning names only what is still not modelled', () => {
    const s = { armyCap: 8, cards: [] } as unknown as GameSettings;
    const w = incomeUncertainties(s).join('\n');
    expect(w).toMatch(/army cap \(8× income\)/);
    expect(w).toMatch(/income model does not apply it/);
    expect(w).not.toMatch(/the model does not apply it/);
  });
});

// Issue #107: in a 7-player FFA opening rule 4e ran, but every step it tried failed, and its
// warning named a far step toward the bonus with the fewest armies to finish — reachable only
// through a 1-army territory — with only the deploy as its budget, while a 4-army neutral next
// to my 6-army stack (toward a costlier bonus) was affordable.
describe('#107: never stand still, live shapes', () => {
  //   My 6-stack on 1 borders 3 (a 4-neutral in Coast). My 1-army 2 borders 4 (an 8-neutral in
  //   Hills, 13 to take). Hills (+2) is 1, 2 and 4: 13 to finish, the fewest — but only 4 is
  //   missing, reachable only from the 1-army 2. Coast (+2) is 3, 6, 7: 6 + 20 + 20 = 46.
  //   Six opponents sit in the fog beyond 7 and 4.
  const SEVEN: PlanGameContext = { players: [ME, P2, P3, 50, 60, 70, 80].map((id) => ({ id })), turn: 2 };
  const CAP: PlannerSettings = { ...STD, armyCap: 8 };
  const fogged = (territoryId: number): TerritoryState => ({ territoryId, owner: { kind: 'unknown' }, armies: null });
  const map = makeMap(
    [1, 2, 3, 4, 6, 7, 20, 21, 22],
    [[1, 2], [1, 3], [2, 4], [3, 6], [6, 7], [7, 20], [4, 21], [21, 22]],
    [
      [401, 'Hills', 2, [1, 2, 4]],
      [402, 'Coast', 2, [3, 6, 7]],
    ],
  );
  const mg = buildGraph(map);
  const live = (stack: number, near: number): BoardState =>
    board([mine(1, stack), mine(2, 1), neutral(3, near), neutral(4, 8), neutral(6, 12), neutral(7, 12), fogged(20), fogged(21), fogged(22)]);

  it('the arithmetic: an 8-neutral takes 13, a 6-neutral 10', () => {
    expect(armiesToTake(8)).toBe(13);
    expect(armiesToTake(6)).toBe(10);
  });

  it('takes the neutral next to my stack, not the far step toward the bonus with fewer armies to finish', () => {
    const b = live(6, 4);
    for (const adapt of [false, true]) {
      const p = planTurn({ graph: mg, board: b, me: ME, income: 5, settings: CAP, game: SEVEN, options: { adapt } });
      expect(p.profile.phase).toBe('opening');
      expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 3, armies: 6, kind: 'attack' })]);
      // Coast is not the bonus with the fewest armies to finish: the reason must not say so.
      expect(attacks(p)[0]!.reason).toMatch(/Coast \(#402\) \(\+2, 46 armies to finish, the fewest of any bonus with a capture affordable this turn\)/);
      expect(attacks(p)[0]!.reason).not.toMatch(/the fewest of any bonus in reach/);
      expect(p.rationale.join('\n')).toMatch(
        /Hills \(#401\) has fewer armies to finish \(13\), but T4 \(#4\) needs 13 and at most 5 can reach it this turn/,
      );
      expect(p.warnings.join('\n')).not.toMatch(/standing still/i);
      expect(valid(p, b, 5, map)).toEqual([]);
    }
  });

  it('the same with the previous board known (nothing moved)', () => {
    const b = live(6, 4);
    const p = planTurn({ graph: mg, board: b, me: ME, income: 5, settings: CAP, game: SEVEN, previousBoard: b });
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 3, armies: 6 })]);
  });

  it('nothing affordable: the warning names the closest step and counts the movable armies next to it', () => {
    // A 4-stack (3 movable) next to a 6-neutral (10 to take): 3 + 5 = 8 reach it, 2 short.
    // The far 8-neutral needs 13 and only the 5 deploys reach it: 8 short.
    const b = live(4, 6);
    const p = planTurn({ graph: mg, board: b, me: ME, income: 5, settings: CAP, game: SEVEN });
    expect(attacks(p)).toEqual([]);
    const w = p.warnings.join('\n');
    expect(w).toMatch(
      /Standing still: no capture is planned, and the cheapest expansion \(T3 \(#3\), 10 armies, toward bonus Coast \(#402\)\) does not fit this turn: it needs 10, and at most 8 can reach it this turn \(3 movable on T1 \(#1\) \+ 5 to deploy\)\./,
    );
    expect(w).not.toMatch(/T4 \(#4\), 13 armies/);
    expect(w).not.toMatch(/what the holds leave/);
  });

  describe("rule 4d's frontier stop", () => {
    // 3 borders an enemy stack of 12 on 22: a capture of 3 (3 survivors) would need far more than
    // the next income of 5 to hold, and my 11-stack on 1 faces no enemy now (0 at the start).
    const fmap = makeMap(
      [1, 2, 3, 6, 7, 22],
      [[1, 2], [1, 3], [3, 6], [6, 7], [3, 22]],
      [[402, 'Coast', 2, [3, 6, 7]]],
    );
    const fg = buildGraph(fmap);
    const b = board([mine(1, 11), mine(2, 1), neutral(3, 4), neutral(6, 12), neutral(7, 12), player(22, 12, P2)]);

    it('in the opening, one capture that grows the frontier beats standing still, and the rationale says so', () => {
      const p = planTurn({ graph: fg, board: b, me: ME, income: 5, settings: CAP, game: SEVEN });
      expect(p.profile.phase).toBe('opening');
      expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 3, armies: 6 })]);
      const r = p.rationale.join('\n');
      expect(r).toMatch(/rule 4d's frontier stop is waived for this one capture: in the opening, one capture that grows the frontier is better than none/);
      expect(r).not.toMatch(/Do not take T3 \(#3\)/);
      expect(p.warnings.join('\n')).not.toMatch(/not taken/);
      expect(p.warnings.join('\n')).not.toMatch(/standing still/i);
      expect(valid(p, b, 5, fmap)).toEqual([]);
    });

    it('in the expansion phase the stop holds, and the warning names it as the reason', () => {
      const p = planTurn({ graph: fg, board: b, me: ME, income: 5, settings: CAP, game: { ...SEVEN, turn: 5 } });
      expect(p.profile.phase).toBe('expansion');
      expect(attacks(p)).toEqual([]);
      expect(p.warnings.join('\n')).toMatch(
        /Standing still: no capture is planned, and the cheapest expansion \(T3 \(#3\), 6 armies, toward bonus Coast \(#402\)\) is refused by rule 4d's frontier stop/,
      );
    });
  });
});

// #107, the live root cause: in a several-player opening my only stack next to a cheap neutral
// borders a big enemy stack, so rule 1a concedes it and rule 1b withdraws its armies — and 4e
// then had no usable source (a conceded border is never deployed to, and its 5 movable armies
// alone cannot take a 4-neutral). The plan withdrew, deployed everything to the biggest stack
// and captured nothing, with a frontier needing 0. A conceded border's armies are lost anyway:
// rather than stand still, 4e attacks out of it with its movable armies plus deploys.
describe('#107: a conceded border attacks out rather than stand still', () => {
  const SEVEN: PlanGameContext = { players: [ME, P2, P3, 50, 60, 70, 80].map((id) => ({ id })), turn: 2 };
  const CAP: PlannerSettings = { ...STD, armyCap: 8 };
  //   My 6-stack on 1 borders 3 (Pair, +2, with 12-neutrals on 5 and 6) and a 25-army enemy on 22.
  //   My 1-army 2 is behind 1, next to a 12-neutral on 7.
  const map = makeMap(
    [1, 2, 3, 5, 6, 7, 22],
    [[1, 2], [1, 3], [3, 5], [5, 6], [1, 22], [2, 7]],
    [[401, 'Pair', 2, [3, 5, 6]]],
  );
  const mg = buildGraph(map);
  const at = (near: number): BoardState =>
    board([mine(1, 6), mine(2, 1), neutral(3, near), neutral(5, 12), neutral(6, 12), neutral(7, 12), player(22, 25, P2)]);
  const run = (b: BoardState, settings: PlannerSettings = CAP, adapt = false) =>
    planTurn({ graph: mg, board: b, me: ME, income: 5, settings, game: SEVEN, options: { adapt } });

  it('takes the 4-neutral from the conceded stack (5 movable + 1 deploy) instead of withdrawing', () => {
    const b = at(4);
    for (const adapt of [false, true]) {
      const p = run(b, CAP, adapt);
      expect(p.profile.phase).toBe('opening');
      expect(p.conceded).toEqual([1]);
      expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 3, armies: 6, kind: 'attack' })]);
      expect(p.moves.filter((m) => m.kind === 'transfer' && m.from === 1)).toEqual([]);
      expect(p.deploys.find((d) => d.territoryId === 1)?.armies).toBe(1);
      expect(deploySum(p)).toBe(5);
      expect(p.cardAdvice).toBe('order-priority');
      expect(p.warnings).toContain('The attack out of T1 (#1) only executes if T1 (#1) is still mine when the order runs; play Order Priority so it goes first.');
      const r = p.rationale.join('\n');
      expect(r).toMatch(
        /Attack out of conceded T1 \(#1\) rather than withdraw: its 5 movable armies \(and 1 deployed there, which leave with the attack\) take T3 \(#3\)/,
      );
      expect(r).not.toMatch(/Withdraw 5 from T1/);
      const w = p.warnings.join('\n');
      expect(w).not.toMatch(/withdrawal from T1/);
      expect(w).not.toMatch(/standing still/i);
      expect(valid(p, b, 5, map)).toEqual([]);
    }
  });

  it('under No-Split the withdrawal no longer occupies the conceded stack', () => {
    const b = at(4);
    const p = run(b, { ...CAP, noSplit: true });
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 3, armies: 6 })]);
    expect(p.moves.filter((m) => m.from === 1)).toHaveLength(1);
    expect(p.warnings.join('\n')).not.toMatch(/No-Split: T1/);
  });

  it('too big even attacking out: the withdrawal stands, and the warning names the concession', () => {
    // An 8-neutral takes 13: 5 movable + 5 deploys = 10.
    const b = at(8);
    const p = run(b);
    expect(attacks(p)).toEqual([]);
    expect(p.moves).toEqual([expect.objectContaining({ from: 1, to: 2, armies: 5, kind: 'transfer' })]);
    expect(p.cardAdvice).toBe('order-priority');
    const w = p.warnings.join('\n');
    expect(w).toMatch(/The withdrawal from T1 \(#1\) only executes/);
    expect(w).toMatch(
      /Standing still: no capture is planned, and the cheapest expansion \(T3 \(#3\), 13 armies, toward bonus Pair \(#401\)\) does not fit this turn: it needs 13, and at most 10 can reach it this turn \(5 movable on T1 \(#1\), a conceded border, \+ 5 to deploy\)\./,
    );
    expect(w).not.toMatch(/hold their borders/);
    expect(valid(p, b, 5, map)).toEqual([]);
  });

  it('attacking out sends every movable army on the conceded border, not only the cost', () => {
    // A 10-stack on 1: 9 movable, a 4-neutral takes 6. The 3 extra are lost on 1 anyway; at 3 they survive.
    const b = board([mine(1, 10), mine(2, 1), neutral(3, 4), neutral(5, 12), neutral(6, 12), neutral(7, 12), player(22, 40, P2)]);
    const p = run(b);
    expect(p.conceded).toEqual([1]);
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 3, armies: 9, kind: 'attack' })]);
    expect(p.moves.filter((m) => m.from === 1)).toHaveLength(1);
    expect(p.deploys.find((d) => d.territoryId === 1)).toBeUndefined();
    const r = p.rationale.join('\n');
    expect(r).toMatch(/Attack T3 \(#3\) from T1 \(#1\) with 9:/);
    expect(r).toMatch(/Attack out of conceded T1 \(#1\) rather than withdraw: its 9 movable armies take T3 \(#3\)/);
    expect(valid(p, b, 5, map)).toEqual([]);
  });

  describe('an unconceded source that can take the step alone goes first: the conceded stack withdraws', () => {
    //   My 30-stack on 1 borders a 60-army enemy on 22 (conceded). My 6-stack on 4 and 1 both border
    //   the 4-neutral 3 (Pair, +2, with 12-neutrals on 5 and 6). My 1-army 2 borders 1 and 4.
    const umap = makeMap(
      [1, 2, 3, 4, 5, 6, 22],
      [[1, 2], [2, 4], [1, 3], [4, 3], [3, 5], [5, 6], [1, 22]],
      [[401, 'Pair', 2, [3, 5, 6]]],
    );
    const ub = board([mine(1, 30), mine(2, 1), neutral(3, 4), mine(4, 6), neutral(5, 12), neutral(6, 12), player(22, 60, P2)]);

    it('withdraws 29 from 1 and takes 3 from 4', () => {
      for (const adapt of [false, true]) {
        const p = planTurn({ graph: buildGraph(umap), board: ub, me: ME, income: 5, settings: CAP, game: SEVEN, options: { adapt } });
        expect(p.profile.phase).toBe('opening');
        expect(p.conceded).toEqual([1]);
        expect(p.moves.filter((m) => m.from === 1)).toEqual([expect.objectContaining({ to: 2, armies: 29, kind: 'transfer' })]);
        expect(attacks(p)).toEqual([expect.objectContaining({ from: 4, to: 3, kind: 'attack' })]);
        expect(p.rationale.join('\n')).not.toMatch(/Attack out of conceded/);
        expect(valid(p, ub, 5, umap)).toEqual([]);
      }
    });
  });

  describe('the capture goes from other sources: rule 1b withdrawal survives every undo', () => {
    //   Conceded 6-stack on 1 (a 25-army enemy on 22) has the best reach to 3, a 7-neutral in Pair
    //   (+2, with 12-neutrals on 6 and 7). 3 also borders my 4-stacks on 4 and 5, and a 15-army enemy
    //   on 23: the combined capture from 4 and 5 is stopped by rule 4d (waived only in the opening).
    const cmap = makeMap(
      [1, 2, 3, 4, 5, 6, 7, 22, 23],
      [[1, 2], [1, 3], [1, 22], [3, 4], [3, 5], [4, 2], [5, 2], [3, 6], [6, 7], [3, 23]],
      [[401, 'Pair', 2, [3, 6, 7]]],
    );
    const cg = buildGraph(cmap);
    const cb = board([
      mine(1, 6),
      mine(2, 1),
      neutral(3, 7),
      mine(4, 4),
      mine(5, 4),
      neutral(6, 12),
      neutral(7, 12),
      player(22, 25, P2),
      player(23, 15, P3),
    ]);
    const withdrawal = (p: TurnPlan) => {
      expect(p.conceded).toEqual([1]);
      expect(p.moves.filter((m) => m.from === 1)).toEqual([expect.objectContaining({ to: 2, armies: 5, kind: 'transfer' })]);
      expect(p.rationale.join('\n')).toMatch(/Withdraw 5 from T1 \(#1\) to /);
      expect(p.rationale.join('\n')).not.toMatch(/Attack out of conceded/);
      expect(p.warnings.join('\n')).toMatch(/The withdrawal from T1 \(#1\) only executes/);
      expect(p.cardAdvice).toBe('order-priority');
    };

    it('opening: the waived capture goes ahead from 4 and 5, and the withdrawal stands', () => {
      for (const adapt of [false, true]) {
        const p = planTurn({ graph: cg, board: cb, me: ME, income: 5, settings: CAP, game: SEVEN, options: { adapt } });
        expect(p.profile.phase).toBe('opening');
        expect(attacks(p).map((m) => m.to)).toEqual([3, 3]);
        expect(attacks(p).every((m) => m.from !== 1)).toBe(true);
        withdrawal(p);
        expect(valid(p, cb, 5, cmap)).toEqual([]);
      }
    });

    it('later (contact, over the army cap): rule 4d is a cost, not a veto (#114); the capture goes ahead from 4 and 5, and the withdrawal stands', () => {
      // An army cap of 1× income: my 20 armies after deploy exceed 5, so 4e runs in contact. Every
      // candidate is tried and undone to rank it: the withdrawal survives those undos too.
      const p = planTurn({ graph: cg, board: cb, me: ME, income: 5, settings: { ...STD, armyCap: 1 }, game: { ...SEVEN, turn: 5 } });
      expect(p.profile.phase).toBe('contact');
      expect(p.rationale.join('\n')).not.toMatch(/Do not take T3 \(#3\)/);
      expect(attacks(p).map((m) => m.to)).toEqual([3, 3]);
      expect(attacks(p).every((m) => m.from !== 1)).toBe(true);
      // 3 faces the 15-army enemy on 23: its 4 survivors cannot hold it next turn.
      expect(attacks(p)[1]!.reason).toMatch(/^cheapest expansion \(loses ~7 armies, and its 4 survivors may fall next turn\)/);
      withdrawal(p);
      expect(valid(p, cb, 5, cmap)).toEqual([]);
    });
  });
});

describe('#107: the stand-still warning names the actual reason', () => {
  it('R3: a capture that completes a bonus that falls next turn is refused, not "does not fit"', () => {
    // Pair (+2) is 1 and 3; a 40-army enemy borders both. Taking 3 fits (5 movable + 5 deploy)
    // but completes Pair, which could not be held next turn.
    const map = makeMap([1, 3, 22], [[1, 3], [1, 22], [3, 22]], [[401, 'Pair', 2, [1, 3]]]);
    const b = board([mine(1, 6), neutral(3, 4), player(22, 40, P2)]);
    const p = planTurn({
      graph: buildGraph(map),
      board: b,
      me: ME,
      income: 5,
      settings: STD,
      game: { players: [ME, P2, P3, 50, 60].map((id) => ({ id })), turn: 2 },
    });
    expect(attacks(p)).toEqual([]);
    const w = p.warnings.join('\n');
    expect(w).toMatch(
      /Standing still: no capture is planned, and the cheapest expansion \(T3 \(#3\), 6 armies, toward bonus Pair \(#401\)\) is refused by rule R3: taking it completes bonus Pair \(#401\), which could not be held next turn \(see "completing Pair \(#401\) leaves …: not completed"\)\./,
    );
    expect(w).not.toMatch(/does not fit/);
  });

  it('every neighbour holds: the warning says each one holds, not that it is conceded or too small', () => {
    // Keep (+3) is 1 and 2, mine; an 8-army enemy on 22 threatens 1, the only neighbour of 3.
    const map = makeMap([1, 2, 3, 5, 22], [[1, 2], [1, 3], [3, 5], [1, 22]], [
      [401, 'Keep', 3, [1, 2]],
      [402, 'Pair', 2, [3, 5]],
    ]);
    const b = board([mine(1, 4), mine(2, 3), neutral(3, 4), neutral(5, 12), player(22, 8, P2)]);
    const p = plan(b, 5, { map: buildGraph(map) });
    expect(attacks(p)).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(
      /\(T3 \(#3\), 6 armies, toward bonus Pair \(#402\)\) cannot be reached: no neighbour of mine can attack it \(T1 \(#1\) stays to hold its border\)\./,
    );
  });
});

// #107, the second case: an 8-player FFA in contact, every neutral at 15, my 15-stacks next to
// opponent territories holding 4 and 0 — and the plan made no capture. In the contact and late
// phases a plan with no capture at all falls back too: the cheapest capture among the neutral
// steps rule 4e would take and the enemy territories it can take at a trade of at least even,
// at the plan's win chance, leaving every hold covered and never lowering income.
describe('#107: in contact, never stand still either', () => {
  const EIGHT: PlanGameContext = { players: [ME, P2, P3, 50, 60, 70, 80, 90].map((id) => ({ id })), turn: 3 };
  //   My 15-stacks on 1 and 2. 22 (player 30, 4 armies) borders 1; 23 (player 40, 0 armies)
  //   borders 2. Behind them 24 (player 30) and 25 (player 40). Every neutral holds 15 (25 to take).
  //   Delta (+3) is 1, 22 and 3: taking 22 advances it. Fen (+2) is 4, 5, 6.
  const map = makeMap(
    [1, 2, 3, 4, 5, 6, 22, 23, 24, 25],
    [[1, 2], [1, 3], [1, 22], [2, 4], [2, 23], [3, 4], [4, 5], [5, 6], [22, 24], [23, 25]],
    [
      [501, 'Delta', 3, [1, 22, 3]],
      [502, 'Fen', 2, [4, 5, 6]],
    ],
  );
  const mg = buildGraph(map);
  const contactBoard = (extra: TerritoryState[] = []): BoardState =>
    board([
      mine(1, 15),
      mine(2, 15),
      neutral(3, 15),
      neutral(4, 15),
      neutral(5, 15),
      neutral(6, 15),
      player(22, 4, P2),
      player(23, 0, P3),
      player(24, 3, P2),
      player(25, 3, P3),
      ...extra,
    ]);
  const run = (b: BoardState, o: { map?: GameMap; adapt?: boolean; settings?: PlannerSettings } = {}) =>
    planTurn({
      graph: o.map ? buildGraph(o.map) : mg,
      board: b,
      me: ME,
      income: 5,
      settings: o.settings ?? STD,
      game: EIGHT,
      options: { adapt: o.adapt ?? false },
    });

  it('the arithmetic: a 15-neutral takes 25, a 4-army stack 6, an empty one 1', () => {
    expect(armiesToTake(15)).toBe(25);
    expect(armiesToTake(4)).toBe(6);
    expect(armiesToTake(0)).toBe(1);
  });

  it('takes the enemy territory that loses the fewest armies, from a 15-stack, holds intact', () => {
    const b = contactBoard();
    for (const adapt of [false, true]) {
      const p = run(b, { adapt });
      expect(p.profile.phase).toBe('contact');
      expect(p.conceded).toEqual([]);
      // #112: 22 advances Delta but loses ~3 armies; 23 (1 to take) loses none, so it goes first —
      // a bonus is only a tie-break. Sized at 1, then topped up from the stack's idle armies to the
      // next kill breakpoint (3), as every attack on a player's is. 22 is no free capture.
      expect(attacks(p)).toEqual([expect.objectContaining({ from: 2, to: 23, armies: 3, kind: 'attack' })]);
      // #114: its 1 survivor cannot hold 23 against player 40's 3 on 25 (+ deploy): at risk.
      expect(attacks(p)[0]!.reason).toMatch(
        /^cheapest capture \(loses no armies, and its 1 survivor may fall next turn\): takes a territory of player 40/,
      );
      expect(p.expected.captures).toEqual([23]);
      const r = p.rationale.join('\n');
      expect(r).toMatch(/Take T23 \(#23\) though no planned capture is economic: contact phase: no capture is planned/);
      expect(r).toMatch(/kills 0 for 0 lost: a trade of at least even/);
      // No second front in an FFA: player 40 cannot attack me now, so this opens a second front — taken only because no neutral capture fits.
      expect(r).toMatch(
        /Player 40 cannot attack me now: taking T23 \(#23\) opens a second front \(no second front in an FFA\), taken only because no neutral capture fits this turn\./,
      );
      expect(r).not.toMatch(/Also take/);
      const w = p.warnings.join('\n');
      expect(w).toMatch(/Attack on enemy T23 \(#23\) assumes its owner does not reinforce it first\./);
      expect(w).not.toMatch(/standing still/i);
      expect(valid(p, b, 5, map)).toEqual([]);
    }
  });

  it('with no bonus to advance, the cheapest: the empty territory', () => {
    const plain = makeMap(
      [1, 2, 3, 4, 5, 6, 22, 23, 24, 25],
      [[1, 2], [1, 3], [1, 22], [2, 4], [2, 23], [3, 4], [4, 5], [5, 6], [22, 24], [23, 25]],
      [[502, 'Fen', 2, [4, 5, 6]]],
    );
    const b = contactBoard();
    const p = run(b, { map: plain });
    // 1 to take, topped up to 3 from the idle stack.
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 2, to: 23, armies: 3, kind: 'attack' })]);
    expect(valid(p, b, 5, plain)).toEqual([]);
  });

  it('a player that can already attack me: no new front, and the rationale says so', () => {
    // My 1-army 7 borders 24 (player 30, 6 armies: out of 7's reach): player 30 can take it. Player
    // 30 also holds 26, out of my reach, so this is no finishing off (rule 1e). 23 (player 40, who
    // cannot attack me) would open a second front, so 22 goes first; 23 then costs nothing (#112).
    const front = makeMap(
      [1, 2, 3, 4, 5, 6, 7, 22, 23, 24, 25, 26],
      [[1, 2], [1, 3], [1, 22], [2, 4], [2, 23], [3, 4], [4, 5], [5, 6], [22, 24], [23, 25], [7, 24], [7, 2], [24, 26]],
      [
        [501, 'Delta', 3, [1, 22, 3]],
        [502, 'Fen', 2, [4, 5, 6]],
      ],
    );
    const b = board([
      ...contactBoard().territories.filter((t) => t.territoryId !== 24),
      mine(7, 1),
      player(24, 6, P2),
      player(26, 3, P2),
    ]);
    const p = run(b, { map: front });
    expect(attacks(p).map((m) => [m.from, m.to])).toEqual([
      [1, 22],
      [2, 23],
    ]);
    const r = p.rationale.join('\n');
    expect(r).toMatch(/Player 30 can already attack me \(T7 \(#7\)\): taking T22 \(#22\) opens no new front\./);
    expect(r).toMatch(/Also take T23 \(#23\): it costs nothing/);
    expect(r).toMatch(/Player 40 cannot attack me now: taking T23 \(#23\) opens a second front, taken only because it costs nothing\./);
    expect(valid(p, b, 5, front)).toEqual([]);
  });

  it('a neutral step that fits beats a second-front enemy capture', () => {
    // 3 holds 4 (6 to take) instead of 15: the neutral advances Delta from 1 and opens no front.
    const b = board(contactBoard().territories.map((t) => (t.territoryId === 3 ? neutral(3, 4) : t)));
    const p = run(b);
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 3, armies: 6 })]);
    expect(p.rationale.join('\n')).not.toMatch(/second front/);
  });

  it('an attack that would leave its source unable to hold is not made', () => {
    // 22 holds 9 (15 to take) next to my 15-stack on 1: its 14 movable + 1 deploy take it, but the 1
    // that stays on 1 falls to the 8-army stack of player 30 on 24, next to it too (7 movable + 5 deploy),
    // and so do the 5 that would stay with every deploy left.
    const tight = makeMap(
      [1, 2, 3, 4, 5, 6, 22, 23, 24, 25],
      [[1, 2], [1, 3], [1, 22], [2, 4], [2, 23], [3, 4], [4, 5], [5, 6], [22, 24], [23, 25], [1, 24]],
      [[502, 'Fen', 2, [4, 5, 6]]],
    );
    const b = board(
      contactBoard()
        .territories.filter((t) => t.territoryId !== 23 && t.territoryId !== 25)
        .map((t) => (t.territoryId === 22 ? player(22, 9, P2) : t.territoryId === 24 ? player(24, 8, P2) : t))
        .concat([neutral(23, 15), neutral(25, 15)]),
    );
    const p = run(b, { map: tight });
    expect(p.conceded).toEqual([]);
    expect(attacks(p)).toEqual([]);
    const w = p.warnings.join('\n');
    expect(w).toMatch(
      /Not attacking T22 \(#22\): it would leave T1 \(#1\) unable to hold its border \(1 would stay, 5 with the 4 deploys left there, against a threat of 12\)\./,
    );
    expect(w).toMatch(/Standing still: no capture is planned/);
  });

  it('behind on income in an FFA (adapt picks defend): the fallback still fires, unlike a chosen defend', () => {
    // Player 40 holds Moor (+5) on 25, a 12-stack out of my reach: ~9 income against my 5, so adapt
    // picks `defend` (rule 0p.3).
    const moor = makeMap(
      [1, 2, 3, 4, 5, 6, 22, 23, 24, 25],
      [[1, 2], [1, 3], [1, 22], [2, 4], [2, 23], [3, 4], [4, 5], [5, 6], [22, 24], [23, 25]],
      [
        [501, 'Delta', 3, [1, 22, 3]],
        [502, 'Fen', 2, [4, 5, 6]],
        [503, 'Moor', 5, [25]],
      ],
    );
    const b = board(contactBoard().territories.map((t) => (t.territoryId === 25 ? player(25, 12, P3) : t)));
    const p = run(b, { map: moor, adapt: true });
    expect(p.profile.standing).toBe('behind');
    expect(p.goal).toBe('defend');
    expect(attacks(p)).toHaveLength(1);
    expect(p.rationale.join('\n')).toMatch(/though no planned capture is economic: contact phase/);
    expect(valid(p, b, 5, moor)).toEqual([]);
    // The caller's own `defend` keeps its behaviour: no fallback.
    const chosen = planTurn({
      graph: buildGraph(moor),
      board: b,
      me: ME,
      income: 5,
      settings: STD,
      game: EIGHT,
      options: { goal: 'defend' },
    });
    expect(attacks(chosen)).toEqual([]);
  });

  it('a source next to two enemies attacks when the deploys left on it make it hold', () => {
    // My 15 on 1 borders 22 (player 30, 4 armies: 6 to take) and 24 (player 40, 12 armies: a threat
    // of 11 movable + its deploy). Right after the attack too few stay on 1 to hold — but the deploys
    // still unspent can land there: then 1 holds and the capture is safe.
    const two = makeMap(
      [1, 3, 4, 22, 24, 26, 27],
      [[1, 3], [3, 4], [1, 22], [1, 24], [22, 26], [24, 27]],
      [[502, 'Fen', 2, [3, 4]]],
    );
    const b = board([
      mine(1, 15),
      neutral(3, 15),
      neutral(4, 15),
      player(22, 4, P2),
      player(24, 12, P3),
      player(26, 3, P2),
      player(27, 3, P3),
    ]);
    const p = run(b, { map: two });
    expect(p.profile.phase).toBe('contact');
    expect(p.conceded).toEqual([]);
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 22, kind: 'attack' })]);
    const sent = attacks(p)[0]!.armies;
    const onOne = 15 + (p.deploys.find((d) => d.territoryId === 1)?.armies ?? 0) - sent;
    // 24's threat: its 11 movable plus player 40's deploy; 1 must stand against it.
    expect(armiesToTake(onOne)!).toBeGreaterThan(16);
    expect(p.warnings.join('\n')).not.toMatch(/Not attacking T22|Standing still/);
    expect(p.rationale.join('\n')).toMatch(
      /Deploy \d+ to T1 \(#1\) so it still holds its border after the attack on T22 \(#22\) \(\d+ stay against a threat of 16\)\./,
    );
    expect(valid(p, b, 5, two)).toEqual([]);
  });

  it('the only enemy capture trades below even: no capture, and a warning says so', () => {
    // 22 (player 30, 10 armies: 16 to take) borders my 9-stacks on 1 and 2: alone each reaches 13;
    // together, 2 softens with 8 (kills 5, loses 7) and 1 finishes with 8 (kills 5, loses 4):
    // 11 lost for 10 killed.
    expect(armiesToTake(10)).toBe(16);
    const bmap = makeMap([1, 2, 3, 5, 22], [[1, 2], [1, 3], [3, 5], [1, 22], [2, 22]], [[401, 'Pair', 2, [3, 5]]]);
    const b = board([mine(1, 9), mine(2, 9), neutral(3, 15), neutral(5, 15), player(22, 10, P2)]);
    const p = run(b, { map: bmap });
    expect(p.profile.phase).toBe('contact');
    expect(attacks(p)).toEqual([]);
    const w = p.warnings.join('\n');
    expect(w).toMatch(/Standing still: no capture is planned/);
    expect(w).toMatch(
      /Not attacking T22 \(#22\): the combined capture loses 11 armies for the 10 it kills, a trade below even\./,
    );
  });
});

// #112: an 8-player FFA in contact, at 60/70, every neutral 15. With no other capture the contact
// fallback took a 15-neutral with 25 (≈11 lost) toward a big bonus, while enemy territories of 4
// (≈3 lost) and 0 (nothing lost) bordered my stacks. In contact and late phases the fallback now
// ranks by the armies a capture loses, then by the armies it sends, a bonus only as a tie-break;
// and after it, every other capture that loses nothing is taken too.
describe('#112: the contact fallback takes the capture that loses the fewest armies', () => {
  const EIGHT: PlanGameContext = { players: [ME, P2, P3, 50, 60, 70, 80, 90].map((id) => ({ id })), turn: 3 };
  //   My 25-stacks on 1 and 2, and a 1-army 7. 22 (player 30, 4) borders 1; 23 (player 40, 0)
  //   borders 2. Crown (+4) is the four 15-neutrals 3 4 5 6 (25 to take each): 3 borders 1, 4
  //   borders 2. Player 30's 24 (6) borders 7, so player 30 can attack me; so can player 40's 25
  //   (6) when `bothFront`. Neither is in 7's reach (10 to take). 26 and 27 keep both players out
  //   of my reach (no finishing off).
  const shape = (bothFront: boolean) =>
    makeMap(
      [1, 2, 3, 4, 5, 6, 7, 22, 23, 24, 25, 26, 27],
      [
        [1, 2], [1, 3], [1, 22], [2, 4], [2, 23], [2, 7], [3, 4], [4, 5], [5, 6],
        [22, 24], [23, 25], [7, 24], [24, 26], [25, 27],
        ...(bothFront ? ([[7, 25]] as [number, number][]) : []),
      ],
      [[601, 'Crown', 4, [3, 4, 5, 6]]],
    );
  const shapeBoard = (extra: TerritoryState[] = []): BoardState =>
    board([
      mine(1, 25),
      mine(2, 25),
      mine(7, 1),
      neutral(3, 15),
      neutral(4, 15),
      neutral(5, 15),
      neutral(6, 15),
      player(24, 6, P2),
      player(25, 6, P3),
      player(26, 3, P2),
      player(27, 3, P3),
      ...extra,
    ]);
  const run = (b: BoardState, map: GameMap) =>
    planTurn({ graph: buildGraph(map), board: b, me: ME, income: 5, settings: STD, game: EIGHT, options: { adapt: false } });

  it('the arithmetic: a 15-neutral loses 11, a 4-army stack 3, an empty one nothing', () => {
    expect(armiesToTake(15)).toBe(25);
    expect(straightKills(15, 70)).toBe(11);
    expect(straightKills(4, 70)).toBe(3);
  });

  it('takes the empty enemy territory, not the 15-neutral toward the big bonus', () => {
    const map = shape(true);
    const b = shapeBoard([player(22, 4, P2), player(23, 0, P3)]);
    const p = run(b, map);
    expect(p.profile.phase).toBe('contact');
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 2, to: 23, kind: 'attack' })]);
    expect(attacks(p)[0]!.reason).toMatch(/loses no armies/);
    expect(p.expected.captures).toEqual([23]);
    const r = p.rationale.join('\n');
    expect(r).toMatch(/Take T23 \(#23\) though no planned capture is economic/);
    expect(r).not.toMatch(/Attack T3 \(#3\)|Attack T4 \(#4\)|Attack T22 \(#22\)/);
    expect(valid(p, b, 5, map)).toEqual([]);
  });

  it('when the 4 is picked first (the empty one opens a second front), the empty one is also taken: it costs nothing', () => {
    const map = shape(false);
    const b = shapeBoard([player(22, 4, P2), player(23, 0, P3)]);
    const p = run(b, map);
    expect(p.profile.phase).toBe('contact');
    expect(attacks(p).map((m) => [m.from, m.to])).toEqual([
      [1, 22],
      [2, 23],
    ]);
    expect(attacks(p)[0]!.reason).toMatch(/loses ~3 armies/);
    expect(p.expected.captures).toEqual([22, 23]);
    const r = p.rationale.join('\n');
    expect(r).toMatch(/Take T22 \(#22\) though no planned capture is economic/);
    expect(r).toMatch(/kills 4 for 3 lost: a trade of at least even/);
    expect(r).toMatch(/Also take T23 \(#23\): it costs nothing/);
    expect(r).not.toMatch(/Attack T3 \(#3\)|Attack T4 \(#4\)/);
    expect(valid(p, b, 5, map)).toEqual([]);
  });

  it('with only neutrals in reach, the neutral step is taken as before', () => {
    const map = shape(true);
    // 22 and 23 are out of sight: no enemy capture is in reach.
    const b = shapeBoard();
    const p = run(b, map);
    expect(p.profile.phase).toBe('contact');
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 3, armies: 25, kind: 'attack' })]);
    expect(attacks(p)[0]!.reason).toMatch(/^cheapest expansion \(loses ~11 armies\) toward bonus Crown \(#601\)/);
    expect(valid(p, b, 5, map)).toEqual([]);
  });
});

// The real shape that showed it (an 8-player opening: every stack 15, every neutral 15, income 5,
// one-army-stands-guard off): to take one neutral that completes nothing, the fallback emptied a
// stack standing next to enemy stacks — once alone, once as the softener of a combined capture —
// and, when rule 4d refused that, waived 4d for it. The contact phase already required every
// source to still hold its border once the attack leaves; the opening and expansion phases, the
// army-cap case and the waiver did not. A capture that leaves its source to fall is worse than
// standing still: it trades a held territory and its armies for a neutral that pays nothing.
describe('never stand still, but never by emptying a border that holds (every phase)', () => {
  const OFF: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: false };
  const EIGHT: PlanGameContext = { players: [ME, P2, P3, 50, 60, 70, 80, 90].map((id) => ({ id })), turn: 1 };
  //   1 (mine) ─ 3 (a neutral, in Far with 15-neutrals on 6 and 7: uneconomic for +3)
  //   1 ─ 4 (P2, 15) and 1 ─ 5 (P3, 15): two enemy stacks next to my stack.
  //   2 (mine) ─ 3 as well, with no enemy next to it.
  const map = makeMap(
    [1, 2, 3, 4, 5, 6, 7],
    [[1, 3], [2, 3], [1, 4], [1, 5], [3, 6], [6, 7]],
    [[501, 'Far', 3, [3, 6, 7]]],
  );
  const kg = buildGraph(map);
  const shape = (one: number, two: number, near = 15): BoardState =>
    board([mine(1, one), mine(2, two), neutral(3, near), player(4, 15, P2), player(5, 15, P3), neutral(6, 15), neutral(7, 15)]);
  const plan = (b: BoardState, game: PlanGameContext = EIGHT, settings: PlannerSettings = OFF) =>
    planTurn({ graph: kg, board: b, me: ME, income: 5, settings, game });
  const deployedTo = (p: TurnPlan, t: number) => p.deploys.filter((d) => d.territoryId === t).reduce((n, d) => n + d.armies, 0);
  /** The plan passes warapp_submit_turn's validator with one-army-stands-guard off. */
  const ok = (p: TurnPlan, b: BoardState) => valid(p, b, 5, map, false);

  it('the arithmetic: a 15-neutral takes 25, a 4-neutral 6; 21 armies need 35, 13 need 21, 8 need 13', () => {
    expect(armiesToTake(15)).toBe(25);
    expect(armiesToTake(4)).toBe(6);
    expect(straightKills(15, 70)).toBe(11);
    expect(armiesToTake(21)).toBe(35);
    expect(armiesToTake(13)).toBe(21);
    expect(armiesToTake(8)).toBe(13);
  });

  it('opening: a 20-stack next to two enemy 15-stacks does not send everything at a neutral', () => {
    // 20 + 5 deployed take the neutral exactly, and leave T1 empty beside two 15-stacks (each
    // 15 + ~5). Before, it attacked with 25.
    const b = shape(20, 1);
    const p = plan(b);
    expect(p.profile.phase).toBe('opening');
    expect(attacks(p)).toEqual([]);
    expect(p.conceded).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(
      /Standing still: no capture is planned, and the cheapest expansion \(T3 \(#3\), 25 armies, toward bonus Far \(#501\)\) is not taken: attacking it would leave T1 \(#1\) unable to hold its border/,
    );
    expect(p.rationale.join('\n')).not.toMatch(/frontier stop is waived/);
    expect(deploySum(p)).toBe(5);
    expect(ok(p, b)).toEqual([]);
  });

  it('opening: nor in a combined capture that leaves the border stack short (15 from behind, 10 from the border)', () => {
    // No single stack can afford the 25: T2 wears the neutral down with all 15 and T1 finishes
    // with 10 of its 15, leaving 5 (10 with every deploy) beside two 15-stacks. Before, it did.
    const b = shape(15, 15);
    const p = plan(b);
    expect(p.profile.phase).toBe('opening');
    expect(attacks(p)).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(/Standing still: .*T3 \(#3\).* is not taken: attacking it would leave T1 \(#1\) unable to hold its border/);
    expect(p.rationale.join('\n')).not.toMatch(/frontier stop is waived/);
    expect(ok(p, b)).toEqual([]);
  });

  it('a stack that still holds once the attack leaves does attack', () => {
    // A 4-neutral: 6 of the 22 take it, and the 16 left (21 with the deploys) need 27 or more.
    const b = shape(22, 1, 4);
    const p = plan(b);
    expect(p.profile.phase).toBe('opening');
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 3, armies: 6 })]);
    expect(ok(p, b)).toEqual([]);
  });

  it('a stack left short gets the deploys still available there that make it hold, then attacks', () => {
    // 14 − 6 leaves 8, which 13 take; all 5 deploys make it 13, which need 21.
    const b = shape(14, 1, 4);
    const p = plan(b);
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 3, armies: 6 })]);
    expect(deployedTo(p, 1)).toBe(5);
    expect(p.rationale.join('\n')).toMatch(/Deploy 5 to T1 \(#1\) so it still holds its border after the attack on T3 \(#3\) \(13 stay against a threat of 20\)/);
    expect(ok(p, b)).toEqual([]);
  });

  it('one army fewer and the deploys cannot make it hold: no attack', () => {
    // 13 − 6 leaves 7; with all 5 deploys 12, which 20 take.
    const b = shape(13, 1, 4);
    const p = plan(b);
    expect(attacks(p)).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(/is not taken: attacking it would leave T1 \(#1\) unable to hold its border \(7 would stay, 12 with the 5 deploys left there, against a threat of 20\)/);
    expect(ok(p, b)).toEqual([]);
  });

  it('a source with no enemy next to it is free to send everything, as before', () => {
    // T2 has no enemy neighbour: 20 + 5 take the neutral and nothing is left to fall.
    const b = shape(1, 20);
    const p = plan(b);
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 2, to: 3, armies: 25 })]);
    expect(ok(p, b)).toEqual([]);
  });
});

// #114: an 8-player FFA in contact, at 60/70, every neutral 15, income 5. The contact fallback
// still took a 15-neutral with 25 (≈11 lost): rule 4d's frontier stop refused the empty enemy
// territory next to one 15-stack, and the 4-army enemy territory next to the other left no line
// at all (its owner could not attack me, so rule 0p.2 tried it only after the neutral, which was
// taken first, and nothing reported the candidates never tried). In the contact/late fallback 4d
// is now a cost, not a veto: a capture's ranking cost is the armies it is expected to lose plus
// the survivors it leaves on a border that cannot hold next turn; and every candidate the
// fallback drops is named with its reason.
describe('#114: the contact fallback counts the frontier as armies at risk, not a veto', () => {
  const EIGHT: PlanGameContext = { players: [ME, P2, P3, 50, 60, 70, 80, 90].map((id) => ({ id })), turn: 3 };
  //   My 15-stacks on 1 and 2, a 25-stack on 8 behind them, and a 1-army 7 (conceded).
  //   1 borders 23 (player 40, 0) and 24 (player 30, 12); 2 borders 22 (player 30, 4) and 25
  //   (player 40, 12). 23 then faces 25, 22 faces 24. Crown (+6) is the four 15-neutrals 3 4 5 6:
  //   8 alone reaches 3 (25 to take). 7 borders 25 (player 40 can attack me) and, when
  //   `bothFront`, 24 (so can player 30). 26 and 27 keep both players out of my reach.
  const shape = (bothFront: boolean) =>
    makeMap(
      [1, 2, 3, 4, 5, 6, 7, 8, 22, 23, 24, 25, 26, 27],
      [
        [1, 2], [8, 1], [8, 2], [8, 3], [1, 23], [1, 24], [2, 4], [2, 22], [2, 25], [2, 7],
        [3, 4], [4, 5], [5, 6], [22, 24], [23, 25], [7, 25], [24, 26], [25, 27],
        ...(bothFront ? ([[7, 24]] as [number, number][]) : []),
      ],
      [[701, 'Crown', 6, [3, 4, 5, 6]]],
    );
  const shapeBoard = (): BoardState =>
    board([
      mine(1, 15),
      mine(2, 15),
      mine(7, 1),
      mine(8, 25),
      neutral(3, 15),
      neutral(4, 15),
      neutral(5, 15),
      neutral(6, 15),
      player(22, 4, P2),
      player(23, 0, P3),
      player(24, 12, P2),
      player(25, 12, P3),
      player(26, 3, P2),
      player(27, 3, P3),
    ]);
  const run = (b: BoardState, map: GameMap) =>
    planTurn({ graph: buildGraph(map), board: b, me: ME, income: 5, settings: STD, game: EIGHT, options: { adapt: false } });

  it('the arithmetic: the empty one loses nothing, the 4 loses ~3, the 15-neutral ~11', () => {
    expect(armiesToTake(0)).toBe(1);
    expect(armiesToTake(4)).toBe(6);
    expect(armiesToTake(15)).toBe(25);
    expect(straightKills(4, 70)).toBe(3);
    expect(straightKills(15, 70)).toBe(11);
    // 25's threat on 23: 11 movable + ~5 deploy = 16; 1 survivor (2 to take) cannot hold.
    expect(armiesToTake(1)!).toBeLessThanOrEqual(16);
  });

  it('takes the empty enemy territory 4d refused, not the 15-neutral, and names its survivors at risk', () => {
    const map = shape(false);
    const b = shapeBoard();
    const p = run(b, map);
    expect(p.profile.phase).toBe('contact');
    expect(p.conceded).toEqual([7]);
    // 23 costs 0 lost + 1 survivor at risk = 1; the neutral costs 11 (3 faces no enemy).
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 23, kind: 'attack' })]);
    expect(attacks(p)[0]!.reason).toMatch(
      /^cheapest capture \(loses no armies, and its 1 survivor may fall next turn\): takes a territory of player 40/,
    );
    expect(p.expected.captures).toEqual([23]);
    const r = p.rationale.join('\n');
    expect(r).toMatch(/Take T23 \(#23\) though no planned capture is economic/);
    // The 4d refusal is not said of a capture the fallback takes.
    expect(r).not.toMatch(/Do not take T23/);
    expect(p.warnings.join('\n')).not.toMatch(/T23 \(#23\) \(the frontier would need/);
    expect(r).not.toMatch(/Attack T3 \(#3\)|Attack T22 \(#22\)/);
    // Every candidate dropped has a reason: the 4 (its owner cannot attack me, so it is tried
    // last) and the neutral (it costs more).
    const line = p.rationale.find((l) => l.startsWith('Other candidates not taken: '));
    expect(line).toBeDefined();
    expect(line).toMatch(/T3 \(#3\) is ranked after T23 \(#23\): it costs 11 \(loses ~11 armies\) against 1/);
    expect(line).toMatch(/T22 \(#22\) is ranked after T23 \(#23\): player 30 cannot attack me now, so it is tried only after every other capture/);
    expect(valid(p, b, 5, map)).toEqual([]);
  });

  it('when both owners can attack me: the 4 costs 3 lost + its survivors at risk, still above the empty one', () => {
    const map = shape(true);
    const b = shapeBoard();
    const p = run(b, map);
    expect(p.profile.phase).toBe('contact');
    expect(attacks(p).map((m) => [m.from, m.to])).toEqual([[1, 23]]);
    const line = p.rationale.find((l) => l.startsWith('Other candidates not taken: '))!;
    // 22: 6 sent, 3 lost, 3 survivors facing 24 (threat 16) = 6; the neutral 11.
    expect(line).toMatch(/T22 \(#22\) is ranked after T23 \(#23\): it costs 6 \(loses ~3 armies, and its 3 survivors may fall next turn\) against 1/);
    expect(line).toMatch(/T3 \(#3\) is ranked after T23 \(#23\): it costs 11 \(loses ~11 armies\) against 1/);
    expect(valid(p, b, 5, map)).toEqual([]);
  });

  it('outside the fallback 4d still stops a capture that grows the enemy frontier past income', () => {
    // 9, a 1-neutral next to 8, completes Nook (+2): an economic capture, so no fallback runs.
    // Enemy territories are no plain-expansion target under `balanced`, so 4d's stop is shown on
    // the neutral 11 (1 army, in no bonus) next to 1 and to player 40's 12-stack on 25: plain
    // expansion (pass 3) tries it, and its 2 survivors there would need 8 more to hold.
    const base = shape(false);
    const map = makeMap(
      [...base.territories.map((t) => t.id), 9, 11],
      [
        [1, 2], [8, 1], [8, 2], [8, 3], [1, 23], [1, 24], [2, 4], [2, 22], [2, 25], [2, 7],
        [3, 4], [4, 5], [5, 6], [22, 24], [23, 25], [7, 25], [24, 26], [25, 27], [8, 9], [1, 11], [11, 25],
      ],
      [
        [701, 'Crown', 6, [3, 4, 5, 6]],
        [702, 'Nook', 2, [9]],
      ],
    );
    const b = board([...shapeBoard().territories, neutral(9, 1), neutral(11, 1)]);
    const p = run(b, map);
    expect(p.profile.phase).toBe('contact');
    expect(p.expected.captures).toEqual([9]);
    const r = p.rationale.join('\n');
    expect(r).toMatch(/Do not take T11 \(#11\): it adds a border facing an enemy without completing a bonus/);
    expect(r).not.toMatch(/though no planned capture is economic/);
    expect(r).not.toMatch(/Other candidates not taken/);
    expect(valid(p, b, 5, map)).toEqual([]);
  });
});
