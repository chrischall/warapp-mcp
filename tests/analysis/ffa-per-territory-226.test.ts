// #226: an FFA opponent's deploy was estimated at base income when income is per territory, and
// strikes were sized to the exact kill count with idle armies to spare. Five fixes:
//  (a) per-territory income: an opponent's floor counts its visible territories at the rate, and
//      the most it could earn counts every territory it could hold (visible, or one the fog hides),
//      so a prior or an observation is not capped back down to the base;
//  (b) the fog prior (#119) in an even-start free-for-all with no teams, every player still in;
//  (c) a margin on an attack on a player from armies that would otherwise sit idle on its source;
//  (d) my failed attack's kills count back into the defender's observed deploy;
//  (e) a large fog reveal in a per-territory game is named in a warning (still not income).
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import {
  enemyDeployEstimates,
  observeDeploy,
  planTurn,
  type PlanInput,
  type PlannerSettings,
} from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { SYNTHETIC_COUNT, syntheticInput } from './golden/corpus.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const A = 20;
const B = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const PER: PlannerSettings = { ...STD, baseIncome: 5, bonusArmyPer: 1 };

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

const enemy = (territoryId: number, armies: number, playerId = A): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

// My T1–T12 in a line (+6 bonus on T1–T3): 12 territories at one army each plus 6 = 18 a turn.
// Player A shows T13 (100) and T14 (30) beside the fog; player B shows T15 (40) beside the fog.
// T21–T32 are fogged (12 territories, a +10 bonus on T25–T26 among them).
const ids = [...Array.from({ length: 15 }, (_, i) => i + 1), ...Array.from({ length: 12 }, (_, i) => i + 21)];
const edges: [number, number][] = [
  ...Array.from({ length: 11 }, (_, i): [number, number] => [i + 1, i + 2]),
  [12, 13],
  [13, 14],
  [14, 21],
  [11, 15],
  [15, 22],
  ...Array.from({ length: 11 }, (_, i): [number, number] => [i + 21, i + 22]),
];
const g = buildGraph(makeMap(ids, edges, [[901, 6, [1, 2, 3]], [902, 10, [25, 26]]]));
const myStacks = Array.from({ length: 12 }, (_, i) => mine(i + 1, i === 11 ? 60 : i === 10 ? 40 : 3));
const fog = Array.from({ length: 12 }, (_, i) => fogged(i + 21));
const s = board([...myStacks, enemy(13, 100), enemy(14, 30), enemy(15, 40, B), ...fog]);
const players = [{ id: ME }, { id: A }, { id: B }];
const ffaInput = (over: Partial<PlanInput> = {}): PlanInput => ({
  graph: g,
  board: s,
  me: ME,
  income: 18,
  settings: PER,
  turn: 6,
  game: { players, turn: 6, symmetricStart: true },
  options: { adapt: true },
  ...over,
});

describe('(a) per-territory income: what an opponent could earn counts the territories the fog may hide', () => {
  it('its floor counts its visible territories at the rate', () => {
    const many = board([...myStacks, ...[13, 14, 21, 22, 23, 24, 25, 26].map((t) => enemy(t, 5)), enemy(15, 40, B), ...fog.slice(6)]);
    const [a] = enemyDeployEstimates(g, many, ME, PER);
    expect(a).toMatchObject({ playerId: A, held: 8, base: 8, estimate: 8 + 10 });
  });

  it('the most it could earn counts its visible and every fogged territory at the rate, not the base alone', () => {
    const [a, b] = enemyDeployEstimates(g, s, ME, PER, undefined, undefined, { myIncome: 18 });
    // A: 2 visible + 12 fogged = 14 territories at one army each, plus the +10 it could hold.
    expect(a).toMatchObject({ playerId: A, base: 5, couldEarn: 24, prior: 18, estimate: 18, source: 'prior' });
    expect(b).toMatchObject({ playerId: B, base: 5, couldEarn: 23, prior: 18, estimate: 18, source: 'prior' });
  });

  it('a game without per-territory income is unchanged: the base and the bonuses it could hold', () => {
    const [a] = enemyDeployEstimates(g, s, ME, { ...STD, baseIncome: 5 }, undefined, undefined, { myIncome: 18 });
    expect(a).toMatchObject({ couldEarn: 15, prior: 15 });
  });
});

describe('(b) the fog prior in an even-start free-for-all with no teams', () => {
  it('each opponent beside the fog is estimated at my own income, named a prior', () => {
    const p = planTurn(ffaInput());
    const text = p.warnings.join('\n');
    expect(text).toMatch(
      /Enemy deploy estimate for player 20: ~18 \(a prior, not an observation: in a free-for-all that started even \(no teams, every player still in\), an opponent bordering the fog is assumed to earn at least my own income 18, capped at the most it could earn on this board, 24;/,
    );
    expect(p.enemyDeploy).toBe(18);
  });

  it('card armies are not income: the prior is what I earn', () => {
    expect(planTurn(ffaInput({ income: 28, cardArmies: 10 })).enemyDeploy).toBe(18);
  });

  it('not with teams, not once a player is out, not without an even start', () => {
    const teams = [
      { id: ME, team: 0 },
      { id: A, team: 1 },
      { id: B, team: 1 },
    ];
    expect(planTurn(ffaInput({ game: { players: teams, turn: 6, symmetricStart: true } })).warnings.join('\n')).not.toMatch(/a prior/);
    const out = [...players, { id: 40, state: 'Eliminated' }];
    expect(planTurn(ffaInput({ game: { players: out, turn: 6, symmetricStart: true } })).warnings.join('\n')).not.toMatch(/a prior/);
    expect(planTurn(ffaInput({ game: { players, turn: 6, symmetricStart: false } })).warnings.join('\n')).not.toMatch(/a prior/);
  });

  it('a player that never took its seat does not count as out', () => {
    const declined = [...players, { id: 40, state: 'Declined' }];
    expect(planTurn(ffaInput({ game: { players: declined, turn: 6, symmetricStart: true } })).enemyDeploy).toBe(18);
  });

  it('not for an opponent with nothing beside the fog', () => {
    const open = board([...myStacks, enemy(13, 100), enemy(14, 30), enemy(15, 40, B), ...fog.map((t) => neutral(t.territoryId, 2))]);
    const p = planTurn(ffaInput({ board: open }));
    expect(p.warnings.join('\n')).not.toMatch(/a prior/);
  });
});

describe('(d) my failed attack: its kills count back into the defender observed deploy', () => {
  // My T1 (600) attacked the opponent's T2 (131) with 470 and failed; T2 shows 199 now.
  const small = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [2, 3], [1, 4]], []));
  const before = board([mine(1, 600), enemy(2, 131), neutral(3, 2), mine(4, 3)]);
  const after = board([mine(1, 130), enemy(2, 199), neutral(3, 2), mine(4, 3)]);
  const orders = { deploys: [], moves: [{ from: 1, to: 2, armies: 470 }] };

  it('defenders after = before + deploy - kills: 199 + 282 - 131 = 350, named as my attack', () => {
    const o = observeDeploy(small, after, before, A, STD, { me: ME, myOrders: orders });
    expect(o).toMatchObject({ deploy: 350, attacked: [2], attackKills: 282 });
    // Without my orders, the net change only.
    expect(observeDeploy(small, after, before, A, STD, { me: ME }).deploy).toBe(68);
  });

  it('a source that fell this turn measures nothing', () => {
    const lost = board([enemy(1, 50), enemy(2, 199), neutral(3, 2), mine(4, 3)]);
    expect(observeDeploy(small, lost, before, A, STD, { me: ME, myOrders: orders }).attackKills).toBe(0);
  });

  it('beside the fog the kills are ambiguous growth, read as deploy only up to the #123 bound', () => {
    const fogGraph = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [2, 3], [1, 4]], []));
    const b0 = board([mine(1, 600), enemy(2, 131), fogged(3), mine(4, 3)]);
    const b1 = board([mine(1, 130), enemy(2, 199), fogged(3), mine(4, 3)]);
    const low = observeDeploy(fogGraph, b1, b0, A, STD, { me: ME, myOrders: orders, expected: 20, most: 1000 });
    expect(low).toMatchObject({ deploy: 40, attackKills: 282, grewFromFog: [2], fogGrowth: 310 });
    const high = observeDeploy(fogGraph, b1, b0, A, STD, { me: ME, myOrders: orders, expected: 394, most: 1000 });
    expect(high).toMatchObject({ deploy: 350, grewFromFog: [] });
  });

  it('the plan reads it from the orders I sent last turn, and says so', () => {
    const p = planTurn({
      graph: small,
      board: after,
      previousBoard: before,
      previousOrders: orders,
      me: ME,
      income: 5,
      settings: STD,
      turn: 5,
    });
    expect(p.rationale.join('\n')).toMatch(/my failed attack on T2 \(#2\) killed ~282 of its defenders/);
    // With no fog on this board it could earn only its base, so the figure is capped there.
    expect(p.warnings.join('\n')).toMatch(/player 20 was observed to deploy \+350\/turn, more than it could earn on this board/);
  });
});

describe('(e) a large fog reveal in a per-territory game is named, still not income', () => {
  // Last turn T13 and T14 were fogged; this turn they show A's 313 and 293.
  const before = board([...myStacks, fogged(13), fogged(14), enemy(15, 40, B), ...fog]);
  const now = board([...myStacks, enemy(13, 313), enemy(14, 293), enemy(15, 40, B), ...fog]);

  it('the warning names the revealed armies against the floor', () => {
    const p = planTurn(ffaInput({ board: now, previousBoard: before, game: { players, turn: 6 } }));
    expect(p.warnings.join('\n')).toMatch(
      /Player 20: 606 armies came into view on 2 territories \(fog reveals, not income\); with income per territory, stacks that size say it holds more territories than the 2 in view/,
    );
  });

  it('not in a game without per-territory income', () => {
    const p = planTurn(ffaInput({ board: now, previousBoard: before, settings: { ...STD, baseIncome: 5 }, game: { players, turn: 6 } }));
    expect(p.warnings.join('\n')).not.toMatch(/came into view/);
  });
});

describe('(c) a margin on an attack on a player from armies that would sit idle on its source', () => {
  // My T1 (534) beside player A's T2 (131) of its visible +5 bonus {T2, T3}; my rear T4 (3); fog past T3.
  const m = buildGraph(makeMap([1, 2, 3, 4, 5, 6], [[1, 2], [2, 3], [1, 4], [3, 5], [1, 6]], [[900, 5, [2, 3]]]));
  const plan = (cells: TerritoryState[], settings: PlannerSettings = STD) =>
    planTurn({
      graph: m,
      board: board(cells),
      me: ME,
      income: 20,
      settings,
      turn: 4,
      options: { adapt: true },
      game: { players, turn: 4 },
    });
  const base = [mine(1, 534), enemy(2, 131), enemy(3, 10), mine(4, 3), fogged(5)];

  it('the break sized at the estimate takes the idle armies on its source, and says what it now covers', () => {
    const p = plan([...base, mine(6, 3)]);
    const attack = p.moves.find((x) => x.from === 1 && x.to === 2)!;
    // 534 + 20 deployed − the guard, less what holds T1 if the attack fails (#128: 131 + ~10 beside it).
    const left = 534 + 20 - attack.armies;
    expect(attack.armies).toBe(469);
    expect(armiesToTake(left, STD)).toBeGreaterThan(130 + 10);
    expect(p.rationale.join('\n')).toMatch(
      /Margin on the attack on T2 \(#2\) from T1 \(#1\) \(#226\): up from 235 to 469 with the 234 armies that would otherwise sit idle there \(no hold needs them, even if the attack fails\): 469 take it even if player 20 deploys up to \d+ there first, against the ~10 estimate, which is a floor\./,
    );
  });

  it('what holds the source against another stack stays', () => {
    const p = plan([...base, enemy(6, 60, B)]);
    const attack = p.moves.find((x) => x.from === 1 && x.to === 2);
    expect(attack).toBeDefined();
    const sent = p.moves.filter((x) => x.from === 1).reduce((n, x) => n + x.armies, 0);
    const deployed = p.deploys.filter((d) => d.territoryId === 1).reduce((n, d) => n + d.armies, 0);
    const stays = 534 + deployed - sent;
    // Player B's 60 next to T1 plus its deploy: what stays must still beat that attack.
    expect(armiesToTake(stays, STD)).toBeGreaterThan(59 + 5);
    // The margin still went in: T2 gets more than the 235 its #120 size needs.
    expect(attack!.armies).toBeGreaterThan(235);
  });

  it('No-Split sends the whole stack already: no margin line', () => {
    const p = plan([...base, mine(6, 3)], { ...STD, noSplit: true });
    expect(p.rationale.join('\n')).not.toMatch(/Margin on the attack/);
  });
});

describe('(d) a sweep over the golden corpus with my failed attacks added', () => {
  // Every corpus input with a previous board gets orders: from each territory of mine on both
  // boards, an attack with all but one of its armies then on each opponent territory beside it that
  // stayed the opponent's. The path must fire, never lower an estimate, and never break a plan.
  it('fires on many boards, only ever raises an observation, and every plan still plans', () => {
    let boards = 0;
    let fired = 0;
    for (let i = 0; i < SYNTHETIC_COUNT; i += 2) {
      const input = syntheticInput(i);
      const prev = input.previousBoard;
      if (!prev) continue;
      const was = new Map(prev.territories.map((t) => [t.territoryId, t]));
      const now = new Map(input.board.territories.map((t) => [t.territoryId, t]));
      const isMine = (t: TerritoryState | undefined) => t?.owner.kind === 'player' && t.owner.playerId === input.me && t.armies !== null;
      const moves: { from: number; to: number; armies: number }[] = [];
      for (const [id, t] of was) {
        if (!isMine(t) || !isMine(now.get(id)) || !input.graph.territoryById.has(id)) continue;
        for (const n of input.graph.territoryById.get(id)!.connectedTo) {
          const a = was.get(n);
          const b = now.get(n);
          if (a?.owner.kind === 'player' && b?.owner.kind === 'player' && a.owner.playerId !== input.me && a.owner.playerId === b.owner.playerId)
            moves.push({ from: id, to: n, armies: Math.max(1, t.armies! - 1) });
        }
      }
      if (!moves.length) continue;
      boards++;
      const orders = { deploys: [], moves };
      const without = enemyDeployEstimates(input.graph, input.board, input.me, input.settings, prev);
      const withOrders = enemyDeployEstimates(input.graph, input.board, input.me, input.settings, prev, undefined, undefined, { previousOrders: orders });
      for (const e of withOrders) {
        const w = without.find((x) => x.playerId === e.playerId)!;
        expect(e.observedRaw!).toBeGreaterThanOrEqual(w.observedRaw!);
        expect(e.observed!).toBeLessThanOrEqual(e.observedCap!);
        if (e.observation!.attackKills > 0) fired++;
      }
      const plan = planTurn({ ...input, previousOrders: orders });
      expect(plan.deploys.reduce((n, d) => n + d.armies, 0)).toBeLessThanOrEqual(input.income);
    }
    expect(boards).toBeGreaterThan(50);
    expect(fired).toBeGreaterThan(50);
  }, 120_000);
});
