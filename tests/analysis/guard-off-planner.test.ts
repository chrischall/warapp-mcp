// #165: the planner under One Army Must Stand Guard off. It keeps one army on each territory of mine
// next to an enemy (an empty one falls to any single army), and takes an empty enemy territory beside
// me whose loss breaks its owner's bonus with one army. Synthetic map.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import { guardOffExposure } from '../../src/analysis/guard-off.js';
import { planTurn, type PlanOptions, type PlannerSettings } from '../../src/analysis/planner.js';
import type { BoardState } from '../../src/board.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const MATE = 30;

/** 1 ─ 2 ─ 3 ─ 4 ─ 5, plus 6 off 3. Bonus 100 (+3) is 4 and 5; bonus 200 (+2) is 6. */
const MAP: GameMap = {
  id: 1,
  name: 'Guard',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2] },
    { id: 2, name: 'T2', connectedTo: [1, 3] },
    { id: 3, name: 'T3', connectedTo: [2, 4, 6] },
    { id: 4, name: 'T4', connectedTo: [3, 5] },
    { id: 5, name: 'T5', connectedTo: [4] },
    { id: 6, name: 'T6', connectedTo: [3] },
  ],
  bonuses: [
    { id: 100, name: 'B100', value: 3, territoryIds: [4, 5], bonusIds: [] },
    { id: 200, name: 'B200', value: 2, territoryIds: [6], bonusIds: [] },
  ],
  distributionModes: [],
};
const G = buildGraph(MAP);
const OFF: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: false };
const ON: PlannerSettings = { ...OFF, oneArmyStandsGuard: true };

const plan = (b: BoardState, income: number, settings = OFF, options: PlanOptions = {}) =>
  planTurn({ graph: G, board: b, me: ME, income, settings, options, game: { turn: 10 } });

/** My armies on `t` once the plan's deploys and moves run (captures not counted). */
const left = (b: BoardState, p: ReturnType<typeof plan>, t: number) =>
  (b.territories.find((x) => x.territoryId === t)?.armies ?? 0) +
  p.deploys.filter((d) => d.territoryId === t).reduce((n, d) => n + d.armies, 0) -
  p.moves.filter((m) => m.from === t).reduce((n, m) => n + m.armies, 0) +
  p.moves.filter((m) => m.to === t && m.kind === 'transfer').reduce((n, m) => n + m.armies, 0);

describe('planTurn with the guard off (#165)', () => {
  it('keeps one army on a conceded border next to an enemy instead of withdrawing every army', () => {
    const b = board([mine(1, 1), mine(2, 1), mine(3, 4), mine(4, 9, FOE), mine(5, 3, FOE), neutral(6, 2)]);
    const p = plan(b, 0);
    expect(p.conceded).toContain(3);
    expect(left(b, p, 3)).toBe(1);
    expect(guardOffExposure({ graph: G, board: b, me: ME, deploys: p.deploys, moves: p.moves }).emptied).toEqual([]);
    expect(p.rationale.join('\n')).toMatch(/One Army Must Stand Guard is off: .*T3 \(#3\)/);
  });

  it('never attacks out of a border next to an enemy with its last army', () => {
    const b = board([mine(1, 1), mine(2, 1), mine(3, 2), mine(4, 20, FOE), mine(5, 3, FOE), neutral(6, 1)]);
    const p = plan(b, 0);
    expect(left(b, p, 3)).toBeGreaterThanOrEqual(1);
    // With a deploy it can still take 6 and keep one behind.
    const funded = plan(b, 1);
    expect(funded.moves).toContainEqual(expect.objectContaining({ from: 3, to: 6, kind: 'attack' }));
    expect(left(b, funded, 3)).toBe(1);
  });

  it('leaves an interior territory free to empty', () => {
    const b = board([mine(1, 6), mine(2, 1), mine(3, 1), mine(4, 2, FOE), mine(5, 3, FOE), neutral(6, 9)]);
    const p = plan(b, 0);
    expect(p.rationale.join('\n')).not.toMatch(/One Army Must Stand Guard is off: [^\n]*T1 \(#1\)/);
    expect(p.rationale.join('\n')).toMatch(/One Army Must Stand Guard is off: [^\n]*T3 \(#3\)/);
  });

  it('pays the army a territory at 0 next to an enemy is owed before any other deploy', () => {
    // T3 starts at 0 next to an enemy at 4; T1 and T2 hold 6 each.
    const b = board([mine(1, 6), mine(2, 6), mine(3, 0), mine(4, 4, FOE), mine(5, 3, FOE), neutral(6, 9)]);
    for (const goal of ['balanced', 'expand', 'defend'] as const) {
      const p = plan(b, 5, OFF, { goal });
      expect(p.deploys.find((d) => d.territoryId === 3)?.armies ?? 0, goal).toBeGreaterThanOrEqual(1);
      expect(left(b, p, 3), goal).toBeGreaterThanOrEqual(1);
      expect(guardOffExposure({ graph: G, board: b, me: ME, deploys: p.deploys, moves: p.moves }).emptied, goal).toEqual([]);
      expect(p.rationale.join('\n'), goal).toMatch(/One Army Must Stand Guard is off: [^\n]*T3 \(#3\)/);
      // The army is paid before any hold, and the rationale says so.
      expect(p.rationale.join('\n'), goal).toMatch(/T3 \(#3\) starts at 0, so its army is deployed first, before any hold/);
    }
  });

  it('does not claim a territory at 0 keeps one army when there is nothing to deploy there', () => {
    const b = board([mine(1, 6), mine(2, 6), mine(3, 0), mine(4, 4, FOE), mine(5, 3, FOE), neutral(6, 9)]);
    const p = plan(b, 0);
    expect(left(b, p, 3)).toBe(0);
    expect(p.rationale.join('\n')).not.toMatch(/One Army Must Stand Guard is off: [^\n]*T3 \(#3\)/);
  });

  it('under No-Split an order still sends the whole stack', () => {
    const b = board([mine(1, 1), mine(2, 1), mine(3, 4), mine(4, 9, FOE), mine(5, 3, FOE), neutral(6, 2)]);
    const p = plan(b, 0, { ...OFF, noSplit: true });
    for (const m of p.moves.filter((x) => x.from === 3)) expect(m.armies).toBe(4);
  });

  it('takes an empty enemy border territory whose loss breaks its owner\'s bonus with one army', () => {
    const b = board([mine(1, 1), mine(2, 1), mine(3, 3), mine(4, 0, FOE), mine(5, 6, FOE), neutral(6, 9)]);
    for (const goal of ['balanced', 'expand', 'defend'] as const) {
      const p = plan(b, 0, OFF, { goal, enemyDeploy: 12 });
      const hit = p.moves.filter((m) => m.to === 4 && m.kind === 'attack');
      expect(hit, goal).toHaveLength(1);
      // Under `balanced` the break pass may take it first; otherwise the guard-off pass, with one army.
      if (goal !== 'balanced') {
        expect(hit[0]!.armies, goal).toBe(1);
        expect(hit[0]!.reason, goal).toMatch(/One Army Must Stand Guard is off/);
        // A later rule may size the attack up, so the reason does not promise one army.
        expect(hit[0]!.reason, goal).toMatch(/: an attack breaks player 20's bonus/);
      }
      expect(p.expected.captures, goal).toContain(4);
      expect(left(b, p, 3), goal).toBeGreaterThanOrEqual(1);
    }
  });

  it('breaks a bonus from a territory at 0 only after paying its own army', () => {
    // T3 starts at 0 between my T2 and an empty enemy T4 whose loss breaks B100.
    const b = board([mine(1, 1), mine(2, 1), mine(3, 0), mine(4, 0, FOE), mine(5, 6, FOE), neutral(6, 9)]);
    for (const goal of ['balanced', 'expand', 'defend'] as const) {
      const p = plan(b, 2, OFF, { goal, enemyDeploy: 12 });
      expect(left(b, p, 3), goal).toBeGreaterThanOrEqual(1);
      const short = plan(b, 1, OFF, { goal, enemyDeploy: 12 });
      expect(left(b, short, 3), goal).toBeGreaterThanOrEqual(1);
      expect(short.moves.filter((m) => m.from === 3), goal).toEqual([]);
    }
  });

  it('does not take a 0-army enemy territory that breaks nothing, nor a teammate\'s', () => {
    const lone = board([mine(1, 1), mine(2, 1), mine(3, 3), mine(4, 0, FOE), mine(5, 6, MATE), neutral(6, 9)]);
    const p = planTurn({
      graph: G,
      board: lone,
      me: ME,
      income: 0,
      settings: OFF,
      options: { goal: 'defend', enemyDeploy: 12 },
      game: { turn: 10, players: [{ id: ME, team: 1 }, { id: MATE, team: 1 }, { id: FOE, team: 2 }] },
    });
    expect(p.moves.filter((m) => m.to === 4 && m.armies === 1 && /Stand Guard/.test(m.reason))).toEqual([]);
    expect(p.moves.filter((m) => m.to === 5)).toEqual([]);
  });

  it('changes nothing with the guard on', () => {
    const b = board([mine(1, 1), mine(2, 1), mine(3, 4), mine(4, 9, FOE), mine(5, 3, FOE), neutral(6, 2)]);
    const p = plan(b, 0, ON);
    expect(p.rationale.join('\n')).not.toMatch(/One Army Must Stand Guard is off/);
  });

  it('every guard-off plan on random boards passes validateTurn and leaves no border next to an enemy empty', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 300; i++) {
      const owners = [1, 2, 3, 4, 5, 6].map(() => {
        const r = rnd();
        return r < 0.45 ? ME : r < 0.75 ? FOE : 0;
      });
      if (!owners.includes(ME)) owners[2] = ME;
      const b = board(
        owners.map((o, k) => {
          const armies = Math.floor(rnd() * 8);
          return o === 0 ? neutral(k + 1, armies) : mine(k + 1, armies, o);
        }),
      );
      const income = Math.floor(rnd() * 6);
      const goal = (['balanced', 'expand', 'defend'] as const)[i % 3];
      const p = plan(b, income, OFF, { goal });
      const again = plan(b, income, OFF, { goal });
      expect(again).toEqual(p);
      const ref = (id: number) => ({ id, name: `T${id}` });
      expect(() =>
        validateTurn({
          map: MAP,
          board: b.territories.map(
            (t): LiveTerritory => ({
              territoryId: t.territoryId,
              fogLevel: 1,
              fogged: false,
              owner: t.owner.kind === 'player' ? t.owner.playerId : OWNER_NEUTRAL,
              armies: t.armies,
            }),
          ),
          myInGameId: ME,
          income,
          guard: false,
          deploys: p.deploys.map((d) => ({ territory: ref(d.territoryId), armies: d.armies })),
          moves: p.moves.map((m) => ({ from: ref(m.from), to: ref(m.to), armies: m.armies })),
        }),
      ).not.toThrow();
      for (const t of b.territories) {
        if (t.owner.kind !== 'player' || t.owner.playerId !== ME) continue;
        const out = p.moves.some((m) => m.from === t.territoryId);
        const nextToFoe = G.neighbors.get(t.territoryId)!.some((n) => owners[n - 1] === FOE);
        if (out && nextToFoe) expect(left(b, p, t.territoryId), `board ${i}, territory ${t.territoryId}`).toBeGreaterThanOrEqual(1);
        // A territory at 0 next to an enemy is paid its army first, when the income covers them all.
        const owed = b.territories.filter(
          (x) =>
            x.owner.kind === 'player' &&
            x.owner.playerId === ME &&
            x.armies === 0 &&
            G.neighbors.get(x.territoryId)!.some((n) => owners[n - 1] === FOE),
        ).length;
        if (nextToFoe && t.armies === 0 && income >= owed)
          expect(left(b, p, t.territoryId), `board ${i}, territory ${t.territoryId} (owed)`).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
