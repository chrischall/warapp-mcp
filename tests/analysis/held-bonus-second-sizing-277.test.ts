// #277 (item 2), the live shape in miniature (every map, id and name here is made up). A free-for-all
// I lead: my held B1 (+4) has three threatened borders, each 1 army — T1 and T2 face player 20's ~5
// deploy, T3 faces player 30's ~13 — and holding all three needs 14, more than 3 × its worth, so it was
// conceded. The same plan broke player 40's two bonuses with two attacks, T31 from T5 and T32 from T6,
// each sized for player 40's whole ~20 deploy (36 against 2 defenders). That deploy reinforces one
// target, not both: the second sure sizing is where the held bonus's armies come from. The fix funds
// the bonus's borders from the second attack's surplus over its bare size, and keeps the first whole.
// When the two attacks face different opponents, each one's deploy can land on its own target: both
// keep their full size, and the bonus stays conceded.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { stressPlan } from '../../src/analysis/stress.js';
import type { GameMap } from '../../src/normalize.js';
import { board as boardOf } from './helpers.js';

const ME = 10;
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
const at = (territoryId: number, armies: number, who: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: who },
  armies,
});

/** `b3`, `b6`: the values of B3 and B6 (player 40 earns 5 + both when it holds both). */
const mapOf = (b3: number, b6: number) => makeMap(
  [1, 2, 3, 4, 5, 6, 7, 11, 12, 21, 22, 31, 32, 33, 34],
  [
    [1, 11],
    [2, 11],
    [1, 4],
    [2, 4],
    [3, 4],
    [3, 21],
    [4, 5],
    [4, 6],
    [4, 7],
    [11, 12],
    [21, 22],
    [5, 31],
    [6, 32],
    [31, 33],
    [32, 33],
    [33, 34],
  ],
  [
    [1, 4, [1, 2, 3, 4]],
    [2, 8, [21, 22]],
    [3, b3, [31, 33]],
    [6, b6, [32, 34]],
    [4, 8, [5, 31]],
    [5, 8, [6, 32]],
  ],
);

/** `east`: who holds T32 and T34 (player 40, as T31 and T33; or another player). */
const field = (east = 40): BoardState =>
  boardOf([
    at(1, 1, ME),
    at(2, 1, ME),
    at(3, 1, ME),
    at(4, 1, ME),
    at(5, 5, ME),
    at(6, 5, ME),
    at(7, 150, ME),
    at(11, 1, 20),
    at(12, 1, 20),
    at(21, 2, 30),
    at(22, 1, 30),
    at(31, 2, 40),
    at(32, 2, east),
    at(33, 2, 40),
    at(34, 1, east),
  ]);
/**
 * Player 40 holds B3 and B6 (+8 and +7: one ~20 deploy); or, `east` holding B6, player 40 and it each
 * hold one worth +15 (two ~20 deploys).
 */
const graphOf = (east: number) => (east === 40 ? buildGraph(mapOf(8, 7)) : buildGraph(mapOf(15, 15)));
const input = (east = 40): PlanInput => ({
  graph: graphOf(east),
  board: field(east),
  me: ME,
  income: 90,
  settings: RATES,
  game: { players: [ME, 20, 30, 40, ...(east === 40 ? [] : [east])].map((id) => ({ id })), turn: 10 },
  options: { adapt: true },
});
const attackOn = (p: TurnPlan, to: number) => p.moves.find((m) => m.kind === 'attack' && m.to === to);
const deployedOn = (p: TurnPlan, id: number) => p.deploys.filter((d) => d.territoryId === id).reduce((n, d) => n + d.armies, 0);
/** What one opponent's single replies take of B1 under one move order (warapp_check_plan's test). */
const b1Lost = (p: TurnPlan, east: number, opponent: number, deploy: number, firstMover: 'me' | 'opponent') =>
  stressPlan({
    graph: graphOf(east),
    board: field(east),
    me: ME,
    deploys: p.deploys,
    moves: p.moves,
    opponents: [{ id: opponent, deploy }],
    settings: RATES,
    firstMover,
  }).replies.some((r) => r.lost.some((t) => [1, 2, 3, 4].includes(t)));

describe('#277: a held bonus is funded before a second attack sized for the same deploy', () => {
  it('funds B1 from the second of two attacks sized for player 40’s one ~20 deploy', () => {
    const p = planTurn(input());
    expect(p.deploys.reduce((n, d) => n + d.armies, 0)).toBe(90);
    // The first attack keeps its sure size; the second gives up what B1 needs and still takes its 2.
    expect(attackOn(p, 31)?.armies).toBe(36);
    const second = attackOn(p, 32)!;
    expect(second.armies).toBeLessThan(36);
    expect(second.armies).toBeGreaterThanOrEqual(3);
    expect(second.winChance).toBe(1);
    // B1's borders get what holds them: no concession.
    expect(deployedOn(p, 1)).toBeGreaterThanOrEqual(3);
    expect(deployedOn(p, 2)).toBeGreaterThanOrEqual(3);
    expect(deployedOn(p, 3)).toBeGreaterThanOrEqual(8);
    expect(p.warnings.some((w) => w.startsWith('conceding bonus B1'))).toBe(false);
    expect(p.warnings.some((w) => w.startsWith('This plan concedes bonus B1'))).toBe(false);
    expect(p.rationale.find((l) => l.includes('(#277)'))).toMatch(/^Fund held bonus B1 \(#1\) \(\+4\) \(#277\)/);
    // And B1 now survives each opponent's single replies, whoever moves first.
    for (const fm of ['me', 'opponent'] as const) {
      expect(b1Lost(p, 40, 20, 5, fm)).toBe(false);
      expect(b1Lost(p, 40, 30, 13, fm)).toBe(false);
    }
  });

  it('keeps both attacks whole when they face different opponents', () => {
    const p = planTurn(input(50));
    expect(attackOn(p, 31)?.armies).toBe(36);
    expect(attackOn(p, 32)?.armies).toBe(36);
    expect(p.rationale.some((l) => l.includes('(#277)'))).toBe(false);
    expect(p.warnings.some((w) => w.startsWith('conceding bonus B1'))).toBe(true);
  });
});
