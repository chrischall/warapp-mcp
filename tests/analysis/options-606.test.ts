// #606: the mechanics laid out for the calling model: ranked capture and hold options, and alternative plans.
import { describe, expect, it } from 'vitest';
import type { BoardState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { alternativePlans, stressSummary, turnOptions } from '../../src/analysis/options.js';
import { planTurn, type PlanInput } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';

const ME = 1;
const FOE = 2;
// T1 (mine 10) ─ T2 (neutral 2) ─ T3 (neutral 2); T1 ─ T4 (foe 5) ─ T5 (foe 3); T6 (mine 4) ─ T4.
// Bonus 10 (+3): T1, T2. Bonus 11 (+2): T3, T5. Bonus 12 (+4): T6 alone (held).
const MAP: GameMap = {
  id: 1,
  name: 'm',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2, 4] },
    { id: 2, name: 'T2', connectedTo: [1, 3] },
    { id: 3, name: 'T3', connectedTo: [2] },
    { id: 4, name: 'T4', connectedTo: [1, 5, 6] },
    { id: 5, name: 'T5', connectedTo: [4] },
    { id: 6, name: 'T6', connectedTo: [4] },
  ],
  bonuses: [
    { id: 10, name: 'B10', value: 3, territoryIds: [1, 2], bonusIds: [] },
    { id: 11, name: 'B11', value: 2, territoryIds: [3, 5], bonusIds: [] },
    { id: 12, name: 'B12', value: 4, territoryIds: [6], bonusIds: [] },
  ],
  distributionModes: [],
};
const mine = (id: number, armies: number) => ({ territoryId: id, owner: { kind: 'player' as const, playerId: ME }, armies });
const foe = (id: number, armies: number) => ({ territoryId: id, owner: { kind: 'player' as const, playerId: FOE }, armies });
const neutral = (id: number, armies: number) => ({ territoryId: id, owner: { kind: 'neutral' as const }, armies });
const BOARD: BoardState = { source: 'browser', verified: true, territories: [mine(1, 10), neutral(2, 2), neutral(3, 2), foe(4, 5), foe(5, 3), mine(6, 4)] };
const g = buildGraph(MAP);
const rates = { offensiveKillRate: 60, defensiveKillRate: 70 };

describe('turnOptions (#606)', () => {
  const o = turnOptions({ graph: g, board: BOARD, me: ME, deployOf: () => 5, rates });

  it('ranks the capture that completes a bonus first, with its cost and sources', () => {
    expect(o.captures[0]).toMatchObject({ target: 2, owner: 'neutral', defenders: 2, needs: 3, completes: [{ bonusId: 10, value: 3 }], incomeGain: 3 });
    expect(o.captures[0]!.from).toEqual([{ territoryId: 1, spare: 9 }]);
  });

  it("prices a player's territory as it stands and after its owner's whole deploy, and counts the borders it opens", () => {
    const t4 = o.captures.find((c) => c.target === 4)!;
    expect(t4.owner).toBe(FOE);
    expect(t4.needs).toBe(8);
    expect(t4.needsIfReinforced).toBe(16);
    expect(t4.opensBorders).toBe(1);
    expect(t4.from.map((f) => f.territoryId)).toEqual([1, 6]);
  });

  it('lays out each border facing a player: what holds it against the stacks alone and against one whole deploy', () => {
    const t6 = o.holds.find((x) => x.territoryId === 6)!;
    expect(t6).toMatchObject({ armies: 4, facing: [{ player: FOE, stacks: 4, deploy: 5 }], protects: [{ bonusId: 12, value: 4 }] });
    expect(t6.addAgainstStacks).toBe(0);
    expect(t6.addAgainstDeploy).toBeGreaterThan(0);
    // The held bonus's border comes first.
    expect(o.holds[0]!.territoryId).toBe(6);
  });

  it('leaves out teammates, fogged territories and anything beyond the limit', () => {
    const fogged: BoardState = { ...BOARD, territories: BOARD.territories.map((t) => (t.territoryId === 2 ? { ...t, owner: { kind: 'unknown' as const }, armies: null } : t)) };
    const f = turnOptions({ graph: g, board: fogged, me: ME, deployOf: () => 5, rates, friends: new Set([FOE]) }, 1);
    expect(f.captures.map((c) => c.target)).toEqual([]);
    expect(f.holds).toEqual([]);
    const capped = turnOptions({ graph: g, board: BOARD, me: ME, deployOf: () => 5, rates, guard: false }, 1);
    expect(capped.captures).toHaveLength(1);
    expect(capped.captures[0]!.from[0]!.spare).toBe(10);
  });
});

describe('alternativePlans (#606)', () => {
  const input: PlanInput = { graph: g, board: BOARD, me: ME, income: 6, game: { players: [{ id: ME }, { id: FOE }], turn: 5 }, options: { adapt: true } };
  const base = planTurn(input);

  it('lists the default plan first, then the other goals, each different from those before', () => {
    const alts = alternativePlans(input, base, () => ({ safe: true, harmful: 0, considered: 3 }));
    expect(alts[0]!.name).toBe('default');
    expect(alts[0]!.deploys).toEqual(base.deploys.map((d) => ({ territoryId: d.territoryId, armies: d.armies })));
    expect(alts.every((a) => a.stress?.safe === true)).toBe(true);
    const keys = alts.map((a) => JSON.stringify([a.deploys, a.moves.map((m) => [m.from, m.to, m.armies])]));
    expect(new Set(keys).size).toBe(keys.length);
    expect(alts.slice(1).every((a) => a.name === 'expand' || a.name === 'defend')).toBe(true);
  });

  it('leaves the stress out when none is given or it gives nothing', () => {
    expect(alternativePlans(input, base)[0]).not.toHaveProperty('stress');
    expect(alternativePlans(input, base, () => undefined)[0]).not.toHaveProperty('stress');
  });
});

describe('stressSummary (#606)', () => {
  it('safe when no reply harms, unknown when none was tried, the worst reply kept', () => {
    expect(stressSummary({ considered: 0, harmful: 0 })).toEqual({ safe: null, harmful: 0, considered: 0 });
    expect(stressSummary({ considered: 4, harmful: 0 })).toEqual({ safe: true, harmful: 0, considered: 4 });
    expect(
      stressSummary({ considered: 4, harmful: 1, worst: { opponent: 2, lost: [6], capturesFailed: [], incomeLost: 4 } }),
    ).toEqual({ safe: false, harmful: 1, considered: 4, worst: { opponent: 2, lost: [6], capturesFailed: [], incomeLost: 4 } });
  });
});
