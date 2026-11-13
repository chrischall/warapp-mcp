// Issue #45: the planner conceded the borders facing an opponent down to two
// 2-army territories instead of finishing it off. Before conceding, it now checks
// whether attacking the territories of a fully visible, reachable opponent eliminates
// it (or cuts it to one territory, or takes at least half of it) against its best
// response: its estimated deploy is one budget, spread over its territories to save
// as many as it can. Every map, id and name here is made up.
//
//   Home  (+2): 1 2       — mine
//   Wilds (+3): 7 8 9     — neutrals: the expansion the old plan preferred
//   3 4: my thin borders, facing the opponent's 5 and 6
//
//   1─2, 1─3, 1─4, 3─4, 3─5, 4─6, 5─6, 2─7, 7─8, 2─9
import { describe, expect, it } from 'vitest';
import type { BoardState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import {
  captureCost,
  guaranteedFalls,
  planTurn,
  PRESSURE_FACTOR,
  PRESSURE_MARGIN,
  PRESSURE_MARGIN_ARMIES,
  pressureMargin,
  type PlannerSettings,
  type TurnPlan,
} from '../../src/analysis/planner.js';
import { boardStateFromLive, OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap, Player } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';

const mapOf = (edges: [number, number][], ids: number[], bonuses: GameMap['bonuses']): GameMap => ({
  id: 1,
  name: 'Endgame',
  territories: ids.map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
  })),
  bonuses,
  distributionModes: [],
});
const EDGES: [number, number][] = [
  [1, 2], [1, 3], [1, 4], [3, 4], [3, 5], [4, 6], [5, 6], [2, 7], [7, 8], [2, 9],
];
const BONUSES: GameMap['bonuses'] = [
  { id: 501, name: 'Home', value: 2, territoryIds: [1, 2], bonusIds: [] },
  { id: 502, name: 'Wilds', value: 3, territoryIds: [7, 8, 9], bonusIds: [] },
];
const MAP = mapOf(EDGES, [1, 2, 3, 4, 5, 6, 7, 8, 9], BONUSES);

// In-game ids, and the GameFeed ids the board carries (two check digits each end).
const ME = 1234;
const THEM = 5678;
const OTHER = 4321;
const player = (id: number, name: string): Player => ({
  id,
  name,
  isAI: false,
  humanTurnedIntoAI: false,
  hasCommittedOrders: false,
});
const ME_FEED = 11123499;
const THEM_FEED = 22567833;
const OTHER_FEED = 33432188;
const PLAYERS = [player(ME_FEED, 'Me'), player(THEM_FEED, 'Them'), player(OTHER_FEED, 'Other')];

const t = (territoryId: number, owner: number, armies: number): LiveTerritory => ({
  territoryId,
  fogLevel: 1,
  fogged: false,
  owner,
  armies,
});
const fog = (territoryId: number): LiveTerritory => ({ territoryId, fogLevel: 4, fogged: true, owner: -1, armies: null });
const toBoard = (live: LiveTerritory[]): BoardState => boardStateFromLive(live, PLAYERS[0]!, PLAYERS);

/** The opponent's base income is 6 (its estimate: ~6 a turn). */
const STD: PlannerSettings = {
  offensiveKillRate: 60,
  defensiveKillRate: 70,
  roundingMode: 'StraightRound',
  luckModifier: 0,
  oneArmyStandsGuard: true,
  baseIncome: 6,
};

/** #45: the opponent is down to 5 and 6, two armies each, both bordering my thin 3 and 4. */
const ENDGAME: LiveTerritory[] = [
  t(1, ME, 5), t(2, ME, 2), t(3, ME, 3), t(4, ME, 3),
  t(5, THEM, 2), t(6, THEM, 2),
  t(7, OWNER_NEUTRAL, 2), t(8, OWNER_NEUTRAL, 2), t(9, OWNER_NEUTRAL, 2),
];

const plan = (live: LiveTerritory[], income: number, extra: Partial<Parameters<typeof planTurn>[0]> = {}, map = MAP) =>
  planTurn({ graph: buildGraph(map), board: toBoard(live), me: ME_FEED, income, settings: STD, ...extra });
const named = (id: number) => ({ id, name: `T${id}` });
const validate = (p: TurnPlan, live: LiveTerritory[], income: number, map = MAP) =>
  validateTurn({
    map,
    board: live,
    myInGameId: ME,
    income,
    guard: true,
    deploys: p.deploys.map((d) => ({ territory: named(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: named(m.from), to: named(m.to), armies: m.armies })),
  });
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const deployedTo = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
const deploySum = (p: TurnPlan) => p.deploys.reduce((s, d) => s + d.armies, 0);
const outOf = (p: TurnPlan, id: number) => p.moves.filter((m) => m.from === id).reduce((s, m) => s + m.armies, 0);

describe('finishing off a weak opponent (#45)', () => {
  it('the worst case is sized by hand: 2 defenders + a 6 deploy = 8, which takes 13 at 60/70', () => {
    expect(armiesToTake(8, STD)).toBe(13);
    // Each thin border (3 armies) falls to the opponent's 1 movable + 6 deploy, and
    // holding it (2 more) is worth nothing: the old plan conceded both.
    expect(armiesToTake(3, STD)).toBeLessThanOrEqual(7);
  });

  it('attacks both of its territories, the deploy split onto the two border stacks, conceding nothing', () => {
    const p = plan(ENDGAME, 22);
    expect(p.conceded).toEqual([]);
    expect(p.deploys).toEqual([
      { territoryId: 3, armies: 11 },
      { territoryId: 4, armies: 11 },
    ]);
    expect(attacks(p)).toEqual([
      expect.objectContaining({ from: 3, to: 5, armies: 13 }),
      expect.objectContaining({ from: 4, to: 6, armies: 13 }),
    ]);
    expect(p.expected.captures).toEqual([5, 6]);
    expect(p.rationale.join('\n')).toMatch(/Finish off player 22567833: attack all 2 of its territories/);
    expect(p.rationale.join('\n')).toMatch(/~6 deploy/);
    expect(p.warnings.join('\n')).toMatch(/Eliminating player 22567833/);
    expect(p.warnings.join('\n')).not.toMatch(/conceded/);
    expect(() => validate(p, ENDGAME, 22)).not.toThrow();
  });

  it("the opponent's best response: one shared deploy, spent where it saves a target most cheaply", () => {
    // Saving a target costs (what the attack can take) − (its armies) + 1 deploys there.
    expect(guaranteedFalls([3, 4], 6)).toBe(1); // it saves the cheaper one, not both (3 + 4 > 6)
    expect(guaranteedFalls([7, 7], 6)).toBe(2); // neither: each needs more than all of it
    expect(guaranteedFalls([1, 6], 6)).toBe(1);
    expect(guaranteedFalls([3, 3], 6)).toBe(0); // both
    expect(guaranteedFalls([4, 4, 4], 6)).toBe(2);
    expect(guaranteedFalls([0, 9], 6)).toBe(1); // an attack too small to take it unreinforced fails for free
    expect(guaranteedFalls([], 6)).toBe(0);
  });

  it('#45 at a realistic income (10): attacks both, +6/+4 onto the two border stacks, and one must fall', () => {
    // Its ~6 deploy is one budget: 8 from T3 takes up to 5 defenders (T5 needs 4 to be saved),
    // 6 from T4 takes up to 4 (T6 needs 3). Saving both needs 7 > 6, so at least one falls
    // and it is cut to one territory. Fewer attacking armies cannot guarantee that.
    const p = plan(ENDGAME, 10);
    expect(p.conceded).toEqual([]);
    expect(p.deploys).toEqual([
      { territoryId: 3, armies: 6 },
      { territoryId: 4, armies: 4 },
    ]);
    // Cheaper attack first; T5's is sized for 3 of the ~6 landing there, T6's for 2.
    expect(attacks(p)).toEqual([
      expect.objectContaining({ from: 4, to: 6, armies: 6 }),
      expect.objectContaining({ from: 3, to: 5, armies: 8 }),
    ]);
    const why = p.rationale.join('\n');
    expect(why).toMatch(
      /Pressure player 22567833: attack all 2 of its territories \(T5 \(#5\), T6 \(#6\)\) this turn: its ~6 deploy can save at most 1 of them, so at least 1 falls, cutting it to one territory/,
    );
    expect(why).not.toMatch(/Finish off/);
    expect(p.warnings.join('\n')).toMatch(/Pressuring player 22567833 assumes it deploys at most ~6/);
    expect(p.warnings.join('\n')).toMatch(/player 22567833 chooses which of T5 \(#5\), T6 \(#6\) to save/);
    expect(p.warnings.join('\n')).not.toMatch(/conceded/);
    expect(deploySum(p)).toBe(10);
    expect(() => validate(p, ENDGAME, 10)).not.toThrow();
  });

  it('#45 at income 8: no split of 8 makes saving both cost more than its 6, so it is not attempted', () => {
    // 2 movable + 2 movable + 8 deploys = 12 attacking armies take at most 4 + 4 defenders
    // (6 and 6, or 5 + 3 with 8 and 4): saving both costs at most 3 + 3 = 6, which its ~6
    // deploy covers. Nothing is guaranteed, so the borders are judged as before: both thin
    // borders conceded (withdrawn to T1) and the 8 deployed to T2 to expand into Wilds.
    const p = plan(ENDGAME, 8);
    expect(p.rationale.join('\n')).not.toMatch(/Finish off|Pressure player/);
    expect(attacks(p).filter((m) => m.to === 5 || m.to === 6)).toEqual([]);
    expect(p.conceded).toEqual([3, 4]);
    expect(p.deploys).toEqual([{ territoryId: 2, armies: 8 }]);
    // #71: T9 (a dead end behind T2) adds no border, T7 opens one onto T8 (+0.25 in its
    // score), so at equal capture cost T9 goes first.
    expect(attacks(p)).toEqual([
      expect.objectContaining({ from: 2, to: 9, armies: 3 }),
      expect.objectContaining({ from: 2, to: 7, armies: 3 }),
    ]);
    expect(p.expected.captures).toEqual([7, 9]);
    expect(() => validate(p, ENDGAME, 8)).not.toThrow();
  });

  it('works under goal defend too', () => {
    const p = plan(ENDGAME, 22, { options: { goal: 'defend' } });
    expect(p.conceded).toEqual([]);
    expect(p.expected.captures).toEqual([5, 6]);
  });

  it('leaves the plan unchanged when the opponent is too strong to finish', () => {
    const strong = ENDGAME.map((x) => (x.owner === THEM ? { ...x, armies: 12 } : x));
    const p = plan(strong, 22);
    expect(attacks(p).filter((m) => m.to === 5 || m.to === 6)).toEqual([]);
    expect(p.conceded).toEqual([3, 4]);
    expect(p.rationale.join('\n')).not.toMatch(/Finish off/);
    expect(p.expected.captures).toEqual(expect.arrayContaining([7, 9]));
  });

  it('does not attempt an opponent partly hidden in the fog, and says so', () => {
    const map = mapOf([...EDGES, [6, 10]], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], BONUSES);
    const live = [...ENDGAME, fog(10)];
    const p = plan(live, 22, {}, map);
    expect(attacks(p).filter((m) => m.to === 5 || m.to === 6)).toEqual([]);
    expect(p.conceded).toEqual([3, 4]);
    expect(p.warnings.join('\n')).toMatch(
      /player 22567833 may hold more territories in the fog \(next to T6 \(#6\)\): finishing it off is not attempted/,
    );
  });

  it('a 3-player game: finishing one opponent still holds the border it shares with a third', () => {
    // 3 is in Home now (worth holding), and borders both the weak opponent's 5 and the other's 6.
    const map = mapOf(
      [...EDGES, [3, 6]],
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      [{ id: 501, name: 'Home', value: 3, territoryIds: [1, 2, 3], bonusIds: [] }, BONUSES[1]!],
    );
    const live: LiveTerritory[] = [
      t(1, ME, 5), t(2, ME, 2), t(3, ME, 3), t(4, ME, 3),
      t(5, THEM, 2), t(6, OTHER, 8),
      t(7, OWNER_NEUTRAL, 2), t(8, OWNER_NEUTRAL, 2), t(9, OWNER_NEUTRAL, 2),
    ];
    const p = plan(live, 25, {}, map);
    expect(attacks(p)).toContainEqual(expect.objectContaining({ from: 3, to: 5, armies: 13 }));
    expect(p.expected.captures).toContain(5);
    expect(p.conceded).not.toContain(3);
    // The other player threatens 3 with 7 movable + its ~6 deploy = 13: 3 keeps what holds that.
    const stays = 3 + deployedTo(p, 3) - outOf(p, 3);
    expect(armiesToTake(stays, STD)!).toBeGreaterThan(13);
    expect(deploySum(p)).toBe(25);
    expect(() => validate(p, live, 25, map)).not.toThrow();
  });

  it('a 3-player game: a hold facing a third player that attacks nothing is reserved before finishing off', () => {
    // 2 is in Home (+5) and faces the other player's 10 (12 armies): 11 movable + ~6 deploy = 17,
    // so it needs 7 more to hold. It is not a source against the weak opponent, so finishing that
    // opponent off (22 needed) must not spend the income that hold is worth paying for.
    const map = mapOf(
      [...EDGES, [2, 10]],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [{ id: 501, name: 'Home', value: 5, territoryIds: [1, 2], bonusIds: [] }, BONUSES[1]!],
    );
    const base: LiveTerritory[] = [
      t(1, ME, 5), t(2, ME, 4), t(3, ME, 3), t(4, ME, 3),
      t(7, OWNER_NEUTRAL, 2), t(8, OWNER_NEUTRAL, 2), t(9, OWNER_NEUTRAL, 2),
      t(10, OTHER, 12),
    ];
    // Without the weak opponent the same board holds 2 with 7.
    const alone = [...base, t(5, OWNER_NEUTRAL, 2), t(6, OWNER_NEUTRAL, 2)];
    const q = plan(alone, 22, {}, map);
    expect(q.conceded).not.toContain(2);
    expect(armiesToTake(4 + deployedTo(q, 2), STD)!).toBeGreaterThan(17);
    expect(armiesToTake(4 + 6, STD)!).toBeLessThanOrEqual(17);

    const live = [...base, t(5, THEM, 2), t(6, THEM, 2)];
    for (const goal of ['balanced', 'defend'] as const) {
      const p = plan(live, 22, { options: { goal } }, map);
      expect(p.conceded).not.toContain(2);
      expect(outOf(p, 2)).toBe(0);
      const stays = 4 + deployedTo(p, 2);
      expect(armiesToTake(stays, STD)!).toBeGreaterThan(17);
      expect(p.warnings.join('\n')).not.toMatch(/T2 \(#2\) cannot be held/);
      expect(deploySum(p)).toBe(22);
      expect(() => validate(p, live, 22, map)).not.toThrow();
    }
  });

  it('hedges the elimination when anything on the board is fogged, even away from the opponent', () => {
    // 10 is fogged, next to the neutral 8 only: the opponent may hold it, out of sight.
    const map = mapOf([...EDGES, [8, 10]], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], BONUSES);
    const live = [...ENDGAME, fog(10)];
    const p = plan(live, 22, {}, map);
    expect(p.expected.captures).toEqual(expect.arrayContaining([5, 6]));
    const why = p.rationale.join('\n');
    expect(why).toMatch(/Finish off player 22567833/);
    expect(why).not.toMatch(/so it is eliminated even if it reinforces/);
    expect(why).toMatch(/eliminated if it holds nothing in the fog/);
    expect(p.warnings.join('\n')).toMatch(/player 22567833 could still hold territories in the fog/);
    // A fully visible board keeps the plain wording.
    expect(plan(ENDGAME, 22).rationale.join('\n')).toMatch(/so it is eliminated even if it reinforces/);
  });

  it('takes most of a weak opponent when the borders it frees no longer need holding', () => {
    // A third territory, 10, borders only my 1 and holds 20: too strong to take even
    // with everything. Taking 5 and 6 still leaves it 1 of 3, and neither 3 nor 4
    // (the attacking borders) faces 10.
    const map = mapOf([...EDGES, [1, 10]], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], BONUSES);
    const live = [...ENDGAME, t(10, THEM, 20)];
    const p = plan(live, 22, {}, map);
    expect(p.expected.captures).toEqual(expect.arrayContaining([5, 6]));
    expect(p.expected.captures).not.toContain(10);
    expect(p.conceded).not.toContain(3);
    expect(p.conceded).not.toContain(4);
    expect(p.rationale.join('\n')).toMatch(/Pressure player 22567833: take 2 of its 3 territories/);
    expect(p.warnings.join('\n')).toMatch(/Pressuring player 22567833/);
    expect(() => validate(p, live, 22, map)).not.toThrow();
  });

  it('does not pressure at the cost of a hold that faces what is left of the opponent', () => {
    // 10 (8 armies) is the opponent's third territory and borders my 2 (Home, +5) only:
    // 7 movable + ~6 deploy = 13 threatens 2, which needs 7 more to hold. Attacking 10 too
    // costs too much, and taking 5 and 6 for sure (11 + 11 deploys) would leave nothing
    // for that hold, so the +5 border is not thrown away for two captures.
    const map = mapOf(
      [...EDGES, [2, 10]],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [{ id: 501, name: 'Home', value: 5, territoryIds: [1, 2], bonusIds: [] }, BONUSES[1]!],
    );
    const live = [...ENDGAME, t(10, THEM, 8)];
    for (const goal of ['balanced', 'defend'] as const) {
      const p = plan(live, 22, { options: { goal } }, map);
      expect(p.rationale.join('\n')).not.toMatch(/Pressure player|Finish off/);
      expect(p.conceded).not.toContain(2);
      expect(p.warnings.join('\n')).not.toMatch(/T2 \(#2\) cannot be held/);
      expect(armiesToTake(2 + deployedTo(p, 2) - outOf(p, 2), STD)!).toBeGreaterThan(13);
      expect(deploySum(p)).toBe(22);
      expect(() => validate(p, live, 22, map)).not.toThrow();
    }
    // With 7 more income both the hold and the two captures fit: pressure, and 2 holds.
    for (const goal of ['balanced', 'defend'] as const) {
      const p = plan(live, 29, { options: { goal } }, map);
      expect(p.rationale.join('\n')).toMatch(
        /Pressure player 22567833: take 2 of its 3 territories \(T5 \(#5\), T6 \(#6\)\) this turn, each sized for its full ~6 deploy landing there, cutting it to one territory; T10 \(#10\) stays unattacked/,
      );
      expect(attacks(p)).toEqual([
        expect.objectContaining({ from: 3, to: 5, armies: 13 }),
        expect.objectContaining({ from: 4, to: 6, armies: 13 }),
      ]);
      expect(p.conceded).not.toContain(2);
      expect(armiesToTake(2 + deployedTo(p, 2) - outOf(p, 2), STD)!).toBeGreaterThan(13);
      expect(deploySum(p)).toBe(29);
      expect(() => validate(p, live, 29, map)).not.toThrow();
    }
  });

  it('attacks a weak third territory too when that guarantees more for fewer armies', () => {
    // 10 (4 armies) borders only my 2. Attacking all three, its ~6 deploy can save only the
    // cheapest one (3 for T6, then 4 and 4): two must fall, cutting it to one territory, with
    // 25 attacking armies instead of 26 for taking 5 and 6 for sure (plus 2's hold).
    const map = mapOf(
      [...EDGES, [2, 10]],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [{ id: 501, name: 'Home', value: 5, territoryIds: [1, 2], bonusIds: [] }, BONUSES[1]!],
    );
    const live = [...ENDGAME, t(10, THEM, 4)];
    const p = plan(live, 22, {}, map);
    expect(attacks(p).filter((m) => [5, 6, 10].includes(m.to))).toEqual([
      expect.objectContaining({ from: 4, to: 6, armies: 6 }),
      expect.objectContaining({ from: 3, to: 5, armies: 8 }),
      expect.objectContaining({ from: 2, to: 10, armies: 11 }),
    ]);
    expect(p.rationale.join('\n')).toMatch(
      /Pressure player 22567833: attack all 3 of its territories \(T5 \(#5\), T6 \(#6\), T10 \(#10\)\) this turn: its ~6 deploy can save at most 1 of them, so at least 2 fall, cutting it to one territory/,
    );
    expect(p.conceded).toEqual([]);
    expect(deploySum(p)).toBe(22);
    expect(() => validate(p, live, 22, map)).not.toThrow();
  });

  it('does not pressure when an attacking border still faces what is left of the opponent', () => {
    // 10 (20 armies) also borders my 3: after 3 attacks 5, 3 would face 10 alone.
    const map = mapOf([...EDGES, [3, 10]], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], BONUSES);
    const live = [...ENDGAME, t(10, THEM, 20)];
    const p = plan(live, 22, {}, map);
    expect(p.rationale.join('\n')).not.toMatch(/Pressure player/);
    expect(attacks(p).filter((m) => m.to === 5 || m.to === 6 || m.to === 10)).toEqual([]);
  });

  it('never concedes a border captured from the weak opponent last turn', () => {
    // Too poor to finish it this turn (8 income, 22 needed), so the old triage runs —
    // but 3 was the opponent's a turn ago: conceding it hands it straight back.
    const previous = toBoard([...ENDGAME.filter((x) => x.territoryId !== 3), t(3, THEM, 4)]);
    const p = plan(ENDGAME, 8, { previousBoard: previous });
    expect(p.rationale.join('\n')).not.toMatch(/Finish off/);
    expect(p.conceded).toEqual([4]);
    expect(deployedTo(p, 3)).toBeGreaterThanOrEqual(2);
    expect(p.rationale.join('\n')).toMatch(/T3 \(#3\) was captured from player 22567833 last turn/);
    // Without the history it is conceded like 4.
    expect(plan(ENDGAME, 8).conceded).toEqual([3, 4]);
  });

  it('says a recently captured border is held only when its hold is funded', () => {
    const previous = toBoard([...ENDGAME.filter((x) => x.territoryId !== 3), t(3, THEM, 4)]);
    const recent = /T3 \(#3\) was captured from player 22567833 last turn/;
    // defend, too poor to hold it (12 next to it: 11 movable + ~6 deploy = 17): conceded,
    // never also called held.
    // The 12 stood there last turn too: no observed growth raises its ~6 deploy (#57).
    const heavy = ENDGAME.map((x) => (x.territoryId === 5 ? { ...x, armies: 12 } : x));
    const heavyBefore = toBoard([...heavy.filter((x) => x.territoryId !== 3), t(3, THEM, 4)]);
    const poor = plan(heavy, 7, { previousBoard: heavyBefore, options: { goal: 'defend' } });
    expect(poor.warnings.join('\n')).toMatch(/T3 \(#3\) cannot be held with the 7 armies left/);
    expect(poor.conceded).toContain(3);
    expect(poor.rationale.join('\n')).not.toMatch(recent);
    // defend, funded: held, and the line says why it was not conceded economically.
    const held = plan(ENDGAME, 8, { previousBoard: previous, options: { goal: 'defend' } });
    expect(deployedTo(held, 3)).toBeGreaterThanOrEqual(2);
    expect(held.rationale.join('\n')).toMatch(/last turn, and that opponent is weak: it is not conceded economically/);
    // expand reserves nothing for it: no line claiming it is held.
    const expand = plan(ENDGAME, 8, { previousBoard: previous, options: { goal: 'expand' } });
    expect(expand.rationale.join('\n')).not.toMatch(recent);
  });
});

// Issue #60: the opponent's one visible territory (0 armies) sat next to my 7-stack, but it
// borders the fog, so the finish-off check skipped it. Fog is a reason not to claim
// elimination, not to skip a capture that costs about what expansion does. Live, an 11-army
// attack sized for exactly its ~6 estimated deploy FAILED (it deployed more): pressure is
// sized with a margin over the full deploy (PRESSURE_MARGIN), and that margin-sized cost is
// what the PRESSURE_FACTOR gate judges. At ~6 the #60 shape costs 15 — five 2-army neutrals,
// "more than the expansion it displaces" — so the cautious choice (not attempted) stands; a
// weaker opponent (~4) is pressured.
//
//   1─2, 1─5, 5─10, 2─7, 1─8 — 1 (my 7-stack), 2 mine; 5 theirs; 10 fogged; 7, 8 neutral (2).
describe('pressure on a weak opponent next to the fog (#60)', () => {
  const MAP60 = mapOf(
    [[1, 2], [1, 5], [5, 10], [2, 7], [1, 8]],
    [1, 2, 5, 7, 8, 10],
    [
      { id: 501, name: 'Home', value: 2, territoryIds: [1, 2], bonusIds: [] },
      { id: 502, name: 'Wilds', value: 3, territoryIds: [7, 8], bonusIds: [] },
    ],
  );
  const board60 = (theirs: number, ten: LiveTerritory = fog(10)): LiveTerritory[] => [
    t(1, ME, 7), t(2, ME, 2), t(5, THEM, theirs), t(7, OWNER_NEUTRAL, 2), t(8, OWNER_NEUTRAL, 2), ten,
  ];
  /** No visible neutral next to me: 7 and 8 are mine too. */
  const noNeutrals60 = (theirs: number): LiveTerritory[] => [
    t(1, ME, 7), t(2, ME, 2), t(5, THEM, theirs), t(7, ME, 2), t(8, ME, 2), fog(10),
  ];

  it('the margin by hand: at least ceil((deploy + 1) / 0.6) plus a buffer, never under PRESSURE_MARGIN_ARMIES', () => {
    expect(PRESSURE_MARGIN).toBe(0.5);
    expect(PRESSURE_MARGIN_ARMIES).toBe(2);
    expect(pressureMargin(0)).toBe(2);
    expect(pressureMargin(4)).toBe(2);
    expect(pressureMargin(6)).toBe(3);
    expect(pressureMargin(9)).toBe(5);
    // The #60 sizing that failed live: exactly the ~6 deploy, 10 armies. With the margin: 15,
    // over the owner's floor of ceil(7 / 0.6) = 12.
    expect(captureCost(0 + 6, STD)).toBe(10);
    expect(captureCost(0 + 6 + pressureMargin(6), STD)).toBe(15);
    expect(captureCost(0 + 6 + pressureMargin(6), STD)!).toBeGreaterThan(Math.ceil(7 / 0.6));
  });

  it('the gate by hand: PRESSURE_FACTOR × a 2-army neutral (3) is 12 — ~6 on 0 (15) is over it, ~4 on 0 (10) under', () => {
    expect(PRESSURE_FACTOR).toBe(4);
    expect(PRESSURE_FACTOR * captureCost(2, STD)!).toBe(12);
    expect(captureCost(0 + 4 + pressureMargin(4), STD)).toBe(10);
    expect(captureCost(3 + 6 + pressureMargin(6), STD)).toBe(20);
  });

  it('#60 at ~6: the margin-sized capture (15) costs more than the expansion it displaces, so it is not attempted', () => {
    const live = board60(0);
    for (const goal of ['balanced', 'defend'] as const) {
      const p = plan(live, 8, { options: { goal } }, MAP60);
      // Never the 10-army attack that failed live.
      expect(attacks(p).filter((m) => m.to === 5)).toEqual([]);
      expect(p.rationale.join('\n')).not.toMatch(/Pressure player|Finish off/);
      expect(p.warnings.join('\n')).toMatch(
        /player 22567833 may hold more territories in the fog \(next to T5 \(#5\)\): finishing it off is not attempted/,
      );
      expect(() => validate(p, live, 8, MAP60)).not.toThrow();
    }
  });

  it('a weaker opponent (~4): its one visible 0-army territory is attacked with a margin over its full deploy, as pressure', () => {
    const live = board60(0);
    for (const goal of ['balanced', 'defend'] as const) {
      const p = plan(live, 8, { options: { goal, enemyDeploy: 4 } }, MAP60);
      expect(attacks(p)).toContainEqual(expect.objectContaining({ from: 1, to: 5, armies: 10 }));
      expect(p.expected.captures).toContain(5);
      const why = p.rationale.join('\n');
      expect(why).toMatch(
        /Pressure player 22567833: take all 1 of its visible territories \(T5 \(#5\)\) this turn, each sized for its full ~4 deploy plus a margin of 2 landing there; it may hold more in the fog \(next to T5 \(#5\)\), so this is not an elimination/,
      );
      expect(why).not.toMatch(/Finish off/);
      const warn = p.warnings.join('\n');
      expect(warn).not.toMatch(/finishing it off is not attempted/);
      expect(warn).not.toMatch(/Eliminating player/);
      expect(warn).toMatch(/Pressuring player 22567833 assumes it deploys at most ~6 \(its ~4 estimate plus a margin of 2\)/);
      expect(warn).toMatch(
        /player 22567833 may hold more territories in the fog \(next to T5 \(#5\)\): taking its 1 visible territories is pressure, not an elimination/,
      );
      expect(deploySum(p)).toBe(8);
      expect(() => validate(p, live, 8, MAP60)).not.toThrow();
    }
  });

  it('with no visible neutral next to me there is no expansion to compare with: the #60 shape is pressured, margin included', () => {
    const live = noNeutrals60(0);
    const p = plan(live, 10, {}, MAP60);
    expect(attacks(p)).toContainEqual(expect.objectContaining({ from: 1, to: 5, armies: 15 }));
    expect(p.rationale.join('\n')).toMatch(/Pressure player 22567833: take all 1 of its visible territories/);
    expect(() => validate(p, live, 10, MAP60)).not.toThrow();
  });

  it('a visible territory too costly (3 armies + ~6 + 3 = 20 > 12) is not attacked, and warned as before', () => {
    const live = board60(3);
    const p = plan(live, 12, {}, MAP60);
    expect(attacks(p).filter((m) => m.to === 5)).toEqual([]);
    expect(p.rationale.join('\n')).not.toMatch(/Pressure player|Finish off/);
    expect(p.warnings.join('\n')).toMatch(
      /player 22567833 may hold more territories in the fog \(next to T5 \(#5\)\): finishing it off is not attempted, though its 1 visible territories could all be taken this turn/,
    );
    expect(() => validate(p, live, 12, MAP60)).not.toThrow();
  });

  it('the gate is all-or-nothing: one dear visible territory blocks pressure on a cheap one beside it', () => {
    // 1─6 added: 6 is theirs with 3 armies (3 + 4 + 2 = 9 → 15 > 12); 5 alone (0 → 10) would pass.
    const map = mapOf(
      [[1, 2], [1, 5], [1, 6], [5, 10], [2, 7], [1, 8]],
      [1, 2, 5, 6, 7, 8, 10],
      [
        { id: 501, name: 'Home', value: 2, territoryIds: [1, 2], bonusIds: [] },
        { id: 502, name: 'Wilds', value: 3, territoryIds: [7, 8], bonusIds: [] },
      ],
    );
    // T1 holds 14: the 11 it can spare beyond its hold do not pay for 6's 15 (#120), so the gate
    // still prices it against expansion.
    const live = [
      t(1, ME, 14), t(2, ME, 2), t(5, THEM, 0), t(6, THEM, 3), t(7, OWNER_NEUTRAL, 2), t(8, OWNER_NEUTRAL, 2), fog(10),
    ];
    const p = plan(live, 12, { options: { enemyDeploy: 4 } }, map);
    expect(attacks(p).filter((m) => m.to === 5 || m.to === 6)).toEqual([]);
    expect(p.rationale.join('\n')).not.toMatch(/Pressure player|Finish off/);
    expect(() => validate(p, live, 12, map)).not.toThrow();
    // With 20 on T1, its idle armies pay for 6 outright: no expansion is displaced, so the gate is
    // waived for it (#120) and both fall.
    const idle = [
      t(1, ME, 20), t(2, ME, 2), t(5, THEM, 0), t(6, THEM, 3), t(7, OWNER_NEUTRAL, 2), t(8, OWNER_NEUTRAL, 2), fog(10),
    ];
    const q = plan(idle, 12, { options: { enemyDeploy: 4 } }, map);
    expect(q.expected.captures).toEqual(expect.arrayContaining([5, 6]));
    expect(q.rationale.join('\n')).toMatch(/T6 \(#6\) \(15\) is paid from idle armies on T1 \(#1\)/);
    expect(() => validate(q, idle, 12, map)).not.toThrow();
  });

  it('full visibility still uses the elimination path, sized for the plain estimate (no pressure margin)', () => {
    const live = board60(3, t(10, OWNER_NEUTRAL, 2));
    const p = plan(live, 12, {}, MAP60);
    expect(attacks(p)).toContainEqual(expect.objectContaining({ from: 1, to: 5, armies: 15 }));
    expect(p.rationale.join('\n')).toMatch(/Finish off player 22567833: attack all 1 of its territories/);
    expect(p.rationale.join('\n')).not.toMatch(/visible territories/);
    expect(() => validate(p, live, 12, MAP60)).not.toThrow();
  });
});
