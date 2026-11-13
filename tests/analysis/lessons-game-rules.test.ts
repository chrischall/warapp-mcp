// Lessons from the game rules the planner ignored (issues #28, #29, #31; see
// docs/PLAN-PLANNER-4.md "Why"): kill rates, Local Deployment and No-Split. One
// synthetic board is planned at 20/80 under all four combinations of
// {localDeployments, noSplit}, and each plan is checked by warapp_submit_turn's
// validator with the same settings — the planner must never propose a turn the
// validator refuses. Every map, id and name here is made up.
//
//   Home (+3): 1 2 3   — held; 3 borders two cheap neutrals (4, 5), 1 an enemy at 9
//   Pair (+2): 4 5     — two 1-army neutrals next to my 3
//   Far  (+4): 6 7     — my 6 (outside Home) next to a neutral 7
//   Rest:      8 9     — 8 a neutral next to 6; 9 the enemy's
//
//   1─2, 2─3, 1─3, 3─4, 3─5, 4─5, 2─6, 6─7, 6─8, 1─9
import { describe, expect, it } from 'vitest';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { boardStateFromLive, OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap, Player } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';

const ME = 1234;
const ENEMY = 5678;
const EDGES: [number, number][] = [
  [1, 2], [2, 3], [1, 3], [3, 4], [3, 5], [4, 5],
  [2, 6], [6, 7], [6, 8], [1, 9],
];
const IDS = Array.from({ length: 9 }, (_, i) => i + 1);
const MAP: GameMap = {
  id: 1,
  name: 'Rulebook',
  territories: IDS.map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: EDGES.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
  })),
  bonuses: [
    { id: 401, name: 'Home', value: 3, territoryIds: [1, 2, 3], bonusIds: [] },
    { id: 402, name: 'Pair', value: 2, territoryIds: [4, 5], bonusIds: [] },
    { id: 403, name: 'Far', value: 4, territoryIds: [6, 7], bonusIds: [] },
  ],
  distributionModes: [],
};
const g = buildGraph(MAP);
const HOME = [1, 2, 3];

const t = (territoryId: number, owner: number, armies: number): LiveTerritory => ({
  territoryId,
  fogLevel: 1,
  fogged: false,
  owner,
  armies,
});
/** The live board warapp_submit_turn validates against (every territory visible). */
const LIVE: LiveTerritory[] = [
  t(1, ME, 4),
  t(2, ME, 2),
  t(3, ME, 12),
  t(4, OWNER_NEUTRAL, 1),
  t(5, OWNER_NEUTRAL, 1),
  t(6, ME, 3),
  t(7, OWNER_NEUTRAL, 2),
  t(8, OWNER_NEUTRAL, 1),
  t(9, ENEMY, 3),
];
/** GameFeed ids: the in-game id plus two check digits each end. */
const player = (id: number, name: string): Player => ({
  id,
  name,
  isAI: false,
  humanTurnedIntoAI: false,
  hasCommittedOrders: false,
});
const ME_FEED = 11123499;
const players = [player(ME_FEED, 'Me'), player(22567833, 'Them')];
const BOARD = boardStateFromLive(LIVE, players[0]!, players);
const BASE = 5;
const INCOME = BASE + 3; // base + Home

const RATES: PlannerSettings = {
  offensiveKillRate: 20,
  defensiveKillRate: 80,
  roundingMode: 'StraightRound',
  luckModifier: 0,
  oneArmyStandsGuard: true,
  baseIncome: BASE,
};

const plan = (settings: PlannerSettings): TurnPlan =>
  planTurn({ graph: g, board: BOARD, me: ME_FEED, income: INCOME, settings, options: { goal: 'expand' } });

const named = (id: number) => ({ id, name: `T${id}` });
const validate = (p: TurnPlan, settings: PlannerSettings) =>
  validateTurn({
    map: MAP,
    board: LIVE,
    myInGameId: ME,
    income: INCOME,
    guard: settings.oneArmyStandsGuard ?? true,
    deploys: p.deploys.map((d) => ({ territory: named(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: named(m.from), to: named(m.to), armies: m.armies })),
    localDeployments: settings.localDeployments ?? false,
    noSplit: settings.noSplit ?? false,
  });
const deploySum = (p: TurnPlan, ids?: number[]) =>
  p.deploys.filter((d) => !ids || ids.includes(d.territoryId)).reduce((s, d) => s + d.armies, 0);
const ordersFrom = (p: TurnPlan, id: number) => p.moves.filter((m) => m.from === id);

describe('game rules: kill rates, Local Deployment and No-Split (issues #28, #29, #31)', () => {
  it('the board is sized at 20/80: a 1-army neutral costs 3, a 2-army one 8 (hand-derived)', () => {
    // round(a × 0.2) ≥ d  ⇔  a ≥ (100d − 50) / 20; and a − round(0.8d) ≥ 1.
    // 1 defender: max(ceil(50 / 20) = 3, round(0.8) + 1 = 2) = 3   (2 at 60/70).
    // 2 defenders: max(ceil(150 / 20) = 8, round(1.6) + 1 = 3) = 8 (3 at 60/70).
    expect(armiesToTake(1, RATES)).toBe(3);
    expect(armiesToTake(2, RATES)).toBe(8);
  });

  for (const localDeployments of [false, true]) {
    for (const noSplit of [false, true]) {
      const settings: PlannerSettings = {
        ...RATES,
        ...(localDeployments ? { localDeployments } : {}),
        ...(noSplit ? { noSplit } : {}),
      };
      it(`localDeployments ${localDeployments ? 'on' : 'off'}, noSplit ${noSplit ? 'on' : 'off'}: the validator accepts the plan`, () => {
        const p = plan(settings);
        expect(() => validate(p, settings)).not.toThrow();
        expect(deploySum(p)).toBe(INCOME);
        // Every attack is sized at 20/80.
        for (const m of p.moves.filter((x) => x.kind === 'attack')) {
          const defenders = LIVE.find((x) => x.territoryId === m.to)!.armies!;
          expect(m.armies).toBeGreaterThanOrEqual(armiesToTake(defenders, RATES)!);
        }
        if (localDeployments) {
          // Home's +3 is deployed inside Home; at most the base income goes elsewhere.
          expect(deploySum(p, HOME)).toBeGreaterThanOrEqual(3);
          expect(INCOME - deploySum(p, HOME)).toBeLessThanOrEqual(BASE);
          expect(p.rationale.join('\n')).toMatch(/Local Deployment/);
        }
        if (noSplit) {
          for (const id of IDS) expect(ordersFrom(p, id).length, `orders from T${id}`).toBeLessThanOrEqual(1);
          expect(p.rationale.join('\n')).toMatch(/No-Split/);
          // #124: every order is the whole stack, so the validator has nothing to warn about.
          expect(validate(p, settings).warnings.filter((w) => w.startsWith('No-Split'))).toEqual([]);
        }
      });
    }
  }

  it('No-Split: T3 attacks both 1-army neutrals with 3 each only when splitting is allowed (else one, with its whole stack)', () => {
    const attacksFrom3 = (p: TurnPlan) =>
      ordersFrom(p, 3).filter((m) => m.kind === 'attack').map((m) => [m.to, m.armies]);
    expect(attacksFrom3(plan(RATES))).toEqual([[4, 3], [5, 3]]);
    const one = plan({ ...RATES, noSplit: true });
    // #124: the one attack carries T3's whole stack (12, plus its deploys, less the guard).
    expect(ordersFrom(one, 3)).toEqual([expect.objectContaining({ kind: 'attack', to: 4, armies: 11 + deploySum(one, [3]) })]);
    expect(one.warnings.join('\n')).toMatch(/No-Split: T3 \(#3\) already attacks T4 \(#4\), so the attack on T5 \(#5\) is not planned/);
  });

  it('Local Deployment: Far (+4) needs 6 deployed on T6, more than the 5 that may go outside Home', () => {
    // T7 (2) costs 8 at 20/80; T6 holds 3 (2 movable), so 6 must be deployed there.
    const free = plan(RATES);
    expect(free.deploys).toEqual([{ territoryId: 6, armies: 8 }]);
    expect(ordersFrom(free, 6)).toEqual([expect.objectContaining({ kind: 'attack', to: 7, armies: 8 })]);
    const local = plan({ ...RATES, localDeployments: true });
    expect(local.moves.some((m) => m.to === 7)).toBe(false);
    expect(deploySum(local, HOME)).toBe(7);
    expect(deploySum(local, [6])).toBe(1);
    expect(local.rationale.join('\n')).toMatch(/bonus Home \(#401\)'s \+3 may only be deployed on its territories/);
  });

  it('the validator refuses what the rules forbid on this board (the planner never proposes it)', () => {
    const split = plan(RATES);
    expect(() => validate(split, { ...RATES, noSplit: true })).toThrow(/No-Split/);
    const outside: TurnPlan = { ...split, deploys: [{ territoryId: 6, armies: INCOME }], moves: [] };
    expect(() => validate(outside, { ...RATES, localDeployments: true })).toThrow(/Local Deployment/);
    expect(() => validate(outside, RATES)).not.toThrow();
  });
});
