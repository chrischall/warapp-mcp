// #298, the second half: a contested bonus whose completion I attempted and failed on two consecutive
// turns is pushed all-in once (every missing member, each sized for its owner's deploy, the push within
// two turns of its value and my income) or dropped as a target for three turns; an all-in that fails is
// dropped the same way. Synthetic maps only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput } from '../../src/analysis/planner.js';
import {
  bonusVerdicts,
  DROP_TURNS,
  judgeAttempts,
  rememberBonusAttempts,
  type BonusAttemptMemory,
} from '../../src/analysis/plan/bonus-attempts.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine } from './helpers.js';

const ME = 10;
const P2 = 30;
const P3 = 40;
const RATES = { offensiveKillRate: 60, defensiveKillRate: 70 };
const FEN = 301;

const player = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

//   Fen (+6: 3, 4, 5): I hold 4 and 5, player 30 holds 3 (and 8 behind it). My 2 borders 3 too; my 1
//   faces player 40's 14-stack on 6.
const edges: [number, number][] = [[1, 2], [2, 3], [3, 4], [4, 5], [1, 6], [6, 7], [3, 8], [9, 7]];
const map: GameMap = {
  id: 1,
  name: 'Attempts',
  territories: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
  })),
  bonuses: [{ id: FEN, name: 'Fen', value: 6, territoryIds: [3, 4, 5], bonusIds: [] }],
  distributionModes: [],
};
const g = buildGraph(map);
const at = (c: number, owner3 = P2): BoardState =>
  board([
    mine(1, 8),
    mine(2, 4),
    player(3, c, owner3),
    mine(4, 3),
    mine(5, 2),
    player(6, 14, P3),
    player(7, 3, P3),
    player(8, 3, P2),
    player(9, 4, P3),
  ]);
const input = (b: BoardState, bonusAttempts?: BonusAttemptMemory): PlanInput => ({
  graph: g,
  board: b,
  me: ME,
  income: 12,
  settings: { ...RATES, oneArmyStandsGuard: true },
  game: { players: [ME, P2, P3, 50].map((id) => ({ id })), turn: 18 },
  turn: 18,
  ...(bonusAttempts ? { bonusAttempts } : {}),
  options: { goal: 'balanced', minWinChance: 1 },
});
const attacksOn = (p: ReturnType<typeof planTurn>, t: number) => p.moves.filter((m) => m.kind === 'attack' && m.to === t);
const sent = (p: ReturnType<typeof planTurn>, t: number) => attacksOn(p, t).reduce((n, m) => n + m.armies, 0);

/** Fen attempted on turns 16 and 17, both judged failed. */
const TWICE: BonusAttemptMemory = {
  bonuses: [{ bonusId: FEN, attempts: [{ turn: 16, allIn: false, failed: true }, { turn: 17, allIn: false }] }],
};

describe('#298: the attempt memory', () => {
  it('judges last turn’s attempt on this board: failed when the bonus is not all mine', () => {
    expect(judgeAttempts(TWICE, 18, g, at(1), ME).bonuses[0]!.attempts[1]).toEqual({ turn: 17, allIn: false, failed: true });
    const done = board([...at(1).territories.filter((t) => t.territoryId !== 3), mine(3, 2)]);
    expect(judgeAttempts(TWICE, 18, g, done, ME).bonuses[0]!.attempts[1]).toEqual({ turn: 17, allIn: false, failed: false });
  });

  it('two failed attempts on consecutive turns call for the all-in; one, or a gap, does not', () => {
    const judged = judgeAttempts(TWICE, 18, g, at(1), ME);
    expect(bonusVerdicts(judged, 18)).toEqual([{ bonusId: FEN, kind: 'all-in', failedTurns: [16, 17] }]);
    const one: BonusAttemptMemory = { bonuses: [{ bonusId: FEN, attempts: [{ turn: 17, allIn: false, failed: true }] }] };
    expect(bonusVerdicts(one, 18)).toEqual([]);
    const gap: BonusAttemptMemory = {
      bonuses: [{ bonusId: FEN, attempts: [{ turn: 15, allIn: false, failed: true }, { turn: 17, allIn: false, failed: true }] }],
    };
    expect(bonusVerdicts(gap, 18)).toEqual([]);
  });

  it('a failed all-in drops it for three turns; a drop made earlier keeps running', () => {
    const allIn: BonusAttemptMemory = {
      bonuses: [{ bonusId: FEN, attempts: [{ turn: 15, allIn: false, failed: true }, { turn: 16, allIn: false, failed: true }, { turn: 17, allIn: true, failed: true }] }],
    };
    expect(bonusVerdicts(allIn, 18)).toEqual([
      { bonusId: FEN, kind: 'dropped', why: 'all-in-failed', from: 18, until: 18 + DROP_TURNS - 1, failedTurns: [15, 16, 17] },
    ]);
    const dropped: BonusAttemptMemory = { bonuses: [{ bonusId: FEN, attempts: [], drop: { from: 17, until: 19 } }] };
    expect(bonusVerdicts(dropped, 19)).toEqual([{ bonusId: FEN, kind: 'dropped', why: 'still-dropped', from: 17, until: 19, failedTurns: [] }]);
    expect(bonusVerdicts(dropped, 20)).toEqual([]);
    // A drop this very turn's earlier plan made is decided again.
    expect(bonusVerdicts(dropped, 17)).toEqual([]);
  });

  it('remembers this turn’s expected completions of contested bonuses, and the drops', () => {
    expect(rememberBonusAttempts(undefined, 18, g, at(1), ME, [FEN]).bonuses).toEqual([{ bonusId: FEN, attempts: [{ turn: 18, allIn: false }] }]);
    expect(
      rememberBonusAttempts(undefined, 18, g, at(1), ME, [FEN], [{ bonusId: FEN, kind: 'all-in', failedTurns: [16, 17], cost: 10, cap: 12 }]).bonuses,
    ).toEqual([{ bonusId: FEN, attempts: [{ turn: 18, allIn: true }] }]);
    // A neutral member is no contest.
    const neutral3 = board([...at(1).territories.filter((t) => t.territoryId !== 3), { territoryId: 3, owner: { kind: 'neutral' }, armies: 2 }]);
    expect(rememberBonusAttempts(undefined, 18, g, neutral3, ME, [FEN]).bonuses).toEqual([]);
    // A plan that does not expect to complete it (an advance, or no attack) is no attempt.
    expect(rememberBonusAttempts(undefined, 18, g, at(1), ME, []).bonuses).toEqual([]);
    // Last turn's attempt judged, this turn's replaced, older than six turns forgotten, the drop kept.
    const kept = rememberBonusAttempts(
      { bonuses: [{ bonusId: FEN, attempts: [{ turn: 11, allIn: false, failed: true }, { turn: 17, allIn: false }, { turn: 18, allIn: true }] }] },
      18,
      g,
      at(1),
      ME,
      [],
      [{ bonusId: FEN, kind: 'dropped', why: 'no-all-in', from: 18, until: 20, failedTurns: [16, 17] }],
    );
    expect(kept.bonuses).toEqual([{ bonusId: FEN, attempts: [{ turn: 17, allIn: false, failed: true }], drop: { from: 18, until: 20 } }]);
  });
});

describe('#298: the planner pushes all-in once, or drops the bonus', () => {
  it('without the memory, the piecemeal attack on 3 is sized for the defenders there now', () => {
    const p = planTurn(input(at(3)));
    expect(sent(p, 3)).toBeGreaterThan(0);
    expect(sent(p, 3)).toBeLessThan(armiesToTake(3 + 5, RATES)!);
    expect(p.bonusPush).toBeUndefined();
  });

  it('one failed attempt changes nothing', () => {
    const one: BonusAttemptMemory = { bonuses: [{ bonusId: FEN, attempts: [{ turn: 17, allIn: false }] }] };
    expect(planTurn(input(at(3), one))).toEqual(planTurn(input(at(3))));
  });

  it('two failed attempts, and a push within the cap completes it: all-in, sized for its owner’s deploy', () => {
    // 1 defender + player 30's ~5 deploy: 10 armies, within min(2 × 6, my income 12).
    const p = planTurn(input(at(1), TWICE));
    expect(sent(p, 3)).toBeGreaterThanOrEqual(armiesToTake(1 + 5, RATES)!);
    expect(p.expected.captures).toContain(3);
    expect(p.expected.bonusesCompleted).toContain(FEN);
    expect(p.bonusPush).toEqual([{ bonusId: FEN, kind: 'all-in', failedTurns: [16, 17], cost: armiesToTake(6, RATES)!, cap: 12 }]);
    expect(p.rationale.join('\n')).toMatch(/Bonus Fen \(#301\): my attempts to complete it failed on turns 16 and 17: all-in this turn/);
  });

  it('two failed attempts and no push within the cap: dropped for three turns, nothing sent into it', () => {
    // 3 defenders + ~5: 13 armies, over 2 × 6 = 12.
    expect(armiesToTake(3 + 5, RATES)).toBe(13);
    const p = planTurn(input(at(3), TWICE));
    expect(attacksOn(p, 3)).toEqual([]);
    expect(p.bonusPush).toEqual([
      { bonusId: FEN, kind: 'dropped', why: 'no-all-in', from: 18, until: 20, failedTurns: [16, 17], detail: expect.stringMatching(/the push needs 13 armies, over the cap of 12/) },
    ]);
    expect(p.rationale.join('\n')).toMatch(/Bonus Fen \(#301\) is dropped as a target on turns 18 to 20 \(#298\)/);
  });

  it('#406: two failed attempts but no missing member held by another player any more: no all-in and no drop', () => {
    // Player 30 lost 3 to the neutral: Fen is no longer contested, so it is planned as any other bonus.
    const neutral3 = board([mine(1, 8), mine(2, 4), { territoryId: 3, owner: { kind: 'neutral' }, armies: 2 }, mine(4, 3), mine(5, 2), player(6, 14, P3), player(7, 3, P3), player(8, 3, P2), player(9, 4, P3)]);
    const p = planTurn(input(neutral3, TWICE));
    expect(p.bonusPush ?? []).toEqual([]);
  });

  it('a drop still running, and an all-in that failed, leave it unfunded', () => {
    const running: BonusAttemptMemory = { bonuses: [{ bonusId: FEN, attempts: [], drop: { from: 17, until: 19 } }] };
    const p = planTurn(input(at(3), running));
    expect(attacksOn(p, 3)).toEqual([]);
    expect(p.bonusPush).toEqual([{ bonusId: FEN, kind: 'dropped', why: 'still-dropped', from: 17, until: 19, failedTurns: [] }]);
    const failedAllIn: BonusAttemptMemory = {
      bonuses: [{ bonusId: FEN, attempts: [{ turn: 16, allIn: false, failed: true }, { turn: 17, allIn: true }] }],
    };
    const q = planTurn(input(at(1), failedAllIn));
    expect(attacksOn(q, 3)).toEqual([]);
    expect(q.bonusPush?.[0]).toMatchObject({ kind: 'dropped', why: 'all-in-failed', from: 18, until: 20 });
  });
});
