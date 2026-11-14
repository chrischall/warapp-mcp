// The agreement ledger on disk and the cross-game player record (docs/PLAN-TEAMS.md A2).
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addCounts,
  isZero,
  MAX_RECORD_ENTRIES,
  outcomeOf,
  playerRecord,
  recordDelta,
  recordEntryFor,
  talliesOf,
  upsertEntry,
  ZERO_COUNTS,
  type RecordEntry,
} from '../src/analysis/player-record.js';
import { newAgreement, transitionAgreement, type Agreement, type AgreementStatus } from '../src/analysis/relations.js';
import {
  entryKey,
  legacyEntryKey,
  playerKey,
  playerRecordEnabled,
  playerRecordPath,
  playerRecordSalt,
  playerRecordSaltPath,
  playerRecordState,
  readPlayerRecord,
  updatePlayerRecord,
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
    expect(statSync(relationsPath(dir, GAME, ME)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'relations')).mode & 0o777).toBe(0o700);
    // Another account's ledger is not mine.
    expect(await readLedger(dir, GAME, 9999)).toBeUndefined();
  });

  it('keeps a second account in the same game apart: neither reads nor overwrites the other', async () => {
    const dir = tmp();
    const mineLedger = { ...emptyLedger(GAME, ME), agreements: [walk(['agreed'])] };
    const theirs = { ...emptyLedger(GAME, 9999), agreements: [{ ...walk(['proposed-by-me']), id: 'a1' }] };
    expect(await writeLedger(dir, mineLedger)).toBe(true);
    expect(await readLedger(dir, GAME, 9999)).toBeUndefined();
    expect(await writeLedger(dir, theirs)).toBe(true);
    expect(await readLedger(dir, GAME, ME)).toEqual(mineLedger);
    expect(await readLedger(dir, GAME, 9999)).toEqual(theirs);
  });

  it('reads only agreement ids it could have made, and writes them in number order', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'relations'), { recursive: true });
    const a = walk(['agreed']);
    const file = { gameId: GAME, playerId: ME, agreements: [{ ...a, id: 'a10' }, { ...a, id: 'x' }, { ...a, id: 'a2' }], usage: {} };
    writeFileSync(relationsPath(dir, GAME, ME), JSON.stringify(file));
    const back = (await readLedger(dir, GAME, ME))!;
    expect(back.agreements.map((x) => x.id)).toEqual(['a10', 'a2']);
    await writeLedger(dir, back);
    expect((await readLedger(dir, GAME, ME))!.agreements.map((x) => x.id)).toEqual(['a2', 'a10']);
  });

  it('drops an unusable agreement and never throws on a broken file', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'relations'), { recursive: true });
    const good = walk(['agreed']);
    writeFileSync(relationsPath(dir, GAME, ME), JSON.stringify({ gameId: GAME, playerId: ME, agreements: [good, { id: 'x', with: 'bob' }], usage: { '5': 'nope' } }));
    expect((await readLedger(dir, GAME, ME))?.agreements).toEqual([good]);
    writeFileSync(relationsPath(dir, GAME, ME), '{not json');
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

  it("keeps a turn's income lost to a break (T6) beside its armies, and reads older entries without it", async () => {
    const dir = tmp();
    await writeLedger(dir, emptyLedger(GAME, ME));
    expect(await recordTruceUsage(dir, GAME, ME, 8, [{ agreementId: 'a1', armiesFreed: 3, lossIfBroken: 24, incomeLostIfBroken: 5 }])).toBe(true);
    expect((await readLedger(dir, GAME, ME))!.usage['8']).toEqual([{ agreementId: 'a1', armiesFreed: 3, lossIfBroken: 24, incomeLostIfBroken: 5 }]);
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

  it('keeps the format, the turns, the terms shape, the outcome and the break context, never an id', () => {
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
    // A later write (retaliated, say) keeps the format, flag and context first recorded.
    const later = entry({ ...a, retaliated: false }, { format: { players: 9, teams: true, ffaSize: null }, now: 2 }, e);
    expect(later).toMatchObject({ format: e.format, breachFlag: 'broken', context: e.context, retaliated: false, updated: 2 });
  });

  it('caps the entries per player, dropping the least recently updated', () => {
    let entries: RecordEntry[] = [];
    for (let i = 0; i < MAX_RECORD_ENTRIES + 3; i++) entries = upsertEntry(entries, entry(walk(['agreed']), { key: String(i).padStart(32, '0'), now: i }));
    expect(entries).toHaveLength(MAX_RECORD_ENTRIES);
    expect(entries[0]!.updated).toBe(3);
  });
});

describe('the tallies', () => {
  it('counts each agreement once: made when first agreed, its outcome when it is over', () => {
    const steps = (statuses: AgreementStatus[]) => {
      let total = { ...ZERO_COUNTS };
      let before: Agreement | undefined;
      for (let i = 1; i <= statuses.length; i++) {
        const after = walk(statuses.slice(0, i));
        total = addCounts(total, recordDelta(before, after));
        before = after;
      }
      return total;
    };
    expect(steps(['proposed-by-them', 'agreed', 'notice-by-me', 'agreed', 'ended'])).toEqual({ ...ZERO_COUNTS, made: 1, kept: 1 });
    expect(steps(['agreed', 'notice-by-them', 'ended'])).toEqual({ ...ZERO_COUNTS, made: 1, endedWithNotice: 1 });
    expect(steps(['agreed', 'broken-by-them'])).toEqual({ ...ZERO_COUNTS, made: 1, brokenByThem: 1 });
    expect(steps(['agreed', 'broken-by-me'])).toEqual({ ...ZERO_COUNTS, made: 1, brokenByMe: 1 });
    // A proposal that never became an agreement counts nothing.
    expect(steps(['proposed-by-me', 'ended'])).toEqual(ZERO_COUNTS);
    // Re-recording an over agreement (e.g. `retaliated`) adds nothing.
    const broken = walk(['agreed', 'broken-by-me']);
    expect(isZero(recordDelta(broken, { ...broken, retaliated: true }))).toBe(true);
  });

  it('rebuilds tallies from entries alone (an old file)', () => {
    const e = (statuses: AgreementStatus[], key: string) =>
      recordEntryFor(walk(statuses), { key: key.repeat(32), format: { players: 4, teams: false, ffaSize: 4 }, now: 1 });
    expect(talliesOf([e(['agreed', 'ended'], 'a'), e(['agreed', 'broken-by-them'], 'b'), e(['proposed-by-me'], 'c')])).toEqual({
      ...ZERO_COUNTS,
      made: 2,
      kept: 1,
      brokenByThem: 1,
    });
  });

  it('summarises a player: the tallies, a kept rate, and what the entries show', () => {
    const k = (n: number) => String(n).padStart(32, '0');
    const entry = (a: Agreement, n: number, extra: Partial<RecordEntry> = {}, context?: RecordEntry['context']) => ({
      ...recordEntryFor(a, { key: k(n), format: { players: 5, teams: false, ffaSize: 5 }, now: n, ...(context ? { context } : {}) }),
      ...extra,
    });
    const entries = [
      entry(walk(['agreed', 'ended']), 1),
      entry(walk(['agreed', 'notice-by-them', 'ended']), 2),
      entry(walk(['proposed-by-them', 'agreed', 'broken-by-them']), 3, {}, { endgame: true, leader: 'partner', outgrowing: null }),
      entry(walk(['agreed', 'broken-by-me']), 4, { retaliated: true }),
      entry(walk(['agreed', 'ended']), 5, { proposedAgain: true }),
    ];
    // The tallies outlive entries dropped past the bound: here one more kept than the entries show.
    const tallies = { made: 6, kept: 3, endedWithNotice: 1, brokenByThem: 1, brokenByMe: 1 };
    expect(playerRecord(tallies, entries)).toEqual({
      ...tallies,
      keptRate: 0.8,
      entries: 5,
      proposals: { byMe: 0, byThem: 1 },
      open: 0,
      theirNotice: { honoured: 1, broken: 0 },
      brokenByThemInEndgame: 1,
      brokenByThemLeading: 1,
      retaliated: 1,
      proposedAgain: 1,
      turnsToBreak: [1],
      last: 'kept',
    });
    expect(playerRecord(ZERO_COUNTS).keptRate).toBeNull();
  });
});

describe('the cross-game record on disk', () => {
  const format = { players: 4, teams: false, ffaSize: 4 };
  const write = (dir: string, before: Agreement | undefined, after: Agreement, env = {}, now = 10) =>
    updatePlayerRecord(
      dir,
      P,
      (salt, current) => {
        const key = entryKey(salt, ME, GAME, after.id);
        return { delta: recordDelta(before, after), entries: [recordEntryFor(after, { key, format, now }, current.entries.find((e) => e.key === key))] };
      },
      env,
      now,
    );

  it('keeps entries and tallies per player, keyed by salted hashes: no player id, game id or name in the file', async () => {
    const dir = tmp();
    expect(await write(dir, undefined, walk(['agreed']))).toBe('updated');
    expect(await write(dir, walk(['agreed']), walk(['agreed', 'ended']), {}, 11)).toBe('updated');
    const text = readFileSync(playerRecordPath(dir), 'utf8');
    expect(text).not.toContain(String(P));
    expect(text).not.toContain(String(GAME));
    const salt = (await playerRecordSalt(dir))!;
    const file = JSON.parse(text) as { version: number; players: Record<string, Record<string, unknown>> };
    expect(file.version).toBe(3);
    expect(Object.keys(file.players)).toEqual([playerKey(salt, P)]);
    expect(statSync(playerRecordPath(dir)).mode & 0o777).toBe(0o600);
    expect(statSync(playerRecordSaltPath(dir)).mode & 0o777).toBe(0o600);
    const back = await readPlayerRecord(dir, P, {});
    expect(back).toMatchObject({ tallies: { ...ZERO_COUNTS, made: 1, kept: 1 }, entries: [{ key: entryKey(salt, ME, GAME, 'a1'), outcome: 'kept', agreedTurn: 3, endedTurn: 4 }] });
    expect(await readPlayerRecord(dir, 3333, {})).toBeNull();
  });

  it('a different salt keys the same player differently', () => {
    expect(playerKey('a'.repeat(32), P)).not.toBe(playerKey('b'.repeat(32), P));
    expect(playerKey('a'.repeat(32), P)).toMatch(/^[0-9a-f]{32}$/);
    expect(entryKey('a'.repeat(32), ME, GAME, 'a1')).not.toBe(entryKey('a'.repeat(32), ME, GAME + 1, 'a1'));
  });

  it('keys an entry by my account too: two local accounts in one game never collide', () => {
    const salt = 'a'.repeat(32);
    expect(entryKey(salt, ME, GAME, 'a1')).not.toBe(entryKey(salt, 9999, GAME, 'a1'));
    expect(entryKey(salt, ME, GAME, 'a1')).toMatch(/^[0-9a-f]{32}$/);
    // The key entries written before the account was part of it: read as they are.
    expect(legacyEntryKey(salt, GAME, 'a1')).toMatch(/^[0-9a-f]{32}$/);
    expect(legacyEntryKey(salt, GAME, 'a1')).not.toBe(entryKey(salt, ME, GAME, 'a1'));
  });

  it('never overwrites a record file it cannot parse: reads say unreadable, writes fail, the file stays as it was', async () => {
    for (const bad of ['{not json', '[]', '"text"', JSON.stringify({ version: 3, players: [] })]) {
      const dir = tmp();
      expect(await write(dir, undefined, walk(['agreed']))).toBe('updated');
      writeFileSync(playerRecordPath(dir), bad);
      expect(await readPlayerRecord(dir, P, {})).toBe('unreadable');
      expect(await playerRecordState(dir, {})).toBe('unreadable');
      expect(await write(dir, undefined, { ...walk(['agreed']), id: 'a2' })).toBe('failed');
      expect(readFileSync(playerRecordPath(dir), 'utf8')).toBe(bad);
    }
    // A missing file is simply empty.
    expect(await playerRecordState(tmp(), {})).toBe('on');
  });

  it('makes the salt only when it writes, and never replaces a malformed one', async () => {
    const dir = tmp();
    // A read makes nothing.
    expect(await readPlayerRecord(dir, P, {})).toBeNull();
    expect(existsSync(playerRecordSaltPath(dir))).toBe(false);
    expect(await playerRecordSalt(dir)).toBeUndefined();
    // A malformed salt: the read says so and the write refuses, leaving the file as it was.
    mkdirSync(join(dir, 'relations'), { recursive: true });
    writeFileSync(playerRecordSaltPath(dir), 'not a salt');
    expect(await readPlayerRecord(dir, P, {})).toBe('unreadable');
    expect(await write(dir, undefined, walk(['agreed']))).toBe('failed');
    expect(readFileSync(playerRecordSaltPath(dir), 'utf8')).toBe('not a salt');
    expect(existsSync(playerRecordPath(dir))).toBe(false);
  });

  it('two writes at once in this process both land', async () => {
    const dir = tmp();
    const a1 = walk(['agreed']);
    const a2 = { ...walk(['agreed']), id: 'a2' };
    expect(await Promise.all([write(dir, undefined, a1), write(dir, undefined, a2)])).toEqual(['updated', 'updated']);
    const back = await readPlayerRecord(dir, P, {});
    expect(back).toMatchObject({ tallies: { made: 2 } });
    expect((back as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it('reads older files loosely: counts-only (v2) and entries-only (v1); drops what it cannot use', async () => {
    const dir = tmp();
    await write(dir, undefined, walk(['agreed']));
    const salt = (await playerRecordSalt(dir))!;
    const key = playerKey(salt, P);
    const counts = { made: 2, kept: 1, endedWithNotice: 0, brokenByThem: 1, brokenByMe: 0 };
    writeFileSync(playerRecordPath(dir), JSON.stringify({ version: 2, players: { [key]: { counts, updated: 1 } } }));
    expect(await readPlayerRecord(dir, P, {})).toEqual({ tallies: counts, entries: [] });
    const e = recordEntryFor(walk(['agreed', 'broken-by-them']), { key: legacyEntryKey(salt, GAME, 'a1'), format, now: 1 });
    writeFileSync(playerRecordPath(dir), JSON.stringify({ version: 1, players: { [key]: { entries: [e, { key: 'nope' }] } } }));
    expect(await readPlayerRecord(dir, P, {})).toEqual({ tallies: { ...ZERO_COUNTS, made: 1, brokenByThem: 1 }, entries: [e] });
    writeFileSync(playerRecordPath(dir), JSON.stringify({ version: 2, players: { [key]: { counts: { made: 'x' }, updated: 1 } } }));
    expect(await readPlayerRecord(dir, P, {})).toBeNull();
    // A write over an older file carries its tallies forward.
    writeFileSync(playerRecordPath(dir), JSON.stringify({ version: 2, players: { [key]: { counts, updated: 1 } } }));
    expect(await write(dir, walk(['agreed']), walk(['agreed', 'ended']))).toBe('updated');
    expect(await readPlayerRecord(dir, P, {})).toMatchObject({ tallies: { ...counts, kept: 2 } });
  });

  it('is on by default, local and hosted, and off only with WARAPP_PLAYER_RECORD=off: then nothing is read or written', async () => {
    expect(playerRecordEnabled({})).toBe(true);
    expect(playerRecordEnabled({ MCP_HOST_METER_FILE: '/tmp/meter' })).toBe(true);
    expect(playerRecordEnabled({ FLY_MACHINE_ID: 'm1' })).toBe(true);
    for (const env of [{ WARAPP_PLAYER_RECORD: 'off' }, { WARAPP_PLAYER_RECORD: 'false' }, { FLY_MACHINE_ID: 'm1', WARAPP_PLAYER_RECORD: '0' }]) {
      const dir = tmp();
      expect(playerRecordEnabled(env)).toBe(false);
      expect(await write(dir, undefined, walk(['agreed']), env)).toBe('off');
      expect(existsSync(playerRecordPath(dir))).toBe(false);
      expect(existsSync(playerRecordSaltPath(dir))).toBe(false);
      expect(await readPlayerRecord(dir, P, env)).toBe('off');
    }
  });
});
