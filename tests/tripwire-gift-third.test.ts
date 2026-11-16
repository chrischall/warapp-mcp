// #275 review: with Gift in play, a third player may take a territory out of view and gift it to an
// opponent with its stack, so a stack out of the fog on a territory not last seen its own says nothing of
// that opponent's income. readTripwires tells the tripwire who else is in the game: every player with an
// estimate, on a team, or owning a territory on a board, a static seat (#270) aside. Synthetic map and ids only.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TerritoryState } from '../src/board.js';
import { buildGraph } from '../src/analysis/graph.js';
import type { EnemyDeployEstimate } from '../src/analysis/plan/shared.js';
import type { TurnBoard } from '../src/analysis/opponents.js';
import { type GameMap, normalizeSettings } from '../src/normalize.js';
import { readTripwires } from '../src/tools/survival.js';
import { writeSurvival } from '../src/trend.js';
import { board, fogged, mine } from './analysis/helpers.js';

const ME = 10;
const FOE = 20;
const Q = 30;
const STD = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, multiAttack: false };
const MAP: GameMap = {
  id: 1,
  name: 'Line',
  territories: [1, 2, 3, 4, 5].map((id) => ({ id, name: `T${id}`, connectedTo: [id - 1, id + 1].filter((x) => x >= 1 && x <= 5) })),
  bonuses: [],
  distributionModes: [],
};
const foe = (id: number, armies: number): TerritoryState => mine(id, armies, FOE);
// Never seen before turn 3, then 80 on 3: far beyond 2 starts of 5 and two deploys of 5.
const boards = (on5: TerritoryState = fogged(5)): TurnBoard[] => [
  { turn: 2, board: board([mine(1, 5), mine(2, 5), fogged(3), fogged(4), on5]) },
  { turn: 3, board: board([mine(1, 5), mine(2, 5), foe(3, 80), fogged(4), on5]) },
];
let dataDir: string;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'warapp-tripwire-gift-'));
  for (const turn of [1, 2]) await writeSurvival(dataDir, 1, ME, turn, { estimates: new Map([[FOE, 5]]), tripwires: [] });
});
const GIFT = { GiftCard: { NumPieces: 1, InitialPieces: 0, MinimumPiecesPerTurn: 1, Weight: 1 } };
const read = (a: { boards?: TurnBoard[]; estimates?: number[]; staticSeats?: Set<number>; gift?: boolean } = {}) =>
  readTripwires({
    dataDir,
    gameId: 1,
    me: ME,
    turn: 3,
    graph: buildGraph(MAP),
    boards: a.boards ?? boards(),
    settings: STD,
    estimates: (a.estimates ?? [FOE]).map((playerId) => ({ playerId, estimate: 5 }) as EnemyDeployEstimate),
    gameSettings: normalizeSettings({ DistributionMode: 0, TerritoryLimit: 2, InitialPlayerArmiesPerTerritory: 5, ...(a.gift === false ? {} : GIFT) }),
    map: MAP,
    ...(a.staticSeats ? { staticSeats: a.staticSeats } : {}),
  });
const kinds = async (a: Parameters<typeof read>[0]) => (await read(a)).tripwires.map((w) => [w.player, w.kind]);

describe('the tripwire with Gift in play and a third player (#275 review)', () => {
  it('reads a stack never seen in a 1v1: no one else could have gifted it', async () => {
    expect(await kinds({})).toEqual([[FOE, 'fog-stack']]);
  });

  it('reads no such stack with a third player in the game, by its estimate or on a board', async () => {
    expect(await kinds({ estimates: [FOE, Q] })).toEqual([]);
    expect(await kinds({ boards: boards(mine(5, 3, Q)) })).toEqual([]);
  });

  it('reads it again when that player is a static seat, or without Gift in the game', async () => {
    expect(await kinds({ boards: boards(mine(5, 3, Q)), staticSeats: new Set([Q]) })).toEqual([[FOE, 'fog-stack']]);
    expect(await kinds({ estimates: [FOE, Q], gift: false })).toEqual([[FOE, 'fog-stack']]);
  });
});
