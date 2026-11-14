// #94: an opponent still in the game with no territory in view is the most dangerous case (a
// 1v1 opponent stayed fogged for 11 turns and came out with a 556-army stack). Given the game's
// players, the tracker lists every opponent still playing — visible or not — with how many of
// its territories are in view and for how many turns it has been out of sight; an opponent with
// nothing in view gets a lower bound on the armies it has received since the game started
// (its starting armies + the base income every turn), and a warning when that bound beats my
// largest stack or my total visible armies. Synthetic map, ids and names only.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { trackGame, trackOpponents, type TrackGame, type TurnBoard } from '../../src/analysis/opponents.js';
import { planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import { gameProfile } from '../../src/analysis/profile.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const BASE = 5;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, baseIncome: BASE };

/** A line 1 ─ 2 ─ … ─ 8, one +3 bonus on {7, 8} (never counted for an unseen opponent). */
function line(): GameMap {
  const ids = [1, 2, 3, 4, 5, 6, 7, 8];
  return {
    id: 1,
    name: 'Synthetic line',
    territories: ids.map((id) => ({ id, name: `T${id}`, connectedTo: ids.filter((x) => Math.abs(x - id) === 1) })),
    bonuses: [{ id: 901, name: 'B901', value: 3, territoryIds: [7, 8], bonusIds: [] }],
    distributionModes: [],
  };
}
const g = buildGraph(line());

const enemy = (territoryId: number, armies: number, playerId = ENEMY): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const FOG = [3, 4, 5, 6, 7, 8].map(fogged);
/** My T1/T2 at the given counts, everything else fogged. */
const hidden = (t1 = 5, t2 = 5): BoardState => board([mine(1, t1), mine(2, t2), ...FOG]);
/** My T1/T2 at 5, the enemy's T3 in view at `armies`. */
const seen = (armies: number): BoardState => board([mine(1, 5), mine(2, 5), enemy(3, armies), ...FOG.slice(1)]);
const history = (...boards: [number, BoardState][]): TurnBoard[] => boards.map(([turn, b]) => ({ turn, board: b }));

/** A 1v1: me and the enemy (named), starting with 3 territories of 2 armies each. */
const GAME: TrackGame = {
  players: [
    { id: ME, name: 'Me', state: 'Playing' },
    { id: ENEMY, name: 'Zed', state: 'Playing' },
  ],
  start: { territories: 3, armiesPerTerritory: 2 },
};

describe('trackOpponents: unseen opponents (#94)', () => {
  it('a never-seen 1v1 opponent at turn 3 is listed with visible 0, turnsUnseen 3 and the received lower bound', () => {
    const [t, ...rest] = trackOpponents(g, history([1, hidden()], [2, hidden()], [3, hidden()]), ME, STD, GAME);
    expect(rest).toEqual([]);
    // Start 3 territories × 2 armies = 6; base income 5 for each of turns 1, 2 and 3 (the
    // turn being played has already paid its income) = 15. 6 + 15 = 21.
    expect(t).toMatchObject({ playerId: ENEMY, visible: 0, turnsUnseen: 3, firstSeen: null, turns: [] });
    expect(t!.earnedAtLeast).toMatchObject({ total: 21, start: 6, baseIncome: 5, turns: 3 });
    expect(t!.notes.join(' ')).toMatch(/at least 21 armies/);
    expect(t!.notes.join(' ')).toMatch(/could be banking up to roughly this, minus what its expansion cost/);
  });

  it('never counts a bonus it might hold: only the base income', () => {
    const [t] = trackOpponents(g, history([3, hidden()]), ME, STD, GAME);
    expect(t!.earnedAtLeast!.baseIncome).toBe(BASE);
  });

  it('starting armies unknown: the term is left out and the note says so', () => {
    const [t] = trackOpponents(g, history([1, hidden()], [2, hidden()], [3, hidden()]), ME, STD, {
      players: GAME.players,
      startUnknown: 'the settings do not give the starting armies',
    });
    // Base income only: 3 turns × 5 = 15.
    expect(t!.earnedAtLeast).toMatchObject({ total: 15, start: null });
    expect(t!.notes.join(' ')).toMatch(/starting armies are not counted: the settings do not give the starting armies/);
  });

  it('seen, then fogged for 2 turns: turnsUnseen 2', () => {
    const [t] = trackOpponents(g, history([1, seen(4)], [2, hidden()], [3, hidden()]), ME, STD, GAME);
    expect(t).toMatchObject({ playerId: ENEMY, visible: 0, turnsUnseen: 2, firstSeen: 1 });
    expect(t!.earnedAtLeast!.total).toBe(21);
    expect(t!.notes.join(' ')).toMatch(/out of sight for 2 turns/);
  });

  it('a partly visible opponent gets only the new fields: visible count, turnsUnseen 0, no bound', () => {
    const now = board([mine(1, 5), mine(2, 5), enemy(3, 4), enemy(4, 2), ...FOG.slice(2)]);
    const [t] = trackOpponents(g, history([2, now], [3, now]), ME, STD, GAME);
    expect(t).toMatchObject({ playerId: ENEMY, visible: 2, turnsUnseen: 0, earnedAtLeast: null, warnings: [] });
    const [without] = trackOpponents(g, history([2, now], [3, now]), ME, STD);
    expect({ ...t, notes: [] }).toEqual({ ...without, notes: [] });
  });

  it('warns when the bound exceeds my largest stack, and separately my total visible armies', () => {
    // Bound 21. My 5 + 5: both warnings.
    const [both] = trackOpponents(g, history([1, hidden()], [2, hidden()], [3, hidden()]), ME, STD, GAME);
    expect(both!.warnings).toEqual([
      'Player Zed has been out of sight for 3 turns and has received at least 21 armies since the game started (starting armies 6 + base income 5 × 3 turns); it could be banking a stack larger than your largest (5).',
      'Player Zed has been out of sight for 3 turns and has received at least 21 armies since the game started (starting armies 6 + base income 5 × 3 turns); it could be banking more than your total visible armies (10).',
    ]);
    expect(both!.earnedAtLeast).toMatchObject({ largestStack: 5, visibleArmies: 10, exceedsLargest: true, exceedsTotal: true });
    // My 20 + 5: only the largest-stack warning (21 > 20, 21 ≤ 25).
    const [largest] = trackOpponents(g, history([1, hidden()], [2, hidden()], [3, hidden(20, 5)]), ME, STD, GAME);
    expect(largest!.warnings).toHaveLength(1);
    expect(largest!.warnings[0]).toMatch(/larger than your largest \(20\)/);
    // My 30 + 5: no warning.
    const [none] = trackOpponents(g, history([1, hidden()], [2, hidden()], [3, hidden(30, 5)]), ME, STD, GAME);
    expect(none!.warnings).toEqual([]);
    expect(none!.earnedAtLeast).toMatchObject({ total: 21, exceedsLargest: false, exceedsTotal: false });
  });

  it('the base-income-only bound says so in the warning', () => {
    const [t] = trackOpponents(g, history([3, hidden()]), ME, STD, { players: GAME.players, startUnknown: 'unknown' });
    expect(t!.warnings[0]).toMatch(/received at least 15 armies since the game started \(base income 5 × 3 turns\)/);
  });

  it('teammates and eliminated or surrendered players are not listed', () => {
    const game: TrackGame = {
      players: [
        { id: ME, team: 0 },
        { id: 11, team: 0 },
        { id: ENEMY, team: 1 },
        { id: 30, team: 1, state: 'Eliminated' },
        { id: 40, team: 1, state: 'SurrenderAccepted' },
      ],
      start: GAME.start!,
    };
    const tracks = trackOpponents(g, history([3, hidden()]), ME, STD, game);
    expect(tracks.map((t) => t.playerId)).toEqual([ENEMY]);
  });

  it('visible opponents come first (by id), then the unseen ones (by id); without names, ids', () => {
    const now = board([mine(1, 5), mine(2, 5), enemy(3, 4, 30), ...FOG.slice(1)]);
    const tracks = trackOpponents(g, history([3, now]), ME, STD, {
      players: [{ id: ME }, { id: 25 }, { id: 30 }, { id: ENEMY }],
      start: GAME.start!,
    });
    expect(tracks.map((t) => [t.playerId, t.visible])).toEqual([
      [30, 1],
      [ENEMY, 0],
      [25, 0],
    ]);
    expect(tracks.find((t) => t.playerId === 25)!.warnings[0]).toMatch(/^Player 25 has been out of sight/);
  });

  it('is deterministic', () => {
    const h = history([3, hidden()], [1, hidden()], [2, hidden()]);
    expect(trackOpponents(g, h, ME, STD, GAME)).toEqual(trackOpponents(g, [...h].reverse(), ME, STD, GAME));
  });
});

describe('the profile and the planner mention an unseen opponent (#94)', () => {
  it("the 'unknown' standing note gives the unseen opponent's lower bound", () => {
    const p = gameProfile({
      graph: g,
      board: hidden(),
      me: ME,
      players: [{ id: ME }, { id: ENEMY }],
      turn: 3,
      income: 5,
      estimates: [],
      unseen: [{ playerId: ENEMY, turnsUnseen: 3, earnedAtLeast: 21 }],
    });
    expect(p.standing).toBe('unknown');
    expect(p.notes.join(' ')).toMatch(
      /Standing unknown: no opponent is in sight.*Player 20 has been out of sight for 3 turns and has received at least 21 armies/,
    );
  });

  it('planTurn feeds the tracks to the profile', () => {
    const boards = history([1, hidden()], [2, hidden()], [3, hidden()]);
    const tracks = trackOpponents(g, boards, ME, STD, GAME);
    const plan = planTurn({
      graph: g,
      board: hidden(),
      me: ME,
      income: 5,
      settings: STD,
      turn: 3,
      tracks,
      game: { players: [{ id: ME }, { id: ENEMY }], turn: 3 },
    });
    expect(plan.profile.notes.join(' ')).toMatch(/Player 20 has been out of sight for 3 turns and has received at least 21 armies/);
  });
});

describe('turnsUnseen when my boards do not cover the whole game (#94 review)', () => {
  it('a history that starts after turn 1: a floor counted from the oldest board, said as one', () => {
    // Boards for turns 5..15 only, none showing it: it may have been in view on turn 4 or
    // earlier, so all I know is turns 5..15 = 11 turns.
    const boards = history(...Array.from({ length: 11 }, (_, i): [number, BoardState] => [5 + i, hidden()]));
    const [t] = trackOpponents(g, boards, ME, STD, GAME);
    expect(t).toMatchObject({ visible: 0, turnsUnseen: 11, turnsUnseenAtLeast: true });
    // The bound does not depend on the boards: start 6 + 15 turns × 5 = 81.
    expect(t!.earnedAtLeast).toMatchObject({ total: 81, turns: 15 });
    expect(t!.warnings[0]).toMatch(/^Player Zed has been out of sight for at least 11 turns \(no board of mine for turn 4\) and has received at least 81 armies/);
    expect(t!.notes.join(' ')).toMatch(/out of sight for at least 11 turns \(no board of mine for turn 4\)/);
  });

  it('only the current board at turn 8: at least 1 turn, never 8', () => {
    const [t] = trackOpponents(g, history([8, hidden()]), ME, STD, GAME);
    expect(t).toMatchObject({ turnsUnseen: 1, turnsUnseenAtLeast: true });
    expect(t!.warnings[0]).toMatch(/out of sight for at least 1 turn \(no board of mine for turn 7\)/);
  });

  it('a gap after it was last seen: counted back to the gap only', () => {
    // Seen on turn 1, no boards for turns 2 and 3, hidden on 4 and 5: at least 2 turns.
    const [t] = trackOpponents(g, history([1, seen(4)], [4, hidden()], [5, hidden()]), ME, STD, GAME);
    expect(t).toMatchObject({ turnsUnseen: 2, turnsUnseenAtLeast: true });
  });

  it('boards from turn 1 on, or back to the board that last showed it: exact', () => {
    const [never] = trackOpponents(g, history([1, hidden()], [2, hidden()], [3, hidden()]), ME, STD, GAME);
    expect(never).toMatchObject({ turnsUnseen: 3, turnsUnseenAtLeast: false });
    const [fogged] = trackOpponents(g, history([1, seen(4)], [2, hidden()], [3, hidden()]), ME, STD, GAME);
    expect(fogged).toMatchObject({ turnsUnseen: 2, turnsUnseenAtLeast: false });
    expect(fogged!.warnings[0]).toMatch(/out of sight for 2 turns and/);
  });

  it('the profile note keeps the floor', () => {
    const p = gameProfile({
      graph: g,
      board: hidden(),
      me: ME,
      players: [{ id: ME }, { id: ENEMY }],
      turn: 8,
      income: 5,
      estimates: [],
      unseen: [{ playerId: ENEMY, turnsUnseen: 1, turnsUnseenAtLeast: true, earnedAtLeast: 46 }],
    });
    expect(p.notes.join(' ')).toMatch(
      /Player 20 has been out of sight for at least 1 turn and has received at least 46 armies: it could be banking up to roughly that, minus what its expansion cost\./,
    );
  });
});

describe('trackGame and the caveats on the bound (#94 review)', () => {
  it('full distribution (DistributionMode -1) leaves the starting armies out', () => {
    const game = trackGame(GAME.players, { territoryLimit: 3, initialPlayerArmiesPerTerritory: 2, distributionMode: -1, cards: [] });
    expect(game.start).toBeUndefined();
    expect(game.startUnknown).toMatch(/full distribution/);
  });

  it('#205: with the starts unknown under an even split, keeps the armies per starting territory for an upper bound', () => {
    expect(trackGame(GAME.players, { territoryLimit: 3, initialPlayerArmiesPerTerritory: 2, distributionMode: -1, cards: [] }).startArmiesPerTerritory).toBe(2);
    expect(trackGame(GAME.players, { initialPlayerArmiesPerTerritory: 4, distributionMode: 0, cards: [] }).startArmiesPerTerritory).toBe(4);
    // A scenario sets its own starts, and without the armies per territory there is nothing to bound.
    const scenario = { distributionModes: [{ id: 7, name: 'Scenario', type: 'scenario' }] };
    expect(trackGame(GAME.players, { initialPlayerArmiesPerTerritory: 4, distributionMode: 7, cards: [] }, scenario).startArmiesPerTerritory).toBeUndefined();
    expect(trackGame(GAME.players, { territoryLimit: 3, distributionMode: -1, cards: [] }).startArmiesPerTerritory).toBeUndefined();
    // Known starts need no ceiling.
    expect(trackGame(GAME.players, { territoryLimit: 3, initialPlayerArmiesPerTerritory: 2, distributionMode: 0, cards: [] }).startArmiesPerTerritory).toBeUndefined();
  });

  it('#214 review: says when the even share is the real start (full distribution), not only a bound', () => {
    expect(trackGame(GAME.players, { territoryLimit: 3, initialPlayerArmiesPerTerritory: 2, distributionMode: -1, cards: [] }).fullDistribution).toBe(true);
    // Without TerritoryLimit the share is only a bound: picks may have granted far fewer.
    expect(trackGame(GAME.players, { initialPlayerArmiesPerTerritory: 4, distributionMode: 0, cards: [] }).fullDistribution).toBeUndefined();
    expect(trackGame(GAME.players, { territoryLimit: 3, initialPlayerArmiesPerTerritory: 2, distributionMode: 0, cards: [] }).fullDistribution).toBeUndefined();
  });

  it('manual or automatic distribution keeps TerritoryLimit × InitialPlayerArmiesPerTerritory', () => {
    const game = trackGame(GAME.players, { territoryLimit: 3, initialPlayerArmiesPerTerritory: 2, distributionMode: 0, cards: [] });
    expect(game.start).toEqual({ territories: 3, armiesPerTerritory: 2 });
  });

  it('the Sanctions card: the note says the base-income floor may not hold', () => {
    const game = trackGame(GAME.players, { territoryLimit: 3, initialPlayerArmiesPerTerritory: 2, cards: ['Sanctions'] });
    const [t] = trackOpponents(g, history([3, hidden()]), ME, STD, game);
    expect(t!.notes.join(' ')).toMatch(/base income each turn may not hold: .*Sanctions card/);
  });

  it('a map with a negative bonus: the note says the base-income floor may not hold', () => {
    const m = line();
    const neg = buildGraph({ ...m, bonuses: [...m.bonuses, { id: 902, name: 'B902', value: -2, territoryIds: [5, 6], bonusIds: [] }] });
    const [t] = trackOpponents(neg, history([3, hidden()]), ME, STD, GAME);
    expect(t!.notes.join(' ')).toMatch(/base income each turn may not hold: .*negative-value bonus/);
    const [plain] = trackOpponents(g, history([3, hidden()]), ME, STD, GAME);
    expect(plain!.notes.join(' ')).not.toMatch(/may not hold/);
  });
});

describe('teammates in view (#94 review)', () => {
  it('a visible teammate is not listed', () => {
    const now = board([mine(1, 5), mine(2, 5), enemy(3, 4, 11), enemy(4, 3), ...FOG.slice(2)]);
    const game: TrackGame = { players: [{ id: ME, team: 0 }, { id: 11, team: 0 }, { id: ENEMY, team: 1 }], start: GAME.start! };
    expect(trackOpponents(g, history([3, now]), ME, STD, game).map((t) => t.playerId)).toEqual([ENEMY]);
    // Without the game, everyone in view is listed as before.
    expect(trackOpponents(g, history([3, now]), ME, STD).map((t) => t.playerId)).toEqual([11, ENEMY]);
  });
});
