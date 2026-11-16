// #275 review: a Diplomacy card in force on the turn my attack ran may have worn off by this one, so the
// cards in effect now cannot say the attack ran. Once anyone may hold one, no held attack is read.
// Synthetic map and ids only.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TerritoryState } from '../src/board.js';
import { buildGraph } from '../src/analysis/graph.js';
import type { EnemyDeployEstimate } from '../src/analysis/plan/shared.js';
import type { TurnBoard } from '../src/analysis/opponents.js';
import { normalizeSettings, type GameMap } from '../src/normalize.js';
import { readTripwires } from '../src/tools/survival.js';
import { writeSurvival } from '../src/trend.js';
import { board, mine } from './analysis/helpers.js';

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
// 35 attackers kill 21: 22 defenders held 3, where 5 stood with a 5 deploy and no stack beside it.
const TURN = 5;
const BOARDS: TurnBoard[] = [
  {
    turn: TURN - 1,
    board: board([mine(1, 1), mine(2, 40), foe(3, 5), foe(4, 1)]),
    orders: { deploys: [], moves: [{ from: 2, to: 3, armies: 35 }], sent: [{ from: 2, to: 3 }] },
  },
  { turn: TURN, board: board([mine(1, 1), mine(2, 20), foe(3, 4), foe(4, 1)]) },
];
let dataDir: string;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'warapp-tripwire-diplomacy-'));
  for (let turn = 1; turn < TURN; turn++) await writeSurvival(dataDir, 1, ME, turn, { estimates: new Map([[FOE, 5]]), tripwires: [] });
});
const read = (raw: Record<string, unknown>) =>
  readTripwires({
    dataDir,
    gameId: 1,
    me: ME,
    turn: TURN,
    graph: buildGraph(MAP),
    boards: BOARDS,
    settings: STD,
    estimates: [{ playerId: FOE, estimate: 5 } as EnemyDeployEstimate],
    gameSettings: normalizeSettings({ DistributionMode: 0, TerritoryLimit: 2, InitialPlayerArmiesPerTerritory: 5, ...raw }),
    map: MAP,
  });

describe('the tripwire and a Diplomacy card that may have worn off (#275 review)', () => {
  it('trips on the held attack with no Diplomacy card in play', async () => {
    expect((await read({})).tripwires.map((w) => [w.player, w.kind])).toEqual([[FOE, 'held-attack']]);
  });

  it('reads no held attack once anyone may have held a Diplomacy card on the turn it ran', async () => {
    const piece = { NumPieces: 1, InitialPieces: 1, MinimumPiecesPerTurn: 1, Weight: 1, Duration: 1 };
    expect((await read({ NumberOfCardsToReceiveEachTurn: 1, DiplomacyCard: piece })).tripwires).toEqual([]);
  });
});
