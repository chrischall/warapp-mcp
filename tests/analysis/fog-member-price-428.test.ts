// #428: a fogged missing member of a bonus is priced from what is known of it — its last sighting on
// my board history, else the game's neutral size — and only without either at the bonus's costliest
// visible missing member (65 finished-game plans counted every fogged member at 208). Every map, id
// and name here is made up.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings, type PlanOptions } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
// 1 (mine) ─ 2 (neutral 20) ─ 3 (fogged); B701 (+5) is 2 and 3. 4 is mine, 5 a neutral 2.
const map: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2, 4] },
    { id: 2, name: 'T2', connectedTo: [1, 3] },
    { id: 3, name: 'T3', connectedTo: [2] },
    { id: 4, name: 'T4', connectedTo: [1, 5] },
    { id: 5, name: 'T5', connectedTo: [4] },
  ],
  bonuses: [{ id: 701, name: 'B701', value: 5, territoryIds: [2, 3], bonusIds: [] }],
  distributionModes: [],
};
const g = buildGraph(map);
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const b = board([mine(1, 3), neutral(2, 20), fogged(3), mine(4, 3), neutral(5, 2)]);
const plan = (settings: PlannerSettings, options: PlanOptions = {}, at = b) =>
  planTurn({ graph: g, board: at, me: ME, income: 40, settings, game: { turn: 4 }, options });
const why = (p: ReturnType<typeof planTurn>) => p.rationale.join('\n');
/** The neutral 20's capture cost, which the old rule charged every fogged member. */
const COSTLIEST = /1 fogged member counted at (\d+) each/;

describe('#428: a fogged bonus member is priced from what is known of it', () => {
  it('with no neutral size and no sighting, it still counts at the costliest visible member', () => {
    const m = why(plan(STD)).match(COSTLIEST);
    expect(Number(m?.[1])).toBeGreaterThan(30);
    expect(why(plan(STD))).not.toMatch(/neutral size/);
  });

  it("with the game's neutral size, it counts at that neutral's cost, not the costliest member's", () => {
    const p = plan({ ...STD, neutralArmies: 2 });
    expect(why(p)).toMatch(/1 fogged member counted at 3 each: the game's neutral size, 2\)/);
    expect(why(p)).not.toMatch(/counted at (3\d|[4-9]\d|\d{3,}) each/);
  });

  it('a member last seen on my board history counts at its last-seen armies, ahead of the neutral size', () => {
    const p = plan({ ...STD, neutralArmies: 2 }, { lastSeen: new Map([[3, { armies: 5, owner: null }]]) });
    expect(why(p)).toMatch(/B701 \(#701\): T3 \(#3\), fogged now, was last seen at 5 armies \(#428\): costed at that\./);
    // Costed, not fogged: no fogged-member note for the bonus.
    expect(why(p)).not.toMatch(/fogged member/);
  });

  it("a member the fog shows another player holding now is not priced as a neutral, nor at a sighting under another owner", () => {
    const ownerOnly = board([mine(1, 3), neutral(2, 20), { territoryId: 3, owner: { kind: 'player', playerId: FOE }, armies: null, fogLevel: 'OwnerOnly' }, mine(4, 3), neutral(5, 2)]);
    const neutralSighting = { lastSeen: new Map([[3, { armies: 1, owner: null }]]) };
    for (const p of [plan({ ...STD, neutralArmies: 2 }, {}, ownerOnly), plan({ ...STD, neutralArmies: 2 }, neutralSighting, ownerOnly)]) {
      expect(why(p)).not.toMatch(/neutral size|last seen/);
      expect(Number(why(p).match(COSTLIEST)?.[1])).toBeGreaterThan(30);
    }
    // A sighting under the owner shown now is still its armies.
    const ownSighting = { lastSeen: new Map([[3, { armies: 4, owner: FOE }]]) };
    expect(why(plan(STD, ownSighting, ownerOnly))).toMatch(/T3 \(#3\), fogged now, was last seen at 4 armies \(#428\)/);
  });
});
