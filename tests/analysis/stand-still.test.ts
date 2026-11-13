// Issue #104: in a several-player opening, with 5 income and every adjacent neutral at 4 or
// 12, every bonus failed the economy test, so the plan deployed everything to one stack and
// attacked nothing. In the opening and expansion phases — or whenever my armies exceed the
// game's army cap — a plan that would make no capture at all takes the cheapest affordable
// neutral capture toward the bonus with the fewest armies to finish, with armies left after
// every hold. Synthetic maps only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { incomeUncertainties } from '../../src/analysis/player.js';
import { planTurn, type PlanGameContext, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap, GameSettings } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const P2 = 30;
const P3 = 40;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const FFA: PlanGameContext = { players: [{ id: ME }, { id: P2 }, { id: P3 }, { id: 50 }], turn: 2 };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, string, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'StandStill',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, name, value, territoryIds]) => ({ id, name, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const player = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

//   My stack on 1 borders four neutrals: 3 (4, Ridge), 4 (4, Vale), 5 (12, Vale), 10 (12, Marsh).
//   2 is mine too, next to 6 (12, Vale) and, in some boards, an enemy on 22.
//   Ridge (+2): 3 7 8 9 — 6 + 3 × 20 = 66 to finish.
//   Vale  (+2): 4 5 6   — 6 + 2 × 20 = 46 to finish: the cheapest bonus.
//   Marsh (+3): 10 11 12 — 3 × 20 = 60 to finish.
//   Every one is uneconomic (over 10 × its value, or one member over 5 × its value).
//   Other players sit far away on 20 and 21.
const EDGES: [number, number][] = [
  [1, 2], [1, 3], [1, 4], [1, 5], [1, 10], [2, 6], [4, 5], [5, 6],
  [3, 7], [7, 8], [8, 9], [10, 11], [11, 12], [9, 20], [12, 21], [2, 22],
];
const IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 20, 21, 22];
const BONUSES: [number, string, number, number[]][] = [
  [201, 'Ridge', 2, [3, 7, 8, 9]],
  [202, 'Vale', 2, [4, 5, 6]],
  [203, 'Marsh', 3, [10, 11, 12]],
];
const MAP = makeMap(IDS, EDGES, BONUSES);
const g = buildGraph(MAP);

// 22 is out of sight unless a board puts an enemy there.
const far = [player(20, 5, P2), player(21, 5, P3)];
const opening = (stack = 11, extra: TerritoryState[] = []): BoardState =>
  board([
    mine(1, stack),
    mine(2, 1),
    neutral(3, 4),
    neutral(4, 4),
    neutral(5, 12),
    neutral(6, 12),
    neutral(7, 12),
    neutral(8, 12),
    neutral(9, 12),
    neutral(10, 12),
    neutral(11, 12),
    neutral(12, 12),
    ...far.filter((t) => !extra.some((e) => e.territoryId === t.territoryId)),
    ...extra,
  ]);

const plan = (
  b: BoardState,
  income: number,
  o: { settings?: PlannerSettings; game?: PlanGameContext; map?: ReturnType<typeof buildGraph> } = {},
) => planTurn({ graph: o.map ?? g, board: b, me: ME, income, settings: o.settings ?? STD, game: o.game ?? FFA });

const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const deploySum = (p: TurnPlan) => p.deploys.reduce((s, d) => s + d.armies, 0);

/** The plan passes warapp_submit_turn's validator. */
function valid(p: TurnPlan, b: BoardState, income: number, map = MAP) {
  const names = new Map(map.territories.map((t) => [t.id, t.name]));
  const ref = (id: number) => ({ id, name: names.get(id)! });
  return validateTurn({
    map,
    board: b.territories.map(
      (t): LiveTerritory => ({
        territoryId: t.territoryId,
        fogLevel: 1,
        fogged: false,
        owner: t.owner.kind === 'player' ? t.owner.playerId : t.owner.kind === 'neutral' ? OWNER_NEUTRAL : -1,
        armies: t.armies,
      }),
    ),
    myInGameId: ME,
    income,
    guard: true,
    deploys: p.deploys.map((d) => ({ territory: ref(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: ref(m.from), to: ref(m.to), armies: m.armies })),
  }).warnings;
}

describe('never stand still in the opening (#104)', () => {
  it('the arithmetic: a 4-neutral takes 6, a 12-neutral 20', () => {
    expect(armiesToTake(4)).toBe(6);
    expect(armiesToTake(12)).toBe(20);
  });

  it('(a) every bonus uneconomic: one capture of a 4-neutral toward the cheapest bonus, sized correctly', () => {
    const b = opening();
    const p = plan(b, 5);
    expect(p.profile.phase).toBe('opening');
    expect(p.rationale.join('\n')).toMatch(/Skip bonus Vale \(#202\): uneconomic/);
    const a = attacks(p);
    expect(a).toHaveLength(1);
    // Vale (46 to finish) beats Ridge (66) and Marsh (60): its 4-neutral on 4, not Ridge's on 3.
    expect(a[0]).toMatchObject({ from: 1, to: 4, armies: 6, kind: 'attack' });
    expect(a[0]!.reason).toMatch(/Vale \(#202\)/);
    expect(a[0]!.reason).toMatch(/46 armies to finish/);
    expect(p.rationale.join('\n')).toMatch(/nothing passed the economy test; standing still is worse than the cheapest expansion/);
    expect(p.expected.captures).toEqual([4]);
    expect(deploySum(p)).toBe(5);
    expect(valid(p, b, 5)).toEqual([]);
  });

  it('(a) ties on armies to finish go to the higher value, then the lower id', () => {
    // Twin (+3) mirrors Vale's 46 to finish with a 4-neutral next to my stack on 13.
    const map = makeMap(
      [...IDS, 13, 14, 15],
      [...EDGES, [1, 13], [13, 14], [14, 15]],
      [...BONUSES, [204, 'Twin', 3, [13, 14, 15]]],
    );
    // Twin: 6 + 20 + 20 = 46, value 3 > Vale's 2. Uneconomic: one member costs 20 > 5 × 3.
    const b = board([...opening().territories, neutral(13, 4), neutral(14, 12), neutral(15, 12)]);
    const p = plan(b, 5, { map: buildGraph(map) });
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 13, armies: 6 })]);
    expect(valid(p, b, 5, map)).toEqual([]);
  });

  it('(a) a capture that needs deploys is funded from the income', () => {
    // A 4-army stack (3 movable) needs 3 more for the 6-army capture.
    const b = opening(4);
    const p = plan(b, 5);
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 4, armies: 6 })]);
    expect(p.deploys.find((d) => d.territoryId === 1)?.armies ?? 0).toBeGreaterThanOrEqual(3);
    expect(valid(p, b, 5)).toEqual([]);
  });

  describe('(b) a threatened hold comes first', () => {
    // Keep (+3) is 1 and 2, mine in full; an enemy stack on 22 threatens 2.
    const map = makeMap(IDS, EDGES, [...BONUSES, [205, 'Keep', 3, [1, 2]]]);
    const kg = buildGraph(map);
    const boardWith = (stack: number, enemy: number, border: number): BoardState => {
      const b = opening(stack, [player(22, enemy, P2)]);
      return board(b.territories.map((t) => (t.territoryId === 2 ? mine(2, border) : t)));
    };

    it('the fallback uses only what the hold leaves', () => {
      // Threat on 2: 4 movable + ~5 deploy = 9; 4 armies need 6 to take, 5 need 8, 6 need 10 — hold with 2.
      expect(armiesToTake(5)).toBe(8);
      expect(armiesToTake(6)).toBe(10);
      const b = boardWith(4, 5, 4);
      const p = plan(b, 5, { map: kg });
      expect(p.conceded).toEqual([]);
      expect(p.deploys.find((d) => d.territoryId === 2)?.armies).toBe(2);
      // 3 left: the stack's 3 movable + 3 deploys take the 4-neutral.
      expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 4, armies: 6 })]);
      expect(p.deploys.find((d) => d.territoryId === 1)?.armies).toBe(3);
      expect(valid(p, b, 5, map)).toEqual([]);
    });

    it('none left: no capture, and a warning says why', () => {
      // Threat on 2: 7 movable + ~5 = 12; 3 armies need all 5 deploys to hold (7 need 11, 8 need 13).
      expect(armiesToTake(7)).toBe(11);
      expect(armiesToTake(8)).toBe(13);
      const b = boardWith(4, 8, 3);
      const p = plan(b, 5, { map: kg });
      expect(p.conceded).toEqual([]);
      expect(p.deploys).toEqual([{ territoryId: 2, armies: 5 }]);
      expect(attacks(p)).toEqual([]);
      expect(p.warnings.join('\n')).toMatch(/standing still.*cheapest expansion.*T4 \(#4\).*Vale \(#202\)/i);
      expect(valid(p, b, 5, map)).toEqual([]);
    });
  });

  it('(c) an economic bonus exists: the plan is the economic one, no fallback', () => {
    // Vale's other members hold 1: 6 + 2 + 2 = 10 to finish, economic for +2.
    const b = board(
      opening().territories.map((t) => (t.territoryId === 5 || t.territoryId === 6 ? neutral(t.territoryId, 1) : t)),
    );
    const p = plan(b, 5);
    expect(p.rationale.join('\n')).not.toMatch(/standing still/i);
    expect(p.warnings.join('\n')).not.toMatch(/standing still/i);
    expect(attacks(p).map((m) => m.to).sort()).toEqual(expect.arrayContaining([4, 5]));
    for (const m of attacks(p)) expect(m.reason).not.toMatch(/cheapest expansion/);
  });

  it('(c) outside the opening and expansion phases (no army cap), nothing changes', () => {
    // Turn 9, in contact with player 30 on 22 (a 1-army stack: no threat to a 6-army border).
    const b = board(
      opening(11, [player(22, 1, P2)]).territories.map((t) => (t.territoryId === 2 ? mine(2, 6) : t)),
    );
    const p = plan(b, 5, { game: { ...FFA, turn: 9 } });
    expect(p.profile.phase).toBe('contact');
    expect(attacks(p)).toEqual([]);
    expect(p.rationale.join('\n')).not.toMatch(/standing still/i);
  });

  it('(d) army cap exceeded in a later phase: the fallback fires, and says why', () => {
    const b = board(
      opening(11, [player(22, 1, P2)]).territories.map((t) => (t.territoryId === 2 ? mine(2, 6) : t)),
    );
    // 17 armies + 5 deployed = 22 > 4 × 5 = 20.
    const p = plan(b, 5, { game: { ...FFA, turn: 9 }, settings: { ...STD, armyCap: 4 } });
    expect(p.profile.phase).toBe('contact');
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 4, armies: 6 })]);
    expect(p.rationale.join('\n')).toMatch(/22 armies after deploy exceed the army cap of 20 \(4× income 5\)/);
    expect(valid(p, b, 5)).toEqual([]);
    // Under the cap (5× income = 25), nothing changes.
    const under = plan(b, 5, { game: { ...FFA, turn: 9 }, settings: { ...STD, armyCap: 5 } });
    expect(attacks(under)).toEqual([]);
  });

  it('(e) only negative bonuses nearby: no fallback capture', () => {
    const map = makeMap(
      [1, 2, 3, 4],
      [[1, 2], [1, 3], [1, 4]],
      [
        [301, 'Bog', -1, [3]],
        [302, 'Mire', -2, [4]],
      ],
    );
    const b = board([mine(1, 11), mine(2, 1), neutral(3, 4), neutral(4, 4)]);
    const p = plan(b, 5, { map: buildGraph(map) });
    expect(attacks(p)).toEqual([]);
    expect(p.rationale.join('\n')).not.toMatch(/standing still/i);
    expect(p.warnings.join('\n')).not.toMatch(/standing still/i);
  });

  it('the army cap warning names only what is still not modelled', () => {
    const s = { armyCap: 8, cards: [] } as unknown as GameSettings;
    const w = incomeUncertainties(s).join('\n');
    expect(w).toMatch(/army cap \(8× income\)/);
    expect(w).toMatch(/income model does not apply it/);
    expect(w).not.toMatch(/the model does not apply it/);
  });
});
