// #214 item 1: a lead step (#203) toward the closest bonus was sized only at its sure cost, its
// defenders plus everything its owner may deploy there first. At a 30% offensive kill rate the
// owner's ~16 is multiplied about 3.3×: 52 and 65 against 18 and 24 the turn could fund, so the
// steps were never taken — while the closest-bonus ranking priced the same members at their bare
// cost (1 and 12). Now the sure-sized try comes first; when it cannot be funded, a step toward the
// closest bonus (or a completion) is retried at its bare cost, a sure capture of the defenders
// standing there now. #120's warning then says what it faces if the owner deploys there first.
// Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;

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

// Bonus A (#901, +2): my T1 (1 army, conceded: it faces player 30's T30) and T4 (15, facing T31),
// player 20's T2 (0 armies) and T3 — the closest bonus. Bonus B (#902, +5): my T5 and a chain of
// three neutrals, 3 layers deep. My 150 on the interior T8 (#903, +10 held) give me the lead. Every
// player's base income is 16, so each opponent may deploy ~16 on the step first.
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
      [905, 3, [4, 12]],
    ],
  ),
);
const field = (t3: number): BoardState =>
  board([
    mine(1, 1),
    enemy(2, 0, 20),
    enemy(3, t3, 20),
    mine(4, 15),
    mine(5, 2),
    neutral(6, 4),
    neutral(7, 4),
    mine(8, 150),
    neutral(9, 4),
    mine(11, 1),
    mine(12, 1),
    enemy(20, 10, 20),
    enemy(30, 12, 30),
    enemy(31, 12, 30),
  ]);
const LOW: PlannerSettings = { offensiveKillRate: 30, defensiveKillRate: 75, oneArmyStandsGuard: false, baseIncome: 16 };
const MID: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: false, baseIncome: 16 };
const input = (settings: PlannerSettings, t3: number, income = 18): PlanInput => ({
  graph: g,
  board: field(t3),
  me: ME,
  income,
  settings,
  game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 10 },
  options: { adapt: true },
});
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const skipLine = (p: TurnPlan) => p.rationale.find((l) => l.startsWith('Not attacking')) ?? '';

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

describe('#214 item 1: a lead step the sure cost cannot fund is retried at its bare cost', () => {
  it('30/75: takes both of the closest bonus\'s steps at their bare cost (1 and 12), not skipped at 52 and 65', () => {
    const i = input(LOW, 4);
    const p = planTurn(i);
    const hits = attacks(p).filter((m) => m.to === 2 || m.to === 3).map((m) => [m.from, m.to, m.armies]);
    expect(hits.sort((a, b) => a[1]! - b[1]!)).toEqual([
      [1, 2, 1],
      [4, 3, 12],
    ]);
    const t2 = attacks(p).find((m) => m.to === 2)!;
    expect(t2.reason).toMatch(/bonus B901 \(#901\).*player 20's member, taken on my army lead/);
    expect(t2.reason).toMatch(/sized for the 0 defenders there now: 52 would be sure even if player 20 deploys its ~16 there first, more than this turn can fund/);
    expect(t2.reason).not.toMatch(/sure even if player 20 deploys its ~16 there first \(0 \+ 16 defenders\)/);
    // #120's warning says what each faces if player 20 deploys there first.
    expect(p.warnings.join('\n')).toMatch(/Attack on enemy T2 \(#2\) assumes its owner does not reinforce it first: if player 20 deploys its ~16 there, 1 attack 16 \(win chance 0%\); 52 would be sure/);
    expect(p.warnings.join('\n')).toMatch(/Attack on enemy T3 \(#3\) assumes its owner does not reinforce it first: if player 20 deploys its ~16 there, 12 attack 20/);
    // Neither is in the skip line any more.
    expect(skipLine(p)).not.toMatch(/T2 \(#2\)|T3 \(#3\)/);
    expect(valid(p, i)).toEqual([]);
  });

  it('60/70: the same shape at the default kill rates (sure 26 and 38, bare 1 and 11)', () => {
    // T3 (7 armies) is taken at its bare 11 from T4 (the sure 38 is out of reach). T2's bare step
    // would then complete B901, whose frontier would fall next turn: R3 refuses it, and its skip
    // line says so rather than a funding shortfall.
    const i = input(MID, 7);
    const p = planTurn(i);
    expect(attacks(p).filter((m) => m.to === 2 || m.to === 3).map((m) => [m.from, m.to, m.armies])).toEqual([[4, 3, 11]]);
    expect(attacks(p).find((m) => m.to === 3)!.reason).toMatch(
      /advances bonus B901 \(#901\).*sized for the 7 defenders there now: 38 would be sure even if player 20 deploys its ~16 there first, more than this turn can fund \(#214\)/,
    );
    expect(p.warnings.join('\n')).toMatch(/Attack on enemy T3 \(#3\) assumes its owner does not reinforce it first: if player 20 deploys its ~16 there, 11 attack 23 \(win chance 0%\); 38 would be sure\./);
    expect(skipLine(p)).toMatch(/T2 \(#2\) \(player 20, 0 armies\): taking it needs 1 \(26 if player 20 deploys its ~16 there first\).*its bonus's step was refused: what survives the attack would not hold it next turn \(R3\)/);
    expect(skipLine(p)).not.toMatch(/T3 \(#3\)/);
    expect(valid(p, i)).toEqual([]);
  });

  it('keeps the sure-sized step when the turn can fund it, and retries only the one it cannot', () => {
    // Base income 5: T3's sure 20 (7 + 5 defenders) fits from T4; T2's sure 8 then does not fit
    // what is left, so only T2 is retried at its bare cost, and only T2 carries #120's warning.
    const i = input({ ...MID, baseIncome: 5 }, 7);
    const p = planTurn(i);
    const t3 = attacks(p).find((m) => m.to === 3)!;
    expect(t3).toMatchObject({ from: 4, armies: 20 });
    expect(t3.reason).toMatch(/completes bonus B901 \(#901\).*sure even if player 20 deploys its ~5 there first \(7 \+ 5 defenders\)/);
    const t2 = attacks(p).find((m) => m.to === 2)!;
    expect(t2).toMatchObject({ from: 1, armies: 1 });
    expect(t2.reason).toMatch(/sized for the 0 defenders there now: 8 would be sure/);
    expect(p.warnings.join('\n')).not.toMatch(/Attack on enemy T3 \(#3\) assumes/);
    expect(p.warnings.join('\n')).toMatch(/Attack on enemy T2 \(#2\) assumes its owner does not reinforce it first: if player 20 deploys its ~5 there, 1 attack 5/);
    expect(valid(p, i)).toEqual([]);
  });

  it('never retries a step a sibling\'s sure try still needs the deploy for', () => {
    // #212's shape at 60/70 with base income 5 (T2: 1 army, T3: 3, T1 holding a +3 border): before
    // the bare round ran after the sure one, T2's bare step (tried first, the cheaper) took the
    // deploy T3's sure step needed, and both landed unsure. The sure T3 is kept; T2 still waits.
    const m = { ...g.map, bonuses: [...g.map.bonuses, { id: 904, name: 'B904', value: 3, territoryIds: [1, 11], bonusIds: [] }] };
    const b = board(
      field(3).territories.map((t) =>
        t.territoryId === 2 ? { ...t, armies: 1 } : t.territoryId === 4 ? { ...t, armies: 12 } : t.territoryId === 8 ? { ...t, armies: 60 } : t.territoryId === 6 || t.territoryId === 7 ? { ...t, armies: 4 } : t,
      ),
    );
    const i: PlanInput = { ...input({ ...MID, baseIncome: 5 }, 3, 21), graph: buildGraph(m), board: b };
    const p = planTurn(i);
    expect(attacks(p).find((x) => x.to === 3)).toMatchObject({ from: 4, armies: 13 });
    expect(attacks(p).find((x) => x.to === 3)!.reason).toMatch(/sure even if player 20 deploys its ~5 there first \(3 \+ 5 defenders\)/);
    expect(attacks(p).map((x) => x.to)).not.toContain(2);
    expect(valid(p, i)).toEqual([]);
  });

  it('funds a lone bare step on a conceded source when the bonus cannot complete this turn', () => {
    // B901 worth +20 and T3 at 12 (40 bare, out of reach): T2's bare step advances B901 alone, from
    // the conceded T1, the deploy sized for the attack (#214's conceded allowance).
    const m = { ...g.map, bonuses: g.map.bonuses.map((x) => (x.id === 901 ? { ...x, value: 20 } : x)) };
    const i: PlanInput = { ...input(LOW, 12), graph: buildGraph(m) };
    const p = planTurn(i);
    const t2 = attacks(p).find((x) => x.to === 2)!;
    expect(t2).toMatchObject({ from: 1, armies: 1 });
    expect(t2.reason).toMatch(/advances bonus B901 \(#901\).*sized for the 0 defenders there now: 52 would be sure/);
    expect(p.rationale.join('\n')).toMatch(/T1 \(#1\) is conceded, but the deploy there leaves with the attack on T2 \(#2\)/);
    expect(valid(p, i)).toEqual([]);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(planTurn(input(LOW, 4)))).toBe(JSON.stringify(planTurn(input(LOW, 4))));
  });
});
