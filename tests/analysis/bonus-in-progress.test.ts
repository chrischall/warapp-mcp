// Issue #122: value was only counted for a bonus held in full at the start of the turn. On
// synthetic maps (every id and name here is made up):
//  (a) a member of the bonus being advanced is conceded ("protects +0") though three of the five
//      income would hold it;
//  (b) a held bonus is conceded for a completion that earns slightly more, though holding it and
//      advancing uses the same income and completes the bonus a turn later;
//  (c) a start facing an enemy start is stripped in the opening for want of 2 armies, though the
//      top-up is less than the armies it keeps.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { chargeDeploys, deployPools } from '../../src/analysis/local-deploy.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const RATES: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70 };
const players = [{ id: ME }, { id: ENEMY }];

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, string, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Progress',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, name, value, territoryIds]) => ({ id, name, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const enemy = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: ENEMY },
  armies,
});
const deployedTo = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
const leaving = (p: TurnPlan, id: number) => p.moves.filter((m) => m.from === id).reduce((s, m) => s + m.armies, 0);
const captures = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack').map((m) => m.to);

// ---- (a) a member of the bonus being advanced ----
//   Bonus Quill (+4): 31 32 37 38. Mine: 31 (3), 32 (3). Neutral 37, 38 (2 each).
//   Enemy 33 (4) next to 32; enemy 34 (1) behind it. Income 5.
//     37 ─ 38
//     |     |
//     31 ─ 32 ─ 33(e) ─ 34(e)
const MAP_A = makeMap(
  [31, 32, 33, 34, 37, 38],
  [[31, 32], [32, 33], [33, 34], [31, 37], [37, 38], [32, 38]],
  [[731, 'Quill', 4, [31, 32, 37, 38]]],
);
const BOARD_A = board([mine(31, 3), mine(32, 3), enemy(33, 4), enemy(34, 1), neutral(37, 2), neutral(38, 2)], true);

describe('#122 (a): a member of the bonus being advanced is valued, not conceded at +0', () => {
  const g = buildGraph(MAP_A);
  const plan = planTurn({
    graph: g,
    board: BOARD_A,
    me: ME,
    income: 5,
    settings: RATES,
    game: { players, turn: 6 },
    options: { adapt: true },
  });

  it('keeps T32 and deploys what holds it', () => {
    expect(plan.conceded).not.toContain(32);
    expect(leaving(plan, 32)).toBe(0);
    // Enemy 33: 4 armies, 3 movable (guard) + ~5 deploy.
    const stays = 3 + deployedTo(plan, 32);
    expect(armiesToTake(stays, { offensiveKillRate: 60, defensiveKillRate: 70 })).toBeGreaterThan(3 + 5);
    expect(plan.warnings.join('\n')).not.toMatch(/T32 \(#32\) cannot be held/);
  });

  it('still advances the bonus with the rest', () => {
    expect(captures(plan).some((t) => t === 37 || t === 38)).toBe(true);
  });

  it('values the member by the share of the bonus held', () => {
    expect(plan.rationale.join('\n')).toMatch(/T32 \(#32\).*protects \+[1-9]/);
  });
});

// ---- (b) a held bonus against a slightly larger completion ----
//   Moss (+3): 61 62, mine; 62 (4) faces enemy 63 (9), enemy 64 behind it. Lark (+4): 65 66 67;
//   65 (1) mine, 66 and 67 neutral (2 each). Income 8. Holding 62 costs 5 (threat 8 movable + 5
//   deploy = 13; 9 armies need 15), completing Lark costs 6: both do not fit.
//     66 ─ 67
//       \ /
//        65 ─ 61 ─ 62 ─ 63(e) ─ 64(e)
const MAP_B = makeMap(
  [61, 62, 63, 64, 65, 66, 67],
  [[61, 62], [62, 63], [63, 64], [61, 65], [65, 66], [65, 67], [66, 67]],
  [
    [761, 'Moss', 3, [61, 62]],
    [762, 'Lark', 4, [65, 66, 67]],
  ],
);
const BOARD_B = board(
  [mine(61, 1), mine(62, 4), enemy(63, 9), enemy(64, 1), mine(65, 1), neutral(66, 2), neutral(67, 2)],
  true,
);

describe('#122 (b): a held bonus is not traded for a completion one turn sooner', () => {
  const g = buildGraph(MAP_B);
  const plan = planTurn({
    graph: g,
    board: BOARD_B,
    me: ME,
    income: 8,
    settings: RATES,
    game: { players, turn: 9 },
    options: { adapt: true },
  });

  it('holds Moss and advances Lark with the rest', () => {
    expect(plan.conceded).toEqual([]);
    expect(leaving(plan, 62)).toBe(0);
    expect(armiesToTake(4 + deployedTo(plan, 62), RATES)).toBeGreaterThan(8 + 5);
    expect(plan.expected.bonusesAtRisk).toBeUndefined();
    expect(captures(plan).filter((t) => t === 66 || t === 67)).toHaveLength(1);
    expect(plan.expected.bonusesCompleted).toEqual([]);
  });

  it('says why the completion waits', () => {
    expect(plan.rationale.join('\n')).toMatch(/Complete bonus Lark \(#762\).*only after holding Moss \(#761\)/);
  });
});

// ---- (e) a bonus completed this turn beside an enemy ----
//   Fen (+3): 101 (3, faces enemy 111 with 9), 102 (4), 103 (2-army neutral next to 102). Moor
//   (+5): 120 (1, mine) and four 2-army neutrals around it. A third player far away (an FFA).
//   Income 8. Taking 103 completes Fen; 101 then needs 6 against ~13 (8 movable + 5).
const MAP_E = makeMap(
  [101, 102, 103, 111, 112, 120, 121, 122, 123, 124, 130, 131],
  [
    [101, 102], [102, 103], [101, 111], [111, 112], [102, 120], [120, 121], [121, 122], [122, 123],
    [123, 124], [120, 124], [112, 130], [130, 131],
  ],
  [
    [901, 'Fen', 3, [101, 102, 103]],
    [902, 'Moor', 5, [120, 121, 122, 123, 124]],
  ],
);
const other = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: 30 },
  armies,
});
const BOARD_E = board(
  [
    mine(101, 3), mine(102, 4), neutral(103, 2), enemy(111, 9), enemy(112, 1), mine(120, 1),
    neutral(121, 2), neutral(122, 2), neutral(123, 2), neutral(124, 2), other(130, 5), other(131, 5),
  ],
  true,
);

describe('#122 (e): a bonus completed this turn beside an enemy is garrisoned before later captures', () => {
  const g = buildGraph(MAP_E);
  const plan = planTurn({
    graph: g,
    board: BOARD_E,
    me: ME,
    income: 8,
    settings: RATES,
    game: { players: [...players, { id: 30 }], turn: 6 },
    options: { adapt: true },
  });

  it('completes Fen and holds T101 against the ~13 threat', () => {
    expect(plan.profile.format).toBe('ffa');
    expect(plan.expected.bonusesCompleted).toEqual([901]);
    expect(armiesToTake(3 + deployedTo(plan, 101), RATES)).toBeGreaterThan(8 + 5);
    expect(plan.rationale.join('\n')).toMatch(/Garrison T101 \(#101\) for bonus Fen \(#901\) \(\+3\), completed this turn: deploy 6/);
    expect(plan.warnings.join('\n')).not.toMatch(/the bonus can fall next turn/);
  });
});

// ---- (c) the opening: three starts around an enemy start ----
//   Enemy start 50 borders my starts 41, 42, 43 (in no bonus); its second start 59 is behind it;
//   my fourth start 44 is elsewhere.
//   Each start has two neutrals of a +2 bonus beside it. Opening board: every territory holds 5
//   (neutrals 2), no guard. Threat on each start: 5 movable + 5 deploy = 10; 5 armies need 8 to
//   take, 7 need 12, so each needs 2 (6 for all three, income 5).
const MAP_C = makeMap(
  [41, 42, 43, 44, 50, 59, 51, 52, 53, 54, 55, 56, 57, 58],
  [
    [41, 50], [42, 50], [43, 50], [50, 59],
    [41, 51], [51, 52], [42, 53], [53, 54], [43, 55], [55, 56], [44, 57], [57, 58],
  ],
  [
    [741, 'Reed', 2, [51, 52]],
    [742, 'Sedge', 2, [53, 54]],
    [743, 'Rush', 2, [55, 56]],
    [744, 'Fern', 2, [57, 58]],
  ],
);
const BOARD_C = board(
  [
    mine(41, 5), mine(42, 5), mine(43, 5), mine(44, 5), enemy(50, 5), enemy(59, 5),
    ...[51, 52, 53, 54, 55, 56, 57, 58].map((id) => neutral(id, 2)),
  ],
  true,
);

describe('#122 (c): in the opening a start is not stripped when its top-up is less than its armies', () => {
  const g = buildGraph(MAP_C);
  const plan = planTurn({
    graph: g,
    board: BOARD_C,
    me: ME,
    income: 5,
    settings: { ...RATES, oneArmyStandsGuard: false },
    game: { players, turn: 1 },
    options: { adapt: true },
  });

  it('holds two of the three starts the income can cover, not none', () => {
    expect(plan.profile.phase).toBe('opening');
    const held = [41, 42, 43].filter((t) => !plan.conceded.includes(t));
    expect(held.length).toBeGreaterThanOrEqual(2);
    for (const t of held) {
      const stays = 5 + deployedTo(plan, t) - leaving(plan, t);
      expect(armiesToTake(stays, RATES)).toBeGreaterThan(10);
    }
    expect(plan.warnings.join('\n')).not.toMatch(/cannot be held economically \(needs 2, protects \+0\)/);
  });
});

// ---- (d) Local Deployment: a completion that pays back in a turn, against a near miss ----
//   Slate (+3): 81 82 83 84, mine; 81 (2) faces enemy 91 (4), 82 (2) faces enemy 92 (3) (93
//   behind both). Ash (+3): 85 (1, mine, next to 83) and 86 (2-army neutral): 3 armies complete
//   it. Income 8 = 5 free + Slate's 3. Holding Slate whole needs 7; after completing Ash, 5 are
//   left for it — short by 2, a near miss.
const MAP_D = makeMap(
  [81, 82, 83, 84, 85, 86, 91, 92, 93],
  [[81, 82], [82, 83], [83, 84], [84, 81], [81, 91], [82, 92], [91, 93], [92, 93], [83, 85], [85, 86]],
  [
    [781, 'Slate', 3, [81, 82, 83, 84]],
    [782, 'Ash', 3, [85, 86]],
  ],
);
const BOARD_D = board(
  [mine(81, 2), mine(82, 2), mine(83, 1), mine(84, 1), mine(85, 1), neutral(86, 2), enemy(91, 4), enemy(92, 3), enemy(93, 1)],
  true,
);

describe('#122 (d): a completion that pays back in a turn is not deferred to top a near miss up to sure', () => {
  const g = buildGraph(MAP_D);
  const plan = planTurn({
    graph: g,
    board: BOARD_D,
    me: ME,
    income: 8,
    settings: { ...RATES, localDeployments: true },
    game: { players, turn: 12 },
    options: { adapt: true },
  });

  it('completes Ash and keeps Slate as a near miss with its own pool', () => {
    expect(plan.expected.bonusesCompleted).toEqual([782]);
    expect(plan.conceded).toEqual([]);
    expect(deployedTo(plan, 81) + deployedTo(plan, 82)).toBe(5);
    expect(plan.warnings.join('\n')).toMatch(/Bonus Slate \(#781\) \(\+3\) is held though short/);
    expect(plan.rationale.join('\n')).not.toMatch(/Complete bonus Ash \(#782\).*only after holding/);
  });
});

// ---- (e, Local Deployment) two garrisoned members drawing on the free pool together ----
//   A 4x4 grid (ids 1..16, row by row). Mine: Ochre (+5) 11 12 and Teal (+2) 15 16 are held, so
//   7 of the 14 income are pooled and 7 are free. Clay (+5) 3 4 7 8: 3 7 8 mine, 4 a 1-army
//   neutral; capturing 4 completes Clay, whose start members 3 and 7 face enemies. Each garrison
//   fits the free pool on its own; together they overdraw it.
const GRID_IDS = Array.from({ length: 16 }, (_, i) => i + 1);
const GRID_EDGES: [number, number][] = GRID_IDS.flatMap((id) => {
  const x = (id - 1) % 4;
  const out: [number, number][] = [];
  if (x < 3) out.push([id, id + 1]);
  if (id + 4 <= 16) out.push([id, id + 4]);
  return out;
});
const MAP_G = makeMap(GRID_IDS, GRID_EDGES, [
  [801, 'Moor', 4, [1, 2, 5, 6]],
  [802, 'Clay', 5, [3, 4, 7, 8]],
  [803, 'Dune', 3, [9, 10]],
  [804, 'Ochre', 5, [11, 12]],
  [805, 'Heath', 1, [13, 14]],
  [806, 'Teal', 2, [15, 16]],
]);
const BOARD_G = board(
  [
    neutral(1, 3), enemy(2, 7), mine(3, 3), neutral(4, 1), mine(5, 7), enemy(6, 3), mine(7, 1), mine(8, 8),
    enemy(9, 8), mine(10, 8), mine(11, 7), mine(12, 6), enemy(13, 8), mine(14, 6), mine(15, 1), mine(16, 4),
  ],
  true,
);

describe('#122 (e) under Local Deployment: garrisons are checked against the pools together', () => {
  const g = buildGraph(MAP_G);
  const plan = planTurn({
    graph: g,
    board: BOARD_G,
    me: ME,
    income: 14,
    settings: { ...RATES, localDeployments: true },
    game: { players, turn: 8 },
    options: { adapt: true },
  });

  it('deploys exactly the income, within the pools', () => {
    expect(plan.deploys.reduce((s, d) => s + d.armies, 0)).toBe(14);
    const held = new Set([3, 5, 7, 8, 10, 11, 12, 14, 15, 16]);
    const pools = deployPools(g, held, 14);
    const charged = chargeDeploys(pools, new Map(plan.deploys.map((d) => [d.territoryId, d.armies])));
    expect(charged.anywhereUsed).toBeLessThanOrEqual(pools.anywhere);
  });
});
