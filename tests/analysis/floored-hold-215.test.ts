// #215 (item 2), the live shape. Built from the numbers of the live plan (every map, id and name
// here is made up): a 1v1 in contact, income 22, the opponent's deploy ~29. My T1 (2 armies) is the
// one threatened border of my held B1 (+4), beside player 20's T5 (5 armies: 4 movable + ~29 = 33);
// B1's interior T2, T3, T4 hold 3, 9 and 3. My T9 (7, in no bonus) faces player 20's 35-stack and is
// conceded. T13 (1) can advance into B3 (+5) through the neutral T14 (10), far from finishing.
//
// The plan floored B1 (#118: its hold costs more than 3 × its worth, so the captures went first),
// sent 16 to the advance into B3, spread the 5 left on T1 "against the one shared deploy", and moved
// B1's idle interior armies into T1 (rule 6). T1 fell to the 33 whoever moved first: no withdrawal
// was involved, and the transfers never counted toward the hold. The fix: in a 1v1 in contact (rule
// 0p.1: an advance ranks below every hold) a contested held bonus is held whole, where it fits,
// before the first advance; and the plan warns when a border holds only with armies transferred in,
// which land after the opponent's first attack when it moves first.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { stressPlan } from '../../src/analysis/stress.js';
import type { GameMap } from '../../src/normalize.js';
import { board as boardOf } from './helpers.js';

const ME = 10;
const FOE = 20;
const RATES: PlannerSettings = {
  offensiveKillRate: 60,
  defensiveKillRate: 70,
  oneArmyStandsGuard: true,
  luckModifier: 0,
  roundingMode: 'StraightRound',
};

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
const at = (territoryId: number, armies: number, who: number | 'neutral'): TerritoryState =>
  who === 'neutral'
    ? { territoryId, owner: { kind: 'neutral' }, armies }
    : { territoryId, owner: { kind: 'player', playerId: who }, armies };

const map = makeMap(
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
  [
    [1, 5],
    [1, 2],
    [1, 3],
    [1, 4],
    [2, 3],
    [3, 4],
    [3, 6],
    [2, 7],
    [7, 8],
    [9, 10],
    [9, 11],
    [10, 11],
    [11, 12],
    [13, 14],
    [14, 15],
    [15, 16],
    [16, 17],
    [13, 18],
    [7, 18],
    [5, 6],
    [4, 18],
  ],
  [
    [1, 4, [1, 2, 3, 4]],
    [2, 3, [11, 12]],
    [3, 5, [14, 15, 16, 17]],
    [4, 3, [7, 8]],
  ],
);
const g = buildGraph(map);
interface Shape {
  income?: number;
  /** T1's armies (2 live). */
  u?: number;
  /** The opponent's deploy estimate (~29 live). */
  deploy?: number;
  /** Player 20's stack facing T9. */
  tasmania?: number;
  movesFirst?: boolean;
  movesFirstUnverified?: boolean;
}
const field = (o: Shape = {}): BoardState =>
  boardOf([
    at(1, o.u ?? 2, ME),
    at(2, 3, ME),
    at(3, 9, ME),
    at(4, 3, ME),
    at(5, 5, FOE),
    at(6, 2, 'neutral'),
    at(7, 4, ME),
    at(8, 2, 'neutral'),
    at(9, 7, ME),
    at(10, o.tasmania ?? 35, FOE),
    at(11, 2, FOE),
    at(12, 2, FOE),
    at(13, 1, ME),
    at(14, 10, 'neutral'),
    at(15, 2, 'neutral'),
    at(16, 2, 'neutral'),
    at(17, 16, 'neutral'),
    at(18, 1, ME),
  ]);
const input = (o: Shape = {}): PlanInput => ({
  graph: g,
  board: field(o),
  me: ME,
  income: o.income ?? 22,
  settings: RATES,
  game: { players: [{ id: ME }, { id: FOE }], turn: 10 },
  options: {
    adapt: true,
    enemyDeploy: o.deploy ?? 29,
    ...(o.movesFirst !== undefined ? { movesFirst: o.movesFirst } : {}),
    ...(o.movesFirstUnverified ? { movesFirstUnverified: true } : {}),
  },
});
const deployedOn = (p: TurnPlan, id: number) => p.deploys.filter((d) => d.territoryId === id).reduce((n, d) => n + d.armies, 0);
/** What player 20's single replies take of mine (`warapp_check_plan`'s test) under one move order. */
const lost = (p: TurnPlan, o: Shape, firstMover: 'me' | 'opponent') =>
  stressPlan({
    graph: g,
    board: field(o),
    me: ME,
    deploys: p.deploys,
    moves: p.moves,
    opponents: [{ id: FOE, deploy: o.deploy ?? 29 }],
    settings: RATES,
    firstMover,
    lookAhead: false,
  }).replies.flatMap((r) => r.lost);

describe('#215: the live shape — a held bonus left to fall while the deploy went to an advance', () => {
  it('holds T1 whole before the advance, so it holds whoever moves first', () => {
    const p = planTurn(input());
    // 19 make T1 21 armies, 35 to take: above the 33 (4 movable + ~29) without any transfer in.
    expect(p.rationale).toContain('Deploy 19 to T1 (#1) so it holds (protects +4): 21 armies need 35 to take, above the ~33 threat.');
    // The 3 left join it as the strike stack (rule 0p.3c): nothing goes to the advance.
    expect(deployedOn(p, 1)).toBe(22);
    expect(p.moves.some((m) => m.kind === 'attack' && m.from === 13 && m.to === 14)).toBe(false);
    expect(lost(p, {}, 'opponent')).not.toContain(1);
    expect(lost(p, {}, 'me')).not.toContain(1);
  });

  it('holds it whole past its floor, and not against "the one shared deploy"', () => {
    const p = planTurn(input());
    expect(p.rationale).toContain(
      'Hold bonus B1 (#1) (+4) whole: past its floor its 1 threatened border needs 18 more (more than 3 × its worth), before any expansion that completes no bonus (1v1 in contact: an advance ranks below every hold).',
    );
    const text = [...p.rationale, ...p.warnings].join('\n');
    expect(text).not.toMatch(/against the one shared deploy/);
    expect(text).not.toMatch(/can still break bonus B1/);
  });

  it('holds it the same whatever the move order the caller knows', () => {
    for (const movesFirst of [true, false]) {
      const p = planTurn(input({ movesFirst }));
      expect(deployedOn(p, 1)).toBe(22);
      expect(lost(p, {}, 'opponent')).not.toContain(1);
    }
  });
});

describe('#215 review: a border that holds only with idle armies transferred in says so', () => {
  // Nearby: 8 income, T1 on 1 army, a ~20 deploy (~24 in all). The deploy goes to T1 (9 armies,
  // 15 to take) and rule 6 moves 12 idle armies in, 8 of them from T3 — the transfers are my own
  // orders, so they land after player 20's attack when it moves first.
  const near: Shape = { income: 8, u: 1, deploy: 20 };
  it('warns, naming the one transfer that can land in time when I move first', () => {
    const p = planTurn(input(near));
    expect(p.warnings).toContain(
      'T1 (#1) holds only if I move first: 12 of its armies are idle armies transferred into it this turn, and if player 20 moves first its attack (~24) lands before them; moving first, only my first order runs before its first, so it holds only if that is the 8 from T3 (#3). Its own 9 need 15 to take; 6 more deployed there would hold it whoever moves first.',
    );
    expect(lost(p, near, 'opponent')).toContain(1);
  });

  it('says the award is unverified when only the award says I move first, and nothing when the user said so', () => {
    const award = planTurn(input({ ...near, movesFirst: true, movesFirstUnverified: true }));
    expect(award.warnings.join('\n')).toMatch(
      /T1 \(#1\) holds only if I move first: .* lands before them \(the award of picks says I move first: the wiki's rule, not verified live\); moving first/,
    );
    const told = planTurn(input({ ...near, movesFirst: true }));
    expect(told.warnings.join('\n')).not.toMatch(/holds only if I move first/);
  });

  it('names the one transfer that lands in time when I am known to move first (#215 review)', () => {
    // Moving first, only my first order runs before player 20's first: the 12 transferred in do not
    // all land in time, so T1 holds only if its first order is the 8 from T3.
    const told = planTurn(input({ ...near, movesFirst: true }));
    expect(told.warnings).toContain(
      'T1 (#1) holds only if my first order is the 8 from T3 (#3): 12 of its armies are idle armies transferred into it this turn, and I move first, so only my first order runs before player 20\'s first attack (~24). Its own 9 need 15 to take; 6 more deployed there would hold it with no transfer in.',
    );
  });
});
