// The agreement ledger on disk and the cross-game player record (docs/PLAN-TEAMS.md A2).
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addCounts, isZero, outcomeOf, playerRecord, recordDelta, ZERO_COUNTS } from '../src/analysis/player-record.js';
import { newAgreement, transitionAgreement, type Agreement, type AgreementStatus } from '../src/analysis/relations.js';
import {
  addPlayerCounts,
  playerKey,
  playerRecordEnabled,
  playerRecordPath,
  playerRecordSalt,
  readPlayerCounts,
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
});

describe('the record counts', () => {
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

  it('summarises a player: the counts and a kept rate, nothing else', () => {
    expect(playerRecord({ made: 5, kept: 2, endedWithNotice: 1, brokenByThem: 1, brokenByMe: 1 })).toEqual({
      made: 5,
      kept: 2,
      endedWithNotice: 1,
      brokenByThem: 1,
      brokenByMe: 1,
      keptRate: 0.75,
    });
    expect(playerRecord(ZERO_COUNTS).keptRate).toBeNull();
  });
});

describe('the cross-game record on disk', () => {
  it('keeps counts only, the player keyed by a salted hash: no id, game, turn or terms in the file', async () => {
    const dir = tmp();
    const delta = recordDelta(undefined, walk(['agreed']));
    expect(await addPlayerCounts(dir, P, delta, {})).toBe(true);
    expect(await addPlayerCounts(dir, P, recordDelta(walk(['agreed']), walk(['agreed', 'ended'])), {})).toBe(true);
    const text = readFileSync(playerRecordPath(dir), 'utf8');
    expect(text).not.toContain(String(P));
    expect(text).not.toContain(String(GAME));
    const salt = (await playerRecordSalt(dir))!;
    const file = JSON.parse(text) as { players: Record<string, Record<string, unknown>> };
    expect(Object.keys(file.players)).toEqual([playerKey(salt, P)]);
    expect(Object.keys(file.players[playerKey(salt, P)]!).sort()).toEqual(['counts', 'updated']);
    expect(statSync(playerRecordPath(dir)).mode & 0o777).toBe(0o600);
    expect(await readPlayerCounts(dir, P, {})).toEqual({ ...ZERO_COUNTS, made: 1, kept: 1 });
    expect(await readPlayerCounts(dir, 3333, {})).toBeUndefined();
  });

  it('a different salt keys the same player differently', () => {
    expect(playerKey('a'.repeat(32), P)).not.toBe(playerKey('b'.repeat(32), P));
    expect(playerKey('a'.repeat(32), P)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('drops unusable counts from a hand-edited file, never throwing', async () => {
    const dir = tmp();
    await addPlayerCounts(dir, P, { ...ZERO_COUNTS, made: 1 }, {});
    const salt = (await playerRecordSalt(dir))!;
    writeFileSync(playerRecordPath(dir), JSON.stringify({ version: 2, players: { [playerKey(salt, P)]: { counts: { made: 'x' }, updated: 1 } } }));
    expect(await readPlayerCounts(dir, P, {})).toBeUndefined();
    writeFileSync(playerRecordPath(dir), '{not json');
    expect(await readPlayerCounts(dir, P, {})).toBeUndefined();
  });

  it('is off with WARAPP_PLAYER_RECORD=off and always on a hosted child: nothing is read or written', async () => {
    expect(playerRecordEnabled({})).toBe(true);
    for (const env of [{ WARAPP_PLAYER_RECORD: 'off' }, { MCP_HOST_METER_FILE: '/tmp/meter' }, { FLY_MACHINE_ID: 'm1', WARAPP_PLAYER_RECORD: 'on' }]) {
      const dir = tmp();
      expect(playerRecordEnabled(env)).toBe(false);
      expect(await addPlayerCounts(dir, P, { ...ZERO_COUNTS, made: 1 }, env)).toBe(false);
      expect(() => statSync(playerRecordPath(dir))).toThrow();
      expect(await readPlayerCounts(dir, P, env)).toBeUndefined();
    }
  });
});
