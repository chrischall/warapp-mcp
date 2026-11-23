// #427: when the game does not fog card plays, the last turn's orders show every Reinforcement play
// (VERIFIED live 2026-11-22: an opponent's GameOrderPlayCardReinforcement in the LatestGameInfo's
// GameTurn, with none of its deploys in view). A seen play restarts that opponent's card clock; a turn
// whose orders were read and show no play is no play, whatever its deploy looked like. With no plays
// read (card plays fogged), nothing changes.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { trackOpponents, type OpponentTrack } from '../../src/analysis/opponents.js';
import { enemyDeployEstimates, planTurn, type PlannerSettings, type ReinforcementPlays } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine } from './helpers.js';

const ME = 10;
const FOE = 20;
const OTHER = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  return {
    id: 1,
    name: 'Cardland',
    territories: ids.map((id) => ({ id, name: `T${id}`, connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)) })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const foe = (territoryId: number, armies: number, playerId = FOE): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId }, armies });
const plays = (read: number[], seen: [number, number][]): ReinforcementPlays => ({ read, plays: seen.map(([player, turn]) => ({ player, turn })) });

describe('a seen Reinforcement play restarts the card clock (#427)', () => {
  const g = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [2, 3], [3, 4]]));
  const b = board([mine(1, 5), mine(2, 5), foe(3, 4), foe(4, 4)]);
  const clock = { firstTurn: 4, armies: 6, turnsPerCard: 3 };
  const est = (turn: number, seen?: ReinforcementPlays, tracks?: OpponentTrack[], r: typeof clock | { firstTurn: number; armies: number; turnsPerCard: null } = clock) =>
    enemyDeployEstimates(g, b, ME, STD, undefined, tracks, undefined, { turn, fog: 'Foggy', reinforcement: r, ...(seen ? { plays: seen } : {}) }).find((e) => e.playerId === FOE)!;

  it('with no plays read the clock runs as before: a card from turn 4 on, every turn', () => {
    expect(est(6).card).toEqual({ armies: 6, due: 4 });
    expect(est(6).estimate).toBe(11);
    expect(est(6, plays([], [])).card).toEqual({ armies: 6, due: 4 });
  });
  it('a play seen on turn 5 ends the card until the next can be due: its capturing turns after the play', () => {
    const seen = plays([4, 5], [[FOE, 5]]);
    expect(est(6, seen).card).toBeNull();
    expect(est(6, seen).cardPlayed).toBe(5);
    expect(est(6, seen).cardSeen).toBe(true);
    expect(est(6, seen).estimate).toBe(5);
    expect(est(7, seen).card).toBeNull();
    expect(est(8, seen).card).toEqual({ armies: 6, due: 8 });
  });
  it('a play seen before the clock says a card can be in hand still counts (the clock runs at the expected rate)', () => {
    const seen = plays([2, 3], [[FOE, 3]]);
    expect(est(4, seen).card).toBeNull();
    expect(est(5, seen).card).toBeNull();
    expect(est(6, seen).card).toEqual({ armies: 6, due: 6 });
  });
  it("another player's play leaves this one's clock alone", () => {
    expect(est(6, plays([5], [[OTHER, 5]])).card).toEqual({ armies: 6, due: 4 });
  });
  it('where only one card ever comes (one card total), a seen play ends it for the game', () => {
    const once = { firstTurn: 2, armies: 6, turnsPerCard: null };
    expect(est(9, undefined, undefined, once).card).toEqual({ armies: 6, due: 2 });
    expect(est(9, plays([3], [[FOE, 3]]), undefined, once).card).toBeNull();
    expect(est(30, plays([3], [[FOE, 3]]), undefined, once).card).toBeNull();
  });
  it('a turn whose orders were read and show no play is no play, though its deploy jumped over the income', () => {
    // Turn 5 it deployed 11 on an income of 5: read as a play from the jump alone, unless that turn was read.
    const turns: OpponentTrack['turns'] = [4, 5].map((from) => ({
      from, to: from + 1, observed: from === 5 ? 11 : 5, raw: from === 5 ? 11 : 5, cap: 20, counted: [], captured: [], fromFog: [], reveals: [], visibleIncome: 5, earned: 5, net: 0, losses: 0, fogArmies: 0, measured: 0, broken: [], brokenValue: 0, low: from === 5 ? 11 : 5, high: from === 5 ? 11 : 5, reinforced: [], grewFromFog: [], emptied: [], combat: 0,
    }));
    const tr: OpponentTrack[] = [{ ...trackOf(turns) }];
    expect(est(6, undefined, tr).cardPlayed).toBe(5);
    expect(est(6, undefined, tr).card).toBeNull();
    const read = est(6, plays([4, 5], []), tr);
    expect(read.cardPlayed).toBeNull();
    expect(read.card).toEqual({ armies: 6, due: 4 });
    // A turn not read still reads the jump.
    expect(est(6, plays([4], []), tr).cardPlayed).toBe(5);
  });
  it('the plan says the play was seen in the orders, not inferred from a deploy', () => {
    const seen = plays([5], [[FOE, 5]]);
    const plan = planTurn({ graph: g, board: b, me: ME, income: 5, settings: STD, turn: 6, game: { turn: 6, fog: 'Foggy', reinforcement: clock, reinforcementPlays: seen } });
    const text = plan.warnings.join('\n');
    expect(text).toMatch(/player 20 played a Reinforcement card on turn 5 \(seen in that turn's orders: card plays are not fogged in this game\), so none is added until the next can be due: turn 8/i);
    expect(text).not.toMatch(/taken as played/);
    const later = planTurn({ graph: g, board: b, me: ME, income: 5, settings: STD, turn: 9, game: { turn: 9, fog: 'Foggy', reinforcement: clock, reinforcementPlays: seen } });
    expect(later.warnings.join('\n')).toMatch(/player 20 may hold a Reinforcement card from turn 8 \(the card clock; it last played one on turn 5, seen in the orders\)/i);
  });
});

describe('a seen play is the card in a tracked figure; a read turn without one is income (#427)', () => {
  // The #427 line: me on 1 2, the opponent on 3 4 (income 5) and 5-8 fogged with a +10 bonus on 7 8. It
  // deploys 5 a turn, except turn 4: 11.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7, 8], [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8]], [[101, 10, [7, 8]]]));
  const deploys = [5, 5, 5, 11, 5, 5, 5];
  const boards: { turn: number; board: ReturnType<typeof board> }[] = [];
  let a3 = 3;
  for (let t = 1; t <= deploys.length; t++) {
    boards.push({ turn: t, board: board([mine(1, 5), mine(2, 50), foe(3, a3), foe(4, 2), fogged(5), fogged(6), fogged(7), fogged(8)]) });
    a3 += deploys[t - 1]!;
  }
  const clock = { firstTurn: 3, armies: 6, turnsPerCard: 3 };
  const at = (seen: ReinforcementPlays) => {
    const tracks = trackOpponents(g, boards, ME, STD);
    return enemyDeployEstimates(g, boards[6]!.board, ME, STD, boards[5]!.board, tracks, undefined, { turn: 7, fog: 'Foggy', reinforcement: clock, plays: seen }).find((x) => x.playerId === FOE)!;
  };
  const all = [1, 2, 3, 4, 5, 6];

  it('the play seen on turn 4 is taken out of the tracked 11: income 5, the next card due on turn 7', () => {
    const e = at(plays(all, [[FOE, 4]]));
    expect(e.cardInTrack).toEqual({ was: 11, income: 5, armies: 6, turns: [4] });
    expect(e.card).toEqual({ armies: 6, due: 7 });
    expect(e.estimate).toBe(11);
  });
  it('with every turn read and no play seen, the 11 was income: it stands, and the clock adds a card on top', () => {
    const e = at(plays(all, []));
    expect(e.cardInTrack ?? null).toBeNull();
    expect(e.cardPlayed).toBeNull();
    expect(e.estimate).toBe(17);
  });
});

function trackOf(turns: OpponentTrack['turns']): OpponentTrack {
  return {
    playerId: FOE,
    firstSeen: 1,
    lastTurn: 6,
    turns,
    base: 5,
    bonusIncome: 0,
    visibleIncome: 5,
    income: 5,
    incomeTurns: [4, 5],
    observedRange: { min: 5, max: 5 },
    incomeMethod: 'max-observed',
    incomeLowered: 0,
    unexplained: 0,
    inferred: null,
    visible: 1,
    turnsUnseen: 0,
    turnsUnseenAtLeast: false,
    earnedAtLeast: null,
    warnings: [],
    notes: [],
  };
}
