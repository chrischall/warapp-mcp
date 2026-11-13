// Issue #72: the planner goes on offence. It breaks bonuses the opponent tracker infers behind
// the fog, sizes a break to land (not to survive the counter-attack), treats "behind on income"
// in a 1v1 as a reason to strike rather than defend, refuses bad trades when behind on armies,
// concentrates its spare deploys into one strike stack facing the strongest opponent, and
// counter-attacks a stack that just spent itself attacking me. Every map, id and name here is
// made up. Kill rates 60/70, no luck: armiesToTake 1:2 2:3 3:5 4:6 5:8 6:10 8:13 9:15 10:16.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import type { OpponentTrack } from '../../src/analysis/opponents.js';
import {
  captureCost,
  NEUTRAL_BORDER_COST,
  PAYBACK_TURNS,
  planTurn,
  type PlanInput,
  type PlannerSettings,
  type TurnPlan,
} from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const THIRD = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  return {
    id: 1,
    name: 'Synthetic offence',
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
const deployedTo = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;

/** A track observed over two turns with `income`, and the bonus combinations that fit its gap. */
function track(playerId: number, income: number, candidates: number[][] = [], visibleIncome = 5): OpponentTrack {
  const turn = { from: 0, to: 1, observed: income, raw: income, cap: income, counted: [], captured: [], fromFog: [], reveals: [], visibleIncome, earned: income, net: 0, losses: 0 };
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
    unaccounted: 0,
    inferred: candidates.length
      ? {
          gap: income - visibleIncome,
          exact: true,
          candidates: candidates.map((ids) => ({ bonusIds: ids, total: income - visibleIncome })),
          more: 0,
        }
      : null,
    notes: [],
  };
}

// T1 (12) faces the enemy's T5 (3), the one visible member of B901 (+5: T5 with fogged T6, T7).
// Behind T5 sits the enemy's 20-stack on T8. Its tracked income is 10 against a visible 5: a
// gap of 5 that B901 fits. B902 (+5) is fogged T9 alone.
describe('break an inferred bonus (#72)', () => {
  const g = buildGraph(
    makeMap(
      [1, 5, 6, 7, 8, 9],
      [
        [1, 5],
        [5, 6],
        [6, 7],
        [5, 8],
        [8, 9],
      ],
      [
        [901, 5, [5, 6, 7]],
        [902, 5, [9]],
      ],
    ),
  );
  const s = board([mine(1, 12), enemy(5, 3), fogged(6), fogged(7), enemy(8, 20), fogged(9)]);
  const input = (tracks?: OpponentTrack[]): PlanInput => ({ graph: g, board: s, me: ME, income: 5, settings: STD, ...(tracks ? { tracks } : {}) });

  it('without a track, a partly fogged bonus is never broken', () => {
    const p = planTurn(input());
    expect(attacks(p)).toEqual([]);
    expect(p.offence).toEqual([]);
  });

  it('in every candidate combination: its visible member is attacked at the landing size, "probable"', () => {
    const p = planTurn(input([track(ENEMY, 10, [[901]])]));
    // Landing size: the 3 defenders present, nothing for the ~10 deploy or the 20-stack behind it.
    expect(captureCost(3, STD)).toBe(5);
    expect(why(p)).toMatch(
      /Attack T5 \(#5\) from T1 \(#1\) with 5: breaks probable enemy bonus B901 \(#901\) \(\+5 from player 20; in every combination of bonuses that fits its income gap\)/,
    );
    expect(attacks(p).map((m) => [m.from, m.to])).toEqual([[1, 5]]);
    // 5 − round(0.7 × 3) = 3 survivors, retaken for 5: worth 5 + 5 / 10 = 5.5.
    expect(p.offence).toEqual([
      expect.objectContaining({ target: 5, kind: 'break', cost: 5, value: 5.5, taken: true }),
    ]);
    expect(p.offence[0]!.why).toMatch(/probable/);
    expect(p.warnings.join('\n')).toMatch(/T5 \(#5\) can be retaken after it breaks B901/);
  });

  it("in the tracker's best fit only: still probable", () => {
    const p = planTurn(input([track(ENEMY, 10, [[901], [902]])]));
    expect(attacks(p).map((m) => m.to)).toEqual([5]);
    expect(why(p)).toMatch(/breaks probable enemy bonus B901 \(#901\) \(\+5 from player 20; in the best fit of its income gap\)/);
  });

  it('a bonus only a weaker fit lists is not a break target', () => {
    const p = planTurn(input([track(ENEMY, 10, [[902], [901]])]));
    expect(attacks(p)).toEqual([]);
  });

  it('a track over fewer than two observed turns is not trusted', () => {
    const t = track(ENEMY, 10, [[901]]);
    const p = planTurn(input([{ ...t, turns: t.turns.slice(0, 1) }]));
    expect(attacks(p)).toEqual([]);
  });
});

// Size a break to land, not to survive. T1 (5) faces T5 (3), a member of the enemy's fully visible
// B905 (+5: T5 and its 30-stack T6). T2 (1) faces the neutral T3 (2) of B906 (+3: T3, T4).
// Income 3 pays one deploy: T5 needs 1 more on T1, the advance on T3 needs 3.
describe('a break is scored on landing (#72 with #71)', () => {
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6],
      [
        [1, 2],
        [1, 5],
        [5, 6],
        [2, 3],
        [3, 4],
      ],
      [
        [905, 5, [5, 6]],
        [906, 3, [3, 4]],
      ],
    ),
  );
  const s = board([mine(1, 5), mine(2, 1), neutral(3, 2), neutral(4, 2), enemy(5, 3), enemy(6, 30)]);

  it("the captured territory's own hold need is out of its score; the frontier of the other borders stays", () => {
    const p = planTurn({ graph: g, board: s, me: ME, income: 3, settings: STD });
    // Break: worth 5 + armiesToTake(3 survivors) / 10 = 5.5 over 5 armies + frontier 0 (T5 opens a
    // border, +0.25; T1 closes one, −0.25) = 1.1 per army. Holding T5 against 29 + 5 would need
    // 18 more (#71's sizing), which no longer counts. The advance: 3 / (3 + 3 + 0) = 0.5.
    expect(armiesToTake(3, STD)).toBe(5);
    expect(NEUTRAL_BORDER_COST).toBe(0.25);
    expect(PAYBACK_TURNS).toBe(10);
    expect(attacks(p).map((m) => [m.from, m.to])).toEqual([[1, 5]]);
    expect(deployedTo(p, 1)).toBeGreaterThanOrEqual(1);
    expect(p.offence).toEqual([expect.objectContaining({ target: 5, kind: 'break', cost: 5, value: 5.5, taken: true })]);
  });
});

// Rule 0p.3 (S1, changed by #72). T1 (9) faces T5 (6) of the enemy's visible B902 (+4: T5, T6);
// T11 (15) faces its 16-stack T9. T2 (1) faces the neutral T3 (3) of B903 (+3: T3, T4).
// Enemy ~9 (5 + 4) against my 5: behind on income. The break needs 2 deploys, the neutral 5.
describe('behind on income in a 1v1 means strike', () => {
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6, 9, 11],
      [
        [1, 2],
        [1, 5],
        [1, 11],
        [2, 3],
        [3, 4],
        [5, 6],
        [9, 11],
      ],
      [
        [902, 4, [5, 6]],
        [903, 3, [3, 4]],
      ],
    ),
  );
  const s = board([mine(1, 9), mine(2, 1), mine(11, 15), neutral(3, 3), neutral(4, 4), enemy(5, 6), enemy(6, 2), enemy(9, 16)]);
  const input = (players: number[], options: PlanInput['options'] = { adapt: true }): PlanInput => ({
    graph: g,
    board: s,
    me: ME,
    income: 5,
    settings: STD,
    game: { players: players.map((id) => ({ id })) },
    options,
  });

  it('1v1: the goal stays balanced, the break is made and the neutral waits', () => {
    const p = planTurn(input([ME, ENEMY]));
    expect(p.profile).toMatchObject({ format: '1v1', standing: 'behind' });
    expect(p.goal).toBe('balanced');
    expect(why(p)).toMatch(
      /Goal balanced from the game profile \(1v1, contact, behind\): behind on income \(5 against ~9\) in a 1v1 — strike: break the opponent's bonuses with minimal attacks before expansion that completes nothing/,
    );
    expect(attacks(p).map((m) => [m.from, m.to])).toEqual([[1, 5]]);
    expect(p.offence).toContainEqual(expect.objectContaining({ target: 5, kind: 'break', taken: true }));
  });

  it('the old rule would have defended: goal defend takes the neutral and breaks nothing', () => {
    const p = planTurn(input([ME, ENEMY], { goal: 'defend' }));
    expect(attacks(p).map((m) => m.to)).toEqual([3]);
  });

  it('an FFA still defends when behind', () => {
    const p = planTurn(input([ME, ENEMY, THIRD]));
    expect(p.goal).toBe('defend');
    expect(attacks(p).map((m) => m.to)).not.toContain(5);
  });
});

// Behind on armies: no trade below even. T1 and T2 (10 each) both face T5 (10) of the enemy's
// visible B904 (+1: T5, T6). Neither alone affords its 16 (9 movable + income 5), so the break is
// a combined capture: T2 wears it down with 9 (kills 5, loses 7), T1 finishes with 8 (kills 5,
// loses 4) — 11 lost for 10 killed. Enemy ~6 against my 5: even on income.
describe('behind on armies: no trade below even', () => {
  const g = buildGraph(
    makeMap(
      [1, 2, 5, 6],
      [
        [1, 2],
        [1, 5],
        [2, 5],
        [5, 6],
      ],
      [[904, 1, [5, 6]]],
    ),
  );
  const plan = (t6: number) =>
    planTurn({
      graph: g,
      board: board([mine(1, 10), mine(2, 10), enemy(5, 10), enemy(6, t6)]),
      me: ME,
      income: 5,
      settings: STD,
      game: { players: [{ id: ME }, { id: ENEMY }] },
      options: { adapt: true },
    });

  it('level on armies (20 against 12): the combined break is made', () => {
    const p = plan(2);
    expect(p.profile.standing).toBe('even');
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([
      [2, 5, 9],
      [1, 5, 8],
    ]);
  });

  it('behind on armies (20 against 30): it is not, and the rationale says why', () => {
    const p = plan(20);
    expect(p.profile.standing).toBe('even');
    expect(attacks(p)).toEqual([]);
    expect(why(p)).toMatch(/Behind on armies \(20 visible against player 20's 30\)/);
    expect(why(p)).toMatch(/Not attacking T5 \(#5\): the combined capture loses 11 armies for the 10 it kills, a trade below even while behind on armies/);
    expect(p.offence).toContainEqual(expect.objectContaining({ target: 5, kind: 'break', taken: false }));
  });

  it('exactly 0.8x (20 against 25) is not behind: the plan says "< 0.8x"', () => {
    expect(why(plan(15))).not.toMatch(/Behind on armies/);
  });

  it('a commander counts as 7 on each side: 20 + 7 against 30 is not behind', () => {
    const p = planTurn({
      graph: g,
      board: board([mine(1, 10), { ...mine(2, 10), specialUnits: [{ kind: 'commander', id: '1'.padStart(32, '0'), playerId: ME }] }, enemy(5, 10), enemy(6, 20)]),
      me: ME,
      income: 5,
      settings: STD,
      game: { players: [{ id: ME }, { id: ENEMY }] },
      options: { adapt: true },
    });
    expect(why(p)).not.toMatch(/Behind on armies/);
  });

  // The invariant behind refusing only combined captures: a single capture kills every defender
  // and loses at most round(defenders x defensive rate) <= defenders, so it never trades below
  // even, whatever the kill rates.
  it.each([
    [100, 100],
    [30, 100],
    [60, 70],
  ])('a single capture while behind is still made (kill rates %i/%i)', (offensiveKillRate, defensiveKillRate) => {
    const g1 = buildGraph(
      makeMap(
        [1, 5, 6],
        [
          [1, 5],
          [5, 6],
        ],
        [[905, 1, [5, 6]]],
      ),
    );
    const p = planTurn({
      graph: g1,
      board: board([mine(1, 10), enemy(5, 3), enemy(6, 30)]),
      me: ME,
      income: 5,
      settings: { offensiveKillRate, defensiveKillRate, oneArmyStandsGuard: true },
      game: { players: [{ id: ME }, { id: ENEMY }] },
      options: { adapt: true },
    });
    expect(why(p)).toMatch(/Behind on armies \(10 visible against player 20's 33\)/);
    expect(attacks(p).map((m) => [m.from, m.to])).toEqual([[1, 5]]);
    expect(why(p)).not.toMatch(/trade below even while behind on armies \(loses|combined capture loses/);
  });
});

// Concentrate. An FFA: T1 (20) faces player 20's T5 (2) and the fogged T7; T2 (20) faces player
// 30's T6 (2). Player 30's tracked income is 12, player 20's ~5; mine is 10 (even). No capture
// is worth making: the whole income is spare.
describe('concentrate the spare deploys on the strongest opponent', () => {
  const g = buildGraph(
    makeMap(
      [1, 2, 5, 6, 7, 8, 9],
      [
        [1, 2],
        [1, 5],
        [1, 7],
        [2, 6],
        [5, 8],
        [6, 9],
      ],
    ),
  );
  const s = board([mine(1, 20), mine(2, 20), enemy(5, 2), enemy(6, 2, THIRD), fogged(7), enemy(8, 2), enemy(9, 2, THIRD)]);
  const input = (options: PlanInput['options']): PlanInput => ({
    graph: g,
    board: s,
    me: ME,
    income: 10,
    settings: STD,
    tracks: [track(THIRD, 12)],
    game: { players: [{ id: ME }, { id: ENEMY }, { id: THIRD }] },
    options,
  });

  it('without the profile, the leftover goes to the border with the most fog', () => {
    expect(planTurn(input({})).deploys).toEqual([{ territoryId: 1, armies: 10 }]);
  });

  it('adapting: one strike stack on the border facing player 30, and the rationale names it', () => {
    const p = planTurn(input({ adapt: true }));
    expect(p.profile).toMatchObject({ format: 'ffa', standing: 'even' });
    expect(p.deploys).toEqual([{ territoryId: 2, armies: 10 }]);
    expect(why(p)).toMatch(
      /Deploy the leftover 10 to T2 \(#2\): one strike stack on the border facing player 30, the strongest opponent \(~12 income, tracked\), not spread/,
    );
    expect(p.offence).toContainEqual({
      target: 2,
      kind: 'strike',
      cost: 10,
      value: 12,
      taken: true,
      why: expect.stringMatching(/strike stack/),
    });
  });
});

// Concentrate takes the leftover ahead of a comfort margin, in an FFA too (rule 0p.3c has no
// format restriction). I hold B906 (+3) at T3 (8), which faces player 20's T4 (8): it holds
// without a deploy but is short of a comfortable margin. T1 (20) faces player 30's T5 (2), the
// strongest opponent (tracked 12; its T6 keeps it from being finished off).
describe('concentrate outranks a comfort margin on a held bonus border', () => {
  const g = buildGraph(
    makeMap(
      [1, 3, 4, 5, 6],
      [
        [1, 3],
        [3, 4],
        [1, 5],
        [5, 6],
      ],
      [[906, 3, [3]]],
    ),
  );
  const input = (options: PlanInput['options']): PlanInput => ({
    graph: g,
    board: board([mine(1, 20), mine(3, 8), enemy(4, 8), enemy(5, 2, THIRD), enemy(6, 2, THIRD)]),
    me: ME,
    income: 10,
    settings: STD,
    tracks: [track(THIRD, 12)],
    game: { players: [{ id: ME }, { id: ENEMY }, { id: THIRD }] },
    options,
  });

  it('without the profile, the leftover tops up the short held border', () => {
    const p = planTurn(input({}));
    expect(p.deploys).toEqual([{ territoryId: 3, armies: 10 }]);
    expect(why(p)).toMatch(/Deploy the leftover 10 to T3 \(#3\): the held border with the most at stake \(protects \+3\)/);
  });

  it('adapting in an FFA: the strike stack facing player 30 takes it instead', () => {
    const p = planTurn(input({ adapt: true }));
    expect(p.profile.format).toBe('ffa');
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 10 }]);
    expect(why(p)).toMatch(/Deploy the leftover 10 to T1 \(#1\): one strike stack on the border facing player 30/);
  });
});

// Counter-attack. Last turn the enemy's T5 (12) attacked my T1 and failed: it shows 4 now, and
// its only other neighbour, its own 40-stack T6, did not grow (no transfer). Capturing 4
// defenders costs 6 instead of 20.
describe('counter-attack a stack that spent itself on me', () => {
  const g = buildGraph(
    makeMap(
      [1, 5, 6],
      [
        [1, 5],
        [5, 6],
      ],
    ),
  );
  const before = (t5: number, t6 = 40): BoardState => board([mine(1, 9), enemy(5, t5), enemy(6, t6)]);
  const now = board([mine(1, 8), enemy(5, 4), enemy(6, 40)]);
  const plan = (previousBoard?: BoardState) =>
    planTurn({ graph: g, board: now, me: ME, income: 5, settings: STD, ...(previousBoard ? { previousBoard } : {}) });

  it('after a failed enemy attack: struck at the landing size, and reported', () => {
    const p = plan(before(12));
    expect(captureCost(4, STD)).toBe(6);
    expect(captureCost(12, STD)).toBe(20);
    expect(attacks(p).map((m) => [m.from, m.to])).toEqual([[1, 5]]);
    expect(why(p)).toMatch(
      /Attack T5 \(#5\) from T1 \(#1\) with 6: counter-attacks player 20's T5 \(#5\), which shrank from 12 to 4 attacking me last turn \(6 to take now, 20 before\)/,
    );
    expect(p.offence).toEqual([expect.objectContaining({ target: 5, kind: 'counter', cost: 6, taken: true })]);
  });

  it('no previous board, or a shrink its own neighbour absorbed (a transfer): no counter', () => {
    expect(attacks(plan())).toEqual([]);
    const moved = plan(before(12, 32));
    expect(attacks(moved)).toEqual([]);
    expect(moved.offence).toEqual([]);
  });
});

// The shrink must be pinned on me. T5 (12 last turn, 4 now) also borders T7: when T7 changed
// hands to T5's owner (an expansion into a neutral) or lost armies to anyone (a hit on a third
// player), the armies T5 spent may have gone there, so it is no counter-attack target — even
// though my T1 sits next to it untouched.
describe('a counter-attack needs the shrink pinned on me', () => {
  const g = buildGraph(
    makeMap(
      [1, 5, 6, 7],
      [
        [1, 5],
        [5, 6],
        [5, 7],
      ],
    ),
  );
  const plan = (t7Before: TerritoryState, t7Now: TerritoryState) =>
    planTurn({
      graph: g,
      board: board([mine(1, 9), enemy(5, 4), enemy(6, 40), t7Now]),
      previousBoard: board([mine(1, 9), enemy(5, 12), enemy(6, 40), t7Before]),
      me: ME,
      income: 5,
      settings: STD,
    });

  it('the stack expanded into a neutral (T7: neutral 2 -> enemy 6): no counter', () => {
    const p = plan(neutral(7, 2), enemy(7, 6));
    expect(p.offence.filter((o) => o.kind === 'counter')).toEqual([]);
    expect(why(p)).not.toMatch(/attacking me last turn/);
    expect(attacks(p).map((m) => m.to)).not.toContain(5);
  });

  it("the stack attacked a third player (T7: player 30's 10 -> 4): no counter", () => {
    const p = plan(enemy(7, 10, THIRD), enemy(7, 4, THIRD));
    expect(p.offence.filter((o) => o.kind === 'counter')).toEqual([]);
    expect(why(p)).not.toMatch(/attacking me last turn/);
  });

  it('the third player untouched (T7 unchanged): the counter stands', () => {
    const p = plan(enemy(7, 10, THIRD), enemy(7, 10, THIRD));
    expect(p.offence).toContainEqual(expect.objectContaining({ target: 5, kind: 'counter', taken: true }));
  });
});
