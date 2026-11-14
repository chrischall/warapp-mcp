// #215 (item 2): a hold sized only for my moving first. The armies a conceded border withdraws into
// a neighbour land by my own order; when the opponent moves first, its first order — an all-in on
// that neighbour — runs before any of mine. The leftover counted the withdrawal as part of the hold,
// so a border with ~33 against it was left on what only held once the withdrawal arrived, and
// `warapp_check_plan` showed it falling when the opponent moved first. Unless I am known to move
// first (#127), a hold is now sized for the worse order when the leftover can afford it, and the
// plan says plainly when it cannot. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { stressPlan } from '../../src/analysis/stress.js';
import type { GameMap } from '../../src/normalize.js';
import { board as boardOf } from './helpers.js';

const ME = 10;
const FOE = 20;
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
const at = (territoryId: number, armies: number, who: number | 'neutral'): TerritoryState =>
  who === 'neutral'
    ? { territoryId, owner: { kind: 'neutral' }, armies }
    : { territoryId, owner: { kind: 'player', playerId: who }, armies };

// My T1 (27 armies, in no bonus) faces player 20's 60-stack on T2: hopeless, conceded, it withdraws
// to my T3. T3 (10 armies) faces player 20's 28-stack on T6 (~33 with its deploy) and takes the
// neutral T4 this turn, completing B1 (+1, too little to garrison), so T3 is kept for it (rule 1c).
// T7 (10) breaks player 20's B4 through T10 and is the stack the leftover expansion goes to.
const map = makeMap(
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  [
    [1, 2],
    [1, 3],
    [3, 6],
    [3, 4],
    [4, 5],
    [5, 7],
    [6, 8],
    [2, 8],
    [7, 9],
    [6, 9],
    [7, 10],
    [10, 11],
    [11, 8],
  ],
  [
    [1, 1, [3, 4]],
    [2, 3, [5, 7]],
    [3, 5, [2, 8]],
    [4, 4, [10, 11]],
  ],
);
const g = buildGraph(map);
const field = (o: { y?: number; e?: number; w?: number; t9?: number } = {}): BoardState =>
  boardOf([
    at(1, o.w ?? 27, ME),
    at(2, 60, FOE),
    at(3, o.y ?? 10, ME),
    at(4, 1, 'neutral'),
    at(5, 6, ME),
    at(6, o.e ?? 28, FOE),
    at(7, 10, ME),
    at(8, 4, FOE),
    at(9, o.t9 ?? 3, ME),
    at(10, 2, FOE),
    at(11, 2, FOE),
  ]);
type Shape = { income?: number; movesFirst?: boolean; unverified?: boolean; y?: number; e?: number; w?: number; t9?: number };
const input = (o: Shape = {}): PlanInput => ({
  graph: g,
  board: field(o),
  me: ME,
  income: o.income ?? 30,
  settings: RATES,
  game: { players: [{ id: ME }, { id: FOE }], turn: 10 },
  options: {
    enemyDeploy: 5,
    ...(o.movesFirst !== undefined ? { movesFirst: o.movesFirst } : {}),
    ...(o.unverified ? { movesFirstUnverified: true } : {}),
  },
});
const deployedOn = (p: TurnPlan, id: number) => p.deploys.filter((d) => d.territoryId === id).reduce((n, d) => n + d.armies, 0);
const withdrawal = (p: TurnPlan) => p.moves.find((m) => m.kind === 'transfer' && m.from === 1 && m.to === 3);
/** What player 20's single replies take of mine when it moves first (`warapp_check_plan`'s test). */
const lostIfOpponentFirst = (p: TurnPlan, o: Shape = {}, firstMover: 'opponent' | 'me' = 'opponent') =>
  stressPlan({
    graph: g,
    board: field(o),
    me: ME,
    deploys: p.deploys,
    moves: p.moves,
    opponents: [{ id: FOE, deploy: 5 }],
    settings: RATES,
    firstMover,
    lookAhead: false,
  }).replies.flatMap((r) => r.lost);

describe('#215: a hold is sized for the worse move order when the first mover is unknown', () => {
  it('deploys on a border what holds it without the armies withdrawn into it', () => {
    const p = planTurn(input());
    // T1 withdraws 26 to T3, which attacks T4 with 2: 8 of its own stay, plus the 26 arriving.
    expect(withdrawal(p)?.armies).toBe(26);
    // Without the withdrawal T3 needs 13 more to hold the ~33 (21 need 35 to take).
    expect(deployedOn(p, 3)).toBe(13);
    expect(p.rationale.join('\n')).toMatch(
      /Deploy 13 to T3 \(#3\) so it holds whoever moves first \(protects \+1\): the 26 withdrawn into it land after player 20's attack if it moves first, and without them its 21 need 35 to take, above the ~33 threat\./,
    );
    // The rest of the leftover still goes to the expansion stack.
    expect(deployedOn(p, 7)).toBe(17);
    expect(p.warnings.join('\n')).not.toMatch(/holds only if I move first/);
  });

  it('holds T3 when player 20 moves first, which the plan sized for my moving first did not', () => {
    expect(lostIfOpponentFirst(planTurn(input()))).not.toContain(3);
  });

  it('sizes it the same when player 20 is known to move first', () => {
    const p = planTurn(input({ movesFirst: false }));
    expect(deployedOn(p, 3)).toBe(13);
    expect(p.rationale.join('\n')).toMatch(/so it holds whoever moves first/);
  });

  it('keeps the known-first-mover plan (#127): moving first, the withdrawal lands in time', () => {
    const p = planTurn(input({ movesFirst: true }));
    expect(withdrawal(p)?.armies).toBe(26);
    expect(deployedOn(p, 3)).toBe(0);
    expect(deployedOn(p, 7)).toBe(30);
    expect(p.rationale.join('\n')).not.toMatch(/whoever moves first/);
    expect(p.warnings.join('\n')).not.toMatch(/only if I move first/);
  });

  it('treats a first move only the award of picks says (unverified) as unknown for the hold (#215 review)', () => {
    const p = planTurn(input({ movesFirst: true, unverified: true }));
    expect(deployedOn(p, 3)).toBe(13);
    expect(p.rationale.join('\n')).toMatch(/so it holds whoever moves first/);
    expect(lostIfOpponentFirst(p)).not.toContain(3);
  });

  it('says so when the hold depends on a first move the award says I have, unverified', () => {
    const p = planTurn(input({ income: 12, movesFirst: true, unverified: true }));
    expect(p.warnings.join('\n')).toMatch(
      /T3 \(#3\) holds only if I move first: 26 of its armies are withdrawn into it this turn, and if player 20 moves first its attack \(~33\) lands before them \(the award of picks says I move first: the wiki's rule, not verified live\)\./,
    );
  });

  it('says plainly that the hold depends on moving first when the leftover cannot afford it', () => {
    // 12 income: the hold of T7's attack and the capture leave too little for the 13.
    const p = planTurn(input({ income: 12 }));
    expect(deployedOn(p, 3)).toBe(0);
    expect(p.warnings).toContain(
      "T3 (#3) holds only if I move first: 26 of its armies are withdrawn into it this turn, and if player 20 moves first its attack (~33) lands before them. Its own 8 need 13 to take; 13 more deployed there would hold it whoever moves first, more than the plan had left to deploy there.",
    );
  });

  it('names the known order in that warning when player 20 moves first', () => {
    const p = planTurn(input({ income: 12, movesFirst: false }));
    expect(p.warnings.join('\n')).toMatch(/T3 \(#3\) holds only if I move first: 26 of its armies are withdrawn into it this turn, and player 20 moves first, so its attack \(~33\) lands before them\./);
  });

  it('says why no deploy was made when No-Split sends the border\'s stack with its order (#215 review)', () => {
    // Under No-Split T3's attack on T4 carries its whole stack, deploys included: a deploy there
    // holds nothing, so "more than the plan had left to deploy there" would misstate why.
    const i = input();
    i.settings = { ...RATES, noSplit: true };
    const p = planTurn(i);
    const w = p.warnings.find((l) => l.startsWith('T3 (#3) holds only if I move first')) ?? '';
    expect(w).toMatch(/No-Split sends every army of its own with its order, deploys included, so no deploy there holds it whoever moves first\.$/);
    expect(w).not.toMatch(/more than the plan had left/);
  });

  it('leaves a border alone that holds on its own whoever moves first', () => {
    // A 12-stack (~17): T3's own 8 already need 13 to take it.
    const p = planTurn(input({ e: 8 }));
    expect(p.rationale.join('\n')).not.toMatch(/whoever moves first/);
    expect(p.warnings.join('\n')).not.toMatch(/only if I move first/);
  });
});

describe('#215 review: the worse-order hold does not stop a conceded border being held after all (#121)', () => {
  // Nearby: T1 10 (still hopeless against the 60), T3 4, player 20's T6 12 (~17 with its deploy).
  // T9 (3, in no bonus) is conceded at triage and withdraws 2 into T7. The leftover first sizes T3
  // for the worse order (7, without the 9 withdrawn into it). Before that deploy T3 was short of its
  // comfortable margin, so the leftover still buys comfort, and #121 holds T9 after all
  // (8) before the rest goes to the expansion stack (T3, 20 armies with the 9 withdrawn, already has
  // its comfortable margin in the order where they land in time).
  const near: Shape = { income: 40, w: 10, y: 4, e: 12 };
  it('holds T9 after all before the rest goes to the expansion stack', () => {
    const p = planTurn(input(near));
    expect(p.rationale.join('\n')).toMatch(/Deploy 7 to T3 \(#3\) so it holds whoever moves first/);
    expect(p.rationale.join('\n')).toMatch(/Hold T9 \(#9\) after all \(not conceded\): deploy 8 there, and keep the 2 that would have withdrawn/);
    expect(deployedOn(p, 9)).toBe(8);
    expect(p.moves.some((m) => m.from === 9)).toBe(false);
    expect(deployedOn(p, 3)).toBe(7);
    expect(deployedOn(p, 7)).toBe(25);
  });

  it('loses nothing of T3 and T9 whoever moves first', () => {
    const p = planTurn(input(near));
    for (const who of ['opponent', 'me'] as const) {
      const lost = lostIfOpponentFirst(p, near, who);
      expect(lost).not.toContain(3);
      expect(lost).not.toContain(9);
    }
  });
});

describe('#215: what a border spares beyond its hold leaves the armies withdrawn into it out', () => {
  // My T1 (19) faces player 20's T2, T3 and T4 and receives 2 withdrawn from conceded T6; T5 (11)
  // beside it. Nothing passes the economy test, so rule 4e's fallback takes T3 after the withdrawal.
  const small = makeMap(
    [1, 2, 3, 4, 5, 6, 7],
    [
      [1, 2],
      [1, 3],
      [1, 4],
      [1, 5],
      [1, 6],
      [1, 7],
      [2, 4],
      [3, 4],
      [3, 5],
      [3, 6],
      [4, 5],
      [5, 7],
    ],
    [],
  );
  const smallInput = (movesFirst?: boolean): PlanInput => ({
    graph: buildGraph(small),
    board: boardOf([
      at(1, 19, ME),
      at(2, 9, FOE),
      at(3, 5, FOE),
      at(4, 9, FOE),
      at(5, 11, ME),
      at(6, 3, ME),
      { territoryId: 7, owner: { kind: 'unknown' }, armies: null },
    ]),
    me: ME,
    income: 3,
    settings: { offensiveKillRate: 29, defensiveKillRate: 17 },
    options: { goal: 'balanced', ...(movesFirst !== undefined ? { movesFirst } : {}) },
  });
  const line = (p: TurnPlan) => p.rationale.find((l) => l.startsWith('Other candidates not taken')) ?? '';

  it('keeps on the source what holds it without them, unless I am known to move first', () => {
    const p = planTurn(smallInput());
    expect(p.moves.find((m) => m.kind === 'transfer' && m.from === 6 && m.to === 1)?.armies).toBe(2);
    // 13 of T1's 19 may leave: its hold is kept without the 2 arriving.
    expect(line(p)).toMatch(/13 movable on T1 \(#1\)/);
    expect(p.moves.some((m) => m.kind === 'attack' && m.from === 1 && m.to === 3 && m.armies === 16)).toBe(false);
    // Moving first, the 2 land before player 20's first attack and count, as before.
    const first = planTurn(smallInput(true));
    expect(line(first)).toMatch(/15 movable on T1 \(#1\)/);
    expect(first.moves.some((m) => m.kind === 'attack' && m.from === 1 && m.to === 3 && m.armies === 16)).toBe(true);
  });
});
