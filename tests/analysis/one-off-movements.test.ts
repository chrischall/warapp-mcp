// Issue #123: one-off army movements read as income, in both directions. Every board here is
// synthetic (made-up maps, ids and counts).
//  1. Deploy-then-capture: a visible stack that shrank into a capture it outnumbers was
//     reinforced — the surplus is deploy, not a stack out of the fog.
//  2. A stack walking out of the fog onto a held territory: growth beyond what it was expected to
//     deploy, on a territory with a hidden neighbour, is a move from the fog, not income.
//  3. A visible transfer between its own territories is not a trend: growth matched by a visible
//     neighbour's shrink is a transfer, and projected growth is capped at the observed deploy.
//  4. Taking a territory I emptied: a capture from me is priced from what I may have left (the
//     guard), not last turn's stack — unless my orders say what stood there.
//  5. Unexplained armies leave out combat deaths where its stack and a neighbour of another owner
//     both shrank.
//  6. Inferred bonuses: only bonuses within reach of its territories, that it could have paid
//     for; none listed when too many fit.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { straightKills } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { MAX_LISTED_COMBINATIONS, trackOpponents, type TurnBoard } from '../../src/analysis/opponents.js';
import { enemyDeployEstimates, observeDeploy, planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
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

const enemy = (territoryId: number, armies: number, playerId = ENEMY): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const line = (n: number) => Array.from({ length: n - 1 }, (_, i) => [i + 1, i + 2] as [number, number]);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const history = (...boards: [number, BoardState][]): TurnBoard[] => boards.map(([turn, b]) => ({ turn, board: b }));

describe('1. deploy-then-capture (#123)', () => {
  // T1 – T2 – T3 – T4, and T3 – T5. My T1, T2; a 3-army neutral T3 with the enemy's visible T4
  // (6) beside it and the fogged T5 (a +5 bonus it could hold) behind it.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5],
      [
        [1, 2],
        [2, 3],
        [3, 4],
        [3, 5],
      ],
      [[901, 5, [5]]],
    ),
  );
  const before = board([mine(1, 5), mine(2, 5), neutral(3, 3), enemy(4, 6), fogged(5)]);
  // It deployed 8 on T4 (14) and attacked T3 with 13: 3 neutrals kill round(2.1) = 2, so 11
  // stand on T3 and 1 on T4.
  const after = board([mine(1, 5), mine(2, 5), enemy(3, 11), enemy(4, 1), fogged(5)]);

  it('the surplus over what the visible source sent is deploy, not a stack out of the fog', () => {
    // Given the most it could deploy (base 5 + the +5 it could hold in the fog).
    const o = observeDeploy(g, after, before, ENEMY, STD, { most: 10 });
    expect(o.deploy).toBe(8);
    expect(o.fromFog).toEqual([]);
    expect(o.fogArmies).toBe(0);
    expect(o.reinforced).toEqual([3]);
    // Two-sided: had the 6 beyond T4's shrink come from the fog, it deployed only the capture's cost.
    expect(o.low).toBe(straightKills(3, 70));
    expect(o.high).toBe(8);
  });

  it('the tracker records it, and the note words it as a possibility', () => {
    const [t] = trackOpponents(g, history([3, before], [4, after]), ME, STD);
    expect(t!.turns[0]).toMatchObject({ observed: 8, low: 2, high: 8, fromFog: [] });
    expect(t!.notes.join(' ')).toMatch(/deployed on the visible stack that attacked/);
    expect(t!.notes.join(' ')).not.toMatch(/moved in from the fog/);
  });

  it('with no visible source that shrank, the stack still came from the fog (#86)', () => {
    const still = board([mine(1, 5), mine(2, 5), enemy(3, 11), enemy(4, 6), fogged(5)]);
    const o = observeDeploy(g, still, before, ENEMY, STD, { most: 10 });
    expect(o).toMatchObject({ deploy: 2, fromFog: [3], fogArmies: 11, reinforced: [] });
  });

  it('never more deploy-then-capture than it could earn: the rest came from the fog', () => {
    // 40 stand on T3: T4's 5 and 10 deployed at most (base 5 + 5); 25 arrived from the fog.
    const big = board([mine(1, 5), mine(2, 5), enemy(3, 40), enemy(4, 1), fogged(5)]);
    const o = observeDeploy(g, big, before, ENEMY, STD, { most: 10 });
    expect(o).toMatchObject({ deploy: -5 + 2 + 5 + 10, reinforced: [3], fromFog: [3], fogArmies: 25 });
    // A board-only reading (no context) keeps #86's: the surplus is a move.
    expect(observeDeploy(g, after, before, ENEMY, STD)).toMatchObject({ deploy: 2, reinforced: [], fromFog: [3] });
  });
});

describe('2. a stack walking out of the fog onto a held territory (#123)', () => {
  // My +5 bonus {1, 2, 3}, T3 (28) on the border; the enemy's T4 beside it; T5–T9 fogged (with
  // +20 and +25 bonuses it could hold, so the could-earn cap does not cut anything).
  const g = buildGraph(
    makeMap(range(1, 9), line(9), [
      [101, 5, [1, 2, 3]],
      [102, 20, [5, 6]],
      [103, 25, [7, 8, 9]],
    ]),
  );
  const fog = range(5, 9).map(fogged);
  const at = (t4: number) => board([mine(1, 1), mine(2, 1), mine(3, 28), enemy(4, t4), ...fog]);
  const before = at(5);
  const after = at(45);

  it('growth beyond what it was expected to deploy, beside the fog, is a move', () => {
    const [e] = enemyDeployEstimates(g, after, ME, STD, before);
    expect(e!.observation).toMatchObject({ deploy: 5, low: 0, high: 40, fogArmies: 35, grewFromFog: [4] });
    expect(e).toMatchObject({ estimate: 5, observedRaw: 5 });
  });

  it('the plan holds the bonus rather than conceding it to a phantom +40', () => {
    const p = planTurn({ graph: g, board: after, previousBoard: before, me: ME, income: 10, settings: STD, options: { adapt: true } });
    expect(p.enemyDeploy).toBe(5);
    expect(p.conceded).toEqual([]);
    expect(p.moves.filter((m) => m.from === 3)).toEqual([]);
    expect(p.rationale.join('\n')).toMatch(/35 of its growth on T4 \(#4\).*next to the fog.*a move/);
  });

  it('the tracker does not pin it at 40 for the idle turns that follow', () => {
    const [t] = trackOpponents(g, history([8, before], [9, after], [10, after], [11, after]), ME, STD);
    expect(t!.turns.map((x) => x.observed)).toEqual([5, 0, 0]);
    expect(t!.income).toBe(5);
  });

  it('growth a visible neighbour of its own sent is no fog arrival', () => {
    // T4 (beside the fogged T6 too) grew 40 and its visible T5 shrank 40: a transfer, observed 0.
    const g2 = buildGraph(makeMap(range(1, 6), [...line(6), [4, 6]], [[101, 5, [1, 2, 3]]]));
    const b = board([mine(1, 1), mine(2, 1), mine(3, 28), enemy(4, 5), enemy(5, 50), fogged(6)]);
    const a = board([mine(1, 1), mine(2, 1), mine(3, 28), enemy(4, 45), enemy(5, 10), fogged(6)]);
    const [e] = enemyDeployEstimates(g2, a, ME, STD, b);
    expect(e!.observation).toMatchObject({ deploy: 0, fogArmies: 0, grewFromFog: [] });
  });
});

describe('3. a visible transfer is not a trend (#123)', () => {
  // No fog. My +2 bonus {1, 2, 3}, T3 (28); the enemy moved 40 from T5 to its front T4 and
  // deployed 5 on T5.
  const g = buildGraph(makeMap(range(1, 5), line(5), [[101, 2, [1, 2, 3]]]));
  const before = board([mine(1, 1), mine(2, 1), mine(3, 28), enemy(4, 5), enemy(5, 50)]);
  const after = board([mine(1, 1), mine(2, 1), mine(3, 28), enemy(4, 45), enemy(5, 15)]);

  it('the threat is its movable armies plus its deploy, not a +40/turn projection', () => {
    const p = planTurn({ graph: g, board: after, previousBoard: before, me: ME, income: 7, settings: STD, options: { adapt: true } });
    expect(p.rationale.join('\n')).not.toMatch(/uses the trend/);
    expect(p.warnings.join('\n')).not.toMatch(/\+40\/turn/);
    expect(p.conceded).toEqual([]);
    expect(p.moves.filter((m) => m.from === 3)).toEqual([]);
    // The same position without the previous board: the same hold.
    const blind = planTurn({ graph: g, board: after, me: ME, income: 7, settings: STD, options: { adapt: true } });
    expect(p.deploys).toEqual(blind.deploys);
  });

  it('growth by deploys alone is still projected (capped at the observed deploy)', () => {
    // T4 grows 5 → 12 with T5 unchanged: it deployed 7 there (more than its base 5).
    const grown = board([mine(1, 1), mine(2, 1), mine(3, 28), enemy(4, 12), enemy(5, 50)]);
    const p = planTurn({ graph: g, board: grown, previousBoard: before, me: ME, income: 7, settings: STD, options: { enemyDeploy: 5 } });
    expect(p.warnings.join('\n')).toMatch(/T4 \(#4\) is building: \+7\/turn/);
    expect(p.rationale.join('\n')).toMatch(/uses the trend: player 20's stack next to it grows \+7\/turn/);
  });
});

describe('1b. deploy-then-capture with my orders measuring the turn (#123, #119)', () => {
  // Section 1's board plus an edge T1 – T4: I attacked its T4 with 2 from T1 and failed, killing
  // round(1.2) = 1 that the boards alone do not show. The measured reading must still count the
  // surplus on T3 as deploy, not as a stack out of the fog.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5],
      [
        [1, 2],
        [1, 4],
        [2, 3],
        [3, 4],
        [3, 5],
      ],
      [[901, 5, [5]]],
    ),
  );
  const before = board([mine(1, 5), mine(2, 5), neutral(3, 3), enemy(4, 6), fogged(5)]);
  const after = board([mine(1, 5), mine(2, 5), enemy(3, 11), enemy(4, 1), fogged(5)]);

  it('keeps the deploy on the reinforced capture and adds what my orders measured', () => {
    const blind = trackOpponents(g, history([3, before], [4, after]), ME, STD);
    expect(blind[0]!.turns[0]).toMatchObject({ raw: 8, low: 2, high: 8, reinforced: [3], fromFog: [] });
    const [t] = trackOpponents(
      g,
      [{ turn: 3, board: before, orders: { deploys: [], moves: [{ from: 1, to: 4, armies: 2 }] } }, { turn: 4, board: after }],
      ME,
      STD,
    );
    expect(t!.turns[0]).toMatchObject({ measured: 1, raw: 9, observed: 9, low: 3, high: 9, reinforced: [3], fromFog: [] });
  });
});

describe('4. taking a territory I emptied (#123)', () => {
  // T1 (neutral) – T2 (mine, 30) – T3 (enemy, 5) – T4 (enemy, 2) – T5 (fogged; +30 bonus {4, 5}
  // it could hold). I sent 29 from T2 into T1 and took it; it deployed 5 on T3 (10) and took T2
  // (1 left) with 9, losing 1: 8 stand there.
  const g = buildGraph(makeMap(range(1, 5), line(5), [[901, 30, [4, 5]]]));
  const before = board([neutral(1, 2), mine(2, 30), enemy(3, 5), enemy(4, 2), fogged(5)]);
  const after = board([mine(1, 28), enemy(2, 8), enemy(3, 1), enemy(4, 2), fogged(5)]);

  it('the capture is priced from the guard I may have left, not my stack last turn', () => {
    const [e] = enemyDeployEstimates(g, after, ME, STD, before);
    expect(e!.observation).toMatchObject({ deploy: 5, low: 5, high: 5 - straightKills(1, 70) + straightKills(30, 70), emptied: [2] });
    expect(e!.observedRaw).toBe(5);
  });

  it('my orders measure what stood there', () => {
    const blind = trackOpponents(g, history([3, before], [4, after]), ME, STD);
    expect(blind[0]!.turns[0]!.observed).toBe(5);
    // Had I left all 30 there (no orders out of T2), its 8 standing after the fight mean it
    // deployed far more: the measurement says so.
    const held = trackOpponents(
      g,
      [{ turn: 3, board: before, orders: { deploys: [], moves: [] } }, { turn: 4, board: after }],
      ME,
      STD,
    );
    expect(held[0]!.turns[0]!.observed).toBe(5 - straightKills(1, 70) + straightKills(30, 70));
    const emptied = trackOpponents(
      g,
      [{ turn: 3, board: before, orders: { deploys: [], moves: [{ from: 2, to: 1, armies: 29 }] } }, { turn: 4, board: after }],
      ME,
      STD,
    );
    expect(emptied[0]!.turns[0]).toMatchObject({ observed: 5, measured: 0 });
  });
});

describe('5. unexplained armies leave out combat deaths (#123)', () => {
  // No fog. My T2 (12) attacked its T3 (10) with 10 and failed, twice: each time my T2 lost 7
  // and its T3 lost 6 and got its base 5.
  const g = buildGraph(makeMap(range(1, 4), line(4), []));
  const at = (t2: number, t3: number) => board([mine(1, 5), mine(2, t2), enemy(3, t3), enemy(4, 2)]);

  it('two failed attacks of mine with nothing hidden leave nothing unexplained', () => {
    const [t] = trackOpponents(g, history([3, at(19, 10)], [4, at(12, 9)], [5, at(5, 8)]), ME, STD);
    expect(t!.turns.map((x) => x.combat)).toEqual([6, 6]);
    expect(t!.unexplained).toBe(0);
    expect(t!.notes.join(' ')).toMatch(/unexplained/i);
  });

  it('a shrink with no neighbour of another owner shrinking stays unexplained', () => {
    const [t] = trackOpponents(g, history([3, at(19, 10)], [4, at(19, 9)]), ME, STD);
    expect(t!.turns[0]!.combat).toBe(0);
    expect(t!.unexplained).toBe(6);
  });
});

describe('6. inferred bonuses must be plausible (#123)', () => {
  // A line T1..T60: my T1, T2; the enemy's T3, T4, T5; T6..T60 fogged. +2 single-territory
  // bonuses on T7 (2 hops from its T5), T8 (3), T20 (15 hops) and T25; a +2 bonus of T9..T60
  // less the singles (4 hops away, 50 territories) would cost it more than it could have
  // received by turn 5.
  const singles = [7, 8, 20, 25];
  const huge = range(9, 60).filter((t) => !singles.includes(t));
  const bonuses: [number, number, number[]][] = [...singles.map((t) => [900 + t, 2, [t]] as [number, number, number[]]), [999, 2, huge]];
  const g = buildGraph(makeMap(range(1, 60), line(60), bonuses));
  const fog = range(6, 60).map(fogged);
  const at = (t3: number) => board([mine(1, 5), mine(2, 5), enemy(3, t3), enemy(4, 2), enemy(5, 2), ...fog]);

  it('only bonuses within reach and affordable, nearest first', () => {
    // It deploys 7 a turn: a gap of 2.
    const [t] = trackOpponents(g, history([3, at(10)], [4, at(17)], [5, at(24)]), ME, STD);
    expect(t!.inferred!.gap).toBe(2);
    expect(t!.inferred!.candidates).toEqual([
      { bonusIds: [907], total: 2, hops: 2 },
      { bonusIds: [908], total: 2, hops: 3 },
    ]);
  });

  it('none listed when too many fit', () => {
    const many = range(6, 6 + MAX_LISTED_COMBINATIONS);
    const g2 = buildGraph(
      makeMap(
        range(1, 60),
        [...line(5), ...many.map((t) => [5, t] as [number, number])],
        many.map((t) => [800 + t, 2, [t]] as [number, number, number[]]),
      ),
    );
    const [t] = trackOpponents(g2, history([3, at(10)], [4, at(17)], [5, at(24)]), ME, STD);
    expect(t!.inferred).toMatchObject({ gap: 2, candidates: [], more: MAX_LISTED_COMBINATIONS + 1 });
    expect(t!.notes.join(' ')).toMatch(/too many to name/);
  });
});

describe('6b. inferred bonuses on the 761-territory fixture (#123)', () => {
  it('a gap of 6 lists only bonuses within reach, quickly', async () => {
    const { fixtureMap } = await import('./helpers.js');
    const map = fixtureMap();
    const g = buildGraph(map);
    // Its one territory in view, every neighbour mine; the rest of the map fogged. It deploys 11
    // a turn there (base 5 + a gap of 6).
    // A territory in a positive bonus it does not hold alone, so there are bonuses within reach
    // and its visible income stays the base (the map's first territory has no bonus within 4
    // hops, which let this test pass with nothing listed).
    const t = map.territories.find((x) =>
      map.bonuses.some((b) => b.value > 0 && b.territoryIds.length > 1 && b.territoryIds.includes(x.id)),
    )!.id;
    const ns = g.neighbors.get(t)!;
    const at = (armies: number) =>
      board(
        map.territories.map((x) =>
          x.id === t ? enemy(t, armies) : ns.includes(x.id) ? mine(x.id, 3) : fogged(x.id),
        ),
      );
    const started = Date.now();
    const [track] = trackOpponents(g, history([3, at(10)], [4, at(21)], [5, at(32)]), ME, STD);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(track!.inferred!.gap).toBe(6);
    // Every listed bonus has a member within reach of its territory.
    const hops = new Map<number, number>([[t, 0]]);
    let frontier = [t];
    for (let d = 1; d <= 4; d++) {
      const next: number[] = [];
      for (const x of frontier) for (const n of g.neighbors.get(x) ?? []) if (!hops.has(n)) (hops.set(n, d), next.push(n));
      frontier = next;
    }
    const near = (bonusId: number) => map.bonuses.find((b) => b.id === bonusId)!.territoryIds.some((x) => hops.has(x));
    for (const c of track!.inferred!.candidates) for (const b of c.bonusIds) expect(near(b)).toBe(true);
    // Something fits (the filter does not just exclude everything), but far from every bonus.
    expect(track!.inferred!.candidates.length + track!.inferred!.more).toBeGreaterThan(0);
    expect(track!.inferred!.candidates.length + track!.inferred!.more).toBeLessThan(1000);
    expect(track!.inferred!.implausible).toBeGreaterThan(0);
  });
});
