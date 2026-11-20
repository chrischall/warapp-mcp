// #437 task 4 review: every profile fold keeps lottery and no-show games out, not only the end-of-game
// pass's own. warapp_get_game and warapp_profile_opponents fold a finished game through `foldFinished`
// (the live per-game file, or a backfill from the board cache); a lottery or no-show game read there before
// the end-of-game pass ran must not be folded, so the pass's answer never depends on which tool ran first.
// Synthetic GameFeed answers only; no war.app traffic.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MapCache, WarappClient } from '../src/client.js';
import { recordJoin, updateDecisionLog, type DecisionEntry, type JoinContext } from '../src/decision-log.js';
import { normalizeGame, normalizeMap } from '../src/normalize.js';
import { graphOf } from '../src/tools/common.js';
import { profilePlayersPath, recordBehaviour } from '../src/profile-store.js';
import { endOfGame } from '../src/tools/end-of-game.js';
import { foldFinished, foldKeptProfile } from '../src/tools/profile-hook.js';
import { writeBoardCache, writeOrdersCache } from '../src/trend.js';
import type { BoardState } from '../src/board.js';
import { CREDS, stubFetch } from './helpers.js';

const GAME = 22345681;
const ME = 4412345687;
const FOE = 7176543239;

const line = (n: number, id = '77') => ({
  id,
  name: 'Line',
  territories: Array.from({ length: n }, (_, i) => i + 1).map((t) => ({ id: String(t), name: `T${t}`, connectedTo: [t - 1, t + 1].filter((x) => x >= 1 && x <= n) })),
  bonuses: [{ id: '100', name: 'West', value: '3', territoryIDs: [1, 2] }],
});
const terr = (id: number, owner: number, armies: number) => ({ terrID: String(id), ownedBy: String(owner), armies: String(armies), fogLevel: 'Visible' });

/** A finished two-seat game: I lost on a 6-territory line (or `over` it). */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: String(GAME),
    state: 'Finished',
    name: 'Named Game',
    numberOfTurns: '3',
    players: [
      { id: String(ME), name: 'Alpha', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Eliminated' },
      { id: String(FOE), name: 'Beta', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Won' },
    ],
    settings: { Map: '77', MinimumArmyBonus: '5' },
    map: line(6),
    standing0: [terr(1, ME, 5), terr(2, ME, 5), terr(5, FOE, 5), terr(6, FOE, 5)],
    standing1: [terr(1, ME, 5), terr(2, ME, 5), terr(5, FOE, 9), terr(6, FOE, 5)],
    standing2: [terr(1, ME, 5), terr(2, ME, 5), terr(5, FOE, 9), terr(6, FOE, 5)],
    standing3: [terr(1, ME, 5), terr(2, ME, 5), terr(5, FOE, 9), terr(6, FOE, 5)],
    ...over,
  };
}

/** A two-territory lottery map the game ended on in one turn. */
const lottery = (over: Record<string, unknown> = {}) =>
  body({
    numberOfTurns: '1',
    settings: { Map: '78', MinimumArmyBonus: '5' },
    map: line(2, '78'),
    standing0: [terr(1, ME, 5), terr(2, FOE, 5)],
    standing1: [terr(1, FOE, 1), terr(2, FOE, 5)],
    standing2: undefined,
    standing3: undefined,
    ...over,
  });

const own = (territoryId: number, playerId: number, armies: number) => ({ territoryId, owner: { kind: 'player' as const, playerId }, armies });
const board = (ids: readonly number[]): BoardState => ({
  source: 'browser',
  verified: true,
  territories: ids.map((id) => own(id, id <= ids.length / 2 ? ME : FOE, 5)),
});

/** Boards (and my orders) cached as the game was played, so a fold has something to backfill. */
async function played(dir: string, ids: readonly number[], turns: number): Promise<void> {
  for (let t = 1; t <= turns; t++) {
    await writeBoardCache(dir, GAME, ME, t, board(ids));
    await writeOrdersCache(dir, GAME, ME, t, { deploys: [], moves: [{ from: ids[0]!, to: ids[ids.length - 1]!, armies: 1 }] });
  }
}

async function read(b: Record<string, unknown>) {
  const { fetchImpl } = stubFetch(b);
  const client = new WarappClient({ env: CREDS, fetchImpl, sleep: async () => undefined, mapCache: new MapCache() });
  return { client, game: await client.getGame(GAME, { history: true, settings: true }) };
}

const planned = { kind: 'planned', planner: { version: 'test' } } as unknown as DecisionEntry;
const JOIN: JoinContext = {
  at: new Date(Date.UTC(2026, 0, 1)).toISOString(),
  settingsKey: 'sha256:0123456789abcdef',
  flags: { format: '1v1', seats: 2 },
  policy: { passes: true, broke: [], passed: [], unchecked: [] },
  lottery: true,
};

describe('#437: foldFinished keeps lottery and no-show games out of the profiles', () => {
  it('a lottery map (at most four territories) read before the end-of-game pass is not folded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-fold-ex-'));
    await played(dir, [1, 2], 3);
    const { game } = await read(lottery());
    expect(await foldFinished(dir, {}, game)).toMatchObject({ status: 'nothing', reason: 'excluded' });
    expect(existsSync(profilePlayersPath(dir))).toBe(false);
  });

  it('the pass after an earlier fold read reports the same exclusion, and nothing was folded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-fold-ex-'));
    await played(dir, [1, 2], 3);
    const { client, game } = await read(lottery());
    await foldFinished(dir, {}, game);
    const r = await endOfGame({ client, dataDir: dir, env: {} }, GAME, ME, game, { history: game, retry: true, fold: true });
    expect(r.processed).toEqual({ profiles: 'excluded', map: 'excluded', lessons: 'excluded' });
    expect(r.profileFold).toMatchObject({ status: 'nothing', reason: 'excluded' });
    expect(existsSync(profilePlayersPath(dir))).toBe(false);
  });

  it('without the map: the lobby the log read as a lottery is not folded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-fold-ex-'));
    await played(dir, [1, 2, 5, 6], 3);
    // A per-game file kept while it was played: the live fold needs no map.
    const graph = graphOf(normalizeMap(line(6)));
    const boards = [1, 2, 3].map((turn) => ({ turn, board: board([1, 2, 5, 6]) }));
    await recordBehaviour(dir, { gameId: GAME, me: ME, graph, settings: {}, opponents: [FOE], boards }, {});
    await recordJoin(dir, GAME, ME, JOIN, { mode: 'on' });
    const { map: _map, ...noMap } = body();
    expect(await foldFinished(dir, {}, normalizeGame(noMap))).toMatchObject({ status: 'nothing', reason: 'excluded' });
    expect(existsSync(profilePlayersPath(dir))).toBe(false);
  });

  it('a no-show (boards seen, no turn committed, booted early) is not folded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-fold-ex-'));
    for (let t = 1; t <= 2; t++) await writeBoardCache(dir, GAME, ME, t, board([1, 2, 5, 6]));
    await updateDecisionLog(dir, GAME, ME, (l) => ({ ...l, turns: { '1': planned } }), { mode: 'on' });
    const players = [
      { id: String(ME), name: 'Alpha', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Booted' },
      { id: String(FOE), name: 'Beta', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Won' },
    ];
    const { game } = await read(body({ players, numberOfTurns: '1', standing2: undefined, standing3: undefined }));
    expect(await foldFinished(dir, {}, game)).toMatchObject({ status: 'nothing', reason: 'excluded' });
    expect(existsSync(profilePlayersPath(dir))).toBe(false);
  });

  it('a counted game still folds (the check keeps nothing else out)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-fold-ex-'));
    await played(dir, [1, 2, 5, 6], 3);
    const { game } = await read(body());
    expect(await foldFinished(dir, {}, game)).toMatchObject({ status: 'folded', source: 'backfill' });
  });

  it('the file-only fold (a wait read, a game-ended notice) skips such a game too, and folds a counted one', async () => {
    const live = async (dir: string) => {
      await played(dir, [1, 2, 5, 6], 3);
      const graph = graphOf(normalizeMap(line(6)));
      const boards = [1, 2, 3].map((turn) => ({ turn, board: board([1, 2, 5, 6]) }));
      await recordBehaviour(dir, { gameId: GAME, me: ME, graph, settings: {}, opponents: [FOE], boards }, {});
    };
    const { map: _map, ...noMap } = body();
    const excluded = mkdtempSync(join(tmpdir(), 'warapp-mcp-fold-ex-'));
    await live(excluded);
    await recordJoin(excluded, GAME, ME, JOIN, { mode: 'on' });
    expect(await foldKeptProfile(excluded, normalizeGame(noMap), {})).toBe(0);
    expect(existsSync(profilePlayersPath(excluded))).toBe(false);
    const counted = mkdtempSync(join(tmpdir(), 'warapp-mcp-fold-ex-'));
    await live(counted);
    expect(await foldKeptProfile(counted, normalizeGame(noMap), {})).toBeGreaterThan(0);
  });
});
