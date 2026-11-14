// #235 (a later comment): a free-for-all border that holds against each opponent alone is never
// conceded because two of them together could take it — even when I lead (#201), where the hold
// is sized for them together only while that pays; and (b) a border whose loss cuts my holdings in
// two protects what it cuts off. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
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
      options: { goal: 'balanced', enemyDeploy: 5 },
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
    const p = run(false);
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
