// Issue #124: under No-Split the whole stack moves. war.app's No-Split mode sends every available
// army of a territory in its one attack or transfer (the wiki, and a live turn where four orders
// of 3 from stacks of 8, 7, 4 and 3 left every source empty). So an order's armies are the whole
// stack, this turn's deploys there included; a territory that must hold issues no order; and a
// strike stack's one order goes to the strike before a small expansion. Synthetic maps only.
// Kill rates 60/70, no luck.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import type { OpponentTrack } from '../../src/analysis/opponents.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const NOSPLIT: PlannerSettings = { ...STD, noSplit: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  return {
    id: 1,
    name: 'Synthetic whole stack',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const enemy = (territoryId: number, armies: number, playerId = ENEMY): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const deployedOn = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
/** What `id` can send this turn: its armies plus this turn's deploys there, less the guard. */
const stackOf = (input: PlanInput, p: TurnPlan, id: number) => {
  const st = input.board.territories.find((t) => t.territoryId === id)!;
  const guard = (input.settings?.oneArmyStandsGuard ?? true) ? 1 : 0;
  return (st.armies ?? 0) + deployedOn(p, id) - guard;
};

/** A track observed over two turns with `income`. */
function track(playerId: number, income: number, visibleIncome = 5): OpponentTrack {
  const turn = { from: 0, to: 1, observed: income, raw: income, cap: income, counted: [], captured: [], fromFog: [], reveals: [], visibleIncome, earned: income, net: 0, losses: 0, fogArmies: 0, measured: 0, broken: [], brokenValue: 0, low: income, high: income, reinforced: [], grewFromFog: [], emptied: [], combat: 0 };
  return {
    playerId,
    firstSeen: 1,
    lastTurn: 3,
    turns: [
      { ...turn, from: 1, to: 2 },
      { ...turn, from: 2, to: 3 },
    ],
    base: visibleIncome,
    bonusIncome: 0,
    visibleIncome,
    income,
    incomeTurns: [1, 2],
    observedRange: { min: income, max: income },
    incomeMethod: 'max-observed',
    incomeLowered: 0,
    unexplained: 0,
    visible: 1,
    turnsUnseen: 0,
    turnsUnseenAtLeast: false,
    earnedAtLeast: null,
    warnings: [],
    inferred: null,
    notes: [],
  };
}

/** The plan passes warapp_submit_turn's validator (it throws on a refusal); its warnings. */
function validate(input: PlanInput, p: TurnPlan): string[] {
  const map = input.graph.map;
  const names = new Map(map.territories.map((t) => [t.id, t.name]));
  const ref = (id: number) => ({ id, name: names.get(id)! });
  return validateTurn({
    map,
    board: input.board.territories.map(
      (t): LiveTerritory => ({
        territoryId: t.territoryId,
        fogLevel: t.armies === null ? 4 : 1,
        fogged: t.armies === null,
        owner: t.owner.kind === 'player' ? t.owner.playerId : t.owner.kind === 'neutral' ? OWNER_NEUTRAL : -1,
        armies: t.armies,
      }),
    ),
    myInGameId: ME,
    income: input.income,
    guard: input.settings?.oneArmyStandsGuard ?? true,
    deploys: p.deploys.map((d) => ({ territory: ref(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: ref(m.from), to: ref(m.to), armies: m.armies })),
    noSplit: input.settings?.noSplit === true,
  }).warnings;
}

describe('No-Split: an order sends the whole stack, deploys included (#124)', () => {
  // T2 ─ T1 ─ T3: T1 (10) takes T3 (2 armies, bonus B50 +2 alone); T2 is dropped (one order).
  const g = buildGraph(
    makeMap(
      [1, 2, 3],
      [
        [1, 2],
        [1, 3],
      ],
      [[50, 2, [3]]],
    ),
  );
  const s = board([mine(1, 10), neutral(2, 1), neutral(3, 2)]);

  it('the attack carries every army on T1 and every army deployed there, less the guard', () => {
    const input: PlanInput = { graph: g, board: s, me: ME, income: 5, settings: NOSPLIT };
    const p = planTurn(input);
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 5 }]);
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 3, armies: 14 })]);
    expect(p.warnings.join('\n')).not.toMatch(/sends the planned armies/);
    expect(p.rationale.join('\n')).toMatch(/No-Split: .*whole stack/);
    expect(validate(input, p)).toEqual([]);
  });

  it('with one-army-stands-guard off, nothing stays', () => {
    const input: PlanInput = { graph: g, board: s, me: ME, income: 5, settings: { ...NOSPLIT, oneArmyStandsGuard: false } };
    const p = planTurn(input);
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 3, armies: 15 })]);
  });

  it('flag off: the planned amount, as before', () => {
    const p = planTurn({ graph: g, board: s, me: ME, income: 5, settings: STD });
    expect(attacks(p).find((m) => m.to === 3)?.armies).toBeLessThan(14);
  });
});

// The issue's shape: T1 (29) is the border of a held +4 (B60: T1, T5) beside the enemy's T2 (12,
// next to the fog), and a 1-army neutral T3 is next to it. With splitting allowed T1 takes T3 and
// keeps the rest; under No-Split that attack would empty T1 and hand the +4 to the 12.
//   T5 ─ T1 ─ T3,  T1 ─ T2 (enemy) ─ T6 (fog)
describe('No-Split: a territory that must hold issues no order (#124)', () => {
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 5, 6],
      [
        [1, 2],
        [1, 3],
        [1, 5],
        [2, 6],
      ],
      [[60, 4, [1, 5]]],
    ),
  );
  const at = (t2: number) => board([mine(1, 29), enemy(2, t2), neutral(3, 1), mine(5, 3), fogged(6)]);
  const input = (over: Partial<PlanInput> = {}): PlanInput => ({ graph: g, board: at(12), me: ME, income: 5, settings: NOSPLIT, ...over });

  it('splitting allowed: T1 takes T3 and keeps the rest', () => {
    const p = planTurn(input({ settings: STD }));
    expect(attacks(p).map((m) => [m.from, m.to])).toContainEqual([1, 3]);
  });

  it('No-Split: T1 does not take T3; its one order may only be the whole stack on the threat itself', () => {
    const inp = input();
    const p = planTurn(inp);
    expect(p.moves.filter((m) => m.from === 1 && m.to === 3)).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(
      /No-Split: T1 \(#1\) must hold \(protects \+4\): an order would send its whole stack, leaving 1 against the ~16 threat, so the attack on T3 \(#3\) is not planned/,
    );
    // T2 falls for sure even if its owner lands its ~5 there first (17 defenders need 29 of the
    // 33), and then nothing threatens T1: the whole stack may take it.
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 2, armies: 33 })]);
    expect(p.rationale.join('\n')).toMatch(/Attack T2 \(#2\) from T1 \(#1\) with 33, the whole stack \(No-Split; 20 would take it\)/);
    expect(validate(inp, p)).toEqual([]);
  });

  it('No-Split: facing a stack it cannot take for sure, T1 issues no order at all', () => {
    // T2 (30): taking it even before its owner reinforces needs more than T1's 33.
    const inp = input({ board: at(30) });
    const p = planTurn(inp);
    expect(p.moves.filter((m) => m.from === 1)).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(/No-Split: T1 \(#1\) must hold \(protects \+4\).*so the attack on T3 \(#3\) is not planned/);
    expect(validate(inp, p)).toEqual([]);
  });

  it('No-Split, adapting in a 1v1: the strike stack takes the only threat with its whole stack', () => {
    const inp = input({
      tracks: [track(ENEMY, 5)],
      game: { players: [{ id: ME }, { id: ENEMY }] },
      options: { adapt: true },
    });
    const p = planTurn(inp);
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 2, armies: 33 })]);
    const why = p.rationale.join('\n');
    expect(why).toMatch(
      /Attack T2 \(#2\) from the strike stack T1 \(#1\) with 33 \(win chance 100%\): .*No-Split sends the whole stack \(20 would take it\), and T1 \(#1\) need not hold: no visible threat to it is left/,
    );
    expect(why).not.toMatch(/the stack keeps/);
    expect(validate(inp, p)).toEqual([]);
  });
});

// Item 3: T1 (40) protects nothing (in no bonus), so it may move; it faces the opponent's T2 (6)
// and the neutral T3 (1), a step toward B70 (+3: T3, T4). Expansion would spend T1's one order on
// T3; the strike on T2 goes first.
//   T4 ─ T3 ─ T1 ─ T2 (enemy 6) ─ T6 (fog)
describe("No-Split: the strike stack's one order goes to the strike before a small expansion (#124)", () => {
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 6],
      [
        [1, 2],
        [1, 3],
        [3, 4],
        [2, 6],
      ],
      [[70, 3, [3, 4]]],
    ),
  );
  const s = board([mine(1, 40), enemy(2, 6), neutral(3, 1), neutral(4, 1), fogged(6)]);
  const input: PlanInput = {
    graph: g,
    board: s,
    me: ME,
    income: 5,
    settings: NOSPLIT,
    tracks: [track(ENEMY, 5)],
    game: { players: [{ id: ME }, { id: ENEMY }] },
    options: { adapt: true },
  };

  it('T1 strikes T2 with its whole stack; T3 is not taken', () => {
    const p = planTurn(input);
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 2, armies: 44 })]);
    expect(p.expected.captures).toEqual([2]);
    expect(p.rationale.join('\n')).toMatch(/No-Split: T1 \(#1\)'s one order goes to the strike on T2 \(#2\), not the expansion into T3 \(#3\)/);
    expect(validate(input, p)).toEqual([]);
  });
});

describe('No-Split: on random boards every order is the whole stack (#124)', () => {
  it('property: each move sends its source\'s armies plus deploys less the guard, and validates', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
      const n = int(3, 10);
      const ids = Array.from({ length: n }, (_, i) => i + 1);
      const edges: [number, number][] = [];
      for (let i = 2; i <= n; i++) edges.push([i, int(1, i - 1)]);
      for (let k = 0; k < n; k++) {
        const a = int(1, n);
        const b = int(1, n);
        if (a !== b && !edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) edges.push([a, b]);
      }
      const bonuses: [number, number, number[]][] = [];
      for (let b = 0; b < int(0, 3); b++) {
        const members = ids.filter(() => r() < 0.4);
        if (members.length) bonuses.push([100 + b, int(-1, 5), members]);
      }
      const gr = buildGraph(makeMap(ids, edges, bonuses));
      const entries: TerritoryState[] = ids.map((id) => {
        const k = id === 1 ? 0 : int(0, 4);
        if (k === 0) return mine(id, int(0, 20));
        if (k === 1) return enemy(id, int(1, 12));
        if (k === 2) return fogged(id);
        return neutral(id, int(0, 6));
      });
      const settings: PlannerSettings = {
        offensiveKillRate: int(20, 100),
        defensiveKillRate: int(0, 100),
        noSplit: true,
        oneArmyStandsGuard: r() < 0.7,
        ...(r() < 0.2 ? { localDeployments: true } : {}),
      };
      const goals = ['expand', 'complete-bonus', 'defend', 'balanced'] as const;
      const adapt = r() < 0.3;
      const input: PlanInput = {
        graph: gr,
        board: board(entries),
        me: ME,
        income: int(0, 12),
        settings,
        ...(adapt
          ? { options: { adapt: true }, tracks: [track(ENEMY, int(3, 10))], game: { players: [{ id: ME }, { id: ENEMY }] } }
          : { options: { goal: goals[int(0, 3)] } }),
      };
      const ctx = `seed ${seed}`;
      const p = planTurn(input);
      for (const m of p.moves) expect(m.armies, `${ctx} ${m.from}→${m.to}`).toBe(stackOf(input, p, m.from));
      expect(() => validate(input, p), ctx).not.toThrow();
      const w = validate(input, p);
      expect(w.filter((x) => x.startsWith('No-Split')), ctx).toEqual([]);
    }
  });
});

describe('validateTurn — No-Split warns when an order sends less than the whole stack (#124)', () => {
  //   T2 ─ T1 ─ T3
  const map = makeMap(
    [1, 2, 3],
    [
      [1, 2],
      [1, 3],
    ],
  );
  const live: LiveTerritory[] = [
    { territoryId: 1, fogLevel: 1, fogged: false, owner: 7, armies: 10 },
    { territoryId: 2, fogLevel: 1, fogged: false, owner: 0, armies: 1 },
    { territoryId: 3, fogLevel: 1, fogged: false, owner: 0, armies: 2 },
  ];
  const T = (id: number) => ({ id, name: `T${id}` });
  const run = (armies: number, noSplit: boolean, guard = true) =>
    validateTurn({
      map,
      board: live,
      myInGameId: 7,
      income: 5,
      guard,
      deploys: [{ territory: T(1), armies: 5 }],
      moves: [{ from: T(1), to: T(3), armies }],
      noSplit,
    });

  it('names the order, what it sends and the whole stack war.app sends instead', () => {
    const { warnings } = run(3, true);
    expect(warnings).toEqual([
      expect.stringMatching(
        /^No-Split: ⟦T1⟧ \(1\) → ⟦T3⟧ \(3\) sends 3, but this game moves the whole stack: war\.app sends all 14 \(its armies plus this turn's deploys there, less the guard\)/,
      ),
    ]);
  });

  it('no warning for the whole stack, or with No-Split off', () => {
    expect(run(14, true).warnings).toEqual([]);
    expect(run(3, false).warnings).toEqual([]);
    expect(run(15, true, false).warnings).toEqual([]);
  });
});

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
