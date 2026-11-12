// Issue #45: the planner conceded the borders facing an opponent down to two
// 2-army territories instead of finishing it off. Before conceding, it now checks
// whether attacking every territory of a fully visible, reachable opponent — each
// attack sized for that opponent's full deploy landing on it — eliminates it (or
// takes most of it). Every map, id and name here is made up.
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
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
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
});
