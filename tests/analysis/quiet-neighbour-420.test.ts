// #420 (owner decision of 2026-11-20, "Rule P1 is amended for one case only"): the planner may read a
// neighbour's profile when it has 10 or more observed contact turns with an attack rate of 0.1 or less.
// That neighbour's borders are sized at its visible stack plus its largest seen top-up, until its first
// attack on me, which restores full sizing at once. Every other habit stays inform-only.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { quietNeighbour, QUIET_CONTACT_TURNS, type ObservedPrimitives, type TurnPrimitives } from '../../src/analysis/opponent-profile.js';
import { trackOpponents, type TurnBoard } from '../../src/analysis/opponents.js';
import { planTurn, type PlanInput, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { profileGamePath } from '../../src/profile-store.js';
import { quietNeighbours } from '../../src/tools/profile-hook.js';
import { board, mine } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

const prim = (over: Partial<TurnPrimitives> = {}): TurnPrimitives => ({
  contact: true,
  attackedMe: false,
  iAttacked: false,
  reinforce: { n: 0, e: 0, extra: 0 },
  stack: null,
  tookFromMe: [],
  lostToMe: [],
  ...over,
});
/** Turns 1..n in contact, attacking me on the turns listed. */
const turns = (n: number, attacks: number[] = [], untold: number[] = []): ObservedPrimitives[] =>
  Array.from({ length: n }, (_, i) => ({
    turn: i + 1,
    primitives: prim({ attackedMe: untold.includes(i + 1) ? null : attacks.includes(i + 1) }),
  }));

describe('#420: quietNeighbour reads the one profile hook P1 allows', () => {
  it('10 contact turns told with no attack: quiet', () => {
    expect(QUIET_CONTACT_TURNS).toBe(10);
    expect(quietNeighbour(turns(10))).toMatchObject({ contactTurns: 10, attacks: 0, quiet: true, since: 10 });
  });

  it('9 told turns are too few; a turn that cannot be told or out of contact is no contact turn', () => {
    expect(quietNeighbour(turns(9)).quiet).toBe(false);
    expect(quietNeighbour(turns(10, [], [4])).quiet).toBe(false);
    const away = [...turns(9), { turn: 10, primitives: prim({ contact: false }) }];
    expect(quietNeighbour(away)).toMatchObject({ contactTurns: 9, quiet: false });
  });

  it('one attack in its first 10 turns qualifies at 0.1; a second in 11 turns does not', () => {
    expect(quietNeighbour(turns(10, [3])).quiet).toBe(true);
    expect(quietNeighbour(turns(11, [3, 5])).quiet).toBe(false);
  });

  it('its first attack after it qualified restores full sizing at once, and for good', () => {
    const r = quietNeighbour(turns(14, [12]));
    expect(r).toMatchObject({ quiet: false, since: 10, attackedOn: 12 });
    // Still 1 in 14 (≤ 0.1 would not hold anyway at 2 in 14, but one is enough).
    expect(quietNeighbour(turns(30, [12])).quiet).toBe(false);
  });
});

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
const foe = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: FOE }, armies });

// My +5 B901 {1, 2}: T1 faces the opponent's T4, its one border with me. Its +6 B902 {4, 5, 6} in view.
const g = buildGraph(makeMap([1, 2, 4, 5, 6], [[1, 2], [1, 4], [4, 5], [5, 6]], [[901, 5, [1, 2]], [902, 6, [4, 5, 6]]]));
const turn = (t: number, four: number): TurnBoard => ({ turn: t, board: board([mine(1, 6), mine(2, 1), foe(4, four), foe(5, 1), foe(6, 1)]) });
// Its stack beside me grew by 2 at most.
const tracks = trackOpponents(g, [turn(1, 4), turn(2, 6), turn(3, 6)], ME, STD);
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  graph: g,
  board: turn(4, 6).board,
  me: ME,
  income: 12,
  settings: STD,
  turn: 4,
  tracks,
  game: { players: [{ id: ME }, { id: FOE }], turn: 4 },
  ...over,
});

describe('#420: a quiet neighbour is sized at its stack plus its largest top-up', () => {
  it('its one border, even its most valuable, takes its stack plus the top-up, with a line saying why', () => {
    const p = planTurn(input({ quiet: [{ player: FOE, contactTurns: 12, attacks: 0 }] }));
    const line = p.rationale.find((r) => r.includes('(#420') && r.includes('has not attacked'));
    expect(line).toBeDefined();
    expect(line).toContain('12 contact turns');
    expect(line).toContain('+2');
    // T1: 5 movable + 2 = 7; 6 armies hold against 7. Against the full 9, 14 take it.
    expect(p.warnings.some((w) => w.startsWith('T1 (#1)') && w.includes('could be taken'))).toBe(false);
  });

  it('not marked quiet (or under an explicit enemy deploy), the border keeps the full deploy', () => {
    expect(planTurn(input()).warnings.some((w) => w.startsWith('T1 (#1)') && w.includes('could be taken'))).toBe(true);
    const custom = planTurn(input({ quiet: [{ player: FOE, contactTurns: 12, attacks: 0 }], options: { enemyDeploy: 9 } }));
    expect(custom.warnings.some((w) => w.startsWith('T1 (#1)') && w.includes('could be taken'))).toBe(true);
  });

  it('with no top-up seen (no track), a quiet neighbour keeps the full deploy', () => {
    const p = planTurn(input({ tracks: [], quiet: [{ player: FOE, contactTurns: 12, attacks: 0 }] }));
    expect(p.rationale.some((r) => r.includes('has not attacked'))).toBe(false);
  });
});

describe('#420: the tool reads the quiet neighbours from the kept turns and the boards in hand', () => {
  const dir = mkdtempSync(join(tmpdir(), 'warapp-quiet-'));
  const GAME = 77;
  const keep = (byTurn: Record<number, TurnPrimitives>) => {
    mkdirSync(join(dir, 'profiles', 'games'), { recursive: true });
    const t: Record<string, Record<string, TurnPrimitives>> = {};
    for (const [n, p] of Object.entries(byTurn)) t[n] = { [String(FOE)]: p };
    writeFileSync(profileGamePath(dir, GAME, ME), JSON.stringify({ version: 1, gameId: GAME, playerId: ME, turns: t }));
  };
  const kept = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, prim()]));
  // Turn 11 → 12 on the boards in hand: T4 (2 armies) beside my T1 (6); it took T1? No: it stood still.
  const quietBoards: TurnBoard[] = [
    { turn: 11, board: board([mine(1, 6), mine(2, 1), foe(4, 2), foe(5, 1), foe(6, 1)]), orders: { deploys: [], moves: [], sent: [], cards: [] } },
    { turn: 12, board: board([mine(1, 6), mine(2, 1), foe(4, 2), foe(5, 1), foe(6, 1)]) },
  ];

  it('10 kept quiet turns: quiet', async () => {
    keep(kept);
    const q = await quietNeighbours({ dataDir: dir, env: {}, gameId: GAME, me: ME, graph: g, settings: STD, opponents: [FOE], boards: [], teamsKnown: true });
    expect(q).toEqual([{ player: FOE, contactTurns: 10, attacks: 0 }]);
  });

  it('an attack on the boards in hand, not yet kept, restores full sizing at once', async () => {
    keep(kept);
    const attacked: TurnBoard[] = [
      { turn: 11, board: board([mine(1, 6), mine(2, 1), foe(4, 9), foe(5, 1), foe(6, 1)]), orders: { deploys: [], moves: [], sent: [], cards: [] } },
      { turn: 12, board: board([foe(1, 3), mine(2, 1), foe(4, 1), foe(5, 1), foe(6, 1)]) },
    ];
    const q = await quietNeighbours({ dataDir: dir, env: {}, gameId: GAME, me: ME, graph: g, settings: STD, opponents: [FOE], boards: attacked, teamsKnown: true });
    expect(q).toEqual([]);
    const still = await quietNeighbours({ dataDir: dir, env: {}, gameId: GAME, me: ME, graph: g, settings: STD, opponents: [FOE], boards: quietBoards, teamsKnown: true });
    expect(still).toEqual([{ player: FOE, contactTurns: 11, attacks: 0 }]);
  });

  it('nothing with profiling off, no data dir, or the teams unknown', async () => {
    keep(kept);
    const base = { gameId: GAME, me: ME, graph: g, settings: STD, opponents: [FOE], boards: [] as TurnBoard[] };
    expect(await quietNeighbours({ ...base, dataDir: dir, env: { WARAPP_PLAYER_PROFILE: 'off' }, teamsKnown: true })).toEqual([]);
    expect(await quietNeighbours({ ...base, dataDir: undefined, env: {}, teamsKnown: true })).toEqual([]);
    expect(await quietNeighbours({ ...base, dataDir: dir, env: {}, teamsKnown: false })).toEqual([]);
  });
});
