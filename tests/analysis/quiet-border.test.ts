// A quiet border (owner request 2026-11-28): in a free-for-all a 24-army stack guarding a bonus sat a whole
// turn against an opponent that had put 0 or 1 armies beside my land for three turns, because its border was
// sized for that opponent's whole fog-prior deploy (~44). An opponent whose last 3 observed turns, in a row and
// ending at its newest board, each grew a stack beside my land by at most 1 is read like #420's quiet
// neighbour: every border facing it is sized at its stacks there plus its largest top-up seen, so what stands
// above that goes to captures; its most valuable border still holds against half the deploy (the next turn, the
// opponent put ~12 of a ~17 deploy beside that stack). The board below is the corner of that game in miniature (ids from the real
// map, the rest made up): T232 the stack, T214 the opponent's stack of 2, T215 and T216 neutrals of 1.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { trackOpponents, type TurnBoard } from '../../src/analysis/opponents.js';
import { QUIET_DEPLOY_MAX, QUIET_DEPLOY_SHARE, QUIET_DEPLOY_TURNS, quietBorder, quietFloor } from '../../src/analysis/plan/threats.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const FAR = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, luckModifier: 0, roundingMode: 'StraightRound' };

describe('quietBorder: the last 3 observed turns, in a row and fresh, each at most 1 beside my land', () => {
  const t = (from: number, topUp?: number) => ({ from, to: from + 1, ...(topUp !== undefined ? { topUp } : {}) });
  it('reads a quiet run', () => {
    expect(QUIET_DEPLOY_TURNS).toBe(3);
    expect(QUIET_DEPLOY_MAX).toBe(1);
    expect(QUIET_DEPLOY_SHARE).toBe(0.5);
    expect([quietFloor(39), quietFloor(44), quietFloor(-3)]).toEqual([20, 22, 0]);
    expect(quietBorder({ lastTurn: 7, turns: [t(3, 5), t(4, 1), t(5, 0), t(6, 0)] })).toEqual({ deployTurns: 3, most: 1 });
  });
  it('refuses a short, loud, broken, stale or unread run', () => {
    expect(quietBorder({ lastTurn: 7, turns: [t(5, 0), t(6, 0)] })).toBeNull();
    expect(quietBorder({ lastTurn: 7, turns: [t(4, 2), t(5, 0), t(6, 0)] })).toBeNull();
    expect(quietBorder({ lastTurn: 7, turns: [t(3, 0), t(5, 0), t(6, 0)] })).toBeNull();
    expect(quietBorder({ lastTurn: 7, turns: [t(4, 0), t(5, 0), { from: 6, to: 8, topUp: 0 }] })).toBeNull();
    expect(quietBorder({ lastTurn: 8, turns: [t(4, 0), t(5, 0), t(6, 0)] })).toBeNull();
    expect(quietBorder({ lastTurn: 7, turns: [t(4, 0), t(5), t(6, 0)] })).toBeNull();
  });
});

const edges: [number, number][] = [
  [232, 228], [232, 229], [232, 230], [232, 231], [228, 229], [228, 233], [229, 230], [230, 231],
  [232, 214], [232, 215], [232, 216], [215, 216], [215, 217], [216, 217], [214, 217],
  [233, 262], [233, 263], [262, 263], [231, 300], [300, 301], [301, 302], [228, 501], [501, 500],
  [214, 400], [263, 401], [217, 402],
  ...Array.from({ length: 40 }, (_, i) => [400 + i, 401 + i] as [number, number]),
];
const ids = [...new Set(edges.flat())].sort((a, b) => a - b);
const map: GameMap = {
  id: 1,
  name: 'Corner',
  territories: ids.map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
  })),
  bonuses: [
    { id: 53, name: 'B53', value: 4, territoryIds: [228, 229, 230, 231, 232, 233], bonusIds: [] },
    { id: 54, name: 'B54', value: 4, territoryIds: [214, 215, 216, 217], bonusIds: [] },
    { id: 29, name: 'B29', value: 3, territoryIds: [500, 501], bonusIds: [] },
    { id: 27, name: 'B27', value: 3, territoryIds: [262, 263], bonusIds: [] },
    ...Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, name: `H${i}`, value: 10, territoryIds: [400 + 4 * i, 401 + 4 * i, 402 + 4 * i, 403 + 4 * i], bonusIds: [] })),
  ],
  distributionModes: [],
};
const g = buildGraph(map);
const player = (territoryId: number, playerId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId }, armies });
const fog = Array.from({ length: 41 }, (_, i): TerritoryState => ({ territoryId: 400 + i, owner: { kind: 'unknown' }, armies: null }));
/** The board with the opponent's stack on T214 at `costa` (and T232's 24 beside it). */
const at = (costa: number, stack = 24) =>
  board([
    mine(228, 1), mine(229, 1), mine(230, 1), mine(231, 1), mine(232, stack), mine(233, 2), mine(501, 1),
    player(214, FOE, costa), neutral(215, 1), neutral(216, 1), neutral(217, 1), player(262, FOE, 1), player(263, FOE, 1),
    neutral(300, 1), neutral(301, 1), player(302, FAR, 3), neutral(500, 14), ...fog,
  ]);
/** Turns 4 → 7; T214 grows by `growth[i]` each turn. */
const history = (growth: number[]): TurnBoard[] => {
  let c = 1;
  return [4, 5, 6, 7].map((turn, i) => {
    if (i > 0) c += growth[i - 1]!;
    return { turn, board: at(c) };
  });
};
const plan = (h: TurnBoard[], over: Partial<PlanInput> = {}): TurnPlan =>
  planTurn({
    graph: g,
    board: h[3]!.board,
    previousBoard: h[2]!.board,
    me: ME,
    income: 42,
    settings: STD,
    turn: 7,
    tracks: trackOpponents(g, h, ME, STD),
    // The opponent's estimate as the game had it, from the fog (a known income stands in for the prior).
    knownIncome: [{ player: FOE, income: 39 }],
    game: { players: [{ id: ME }, { id: FOE }, { id: FAR }], turn: 7, symmetricStart: true },
    options: { adapt: true },
    ...over,
  });
const sentFrom = (p: TurnPlan, from: number) => p.moves.filter((m) => m.from === from).reduce((n, m) => n + m.armies, 0);
const deployedTo = (p: TurnPlan, id: number) => p.deploys.filter((d) => d.territoryId === id).reduce((n, d) => n + d.armies, 0);

describe('the Italy corner: a stack beside a quiet border spreads its surplus', () => {
  const quiet = history([1, 0, 0]);
  it('sends what stands above the quiet threat into the neighbours, and deploys nothing there', () => {
    const p = plan(quiet);
    expect(p.moves.filter((m) => m.from === 232 && m.kind === 'attack').map((m) => m.to).sort()).toEqual([214, 215, 216]);
    // Main sends 3 and keeps 38. The floor keeps what holds against its stack plus half the ~39 (2 + 20 attackers).
    expect(sentFrom(p, 232)).toBe(10);
    expect(deployedTo(p, 232)).toBe(0);
    expect(24 - sentFrom(p, 232)).toBe(14);
    expect(p.rationale.join('\n')).toContain(
      'Player 20 has put at most 1 army beside my land in each of its last 3 turns (a quiet border, owner request 2026-11-28): T232 (#232), T233 (#233) are sized at its stack beside them plus its largest top-up seen, +1, not its ~39 deploy (T232 (#232), its most valuable, against half of it, 20)',
    );
  });

  it('an opponent that built up beside me keeps the full deploy on that border, and the stack stays', () => {
    const p = plan(history([1, 3, 0]));
    expect(p.rationale.join('\n')).not.toContain('a quiet border');
    // What stays on T232 after its orders: held against the whole ~39 deploy.
    expect(24 + deployedTo(p, 232) - sentFrom(p, 232)).toBeGreaterThanOrEqual(30);
  });

  it('two turns of evidence are not enough, nor an explicit enemy deploy', () => {
    const short = history([1, 0, 0]).slice(1);
    const p = planTurn({
      graph: g, board: short[2]!.board, previousBoard: short[1]!.board, me: ME, income: 42, settings: STD, turn: 7,
      tracks: trackOpponents(g, short, ME, STD), knownIncome: [{ player: FOE, income: 39 }],
      game: { players: [{ id: ME }, { id: FOE }, { id: FAR }], turn: 7, symmetricStart: true }, options: { adapt: true },
    });
    expect(p.rationale.join('\n')).not.toContain('a quiet border');
    expect(plan(quiet, { options: { adapt: true, enemyDeploy: 39 } }).rationale.join('\n')).not.toContain('a quiet border');
  });
});
