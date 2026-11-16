// #281: territory vacated by a player who is out with no AI on its seat (a static seat, #270) is a
// neutral the live opponent beside it takes for free next turn. Taking it costs next to nothing and
// the border comes either way, so rule 4d's frontier budget does not refuse a cheap one on its hold
// cost alone; its score credits the denial; it never takes armies a hold needs, and it is taken
// with the fewest armies that capture it. Synthetic map, made-up ids.
//
//   6 ─ 1 ─ 2 ─ 3        1 mine; 2 vacated by S (or an ordinary neutral); 3 A's live stack
//                        6 a quiet neutral wall (40) behind me
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const A = 20;
const S = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, baseIncome: 5 };

const held = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  return {
    id: 1,
    name: 'Synthetic vacated',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}

const players = [
  { id: ME, state: 'Playing' },
  { id: A, state: 'Playing' },
  { id: S, state: 'SurrenderAccepted' },
];

const line = [
  [6, 1],
  [1, 2],
  [2, 3],
] as [number, number][];
const G = buildGraph(makeMap([1, 2, 3, 6], line));

function input(b: ReturnType<typeof board>, graph = G): PlanInput {
  return { graph, board: b, me: ME, income: 5, settings: STD, turn: 14, game: { players, turn: 14 }, options: { adapt: true } };
}
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const attacksOn = (p: TurnPlan, t: number) => attacks(p).filter((m) => m.to === t);

describe('vacated land (#281)', () => {
  it('the live shape: an empty vacated territory beside a live stack is taken, with the fewest armies', () => {
    const p = planTurn(input(board([mine(1, 8), held(2, 0, S), held(3, 12, A), neutral(6, 40)])));
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 2, armies: 1 })]);
    expect(p.expected.captures).toContain(2);
    expect(p.rationale.join('\n')).toMatch(
      /Take T2 \(#2\) though it faces player 20: player 30 left it \(out, no AI\), it costs 1, and player 20 would take it free next turn — the border comes either way \(#281\)\./,
    );
    expect(p.rationale.join('\n')).not.toMatch(/Do not take T2/);
    expect(p.warnings.join('\n')).not.toMatch(/T2 \(#2\).*not taken/);
  });

  it('the same territory as an ordinary neutral is still refused by the frontier rule', () => {
    const p = planTurn(input(board([mine(1, 8), neutral(2, 0), held(3, 12, A), neutral(6, 40)])));
    expect(attacks(p).map((m) => m.to)).not.toContain(2);
    expect(p.rationale.join('\n')).toMatch(/Do not take T2 \(#2\): it adds a border facing an enemy without completing a bonus/);
    expect(p.rationale.join('\n')).not.toMatch(/#281/);
  });

  it('a vacated territory whose capture would cost a hold is not taken', () => {
    // T1 also borders A's T3 (20): with 12 armies, every one of them and every deploy is its hold.
    //   6 ─ 1 ─ 2 ─ 3, and 1 ─ 3
    const g = buildGraph(makeMap([1, 2, 3, 6], [...line, [1, 3]]));
    const at = (armies: number) => planTurn(input(board([mine(1, armies), held(2, 0, S), held(3, 20, A), neutral(6, 40)]), g));
    const p = at(12);
    expect(p.conceded).toEqual([]);
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 5 }]);
    expect(attacks(p).map((m) => m.to)).not.toContain(2);
    // With armies to spare above the hold, the same capture is made with one of them.
    const spare = at(16);
    expect(spare.conceded).toEqual([]);
    expect(attacks(spare)).toEqual([expect.objectContaining({ from: 1, to: 2, armies: 1 })]);
  });

  it('its score credits the denial: it goes before an equal ordinary neutral when only one can be paid', () => {
    // T1 has 1 army and 1 to deploy: one capture of an empty territory. T7 is an ordinary empty
    // neutral facing no one; T2 is vacated beside A's stack. Without the denial T7 ranks first.
    //   6 ─ 1 ─ 2 ─ 3, and 1 ─ 7
    const g = buildGraph(makeMap([1, 2, 3, 6, 7], [...line, [1, 7]]));
    const b = board([mine(1, 1), held(2, 0, S), held(3, 12, A), neutral(6, 40), neutral(7, 0)]);
    const p = planTurn({ ...input(b, g), income: 1 });
    expect(attacks(p).map((m) => m.to)).toEqual([2]);
    const plain = planTurn({ ...input(board([mine(1, 1), neutral(2, 0), held(3, 12, A), neutral(6, 40), neutral(7, 0)]), g), income: 1 });
    expect(attacks(plain).map((m) => m.to)).toEqual([7]);
  });

  it('a vacated territory no live stack could take for free is judged as any neutral', () => {
    // 4 vacated armies on T2: A's 12 could take it, but not for free, and it costs me 7.
    const p = planTurn(input(board([mine(1, 8), held(2, 4, S), held(3, 12, A), neutral(6, 40)])));
    expect(p.rationale.join('\n')).not.toMatch(/#281/);
  });

  it('says what the live stack would pay when the territory is not empty (#281 review)', () => {
    // 1 vacated army on T2 costs 2: player 20 would take it for 2, not free.
    const p = planTurn(input(board([mine(1, 8), held(2, 1, S), held(3, 12, A), neutral(6, 40)])));
    expect(attacksOn(p, 2)).toEqual([expect.objectContaining({ from: 1, armies: 2 })]);
    expect(p.rationale.join('\n')).toMatch(/it costs 2, and player 20 would take it for 2 next turn — the border comes either way \(#281\)\./);
    expect(p.rationale.join('\n')).not.toMatch(/take it free/);
  });

  it('names the bonus it would complete for the live opponent (#281 review)', () => {
    const g = buildGraph(makeMap([1, 2, 3, 6], line, [[700, 3, [2, 3]]]));
    const p = planTurn(input(board([mine(1, 8), held(2, 0, S), held(3, 12, A), neutral(6, 40)]), g));
    expect(attacksOn(p, 2)).toEqual([expect.objectContaining({ from: 1, armies: 1 })]);
    expect(p.rationale.join('\n')).toMatch(
      /player 20 would take it free next turn, completing bonus B700 \(#700\) \(\+3\) for it — the border comes either way \(#281\)\./,
    );
  });

  it('names the bonus progress it would give the live opponent (#281 review)', () => {
    // B700 (+3) is T2, T3 and the neutral T6: T2 would be player 20's second member of three.
    const g = buildGraph(makeMap([1, 2, 3, 6], line, [[700, 3, [2, 3, 6]]]));
    const p = planTurn(input(board([mine(1, 8), held(2, 0, S), held(3, 12, A), neutral(6, 40)]), g));
    expect(attacksOn(p, 2)).toEqual([expect.objectContaining({ from: 1, armies: 1 })]);
    expect(p.rationale.join('\n')).toMatch(/player 20 would take it free next turn, toward its bonuses \(~\+1 a turn\)/);
  });

  it('with the guard off, an empty vacated territory is taken with one army (#281 review)', () => {
    const p = planTurn({ ...input(board([mine(1, 8), held(2, 0, S), held(3, 12, A), neutral(6, 40)])), settings: { ...STD, oneArmyStandsGuard: false } });
    expect(attacksOn(p, 2)).toEqual([expect.objectContaining({ from: 1, armies: 1 })]);
    expect(p.rationale.join('\n')).toMatch(/Take T2 \(#2\) though it faces player 20: player 30 left it \(out, no AI\), it costs 1, and player 20 would take it free next turn/);
    // A vacated territory is a neutral now: the empty-enemy rule (#281's extension) never names it.
    expect(p.rationale.join('\n')).not.toMatch(/cheap expansion/);
  });
});


// #281 × #282: T1 holds my commander beside A's stack on T3; it walks to T8 this turn. T2, vacated by
// S, borders T1 and T3: a denial, but everything on T1 is the commander's transit hold until the walk.
describe('vacated land beside the territory my commander walks from (#281 × #282)', () => {
  const g = buildGraph(makeMap([1, 2, 3, 8, 9], [[1, 2], [2, 3], [1, 3], [1, 8], [8, 9]]));
  const commander = { kind: 'commander' as const, id: `${ME}`.padStart(32, '0'), playerId: ME };
  const b = (verified: boolean) =>
    board([{ ...mine(1, 30), specialUnits: [commander] }, held(2, 0, S), held(3, 12, A), mine(8, 2), mine(9, 2)], verified);

  it('is not taken from it', () => {
    const p = planTurn({ ...input(b(true), g), options: { adapt: true } });
    expect(p.moves.filter((m) => m.commander)).toEqual([expect.objectContaining({ from: 1, to: 8 })]);
    expect(attacksOn(p, 2).filter((m) => m.from === 1)).toEqual([]);
  });

  it('a commander that stays takes it from the armies above its hold', () => {
    const p = planTurn({ ...input(b(true), g), options: { adapt: true, commanderWalks: false } });
    expect(p.moves.filter((m) => m.commander)).toEqual([]);
    expect(attacksOn(p, 2)).toEqual([expect.objectContaining({ from: 1, armies: 1 })]);
  });
});
