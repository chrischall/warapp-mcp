import { describe, expect, it } from 'vitest';
import type { BoardSpecialUnit, TerritoryState } from '../../src/board.js';
import { armiesToTake, COMMANDER_STRENGTH, specialUnitStrength } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { captureCost, planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { boardStateFromLive, OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap, Player } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, mine, neutral, sizedBeforeMargin } from './helpers.js';

const ME = 10;
const ENEMY = 20;
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

const enemy = (territoryId: number, armies: number, playerId = ENEMY): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const commander = (playerId: number): BoardSpecialUnit => ({
  kind: 'commander',
  id: `${playerId}`.padStart(32, '0'),
  playerId,
});
/** `t` with a commander of `playerId` standing on it. */
const withCommander = (t: TerritoryState, playerId: number): TerritoryState => ({
  ...t,
  specialUnits: [commander(playerId)],
});
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const deployedTo = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
const takenWarning = (p: TurnPlan, id: number) => p.warnings.some((w) => w.startsWith(`T${id} (#${id}) (`) && w.includes('could be taken next turn'));

describe('commander combat value (from the client bundle)', () => {
  it('a commander fights as 7 armies; bosses and custom units are not counted', () => {
    expect(COMMANDER_STRENGTH).toBe(7);
    expect(specialUnitStrength(undefined)).toBe(0);
    expect(specialUnitStrength([commander(ME)])).toBe(7);
    const boss: BoardSpecialUnit = { kind: 'boss', id: 'x'.repeat(32), playerId: 0 };
    expect(specialUnitStrength([commander(ME), boss])).toBe(7);
  });
});

describe('planner: commanders (#61)', () => {
  // T1 (mine) ─ T2 (enemy) ; T1 ─ T3 (mine) ─ T4 (neutral)
  const g = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [1, 3], [3, 4]]));

  it('never concedes my commander\'s border; holds it when the budget allows', () => {
    // Threat on T1: 19 movable + ~5 deploy = 24. Counting the commander (3 + 7), 5 deploys make
    // it hold (15 defenders need 25). Without the commander it would need 12, more than the
    // income, and T1 protects +0, so it was conceded economically.
    const plan = planTurn({
      graph: g,
      board: board([withCommander(mine(1, 3), ME), enemy(2, 20), mine(3, 5), neutral(4, 2)], true),
      me: ME,
      income: 10,
      settings: STD,
    });
    expect(plan.conceded).not.toContain(1);
    expect(armiesToTake(3 + 5 + COMMANDER_STRENGTH)).toBeGreaterThan(24);
    expect(plan.rationale).toContain(
      'Deploy 5 to T1 (#1): my commander stands there, so it must hold (losing the commander eliminates me): 8 armies and my commander need 25 to take, above the ~24 threat.',
    );
    // (The leftover may top it up further: it is the held border with the most at stake.)
    expect(deployedTo(plan, 1)).toBeGreaterThanOrEqual(5);
    expect(plan.moves.filter((m) => m.from === 1)).toEqual([]);
  });

  it('the issue-like case: an unaffordable commander border is still not conceded, gets every army and warns', () => {
    // A thin commander border (15 armies + my commander) facing a huge stack; the hold needs far more than the income.
    for (const goal of ['balanced', 'defend', 'expand', 'complete-bonus'] as const) {
      const plan = planTurn({
        graph: g,
        board: board([withCommander(mine(1, 15), ME), enemy(2, 120), mine(3, 5), neutral(4, 2)], true),
        me: ME,
        income: 5,
        settings: STD,
        options: { goal },
      });
      expect(plan.conceded, goal).not.toContain(1);
      expect(plan.warnings.some((w) => w.includes('cannot be held') && w.includes('T1 (#1)') && w.endsWith(': conceded')), goal).toBe(false);
      expect(plan.warnings.some((w) => w.includes('commander') && w.includes('T1 (#1)') && w.includes('cannot')), goal).toBe(true);
      expect(deployedTo(plan, 1), goal).toBe(5);
      // Nothing leaves it: no withdrawal, no attack, no transfer.
      expect(plan.moves.filter((m) => m.from === 1), goal).toEqual([]);
    }
  });

  it('attacks an adjacent 0-army enemy commander first, sized for its defence plus its owner\'s full deploy', () => {
    // T2: 0 armies + the enemy commander; its owner deploys ~5. Defence 0 + 7 + 5 = 12 → 20 attackers.
    // T3 holds a cheap neutral next door (a 1-army capture), which would otherwise go first.
    const g2 = buildGraph(makeMap([1, 2, 3, 5], [[1, 2], [1, 3], [2, 5]], [[201, 3, [3]]]));
    const plan = planTurn({
      graph: g2,
      board: board([mine(1, 16), withCommander(enemy(2, 0), ENEMY), neutral(3, 1), enemy(5, 3)], true),
      me: ME,
      income: 5,
      settings: STD,
    });
    const cost = captureCost(0 + COMMANDER_STRENGTH + 5, STD)!;
    expect(cost).toBe(20);
    const first = attacks(plan)[0]!;
    expect(first).toMatchObject({ from: 1, to: 2, armies: cost });
    expect(first.reason).toContain('commander');
    expect(plan.expected.captures).toContain(2);
    expect(plan.rationale.some((r) => r.includes('commander') && r.includes('eliminat'))).toBe(true);
    // Sized for the worst case: no "assumes its owner does not reinforce" warning.
    expect(plan.warnings.some((w) => w.includes('assumes its owner does not reinforce'))).toBe(false);
  });

  it('strikes from a thin border triage would concede: the kill removes its only threat', () => {
    // T1 (2 armies) is next to the enemy commander on T2 (0 armies), which T6 (30) backs.
    // Holding T1 against T2 would not pay, but the strike (20) fits: 1 movable + 19 deploys.
    const g4 = buildGraph(makeMap([1, 2, 3, 4, 5, 6], [[1, 2], [2, 6], [1, 3], [3, 4], [3, 5]]));
    for (const goal of ['balanced', 'defend', 'expand'] as const) {
      const plan = planTurn({
        graph: g4,
        board: board([mine(1, 2), withCommander(enemy(2, 0), ENEMY), mine(3, 2), neutral(4, 2), neutral(5, 2), enemy(6, 30)], true),
        me: ME,
        income: 20,
        settings: STD,
        options: { goal },
      });
      const cost = captureCost(0 + COMMANDER_STRENGTH + 5, STD)!;
      expect(attacks(plan)[0], goal).toMatchObject({ from: 1, to: 2, armies: cost });
      expect(plan.conceded, goal).not.toContain(1);
      expect(plan.warnings.some((w) => w.includes('T1 (#1)') && w.endsWith(': conceded')), goal).toBe(false);
      expect(plan.warnings.some((w) => w.includes('more than my territories next to it can send')), goal).toBe(false);
      expect(plan.moves.some((m) => m.from === 1 && m.kind === 'transfer'), goal).toBe(false);
    }
  });

  it('strikes an enemy commander before pressuring another player', () => {
    // T1 (10, unthreatened) is next to the enemy commander on T2 (0 armies); T3 (2) faces
    // player 30's two 2-army territories, which finishing off would press with the income.
    const g5 = buildGraph(makeMap([1, 2, 3, 4, 5, 6], [[1, 2], [2, 6], [1, 3], [3, 4], [3, 5]]));
    for (const goal of ['balanced', 'defend', 'expand'] as const) {
      const plan = planTurn({
        graph: g5,
        board: board([mine(1, 10), withCommander(enemy(2, 0), ENEMY), mine(3, 2), enemy(4, 2, 30), enemy(5, 2, 30), enemy(6, 30)], true),
        me: ME,
        income: 15,
        settings: STD,
        options: { goal },
      });
      const cost = captureCost(0 + COMMANDER_STRENGTH + 5, STD)!;
      expect(attacks(plan)[0], goal).toMatchObject({ from: 1, to: 2, armies: cost });
      expect(plan.warnings.some((w) => w.includes('more than my territories next to it can send')), goal).toBe(false);
    }
  });

  it('strikes first when the kill removes the threat that makes my commander\'s territory unholdable', () => {
    // My commander on T1 (3 armies) faces only T2: 20 armies and the enemy commander, a ~31
    // threat that 10 income cannot hold against (it needs 17). T5 (50) is next to T2 too:
    // killing T2's commander (53 attackers) takes T5's 49 movable + 4 deploys, and removes
    // the only threat to T1, so the income goes into the strike instead of the doomed hold.
    // (Under balanced and defend, finishing player 20 off already does it; expand has no finish-off.)
    const g6 = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [5, 2], [1, 3], [3, 4]]));
    const cost = captureCost(20 + COMMANDER_STRENGTH + 5, STD)!;
    expect(cost).toBeGreaterThan(49);
    for (const goal of ['balanced', 'defend', 'expand', 'complete-bonus'] as const) {
      const plan = planTurn({
        graph: g6,
        board: board([withCommander(mine(1, 3), ME), withCommander(enemy(2, 20), ENEMY), mine(3, 2), neutral(4, 2), mine(5, 50)], true),
        me: ME,
        income: 10,
        settings: STD,
        options: { enemyDeploy: 5, goal },
      });
      expect(attacks(plan)[0], goal).toMatchObject({ from: 5, to: 2, armies: cost });
      expect(plan.warnings.some((w) => w.includes('cannot be made safe')), goal).toBe(false);
      expect(plan.moves.filter((m) => m.from === 1), goal).toEqual([]);
    }
  });

  it('does not treat the struck player as gone: its other stack still threatens my commander this turn', () => {
    // My commander on T1 (16) faces T2 (0 armies + player 20's commander) and T5 (player 20, 90).
    // war.app interleaves both players' attacks, so killing T2's commander does not stop T5's
    // attack this turn: T1 still faces ~94, every army of the 10 income is reserved for it and
    // nothing leaves it, so the strike (20) cannot be sent; the warning says why.
    const g8 = buildGraph(makeMap([1, 2, 3, 4, 5, 6], [[1, 2], [1, 5], [1, 3], [3, 4], [2, 6]]));
    for (const goal of ['balanced', 'defend', 'expand', 'complete-bonus'] as const) {
      const plan = planTurn({
        graph: g8,
        board: board([withCommander(mine(1, 16), ME), withCommander(enemy(2, 0), ENEMY), mine(3, 2), neutral(4, 2), enemy(5, 90), neutral(6, 2)], true),
        me: ME,
        income: 10,
        settings: STD,
        options: { goal },
      });
      expect(attacks(plan).some((m) => m.to === 2), goal).toBe(false);
      expect(deployedTo(plan, 1), goal).toBe(10);
      expect(plan.moves.filter((m) => m.from === 1), goal).toEqual([]);
      expect(plan.conceded, goal).not.toContain(1);
      expect(plan.warnings.some((w) => w.includes('cannot be made safe')), goal).toBe(true);
      const w = plan.warnings.find((x) => x.includes('more than my territories next to it can send'));
      expect(w, goal).toContain("10 of the income is held back for my commander's territory");
      expect(w, goal).toContain('T1 (#1) keeps 15 to hold my commander');
    }
  });

  it('a source that cannot hold anyway sends its armies into the strike instead of keeping them all', () => {
    // T1 (30) is next to player 20's commander on T2 (0 armies) and player 30's 200 on T5: it
    // cannot hold whatever it keeps. Its 29 movable armies kill the commander (20) alone.
    const g9 = buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7], [[1, 2], [1, 5], [1, 3], [3, 4], [2, 6], [6, 7]]));
    const cost = captureCost(0 + COMMANDER_STRENGTH + 5, STD)!;
    const boards = {
      'player 20 holds more': [mine(1, 30), withCommander(enemy(2, 0), ENEMY), mine(3, 2), neutral(4, 2), enemy(5, 200, 30), enemy(6, 50), enemy(7, 50)],
      'player 20 holds only T2': [mine(1, 30), withCommander(enemy(2, 0), ENEMY), mine(3, 2), neutral(4, 2), enemy(5, 200, 30), neutral(6, 50), neutral(7, 50)],
    };
    for (const [name, b] of Object.entries(boards))
      for (const goal of ['balanced', 'defend', 'expand'] as const) {
        const plan = planTurn({ graph: g9, board: board(b, true), me: ME, income: 5, settings: STD, options: { goal } });
        const why = `${name}, ${goal}`;
        const strike = attacks(plan).find((m) => m.to === 2);
        expect(strike, why).toMatchObject({ from: 1 });
        expect(strike!.armies, why).toBeGreaterThanOrEqual(cost);
        expect(strike!.reason, why).toContain('commander');
        expect(plan.warnings.some((w) => w.includes('more than my territories next to it can send')), why).toBe(false);
      }
  });

  it('says what limits a strike it cannot make: a source\'s own keep', () => {
    // T1 (25) faces player 30's T5 (15): ~19, so it keeps 11 to hold. 13 movable + 2 deploys
    // fall short of the 20 the strike needs; without the keep, 24 + 2 would do.
    const g10 = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [1, 5], [1, 3], [3, 4]]));
    const plan = planTurn({
      graph: g10,
      board: board([mine(1, 25), withCommander(enemy(2, 0), ENEMY), mine(3, 2), neutral(4, 2), enemy(5, 15, 30)], true),
      me: ME,
      income: 2,
      settings: STD,
      options: { goal: 'expand' },
    });
    expect(attacks(plan).some((m) => m.to === 2)).toBe(false);
    const w = plan.warnings.find((x) => x.includes('more than my territories next to it can send'))!;
    expect(w).toBeDefined();
    expect(w).toContain('T1 (#1) keeps 11 to hold its other borders');
    expect(w).not.toContain('held back for my commander');
    expect(w).not.toContain('unaffordable');
  });

  it('a held bonus is not judged on my commander\'s hold, which rule 1k already paid', () => {
    // Bonus {T1, T3} (+2) is mine. My commander's T1 (3 armies) faces T2 (40): its hold (17)
    // is deployed first, whatever it costs. T3 (5) faces T4 (8) and needs 3, which the bonus
    // pays for; counting T1's 17 too (20 > 3 × its worth of ~2.8) would concede the bonus,
    // and T3 with it.
    const g7 = buildGraph(makeMap([1, 2, 3, 4, 6], [[1, 2], [1, 3], [3, 4], [4, 6]], [[501, 2, [1, 3]]]));
    const plan = planTurn({
      graph: g7,
      board: board([withCommander(mine(1, 3), ME), enemy(2, 40), mine(3, 5), enemy(4, 8, 30), enemy(6, 8, 30)], true),
      me: ME,
      income: 50,
      settings: STD,
      options: { goal: 'defend', enemyDeploy: 5 },
    });
    expect(plan.conceded).not.toContain(1);
    expect(plan.conceded).not.toContain(3);
    expect(deployedTo(plan, 1)).toBeGreaterThanOrEqual(17);
    expect(deployedTo(plan, 3)).toBeGreaterThanOrEqual(3);
    expect(plan.rationale.some((r) => r.includes('Hold bonus B501') && r.includes('need 3 in all'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('conceding bonus') || (w.includes('T3 (#3)') && w.endsWith(': conceded')))).toBe(false);
  });

  it('warns when an enemy commander in reach cannot be killed this turn', () => {
    const plan = planTurn({
      graph: g,
      board: board([mine(1, 5), withCommander(enemy(2, 10), ENEMY), mine(3, 5), neutral(4, 2)], true),
      me: ME,
      income: 5,
      settings: STD,
    });
    expect(attacks(plan).some((m) => m.to === 2)).toBe(false);
    expect(plan.warnings.some((w) => w.includes('commander') && w.includes('T2 (#2)'))).toBe(true);
    // 10 armies + 7 + ~5 deploy need 36; T1's 4 movable and 5 deploys are all it has: unaffordable,
    // and nothing else (no keep, no reserve) is blamed.
    const w = plan.warnings.find((x) => x.includes('more than my territories next to it can send'))!;
    expect(w).toContain('unaffordable: at most 9 attackers from any one territory');
    expect(w).not.toContain('keeps');
    expect(w).not.toContain('held back');
  });

  it('counts an enemy commander in the threat to my border', () => {
    // T1 has 8 (13 to take). T2: 6 armies (5 movable) + ~5 deploy = 10 — no threat without the
    // commander; with it, 17 ≥ 13.
    const b = [mine(1, 8), withCommander(enemy(2, 6), ENEMY), mine(3, 5), neutral(4, 2)];
    const plan = planTurn({ graph: g, board: board(b, true), me: ME, income: 5, settings: STD });
    expect(takenWarning(plan, 1)).toBe(true);
    const without = planTurn({ graph: g, board: board([mine(1, 8), enemy(2, 6), mine(3, 5), neutral(4, 2)], true), me: ME, income: 5, settings: STD });
    expect(takenWarning(without, 1)).toBe(false);
  });

  it('counts my commander in my border\'s defence', () => {
    // T1 has 3 (5 to take) but with the commander defends as 10 (16 to take), above the ~14 threat.
    const plan = planTurn({
      graph: g,
      board: board([withCommander(mine(1, 3), ME), enemy(2, 10), mine(3, 5), neutral(4, 2)], true),
      me: ME,
      income: 5,
      settings: STD,
    });
    expect(takenWarning(plan, 1)).toBe(false);
    expect(plan.conceded).not.toContain(1);
  });

  it('counts an enemy commander in a capture\'s cost', () => {
    // Under complete-bonus an enemy territory is an ordinary target: its commander adds 7 to its defence.
    const g3 = buildGraph(makeMap([1, 2, 3], [[1, 2], [2, 3]], [[301, 3, [1, 2]]]));
    const plan = planTurn({
      graph: g3,
      board: board([mine(1, 40), withCommander(enemy(2, 2, 30), 30), enemy(3, 1, 30)], true),
      me: ME,
      income: 5,
      settings: STD,
      options: { goal: 'complete-bonus', enemyDeploy: 0 },
    });
    const at2 = attacks(plan).find((m) => m.to === 2)!;
    expect(at2.armies).toBeGreaterThanOrEqual(captureCost(2 + COMMANDER_STRENGTH, STD)!);
  });
});

describe('planner: commander rules after review (C2b, #61)', () => {
  const noStrikeWarning = (p: TurnPlan) => p.warnings.find((w) => w.includes('more than my territories next to it can send'));

  it('reserves my commander\'s hold against the struck player\'s other stacks before the strike', () => {
    // My commander on T1 (3) faces T2 (0 armies + player 20's commander) and player 20's T5 (20):
    // ~24 without T2, so T1 needs 5 more. T3 (10) could kill the commander (20) with 11 deploys,
    // but only 10 of the 15 income are left once T1's 5 are reserved: no strike, T1 holds.
    const ga = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [1, 5], [1, 3], [3, 2], [3, 4]]));
    for (const goal of ['balanced', 'defend', 'expand'] as const) {
      const plan = planTurn({
        graph: ga,
        board: board([withCommander(mine(1, 3), ME), withCommander(enemy(2, 0), ENEMY), mine(3, 10), neutral(4, 30), enemy(5, 20)], true),
        me: ME,
        income: 15,
        settings: STD,
        options: { goal, enemyDeploy: 5 },
      });
      expect(attacks(plan).some((m) => m.to === 2), goal).toBe(false);
      expect(deployedTo(plan, 1), goal).toBeGreaterThanOrEqual(5);
      expect(plan.warnings.some((w) => w.includes('cannot be made safe')), goal).toBe(false);
      expect(noStrikeWarning(plan), goal).toContain("5 of the income is held back for my commander's territory");
    }
  });

  it('under Local Deployment the reserve is charged to my commander\'s pools, not left in the budget', () => {
    // Bonus B700 {T6, T7} (+4) is held, so 4 of the 8 income may go anywhere and 4 only on T6/T7.
    // My commander on T1 (3) faces player 30's T5 (18 + 3): it needs 3, which only the 4
    // "anywhere" armies can reach, so 3 of them are reserved. T3 (15) could kill the commander
    // on T2 (16) with 2 deploys, but only 1 "anywhere" army is left (the bonus armies cannot
    // reach T3 either), so it is not made and T1 gets what the strike would have spent.
    const gl = buildGraph(makeMap([1, 2, 3, 5, 6, 7, 8], [[1, 5], [1, 3], [3, 2], [6, 7], [3, 6], [2, 8]], [[700, 4, [6, 7]]]));
    const plan = planTurn({
      graph: gl,
      board: board(
        [withCommander(mine(1, 3), ME), withCommander(enemy(2, 0), ENEMY), mine(3, 15), enemy(5, 18, 30), mine(6, 5), mine(7, 5), neutral(8, 2)],
        true,
      ),
      me: ME,
      income: 8,
      settings: { ...STD, localDeployments: true },
      options: { goal: 'defend', enemyDeploy: 3 },
    });
    expect(deployedTo(plan, 1)).toBeGreaterThanOrEqual(3);
    expect(deployedTo(plan, 3)).toBe(0);
    expect(attacks(plan).some((m) => m.to === 2)).toBe(false);
    expect(plan.warnings.some((w) => w.includes('cannot be made safe')), plan.warnings.join('\n')).toBe(false);
    expect(noStrikeWarning(plan)).toContain("3 of the income is held back for my commander's territory");
  });

  it('never warns of an unmade strike without a reason', () => {
    // T3 (0) owes its guard, so its 16 income send 15, one short of the 16 that kill player
    // 20's commander on T2. No keep, reserve, No-Split or unaffordability binds: say what it
    // can send instead.
    const gz = buildGraph(makeMap([2, 3, 4, 8], [[3, 2], [3, 4], [2, 8]]));
    const plan = planTurn({
      graph: gz,
      board: board([withCommander(enemy(2, 0), ENEMY), mine(3, 0), mine(4, 1), neutral(8, 2)], true),
      me: ME,
      income: 16,
      settings: STD,
      options: { goal: 'expand', enemyDeploy: 3 },
    });
    expect(attacks(plan).some((m) => m.to === 2)).toBe(false);
    expect(noStrikeWarning(plan)).toContain('(T3 (#3) can send at most 15)');
    // Under Local Deployment it names T3's pool room: B900 {T4} (+2) keeps 2 of 18 off T3.
    const gzl = buildGraph(makeMap([2, 3, 4, 8], [[3, 2], [3, 4], [2, 8]], [[900, 2, [4]]]));
    const ld = planTurn({
      graph: gzl,
      board: board([withCommander(enemy(2, 0), ENEMY), mine(3, 0), mine(4, 1), neutral(8, 2)], true),
      me: ME,
      income: 18,
      settings: { ...STD, localDeployments: true },
      options: { goal: 'expand', enemyDeploy: 3 },
    });
    expect(attacks(ld).some((m) => m.to === 2)).toBe(false);
    expect(noStrikeWarning(ld)).toContain('(T3 (#3) can send at most 15 (Local Deployment: only 16 may be deployed there))');
  });

  it('a source doomed by the struck player\'s other stack sends everything into the strike', () => {
    // T1 (30) faces player 30's T7 (25: ~29, so it would keep 17) and player 20's T6 (200: ~204,
    // which nothing holds against). Player 20 is not gone this turn, so T1 is lost anyway: its
    // 29 movable armies kill the commander on T2 (20) instead of 12 + 5 deploys falling short.
    const gb = buildGraph(makeMap([1, 2, 3, 4, 6, 7], [[1, 2], [1, 6], [1, 7], [1, 3], [3, 4]]));
    const cost = captureCost(0 + COMMANDER_STRENGTH + 5, STD)!;
    for (const goal of ['balanced', 'defend', 'expand'] as const) {
      const plan = planTurn({
        graph: gb,
        board: board([mine(1, 30), withCommander(enemy(2, 0), ENEMY), mine(3, 2), neutral(4, 2), enemy(6, 200), enemy(7, 25, 30)], true),
        me: ME,
        income: 5,
        settings: STD,
        options: { goal, enemyDeploy: 5 },
      });
      const strike = attacks(plan).find((m) => m.to === 2);
      expect(strike, goal).toMatchObject({ from: 1 });
      expect(strike!.armies, goal).toBeGreaterThanOrEqual(cost);
      expect(noStrikeWarning(plan), goal).toBeUndefined();
    }
  });

  it('strikes into a bonus whose new frontier R3 would call indefensible (balanced and defend)', () => {
    // Taking T2 completes bonus {T2, T3}, and player 20's T6 (100) next to it could retake it
    // next turn: R3 would refuse the capture. Killing the commander eliminates player 20, so it is made.
    const gc = buildGraph(makeMap([1, 2, 3, 6], [[1, 2], [2, 6], [1, 3], [3, 2]], [[601, 2, [2, 3]]]));
    const cost = captureCost(0 + COMMANDER_STRENGTH + 5, STD)!;
    for (const goal of ['balanced', 'defend'] as const) {
      const plan = planTurn({
        graph: gc,
        board: board([mine(1, 40), withCommander(enemy(2, 0), ENEMY), mine(3, 2), enemy(6, 100)], true),
        me: ME,
        income: 10,
        settings: STD,
        options: { goal, enemyDeploy: 5 },
      });
      const strike = attacks(plan).find((m) => m.to === 2);
      expect(strike, goal).toMatchObject({ from: 1 });
      expect(strike!.armies, goal).toBeGreaterThanOrEqual(cost);
      expect(plan.warnings.some((w) => w.includes('indefensible')), goal).toBe(false);
      expect(noStrikeWarning(plan), goal).toBeUndefined();
    }
  });

  describe('Order Priority when a strike is planned and my commander is threatened', () => {
    // My commander on T1 (3) faces T2 (20 + player 20's commander); T5 (50) kills it.
    const gd = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [5, 2], [1, 3], [3, 4]]));
    const b = board([withCommander(mine(1, 3), ME), withCommander(enemy(2, 20), ENEMY), mine(3, 2), neutral(4, 2), mine(5, 50)], true);

    it('does not spend Order Priority for my commander when only a third player threatens it', () => {
      // T2 (1 + player 20's commander) cannot take T1 (3 + my commander); player 30's T6 (60) can.
      // Moving first does not stop player 30, so the card is not advised to protect my commander;
      // #179: it is advised for the strike itself, which eliminates player 20 (its commander
      // could walk away before it lands).
      const g3 = buildGraph(makeMap([1, 2, 3, 4, 5, 6], [[1, 2], [5, 2], [1, 3], [3, 4], [1, 6]]));
      const b3 = board(
        [withCommander(mine(1, 3), ME), withCommander(enemy(2, 1), ENEMY), mine(3, 2), neutral(4, 2), mine(5, 50), enemy(6, 60, 30)],
        true,
      );
      const plan = planTurn({ graph: g3, board: b3, me: ME, income: 10, settings: STD, options: { goal: 'balanced', enemyDeploy: 5, holdsOrderPriority: true } });
      expect(attacks(plan).some((m) => m.to === 2)).toBe(true);
      expect(plan.rationale.some((r) => r.startsWith("Play Order Priority: my commander's territory"))).toBe(false);
      expect(plan.cardAdvice).toBe('order-priority');
      expect(plan.rationale.join('\n')).toMatch(/Play Order Priority: T5 \(#5\) → T2 \(#2\) is the strike on player 20's commander, which eliminates it/);
    });

    it('advises playing my Order Priority card so the strike resolves first, and says so', () => {
      for (const goal of ['balanced', 'defend', 'expand'] as const) {
        const plan = planTurn({ graph: gd, board: b, me: ME, income: 10, settings: STD, options: { goal, enemyDeploy: 5, holdsOrderPriority: true } });
        expect(attacks(plan)[0], goal).toMatchObject({ from: 5, to: 2 });
        expect(plan.cardAdvice, goal).toBe('order-priority');
        expect(plan.rationale.some((r) => r.includes('Order Priority') && r.includes('T1 (#1)')), goal).toBe(true);
      }
    });

    it('when I move first, neither advises nor mentions playing the card for the strike', () => {
      for (const goal of ['balanced', 'defend', 'expand'] as const) {
        const plan = planTurn({
          graph: gd,
          board: b,
          me: ME,
          income: 10,
          settings: STD,
          options: { goal, enemyDeploy: 5, holdsOrderPriority: true, movesFirst: true },
        });
        expect(attacks(plan)[0], goal).toMatchObject({ from: 5, to: 2 });
        expect(plan.cardAdvice, goal).toBeNull();
        expect(plan.rationale.some((r) => r.startsWith('Play Order Priority')), goal).toBe(false);
        expect(plan.rationale.some((r) => r.startsWith('Order Priority is not needed for the strike')), goal).toBe(true);
      }
    });

    it('without the card, warns that the attacks interleave', () => {
      const plan = planTurn({ graph: gd, board: b, me: ME, income: 10, settings: STD, options: { goal: 'expand', enemyDeploy: 5 } });
      expect(attacks(plan)[0]).toMatchObject({ from: 5, to: 2 });
      expect(plan.cardAdvice).toBeNull();
      expect(plan.warnings.some((w) => w.includes('Order Priority') && w.includes('interleave'))).toBe(true);
    });

    describe('my commander\'s territory is the strike source', () => {
      // My commander on T1 (30) next to player 20's commander on T2 (0) and player 20's T5 (40).
      // At turn start T1 defends as 37: T5's ~44 and T2's 7 (51) do not take it. The strike
      // sends 20 from T1, leaving 20 + my commander (45 to take); attacks interleave, so T5's
      // 39 + 5 deploy and T2's commander (it may attack before the strike lands) come to 51.
      const gs = buildGraph(makeMap([1, 2, 3, 4, 5, 6], [[1, 2], [1, 5], [1, 3], [3, 4], [2, 6]]));
      const bs = board(
        [withCommander(mine(1, 30), ME), withCommander(enemy(2, 0), ENEMY), mine(3, 2), neutral(4, 2), enemy(5, 40), neutral(6, 2)],
        true,
      );
      const left = (p: TurnPlan) =>
        30 + deployedTo(p, 1) - p.moves.filter((m) => m.from === 1).reduce((n, m) => n + m.armies, 0);

      it('judges the threat on what stays after the strike: advises Order Priority', () => {
        for (const goal of ['balanced', 'defend', 'expand'] as const) {
          const plan = planTurn({ graph: gs, board: bs, me: ME, income: 12, settings: STD, options: { goal, enemyDeploy: 5, holdsOrderPriority: true } });
          expect(attacks(plan).find((m) => m.to === 2), goal).toMatchObject({ from: 1 });
          // What stays on T1 falls to T5's and T2's stacks together.
          expect(armiesToTake(left(plan) + COMMANDER_STRENGTH, STD)!, goal).toBeLessThanOrEqual(39 + 5 + COMMANDER_STRENGTH);
          expect(plan.cardAdvice, goal).toBe('order-priority');
          expect(plan.rationale.some((r) => r.includes('Play Order Priority') && r.includes('T1 (#1)')), goal).toBe(true);
        }
      });

      it('without the card, warns that the attacks interleave', () => {
        const plan = planTurn({ graph: gs, board: bs, me: ME, income: 12, settings: STD, options: { goal: 'expand', enemyDeploy: 5 } });
        expect(attacks(plan).find((m) => m.to === 2)).toMatchObject({ from: 1 });
        expect(plan.cardAdvice).toBeNull();
        expect(plan.warnings.some((w) => w.includes('Order Priority') && w.includes('interleave'))).toBe(true);
      });
    });

    it('no advice for my commander when it is not threatened: only the eliminating strike\'s (#179)', () => {
      // My commander on T1 (16) defends as 23, far above T2's ~12.
      const g2 = buildGraph(makeMap([1, 2, 3, 5], [[1, 2], [1, 3], [2, 5]]));
      const plan = planTurn({
        graph: g2,
        board: board([withCommander(mine(1, 26), ME), withCommander(enemy(2, 0), ENEMY), neutral(3, 1), enemy(5, 3)], true),
        me: ME,
        income: 5,
        settings: STD,
        options: { goal: 'expand', holdsOrderPriority: true },
      });
      expect(attacks(plan)[0]).toMatchObject({ from: 1, to: 2 });
      expect(plan.warnings.some((w) => w.includes('Order Priority'))).toBe(false);
      expect(plan.rationale.some((r) => r.startsWith("Play Order Priority: my commander's territory"))).toBe(false);
      expect(plan.cardAdvice).toBe('order-priority');
      expect(plan.rationale.join('\n')).toMatch(/Play Order Priority: T1 \(#1\) → T2 \(#2\) is the strike on player 20's commander, which eliminates it/);
    });
  });

  describe('a strike planned, my commander not threatened, and a withdrawal (rule 7 gates the card)', () => {
    // My commander on T1 (26) strikes player 20's commander on T2 (0); T7 (8) faces player 20's
    // T8 (200), is conceded, and withdraws into T1. The strike moves out of T1, so it waits on
    // the withdrawal: the withdrawal is my first order, and only rule 7 decides the card.
    const gw = buildGraph(makeMap([1, 2, 3, 5, 7, 8], [[1, 2], [1, 3], [2, 5], [1, 7], [7, 8]]));
    const bw = board(
      [withCommander(mine(1, 26), ME), withCommander(enemy(2, 0), ENEMY), neutral(3, 1), enemy(5, 3), mine(7, 8), enemy(8, 200)],
      true,
    );
    const plan = (holdsOrderPriority: boolean) =>
      planTurn({ graph: gw, board: bw, me: ME, income: 5, settings: STD, options: { goal: 'balanced', holdsOrderPriority } });

    it('advises no card I do not hold, and calls the withdrawal my first order', () => {
      const p = plan(false);
      expect(attacks(p).some((m) => m.from === 1 && m.to === 2)).toBe(true);
      expect(p.moves[0]).toMatchObject({ from: 7, to: 1, kind: 'transfer' });
      expect(p.cardAdvice).toBeNull();
      expect(p.warnings).toContain(
        'The withdrawal from T7 (#7) only executes if T7 (#7) is still mine when the order runs; it is my first order (Order Priority not advised: I hold no Order Priority card to play).',
      );
      expect(p.warnings.some((w) => w.includes('may come too late'))).toBe(false);
    });

    it('with the card, advises it for the withdrawal it protects', () => {
      const p = plan(true);
      expect(p.moves[0]).toMatchObject({ from: 7, to: 1, kind: 'transfer' });
      expect(p.cardAdvice).toBe('order-priority');
      expect(p.warnings).toContain(
        "The withdrawal from T7 (#7) only executes if T7 (#7) is still mine when the order runs; play Order Priority: it is my first order, and the card runs it before the opponent's first.",
      );
    });
  });

  it('names the reserve only when it, not a source\'s keep, is what stops the strike', () => {
    // My commander on T1 (3) needs 5 against player 30's T5 (~24): reserved first. T3 (25) is
    // next to player 20's commander on T2 (0: 20 to kill) and keeps 11 against player 40's T6
    // (~19). Income 6: without the reserve, 13 + 6 = 19 still falls short, so only the keep
    // is named. Income 8: 13 + 8 = 21 would do but for the 5 reserved, so the reserve is named.
    const gr = buildGraph(makeMap([1, 2, 3, 5, 6, 7], [[1, 5], [1, 3], [3, 2], [3, 6], [2, 7]]));
    const b = board(
      [withCommander(mine(1, 3), ME), withCommander(enemy(2, 0), ENEMY), mine(3, 25), enemy(5, 20, 30), enemy(6, 15, 40), neutral(7, 2)],
      true,
    );
    const at = (income: number) =>
      noStrikeWarning(planTurn({ graph: gr, board: b, me: ME, income, settings: STD, options: { goal: 'expand', enemyDeploy: 5 } }))!;
    expect(at(6)).toContain('T3 (#3) keeps 11 to hold its other borders');
    expect(at(6)).not.toContain('held back for my commander');
    expect(at(8)).toContain("5 of the income is held back for my commander's territory");
  });

  it('names No-Split when the only source already strikes another commander', () => {
    // T1 (60) is next to two enemy commanders, each on 0 armies: under No-Split it kills one.
    const ge = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [1, 5], [1, 3], [3, 4]]));
    const plan = planTurn({
      graph: ge,
      board: board([mine(1, 60), withCommander(enemy(2, 0), ENEMY), mine(3, 2), neutral(4, 2), withCommander(enemy(5, 0, 30), 30)], true),
      me: ME,
      income: 5,
      settings: { ...STD, noSplit: true },
      options: { goal: 'expand', enemyDeploy: 5 },
    });
    expect(attacks(plan).filter((m) => m.from === 1)).toHaveLength(1);
    expect(attacks(plan)[0]).toMatchObject({ from: 1, to: 2 });
    const w = noStrikeWarning(plan)!;
    expect(w).toContain('T5 (#5)');
    expect(w).toContain('No-Split: T1 (#1) already attacks T2 (#2)');
    expect(w).not.toContain('unaffordable');
  });

  it('a held bonus\'s payback test leaves out the stack my commander\'s hold already saves', () => {
    // Bonus {T1, T3} (+2). My commander's T1 (100) needs 4 against T2 (~184), held by rule 1k
    // anyway. T3 (5) needs 8 against T4 (~20): the bonus is worth 2 + 0.5 (T3's stack), so 8 is
    // more than 3 × 2.5 and it fails the factor test. Counting T1's 100 armies (worth 12.5) would
    // pass it. Since #118 the factor test concedes only when the armies have a better use: here
    // nothing else uses them, so it is held after all — but as a unit that failed the test.
    const gf = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [1, 3], [3, 4]], [[501, 2, [1, 3]]]));
    const plan = planTurn({
      graph: gf,
      board: board([withCommander(mine(1, 100), ME), enemy(2, 180), mine(3, 5), enemy(4, 16, 30)], true),
      me: ME,
      // Too little to finish player 30 off (T4 needs 35 from T3), plenty for both holds.
      income: 20,
      settings: STD,
      options: { goal: 'defend', enemyDeploy: 5 },
    });
    expect(plan.conceded).not.toContain(1);
    expect(deployedTo(plan, 1)).toBeGreaterThanOrEqual(4);
    expect(plan.conceded).not.toContain(3);
    expect(plan.rationale.some((r) => /Hold bonus B501 \(#501\) \(\+2\) whole: .*\(more than 3 × its worth\), and nothing else this turn uses those armies/.test(r))).toBe(true);
    expect(plan.rationale.some((r) => r.includes('pays back within'))).toBe(false);
  });
});

describe('planner: commanders through the live board (#61)', () => {
  const ME_IN = 1234;
  const THEM_IN = 5678;
  const player = (id: number, name: string): Player => ({ id, name, isAI: false, humanTurnedIntoAI: false, hasCommittedOrders: false });
  const ME_FEED = 11123499;
  const PLAYERS = [player(ME_FEED, 'Me'), player(22567833, 'Them')];
  const live = (territoryId: number, owner: number, armies: number, cmdr?: number): LiveTerritory => ({
    territoryId,
    fogLevel: 1,
    fogged: false,
    owner,
    armies,
    ...(cmdr !== undefined ? { specialUnits: [{ kind: 'commander' as const, id: `${cmdr}`.padStart(32, '0'), owner: cmdr }] } : {}),
  });
  // T1 (mine, my commander) ─ T2 (theirs, their commander on 0 armies) ─ T5 (theirs); T1 ─ T3 (neutral) ─ T4 (neutral).
  const map = makeMap([1, 2, 3, 4, 5], [[1, 2], [1, 3], [3, 4], [2, 5]], [[401, 2, [3, 4]]]);
  const standing = [
    live(1, ME_IN, 21, ME_IN),
    live(2, THEM_IN, 0, THEM_IN),
    live(3, OWNER_NEUTRAL, 2),
    live(4, OWNER_NEUTRAL, 2),
    live(5, THEM_IN, 4),
  ];

  it('kills the adjacent enemy commander from my commander\'s territory, keeps the commander home, and validates', () => {
    const plan = planTurn({
      graph: buildGraph(map),
      board: boardStateFromLive(standing, PLAYERS[0]!, PLAYERS),
      me: ME_FEED,
      income: 5,
      settings: STD,
    });
    expect(attacks(plan)[0]).toMatchObject({ from: 1, to: 2 });
    // #226: sized for the commander and the owner's deploy; idle armies on T1 then join it as a margin.
    expect(sizedBeforeMargin(plan, 1, 2)).toBe(captureCost(0 + COMMANDER_STRENGTH + 5, STD)!);
    expect(plan.conceded).not.toContain(1);
    expect(plan.rationale).toContain('My commander stays on T1 (#1): planned moves carry armies only, never the commander.');
    const named = (id: number) => ({ id, name: `T${id}` });
    const checked = validateTurn({
      map,
      board: standing,
      myInGameId: ME_IN,
      income: 5,
      guard: true,
      deploys: plan.deploys.map((d) => ({ territory: named(d.territoryId), armies: d.armies })),
      moves: plan.moves.map((m) => ({ from: named(m.from), to: named(m.to), armies: m.armies })),
    });
    expect(checked).toEqual({ warnings: [] });
  });
});
