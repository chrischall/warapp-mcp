import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import {
  atWarWith,
  COALITION_GRACE_TURNS,
  coalitionAdvice,
  leaderBonuses,
  OUTREACH_DRAFTS,
  surrenderStreak,
  type CoalitionInput,
} from '../../src/analysis/coalition.js';
import { gameOutlook, SURRENDER_TURNS } from '../../src/analysis/outlook.js';
import type { TurnBoard } from '../../src/analysis/opponents.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

// #445 (owner answers of 2026-11-23): once the #436 surrender line is crossed in a free-for-all with three or more
// players still playing, "try a coalition first" replaces "surrender" for 2 turns while the trailing players
// out-earn the leader (now, or after it loses a breakable bonus) and its lead over me is not growing. Every viable
// partner (borders the leader, not at war with me, not ruled out by the record) is ranked; the top 2 get a #415
// `propose` draft naming the leader's bonus we could break together. Never sent.

const ME = 1;
const LEADER = 2;

/** Me 12, the leader 30, three trailing players bordering it. */
const opponents = [
  { playerId: LEADER, low: 30, estimate: 30, calibrated: true },
  { playerId: 3, low: 9, estimate: 9, calibrated: true },
  { playerId: 4, low: 8, estimate: 8, calibrated: false },
  { playerId: 5, low: 6, estimate: 6, calibrated: true },
];
const leaderBonus = { bonus: 7, value: 5, by: [{ playerId: 4, target: 40, defenders: 3, armiesBeside: 12 }, { playerId: ME, target: 40, defenders: 3, armiesBeside: 6 }] };
const base = (over: Partial<CoalitionInput> = {}): CoalitionInput => ({
  me: ME,
  myIncome: 12,
  leader: { playerId: LEADER, estimate: 30 },
  opponents,
  playersLeft: 5,
  bordersLeader: new Set([3, 4, 5]),
  bonuses: [leaderBonus],
  turnsBelow: SURRENDER_TURNS,
  turn: 9,
  gameId: 777,
  ...over,
});

describe('coalitionAdvice (#445)', () => {
  it('advises a coalition with the partners ranked and drafts for the top two, naming the bonus to break', () => {
    const r = coalitionAdvice(base())!;
    expect(r.viable).toBe(true);
    expect(r.viableBy).toBe('now');
    expect(r.inForce).toBe(true);
    expect(r.trailingIncome).toBe(12 + 9 + 8 + 6);
    // Player 4 borders the leader's bonus 7: first; then by income.
    expect(r.partners.map((p) => p.playerId)).toEqual([4, 3, 5]);
    expect(r.partners[0]!.jointBreak).toEqual({ bonus: 7, value: 5, target: 40, defenders: 3, theirArmiesBeside: 12, myArmiesBeside: 6 });
    expect(r.outreach).toEqual([4, 3]);
    expect(r.drafts).toHaveLength(OUTREACH_DRAFTS);
    const d = r.drafts[0]!;
    expect(d).toMatchObject({ to: 4, stance: 'propose', priceWith: 'warapp_advise_diplomacy', automation: 'off' });
    expect(d.draft).toMatch(/\[\[b:7\]\] is worth \+5 a turn/);
    expect(d.draft).toMatch(/\[\[t:40\]\]/);
    expect(d.draft).not.toMatch(/~|12/); // my income is never shared
    expect(d.send).toBeUndefined();
    expect(d.reasons.join(' ')).toMatch(/WARAPP_CHAT_AUTOMATION is off/);
    expect(r.drafts[1]!.draft).not.toMatch(/\[\[b:/);
    expect(r.advice).toMatch(/^Try a coalition first \(attempt turn 1 of 2/);
    expect(r.graceTurns).toBe(COALITION_GRACE_TURNS);
  });

  it('offers send (still confirm-gated) only with the automation gate on', () => {
    const r = coalitionAdvice(base({ automation: 'on' }))!;
    expect(r.drafts[0]!.send).toEqual({ game_id: 777, message: r.drafts[0]!.draft, to: 4, automated: true });
  });

  it('leaves out a partner at war with me, one the record rules out, and one not bordering the leader', () => {
    const r = coalitionAdvice(base({ atWar: new Set([4]), breakers: new Set([3]), bordersLeader: new Set([3, 4]) }))!;
    expect(r.partners).toEqual([]);
    expect(r.leftOut).toEqual([
      { playerId: 3, reason: 'broke-a-truce' },
      { playerId: 4, reason: 'at-war' },
      { playerId: 5, reason: 'not-bordering-leader' },
    ]);
    expect(r.viable).toBe(false);
    expect(r.inForce).toBe(false);
    expect(r.drafts).toEqual([]);
    expect(r.advice).toMatch(/surrender advice stands/);
  });

  it('is viable after a break when the trailing players out-earn only the leader without its bonus', () => {
    // 12 + 8 = 20 against 24: not now; against 24 - 5 = 19 once bonus 7 breaks: yes.
    const r = coalitionAdvice(base({ leader: { playerId: LEADER, estimate: 24 }, bordersLeader: new Set([4]) }))!;
    expect(r.viableBy).toBe('after-break');
    expect(r.afterBreak).toEqual({ bonus: 7, value: 5, leaderIncome: 19 });
    expect(r.inForce).toBe(true);
    expect(r.advice).toMatch(/once bonus 7 \(\+5\) breaks/);
  });

  it('keeps the surrender advice when the trailing players cannot out-earn the leader even after a break', () => {
    const r = coalitionAdvice(base({ leader: { playerId: LEADER, estimate: 40 }, bordersLeader: new Set([4]) }))!;
    expect(r.viable).toBe(false);
    expect(r.inForce).toBe(false);
    expect(r.advice).toMatch(/No coalition looks viable.*still not enough once bonus 7.*surrender advice stands/);
  });

  it('gives the attempt two turns: on the third turn after crossing the surrender advice returns', () => {
    const second = coalitionAdvice(base({ turnsBelow: SURRENDER_TURNS + 1, leads: new Map([[8, 18], [9, 18]]) }))!;
    expect(second.graceTurn).toBe(2);
    expect(second.inForce).toBe(true);
    const third = coalitionAdvice(base({ turnsBelow: SURRENDER_TURNS + 2, leads: new Map([[7, 18], [8, 18], [9, 18]]) }))!;
    expect(third.graceTurn).toBe(3);
    expect(third.inForce).toBe(false);
    expect(third.drafts).toEqual([]);
    expect(third.advice).toMatch(/had its 2 turns.*surrender advice stands/);
  });

  it('returns the surrender advice early when the leader\'s lead grows inside the window', () => {
    // Crossed on turn 8 with a lead of 15; now 30 - 12 = 18.
    const r = coalitionAdvice(base({ turnsBelow: SURRENDER_TURNS + 1, leads: new Map([[8, 15], [9, 18]]) }))!;
    expect(r.lead).toEqual({ atCrossing: 15, now: 18, growing: true });
    expect(r.inForce).toBe(false);
    expect(r.advice).toMatch(/lead over me grew from ~15 to ~18/);
  });

  it('is null with two players left, or when I lead', () => {
    expect(coalitionAdvice(base({ playersLeft: 2 }))).toBeNull();
    expect(coalitionAdvice(base({ leader: { playerId: ME, estimate: 30 } }))).toBeNull();
  });
});

describe('surrenderStreak and atWarWith (#445)', () => {
  it('counts the logged turns under the line, against the strongest anywhere when logged', () => {
    const turns = {
      '5': { income: { mine: 12, low: 14, estimate: 14 } },
      '6': { income: { mine: 10, low: 20, estimate: 20 } },
      '7': { income: { mine: 10, low: 9, estimate: 12 }, surrender: { low: 25, estimate: 25 } },
      '8': { income: { mine: 10, low: 20, estimate: 22 } },
    };
    const s = surrenderStreak(turns, 8);
    expect(s.turns).toBe(3);
    expect([...s.leads]).toEqual([[8, 12], [7, 15], [6, 10]]);
    expect(surrenderStreak(turns, 9).turns).toBe(0);
  });

  it('reads a broken truce or a declared attack since the latest agreement as war', () => {
    const ledger = {
      agreements: [
        { with: 3, status: 'broken-by-them', createdTurn: 2 },
        { with: 4, status: 'agreed', createdTurn: 5 },
        { with: 5, status: 'agreed', createdTurn: 1 },
      ],
      commitments: [
        { kind: 'will-attack', with: 4, sentTurn: 3 },
        { kind: 'will-attack', with: 5, sentTurn: 4 },
      ],
    };
    expect([...atWarWith(ledger, [3, 4, 5, 6])].sort()).toEqual([3, 5]);
    expect(atWarWith(undefined, [3]).size).toBe(0);
  });
});

describe('leaderBonuses (#445)', () => {
  // T1–T6 in a line: bonus 1 = T4–T5 (+4) held by the leader; T3 is player 3's, T6 player 4's, T1–T2 mine.
  const map: GameMap = {
    id: 1,
    name: 'Line',
    territories: [1, 2, 3, 4, 5, 6].map((id) => ({ id, name: `T${id}`, connectedTo: [id - 1, id + 1].filter((x) => x >= 1 && x <= 6) })),
    bonuses: [{ id: 1, name: 'Ridge', value: 4, territoryIds: [4, 5], bonusIds: [] }],
    distributionModes: [],
  };
  const p = (territoryId: number, playerId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId }, armies });

  it('lists the bonuses the leader holds in full and each player beside one, at its weakest bordered member', () => {
    const g = buildGraph(map);
    const b = board([mine(1, 5, ME), mine(2, 5, ME), p(3, 3, 7), p(4, LEADER, 2), p(5, LEADER, 9), p(6, 4, 11)]);
    expect(leaderBonuses(g, b, LEADER, new Set([ME, 3, 4]))).toEqual([
      { bonus: 1, value: 4, by: [{ playerId: 3, target: 4, defenders: 2, armiesBeside: 7 }, { playerId: 4, target: 5, defenders: 9, armiesBeside: 11 }] },
    ]);
    // A member not visibly the leader's: not held in full.
    expect(leaderBonuses(g, board([mine(1, 5, ME), p(3, 3, 7), p(4, LEADER, 2), neutral(5, 2)]), LEADER, new Set([3]))).toEqual([]);
  });
});

describe('the surrender line carries every opponent\'s estimate once crossed (#445)', () => {
  it('lists each opponent in a free-for-all, and nothing before the line is crossed', () => {
    const map: GameMap = {
      id: 1,
      name: 'Line',
      territories: [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, name: `T${id}`, connectedTo: [id - 1, id + 1].filter((x) => x >= 1 && x <= 8) })),
      bonuses: [{ id: 2, name: 'East', value: 5, territoryIds: [6, 7, 8], bonusIds: [] }],
      distributionModes: [],
    };
    const p = (territoryId: number, playerId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId }, armies });
    const b = () => board([mine(1, 10, ME), neutral(2, 2), neutral(3, 2), p(4, 3, 5), neutral(5, 2), p(6, LEADER, 10), p(7, LEADER, 10), p(8, LEADER, 10)]);
    const game = { players: [{ id: ME }, { id: LEADER }, { id: 3 }] };
    const boards = (n: number): TurnBoard[] => Array.from({ length: n }, (_, i) => ({ turn: 4 + i, board: b() }));
    const o = gameOutlook({ graph: buildGraph(map), me: ME, boards: boards(3), game });
    expect(o.surrenderLine?.crossed).toBe(true);
    expect(o.surrenderLine?.opponents?.map((x) => x.playerId)).toEqual([LEADER, 3]);
    expect(o.surrenderLine?.opponents?.find((x) => x.playerId === LEADER)?.estimate).toBe(o.surrenderLine?.theirIncome);
    const early = gameOutlook({ graph: buildGraph(map), me: ME, boards: boards(2), game });
    expect(early.surrenderLine?.crossed).toBe(false);
    expect(early.surrenderLine?.opponents).toBeUndefined();
  });
});
