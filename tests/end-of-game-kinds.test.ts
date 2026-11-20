// #437 task 4: the end-of-game pass tags each game's kind (lottery, no-show, legacy, team), keeps lottery and
// no-show games out of the lessons, the map record and the profile folds (counted apart), keeps the turn my
// seat left on a surrender with no failed attack of that turn, and gives each map entry its settings key.
// Synthetic GameFeed answers only; no war.app traffic.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MapCache, WarappClient } from '../src/client.js';
import { recordGameEvent, updateDecisionLog, type DecisionEntry } from '../src/decision-log.js';
import { finishedPath } from '../src/finished-store.js';
import { lessonsPath, mapRecordPath } from '../src/lessons-store.js';
import { playerRecordSalt } from '../src/player-record-store.js';
import { profilePlayersPath } from '../src/profile-store.js';
import { endOfGame } from '../src/tools/end-of-game.js';
import { writeOrdersCache } from '../src/trend.js';
import { CREDS, stubFetch } from './helpers.js';

const GAME = 22345671;
const ME = 4412345677;
const FOE = 7176543229;

const line = (n: number) => ({
  id: '77',
  name: 'Line',
  territories: Array.from({ length: n }, (_, i) => i + 1).map((id) => ({ id: String(id), name: `T${id}`, connectedTo: [id - 1, id + 1].filter((x) => x >= 1 && x <= n) })),
  bonuses: [{ id: '100', name: 'West', value: '3', territoryIDs: [1, 2] }],
});
const terr = (id: number, owner: number | 'Neutral', armies: number) => ({ terrID: String(id), ownedBy: String(owner), armies: String(armies), fogLevel: 'Visible' });

/** Three turns on a 6-territory line: I hold 1–2 throughout, the opponent 5–6; my attacks on 5 fail. */
function game(myState: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: String(GAME),
    state: 'Finished',
    name: 'Named Game',
    numberOfTurns: '3',
    players: [
      { id: String(ME), name: 'Alpha', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: myState },
      { id: String(FOE), name: 'Beta', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Won' },
    ],
    settings: { Map: '77', MinimumArmyBonus: '5', LocalDeployments: 'True', Commanders: 'False' },
    map: line(6),
    standing0: [terr(1, ME, 5), terr(2, ME, 5), terr(5, FOE, 5), terr(6, FOE, 5)],
    standing1: [terr(1, ME, 5), terr(2, ME, 5), terr(5, FOE, 9), terr(6, FOE, 5)],
    standing2: [terr(1, ME, 5), terr(2, ME, 5), terr(5, FOE, 9), terr(6, FOE, 5)],
    standing3: [terr(1, ME, 5), terr(2, ME, 5), terr(5, FOE, 9), terr(6, FOE, 5)],
    ...over,
  };
}

async function pass(dir: string, body: Record<string, unknown>, opts: { fold?: boolean } = {}) {
  const { fetchImpl } = stubFetch(body);
  const client = new WarappClient({ env: CREDS, fetchImpl, sleep: async () => undefined, mapCache: new MapCache() });
  const read = await client.getGame(GAME, { history: true, settings: true });
  return endOfGame({ client, dataDir: dir, env: {} }, GAME, ME, read, { history: read, retry: true, ...(opts.fold ? { fold: true } : {}) });
}

async function record(dir: string): Promise<Record<string, any>> {
  return JSON.parse(readFileSync(finishedPath(dir, (await playerRecordSalt(dir))!, ME, GAME), 'utf8'));
}
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

const planned = { kind: 'planned', planner: { version: 'test' } } as unknown as DecisionEntry;

describe('#437 task 4: the game kinds at the end-of-game pass', () => {
  it('a game played on this build: no kind; the map entry keeps its settings key and flags', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-kinds-'));
    for (const turn of [2, 3]) await writeOrdersCache(dir, GAME, ME, turn, { deploys: [], moves: [{ from: 2, to: 3, armies: 1 }] });
    const r = await pass(dir, game('Eliminated'));
    expect(r.processed).toEqual({ profiles: 'folded', map: 'kept', lessons: 'kept' });
    expect((await record(dir)).kinds).toEqual([]);
    const entry = json(mapRecordPath(dir, 77)).entries[0];
    expect(entry.kinds).toEqual([]);
    expect(entry.settings).toEqual({ key: expect.stringMatching(/^sha256:[0-9a-f]{16}$/), localDeployments: true, commanders: false });
    expect(json(lessonsPath(dir)).entries[0].kinds).toEqual([]);
  });

  it('legacy: no decision log and no board cache — tagged, still counted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-kinds-'));
    const r = await pass(dir, game('Eliminated'));
    expect(r.processed).toMatchObject({ map: 'kept', lessons: 'kept' });
    expect((await record(dir)).kinds).toEqual(['legacy']);
    expect(json(lessonsPath(dir)).entries[0].kinds).toEqual(['legacy']);
  });

  it('a lottery (a map of at most four territories) is counted apart: no lessons, map entry or profile fold', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-kinds-'));
    await writeOrdersCache(dir, GAME, ME, 1, { deploys: [], moves: [] });
    const body = game('Won', {
      players: [
        { id: String(ME), name: 'Alpha', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Won' },
        { id: String(FOE), name: 'Beta', isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Eliminated' },
      ],
      numberOfTurns: '1',
      settings: { Map: '78', MinimumArmyBonus: '5' },
      map: { ...line(2), id: '78' },
      standing0: [terr(1, ME, 5), terr(2, FOE, 5)],
      standing1: [terr(1, ME, 5), terr(2, ME, 1)],
      standing2: undefined,
      standing3: undefined,
    });
    const r = await pass(dir, body, { fold: true });
    expect(r.processed).toEqual({ profiles: 'excluded', map: 'excluded', lessons: 'excluded' });
    expect(r.profileFold).toMatchObject({ status: 'nothing', reason: 'excluded' });
    expect((await record(dir)).kinds).toEqual(['lottery']);
    const lessons = json(lessonsPath(dir));
    expect(lessons.byFormat).toEqual({});
    expect(lessons.excluded).toMatchObject({ lottery: 1, noShow: 0 });
    const map = json(mapRecordPath(dir, 78));
    expect(map).toMatchObject({ games: 0, entries: [], excluded: { lottery: 1, noShow: 0 } });
    expect(existsSync(profilePlayersPath(dir))).toBe(false);
  });

  it('a no-show (a log kept, no turn committed) is counted apart too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-kinds-'));
    await updateDecisionLog(dir, GAME, ME, (l) => ({ ...l, turns: { '1': planned } }), { mode: 'on' });
    const r = await pass(dir, game('Booted'));
    expect(r.processed).toEqual({ profiles: 'excluded', map: 'excluded', lessons: 'excluded' });
    expect((await record(dir)).kinds).toEqual(['no-show']);
    expect(json(lessonsPath(dir)).excluded).toMatchObject({ lottery: 0, noShow: 1 });
  });

  it('a surrender: the turn my seat left from the log, and no failed attack of that turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-kinds-'));
    for (const turn of [2, 3]) await writeOrdersCache(dir, GAME, ME, turn, { deploys: [], moves: [{ from: 2, to: 3, armies: 1 }] });
    await updateDecisionLog(dir, GAME, ME, (l) => ({ ...l, turns: { '2': planned } }), { mode: 'on' });
    await recordGameEvent(dir, GAME, ME, { turn: 3, kind: 'surrender-accepted', player: ME }, {}, { mode: 'on' });
    expect((await pass(dir, game('SurrenderAccepted'))).status).toBe('captured');
    const rec = await record(dir);
    expect(rec.outcome).toMatchObject({ result: 'surrendered', outTurn: null, leftTurn: 3 });
    expect(rec.failedAttacks.map((f: { turn: number }) => f.turn)).toEqual([2]);
    expect(json(lessonsPath(dir)).entries[0].howLost).toEqual({ cause: 'surrendered', turn: 3 });
    const text = readFileSync(finishedPath(dir, (await playerRecordSalt(dir))!, ME, GAME), 'utf8');
    for (const s of [String(ME), String(FOE), 'Alpha', 'Beta', 'Named Game']) expect(text).not.toContain(s);
  });
});
