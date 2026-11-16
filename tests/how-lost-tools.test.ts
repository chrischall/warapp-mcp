// #274 item 5: warapp_get_game says how a lost game was lost, from the boards cached while it was
// played. Synthetic GameFeed answers and boards only; no war.app traffic.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../src/board.js';
import { outlookLogPath, readOutlookLog } from '../src/outlook-log.js';
import { writeBoardCache, writeOrdersCache } from '../src/trend.js';
import { liveHarness, lobbyFixture, payload, type Harness } from './helpers.js';

const GAME = 12345678;
const ME = 1000;
const OPP = 1001;

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

function finished(myState: string, turns = '3'): Record<string, unknown> {
  const f = lobbyFixture();
  const [a, b] = f.players as Array<Record<string, string>>;
  return {
    ...f,
    id: String(GAME),
    state: 'Finished',
    numberOfTurns: turns,
    players: [
      { ...a, id: String(ME), name: 'Me', state: myState },
      { ...b, id: String(OPP), name: 'Rival "x"', state: myState === 'Won' ? 'Eliminated' : 'Won' },
    ],
  };
}

const t = (territoryId: number, owner: number, armies: number, commander = false): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: owner },
  armies,
  ...(commander ? { specialUnits: [{ kind: 'commander' as const, id: 'g', playerId: owner }] } : {}),
});

// On the fixture's map territory 3 (Thenn) borders 1, 2, 5 and 7.
const board = (): BoardState => ({
  source: 'browser',
  verified: true,
  territories: [t(3, ME, 341, true), t(1, OPP, 1), t(2, OPP, 0), t(5, OPP, 1), t(7, OPP, 0), t(6, ME, 20)],
});

async function seed(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-howlost-'));
  await writeBoardCache(dir, GAME, ME, 2, board());
  await writeBoardCache(dir, GAME, ME, 3, board());
  await writeOrdersCache(dir, GAME, ME, 3, { deploys: [{ territoryId: 6, armies: 5 }], moves: [] });
  return dir;
}

describe('warapp_get_game: how the game was lost (#274)', () => {
  it('names the turn, the commander territory that fell, what it held, the attack it needed and who took it', async () => {
    const dir = await seed();
    h = await liveHarness({ feed: [finished('Eliminated')], dataDir: dir });
    const p = payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>;
    expect(p.howLost).toMatchObject({
      result: 'Eliminated',
      turn: 3,
      turnCertain: true,
      cause: 'commander',
      commander: { territoryId: 3, armies: 341, deployed: 0, held: { low: 341, high: 341 }, attackersNeeded: 580 },
      by: { id: OPP },
    });
    expect(p.howLost.commander.territoryName).toContain('Thenn');
    expect(p.howLost.by.name).toMatch(/^⟦Rival ʺxʺ⟧$/);
    expect(p.howLost.line).toMatch(/^Eliminated on turn 3: my commander's territory 3 ⟦Thenn⟧ fell to ⟦Rival ʺxʺ⟧/);
    expect(p.howLost.line).toContain('580');
    // Kept name-free beside the outlook, so it outlives the board cache.
    const text = readFileSync(outlookLogPath(dir, GAME), 'utf8');
    expect(text).not.toContain('Rival');
    expect(text).not.toContain('Thenn');
    expect((await readOutlookLog(dir, GAME, ME))?.loss).toMatchObject({ turn: 3, cause: 'commander', by: OPP });
  });

  it('reads the kept loss when the boards are gone', async () => {
    const dir = await seed();
    h = await liveHarness({ feed: [finished('Eliminated')], dataDir: dir });
    await h.call('warapp_get_game', { game_id: GAME });
    await h.harness.close();
    const { rmSync } = await import('node:fs');
    rmSync(join(dir, 'boards'), { recursive: true, force: true });
    h = await liveHarness({ feed: [finished('Eliminated')], dataDir: dir });
    const p = payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>;
    expect(p.howLost).toMatchObject({ cause: 'commander', turn: 3, by: { id: OPP } });
  });

  it('says the turn is only the last one cached when the game went on after it', async () => {
    const dir = await seed();
    h = await liveHarness({ feed: [finished('Eliminated', '9')], dataDir: dir });
    const p = payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>;
    expect(p.howLost.turnCertain).toBe(false);
    expect(p.howLost.line).toMatch(/^Eliminated on turn 3 \(the last turn cached here/);
  });

  it('reports nothing for a game I won, one in progress, or one this server never cached', async () => {
    const dir = await seed();
    h = await liveHarness({ feed: [finished('Won')], dataDir: dir });
    expect((payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, unknown>).howLost).toBeUndefined();
    await h.harness.close();
    h = await liveHarness({ feed: [{ ...finished('Eliminated'), state: 'Playing' }], dataDir: dir });
    expect((payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, unknown>).howLost).toBeUndefined();
    await h.harness.close();
    h = await liveHarness({ feed: [finished('Eliminated')] });
    expect((payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, unknown>).howLost).toBeUndefined();
  });

  it('gives a surrender or a boot as the cause without reading the boards', async () => {
    const dir = await seed();
    h = await liveHarness({ feed: [finished('SurrenderAccepted')], dataDir: dir });
    const p = payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>;
    expect(p.howLost).toEqual({ result: 'SurrenderAccepted', cause: 'surrendered', line: 'Surrendered (accepted).' });
  });

  it('without my orders gives what stood at the start, and without a commander names the last territories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-howlost-'));
    await writeBoardCache(dir, GAME, ME, 3, board());
    h = await liveHarness({ feed: [finished('Eliminated')], dataDir: dir });
    let p = payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>;
    expect(p.howLost.commander).toMatchObject({ armies: 341, held: null, attackersNeeded: null });
    expect(p.howLost.line).toContain('my orders that turn are not cached');
    await h.harness.close();
    const plain = board();
    plain.territories = plain.territories.map(({ specialUnits: _u, ...rest }) => rest);
    await writeBoardCache(dir, GAME, ME, 4, plain);
    h = await liveHarness({ feed: [finished('Eliminated', '4')], dataDir: dir });
    p = payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>;
    expect(p.howLost).toMatchObject({ cause: 'last-territories', turn: 4, by: { id: OPP } });
    expect(p.howLost.line).toMatch(/^Eliminated on turn 4: my last 2 territories fell to ⟦Rival ʺxʺ⟧ \(3 ⟦Thenn⟧, 6 /);
  });

  it('gives a boot by the state', async () => {
    const dir = await seed();
    h = await liveHarness({ feed: [finished('Booted')], dataDir: dir });
    expect((payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>).howLost).toMatchObject({ cause: 'booted' });
  });
});
