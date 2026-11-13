// Issue #121: captures, transfers and the leftover deploy must not strip or walk away from
// borders that face an enemy. Each territory has one surplus — its armies plus this turn's
// deploys, less what holds it against the visible threat — and every pass draws on that.
// Synthetic maps and made-up ids only. Kill rates 60/70, no luck, one army stands guard.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanGameContext, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const RATES = { offensiveKillRate: 60, defensiveKillRate: 70 };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  return {
    id: 1,
    name: 'Synthetic surplus',
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
const deployedOn = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
/** Armies on my `id` once every deploy and move of the plan is done (captures not counted). */
function endsOn(input: PlanInput, p: TurnPlan, id: number): number {
  const st = input.board.territories.find((t) => t.territoryId === id)!;
  let a = (st.armies ?? 0) + deployedOn(p, id);
  for (const m of p.moves) {
    if (m.from === id) a -= m.armies;
    if (m.to === id && m.kind === 'transfer') a += m.armies;
  }
  return a;
}
const takes = (armies: number) => armiesToTake(armies, RATES)!;

/** The plan, after warapp_submit_turn's validator accepts it (it throws on a refusal). */
function plan(input: PlanInput): TurnPlan {
  const p = planTurn(input);
  const map = input.graph.map;
  const names = new Map(map.territories.map((t) => [t.id, t.name]));
  const ref = (id: number) => ({ id, name: names.get(id)! });
  validateTurn({
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
  });
  return p;
}

describe('#121 a capture keeps what holds a safe border', () => {
  // 18(n2) – 22(mine 8) – 23(enemy 7) ; 27(mine 0) – 6(n1). Income 5.
  // T22 holds at the start: taking 8 needs 13, more than a threat of 6 movable + 5 deploy = 11.
  const g = buildGraph(makeMap([6, 18, 22, 23, 27], [[18, 22], [22, 23], [6, 27]]));
  const s = board([mine(22, 8), enemy(23, 7), neutral(18, 2), mine(27, 0), neutral(6, 1)]);
  const at = (income: number, settings = STD): PlanInput => ({ graph: g, board: s, me: ME, income, settings });

  it('T22 is not left takeable by its capture of T18 (both captures do not fit with the guard)', () => {
    expect(takes(8)).toBeGreaterThan(11);
    const input = at(5);
    const p = plan(input);
    // Before #121: deploys 22+2, 27+3 and 22->18 x3 left T22 on 7, which 11 take.
    expect(takes(endsOn(input, p, 22))).toBeGreaterThan(11);
  });

  it('the capture deploys what keeps T22 holding when it fits', () => {
    const input = at(5, { ...STD, oneArmyStandsGuard: false });
    const p = plan(input);
    expect(p.moves.filter((m) => m.kind === 'attack').map((m) => m.to).sort((a, b) => a - b)).toEqual([6, 18]);
    expect(deployedOn(p, 22)).toBe(3);
    expect(takes(endsOn(input, p, 22))).toBeGreaterThan(11);
  });

  it('with income to spare it takes T18 and keeps the hold', () => {
    const input = at(8);
    const p = plan(input);
    expect(p.moves.some((m) => m.from === 22 && m.to === 18)).toBe(true);
    expect(takes(endsOn(input, p, 22))).toBeGreaterThan(11);
  });
});

describe('#121 a combined capture keeps what holds its finisher', () => {
  // E1(6) – 2(10) – 3(neutral 8) – 4(6); T2 holds (10 need 17 against 5 + 5 = 10). No single
  // source affords the 14 that take T3 on its surplus; T4 wears it down and T2 finishes.
  // Before, the finisher could spend T2's garrison and leave it beside the enemy.
  const g = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [2, 3], [3, 4]], [[70, 3, [3]]]));
  const s = board([enemy(1, 6), mine(2, 10), neutral(3, 8), mine(4, 6)]);

  for (const income of [0, 6]) {
    it(`T2 still holds after the plan (income ${income})`, () => {
      const input: PlanInput = { graph: g, board: s, me: ME, income, settings: STD };
      const p = plan(input);
      expect(takes(endsOn(input, p, 2))).toBeGreaterThan(10);
    });
  }
});

describe('#121 transfers: what counts as held, and where the front is', () => {
  const FFA: PlanGameContext = { players: [{ id: ME }, { id: ENEMY }, { id: 21 }], turn: 14, fog: 'NoFog' };
  const transfersFrom = (p: TurnPlan, id: number) => p.moves.filter((m) => m.kind === 'transfer' && m.from === id);

  it('an exact-sized break on a player does not make the garrison beside it idle', () => {
    // 1(60) – 2(enemy 30) – 3(enemy 2): bonus B101 (+1) = 2, 3 is player 20's; B100 (+3) = 1, 4 is
    // mine. 1 – 4(3) – 5(player 21, 4) – 6(player 21, 4). The break of T2 is sized for its 30, not
    // for a reinforcement: if it fails, T1 still faces T2. Before, T1 then transferred 13 to T4 as
    // "idle interior armies".
    const g = buildGraph(
      makeMap([1, 2, 3, 4, 5, 6], [[1, 2], [2, 3], [1, 4], [5, 6], [4, 5]], [[100, 3, [1, 4]], [101, 1, [2, 3]]]),
    );
    const input: PlanInput = {
      graph: g,
      board: board([mine(1, 60), enemy(2, 30), enemy(3, 2), mine(4, 3), enemy(5, 4, 21), enemy(6, 4, 21)]),
      me: ME,
      income: 8,
      settings: { offensiveKillRate: 60, defensiveKillRate: 70 },
      game: FFA,
      options: { adapt: true },
    };
    const p = plan(input);
    expect(p.moves.some((m) => m.kind === 'attack' && m.from === 1 && m.to === 2)).toBe(true);
    expect(transfersFrom(p, 1)).toEqual([]);
  });

  it("my commander's stack beside a conceded border stays", () => {
    // E1(30) – 2(3) – 3(12, my commander) – 4(1) – 5(1) – neutral 6 (a +0 bonus). T2 is conceded;
    // the enemy takes it next and then faces T3. Before, T3 counted as interior (a conceded border
    // is not "the front": other stacks still concentrate on a front that holds) and sent 16 to T4.
    const g = buildGraph(makeMap([1, 2, 3, 4, 5, 6], [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6]], [[101, 0, [6]]]));
    const cmd: TerritoryState = { ...mine(3, 12), specialUnits: [{ kind: 'commander', id: 'c', playerId: ME }] };
    const input: PlanInput = {
      graph: g,
      board: board([enemy(1, 30), mine(2, 3), cmd, mine(4, 1), mine(5, 1), neutral(6, 10)]),
      me: ME,
      income: 5,
      settings: { offensiveKillRate: 60, defensiveKillRate: 70 },
      game: { players: [{ id: ME }, { id: ENEMY }], turn: 9, commanders: true },
      options: { adapt: true },
    };
    const p = plan(input);
    expect(p.conceded).toEqual([2]);
    expect(transfersFrom(p, 3)).toEqual([]);
  });

  it('idle armies head for the enemy, not a worthless neutral', () => {
    // neutral 9(20) – 1(1) – 2(15) – 3(1) – 4(4) – enemy 5(12); bonus B60 (+3) = 3, 4, held, so T4
    // spends 7 of the 9 income on its hold. Before, T2's stack moved to T1, toward the neutral.
    const g = buildGraph(makeMap([1, 2, 3, 4, 5, 9], [[9, 1], [1, 2], [2, 3], [3, 4], [4, 5]], [[60, 3, [3, 4]]]));
    const input: PlanInput = {
      graph: g,
      board: board([neutral(9, 20), mine(1, 1), mine(2, 15), mine(3, 1), mine(4, 4), enemy(5, 12)]),
      me: ME,
      income: 9,
      settings: STD,
    };
    const p = plan(input);
    expect(p.conceded).toEqual([]);
    expect(deployedOn(p, 4)).toBeGreaterThanOrEqual(7);
    expect(transfersFrom(p, 2).map((m) => m.to)).toEqual([3]);
  });

  it('a stack one step from a worthless neutral moves toward the enemy', () => {
    // neutral 9(20) – 2(15) – 3(1) – 4(1) – enemy 5(2); bonus B60 (+3) = 3, 4, held. Before, T2
    // was next to "the front" (the neutral) and never moved.
    const g = buildGraph(makeMap([2, 3, 4, 5, 9], [[9, 2], [2, 3], [3, 4], [4, 5]], [[60, 3, [3, 4]]]));
    const input: PlanInput = {
      graph: g,
      board: board([neutral(9, 20), mine(2, 15), mine(3, 1), mine(4, 1), enemy(5, 2)]),
      me: ME,
      income: 5,
      settings: STD,
    };
    const p = plan(input);
    expect(transfersFrom(p, 2).map((m) => m.to)).toEqual([3]);
  });
});

describe('#121 the leftover deploy', () => {
  it('is spread to each short border’s comfortable margin before any border gets more', () => {
    // E6(1) – E4(6) – 3(7) – 2(1) – 1(7) – E5(6) – E7(1); bonus B60 (+3) = 1, 2, 3, held. Each
    // border holds exactly (7 need 11 against 5 + 5 = 10; 6 need 10) and is comfortable at 8 (more
    // than 1.25 × 10).
    // Before, all 9 went to T1 (16 and 7).
    const g = buildGraph(
      makeMap([1, 2, 3, 4, 5, 6, 7], [[1, 2], [2, 3], [3, 4], [1, 5], [4, 6], [5, 7]], [[60, 3, [1, 2, 3]]]),
    );
    const input: PlanInput = {
      graph: g,
      board: board([mine(1, 7), mine(2, 1), mine(3, 7), enemy(4, 6), enemy(5, 6), enemy(6, 1), enemy(7, 1)]),
      me: ME,
      income: 9,
      settings: STD,
      options: { goal: 'defend' },
    };
    const p = plan(input);
    expect(takes(7)).toBe(11);
    expect(takes(6)).toBe(10);
    expect(takes(8)).toBeGreaterThan(1.25 * 10);
    expect(deployedOn(p, 1)).toBeGreaterThanOrEqual(1);
    expect(deployedOn(p, 3)).toBeGreaterThanOrEqual(1);
    expect(deployedOn(p, 1) + deployedOn(p, 3)).toBe(9);
    expect(p.rationale.join('\n')).toMatch(/Deploy 1 of the leftover to T3 \(#3\): it brings it to a comfortable margin/);
  });
});

describe('#121 a nearly holdable border before a comfort margin', () => {
  // E6(1) – E1(6) – 2(7) – 3(1) – 4(3) – E5(3) – E7(1); bonus B60 (+3) = 2, 3, held. T2 holds
  // (7 need 11 against 5 + 5 = 10) but is short of a comfortable margin. T4 protects +0 and is
  // conceded economically (2 deploys make it hold against 2 + 5 = 7, more than 3 × its worth).
  // Before, its 2 armies withdrew and all 5 went to T2's margin; the leftover now holds T4 first.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7], [[1, 2], [2, 3], [3, 4], [4, 5], [1, 6], [5, 7]], [[60, 3, [2, 3]]]));
  const s = board([enemy(1, 6), mine(2, 7), mine(3, 1), mine(4, 3), enemy(5, 3), enemy(6, 1), enemy(7, 1)]);
  const input: PlanInput = { graph: g, board: s, me: ME, income: 5, settings: STD, options: { goal: 'defend' } };

  it('holds T4 with 2 of the leftover, keeps its garrison, and gives T2 the rest', () => {
    const p = plan(input);
    expect(p.conceded).toEqual([]);
    expect(deployedOn(p, 4)).toBe(2);
    expect(deployedOn(p, 2)).toBe(3);
    expect(p.moves.some((m) => m.from === 4)).toBe(false);
    expect(p.cardAdvice).toBeNull();
    expect(takes(endsOn(input, p, 4))).toBeGreaterThan(7);
    expect(p.warnings.join('\n')).not.toMatch(/T4 \(#4\) cannot be held|withdrawal from T4/);
    expect(p.rationale.join('\n')).toMatch(/Hold T4 \(#4\) after all \(not conceded\): deploy 2 there, and keep the 2 that would have withdrawn/);
  });

  it('a leftover too small for the hold leaves the concession as it was', () => {
    const p = plan({ ...input, income: 1 });
    expect(p.conceded).toEqual([4]);
    expect(deployedOn(p, 4)).toBe(0);
  });
});
