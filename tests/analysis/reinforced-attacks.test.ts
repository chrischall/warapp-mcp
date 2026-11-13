// Issue #120: an attack on a player's territory was sized for the defenders standing there now,
// even out of a huge stack, so the owner's own deploy there first could make it fail. When idle
// armies beyond what holds the source cover it, the attack is sized for the defenders plus the
// owner's deploy estimate; otherwise the plan reports its win chance against the reinforced target.
// Rule 0p.3c picks the strike stack's border by what it can take, and fog pressure (rule 1e) is
// not priced against expansion when idle armies pay for it. Every map, id and name here is made up.
// Kill rates 60/70, no luck: armiesToTake 5:8 10:16 25:42 30:50 33:55.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const THIRD = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  return {
    id: 1,
    name: 'Synthetic reinforced',
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
const warned = (p: TurnPlan) => p.warnings.join('\n');

/** The plan passes warapp_submit_turn's validator (it throws on a refusal). */
function valid(input: PlanInput, p: TurnPlan) {
  const map = input.graph.map;
  const names = new Map(map.territories.map((t) => [t.id, t.name]));
  const ref = (id: number) => ({ id, name: names.get(id)! });
  validateTurn({
    map,
    board: input.board.territories.map(
      (t): LiveTerritory => ({
        territoryId: t.territoryId,
        fogLevel: t.armies === null ? 4 : 1,
        fogged: t.armies === null,
        owner: t.owner.kind === 'player' ? t.owner.playerId : t.owner.kind === 'neutral' ? OWNER_NEUTRAL : -1,
        armies: t.armies,
      }),
    ),
    myInGameId: ME,
    income: input.income,
    guard: true,
    deploys: p.deploys.map((d) => ({ territory: ref(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: ref(m.from), to: ref(m.to), armies: m.armies })),
  });
}

// My 80-stack T1 beside the opponent's T2 (5), with its T3 (10) behind; T4 is mine. Income 8, the
// opponent's deploy ~5. Taking T2 for sure if it deploys its ~5 there first needs 16, and T1 has
// 87 movable with nothing left to face once T2 falls.
describe('an attack out of a big stack is sized for the owner deploying there first (#120)', () => {
  const edges: [number, number][] = [
    [1, 2],
    [2, 3],
    [1, 4],
  ];
  it('a break: at least 16, and no "assumes it does not reinforce" warning', () => {
    const g = buildGraph(makeMap([1, 2, 3, 4], edges, [[100, 3, [1, 4]], [101, 3, [2, 3]]]));
    const input: PlanInput = {
      graph: g,
      board: board([mine(1, 80), enemy(2, 5), enemy(3, 10), mine(4, 1)]),
      me: ME,
      income: 8,
      settings: STD,
      game: { players: [{ id: ME }, { id: ENEMY }] },
      options: { adapt: true },
    };
    const p = planTurn(input);
    expect(p.enemyDeploy).toBe(5);
    expect(armiesToTake(10, { offensiveKillRate: 60, defensiveKillRate: 70 })).toBe(16);
    const a = attacks(p).find((m) => m.to === 2)!;
    expect(a.from).toBe(1);
    expect(a.armies).toBeGreaterThanOrEqual(16);
    expect(warned(p)).not.toMatch(/Attack on enemy T2 \(#2\) assumes its owner does not reinforce it first/);
    expect(why(p)).toMatch(
      /Size the attack on T2 \(#2\) from T1 \(#1\) up from \d+ to 16 with \d+ idle armies there: 16 take it even if player 20 deploys its ~5 there first/,
    );
    valid(input, p);
  });

  it('the strike stack: at least 16 too', () => {
    // T2's bonus has a fogged third member, so T2 breaks nothing: the 1v1 strike stack takes it.
    const g = buildGraph(makeMap([1, 2, 3, 4, 5], [...edges, [3, 5]], [[100, 3, [1, 4]], [101, 3, [2, 3, 5]]]));
    const input: PlanInput = {
      graph: g,
      board: board([mine(1, 80), enemy(2, 5), enemy(3, 10), mine(4, 1), fogged(5)]),
      me: ME,
      income: 8,
      settings: STD,
      game: { players: [{ id: ME }, { id: ENEMY }] },
      options: { adapt: true },
    };
    const p = planTurn(input);
    const a = attacks(p).find((m) => m.to === 2)!;
    expect(a.from).toBe(1);
    expect(a.armies).toBeGreaterThanOrEqual(16);
    expect(warned(p)).not.toMatch(/Attack on enemy T2 \(#2\) assumes its owner does not reinforce it first/);
    expect(p.offence).toContainEqual(expect.objectContaining({ target: 2, kind: 'strike-attack', cost: a.armies, taken: true }));
    valid(input, p);
  });

  it('a stack too small to cover the deploy attacks as before, and the warning gives the win chance against it', () => {
    // T1 (10) + 3: 12 movable take T2 (8) but not the 16 its ~5 deploy would need.
    const g = buildGraph(makeMap([1, 2, 3, 4, 5], [...edges, [3, 5]], [[100, 3, [1, 4]], [101, 3, [2, 3, 5]]]));
    const input: PlanInput = {
      graph: g,
      board: board([mine(1, 10), enemy(2, 5), enemy(3, 10), mine(4, 1), fogged(5)]),
      me: ME,
      income: 3,
      settings: STD,
      game: { players: [{ id: ME }, { id: ENEMY }] },
      options: { adapt: true },
    };
    const p = planTurn(input);
    const a = attacks(p).find((m) => m.to === 2)!;
    expect(a.armies).toBeLessThan(16);
    expect(warned(p)).toMatch(
      /Attack on enemy T2 \(#2\) assumes its owner does not reinforce it first: if player 20 deploys its ~5 there, \d+ attack 10 \(win chance \d+%\); 16 would be sure\./,
    );
    valid(input, p);
  });
});
