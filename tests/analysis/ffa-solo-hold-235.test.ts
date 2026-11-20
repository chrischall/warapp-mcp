// #235 (a later comment): a free-for-all border that holds against each opponent alone is never
// conceded because two of them together could take it — even when I lead (#201), where the hold
// is sized for them together only while that pays; and (b) a border whose loss cuts my holdings in
// two protects what it cuts off. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { noteEstimates, planContext } from '../../src/analysis/plan/estimates.js';
import { deployBook } from '../../src/analysis/plan/orders.js';
import { newPlanState } from '../../src/analysis/plan/state.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
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
const enemy = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const outOf = (p: TurnPlan, t: number) => p.moves.filter((m) => m.from === t);

describe('#235: the FFA leader never concedes a border on two opponents together', () => {
  // My T1 (12, no bonus) faces player 20's T2 and player 30's T3, 9 armies each. Each alone (8 + its
  // ~5 deploy) cannot take it; the two together can. I lead on strength (my 60 on T4); T1, T4 and T6
  // form a triangle, so losing T1 cuts nothing off. Holding T1 against both together costs more than
  // CONCEDE_FACTOR × its worth: it is held against each alone, and the pile-on is a warning.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6],
      [
        [1, 2],
        [1, 3],
        [1, 4],
        [1, 6],
        [4, 6],
        [4, 5],
      ],
    ),
  );
  const input = (adapt: boolean): PlanInput => ({
    graph: g,
    board: board([mine(1, 12), enemy(2, 9, 20), enemy(3, 9, 30), mine(4, 60), neutral(5, 50), mine(6, 2)]),
    me: ME,
    income: 10,
    settings: STD,
    game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 8 },
    options: adapt ? { adapt: true, enemyDeploy: 5 } : { goal: 'balanced', enemyDeploy: 5 },
  });

  it('leading: held against each alone, not conceded, nothing withdrawn', () => {
    const p = planTurn(input(true));
    expect(p.profile.ranking?.leader).toBe(ME);
    expect(p.conceded).not.toContain(1);
    expect(outOf(p, 1)).toEqual([]);
    expect(p.warnings.join('\n')).not.toMatch(/T1 \(#1\) cannot be held/);
    expect(p.rationale.join('\n')).toMatch(
      /I lead this free-for-all \(#201\), but holding T1 \(#1\) against players 20 and 30 attacking together needs \d+ \(protects \+0, worth ~1\.2\): more than CONCEDE_FACTOR × its worth, so it is sized for the strongest single opponent \(~13\), as FFA players attack alone/,
    );
    expect(p.rationale.join('\n')).not.toMatch(/T1 \(#1\) is held against players 20 and 30 attacking together/);
    // #128's warning still says the two together could take it.
    expect(p.warnings.join('\n')).toMatch(/T1 \(#1\) holds against each opponent alone, but players 20 and 30 attacking it in the same turn/);
  });

  it('not adapting: the same (each player judged alone, the pile-on a warning)', () => {
    const p = planTurn(input(false));
    expect(p.conceded).not.toContain(1);
    expect(outOf(p, 1)).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(/T1 \(#1\) holds against each opponent alone, but players 20 and 30/);
  });
});

describe('#235: a border whose loss cuts my holdings in two protects what it cuts off', () => {
  // My T1 (5) joins my T4 (60, the +2 bonus B901 alone) to my T6, T7, T8. Player 20's T2 (9) faces T1:
  // 8 + its ~5 deploy take 5. Losing T1 leaves T4 cut off from the rest: T1 protects +2 (B901's
  // income) and its worth counts T4's 60 armies (/ PAYBACK_TURNS), so it is held, not conceded.
  const edges: [number, number][] = [
    [1, 2],
    [1, 4],
    [1, 6],
    [6, 7],
    [7, 8],
    [4, 5],
  ];
  const run = (linked: boolean) =>
    planTurn({
      graph: buildGraph(makeMap([1, 2, 4, 5, 6, 7, 8], linked ? edges : [...edges, [4, 8]], [[901, 2, [4]]])),
      board: board([mine(1, 5), enemy(2, 9, 20), mine(4, 60), neutral(5, 80), mine(6, 1), mine(7, 1), mine(8, 1)]),
      me: ME,
      income: 7,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }], turn: 8 },
      // #420: the total hold cap off: these test an earlier hold rule, not the cap.
      options: { holdCap: false, goal: 'balanced', enemyDeploy: 5 },
    });

  it('a cut vertex: held, the cut named in the rationale', () => {
    const p = run(true);
    expect(p.conceded).not.toContain(1);
    expect(p.deploys.some((d) => d.territoryId === 1)).toBe(true);
    expect(p.rationale.join('\n')).toMatch(
      /T1 \(#1\) links my holdings: losing it cuts off T4 \(#4\) \(60 armies, \+2 income\) from the rest, so it protects \+2 more and its worth counts those 60 armies/,
    );
    expect(p.rationale.join('\n')).toMatch(/Deploy \d+ to T1 \(#1\) so it holds \(protects \+2\)/);
  });

  it('a cut that leaves only a 1-army leaf, no income, is not named (it cannot change the judgement)', () => {
    // T1 now cuts off only T6's 1 army (T4 joins via T8): worth 1 / PAYBACK_TURNS, nothing to say.
    const p = planTurn({
      graph: buildGraph(makeMap([1, 2, 4, 5, 6, 7, 8], [[1, 2], [1, 4], [1, 6], [4, 8], [7, 8], [4, 5]], [[901, 2, [4]]])),
      board: board([mine(1, 5), enemy(2, 9, 20), mine(4, 60), neutral(5, 80), mine(6, 1), mine(7, 1), mine(8, 1)]),
      me: ME,
      income: 7,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }], turn: 8 },
      options: { goal: 'balanced', enemyDeploy: 5 },
    });
    expect(p.rationale.join('\n')).not.toMatch(/links my holdings/);
  });

  it('with another link (T4–T8), nothing is cut off: conceded as before', () => {
    // #291: T1 would still be the only way in to everything behind it; a hidden territory beside T8 is a second
    // way in, so this case stays about the cut alone.
    const p = planTurn({
      graph: buildGraph(makeMap([1, 2, 4, 5, 6, 7, 8, 9], [...edges, [4, 8], [8, 9]], [[901, 2, [4]]])),
      board: board([mine(1, 5), enemy(2, 9, 20), mine(4, 60), neutral(5, 80), mine(6, 1), mine(7, 1), mine(8, 1), { territoryId: 9, owner: { kind: 'unknown' }, armies: null }]),
      me: ME,
      income: 7,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }], turn: 8 },
      options: { goal: 'balanced', enemyDeploy: 5 },
    });
    expect(p.conceded).toContain(1);
    expect(p.rationale.join('\n')).not.toMatch(/links my holdings/);
  });
});

describe('#235 review: the FFA leader judges a held bonus on the strongest single opponent', () => {
  // The triangle above with T4 = 90 and T1 = 9; players 20 and 30 hold 8 each beside T1. Each alone
  // (7 + its ~5 deploy = 12) cannot take T1's 9 (15 to take); the two together can. With the +1
  // bonus B901 = {T1, T6} held in full, rule 1h's unit judged T1 on the two together and conceded
  // the bonus — a held bonus left less protected than the same border without one.
  const g = (bonus: boolean) =>
    buildGraph(
      makeMap(
        [1, 2, 3, 4, 5, 6],
        [
          [1, 2],
          [1, 3],
          [1, 4],
          [1, 6],
          [4, 6],
          [4, 5],
        ],
        bonus ? [[901, 1, [1, 6]]] : [],
      ),
    );
  const run = (bonus: boolean) =>
    planTurn({
      graph: g(bonus),
      board: board([mine(1, 9), enemy(2, 8, 20), enemy(3, 8, 30), mine(4, 90), neutral(5, 50), mine(6, 2)]),
      me: ME,
      income: 5,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 8 },
      options: { adapt: true, enemyDeploy: 5 },
    });

  it('without a bonus: T1 holds against each alone (the baseline)', () => {
    const p = run(false);
    expect(p.profile.ranking?.leader).toBe(ME);
    expect(p.conceded).not.toContain(1);
  });

  it('with the held bonus: not conceded, the bonus kept, sized for the single opponent', () => {
    const p = run(true);
    expect(p.profile.ranking?.leader).toBe(ME);
    expect(p.conceded).not.toContain(1);
    expect(outOf(p, 1)).toEqual([]);
    const w = p.warnings.join('\n');
    expect(w).not.toMatch(/T1 \(#1\) cannot be held/);
    expect(w).not.toMatch(/conced\w* bonus B901/);
    expect(p.rationale.join('\n')).toMatch(
      /I lead this free-for-all \(#201\), but holding bonus B901 \(#901\) \(\+1\) against players attacking together needs \d+: more than the 5 I can deploy, so its borders are sized for the strongest single opponent, as FFA players attack alone \(#235\): they hold on what they have/,
    );
  });
});

describe('#235 review sweep: a held bonus never leaves its border less protected than no bonus', () => {
  const edges: [number, number][] = [
    [1, 2],
    [1, 3],
    [1, 4],
    [1, 6],
    [4, 6],
    [4, 5],
  ];
  const plan = (bonus: boolean, e: number, t1: number, income: number) =>
    planTurn({
      graph: buildGraph(makeMap([1, 2, 3, 4, 5, 6], edges, bonus ? [[901, 1, [1, 6]]] : [])),
      board: board([mine(1, t1), enemy(2, e, 20), enemy(3, e, 30), mine(4, 90), neutral(5, 50), mine(6, 2)]),
      me: ME,
      income,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 8 },
      options: { adapt: true, enemyDeploy: 5 },
    });

  it('over enemies 8–20, T1 5–40, income 5 or 10: the bonus run concedes T1 only when the plain run does', () => {
    const worse: string[] = [];
    let soloBonus = 0;
    for (const income of [5, 10])
      for (let e = 8; e <= 20; e += 2)
        for (let t1 = 5; t1 <= 40; t1 += 5) {
          const plain = plan(false, e, t1, income);
          const held = plan(true, e, t1, income);
          if (held.rationale.some((l) => l.includes('holding bonus B901'))) soloBonus++;
          if (held.conceded.includes(1) && !plain.conceded.includes(1)) worse.push(`income ${income}, enemies ${e}, T1 ${t1}`);
        }
    expect(worse).toEqual([]);
    // The sweep reaches the new path.
    expect(soloBonus).toBeGreaterThan(0);
  });
});

describe('#235 review 2: a held bonus whose other member cannot be held', () => {
  // The triangle again, plus player 40's T7 (10) beside T6 (2): B901 = {T1, T6} can never be held
  // whole (T6 is hopeless on 5 income), so rule 1h concedes the unit. T1 (11) needs nothing against
  // either of players 20 and 30 alone (9 each): it must be judged as it is with no bonus — kept on
  // the strongest single opponent — not on the two together.
  const edges: [number, number][] = [
    [1, 2],
    [1, 3],
    [1, 4],
    [1, 6],
    [4, 6],
    [4, 5],
    [6, 7],
  ];
  const plan = (o: { bonus: number; e: number; t1: number; income: number; t7: 'enemy' | 'neutral'; t7armies?: number }) =>
    planTurn({
      graph: buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7], edges, o.bonus ? [[901, o.bonus, [1, 6]]] : [])),
      board: board([
        mine(1, o.t1),
        enemy(2, o.e, 20),
        enemy(3, o.e, 30),
        mine(4, 90),
        neutral(5, 50),
        mine(6, 2),
        o.t7 === 'enemy' ? enemy(7, o.t7armies ?? 10, 40) : neutral(7, o.t7armies ?? 10),
      ]),
      me: ME,
      income: o.income,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }, { id: 30 }, { id: 40 }], turn: 8 },
      options: { adapt: true, enemyDeploy: 5 },
    });

  it('the repro: T1 is kept with the bonus as without it', () => {
    const base = { e: 9, t1: 11, income: 5, t7: 'enemy' as const };
    const plain = plan({ ...base, bonus: 0 });
    const held = plan({ ...base, bonus: 1 });
    expect(plain.profile.ranking?.leader).toBe(ME);
    expect(plain.conceded).not.toContain(1);
    expect(held.conceded).not.toContain(1);
    // Triage concedes T6; #257: the idle 90 on T4 beside it then make it hold after all.
    expect(held.conceded).not.toContain(6);
    expect(held.rationale.join('\n')).toMatch(/Hold T6 \(#6\) after all \(not conceded\): transfer \d+ idle armies from T4 \(#4\)/);
    expect(held.rationale.join('\n')).toMatch(
      /holding T1 \(#1\) against players 20 and 30 attacking together needs \d+ .*sized for the strongest single opponent \(~13\).*: it holds on what it has/,
    );
  });

  it('sweep (second member threatened): the bonus run concedes T1 only when the plain run does', () => {
    const worse: string[] = [];
    let reached = 0;
    let skipped = 0;
    for (const t7 of ['enemy', 'neutral'] as const)
      for (const bonus of [1, 3, 6])
        for (const income of [5, 15, 30, 45])
          for (const e of [6, 9, 12, 18, 24, 30])
            for (const t1 of [3, 8, 11, 15, 20, 30, 40]) {
              const plain = plan({ bonus: 0, e, t1, income, t7 });
              const held = plan({ bonus, e, t1, income, t7 });
              // A plan that finishes a player off (rule 1e) picks its strike before any hold, and
              // the bonus can change which player it finishes: not a sizing question.
              const finished = (p: TurnPlan) =>
                p.rationale.flatMap((l) => /^Finish off player (\d+)/.exec(l)?.[1] ?? []).join(',');
              if (finished(plain) !== finished(held)) {
                skipped++;
                continue;
              }
              if (held.rationale.some((l) => /holding T1 \(#1\) against players 20 and 30/.test(l))) reached++;
              if (held.conceded.includes(1) && !plain.conceded.includes(1))
                worse.push(`T7 ${t7}, bonus +${bonus}, income ${income}, enemies ${e}, T1 ${t1}`);
            }
    expect(worse).toEqual([]);
    expect(reached).toBeGreaterThan(0);
    expect(skipped).toBeLessThan(100);
    console.log(`#235 review 2 sweep: reached ${reached}, skipped ${skipped} of 1,008`);
    // 2,016 plans: about half a second alone, past the 5 s default under coverage on a loaded machine.
  }, 60_000);
});

describe('#235 review 2: a cut after captures counts its per-territory income on the holdings it is cut from', () => {
  it('a captured territory in the cut-off part', () => {
    // My chain T1–T2–T3–T4–T5 (5 territories, base 4, one army per territory: income 5), and T9
    // beside T1 captured this turn. Losing T2 cuts off T1 and T9: 6 territories down to 4, so the
    // cut is worth 6 − 4 = 2, not territoryIncome(5) − territoryIncome(3) = 1 on the start-of-turn count.
    const g = buildGraph(makeMap([1, 2, 3, 4, 5, 9], [[1, 2], [2, 3], [3, 4], [4, 5], [1, 9]]));
    const input: PlanInput = {
      graph: g,
      board: board([mine(1, 3), mine(2, 3), mine(3, 3), mine(4, 3), mine(5, 3), neutral(9, 2)]),
      me: ME,
      income: 5,
      settings: { ...STD, baseIncome: 4, bonusArmyPer: 1 },
      game: { players: [{ id: ME }, { id: 20 }], turn: 8 },
    };
    const ctx = planContext(input);
    const ps = newPlanState();
    noteEstimates(ctx, ps);
    const book = deployBook(ctx, ps);
    expect(book.cutOff(2)).toMatchObject({ ids: [1], income: 1 });
    ps.captured.add(9);
    ps.holdings = new Set([...ctx.mine, 9]);
    book.cutCache.clear();
    expect(book.cutOff(2)).toMatchObject({ ids: [1, 9], income: 2 });
  });
});
