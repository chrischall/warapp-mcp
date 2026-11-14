// #212: adapting in a free-for-all on a big army lead, the closest bonus's two missing members were
// a weak opponent's, each beside a stack of mine that must keep its border hold — and #203's bonus
// passes never took them: a border held under `balanced` is locked (its armies stay put), so no
// neighbour of mine was free to attack, and the deploy went to a farther bonus's neutral step. The
// skip lines then counted standing armies only. Now a lead step may attack out of a held border
// when this turn's deploy covers the attack and the hold together: the border keeps exactly what
// holds it once the step is taken. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const RATES: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: false };

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
const enemy = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

// Bonus A (#901, +2): my T1 and T4, player 20's T2 (1 army) and T3 (3) — the closest bonus. T1 and
// T4 face player 30's T30 and T31 (12 each) and are each a border of a small held bonus (#904,
// #905, +3), so they keep their border hold. Bonus B (#902, +5): my T5 and a chain of neutrals,
// 3 layers deep. My 60 on the interior T8 (#903, +10 held) give me a 4.3× lead over player 20's 14.
const g = buildGraph(
  makeMap(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 20, 30, 31],
    [
      [1, 2],
      [2, 3],
      [3, 4],
      [1, 30],
      [4, 31],
      [2, 20],
      [3, 20],
      [1, 11],
      [4, 12],
      [11, 8],
      [12, 8],
      [8, 5],
      [5, 6],
      [6, 7],
      [7, 9],
      [30, 31],
    ],
    [
      [901, 2, [1, 2, 3, 4]],
      [902, 5, [5, 6, 7, 9]],
      [903, 10, [8, 11, 12]],
      [904, 3, [1, 11]],
      [905, 3, [4, 12]],
    ],
  ),
);
const field = (): BoardState =>
  board([
    mine(1, 1),
    enemy(2, 1, 20),
    enemy(3, 3, 20),
    mine(4, 12),
    mine(5, 2),
    neutral(6, 4),
    neutral(7, 4),
    mine(8, 60),
    neutral(9, 4),
    mine(11, 1),
    mine(12, 1),
    enemy(20, 10, 20),
    enemy(30, 12, 30),
    enemy(31, 12, 30),
  ]);
const input = (settings: PlannerSettings = RATES): PlanInput => ({
  graph: g,
  board: field(),
  me: ME,
  income: 21,
  settings,
  game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 10 },
  options: { adapt: true },
});
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const why = (p: TurnPlan) => p.rationale.join('\n');
const deployedAt = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
/** What stays on my `id` once its orders leave: armies + deploys − what leaves. */
const staysAt = (p: TurnPlan, i: PlanInput, id: number) =>
  (i.board.territories.find((t) => t.territoryId === id)!.armies ?? 0) +
  deployedAt(p, id) -
  p.moves.filter((m) => m.from === id).reduce((n, m) => n + m.armies, 0);

/** The plan passes warapp_submit_turn's validator: its warnings (it throws on a refusal). */
function valid(p: TurnPlan, i: PlanInput) {
  const names = new Map(i.graph.map.territories.map((t) => [t.id, t.name]));
  const ref = (id: number) => ({ id, name: names.get(id)! });
  return validateTurn({
    map: i.graph.map,
    board: i.board.territories.map(
      (t): LiveTerritory => ({
        territoryId: t.territoryId,
        fogLevel: 1,
        fogged: false,
        owner: t.owner.kind === 'player' ? t.owner.playerId : t.owner.kind === 'neutral' ? OWNER_NEUTRAL : -1,
        armies: t.armies,
      }),
    ),
    myInGameId: ME,
    income: i.income,
    guard: false,
    deploys: p.deploys.map((d) => ({ territory: ref(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: ref(m.from), to: ref(m.to), armies: m.armies })),
  }).warnings;
}

describe('#212: a lead step out of a border that must keep its hold', () => {
  it("takes the closest bonus's enemy member from the held border, deploying for the attack and the hold", () => {
    const i = input();
    const p = planTurn(i);
    const hit = attacks(p).find((m) => m.to === 3);
    expect(hit).toMatchObject({ from: 4 });
    expect(hit!.reason).toMatch(/bonus B901 \(#901\).*player 20's member, taken on my army lead/);
    // T4 still holds against player 30's T31 once the step leaves.
    expect(why(p)).toMatch(/Attack T3 \(#3\) from T4 \(#4\) with \d+ \(deploy \d+ there\)/);
    expect(why(p)).toMatch(/T4 \(#4\) keeps \d+ to hold its border against the ~\d+ threat once the attack on T3 \(#3\) leaves/);
    // 11 hold against ~17 at 60% offence (17 × 0.6 = 10.2 kills).
    expect(staysAt(p, i, 4)).toBeGreaterThanOrEqual(11);
    // The warning on T4 is restated against the threat once T3 is taken (its 8 cannot attack),
    // never against the start-of-turn threat that would contradict the hold line above.
    const t4 = p.warnings.find((w) => w.startsWith('T4 (#4)')) ?? '';
    expect(t4).toMatch(/the plan deploys \d+ there, leaving \d+ armies \(\d+ to take, more than the \d+ that can still reach it once T3 \(#3\) is taken: it holds\)/);
    expect(t4).not.toMatch(/still could/);
    expect(valid(p, i)).toEqual([]);
  });

  it('gives the closest bonus the deploy before the farther neutral step', () => {
    const p = planTurn(input());
    expect(attacks(p).map((m) => m.to)).not.toContain(6);
  });

  it("names the hold when the other step still does not fit, not the standing armies alone", () => {
    // T2 (1 army) costs 10 as a lead step. T1's hold against player 30 takes the deploy that is
    // left once T3's step is funded: the line says so, not just what T1 can spare standing.
    const i = input();
    const p = planTurn(i);
    expect(attacks(p).map((m) => m.to)).not.toContain(2);
    const line = p.rationale.find((l) => l.startsWith('Not attacking')) ?? '';
    const t2 = line.split(/; (?=T\d+ \(#\d+\) \(player)/).find((s) => s.includes('T2 (#2) (player')) ?? '';
    const m = t2.match(
      /taking it needs 2 \(10 if player 20 deploys its ~5 there first\), and the most a neighbour of mine can spare once it holds its border is 0; when its bonus's step was tried, T1 \(#1\) holds its border, and with the step gone its hold needed (\d+) more than it had; this turn's deploy could add at most (\d+) there: (\d+) left for the attack$/,
    );
    expect(m).not.toBeNull();
    expect(Math.max(0, Number(m![2]) - Number(m![1]))).toBe(Number(m![3]));
    expect(Number(m![3])).toBeLessThan(10);
    expect(valid(p, i)).toEqual([]);
  });

  it('completes the closest bonus when the deploy covers both steps: one from the held border, one from a conceded member of it', () => {
    // Without bonus B904, T1 protects nothing and is conceded: it attacks T2 only once T3 is taken
    // (the step then completes B901, which T1 is in). Player 30 stands 20 on T31 and my 120 on T8.
    const i = input();
    const map = { ...i.graph.map, bonuses: i.graph.map.bonuses.filter((b) => b.id !== 904) };
    const c: PlanInput = {
      ...i,
      income: 28,
      graph: buildGraph(map),
      board: {
        ...i.board,
        territories: i.board.territories.map((t) =>
          t.territoryId === 31 ? { ...t, armies: 20 } : t.territoryId === 8 ? { ...t, armies: 120 } : t,
        ),
      },
    };
    const p = planTurn(c);
    expect(attacks(p).map((m) => [m.from, m.to])).toEqual([
      [4, 3],
      [1, 2],
    ]);
    expect(attacks(p).find((m) => m.to === 2)!.reason).toMatch(/bonus B901 \(#901\).*player 20's member, taken on my army lead/);
    expect(why(p)).toMatch(/T4 \(#4\) keeps \d+ to hold its border/);
    expect(attacks(p).map((m) => m.to)).not.toContain(6);
    expect(valid(p, c)).toEqual([]);
  });

  it('completes the bonus at the steps\' bare cost when the sure ones do not fit beside the held border\'s hold (#214 item 1)', () => {
    // Without bonus B904, T1 is conceded. Before #214 item 1, the held border's sure step on T3
    // could not be funded with T2's, and the line said what the conceded T1 lacked. Now the
    // completion retries both at their bare cost (T3's 3 defenders, T2's 1): B901 completes, and
    // #120's warnings say what each faces if player 20 deploys there first.
    const i = input();
    const map = { ...i.graph.map, bonuses: i.graph.map.bonuses.filter((b) => b.id !== 904) };
    const c: PlanInput = { ...i, income: 25, graph: buildGraph(map) };
    const p = planTurn(c);
    expect(attacks(p).find((m) => m.to === 2)).toMatchObject({ from: 1, armies: 2 });
    expect(attacks(p).find((m) => m.to === 3)).toMatchObject({ from: 4 });
    for (const t of [2, 3])
      expect(attacks(p).find((m) => m.to === t)!.reason).toMatch(/completes bonus B901 \(#901\).*more than this turn can fund \(#214\)/);
    expect(p.warnings.join('\n')).toMatch(/Attack on enemy T2 \(#2\) assumes its owner does not reinforce it first: if player 20 deploys its ~5 there, 2 attack 6/);
    const line = p.rationale.find((l) => l.startsWith('Not attacking')) ?? '';
    expect(line).not.toMatch(/T2 \(#2\)|T3 \(#3\)/);
    expect(valid(p, c)).toEqual([]);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(planTurn(input()))).toBe(JSON.stringify(planTurn(input())));
  });
});
