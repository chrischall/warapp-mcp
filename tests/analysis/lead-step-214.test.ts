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

  it('advances the closest bonus from a conceded source with deploys when the completion does not fit', () => {
    // At 12 both steps (10 + 5 deploys) do not fit: the completion is undone, and the advance takes
    // T2, funded on the conceded T1 and sized for the attack — not the farther bonus's step.
    const i = input(12);
    const p = planTurn(i);
    const hit = attacks(p).find((m) => m.to === 2);
    expect(hit).toMatchObject({ from: 1 });
    expect(hit!.reason).toMatch(/advances bonus B901 \(#901\).*player 20's member, taken on my army lead/);
    expect(attacks(p).map((m) => m.to)).not.toContain(6);
    expect(deployedAt(p, 1)).toBe(hit!.armies);
    expect(staysAt(p, i, 1)).toBe(1);
    expect(why(p)).toMatch(
      /T1 \(#1\) is conceded, but the deploy there leaves with the attack on T2 \(#2\): a lead step into a bonus \(rule 4f's order\) may be funded on a conceded source, the deploy sized for the attack alone \(#214\)\./,
    );
    expect(valid(p, i)).toEqual([]);
  });

  it('says what was short when the deploy cannot reach the conceded source, not a conceded gate', () => {
    // At 9 the step on T2 needs 10 from T1 (1 army, conceded): T2 is skipped, and its line names
    // what T1 could spare and the deploy that could reach it.
    const i = input(9);
    const p = planTurn(i);
    expect(attacks(p).map((m) => m.to)).not.toContain(2);
    expect(deployedAt(p, 1)).toBe(0);
    const line = p.rationale.find((l) => l.startsWith('Not attacking')) ?? '';
    expect(line).toMatch(
      /T2 \(#2\) \(player 20, 1 armies\): .*when its bonus's step was tried, T1 \(#1\) could spare 0 for it and this turn's deploy could add at most 9 there: 9 in all;/,
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

  it('is deterministic', () => {
    expect(JSON.stringify(planTurn(input()))).toBe(JSON.stringify(planTurn(input())));
  });
});
