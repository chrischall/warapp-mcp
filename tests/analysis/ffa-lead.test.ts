// #167, the live comment: in a free-for-all with a big army lead, idle stacks beside weak enemy
// territories are a lever, not a risk — the second-front rule (0p.2) is scaled by my army lead and
// off past SECOND_FRONT_LEAD×; and every enemy territory next to mine that the plan does not attack
// names its reason. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, SECOND_FRONT_LEAD, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { validateTurn } from '../../src/tools/turn.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const STD: PlannerSettings = { offensiveKillRate: 50, defensiveKillRate: 70, oneArmyStandsGuard: true };

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
const enemy = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
/** The plan passes warapp_submit_turn's validator: its warnings (none when legal; it throws on a refusal). */
function valid(p: TurnPlan, i: PlanInput) {
  const names = new Map(i.graph.map.territories.map((t) => [t.id, t.name]));
  const ref = (id: number) => ({ id, name: names.get(id)! });
  const b: BoardState = i.board;
  return validateTurn({
    map: i.graph.map,
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
    income: i.income,
    guard: true,
    deploys: p.deploys.map((d) => ({ territory: ref(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: ref(m.from), to: ref(m.to), armies: m.armies })),
  }).warnings;
}
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const why = (p: TurnPlan) => p.rationale.join('\n');

// Me on 1, 2, 3. T4 (a neutral 2) completes my +8. T5 (player 20, 17 armies) stands beside my T3
// and is a step into B802 (+3, with the neutral T9). Player 20's 43-stack T6, player 30's T7 and
// player 40's T8 are out of my reach: none of them can attack me.
const g = buildGraph(
  makeMap(
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
    [
      [1, 2],
      [2, 3],
      [1, 4],
      [3, 5],
      [5, 6],
      [5, 9],
      [6, 9],
      [6, 7],
      [7, 8],
    ],
    [
      [801, 8, [4]],
      [802, 3, [5, 9]],
    ],
  ),
);
const players = [{ id: ME }, { id: 20 }, { id: 30 }, { id: 40 }];
const input = (stacks: [number, number, number]): PlanInput => ({
  graph: g,
  board: board([
    mine(1, stacks[0]),
    mine(2, stacks[1]),
    mine(3, stacks[2]),
    neutral(4, 2),
    enemy(5, 17, 20),
    enemy(6, 43, 20),
    enemy(7, 53, 30),
    enemy(8, 18, 40),
    neutral(9, 2),
  ]),
  me: ME,
  income: 38,
  settings: STD,
  game: { players, turn: 10 },
  options: { adapt: true },
});

describe('#167: a big army lead in a free-for-all', () => {
  it('exports its constant', () => {
    expect(SECOND_FRONT_LEAD).toBe(3);
  });

  it('with more than 3× the next player\'s armies, an idle stack takes the weak enemy territory beside it, sized for its owner\'s deploy', () => {
    // 80 + 60 + 55 = 195 against player 20's 60 in view: 3.25×.
    const p = planTurn(input([80, 60, 55]));
    expect(p.profile.format).toBe('ffa');
    const hit = attacks(p).find((m) => m.to === 5);
    expect(hit).toBeDefined();
    expect(hit!.from).toBe(3);
    // 17 defenders plus player 20's ~5 deploy: 22, taken for sure by 43 at 50/70.
    expect(hit!.armies).toBeGreaterThanOrEqual(43);
    expect(why(p)).toMatch(/army lead/);
    expect(why(p)).toMatch(/T5 \(#5\)/);
    // The completion is still made.
    expect(attacks(p).map((m) => m.to)).toContain(4);
    expect(valid(p, input([80, 60, 55]))).toEqual([]);
  });

  it('below the lead the stack stands, and the rationale says why T5 is not attacked', () => {
    // 30 + 25 + 20 = 75 against 60: 1.25×.
    const p = planTurn(input([30, 25, 20]));
    expect(attacks(p).map((m) => m.to)).not.toContain(5);
    expect(why(p)).toMatch(/Not attacking .*T5 \(#5\) \(player 20, 17 armies\): /);
  });

  it('every enemy territory next to mine that is not attacked names its reason', () => {
    for (const stacks of [
      [30, 25, 20],
      [80, 60, 55],
      [80, 60, 10],
    ] as [number, number, number][]) {
      const p = planTurn(input(stacks));
      const hit = new Set(attacks(p).map((m) => m.to));
      if (!hit.has(5)) expect(why(p)).toMatch(/T5 \(#5\) \(player 20, 17 armies\): /);
    }
  });

  it('every attack on a player carries its exchange (#167): a lead strike sized for the deploy is a certain first strike', () => {
    const p = planTurn(input([80, 60, 55]));
    const x = p.exchanges?.find((e) => e.to === 5);
    expect(x).toMatchObject({ from: 3, label: 'certain first strike' });
    expect(x!.cases.map((c) => [c.case, c.defenders, c.captures])).toEqual([
      ['now', 17, true],
      ['estimated', 22, true],
      ['whole', 22, true],
    ]);
    // Neutral captures carry none.
    expect(p.exchanges?.some((e) => e.to === 4)).toBe(false);
    expect(why(p)).toMatch(/Exchange of attacks on players \(#167\): T5 \(#5\) from T3 \(#3\) with \d+: certain first strike/);
  });

  it('is deterministic', () => {
    expect(planTurn(input([80, 60, 55]))).toEqual(planTurn(input([80, 60, 55])));
  });
});

describe('#167: the reason an enemy territory next to mine is left alone stays accurate', () => {
  it('under goal defend, when the plan attacks another player\'s territory, it does not claim it attacks none', () => {
    // My 60 on T1 faces player 20's 3 on T2 and player 30's 15 on T9. Behind on income, the goal is
    // defend; rule 4e's fallback still takes T2. T9 is left alone.
    const m = makeMap(
      [1, 2, 5, 6, 9],
      [
        [1, 2],
        [1, 9],
        [2, 5],
        [5, 6],
      ],
      [[901, 2, [1]]],
    );
    const i: PlanInput = {
      graph: buildGraph(m),
      board: board([mine(1, 60), enemy(2, 3, 20), enemy(9, 15, 30), enemy(5, 3, 20), enemy(6, 3, 30)]),
      me: ME,
      income: 2,
      settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
      game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 8 },
      options: { adapt: true, enemyDeploy: 16 },
    };
    const p = planTurn(i);
    expect(why(p)).toMatch(/Goal defend/);
    expect(attacks(p).map((x) => x.to)).toEqual([2]);
    expect(why(p)).toMatch(
      /T9 \(#9\) \(player 30, 15 armies\): under goal defend the plan attacks a player's territory only where a rule calls for it \(here T2 \(#2\)\), and none calls for this one/,
    );
    expect(why(p)).not.toMatch(/goal defend attacks no player's territory/);
  });

  it('with the lead lever on, a territory a neighbour cannot take for sure names the lead strike\'s size, not the lead', () => {
    // My 32 on T1 is 4.0× player 20's 8 in view, but a lead strike on T2 is sized for its 5 defenders
    // plus player 20's ~16 deploy, more than T1 can spare.
    const m = makeMap(
      [1, 2, 3, 5, 6, 7, 8],
      [
        [1, 2],
        [1, 3],
        [1, 7],
        [7, 8],
        [2, 5],
        [5, 6],
      ],
      [
        [901, 2, [1]],
        [902, 6, [3]],
        [903, 3, [7, 8]],
      ],
    );
    const i: PlanInput = {
      graph: buildGraph(m),
      board: board([mine(1, 32), enemy(2, 5, 20), neutral(3, 2), enemy(5, 3, 20), enemy(6, 3, 30), neutral(7, 4), neutral(8, 4)]),
      me: ME,
      income: 10,
      settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
      game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 8 },
      options: { adapt: true, enemyDeploy: 16 },
    };
    const p = planTurn(i);
    expect(why(p)).toMatch(/FFA army lead: my 32 armies in view are 4\.0×/);
    expect(attacks(p).map((x) => x.to)).not.toContain(2);
    expect(why(p)).toMatch(
      /T2 \(#2\) \(player 20, 5 armies\): a lead strike \(my army lead is 4\.0×, over 3×\) needs \d+ — sized for its 5 defenders plus player 20's ~16 deploy — and the most a neighbour of mine can spare for it is \d+ \(T1 \(#1\)\)/,
    );
    expect(why(p)).not.toMatch(/a lead strike takes one only with an army lead over 3×; mine is 4\.0×/);
  });
});

describe('#167: the "Not attacking" line is capped', () => {
  it('gives the first six their reasons and names the rest', () => {
    // My T1 (2 armies) touches nine enemy territories of 20 armies each, T2–T10.
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const m = makeMap(
      ids,
      ids.slice(1).map((n) => [1, n] as [number, number]),
      [[901, 2, [1]]],
    );
    const p = planTurn({
      graph: buildGraph(m),
      board: board([mine(1, 2), ...ids.slice(1).map((n) => enemy(n, 20, n % 2 ? 20 : 30))]),
      me: ME,
      income: 5,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 8 },
      options: { adapt: true },
    });
    const line = p.rationale.find((l) => l.startsWith('Not attacking'))!;
    expect(line).toMatch(/^Not attacking 9 enemy territories next to mine: T2 \(#2\) \(player 30, 20 armies\): /);
    expect(line).toMatch(/T7 \(#7\) \(player 20, 20 armies\): [^;]+; and 3 more: T8 \(#8\), T9 \(#9\), T10 \(#10\)\.$/);
    expect(line).not.toMatch(/T8 \(#8\) \(player/);
  });
});

describe('#167: the army lead under fog', () => {
  it('a player stronger on the FFA ranking (armies + income) that shows a small stack does not switch the lever on', () => {
    // My 40 on T1 against player 20's 5 in view is 8×, but player 20 holds B902 (+40): it leads the
    // ranking on strength, so the lead does not switch the second-front rule off.
    const m = makeMap(
      [1, 2, 3, 4, 5],
      [
        [1, 2],
        [2, 3],
        [3, 4],
        [4, 5],
      ],
      [
        [901, 2, [1]],
        [902, 40, [2, 3]],
      ],
    );
    const i = (bonus: number): PlanInput => ({
      graph: buildGraph({ ...m, bonuses: m.bonuses.map((b) => (b.id === 902 ? { ...b, value: bonus } : b)) }),
      board: board([mine(1, 40), enemy(2, 3, 20), enemy(3, 2, 20), neutral(4, 2), enemy(5, 2, 30)]),
      me: ME,
      income: 10,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 8 },
      options: { adapt: true },
    });
    const strong = planTurn(i(40));
    expect(strong.profile.ranking?.myRank).toBeGreaterThan(1);
    expect(why(strong)).not.toMatch(/FFA army lead/);
    // Rule 0p.2 still applies in rule 4e: taking T2 is named a second front.
    expect(why(strong)).toMatch(/taking T2 \(#2\) opens a second front/);
    // The same board with B902 worth +1: I lead the ranking, and the lever is on.
    const weak = planTurn(i(1));
    expect(weak.profile.ranking?.myRank).toBe(1);
    expect(why(weak)).toMatch(/FFA army lead: my 40 armies in view are 8\.0×/);
  });
});
