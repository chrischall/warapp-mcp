// Overridden bonus values (#62). A game can override any bonus's value (GameFeed
// settings `OverriddenBonuses`; the client keeps it as a Dictionary<bonusId, value>).
// Live: a Local Deployment game, base 2, two single-territory bonuses overridden to
// 12 and 7 → war.app's income 21 = 2 anywhere + 12 + 7. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import { rankBonuses } from '../../src/analysis/bonuses.js';
import { chargeDeploys, deployPools } from '../../src/analysis/local-deploy.js';
import { applyBonusOverrides, overrideUncertainties } from '../../src/analysis/overrides.js';
import { planPicks } from '../../src/analysis/picks.js';
import { incomeFor, planTurn } from '../../src/analysis/planner.js';
import { analyzePlayer, deployCheckUncertainties, incomeUncertainties } from '../../src/analysis/player.js';
import { normalizeSettings, parseOverriddenBonuses, type GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, mine, neutral, tinyMap } from './helpers.js';

const ME = 10;

/**
 * The live case, shrunk: 1 ─ 2 ─ 3 ─ 4. Bonus 50 is territory 1 alone (+6 on the map),
 * bonus 52 is territory 4 alone (+5), bonus 60 is 2+3 (+3). I hold 1 and 4.
 */
function westeros(): GameMap {
  return {
    id: 7,
    name: 'Westeros-ish',
    territories: [1, 2, 3, 4].map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: [id - 1, id + 1].filter((x) => x >= 1 && x <= 4),
    })),
    bonuses: [
      { id: 50, name: 'Keep', value: 6, territoryIds: [1], bonusIds: [] },
      { id: 52, name: 'Square', value: 5, territoryIds: [4], bonusIds: [] },
      { id: 60, name: 'Middle', value: 3, territoryIds: [2, 3], bonusIds: [] },
    ],
    distributionModes: [],
  };
}

const liveSettings = (overrides: unknown) =>
  normalizeSettings({ MinimumArmyBonus: '2', BonusArmyPer: '0', LocalDeployments: true, OverriddenBonuses: overrides });
const LIVE_OVERRIDES = [
  { bonusID: 50, value: 12 },
  { bonusID: 52, value: 7 },
];
const liveBoard = () => board([mine(1, 2), neutral(2, 2), neutral(3, 2), mine(4, 2)], true);

describe('parseOverriddenBonuses', () => {
  const want = new Map([
    [50, 12],
    [52, 7],
  ]);
  it.each([
    ['an array of { bonusID, value }', [{ bonusID: 50, value: 12 }, { bonusID: 52, value: 7 }]],
    ['an array of { BonusID, Value } with string scalars', [{ BonusID: '50', Value: '12' }, { BonusID: '52', Value: '7' }]],
    ['an array of { id, value }', [{ id: 50, value: 12 }, { id: 52, value: 7 }]],
    ['an array of { ID, Value }', [{ ID: '50', Value: 12 }, { ID: 52, Value: '7' }]],
    ['an array of { Key, Value } pairs', [{ Key: 50, Value: 12 }, { Key: '52', Value: '7' }]],
    ['an array of [id, value] tuples', [[50, 12], ['52', '7']]],
    ['an object keyed by bonus id', { '50': 12, '52': 7 }],
    ['an object keyed by bonus id with string values', { '50': '12', '52': '7' }],
    ['a JSON string of an object', '{"50":"12","52":"7"}'],
    ['a JSON string of an array', '[{"bonusID":"50","value":"12"},{"bonusID":"52","value":"7"}]'],
  ])('accepts %s', (_name, raw) => {
    expect(parseOverriddenBonuses(raw)).toEqual({ values: want, unparsed: false });
  });

  it('reads a negative override and an empty value as no overrides', () => {
    expect(parseOverriddenBonuses({ '3': '-2' })).toEqual({ values: new Map([[3, -2]]), unparsed: false });
    expect(parseOverriddenBonuses([])).toEqual({ values: new Map(), unparsed: false });
    expect(parseOverriddenBonuses({})).toEqual({ values: new Map(), unparsed: false });
    expect(parseOverriddenBonuses('')).toEqual({ values: new Map(), unparsed: false });
  });

  it.each([
    ['a bare number', 12],
    ['an array of unknown objects', [{ foo: 1, bar: 2 }]],
    ['an array with one bad entry', [{ bonusID: 50, value: 12 }, { bonusID: 52 }]],
    ['an object with a non-numeric key', { House: 12 }],
    ['an object with a non-integer value', { '50': 'twelve' }],
    ['a string that is not JSON', 'House Stark=12'],
    ['a boolean', true],
  ])('flags %s as unparsed with no values, without throwing', (_name, raw) => {
    expect(parseOverriddenBonuses(raw)).toEqual({ values: new Map(), unparsed: true });
  });
});

describe('normalizeSettings OverriddenBonuses', () => {
  it('keeps the parsed map, and flags an unknown shape', () => {
    expect(liveSettings(LIVE_OVERRIDES).overriddenBonuses).toEqual(
      new Map([
        [50, 12],
        [52, 7],
      ]),
    );
    expect(liveSettings(LIVE_OVERRIDES).overriddenBonusesUnparsed).toBeUndefined();
    const bad = liveSettings(42);
    expect(bad.overriddenBonuses).toEqual(new Map());
    expect(bad.overriddenBonusesUnparsed).toBe(true);
  });
  it('sets nothing when the game sends no overrides', () => {
    const s = normalizeSettings({ MinimumArmyBonus: 5 });
    expect(s.overriddenBonuses).toBeUndefined();
    expect(s.overriddenBonusesUnparsed).toBeUndefined();
    expect(normalizeSettings({ OverriddenBonuses: null }).overriddenBonuses).toBeUndefined();
  });
});

describe('applyBonusOverrides', () => {
  it('returns the same map when there is nothing to apply', () => {
    const map = westeros();
    expect(applyBonusOverrides(map, undefined)).toBe(map);
    expect(applyBonusOverrides(map, normalizeSettings({}))).toBe(map);
    expect(applyBonusOverrides(map, liveSettings([]))).toBe(map);
    expect(applyBonusOverrides(map, liveSettings(42))).toBe(map);
    // An override to the map's own value, or of a bonus not on the map, changes nothing.
    expect(applyBonusOverrides(map, liveSettings({ '50': 6, '999': 4 }))).toBe(map);
  });

  it('returns a new map with the game values, never touching the cached one, and the same object each time', () => {
    const map = westeros();
    const s = liveSettings(LIVE_OVERRIDES);
    const out = applyBonusOverrides(map, s);
    expect(out).not.toBe(map);
    expect(out.bonuses.map((b) => [b.id, b.value])).toEqual([
      [50, 12],
      [52, 7],
      [60, 3],
    ]);
    expect(map.bonuses.map((b) => b.value)).toEqual([6, 5, 3]);
    expect(out.territories).toBe(map.territories);
    expect(applyBonusOverrides(map, liveSettings(LIVE_OVERRIDES))).toBe(out);
  });

  it('overrides a superbonus value', () => {
    const map = tinyMap();
    const out = applyBonusOverrides(map, normalizeSettings({ OverriddenBonuses: { '104': 20 } }));
    expect(out.bonuses.find((b) => b.id === 104)!.value).toBe(20);
    const g = buildGraph(out);
    // Holding A + B (1..5) earns A 3 + B 2 + S 20.
    const held = board([1, 2, 3, 4, 5].map((t) => mine(t, 1)), true);
    expect(analyzePlayer(g, held, ME, normalizeSettings({ MinimumArmyBonus: 5 })).income.total).toBe(5 + 3 + 2 + 20);
  });
});

describe('the live case: Local Deployment, base 2, bonuses overridden to 12 and 7', () => {
  const s = liveSettings(LIVE_OVERRIDES);
  const g = buildGraph(applyBonusOverrides(westeros(), s));

  it('income is 21, not the map values’ 13', () => {
    expect(incomeFor(g, liveBoard(), ME, s)).toBe(21);
    expect(incomeFor(buildGraph(westeros()), liveBoard(), ME, s)).toBe(13);
  });

  it('the Local Deployment pools are 2 anywhere, 12 and 7', () => {
    const pools = deployPools(g, new Set([1, 4]), 21);
    expect(pools.anywhere).toBe(2);
    expect(pools.bonuses.map((p) => [p.bonusId, p.value])).toEqual([
      [50, 12],
      [52, 7],
    ]);
    expect(chargeDeploys(pools, new Map([[1, 14], [4, 7]])).anywhereUsed).toBe(2);
  });

  it("validateTurn accepts the deploy panel's split", () => {
    const live = [
      { territoryId: 1, fogLevel: 1, fogged: false, owner: 77, armies: 2 },
      { territoryId: 2, fogLevel: 1, fogged: false, owner: 0, armies: 2 },
      { territoryId: 3, fogLevel: 1, fogged: false, owner: 0, armies: 2 },
      { territoryId: 4, fogLevel: 1, fogged: false, owner: 77, armies: 2 },
    ];
    const r = validateTurn({
      map: g.map,
      board: live,
      myInGameId: 77,
      income: 21,
      guard: true,
      deploys: [
        { territory: { id: 1, name: 'T1' }, armies: 14 },
        { territory: { id: 4, name: 'T4' }, armies: 7 },
      ],
      moves: [],
      localDeployments: true,
      incomeUncertain: deployCheckUncertainties(s),
      poolsUncertain: overrideUncertainties(s),
    });
    expect(r.warnings).toEqual([]);
  });

  it('the plan deploys 21 within the pools', () => {
    const plan = planTurn({
      graph: g,
      board: liveBoard(),
      me: ME,
      income: 21,
      settings: { baseIncome: 2, localDeployments: true, oneArmyStandsGuard: true },
    });
    const on = (t: number) => plan.deploys.filter((d) => d.territoryId === t).reduce((n, d) => n + d.armies, 0);
    expect(on(1) + on(4)).toBe(21);
    expect(on(1)).toBeGreaterThanOrEqual(12);
    expect(on(4)).toBeGreaterThanOrEqual(7);
  });
});

describe('fail soft while the shape is unverified', () => {
  const live = [
    { territoryId: 1, fogLevel: 1, fogged: false, owner: 77, armies: 2 },
    { territoryId: 4, fogLevel: 1, fogged: false, owner: 77, armies: 2 },
  ];
  const args = (map: GameMap, income: number, deploys: Array<[number, number]>) => ({
    map,
    board: live,
    myInGameId: 77,
    income,
    guard: true,
    deploys: deploys.map(([id, armies]) => ({ territory: { id, name: `T${id}` }, armies })),
    moves: [],
    localDeployments: true,
  });

  it('an unparseable shape: map values are used, income names it, and both checks warn instead of refusing', () => {
    const s = liveSettings('House Stark=12');
    const map = applyBonusOverrides(westeros(), s);
    expect(map).toEqual(westeros());
    expect(incomeFor(buildGraph(map), liveBoard(), ME, s)).toBe(13);
    expect(incomeUncertainties(s).join('\n')).toMatch(/overridden bonus values.*could not be read/i);
    // The panel's 21, split 14 / 7: the model says 13, with pools 6 and 5 and 2 anywhere.
    const r = validateTurn({
      ...args(map, 13, [[1, 14], [4, 7]]),
      incomeUncertain: deployCheckUncertainties(s),
      poolsUncertain: overrideUncertainties(s),
    });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join('\n')).toMatch(/deploy 21 armies.*modelled income is 13/);
    expect(r.warnings.join('\n')).toMatch(/Local Deployment/);
    // Without the soft reasons, the same orders are refused.
    expect(() => validateTurn(args(map, 13, [[1, 14], [4, 7]]))).toThrow(/deploy 21 armies, but your income is 13/);
  });

  it('a cleanly parsed shape is applied (not listed as an income uncertainty) but the checks stay soft until verified', () => {
    const s = liveSettings(LIVE_OVERRIDES);
    expect(incomeUncertainties({ ...s, minimumArmyBonus: 2 })).toEqual([]);
    expect(overrideUncertainties(s).join('\n')).toMatch(/unverified/i);
    expect(deployCheckUncertainties(s).join('\n')).toMatch(/unverified/i);
    expect(overrideUncertainties(s, true)).toEqual([]);
    const map = applyBonusOverrides(westeros(), s);
    // Everything in one bonus pool: refused hard without the soft reasons, warned with them.
    expect(() => validateTurn(args(map, 21, [[1, 21]]))).toThrow(/Local Deployment/);
    const r = validateTurn({
      ...args(map, 21, [[1, 21]]),
      incomeUncertain: deployCheckUncertainties(s),
      poolsUncertain: overrideUncertainties(s),
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/Local Deployment.*not refused here/i);
  });

  it('no overrides: exactly today’s behaviour', () => {
    const s = normalizeSettings({ MinimumArmyBonus: '2', LocalDeployments: true, OverriddenBonuses: [] });
    expect(overrideUncertainties(s)).toEqual([]);
    expect(incomeUncertainties(s)).toEqual([]);
    expect(deployCheckUncertainties(s)).toEqual([]);
    const map = applyBonusOverrides(westeros(), s);
    expect(map.bonuses.map((b) => b.value)).toEqual([6, 5, 3]);
    expect(incomeFor(buildGraph(map), liveBoard(), ME, s)).toBe(13);
    expect(() => validateTurn(args(map, 13, [[1, 13]]))).toThrow(/Local Deployment/);
  });
});

describe('bonus scoring uses the overridden value', () => {
  // 1 ─ 2 ─ 3 ─ 4: bonus 1 = {1}, bonus 2 = {4}, both +1 on the map; the game makes bonus 2 +10.
  const map: GameMap = {
    id: 3,
    name: 'Pair',
    territories: [1, 2, 3, 4].map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: [id - 1, id + 1].filter((x) => x >= 1 && x <= 4),
    })),
    bonuses: [
      { id: 1, name: 'West', value: 1, territoryIds: [1], bonusIds: [] },
      { id: 2, name: 'East', value: 1, territoryIds: [4], bonusIds: [] },
    ],
    distributionModes: [],
  };
  const s = normalizeSettings({ MinimumArmyBonus: 5, OverriddenBonuses: [{ bonusID: 2, value: 10 }] });

  it('ranks the +10 bonus first', () => {
    expect(rankBonuses(buildGraph(map))[0]!.bonusId).toBe(1);
    expect(rankBonuses(buildGraph(applyBonusOverrides(map, s)))[0]!.bonusId).toBe(2);
  });

  it('the pick advisor picks the +10 bonus first', () => {
    const pick = (m: GameMap) =>
      planPicks({
        graph: buildGraph(m),
        pickable: [1, 4],
        settings: { minimumArmyBonus: 5, initialPlayerArmiesPerTerritory: 5, initialNonDistributionArmies: 2 },
        players: 2,
        territoryLimit: 1,
        maxPicks: 2,
      }).picks[0]!.territoryId;
    expect(pick(map)).toBe(1);
    expect(pick(applyBonusOverrides(map, s))).toBe(4);
  });

  it('the planner prefers completing the +10 bonus', () => {
    // I hold 2 and 3 (5 armies each); 1 and 4 are 1-army neutrals; income 5 buys one capture.
    const b = board([neutral(1, 1), mine(2, 5), mine(3, 5), neutral(4, 1)], true);
    const plan = (m: GameMap) =>
      planTurn({ graph: buildGraph(m), board: b, me: ME, income: 5, settings: { baseIncome: 5 } }).expected
        .bonusesCompleted;
    expect(plan(applyBonusOverrides(map, s))).toContain(2);
  });
});
