// #274 item 5: warapp_get_game says how a lost game was lost, from the boards cached while it was
// played. Synthetic GameFeed answers and boards only; no war.app traffic.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../src/board.js';
import type { Game } from '../src/normalize.js';
import type { OutlookIncome, OutlookTurn } from '../src/analysis/outlook.js';
import { outlookLogPath, readOutlookLog, recordLoss, recordOutlook } from '../src/outlook-log.js';
import { lossReport } from '../src/tools/how-lost.js';
import { myOrdersOf } from '../src/tools/turn.js';
import { readCachedOrders, writeBoardCache, writeOrdersCache } from '../src/trend.js';
import { writeFileSync, mkdirSync } from 'node:fs';
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

  it('reports nothing for a game I won, one I am still playing, or one this server never cached', async () => {
    const dir = await seed();
    h = await liveHarness({ feed: [finished('Won')], dataDir: dir });
    expect((payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, unknown>).howLost).toBeUndefined();
    await h.harness.close();
    h = await liveHarness({ feed: [{ ...finished('Playing'), state: 'Playing' }], dataDir: dir });
    expect((payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, unknown>).howLost).toBeUndefined();
    await h.harness.close();
    h = await liveHarness({ feed: [finished('Eliminated')] });
    expect((payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, unknown>).howLost).toBeUndefined();
  });

  it('#283: reads an eliminated seat of mine while the others play on, from the cached boards', async () => {
    const dir = await seed();
    const g = finished('Eliminated');
    const [a, b] = g.players as Array<Record<string, string>>;
    // Three seats: I am out, the other two play on.
    const live = { ...g, state: 'Playing', players: [a, { ...b, state: 'Playing' }, { ...b, id: '1002', name: 'Third', state: 'Playing' }] };
    h = await liveHarness({ feed: [live], dataDir: dir });
    const p = payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>;
    // numberOfTurns 3: turn 3 is the newest completed one, so the loss was on it.
    expect(p.howLost).toMatchObject({ result: 'Eliminated', turn: 3, turnCertain: true, cause: 'commander', commander: { territoryId: 3, armies: 341 } });
    expect(p.howLost.line).toMatch(/^Eliminated on turn 3: my commander's territory 3 ⟦Thenn⟧ fell to ⟦Rival ʺxʺ⟧/);
    expect((await readOutlookLog(dir, GAME, ME))?.loss).toMatchObject({ turn: 3, cause: 'commander' });
  });

  it('#283: names a boot or a surrender of mine while the game is still playing', async () => {
    for (const state of ['Booted', 'SurrenderAccepted']) {
      const dir = await seed();
      const g = finished(state);
      const [a, b] = g.players as Array<Record<string, string>>;
      const live = { ...g, state: 'Playing', players: [a, { ...b, state: 'Playing' }, { ...b, id: '1002', name: 'Third', state: 'Playing' }] };
      h = await liveHarness({ feed: [live], dataDir: dir });
      const p = payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>;
      expect(p.howLost).toMatchObject({ result: state, cause: state === 'Booted' ? 'booted' : 'surrendered' });
      await h.harness.close();
      h = undefined;
    }
  });

  it('gives a surrender by its state, with the last turn played here when no outlook was logged', async () => {
    const dir = await seed();
    h = await liveHarness({ feed: [finished('SurrenderAccepted')], dataDir: dir });
    const p = payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>;
    expect(p.howLost).toEqual({
      result: 'SurrenderAccepted',
      cause: 'surrendered',
      turn: 3,
      line: 'Surrendered (accepted). The last turn played here was turn 3; no outlook was logged for it.',
    });
  });

  it('#283: a surrender gives the turn and the last logged outlook: my income and armies against the strongest opponent\'s, and its state', async () => {
    const dir = await seed();
    const turn = (n: number, state: 'even' | 'losing', armies: number, income: number) => ({
      turn: n,
      mine: armies + 3 * income,
      strongest: { playerId: OPP, low: 160 + 3 * 25, high: null },
      ratio: { low: 0, high: 0.4 },
      changed: 2,
      state,
      figures: { mine: { armies, income }, strongest: { armies: 160, income: 25 } },
    });
    await recordOutlook(dir, GAME, ME, { state: 'losing', heldTurns: 2, k: 3, threshold: 2.4, basis: 'b', turns: [turn(2, 'losing', 50, 9), turn(3, 'losing', 40, 8)] });
    h = await liveHarness({ feed: [finished('SurrenderAccepted')], dataDir: dir });
    const p = payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>;
    expect(p.howLost).toEqual({
      result: 'SurrenderAccepted',
      cause: 'surrendered',
      turn: 3,
      outlook: {
        turn: 3,
        state: 'losing',
        held: { state: 'losing', turns: 2 },
        mine: { armies: 40, income: 8 },
        strongest: { id: OPP, name: '⟦Rival ʺxʺ⟧', armies: 160, income: 25 },
      },
      line:
        "Surrendered (accepted). The last turn played here was turn 3; its outlook read losing (held 2 turns): my income 8 and 40 armies against ⟦Rival ʺxʺ⟧'s 25 and 160 in view.",
    });
    // The log stays name-free.
    expect(readFileSync(outlookLogPath(dir, GAME), 'utf8')).not.toContain('Rival');
  });

  describe('#522: a fogged leader reads at its tracked and calibrated income, not the visible bonus income alone', () => {
    const fogged = (income: OutlookIncome, extra: Partial<OutlookTurn> = {}): OutlookTurn => ({
      turn: 29,
      mine: 2133 + 3 * 152,
      strongest: { playerId: OPP, low: 1619 + 3 * 10, high: null },
      ratio: { low: 0, high: 1.6 },
      changed: 2,
      state: 'losing' as const,
      figures: { mine: { armies: 2133, income: 152 }, strongest: { armies: 1619, income: 10 } },
      evidence: {
        incomes: null,
        opponents: [{ playerId: OPP, income: 103, source: 'tracked' as const, coverage: 0.4, thin: true }],
        thin: true,
      },
      income,
      ...extra,
    });
    const calibrated = (playerId: number): OutlookIncome => ({
      mine: 152,
      theirs: { playerId, low: 103, high: 380, estimate: 343 },
      ratio: { low: 0.4, high: 1.48, estimate: 0.44 },
      calibrated: true,
      lean: 'behind' as const,
    });

    it('the strongest gives its tracked income, frontier read and calibrated range beside the income in view', async () => {
      const dir = await seed();
      await recordOutlook(dir, GAME, ME, { state: 'losing', heldTurns: 3, k: 3, threshold: 2.4, basis: 'b', turns: [fogged(calibrated(OPP))] });
      h = await liveHarness({ feed: [finished('SurrenderAccepted', '29')], dataDir: dir });
      const p = payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>;
      expect(p.howLost.outlook.strongest).toEqual({
        id: OPP,
        name: '⟦Rival ʺxʺ⟧',
        armies: 1619,
        income: 10,
        tracked: 103,
        coverage: 0.4,
        estimate: { low: 103, high: 380, estimate: 343, calibrated: true },
      });
      expect(p.howLost.line).toContain(
        "against ⟦Rival ʺxʺ⟧'s income 10 in view (tracked 103, 40% of its frontier read; estimated ~343, range 103–380, calibrated on past games' estimate ÷ truth) and 1619 armies in view.",
      );
      expect(p.howLost.outlook.incomeLeader).toBeUndefined();
    });

    it('names the strongest on income too when it is another opponent (the surrender line\'s side anywhere first)', async () => {
      const dir = await seed();
      const t = fogged(calibrated(OPP), { surrenderSide: { playerId: 1002, low: 120, estimate: 400, calibrated: true, near: false } });
      await recordOutlook(dir, GAME, ME, { state: 'losing', heldTurns: 3, k: 3, threshold: 2.4, basis: 'b', turns: [t] });
      h = await liveHarness({ feed: [finished('SurrenderAccepted', '29')], dataDir: dir });
      const p = payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>;
      expect(p.howLost.outlook.incomeLeader).toMatchObject({ id: 1002, low: 120, estimate: 400, calibrated: true, anywhere: true });
      expect(p.howLost.line).toMatch(/The strongest on income, near or not: .*'s ~400 \(tracked 120; calibrated on past games' estimate ÷ truth\)\.$/);
    });

    it('an uncalibrated estimate equal to the tracked figure reads as tracked only', async () => {
      const dir = await seed();
      const plain = { ...calibrated(OPP), theirs: { playerId: OPP, low: 103, high: 103, estimate: 103 }, calibrated: false };
      await recordOutlook(dir, GAME, ME, { state: 'losing', heldTurns: 3, k: 3, threshold: 2.4, basis: 'b', turns: [fogged(plain)] });
      h = await liveHarness({ feed: [finished('SurrenderAccepted', '29')], dataDir: dir });
      const p = payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>;
      expect(p.howLost.line).toContain("against ⟦Rival ʺxʺ⟧'s income 10 in view (tracked 103, 40% of its frontier read; estimated ~103, uncalibrated) and 1619 armies in view.");
    });
  });

  it('#283: an outlook logged before the figures were kept still gives the turn and the state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-howlost-'));
    mkdirSync(join(dir, 'outlook'), { recursive: true });
    const old = { gameId: GAME, playerId: ME, turns: { '5': { mine: 50, low: 90, high: null, ratio: { low: 0, high: 0.55 }, state: 'even' } }, latest: { turn: 5, state: null, heldTurns: 1, basis: 'b' } };
    writeFileSync(outlookLogPath(dir, GAME), JSON.stringify(old));
    h = await liveHarness({ feed: [finished('SurrenderAccepted', '5')], dataDir: dir });
    const p = payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>;
    expect(p.howLost).toMatchObject({ turn: 5, outlook: { turn: 5, state: 'even' } });
    expect(p.howLost.outlook.mine).toBeUndefined();
    expect(p.howLost.line).toBe('Surrendered (accepted). The last turn played here was turn 5; its outlook read even (the armies and income behind it were not logged then).');
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
  it('caches a commander walk as such and reads the loss at its destination, saying it may have fallen before the walk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-howlost-'));
    await writeBoardCache(dir, GAME, ME, 3, board());
    // The orders as warapp_submit_turn caches them: my commander walks 3 → 6 with 10 armies.
    const sent = myOrdersOf([
      { kind: 'deploy', territoryId: 6, armies: 5 },
      { kind: 'move', from: 3, to: 6, armies: 10, commander: { id: '00000000-0000-0000-0000-000000000001', owner: 10 } },
    ]);
    expect(sent.moves).toEqual([{ from: 3, to: 6, armies: 10, commander: true }]);
    expect(sent.sent).toEqual([{ from: 3, to: 6, commander: true }]);
    await writeOrdersCache(dir, GAME, ME, 3, sent);
    expect((await readCachedOrders(dir, GAME, ME)).get(3)?.moves).toEqual([{ from: 3, to: 6, armies: 10, commander: true }]);
    h = await liveHarness({ feed: [finished('Eliminated')], dataDir: dir });
    const p = payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>;
    expect(p.howLost.commander).toMatchObject({ territoryId: 6, territoryCertain: false, walk: { from: 3, to: 6, armies: 10 }, held: { low: 35, high: 35 } });
    expect(p.howLost.line).toMatch(/my commander walked from 3 ⟦Thenn⟧ to 6 /);
    expect(p.howLost.line).toContain('it fell on 6');
    expect(p.howLost.line).toContain('or on 3 ⟦Thenn⟧ before the walk ran');
  });

  it('says what it held is a bound when an order the moves leave out touches the commander territory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-howlost-'));
    await writeBoardCache(dir, GAME, ME, 3, board());
    await writeOrdersCache(dir, GAME, ME, 3, { deploys: [], moves: [], sent: [{ from: 3, to: 1 }], cards: [] });
    h = await liveHarness({ feed: [finished('Eliminated')], dataDir: dir });
    const p = payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>;
    expect(p.howLost.commander.held).toMatchObject({ uncertain: true });
    expect(p.howLost.line).toContain('an order this count leaves out');
  });

  it('says the cause is unknown when the game had commanders but the cached board shows none of mine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-howlost-'));
    const plain = board();
    plain.territories = plain.territories.map(({ specialUnits: _u, ...rest }) => rest);
    await writeBoardCache(dir, GAME, ME, 3, plain);
    const g = finished('Eliminated');
    h = await liveHarness({ feed: [{ ...g, settings: { ...(g.settings as object), Commanders: true } }], dataDir: dir });
    const p = payload(await h.call('warapp_get_game', { game_id: GAME })) as Record<string, any>;
    expect(p.howLost).toMatchObject({ cause: 'unknown', turn: 3 });
    expect(p.howLost.line).toBe('Eliminated on turn 3; the cached board does not show my commander, so the cause is unknown.');
  });

  it('never throws: a failure while reading gives no report', async () => {
    const dir = await seed();
    const game = {
      id: GAME,
      state: 'Finished',
      get players(): never {
        throw new Error('boom');
      },
    } as unknown as Game;
    await expect(lossReport(dir, game)).resolves.toBeUndefined();
  });

  it("never writes the loss over another account's outlook log", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-howlost-'));
    mkdirSync(join(dir, 'outlook'), { recursive: true });
    const other = { gameId: GAME, playerId: OPP, turns: { '2': { mine: 5, low: 5, high: 5, ratio: 1, state: 'even' } } };
    writeFileSync(outlookLogPath(dir, GAME), JSON.stringify(other));
    const loss = { turn: 3, turnCertain: true, cause: 'last-territories' as const, territoriesHeld: 1, neighbours: null, by: null };
    expect(await recordLoss(dir, GAME, ME, loss)).toBe(false);
    expect(JSON.parse(readFileSync(outlookLogPath(dir, GAME), 'utf8'))).toEqual(other);
  });
});
