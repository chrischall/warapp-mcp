// S1: the game profile drives the planner (rule 0p). With `adapt` and no goal, the profile
// picks the goal and its rules fire; an explicit goal overrides it; without `adapt` the plan
// is the plain balanced one. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import {
  AHEAD_PRESSURE_FACTOR,
  captureCost,
  planTurn,
  PRESSURE_FACTOR,
  pressureMargin,
  SECOND_FRONT_SIMILAR,
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

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Synthetic',
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

describe('rule 0p: the profile on the plan', () => {
  const g = buildGraph(makeMap([1, 2], [[1, 2]], []));
  const s = board([mine(1, 5), neutral(2, 2)]);

  it('every plan carries the profile and the goal it planned for', () => {
    const p = planTurn({ graph: g, board: s, me: ME, income: 5, settings: STD, game: { turn: 7, fog: 'Foggy', cards: true } });
    expect(p.goal).toBe('balanced');
    expect(p.profile).toMatchObject({ phase: 'expansion', standing: 'unknown', settings: { fog: 'Foggy', cards: true } });
  });

  it('without adapt the profile changes nothing and says nothing', () => {
    const p = planTurn({ graph: g, board: s, me: ME, income: 5, settings: STD });
    expect(why(p)).not.toMatch(/game profile/);
  });

  it('adapting with no goal: balanced is the base, and the rationale says why', () => {
    const p = planTurn({ graph: g, board: s, me: ME, income: 5, settings: STD, options: { adapt: true } });
    expect(p.goal).toBe('balanced');
    expect(why(p)).toMatch(/Goal balanced from the game profile \(1v1, expansion, unknown\): the base goal\./);
  });
});

// Rule 0p.1. T1 (1 army) borders T4, a 2-army neutral of B801 (+5, with T5 out of reach):
// advancing it scores 5 / 6. T2 (2 armies) is my only way into B802 (+2; T9 out of reach) and
// faces the enemy's T8 (2): a threat of 1 + 5, so it needs 3 to hold — worth (2 + 0.2) / 3.
// Income 5 (even with the enemy's ~5) pays for one of them.
describe('rule 0p.1: a 1v1 in contact', () => {
  const g = buildGraph(
    makeMap(
      [1, 2, 4, 5, 8, 9, 11],
      [
        [1, 4],
        [4, 5],
        [2, 8],
        [8, 9],
        [8, 11],
      ],
      [
        [801, 5, [4, 5]],
        [802, 2, [2, 9]],
      ],
    ),
  );
  const s = board([mine(1, 1), mine(2, 2), neutral(4, 2), neutral(5, 2), enemy(8, 2), neutral(9, 2), enemy(11, 2)]);
  const input = (options: PlanInput['options'] = {}): PlanInput => ({
    graph: g,
    board: s,
    me: ME,
    income: 5,
    settings: STD,
    game: { players: [{ id: ME }, { id: ENEMY }], turn: 6 },
    options,
  });

  it('plain balanced advances the +5 and cannot afford the hold', () => {
    const p = planTurn(input());
    expect(attacks(p).map((m) => m.to)).toEqual([4]);
    expect(p.conceded).toEqual([2]);
  });

  it('adapting: the hold outranks expansion that completes nothing', () => {
    const p = planTurn(input({ adapt: true }));
    expect(p.profile).toMatchObject({ format: '1v1', phase: 'contact', standing: 'even' });
    expect(why(p)).toMatch(/Deploy 3 to T2 \(#2\) so it holds \(protects \+2\)/);
    expect(p.conceded).toEqual([]);
    // The 2 left cannot fund the advance (3): it waits. They build the strike stack on T2 (7), which
    // spends it (#102): T8 (2) falls to 3, and the 4 that stay hold against the ~5 deploy alone.
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([[2, 8, 3]]);
    expect(why(p)).toMatch(/Attack T8 \(#8\) from the strike stack T2 \(#2\) with 3 \(win chance 100%\)/);
    expect(why(p)).toMatch(/1v1 in contact: breaking an enemy bonus counts like completing one of equal value/);
  });

  it('an explicit goal overrides the profile, and the plan says so', () => {
    const p = planTurn(input({ adapt: true, goal: 'balanced' }));
    expect(p).toMatchObject({ goal: 'balanced' });
    expect(attacks(p).map((m) => m.to)).toEqual([4]);
    expect(why(p)).toMatch(/Goal balanced was given explicitly, so it overrides the game profile \(1v1, contact, even\)/);
    expect(why(p)).not.toMatch(/1v1 in contact/);
  });

  it('does not fire out of contact', () => {
    // The enemy's stacks gone from next to me: no contact, so expansion competes as usual.
    const apart = board([mine(1, 1), mine(2, 2), neutral(4, 2), neutral(5, 2), neutral(8, 2), neutral(9, 2), enemy(11, 2)]);
    const p = planTurn({ ...input({ adapt: true }), board: apart });
    expect(p.profile.phase).toBe('expansion');
    expect(why(p)).not.toMatch(/1v1 in contact/);
    expect(attacks(p).map((m) => m.to)).toContain(4);
  });
});

// Rule 0p.2. T1 (6) borders a 2-army neutral T2 (B821 +3: 3 / 3 = 1 per army) and the
// enemy's T5 (2), all of B822 (+8): a break worth 8 / 2 opponents / 3 = 1.33 per army. The
// enemy also holds T6 (out of my reach), so it cannot be finished off; a third player sits
// on T9, far away. Income 5 (even) pays for both captures.
describe('rule 0p.2: an FFA with two or more opponents left', () => {
  const g = buildGraph(
    makeMap(
      [1, 2, 5, 6, 9],
      [
        [1, 2],
        [1, 5],
        [5, 6],
      ],
      [
        [821, 3, [2]],
        [822, 8, [5]],
      ],
    ),
  );
  const s = board([mine(1, 6), neutral(2, 2), enemy(5, 2), enemy(6, 2), enemy(9, 2, THIRD)]);
  const players = [{ id: ME }, { id: ENEMY }, { id: THIRD }];
  const input = (options: PlanInput['options'] = {}, b = s): PlanInput => ({
    graph: g,
    board: b,
    me: ME,
    income: 5,
    settings: STD,
    game: { players, turn: 6 },
    options: { opponents: 2, ...options },
  });

  it('exports its constant', () => {
    expect(SECOND_FRONT_SIMILAR).toBe(0.5);
  });

  it('plain balanced breaks the enemy bonus as well as taking the neutral', () => {
    expect(attacks(planTurn(input())).map((m) => m.to).sort()).toEqual([2, 5]);
  });

  it('adapting: no second front — the neutral only', () => {
    const p = planTurn(input({ adapt: true }));
    expect(p.profile).toMatchObject({ format: 'ffa', opponents: 2, standing: 'even' });
    expect(attacks(p).map((m) => m.to)).toEqual([2]);
    expect(why(p)).toMatch(/FFA with 2 opponents left: no second front/);
    expect(why(p)).toMatch(/Not breaking B822 \(#822\) \(\+8 from player 20\): no second front in an FFA/);
  });

  it('still breaks a player that threatens a bonus of mine', () => {
    // T3 (1 army) is my held B823 (+1), next to the enemy's T5: its 1 + ~5 can take it.
    const g3 = buildGraph(
      makeMap(
        [1, 2, 3, 5, 6, 9],
        [
          [1, 2],
          [1, 5],
          [3, 5],
          [5, 6],
        ],
        [
          [821, 3, [2]],
          [822, 8, [5]],
          [823, 1, [3]],
        ],
      ),
    );
    const s3 = board([mine(1, 6), neutral(2, 2), mine(3, 1), enemy(5, 2), enemy(6, 2), enemy(9, 2, THIRD)]);
    const p = planTurn({ ...input({ adapt: true }, s3), graph: g3 });
    expect(attacks(p).map((m) => m.to)).toContain(5);
    expect(why(p)).not.toMatch(/Not breaking/);
  });

  it('still breaks when no neutral capture of similar value exists', () => {
    // The neutral is worth +1 (1 / 3 per army). The break is worth +12 so that, after paying
    // for the enemy-facing border T5 adds (#71), it still earns more than twice that.
    const g1 = buildGraph(
      makeMap(
        [1, 2, 5, 6, 9],
        [
          [1, 2],
          [1, 5],
          [5, 6],
        ],
        [
          [821, 1, [2]],
          [822, 12, [5]],
        ],
      ),
    );
    const p = planTurn({ ...input({ adapt: true }), graph: g1 });
    expect(attacks(p).map((m) => m.to)).toContain(5);
    expect(why(p)).not.toMatch(/Not breaking/);
    // Nothing was skipped, so the general rule is not claimed either.
    expect(why(p)).not.toMatch(/no second front/);
  });

  it('never claims to skip a break it could not afford', () => {
    // T5 holds 8: taking it needs 13, more than T1's 6 plus the income of 5.
    const heavy = board([mine(1, 6), neutral(2, 2), enemy(5, 8), enemy(6, 2), enemy(9, 2, THIRD)]);
    const p = planTurn(input({ adapt: true }, heavy));
    expect(attacks(p).map((m) => m.to)).toEqual([2]);
    expect(why(p)).not.toMatch(/no second front/);
  });

  it('a threatened border attacking its only threat judges the break on the same cost (frontier included)', () => {
    // T1 (4) is threatened only by T5, all of B822 (+10). A break is scored to land (#72): worth
    // 0.5 × (10 + armiesToTake(2 survivors) / 10) = 5.15 over 3 armies plus the frontier it
    // changes without T5's own hold need (T5 opens a border, +0.25; T1's enemy-facing need of 1
    // and weight close, −1.25): 2.25, so 2.29 per army — over twice the neutral's 1.00, not a
    // second front. The border's own attack on its threat must use that same cost: on the
    // armies alone (5.15 / 3 = 1.72) it would be skipped as a second front.
    const g10 = buildGraph(
      makeMap(
        [1, 2, 5, 6, 9],
        [
          [1, 2],
          [1, 5],
          [5, 6],
        ],
        [
          [821, 3, [2]],
          [822, 10, [5]],
        ],
      ),
    );
    const thin = board([mine(1, 4), neutral(2, 2), enemy(5, 2), enemy(6, 2), enemy(9, 2, THIRD)]);
    const p = planTurn({ ...input({ adapt: true }, thin), graph: g10 });
    expect(why(p)).not.toMatch(/Not breaking/);
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([[1, 5, 3]]);
    expect(why(p)).toMatch(/T5 \(#5\) is the only visible threat to T1 \(#1\)/);
    // At +8 the same cost gives 4.15 / 2.25 = 1.84 per army: a second front, so it only holds.
    const g8 = buildGraph(makeMap([1, 2, 5, 6, 9], [[1, 2], [1, 5], [5, 6]], [[821, 3, [2]], [822, 8, [5]]]));
    const held = planTurn({ ...input({ adapt: true }, thin), graph: g8 });
    expect(why(held)).toMatch(/Not breaking B822 \(#822\) \(\+8 from player 20\): no second front in an FFA/);
    expect(attacks(held).map((m) => m.to)).not.toContain(5);
    expect(why(held)).not.toMatch(/only visible threat/);
  });

  it('does not fire in a 1v1', () => {
    const p = planTurn({ ...input({ adapt: true }), board: board(s.territories.filter((t) => t.territoryId !== 9)), game: { players: [{ id: ME }, { id: ENEMY }] } });
    expect(why(p)).not.toMatch(/no second front/);
    expect(attacks(p).map((m) => m.to)).toContain(5);
  });
});

// Rule 0p.3, behind. The (d)-like board: two thin borders each a held +1 next to an enemy,
// and a cheap +3 next door. Income 3 against the enemy's ~5: behind. In an FFA the goal is
// defend; in a 1v1 (#72) behind on income means strike, so the goal stays balanced.
describe('rule 0p.3: behind defends first in an FFA', () => {
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6, 8, 9],
      [
        [1, 2],
        [1, 3],
        [1, 4],
        [1, 5],
        [1, 6],
        [2, 8],
        [3, 9],
      ],
      [
        [801, 3, [4, 5, 6]],
        [802, 1, [2]],
        [803, 1, [3]],
      ],
    ),
  );
  const s = board([mine(1, 11), mine(2, 2), mine(3, 2), neutral(4, 4), neutral(5, 2), neutral(6, 2), enemy(8, 2), enemy(9, 2)]);
  const input = (options: PlanInput['options'] = {}): PlanInput => ({
    graph: g,
    board: s,
    me: ME,
    income: 3,
    settings: STD,
    // #72: a third player (out of sight) makes it an FFA; a 1v1 behind on income strikes instead.
    game: { players: [{ id: ME }, { id: ENEMY }, { id: THIRD }] },
    options,
  });

  it('picks defend, plans exactly as goal defend, and says why', () => {
    const p = planTurn(input({ adapt: true }));
    expect(p.profile.standing).toBe('behind');
    expect(p.goal).toBe('defend');
    const d = planTurn(input({ goal: 'defend' }));
    expect(p.deploys).toEqual(d.deploys);
    expect(p.moves).toEqual(d.moves);
    expect(why(p)).toMatch(/Goal defend from the game profile \(ffa, contact, behind\): behind on income \(3 against ~5\)/);
  });

  it('in a 1v1 the same board keeps the goal balanced (#72: behind on income means strike)', () => {
    const p = planTurn({ ...input({ adapt: true }), game: { players: [{ id: ME }, { id: ENEMY }] } });
    expect(p.profile).toMatchObject({ format: '1v1', standing: 'behind' });
    expect(p.goal).toBe('balanced');
    expect(why(p)).toMatch(/behind on income \(3 against ~5\) in a 1v1 — strike/);
  });

  it('an explicit goal still wins when behind', () => {
    const p = planTurn(input({ adapt: true, goal: 'expand' }));
    expect(p.goal).toBe('expand');
    expect(why(p)).toMatch(/Goal expand was given explicitly/);
  });
});

// Rule 0p.3, sizing. The #60 shape: my 9-stack on T1 next to the enemy's one visible 0-army
// T5, which borders the fog (T10); T7 and T8 are 2-army neutrals (a typical capture: 3).
describe('rule 0p.3: pressure when ahead in a 1v1, and the minimum when behind', () => {
  const g = buildGraph(
    makeMap(
      [1, 2, 5, 7, 8, 10],
      [
        [1, 2],
        [1, 5],
        [5, 10],
        [2, 7],
        [1, 8],
      ],
      [
        [501, 2, [1, 2]],
        [502, 3, [7, 8]],
      ],
    ),
  );
  const s = board([mine(1, 9), mine(2, 2), enemy(5, 0), neutral(7, 2), neutral(8, 2), fogged(10)]);
  const SIX: PlannerSettings = { ...STD, baseIncome: 6 };
  const input = (income: number, options: PlanInput['options'] = {}): PlanInput => ({
    graph: g,
    board: s,
    me: ME,
    income,
    settings: SIX,
    game: { players: [{ id: ME }, { id: ENEMY }] },
    options,
  });

  it('the gate by hand: 0 + ~6 + its margin costs 15, over 4 × 3 but within 8 × 3', () => {
    expect(PRESSURE_FACTOR).toBe(4);
    expect(AHEAD_PRESSURE_FACTOR).toBe(8);
    const cost = captureCost(0 + 6 + pressureMargin(6), STD)!;
    expect(cost).toBe(15);
    expect(cost).toBeGreaterThan(PRESSURE_FACTOR * captureCost(2, STD)!);
    expect(cost).toBeLessThanOrEqual(AHEAD_PRESSURE_FACTOR * captureCost(2, STD)!);
  });

  it('plain balanced does not pressure at ~6', () => {
    const p = planTurn(input(8));
    expect(attacks(p).filter((m) => m.to === 5)).toEqual([]);
  });

  it('ahead (8 against ~6): pressures it at the higher factor, margin included, and states the factor', () => {
    const p = planTurn(input(8, { adapt: true }));
    expect(p.profile).toMatchObject({ format: '1v1', standing: 'ahead' });
    expect(attacks(p)).toContainEqual(expect.objectContaining({ from: 1, to: 5, armies: 15 }));
    expect(why(p)).toMatch(/Ahead in a 1v1 \(8 against ~6\): keep attacking — .* up to 8× a typical neutral capture \(instead of 4×\)/);
    expect(why(p)).toMatch(/Pressure player 20/);
  });

  it('behind (4 against ~6): pressure is sized with no margin', () => {
    // At ~6 with no margin the capture costs 10 (within 4 × 3): attacked at exactly that.
    // #72: behind on income in a 1v1 strikes, so the goal is balanced (it was defend).
    const p = planTurn(input(4, { adapt: true }));
    expect(p.goal).toBe('balanced');
    expect(attacks(p)).toContainEqual(expect.objectContaining({ from: 1, to: 5, armies: captureCost(6, STD)! }));
    expect(p.warnings.join('\n')).toMatch(/its ~6 estimate with no margin: behind, attacks are sized at the minimum/);
  });
});
