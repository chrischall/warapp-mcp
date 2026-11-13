// Lessons from a lost game: a 1v1 on a large map, lost on turn 22 at 0% luck
// (see docs/PLAN-PLANNER-2.md "Why"). Each test below replays one lesson in
// miniature on the same synthetic 20-territory map and asserts what the smarter
// planner now does. Every map, id and name here is made up.
//
//   Homeland (+5): 1 2 3 4      — mine; 1 is interior, 2 3 4 are borders
//   Lowlands (+3): 5 6 7        — the cheap bonus next door (neutrals 4, 2, 2)
//   Outpost  (+4): 8 9 10       — the opponent's bonus, touching my 3 at 8
//   Citadel  (+5): 11 12 13 14  — the opponent's home
//   Marches  (+2): 15 16 17     — the contested frontier, touching my 4 at 15
//   18 19 20: in no bonus
//
//   1─2, 1─3, 1─4, 2─3, 3─4 · 2─5, 2─6, 2─7, 5─6, 6─7 · 3─8, 8─9, 9─10, 8─10, 10─11
//   11─12, 12─13, 13─14, 11─13 · 4─15, 15─16, 16─17, 17─14 · 7─18, 18─9, 16─19,
//   19─13, 17─20, 20─12
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import {
  captureCost,
  MIN_EXPANSION_SHARE,
  planTurn,
  type PlanOptions,
  type PlannerSettings,
  type TurnPlan,
} from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const OPPONENT = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

const EDGES: [number, number][] = [
  [1, 2], [1, 3], [1, 4], [2, 3], [3, 4],
  [2, 5], [2, 6], [2, 7], [5, 6], [6, 7],
  [3, 8], [8, 9], [9, 10], [8, 10], [10, 11],
  [11, 12], [12, 13], [13, 14], [11, 13],
  [4, 15], [15, 16], [16, 17], [17, 14],
  [7, 18], [18, 9], [16, 19], [19, 13], [17, 20], [20, 12],
];
const IDS = Array.from({ length: 20 }, (_, i) => i + 1);
const MAP: GameMap = {
  id: 1,
  name: 'Lessons',
  territories: IDS.map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: EDGES.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
  })),
  bonuses: [
    { id: 201, name: 'Homeland', value: 5, territoryIds: [1, 2, 3, 4], bonusIds: [] },
    { id: 202, name: 'Lowlands', value: 3, territoryIds: [5, 6, 7], bonusIds: [] },
    { id: 203, name: 'Outpost', value: 4, territoryIds: [8, 9, 10], bonusIds: [] },
    { id: 204, name: 'Citadel', value: 5, territoryIds: [11, 12, 13, 14], bonusIds: [] },
    { id: 205, name: 'Marches', value: 2, territoryIds: [15, 16, 17], bonusIds: [] },
  ],
  distributionModes: [],
};
const g = buildGraph(MAP);

const theirs = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: OPPONENT },
  armies,
});
/** The opponent's home and the far frontier, out of sight. */
const FAR = [11, 12, 13, 14, 16, 17, 19, 20].map(fogged);

const plan = (b: BoardState, income: number, options: PlanOptions = {}, previousBoard?: BoardState): TurnPlan =>
  planTurn({ graph: g, board: b, me: ME, income, settings: STD, options, ...(previousBoard ? { previousBoard } : {}) });
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const deployedTo = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
const deploySum = (p: TurnPlan) => p.deploys.reduce((s, d) => s + d.armies, 0);

// ---- the boards, one per lesson ----

/** Lesson 1: the cheap +3 next door (neutrals 4, 2, 2) and a threatened +2 border. */
const expansionBoard = board([
  mine(1, 2), mine(2, 10), mine(3, 3), mine(4, 3), mine(15, 3), mine(16, 4), mine(17, 3),
  neutral(5, 4), neutral(6, 2), neutral(7, 2), neutral(8, 6), theirs(9, 3), theirs(10, 3),
  theirs(11, 5), theirs(12, 5), theirs(13, 5), neutral(14, 3), neutral(18, 2), theirs(19, 11), neutral(20, 3),
]);

/** Lesson 2: the opponent's complete Outpost touches my 3 at a 2-army territory. */
const outpostBoard = board([
  mine(1, 2), mine(2, 3), mine(3, 4), mine(4, 3), mine(5, 2), mine(6, 2), mine(7, 2),
  theirs(8, 2), theirs(9, 5), theirs(10, 5), neutral(15, 2), neutral(18, 2), ...FAR,
]);

/** Lessons 3 and 4: one border faces a 51-army stack; the rest is quiet. */
const hopelessBoard = board([
  mine(1, 2), mine(2, 3), mine(3, 4), mine(4, 15), mine(5, 2), mine(6, 2), mine(7, 2),
  neutral(8, 2), theirs(9, 5), theirs(10, 5), theirs(15, 51), neutral(18, 2), ...FAR,
]);

/** Lesson 3, with an enemy bonus to break next to the hopeless border: T8 (20) in a complete Outpost. */
const hopelessBreakBoard = board([
  mine(1, 2), mine(2, 3), mine(3, 4), mine(4, 3), mine(5, 2), mine(6, 2), mine(7, 2),
  theirs(8, 20), theirs(9, 5), theirs(10, 5), neutral(15, 2), neutral(18, 2), ...FAR,
]);

/** Lesson 3 under expand: a doomed 15-army T2 with two cheap neutrals next to it. */
const attackOutBoard = board([
  mine(1, 2), mine(2, 15), mine(3, 4), mine(4, 3),
  theirs(5, 51), neutral(6, 2), neutral(7, 2), neutral(8, 2), theirs(9, 5), theirs(10, 5),
  neutral(15, 2), neutral(18, 2), ...FAR,
]);

/** Lesson 4: 20 idle armies at home, a doomed front at 3 and a holdable one at 4. */
const spreadBoard = board([
  mine(1, 20), mine(2, 3), mine(3, 15), mine(4, 10), mine(5, 2), mine(6, 2), mine(7, 2),
  theirs(8, 51), theirs(9, 5), theirs(10, 5), theirs(15, 6), neutral(18, 2), ...FAR,
]);

/**
 * Lesson 5: the stack at 15 went 51 → 76 next to my 58 at 4. Its other neighbour, T16, is its
 * own 2 in view on both boards: the growth can only be deploys (#123: next to the fog, growth
 * beyond what it was expected to deploy could be a stack walking in, and is not projected).
 */
const QUIET = [
  mine(1, 2), mine(2, 3), mine(3, 4), mine(5, 2), mine(6, 2), mine(7, 2),
  neutral(8, 2), theirs(9, 5), theirs(10, 5), neutral(18, 2), theirs(16, 2),
  ...FAR.filter((t) => t.territoryId !== 16),
];
const growingNow = board([...QUIET, mine(4, 58), theirs(15, 76)]);
const growingThen = board([...QUIET, mine(4, 58), theirs(15, 51)]);

/**
 * Lesson 6: a doomed 15-army border at 3, and the Lowlands to take this turn. T4 is out of sight,
 * so Homeland is not a bonus I visibly hold: #118 keeps a held bonus's garrisons in place.
 */
const withdrawBoard = board([
  mine(1, 2), mine(2, 6), mine(3, 15), fogged(4),
  neutral(5, 2), neutral(6, 2), neutral(7, 2), theirs(8, 51), theirs(9, 5), theirs(10, 5),
  neutral(15, 2), neutral(18, 2), ...FAR,
]);

describe('lessons from a lost game', () => {
  it('1. expansion keeps a budget: the cheap +3 is completed while a +2 border waits its turn', () => {
    // Holding T16 (+2 for 6) scores better per army than the +3 (3 for 12 armies of
    // captures), and income 8 cannot pay for both. The expansion share puts the +3 first.
    const p = plan(expansionBoard, 8, { enemyDeploy: 5 });
    expect(p.expected.bonusesCompleted).toEqual([202]);
    expect(p.expected.nextIncome).toBe(11);
    expect(attacks(p).filter((m) => [5, 6, 7].includes(m.to)).map((m) => [m.from, m.to, m.armies])).toEqual([
      [2, 6, 3],
      [2, 7, 3],
      [2, 5, 6],
    ]);
    const share = Math.ceil(MIN_EXPANSION_SHARE * 8);
    expect(deployedTo(p, 2)).toBeGreaterThanOrEqual(share);
    expect(p.rationale.join('\n')).toContain('Hold T16 (#16) after this turn\'s bonus completions (needs 6, protects +2)');
    // #59: the 5 left are one short of T16's hold, a near miss: they all go there, not conceded.
    expect(p.conceded).toEqual([]);
    expect(deployedTo(p, 16)).toBe(5);
    expect(p.warnings.join('\n')).toMatch(/Bonus Marches \(#205\) \(\+2\) is held though short/);
    expect(deploySum(p)).toBe(8);

    // What lost the game: all-defence spends the income on the border and the +3 never comes.
    const passive = plan(expansionBoard, 8, { goal: 'defend', enemyDeploy: 5 });
    expect(deployedTo(passive, 16)).toBe(8);
    expect(passive.expected.bonusesCompleted).toEqual([]);
  });

  it('2. an enemy bonus touching me at a 2-army territory is broken, with the exact cost', () => {
    // My T3 (4 armies, in my +5) is itself threatened by T8: its 1 movable plus ~5 deploy
    // take 4. Capturing T8 removes that threat and breaks the opponent's +4; T3 attacks on
    // top of its hold, so it still holds if the attack fails (T8 reinforced first).
    const p = plan(outpostBoard, 8);
    expect(armiesToTake(4, STD)).toBe(6);
    expect(attacks(p)).toContainEqual(expect.objectContaining({ from: 3, to: 8, armies: captureCost(2, STD) }));
    const why = p.rationale.join('\n');
    expect(why).toMatch(/Attack T8 \(#8\) from T3 \(#3\) with 3 \(deploy 3 there\): breaks enemy bonus Outpost \(#203\) \(\+4 from player 20\)/);
    expect(why).toMatch(/T8 \(#8\) is the only visible threat to T3 \(#3\)/);
    expect(armiesToTake(4 + deployedTo(p, 3) - 3, STD)).toBeGreaterThan(6);
    expect(p.expected.captures).toContain(8);
    // Its 2 survivors cannot hold against T9 and T10 next door: said, and still worth a turn of +4.
    expect(p.warnings.join('\n')).toMatch(/T8 \(#8\) can be retaken after it breaks Outpost/);
    expect(deploySum(p)).toBe(8);

    for (const goal of ['expand', 'defend'] as const)
      expect(attacks(plan(outpostBoard, 8, { goal })).some((m) => m.to === 8), goal).toBe(false);
  });

  it('3. a hopeless border is conceded and the income is not poured into it', () => {
    // T4 (15 armies) faces 50 movable + ~38 deploy: holding needs 39 more, against the +5
    // it protects. The old rule sent the leftover to the border with the most enemies next
    // to it — exactly this one. (R1: the opponent's visible income no longer supports ~38 —
    // the old stack rule's round(0.75 × 51) — so the lesson passes it as the estimate.)
    const p = plan(hopelessBoard, 20, { enemyDeploy: 38 });
    expect(p.conceded).toEqual([4]);
    expect(p.warnings).toContain('T4 (#4) cannot be held economically (needs 39, protects +5): conceded');
    expect(deployedTo(p, 4)).toBe(0);
    expect(deploySum(p)).toBe(20);
    // #118: its 14 stay rather than withdraw — it is a border of Homeland, which I hold in full,
    // and moving them makes no other border hold this turn; where they are, they kill attackers.
    expect(p.moves.some((m) => m.from === 4)).toBe(false);
    expect(p.cardAdvice).toBeNull();
    expect(p.rationale.join('\n')).toMatch(/Keep the 14 movable armies on T4 \(#4\) \(not withdrawn\): it is a border of held bonus Homeland/);
    expect(p.rationale.join('\n')).toMatch(/Deploy the leftover \d+ to T3 \(#3\)/);
    // #118: rule 1a's CONCEDE_FACTOR × worth test concedes a held bonus only when the armies
    // have a better use. Once the captures have had their turn and what is left covers the 39,
    // nothing else would use those armies (they would only be parked on T3), so Homeland is held.
    for (const income of [39, 40, 45, 60]) {
      const rich = plan(hopelessBoard, income, { enemyDeploy: 38 });
      expect(rich.conceded, `income ${income}`).toEqual([]);
      expect(deployedTo(rich, 4), `income ${income}`).toBeGreaterThanOrEqual(39);
      expect(rich.rationale.join('\n'), `income ${income}`).toMatch(
        /Hold bonus Homeland \(#201\) \(\+5\) whole: its 1 threatened border needs 39 \(more than 3 × its worth\), and nothing else this turn uses those armies/,
      );
      expect(deploySum(rich), `income ${income}`).toBe(income);
    }

    // Nor does a border failing the factor test become the source of a break: T3 faces
    // 19 + ~15 = 34 and needs 17 (more than 3 × its worth). It never takes 30 deploys to attack
    // the 20 on T8: since #118 it waits for the captures and is then held from what they leave
    // (40 covers it), and a held border attacks nothing. (R1: the ~15 — the old stack rule's
    // round(0.75 × 20) — is passed explicitly, as above.)
    const b = plan(hopelessBreakBoard, 40, { enemyDeploy: 15 });
    expect(b.conceded).toEqual([]);
    expect(deployedTo(b, 3)).toBeGreaterThanOrEqual(17);
    expect(attacks(b).some((m) => m.from === 3)).toBe(false);
    expect(deploySum(b)).toBe(40);
    // When what the captures leave cannot cover it (~30 deploy: it needs 26 of 20), it is
    // conceded, still without attacking; its garrison stays (#118: Homeland is held in full).
    const poor = plan(hopelessBreakBoard, 20, { enemyDeploy: 30 });
    expect(poor.conceded).toContain(3);
    expect(poor.warnings).toContain('T3 (#3) cannot be held economically (needs 26, protects +5): conceded');
    expect(deployedTo(poor, 3)).toBe(0);
    expect(attacks(poor).some((m) => m.from === 3)).toBe(false);
    expect(poor.moves.some((m) => m.from === 3)).toBe(false);
    expect(deploySum(poor)).toBe(20);

    // Under expand (no withdrawal) a conceded border may still attack out, but only with the
    // armies already on it: T2 (15) faces 51 at T5, and takes the 2-army T6 and T7 itself
    // (Lowlands is focused, as it holds the 51).
    const out = plan(attackOutBoard, 6, { goal: 'expand', focusBonusIds: [202] });
    expect(out.conceded).toContain(2);
    expect(attacks(out).filter((m) => m.from === 2).map((m) => m.to)).toEqual([6, 7]);
    expect(deployedTo(out, 2)).toBe(0);
  });

  it('4. idle armies concentrate on the front that holds, never on the conceded one', () => {
    // T3 faces 51 and is conceded; T4 faces 6 and holds. The 19 idle armies at home move
    // toward a front, never into T3. (#118: T3's own 14 stay — it is a border of Homeland, which
    // I hold in full, and moving them would make no other border hold this turn.)
    const p = plan(spreadBoard, 10, { enemyDeploy: 10 });
    expect(p.conceded).toEqual([3]);
    expect(p.moves.some((m) => m.from === 3)).toBe(false);
    expect(p.moves).toContainEqual(expect.objectContaining({ from: 1, armies: 19, kind: 'transfer' }));
    expect(p.moves.some((m) => m.to === 3)).toBe(false);
    expect(deployedTo(p, 3)).toBe(0);
  });

  it('5. a growing stack is seen a turn early, and the border is held against its growth', () => {
    // 75 movable + ~15 deploy = 90 stays under the 96 it takes to break 58: safe on one board.
    expect(armiesToTake(58)).toBe(96);
    const blind = plan(growingNow, 10, { enemyDeploy: 15 });
    expect(blind.warnings.join('\n')).not.toMatch(/T4 \(#4\).*could be taken|is building/);

    // With last turn's board, +25/turn projects 100: T4 needs 61, and 76 the turn after.
    const p = plan(growingNow, 10, { enemyDeploy: 15 }, growingThen);
    const w = p.warnings.join('\n');
    expect(w).toContain(
      'T15 (#15) is building: +25/turn (51 → 76); at this rate T4 (#4) needs 61 to hold next turn and 76 the turn after',
    );
    expect(p.rationale.join('\n')).toMatch(/Deploy 3 to T4 \(#4\) so it holds \(protects \+5\)/);
    expect(armiesToTake(58 + deployedTo(p, 4))).toBeGreaterThan(100);
    expect(p.conceded).toEqual([]);
  });

  it('6. a withdrawal goes first in the turn, with Order Priority advised', () => {
    const p = plan(withdrawBoard, 9);
    expect(p.conceded).toEqual([3]);
    // To T1, a border itself (it faces the fogged T4).
    expect(p.moves[0]).toEqual(expect.objectContaining({ from: 3, to: 1, armies: 14, kind: 'transfer' }));
    expect(attacks(p).length).toBeGreaterThan(0);
    expect(p.moves.findIndex((m) => m.kind === 'attack')).toBeGreaterThan(0);
    expect(p.cardAdvice).toBe('order-priority');
    expect(p.warnings).toContain(
      'The withdrawal from T3 (#3) only executes if T3 (#3) is still mine when the order runs; play Order Priority so it goes first.',
    );
    // The planner advises the card; it never plays one, and `expand` plans no withdrawal.
    const expand = plan(withdrawBoard, 9, { goal: 'expand' });
    expect(expand.cardAdvice).toBeNull();
    expect(expand.moves.some((m) => m.from === 3 && m.kind === 'transfer')).toBe(false);
  });

  it('every lesson plan is a valid turn', () => {
    const cases: Array<[BoardState, number, PlanOptions, BoardState?]> = [
      [expansionBoard, 8, { enemyDeploy: 5 }],
      [outpostBoard, 8, {}],
      [hopelessBoard, 20, {}],
      [hopelessBreakBoard, 40, {}],
      [attackOutBoard, 6, { focusBonusIds: [202] }],
      [spreadBoard, 10, { enemyDeploy: 10 }],
      [growingNow, 10, { enemyDeploy: 15 }, growingThen],
      [withdrawBoard, 9, {}],
    ];
    for (const [b, income, options, prev] of cases)
      for (const goal of ['balanced', 'expand', 'complete-bonus', 'defend'] as const) {
        const p = plan(b, income, { ...options, goal }, prev);
        const armies = new Map(b.territories.map((t) => [t.territoryId, t.armies ?? 0]));
        const mineIds = new Set(
          b.territories.filter((t) => t.owner.kind === 'player' && t.owner.playerId === ME).map((t) => t.territoryId),
        );
        expect(deploySum(p), goal).toBe(income);
        for (const d of p.deploys) {
          expect(mineIds.has(d.territoryId)).toBe(true);
          expect(p.conceded.includes(d.territoryId), `${goal}: deploy to conceded ${d.territoryId}`).toBe(false);
        }
        const out = new Map<number, number>();
        for (const m of p.moves) {
          // Only territories held at the start move armies: captured armies never attack.
          expect(mineIds.has(m.from), `${goal}: move from ${m.from}`).toBe(true);
          out.set(m.from, (out.get(m.from) ?? 0) + m.armies);
          if (m.kind === 'transfer') expect(mineIds.has(m.to)).toBe(true);
        }
        for (const [id, n] of out) expect(n, `${goal}: outgoing from ${id}`).toBeLessThanOrEqual(armies.get(id)! + deployedTo(p, id) - 1);
        // A withdrawal is the only thing that needs Order Priority.
        expect(p.cardAdvice === 'order-priority').toBe(p.moves.some((m) => m.reason === 'withdraws from a conceded border'));
      }
  });
});
