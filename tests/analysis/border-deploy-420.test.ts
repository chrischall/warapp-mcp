// #420 (owner decision of 2026-11-20, "One opponent's deploy"): an opponent deploys its income in
// one place, so only its single most valuable border of mine is sized against its full deploy. Its
// other borders are sized at the stack beside them plus its largest top-up seen (the most one of
// its stacks beside my land grew in one turn, from the tracker's boards). With no top-up seen,
// every border keeps the full deploy.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { borderTopUp, trackOpponents, type TurnBoard } from '../../src/analysis/opponents.js';
import { planTurn, type PlanInput, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
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
const foe = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: FOE }, armies });

// My +5 bonus B901 {1, 2} with T1 facing the opponent's T4; my plain T3 faces its T5. T6 is the
// opponent's, behind T4 and T5, beside no land of mine. Its +6 bonus B902 {4, 5, 6} is in view.
const g = buildGraph(
  makeMap(
    [1, 2, 3, 4, 5, 6],
    [[1, 2], [2, 3], [1, 4], [3, 5], [4, 6], [5, 6]],
    [[901, 5, [1, 2]], [902, 6, [4, 5, 6]]],
  ),
);
const turn = (t: number, four: number, five: number, six: number, my = 6): TurnBoard => ({
  turn: t,
  board: board([mine(1, my), mine(2, 1), mine(3, my), foe(4, four), foe(5, five), foe(6, six)]),
});

describe('#420: the tracker reads the largest top-up of a stack beside my land', () => {
  it('borderTopUp: the most one of its stacks beside my land grew in a turn, never a stack away from it', () => {
    // T5 grows 4 → 7 (+3) beside my T3; T6 grows 2 → 20 beside no land of mine.
    expect(borderTopUp(g, turn(1, 4, 4, 2).board, turn(2, 4, 7, 20).board, FOE, ME)).toBe(3);
  });

  it('a stack that shrank or stood still reads 0; none beside my land reads undefined', () => {
    expect(borderTopUp(g, turn(1, 4, 4, 2).board, turn(2, 3, 4, 9).board, FOE, ME)).toBe(0);
    const away = board([mine(1, 6), mine(2, 1), mine(3, 6), neutral(4, 2), neutral(5, 2), foe(6, 2)]);
    expect(borderTopUp(g, away, board([mine(1, 6), mine(2, 1), mine(3, 6), neutral(4, 2), neutral(5, 2), foe(6, 9)]), FOE, ME)).toBeUndefined();
  });

  it('the track keeps the largest over its observed turns, and none from a GameFeed history board', () => {
    const [t] = trackOpponents(g, [turn(1, 4, 4, 2), turn(2, 6, 4, 2), turn(3, 6, 5, 2)], ME, STD);
    expect(t!.turns.map((x) => x.topUp)).toEqual([2, 1]);
    expect(t!.topUp).toBe(2);
    const [h] = trackOpponents(g, [{ ...turn(1, 4, 4, 2), source: 'history' }, turn(2, 9, 4, 2), turn(3, 9, 5, 2)], ME, STD);
    expect(h!.topUp).toBe(1);
  });
});

// The opponent earns 3 base + 6 (B902) = 9 visibly; its stacks beside my land grew by 2 at most.
const tracks = trackOpponents(g, [turn(1, 4, 4, 1), turn(2, 6, 4, 1), turn(3, 6, 5, 1)], ME, STD);
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  graph: g,
  board: turn(4, 6, 5, 1).board,
  me: ME,
  income: 12,
  settings: STD,
  turn: 4,
  tracks,
  game: { players: [{ id: ME }, { id: FOE }], turn: 4 },
  ...over,
});

describe('#420: one opponent is sized at its full deploy on one border only', () => {
  it('the most valuable border (T1, my +5) keeps the full deploy; T3 is sized at its stack plus the top-up', () => {
    const p = planTurn(input());
    const line = p.rationale.find((r) => r.includes('(#420)') && r.includes('most valuable border'));
    expect(line).toBeDefined();
    expect(line).toContain('T1 (#1)');
    expect(line).toContain('T3 (#3)');
    expect(line).toContain('+2');
    // T3: 4 movable + 2 = 6; 6 armies hold. T1: 5 movable + 9 = 14 needs a hold.
    expect(p.warnings.some((w) => w.startsWith('T3 (#3)') && w.includes('could be taken'))).toBe(false);
    expect(p.warnings.some((w) => w.startsWith('T1 (#1)') && w.includes('could be taken'))).toBe(true);
  });

  it('without a top-up seen (no track), every border keeps the full deploy', () => {
    const p = planTurn(input({ tracks: [] }));
    expect(p.rationale.some((r) => r.includes('most valuable border'))).toBe(false);
    expect(p.warnings.some((w) => w.startsWith('T3 (#3)') && w.includes('could be taken'))).toBe(true);
  });

  it('an explicit enemy deploy is taken as it stands on every border', () => {
    const p = planTurn(input({ options: { enemyDeploy: 9 } }));
    expect(p.rationale.some((r) => r.includes('most valuable border'))).toBe(false);
    expect(p.warnings.some((w) => w.startsWith('T3 (#3)') && w.includes('could be taken'))).toBe(true);
  });
});

// syn1750's shape (review of #420): one guard-only stack of the opponent, T3 (1), faces my T1 (1) and T2
// (10); it never grew, so its top-up is 0 and T2, off its most valuable border T1, reads no threat at all.
// T1 needs more than it protects (+0) and is conceded at first. No border is then short of a margin, so the
// leftover's revival ("Hold … after all") would not run and the leftover went to T2 as "my biggest stack":
// the border that keeps the full deploy ended conceded. It is revived now, ahead of the stack nothing threatens.
describe('#420: the full-deploy border is held before the leftover goes to a border its top-up sized at 0', () => {
  const g3 = buildGraph(
    makeMap([1, 2, 3, 4], [[1, 2], [1, 3], [2, 3], [3, 4]], [[903, 2, [3, 4]]]),
  );
  const at = (t: number): TurnBoard => ({ turn: t, board: board([mine(1, 1), mine(2, 10), foe(3, 1), foe(4, 1)]) });
  const tracks3 = trackOpponents(g3, [at(1), at(2), at(3)], ME, STD);
  const plan3 = () =>
    planTurn({
      graph: g3,
      board: at(4).board,
      me: ME,
      income: 12,
      settings: STD,
      turn: 4,
      tracks: tracks3,
      game: { players: [{ id: ME }, { id: FOE }], turn: 4 },
      options: { goal: 'defend' },
    });

  it('reads a top-up of 0, so T2 is sized at the bare stack', () => {
    expect(tracks3[0]!.topUp).toBe(0);
    const line = plan3().rationale.find((r) => r.includes('(#420)') && r.includes('most valuable border'));
    expect(line).toContain('T1 (#1); T2 (#2) is sized at its stack beside it plus its largest top-up seen, +0');
  });

  it('T1 is held after all from the leftover, never conceded; the rest goes to T2', () => {
    const p = plan3();
    const dep = (t: number) => p.deploys.find((d) => d.territoryId === t)?.armies ?? 0;
    expect(dep(1)).toBe(4);
    expect(dep(2)).toBe(8);
    expect(p.rationale.join('\n')).toMatch(/Hold T1 \(#1\) after all \(not conceded\): deploy 4 there; the leftover covers it before any comfort margin \(5 armies need 8 to take, above the ~7 threat/);
    expect(p.warnings.some((w) => w.startsWith('T1 (#1) cannot be held') && w.endsWith(': conceded'))).toBe(false);
  });
});
