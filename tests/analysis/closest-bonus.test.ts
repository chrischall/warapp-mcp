// Issue #101: a 1v1 at 5 income with no bonus held by turn 7 — each plan advanced a different
// bonus (one attack each into two large bonuses, then two others) and completed none, and one
// bonus's "to finish" figure jumped between consecutive plans. While no bonus is held (and in
// the expansion phase), expansion now concentrates on the bonus closest to completion (armies
// to finish, counting the members I hold), keeps the bonus advanced last turn unless another is
// strictly closer, and counts fogged members in the figure. Synthetic maps only: every id and
// name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanGameContext, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const P2 = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const DUEL: PlanGameContext = { players: [{ id: ME }, { id: P2 }], turn: 6 };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, string, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Closest',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, name, value, territoryIds]) => ({ id, name, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const player = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

//   I hold 1 (in Alpha) and 2 (in Beta), next to each other.
//   Alpha (+2): 1 11 12   — 11 and 12 next to 1: 2 missing, 3 + 3 = 6 armies to finish.
//   Beta  (+2): 2 21 22   — 21 and 22 next to 2: 2 missing, 6 armies to finish.
//   Gamma (+8): 31..36    — a chain from 1: 6 missing, 18 to finish (8 / 18 per army).
//   Delta (+9): 41..46    — a chain from 2: 6 missing, 18 to finish (9 / 18 per army).
//   By value per army the large bonuses win, so the old plan put one attack into each of them
//   and completed nothing; the closest bonuses are the small ones.
//   The opponent sits on 90, at the far end of both chains (no contact).
const EDGES: [number, number][] = [
  [1, 2], [1, 11], [1, 12], [11, 12], [2, 21], [2, 22], [21, 22],
  [1, 31], [31, 32], [32, 33], [33, 34], [34, 35], [35, 36],
  [2, 41], [41, 42], [42, 43], [43, 44], [44, 45], [45, 46],
  [36, 90], [46, 90],
];
const IDS = [1, 2, 11, 12, 21, 22, 31, 32, 33, 34, 35, 36, 41, 42, 43, 44, 45, 46, 90];
const ALPHA = 301;
const BETA = 302;
const GAMMA = 303;
const DELTA = 304;
const BONUSES: [number, string, number, number[]][] = [
  [ALPHA, 'Alpha', 2, [1, 11, 12]],
  [BETA, 'Beta', 2, [2, 21, 22]],
  [GAMMA, 'Gamma', 8, [31, 32, 33, 34, 35, 36]],
  [DELTA, 'Delta', 9, [41, 42, 43, 44, 45, 46]],
];
const MAP = makeMap(IDS, EDGES, BONUSES);
const g = buildGraph(MAP);

const neutrals = (ids: number[], armies = 2) => ids.map((id) => neutral(id, armies));
const field = (over: TerritoryState[] = [], a = 4, b = 4): BoardState => {
  const base = [
    mine(1, a),
    mine(2, b),
    ...neutrals([11, 12, 21, 22, 31, 32, 33, 34, 35, 36, 41, 42, 43, 44, 45, 46]),
    player(90, 3, P2),
  ];
  return board(base.map((t) => over.find((o) => o.territoryId === t.territoryId) ?? t));
};

const plan = (b: BoardState, income: number, o: { previous?: BoardState; game?: PlanGameContext; options?: Parameters<typeof planTurn>[0]['options'] } = {}) =>
  planTurn({
    graph: g,
    board: b,
    me: ME,
    income,
    settings: STD,
    game: o.game ?? DUEL,
    ...(o.previous ? { previousBoard: o.previous } : {}),
    ...(o.options ? { options: o.options } : {}),
  });

const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const targets = (p: TurnPlan) => attacks(p).map((m) => m.to).sort((x, y) => x - y);
const why = (p: TurnPlan) => p.rationale.join('\n');

/** The plan passes warapp_submit_turn's validator. */
function valid(p: TurnPlan, b: BoardState, income: number) {
  const names = new Map(MAP.territories.map((t) => [t.id, t.name]));
  const ref = (id: number) => ({ id, name: names.get(id)! });
  return validateTurn({
    map: MAP,
    board: b.territories.map(
      (t): LiveTerritory => ({
        territoryId: t.territoryId,
        fogLevel: 1,
        fogged: t.armies === null,
        owner: t.owner.kind === 'player' ? t.owner.playerId : t.owner.kind === 'neutral' ? OWNER_NEUTRAL : -1,
        armies: t.armies,
      }),
    ),
    myInGameId: ME,
    income,
    guard: true,
    deploys: p.deploys.map((d) => ({ territory: ref(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: ref(m.from), to: ref(m.to), armies: m.armies })),
  }).warnings;
}

describe('commit to the closest bonus while none is held (#101)', () => {
  it('the arithmetic: a 2-neutral takes 3, a 1-neutral 2', () => {
    expect(armiesToTake(2)).toBe(3);
    expect(armiesToTake(1)).toBe(2);
  });

  it('(a) captures concentrate on the small bonuses closest to completion, not one into each large one', () => {
    const b = field();
    const p = plan(b, 5);
    expect(p.profile).toMatchObject({ format: '1v1', phase: 'expansion' });
    // 3 + 3 movable and 5 deploys: three captures of 3. Alpha completes (11, 12) and Beta starts (21);
    // neither Gamma's 31 nor Delta's 41 is attacked.
    expect(targets(p)).toEqual([11, 12, 21]);
    expect(why(p)).toMatch(
      /No bonus held: expansion goes to the bonus closest to completion first — Alpha \(#301\) 6 armies to finish, 2 turns at income 5, Beta \(#302\) 6, 2 turns, Delta \(#304\) 18, 4 turns, Gamma \(#303\) 18, 4 turns — /,
    );
    expect(attacks(p).find((m) => m.to === 21)!.reason).toMatch(/advances bonus Beta \(#302\) \(\+2, 6 armies to finish\)/);
    expect(valid(p, b, 5)).toEqual([]);
  });

  it('(a) a capture into a farther bonus uses only armies the closer one cannot use', () => {
    // Plenty of armies: Alpha and Beta complete first, and what they leave goes to Delta and Gamma.
    const b = field([], 12, 12);
    const p = plan(b, 5);
    expect(targets(p)).toEqual(expect.arrayContaining([11, 12, 21, 22]));
    expect(attacks(p).filter((m) => [11, 12, 21, 22].includes(m.to)).every((m) => m.armies === 3)).toBe(true);
    expect(valid(p, b, 5)).toEqual([]);
  });

  describe('(b) stability with previousBoard', () => {
    // No movable armies: 5 deploys fund one capture of 3 (Alpha and Beta both 6 to finish).
    const thin = (over: TerritoryState[] = []) => field(over, 1, 1);

    it('with no history, equally close bonuses keep the score order (here: the lower id, Alpha)', () => {
      const p = plan(thin(), 5);
      expect(targets(p)).toHaveLength(1);
      expect([11, 12]).toContain(targets(p)[0]);
    });

    it('the bonus advanced last turn keeps priority over an equally close one', () => {
      // Last turn 2 was a neutral: I captured it, so Beta was advanced since then.
      const previous = thin([neutral(2, 2)]);
      const p = plan(thin(), 5, { previous });
      expect(targets(p)).toHaveLength(1);
      expect([21, 22]).toContain(targets(p)[0]);
      expect(why(p)).toMatch(/Beta \(#302\) keeps priority: I advanced it last turn, and no bonus is strictly closer to completion/);
    });

    it('…and loses it to a strictly closer one', () => {
      // Alpha's 11 holds 1: 2 + 3 = 5 to finish (1 turn at 5 income), strictly closer than Beta's 6 (2 turns).
      const now = thin([neutral(11, 1)]);
      const previous = thin([neutral(2, 2), neutral(11, 1)]);
      const p = plan(now, 5, { previous });
      expect(attacks(p)[0]!.to).toBe(11);
      expect(targets(p).some((t) => t === 21 || t === 22)).toBe(false);
      expect(why(p)).not.toMatch(/keeps priority/);
      expect(why(p)).toMatch(
        /Beta \(#302\), advanced last turn, gives way to Alpha \(#301\): it is strictly closer to completion \(1 turn to finish against 2 turns\)/,
      );
    });
  });

  it('(c) "to finish" counts fogged members, so it does not jump when they come into view or the board changes elsewhere', () => {
    // Gamma's 33..36 in the fog: each counted at its costliest visible missing member (3).
    const foggy = field([fogged(33), fogged(34), fogged(35), fogged(36)]);
    // The same members revealed as the neutrals they were, and an unrelated change in Delta.
    const clear = field([neutral(46, 7)]);
    const figure = (p: TurnPlan) => why(p).match(/Gamma \(#303\) (\d+)/)?.[1];
    const a = plan(foggy, 5);
    const c = plan(clear, 5);
    expect(figure(a)).toBe('18');
    expect(figure(c)).toBe('18');
    expect(why(a)).toMatch(/Gamma \(#303\) 18 \(4 fogged members counted at 3 each\)/);
  });

  it('(d) once a bonus is held and in contact, expansion ranks by value per army again', () => {
    // Alpha held in full; the opponent touches Beta's 22 (contact) with too little to threaten it.
    const b = board([
      mine(1, 8),
      mine(11, 1),
      mine(12, 1),
      mine(2, 8),
      neutral(21, 2),
      player(22, 1, P2),
      ...neutrals([31, 32, 33, 34, 35, 36, 41, 42, 43, 44, 45, 46]),
      player(90, 3, P2),
    ]);
    const p = plan(b, 7);
    expect(p.profile.phase).toBe('contact');
    expect(why(p)).not.toMatch(/closest to completion/);
    // Value per army again: Delta (9 / 18) and Gamma (8 / 18) are advanced before Beta (2 / 5).
    expect(attacks(p).map((m) => m.to)).toEqual([41, 31, 21]);
    expect(valid(p, b, 7)).toEqual([]);
  });
});
