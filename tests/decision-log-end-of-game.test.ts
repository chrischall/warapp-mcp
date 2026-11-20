// The decision log at the end-of-game pass (#412 task 3): once a finished game's history is captured,
// every turn gets its truth from the FULL history, every logged turn its accuracy against what it logged,
// the game its summary, and the log is compacted. Re-running the pass changes nothing. Synthetic GameFeed
// answers only; no war.app traffic.
import { existsSync, mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../src/board.js';
import { WarappClient } from '../src/client.js';
import { type DecisionEntry, decisionLogPath, readDecisionLog, updateDecisionLog } from '../src/decision-log.js';
import { finishedDir, finishedPath } from '../src/finished-store.js';
import { playerRecordSalt } from '../src/player-record-store.js';
import { endOfGame } from '../src/tools/end-of-game.js';
import { CREDS, stubFetch } from './helpers.js';

const GAME = 12345679;
const ME = 4412345677;
const FOE = 7176543229;

const MAP = {
  id: '77',
  name: 'Line',
  territories: [1, 2, 3, 4, 5, 6].map((id) => ({ id: String(id), name: `T${id}`, connectedTo: [id - 1, id + 1].filter((n) => n >= 1 && n <= 6) })),
  bonuses: [
    { id: '100', name: 'West', value: '3', territoryIDs: [1, 2] },
    { id: '200', name: 'East', value: '4', territoryIDs: [5, 6] },
  ],
};
const terr = (id: number, owner: number | 'Neutral', armies: number) => ({ terrID: String(id), ownedBy: String(owner), armies: String(armies), fogLevel: 'Visible' });

/** Finished after 2 turns: I start on 1, the opponent on 6; I take 2, it takes 5 (a 9-income bonus), then everything. */
const finished = {
  id: String(GAME),
  state: 'Finished',
  name: 'Named Game',
  numberOfTurns: '2',
  players: [
    { id: String(ME), name: 'Alpha', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Eliminated' },
    { id: String(FOE), name: 'Beta', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Won' },
  ],
  settings: { Map: '77', MinimumArmyBonus: '5' },
  map: MAP,
  standing0: [terr(1, ME, 5), terr(2, 'Neutral', 2), terr(5, 'Neutral', 2), terr(6, FOE, 5)],
  standing1: [terr(1, ME, 4), terr(2, ME, 3), terr(5, FOE, 4), terr(6, FOE, 4)],
  standing2: [terr(1, FOE, 6), terr(2, FOE, 1), terr(5, FOE, 4), terr(6, FOE, 1)],
};

const t = (id: number, owner: number | 'neutral' | 'fog', armies: number | null): TerritoryState => ({
  territoryId: id,
  owner: owner === 'neutral' ? { kind: 'neutral' } : owner === 'fog' ? { kind: 'unknown' } : { kind: 'player', playerId: owner },
  armies,
  ...(owner === 'fog' ? { fogLevel: 'Fogged' } : {}),
});

/** A planned turn as the log keeps it: my fogged board, the input, and a decision with its estimate of the opponent. */
const planned = (turn: number, territories: TerritoryState[], estimate: number): DecisionEntry =>
  ({
    kind: 'planned',
    board: { kind: 'full', source: 'gamefeed', verified: true, territories },
    input: { income: 5, turn },
    planner: { version: 'test' },
    decision: {
      goal: 'balanced',
      deploys: [{ territoryId: 1, armies: 5 }],
      moves: [],
      expected: { captures: [], bonusesCompleted: [], nextIncome: 5 },
      conceded: [],
      offence: [],
      enemyDeploy: estimate,
      rationale: [`Player ${FOE} may deploy ${estimate}.`],
      warnings: [],
      outlook: 'even',
      estimates: [{ player: FOE, estimate, source: 'tracked', coverage: 0.2, thin: true }],
    },
  }) as unknown as DecisionEntry;

async function pass(dir: string) {
  const { fetchImpl } = stubFetch(finished);
  const client = new WarappClient({ env: CREDS, fetchImpl, sleep: async () => undefined });
  const read = await client.getGame(GAME, { history: true, settings: true });
  return endOfGame({ client, dataDir: dir, env: {} }, GAME, ME, read, { history: read, retry: true });
}

describe('the decision log at the end-of-game pass (#412 task 3)', () => {
  it('writes every turn its truth, each logged turn its accuracy and the summary, then compacts; re-running changes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-decisions-'));
    // Turn 1 (board 0): the opponent at 5, estimated 5. Turn 2 (board 1): it earns 9 but my fogged view
    // estimated 3 — its bonus was hidden.
    await updateDecisionLog(
      dir,
      GAME,
      ME,
      (l) => ({
        ...l,
        turns: {
          '1': planned(1, [t(1, ME, 5), t(2, 'neutral', 2), t(5, 'neutral', 2), t(6, FOE, 5)], 5),
          '2': planned(2, [t(1, ME, 4), t(2, ME, 3), t(5, 'fog', null), t(6, 'fog', null)], 3),
        },
      }),
      { mode: 'on' },
    );
    expect((await pass(dir)).status).toBe('captured');
    const log = (await readDecisionLog(dir, GAME, ME))!;
    expect(log.status).toBe('compacted');
    expect(Object.keys(log.turns).sort()).toEqual(['1', '2']);
    expect(log.turns['1']!.accuracy!.estimates).toEqual([{ player: FOE, estimate: 5, truth: 5, ratio: 1, source: 'tracked', coverage: 0.2, thin: true }]);
    expect(log.turns['2']!.truth!.opponents[0]).toMatchObject({ player: FOE, income: 9, bonuses: [200], hidden: [[5, 4], [6, 4]] });
    expect(log.turns['2']!.accuracy!.estimates[0]).toMatchObject({ estimate: 3, truth: 9, ratio: 0.333333 });
    // Two boards are fewer than the outlook's three turns in a row: the true figures give no state, so no verdict.
    expect(log.turns['2']!.accuracy!.outlook).toEqual({ logged: 'even', truth: null, right: null });
    expect(log.accuracySummary!.outlook).toEqual({ right: 0, wrong: 0 });
    expect(log.accuracySummary!.estimates).toMatchObject({ n: 2, under: 0.5, over: 0 });
    expect(log.accuracySummary!.byCoverage['under-25']).toMatchObject({ n: 2 });
    expect(log.truthMissing).toEqual([]);
    // Compaction kept every board, decision and truth (the game was lost: its last turns keep their input too).
    for (const k of ['1', '2']) {
      expect(log.turns[k]!.board).toBeDefined();
      expect(log.turns[k]!.decision).toBeDefined();
      expect(log.turns[k]!.input).toBeDefined();
    }
    const text = readFileSync(decisionLogPath(dir, GAME), 'utf8');
    for (const s of ['Alpha', 'Beta', 'Named Game']) expect(text).not.toContain(s);

    // The pass again (its record and lasting mark gone, so it runs from the caller's history): the same log.
    const salt = (await playerRecordSalt(dir))!;
    unlinkSync(finishedPath(dir, salt, ME, GAME));
    unlinkSync(join(finishedDir(dir), 'processed.json'));
    expect((await pass(dir)).status).toBe('captured');
    expect(readFileSync(decisionLogPath(dir, GAME), 'utf8')).toBe(text);
  });

  it('starts no log for a game played without one (no truth-only file to crowd out real logs)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-decisions-'));
    expect((await pass(dir)).status).toBe('captured');
    expect(existsSync(decisionLogPath(dir, GAME))).toBe(false);
  });

  it('a pass whose history read fails leaves the log uncompacted; the retry writes the truth, then compacts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-decisions-'));
    await updateDecisionLog(
      dir,
      GAME,
      ME,
      (l) => ({ ...l, turns: { '1': planned(1, [t(1, ME, 5), t(6, FOE, 5)], 5), '2': planned(2, [t(1, ME, 4), t(5, 'fog', null), t(6, 'fog', null)], 3) } }),
      { mode: 'on' },
    );
    const before = readFileSync(decisionLogPath(dir, GAME), 'utf8');
    const { fetchImpl } = stubFetch(finished);
    const seen = await new WarappClient({ env: CREDS, fetchImpl, sleep: async () => undefined }).getGame(GAME, { history: true, settings: true });
    // The pass's own history read fails (a network error): no truth can be written yet.
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const down = new WarappClient({ env: CREDS, fetchImpl: failing, sleep: async () => undefined });
    expect((await endOfGame({ client: down, dataDir: dir, env: {} }, GAME, ME, seen)).status).toBe('read-failed');
    // Not compacted: a retry can still bring the history, and compaction must follow the truth.
    expect(readFileSync(decisionLogPath(dir, GAME), 'utf8')).toBe(before);
    // The retry (warapp_get_game include_history): truth first, then compaction.
    const client = new WarappClient({ env: CREDS, fetchImpl, sleep: async () => undefined });
    expect((await endOfGame({ client, dataDir: dir, env: {} }, GAME, ME, seen, { history: seen, retry: true })).status).toBe('captured');
    const log = (await readDecisionLog(dir, GAME, ME))!;
    expect(log.status).toBe('compacted');
    expect(log.turns['2']!.accuracy!.estimates[0]).toMatchObject({ estimate: 3, truth: 9 });
    expect(log.turns['2']!.accuracy!.myIncome).toBe(5);
    expect(log.accuracySummary).toBeDefined();
  });

  it('writes nothing with WARAPP_DECISION_LOG=off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-eog-decisions-'));
    const { fetchImpl } = stubFetch(finished);
    const client = new WarappClient({ env: CREDS, fetchImpl, sleep: async () => undefined });
    const read = await client.getGame(GAME, { history: true, settings: true });
    await endOfGame({ client, dataDir: dir, env: { WARAPP_DECISION_LOG: 'off' } }, GAME, ME, read, { history: read, retry: true });
    expect(existsSync(decisionLogPath(dir, GAME))).toBe(false);
  });
});
