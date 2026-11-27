// #593 (items 2 and 5a): in a 1v1, an opponent bonus behind the fog is a probable break, and on the
// opening turns a bonus it is one territory short of is a denial; each is sized for a partial deploy (its
// deploy estimate split over its territories beside my land), with the win chance against its whole deploy
// in a warning. In miniature:
//
//   T7 (neutral 2) ─ T1 (mine 8) ─ T2 (his 2) ─ T3 ─ T4 ─ T5      B900 (+4): T2, T3, T4, T5
//                     │
//                     T9 (his 1) ─ T10                           B901 (+1): T9, T10
//
// T3–T5 and T10 are fogged. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake, winChance } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput } from '../../src/analysis/planner.js';
import { foggedBreakables, partialDeploy } from '../../src/analysis/plan/fogged-break.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const HIM = 20;
const his = (territoryId: number, armies: number, playerId = HIM): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const edges: [number, number][] = [[1, 2], [2, 3], [3, 4], [4, 5], [1, 7], [1, 9], [9, 10], [7, 8]];
const map: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: [1, 2, 3, 4, 5, 7, 8, 9, 10].map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
  })),
  bonuses: [
    { id: 900, name: 'B900', value: 4, territoryIds: [2, 3, 4, 5], bonusIds: [] },
    { id: 901, name: 'B901', value: 1, territoryIds: [9, 10], bonusIds: [] },
  ],
  distributionModes: [],
};
const g = buildGraph(map);
const settings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true } as const;
type Opts = { t3?: TerritoryState; t9?: number; players?: number; turn?: number; t1?: number; dropped?: boolean; repulsed?: boolean };
const territories = (o: Opts): TerritoryState[] => [
  mine(1, o.t1 ?? 8),
  his(2, 2),
  o.t3 ?? fogged(3),
  fogged(4),
  fogged(5),
  neutral(7, 2),
  neutral(8, 2),
  his(9, o.t9 ?? 1),
  fogged(10),
];
const input = (o: Opts = {}): PlanInput => ({
  graph: g,
  board: board(territories(o)),
  me: ME,
  income: 6,
  settings,
  game: { players: [{ id: ME }, { id: HIM }, ...(o.players === 3 ? [{ id: 30 }] : [])], turn: o.turn ?? 8 },
  turn: o.turn ?? 8,
  options: { adapt: true },
  ...(o.dropped ? { bonusPush: { allIn: new Set<number>(), dropped: new Set([900]) } } : {}),
  // #240: two failed attacks on T2, its owner putting 4 there each time.
  ...(o.repulsed
    ? {
        repulsed: [
          {
            territoryId: 2,
            playerId: HIM,
            attacks: [
              { turn: 6, armies: 3, before: 2, after: 4, kills: 2 },
              { turn: 7, armies: 3, before: 2, after: 4, kills: 2 },
            ],
          },
        ],
      }
    : {}),
});
const why = (p: ReturnType<typeof planTurn>) => p.rationale.join('\n');
const state = (ts: TerritoryState[]) => new Map(ts.map((t) => [t.territoryId, t]));

describe('#593: which bonuses are probable breaks', () => {
  const foe = (p: number) => p !== ME;
  const mineSet = new Set([1]);

  it('a member in view is his, beside mine, and every fogged member could be his: probable', () => {
    const got = foggedBreakables(g, state(territories({})), foe, mineSet, new Set(), 8);
    expect(got.map((b) => b.bonusId)).toEqual([900, 901]);
    expect(got[0]).toMatchObject({ bonusId: 900, value: 4, player: HIM, members: [2], fogged: 3 });
    expect(got[0]!.shortOf).toBeUndefined();
  });

  it('a member shown with another owner rules it out (past the opening)', () => {
    const got = foggedBreakables(g, state(territories({ t3: neutral(3, 2) })), foe, mineSet, new Set(), 8);
    expect(got.map((b) => b.bonusId)).toEqual([901]);
  });

  it('a bonus already breakable (every member visible, or inferred) is left out', () => {
    const got = foggedBreakables(g, state(territories({})), foe, mineSet, new Set([900]), 8);
    expect(got.map((b) => b.bonusId)).toEqual([901]);
  });

  it('on turns 2–4 a bonus one neutral territory short of complete is a denial (item 5a)', () => {
    for (const turn of [2, 3, 4]) {
      const got = foggedBreakables(g, state(territories({ t3: neutral(3, 2) })), foe, mineSet, new Set(), turn);
      expect(got.find((b) => b.bonusId === 900)).toMatchObject({ shortOf: 3, members: [2] });
    }
    expect(foggedBreakables(g, state(territories({ t3: neutral(3, 2) })), foe, mineSet, new Set(), 5).some((b) => b.bonusId === 900)).toBe(false);
  });

  it('two shown non-his members, or one shown mine, is no denial', () => {
    // Two members shown neutral on an opening turn: he is two short, not one (#599).
    const two = territories({ t3: neutral(3, 2) }).map((t) => (t.territoryId === 4 ? neutral(4, 2) : t));
    expect(foggedBreakables(g, state(two), foe, mineSet, new Set(), 3).some((b) => b.bonusId === 900)).toBe(false);
    const ts = territories({ t3: mine(3, 1) });
    expect(foggedBreakables(g, state(ts), foe, new Set([1, 3]), new Set(), 3).some((b) => b.bonusId === 900)).toBe(false);
  });

  it('the partial deploy splits the estimate over his territories beside mine, rounded up', () => {
    expect(partialDeploy(6, 2)).toBe(3);
    expect(partialDeploy(7, 2)).toBe(4);
    expect(partialDeploy(6, 1)).toBe(6);
    expect(partialDeploy(6, 0)).toBe(6);
  });
});

describe('#593: the planner breaks a fogged bonus in a 1v1', () => {
  it('names the probable bonus and the member, and attacks it sized for a partial deploy', () => {
    const p = planTurn(input());
    expect(why(p)).toMatch(/Player 20 probably holds bonus B900 \(#900\) \(\+4\): T2 \(#2\) in view is its, beside my land, and its 3 fogged members could all be its \(#593\)/);
    const attack = p.moves.find((m) => m.kind === 'attack' && m.to === 2);
    expect(attack).toBeDefined();
    expect(attack!.reason).toMatch(/breaks probable enemy bonus B900 \(#900\) \(\+4 from player 20; .*#593\)/);
    // His deploy estimate (base income, 5) split over his 2 territories beside mine: 3.
    expect(attack!.reason).toMatch(/sized to land if player 20 deploys up to 3 of its ~5 there first \(split over the 2 territories of its beside my land, #593\)/);
    expect(attack!.armies).toBeGreaterThanOrEqual(armiesToTake(2 + 3, settings)!);
    expect(p.expected.captures).toContain(2);
  });

  it('warns with the win chance against his whole deploy when it is sized below it', () => {
    const p = planTurn(input());
    const attack = p.moves.find((m) => m.kind === 'attack' && m.to === 2)!;
    expect(attack.armies).toBeLessThan(armiesToTake(2 + 5, settings)!);
    const w = p.warnings.find((x) => x.startsWith('Attack on enemy T2 (#2) assumes'));
    expect(w).toMatch(/sized for a partial deploy of 3 \(#593\)/);
    expect(w).toContain(`${attack.armies} attack 7 (win chance ${Math.round(winChance(attack.armies, 2 + 5, settings) * 100)}%)`);
  });

  it('not in a game of three players', () => {
    const p = planTurn(input({ players: 3 }));
    expect(why(p)).not.toMatch(/#593/);
    expect(p.moves.some((m) => m.to === 2 && m.kind === 'attack')).toBe(false);
  });

  it('not when a member is shown neutral past the opening', () => {
    const p = planTurn(input({ t3: neutral(3, 2) }));
    expect(p.moves.some((m) => m.to === 2 && m.kind === 'attack' && /B900/.test(m.reason))).toBe(false);
  });

  it('never into a bonus #298 dropped', () => {
    const p = planTurn(input({ dropped: true }));
    expect(p.moves.some((m) => m.to === 2 && m.kind === 'attack' && /B900/.test(m.reason))).toBe(false);
  });

  it('item 5a: on turn 3 a bonus one neutral short of complete is a denial strike', () => {
    const p = planTurn(input({ t3: neutral(3, 2), turn: 3 }));
    const attack = p.moves.find((m) => m.kind === 'attack' && m.to === 2);
    expect(attack?.reason).toMatch(/denies player 20 bonus B900 \(#900\) \(\+4\), one territory short of complete \(T3 \(#3\) still neutral; opening strike, #593\)/);
  });

  it('#240: a territory my attacks failed on is attacked only at its sure size', () => {
    const p = planTurn(input({ repulsed: true }));
    const sent = p.moves.filter((m) => m.kind === 'attack' && m.to === 2).reduce((n, m) => n + m.armies, 0);
    // The most it was reinforced by (4) on top of its 2 defenders, at least the partial deploy (3).
    expect(sent).toBe(armiesToTake(2 + 4, settings)!);
    expect(why(p)).toMatch(/#240/);
  });

  it("never from a hold's armies: the source keeps what holds it against the stack beside it", () => {
    // T9 now holds 6: T1 faces 5 movable plus a ~5 deploy.
    const p = planTurn(input({ t9: 6 }));
    const out = p.moves.filter((m) => m.from === 1).reduce((n, m) => n + m.armies, 0);
    const left = 8 + (p.deploys.find((d) => d.territoryId === 1)?.armies ?? 0) - out;
    // The partial-deploy break (9 for 2 + 3) does not fit beside that hold: it is not made.
    expect(p.moves.some((m) => /#593/.test(m.reason))).toBe(false);
    expect(armiesToTake(left, settings)!).toBeGreaterThan(10);
  });
});
