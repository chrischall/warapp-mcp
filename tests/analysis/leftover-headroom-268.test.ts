// Issue #268: once every border has its hold and its comfortable margin, the rest of the leftover is
// spread over the borders facing one opponent so that the smallest deploy that breaks any of them is
// as large as possible, instead of all of it going to the one with the most at stake. Synthetic map
// only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { chargeDeploys, deployPools } from '../../src/analysis/local-deploy.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board } from './helpers.js';

const ME = 10;
const FOE = 20;
/** 20/80, guard off, no luck: the issue's game. */
const LOW: PlannerSettings = {
  offensiveKillRate: 20,
  defensiveKillRate: 80,
  oneArmyStandsGuard: false,
  luckModifier: 0,
  roundingMode: 'StraightRound',
};

interface Scenario {
  edges: string;
  /** 'M7' mine with 7, 'E16' player 20 with 16, 'F2' player 30 with 2, 'U' fogged. */
  cells: Record<number, string>;
  bonuses: Array<[number, number, number[]]>;
  settings?: PlannerSettings;
  income?: number;
}

/**
 * The issue's shape. My V (T1, 7) and A (T2, 7) and M (T4, 30) face the opponent's 16 on L (T11);
 * A and D (T3, 4) face its 7 on T12; D faces its 4 on T13. D's bonus (+2) is worth the most; V and A
 * share a +1. The opponent's visible +21 bonus makes its estimate ~26. A four-player game with one
 * opponent in view: no 1v1 strike stack, the leftover buys comfort margins.
 */
const ISSUE: Scenario = {
  edges: '1-11 2-11 4-11 2-12 3-12 3-13 1-2 2-3 1-5 4-5 3-6 5-6 11-12 12-13 13-14 11-14',
  cells: { 1: 'M7', 2: 'M7', 3: 'M4', 4: 'M30', 5: 'M2', 6: 'M2', 11: 'E16', 12: 'E7', 13: 'E4', 14: 'U' },
  bonuses: [
    [100, 1, [1, 2, 5]],
    [101, 2, [3, 6]],
    [102, 21, [11, 12, 13]],
  ],
};

function input(sc: Scenario): PlanInput {
  const adj = new Map<number, Set<number>>();
  for (const e of sc.edges.split(/\s+/).filter(Boolean)) {
    const [a, b] = e.split('-').map(Number) as [number, number];
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  }
  const ids = [...adj.keys()].sort((a, b) => a - b);
  const map: GameMap = {
    id: 1,
    name: 'Headroom',
    territories: ids.map((id) => ({ id, name: `T${id}`, connectedTo: [...adj.get(id)!].sort((a, b) => a - b) })),
    bonuses: sc.bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
  const cells: TerritoryState[] = Object.entries(sc.cells).map(([id, s]) =>
    s === 'U'
      ? { territoryId: Number(id), owner: { kind: 'unknown' }, armies: null }
      : {
          territoryId: Number(id),
          owner: { kind: 'player', playerId: s[0] === 'M' ? ME : s[0] === 'F' ? 30 : FOE },
          armies: Number(s.slice(1)),
        },
  );
  return {
    graph: buildGraph(map),
    board: board(cells, true),
    me: ME,
    income: sc.income ?? 29,
    settings: sc.settings ?? LOW,
    options: { adapt: true },
    game: { players: [{ id: ME }, { id: FOE }, { id: 30 }, { id: 40 }], turn: 9, fog: 'Foggy' },
  };
}

const deployedTo = (p: TurnPlan, id: number) => p.deploys.filter((d) => d.territoryId === id).reduce((n, d) => n + d.armies, 0);
const why = (p: TurnPlan) => p.rationale.join('\n');
const take = (n: number) => armiesToTake(n, { offensiveKillRate: 20, defensiveKillRate: 80 })!;
/**
 * Armies on a border after its deploys, as the leftover judges it: the idle interior armies rule 6
 * transfers in later only add to it.
 */
const after = (p: TurnPlan, sc: Scenario, id: number) => Number(sc.cells[id]!.slice(1)) + deployedTo(p, id);

describe('#268 the rest of the leftover raises the smallest deploy that breaks a border', () => {
  // Each border's stacks beside it that are not deploy: V 16, A 16 + 7, D 7 + 4 (sent separately).
  const stacks: Record<number, number> = { 1: 16, 2: 23, 3: 11 };
  /** The deploy on top of the stacks beside it that takes the border. */
  const breaks = (p: TurnPlan, id: number) => take(after(p, ISSUE, id)) - stacks[id]!;

  it('spreads the rest over V, A and D instead of putting it all on D', () => {
    const p = planTurn(input(ISSUE));
    // Before #268: V +4, A +6, D +19 (5 to hold, 1 to its margin, the rest 13): V broke at a deploy
    // of ~37, A at ~40, D only at ~102.
    expect(why(p)).not.toMatch(/Deploy the leftover \d+ to T3 \(#3\): the rest/);
    expect(why(p)).toMatch(
      /Spread the leftover 13 over the borders facing player 20 \(#268\), so the smallest deploy that breaks one of them is as large as possible: T1 \(#1\) \+4, T2 \(#2\) \+4, T3 \(#3\) \+5, once every short border has its comfortable margin: none of them now falls to a deploy of less than ~57/,
    );
    // All 29 still deployed, and the same totals on the three borders.
    expect(p.deploys.reduce((n, d) => n + d.armies, 0)).toBe(29);
    expect(deployedTo(p, 1) + deployedTo(p, 2) + deployedTo(p, 3)).toBe(29);
    // Every border now breaks only at a deploy of ~57 or more (V broke at ~37 before), and the
    // headroom is roughly equal: within one army's worth (5 to take) of each other.
    const all = [1, 2, 3].map((id) => breaks(p, id));
    expect(Math.min(...all)).toBe(57);
    expect(Math.max(...all) - Math.min(...all)).toBeLessThanOrEqual(5);
  });

  it('one border facing the opponent: unchanged, the rest goes to it', () => {
    // Only D faces player 20 (its 4 on T13); V, A and M face nothing.
    const sc: Scenario = {
      edges: '1-2 2-3 1-5 4-5 3-6 5-6 3-13 13-14',
      cells: { 1: 'M7', 2: 'M7', 3: 'M4', 4: 'M30', 5: 'M2', 6: 'M2', 13: 'E4', 14: 'U' },
      bonuses: [
        [100, 1, [1, 2, 5]],
        [101, 2, [3, 6]],
        [102, 21, [13]],
      ],
    };
    const p = planTurn(input(sc));
    expect(why(p)).not.toMatch(/#268/);
    expect(why(p)).toMatch(/Deploy the leftover \d+ to T3 \(#3\)/);
  });

  it('under Local Deployment the pools are respected', () => {
    // B101 (+2) holds only D, B100 (+1) holds V and A: their pools land only inside them.
    const sc: Scenario = { ...ISSUE, settings: { ...LOW, localDeployments: true } };
    const inp = input(sc);
    const p = planTurn(inp);
    expect(p.warnings.join('\n')).not.toMatch(/breaks Local Deployment/);
    const mine = new Set(Object.entries(sc.cells).filter(([, s]) => s[0] === 'M').map(([id]) => Number(id)));
    const pools = deployPools(inp.graph, mine, 29);
    const deploys = new Map<number, number>();
    for (const d of p.deploys) deploys.set(d.territoryId, (deploys.get(d.territoryId) ?? 0) + d.armies);
    expect(chargeDeploys(pools, deploys).anywhereUsed).toBeLessThanOrEqual(pools.anywhere);
    expect(p.deploys.reduce((n, d) => n + d.armies, 0)).toBe(29);
    // The spread still runs, within the pools.
    expect(why(p)).toMatch(/Spread the leftover \d+ over the borders facing player 20 \(#268\)/);
  });

  it('a border another opponent also faces is not part of the spread', () => {
    // Player 30's 2 on T15 beside A (T2): A faces two opponents, so the rest is spread over V and D.
    const p = planTurn(input({ ...ISSUE, edges: `${ISSUE.edges} 2-15 15-14`, cells: { ...ISSUE.cells, 15: 'F2' } }));
    const line = p.rationale.find((l) => l.includes('(#268)'));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/T2 \(#2\) \+/);
    expect(line).toMatch(/T1 \(#1\) \+\d+, T3 \(#3\) \+\d+/);
  });
});
