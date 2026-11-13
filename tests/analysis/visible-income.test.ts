// An opponent's deploy estimate never goes below the income it visibly holds. The old
// rule capped base + visible bonuses at 75% of its largest stack next to me, so a player
// holding +10 in plain view with a 2-stack on my border was estimated at 5: borders were
// under-defended, "sure" eliminations failed, and the profile read "ahead" at 8 against 15.
// A stack says how much can MOVE; it says nothing about how much can be DEPLOYED.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { enemyDeployEstimates, planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const OTHER = 21;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const enemy = (territoryId: number, armies: number, playerId = ENEMY): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

function makeMap(edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  const ids = [...new Set(edges.flat())].sort((a, b) => a - b);
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

describe('an opponent is never estimated below the income it visibly holds', () => {
  // 5 ─ 1 ─ 2 ─ 3 ─ 4     I hold {1,5} (+3). The opponent holds {2,3,4} (+10) in full view,
  //                       with only a 2-stack on my border.
  const g = buildGraph(
    makeMap(
      [[5, 1], [1, 2], [2, 3], [3, 4]],
      [[101, 3, [1, 5]], [102, 10, [2, 3, 4]]],
    ),
  );
  const s = board([mine(5, 1), mine(1, 5), enemy(2, 2), enemy(3, 1), enemy(4, 1)]);

  it('estimates base + visible bonuses, whatever the size of its stack next to me', () => {
    const [e] = enemyDeployEstimates(g, s, ME, STD);
    expect(e).toMatchObject({ playerId: ENEMY, base: 5, bonusIncome: 10, estimate: 15, source: 'visible' });
  });

  it('sizes the hold of a held bonus for that income, not for a small stack', () => {
    const p = planTurn({ graph: g, board: s, me: ME, income: 8, settings: STD });
    expect(p.enemyDeploy).toBe(15);
    // Threat: 1 movable + 15 deployed = 16, and 16 take 10. Eleven on T1 need 18.
    expect(armiesToTake(10, STD)).toBe(16);
    expect(armiesToTake(11, STD)).toBe(18);
    const onBorder = p.deploys.filter((d) => d.territoryId === 1).reduce((sum, d) => sum + d.armies, 0);
    expect(5 + onBorder).toBeGreaterThanOrEqual(11);
    expect(p.conceded).toEqual([]);
    expect(p.warnings.join('\n')).not.toMatch(/at most \d+% of its largest stack/);
  });

  it('reads the standing from that income: 8 against 15 is behind, not ahead', () => {
    const p = planTurn({
      graph: g,
      board: s,
      me: ME,
      income: 8,
      settings: STD,
      options: { adapt: true },
      game: { turn: 6, fog: 'NoFog', players: [{ id: ME }, { id: ENEMY }] },
    });
    expect(p.profile.format).toBe('1v1');
    expect(p.profile.standing).toBe('behind');
  });
});

describe('an elimination is sized for the income the opponent visibly holds', () => {
  //   2 ─ 3      The opponent holds {2,3} (+3): it earns 8 and can put all 8 on either.
  //    ╲ ╱       I hold 1 (30 armies) and 4; a third player sits apart on 5-6.
  // 4 ─ 1    5 ─ 6
  const g = buildGraph(
    makeMap(
      [[1, 2], [1, 3], [2, 3], [1, 4], [5, 6]],
      [[201, 3, [2, 3]], [202, 2, [1, 4]]],
    ),
  );
  const s = board([mine(1, 30), mine(4, 1), enemy(2, 2), enemy(3, 2), enemy(5, 5, OTHER), enemy(6, 5, OTHER)]);

  it('each attack covers the defenders plus its whole visible income', () => {
    const p = planTurn({ graph: g, board: s, me: ME, income: 7, settings: STD });
    const [e] = enemyDeployEstimates(g, s, ME, STD).filter((x) => x.playerId === ENEMY);
    expect(e!.estimate).toBe(8);
    const onEnemy = p.moves.filter((m) => m.kind === 'attack' && (m.to === 2 || m.to === 3));
    expect(onEnemy.map((m) => m.to).sort()).toEqual([2, 3]);
    // 2 defenders + 8 deployed = 10, which 16 take; the old estimate of 5 sent 11.
    for (const m of onEnemy) expect(m.armies).toBeGreaterThanOrEqual(armiesToTake(2 + 8, STD)!);
  });
});

describe('a higher estimate does not concede held bonuses (#118 with #119)', () => {
  // Three +4 bonuses of mine, {a, b} each: a 1-army interior and a 2-army border facing a
  // 6-stack of the opponent, which visibly holds a +25 bonus behind (it earns 30). Income 17.
  //   61 ─ 62 ─ 71        interiors 61, 63, 65 in a row; borders 62, 64, 66
  //   |               ╲
  //   63 ─ 64 ─ 72 ─ 74 ─ 75
  //   |               ╱
  //   65 ─ 66 ─ 73
  const g = buildGraph(
    makeMap(
      [[61, 62], [62, 71], [63, 64], [64, 72], [65, 66], [66, 73], [71, 74], [72, 74], [73, 74], [74, 75], [61, 63], [63, 65]],
      [[611, 4, [61, 62]], [612, 4, [63, 64]], [613, 4, [65, 66]], [614, 25, [71, 72, 73, 74, 75]]],
    ),
  );
  const s = board([
    mine(61, 1), mine(62, 2), mine(63, 1), mine(64, 2), mine(65, 1), mine(66, 2),
    enemy(71, 6), enemy(72, 6), enemy(73, 6), enemy(74, 1), enemy(75, 1),
  ]);

  it('estimates 30 and keeps every border manned rather than conceding one', () => {
    const [e] = enemyDeployEstimates(g, s, ME, STD);
    expect(e!.estimate).toBe(30);
    const p = planTurn({
      graph: g,
      board: s,
      me: ME,
      income: 17,
      settings: STD,
      options: { adapt: true },
      game: { turn: 9, players: [{ id: ME }, { id: ENEMY }] },
    });
    expect(p.conceded).toEqual([]);
    const after = new Map(s.territories.map((t) => [t.territoryId, t.armies!]));
    for (const d of p.deploys) after.set(d.territoryId, after.get(d.territoryId)! + d.armies);
    for (const m of p.moves) after.set(m.from, after.get(m.from)! - m.armies);
    // None of the three borders falls to the 5 movable next to it alone.
    for (const b of [62, 64, 66]) expect(armiesToTake(after.get(b)!, STD)!).toBeGreaterThan(5);
  });
});
