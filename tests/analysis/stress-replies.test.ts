// #180: more reply kinds in the plan stress test — a stack that moves away (dodge), two opponents
// on one territory (joint), attack chains under Multi-Attack, and each deploy bounded by Local
// Deployment's pools. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { stressPlan, type StressInput } from '../../src/analysis/stress.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

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

function stress(map: GameMap, entries: TerritoryState[], over: Partial<StressInput> = {}) {
  return stressPlan({
    graph: buildGraph(map),
    board: board(entries),
    me: ME,
    deploys: [],
    moves: [],
    opponents: [{ id: FOE, deploy: 5 }],
    settings: STD,
    lookAhead: false,
    ...over,
  });
}

describe('stressPlan: dodge (#180)', () => {
  // 1 ─ 2 ─ 3 ─ 4: my 20 on 2 strike the enemy's last territory, 3; a neutral 4 lies beyond it.
  const LINE = makeMap(4, [[1, 2], [2, 3], [3, 4]]);
  const lastStand = [mine(1, 2), mine(2, 20), foe(3, 5), neutral(4, 1)];
  const strike = [{ from: 2, to: 3, armies: 19 }];

  it('moves the struck stack out first: my strike hits the guard, and the player I was finishing lives on', () => {
    const r = stress(LINE, lastStand, { moves: strike });
    expect(r.baseline.captured).toEqual([3]);
    // Its 5 and 5 deployed send 9 into the neutral 4 (1 army) first: 8 survive there.
    expect(r.dodges).toEqual([
      expect.objectContaining({
        opponent: FOE,
        stack: 3,
        exit: 4,
        exitOwner: 'neutral',
        deploy: 5,
        sent: 9,
        took: true,
        escaped: 8,
        strikes: [{ from: 2, result: 'captured', sent: 19 }],
        harmful: true,
      }),
    ]);
    const dodge = r.replies.find((x) => x.kind === 'dodge')!;
    expect(dodge).toMatchObject({ opponent: FOE, from: 3, to: 4, firstMover: 'opponent', eliminationsFailed: [FOE] });
    expect(r.safe).toBe(false);
  });

  it('is not tried when I am known to move first: the stack is struck where it stands', () => {
    const r = stress(LINE, lastStand, { moves: strike, firstMover: 'me' });
    expect(r.dodges).toEqual([]);
    expect(r.replies.some((x) => x.kind === 'dodge')).toBe(false);
  });

  it('reports a capture of mine that the dodging stack takes first', () => {
    // 1 ─ 2, 2 ─ 3, 2 ─ 4, 3 ─ 4: I strike the stack on 3 and take the neutral 4; it walks into 4 first.
    const map = makeMap(4, [[1, 2], [2, 3], [2, 4], [3, 4]]);
    const r = stress(map, [mine(1, 1), mine(2, 20), foe(3, 6), neutral(4, 2)], {
      moves: [
        { from: 2, to: 3, armies: 12 },
        { from: 2, to: 4, armies: 4 },
      ],
    });
    expect(r.baseline.captured).toEqual([3, 4]);
    const d = r.dodges.find((x) => x.exit === 4)!;
    // It walks in with 10 and keeps 7 after my 4 bounce off.
    expect(d).toMatchObject({ exitOwner: 'neutral', took: true, escaped: 7, harmful: true });
    // My plan takes 4, so that move is also the attack reply on it, moving first: one run, not two.
    expect(r.replies.filter((x) => x.to === 4 && x.firstMover === 'opponent')).toEqual([
      expect.objectContaining({ kind: 'attack', from: 3, capturesFailed: [4] }),
    ]);
    expect(r.replies.some((x) => x.kind === 'dodge')).toBe(false);
  });

  it('lists a dodge into its own territory as an escape that costs me nothing', () => {
    // Its own 4 behind it: the stack steps back, my strike takes 3 from the guard.
    const r = stress(LINE, [mine(1, 2), mine(2, 20), foe(3, 5), foe(4, 1)], { moves: strike });
    const own = r.dodges.find((x) => x.exit === 4)!;
    expect(own).toMatchObject({ exitOwner: 'own', took: true, escaped: 10, harmful: false, strikes: [{ from: 2, result: 'captured', sent: 19 }] });
  });

  it('says when its commander gets away with it', () => {
    const withCommander: TerritoryState = { ...foe(3, 5), specialUnits: [{ kind: 'commander', id: 'c', playerId: FOE }] };
    const r = stress(LINE, [mine(1, 2), mine(2, 20), withCommander, neutral(4, 1)], { moves: strike });
    expect(r.dodges).toEqual([expect.objectContaining({ exit: 4, took: true, commander: true })]);
  });

  it('only tries exits it can take: a territory of mine its stack cannot break is not an exit', () => {
    const r = stress(LINE, [mine(1, 2), mine(2, 20), foe(3, 5), foe(4, 1)], { moves: strike });
    expect(r.dodges.map((x) => x.exit)).toEqual([4]);
  });
});

describe('stressPlan: two opponents together (#180)', () => {
  // My 6 on 2 touch A's 4 on 3 and B's 4 on 4. Alone each brings 5 and kills 3: it holds.
  const MAP = makeMap(4, [[1, 2], [2, 3], [2, 4]]);
  const entries = [mine(1, 5), mine(2, 6), foe(3, 4), foe(4, 4, OTHER)];
  const opponents = [
    { id: FOE, deploy: 2 },
    { id: OTHER, deploy: 2 },
  ];
  const teams = new Map([
    [ME, 1],
    [FOE, 2],
    [OTHER, 2],
  ]);

  it('tries teammates hitting one territory together, and says what would hold it', () => {
    const r = stress(MAP, entries, { opponents, teams });
    const joint = r.replies.find((x) => x.kind === 'joint')!;
    expect(joint).toMatchObject({ lost: [2], partner: OTHER });
    expect(r.jointFalls).toEqual([
      expect.objectContaining({ territory: 2, armies: 6, opponents: [FOE, OTHER], from: [3, 4], attackers: [5, 5], needs: 7 }),
    ]);
    expect(r.safe).toBe(false);
  });

  it('does not pair two free-for-all opponents unless I lead', () => {
    expect(stress(MAP, entries, { opponents }).jointFalls).toEqual([]);
    expect(stress(MAP, entries, { opponents }).safe).toBe(true);
    const led = stress(MAP, entries, { opponents, leader: true });
    expect(led.jointFalls.map((j) => j.territory)).toEqual([2]);
  });

  it('drops the territory once it has the armies it needs', () => {
    const r = stress(MAP, [mine(1, 5), mine(2, 7), foe(3, 4), foe(4, 4, OTHER)], { opponents, teams });
    expect(r.jointFalls).toEqual([]);
  });
});

describe('stressPlan: chains under Multi-Attack (#180)', () => {
  // 1 ─ 2 ─ 3 ─ 4 ─ 5: the 20 on 5 touch only the neutral 4; my +4 bonus is 1 and 2.
  const LINE5 = makeMap(5, [[1, 2], [2, 3], [3, 4], [4, 5]], [[100, 4, [1, 2]]]);
  const entries = [mine(1, 1), mine(2, 1), mine(3, 1), neutral(4, 1), foe(5, 20)];

  it('carries the survivors on through several territories', () => {
    const r = stress(LINE5, entries, { settings: { ...STD, multiAttack: true } });
    const chain = r.replies.find((x) => x.kind === 'chain')!;
    expect(chain.path).toEqual([5, 4, 3, 2, 1]);
    expect(chain.lost).toEqual([1, 2, 3]);
    expect(chain.incomeLost).toBe(4);
    expect(r.safe).toBe(false);
  });

  it('never runs through a teammate of the attacker, and stops where the survivors run out', () => {
    // Its teammate holds 3: the chain cannot pass, and nothing of mine is in two attacks' reach.
    const teams = new Map([
      [ME, 1],
      [FOE, 2],
      [OTHER, 2],
    ]);
    const r = stress(LINE5, [mine(1, 1), mine(2, 1), foe(3, 1, OTHER), neutral(4, 1), foe(5, 20)], {
      settings: { ...STD, multiAttack: true },
      teams,
    });
    expect(r.replies.some((x) => x.kind === 'chain')).toBe(false);
    // 5 attackers: 4 survive the neutral and 3 go on; 2 survive my 1 on 3, and the 1 that goes on cannot take 2.
    const short = stress(LINE5, [mine(1, 1), mine(2, 1), mine(3, 1), neutral(4, 1), foe(5, 1)], {
      settings: { ...STD, multiAttack: true },
      opponents: [{ id: FOE, deploy: 5 }],
    });
    expect(short.replies.find((x) => x.kind === 'chain')?.path).toEqual([5, 4, 3]);
  });

  it('is not tried without Multi-Attack', () => {
    const r = stress(LINE5, entries);
    expect(r.replies.some((x) => x.kind === 'chain')).toBe(false);
    expect(r.safe).toBeNull();
  });
});

describe('stressPlan: Local Deployment bounds each deploy (#180)', () => {
  // 1 ─ 2 ─ 3 ─ 4 ─ 5: the enemy holds the +5 bonus 4–5; its stack on 3 is outside it.
  const MAP = makeMap(5, [[1, 2], [2, 3], [3, 4], [4, 5]], [[200, 5, [4, 5]]]);
  const entries = [mine(1, 1), mine(2, 8), foe(3, 3), foe(4, 1), foe(5, 1)];
  const opponents = [{ id: FOE, deploy: 10, base: 5 }];

  it('deploys only its free income on a stack outside its bonus', () => {
    const r = stress(MAP, entries, { opponents, settings: { ...STD }, localDeployments: true });
    // 3 + 5 − 1 = 7 kill 4 of 8: nothing falls.
    expect(r.safe).toBe(true);
    const free = stress(MAP, entries, { opponents, settings: { ...STD } });
    // Without the rule the whole 10 land on 3: 12 kill 7 of 8 — still holds; at 7 armies it falls.
    expect(free.safe).toBe(true);
    const thin = [mine(1, 1), mine(2, 7), foe(3, 3), foe(4, 1), foe(5, 1)];
    expect(stress(MAP, thin, { opponents }).worst).toMatchObject({ deploy: 10, lost: [2] });
    expect(stress(MAP, thin, { opponents, localDeployments: true }).safe).toBe(true);
  });

  it('lets the pool land on a stack inside the bonus', () => {
    // Its stack on 4 (in the bonus) touches my 3: the whole 10 can land there.
    const map = makeMap(5, [[1, 2], [2, 3], [3, 4], [4, 5]], [[200, 5, [4, 5]]]);
    const r = stress(map, [mine(1, 1), mine(2, 1), mine(3, 7), foe(4, 3), foe(5, 1)], { opponents, localDeployments: true });
    expect(r.worst).toMatchObject({ deployTo: 4, deploy: 10, lost: [3] });
  });
});
