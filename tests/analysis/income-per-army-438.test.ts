// Issue #438: among bonuses that finish in the same number of turns, the expansion order put a
// bonus advanced last turn first, before value, and judged each bonus alone. On a map where a
// capture completes a single-territory bonus and a pair bonus at once, the best capture on the
// board was skipped. The order now ranks those ties by the income every bonus the capture
// completes adds per army, with "advanced last turn" a later tie-break. Synthetic map, made-up names.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanGameContext, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const P2 = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const DUEL: PlanGameContext = { players: [{ id: ME }, { id: P2 }], turn: 3 };

//   1 (mine, the capital) ─ 11 (the vassal, a neutral 2)
//   1 ─ 2 (mine, captured last turn) ─ 21 (a neutral 2) ─ 31 ─ 90 (the opponent, far off)
//   Vassal (+6): 11            — one capture of 3 completes it…
//   Realm  (+2): 1, 11         — …and the pair bonus with it: +8 for 3 armies.
//   March  (+7): 2, 21         — advanced last turn; one capture of 3 completes it: +7 for 3.
const EDGES: [number, number][] = [[1, 11], [1, 2], [2, 21], [21, 31], [31, 90]];
const IDS = [1, 2, 11, 21, 31, 90];
const VASSAL = 401;
const REALM = 402;
const MARCH = 403;
const MAP: GameMap = {
  id: 1,
  name: 'Realms',
  territories: IDS.map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: EDGES.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
  })),
  bonuses: (
    [
      [VASSAL, 'Vassal', 6, [11]],
      [REALM, 'Realm', 2, [1, 11]],
      [MARCH, 'March', 7, [2, 21]],
    ] as [number, string, number, number[]][]
  ).map(([id, name, value, territoryIds]) => ({ id, name, value, territoryIds, bonusIds: [] })),
  distributionModes: [],
};
const g = buildGraph(MAP);

const player = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const field = (over: TerritoryState[] = []): BoardState => {
  const base = [mine(1, 1), mine(2, 1), neutral(11, 2), neutral(21, 2), neutral(31, 2), player(90, 3, P2)];
  return board(base.map((t) => over.find((o) => o.territoryId === t.territoryId) ?? t));
};
const plan = (b: BoardState, previous?: BoardState): TurnPlan =>
  planTurn({ graph: g, board: b, me: ME, income: 3, settings: STD, game: DUEL, ...(previous ? { previousBoard: previous } : {}) });
const targets = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack').map((m) => m.to);
const why = (p: TurnPlan) => p.rationale.join('\n');

describe('rank equally close bonuses by the income per army the capture completes (#438)', () => {
  it('a capture completing a single-territory bonus and its pair bonus beats one bonus advanced last turn', () => {
    const previous = field([neutral(2, 2)]);
    const p = plan(field(), previous);
    // 3 deploys fund one capture of 3: the vassal's +6 and the realm's +2 (+8) over the march's +7.
    expect(targets(p)).toEqual([11]);
    expect(p.expected.bonusesCompleted.sort()).toEqual([VASSAL, REALM]);
    expect(why(p)).toMatch(/Vassal \(#401\) and Realm \(#402\) complete together for 3 armies: \+8 next-turn income, 2\.67 per army/);
    expect(why(p)).not.toMatch(/March \(#403\) keeps priority/);
  });

  it('without the pair bonus, the march (+7 alone against +6) is taken, and no "complete together" line', () => {
    const flat = { ...MAP, bonuses: MAP.bonuses.filter((b) => b.id !== REALM) };
    const p = planTurn({ graph: buildGraph(flat), board: field(), me: ME, income: 3, settings: STD, game: DUEL, previousBoard: field([neutral(2, 2)]) });
    expect(targets(p)).toEqual([21]);
    expect(why(p)).not.toMatch(/complete together/);
  });

  it('the line shows only where another bonus as close competes', () => {
    // The march gone, the vassal and realm are the only bonuses: nothing to rank against, no line.
    const only = { ...MAP, bonuses: MAP.bonuses.filter((b) => b.id !== MARCH) };
    const p = planTurn({ graph: buildGraph(only), board: field(), me: ME, income: 3, settings: STD, game: DUEL });
    expect(targets(p)).toEqual([11]);
    expect(why(p)).not.toMatch(/complete together/);
  });
});
