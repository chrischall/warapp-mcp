// #275 review: the tripwire credits a stack no board ever showed its whole start, read from the settings.
// A custom scenario sets each player's start by hand (a large starting stack is the creator's call), so
// the settings' TerritoryLimit × InitialPlayerArmiesPerTerritory says nothing of it: no start, and a
// stack never seen is not read. Synthetic map and ids only.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
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
const MAP: GameMap = {
  id: 1,
  name: 'Line',
  territories: [1, 2, 3, 4].map((id) => ({ id, name: `T${id}`, connectedTo: [id - 1, id + 1].filter((x) => x >= 1 && x <= 4) })),
  bonuses: [],
  distributionModes: [],
};
const foe = (id: number, armies: number): TerritoryState => mine(id, armies, FOE);
// Never seen before turn 3, then 60 on 3: far beyond 2 starts of 5 and two deploys of 5.
const BOARDS: TurnBoard[] = [
  { turn: 2, board: board([mine(1, 5), mine(2, 5), fogged(3), fogged(4)]) },
  { turn: 3, board: board([mine(1, 5), mine(2, 5), foe(3, 60), fogged(4)]) },
];
// Every turn's estimate kept (#275 review: the stock bounds a stack only then).
let dataDir: string;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'warapp-tripwire-start-'));
  for (const turn of [1, 2]) await writeSurvival(dataDir, 1, ME, turn, { estimates: new Map([[FOE, 5]]), tripwires: [] });
});
const read = (gameSettings: Partial<GameSettings> & { raw?: Record<string, unknown> }) =>
  readTripwires({
    dataDir,
    gameId: 1,
    me: ME,
    turn: 3,
    graph: buildGraph(MAP),
    boards: BOARDS,
    settings: STD,
    estimates: [{ playerId: FOE, estimate: 5 } as EnemyDeployEstimate],
    gameSettings: { cards: [], territoryLimit: 2, initialPlayerArmiesPerTerritory: 5, ...gameSettings } as GameSettings,
    map: MAP,
  });

describe('the tripwire start in a custom scenario (#275 review)', () => {
  it('reads a stack never seen against an even start', async () => {
    expect((await read({ distributionMode: 0 })).tripwires.map((w) => [w.player, w.kind])).toEqual([[FOE, 'fog-stack']]);
  });

  it('gives no start in a custom scenario, so a stack never seen is not read', async () => {
    expect((await read({ distributionMode: -3 })).tripwires).toEqual([]);
    expect((await read({ distributionMode: 0, raw: { CustomScenario: { Territories: [] } } })).tripwires).toEqual([]);
  });

  it('gives no start when the settings do not say how the territories were distributed', async () => {
    expect((await read({})).tripwires).toEqual([]);
  });
});
