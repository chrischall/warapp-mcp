// Issue #69: a fog reveal is not enemy income. When my border advances, fog lifts over enemy
// stacks that already existed; last turn's board showed them hidden (fogged, or an owner-only
// fog level whose army count is a placeholder), so they never count as growth or captures.
// The observed figure is also capped at what the opponent could possibly earn.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import {
  enemyDeployEstimates,
  observeDeploy,
  observedDeploy,
  planTurn,
  type PlannerSettings,
} from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
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

// My +6 bonus {1, 2, 3}: T2 faces the enemy's T4, T3 its T5. Last turn I took T9 (a visible
// neutral next to T1), which lifted the fog over the enemy's T6, T7 and T8 (20 armies each,
// there all along). T10 stays fogged. The enemy's +30 bonus {10, 11} lies in the fog.
const g = buildGraph(
  makeMap(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    [
      [1, 2],
      [1, 3],
      [2, 3],
      [2, 4],
      [3, 5],
      [1, 9],
      [9, 6],
      [9, 7],
      [9, 8],
      [4, 10],
      [5, 10],
      [6, 10],
      [10, 11],
    ],
    [
      [901, 6, [1, 2, 3]],
      [902, 30, [10, 11]],
    ],
  ),
);

/** How a hidden territory may read on a previous board. */
const hiddenShapes: Record<string, (id: number) => TerritoryState> = {
  // The live board and its cache: owner unknown, armies null.
  fogged,
  // StandingFogLevel 3 (OwnerOnly): the owner shows, the army count is a placeholder.
  'owner-only': (id) => ({ territoryId: id, owner: { kind: 'player', playerId: ENEMY }, armies: 0, fogLevel: 'OwnerOnly' }),
  // A raw numeric fog level (GameFeed scalars are strings) over a neutral-looking placeholder.
  'numeric fog level': (id) => ({ territoryId: id, owner: { kind: 'neutral' }, armies: 2, fogLevel: '4' }),
};

const previous = (hide: (id: number) => TerritoryState) =>
  board([
    mine(1, 6),
    mine(2, 5),
    mine(3, 5),
    enemy(4, 3),
    enemy(5, 3),
    hide(6),
    hide(7),
    hide(8),
    neutral(9, 2),
    fogged(10),
    fogged(11),
  ]);
// The enemy deployed its base 5 (T4 +2, T5 +3); T6–T8 merely came into view.
const now = board([
  mine(1, 1),
  mine(2, 5),
  mine(3, 5),
  enemy(4, 5),
  enemy(5, 6),
  enemy(6, 20),
  enemy(7, 20),
  enemy(8, 20),
  mine(9, 4),
  fogged(10),
  fogged(11),
]);

describe('fog reveals are not enemy income (#69)', () => {
  for (const [shape, hide] of Object.entries(hiddenShapes)) {
    it(`observes the true small deploy when fog lifts over existing stacks (${shape})`, () => {
      const before = previous(hide);
      const o = observeDeploy(g, now, before, ENEMY);
      expect(o).toEqual({ deploy: 5, counted: [4, 5], captured: [], reveals: [6, 7, 8] });
      expect(observedDeploy(g, now, before, ENEMY)).toBe(5);
      const [e] = enemyDeployEstimates(g, now, ME, STD, before);
      expect(e).toMatchObject({ playerId: ENEMY, observed: 5, estimate: 5 });
    });

    it(`keeps the held bonus's borders instead of conceding them (${shape})`, () => {
      const p = planTurn({ graph: g, board: now, previousBoard: previous(hide), me: ME, income: 11, settings: STD });
      expect(p.enemyDeploy).toBe(5);
      expect(p.conceded).not.toContain(2);
      expect(p.conceded).not.toContain(3);
      // No "building" trend on the revealed stacks next to T9.
      expect(p.warnings.join('\n')).not.toMatch(/T[678] \(#[678]\) is building/);
    });
  }

  it('the revealed stacks never read as growth next to my border', () => {
    const p = planTurn({
      graph: g,
      board: now,
      previousBoard: previous(hiddenShapes['owner-only']!),
      me: ME,
      income: 11,
      settings: STD,
    });
    expect(p.rationale.join('\n')).not.toMatch(/uses the trend/);
  });

  it('a capture from a visible territory still counts', () => {
    // Last turn T9 was my visible 4; the enemy took it from T6 (20 → 14), leaving 5 there.
    const before = board([
      mine(1, 6),
      mine(2, 5),
      mine(3, 5),
      enemy(4, 3),
      enemy(5, 3),
      enemy(6, 20),
      fogged(7),
      fogged(8),
      { ...mine(9, 4), fogLevel: 'Visible' },
      fogged(10),
      fogged(11),
    ]);
    const after = board([
      mine(1, 6),
      mine(2, 5),
      mine(3, 5),
      enemy(4, 3),
      enemy(5, 3),
      enemy(6, 14),
      fogged(7),
      fogged(8),
      enemy(9, 5),
      fogged(10),
      fogged(11),
    ]);
    // Net −6 on T6, +5 on T9 and the 4 it killed there: 3.
    expect(observeDeploy(g, after, before, ENEMY)).toEqual({ deploy: 3, counted: [4, 5, 6, 9], captured: [9], reveals: [] });
  });

  it('a territory fogged last turn and owned by it now is a reveal, not a capture', () => {
    const before = board([mine(1, 6), mine(2, 5), mine(3, 5), enemy(4, 3), enemy(5, 3), fogged(6), fogged(7), fogged(8), mine(9, 4), fogged(10), fogged(11)]);
    const after = board([mine(1, 6), mine(2, 5), mine(3, 5), enemy(4, 3), enemy(5, 3), enemy(6, 30), fogged(7), fogged(8), enemy(9, 7), fogged(10), fogged(11)]);
    // T9 was visibly mine: a capture (7 + my 4). T6 was fogged: a reveal, whatever it holds.
    expect(observeDeploy(g, after, before, ENEMY)).toEqual({ deploy: 11, counted: [4, 5, 9], captured: [9], reveals: [6] });
  });

  it('caps the observed figure at what the opponent could earn, with a warning', () => {
    // Its 5 visible territories earn base 5; the +30 bonus {10, 11} lies in the fog, so it
    // could hold it: at most 35. Its visible armies grew by +100 on territories seen both times.
    const before = board([mine(1, 6), mine(2, 5), mine(3, 5), enemy(4, 3), enemy(5, 3), enemy(6, 3), enemy(7, 3), enemy(8, 3), mine(9, 4), fogged(10), fogged(11)]);
    const after = board([mine(1, 6), mine(2, 5), mine(3, 5), enemy(4, 23), enemy(5, 23), enemy(6, 23), enemy(7, 23), enemy(8, 23), mine(9, 4), fogged(10), fogged(11)]);
    const [e] = enemyDeployEstimates(g, after, ME, STD, before);
    expect(e).toMatchObject({ observedRaw: 100, observedCap: 35, observed: 35, estimate: 35, source: 'observed' });
    const p = planTurn({ graph: g, board: after, previousBoard: before, me: ME, income: 11, settings: STD });
    expect(p.enemyDeploy).toBe(35);
    expect(p.warnings.join('\n')).toMatch(
      /player 20 was observed to deploy \+100\/turn, more than it could earn \(base 5 for its 5 visible territories \+ bonuses it could hold \+30 = 35\): capped at 35/,
    );
    // A bonus with a territory visibly held by someone else (here: neutral T11) is out of reach.
    const neutralEleven = board([...after.territories.filter((t) => t.territoryId !== 11), neutral(11, 2)]);
    const [f] = enemyDeployEstimates(g, neutralEleven, ME, STD, before);
    expect(f).toMatchObject({ observedRaw: 100, observedCap: 5, observed: 5 });
    // Under the cap nothing is cut and nothing is said.
    const q = planTurn({ graph: g, board: now, previousBoard: previous(fogged), me: ME, income: 11, settings: STD });
    expect(q.warnings.join('\n')).not.toMatch(/capped at/);
  });

  it('owner-only territories count toward its visible income, whatever their armies', () => {
    // Light fog: the owner shows everywhere, armies only next to me. The enemy visibly holds
    // its +30 bonus {10, 11} owner-only (armies null), so the bonus and both territories count.
    const ownerOnly = (id: number): TerritoryState => ({
      territoryId: id,
      owner: { kind: 'player', playerId: ENEMY },
      armies: null,
      fogLevel: 'OwnerOnly',
    });
    const lightFog = board([mine(1, 6), mine(2, 5), mine(3, 5), enemy(4, 5), enemy(5, 6), fogged(6), fogged(7), fogged(8), neutral(9, 2), ownerOnly(10), ownerOnly(11)]);
    const [e] = enemyDeployEstimates(g, lightFog, ME, STD);
    expect(e).toMatchObject({ playerId: ENEMY, held: 4, base: 5, bonusIncome: 30, largestStack: 6 });
    // An opponent seen only owner-only still gets an estimate, with no stack to size by.
    const onlyOwnerOnly = board([mine(1, 6), mine(2, 5), mine(3, 5), fogged(4), fogged(5), fogged(6), fogged(7), fogged(8), neutral(9, 2), ownerOnly(10), ownerOnly(11)]);
    const [f] = enemyDeployEstimates(g, onlyOwnerOnly, ME, STD);
    expect(f).toMatchObject({ playerId: ENEMY, held: 2, bonusIncome: 30, largestStack: 0, stackCap: 0 });
    expect(Number.isFinite(f!.estimate)).toBe(true);
  });

  it('the cap warning counts the territories behind its base', () => {
    // T10 reads owner-only for the enemy now: in its base (6 territories), but neither counted
    // nor a reveal in the observation (its armies are hidden).
    const before = board([mine(1, 6), mine(2, 5), mine(3, 5), enemy(4, 3), enemy(5, 3), enemy(6, 3), enemy(7, 3), enemy(8, 3), mine(9, 4), fogged(10), fogged(11)]);
    const after = board([
      mine(1, 6), mine(2, 5), mine(3, 5), enemy(4, 23), enemy(5, 23), enemy(6, 23), enemy(7, 23), enemy(8, 23), mine(9, 4),
      { territoryId: 10, owner: { kind: 'player', playerId: ENEMY }, armies: null, fogLevel: 'OwnerOnly' },
      fogged(11),
    ]);
    const p = planTurn({ graph: g, board: after, previousBoard: before, me: ME, income: 11, settings: STD });
    expect(p.warnings.join('\n')).toMatch(/\(base 5 for its 6 visible territories \+ bonuses it could hold \+30 = 35\): capped at 35/);
  });

  it('the rationale names the turns compared and the territories counted vs skipped as reveals', () => {
    const p = planTurn({ graph: g, board: now, previousBoard: previous(fogged), me: ME, income: 11, settings: STD, turn: 15 });
    const r = p.rationale.join('\n');
    expect(r).toMatch(
      /Observed deploy for player 20, turn 14 → turn 15: \+5\/turn over 2 territories visible on both boards \(0 captured\); 3 skipped as fog reveals \(T6 \(#6\), T7 \(#7\), T8 \(#8\)\)/,
    );
    // Without a turn number the boards are named instead.
    const q = planTurn({ graph: g, board: now, previousBoard: previous(fogged), me: ME, income: 11, settings: STD });
    expect(q.rationale.join('\n')).toMatch(/Observed deploy for player 20, previous board → this board: \+5\/turn/);
  });

  it('explains why each border facing one opponent is sized for its whole deploy (#69, second point)', () => {
    const p = planTurn({ graph: g, board: now, previousBoard: previous(fogged), me: ME, income: 11, settings: STD });
    const holds = p.rationale.filter((l) => /^Deploy \d+ to T[23] \(#[23]\) so it holds/.test(l));
    expect(holds).toHaveLength(2);
    expect(p.rationale.join('\n')).toMatch(
      /Each of the 2 borders held against player 20 \(T2 \(#2\), T3 \(#3\)\) is sized for its full ~5 deploy/,
    );
  });
});
