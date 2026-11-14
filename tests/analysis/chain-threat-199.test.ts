// #199: under Multi-Attack the planner counts an enemy stack's attack chain — a capture, then the
// survivors on from it — that reaches a territory of mine through territories not mine as a threat
// there. Synthetic map only (every id and name is made up).
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import { validateTurn } from '../../src/tools/turn.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

// 1 ─ 2 ─ 3 ─ 4 ─ 5: my +3 bonus is 1, 2, 3; a neutral 4 stands between my 3 and the enemy's 5.
const MAP: GameMap = {
  id: 1,
  name: 'Chainland',
  territories: [1, 2, 3, 4, 5].map((id) => ({ id, name: `T${id}`, connectedTo: [id - 1, id + 1].filter((x) => x >= 1 && x <= 5) })),
  bonuses: [{ id: 100, name: 'Home', value: 3, territoryIds: [1, 2, 3], bonusIds: [] }],
  distributionModes: [],
};
const foe = (id: number, armies: number): TerritoryState => mine(id, armies, FOE);
const why = (p: { rationale: string[]; warnings: string[] }) => [...p.rationale, ...p.warnings].join('\n');
const deployedTo = (p: { deploys: { territoryId: number; armies: number }[] }, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;

/** The plan, after warapp_submit_turn's validator accepts it (it throws on a refusal). */
function plan(multiAttack: boolean, entries: TerritoryState[]) {
  const p = planTurn({
    graph: buildGraph(MAP),
    board: board(entries),
    me: ME,
    income: 8,
    settings: { ...STD, multiAttack },
    options: { goal: 'defend', enemyDeploy: 4 },
  });
  const ref = (id: number) => ({ id, name: `T${id}` });
  validateTurn({
    map: MAP,
    board: entries.map(
      (t): LiveTerritory => ({
        territoryId: t.territoryId,
        fogLevel: 1,
        fogged: false,
        owner: t.owner.kind === 'player' ? t.owner.playerId : OWNER_NEUTRAL,
        armies: t.armies,
      }),
    ),
    myInGameId: ME,
    income: 8,
    guard: true,
    deploys: p.deploys.map((d) => ({ territory: ref(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: ref(m.from), to: ref(m.to), armies: m.armies })),
    multiAttack,
  });
  return p;
}

describe('planner: Multi-Attack chains as a threat (#199)', () => {
  // No enemy stack touches my 3: it is no border without chains.
  const entries = [mine(1, 1), mine(2, 1), mine(3, 2), neutral(4, 1), foe(5, 8)];

  it('holds a territory a chain reaches through a neutral', () => {
    // 8 + 4 deployed − 1 guard = 11 take the neutral 1 (10 survive) and 9 go on to my 3.
    const p = plan(true, entries);
    expect(why(p)).toMatch(/Multi-Attack chain: player 20's stack on T5 \(#5\) can take T4 \(#4\) and attack T3 \(#3\) with ~9 armies/);
    expect(deployedTo(p, 3)).toBeGreaterThanOrEqual(4);
    expect(p.frontier.borders).toBeGreaterThanOrEqual(1);
  });

  it('is not a threat without Multi-Attack', () => {
    const p = plan(false, entries);
    expect(why(p)).not.toMatch(/Multi-Attack chain/);
  });

  it('runs only through territories not mine: a chain onto my 3 does not go on to my 2', () => {
    // No enemy stack touches 3 or 2: the chain 5 → 4 → 3 is 3's threat; through my 3 to my 2 it is none.
    const p = plan(true, [mine(1, 1), mine(2, 1), mine(3, 1), neutral(4, 1), foe(5, 12)]);
    expect(why(p)).toMatch(/Multi-Attack chain: player 20's stack on T5 \(#5\) can take T4 \(#4\) and attack T3 \(#3\)/);
    expect(why(p)).not.toMatch(/attack T2 \(#2\)/);
  });

  it('says the chain is the threat, not movable armies next to it plus a deploy', () => {
    const p = plan(true, entries);
    expect(why(p)).toMatch(/T3 \(#3\) \(2 armies\) could be taken next turn: player 20 can attack it with ~9 armies by a Multi-Attack chain from T5 \(#5\)/);
    expect(why(p)).not.toMatch(/movable armies next to it plus ~0 deploy/);
  });
});

// 1 ─ 2 ─ 3 ─ 4 ─ 5 ─ 6: my +3 bonus is 1, 2, 3.
const LINE6: GameMap = {
  ...MAP,
  territories: [1, 2, 3, 4, 5, 6].map((id) => ({ id, name: `T${id}`, connectedTo: [id - 1, id + 1].filter((x) => x >= 1 && x <= 6) })),
};
const OTHER = 30;

describe('planner: a chain against the stacks next to the border (#199)', () => {
  const run = (entries: TerritoryState[], income = 2) =>
    planTurn({
      graph: buildGraph(LINE6),
      board: board(entries),
      me: ME,
      income,
      settings: { ...STD, multiAttack: true },
      options: { enemyDeploy: 4 },
    });

  it('a bigger chain from another player is the threat, and its player is named', () => {
    // Player 30's 2 on T4 are next to my 3; player 20's 30 on T6 take T5 then T4 and land ~29 on 3.
    const p = run([mine(1, 1), mine(2, 1), mine(3, 2), mine(4, 2, OTHER), neutral(5, 1), foe(6, 30)]);
    expect(why(p)).toMatch(/Multi-Attack chain: player 20's stack on T6 \(#6\) can take T5 \(#5\) then T4 \(#4\) and attack T3 \(#3\) with ~29 armies/);
    expect(why(p)).toMatch(/T3 \(#3\) \(2 armies\) could be taken next turn: player 20 can attack it with ~29 armies by a Multi-Attack chain from T6 \(#6\)/);
    expect(why(p)).not.toMatch(/could be taken next turn: player 30/);
  });

  it('a bigger stack next to the border is the threat, not a smaller chain', () => {
    // Player 30's 20 on T4 are next to my 3; player 20's 6 on T6 take the neutral 5 but not them.
    const p = run([mine(1, 1), mine(2, 1), mine(3, 2), mine(4, 20, OTHER), neutral(5, 1), foe(6, 6)]);
    expect(why(p)).not.toMatch(/Multi-Attack chain: player/);
    expect(why(p)).toMatch(/T3 \(#3\) \(2 armies\) could be taken next turn: player 30 has 19 movable armies next to it/);
  });
});

// 1 ─ 2 ─ 3 ─ 4 ─ 5 ─ 6 ─ 7: my +3 bonus is 1, 2, 3; T4 alone is a +2 bonus.
const LINE7: GameMap = {
  ...MAP,
  territories: [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, name: `T${id}`, connectedTo: [id - 1, id + 1].filter((x) => x >= 1 && x <= 7) })),
  bonuses: [...MAP.bonuses, { id: 101, name: 'Far', value: 2, territoryIds: [4], bonusIds: [] }],
};

describe('planner: a chain through a territory the plan captures (#199)', () => {
  it('no longer counts once the plan takes a territory on its path', () => {
    // Player 20's 10 on T6 take T5 then T4 and land ~9 on my 3; the plan takes T4 from my 3, so
    // after the attack that chain is cut and my 3 needs no deploy to stay held behind it.
    const p = planTurn({
      graph: buildGraph(LINE7),
      board: board([mine(1, 1), mine(2, 1), mine(3, 6), neutral(4, 1), neutral(5, 1), foe(6, 10), neutral(7, 1)]),
      me: ME,
      income: 5,
      settings: { ...STD, multiAttack: true },
      options: { goal: 'expand', enemyDeploy: 4 },
    });
    expect(p.moves.map((m) => [m.from, m.to])).toContainEqual([3, 4]);
    expect(why(p)).toMatch(/Multi-Attack chain: player 20's stack on T6 \(#6\) can take T5 \(#5\) then T4 \(#4\) and attack T3 \(#3\)/);
    expect(why(p)).not.toMatch(/so it still holds its border after the attack on T4/);
  });

  it('counts a chain onto the captured territory itself: it faces an enemy after the plan', () => {
    // The plan takes T4; player 20's 10 on T6 take T5 and attack T4 next: the capture is a border
    // facing an enemy, with a hold cost, though no enemy stack is next to it.
    const run = (multiAttack: boolean) =>
      planTurn({
        graph: buildGraph(LINE7),
        board: board([mine(1, 1), mine(2, 1), mine(3, 6), neutral(4, 1), neutral(5, 1), foe(6, 10), neutral(7, 1)]),
        me: ME,
        income: 5,
        settings: { ...STD, multiAttack },
        options: { goal: 'expand', enemyDeploy: 4 },
      });
    const off = run(false);
    const on = run(true);
    expect(off.moves.map((m) => [m.from, m.to])).toContainEqual([3, 4]);
    expect(on.moves.map((m) => [m.from, m.to])).toContainEqual([3, 4]);
    expect(off.frontier.enemyBorders).toBe(0);
    expect(on.frontier.enemyBorders).toBe(1);
    expect(on.frontier.holdCost).toBeGreaterThan(0);
  });
});

// 1, 2 my +5 bonus; a neutral 4 next to both; the enemy's 5 next to 4 only.
const FORK: GameMap = {
  id: 2,
  name: 'Fork',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2, 4] },
    { id: 2, name: 'T2', connectedTo: [1, 4] },
    { id: 4, name: 'T4', connectedTo: [1, 2, 5] },
    { id: 5, name: 'T5', connectedTo: [4] },
  ],
  bonuses: [{ id: 100, name: 'Home', value: 5, territoryIds: [1, 2], bonusIds: [] }],
  distributionModes: [],
};

describe('planner: a chain is armies already there for the floor tier (#199, #118)', () => {
  const run = (multiAttack: boolean, income: number) =>
    planTurn({
      graph: buildGraph(FORK),
      board: board([mine(1, 2), mine(2, 2), neutral(4, 1), foe(5, 30)]),
      me: ME,
      income,
      settings: { ...STD, multiAttack },
      options: { enemyDeploy: 5 },
    });

  it('does not call a border floored when the chain takes it with no deploy at all', () => {
    // Player 20's 30 on T5 take the neutral 4 and land ~27 on either of my borders without
    // deploying: at income 3 neither border beats them, so the bonus is conceded, not floored, and
    // the deploy is not spread over two borders that both fall.
    const p = run(true, 3);
    expect(why(p)).not.toMatch(/it is not conceded: every border beats the armies already next to it/);
    expect(p.deploys.filter((d) => d.armies > 0)).toHaveLength(1);
    expect(why(p)).toMatch(/This plan concedes bonus Home/);
  });

  it('floors a border against the chain\'s standing armies, so only the deploy is left to aim', () => {
    // At income 30 each border can beat the ~27 the chain lands with no deploy: a real floor, and
    // what breaks one is the ~5 deploy, not the whole ~32 chain.
    const p = run(true, 30);
    expect(why(p)).toMatch(/beat the 27 already next to it \(28 to take\)/);
    expect(why(p)).toMatch(/T1 \(#1\) \(17 armies; 1 of the ~5 deploy take it\)/);
    expect(why(p)).not.toMatch(/of the ~32 deploy/);
  });
});

describe('planner: the deploy estimate of a player that threatens by a chain alone (#199)', () => {
  it('explains that player\'s deploy estimate though no stack of it is next to mine', () => {
    const p = planTurn({
      graph: buildGraph(MAP),
      board: board([mine(1, 1), mine(2, 1), mine(3, 2), neutral(4, 1), foe(5, 8)]),
      me: ME,
      income: 8,
      settings: { ...STD, multiAttack: true },
      options: { goal: 'defend' },
    });
    expect(why(p)).toMatch(/Multi-Attack chain: player 20's stack on T5/);
    expect(why(p)).toMatch(/Enemy deploy estimate for player 20/);
  });
});
