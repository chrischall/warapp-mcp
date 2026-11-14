// Issue #164: the threat model's fog gaps, each on a synthetic map (every id and name is made up).
//  - income is exact when the fog shows every owner (No, Light and Dense fog);
//  - an enemy territory next to me whose armies the fog hides is a threat of a bounded size;
//  - an opponent's Reinforcement card, from the card clock, until a deployment above its income is seen;
//  - a large stack that left view, from its last sighting, at each border it can reach.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { LOST_STACK_TURNS, MAX_LOST_STACKS, trackOpponents, type OpponentTrack } from '../../src/analysis/opponents.js';
import { defaultEnemyDeploy, enemyDeployEstimates, planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Fogland',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const foe = (territoryId: number, armies: number, playerId = FOE): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
/** A territory whose owner shows and whose armies the fog hides (Dense / Heavy fog). */
const ownerOnly = (territoryId: number, playerId = FOE): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies: null,
  fogLevel: 'OwnerOnly',
});
const why = (p: { rationale: string[]; warnings: string[] }) => [...p.rationale, ...p.warnings].join('\n');
const deployedTo = (p: { deploys: { territoryId: number; armies: number }[] }, id: number) =>
  p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;

/** A hand-built track (observed over two turns) with `unexplained` armies and, optionally, stacks that left view. */
function track(playerId: number, o: { income?: number; unexplained?: number | null; lostStacks?: OpponentTrack['lostStacks']; turns?: OpponentTrack['turns'] } = {}): OpponentTrack {
  const income = o.income ?? 5;
  const turn = { from: 0, to: 1, observed: income, raw: income, cap: income, counted: [], captured: [], fromFog: [], reveals: [], visibleIncome: income, earned: income, net: 0, losses: 0, fogArmies: 0, measured: 0, broken: [], brokenValue: 0, low: income, high: income, reinforced: [], grewFromFog: [], emptied: [], combat: 0 };
  return {
    playerId,
    firstSeen: 1,
    lastTurn: 3,
    turns: o.turns ?? [
      { ...turn, from: 1, to: 2 },
      { ...turn, from: 2, to: 3 },
    ],
    base: income,
    bonusIncome: 0,
    visibleIncome: income,
    income,
    incomeTurns: [1, 2],
    observedRange: { min: income, max: income },
    incomeMethod: 'max-observed',
    incomeLowered: 0,
    unexplained: o.unexplained === undefined ? 0 : o.unexplained,
    inferred: null,
    visible: 1,
    turnsUnseen: 0,
    turnsUnseenAtLeast: false,
    earnedAtLeast: null,
    warnings: [],
    notes: [],
    ...(o.lostStacks ? { lostStacks: o.lostStacks } : {}),
  };
}

describe('income is exact when the fog shows every owner (#164)', () => {
  // 1 2 mine; 3 4 5 6 the opponent's, holding bonus 101 (+4) = 5 6.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5, 6], [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6]], [[101, 4, [5, 6]]]));
  const before = board([mine(1, 5), mine(2, 5), foe(3, 2), foe(4, 2), foe(5, 2), foe(6, 2)]);
  // It grew +15 over territories visible on both boards: more than base 5 + bonus 4.
  const after = board([mine(1, 5), mine(2, 5), foe(3, 10), foe(4, 5), foe(5, 4), foe(6, 4)]);
  const at = (fog: string | undefined, b = after) =>
    enemyDeployEstimates(g, b, ME, STD, before, undefined, undefined, { turn: 6, ...(fog ? { fog } : {}) }).find((e) => e.playerId === FOE)!;

  for (const fog of ['NoFog', 'LightFog', 'ModerateFog'])
    it(`${fog}: the estimate is base + held bonuses exactly, labelled exact, not the observed growth`, () => {
      const e = at(fog);
      expect(e.source).toBe('exact');
      expect(e.exact).toBe(9);
      expect(e.estimate).toBe(9);
    });
  it('under Normal and Heavy fog (and with no fog setting) it is not labelled exact', () => {
    for (const fog of ['Foggy', 'VeryFoggy', 'ExtremeFog', undefined]) {
      const e = at(fog);
      expect(e.source).toBe('visible');
      expect(e.exact).toBeNull();
      expect(e.observedRaw).toBe(15);
    }
  });
  it('exact income takes no floor: a base income below the default stands', () => {
    const e = enemyDeployEstimates(g, after, ME, { ...STD, baseIncome: 2 }, before, undefined, undefined, { turn: 6, fog: 'NoFog' }).find((x) => x.playerId === FOE)!;
    expect(e.estimate).toBe(6);
  });
  it('a board missing an owner (a fogged territory) is not exact, whatever the setting says', () => {
    const partial = board([mine(1, 5), mine(2, 5), foe(3, 10), foe(4, 5), foe(5, 4), fogged(6)]);
    expect(at('LightFog', partial).source).not.toBe('exact');
  });
  it("owner-only territories still count: Dense fog's hidden armies do not stop the income being exact", () => {
    const dense = board([mine(1, 5), mine(2, 5), ownerOnly(3), ownerOnly(4), ownerOnly(5), ownerOnly(6)]);
    const e = enemyDeployEstimates(g, dense, ME, STD, undefined, undefined, undefined, { turn: 6, fog: 'ModerateFog' }).find((x) => x.playerId === FOE)!;
    expect(e.source).toBe('exact');
    expect(e.estimate).toBe(9);
  });
  it('the plan names the exact figure and what it leaves out', () => {
    const plan = planTurn({ graph: g, board: after, previousBoard: before, me: ME, income: 5, settings: STD, turn: 6, game: { turn: 6, fog: 'LightFog' } });
    expect(plan.warnings.join('\n')).toMatch(/player 20: ~9 \(exact: .*every territory's owner shows/);
    expect(plan.warnings.join('\n')).toMatch(/army cap, Sanctions and a Reinforcement card/);
  });
});

describe("an opponent's Reinforcement card, from the card clock (#164)", () => {
  const g = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [2, 3], [3, 4]], []));
  const b = board([mine(1, 5), mine(2, 5), foe(3, 4), foe(4, 4)]);
  const clock = { firstTurn: 4, armies: 6, turnsPerCard: 3 };
  const est = (turn: number, tracks?: OpponentTrack[], fog = 'NoFog') =>
    enemyDeployEstimates(g, b, ME, STD, undefined, tracks, undefined, { turn, fog, reinforcement: clock }).find((e) => e.playerId === FOE)!;

  it('before the first turn a card can be in hand, nothing is added', () => {
    const e = est(3);
    expect(e.card).toBeNull();
    expect(e.estimate).toBe(5);
  });
  it('from that turn on, its armies are added to the deploy', () => {
    const e = est(4);
    expect(e.card).toEqual({ armies: 6, due: 4 });
    expect(e.estimate).toBe(11);
    expect(est(9).estimate).toBe(11);
  });
  it('a deployment above its income ends it, until the next card can be due', () => {
    // Turn 5 it deployed 11 (income 5): the card was played. The second card is due on turn 4 + 3.
    const turns: OpponentTrack['turns'] = [4, 5].map((from) => ({
      from, to: from + 1, observed: from === 5 ? 11 : 5, raw: from === 5 ? 11 : 5, cap: 20, counted: [], captured: [], fromFog: [], reveals: [], visibleIncome: 5, earned: 5, net: 0, losses: 0, fogArmies: 0, measured: 0, broken: [], brokenValue: 0, low: from === 5 ? 11 : 5, high: from === 5 ? 11 : 5, reinforced: [], grewFromFog: [], emptied: [], combat: 0,
    }));
    const tr = [track(FOE, { turns })];
    expect(est(6, tr).card).toBeNull();
    expect(est(6, tr).cardPlayed).toBe(5);
    expect(est(7, tr).card).toEqual({ armies: 6, due: 7 });
  });
  it('defaultEnemyDeploy takes the clock and the fog too, and agrees with the plan', () => {
    const when = { turn: 5, fog: 'NoFog', reinforcement: clock };
    const plan = planTurn({ graph: g, board: b, me: ME, income: 5, settings: STD, turn: 5, game: { turn: 5, fog: 'NoFog', reinforcement: clock } });
    expect(defaultEnemyDeploy(g, b, ME, STD, undefined, undefined, undefined, when)).toBe(11);
    expect(defaultEnemyDeploy(g, b, ME, STD, undefined, undefined, undefined, when)).toBe(plan.enemyDeploy);
  });
  it('the plan says where the extra armies come from, and that one card at most is counted', () => {
    const plan = planTurn({ graph: g, board: b, me: ME, income: 5, settings: STD, turn: 5, game: { turn: 5, fog: 'NoFog', reinforcement: clock } });
    expect(plan.warnings.join('\n')).toMatch(/Reinforcement card from turn 4 .*\+6/);
    expect(plan.warnings.join('\n')).toMatch(/one card at most is counted, though more may be in hand/);
  });
  it('under fog a play read from a jump over the visible income is named: hidden income looks the same', () => {
    const turns: OpponentTrack['turns'] = [4, 5].map((from) => ({
      from, to: from + 1, observed: from === 5 ? 11 : 5, raw: from === 5 ? 11 : 5, cap: 20, counted: [], captured: [], fromFog: [], reveals: [], visibleIncome: 5, earned: 5, net: 0, losses: 0, fogArmies: 0, measured: 0, broken: [], brokenValue: 0, low: from === 5 ? 11 : 5, high: from === 5 ? 11 : 5, reinforced: [], grewFromFog: [], emptied: [], combat: 0,
    }));
    const tr = [track(FOE, { turns })];
    expect(est(6, tr, 'Foggy').card).toBeNull();
    const plan = planTurn({ graph: g, board: b, me: ME, income: 5, settings: STD, turn: 6, game: { turn: 6, fog: 'Foggy', reinforcement: clock }, tracks: tr });
    expect(plan.warnings.join('\n')).toMatch(/player 20's Reinforcement card is taken as played on turn 5 .*income the fog hides can look the same.*errs low/i);
  });
  it('a tracked income is printed as tracked: the card is named on top of it, not folded into it', () => {
    const plan = planTurn({ graph: g, board: b, me: ME, income: 5, settings: STD, turn: 6, game: { turn: 6, fog: 'Foggy', reinforcement: clock }, tracks: [track(FOE, { income: 8 })] });
    const text = plan.warnings.join('\n');
    expect(text).toMatch(/player 20: ~8 \(tracked over 2 observed turns, more than [^)]*\), plus \+6 from its Reinforcement card/);
    expect(text).not.toMatch(/player 20: ~14 \(tracked/);
  });
});

describe('Dense and Heavy fog: an enemy next to me whose armies are hidden (#164)', () => {
  // 1 2 mine (bonus 101, +6); 3 the opponent's, armies hidden, next to 2; 4 the opponent's behind it.
  const g = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [2, 3], [3, 4]], [[101, 6, [1, 2]]]));
  const b = board([mine(1, 1), mine(2, 3), ownerOnly(3), ownerOnly(4)]);
  it('it is a threat (its deploy at least), not unseen land: the held bonus is defended', () => {
    const plan = planTurn({ graph: g, board: b, me: ME, income: 10, settings: STD, turn: 6, game: { turn: 6, fog: 'VeryFoggy' }, options: { goal: 'defend' } });
    // 5 deploy + 0 hidden (no track: the guard alone) -> 3 armies need 5 to take: 3 + d must beat 5.
    expect(deployedTo(plan, 2)).toBeGreaterThan(0);
    expect(why(plan)).toMatch(/armies are hidden/);
    expect(why(plan)).toMatch(/win chance .* unknown/);
  });
  it("the tracker's unaccounted armies bound the hidden stack, and the hold is sized for them", () => {
    const small = planTurn({ graph: g, board: b, me: ME, income: 30, settings: STD, turn: 6, game: { turn: 6, fog: 'VeryFoggy' }, tracks: [track(FOE, { unexplained: 0 })], options: { goal: 'defend' } });
    const big = planTurn({ graph: g, board: b, me: ME, income: 30, settings: STD, turn: 6, game: { turn: 6, fog: 'VeryFoggy' }, tracks: [track(FOE, { unexplained: 10 })], options: { goal: 'defend' } });
    expect(why(small)).toMatch(/Deploy 1 to T2 \(#2\) so it holds .*above the ~5 threat/);
    expect(why(big)).toMatch(/Deploy 7 to T2 \(#2\) so it holds .*above the ~15 threat/);
    expect(why(big)).toMatch(/up to 10/);
  });
  it("several hidden neighbours of one opponent share its unaccounted armies: counted once, not once per stack", () => {
    // 2 borders 2, 3 or 4 hidden territories of the same opponent: its 10 unaccounted armies are in
    // one place at most, so the threat on 2 stays ~15 (10 + its ~5 deploy) however many there are.
    for (const k of [2, 3, 4]) {
      const ids = [1, 2, ...Array.from({ length: k }, (_, i) => 3 + i)];
      const edges: [number, number][] = [[1, 2], ...Array.from({ length: k }, (_, i) => [2, 3 + i] as [number, number])];
      const gk = buildGraph(makeMap(ids, edges, [[101, 6, [1, 2]]]));
      const bk = board([mine(1, 1), mine(2, 3), ...Array.from({ length: k }, (_, i) => ownerOnly(3 + i))]);
      const plan = planTurn({ graph: gk, board: bk, me: ME, income: 60, settings: STD, turn: 6, game: { turn: 6, fog: 'ModerateFog' }, tracks: [track(FOE, { unexplained: 10 })], options: { goal: 'defend' } });
      expect(why(plan), `${k} hidden neighbours`).toMatch(/Deploy 7 to T2 \(#2\) so it holds .*above the ~15 threat/);
    }
  });
  it('defaultEnemyDeploy counts an opponent whose only border with me is hidden, as the plan does', () => {
    const big = board([mine(1, 1), mine(2, 3), ownerOnly(3), ownerOnly(4), foe(5, 2)]);
    const g5 = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [2, 3], [3, 4], [4, 5]], [[101, 6, [1, 2]], [102, 7, [3, 4, 5]]]));
    const when = { turn: 6, fog: 'ModerateFog' };
    const plan = planTurn({ graph: g5, board: big, me: ME, income: 10, settings: STD, turn: 6, game: when });
    // Base 5 + bonus 102's 7, exact under Dense fog: bordering me only through a hidden territory.
    expect(defaultEnemyDeploy(g5, big, ME, STD, undefined, undefined, undefined, when)).toBe(12);
    expect(plan.enemyDeploy).toBe(12);
  });
  it('no attack goes into it: its defenders are unknown', () => {
    const b2 = board([mine(1, 1), mine(2, 40), ownerOnly(3), ownerOnly(4)]);
    const plan = planTurn({ graph: g, board: b2, me: ME, income: 10, settings: STD, turn: 6, game: { turn: 6, fog: 'VeryFoggy' } });
    expect(plan.moves.filter((m) => m.kind === 'attack' && m.to === 3)).toEqual([]);
  });
});

describe('stacks that leave view (#164)', () => {
  // A line: 1 (mine) - 2 - 3 - 4 - 5 - 6; 7 a spare neutral next to 1.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7], [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [1, 7]], [[101, 3, [1, 7]]]));
  it('the tracker keeps a large stack its last territory and turn once it is hidden', () => {
    const seen = board([mine(1, 5), mine(7, 2), neutral(2, 2), neutral(3, 2), foe(4, 3), foe(5, 30), foe(6, 2)]);
    const gone = board([mine(1, 5), mine(7, 2), neutral(2, 2), fogged(3), fogged(4), fogged(5), fogged(6)]);
    const tracks = trackOpponents(g, [
      { turn: 3, board: seen },
      { turn: 4, board: gone },
    ], ME, STD, { players: [{ id: ME }, { id: FOE }] });
    const t = tracks.find((x) => x.playerId === FOE)!;
    expect(t.lostStacks).toEqual([{ territoryId: 5, turn: 3, armies: 30 }]);
  });
  it('a stack seen again where it stood (its territory in view, the stack still there) is not lost', () => {
    // (A stack seen again much smaller, its armies gone into the fog, did leave view: see the Normal fog cases.)
    const seen = board([mine(1, 5), mine(7, 2), neutral(2, 2), neutral(3, 2), foe(4, 3), foe(5, 30), foe(6, 2)]);
    const back = board([mine(1, 5), mine(7, 2), neutral(2, 2), fogged(3), fogged(4), foe(5, 30), fogged(6)]);
    const t = trackOpponents(g, [
      { turn: 3, board: seen },
      { turn: 4, board: back },
    ], ME, STD, { players: [{ id: ME }, { id: FOE }] }).find((x) => x.playerId === FOE)!;
    expect(t.lostStacks).toEqual([]);
  });
  it('a stack that moved into view elsewhere is not lost: it is the stack in view', () => {
    // 1 2 7 8 mine-ish: 8 borders 1 and 2. Turn 3: its 30 on 3, next to my 2. Turn 4: the 30 took my
    // 2 and stands there in view; 3 and 8 are fogged. The 30 on 2 is the one from 3.
    const g2 = buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7, 8], [[1, 2], [1, 7], [1, 8], [2, 3], [2, 8], [3, 4], [4, 5], [5, 6]], [[101, 3, [1, 7]]]));
    const b3 = board([mine(1, 5), mine(7, 2), mine(2, 3), foe(3, 30), fogged(4), fogged(5), fogged(6), foe(8, 2)]);
    const b4 = board([mine(1, 5), mine(7, 2), foe(2, 30), fogged(3), fogged(4), fogged(5), fogged(6), fogged(8)]);
    const tracks = trackOpponents(g2, [
      { turn: 3, board: b3 },
      { turn: 4, board: b4 },
    ], ME, STD, { players: [{ id: ME }, { id: FOE }] });
    expect(tracks.find((x) => x.playerId === FOE)!.lostStacks).toEqual([]);
    const plan = planTurn({ graph: g2, board: b4, me: ME, income: 60, settings: STD, turn: 5, game: { turn: 5 }, tracks, options: { goal: 'defend' } });
    expect(why(plan)).not.toMatch(/left view/);
  });
  it('a stack that stayed in view does not explain another that left it', () => {
    // Turn 3: 30 on 5 and 25 on 3. Turn 4: the 25 still on 3, 5 fogged: the 30 is lost.
    const seen = board([mine(1, 5), mine(7, 2), neutral(2, 2), foe(3, 25), foe(4, 3), foe(5, 30), foe(6, 2)]);
    const gone = board([mine(1, 5), mine(7, 2), neutral(2, 2), foe(3, 25), fogged(4), fogged(5), fogged(6)]);
    const t = trackOpponents(g, [
      { turn: 3, board: seen },
      { turn: 4, board: gone },
    ], ME, STD, { players: [{ id: ME }, { id: FOE }] }).find((x) => x.playerId === FOE)!;
    expect(t.lostStacks).toEqual([{ territoryId: 5, turn: 3, armies: 30 }]);
  });
  it('a stack too far away to be the one in view stays lost', () => {
    // Turn 3: 30 on 6. Turn 4: a 20 shows up on 3, three hops from 6: one move a turn cannot get there.
    const seen = board([mine(1, 5), mine(7, 2), neutral(2, 2), neutral(3, 2), foe(4, 3), foe(5, 2), foe(6, 30)]);
    const later = board([mine(1, 5), mine(7, 2), neutral(2, 2), foe(3, 20), fogged(4), fogged(5), fogged(6)]);
    const t = trackOpponents(g, [
      { turn: 3, board: seen },
      { turn: 4, board: later },
    ], ME, STD, { players: [{ id: ME }, { id: FOE }] }).find((x) => x.playerId === FOE)!;
    expect(t.lostStacks).toEqual([{ territoryId: 6, turn: 3, armies: 30 }]);
  });
  it('part of a stack in view elsewhere offsets it: the rest stays lost while still large', () => {
    // Turn 3: 40 on 4. Turn 4: 15 of it on 3 in view (my 2 between), 4 fogged: 25 may still be out there.
    const seen = board([mine(1, 5), mine(7, 2), neutral(2, 2), neutral(3, 2), foe(4, 40), foe(5, 2), foe(6, 2)]);
    const later = board([mine(1, 5), mine(7, 2), neutral(2, 2), foe(3, 15), fogged(4), fogged(5), fogged(6)]);
    const t = trackOpponents(g, [
      { turn: 3, board: seen },
      { turn: 4, board: later },
    ], ME, STD, { players: [{ id: ME }, { id: FOE }] }).find((x) => x.playerId === FOE)!;
    expect(t.lostStacks).toEqual([{ territoryId: 4, turn: 3, armies: 25 }]);
  });
  it(`at most ${MAX_LOST_STACKS} lost stacks are kept per opponent, the largest`, () => {
    // A star: my 1 in the middle, 2..8 the opponent's, each a large stack that turn 4 hides.
    const ids = [1, 2, 3, 4, 5, 6, 7, 8];
    const gs = buildGraph(makeMap(ids, ids.slice(1).map((id) => [1, id] as [number, number]), []));
    const seen = board([mine(1, 5), ...ids.slice(1).map((id) => foe(id, 20 + id))]);
    const gone = board([mine(1, 5), ...ids.slice(1).map((id) => fogged(id))]);
    const t = trackOpponents(gs, [
      { turn: 3, board: seen },
      { turn: 4, board: gone },
    ], ME, STD, { players: [{ id: ME }, { id: FOE }] }).find((x) => x.playerId === FOE)!;
    expect(t.lostStacks!.map((l) => l.territoryId)).toEqual([8, 7, 6, 5, 4]);
  });
  // Now 2 and 3 are fogged: the stack, last seen on 5 on turn 3, is 3 hops from 2 (next to my 1).
  const now = board([mine(1, 5), mine(7, 2), fogged(2), fogged(3), fogged(4), fogged(5), fogged(6)]);
  const lost = [track(FOE, { lostStacks: [{ territoryId: 5, turn: 3, armies: 30 }] })];
  it('before it can arrive, it is no threat', () => {
    // Turn 4: one move since turn 3, it can stand on 4 at most: not next to 1.
    const plan = planTurn({ graph: g, board: now, me: ME, income: 5, settings: STD, turn: 4, game: { turn: 4 }, tracks: lost, options: { goal: 'defend' } });
    expect(why(plan)).not.toMatch(/left view/);
    expect(why(plan)).not.toMatch(/so it holds/);
  });
  it('from its earliest arrival it is a labelled threat on that border', () => {
    // Turn 6: three moves since turn 3, it can stand on 2 and attack 1.
    const plan = planTurn({ graph: g, board: now, me: ME, income: 20, settings: STD, turn: 6, game: { turn: 6 }, tracks: lost, options: { goal: 'defend' } });
    expect(why(plan)).toMatch(/30 armies last seen on T5 \(#5\) on turn 3 left view.*T1 \(#1\) from turn 6/);
    // 29 movable + the ~5 deploy (no estimate for an opponent out of view: the floor).
    expect(why(plan)).toMatch(/~34 threat/);
  });
  it(`a stack out of view for more than ${LOST_STACK_TURNS} turns is no longer counted`, () => {
    const last = 3 + LOST_STACK_TURNS;
    const at = (turn: number) => planTurn({ graph: g, board: now, me: ME, income: 20, settings: STD, turn, game: { turn }, tracks: lost, options: { goal: 'defend' } });
    expect(why(at(last))).toMatch(/left view/);
    expect(why(at(last + 1))).not.toMatch(/left view/);
  });
});

describe('Dense fog over many turns: the hidden pool is not lifetime earnings (#164 review)', () => {
  // A 20-territory line. I hold 1-3; the opponent holds 4.. (owner shown, armies hidden) and takes
  // one hidden neutral a turn eastwards. Exact income 5 (base, no bonus of its). My bonus 1-3 (+3).
  const N = 20;
  const ids = Array.from({ length: N }, (_, i) => i + 1);
  const gl = buildGraph(makeMap(ids, ids.slice(1).map((i) => [i - 1, i] as [number, number]), [[101, 3, [1, 2, 3]]]));
  const hiddenNeutral = (territoryId: number): TerritoryState => ({ territoryId, owner: { kind: 'neutral' }, armies: null, fogLevel: 'OwnerOnly' });
  const at = (turn: number) =>
    board(ids.map((id) => (id <= 3 ? mine(id, 5) : id < 7 + turn ? ownerOnly(id) : hiddenNeutral(id))));
  const history = Array.from({ length: 10 }, (_, i) => ({ turn: i + 2, board: at(i + 2) }));
  const tracks = trackOpponents(gl, history, ME, STD, { players: [{ id: ME }, { id: FOE }] });
  const t = tracks.find((x) => x.playerId === FOE)!;
  it('each owner-only territory it visibly took is credited: the guard left there and what the capture cost', () => {
    // 9 turns × (5 earned − 1 guard left − 1 the hidden neutral cost at least) = 27, not 45.
    expect(t.unexplained).toBe(27);
  });
  it('the hidden stack is bounded by a few turns of its income, so the border is held, not conceded', () => {
    const plan = planTurn({ graph: gl, board: at(11), me: ME, income: 6, settings: STD, turn: 12, game: { turn: 12, fog: 'ModerateFog' }, tracks, options: { goal: 'defend' } });
    expect(why(plan)).toMatch(/up to 10 armies there .*at most 2 turns of its income/);
    expect(deployedTo(plan, 3)).toBeGreaterThan(0);
    expect(why(plan)).not.toMatch(/conceded/);
    // Uncapped (all 27 at T4), holding T3 would cost more than its bonus is worth: conceded.
    const uncapped = planTurn({ graph: gl, board: at(11), me: ME, income: 6, settings: STD, turn: 12, game: { turn: 12, fog: 'ModerateFog' }, tracks: tracks.map((x) => ({ ...x, unexplained: 27, income: 14 })), options: { goal: 'defend' } });
    expect(why(uncapped)).toMatch(/up to 27 armies/);
  });
});

describe('stacks that leave view under Normal fog (#164 review)', () => {
  // A line: 1 (mine) - 2 - 3 - 4 - 5 - 6; 7 a spare neutral next to 1. Normal fog: what borders me shows.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7], [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [1, 7]], [[101, 3, [1, 7]]]));
  const players = { players: [{ id: ME }, { id: FOE }] };
  it('a large stack that shrank where I can see it, its armies gone into the fog, left view', () => {
    // Turn 3: 30 on 2, next to my 1. Turn 4: 2 still shows, with 2; 3 behind it is fogged: 28 left.
    const seen = board([mine(1, 5), mine(7, 2), foe(2, 30), fogged(3), fogged(4), fogged(5), fogged(6)]);
    const shrank = board([mine(1, 5), mine(7, 2), foe(2, 2), fogged(3), fogged(4), fogged(5), fogged(6)]);
    const t = trackOpponents(g, [
      { turn: 3, board: seen },
      { turn: 4, board: shrank },
    ], ME, STD, players).find((x) => x.playerId === FOE)!;
    expect(t.lostStacks).toEqual([{ territoryId: 2, turn: 3, armies: 29 }]);
  });
  it('armies that moved to a territory of its in view did not leave it', () => {
    const g2 = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [1, 3], [2, 3], [3, 4]], []));
    const seen = board([mine(1, 5), foe(2, 30), foe(3, 4), fogged(4)]);
    const moved = board([mine(1, 5), foe(2, 2), foe(3, 32), fogged(4)]);
    const t = trackOpponents(g2, [
      { turn: 3, board: seen },
      { turn: 4, board: moved },
    ], ME, STD, players).find((x) => x.playerId === FOE)!;
    expect(t.lostStacks).toEqual([]);
  });
  it('a stack that shrank beside a fight (another stack next to it shrank too) is not taken as gone', () => {
    const seen = board([mine(1, 20), mine(7, 2), foe(2, 30), fogged(3), fogged(4), fogged(5), fogged(6)]);
    const fought = board([mine(1, 4), mine(7, 2), foe(2, 8), fogged(3), fogged(4), fogged(5), fogged(6)]);
    const t = trackOpponents(g, [
      { turn: 3, board: seen },
      { turn: 4, board: fought },
    ], ME, STD, players).find((x) => x.playerId === FOE)!;
    expect(t.lostStacks).toEqual([]);
  });
  it('a lost stack that can stand next to my border by next turn is warned of a turn ahead', () => {
    // Normal fog: 2 (next to my 1) shows a 2-army neutral. The 30 last seen on 4 on turn 3 can be on 3
    // by now and on 2 by next turn, attacking my 1 the turn after.
    const now = board([mine(1, 5), mine(7, 2), neutral(2, 2), fogged(3), fogged(4), fogged(5), fogged(6)]);
    const lost = [track(FOE, { lostStacks: [{ territoryId: 4, turn: 3, armies: 30 }] })];
    const plan = planTurn({ graph: g, board: now, me: ME, income: 5, settings: STD, turn: 4, game: { turn: 4, fog: 'Foggy' }, tracks: lost });
    expect(plan.warnings.join('\n')).toMatch(/stack of 30 armies last seen on T4 \(#4\) on turn 3 .*can stand on T2 \(#2\), next to my T1 \(#1\), by next turn/);
    // Not yet a threat this turn: it cannot reach a territory next to mine unseen.
    expect(why(plan)).not.toMatch(/left view: it can attack/);
  });
  it('the lost-stack lines say a Multi-attack game can bring it sooner', () => {
    const now = board([mine(1, 5), mine(7, 2), fogged(2), fogged(3), fogged(4), fogged(5), fogged(6)]);
    const lost = [track(FOE, { lostStacks: [{ territoryId: 5, turn: 3, armies: 30 }] })];
    const plan = planTurn({ graph: g, board: now, me: ME, income: 20, settings: { ...STD, multiAttack: true }, turn: 6, game: { turn: 6 }, tracks: lost, options: { goal: 'defend' } });
    expect(why(plan)).toMatch(/left view: .*Multi-attack/);
    const single = planTurn({ graph: g, board: now, me: ME, income: 20, settings: STD, turn: 6, game: { turn: 6 }, tracks: lost, options: { goal: 'defend' } });
    expect(why(single)).not.toMatch(/Multi-attack/);
  });
});

describe('a lost stack is part of its owner unaccounted armies: never counted twice on one border (#164 review)', () => {
  // My 1 borders 2 (owner-only, the opponent's: carries its pool of 12) and 3 (fogged); its stack of
  // 30 was last seen on 4, behind 3, on turn 3.
  const g = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [1, 3], [3, 4]], []));
  const now = board([mine(1, 5), ownerOnly(2), fogged(3), fogged(4)]);
  it('the pool is what is left after the lost stack, so the two together are the larger, not the sum', () => {
    const tracks = [track(FOE, { unexplained: 12, lostStacks: [{ territoryId: 4, turn: 3, armies: 30 }] })];
    const plan = planTurn({ graph: g, board: now, me: ME, income: 60, settings: STD, turn: 5, game: { turn: 5, fog: 'VeryFoggy' }, tracks, options: { goal: 'defend' } });
    // 29 movable + its ~5 deploy: the pool (10 after the cap) is inside the 29, not beside it (39).
    expect(why(plan)).toMatch(/player 20 has 29 movable armies next to it plus ~5 deploy/);
    expect(why(plan)).toMatch(/more than the 34 that can reach it/);
  });
});

describe('a lost stack via the pool carrier is kept when another lost stack reaches the border elsewhere (#164 review)', () => {
  // My 1 (and 6) border 2 (owner-only, the opponent's: carries its pool, capped at 10) and 3 (fogged).
  // Two stacks left view on turn 9: 9 on 4 (behind 2, via the carrier) and 7 on 5 (behind 3).
  const g = buildGraph(makeMap([1, 2, 3, 4, 5, 6], [[1, 2], [1, 3], [2, 4], [3, 5], [1, 6]], [[101, 5, [1, 6]]]));
  const lostStacks = [
    { territoryId: 4, turn: 9, armies: 9 },
    { territoryId: 5, turn: 9, armies: 7 },
  ];
  const tracks = [track(FOE, { unexplained: 30, lostStacks })];
  const plan = (two: TerritoryState) =>
    planTurn({ graph: g, board: board([mine(1, 3), mine(6, 3), two, fogged(3), fogged(4), fogged(5)]), me: ME, income: 40, settings: STD, turn: 10, game: { turn: 10, fog: 'VeryFoggy' }, tracks, options: { goal: 'defend' } });
  it('the carrier keeps the lost stack via it (8), beside the one via 3 (6): 14 movable, not 10', () => {
    const shown = plan(ownerOnly(2));
    expect(why(shown)).toMatch(/player 20 has 14 movable armies next to it/);
  });
  it('showing the owner of 2 never lowers the threat below the fully fogged board', () => {
    const shown = plan(ownerOnly(2));
    const hidden = plan(fogged(2));
    const threat = (p: { rationale: string[]; warnings: string[] }) => Number(/~(\d+) threat/.exec(why(p))?.[1] ?? NaN);
    expect(threat(shown)).toBeGreaterThanOrEqual(threat(hidden));
  });
});

describe('a due Reinforcement card and the hidden stack cap (#164 review)', () => {
  const g = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [2, 3], [3, 4]], [[101, 6, [1, 2]]]));
  const b = board([mine(1, 1), mine(2, 3), ownerOnly(3), ownerOnly(4)]);
  it('the cap is two turns of its income, the card left out (it is counted once, in the deploy)', () => {
    const game = { turn: 6, fog: 'VeryFoggy', reinforcement: { firstTurn: 2, armies: 6, turnsPerCard: 3 } };
    const plan = planTurn({ graph: g, board: b, me: ME, income: 60, settings: STD, turn: 6, game, tracks: [track(FOE, { unexplained: 50 })], options: { goal: 'defend' } });
    expect(why(plan)).toMatch(/Reinforcement card from turn 2/);
    expect(why(plan)).toMatch(/up to 10 armies there/);
  });
});

describe('a card play read under exact fog is named too (#164 review)', () => {
  const g = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [2, 3], [3, 4]], []));
  const b = board([mine(1, 5), mine(2, 5), foe(3, 4), foe(4, 4)]);
  const clock = { firstTurn: 4, armies: 6, turnsPerCard: 3 };
  it('the plan says the card is taken as played, and why it may not have been', () => {
    const turns: OpponentTrack['turns'] = [4, 5].map((from) => ({
      from, to: from + 1, observed: from === 5 ? 11 : 5, raw: from === 5 ? 11 : 5, cap: 20, counted: [], captured: [], fromFog: [], reveals: [], visibleIncome: 5, earned: 5, net: 0, losses: 0, fogArmies: 0, measured: 0, broken: [], brokenValue: 0, low: from === 5 ? 11 : 5, high: from === 5 ? 11 : 5, reinforced: [], grewFromFog: [], emptied: [], combat: 0,
    }));
    const plan = planTurn({ graph: g, board: b, me: ME, income: 5, settings: STD, turn: 6, game: { turn: 6, fog: 'NoFog', reinforcement: clock }, tracks: [track(FOE, { turns })] });
    expect(plan.warnings.join('\n')).toMatch(/player 20's Reinforcement card is taken as played on turn 5 \(a deployment above its exact income\).*errs low/i);
  });
});

describe('the floor tier counts hidden and lost stacks as already next to a border (#164 x #118 review)', () => {
  // My 1 2 are bonus 101 (+6), 6 armies each. 1 borders 3, 2 borders 4; 3 4 5 6 the opponent's.
  // With its stacks in view at 20 armies, the floor (beat the 19 movable next to each border) is
  // out of reach and the bonus is conceded. The same board with the armies hidden, 40 unaccounted
  // (capped at 20 in one place), must not read 0 next to each border and keep the bonus as floored.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5, 6], [[1, 3], [2, 4], [1, 2], [3, 5], [4, 5], [5, 6]], [[101, 6, [1, 2]], [102, 1, [5, 6]]]));
  const plan = (them: (id: number) => TerritoryState, tracks: OpponentTrack[]) =>
    planTurn({ graph: g, board: board([mine(1, 6), mine(2, 6), them(3), them(4), them(5), them(6)]), me: ME, income: 11, settings: STD, turn: 10, game: { turn: 10, fog: 'ModerateFog' }, tracks, options: { goal: 'defend' } });
  it('a border facing a hidden stack is not floored on a 0: the bonus is conceded, as with the stacks in view', () => {
    const tracks = [track(FOE, { income: 10, unexplained: 40 })];
    const seen = plan((id) => foe(id, 20), tracks);
    const hidden = plan((id) => ownerOnly(id), tracks);
    expect(why(seen)).toMatch(/conceding bonus B101/);
    expect(why(hidden)).not.toMatch(/falls only to armies deployed against it/);
    expect(why(hidden)).not.toMatch(/Floor for bonus B101/);
    expect(why(hidden)).toMatch(/conceding bonus B101/);
  });
  it('a lost stack that can reach a border counts there too', () => {
    // Fogged 3 4 5 6; a stack of 30 left view on 5 two turns ago, so it can stand on 3 and 4 now.
    const tracks = [track(FOE, { income: 10, unexplained: 0, lostStacks: [{ territoryId: 5, turn: 8, armies: 30 }] })];
    const lost = plan((id) => fogged(id), tracks);
    expect(why(lost)).not.toMatch(/falls only to armies deployed against it/);
    expect(why(lost)).not.toMatch(/Floor for bonus B101/);
  });
});

describe("last turn's deploy is judged against last turn's income, not this turn's (#164 review)", () => {
  // Bonus 102 (+4) = 4 5. Last turn the opponent held it (income 9) and deployed 9 on 3; since then
  // player 30 took 5, so its income now is 5. The 9 it deployed was income, not a Reinforcement card.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [2, 3], [3, 4], [4, 5]], [[102, 4, [4, 5]]]));
  const prev = board([mine(1, 5), mine(2, 5), foe(3, 4), foe(4, 4), foe(5, 4)]);
  const now = board([mine(1, 5), mine(2, 5), foe(3, 13), foe(4, 4), foe(5, 4, 30)]);
  const clock = { firstTurn: 2, armies: 6, turnsPerCard: 5 };
  it('a deploy its previous income paid for is no card play: the card stays counted', () => {
    const e = enemyDeployEstimates(g, now, ME, STD, prev, undefined, undefined, { turn: 6, fog: 'NoFog', reinforcement: clock }).find((x) => x.playerId === FOE)!;
    expect(e.observation?.low).toBe(9);
    expect(e.cardPlayed).toBeNull();
    expect(e.card).toEqual({ armies: 6, due: 2 });
  });
  it('a deploy above its previous income is still a card play', () => {
    const big = board([mine(1, 5), mine(2, 5), foe(3, 19), foe(4, 4), foe(5, 4, 30)]);
    const e = enemyDeployEstimates(g, big, ME, STD, prev, undefined, undefined, { turn: 6, fog: 'NoFog', reinforcement: clock }).find((x) => x.playerId === FOE)!;
    expect(e.cardPlayed).toBe(5);
    expect(e.card).toBeNull();
  });
});

describe("an opponent's Reinforcement card is a deploy, not income (#164 x #167/#178 review)", () => {
  // A line of 12 in a symmetric 3-player FFA under No Fog: me on 1-4, player 20 on 5-8, player 30
  // on 9-12, each pair a +2 bonus, so everyone earns 9.
  const ids = Array.from({ length: 12 }, (_, i) => i + 1);
  const g = buildGraph(
    makeMap(
      ids,
      ids.slice(1).map((i) => [i - 1, i] as [number, number]),
      [0, 1, 2, 3, 4, 5].map((i) => [100 + i, 2, [2 * i + 1, 2 * i + 2]] as [number, number, number[]]),
    ),
  );
  const owner = (id: number) => (id <= 4 ? ME : id <= 8 ? FOE : 30);
  const b = board(ids.map((id) => foe(id, 8, owner(id))));
  const plan = (reinforcement?: { firstTurn: number; armies: number; turnsPerCard: number }) =>
    planTurn({
      graph: g,
      board: b,
      me: ME,
      income: 9,
      settings: { ...STD, baseIncome: 5 },
      game: { players: [{ id: ME }, { id: FOE }, { id: 30 }], turn: 10, fog: 'NoFog', cards: true, ...(reinforcement ? { reinforcement } : {}) },
      options: { adapt: true },
    });

  it('the card clock leaves the standing, the goal and the FFA ranking as they are without it', () => {
    const none = plan();
    const card = plan({ firstTurn: 3, armies: 6, turnsPerCard: 4 });
    expect(card.warnings.join(' ')).toMatch(/may hold a Reinforcement card/);
    expect(none.profile!.standing).toBe('even');
    expect(card.profile!.standing).toBe(none.profile!.standing);
    expect(card.goal).toBe(none.goal);
    const standing = (p: typeof none) => p.profile!.notes.filter((n) => /Standing/.test(n));
    expect(standing(card)).toEqual(standing(none));
    expect(card.profile!.ranking).toEqual(none.profile!.ranking);
  });
});
