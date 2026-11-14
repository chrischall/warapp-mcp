// The agreement ledger on disk and the cross-game player record (docs/PLAN-TEAMS.md A2).
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_RECORD_ENTRIES,
  outcomeOf,
  playerRecord,
  recordEntryFor,
  upsertEntry,
  type RecordEntry,
} from '../src/analysis/player-record.js';
import { newAgreement, transitionAgreement, type Agreement, type AgreementStatus } from '../src/analysis/relations.js';
import {
  entryKey,
  playerKey,
  playerRecordEnabled,
  playerRecordPath,
  playerRecordSalt,
  readPlayerEntries,
  updatePlayerEntries,
} from '../src/player-record-store.js';
import {
  emptyLedger,
  MAX_AGREEMENTS,
  nextAgreementId,
  readLedger,
  recordTruceUsage,
  relationsPath,
  writeLedger,
} from '../src/relations-store.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'warapp-relations-'));
const GAME = 4242;
const ME = 1111;
const P = 2222;

const walk = (statuses: AgreementStatus[], turn = 3): Agreement => {
  let a = newAgreement('a1', P, statuses[0]!, turn, { scope: { territories: [4, 5] }, noticeTurns: 1, borderCap: 6, untilTurn: 20 });
  for (const [i, s] of statuses.slice(1).entries()) a = (transitionAgreement(a, s, turn + i + 1) as { agreement: Agreement }).agreement;
  return a;
};

describe('the per-game ledger', () => {
  it('round-trips, name-free and private', async () => {
    const dir = tmp();
    const ledger = { ...emptyLedger(GAME, ME), agreements: [walk(['proposed-by-them', 'agreed'])] };
    expect(await writeLedger(dir, ledger)).toBe(true);
    expect(await readLedger(dir, GAME, ME)).toEqual(ledger);
    expect(statSync(relationsPath(dir, GAME)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'relations')).mode & 0o777).toBe(0o700);
    // Another account's ledger is not mine.
    expect(await readLedger(dir, GAME, 9999)).toBeUndefined();
  });

  it('drops an unusable agreement and never throws on a broken file', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'relations'), { recursive: true });
    const good = walk(['agreed']);
    writeFileSync(relationsPath(dir, GAME), JSON.stringify({ gameId: GAME, playerId: ME, agreements: [good, { id: 'x', with: 'bob' }], usage: { '5': 'nope' } }));
    expect((await readLedger(dir, GAME, ME))?.agreements).toEqual([good]);
    writeFileSync(relationsPath(dir, GAME), '{not json');
    expect(await readLedger(dir, GAME, ME)).toBeUndefined();
  });

  it('numbers agreements and bounds the ledger, dropping the oldest over ones', async () => {
    const dir = tmp();
    const many = Array.from({ length: MAX_AGREEMENTS + 5 }, (_, i) => ({
      ...walk(['agreed', 'ended']),
      id: `a${i + 1}`,
      endedTurn: i + 1,
    }));
    expect(nextAgreementId({ ...emptyLedger(GAME, ME), agreements: many })).toBe(`a${MAX_AGREEMENTS + 6}`);
    await writeLedger(dir, { ...emptyLedger(GAME, ME), agreements: many });
    const back = (await readLedger(dir, GAME, ME))!;
    expect(back.agreements).toHaveLength(MAX_AGREEMENTS);
    expect(back.agreements[0]!.id).toBe('a6');
  });

  it('keeps the B2 usage stub per turn, only for a game with a ledger', async () => {
    const dir = tmp();
    expect(await recordTruceUsage(dir, GAME, ME, 7, [{ agreementId: 'a1', armiesFreed: null, lossIfBroken: null }])).toBe(false);
    await writeLedger(dir, emptyLedger(GAME, ME));
    expect(await recordTruceUsage(dir, GAME, ME, 7, [{ agreementId: 'a1', armiesFreed: 4, lossIfBroken: 9 }])).toBe(true);
    expect((await readLedger(dir, GAME, ME))!.usage).toEqual({ '7': [{ agreementId: 'a1', armiesFreed: 4, lossIfBroken: 9 }] });
  });
});

describe('the record entry', () => {
  const entry = (a: Agreement, over: Partial<Parameters<typeof recordEntryFor>[1]> = {}, prev?: RecordEntry) =>
    recordEntryFor(a, { key: 'k'.repeat(32), format: { players: 5, teams: false, ffaSize: 5 }, now: 1, ...over }, prev);

  it('derives each outcome from the status history', () => {
    expect(outcomeOf(walk(['agreed']))).toEqual({ outcome: 'open' });
    expect(outcomeOf(walk(['agreed', 'ended']))).toEqual({ outcome: 'kept' });
    expect(outcomeOf(walk(['proposed-by-me', 'ended']))).toEqual({ outcome: 'not-agreed' });
    expect(outcomeOf(walk(['agreed', 'notice-by-them', 'ended']))).toEqual({ outcome: 'ended-with-notice', noticeBy: 'them', noticeHonoured: true });
    expect(outcomeOf(walk(['agreed', 'notice-by-them', 'broken-by-them']))).toEqual({ outcome: 'broken-by-them', noticeBy: 'them', noticeHonoured: false });
    expect(outcomeOf(walk(['agreed', 'notice-by-me', 'broken-by-them']))).toEqual({ outcome: 'broken-by-them', noticeBy: 'me', noticeHonoured: true });
    // Notice withdrawn is no notice.
    expect(outcomeOf(walk(['agreed', 'notice-by-them', 'agreed', 'broken-by-them']))).toEqual({ outcome: 'broken-by-them' });
  });

  it('keeps the terms shape, the format and the break context, never an id', () => {
    const a = walk(['proposed-by-them', 'agreed', 'broken-by-them']);
    const e = entry(a, { breachFlag: 'broken', context: { endgame: true, leader: 'partner', outgrowing: false } });
    expect(e).toEqual({
      key: 'k'.repeat(32),
      format: { players: 5, teams: false, ffaSize: 5 },
      proposedBy: 'them',
      agreedTurn: 4,
      endedTurn: 5,
      terms: { scope: 'territories', scopeSize: 2, noticeTurns: 1, cap: 6, endCondition: 'turn', against: false },
      outcome: 'broken-by-them',
      breakTurn: 5,
      breachFlag: 'broken',
      context: { endgame: true, leader: 'partner', outgrowing: false },
      updated: 1,
    });
    expect(JSON.stringify(e)).not.toContain(String(P));
  });

  it('summarises a player: counts, the kept rate, turns to a break', () => {
    const k = (n: number) => String(n).padStart(32, '0');
    const entries = [
      entry(walk(['agreed', 'ended']), { key: k(1), now: 1 }),
      entry(walk(['agreed', 'notice-by-them', 'ended']), { key: k(2), now: 2 }),
      entry(walk(['proposed-by-them', 'agreed', 'broken-by-them']), { key: k(3), now: 3, context: { endgame: true, leader: 'me', outgrowing: null } }),
      { ...entry(walk(['agreed', 'broken-by-me']), { key: k(4), now: 4 }), retaliated: true },
      { ...entry(walk(['agreed', 'ended']), { key: k(5), now: 5 }), proposedAgain: true },
    ];
    expect(playerRecord(entries)).toEqual({
      entries: 5,
      proposals: { byMe: 0, byThem: 1 },
      agreed: 5,
      open: 0,
      kept: 2,
      endedWithNotice: 1,
      theirNotice: { honoured: 1, broken: 0 },
      brokenByThem: 1,
      brokenByMe: 1,
      brokenByThemInEndgame: 1,
      retaliated: 1,
      proposedAgain: 1,
      keptRate: 0.75,
      turnsToBreak: [1],
      last: 'kept',
    });
    expect(playerRecord([]).keptRate).toBeNull();
  });

  it('caps the entries per player', () => {
    let entries: RecordEntry[] = [];
    for (let i = 0; i < MAX_RECORD_ENTRIES + 3; i++) entries = upsertEntry(entries, entry(walk(['agreed']), { key: String(i).padStart(32, '0'), now: i }));
    expect(entries).toHaveLength(MAX_RECORD_ENTRIES);
    expect(entries[0]!.updated).toBe(3);
  });
});

describe('the cross-game record on disk', () => {
  it('keys a player by a salted hash: neither the id nor the game is in the file', async () => {
    const dir = tmp();
    const a = walk(['agreed', 'ended']);
    const ok = await updatePlayerEntries(dir, P, (salt) => [
      recordEntryFor(a, { key: entryKey(salt, GAME, a.id), format: { players: 4, teams: false, ffaSize: 4 }, now: 10 }),
    ]);
    expect(ok).toBe(true);
    const text = readFileSync(playerRecordPath(dir), 'utf8');
    expect(text).not.toContain(String(P));
    expect(text).not.toContain(String(GAME));
    const salt = (await playerRecordSalt(dir))!;
    expect(Object.keys((JSON.parse(text) as { players: object }).players)).toEqual([playerKey(salt, P)]);
    expect(statSync(playerRecordPath(dir)).mode & 0o777).toBe(0o600);
    expect((await readPlayerEntries(dir, P)).map((e) => e.outcome)).toEqual(['kept']);
    expect(await readPlayerEntries(dir, 3333)).toEqual([]);
  });

  it('a different salt keys the same player differently', () => {
    expect(playerKey('a'.repeat(32), P)).not.toBe(playerKey('b'.repeat(32), P));
    expect(playerKey('a'.repeat(32), P)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is switched off by WARAPP_PLAYER_RECORD=off: nothing is read or written', async () => {
    const dir = tmp();
    const env = { WARAPP_PLAYER_RECORD: 'off' };
    expect(playerRecordEnabled(env)).toBe(false);
    expect(playerRecordEnabled({})).toBe(true);
    expect(await updatePlayerEntries(dir, P, () => [], env)).toBe(false);
    expect(() => statSync(playerRecordPath(dir))).toThrow();
    expect(await readPlayerEntries(dir, P, env)).toEqual([]);
  });
});
