// #416: finish the nearest bonus first, turns 1–6. Rule 4f (#101) ranked bonuses by turns to finish
// at this income alone, so a start standing on 10 armies beside a bonus counted for nothing: the
// bonus it could take outright ranked level with one the deploys need two turns for. And a 1-point
// bonus held in full switched off #319's warning (and, past the expansion phase, rule 4f itself).
// Synthetic maps only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const P2 = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, string, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Nearest',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, name, value, territoryIds]) => ({ id, name, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const player = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const why = (p: TurnPlan) => p.rationale.join('\n');

describe('armies standing beside a bonus count toward its turns to finish (#416)', () => {
  //   Alpha (+3): 1 11 12 13 — I hold 1 on 10 armies (9 movable); 11..13 are 2-neutrals next to 1: 9 to finish.
  //   Beta  (+6): 2 21 22 23 — I hold 2 on 1 army; 21..23 are 2-neutrals next to 2: 9 to finish.
  //   At income 6 both are 2 turns on the income alone, and Beta's higher value per army ranked it first;
  //   Alpha's 9 movable armies take it this turn.
  const IDS = [1, 2, 11, 12, 13, 21, 22, 23, 90];
  const EDGES: [number, number][] = [[1, 2], [1, 11], [1, 12], [1, 13], [2, 21], [2, 22], [2, 23], [23, 90]];
  const ALPHA = 401;
  const BETA = 402;
  const g = buildGraph(makeMap(IDS, EDGES, [[ALPHA, 'Alpha', 3, [1, 11, 12, 13]], [BETA, 'Beta', 6, [2, 21, 22, 23]]]));
  const field = (over: TerritoryState[] = []): BoardState =>
    board(
      [mine(1, 10), mine(2, 1), ...[11, 12, 13, 21, 22, 23].map((id) => neutral(id, 2)), player(90, 3, P2)].map(
        (t) => over.find((o) => o.territoryId === t.territoryId) ?? t,
      ),
    );
  const plan = (b: BoardState, turn = 2) =>
    planTurn({ graph: g, board: b, me: ME, income: 6, settings: STD, game: { players: [{ id: ME }, { id: P2 }], turn } });

  it('ranks the bonus a standing stack can finish ahead of one the income needs two turns for', () => {
    const p = plan(field());
    expect(why(p)).toMatch(
      /No bonus held: expansion goes to the bonus closest to completion first — Alpha \(#401\) 9 armies to finish \(9 standing beside it\), 1 turn at income 6, Beta \(#402\) 9, 2 turns — /,
    );
  });

  it('credits only what the stack can spare beyond its hold: exact holds come first', () => {
    // An enemy 12-stack beside 1: holding 1 keeps every army there, so nothing stands spare for Alpha.
    const IDS2 = [...IDS, 91];
    const g2 = buildGraph(
      makeMap(IDS2, [...EDGES, [1, 91]], [[ALPHA, 'Alpha', 3, [1, 11, 12, 13]], [BETA, 'Beta', 6, [2, 21, 22, 23]]]),
    );
    const b = board([...field().territories, player(91, 12, P2)]);
    const p = planTurn({ graph: g2, board: b, me: ME, income: 6, settings: STD, game: { players: [{ id: ME }, { id: P2 }], turn: 2 } });
    expect(why(p)).not.toMatch(/standing beside it/);
    expect(why(p)).toMatch(/closest to completion first — Beta \(#402\) 9 armies to finish, 2 turns at income 6, Alpha \(#401\) 9, 2 turns — /);
  });
});

describe('ties at the same turns and income per army go to the surer figure (#416)', () => {
  //   Alpha (+3): 1 11 12 — 11 a 2-neutral beside 1, 12 behind it in the fog (counted at 3, the costliest in view).
  //   Beta  (+3): 2 21 22 — 21 a 2-neutral beside 2, 22 a 2-neutral behind it. Both 6 to finish, two layers
  //   deep, the same income per army; the score order (lower id) ranked Alpha first though its figure is a guess.
  const IDS = [1, 2, 11, 12, 21, 22];
  const EDGES: [number, number][] = [[1, 2], [1, 11], [11, 12], [2, 21], [21, 22]];
  const g = buildGraph(makeMap(IDS, EDGES, [[401, 'Alpha', 3, [1, 11, 12]], [402, 'Beta', 3, [2, 21, 22]]]));
  const b = board([mine(1, 1), mine(2, 1), neutral(11, 2), { territoryId: 12, owner: { kind: 'unknown' }, armies: null }, neutral(21, 2), neutral(22, 2)]);

  it('ranks the bonus with fewer fogged members first', () => {
    const p = planTurn({ graph: g, board: b, me: ME, income: 6, settings: STD, game: { players: [{ id: ME }, { id: P2 }], turn: 2 } });
    expect(why(p)).toMatch(/closest to completion first — Beta \(#402\) 6 armies to finish, 2 turns \(2 layers deep\) at income 6, Alpha \(#401\) 6 \(1 fogged member counted at 3 each\), 2 turns/);
  });
});

describe('a 1-point bonus does not switch off #319 or rule 4f (#416)', () => {
  // #319's map (spread-opening-319.test.ts): six 3-territory bonuses in a row, the first member of each and a
  // second of the first three held, plus 20 beside 1 — here a bonus of its own worth +1 (Tiny), held in full.
  const IDS = [...Array.from({ length: 18 }, (_, i) => i + 1), 20, 99];
  const EDGES: [number, number][] = [];
  for (let b = 0; b < 6; b++) {
    const a = 3 * b + 1;
    EDGES.push([a, a + 1], [a + 1, a + 2]);
    if (b < 5) EDGES.push([a + 2, a + 3]);
  }
  EDGES.push([1, 20], [18, 99]);
  const mapWith = (tiny: number) =>
    buildGraph(
      makeMap(IDS, EDGES, [
        ...Array.from({ length: 6 }, (_, b): [number, string, number, number[]] => [500 + b, `B${b}`, 3, [3 * b + 1, 3 * b + 2, 3 * b + 3]]),
        [600, 'Tiny', tiny, [20]],
      ]),
    );
  const held = new Set([1, 2, 4, 5, 7, 8, 10, 13, 16, 20]);
  const b = board(IDS.map((id) => (id === 99 ? player(99, 5, P2) : held.has(id) ? mine(id, 2) : neutral(id, 2))));
  const plan = (tiny: number) =>
    planTurn({ graph: mapWith(tiny), board: b, me: ME, income: 6, settings: { ...STD, baseIncome: 5 }, game: { players: [{ id: ME }, { id: P2 }], turn: 4 } });
  const spread = (p: TurnPlan) => p.warnings.find((w) => w.includes('#319'));

  it('still warns that the captures are spread when the only bonus held is worth +1', () => {
    const w = spread(plan(1));
    expect(w).toMatch(/^10 territories, no bonus worth more than \+1: the captures are spread \(income 6, base 5\)\. Nearest bonus to complete: B\d \(#50\d\)/);
  });

  it('a +2 bonus held still silences it', () => {
    expect(spread(plan(2))).toBeUndefined();
  });
});
