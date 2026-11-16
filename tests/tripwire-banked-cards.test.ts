// #275 review: an opponent can bank Reinforcement cards (up to MaxCardsHold) and play them all in one
// turn, while its estimate carries at most one. A capture or a held attack those cards explain is no
// broken estimate. Synthetic map and ids only.
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
// My 30 on 2 taken from its stack of 3: 50 attackers needed. Its estimate of 17 (income 10 and one
// card of 7) allows 2 + 17 = 19, and 50 ≥ 1.5 × 19; three banked cards of 7 allow 21 more (40: no trip).
const TURN = 9;
const BOARDS: TurnBoard[] = [
  { turn: TURN - 1, board: board([mine(1, 1), mine(2, 30), foe(3, 3), fogged(4)]), orders: { deploys: [], moves: [], sent: [] } },
  { turn: TURN, board: board([mine(1, 1), foe(2, 8), foe(3, 1), fogged(4)]) },
];
let dataDir: string;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'warapp-tripwire-banked-'));
  for (let turn = 1; turn < TURN; turn++) await writeSurvival(dataDir, 1, ME, turn, { estimates: new Map([[FOE, 17]]), tripwires: [] });
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
    estimates: [{ playerId: FOE, estimate: 17 } as EnemyDeployEstimate],
    gameSettings: normalizeSettings({ DistributionMode: 0, TerritoryLimit: 2, InitialPlayerArmiesPerTerritory: 5, ...raw }),
    map: MAP,
  });
const reinforcement = (o: Record<string, unknown> = {}) => ({
  NumberOfCardsToReceiveEachTurn: 1,
  ReinforcementCard: { NumPieces: 1, InitialPieces: 0, MinimumPiecesPerTurn: 1, Weight: 1, FixedArmies: 7, ...o },
});

describe('the tripwire and banked Reinforcement cards (#275 review)', () => {
  it('trips on the capture with no card in play', async () => {
    expect((await read({})).tripwires.map((w) => [w.player, w.kind])).toEqual([[FOE, 'capture']]);
  });

  it('reads no capture three banked cards explain', async () => {
    expect((await read({ ...reinforcement(), MaxCardsHold: 3 })).tripwires).toEqual([]);
  });

  it('still trips when only one card can be in hand: the estimate already carries it', async () => {
    expect((await read({ ...reinforcement(), MaxCardsHold: 1 })).tripwires.map((w) => w.kind)).toEqual(['capture']);
  });

  it('reads no capture when the cards cannot be counted (progressive armies)', async () => {
    expect((await read({ ...reinforcement({ Mode: 'ProgressiveByNumberOfTurns' }), MaxCardsHold: 3 })).tripwires).toEqual([]);
  });
});
