// #203: adapting in a free-for-all on a big army lead, an enemy member of the closest bonus (rule
// 4f) was left to the lead strikes, which run after the income is spent and count standing armies
// only — so the deploy went to a farther bonus's step instead. Now such a member is a step into its
// bonus (sized like a lead strike: its defenders plus its owner's deploy), funded from this turn's
// deploy in rule 4f's order, under the Local Deployment pools; and when it still does not fit,
// the skip line says what the deploy could add. Every map, id and name here is made up.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const OFF: PlannerSettings = { offensiveKillRate: 30, defensiveKillRate: 75, oneArmyStandsGuard: false };

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

// Bonus A (#901, +5): my T1 (9), a neutral T2 (12: 40 to take at 30%) and player 20's T3 with 0
// armies — the closest bonus, 2 turns at income 20. Bonus B (#902, +5): my T4 (2) and a chain of
// neutrals T5–T7 — 3 layers deep. My 60 on the interior T8 (B903, +15, held) give me a 3.5× lead
// over player 20's 20 on T20 (beside T3, away from me); player 30 sits on T30 at the far end of B.
const g = buildGraph(
  makeMap(
    [1, 2, 3, 4, 5, 6, 7, 8, 20, 30],
    [
      [1, 2],
      [1, 3],
      [2, 3],
      [3, 20],
      [1, 4],
      [4, 8],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 30],
    ],
    [
      [901, 5, [1, 2, 3]],
      [902, 5, [4, 5, 6, 7]],
      [903, 15, [8]],
    ],
  ),
);
const field = (): BoardState =>
  board([
    mine(1, 9),
    neutral(2, 12),
    enemy(3, 0, 20),
    mine(4, 2),
    neutral(5, 6),
    neutral(6, 2),
    neutral(7, 2),
    mine(8, 60),
    enemy(20, 20, 20),
    enemy(30, 5, 30),
  ]);
const input = (settings: PlannerSettings = OFF): PlanInput => ({
  graph: g,
  board: field(),
  me: ME,
  income: 20,
  settings,
  game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 10 },
  options: { adapt: true },
});
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const why = (p: TurnPlan) => p.rationale.join('\n');

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

describe("#203: the closest bonus's enemy member gets the deploy on an army lead", () => {
  it("takes the 0-army enemy member with deploy plus standing armies, sized for its owner's deploy", () => {
    const i = input();
    const p = planTurn(i);
    const hit = attacks(p).find((m) => m.to === 3);
    expect(hit).toBeDefined();
    expect(hit!.from).toBe(1);
    // 0 defenders plus player 20's ~5 deploy: 15 at 30/75. T1 spares 8 of its 9 standing.
    expect(hit!.armies).toBeGreaterThanOrEqual(15);
    expect(p.deploys.find((d) => d.territoryId === 1)?.armies ?? 0).toBeGreaterThanOrEqual(hit!.armies - 8);
    expect(why(p)).toMatch(
      /Attack T3 \(#3\) from T1 \(#1\) with \d+ \(deploy \d+ there\): advances bonus B901 \(#901\).*army lead.*sure even if player 20 deploys its ~5 there first/,
    );
    expect(p.warnings.join('\n')).not.toMatch(/Attack on enemy T3 \(#3\) assumes/);
    expect(valid(p, i)).toEqual([]);
  });

  it('does not fund the farther bonus first', () => {
    const p = planTurn(input());
    // B's step needs 18 of deploy on T4: what A's step leaves does not cover it.
    expect(attacks(p).map((m) => m.to)).not.toContain(5);
  });

  it('under Local Deployment only the free armies reach T1: the step does not fit, and the skip line says what the deploy could add', () => {
    // B903 (+15) is held: its 15 deploy only on T8; the 5 free armies may go anywhere.
    const i = input({ ...OFF, localDeployments: true });
    const p = planTurn(i);
    expect(attacks(p).map((m) => m.to)).not.toContain(3);
    expect(why(p)).toMatch(
      /T3 \(#3\) \(player 20, 0 armies\): a lead strike \(my army lead is [\d.]+×, over 3×\) needs 15 — sized for its 0 defenders plus player 20's ~5 deploy — and the most a neighbour of mine can spare for it is \d+ \(T1 \(#1\)\); when its bonus's step was tried, T1 \(#1\) could spare 8 for it and this turn's deploy could add at most 5 there \(Local Deployment\): 13 in all/,
    );
    expect(valid(p, i)).toEqual([]);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(planTurn(input()))).toBe(JSON.stringify(planTurn(input())));
  });
});

// Two randomized synthetic boards from a planner sweep (made-up map, ids and players).
const sweepBoards = JSON.parse(
  readFileSync(new URL('../fixtures/lead-step-boards.json', import.meta.url), 'utf8'),
) as Record<'retire' | 'skip' | 'rollback', { map: GameMap; territories: TerritoryState[]; income: number; settings: PlannerSettings; options: PlanInput['options']; game: PlanInput['game']; turn: number; tracks: PlanInput['tracks'] }>;
const sweepInput = (k: 'retire' | 'skip' | 'rollback'): PlanInput => {
  const b = sweepBoards[k];
  return {
    graph: buildGraph(b.map),
    board: { source: 'gamefeed', verified: false, territories: b.territories },
    me: ME,
    income: b.income,
    settings: b.settings,
    turn: b.turn,
    ...(b.tracks ? { tracks: b.tracks } : {}),
    game: b.game,
    options: b.options,
  };
};
const reasonFor = (p: TurnPlan, id: number) =>
  p.rationale.find((l) => l.startsWith('Not attacking'))?.split(/; (?=T\d+ \(#\d+\) \(player)/).find((s) => s.includes(`T${id} (#${id}) (player`)) ?? '';

describe('#203 review: a lead step its bonus pass does not take', () => {
  it('goes back to its ordinary cost: rule 4e takes it at that size from the conceded border', () => {
    // T13 (player 30, 3 armies, a member of B1002 +1) costs 21 as a lead step (3 + its owner's ~10)
    // but 18 at its plain size: the bonus pass cannot fund 21, and rule 4e's fallback takes it with
    // the 18 on conceded T2 — a favourable exchange — rather than withdraw T2 and strike T7 at -4.
    const i = sweepInput('retire');
    const p = planTurn(i);
    const hit = attacks(p).find((m) => m.to === 13);
    expect(hit).toMatchObject({ from: 2, armies: 18 });
    expect(why(p)).not.toMatch(/T13 \(#13\) does not fit what the holds leave: it needs 21/);
    expect(why(p)).toMatch(/Exchange of attacks on players \(#167\): T13 \(#13\) from T2 \(#2\) with 18: favourable exchange/);
    // Sized for its armies now, not its owner's deploy: the plan says so.
    expect(p.warnings.some((w) => w.startsWith('Attack on enemy T13 (#13) assumes its owner does not reinforce it first'))).toBe(true);
    expect(attacks(p).map((m) => m.to)).not.toContain(7);
  });

  it("the skip line counts no deploy twice and points to no line that is not there", () => {
    const i = sweepInput('skip');
    const p = planTurn(i);
    const line = reasonFor(p, 7);
    expect(line).toMatch(/a lead strike .* needs 18/);
    expect(line).not.toMatch(/it fits|its line says why/);
    // What one neighbour could put into it when its bonus's step was tried: short of the 18.
    const m = line.match(/when its bonus's step was tried, T\d+ \(#\d+\) could spare (\d+) for it and this turn's deploy could add at most (\d+) there: (\d+) in all/);
    expect(m).not.toBeNull();
    expect(Number(m![1]) + Number(m![2])).toBe(Number(m![3]));
    expect(Number(m![3])).toBeLessThan(18);
    expect(valid(p, i)).toEqual([]);
  });
});

describe('#203 review: a lead step tried and not taken', () => {
  it("leaves no sure sizing behind: rule 4e ranks player 30's T2 and T21 by the armies on them now", () => {
    // Both are lead steps the bonus passes could not fund (41 and 45 for sure). Left assumed sure,
    // T21 read as losing ~8 and T2 was taken instead, from T6, as a "sure" attack it is not.
    const i = sweepInput('rollback');
    const p = planTurn(i);
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([[11, 21, 11]]);
    expect(why(p)).toMatch(/T2 \(#2\) is ranked after T21 \(#21\): it costs 5 \(loses ~2 armies, and its 3 survivors may fall next turn\) against 4/);
    expect(p.warnings.some((w) => w.startsWith('Attack on enemy T21 (#21) assumes its owner does not reinforce it first'))).toBe(true);
    expect(valid(p, i)).toEqual([]);
  });
});

describe('#203 review: a lead step taken by a completion is named', () => {
  it("says it is player 20's member, taken on my army lead", () => {
    // T2 mine: T3 (player 20, 0 armies) completes B901.
    const i: PlanInput = {
      ...input(),
      board: board([
        mine(1, 9),
        mine(2, 12),
        enemy(3, 0, 20),
        mine(4, 2),
        neutral(5, 6),
        neutral(6, 2),
        neutral(7, 2),
        mine(8, 60),
        enemy(20, 20, 20),
        enemy(30, 5, 30),
      ]),
    };
    const p = planTurn(i);
    const hit = attacks(p).find((m) => m.to === 3);
    expect(hit).toBeDefined();
    expect(hit!.reason).toMatch(/^completes bonus B901 \(#901\) \(\+5\) — player 20's member, taken on my army lead \([\d.]+×\): sure even if player 20 deploys its ~5 there first \(0 \+ 5 defenders\)$/);
    expect(p.warnings.join('\n')).not.toMatch(/Attack on enemy T3 \(#3\) assumes/);
    expect(valid(p, i)).toEqual([]);
  });
});
