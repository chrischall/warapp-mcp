// #276: with One Army Must Stand Guard off, three things the planner does that it never does with
// the guard on — (1) a second line: interior members of a held bonus within two moves of a big enemy
// stack keep a garrison one army cannot take; (2) a raid one step deeper: an empty territory beside
// me is taken with two armies when the enemy territory behind it stands at 0 and breaks its owner's
// bonus; (3) a free retake: a territory taken from me that its stack left at 0 is taken back with one.
// Synthetic maps and made-up ids only.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { garrisonSize, SECOND_LINE_STACK_INCOMES } from '../../src/analysis/plan/guard-off.js';
import { validateTurn } from '../../src/tools/turn.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import type { GameMap } from '../../src/normalize.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const enemy = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: ENEMY }, armies });
const settings = (guard: boolean, extra: Partial<PlannerSettings> = {}): PlannerSettings => ({
  offensiveKillRate: 60,
  defensiveKillRate: 70,
  oneArmyStandsGuard: guard,
  ...extra,
});
const mapOf = (edges: [number, number][], bonuses: GameMap['bonuses']): GameMap => {
  const ids = [...new Set(edges.flat())].sort((a, b) => a - b);
  return {
    id: 1,
    name: 'Guard',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses,
    distributionModes: [],
  };
};
const plan = (map: GameMap, b: BoardState, s: PlannerSettings, income: number, previousBoard?: BoardState): TurnPlan =>
  planTurn({
    graph: buildGraph(map),
    board: b,
    me: ME,
    income,
    settings: s,
    game: { players: [{ id: ME }, { id: ENEMY }], turn: 9 },
    options: { goal: 'balanced', enemyDeploy: 5 },
    ...(previousBoard ? { previousBoard } : {}),
  });
const out = (p: TurnPlan, id: number) => p.moves.filter((m) => m.from === id).reduce((n, m) => n + m.armies, 0);
const into = (p: TurnPlan, id: number) => p.moves.filter((m) => m.to === id && m.kind === 'transfer').reduce((n, m) => n + m.armies, 0);
const dep = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
const ends = (p: TurnPlan, b: BoardState, id: number) =>
  (b.territories.find((t) => t.territoryId === id)?.armies ?? 0) + dep(p, id) + into(p, id) - out(p, id);
/** warapp_submit_turn's validator accepts the plan (it throws on a refusal). */
const valid = (map: GameMap, b: BoardState, s: PlannerSettings, income: number, p: TurnPlan) => {
  const ref = (id: number) => ({ id, name: `T${id}` });
  validateTurn({
    map,
    board: b.territories.map(
      (t): LiveTerritory => ({
        territoryId: t.territoryId,
        fogLevel: 1,
        fogged: false,
        owner: t.owner.kind === 'player' ? t.owner.playerId : OWNER_NEUTRAL,
        armies: t.armies,
      }),
    ),
    myInGameId: ME,
    income,
    guard: s.oneArmyStandsGuard ?? true,
    ...(s.noSplit ? { noSplit: true } : {}),
    deploys: p.deploys.map((d) => ({ territory: ref(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: ref(m.from), to: ref(m.to), armies: m.armies })),
  });
};

describe('the garrison one army cannot take (#276)', () => {
  it('is one army at the default kill rates (one attacker and one defender both die; the defender keeps it)', () => {
    expect(garrisonSize({ offensiveKillRate: 60, defensiveKillRate: 70 })).toBe(1);
  });
  it('is two when one army kills one and the defender kills none', () => {
    expect(garrisonSize({ offensiveKillRate: 100, defensiveKillRate: 0 })).toBe(2);
  });
  it('the big-stack bar is my income', () => {
    expect(SECOND_LINE_STACK_INCOMES).toBe(1);
  });
});

// (1) A second line.
//
//   T6 (enemy 50) ─ T5 (enemy stack) ─ T4 (mine 40, the front) ─ T1 (+5 bonus member, 0) ─ T3 (bonus, interior, 6)
//                          └──────────────── T2 (+5 bonus member, 6) ─┘
//
// T1 and T2 are interior (every neighbour mine) members of the held +5 bonus {1, 2, 3}, two moves
// from T5; T3 is three moves away. Rule 6 sends their idle armies to the front at T4.
const LINE = mapOf(
  [
    [5, 4],
    [4, 1],
    [4, 2],
    [1, 3],
    [2, 3],
    [5, 6],
  ],
  [{ id: 101, name: 'B101', value: 5, territoryIds: [1, 2, 3], bonusIds: [] }],
);
const lineBoard = (stack: number) => board([mine(1, 0), mine(2, 6), mine(3, 6), mine(4, 40), enemy(5, stack), enemy(6, 50)]);
const lineBoardOn = (stack: number) => board([mine(1, 1), mine(2, 6), mine(3, 6), mine(4, 40), enemy(5, stack), enemy(6, 50)]);

describe('guard off (1): a second line inside a held bonus near a big stack (#276)', () => {
  it('keeps one army on each interior member within two moves of a stack of at least my income, and deploys one where it is empty', () => {
    const b = lineBoard(20);
    const p = plan(LINE, b, settings(false), 8);
    valid(LINE, b, settings(false), 8, p);
    expect(dep(p, 1)).toBe(1);
    expect(ends(p, b, 1)).toBeGreaterThanOrEqual(1);
    // T2's idle armies still go to the front, all but its garrison (T3's, moving in, cannot move twice).
    expect(out(p, 2)).toBe(5);
    expect(ends(p, b, 2)).toBeGreaterThanOrEqual(1);
    // T3 is three moves away: its armies may still go.
    const text = p.rationale.join('\n');
    expect(text).toContain('Second line (#276)');
    expect(text).toContain('T1 (#1)');
    expect(text).toContain('T2 (#2)');
    expect(text).not.toMatch(/Second line \(#276\)[^\n]*T3 \(#3\)/);
  });

  it('keeps none with a stack below my income', () => {
    const b = lineBoard(6);
    const p = plan(LINE, b, settings(false), 8);
    expect(p.rationale.join('\n')).not.toContain('Second line (#276)');
  });

  it('never fires with the guard on (every territory keeps an army anyway)', () => {
    const b = lineBoardOn(20);
    const p = plan(LINE, b, settings(true), 8);
    expect(p.rationale.join('\n')).not.toContain('Second line (#276)');
    expect(dep(p, 1)).toBe(0);
  });

  it('never fires under No-Split (an order sends the whole stack)', () => {
    const b = lineBoard(20);
    const p = plan(LINE, b, settings(false, { noSplit: true }), 8);
    expect(p.rationale.join('\n')).not.toContain('Second line (#276)');
  });
});

// (2) A raid one step deeper, and (3) a free retake.
//
//   T1 (mine 30) ─ T2 (enemy 0) ─ T3 (enemy 0; enemy's +4 bonus {3, 4}) ─ T4 (enemy 3)
//        └─ T5 (enemy 0, mine last turn) ─ T6 (enemy 12, the stack that took it and moved on)
const RAID = mapOf(
  [
    [1, 2],
    [2, 3],
    [3, 4],
    [1, 5],
    [5, 6],
  ],
  [
    { id: 102, name: 'B102', value: 4, territoryIds: [3, 4], bonusIds: [] },
    { id: 103, name: 'B103', value: 0, territoryIds: [2], bonusIds: [] },
  ],
);
const raidBoard = board([mine(1, 30), enemy(2, 0), enemy(3, 0), enemy(4, 3), enemy(5, 0), enemy(6, 12)]);
const raidBoardOn = board([mine(1, 30), enemy(2, 1), enemy(3, 1), enemy(4, 3), enemy(5, 1), enemy(6, 12)]);
const before = board([mine(1, 30), enemy(2, 2), enemy(3, 2), enemy(4, 3), mine(5, 2), enemy(6, 14)]);

describe('guard off (2): a raid one step deeper (#276)', () => {
  it('takes the empty territory beside me with two armies when the empty one behind it breaks a bonus', () => {
    const p = plan(RAID, raidBoard, settings(false), 5);
    valid(RAID, raidBoard, settings(false), 5, p);
    const raid = p.moves.find((m) => m.to === 2 && m.kind === 'attack');
    expect(raid).toMatchObject({ from: 1 });
    // Two at least: the margins on attacks on a player (#226) may add the armies idle on T1.
    expect(raid!.armies).toBeGreaterThanOrEqual(2);
    expect(raid!.reason).toContain('raid');
    expect(raid!.reason).toContain('T3 (#3)');
    expect(p.rationale.join('\n')).toContain('Raid T2 (#2) from T1 (#1) with ');
  });

  it('is no raid with the guard on', () => {
    const p = plan(RAID, raidBoardOn, settings(true), 5);
    expect(p.moves.find((m) => m.to === 2 && m.reason.includes('raid'))).toBeUndefined();
    expect(p.rationale.join('\n')).not.toContain('Raid T2');
  });

  it('is no raid when the territory behind breaks no bonus', () => {
    const b = board([mine(1, 30), enemy(2, 0), enemy(3, 0), neutral(4, 3), enemy(5, 0), enemy(6, 12)]);
    const p = plan(RAID, b, settings(false), 5);
    expect(p.rationale.join('\n')).not.toContain('Raid T2');
  });
});

describe('guard off (3): a free retake (#276)', () => {
  it('takes back with one army a territory taken from me that its stack left at 0', () => {
    const p = plan(RAID, raidBoard, settings(false), 5, before);
    valid(RAID, raidBoard, settings(false), 5, p);
    const retake = p.moves.find((m) => m.to === 5 && m.kind === 'attack');
    expect(retake).toMatchObject({ from: 1 });
    expect(retake!.reason).toContain('taken from me');
    expect(p.rationale.join('\n')).toContain('Retake T5 (#5) from T1 (#1) with ');
  });

  it('needs the previous board to know it was mine', () => {
    const p = plan(RAID, raidBoard, settings(false), 5);
    expect(p.rationale.join('\n')).not.toContain('Retake T5');
  });

  it('is no retake with the guard on', () => {
    const prevOn = board([mine(1, 30), enemy(2, 2), enemy(3, 2), enemy(4, 3), mine(5, 2), enemy(6, 14)]);
    const p = plan(RAID, raidBoardOn, settings(true), 5, prevOn);
    expect(p.rationale.join('\n')).not.toContain('Retake T5');
  });
});

// #276 (owner's evidence on the issue): the one raid tried in a lost guard-off game failed because
// the owner had reinforced the territory first. A raid or retake on a player's territory is sized
// for that owner's deploy there (#120), from spare armies or a deploy; only when neither covers it
// does it go at its bare size, with #120's "assumes its owner does not reinforce" warning.
//
//   T1 (mine; my +3 bonus {1}) ─ T2 (enemy 0) ─ T3 (enemy 0; enemy's +4 bonus {3, 4}) ─ T4 (enemy 3)
const RAID_LINE = mapOf(
  [
    [1, 2],
    [2, 3],
    [3, 4],
  ],
  [
    { id: 102, name: 'B102', value: 4, territoryIds: [3, 4], bonusIds: [] },
    { id: 103, name: 'B103', value: 0, territoryIds: [2], bonusIds: [] },
    { id: 101, name: 'B101', value: 3, territoryIds: [1], bonusIds: [] },
  ],
);
const RATES = { offensiveKillRate: 60, defensiveKillRate: 70 };
/** The armies that take a territory at 0 even if its owner deploys its 5 there first. */
const SURE = armiesToTake(5, RATES)!;

describe('guard off: a raid or retake is sized for its owner deploy (#276, #120)', () => {
  it('a retake from a source with armies to spare sends what takes it even if the owner deploys there first', () => {
    const p = plan(RAID, raidBoard, settings(false), 5, before);
    const retake = p.moves.find((m) => m.to === 5 && m.kind === 'attack')!;
    expect(retake.armies).toBeGreaterThanOrEqual(SURE);
    expect(p.rationale.join('\n')).toContain(`Retake T5 (#5) from T1 (#1) with ${SURE}, which take it even if player 20 deploys its ~5 there first:`);
    expect(p.warnings.some((w) => w.startsWith('Attack on enemy T5 (#5) assumes'))).toBe(false);
  });

  it('a raid keeps one army over that size to go on next turn', () => {
    const p = plan(RAID, raidBoard, settings(false), 5);
    expect(p.rationale.join('\n')).toContain(`Raid T2 (#2) from T1 (#1) with ${SURE + 1}, which take it even if player 20 deploys its ~5 there first:`);
  });

  it('a raid from a source with nothing to spare deploys the sure size when the income covers it', () => {
    const b = board([mine(1, 1), enemy(2, 0), enemy(3, 0), enemy(4, 3)]);
    const p = plan(RAID_LINE, b, settings(false), 30);
    valid(RAID_LINE, b, settings(false), 30, p);
    const raid = p.moves.find((m) => m.to === 2 && m.kind === 'attack')!;
    expect(raid.reason).toContain('raid');
    expect(raid.armies).toBeGreaterThanOrEqual(SURE + 1);
    expect(p.rationale.join('\n')).toMatch(new RegExp(`Raid T2 \\(#2\\) from T1 \\(#1\\) with ${SURE + 1} \\(deploy \\d+ there\\)`));
    expect(p.warnings.some((w) => w.startsWith('Attack on enemy T2 (#2) assumes'))).toBe(false);
  });

  it('goes at its bare size with the #120 warning when nothing covers the owner deploy', () => {
    const b = board([mine(1, 1), enemy(2, 0), enemy(3, 0), enemy(4, 3)]);
    const p = plan(RAID_LINE, b, settings(false), 2);
    valid(RAID_LINE, b, settings(false), 2, p);
    const raid = p.moves.find((m) => m.to === 2 && m.kind === 'attack' && m.reason.includes('raid'));
    expect(raid?.armies).toBe(2);
    expect(p.warnings.find((w) => w.startsWith('Attack on enemy T2 (#2) assumes its owner does not reinforce it first'))).toContain(
      'if player 20 deploys its ~5 there',
    );
  });
});

