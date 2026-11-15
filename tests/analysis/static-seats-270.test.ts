// #270: a player who is out (surrendered, booted, eliminated, ended by vote) and whose seat no AI
// plays deploys nothing and attacks nothing. Its territories stay on the board as static armies:
// the planner, the stress test's opponents, the tracker and the outlook read them as neutrals —
// targets priced like a wasteland, no hold needed beside them, never the standing or the strike
// stack's direction. An AI that replaced a player stays an opponent.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { gameOutlook } from '../../src/analysis/outlook.js';
import { trackGame, trackOpponents } from '../../src/analysis/opponents.js';
import { planEnemyEstimates } from '../../src/analysis/plan/estimates.js';
import { planTurn, type PlanInput, type PlannerSettings } from '../../src/analysis/planner.js';
import { isStaticSeat, neutralizeSeats, staticSeats } from '../../src/analysis/static-seats.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const A = 20;
const S = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, baseIncome: 5 };

const enemy = (territoryId: number, armies: number, playerId = A): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

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

// My T1–T3 (bonus +3). S (surrendered, no AI) holds T4 (21) beside T3 and T5 (12); bonus +2 on T4–T5,
// which completes nothing of mine. A (playing) holds T8 far away, behind a neutral T7.
//   1 ─ 2 ─ 3 ─ 4 ─ 5 ─ 7 ─ 8
const map = makeMap(
  [1, 2, 3, 4, 5, 7, 8],
  [
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 7],
    [7, 8],
  ],
  [
    [101, 3, [1, 2, 3]],
    [102, 2, [4, 5]],
  ],
);
const g = buildGraph(map);
const now = board([mine(1, 3), mine(2, 3), mine(3, 6), enemy(4, 21, S), enemy(5, 12, S), neutral(7, 2), enemy(8, 5, A)]);
const players = (sState: string, extra: { humanTurnedIntoAI?: boolean } = {}) => [
  { id: ME, state: 'Playing' },
  { id: A, state: 'Playing' },
  { id: S, state: sState, ...extra },
];

function input(sState: string, extra: { humanTurnedIntoAI?: boolean } = {}, endRules = {}): PlanInput {
  return {
    graph: g,
    board: now,
    me: ME,
    income: 8,
    settings: STD,
    turn: 14,
    game: { players: players(sState, extra), turn: 14, endRules },
    options: { adapt: true },
  };
}

describe('staticSeats (#270)', () => {
  it('is out and static only in an out state with no AI on the seat', () => {
    for (const state of ['SurrenderAccepted', 'Booted', 'Eliminated', 'EndedByVote']) expect(isStaticSeat({ id: 1, state })).toBe(true);
    for (const state of ['Playing', 'Won', 'Invited', 'Declined', 'RemovedByHost', undefined])
      expect(isStaticSeat({ id: 1, ...(state ? { state } : {}) })).toBe(false);
    expect(isStaticSeat({ id: 1, state: 'Booted', humanTurnedIntoAI: true })).toBe(false);
    expect(isStaticSeat({ id: 1, state: 'SurrenderAccepted' }, { surrenderedTurnIntoAI: true })).toBe(false);
    expect(isStaticSeat({ id: 1, state: 'SurrenderAccepted' }, { surrenderedTurnIntoAI: false, bootedTurnIntoAI: true })).toBe(true);
    expect(isStaticSeat({ id: 1, state: 'Booted' }, { bootedTurnIntoAI: true })).toBe(false);
    expect(isStaticSeat({ id: 1, state: 'Booted' }, { surrenderedTurnIntoAI: true })).toBe(true);
  });

  it('never names me or a teammate', () => {
    const list = [
      { id: ME, state: 'SurrenderAccepted', team: 1 },
      { id: A, state: 'Booted', team: 1 },
      { id: S, state: 'Booted', team: 2 },
    ];
    expect([...staticSeats(list, undefined, ME)]).toEqual([[S, 'Booted']]);
  });

  it('reads their territories as neutrals, armies kept, and returns the same board when none is held', () => {
    const out = neutralizeSeats(now, staticSeats(players('SurrenderAccepted'), undefined, ME));
    expect(out.territories.find((t) => t.territoryId === 4)).toEqual({ territoryId: 4, owner: { kind: 'neutral' }, armies: 21 });
    expect(out.territories.find((t) => t.territoryId === 8)?.owner).toEqual({ kind: 'player', playerId: A });
    expect(neutralizeSeats(now, new Map())).toBe(now);
    expect(neutralizeSeats(now, new Map([[99, 'Eliminated']]))).toBe(now);
  });
});

describe('the planner (#270)', () => {
  it('a surrendered player with no AI deploys nothing and attacks nothing: no hold beside it', () => {
    const plan = planTurn(input('SurrenderAccepted'));
    // As a live player, T3 faces 21 + a deploy: the bonus is conceded and the standing is behind.
    const live = planTurn(input('Playing'));
    expect(live.conceded).toEqual([3]);
    expect(live.profile.standing).toBe('behind');
    expect(live.warnings.join(' ')).toMatch(/player 30/);
    // Static: nothing to hold against; T3 is kept, the standing is mine, and the armies stage toward T4.
    expect(plan.conceded).toEqual([]);
    expect(plan.profile.standing).not.toBe('behind');
    expect(plan.deploys).toEqual([{ territoryId: 3, armies: 8 }]);
    expect(plan.warnings.join(' ')).not.toMatch(/[Pp]layer 30\b/);
    expect(plan.offence.some((o) => o.kind === 'strike')).toBe(false);
    expect(plan.rationale.join(' ')).toMatch(/player 30 is out \(SurrenderAccepted\).*neutral/i);
  });

  it('prices its territories as neutral targets', () => {
    // S holds a cheap T4 (2 armies): with the seat static it is a neutral of 2, taken like one.
    const cheap = { ...input('SurrenderAccepted'), board: board([mine(1, 3), mine(2, 3), mine(3, 6), enemy(4, 2, S), enemy(5, 1, S), neutral(7, 2), enemy(8, 5, A)]) };
    const plan = planTurn(cheap);
    expect(plan.expected.captures).toContain(4);
    expect(plan.moves.find((m) => m.to === 4)?.kind).toBe('attack');
    expect((plan.exchanges ?? []).some((e) => e.to === 4)).toBe(false);
  });

  it('an AI that replaced the player stays an opponent', () => {
    const ai = planTurn(input('SurrenderAccepted', { humanTurnedIntoAI: true }));
    const live = planTurn(input('Playing'));
    expect(ai.deploys).toEqual(live.deploys);
    expect(ai.moves).toEqual(live.moves);
    const byRule = planTurn(input('SurrenderAccepted', {}, { surrenderedTurnIntoAI: true }));
    expect(byRule.deploys).toEqual(live.deploys);
  });

  it('the enemy estimates leave it out', () => {
    const est = (state: string) =>
      planEnemyEstimates({ graph: g, board: now, me: ME, income: 8, settings: STD, game: { players: players(state), turn: 14 }, turn: 14 }).estimates.map(
        (e) => e.playerId,
      );
    expect(est('Playing')).toContain(S);
    expect(est('SurrenderAccepted')).not.toContain(S);
    expect(est('SurrenderAccepted')).toContain(A);
  });
});

describe('the tracker and the outlook (#270)', () => {
  const before = board([mine(1, 3), mine(2, 3), mine(3, 4), enemy(4, 15, S), enemy(5, 10, S), neutral(7, 2), enemy(8, 3, A)]);
  const boards = [
    { turn: 12, board: before },
    { turn: 13, board: board([mine(1, 3), mine(2, 3), mine(3, 5), enemy(4, 18, S), enemy(5, 11, S), neutral(7, 2), enemy(8, 4, A)]) },
    { turn: 14, board: now },
  ];
  it('tracks no static seat, and keeps an AI-played one', () => {
    const out = trackOpponents(g, boards, ME, STD, trackGame(players('SurrenderAccepted'), undefined, undefined, {}));
    expect(out.map((t) => t.playerId)).not.toContain(S);
    expect(out.map((t) => t.playerId)).toContain(A);
    const ai = trackOpponents(g, boards, ME, STD, trackGame(players('SurrenderAccepted', { humanTurnedIntoAI: true }), undefined));
    expect(ai.map((t) => t.playerId)).toContain(S);
  });

  it('the outlook compares me only with players still deploying', () => {
    const outlook = (state: string) => gameOutlook({ graph: g, me: ME, boards, settings: STD, game: trackGame(players(state), undefined) });
    expect(JSON.stringify(outlook('Playing'))).toMatch(/"(?:opponent|playerId|player)":30\b/);
    expect(JSON.stringify(outlook('SurrenderAccepted'))).not.toMatch(/"(?:opponent|playerId|player)":30\b/);
  });
});
