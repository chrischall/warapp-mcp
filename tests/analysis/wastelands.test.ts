// #167: automatic Wastelands. A fogged missing member of a bonus has no remembered size: with
// wastelands in the game it is costed with the expected surcharge of being one, not as an ordinary
// neutral. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
// 1 (mine) ─ 2 (neutral 2) ─ 3 (fogged); B701 (+5) is 2 and 3. 4 is mine, 5 neutral, 6 and 7 fogged.
const map: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2, 4] },
    { id: 2, name: 'T2', connectedTo: [1, 3] },
    { id: 3, name: 'T3', connectedTo: [2] },
    { id: 4, name: 'T4', connectedTo: [1, 5] },
    { id: 5, name: 'T5', connectedTo: [4, 6] },
    { id: 6, name: 'T6', connectedTo: [5, 7] },
    { id: 7, name: 'T7', connectedTo: [6] },
    { id: 8, name: 'T8', connectedTo: [] },
  ],
  bonuses: [{ id: 701, name: 'B701', value: 5, territoryIds: [2, 3], bonusIds: [] }],
  distributionModes: [],
};
const g = buildGraph(map);
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const b = board([mine(1, 3), neutral(2, 2), fogged(3), mine(4, 3), neutral(5, 2), fogged(6), fogged(7), neutral(8, 2)]);
const plan = (settings: PlannerSettings) => planTurn({ graph: g, board: b, me: ME, income: 5, settings, game: { turn: 4 } });
const why = (p: ReturnType<typeof planTurn>) => p.rationale.join('\n');

describe('#167: wastelands price a fogged bonus member', () => {
  it('without wastelands the fogged member costs what the costliest visible one does', () => {
    // T2 (2) needs 3; the fogged T3 counts at 3: 6 armies to finish.
    expect(why(plan(STD))).toMatch(/\+5, 6 armies to finish \(1 fogged member counted at 3 each\)/);
  });

  it('with 4 wastelands of 10 on 8 territories, each fogged member adds half of (16 − 3): 7 more', () => {
    const p = plan({ ...STD, wastelands: { count: 4, size: 10 } });
    expect(why(p)).toMatch(/\+5, 13 armies to finish \(1 fogged member counted at 10 each\)/);
    expect(why(p)).toMatch(/B701 \(#701\): its 1 fogged member may be a wasteland \(4 of the map's 8 territories start at 10\): \+7 armies expected/);
  });

  it('a game with no wastelands changes nothing', () => {
    expect(why(plan({ ...STD, wastelands: { count: 0, size: 0 } }))).toEqual(why(plan(STD)));
  });
});

describe('#201: a fogged neutral the picking board showed keeps its size', () => {
  const remembered = (sizes: [number, number][], settings: PlannerSettings = STD) =>
    planTurn({ graph: g, board: b, me: ME, income: 5, settings, game: { turn: 4 }, options: { rememberedNeutrals: new Map(sizes) } });

  it('a remembered 10 on T3 is costed as a 10, not as the costliest visible member or a wasteland guess', () => {
    // T2 (2) needs 3; T3 remembered at 10 needs 16 (10 / 0.6 = 16.7 → 16 kills 10 at 60%: 9.6 → 10).
    const p = remembered([[3, 10]], { ...STD, wastelands: { count: 4, size: 10 } });
    expect(why(p)).toMatch(/B701 \(#701\): T3 \(#3\), fogged now, was a neutral of 10 on the picking board \(#201\): costed at that\./);
    expect(why(p)).not.toMatch(/may be a wasteland/);
    expect(why(p)).toMatch(/\+5, 1[89] armies to finish/);
  });

  it('a remembered member of two bonuses is said once, naming both', () => {
    const g2 = buildGraph({ ...map, bonuses: [...map.bonuses, { id: 702, name: 'B702', value: 4, territoryIds: [3, 2], bonusIds: [] }] });
    const p = planTurn({ graph: g2, board: b, me: ME, income: 5, settings: STD, game: { turn: 4 }, options: { rememberedNeutrals: new Map([[3, 10]]) } });
    expect(why(p).match(/fogged now, was a neutral of 10 on the picking board/g)).toHaveLength(1);
    expect(why(p)).toMatch(/B701 \(#701\), B702 \(#702\): T3 \(#3\), fogged now, was a neutral of 10 on the picking board \(#201\): costed at that\./);
  });

  it('a territory not remembered keeps the old costing', () => {
    expect(why(remembered([[6, 4]]))).toMatch(/\+5, 6 armies to finish \(1 fogged member counted at 3 each\)/);
  });
});
