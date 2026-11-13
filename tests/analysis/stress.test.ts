// The plan stress test: a proposed list of orders run against each opponent's single replies
// (its whole deploy on one stack and one attack, or its whole deploy on a territory I attack),
// under both move orders unless the first mover is known. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { stressPlan, type StressInput, type StressReply } from '../../src/analysis/stress.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral, tinyMap } from './helpers.js';

const ME = 10;
const FOE = 20;
const OTHER = 30;
const STD = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(n: number, edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
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

const foe = (id: number, armies: number, player = FOE): TerritoryState => mine(id, armies, player);

/** 1 ─ 2 ─ 3 ─ 4 in a line; bonus 100 (+4) is territories 1 and 2. */
const LINE4 = makeMap(4, [[1, 2], [2, 3], [3, 4]], [[100, 4, [1, 2]]]);

function stress(map: GameMap, entries: TerritoryState[], over: Partial<StressInput> = {}) {
  return stressPlan({
    graph: buildGraph(map),
    board: board(entries),
    me: ME,
    deploys: [],
    moves: [],
    opponents: [{ id: FOE, deploy: 5 }],
    settings: STD,
    ...over,
  });
}

const kinds = (replies: readonly StressReply[]) => replies.map((r) => `${r.kind} ${r.from ?? r.deployTo}>${r.to ?? ''} first:${r.firstMover}`);

describe('stressPlan', () => {
  it('finds nothing to report when no single reply takes anything', () => {
    // The stack next to me has 3 and gets 5 more: 7 attack my 10 and fail.
    const r = stress(LINE4, [mine(1, 2), mine(2, 10), foe(3, 3), foe(4, 1)]);
    expect(r.safe).toBe(true);
    expect(r.replies).toEqual([]);
    expect(r.considered).toBeGreaterThan(0);
    expect(r.exact).toBe(true);
  });

  it('names the reply that takes a border the plan emptied, and the bonus that goes with it', () => {
    // I walk 9 of the 10 away from the border; 7 attackers then take the 1 left.
    const r = stress(LINE4, [mine(1, 2), mine(2, 10), foe(3, 3), foe(4, 1)], { moves: [{ from: 2, to: 1, armies: 9 }] });
    expect(r.safe).toBe(false);
    const w = r.worst!;
    expect(w).toMatchObject({ opponent: FOE, kind: 'attack', deployTo: 3, deploy: 5, from: 3, to: 2, armies: 7 });
    expect(w.lost).toEqual([2]);
    expect(w.bonusesLost).toEqual([{ id: 100, value: 4 }]);
    expect(w.incomeLost).toBe(4);
    // It only works when my transfer runs first: struck first, the 10 are still there.
    expect(w.firstMover).toBe('me');
    expect(r.replies.every((x) => x.firstMover === 'me')).toBe(true);
    expect(r.atRisk.territories).toEqual([{ id: 2, replies: 1 }]);
    expect(r.atRisk.bonuses).toEqual([{ id: 100, value: 4, replies: 1 }]);
  });

  it('simulates only the known move order when the first mover is given', () => {
    const entries = [mine(1, 2), mine(2, 10), foe(3, 3), foe(4, 1)];
    const moves = [{ from: 2, to: 1, armies: 9 }];
    expect(stress(LINE4, entries, { moves, firstMover: 'opponent' }).safe).toBe(true);
    expect(stress(LINE4, entries, { moves, firstMover: 'me' }).safe).toBe(false);
  });

  it('reports an attack of mine that fails when its target is reinforced', () => {
    // 7 take the 4 as the board stands; with 5 more on it they kill only 4 of 9.
    const r = stress(LINE4, [mine(1, 2), mine(2, 8), foe(3, 4), foe(4, 1)], { moves: [{ from: 2, to: 3, armies: 7 }] });
    expect(r.baseline.captured).toEqual([3]);
    const reinforce = r.replies.find((x) => x.kind === 'reinforce')!;
    expect(reinforce).toMatchObject({ deployTo: 3, deploy: 5 });
    expect(reinforce.capturesFailed).toEqual([3]);
    // Six outcomes stop it: the stack on 3 striking my source (either order, alone or with every
    // stack), the stack on 4 walking in first, and the deploy simply sitting on it.
    expect(r.atRisk.captures).toEqual([{ id: 3, replies: 6 }]);
    expect(r.considered).toBe(4);
    expect(r.harmful).toBe(4);
  });

  it('tells a capture that is taken straight back from one that never happens', () => {
    // I take the neutral 3 with 3 (2 survive) beside the enemy's 4, which can reach it with 8.
    const r = stress(LINE4, [mine(1, 1), mine(2, 4), neutral(3, 2), foe(4, 4)], { moves: [{ from: 2, to: 3, armies: 3 }] });
    expect(r.baseline.captured).toEqual([3]);
    // Moving first I take it and lose it again; moving second the enemy is already on it.
    const after = r.replies.find((x) => x.firstMover === 'me')!;
    expect(after).toMatchObject({ kind: 'attack', from: 4, to: 3, retaken: [3], capturesFailed: [], lost: [] });
    const before = r.replies.find((x) => x.firstMover === 'opponent')!;
    expect(before).toMatchObject({ kind: 'attack', from: 4, to: 3, retaken: [], capturesFailed: [3], lost: [] });
    expect(r.atRisk.captures).toEqual([{ id: 3, replies: 2 }]);
  });

  it('puts a lost commander above everything else', () => {
    const withCommander = (t: TerritoryState): TerritoryState => ({ ...t, specialUnits: [{ kind: 'commander', id: 'c', playerId: ME }] });
    // Two borders: territory 2 guards a +4 bonus, territory 5 holds my commander behind 2 armies.
    const map = makeMap(6, [[1, 2], [2, 3], [1, 5], [5, 6]], [[100, 4, [1, 2]]]);
    const r = stress(map, [mine(1, 2), mine(2, 1), foe(3, 6), withCommander(mine(5, 2)), foe(6, 12)], {
      opponents: [{ id: FOE, deploy: 5 }],
    });
    expect(r.worst).toMatchObject({ kind: 'attack', to: 5, commanderLost: true });
    expect(r.replies.some((x) => x.to === 2 && x.incomeLost === 4)).toBe(true);
  });

  it('gives each opponent its own deploy, and never treats a teammate as one', () => {
    const map = makeMap(5, [[1, 2], [2, 3], [2, 4], [2, 5]]);
    const r = stress(map, [mine(1, 1), mine(2, 6), foe(3, 3), foe(4, 3, OTHER), foe(5, 9, 40)], {
      opponents: [
        { id: FOE, deploy: 2 },
        { id: OTHER, deploy: 9 },
      ],
      teams: new Map([
        [ME, 1],
        [40, 1],
        [FOE, 2],
        [OTHER, 3],
      ]),
    });
    // FOE: 3 + 2 − 1 = 4 attackers kill 2 of 6. OTHER: 3 + 9 − 1 = 11 kill 7 and take it.
    expect(r.replies.map((x) => x.opponent)).toEqual([OTHER]);
    expect(r.worst).toMatchObject({ opponent: OTHER, deploy: 9, armies: 11, lost: [2] });
  });

  it('also tries every stack attacking at once, which needs no deploy to break two borders', () => {
    // Two enemy stacks already big enough: one deploy cannot explain both losses, existing armies can.
    const map = makeMap(5, [[1, 2], [1, 3], [2, 4], [3, 5]], [[100, 3, [1, 2]], [101, 3, [1, 3]]]);
    const r = stress(map, [mine(1, 1), mine(2, 2), mine(3, 2), foe(4, 9), foe(5, 9)], { opponents: [{ id: FOE, deploy: 0 }] });
    const all = r.replies.find((x) => x.kind === 'all-attack')!;
    expect(all.lost).toEqual([2, 3]);
    expect(all.incomeLost).toBe(6);
    expect(r.worst).toBe(r.replies[0]);
    expect(r.worst!.kind).toBe('all-attack');
  });

  it('spreads the stacks of an all-out attack over different targets when they can reach several', () => {
    // Both stacks touch both of my territories: together they take both, not the same one twice.
    const map = makeMap(4, [[1, 2], [1, 3], [1, 4], [2, 3], [2, 4]]);
    const r = stress(map, [mine(1, 2), mine(2, 2), foe(3, 9), foe(4, 9)], { opponents: [{ id: FOE, deploy: 0 }] });
    const all = r.replies.find((x) => x.kind === 'all-attack')!;
    expect(all.lost).toEqual([1, 2]);
    expect(all.attacks).toEqual([
      { from: 3, to: 1 },
      { from: 4, to: 2 },
    ]);
  });

  it('lists my territories that border what it cannot see, since nothing there is tested', () => {
    const r = stress(LINE4, [mine(1, 2), mine(2, 10), fogged(3), fogged(4)]);
    expect(r.blindBorders).toEqual([2]);
    expect(r.considered).toBe(0);
    // Nothing was tried, so nothing is known: never "safe".
    expect(r.safe).toBeNull();
  });

  it('counts a territory the plan takes beside the fog as a blind border too', () => {
    const map = makeMap(4, [[1, 2], [2, 3], [3, 4]]);
    const r = stress(map, [mine(1, 1), mine(2, 4), neutral(3, 2), fogged(4)], { moves: [{ from: 2, to: 3, armies: 3 }] });
    expect(r.blindBorders).toEqual([3]);
    expect(r.safe).toBeNull();
  });

  it('treats a territory whose owner shows but whose armies do not as fog: no reply from a stack of unknown size', () => {
    const ownerOnly: TerritoryState = { territoryId: 3, owner: { kind: 'player', playerId: FOE }, armies: null, fogLevel: 'OwnerOnly' };
    const r = stress(LINE4, [mine(1, 2), mine(2, 3), ownerOnly, fogged(4)]);
    expect(r.considered).toBe(0);
    expect(r.blindBorders).toEqual([2]);
    expect(r.safe).toBeNull();
  });

  it('lets an enemy commander join the attack from its stack', () => {
    // 3 armies and a commander, with 5 more: 7 armies and the commander fight as 14 and kill 8.
    const withCommander: TerritoryState = { ...foe(3, 3), specialUnits: [{ kind: 'commander', id: 'c', playerId: FOE }] };
    const r = stress(LINE4, [mine(1, 2), mine(2, 6), withCommander, foe(4, 1)]);
    expect(r.safe).toBe(false);
    expect(r.worst).toMatchObject({ kind: 'attack', from: 3, to: 2, lost: [2] });
  });

  it('also tries every stack on the one most valuable target, which a spread attack would miss', () => {
    // Two 7s both touch my 6 (a +5 bonus); one of them also touches my 20. Alone each kills 4 of the 6.
    const map = makeMap(5, [[1, 3], [1, 4], [2, 4], [1, 5]], [[100, 5, [1, 5]]]);
    const r = stress(map, [mine(1, 6), mine(2, 20), foe(3, 7), foe(4, 7), mine(5, 1)], { opponents: [{ id: FOE, deploy: 0 }] });
    expect(r.safe).toBe(false);
    expect(r.worst).toMatchObject({ kind: 'all-attack', lost: [1], incomeLost: 5 });
    expect(r.worst!.attacks).toEqual([
      { from: 3, to: 1 },
      { from: 4, to: 1 },
    ]);
  });

  it('counts a superbonus with the bonus it rests on, and does not rank a lost negative bonus as a gain', () => {
    // tinyMap: A (+3) = 1,2,3; B (+2) = 4,5; S (+4) = A + B; 6 and 7 beyond.
    const map = tinyMap();
    const r = stress(map, [mine(1, 3), mine(2, 3), mine(3, 3), mine(4, 3), mine(5, 1), foe(6, 9), foe(7, 1)]);
    expect(r.worst).toMatchObject({ lost: [5], incomeLost: 6 });
    expect(r.worst!.bonusesLost).toEqual([
      { id: 102, value: 2 },
      { id: 104, value: 4 },
    ]);
    // A −2 bonus on territory 2: losing it "gains" 2, which must not sink the reply below a mere failed capture.
    const neg = makeMap(4, [[1, 2], [2, 3], [3, 4]], [[100, -2, [1, 2]]]);
    const n = stress(neg, [mine(1, 2), mine(2, 1), foe(3, 9), neutral(4, 2)]);
    expect(n.worst).toMatchObject({ lost: [2], incomeLost: -2 });
  });

  it('a lost commander is one fact, not a list of everything I held', () => {
    const withCommander = (t: TerritoryState): TerritoryState => ({ ...t, specialUnits: [{ kind: 'commander', id: 'c', playerId: ME }] });
    const map = makeMap(5, [[1, 2], [2, 3], [1, 4], [4, 5]], [[100, 4, [1, 4]]]);
    const r = stress(map, [mine(1, 2), withCommander(mine(2, 2)), foe(3, 20), mine(4, 9), neutral(5, 2)], { moves: [{ from: 4, to: 5, armies: 3 }] });
    expect(r.worst).toMatchObject({ commanderLost: true, lost: [1, 2, 4], retaken: [], capturesFailed: [] });
    expect(r.atRisk.commander).toBeGreaterThan(0);
    expect(r.atRisk.territories).toEqual([]);
    expect(r.atRisk.bonuses).toEqual([]);
  });

  it('is deterministic, orders replies worst first, and caps the list', () => {
    const map = makeMap(7, [[1, 2], [1, 3], [1, 4], [2, 5], [3, 6], [4, 7]], [[100, 5, [1, 2]], [101, 2, [1, 3]]]);
    const entries = [mine(1, 1), mine(2, 1), mine(3, 1), mine(4, 1), foe(5, 4), foe(6, 4), foe(7, 4)];
    const a = stress(map, entries, { maxReplies: 2 });
    const b = stress(map, entries, { maxReplies: 2 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.replies).toHaveLength(2);
    expect(a.replies[0]!.incomeLost).toBeGreaterThanOrEqual(a.replies[1]!.incomeLost);
    expect(a.harmful).toBe(4);
    expect(a.considered).toBe(4);
    expect(kinds(a.replies)).toEqual(['all-attack 5> first:undefined', 'attack 5>2 first:undefined']);
  });

  it('carries the resolver\'s caveats: not exact under luck, and the assumptions it leaned on', () => {
    const r = stress(LINE4, [mine(1, 2), mine(2, 10), foe(3, 3), foe(4, 1)], { settings: { ...STD, luckModifier: 16 } });
    expect(r.exact).toBe(false);
    // Struck first by 13, my 10 are 2: the transfer of 9 I ordered sends the 1 it still can.
    const hit = stress(LINE4, [mine(1, 2), mine(2, 10), foe(3, 9), foe(4, 1)], { moves: [{ from: 2, to: 1, armies: 9 }] });
    expect(hit.assumptions.some((x) => /fewer/.test(x))).toBe(true);
  });
});
