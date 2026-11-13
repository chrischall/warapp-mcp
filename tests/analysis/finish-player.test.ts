// Issue #179: finishing a player — cover its exits, count the turns, price the elimination and
// order the killing strike first. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardSpecialUnit, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { captureCost, guaranteedFallsReaching, planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const VICTIM = 20;
const OTHER = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, baseIncome: 5 };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
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
const enemy = (territoryId: number, armies: number, playerId = VICTIM): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const commander = (playerId: number): BoardSpecialUnit => ({ kind: 'commander', id: `${playerId}`.padStart(32, '0'), playerId });
const withCommander = (t: TerritoryState, playerId: number): TerritoryState => ({ ...t, specialUnits: [commander(playerId)] });
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const attackOn = (p: TurnPlan, to: number) => attacks(p).find((m) => m.to === to);

// Me: 1 2 3 (+ 4 behind); the victim: 5 6 7, holding bonus V (+4) = 6 7. Each of its
// territories faces one of mine. Its estimate is 5 base + 4 = ~9; under Local Deployment
// the +4 lands only on 6 or 7, so 5 can be reinforced with ~5 at most.
const LD_MAP = makeMap(
  [1, 2, 3, 4, 5, 6, 7],
  [[1, 2], [2, 3], [3, 4], [1, 5], [2, 6], [3, 7], [5, 6], [6, 7]],
  [[100, 4, [6, 7]]],
);
const LD_BOARD = board([mine(1, 3), mine(2, 3), mine(3, 3), mine(4, 3), enemy(5, 2), enemy(6, 2), enemy(7, 2)]);

describe('#179 Local Deployment: finishing off sizes each territory for the deploy that can reach it', () => {
  it('guaranteedFallsReaching: a target whose save needs more than can reach it falls for sure', () => {
    // Without reach limits it is guaranteedFalls: the cheapest saves first.
    expect(guaranteedFallsReaching([3, 4], [6, 6], 6)).toBe(1);
    // 4 cannot reach the second target (its pool is elsewhere): it can save only the first.
    expect(guaranteedFallsReaching([3, 3], [6, 2], 6)).toBe(1);
    expect(guaranteedFallsReaching([3, 3], [2, 2], 6)).toBe(2);
    expect(guaranteedFallsReaching([0, 5], [0, 5], 5)).toBe(0);
    expect(guaranteedFallsReaching([], [], 5)).toBe(0);
  });

  it('rule 1e: the territory outside its pooled bonus is sized for its free deploy only', () => {
    const off = planTurn({ graph: buildGraph(LD_MAP), board: LD_BOARD, me: ME, income: 60, settings: STD });
    const on = planTurn({ graph: buildGraph(LD_MAP), board: LD_BOARD, me: ME, income: 60, settings: { ...STD, localDeployments: true } });
    for (const p of [off, on]) expect(p.rationale.join('\n')).toMatch(/Finish off player 20/);
    expect(attackOn(off, 5)!.armies).toBe(captureCost(2 + 9, STD));
    expect(attackOn(on, 5)!.armies).toBe(captureCost(2 + 5, STD));
    expect(attackOn(on, 5)!.reason).toMatch(/~5 of its deploy that can reach it/);
    // The pooled bonus's territories still face all of it.
    expect(attackOn(on, 6)!.armies).toBe(captureCost(2 + 9, STD));
    expect(attackOn(on, 7)!.armies).toBe(captureCost(2 + 9, STD));
    // The finish-off line says what each attack was sized for, as the Local Deployment line does.
    expect(off.rationale.join('\n')).toMatch(/Finish off player 20: .*each sized for its full ~9 deploy landing there/);
    expect(on.rationale.join('\n')).toMatch(
      /Finish off player 20: .*each sized for the part of its ~9 deploy that can reach it \(Local Deployment\) landing there/,
    );
    expect(on.rationale.join('\n')).not.toMatch(/Finish off player 20: .*its full ~9 deploy/);
  });

  it('the move-order caveat sizes each border for the deploy that can reach it, as the cover does', () => {
    // My 1 faces only the victim's 5, outside its pooled bonus: 5's 1 movable plus ~5 can reach it.
    const p = planTurn({ graph: buildGraph(LD_MAP), board: LD_BOARD, me: ME, income: 45, settings: { ...STD, localDeployments: true } });
    const caveat = p.warnings.find((w) => /assumes my attacks land before its own orders/.test(w))!;
    expect(caveat).toMatch(/or take T2 \(#2\)/);
    expect(caveat).not.toMatch(/T1 \(#1\)/);
  });

  it('rule 1s: a commander outside its pooled bonus is struck sized for its free deploy only', () => {
    const b = board([mine(1, 3), mine(2, 3), mine(3, 3), mine(4, 3), withCommander(enemy(5, 2), VICTIM), enemy(6, 2), enemy(7, 2)], true);
    const on = planTurn({ graph: buildGraph(LD_MAP), board: b, me: ME, income: 30, settings: { ...STD, localDeployments: true } });
    expect(attackOn(on, 5)!.armies).toBe(captureCost(2 + 7 + 5, STD));
    expect(attackOn(on, 5)!.reason).toMatch(/~5 deploy that can reach it/);
    const off = planTurn({ graph: buildGraph(LD_MAP), board: b, me: ME, income: 30, settings: STD });
    expect(attackOn(off, 5)!.armies).toBe(captureCost(2 + 7 + 9, STD));
  });
});

// The victim (5 6 7) with its largest stack on 6: the stack that can flee or strike first.
const KILL_BOARD = board([mine(1, 3), mine(2, 3), mine(3, 3), mine(4, 3), enemy(5, 2), enemy(6, 6), enemy(7, 2)]);
const killPlan = (options: Parameters<typeof planTurn>[0]['options'] = {}) =>
  planTurn({ graph: buildGraph(LD_MAP), board: KILL_BOARD, me: ME, income: 70, settings: STD, options });

describe('#179 Order Priority: the killing strike goes first', () => {
  it('the attack on its largest stack is my first order, and Order Priority is advised for it', () => {
    const p = killPlan({ holdsOrderPriority: true });
    expect(p.rationale.join('\n')).toMatch(/Finish off player 20/);
    expect(p.moves[0]).toMatchObject({ kind: 'attack', to: 6 });
    expect(p.cardAdvice).toBe('order-priority');
    expect(p.rationale.join('\n')).toMatch(/Play Order Priority: T2 \(#2\) → T6 \(#6\) is the strike that eliminates player 20/);
  });

  it('without the card it still goes first, and no card is advised', () => {
    const p = killPlan();
    expect(p.moves[0]).toMatchObject({ kind: 'attack', to: 6 });
    expect(p.cardAdvice).toBeNull();
  });

  it('moving first, the card is not needed unless the opponent may hold one too', () => {
    const first = killPlan({ holdsOrderPriority: true, movesFirst: true });
    expect(first.moves[0]).toMatchObject({ kind: 'attack', to: 6 });
    expect(first.cardAdvice).toBeNull();
    const contested = killPlan({ holdsOrderPriority: true, movesFirst: true, opponentsMayHoldOrderPriority: true });
    expect(contested.cardAdvice).toBe('order-priority');
    expect(contested.rationale.join('\n')).toMatch(/may hold an Order Priority card: two cancel/);
  });
});

describe('#179 Order Priority: the commander strike when I move first but the opponent may hold one', () => {
  // My commander on T1 (3) faces T2 (20 + player 20's commander); T5 (50) kills it.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [5, 2], [1, 3], [3, 4]]));
  const b = board([withCommander(mine(1, 3), ME), withCommander(enemy(2, 20), VICTIM), mine(3, 2), neutral(4, 2), mine(5, 50)], true);
  const STRIKE: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
  it('advises it: two cards cancel, and mine keeps the strike first', () => {
    const base = { graph: g, board: b, me: ME, income: 10, settings: STRIKE };
    const known = planTurn({ ...base, options: { enemyDeploy: 5, holdsOrderPriority: true, movesFirst: true } });
    expect(known.cardAdvice).toBeNull();
    const p = planTurn({ ...base, options: { enemyDeploy: 5, holdsOrderPriority: true, movesFirst: true, opponentsMayHoldOrderPriority: true } });
    expect(attacks(p)[0]).toMatchObject({ from: 5, to: 2 });
    expect(p.cardAdvice).toBe('order-priority');
    expect(p.rationale.some((r) => r.startsWith('Order Priority is not needed for the strike'))).toBe(false);
    expect(p.rationale.join('\n')).toMatch(/may hold an Order Priority card: two cancel/);
  });
});

describe('#179 eta.eliminate: the turns to finish each visible opponent', () => {
  it('one turn when every territory is next to mine and the armies are there', () => {
    const p = killPlan();
    expect(p.eta?.eliminate[VICTIM]).toEqual({ turns: 1, atLeast: false, distance: 1, armies: expect.any(Number) });
  });

  it('more turns when the income must catch up with its deploy', () => {
    const p = planTurn({ graph: buildGraph(LD_MAP), board: KILL_BOARD, me: ME, income: 20, settings: STD });
    const eta = p.eta!.eliminate[VICTIM]!;
    expect(eta.turns).toBeGreaterThan(1);
    // Its territories' armies plus ~9 a turn for that many turns, against my armies plus 20 a turn.
    expect(eta.armies).toBeLessThanOrEqual(8 + 20 * eta.turns!);
  });

  it('never fewer turns than the steps to its farthest territory', () => {
    // 1 2 3 mine; 4 neutral; 5 the victim's, two steps from 3.
    const g = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [2, 3], [3, 4], [4, 5]]));
    const p = planTurn({ graph: g, board: board([mine(1, 30), mine(2, 30), mine(3, 30), neutral(4, 2), enemy(5, 1)]), me: ME, income: 50, settings: STD });
    expect(p.eta!.eliminate[VICTIM]).toMatchObject({ turns: 2, distance: 2, atLeast: false });
  });

  it('at least, when its land borders the fog', () => {
    const g = buildGraph(makeMap([1, 2, 3], [[1, 2], [2, 3]]));
    const b = board([mine(1, 30), enemy(2, 1), { territoryId: 3, owner: { kind: 'unknown' }, armies: null, fogLevel: 'Fogged' }]);
    const p = planTurn({ graph: g, board: b, me: ME, income: 50, settings: STD });
    expect(p.eta!.eliminate[VICTIM]).toMatchObject({ turns: 1, atLeast: true });
  });

  it('null turns when my income never catches up with its deploy', () => {
    const g = buildGraph(makeMap([1, 2], [[1, 2]]));
    const p = planTurn({ graph: g, board: board([mine(1, 2), enemy(2, 40)]), me: ME, income: 5, settings: STD, options: { enemyDeploy: 30 } });
    expect(p.eta!.eliminate[VICTIM]).toMatchObject({ turns: null });
  });
});

describe('#179 exits: an opponent down to a few territories', () => {
  // As KILL_BOARD, and my 4 (behind 3) also faces the victim's 7; 8 is a neutral next to its 6.
  const map = makeMap(
    [1, 2, 3, 4, 5, 6, 7, 8],
    [[1, 2], [2, 3], [3, 4], [1, 5], [2, 6], [3, 7], [5, 6], [6, 7], [4, 7], [6, 8]],
  );
  const b = board([mine(1, 3), mine(2, 3), mine(3, 3), mine(4, 2), enemy(5, 2), enemy(6, 6), enemy(7, 2), neutral(8, 2)]);
  const plan = (options: Parameters<typeof planTurn>[0]['options'] = {}, income = 90) =>
    planTurn({ graph: buildGraph(map), board: b, me: ME, income, settings: STD, options });
  const stays = (p: TurnPlan, id: number, start: number) =>
    start + (p.deploys.find((d) => d.territoryId === id)?.armies ?? 0) - p.moves.filter((m) => m.from === id).reduce((n, m) => n + m.armies, 0);

  it('lists each stack\'s exits: its own neighbours, the neutrals it can take, and my territories it can take', () => {
    const p = plan({ movesFirst: true }, 0);
    const ex = p.exits!.find((e) => e.player === VICTIM)!;
    expect(ex.stacks.find((x) => x.territory === 6)).toEqual({ territory: 6, movable: 5, own: [5, 7], neutrals: [8], mine: [2] });
    expect(ex.stacks.find((x) => x.territory === 7)).toMatchObject({ own: [6], mine: [3, 4] });
  });

  it('not known to move first: covers its exits onto my land while finishing it off, and says so', () => {
    const p = plan();
    expect(p.rationale.join('\n')).toMatch(/Finish off player 20/);
    expect(p.rationale.join('\n')).toMatch(/Cover player 20's exits \(#179\)/);
    // 4 attacks nothing but faces 7 (1 movable + ~5): it is held (6 attackers do not take 4).
    expect(stays(p, 4, 2)).toBeGreaterThanOrEqual(4);
    // Its stacks plus its deploy take none of my borders: the exits onto my land are closed.
    expect(p.exits!.find((e) => e.player === VICTIM)!.stacks.every((x) => x.mine.length === 0)).toBe(true);
    expect(p.warnings.join('\n')).not.toMatch(/or take T/);
    // Its flight onto the neutral is named, with who can retake it.
    expect(p.warnings.join('\n')).toMatch(/player 20's stack on T6 \(#6\) can flee onto T8 \(#8\)/);
  });

  it('known to move first: no cover is needed', () => {
    const p = plan({ movesFirst: true });
    expect(p.rationale.join('\n')).toMatch(/Finish off player 20/);
    expect(p.rationale.join('\n')).not.toMatch(/Cover player 20's exits/);
  });

  it('when covering is unaffordable, finishes it off uncovered as before, with the caveat', () => {
    const p = plan({}, 40);
    expect(p.rationale.join('\n')).toMatch(/Finish off player 20/);
    expect(p.rationale.join('\n')).not.toMatch(/Cover player 20's exits/);
    expect(p.warnings.join('\n')).toMatch(/assumes my attacks land before its own orders/);
  });
});

describe('#179 FFA: price the elimination before finishing a player off', () => {
  // 1 2 mine; 3 the victim's last territory (1 army), between my 2 and player 30's 4; 5 is player 30's too.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [2, 3], [3, 4], [4, 5]]));
  const game = { players: [{ id: ME }, { id: VICTIM }, { id: OTHER }] };
  const ffa = (otherArmies: number) =>
    planTurn({ graph: g, board: board([mine(1, 5), mine(2, 5), enemy(3, 1), enemy(4, otherArmies, OTHER), enemy(5, 1, OTHER)]), me: ME, income: 12, settings: STD, game });

  it('a buffer against a strong third player is not finished off: the frontier it opens costs more than it pays', () => {
    const p = ffa(60);
    expect(attackOn(p, 3)).toBeUndefined();
    expect(p.rationale.join('\n')).toMatch(/player 20 is a buffer in this FFA: finishing it off costs more frontier than it pays/);
    expect(p.rationale.join('\n')).toMatch(/Not finishing off player 20 \(#179\): it is a buffer: taking T3 \(#3\) makes me border player 30's T4 \(#4\)/);
  });

  it('a buffer against a weak third player is finished off, priced', () => {
    const p = ffa(1);
    expect(attackOn(p, 3)).toBeDefined();
    expect(p.rationale.join('\n')).toMatch(/Finish off player 20/);
    expect(p.rationale.join('\n')).toMatch(/Elimination price \(#179\): taking T3 \(#3\) makes me border player 30's T4 \(#4\)/);
  });

  it('a commander strike is never gated, and says who collects the land it leaves', () => {
    // The victim's commander on 3; its land turns neutral, next to player 30's 4.
    const b = board([mine(1, 5), mine(2, 30), withCommander(enemy(3, 1), VICTIM), enemy(6, 1), enemy(4, 60, OTHER), enemy(5, 1, OTHER)], true);
    const g2 = buildGraph(makeMap([1, 2, 3, 4, 5, 6], [[1, 2], [2, 3], [3, 4], [4, 5], [3, 6], [4, 6]]));
    const p = planTurn({ graph: g2, board: b, me: ME, income: 12, settings: STD, game });
    expect(attackOn(p, 3)).toBeDefined();
    expect(p.rationale.join('\n')).toMatch(/Commander kill \(#179\): player 20's land turns neutral where it stands; player 30 borders T6 \(#6\)/);
  });
});

describe('#179 cover: the hold survives the later passes', () => {
  // My 1 (4) faces the victim's 2 (13) and a cheap neutral 4 (2); my 7 (28) strikes 2. The
  // victim's stack on 2 plus its ~9 deploy can hit 1 before my strike lands: 1 is covered, and
  // no later pass (the expansion into 4 here) may spend what it keeps.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7], [[1, 2], [1, 4], [1, 5], [2, 3], [2, 6], [2, 7], [5, 7]]));
  const b = board([mine(1, 4), enemy(2, 13), neutral(3, 3), neutral(4, 2), neutral(5, 8), neutral(6, 6), mine(7, 28)]);
  const ends = (p: TurnPlan, id: number, start: number) =>
    start +
    (p.deploys.find((d) => d.territoryId === id)?.armies ?? 0) +
    p.moves.filter((m) => m.to === id && m.kind === 'transfer').reduce((n, m) => n + m.armies, 0) -
    p.moves.filter((m) => m.from === id).reduce((n, m) => n + m.armies, 0);

  it('a covered border with a cheap expansion beside it keeps what holds against the victim', () => {
    const p = planTurn({ graph: g, board: b, me: ME, income: 34, settings: STD, options: { adapt: false, enemyDeploy: 9 } });
    expect(p.rationale.join('\n')).toMatch(/Cover player 20's exits \(#179\): .*T1 \(#1\)/);
    // Its stack (12 movable) plus its ~9 deploy: 21 must not take what stays on 1.
    expect(captureCost(ends(p, 1, 4), STD)).toBeGreaterThan(21);
    expect(p.warnings.join('\n')).not.toMatch(/or take T1 \(#1\)/);
  });

  it('a covered border the triage concedes is not withdrawn from below its cover', () => {
    // 1 (4) faces the victim's 2 (1) and player 30's 3 (40): conceded against 30, covered against 20.
    const g2 = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [1, 3], [1, 4], [4, 5], [2, 5]]));
    const b2 = board([mine(1, 4), enemy(2, 1), enemy(3, 40, OTHER), mine(4, 2), mine(5, 30)]);
    const p = planTurn({ graph: g2, board: b2, me: ME, income: 10, settings: STD, options: { adapt: false, enemyDeploy: 4 } });
    expect(p.rationale.join('\n')).toMatch(/Cover player 20's exits \(#179\): .*T1 \(#1\)/);
    expect(p.conceded).toContain(1);
    // The victim's stack (0 movable) plus its ~4 deploy.
    expect(captureCost(ends(p, 1, 4), STD)).toBeGreaterThan(4);
  });
});

describe('#179 FFA: a buffer left standing is not taken by any pass', () => {
  // Player 40's 1 (0 armies) is a buffer between my 7 and 9 and player 30's 2 (19). My army lead
  // is over 3×, so the #167 lead strike would take it from 9: the buffer gate holds there too.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      [[1, 2], [1, 7], [1, 9], [2, 3], [2, 4], [2, 10], [3, 5], [3, 8], [3, 6], [5, 6], [6, 11], [6, 13], [9, 12], [10, 13]],
    ),
  );
  const b = board(
    [
      enemy(1, 0, 40),
      enemy(2, 19, OTHER),
      neutral(3, 1),
      neutral(4, 2),
      enemy(5, 21, OTHER),
      enemy(6, 4, OTHER),
      mine(7, 64),
      enemy(8, 14),
      mine(9, 72),
      neutral(10, 6),
      neutral(11, 2),
      mine(12, 64),
      enemy(13, 7),
    ],
    true,
  );
  const game = { players: [{ id: ME }, { id: VICTIM }, { id: OTHER }, { id: 40 }], turn: 22, commanders: true };
  const settings: PlannerSettings = { offensiveKillRate: 70, defensiveKillRate: 70, oneArmyStandsGuard: true };

  it('the army-lead strike skips it', () => {
    const p = planTurn({ graph: g, board: b, me: ME, income: 9, settings, game, options: { adapt: true, enemyDeploy: 2 } });
    expect(p.rationale.join('\n')).toMatch(/Not finishing off player 40 \(#179\): it is a buffer/);
    // The frontier delta is shown in whole armies.
    expect(p.rationale.join('\n')).toMatch(/the frontier's hold cost changes by \+\d+ armies/);
    expect(p.rationale.join('\n')).toMatch(/FFA army lead/);
    expect(attackOn(p, 1)).toBeUndefined();
    // Nor is it offered as the capture the plan stands still without.
    expect(p.warnings.join('\n')).not.toMatch(/cheapest capture \(T1 \(#1\)/);
  });
});

describe('#179 Order Priority for the kill: no minimum armies, and never for a wear-down attack', () => {
  it('a small killing strike still gets the card', () => {
    // My 1 (20) kills the victim's last territory 2 (1) with 3, under ORDER_PRIORITY_MIN_ARMIES.
    const g = buildGraph(makeMap([1, 2, 3], [[1, 2], [1, 3]]));
    const b = board([mine(1, 20), enemy(2, 1), neutral(3, 2)]);
    const p = planTurn({ graph: g, board: b, me: ME, income: 5, settings: STD, options: { enemyDeploy: 1, holdsOrderPriority: true } });
    expect(p.rationale.join('\n')).toMatch(/Finish off player 20/);
    expect(p.moves[0]).toMatchObject({ kind: 'attack', from: 1, to: 2 });
    expect(p.moves[0]!.armies).toBeLessThan(5);
    expect(p.cardAdvice).toBe('order-priority');
    expect(p.rationale.join('\n')).toMatch(/Play Order Priority: T1 \(#1\) → T2 \(#2\) is the strike that eliminates player 20/);
  });

  it('a kill by a combined capture: the card cannot secure it, and says so', () => {
    // The victim's last territory 3 is taken by 1 wearing it down and 2 finishing it: the card
    // protects only my first order, the wear-down, which takes nothing.
    const g = buildGraph(makeMap([1, 2, 3, 4], [[1, 3], [2, 3], [1, 2], [1, 4]]));
    for (const mine1 of [4, 6]) {
      const b = board([mine(1, mine1), mine(2, 14), enemy(3, 6), neutral(4, 2)]);
      const p = planTurn({ graph: g, board: b, me: ME, income: 0, settings: STD, options: { enemyDeploy: 3, holdsOrderPriority: true } });
      expect(p.rationale.join('\n')).toMatch(/Finish off player 20/);
      expect(p.multiSourceCaptures).toEqual([3]);
      expect(p.cardAdvice).toBeNull();
      expect(p.warnings.join('\n')).toMatch(
        /The strike that eliminates player 20 is a combined capture of T3 \(#3\) \(2 attacks that must run in order\): Order Priority moves only my first order ahead, so it cannot secure the kill/,
      );
    }
  });
});
