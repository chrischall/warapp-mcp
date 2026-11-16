// #275 review: the tripwire's stock bound (every start plus every turn's estimate) counted a turn whose
// estimate was not kept at today's figure. Once a visible bonus break has lowered the estimate, armies an
// opponent honestly earned early on and banked under the fog walk out and read as broken income. The
// stock bounds a stack only with every turn kept; a turn not kept stands in at the most it was kept at.
// And my own Gift of a territory is no capture. Synthetic map and ids only.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../src/board.js';
import { buildGraph } from '../src/analysis/graph.js';
import type { EnemyDeployEstimate } from '../src/analysis/plan/shared.js';
import type { TurnBoard } from '../src/analysis/opponents.js';
import type { GameMap, GameSettings } from '../src/normalize.js';
import { readTripwires } from '../src/tools/survival.js';
import { writeSurvival } from '../src/trend.js';
import { board, fogged, mine } from './analysis/helpers.js';

const ME = 10;
const FOE = 20;
const STD = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, multiAttack: false };
const line = (n: number): GameMap => ({
  id: 1,
  name: 'Line',
  territories: Array.from({ length: n }, (_, i) => i + 1).map((id) => ({ id, name: `T${id}`, connectedTo: [id - 1, id + 1].filter((x) => x >= 1 && x <= n) })),
  bonuses: [],
  distributionModes: [],
});
const MAP = line(4);
const foe = (id: number, armies: number): TerritoryState => mine(id, armies, FOE);
const EVEN = { cards: [], territoryLimit: 2, initialPlayerArmiesPerTerritory: 5, distributionMode: 0, raw: {} } as unknown as GameSettings;

async function dirWith(kept: Record<number, number>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'warapp-tripwire-kept-'));
  for (const [turn, e] of Object.entries(kept)) await writeSurvival(dir, 1, ME, Number(turn), { estimates: new Map([[FOE, e]]), tripwires: [] });
  return dir;
}

const read = (dataDir: string | undefined, boards: TurnBoard[], turn: number, o: { map?: GameMap; gameSettings?: GameSettings; now?: number } = {}) =>
  readTripwires({
    dataDir,
    gameId: 1,
    me: ME,
    turn,
    graph: buildGraph(o.map ?? MAP),
    boards,
    settings: STD,
    estimates: [{ playerId: FOE, estimate: o.now ?? 5 } as EnemyDeployEstimate],
    gameSettings: o.gameSettings ?? EVEN,
    map: o.map ?? MAP,
  });

describe('the stock bound reads only kept estimates (#275 review)', () => {
  // Never seen before turn 3, then 60 on 3: beyond 2 starts of 5 and two turns of 5.
  const BOARDS: TurnBoard[] = [
    { turn: 2, board: board([mine(1, 5), mine(2, 5), fogged(3), fogged(4)]) },
    { turn: 3, board: board([mine(1, 5), mine(2, 5), foe(3, 60), fogged(4)]) },
  ];

  it('reads a stack against its stock when every turn before this one was kept', async () => {
    const r = await read(await dirWith({ 1: 5, 2: 5 }), BOARDS, 3);
    expect(r.tripwires).toMatchObject([{ player: FOE, kind: 'fog-stack', allowed: 20 }]);
  });

  it('uses the figures kept: an opponent that earned more early on is credited what it was planned against', async () => {
    // 50 kept for turn 1: 10 + 50 + 5 allow 65, above the 60.
    expect((await read(await dirWith({ 1: 50, 2: 5 }), BOARDS, 3)).tripwires).toEqual([]);
  });

  it('does not bound it by a stock with a turn not kept: today\'s lower figure may under-count it', async () => {
    expect((await read(await dirWith({ 2: 5 }), BOARDS, 3)).tripwires).toEqual([]);
    // Nothing kept at all (a game already running when this shipped, or no data dir).
    expect((await read(undefined, BOARDS, 3)).tripwires).toEqual([]);
  });

  it('stands a turn not kept in at the most the opponent was kept at, never below today\'s figure', async () => {
    // My 10 on 2 need 16 attackers; its 3 on 3 send 2. Turn 2 not kept: it stands in at the 20 kept for
    // turn 1 (2 + 20 = 22 allow 16), never at today's 5 (2 + 5 = 7 would trip).
    const capture: TurnBoard[] = [
      { turn: 2, board: board([mine(1, 1), mine(2, 10), foe(3, 3), fogged(4)]), orders: { deploys: [], moves: [], sent: [], cards: [] } },
      { turn: 3, board: board([mine(1, 1), foe(2, 8), foe(3, 1), fogged(4)]) },
    ];
    expect((await read(await dirWith({ 1: 20 }), capture, 3)).tripwires).toEqual([]);
    expect((await read(await dirWith({ 1: 5 }), capture, 3)).tripwires).toMatchObject([{ kind: 'capture', allowed: 7 }]);
  });
});

describe('my Gift card through the tools (#275 review)', () => {
  const capture = (orders: TurnBoard['orders']): TurnBoard[] => [
    { turn: 2, board: board([mine(1, 1), mine(2, 40), foe(3, 3), fogged(4)]), ...(orders ? { orders } : {}) },
    { turn: 3, board: board([mine(1, 1), foe(2, 40), foe(3, 3), fogged(4)]) },
  ];
  const GIFT = { ...EVEN, cards: ['Gift'] } as unknown as GameSettings;

  it('reads no capture of a territory I gifted', async () => {
    const dir = await dirWith({ 1: 5, 2: 5 });
    expect((await read(dir, capture({ deploys: [], moves: [], sent: [], cards: [{ card: 'Gift', target: 2 }] }), 3, { gameSettings: GIFT })).tripwires).toEqual([]);
  });

  it('reads no capture of mine when my card plays were not recorded and Gift is in play', async () => {
    const dir = await dirWith({ 1: 5, 2: 5 });
    expect((await read(dir, capture({ deploys: [], moves: [], sent: [] }), 3, { gameSettings: GIFT })).tripwires).toEqual([]);
    // Without Gift in the game, the same capture trips.
    expect((await read(dir, capture({ deploys: [], moves: [], sent: [] }), 3)).tripwires).toMatchObject([{ kind: 'capture', territory: 2 }]);
  });
});
