// PLAN-TEAMS C4: the team brief's pure parts — the opponents' incomes and their basis, the conflicts between
// my plan and my teammates' entered orders, what I ask of them, the overlap of our pick lists and the picks
// I lost. Pure and deterministic: no I/O, ties on ascending id.
import { describe, expect, it } from 'vitest';
import type { AwardReading } from '../../src/analysis/award.js';
import { buildGraph } from '../../src/analysis/graph.js';
import type { EnemyDeployEstimate, PlannedMove } from '../../src/analysis/planner.js';
import {
  briefAsks,
  briefConflicts,
  incomeBasis,
  opponentIncomes,
  pickOverlap,
  picksLost,
} from '../../src/analysis/team-brief.js';
import type { BoardState, TerritoryState } from '../../src/board.js';
import type { TeammateOrders, TeamMove } from '../../src/team-orders.js';
import { tinyMap } from './helpers.js';

const ME = 10;
const MATE = 20;
const FOE = 30;
const g = buildGraph(tinyMap());

const t = (territoryId: number, owner: number | 'neutral', armies = 3): TerritoryState => ({
  territoryId,
  owner: owner === 'neutral' ? { kind: 'neutral' } : { kind: 'player', playerId: owner },
  armies,
  fogLevel: 'Visible',
});

function board(ts: TerritoryState[], mates?: TeammateOrders[]): BoardState {
  return { source: 'browser', verified: true, territories: ts, ...(mates ? { teammateOrders: mates } : {}) };
}

const mateMoves = (moves: TeamMove[], player = MATE): TeammateOrders => ({
  playerId: player,
  orders: { deploys: [], moves, cards: [], discards: [], unread: [] },
  picks: null,
});

const attack = (from: number, to: number, armies: number): PlannedMove => ({ from, to, armies, kind: 'attack', reason: 'test' });

function estimate(over: Partial<EnemyDeployEstimate>): EnemyDeployEstimate {
  return {
    playerId: FOE,
    estimate: 5,
    held: 3,
    base: 5,
    bonusIncome: 0,
    largestStack: 4,
    opening: false,
    observed: null,
    observedRaw: null,
    observedCap: null,
    observation: null,
    tracked: null,
    newestCut: null,
    trackedTurns: [],
    couldEarn: 10,
    couldHold: 3,
    prior: null,
    priorBlend: null,
    coverage: null,
    priorCap: null,
    fogBeside: false,
    source: 'visible',
    exact: null,
    card: null,
    cardPlayed: null,
    ...over,
  };
}

describe('incomeBasis', () => {
  it('names the figure each source rests on', () => {
    expect(incomeBasis(estimate({ source: 'visible', base: 5, bonusIncome: 3, estimate: 8 }))).toBe('base 5 + visibly held bonuses 3');
    expect(incomeBasis(estimate({ source: 'observed', observed: 9, estimate: 9 }))).toBe('observed: deployed 9 since the previous board');
    expect(incomeBasis(estimate({ source: 'tracked', tracked: 11, trackedTurns: [3, 4], estimate: 11 }))).toBe(
      'tracked: 11 over observed turns 3, 4',
    );
    expect(incomeBasis(estimate({ source: 'prior', prior: 12, estimate: 12 }))).toBe('a prior, not an observation: 12');
    expect(incomeBasis(estimate({ source: 'exact', exact: 7, estimate: 7 }))).toBe('exact: every owner is shown');
    expect(incomeBasis(estimate({ source: 'visible', estimate: 9, card: { armies: 4, due: 3 } }))).toMatch(/Reinforcement card of 4/);
  });
});

describe('opponentIncomes', () => {
  it('lists every opponent still playing, ascending, with null when nothing of theirs is in view', () => {
    const out = opponentIncomes([estimate({ playerId: 31, estimate: 6 }), estimate({ playerId: MATE })], [31, 32]);
    expect(out).toEqual([
      { player: 31, estimate: 6, source: 'visible', basis: 'base 5 + visibly held bonuses 0' },
      { player: 32, estimate: null, source: null, basis: 'nothing of theirs in view' },
    ]);
  });
});

describe('briefConflicts', () => {
  const ts = [t(1, ME, 8), t(2, MATE, 8), t(3, FOE, 2), t(4, 'neutral', 2), t(5, 'neutral', 2)];
  const allies = new Set([MATE]);

  it('reports nothing without teammate orders (unknown, not "none")', () => {
    expect(briefConflicts({ g, board: board(ts), me: ME, allies, moves: [attack(1, 3, 6)], bonusesCompleted: [] })).toEqual([]);
  });

  it('a target we both attack: the second attack lands on a teammate (V7), unless it is a joint capture', () => {
    const b = board(ts, [mateMoves([{ from: 2, to: 3, armies: 6, mode: 'attack-transfer' }])]);
    const plain = briefConflicts({ g, board: b, me: ME, allies, moves: [attack(1, 3, 6)], bonusesCompleted: [] });
    expect(plain).toEqual([{ kind: 'same-target', territory: 3, teammate: MATE, mine: 6, theirs: 6, joint: false }]);
    const joint = briefConflicts({ g, board: b, me: ME, allies, moves: [attack(1, 3, 6)], bonusesCompleted: [], joint: new Set([3]) });
    expect(joint[0]).toMatchObject({ kind: 'same-target', joint: true });
  });

  it('a transfer-only order of theirs is no attack on my target', () => {
    const b = board(ts, [mateMoves([{ from: 2, to: 3, armies: 6, mode: 'transfer' }])]);
    expect(briefConflicts({ g, board: b, me: ME, allies, moves: [attack(1, 3, 6)], bonusesCompleted: [] })).toEqual([]);
  });

  it('their capture in a bonus my plan completes: a bonus pays one holder', () => {
    const b = board([t(1, ME, 8), t(2, 'neutral', 1), t(3, 'neutral', 1), t(4, MATE, 9)], [
      mateMoves([{ from: 4, to: 3, armies: 5, mode: 'attack-transfer' }]),
    ]);
    const out = briefConflicts({ g, board: b, me: ME, allies, moves: [attack(1, 2, 4)], bonusesCompleted: [101] });
    expect(out).toEqual([{ kind: 'bonus', bonus: 101, territory: 3, teammate: MATE, completes: true }]);
  });

  it('their capture in a bonus my plan only advances (a capture into it, not completing it): still one holder (G3)', () => {
    const b = board([t(1, ME, 8), t(2, 'neutral', 1), t(3, 'neutral', 1), t(4, MATE, 9), t(5, 'neutral', 1)], [
      mateMoves([
        { from: 4, to: 3, armies: 5, mode: 'attack-transfer' },
        // Bonus 102 (4–5): no capture of mine goes into it.
        { from: 4, to: 5, armies: 2, mode: 'attack-transfer' },
      ]),
    ]);
    const out = briefConflicts({ g, board: b, me: ME, allies, moves: [attack(1, 2, 4)], bonusesCompleted: [] });
    // A direct member of bonus 101 only: the superbonus 104 above it is no advance of mine.
    expect(out).toEqual([{ kind: 'bonus', bonus: 101, territory: 3, teammate: MATE, completes: false }]);
  });

  it('their order onto a territory of mine: an attack with attack_teammates, else a move whose effect is unverified', () => {
    const b = board(ts, [
      mateMoves([
        { from: 2, to: 1, armies: 4, mode: 'attack-transfer', attackTeammates: true },
        { from: 2, to: 1, armies: 2, mode: 'transfer' },
      ]),
    ]);
    expect(briefConflicts({ g, board: b, me: ME, allies, moves: [], bonusesCompleted: [] })).toEqual([
      { kind: 'attacks-me', from: 2, to: 1, teammate: MATE, armies: 4 },
      { kind: 'onto-mine', from: 2, to: 1, teammate: MATE, armies: 2 },
    ]);
  });

  it('ignores an entry of a player who is not my teammate', () => {
    const b = board(ts, [mateMoves([{ from: 2, to: 3, armies: 6, mode: 'attack-transfer' }], 99)]);
    expect(briefConflicts({ g, board: b, me: ME, allies, moves: [attack(1, 3, 6)], bonusesCompleted: [] })).toEqual([]);
  });
});

describe('briefAsks', () => {
  it('asks a teammate beside a conceded border of mine to cover it, and keeps each joint capture', () => {
    const b = board([t(3, ME, 2), t(2, MATE, 9), t(4, FOE, 12), t(1, MATE, 1)]);
    const asks = briefAsks({
      g,
      board: b,
      allies: new Set([MATE]),
      conceded: [3],
      jointCaptures: [{ target: 4, teammates: [MATE], mustGoFirst: MATE }],
    });
    expect(asks).toEqual([
      { kind: 'joint-capture', target: 4, teammates: [MATE], mustGoFirst: MATE },
      // Territory 1 holds a single army: nothing to send.
      { kind: 'cover', territory: 3, beside: [{ teammate: MATE, territory: 2, armies: 9 }] },
    ]);
  });

  it('asks nothing for a conceded border no teammate borders', () => {
    const b = board([t(5, ME, 2), t(4, FOE, 12), t(6, 'neutral', 2)]);
    expect(briefAsks({ g, board: b, allies: new Set([MATE]), conceded: [5], jointCaptures: [] })).toEqual([]);
  });
});

describe('pickOverlap', () => {
  it('names each pick both lists hold, with both positions, and the bonuses both pick into', () => {
    const out = pickOverlap(g, [1, 4, 6], [
      { player: MATE, list: [5, 1, 2] },
      { player: 21, list: null },
    ]);
    expect(out.overlap).toEqual([{ territory: 1, mine: 1, teammate: MATE, theirs: 2 }]);
    expect(out.sharedBonuses).toEqual([
      { bonus: 101, mine: [1], teammate: MATE, theirs: [1, 2] },
      { bonus: 102, mine: [4], teammate: MATE, theirs: [5] },
      // The superbonus S holds both.
      { bonus: 104, mine: [1, 4], teammate: MATE, theirs: [1, 2, 5] },
    ]);
    expect(out.unknown).toEqual([21]);
  });

  it('is empty with disjoint lists in disjoint bonuses', () => {
    expect(pickOverlap(g, [1], [{ player: MATE, list: [6] }])).toEqual({ overlap: [], sharedBonuses: [], unknown: [] });
  });
});

describe('picksLost', () => {
  const reading = (over: Partial<AwardReading>): AwardReading => ({
    granted: [4],
    unlisted: [],
    opponentStarts: [],
    allStartsKnown: false,
    role: null,
    opponentFirstAward: null,
    ...over,
  });

  it('lists each pick ranked above a granted one that went elsewhere, in list order, and whose it was', () => {
    const r = reading({ granted: [4, 6], opponentStarts: [3], teammateStarts: [1] });
    expect(picksLost([1, 3, 4, 6], r)).toEqual({
      granted: [4, 6],
      lost: [
        { territory: 1, rank: 1, by: 'teammate' },
        { territory: 3, rank: 2, by: 'opponent' },
      ],
      unlisted: [],
    });
  });

  it('outside a team reading every lost pick is another player\'s', () => {
    expect(picksLost([3, 4], reading({ opponentStarts: [3] })).lost).toEqual([{ territory: 3, rank: 1, by: 'other' }]);
  });
});
