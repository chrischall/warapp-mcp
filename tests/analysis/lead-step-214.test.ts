// #214: after #212, a lead step (#203) toward the closest bonus could attack out of a held border,
// but never out of a conceded one: a conceded border attacks out only with the armies on it, unless
// the step completes a bonus it is in — and that exception looked only at members already taken, so
// the closest bonus's 1-army enemy member beside my conceded 1-army territory was skipped while its
// sibling (beside a held border) was not yet planned. The deploy went to a farther bonus's neutral
// step. Now a lead step may be funded from this turn's deploy on a conceded source (sized for the
// attack, never my commander's territory), and the completes-a-bonus exception counts the sibling
// steps a completion plans in the same turn. Every map, id and name here is made up.
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



// Bonus A (#901, +2): my T1 and T4, player 20's T2 (1 army) and T3 (3) — the closest bonus. T1 (1
// army) faces player 30's T30 (12) and protects nothing: it is conceded. T4 (24) faces player 30's
// T31 (20) and is a border of the small held bonus B905 (+3). Bonus B902 (+5): my T5 and a chain of
// three 8-army neutrals, 3 layers deep. My 120 on the interior T8 (B903, +10 held) give me the lead.
const map = makeMap(
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
    [905, 3, [4, 12]],
  ],
);
const g = buildGraph(map);
const field = (): BoardState =>
  board([
    mine(1, 1),
    enemy(2, 1, 20),
    enemy(3, 3, 20),
    mine(4, 24),
    mine(5, 2),
    neutral(6, 8),
    neutral(7, 8),
    mine(8, 120),
    neutral(9, 8),
    mine(11, 1),
    mine(12, 1),
    enemy(20, 10, 20),
    enemy(30, 12, 30),
    enemy(31, 20, 30),
  ]);
const input = (income = 18, settings: PlannerSettings = RATES): PlanInput => ({
  graph: g,
  board: field(),
  me: ME,
  income,
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

describe('#214: a lead step toward the closest bonus funded on a conceded source', () => {
  it('takes both of the closest bonus\'s enemy members: one from the conceded border with deploys, one from the held border', () => {
    const i = input();
    const p = planTurn(i);
    expect(attacks(p).map((m) => [m.from, m.to]).sort((a, b) => a[1]! - b[1]!)).toEqual([
      [1, 2],
      [4, 3],
    ]);
    // Not the farther bonus's neutral step.
    expect(attacks(p).map((m) => m.to)).not.toContain(6);
    // Pass 1 completes it whole: T2's step from the conceded T1 counts T3, its sibling in the same
    // completion (#122's exception), and T1's deploys all leave with the attack.
    const hit = attacks(p).find((m) => m.to === 2)!;
    expect(hit.reason).toMatch(/completes bonus B901 \(#901\).*player 20's member, taken on my army lead/);
    expect(deployedAt(p, 1)).toBe(hit.armies);
    expect(staysAt(p, i, 1)).toBe(1);
    expect(why(p)).not.toMatch(/T2 \(#2\) \(player 20, 1 armies\)/);
    expect(valid(p, i)).toEqual([]);
  });

  it('completes the closest bonus with the sibling at its bare cost when both sure steps do not fit (#214 item 1)', () => {
    // At 12 both sure steps (10 + 5 deploys) do not fit. Before #214 item 1 the completion was
    // undone and the advance took T3 alone. Now the completion is tried again with each lead step
    // retried at its bare cost once its sure try fails: T3 sure from the held T4 (5 deploys), T2
    // bare from the conceded T1 (2: its 1 defender now), and #120's warning names the risk.
    const i = input(12);
    const p = planTurn(i);
    expect(attacks(p).map((m) => [m.from, m.to]).sort((a, b) => a[1]! - b[1]!)).toEqual([
      [1, 2],
      [4, 3],
    ]);
    expect(attacks(p).find((m) => m.to === 3)!.reason).toMatch(/completes bonus B901 \(#901\).*sure even if player 20 deploys its ~5 there first \(3 \+ 5 defenders\)/);
    expect(attacks(p).find((m) => m.to === 2)!.reason).toMatch(
      /completes bonus B901 \(#901\).*sized for the 1 defenders there now: 10 would be sure even if player 20 deploys its ~5 there first, more than this turn can fund \(#214\)/,
    );
    expect(p.warnings.join('\n')).toMatch(/Attack on enemy T2 \(#2\) assumes its owner does not reinforce it first: if player 20 deploys its ~5 there/);
    expect(attacks(p).map((m) => m.to)).not.toContain(6);
    expect(valid(p, i)).toEqual([]);
  });

  it('says what was short when the deploy cannot reach the conceded source, not a conceded gate', () => {
    // At 6 the sure T3 takes 5 of the deploy. The step on T2 from T1 (1 army, conceded) needs 10
    // sure and still 2 at its bare cost (#214 item 1): T2 is skipped, and its line names what T1
    // could spare and the deploy that could reach it, on the bare basis the line opens with.
    const i = input(6);
    const p = planTurn(i);
    expect(attacks(p).map((m) => m.to)).not.toContain(2);
    expect(deployedAt(p, 1)).toBe(0);
    const line = p.rationale.find((l) => l.startsWith('Not attacking')) ?? '';
    expect(line).toMatch(
      /T2 \(#2\) \(player 20, 1 armies\): taking it needs 2 \(10 if player 20 deploys its ~5 there first\).*when its bonus's step was tried, T1 \(#1\) could spare 0 for it and this turn's deploy could add at most 1 there: 1 in all;/,
    );
    expect(line).not.toMatch(/is conceded/);
    expect(valid(p, i)).toEqual([]);
  });

  it("completes a bonus from a conceded border when its sibling step is planned in the same completion", () => {
    // T2 is a 2-army neutral (no lead step) beside the conceded T1 (3 armies); T3 (7) is player 20's
    // lead step beside the held T4. The completion tries T2 first: before, #122's exception saw T3
    // not yet taken and refused T1, so the bonus was never completed. Now the pair is one completion.
    const b = board([
      mine(1, 3),
      neutral(2, 2),
      enemy(3, 7, 20),
      mine(4, 18),
      mine(5, 2),
      neutral(6, 2),
      neutral(7, 9),
      mine(8, 151),
      neutral(9, 4),
      mine(11, 1),
      mine(12, 2),
      enemy(20, 7, 20),
      enemy(30, 20, 30),
      enemy(31, 25, 30),
    ]);
    const m = { ...map, bonuses: map.bonuses.map((x) => (x.id === 902 ? { ...x, value: 1 } : x)) };
    const i: PlanInput = { ...input(23), graph: buildGraph(m), board: b };
    const p = planTurn(i);
    expect(attacks(p).map((x) => [x.from, x.to]).sort((a, c) => a[1]! - c[1]!)).toEqual([
      [1, 2],
      [4, 3],
    ]);
    expect(attacks(p).find((x) => x.to === 2)!.reason).toBe('completes bonus B901 (#901) (+2)');
    expect(why(p)).toMatch(/Keep T1 \(#1\) \(not conceded\): this turn's captures complete bonus B901 \(#901\)/);
    // Not withdrawn: T1's armies attack out.
    expect(p.moves.some((x) => x.from === 1 && x.kind === 'transfer')).toBe(false);
    expect(valid(p, i)).toEqual([]);
  });

  /**
   * A board from the review's sweep (random armies, income and bonus values on this map):
   * `[territory, owner (0 neutral), armies]`, the income, and B901/B902's values.
   */
  const swept = (ts: [number, number, number][], income: number, a: number, b: number): PlanInput => {
    const m = { ...map, bonuses: map.bonuses.map((x) => (x.id === 901 ? { ...x, value: a } : x.id === 902 ? { ...x, value: b } : x)) };
    const field = board(ts.map(([id, owner, armies]) => (owner === ME ? mine(id, armies) : owner ? enemy(id, armies, owner) : neutral(id, armies))));
    return { ...input(income), graph: buildGraph(m), board: field };
  };

  it('takes the held border\'s sibling first when the conceded-funded step would block the completion', () => {
    // T2 (player 20, 5) beside the conceded T1 (5), T3 (neutral, 3) beside the held T4 (26), income
    // 13. Taking T2 first sank 12 of 13 into T1, and then rule 1c's guard refused T3's completion
    // (it judged T1's exposure as if the completion added it). T3 first, then T2 completes the bonus,
    // and the guard sees T1 exposed whether or not it is completed.
    const i = swept(
      [[1, 10, 5], [2, 20, 5], [3, 0, 3], [4, 10, 26], [5, 10, 3], [6, 0, 6], [7, 0, 4], [8, 10, 114], [9, 0, 9],
        [11, 10, 1], [12, 10, 2], [20, 20, 3], [30, 30, 16], [31, 30, 30]],
      13, 2, 5,
    );
    const p = planTurn(i);
    expect(attacks(p).map((m) => [m.from, m.to]).sort((a, b) => a[1]! - b[1]!)).toEqual([
      [1, 2],
      [4, 3],
    ]);
    expect(why(p)).not.toMatch(/Do not complete bonus B901/);
    expect(p.warnings.join('\n')).not.toMatch(/completing B901 \(#901\) leaves .*: not completed/);
    expect(why(p)).toMatch(/Keep T1 \(#1\) \(not conceded\): this turn's captures complete bonus B901 \(#901\)/);
    expect(valid(p, i)).toEqual([]);
  });

  it('completes the closest bonus, not the farther one\'s neutral step, when the relaxed pass tries the conceded step first', () => {
    // T2 (player 20, 5) beside the conceded T1 (2), T3 (neutral, 2) beside the held T4 (22), income
    // 18. With T2 taken first the guard refused T3, the two-step fixed point settled on the base
    // plan, and the deploy went to B902's neutral T6 — the issue's outcome.
    const i = swept(
      [[1, 10, 2], [2, 20, 5], [3, 0, 2], [4, 10, 22], [5, 10, 2], [6, 0, 7], [7, 0, 7], [8, 10, 147], [9, 0, 4],
        [11, 10, 3], [12, 10, 3], [20, 20, 6], [30, 30, 17], [31, 30, 8]],
      18, 2, 4,
    );
    const p = planTurn(i);
    const to = attacks(p).map((m) => m.to);
    expect(to).toContain(2);
    expect(to).toContain(3);
    expect(to).not.toContain(6);
    expect(attacks(p).find((m) => m.to === 2)!.from).toBe(1);
    expect(why(p)).not.toMatch(/Do not complete bonus B901/);
    expect(valid(p, i)).toEqual([]);
  });

  it('advances from the held border, not the conceded one, when only one step of the closest bonus fits', () => {
    // T2 (player 20, 3) beside the conceded T1 (2), T3 (neutral, 4) beside the held T4 (21), income
    // 13. Both steps do not fit. Taking T2 alone sank 12 of 13 into the conceded T1 for one capture;
    // T3 from T4 (a few deploys) leaves the rest for B902's T6 — two captures.
    const i = swept(
      [[1, 10, 2], [2, 20, 3], [3, 0, 4], [4, 10, 21], [5, 10, 1], [6, 0, 5], [7, 0, 7], [8, 10, 64], [9, 0, 9],
        [11, 10, 1], [12, 10, 2], [20, 20, 11], [30, 30, 14], [31, 30, 12]],
      13, 3, 3,
    );
    const p = planTurn(i);
    expect(attacks(p).map((m) => m.to)).not.toContain(2);
    expect(attacks(p).find((m) => m.to === 3)).toMatchObject({ from: 4 });
    expect(attacks(p).map((m) => m.to)).toContain(6);
    expect(deployedAt(p, 1)).toBe(0);
    expect(why(p)).not.toMatch(/is conceded, but the deploy there leaves with the attack/);
    expect(valid(p, i)).toEqual([]);
  });

  it('completes the bonus with the conceded sibling at its bare cost rather than leaving it after the sure step (#214 item 1)', () => {
    // Before #214 item 1 the sure T2 (18) did not fit beside the sure T3, so the advance kept T3
    // and B902's T6 and left T2. Now the completion retries T2 at its bare cost (10, its 6
    // defenders now) from the conceded T1: B901 completes, and T6 still fits.
    const i = swept(
      [[1, 10, 5], [2, 20, 6], [3, 20, 6], [4, 10, 29], [5, 10, 3], [6, 0, 5], [7, 0, 8], [8, 10, 157], [9, 0, 2],
        [11, 10, 3], [12, 10, 1], [20, 20, 4], [30, 30, 19], [31, 30, 20]],
      16, 3, 4,
    );
    const p = planTurn(i);
    expect(attacks(p).find((m) => m.to === 3)).toMatchObject({ from: 4 });
    expect(attacks(p).find((m) => m.to === 2)).toMatchObject({ from: 1, armies: 10 });
    expect(attacks(p).find((m) => m.to === 2)!.reason).toMatch(/completes bonus B901 \(#901\).*sized for the 6 defenders there now: 18 would be sure/);
    expect(attacks(p).map((m) => m.to)).toContain(6);
    expect(valid(p, i)).toEqual([]);
  });

  it('completes the bonus: the conceded step sure, its sibling at its bare cost (#214 item 1)', () => {
    // T2 (player 20, 2) beside the conceded T1 (5) needs 7 deploys sure; T3 (player 20, 7) beside
    // the held T4 (28) needs all 17 sure. Before #214 item 1 one B901 capture fitted (T2, then
    // B902's T6 from the rest). Now the completion retries T3 at its bare cost (11: its 7 defenders
    // now, 4 deploys) once its sure try fails: T2 sure, T3 bare, B901 complete.
    const i = swept(
      [[1, 10, 5], [2, 20, 2], [3, 20, 7], [4, 10, 28], [5, 10, 3], [6, 0, 7], [7, 0, 4], [8, 10, 140], [9, 0, 3],
        [11, 10, 2], [12, 10, 1], [20, 20, 5], [30, 30, 18], [31, 30, 28]],
      17, 3, 3,
    );
    const p = planTurn(i);
    const hit = attacks(p).find((m) => m.to === 2);
    expect(hit).toMatchObject({ from: 1, armies: 11 });
    expect(hit!.reason).toMatch(/completes bonus B901 \(#901\).*sure even if player 20 deploys its ~5 there first \(2 \+ 5 defenders\)/);
    const t3 = attacks(p).find((m) => m.to === 3);
    expect(t3).toMatchObject({ from: 4, armies: 11 });
    expect(t3!.reason).toMatch(/completes bonus B901 \(#901\).*sized for the 7 defenders there now: 20 would be sure/);
    expect(staysAt(p, i, 1)).toBe(1);
    expect(valid(p, i)).toEqual([]);
  });

  it('says once that the closest bonus is not completed when both passes refuse it for income (rule 4c)', () => {
    // B907 (+2, T6 alone) is closer and completes first. B906 (−3: T3 and T6) then makes B901's
    // completion lower income. Pass 1 refuses it, and pass 2's retry (its conceded-funded step T2
    // tried last) refuses it again: the line is said once.
    const m = {
      ...map,
      bonuses: [
        ...map.bonuses,
        { id: 906, name: 'B906', value: -3, territoryIds: [3, 6], bonusIds: [] },
        { id: 907, name: 'B907', value: 2, territoryIds: [6], bonusIds: [] },
      ],
    };
    const b = board([
      mine(1, 1), enemy(2, 1, 20), enemy(3, 1, 20), mine(4, 24), mine(5, 2), neutral(6, 2), neutral(7, 8), mine(8, 120),
      neutral(9, 8), mine(11, 1), mine(12, 1), enemy(20, 10, 20), enemy(30, 12, 30), enemy(31, 20, 30),
    ]);
    const i: PlanInput = { ...input(16), graph: buildGraph(m), board: b };
    const p = planTurn(i);
    const lines = p.rationale.filter((l) => l.startsWith('Do not complete bonus B901 (#901) (+2): with this turn\'s other captures it changes income'));
    expect(lines).toHaveLength(1);
    expect(valid(p, i)).toEqual([]);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(planTurn(input()))).toBe(JSON.stringify(planTurn(input())));
  });
});
