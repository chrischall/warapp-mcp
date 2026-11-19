// #293 review: the Local Deployment reading of the observed deploy and the border bound, and the
// tracker's coverage note. Synthetic maps only: every id and name here is made up.
//  (1) a walled walk draws only on the shrink the captures (and the other grown stacks) left: one
//      neighbour's shrink never offsets a capture and a walled growth both;
//  (2) the free income it reads under counts a Reinforcement card the clock allows on the turn read,
//      in the planner and the tracker alike;
//  (3) outside per-territory income a border faces at most the free income plus the pools it could
//      hold there; with per-territory income the estimate beyond every pool still counts as free;
//  (4) the tracker's "the planner sizes it toward the midpoint" (#368; was #294's 1.5 floor) only when the planner would use the track.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { enemyDeployReaching } from '../../src/analysis/local-deploy.js';
import { trackOpponents } from '../../src/analysis/opponents.js';
import { enemyDeployEstimates, observeDeploy, planTurn, type PlanInput, type PlannerSettings } from '../../src/analysis/planner.js';
import { stressPlan } from '../../src/analysis/stress.js';
import type { GameMap } from '../../src/normalize.js';
import { normalizeSettings } from '../../src/normalize.js';
import { plannerSettings } from '../../src/tools/turn.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, luckModifier: 0, roundingMode: 'StraightRound' };
const LD: PlannerSettings = { ...STD, localDeployments: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
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
const foe = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: FOE }, armies });
const text = (p: { warnings: string[]; rationale: string[] }) => [...p.warnings, ...p.rationale].join('\n');

// Its A (1) beside its B (2) and the neutral C (4); B borders the fogged 3 and my 5. Bonus 101 (B and my
// 5) it cannot hold, so B is walled: growth there is deploy only up to its free income.
const g = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [2, 3], [1, 4], [2, 5]], [[101, 5, [2, 5]]]));
const before: BoardState = board([foe(1, 10), foe(2, 2), fogged(3), neutral(4, 2), mine(5, 5)]);

describe('(1) a walled walk draws on what the captures left (#293 review)', () => {
  it('A shrinks 8, a capture beside A claims it, B grows 8: the 8 count once', () => {
    // A 10 → 2 (sent 8), C taken with 8 standing (claims A's 8), B 2 → 10 beside the fog.
    const after = board([foe(1, 2), foe(2, 10), fogged(3), foe(4, 8), mine(5, 5)]);
    const o = observeDeploy(g, after, before, FOE, LD, { me: ME, expected: 10, localFree: 5 });
    // −8 (A) + 1 (C's cost) + 8 (C, claimed from A) + 5 (B, its free income; nothing left to walk) = 6.
    expect(o.deploy).toBe(6);
    expect(o.localCut).toEqual({ free: 5, territories: [2] });
    expect(o.fogGrowth).toBe(3);
  });

  it('with no capture claiming it, the walk still nets the shrink (unchanged)', () => {
    const after = board([foe(1, 2), foe(2, 10), fogged(3), neutral(4, 2), mine(5, 5)]);
    const o = observeDeploy(g, after, before, FOE, LD, { me: ME, expected: 10, localFree: 0 });
    expect(o.deploy).toBe(0);
    expect(o.localCut).toBeUndefined();
  });
});

describe('(2) the free income it reads under counts a Reinforcement card the clock allows (#293 review)', () => {
  // B grows 12 out of nothing beside the fog: deploy up to the free income. A fogged +10 (6 7) it
  // could hold elsewhere lets it earn more than its base, so the turn's bound is not what cuts.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7], [[1, 2], [2, 3], [1, 4], [2, 5], [3, 6], [6, 7]], [[101, 5, [2, 5]], [102, 10, [6, 7]]]));
  const before = board([foe(1, 10), foe(2, 2), fogged(3), neutral(4, 2), mine(5, 5), fogged(6), fogged(7)]);
  const after = board([foe(1, 10), foe(2, 14), fogged(3), neutral(4, 2), mine(5, 5), fogged(6), fogged(7)]);

  it('plannerSettings carries a fixed Reinforcement card as the opponents\' clock', () => {
    const s = normalizeSettings({
      NumberOfCardsToReceiveEachTurn: 1,
      ReinforcementCard: { NumPieces: 4, InitialPieces: 0, MinimumPiecesPerTurn: 1, Weight: 1, FixedArmies: 8 },
    });
    expect(plannerSettings(s).opponentReinforcement).toEqual({ firstTurn: 5, armies: 8, turnsPerCard: 4 });
    expect(plannerSettings(normalizeSettings({})).opponentReinforcement).toBeUndefined();
  });

  it('the planner: the card joins the free income from the clock\'s first turn on', () => {
    const at = (firstTurn: number, turn: number) =>
      enemyDeployEstimates(g, after, ME, { ...LD, opponentReinforcement: { firstTurn, armies: 4, turnsPerCard: null } }, before, undefined, undefined, { turn })[0]!;
    // The turn read is 5 (planning turn 6): a card from turn 3 can be in hand, one from turn 9 cannot.
    expect(at(3, 6).observation!.localCut).toEqual({ free: 9, territories: [2] });
    expect(at(9, 6).observation!.localCut).toEqual({ free: 5, territories: [2] });
  });

  it('the planner prefers the game\'s own clock (the card in my hand) when it has one', () => {
    const [e] = enemyDeployEstimates(g, after, ME, { ...LD, opponentReinforcement: { firstTurn: 1, armies: 4, turnsPerCard: null } }, before, undefined, undefined, {
      turn: 6,
      reinforcement: { firstTurn: 1, armies: 6, turnsPerCard: null },
    });
    expect(e!.observation!.localCut).toEqual({ free: 11, territories: [2] });
  });

  it('the tracker reads the turn under the same free income', () => {
    const track = (firstTurn: number) =>
      trackOpponents(g, [{ turn: 5, board: before }, { turn: 6, board: after }], ME, { ...LD, opponentReinforcement: { firstTurn, armies: 4, turnsPerCard: null } })[0]!;
    // B's 12: 9 deployable with the card (3 out of the fog), 5 without it (7 out of the fog).
    expect(track(3).turns[0]!.fogArmies).toBe(3);
    expect(track(9).turns[0]!.fogArmies).toBe(7);
  });
});

describe('(3) outside per-territory income a border faces its free income and its pools (#293)', () => {
  const pool = [{ value: 20, members: new Set([5, 6]) }];

  it('enemyDeployReaching: no per-territory income, no slack beyond the pools', () => {
    expect(enemyDeployReaching(30, 5, pool, [3], false)).toBe(5);
    expect(enemyDeployReaching(30, 5, pool, [5], false)).toBe(25);
    expect(enemyDeployReaching(30, 5, [], [3], false)).toBe(5);
    expect(enemyDeployReaching(4, 5, pool, [5], false)).toBe(4);
  });

  it('enemyDeployReaching: with per-territory income the estimate beyond every pool counts as free (unchanged)', () => {
    expect(enemyDeployReaching(30, 5, pool, [3], true)).toBe(10);
    expect(enemyDeployReaching(30, 5, pool, [5], true)).toBe(30);
    expect(enemyDeployReaching(30, 5, [], [3], true)).toBe(30);
  });

  // My 1 2 (+3); its 3 (12) beside my 2, in no bonus; its 4 behind; the fog holds a possible +10 (5 6)
  // and a dozen more territories in no bonus, which per-territory income would pay for.
  const extra = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
  const g3 = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6, ...extra],
      [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [4, 7], ...extra.slice(1).map((t) => [t - 1, t] as [number, number])],
      [[101, 3, [1, 2]], [102, 10, [5, 6]]],
    ),
  );
  const b3 = board([mine(1, 1), mine(2, 16), foe(3, 12), foe(4, 1), fogged(5), fogged(6), ...extra.map((t) => fogged(t))]);
  const input = (settings: PlannerSettings): PlanInput => ({
    graph: g3,
    board: b3,
    me: ME,
    income: 30,
    settings,
    turn: 10,
    game: { players: [{ id: ME }, { id: FOE }], turn: 10, symmetricStart: true },
    options: { goal: 'defend' },
  });

  it('the planner: the gate faces the free income alone, and with per-territory income the slack and a warning', () => {
    // 11 movable + 5 free = 16: the 16 on T2 hold.
    expect(text(planTurn(input(LD)))).not.toMatch(/T2 \(#2\) \(16 armies\) could be taken/);
    expect(text(planTurn(input(LD)))).not.toMatch(/per-territory income/);
    // With per-territory income (1 per territory): the prior of 26 holds 11 beyond the free 5 and the
    // +10, which may land anywhere: 11 movable + 16 take the 16.
    const per = planTurn(input({ ...LD, bonusArmyPer: 1 }));
    expect(text(per)).toMatch(/T2 \(#2\) \(16 armies\) could be taken next turn: player 20 has 11 movable armies next to it plus ~16 deploy/);
    expect(per.warnings.join('\n')).toMatch(
      /Local Deployment with per-territory income: player 20's estimate of ~26 is more than its free income \+5 and the \+10 of bonuses it could hold, so the 11 beyond them/,
    );
  });

  it('check_plan tries the same bound', () => {
    const stress = (perTerritoryIncome: boolean) =>
      stressPlan({
        graph: g3,
        board: b3,
        me: ME,
        deploys: [],
        moves: [],
        opponents: [{ id: FOE, deploy: 30, base: 5 }],
        settings: STD,
        firstMover: 'opponent',
        localDeployments: true,
        ...(perTerritoryIncome ? { perTerritoryIncome: true } : {}),
      });
    expect(stress(false).safe).toBe(true);
    expect(stress(true).safe).toBe(false);
  });
});

describe('(4) the coverage note names the planner\'s floor only when the planner uses the track (#294 review)', () => {
  // Its T5 grows +15 a turn beside the fogged +30 (20–22): a quarter of its frontier in view.
  const low = buildGraph(
    makeMap([1, 2, 4, 5, 20, 21, 22], [[1, 2], [2, 4], [4, 5], [5, 20], [5, 21], [5, 22], [20, 21], [21, 22]], [[900, 30, [20, 21, 22]]]),
  );
  const at = (a5: number): BoardState => board([mine(1, 40), mine(2, 3), mine(4, 40), foe(5, a5), fogged(20), fogged(21), fogged(22)]);
  const S: PlannerSettings = { ...STD, baseIncome: 10 };

  it('one observed turn: a lower bound, no floor promised', () => {
    const [t] = trackOpponents(low, [10, 25].map((a5, i) => ({ turn: i + 1, board: at(a5) })), ME, S);
    expect(t!.turns).toHaveLength(1);
    const note = t!.notes.join('\n');
    expect(note).toMatch(/Income read from 1 of ~4 frontier territories/);
    expect(note).not.toMatch(/the planner sizes it toward the midpoint/);
  });

  it('two observed turns: the midpoint is named (#368, in place of #294\'s floor)', () => {
    const [t] = trackOpponents(low, [10, 25, 40].map((a5, i) => ({ turn: i + 1, board: at(a5) })), ME, S);
    expect(t!.notes.join('\n')).toMatch(/the planner sizes it toward the midpoint between it and the most it could have \(#368\)/);
  });
});
