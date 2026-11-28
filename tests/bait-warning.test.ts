// #593 5c: the submit preview's warning for an attack on a player's territory that its stacks
// beside the target can reinforce before the attack lands (the bait). Synthetic map only.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/analysis/graph.js';
import type { LiveTerritory } from '../src/live.js';
import type { GameMap } from '../src/normalize.js';
import { baitAttackWarning } from '../src/tools/bait.js';

const ME = 1;
const FOE = 2;
const STD = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

/** 1 ─ 2 ─ 3, and 4 beside 2: 1 is mine, 2 its 1-army territory, 3 and 4 its stacks. */
const MAP: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: [
    { id: 1, name: 'Hong Kong', connectedTo: [2] },
    { id: 2, name: 'Tibet', connectedTo: [1, 3, 4] },
    { id: 3, name: 'India', connectedTo: [2] },
    { id: 4, name: 'Nepal', connectedTo: [2] },
  ],
  bonuses: [],
  distributionModes: [],
};
const graph = buildGraph(MAP);
const t = (territoryId: number, owner: number, armies: number | null, fogged = false): LiveTerritory => ({ territoryId, fogLevel: fogged ? 4 : 1, fogged, owner, armies });
const P = (id: number) => ({ id, name: MAP.territories.find((x) => x.id === id)!.name });
const label = (p: { id: number; name: string }) => `${p.name} (#${p.id})`;
const warn = (board: LiveTerritory[], armies: number, extra: Partial<Parameters<typeof baitAttackWarning>[0]> = {}) =>
  baitAttackWarning({ graph, board, me: ME, moves: [{ from: P(1), to: P(2), armies }], settings: STD, label, name: P, ...extra });

describe('baitAttackWarning (#593 5c)', () => {
  it('warns when its stacks beside the target can move in first and beat the attack: the Tibet case', () => {
    const w = warn([t(1, ME, 4), t(2, FOE, 1), t(3, FOE, 24), t(4, FOE, 1)], 3);
    expect(w).toMatch(/Hong Kong \(#1\) → Tibet \(#2\) with 3/);
    expect(w).toMatch(/India \(#3\) 23/);
    // 1 there and 23 moved in: 24 defenders, which need 40 at 60/70.
    expect(w).toMatch(/24 defenders/);
    expect(w).toMatch(/needs 40/);
    expect(w).toMatch(/moves first/);
    expect(w).toMatch(/warapp_check_plan/);
    // Nepal's 1 is its guard: it cannot move, so it is not named.
    expect(w).not.toMatch(/Nepal/);
  });

  it('adds up every stack beside the target', () => {
    const w = warn([t(1, ME, 40), t(2, FOE, 1), t(3, FOE, 24), t(4, FOE, 6)], 39);
    expect(w).toMatch(/India \(#3\) 23, Nepal \(#4\) 5/);
    expect(w).toMatch(/29 defenders/);
  });

  it('says nothing for a neutral target, whatever stands beside it: neutrals never move (#617)', () => {
    // The live board's owner 0 is neutral: a 2-army neutral beside 2-army neutrals read as player 0's bait.
    expect(warn([t(1, ME, 4), t(2, 0, 2), t(3, 0, 2), t(4, 0, 2)], 3)).toBeUndefined();
    expect(warn([t(1, ME, 4), t(2, 0, 2), t(3, 0, 24), t(4, 0, 6)], 3)).toBeUndefined();
  });

  it('still warns for a player beside a neutral target it does not own, never naming the neutral (#617)', () => {
    const w = warn([t(1, ME, 4), t(2, FOE, 1), t(3, FOE, 24), t(4, 0, 6)], 3);
    expect(w).toMatch(/player 2's stacks/);
    expect(w).not.toMatch(/player 0|Nepal/);
  });

  it('says nothing when the attack beats what can move in', () => {
    expect(warn([t(1, ME, 41), t(2, FOE, 1), t(3, FOE, 24), t(4, FOE, 1)], 40)).toBeUndefined();
  });

  it('says nothing when no stack beside the target can move (a plain deploy is the stress test\'s reinforce reply)', () => {
    expect(warn([t(1, ME, 4), t(2, FOE, 1), t(3, FOE, 1), t(4, FOE, 1)], 3)).toBeUndefined();
  });

  it('ignores stacks of another player, a teammate\'s target, a fogged stack and a transfer-only order', () => {
    expect(warn([t(1, ME, 4), t(2, FOE, 1), t(3, 9, 24), t(4, FOE, 1)], 3)).toBeUndefined();
    expect(warn([t(1, ME, 4), t(2, FOE, 1), t(3, FOE, 24), t(4, FOE, 1)], 3, { teammates: new Set([FOE]) })).toBeUndefined();
    expect(warn([t(1, ME, 4), t(2, FOE, 1), t(3, FOE, null, true), t(4, FOE, 1)], 3)).toBeUndefined();
    expect(
      baitAttackWarning({ graph, board: [t(1, ME, 4), t(2, FOE, 1), t(3, FOE, 24), t(4, FOE, 1)], me: ME, moves: [{ from: P(1), to: P(2), armies: 3, mode: 'transfer-only' }], settings: STD, label, name: P }),
    ).toBeUndefined();
  });

  it('with the guard off a stack can move every army', () => {
    const w = warn([t(1, ME, 4), t(2, FOE, 1), t(3, FOE, 24), t(4, FOE, 1)], 3, { settings: { ...STD, oneArmyStandsGuard: false } });
    expect(w).toMatch(/India \(#3\) 24, Nepal \(#4\) 1/);
  });

  it('sums my attacks on one target', () => {
    const board = [t(1, ME, 41), t(2, FOE, 1), t(3, FOE, 24), t(4, FOE, 1)];
    const moves = [
      { from: P(1), to: P(2), armies: 20 },
      { from: P(1), to: P(2), armies: 20 },
    ];
    expect(baitAttackWarning({ graph, board, me: ME, moves, settings: STD, label, name: P })).toBeUndefined();
  });
});
