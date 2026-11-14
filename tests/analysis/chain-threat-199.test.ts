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

  it('runs only through territories not mine: a chain through my 3 is the border at 3, not a threat to 2', () => {
    const p = plan(true, [mine(1, 1), mine(2, 1), mine(3, 2), foe(4, 8), neutral(5, 1)]);
    expect(why(p)).not.toMatch(/Multi-Attack chain/);
  });
});
