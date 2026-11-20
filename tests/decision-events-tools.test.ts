// #437 task 2 at the capture points: every GameFeed game read diffs the seats into the decision log's events
// (the account the log belongs to, else the signed-in one already known: never an extra request), a pending
// surrender read is logged once per player, and the hosted path reads and writes the same way. Synthetic ids;
// the fixture's players carry names only to prove none is ever written.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardState } from '../src/board.js';
import { decisionLogPath, readDecisionLog, recordObservation } from '../src/decision-log.js';
import { readPendingSurrenders } from '../src/tools/surrender-pending.js';
import { captureSeats, mySurrenderDetail } from '../src/tools/decision-capture.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveHarness, lobbyFixture, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
const ANN = '3312345644';
const BOB = '7176543229';
const CAT = '5512121233';

function feed(numberOfTurns: string): { body: Record<string, unknown>; set: (id: string, p: Record<string, string>) => void; turn: (n: string) => void } {
  const f = lobbyFixture();
  const template = (f.players as Array<Record<string, string>>)[0]!;
  const players = [
    { ...template, id: ANN, name: 'Ann', state: 'Playing' },
    { ...template, id: BOB, name: 'Bob', state: 'Playing' },
    { ...template, id: CAT, name: 'Cat', state: 'Playing' },
  ];
  const body: Record<string, unknown> = { ...f, id: String(GAME), state: 'Playing', numberOfTurns, players };
  return {
    body,
    set: (id, p) => Object.assign(players.find((x) => x.id === id)!, p),
    turn: (n) => {
      body.numberOfTurns = n;
    },
  };
}

const board: BoardState = { source: 'gamefeed', verified: true, territories: [{ territoryId: 159, owner: { kind: 'player', playerId: Number(ANN) }, armies: 3 }] };
const log = () => readDecisionLog(h!.dataDir, GAME);
const text = () => readFileSync(decisionLogPath(h!.dataDir, GAME), 'utf8');

describe('seat events from every game read (#437 task 2)', () => {
  for (const hosted of [false, true]) {
    it(`logs a seat booted, then turned AI, once each, on the log's own account${hosted ? ' (hosted)' : ''}`, async () => {
      const g = feed('3');
      h = await liveHarness({ feed: [g.body], ...(hosted ? { env: { MCP_HOST_CONFIRM_SECRET: 'synthetic' } } : {}) });
      await recordObservation(h.dataDir, GAME, Number(ANN), 3, board, 'live');
      expect((await h.call('warapp_get_game', { game_id: GAME })).isError).toBeFalsy();
      expect((await log())!.events ?? []).toEqual([]);
      g.turn('4');
      g.set(BOB, { state: 'Booted' });
      await h.call('warapp_get_game', { game_id: GAME });
      await h.call('warapp_get_game', { game_id: GAME });
      g.set(BOB, { humanTurnedIntoAI: 'True' });
      await h.call('warapp_get_game', { game_id: GAME });
      const l = (await log())!;
      expect(l.events!.map((e) => [e.turn, e.kind, e.player])).toEqual([
        [5, 'booted', Number(BOB)],
        [5, 'turned-ai', Number(BOB)],
      ]);
      expect(l.opponents).toEqual({ [BOB]: { firstSeen: 4 }, [CAT]: { firstSeen: 4 } });
      expect(l.turns['3']!.kind).toBe('observed');
      // One GameFeed request per read: the capture asks nothing more.
      expect(h.calls).toHaveLength(4);
      expect(text()).not.toMatch(/\b(Ann|Bob|Cat)\b/);
    });
  }

  it('starts no log for a game with none when the signed-in account is not known (no request to learn it)', async () => {
    const g = feed('3');
    h = await liveHarness({ feed: [g.body] });
    await h.call('warapp_get_game', { game_id: GAME });
    expect(await log()).toBeUndefined();
    expect(h.calls).toHaveLength(1);
  });

  it('writes nothing with the decision log off', async () => {
    const g = feed('3');
    h = await liveHarness({ feed: [g.body], env: { WARAPP_DECISION_LOG: 'off' } });
    await recordObservation(h.dataDir, GAME, Number(ANN), 3, board, 'live', { mode: 'on' });
    g.set(BOB, { state: 'Booted' });
    await h.call('warapp_get_game', { game_id: GAME });
    expect((await log())!.events).toBeUndefined();
  });
});

describe('a pending surrender read (#437 task 2)', () => {
  it('is logged once per player, with whether my acceptance is owed', async () => {
    const g = feed('5');
    h = await liveHarness({ feed: [g.body] });
    const game = { id: GAME, state: 'Playing', numberOfTurns: 5, players: [ANN, BOB, CAT].map((id) => ({ id: Number(id), name: 'x', isAI: false, humanTurnedIntoAI: false, hasCommittedOrders: false, state: 'Playing' })) };
    const me = game.players[0]!;
    const ctx = { rpc: {} as never, bundle: (async () => ({})) as never, dataDir: h.dataDir };
    // Bob (in-game 765432) has surrendered; Ann has not accepted.
    const seats = async () => [
      { id: 123456, state: 2, surrendered: false, acceptedBy: [], ai: false, turnedAI: false },
      { id: 765432, state: 2, surrendered: true, acceptedBy: [], ai: false, turnedAI: false },
    ];
    await recordObservation(h.dataDir, GAME, Number(ANN), 6, board, 'live');
    const once = await readPendingSurrenders(ctx as never, game, me, seats as never);
    expect(once).toEqual([expect.objectContaining({ player: Number(BOB), owedByMe: true })]);
    await readPendingSurrenders(ctx as never, game, me, seats as never);
    const l = (await log())!;
    expect(l.events!.map((e) => [e.turn, e.kind, e.player, e.detail])).toEqual([[6, 'surrender-pending', Number(BOB), 'owed']]);
  });
});

describe('captureSeats with no log yet (#437 task 2)', () => {
  const players = (state: string) => [ANN, BOB].map((id) => ({ id: Number(id), name: 'x', isAI: false, humanTurnedIntoAI: false, hasCommittedOrders: false, state }));
  it('starts the log as the signed-in account a read already gave, in a game still played; never in a finished one or another\'s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-seats-'));
    const ctx = { dataDir: dir, decisionLog: 'on' as const, cachedInviteToken: () => Number(ANN) };
    await captureSeats(ctx, { id: 1, state: 'Finished', numberOfTurns: 9, players: players('Playing') });
    expect(await readDecisionLog(dir, 1)).toBeUndefined();
    await captureSeats({ ...ctx, cachedInviteToken: () => 999 }, { id: 2, state: 'Playing', numberOfTurns: 2, players: players('Playing') });
    expect(await readDecisionLog(dir, 2)).toBeUndefined();
    await captureSeats({ ...ctx, cachedInviteToken: () => undefined }, { id: 3, state: 'Playing', numberOfTurns: 2, players: players('Playing') });
    expect(await readDecisionLog(dir, 3)).toBeUndefined();
    await captureSeats(ctx, { id: 3, state: 'Playing', numberOfTurns: 2, players: players('Playing') });
    const l = (await readDecisionLog(dir, 3))!;
    expect(l.playerId).toBe(Number(ANN));
    expect(l.seats).toEqual({ [ANN]: { state: 'Playing', ai: false }, [BOB]: { state: 'Playing', ai: false } });
    expect(l.opponents).toEqual({ [BOB]: { firstSeen: 3 } });
  });
});

describe('mySurrenderDetail (#437 task 2)', () => {
  it('takes my income and the highest-income opponent from the latest outlook evidence; nulls without one', () => {
    expect(mySurrenderDetail('pending', undefined)).toEqual({ status: 'pending', income: null, strongest: null, outlook: null, outlookTurn: null });
    const latest = {
      turn: 7,
      state: 'behind' as const,
      heldTurns: 3,
      basis: 'x',
      evidence: {
        incomes: { mine: 9, theirs: 30, playerId: 5, source: 'tracked' as const },
        opponents: [
          { playerId: 4, income: 12, source: 'visible' as const, coverage: null, thin: true },
          { playerId: 5, income: 30, source: 'tracked' as const, coverage: 0.5, thin: false },
        ],
        thin: true,
      },
    };
    expect(mySurrenderDetail('surrendered', { latest } as never)).toEqual({
      status: 'surrendered',
      income: 9,
      strongest: { player: 5, income: 30, source: 'tracked', thin: false },
      outlook: 'behind',
      outlookTurn: 7,
    });
  });
});
