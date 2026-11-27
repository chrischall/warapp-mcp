// #606: the facts laid out for the calling model to plan on its own.
import { describe, expect, it } from 'vitest';
import type { BoardState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { FACT_PARTS, FACTS_AVAILABLE, MORE_ON_REQUEST, OWN_PLAN_STEPS, pickFacts, situation } from '../../src/analysis/situation.js';
import type { GameMap } from '../../src/normalize.js';

const ME = 1;
const FOE = 2;
const MATE = 3;
// T1 (mine 10) ─ T2 (neutral 2) ─ T3 (neutral 2); T1 ─ T4 (foe 5) ─ T5 (foe 3); T6 (mine 4, commander) ─ T4; T7 (fog) ─ T6.
// Bonus 10 (+3): T1, T2. Bonus 11 (+2): T3, T5. Bonus 12 (+4): T6. Bonus 13 (+5): T4, T5 (the foe's). Bonus 14 (+1): T7.
const MAP: GameMap = {
  id: 1,
  name: 'm',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2, 4] },
    { id: 2, name: 'T2', connectedTo: [1, 3] },
    { id: 3, name: 'T3', connectedTo: [2] },
    { id: 4, name: 'T4', connectedTo: [1, 5, 6] },
    { id: 5, name: 'T5', connectedTo: [4] },
    { id: 6, name: 'T6', connectedTo: [4, 7] },
    { id: 7, name: 'T7', connectedTo: [6] },
  ],
  bonuses: [
    { id: 10, name: 'B10', value: 3, territoryIds: [1, 2], bonusIds: [] },
    { id: 11, name: 'B11', value: 2, territoryIds: [3, 5], bonusIds: [] },
    { id: 12, name: 'B12', value: 4, territoryIds: [6], bonusIds: [] },
    { id: 13, name: 'B13', value: 5, territoryIds: [4, 5], bonusIds: [] },
    { id: 14, name: 'B14', value: 1, territoryIds: [7], bonusIds: [] },
    { id: 15, name: 'B15', value: -1, territoryIds: [3], bonusIds: [] },
  ],
  distributionModes: [],
};
const player = (id: number, owner: number, armies: number | null) => ({ territoryId: id, owner: { kind: 'player' as const, playerId: owner }, armies });
const neutral = (id: number, armies: number) => ({ territoryId: id, owner: { kind: 'neutral' as const }, armies });
const BOARD: BoardState = {
  source: 'browser',
  verified: true,
  territories: [
    player(1, ME, 10),
    neutral(2, 2),
    neutral(3, 2),
    player(4, FOE, 5),
    player(5, FOE, 3),
    { ...player(6, ME, 4), specialUnits: [{ kind: 'commander', id: 'g', playerId: ME }] },
    { territoryId: 7, owner: { kind: 'unknown' as const }, armies: null },
  ],
};
const PREVIOUS: BoardState = {
  source: 'browser',
  verified: true,
  territories: [player(1, ME, 9), neutral(2, 2), player(3, ME, 1), player(4, FOE, 2), player(5, FOE, 3), player(6, ME, 4), player(7, ME, 1)],
};
const g = buildGraph(MAP);
const rates = { offensiveKillRate: 60, defensiveKillRate: 70 };

describe('situation (#606)', () => {
  const s = situation({
    graph: g,
    board: BOARD,
    previousBoard: PREVIOUS,
    me: ME,
    rates,
    myIncome: 9,
    incomeHistory: [{ turn: 3, income: 8 }],
    pastBoards: [
      { turn: 3, board: PREVIOUS, orders: { deploys: [{ territoryId: 1, armies: 5 }], moves: [{ from: 1, to: 2, armies: 3 }] } },
      { turn: 2, board: { source: 'browser', verified: true, territories: [player(1, ME, 5), player(4, FOE, 5), { territoryId: 2, owner: { kind: 'unknown' as const }, armies: null }] } },
    ],
    opponents: [
      { playerId: FOE, estimate: 12, source: 'tracked', visibleIncome: 10, tracked: 11, range: { low: 10, high: 14 }, coverage: 0.4, history: [{ turn: 3, observed: 9 }] },
      { playerId: ME, estimate: 9 },
    ],
  });

  it('sums my side and the bonuses I hold', () => {
    expect(s.me).toEqual({ income: 9, incomeHistory: [{ turn: 3, income: 8 }], territories: 2, armies: 14, bonusesHeld: [{ bonusId: 12, value: 4 }] });
  });

  it('lists the territories in view and the hidden ones beside me, nearest first, with names, units and neighbours', () => {
    expect(s.territories.map((t) => [t.id, t.distance])).toEqual([[1, 0], [6, 0], [2, 1], [4, 1], [7, 1], [3, 2], [5, 2]]);
    expect(s.territories.find((t) => t.id === 6)).toMatchObject({ name: 'T6', owner: 'me', units: [{ kind: 'commander', owner: 'me' }] });
    expect(s.territories.find((t) => t.id === 7)).toMatchObject({ owner: 'fog', armies: null, bonuses: [14] });
    expect(s.territories.find((t) => t.id === 4)).toMatchObject({ owner: FOE, armies: 5, neighbors: [1, 5, 6] });
    expect(s.territoriesOmitted).toBe(0);
  });

  it('lays out each bonus that matters: who holds what, what finishing it costs, which members are in reach', () => {
    expect(s.bonuses.map((b) => b.bonusId)).toEqual([12, 10, 14, 13]);
    expect(s.bonuses.find((b) => b.bonusId === 10)).toMatchObject({ mine: 1, neutral: 1, heldBy: null, missing: [2], armiesToFinish: 3, reachable: [2] });
    expect(s.bonuses.find((b) => b.bonusId === 13)).toMatchObject({ heldBy: FOE, players: [{ player: FOE, count: 2 }], missing: [4, 5], reachable: [4] });
    expect(s.bonuses.find((b) => b.bonusId === 14)).toMatchObject({ fogged: 1, armiesToFinish: null });
    expect(s.bonuses.find((b) => b.bonusId === 12)).toMatchObject({ heldBy: 'me', armiesToFinish: 0 });
    // B11 is two steps away and nobody holds it whole; B15 pays nothing.
    expect(s.bonuses.some((b) => b.bonusId === 11 || b.bonusId === 15)).toBe(false);
  });

  it("gives each opponent's income with how it was read, its bonuses and its stacks beside me", () => {
    expect(s.opponents).toHaveLength(1);
    expect(s.opponents[0]).toEqual({
      player: FOE,
      income: { estimate: 12, source: 'tracked', visible: 10, tracked: 11, range: { low: 10, high: 14 }, coverage: 0.4 },
      history: [{ turn: 3, observed: 9 }],
      territoriesInView: 2,
      armiesInView: 8,
      bonusesHeld: [{ bonusId: 13, value: 5 }],
      besideMe: [{ territoryId: 4, armies: 5, borders: [1, 6] }],
      movableBesideMe: 4,
    });
  });

  it('says what changed since last turn', () => {
    expect(s.changes).toEqual({
      lost: [{ territoryId: 3, to: 'neutral' }, { territoryId: 7, to: 'fog' }],
      gained: [],
      moved: [{ territoryId: 4, owner: FOE, was: 2, now: 5 }],
    });
  });

  it('with no board from last turn, no teammates as opponents, and the guard off', () => {
    const t = situation({ graph: g, board: BOARD, me: ME, rates, myIncome: 9, guard: false, friends: new Set([FOE]), opponents: [{ playerId: FOE, estimate: 5 }, { playerId: MATE, estimate: 5 }] });
    expect(t.changes).toBeNull();
    expect(t.past).toEqual([]);
    expect(t.me.incomeHistory).toEqual([]);
    expect(t.opponents.map((o) => o.player)).toEqual([MATE]);
    expect(t.opponents[0]).toMatchObject({ income: { estimate: 5 }, territoriesInView: 0, movableBesideMe: 0 });
    const gained = situation({ graph: g, board: PREVIOUS, previousBoard: BOARD, me: ME, rates, myIncome: 5, guard: false, opponents: [{ playerId: FOE, estimate: 5 }] });
    expect(gained.changes!.gained).toEqual([{ territoryId: 3, from: 'neutral' }, { territoryId: 7, from: 'fog' }]);
    expect(gained.opponents[0]!.movableBesideMe).toBe(2);
  });

  it('summarises each earlier turn kept: every side in view, its bonuses, and my orders when kept', () => {
    expect(s.past).toEqual([
      { turn: 2, sides: [{ owner: 'me', territories: 1, armies: 5, bonusesHeld: [] }, { owner: FOE, territories: 1, armies: 5, bonusesHeld: [] }] },
      {
        turn: 3,
        sides: [
          { owner: 'me', territories: 4, armies: 15, bonusesHeld: [12, 14] },
          { owner: FOE, territories: 2, armies: 5, bonusesHeld: [13] },
        ],
        myOrders: { deploys: [{ territoryId: 1, armies: 5 }], moves: [{ from: 1, to: 2, armies: 3 }] },
      },
    ]);
  });

  it('gives only the parts asked for, and names every part it can give', () => {
    expect(pickFacts(s, ['bonuses', 'changes'])).toEqual({ bonuses: s.bonuses, bonusesOmitted: 0, changes: s.changes });
    expect(Object.keys(pickFacts(s, FACT_PARTS))).toEqual(['me', 'territories', 'territoriesOmitted', 'bonuses', 'bonusesOmitted', 'opponents', 'changes', 'past']);
    expect(Object.keys(FACTS_AVAILABLE)).toEqual([...FACT_PARTS]);
    for (const part of FACT_PARTS) expect(MORE_ON_REQUEST).toContain(`"${part}"`);
  });

  it('ends with the steps for planning on your own, through warapp_check_plan and an override reason', () => {
    expect(OWN_PLAN_STEPS.join(' ')).toMatch(/warapp_check_plan[\s\S]*override_reason/);
  });
});
