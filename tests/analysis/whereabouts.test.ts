// Where the opponents are and what they are doing (src/analysis/whereabouts.ts). Every map, id
// and number here is made up. Combat is 60% / 70%, no luck: taking 2 neutrals needs 3 armies,
// 3 needs 5, 4 needs 6 and 10 needs 16.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph, type MapGraph } from '../../src/analysis/graph.js';
import type { OpponentTrack, TurnBoard } from '../../src/analysis/opponents.js';
import {
  boardField,
  EXPLAINS_EARLIEST,
  growth,
  GROWTH_WEIGHT,
  INCOME_WEIGHT,
  LAST_SEEN,
  locateOpponents,
  MAX_APPROACHES,
  MAX_PREPARE,
  MAX_START_SETS,
  PRESENCE_CAP,
  reach,
  type OpponentWhereabouts,
  type WhereInput,
  type WhereSettings,
} from '../../src/analysis/whereabouts.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, neutral } from './helpers.js';

const ME = 100;
const FOE = 200;
const THIRD = 300;

type Edge = [number, number];
type BonusSpec = [id: number, value: number, territoryIds: number[]];

function mkGraph(edges: Edge[], bonuses: BonusSpec[] = [], extraIds: number[] = []): MapGraph {
  const ids = [...new Set([...edges.flat(), ...bonuses.flatMap((b) => b[2]), ...extraIds])].sort((a, b) => a - b);
  const map: GameMap = {
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
  return buildGraph(map);
}

/** A line 1–2–…–n. */
const line = (n: number): Edge[] => Array.from({ length: n - 1 }, (_, i) => [i + 1, i + 2] as Edge);

const own = (territoryId: number, armies: number, playerId = ME): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const foe = (territoryId: number, armies: number | null, playerId = FOE): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
  ...(armies === null ? { fogLevel: 'OwnerOnly' } : {}),
});
const at = (turn: number, ...entries: TerritoryState[]): TurnBoard => ({ turn, board: board(entries) });

const STD: WhereSettings = {
  offensiveKillRate: 60,
  defensiveKillRate: 70,
  oneArmyStandsGuard: true,
  baseIncome: 5,
  startingArmies: 5,
  startsPerPlayer: 1,
  neutralArmies: 2,
  distributionNeutralArmies: 4,
};
const DUEL = [{ id: ME }, { id: FOE }];

const locate = (over: Partial<WhereInput> & Pick<WhereInput, 'graph' | 'boards'>) =>
  locateOpponents({ me: ME, players: DUEL, settings: STD, ...over });
const theFoe = (r: ReturnType<typeof locateOpponents>, id = FOE): OpponentWhereabouts => r.opponents.find((o) => o.playerId === id)!;
const likelihoods = (o: OpponentWhereabouts) => new Map(o.starts.likely.map((s) => [s.territoryId, s.likelihood]));
const presenceOf = (o: OpponentWhereabouts, id: number) => o.presence.find((p) => p.territoryId === id);
const sum = (xs: Iterable<number>) => [...xs].reduce((s, x) => s + x, 0);
const pickable = (...territories: number[]) => ({ territories, source: 'pickable' as const });

/** A track with nothing observed, for the fields the model reads. */
function track(over: Partial<OpponentTrack>): OpponentTrack {
  return {
    playerId: FOE,
    firstSeen: null,
    lastTurn: 1,
    turns: [],
    base: 5,
    bonusIncome: 0,
    visibleIncome: 5,
    income: null,
    incomeTurns: [],
    observedRange: null,
    incomeMethod: null,
    incomeLowered: 0,
    unexplained: null,
    inferred: null,
    visible: 0,
    turnsUnseen: 0,
    turnsUnseenAtLeast: false,
    earnedAtLeast: null,
    warnings: [],
    notes: [],
    ...over,
  };
}

describe('starts — before any encounter', () => {
  // I start on 9 of a line of nine; the pickable territories were 1, 4, 7 and 9.
  const graph = mkGraph(line(9));
  const turn1 = at(1, own(9, 5), neutral(8, 2));

  it('with a uniform prior, shares the unknown starts evenly among the candidates left', () => {
    const o = theFoe(locate({ graph, boards: [turn1], settings: { ...STD, startsPerPlayer: 2 }, candidates: pickable(1, 4, 7, 9) }));
    expect(o.starts).toMatchObject({ source: 'pickable', proven: [], ruledOut: [9], unknown: 2, method: 'enumerated', priorOnly: false });
    expect(o.starts.prior).toEqual({ source: 'uniform', sample: null, weak: false });
    const l = likelihoods(o);
    expect([...l.keys()].sort((a, b) => a - b)).toEqual([1, 4, 7]);
    for (const v of l.values()) expect(v).toBeCloseTo(2 / 3, 10);
    expect(sum(l.values())).toBeCloseTo(2, 10);
  });

  it('follows a weighted prior', () => {
    const prior = { weights: new Map([[1, 3], [4, 1], [7, 1]]), source: 'statistics' as const, sample: 12 };
    const one = likelihoods(theFoe(locate({ graph, boards: [turn1], candidates: pickable(1, 4, 7, 9), prior })));
    expect(one.get(1)).toBeCloseTo(0.6, 10);
    expect(one.get(4)).toBeCloseTo(0.2, 10);
    expect(one.get(7)).toBeCloseTo(0.2, 10);

    // Two starts: the sets {1,4}, {1,7}, {4,7} weigh 3, 3 and 1.
    const two = theFoe(locate({ graph, boards: [turn1], settings: { ...STD, startsPerPlayer: 2 }, candidates: pickable(1, 4, 7, 9), prior }));
    const l = likelihoods(two);
    expect(l.get(1)).toBeCloseTo(6 / 7, 10);
    expect(l.get(4)).toBeCloseTo(4 / 7, 10);
    expect(sum(l.values())).toBeCloseTo(2, 10);
    expect(two.starts.prior).toEqual({ source: 'statistics', sample: 12, weak: false });
    // Likeliest first, then by id.
    expect(two.starts.likely.map((s) => s.territoryId)).toEqual([1, 4, 7]);
  });

  it('rules out a candidate any board showed as a neutral', () => {
    const turn2 = at(2, own(9, 3), own(8, 2), neutral(7, 4));
    const o = theFoe(locate({ graph, boards: [turn1, turn2], settings: { ...STD, startsPerPlayer: 2 }, candidates: pickable(1, 4, 7, 9) }));
    expect(o.starts.ruledOut).toEqual([7, 9]);
    expect(likelihoods(o)).toEqual(new Map([[1, 1], [4, 1]]));
  });

  it('gives a proven start likelihood 1, and it takes one of the starts', () => {
    const o = theFoe(
      locate({
        graph,
        boards: [turn1],
        settings: { ...STD, startsPerPlayer: 2 },
        candidates: pickable(1, 4, 7, 9),
        proven: new Map([[FOE, [4]]]),
      }),
    );
    expect(o.starts).toMatchObject({ proven: [4], unknown: 1 });
    const l = likelihoods(o);
    expect(l.get(1)).toBeCloseTo(0.5, 10);
    expect(l.get(7)).toBeCloseTo(0.5, 10);
    expect(l.has(4)).toBe(false);
    // Hidden, and its for certain: present up to the cap.
    expect(presenceOf(o, 4)).toEqual({ territoryId: 4, likelihood: PRESENCE_CAP, basis: ['start'] });
  });

  it('takes what the turn-1 board shows of it as proven: nobody has moved yet', () => {
    const o = theFoe(
      locate({ graph, boards: [at(1, own(9, 5), neutral(8, 2), foe(4, 5))], settings: { ...STD, startsPerPlayer: 2 }, candidates: pickable(1, 4, 7, 9) }),
    );
    expect(o.starts.proven).toEqual([4]);
    expect(o.starts.unknown).toBe(1);
    expect(o.seen.inView).toEqual([{ territoryId: 4, armies: 5 }]);
  });

  it('says so when no candidates are known, and guesses no start', () => {
    const r = locate({ graph, boards: [turn1] });
    const o = theFoe(r);
    expect(o.starts).toMatchObject({ source: 'none', proven: [], likely: [], method: 'none' });
    expect(o.presence).toEqual([]);
    expect(r.assumptions.join(' ')).toMatch(/No start candidates are known/);
  });

  it('guesses no start when the settings do not say how many a player has', () => {
    const { startsPerPlayer: _, ...settings } = STD;
    const o = theFoe(locate({ graph, boards: [turn1], settings, candidates: pickable(1, 4, 7, 9) }));
    expect(o.starts).toMatchObject({ source: 'pickable', likely: [], unknown: null, method: 'none' });
  });
});

describe('starts — an encounter moves the belief', () => {
  // A line of ten. Bonuses: 1–3, 5–7 and (mine) 8–10, +3 each. I start on 10 and walk to 8; on
  // turn 3 the opponent stands on 7.
  const graph = mkGraph(line(10), [
    [901, 3, [1, 2, 3]],
    [902, 3, [5, 6, 7]],
    [903, 3, [8, 9, 10]],
  ]);
  const boards = [
    at(1, own(10, 5), neutral(9, 2)),
    at(2, own(10, 1), own(9, 7), neutral(8, 2)),
    at(3, own(10, 1), own(9, 1), own(8, 3), foe(7, 4)),
  ];

  it('makes a start that cannot reach the sighting in time impossible, and the near one likely', () => {
    const o = theFoe(locate({ graph, boards, candidates: pickable(1, 5, 10) }));
    // From 1 the sighting on turn 3 is six captures away; from 5 it is two.
    expect(o.starts.ruledOut).toEqual([10]);
    expect(o.starts.likely).toEqual([{ territoryId: 5, likelihood: 1 }]);
    expect(o.starts.priorOnly).toBe(false);
  });

  it('puts presence on the start and on the corridor to the sighting', () => {
    const o = theFoe(locate({ graph, boards, candidates: pickable(1, 5, 10) }));
    expect(presenceOf(o, 5)).toEqual({ territoryId: 5, likelihood: PRESENCE_CAP, basis: ['start'] });
    expect(presenceOf(o, 6)).toEqual({ territoryId: 6, likelihood: PRESENCE_CAP, basis: ['corridor', 'growth'] });
    // In view, mine or never on its way: no presence.
    for (const id of [1, 2, 3, 4, 7, 8]) expect(presenceOf(o, id), String(id)).toBeUndefined();
    // The bonus the sighting sits in is probably whole: one member in view, two guessed.
    expect(o.bonuses).toEqual([{ bonusId: 902, likelihood: PRESENCE_CAP, basis: ['start', 'corridor', 'growth'], inView: 1, hidden: 2 }]);
  });

  it('splits a corridor evenly among the territories at the same distance, leaving out what is seen to be neutral', () => {
    // A diamond: 1 – {2, 3} – 4, and my 5 next to 4.
    const diamond = mkGraph([[1, 2], [1, 3], [2, 4], [3, 4], [4, 5]]);
    const open = theFoe(locate({ graph: diamond, boards: [at(3, own(5, 5), foe(4, 3))], candidates: pickable(1) }));
    expect(presenceOf(open, 2)).toEqual({ territoryId: 2, likelihood: 0.5, basis: ['corridor'] });
    expect(presenceOf(open, 3)).toEqual({ territoryId: 3, likelihood: 0.5, basis: ['corridor'] });
    const walled = theFoe(locate({ graph: diamond, boards: [at(3, own(5, 5), foe(4, 3), neutral(3, 2))], candidates: pickable(1) }));
    expect(presenceOf(walled, 2)).toEqual({ territoryId: 2, likelihood: PRESENCE_CAP, basis: ['corridor'] });
    expect(presenceOf(walled, 3)).toBeUndefined();
  });

  it('drops a start set that cannot explain two sightings far apart for one that can', () => {
    // A line of twelve; the opponent shows on both ends on turn 2. Only starts 2 and 11 explain both.
    const long = mkGraph(line(12), [[911, 2, [1, 2]], [912, 2, [11, 12]]], [20]);
    const o = theFoe(
      locate({
        graph: long,
        boards: [at(2, own(20, 5), foe(1, 3), foe(12, 3))],
        settings: { ...STD, startsPerPlayer: 2 },
        candidates: pickable(2, 6, 11),
      }),
    );
    expect(o.starts.likely).toEqual([
      { territoryId: 2, likelihood: 1 },
      { territoryId: 11, likelihood: 1 },
    ]);
  });

  it('falls back to the prior alone when no start set explains what was seen, and says so', () => {
    const r = locate({ graph, boards, candidates: pickable(1, 2) });
    const o = theFoe(r);
    expect(o.starts.priorOnly).toBe(true);
    expect(likelihoods(o)).toEqual(new Map([[1, 0.5], [2, 0.5]]));
    expect(r.assumptions.join(' ')).toMatch(new RegExp(`Player ${FOE}: no start set explains where it was seen`));
  });

  it('weighs "could at the earliest" below "the growth model holds it"', () => {
    // Two candidates either side of the sighting on 4 (turn 3): from 2 the growth model follows
    // its bonus to 4; from 6 it could get there, but its own bonus leads the other way.
    const g = mkGraph(line(8), [[921, 4, [2, 3, 4]], [922, 4, [6, 7, 8]]], [30]);
    const o = theFoe(locate({ graph: g, boards: [at(3, own(30, 5), foe(4, 3))], candidates: pickable(2, 6) }));
    const l = likelihoods(o);
    expect(l.get(2)).toBeCloseTo(1 / (1 + EXPLAINS_EARLIEST), 10);
    expect(l.get(6)).toBeCloseTo(EXPLAINS_EARLIEST / (1 + EXPLAINS_EARLIEST), 10);
    expect(l.get(2)!).toBeGreaterThan(2 * l.get(6)!);
  });
});

describe('reach and growth', () => {
  // 1 – 2 – 3 – 4, and a shortcut 1 – 5 – 4 through my territory 5.
  const graph = mkGraph([[1, 2], [2, 3], [3, 4], [1, 5], [5, 4]]);
  const budget = { armies: 5, income: 5 };

  it('is delayed by a large neutral on the way, by its cost', () => {
    const field = boardField({ graph, boards: [at(3, neutral(2, 10), own(5, 3))], me: ME, settings: STD });
    const r = reach(field, [1], budget);
    expect(r.get(1)).toEqual({ turns: 0, captures: 0, cost: 0, path: [1] });
    // 16 armies for the 10 neutrals: 5 at hand + 5 a turn covers it on turn 3.
    expect(r.get(2)).toEqual({ turns: 3, captures: 1, cost: 16, path: [1, 2] });
    expect(r.get(3)).toEqual({ turns: 3, captures: 2, cost: 19, path: [1, 2, 3] });
    expect(r.get(4)).toEqual({ turns: 4, captures: 3, cost: 22, path: [1, 2, 3, 4] });
  });

  it('never passes through my territories: they are targets', () => {
    const field = boardField({ graph, boards: [at(3, own(5, 3))], me: ME, settings: STD });
    const r = reach(field, [1], budget);
    // Through 5 it would be two captures; the way round is three.
    expect(r.get(4)).toEqual({ turns: 3, captures: 3, cost: 9, path: [1, 2, 3, 4] });
    // My 3 armies on 5 take 5 to capture.
    expect(r.get(5)).toEqual({ turns: 1, captures: 1, cost: 5, path: [1, 5] });
  });

  it('costs an unpicked candidate at the in-distribution size and stops at the horizon', () => {
    const long = mkGraph(line(20));
    const field = boardField({ graph: long, boards: [at(1)], me: ME, settings: STD, candidates: pickable(3) });
    const r = reach(field, [1], budget);
    expect(r.get(2)!.cost).toBe(3);
    expect(r.get(3)!.cost).toBe(3 + 6);
    expect(r.get(13)!.captures).toBe(12);
    expect(r.has(14)).toBe(false);
  });

  it('with no income, reaches only what the armies at hand pay for', () => {
    const field = boardField({ graph, boards: [at(3)], me: ME, settings: STD });
    const r = reach(field, [1], { armies: 5, income: 0 });
    expect(r.get(2)!.turns).toBe(1);
    expect(r.has(3)).toBe(false);
  });

  it('growth takes the bonus with the best value per cost first', () => {
    // 1 touches bonus 931 (+1: territory 2) and bonus 932 (+5: territories 3 and 4).
    const g = mkGraph([[1, 2], [1, 3], [3, 4]], [[931, 1, [2]], [932, 5, [3, 4]]]);
    const field = boardField({ graph: g, boards: [at(1)], me: ME, settings: STD });
    const held = growth(field, 1, 3, { armies: 1, baseIncome: 3 });
    // 4 armies a turn: 3 on turn 1, 4 on turn 2 (the +5 is whole), and only then the +1.
    expect([...held].sort(([a], [b]) => a - b)).toEqual([
      [1, 0],
      [2, 3],
      [3, 1],
      [4, 2],
    ]);
    expect([...growth(field, 1, 1, { armies: 1, baseIncome: 3 }).keys()].sort()).toEqual([1, 3]);
  });

  it('growth never holds what is seen to be neutral or mine', () => {
    const g = mkGraph([[1, 2], [1, 3], [3, 4]], [[931, 1, [2]], [932, 5, [3, 4]]]);
    const field = boardField({ graph: g, boards: [at(4, neutral(3, 2), own(2, 4))], me: ME, settings: STD });
    expect([...growth(field, 1, 3, { armies: 5, baseIncome: 5 }, new Set([3]))]).toEqual([[1, 0]]);
  });
});

describe('presence', () => {
  const graph = mkGraph(line(4));
  const seen = at(2, own(4, 5), own(3, 2), foe(2, 6));
  const hiddenAt = (turn: number) => at(turn, own(4, 5), own(3, 2), fogged(2));

  it('keeps a territory last seen as its own, in a two-player game', () => {
    const o = theFoe(locate({ graph, boards: [seen, hiddenAt(3)] }));
    expect(o.seen).toMatchObject({ inView: [], lastSeen: [{ territoryId: 2, turn: 2, armies: 6 }] });
    expect(presenceOf(o, 2)).toEqual({ territoryId: 2, likelihood: LAST_SEEN.duel, basis: ['last-seen'] });
  });

  it('lets it decay by the turn with three players, down to a floor', () => {
    const players = [...DUEL, { id: THIRD }];
    const after = (turn: number) => presenceOf(theFoe(locate({ graph, players, boards: [seen, hiddenAt(turn)] })), 2)!.likelihood;
    expect(after(3)).toBeCloseTo(0.8, 10);
    expect(after(5)).toBeCloseTo(0.6, 10);
    expect(after(9)).toBeCloseTo(LAST_SEEN.floor, 10);
  });

  it('raises the hidden members of bonuses the income could come from', () => {
    // 902 = {6, 7} is in both combinations that fit its income, 903 = {8} in one.
    const g = mkGraph(line(8), [[902, 4, [6, 7]], [903, 3, [8]]]);
    const inferred = { gap: 4, exact: true, candidates: [{ bonusIds: [902], total: 4, hops: 1 }, { bonusIds: [902, 903], total: 7, hops: 3 }], more: 0, implausible: 0 };
    const o = theFoe(
      locate({ graph: g, boards: [at(5, own(1, 5), own(2, 5), foe(3, 4))], tracks: [track({ firstSeen: 4, income: 9, inferred })] }),
    );
    expect(presenceOf(o, 6)).toEqual({ territoryId: 6, likelihood: INCOME_WEIGHT, basis: ['income'] });
    expect(presenceOf(o, 7)!.likelihood).toBeCloseTo(INCOME_WEIGHT, 10);
    expect(presenceOf(o, 8)!.likelihood).toBeCloseTo(INCOME_WEIGHT / 2, 10);
    expect(o.bonuses.map((b) => [b.bonusId, b.likelihood, b.basis])).toEqual([
      [902, INCOME_WEIGHT, ['income']],
      [903, INCOME_WEIGHT / 2, ['income']],
    ]);
    expect(o.income).toEqual({ estimate: 9, method: null });
  });

  it('counts the combinations the track fits but does not list, as not containing a listed bonus', () => {
    const g = mkGraph(line(8), [[902, 4, [6, 7]], [903, 3, [8]]]);
    const inferred = { gap: 4, exact: true, candidates: [{ bonusIds: [902], total: 4, hops: 1 }, { bonusIds: [902, 903], total: 7, hops: 3 }], more: 2, implausible: 0 };
    const o = theFoe(locate({ graph: g, boards: [at(5, own(1, 5), own(2, 5), foe(3, 4))], tracks: [track({ firstSeen: 4, income: 9, inferred })] }));
    expect(presenceOf(o, 6)!.likelihood).toBeCloseTo(INCOME_WEIGHT / 2, 10);
    expect(presenceOf(o, 8)!.likelihood).toBeCloseTo(INCOME_WEIGHT / 4, 10);
  });

  it('adds growth from a likely start, at a discount', () => {
    // One candidate, turn 2: after one turn the growth model holds 2 as well (bonus 941).
    const g = mkGraph(line(5), [[941, 2, [1, 2]]]);
    const o = theFoe(locate({ graph: g, boards: [at(2, own(5, 5))], candidates: pickable(1) }));
    expect(presenceOf(o, 1)).toEqual({ territoryId: 1, likelihood: PRESENCE_CAP, basis: ['start'] });
    expect(presenceOf(o, 2)).toEqual({ territoryId: 2, likelihood: GROWTH_WEIGHT, basis: ['growth'] });
    expect(presenceOf(o, 3)).toBeUndefined();
  });

  it('never puts presence on a territory shown now as neutral or as someone else\'s', () => {
    const g = mkGraph(line(5), [[941, 2, [1, 2]]]);
    const o = theFoe(locate({ graph: g, players: [...DUEL, { id: THIRD }], boards: [at(2, own(5, 5), neutral(2, 2), foe(1, 5, THIRD))], candidates: pickable(1, 3) }));
    expect(o.presence.map((p) => p.territoryId)).toEqual([3]);
  });
});

describe('approaches', () => {
  // 1 – 2 – 3 – 7 – 6: the opponent's stack on 1, a neutral on 2, my 3 and 7, and 6 in the fog
  // (last seen as its own).
  const graph = mkGraph([[1, 2], [2, 3], [3, 7], [7, 6]]);
  const boards = [at(3, own(3, 4), own(7, 4), foe(6, 4)), at(4, foe(1, 9), neutral(2, 2), own(3, 4), own(7, 4))];

  it('gives the turn, the path and the armies that could arrive from a seen stack two captures away', () => {
    const o = theFoe(locate({ graph, boards }));
    const a = o.approaches.find((x) => x.target === 3)!;
    // 8 movable + 5 this turn − 3 for the neutral, + 5 next turn.
    expect(a).toEqual({ target: 3, turn: 5, inTurns: 1, source: 'seen', from: 1, path: [1, 2, 3], armies: 15, valued: false });
  });

  it('marks an approach from a territory it only probably holds as guessed, with no army count', () => {
    const o = theFoe(locate({ graph, boards }));
    expect(o.approaches[0]).toEqual({ target: 7, turn: 4, inTurns: 0, source: 'guessed', from: 6, path: [6, 7], armies: null, valued: false });
    // Soonest first.
    expect(o.approaches.map((a) => a.target)).toEqual([7, 3]);
  });

  it('uses the tracked income when there is one', () => {
    const o = theFoe(locate({ graph, boards, tracks: [track({ firstSeen: 3, income: 11, incomeMethod: 'max-observed' })] }));
    expect(o.approaches.find((x) => x.target === 3)!.armies).toBe(8 + 11 - 3 + 11);
    expect(o.income).toEqual({ estimate: 11, method: 'max-observed' });
  });

  it('says what it can attack this turn, and with how much', () => {
    const g = mkGraph(line(3));
    const o = theFoe(locate({ graph: g, boards: [at(4, foe(1, 6)), at(5, foe(1, 9), own(2, 4), own(3, 1))] }));
    expect(o.approaches[0]).toMatchObject({ target: 2, turn: 5, inTurns: 0, source: 'seen', from: 1, armies: 13 });
    const texts = o.doing.map((d) => `${d.rule}: ${d.text}`);
    expect(texts).toContainEqual(expect.stringMatching(/^can-attack: Player 200 can attack territory 2 this turn with up to 13 armies from territory 1/));
    expect(texts).toContainEqual(expect.stringMatching(/^stack-grew: Player 200's stack on territory 1, next to your territory 2, grew by 3 to 9 since turn 4/));
  });

  it('puts a territory of a bonus I hold in full first among equally near ones, and lists at most ten', () => {
    // A hub: the opponent's 50 touches twelve territories of mine, 12 of them … 1; 7 and 8 are my bonus.
    const spokes: Edge[] = Array.from({ length: 12 }, (_, i) => [50, i + 1] as Edge);
    const g = mkGraph(spokes, [[951, 2, [7, 8]]]);
    const o = theFoe(locate({ graph: g, boards: [at(6, foe(50, 20), ...Array.from({ length: 12 }, (_, i) => own(i + 1, 2)))] }));
    expect(o.approaches).toHaveLength(MAX_APPROACHES);
    expect(o.approaches.map((a) => a.target)).toEqual([7, 8, 1, 2, 3, 4, 5, 6, 9, 10]);
    expect(o.approaches[0]!.valued).toBe(true);
    // One sentence per stack, however many territories it touches.
    expect(o.doing.filter((d) => d.rule === 'can-attack').map((d) => d.text)).toEqual([
      'Player 200 can attack territories 1, 2, 3, 4, 5 and 7 more this turn with up to 24 armies from territory 50 (what its stack can move plus a deploy of 5).',
    ]);
  });
});

describe('doing', () => {
  it('says an unseen opponent has not been seen, and what it has received at least', () => {
    const graph = mkGraph(line(6));
    const earnedAtLeast = { total: 25, start: 5, baseIncome: 5, turns: 4, largestStack: 6, visibleArmies: 9, exceedsLargest: true, exceedsTotal: true };
    const o = theFoe(locate({ graph, boards: [at(4, own(6, 6), own(5, 3))], tracks: [track({ earnedAtLeast })] }));
    expect(o.doing).toEqual([
      {
        rule: 'unseen',
        text: 'Player 200 has not been seen on any board of yours; it has received at least 25 armies since the game started (received, not held).',
        territoryIds: [],
      },
    ]);
    expect(o.summary).toMatch(/^Player 200: nothing in view/);
  });

  it('names a bonus it is one or two captures from completing in view', () => {
    const graph = mkGraph(line(6), [[961, 4, [1, 2, 3]]]);
    const o = theFoe(locate({ graph, boards: [at(4, foe(1, 3), foe(2, 3), neutral(3, 2), own(4, 5))] }));
    const near = o.doing.find((d) => d.rule === 'near-bonus')!;
    expect(near.text).toBe('Player 200 holds 2 of the 3 territories of bonus 961 (+4): 1 capture from completing it (territory 3).');
    expect(near).toMatchObject({ bonusId: 961, territoryIds: [3] });
  });

  it('names hidden armies the track cannot place when they exceed its income', () => {
    const graph = mkGraph(line(4));
    const boards = [at(4, own(4, 6), foe(3, 2))];
    const hidden = (unexplained: number) => theFoe(locate({ graph, boards, tracks: [track({ firstSeen: 2, income: 8, unexplained })] }));
    expect(hidden(20).doing.find((d) => d.rule === 'hidden-armies')!.text).toMatch(/About 20 of player 200's armies are out of sight.*income of 8/);
    expect(hidden(20).hiddenArmies).toBe(20);
    expect(hidden(8).doing.find((d) => d.rule === 'hidden-armies')).toBeUndefined();
  });
});

describe('prepare', () => {
  it('hold: the armies a territory of a bonus I hold needs against what a seen stack could bring', () => {
    // 1 (its 12) – 2 (neutral) – 3 – 4; I hold bonus 971 = {3, 4}.
    const graph = mkGraph(line(4), [[971, 3, [3, 4]]]);
    const r = locate({ graph, boards: [at(4, foe(1, 12), neutral(2, 2), own(3, 4), own(4, 2))] });
    // 11 movable + 5 − 3, + 5 next turn = 18 arrive; 12 defenders make 18 too few (11 fall to 18).
    expect(r.prepare).toEqual([
      {
        kind: 'hold',
        opponent: FOE,
        turn: 5,
        territory: 3,
        bonusId: 971,
        need: 12,
        have: 4,
        armies: 18,
        from: 1,
        text: 'Territory 3 (in bonus 971, which you hold in full) can be attacked by player 200 on turn 5 with up to 18 armies from territory 1: it needs 12 armies to hold and has 4.',
      },
    ]);
  });

  it('hold: nothing to prepare when it already holds, or the bonus is not whole', () => {
    const graph = mkGraph(line(4), [[971, 3, [3, 4]]]);
    const enough = locate({ graph, boards: [at(4, foe(1, 12), neutral(2, 2), own(3, 12), own(4, 2))] });
    expect(enough.prepare.filter((p) => p.kind === 'hold')).toEqual([]);
    const partial = mkGraph(line(5), [[971, 3, [3, 4, 5]]]);
    const r = locate({ graph: partial, boards: [at(4, foe(1, 12), neutral(2, 2), own(3, 4), own(4, 2), neutral(5, 2))] });
    expect(r.prepare.filter((p) => p.kind === 'hold')).toEqual([]);
  });

  it('hold: judges the soonest attack, not a larger one a turn later', () => {
    // Its 12 on 1 touches my 3 directly, and could also come round through the neutral 2.
    const graph = mkGraph([[1, 3], [1, 2], [2, 3], [3, 4]], [[971, 3, [3, 4]]]);
    const r = locate({ graph, boards: [at(4, foe(1, 12), neutral(2, 0), own(3, 4), own(4, 2))] });
    // This turn: 11 + 5 = 16, which 11 defenders hold. Next turn through 2 it would be 20.
    expect(r.prepare.filter((p) => p.kind === 'hold')).toMatchObject([{ territory: 3, turn: 4, armies: 16, need: 11, have: 4 }]);
  });

  it('hold: my commander\'s territory counts, and the commander defends as seven', () => {
    const graph = mkGraph(line(3));
    const commander = { ...own(2, 2), specialUnits: [{ kind: 'commander' as const, id: 'c', playerId: ME }] };
    const r = locate({ graph, boards: [at(4, foe(1, 12), commander, own(3, 1))] });
    // 11 movable + 5 = 16 arrive: 11 defenders hold; 2 armies and the commander make 9.
    expect(r.prepare[0]).toMatchObject({ kind: 'hold', territory: 2, turn: 4, need: 11, have: 9, armies: 16 });
    expect(r.prepare[0]!.text).toMatch(/Territory 2 \(your commander is there\)/);
  });

  it('contested: a bonus I hold part of, with a missing member it probably holds', () => {
    // I hold 4 of bonus 981 = {3, 4}; 3 is in the fog, last seen as its own.
    const graph = mkGraph(line(4), [[981, 2, [3, 4]]]);
    const r = locate({ graph, boards: [at(3, own(4, 5), foe(3, 4)), at(4, own(4, 5), fogged(3))] });
    expect(r.prepare.find((p) => p.kind === 'contested')).toEqual({
      kind: 'contested',
      opponent: FOE,
      turn: 4,
      territory: 3,
      bonusId: 981,
      likelihood: LAST_SEEN.duel,
      text: 'Bonus 981 (+2): you hold 1 of 2; player 200 may hold territory 3 (likelihood 0.95).',
    });
  });

  it('contested: a missing member a seen stack can take within two turns', () => {
    // Its 9 on 1; 2 and 3 are neutral; I hold 4 of bonus 981 = {3, 4}.
    const graph = mkGraph(line(4), [[981, 2, [3, 4]]]);
    const r = locate({ graph, boards: [at(4, foe(1, 9), neutral(2, 2), neutral(3, 2), own(4, 5))] });
    expect(r.prepare.find((p) => p.kind === 'contested')).toEqual({
      kind: 'contested',
      opponent: FOE,
      turn: 5,
      territory: 3,
      bonusId: 981,
      from: 1,
      text: 'Bonus 981 (+2): you hold 1 of 2; player 200 could take territory 3 by turn 5 from territory 1.',
    });
  });

  it('contested: says so when it holds the missing member in view', () => {
    const graph = mkGraph(line(4), [[981, 2, [3, 4]]]);
    const r = locate({ graph, boards: [at(4, foe(3, 3), own(4, 5))] });
    expect(r.prepare.find((p) => p.kind === 'contested')!.text).toBe('Bonus 981 (+2): you hold 1 of 2; player 200 holds territory 3.');
  });

  it('contested: says when the stack that could take it is itself a guess', () => {
    // 3 is in the fog, last seen as its own; 4 is a neutral in bonus 981 = {4, 5}, of which I hold 5.
    const graph = mkGraph(line(5), [[981, 2, [4, 5]]]);
    const r = locate({ graph, boards: [at(3, own(5, 5), neutral(4, 2), foe(3, 4)), at(4, own(5, 5), neutral(4, 2), fogged(3))] });
    expect(r.prepare.find((p) => p.kind === 'contested')!.text).toBe(
      'Bonus 981 (+2): you hold 1 of 2; player 200 could take territory 4 by turn 4 from territory 3 (guessed).',
    );
  });

  it('contested: leaves out a bonus not worth finishing', () => {
    // I hold one territory of a +2 bonus of thirty: the other 29 would cost 87 armies, far past ten turns of its value.
    const graph = mkGraph(line(31), [[991, 2, Array.from({ length: 30 }, (_, i) => i + 2)]]);
    const r = locate({ graph, boards: [at(4, foe(29, 6), neutral(30, 2), own(31, 5))] });
    expect(r.prepare.filter((p) => p.kind === 'contested')).toEqual([]);
  });

  it('puts what to hold before a contested bonus, and a look last', () => {
    // My bonus 971 = {5, 6} faces its stack on 3 across the neutral 4; I hold 6 of bonus 972 = {6, 7}
    // too, whose 7 is in the fog and may be its start (as 9 may).
    const graph = mkGraph([[3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9]], [[971, 3, [5, 6]], [972, 2, [6, 7]]]);
    const r = locate({ graph, boards: [at(2, foe(3, 12), neutral(4, 2), own(5, 2), own(6, 2))], candidates: pickable(7, 9) });
    expect(r.prepare.map((p) => [p.kind, p.turn, p.territory])).toEqual([
      ['hold', 3, 5],
      ['contested', 2, 7],
      ['scout', 2, 7],
    ]);
  });

  it('scout: a territory whose capture would show a guess that could go either way', () => {
    // Mine 1 – neutral 2 – hidden 3 … 9; the opponent started on 3 or on 9.
    const graph = mkGraph([[1, 2], [2, 3], [3, 8], [8, 9], [2, 10]]);
    const r = locate({ graph, boards: [at(1, own(1, 5), neutral(2, 2))], candidates: pickable(3, 9) });
    expect(r.prepare.find((p) => p.kind === 'scout')).toEqual({
      kind: 'scout',
      opponent: FOE,
      turn: 1,
      territory: 2,
      reveals: [3],
      likelihood: 0.5,
      text: 'Taking territory 2 (it borders your territory 1) would show territory 3, where player 200 may be (likelihood 0.5); it borders 2 hidden territories.',
    });
  });

  it('scout: a hidden territory next to mine is looked at itself', () => {
    const graph = mkGraph([[1, 3], [3, 8], [8, 9]]);
    const r = locate({ graph, boards: [at(1, own(1, 5))], candidates: pickable(3, 9) });
    expect(r.prepare.find((p) => p.kind === 'scout')).toMatchObject({ territory: 3, reveals: [3] });
    expect(r.prepare.find((p) => p.kind === 'scout')!.text).toMatch(/^Territory 3 borders your territory 1 and is hidden: player 200 may be there \(likelihood 0.5\)/);
  });

  it('lists the most urgent first, at most ten', () => {
    // A hub of mine around its stack: every spoke is a one-territory bonus I hold.
    const spokes: Edge[] = Array.from({ length: 14 }, (_, i) => [50, i + 1] as Edge);
    const g = mkGraph(spokes, Array.from({ length: 14 }, (_, i) => [900 + i, 1, [i + 1]] as BonusSpec));
    const r = locate({ graph: g, boards: [at(6, foe(50, 20), ...Array.from({ length: 14 }, (_, i) => own(i + 1, i < 2 ? 1 : 2)))] });
    expect(r.prepare).toHaveLength(MAX_PREPARE);
    expect(r.prepare.every((p) => p.kind === 'hold')).toBe(true);
    // The same turn for all: the one shortest of armies first, then by id.
    expect(r.prepare.slice(0, 3).map((p) => p.territory)).toEqual([1, 2, 3]);
  });
});

describe('who is an opponent, and determinism', () => {
  const graph = mkGraph(line(10), [[902, 3, [5, 6, 7]]]);
  const boards = [at(2, own(10, 5), own(9, 2)), at(3, own(10, 1), own(9, 1), own(8, 3), foe(7, 4))];

  it('gives the same output for the same input', () => {
    const input = { graph, boards, candidates: pickable(1, 5, 10), players: [...DUEL, { id: THIRD }] };
    expect(locate(input)).toEqual(locate(input));
    expect(JSON.stringify(locate(input))).toBe(JSON.stringify(locate({ ...input, boards: [...boards].reverse() })));
  });

  it('with no opponents, returns an empty result', () => {
    const r = locate({ graph, boards: [at(2, own(10, 5))], players: [{ id: ME }] });
    expect(r.opponents).toEqual([]);
    expect(r.prepare).toEqual([]);
    expect(locate({ graph, boards: [] })).toMatchObject({ turn: null, opponents: [], prepare: [] });
  });

  it('does not count a teammate, in view or not', () => {
    const players = [
      { id: ME, team: 0 },
      { id: FOE, team: 1 },
      { id: THIRD, team: 0 },
    ];
    const r = locate({ graph, players, boards: [at(3, own(10, 1), own(9, 1, THIRD), foe(7, 4))] });
    expect(r.opponents.map((o) => o.playerId)).toEqual([FOE]);
  });

  it('lists an opponent out of the game only while it still holds territory in view', () => {
    const players = [...DUEL, { id: THIRD, state: 'Eliminated' }];
    expect(locate({ graph, players, boards }).opponents.map((o) => o.playerId)).toEqual([FOE]);
    const still = [at(3, own(10, 1), foe(7, 4), foe(1, 2, THIRD))];
    expect(locate({ graph, players, boards: still }).opponents.map((o) => o.playerId)).toEqual([FOE, THIRD]);
  });

  it('states what it assumes, the prior with its sample included', () => {
    const prior = { weights: new Map([[1, 3]]), source: 'statistics' as const, sample: 3, weak: true };
    const text = locate({ graph, boards, candidates: pickable(1, 5, 10), prior }).assumptions.join('\n');
    expect(text).toMatch(/not measured probabilities/);
    expect(text).toMatch(/pool/i);
    expect(text).toMatch(/one capture per turn/);
    expect(text).toMatch(/never abandoned/);
    expect(text).toMatch(/Blockade/);
    expect(text).toMatch(/3 finished games.*weak/);
    expect(text).toMatch(/3 territories the live board showed as pickable/);
    // My oldest board here is turn 2.
    expect(text).toMatch(/oldest board is turn 2/);
  });
});

describe('above the enumeration limit', () => {
  // A line of 45: forty candidates, three starts each: 9880 sets.
  const graph = mkGraph(line(45));
  const settings = { ...STD, startsPerPlayer: 3 };
  const candidates = pickable(...Array.from({ length: 40 }, (_, i) => i + 1));

  it('weighs candidates one by one, and the likelihoods still sum to the starts', () => {
    const r = locate({ graph, boards: [at(1, own(45, 5))], settings, candidates });
    const o = theFoe(r);
    expect(o.starts.method).toBe('independent');
    expect(o.starts.likely).toHaveLength(40);
    for (const s of o.starts.likely) expect(s.likelihood).toBeCloseTo(3 / 40, 10);
    expect(r.assumptions.join(' ')).toMatch(new RegExp(`more than ${MAX_START_SETS} start sets`));
  });

  it('caps a likelihood at 1 and shares the rest', () => {
    const prior = { weights: new Map([[7, 10_000]]), source: 'statistics' as const, sample: 40 };
    const o = theFoe(locate({ graph, boards: [at(1, own(45, 5))], settings, candidates, prior }));
    const l = likelihoods(o);
    expect(l.get(7)).toBe(1);
    expect(sum(l.values())).toBeCloseTo(3, 10);
    expect(Math.max(...l.values())).toBeLessThanOrEqual(1);
    expect(l.get(1)).toBeCloseTo(2 / 39, 10);
  });

  it('still moves toward a sighting', () => {
    // Seen on 41 on turn 2: only a start on 40 is one capture away.
    const o = theFoe(locate({ graph, boards: [at(2, own(45, 5), own(44, 2), foe(41, 3))], settings, candidates }));
    const l = likelihoods(o);
    expect(o.starts.method).toBe('independent');
    expect(sum(l.values())).toBeCloseTo(3, 10);
    expect(l.get(40)!).toBeGreaterThan(5 * l.get(1)!);
    expect(o.starts.likely[0]!.territoryId).toBe(40);
  });
});
