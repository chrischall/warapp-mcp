import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { blockadeOffer, bombAdvice, bombExposure, wallOffer, wallThreats, type CardBoard } from '../../src/analysis/card-threats.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral, tinyMap } from './helpers.js';

// tinyMap: 1 ─ 2 ─ 3 triangle (bonus A +3), 3 ─ 4 ─ 5 ─ 6 ─ 7 (bonus B +2: 4, 5).
const ME = 10;
const ENEMY = 20;
const g = buildGraph(tinyMap());
const enemy = (territoryId: number, armies: number, commander = false): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: ENEMY },
  armies,
  ...(commander ? { specialUnits: [{ kind: 'commander' as const, id: 'c'.repeat(32), playerId: ENEMY }] } : {}),
});
const myCommander = (t: TerritoryState): TerritoryState => ({
  ...t,
  specialUnits: [{ kind: 'commander', id: 'd'.repeat(32), playerId: ME }],
});
const cb = (territories: TerritoryState[], over: Partial<CardBoard> = {}): CardBoard => ({
  graph: g,
  board: board(territories),
  me: ME,
  deploys: [],
  moves: [],
  enemyDeploy: 5,
  ...over,
});

describe('bombAdvice (#163)', () => {
  it('bombs the stack whose half can no longer take my border', () => {
    // T5's 10 + 5 deploy reach 14 at T4 (6 armies fall to 10); halved, 8 − 1 = 7 cannot.
    const a = bombAdvice(cb([neutral(3, 2), mine(4, 6), enemy(5, 10), neutral(6, 2)]));
    expect(a).toMatchObject({ target: 5, kind: 'hold' });
    expect(a.why).toMatch(/^Bomb 5: /);
  });

  it('never bombs a territory a truce covers: that would be a break without notice (D3)', () => {
    const a = bombAdvice({ ...cb([neutral(3, 2), mine(4, 6), enemy(5, 10), neutral(6, 2)]), noBomb: new Set([5]) });
    expect(a.target).toBeUndefined();
    expect(a.why).toMatch(/^Hold the Bomb/);
  });

  it('bombs the target of a planned attack that fails if the owner deploys there, and works halved', () => {
    const a = bombAdvice(
      cb([neutral(3, 2), mine(4, 20), enemy(5, 8), neutral(6, 2)], { moves: [{ from: 4, to: 5, armies: 19, kind: 'attack' }] }),
    );
    expect(a).toMatchObject({ target: 5, kind: 'capture' });
  });

  it('a commander kill comes first: the bomb halves the guard and leaves the commander', () => {
    // 3 + 5 deploy + commander (7): 25 to take; halved, 4 + 7 → 18, within my 19 free.
    const a = bombAdvice(cb([neutral(3, 2), mine(4, 20), enemy(5, 3, true), neutral(6, 2)]));
    expect(a).toMatchObject({ target: 5, kind: 'commander' });
  });

  it('says to hold the card when halving nothing changes the turn', () => {
    const a = bombAdvice(cb([neutral(3, 2), mine(4, 50), enemy(5, 2), neutral(6, 2)]));
    expect(a.target).toBeUndefined();
    expect(a.why).toMatch(/^Hold the Bomb/);
  });

  it("takes the worst case for a bombed stack: the owner deploys on its other stack beside my border, unhalved", () => {
    // T4's 6 need 10. T5 (10) bombed keeps 5; the 5 deploy goes on T3 (2) instead, unhalved:
    // 5 + (5 − 1) + (2 − 1) = 10 still takes T4, so bombing T5 holds nothing.
    const a = bombAdvice(cb([enemy(3, 2), mine(4, 6), enemy(5, 10), neutral(6, 2)]));
    expect(a.target).toBeUndefined();
    expect(a.why).toMatch(/^Hold the Bomb/);
  });

  it('halves the deploy with the stack when the owner has no other stack beside my border', () => {
    // Only T5 reaches T4: deployed there, (10 + 5) halved keeps 8, 7 attack — short of the 10 needed.
    const a = bombAdvice(cb([neutral(3, 2), mine(4, 6), enemy(5, 10), neutral(6, 2)]));
    expect(a).toMatchObject({ target: 5, kind: 'hold' });
  });

  it('never targets a teammate', () => {
    const a = bombAdvice(cb([neutral(3, 2), mine(4, 6), enemy(5, 10), neutral(6, 2)], { friends: new Set([ENEMY]) }));
    expect(a.target).toBeUndefined();
  });
});

describe('bombExposure (#163)', () => {
  it('lists a border that holds unbombed and falls halved', () => {
    // T4's 12 need 20 to take, T5 reaches 12; bombed, 6 need 10.
    expect(bombExposure(cb([neutral(3, 2), mine(4, 12), enemy(5, 8), neutral(6, 2)]))).toEqual([
      { territory: 4, armies: 12, bombed: 6, reach: 12, player: ENEMY, commander: false },
    ]);
  });

  it('counts my deploys as bombed and transfers in as arriving after the bomb', () => {
    const exposed = bombExposure(
      cb([neutral(2, 1), mine(3, 4), mine(4, 8), enemy(5, 14), neutral(6, 2)], {
        deploys: [{ territoryId: 4, armies: 4 }],
        moves: [{ from: 3, to: 4, armies: 3, kind: 'transfer' }],
      }),
    );
    // 8 + 4 deploy + 3 in = 15 (25 to take, reach 18); bombed: floor(12 / 2) + 3 = 9 (15 to take).
    expect(exposed.map((e) => [e.territory, e.armies, e.bombed])).toEqual([[4, 15, 9]]);
  });

  it('is empty where the border holds either way or falls either way', () => {
    expect(bombExposure(cb([neutral(3, 2), mine(4, 40), enemy(5, 8), neutral(6, 2)]))).toEqual([]);
    expect(bombExposure(cb([neutral(3, 2), mine(4, 2), enemy(5, 8), neutral(6, 2)]))).toEqual([]);
  });

  it('flags my commander', () => {
    // 4 + commander (7) need 18 against a reach of 16; bombed, 2 + 7 need 15.
    expect(bombExposure(cb([neutral(3, 2), myCommander(mine(4, 4)), enemy(5, 12), neutral(6, 2)]))[0]?.commander).toBe(true);
  });
});

describe('wallThreats (#163)', () => {
  it("warns of a planned attack the owner's Emergency Blockade would stop", () => {
    const plan = { moves: [{ from: 4, to: 5, armies: 19, kind: 'attack' as const }] };
    expect(wallThreats(cb([mine(4, 20), enemy(5, 4)], plan), 3)).toEqual([{ target: 5, player: ENEMY, attackers: 19, wall: 27 }]);
    // A small wall that 19 still take: no warning.
    expect(wallThreats(cb([mine(4, 20), enemy(5, 1)], { ...plan, enemyDeploy: 2 }), 2)).toEqual([]);
  });

  it('ignores attacks on neutrals', () => {
    expect(wallThreats(cb([mine(4, 20), neutral(5, 4)], { moves: [{ from: 4, to: 5, armies: 19, kind: 'attack' }] }), 3)).toEqual([]);
  });
});

describe('wallOffer (#163)', () => {
  it('offers the card on a conceded border where the wall kills more than it gives up', () => {
    // T4's 10 × 3 = 30: a 34-army attack loses 21 against it.
    expect(wallOffer(cb([neutral(3, 2), mine(4, 10), enemy(5, 30), neutral(6, 2)]), 3, [4])).toEqual({
      territory: 4,
      givesUp: 10,
      wall: 30,
      player: ENEMY,
      reach: 34,
      kills: 21,
      protects: { territories: [], bonuses: [], income: 0, commander: false },
    });
  });

  it('never on a conceded border the plan withdraws from: the wall would strand the moves out of it (#163)', () => {
    const withdraw = { moves: [{ from: 4, to: 3, armies: 9, kind: 'transfer' as const }] };
    expect(wallOffer(cb([mine(3, 2), mine(4, 10), enemy(5, 30), neutral(6, 2)], withdraw), 3, [4])).toBeUndefined();
  });

  it('never on my commander, a member of a bonus I hold, or where the wall kills too little', () => {
    expect(wallOffer(cb([neutral(3, 2), myCommander(mine(4, 10)), enemy(5, 30), neutral(6, 2)]), 3, [4])).toBeUndefined();
    expect(wallOffer(cb([mine(1, 2), mine(2, 2), mine(3, 10), enemy(4, 30), neutral(5, 2)]), 3, [3])).toBeUndefined();
    expect(wallOffer(cb([neutral(3, 2), mine(4, 10), enemy(5, 30), neutral(6, 2)]), 1, [4])).toBeUndefined();
  });
});

describe('blockadeOffer (#434): a Blockade on the one gate into a held bonus the plan concedes', () => {
  // I hold bonus A (1, 2, 3) and its gate 4; the stack on 5 (10 + 5 deploy, ~14) reaches A only through 4.
  const gate = (armies: number, over: Partial<CardBoard> = {}) =>
    cb([mine(1, 2), mine(2, 2), mine(3, 2), mine(4, armies), enemy(5, 10), neutral(6, 2), neutral(7, 2)], over);

  it('walls the gate when its armies × the multiplier stop the stack beside it', () => {
    expect(blockadeOffer(gate(4), 3, [4])).toEqual({
      territory: 4,
      armies: 4,
      wall: 12,
      player: ENEMY,
      reach: 14,
      opens: { ids: [1, 2, 3], bonuses: [101], income: 3 },
      commander: false,
    });
  });

  it('sizes the wall on what the plan leaves there: deploys in, moves out (the card runs after the moves)', () => {
    const over = { deploys: [{ territoryId: 4, armies: 3 }], moves: [{ from: 4, to: 3, armies: 2, kind: 'transfer' as const }] };
    expect(blockadeOffer(gate(4, over), 3, [4])).toMatchObject({ territory: 4, armies: 5, wall: 15 });
  });

  it('never when the wall would not stop the stack, or the plan does not concede the gate', () => {
    expect(blockadeOffer(gate(2), 3, [4])).toBeUndefined();
    expect(blockadeOffer(gate(4), 3, [])).toBeUndefined();
  });

  it('never on a member of a bonus I hold: the wall gives it away and breaks the bonus', () => {
    // 3 is A's own member facing the stack on 4: walling it would break A.
    expect(blockadeOffer(cb([mine(1, 2), mine(2, 2), mine(3, 6), enemy(4, 10), neutral(5, 2), neutral(6, 2), neutral(7, 2)]), 3, [3])).toBeUndefined();
    // 4 and 5 make bonus B (+2), held: neither is walled.
    expect(blockadeOffer(cb([mine(1, 2), mine(2, 2), mine(3, 2), mine(4, 6), mine(5, 6), enemy(6, 10), neutral(7, 2)]), 3, [4, 5])).toBeUndefined();
  });

  it('never on my commander, nor on a border that is no gate (nothing held lies only behind it)', () => {
    expect(blockadeOffer(gate(4, {}), 3, [4])).toBeDefined();
    expect(blockadeOffer(cb([mine(1, 2), mine(2, 2), mine(3, 2), myCommander(mine(4, 4)), enemy(5, 10), neutral(6, 2), neutral(7, 2)]), 3, [4])).toBeUndefined();
    // With 2 in the fog A is not held whole, and nothing held lies only behind 4.
    const fog = { territoryId: 2, owner: { kind: 'unknown' as const }, armies: null };
    expect(blockadeOffer(cb([mine(1, 2), fog, mine(3, 2), mine(4, 4), enemy(5, 10), neutral(6, 2), neutral(7, 2)]), 3, [4])).toBeUndefined();
  });
});

// #369: a wall map. The enemy stack on 1 reaches my 2; behind 2 lies my 3 (bonus X +3 with my 4).
//   1 ─ 2 ─ 3 ─ 4        with `around`: 1 ─ 5 ─ 3 (a way past 2 in the same two steps)
function wallMap(around = false): GameMap {
  const edges: [number, number][] = [[1, 2], [2, 3], [3, 4], ...(around ? ([[1, 5], [5, 3]] as [number, number][]) : [])];
  const ids = around ? [1, 2, 3, 4, 5] : [1, 2, 3, 4];
  return {
    id: 2,
    name: 'Wall',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: [{ id: 201, name: 'X', value: 3, territoryIds: [3, 4], bonusIds: [] }],
    distributionModes: [],
  };
}
const wallBoard = (territories: TerritoryState[], around = false): CardBoard => ({
  graph: buildGraph(wallMap(around)),
  board: board(territories),
  me: ME,
  deploys: [],
  moves: [],
  enemyDeploy: 5,
});

describe('wallOffer: what the wall protects (#369)', () => {
  // T2's 6 × 1.5 = a wall of 9 (15 to take); T1's 10 + 5 deploy reach 14: it takes 6 (10 needed), not the wall.
  // The wall kills 6 (9 × 70%) of the 14: no more than the 6 given up, so kills alone never pay here.
  const behind = [enemy(1, 10), mine(2, 6), mine(3, 2), mine(4, 2)];

  it('pays when the wall blocks the stack from a bonus I hold behind it, priced by its income', () => {
    expect(wallOffer(wallBoard(behind), 1.5, [2])).toEqual({
      territory: 2,
      givesUp: 6,
      wall: 9,
      player: ENEMY,
      reach: 14,
      kills: 6,
      protects: { territories: [3], bonuses: [{ bonus: 201, value: 3 }], income: 3, commander: false },
    });
  });

  it('is not offered when the opponent can go around the wall in the same two steps', () => {
    expect(wallOffer(wallBoard([...behind, neutral(5, 2)], true), 1.5, [2])).toBeUndefined();
    // Even where kills alone would pay (× 3: a wall of 18 kills 13 of the 14), a wall it walks past is never attacked.
    expect(wallOffer(wallBoard([...behind, neutral(5, 2)], true), 3, [2])).toBeUndefined();
  });

  it('pays when it shields my commander behind it', () => {
    const offer = wallOffer(wallBoard([enemy(1, 10), mine(2, 6), myCommander(mine(3, 2)), neutral(4, 2)]), 1.5, [2]);
    expect(offer?.protects).toEqual({ territories: [3], bonuses: [], income: 0, commander: true });
  });

  it('is not offered when nothing behind pays for it and the kills do not', () => {
    expect(wallOffer(wallBoard([enemy(1, 10), mine(2, 6), mine(3, 2), neutral(4, 2)]), 1.5, [2])).toBeUndefined();
  });

  it('protects nothing when the stack can take the wall, so only the kills price it', () => {
    // T1's 40 + 5 reach 44: the wall of 9 falls and the stack goes on into X.
    expect(wallOffer(wallBoard([enemy(1, 40), mine(2, 6), mine(3, 2), mine(4, 2)]), 1.5, [2])).toBeUndefined();
  });
});
