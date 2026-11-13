import { describe, expect, it } from 'vitest';
import { mapStats, MIN_SAMPLE, recordFromGame, type GameRecord } from '../src/map-stats.js';
import type { Game, GameMap } from '../src/normalize.js';

// A made-up 6-territory map: bonus 1 = {1,2} (+2), bonus 2 = {3,4} (+2),
// bonus 3 = {5,6} (+1), bonus 9 = {1,2,3,4,5,6} (0, never "completed").
const MAP: GameMap = {
  id: 777,
  name: 'Test Map',
  territories: [1, 2, 3, 4, 5, 6].map((id) => ({ id, name: `T${id}`, connectedTo: [] })),
  bonuses: [
    { id: 1, name: 'North', value: 2, territoryIds: [1, 2], bonusIds: [] },
    { id: 2, name: 'South', value: 2, territoryIds: [3, 4], bonusIds: [] },
    { id: 3, name: 'East', value: 1, territoryIds: [5, 6], bonusIds: [] },
    { id: 9, name: 'All', value: 0, territoryIds: [1, 2, 3, 4, 5, 6], bonusIds: [] },
  ],
  distributionModes: [],
};

const A = 1001;
const B = 1002;
const owner = (id: number | 'Neutral') => id;
/** A standing: territory → owner. */
const standing = (owners: Record<number, number | 'Neutral'>) =>
  Object.entries(owners).map(([t, o]) => ({ terrID: t, ownedBy: String(owner(o)), armies: '2', fogLevel: 'Visible' }));

function finishedGame(id: number, history: unknown, winner: number = A): Game {
  return {
    id,
    state: 'Finished',
    players: [A, B].map((p) => ({
      id: p,
      name: `p${p}`,
      isAI: false,
      humanTurnedIntoAI: false,
      hasCommittedOrders: false,
      state: p === winner ? 'Won' : 'Eliminated',
    })),
    map: MAP,
    history,
  };
}

// Picks: A takes 1 and 3, B takes 4 and 5. A completes North on turn 2; B never completes.
const HISTORY = [
  { turnNumber: '0', standing: standing({ 1: A, 2: 'Neutral', 3: A, 4: B, 5: B, 6: 'Neutral' }) },
  { turnNumber: '1', standing: standing({ 1: A, 2: 'Neutral', 3: A, 4: B, 5: B, 6: 'Neutral' }) },
  { turnNumber: '2', standing: standing({ 1: A, 2: A, 3: A, 4: B, 5: B, 6: 'Neutral' }) },
];

describe('recordFromGame', () => {
  it('reads each player’s starts, anchor bonus, win and first bonus turn', () => {
    const r = recordFromGame(finishedGame(5, HISTORY), MAP);
    expect(r).toEqual({
      gameId: 5,
      mapId: 777,
      turnsSeen: 3,
      players: [
        { playerId: A, won: true, starts: [1, 3], anchorBonusId: 1, firstBonusTurn: 2 },
        { playerId: B, won: false, starts: [4, 5], anchorBonusId: 2, firstBonusTurn: null },
      ],
    });
  });

  it('starts from the first standing where players own land (skips the pick-phase board)', () => {
    const r = recordFromGame(
      finishedGame(5, [
        { turnNumber: 0, standing: standing({ 1: 'Neutral', 2: 'Neutral', 3: 'Neutral', 4: 'Neutral', 5: 'Neutral', 6: 'Neutral' }) },
        ...HISTORY.map((h) => ({ ...h, turnNumber: Number(h.turnNumber) + 1 })),
      ]),
      MAP,
    );
    expect(r.players[0]!.starts).toEqual([1, 3]);
    expect(r.players[0]!.firstBonusTurn).toBe(3);
  });

  it('a game with no usable history still records its winner, with no starts', () => {
    const r = recordFromGame(finishedGame(6, 'garbage'), MAP);
    expect(r.turnsSeen).toBe(0);
    expect(r.players.map((p) => [p.won, p.starts, p.anchorBonusId, p.firstBonusTurn])).toEqual([
      [true, [], null, null],
      [false, [], null, null],
    ]);
  });
});

/** n games where A (anchored on North) wins `aWins` of them. */
function sample(n: number, aWins: number, mapId = 777, idBase = 100): GameRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    gameId: idBase + i,
    mapId,
    turnsSeen: 3,
    players: [
      { playerId: A, won: i < aWins, starts: [1, 3], anchorBonusId: 1, firstBonusTurn: 2 },
      { playerId: B, won: i >= aWins, starts: [4, 5], anchorBonusId: 2, firstBonusTurn: i % 2 ? 4 : null },
    ],
  }));
}

describe('mapStats', () => {
  it('groups by map and counts the sample', () => {
    const s = mapStats([...sample(6, 4), ...sample(2, 1, 888, 900)]);
    expect(s.map((m) => [m.mapId, m.sampleSize])).toEqual([
      [777, 6],
      [888, 2],
    ]);
  });

  it('ranks the most-picked starting territories (ties on ascending id)', () => {
    const [m] = mapStats(sample(6, 4));
    expect(m!.mostPicked.slice(0, 2)).toEqual([
      { territoryId: 1, picks: 6, pickRate: 1, winnerPicks: 4 },
      { territoryId: 3, picks: 6, pickRate: 1, winnerPicks: 4 },
    ]);
  });

  it('gives the win rate by starting bonus', () => {
    const [m] = mapStats(sample(6, 4));
    expect(m!.winRateByStartingBonus).toEqual([
      { bonusId: 1, players: 6, wins: 4, winRate: 0.67, lowSample: false },
      { bonusId: 2, players: 6, wins: 2, winRate: 0.33, lowSample: false },
    ]);
  });

  it('summarises the turn of each player’s first bonus completion', () => {
    const [m] = mapStats(sample(6, 4));
    expect(m!.firstBonusTurn).toEqual({
      players: 12,
      completed: 9,
      neverCompleted: 3,
      median: 2,
      byTurn: [
        { turn: 2, players: 6 },
        { turn: 4, players: 3 },
      ],
      winnersMedian: 2,
    });
  });

  it(`flags every rate on fewer than ${MIN_SAMPLE} games and says so`, () => {
    const [m] = mapStats(sample(MIN_SAMPLE - 1, 2));
    expect(m!.lowSample).toBe(true);
    expect(m!.note).toMatch(new RegExp(`fewer than ${MIN_SAMPLE}`));
    expect(m!.winRateByStartingBonus.every((b) => b.lowSample)).toBe(true);
  });

  it('a sample of exactly the minimum is not flagged', () => {
    const [m] = mapStats(sample(MIN_SAMPLE, 2));
    expect(m!.lowSample).toBe(false);
    expect(m!.note).toBeUndefined();
  });

  it('is deterministic whatever the input order', () => {
    const recs = sample(7, 3);
    expect(mapStats([...recs].reverse())).toEqual(mapStats(recs));
  });

  it('counts a game id once', () => {
    const [m] = mapStats([...sample(5, 2), ...sample(5, 2)]);
    expect(m!.sampleSize).toBe(5);
  });

  it('nothing in, nothing out', () => {
    expect(mapStats([])).toEqual([]);
  });
});
