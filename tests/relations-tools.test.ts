// warapp_record_agreement and warapp_get_relations (docs/PLAN-TEAMS.md A2): recording a truce in the
// local ledger (not confirm-gated: nothing leaves the machine), its refusals, the breach watch over
// the cached boards, and the cross-game player record (salted, name-free, switchable).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readGameRecord } from '../src/replay.js';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { withPathLock } from '../src/path-lock.js';
import { entryKey, legacyEntryKey, playerRecordPath } from '../src/player-record-store.js';
import { withLedgerLock } from '../src/relations-store.js';
import { Method } from '../src/protocol/methods.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const CAT = { feed: '5523456788', inGame: 234567 };

/** The lobby fixture as a game being played: Ann, Bob and Cat, plus the fixture's other players unless `seats` cuts them. */
function game(numberOfTurns: string, opts: { state?: string; seats?: number; patch?: Record<string, Record<string, string>> } = {}) {
  const f = lobbyFixture();
  const named = [
    { id: ANN.feed, name: 'Ann' },
    { id: BOB.feed, name: 'Bob' },
    { id: CAT.feed, name: 'Cat' },
  ];
  const players = (f.players as Array<Record<string, string>>)
    .map((p, i) => ({ ...p, ...named[i], ...opts.patch?.[named[i]?.name ?? ''] }))
    .slice(0, opts.seats);
  return { ...f, state: opts.state ?? 'Playing', numberOfTurns, players };
}

// Ann holds 159 and 161; Bob's 158 borders both. 157 neutral, 135 fogged.
const boardAt = (opts: { bob158?: number; bobTakes161?: boolean } = {}): SyntheticTerritory[] => [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  opts.bobTakes161 ? { id: 161, fogLevel: 1, owner: BOB.inGame, armies: 2 } : { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: opts.bob158 ?? 7 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];
const live = (territories: SyntheticTerritory[]) => (req: DecodedRequest): Partial<ReplyFrame> => {
  if (req.method !== Method.GetLatestGameInfo) throw new Error(`unexpected method ${req.method}`);
  return { body: (w) => writeLatestGameInfo(w, territories, [ANN.inGame]) };
};

const record = (args: Record<string, unknown>) => h!.call('warapp_record_agreement', { game_id: GAME, player: 'Ann', ...args });

interface RecordPayload {
  recorded: string;
  agreement: { id: string; with: { id: number; name: string }; status: string; state: string; terms: Record<string, unknown>; history: unknown[] };
  playerRecord: string;
  written: string;
}
interface RelationsPayload {
  agreements: Array<{
    id: string;
    status: string;
    state: string;
    trust?: { level: string; reasons: string[] };
    flags: Array<{ kind: string; turn: number; territories: Array<{ id: number }> }>;
    record: null | 'off' | 'unreadable' | { brokenByThem: number; made: number };
    recordEntries?: unknown[];
    history?: unknown[];
  }>;
  tacit: unknown[];
  boards: { turns: number[]; live: boolean };
  playerRecord: string;
}

describe('the tools', () => {
  it('lists warapp_get_relations read-only and warapp_record_agreement as a write that reaches no one', async () => {
    h = await liveHarness();
    const tools = (await h.harness.client.listTools()).tools;
    expect(tools.find((t) => t.name === 'warapp_get_relations')!.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((t) => t.name === 'warapp_record_agreement')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tools.find((t) => t.name === 'warapp_record_agreement')!.description).toMatch(/Nothing is sent to war\.app/);
  });

  it('is registered on a hosted child too, with the player record on in its per-user data dir (owner decision D5)', async () => {
    h = await liveHarness({ feed: [game('2')], env: { MCP_HOST_METER_FILE: '/tmp/meter' } });
    const names = (await h.harness.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['warapp_get_relations', 'warapp_record_agreement']));
    expect(payload<RecordPayload>(await record({ with: 'Bob', status: 'agreed' })).playerRecord).toBe('updated');
    expect(existsSync(join(h.dataDir, 'relations', 'players.json'))).toBe(true);
    const p = payload<RelationsPayload>(await h.call('warapp_get_relations', { game_id: GAME, player: 'Ann' }));
    expect(p).toMatchObject({ playerRecord: 'on', agreements: [{ id: 'a1', record: { made: 1 } }] });
  });
});

describe('warapp_record_agreement', () => {
  it('refuses to record over a ledger file it cannot read, and leaves the file as it is (#232)', async () => {
    h = await liveHarness({ feed: [game('2')] });
    mkdirSync(join(h.dataDir, 'relations'), { recursive: true });
    const path = join(h.dataDir, 'relations', `${GAME}-${ANN.feed}.json`);
    writeFileSync(path, '{ not json');
    expect(textOf(await record({ with: 'Bob', status: 'agreed' }))).toMatch(/exists but cannot be read: nothing was recorded/);
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
    writeFileSync(path, JSON.stringify({ gameId: GAME, playerId: 1, agreements: [] }));
    expect(textOf(await record({ with: 'Bob', status: 'agreed' }))).toMatch(/cannot be read/);
  });

  it('records a truce and its changes in a name-free ledger, without a confirmation step', async () => {
    h = await liveHarness({ feed: [game('2')] });
    const made = payload<RecordPayload>(await record({ with: 'Bob', status: 'proposed-by-them', territories: [159], notice_turns: 2, border_cap: 8 }));
    expect(made).toMatchObject({
      recorded: 'created',
      agreement: { id: 'a1', with: { id: Number(BOB.feed) }, status: 'proposed-by-them', state: 'proposed' },
      // A proposal is an entry, but counts nothing yet.
      playerRecord: 'updated',
    });
    expect(made.agreement.with.name).toMatch(/^⟦Bob⟧$/);
    expect(made.agreement.terms).toMatchObject({ scope: { territories: [{ id: 159 }] }, noticeTurns: 2, borderCap: 8 });
    expect(made.written).toMatch(/nothing (?:is|was) sent to war\.app or to any player/);
    // The note names what is written and where, never "this machine": a hosted child writes too.
    expect(made.written).toMatch(/server's data directory/);
    expect(made.written).toMatch(/player record/);
    expect(made.written).not.toMatch(/this machine|local only/i);
    const agreed = payload<RecordPayload>(await record({ agreement_id: 'a1', status: 'agreed' }));
    expect(agreed).toMatchObject({ agreement: { status: 'agreed', state: 'active' }, playerRecord: 'updated' });
    const text = readFileSync(join(h.dataDir, 'relations', `${GAME}-${ANN.feed}.json`), 'utf8');
    expect(text).not.toMatch(/Ann|Bob/);
    expect(JSON.parse(text)).toMatchObject({ gameId: GAME, playerId: Number(ANN.feed), agreements: [{ id: 'a1', with: Number(BOB.feed), status: 'agreed', agreedTurn: 3 }] });
    // The cross-game record: an entry per agreement and the tallies, no player id, game id or name.
    const players = readFileSync(join(h.dataDir, 'relations', 'players.json'), 'utf8');
    for (const s of [BOB.feed, ANN.feed, String(GAME), 'Bob', 'Ann']) expect(players).not.toContain(s);
    const stored = Object.values((JSON.parse(players) as { players: Record<string, { tallies: unknown; entries: unknown[] }> }).players);
    expect(stored.map((x) => x.tallies)).toEqual([{ made: 1, kept: 0, endedWithNotice: 0, brokenByThem: 0, brokenByMe: 0 }]);
    expect(stored[0]!.entries).toEqual([
      expect.objectContaining({
        format: { players: expect.any(Number), teams: false, ffaSize: expect.any(Number) },
        proposedBy: 'them',
        agreedTurn: 3,
        endedTurn: null,
        terms: { scope: 'territories', scopeSize: 1, noticeTurns: 2, cap: 8, endCondition: 'none', against: false },
        outcome: 'open',
      }),
    ]);
    // Nothing went to war.app.
    expect(h.exchanges).toEqual([]);
  });

  it('refuses a partner who is me, an AI, out, a teammate, and in a 1v1', async () => {
    h = await liveHarness({ feed: [game('2', { patch: { Bob: { isAI: 'True' }, Cat: { state: 'Eliminated' } } })] });
    expect(textOf(await record({ with: 'Ann', status: 'agreed' }))).toMatch(/that is you: nothing was recorded/);
    expect(textOf(await record({ with: 'Bob', status: 'agreed' }))).toMatch(/is an AI/);
    expect(textOf(await record({ with: 'Cat', status: 'agreed' }))).toMatch(/no longer playing/);
    await h.harness.close();
    h = await liveHarness({ feed: [game('2', { patch: { Ann: { team: '1' }, Bob: { team: '1' } } })] });
    expect(textOf(await record({ with: 'Bob', status: 'agreed' }))).toMatch(/your teammate/);
    await h.harness.close();
    h = await liveHarness({ feed: [game('2', { seats: 2 })] });
    expect(textOf(await record({ with: 'Bob', status: 'agreed' }))).toMatch(/1v1/);
    await h.harness.close();
    // A 2v2-like seating: Bob's team holds everyone but me.
    h = await liveHarness({ feed: [game('2', { seats: 3, patch: { Ann: { team: '1' }, Bob: { team: '2' }, Cat: { team: '2' } } })] });
    expect(textOf(await record({ with: 'Bob', status: 'agreed' }))).toMatch(/no third player or team/);
  });

  it('refuses an until_turn already past, on create and on a terms change', async () => {
    h = await liveHarness({ feed: [game('4')] });
    expect(textOf(await record({ with: 'Bob', status: 'agreed', until_turn: 4 }))).toMatch(/until_turn 4 is before this turn \(5\): nothing was recorded/);
    payload(await record({ with: 'Bob', status: 'proposed-by-me', until_turn: 5 }));
    expect(textOf(await record({ agreement_id: 'a1', until_turn: 2 }))).toMatch(/until_turn 2 is before this turn/);
  });

  it('refuses a scope off the map, a second open agreement, a bad move, changed terms after agreeing, and a lobby', async () => {
    h = await liveHarness({ feed: [game('2')] });
    expect(textOf(await record({ with: 'Bob', status: 'agreed', territories: [999999] }))).toMatch(/No territory matches/);
    expect(textOf(await record({ with: 'Bob', status: 'ended' }))).toMatch(/starts as proposed-by-me, proposed-by-them, agreed/);
    payload(await record({ with: 'Bob', status: 'agreed' }));
    expect(textOf(await record({ with: 'Bob', status: 'proposed-by-me' }))).toMatch(/Agreement a1 with player \d+ is still agreed/);
    expect(textOf(await record({ agreement_id: 'a1', status: 'proposed-by-me' }))).toMatch(/cannot go from agreed to proposed-by-me/);
    expect(textOf(await record({ agreement_id: 'a1', border_cap: 3 }))).toMatch(/can no longer change/);
    expect(textOf(await record({ agreement_id: 'a1', retaliated: true }))).toMatch(/only after broken-by-me/);
    expect(textOf(await record({ agreement_id: 'a9', status: 'ended' }))).toMatch(/no agreement "a9"/);
    payload(await record({ agreement_id: 'a1', status: 'ended' }));
    expect(textOf(await record({ agreement_id: 'a1', status: 'agreed' }))).toMatch(/already ended/);
    await h.harness.close();
    h = await liveHarness({ feed: [game('-1', { state: 'WaitingForPlayers' })] });
    expect(textOf(await record({ with: 'Bob', status: 'agreed' }))).toMatch(/WaitingForPlayers/);
  });
});

describe('warapp_record_agreement terms', () => {
  it('takes bonuses, a third player it is aimed at or ends with, and retaliation after my break', async () => {
    h = await liveHarness({ feed: [game('2')] });
    expect(textOf(await record({ with: 'Bob', status: 'agreed', territories: [159], bonuses: [1] }))).toMatch(/not both/);
    expect(textOf(await record({ with: 'Bob', status: 'agreed', against: 'Bob' }))).toMatch(/must be a third player/);
    const made = payload<RecordPayload>(await record({ with: 'Bob', status: 'proposed-by-me', against: 'Cat', until_player_out: 'Cat', until_turn: 9 }));
    expect(made.agreement.terms).toMatchObject({ scope: 'all', untilTurn: 9, against: { id: Number(CAT.feed) }, untilPlayerOut: { id: Number(CAT.feed) } });
    const bonus = (lobbyFixture().map as { bonuses: Array<{ id: string }> }).bonuses[0]!.id;
    const changed = payload<RecordPayload>(await record({ agreement_id: 'a1', bonuses: [bonus], notice_turns: 0 }));
    expect(changed.agreement.terms).toMatchObject({ scope: { bonuses: [{ id: Number(bonus) }] }, noticeTurns: 0, untilTurn: 9 });
    payload(await record({ agreement_id: 'a1', status: 'agreed' }));
    payload(await record({ agreement_id: 'a1', status: 'broken-by-me' }));
    const after = payload<RecordPayload>(await record({ agreement_id: 'a1', retaliated: true }));
    expect(after.agreement).toMatchObject({ status: 'broken-by-me', retaliated: true });
    expect(textOf(await record({ agreement_id: 'a1' }))).toMatch(/Nothing to record/);
  });
});

describe('warapp_get_relations', () => {
  it('watches the board: a covered territory taken is broken, the record keeps the break', async () => {
    // Turn 3: agree, and read the board (cached). Turn 4: Bob has taken 161.
    h = await liveHarness({ feed: [game('2')], warapp: live(boardAt()) });
    payload(await record({ with: 'Bob', status: 'agreed' }));
    const first = payload<RelationsPayload>(await h.call('warapp_get_relations', { game_id: GAME, player: 'Ann' }));
    expect(first.agreements[0]).toMatchObject({ id: 'a1', state: 'active', trust: { level: 'clear' }, flags: [], record: { made: 1, keptRate: null } });
    expect(first.boards).toEqual({ turns: [3], live: true });
    const dir = h.dataDir;
    expect((await readGameRecord(dir, GAME))?.id).toBe(GAME);
    await h.harness.close();
    h = await liveHarness({ dataDir: dir, feed: [game('3')], warapp: live(boardAt({ bobTakes161: true })) });
    const p = payload<RelationsPayload>(await h.call('warapp_get_relations', { game_id: GAME, player: 'Ann', view: 'full' }));
    const a = p.agreements[0]!;
    expect(a.flags).toEqual([expect.objectContaining({ kind: 'broken', turn: 3, territories: [expect.objectContaining({ id: 161 })] })]);
    expect(a.trust).toEqual({ level: 'watch', reasons: ['flag: broken'] });
    expect(a.history).toHaveLength(1);
    const broke = payload<RecordPayload>(await record({ agreement_id: 'a1', status: 'broken-by-them' }));
    expect(broke.agreement).toMatchObject({ status: 'broken-by-them', state: 'over' });
    const after = payload<RelationsPayload>(await h.call('warapp_get_relations', { game_id: GAME, player: 'Ann', view: 'full' }));
    expect(after.agreements[0]).toMatchObject({ state: 'over', record: { brokenByThem: 1, made: 1, keptRate: 0, turnsToBreak: [1], last: 'broken-by-them' } });
    expect(after.agreements[0]).not.toHaveProperty('trust');
    // The full view lists the partner's entries, without their keys.
    expect(after.agreements[0]!.recordEntries).toEqual([expect.objectContaining({ outcome: 'broken-by-them', breachFlag: 'broken' })]);
    expect(after.agreements[0]!.recordEntries![0]).not.toHaveProperty('key');
    const players = JSON.parse(readFileSync(join(dir, 'relations', 'players.json'), 'utf8')) as {
      players: Record<string, { tallies: object; entries: Array<Record<string, unknown>> }>;
    };
    const stored = Object.values(players.players)[0]!;
    expect(stored.tallies).toEqual({ made: 1, kept: 0, endedWithNotice: 0, brokenByThem: 1, brokenByMe: 0 });
    // The break: its turn, the strongest flag the cached boards showed, and the context.
    expect(stored.entries[0]).toMatchObject({
      outcome: 'broken-by-them',
      agreedTurn: 3,
      endedTurn: 4,
      breakTurn: 4,
      breachFlag: 'broken',
      // Cat is never seen on these boards, so the endgame and the leader are unknown, not guessed.
      context: { endgame: null, leader: 'unknown', outgrowing: false },
    });
  });

  it('marks an over agreement as proposed again when the partner proposes a new one', async () => {
    h = await liveHarness({ feed: [game('2')] });
    payload(await record({ with: 'Bob', status: 'agreed' }));
    payload(await record({ agreement_id: 'a1', status: 'ended' }));
    payload(await record({ with: 'Bob', status: 'proposed-by-them' }));
    const players = JSON.parse(readFileSync(join(h.dataDir, 'relations', 'players.json'), 'utf8')) as {
      players: Record<string, { entries: Array<{ outcome: string; proposedAgain?: boolean }> }>;
    };
    const entries = Object.values(players.players)[0]!.entries;
    expect(entries.map((e) => [e.outcome, e.proposedAgain ?? false]).sort()).toEqual([
      ['kept', true],
      ['open', false],
    ]);
  });

  it('updates the player record inside the ledger lock, so records land in the order the ledger changed', async () => {
    h = await liveHarness({ feed: [game('2')] });
    payload(await record({ with: 'Bob', status: 'agreed' }));
    const dir = h.dataDir;
    const ledgerPath = join(dir, 'relations', `${GAME}-${ANN.feed}.json`);
    // Hold the record's lock: the call writes its ledger, then waits for the record.
    let release!: () => void;
    const blocker = withPathLock(playerRecordPath(dir), () => new Promise<void>((r) => (release = r)));
    const call = record({ agreement_id: 'a1', status: 'ended' });
    await vi.waitFor(() => expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).agreements[0].status).toBe('ended'));
    let probed = false;
    const probe = withLedgerLock(dir, GAME, Number(ANN.feed), async () => {
      probed = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    // The ledger's lock is still held while the record waits: another ledger change cannot slip between them.
    expect(probed).toBe(false);
    release();
    await blocker;
    expect(payload<RecordPayload>(await call).playerRecord).toBe('updated');
    await probe;
    expect(probed).toBe(true);
  });

  it('updates an entry written under the older key (no account in it) in place, never beside it', async () => {
    h = await liveHarness({ feed: [game('2')] });
    payload(await record({ with: 'Bob', status: 'agreed' }));
    const path = join(h.dataDir, 'relations', 'players.json');
    const salt = readFileSync(join(h.dataDir, 'relations', 'players.salt'), 'utf8').trim();
    const file = JSON.parse(readFileSync(path, 'utf8')) as { players: Record<string, { entries: Array<{ key: string; outcome: string }> }> };
    const stored = Object.values(file.players)[0]!;
    const old = legacyEntryKey(salt, GAME, 'a1');
    stored.entries[0]!.key = old;
    writeFileSync(path, JSON.stringify(file));
    payload(await record({ agreement_id: 'a1', status: 'ended' }));
    const after = Object.values((JSON.parse(readFileSync(path, 'utf8')) as typeof file).players)[0]!;
    expect(after.entries.map((e) => [e.key, e.outcome])).toEqual([[old, 'kept']]);
    // A new agreement is keyed with the account in it.
    payload(await record({ with: 'Bob', status: 'proposed-by-them' }));
    const keys = Object.values((JSON.parse(readFileSync(path, 'utf8')) as typeof file).players)[0]!.entries.map((e) => e.key);
    expect(keys).toContain(entryKey(salt, Number(ANN.feed), GAME, 'a2'));
  });

  it('counts each agreement once across its updates, and an over one never again', async () => {
    h = await liveHarness({ feed: [game('2')] });
    payload(await record({ with: 'Bob', status: 'agreed' }));
    payload(await record({ agreement_id: 'a1', status: 'notice-by-me' }));
    payload(await record({ agreement_id: 'a1', status: 'agreed' }));
    payload(await record({ agreement_id: 'a1', status: 'ended' }));
    payload(await record({ with: 'Bob', status: 'proposed-by-them' }));
    payload(await record({ agreement_id: 'a2', status: 'agreed' }));
    payload(await record({ agreement_id: 'a2', status: 'broken-by-me' }));
    expect(payload<RecordPayload>(await record({ agreement_id: 'a2', retaliated: true })).playerRecord).toBe('updated');
    const p = payload<RelationsPayload>(await h.call('warapp_get_relations', { game_id: GAME, player: 'Ann' }));
    expect(p.agreements[1]!.record).toMatchObject({ made: 2, kept: 1, endedWithNotice: 0, brokenByThem: 0, brokenByMe: 1, keptRate: 1, retaliated: 1, entries: 2 });
  });

  it('with a malformed salt file, records the ledger, reports the record failed, and never replaces the salt', async () => {
    h = await liveHarness({ feed: [game('2')] });
    mkdirSync(join(h.dataDir, 'relations'), { recursive: true });
    writeFileSync(join(h.dataDir, 'relations', 'players.salt'), 'garbled');
    expect(payload<RecordPayload>(await record({ with: 'Bob', status: 'agreed' }))).toMatchObject({ recorded: 'created', playerRecord: 'failed' });
    expect(readFileSync(join(h.dataDir, 'relations', 'players.salt'), 'utf8')).toBe('garbled');
    const p = payload<RelationsPayload>(await h.call('warapp_get_relations', { game_id: GAME, player: 'Ann' }));
    expect(p).toMatchObject({ playerRecord: 'unreadable', agreements: [{ id: 'a1', record: 'unreadable' }] });
  });

  it('with the player record off, keeps the ledger and writes no record', async () => {
    h = await liveHarness({ feed: [game('2')], env: { WARAPP_PLAYER_RECORD: 'off' } });
    expect(payload<RecordPayload>(await record({ with: 'Bob', status: 'agreed' })).playerRecord).toBe('off');
    expect(existsSync(join(h.dataDir, 'relations', 'players.json'))).toBe(false);
    expect(existsSync(join(h.dataDir, 'relations', 'players.salt'))).toBe(false);
    const p = payload<RelationsPayload>(await h.call('warapp_get_relations', { game_id: GAME, player: 'Ann' }));
    expect(p).toMatchObject({ playerRecord: 'off', agreements: [{ id: 'a1', record: 'off' }] });
  });

  it('with the live board unreadable, still lists the agreements from the cached boards', async () => {
    h = await liveHarness({ feed: [game('2')], warapp: () => ({ error: { code: 1 } }) as unknown as Partial<ReplyFrame> });
    payload(await record({ with: 'Bob', status: 'agreed' }));
    const p = payload<RelationsPayload & { notes: string[] }>(await h.call('warapp_get_relations', { game_id: GAME, player: 'Ann' }));
    expect(p.boards.live).toBe(false);
    expect(p.agreements[0]).toMatchObject({ id: 'a1', state: 'active' });
    expect(p.notes.join(' ')).toMatch(/live board could not be read/);
  });
});

// B2: warapp_plan_turn resolves the ledger into the planner's relations (the rules themselves are
// tested in tests/analysis/lessons-diplomacy.test.ts).
interface PlanPayload {
  relations?: Array<{
    player: { id: number; name: string | null };
    agreement?: string;
    state: string;
    honoured: boolean;
    trust: string;
    flags: string[];
    breach?: { term: string; turn: number; territories: Array<{ id: number }> };
    lossIfBroken?: { from: { id: number }; to: { id: number }; deploy: number; armies: number; bonusValue: number; territories: Array<{ id: number }> } | null;
  }>;
  advice?: unknown[];
  tacit?: unknown[];
  warnings: string[];
  rationale: string[];
}
const planTurn = async (view?: 'full') =>
  payload<PlanPayload>(await h!.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', ...(view ? { view } : {}) }));

describe('warapp_plan_turn — the truces in the ledger (B2)', () => {
  it('without an agreement the plan carries no relations', async () => {
    h = await liveHarness({ feed: [game('2')], warapp: live(boardAt()) });
    const p = await planTurn();
    expect(p).not.toHaveProperty('relations');
    expect(p).not.toHaveProperty('advice');
  });

  it('honours an agreed truce, names the partner as untrusted text, and logs the armies it freed and what a break would cost (T6)', async () => {
    h = await liveHarness({ feed: [game('2')], warapp: live(boardAt()) });
    payload(await record({ with: 'Bob', status: 'agreed' }));
    const p = await planTurn();
    expect(p.relations).toEqual([
      expect.objectContaining({ player: { id: Number(BOB.feed), name: '⟦Bob⟧' }, agreement: 'a1', state: 'active', honoured: true, trust: 'clear' }),
    ]);
    expect(p.rationale.join('\n')).toMatch(/Truce with player \d+ \(agreement a1\): none of its \d+ covered territor/);
    const ledger = JSON.parse(readFileSync(join(h.dataDir, 'relations', `${GAME}-${ANN.feed}.json`), 'utf8')) as {
      usage: Record<string, Array<{ agreementId: string; armiesFreed: number | null; lossIfBroken: number | null; incomeLostIfBroken?: number | null }>>;
    };
    // Bob's 7 on 158 and its deploy break in: the plan reports it by name, and the ledger logs the armies and income.
    const loss = p.relations![0]!.lossIfBroken!;
    expect(loss).toMatchObject({ from: expect.objectContaining({ id: 158 }), deploy: expect.any(Number) });
    expect([159, 161]).toContain(loss.to.id);
    expect(ledger.usage['3']).toEqual([
      { agreementId: 'a1', armiesFreed: expect.any(Number), lossIfBroken: loss.armies, incomeLostIfBroken: loss.bonusValue },
    ]);
    expect(loss.armies).toBeGreaterThan(0);
  });

  it('never honours an `enforced` flag written into the ledger: no decoder vouches for it (T9)', async () => {
    h = await liveHarness({ feed: [game('2')], warapp: live(boardAt()) });
    payload(await record({ with: 'Bob', status: 'agreed' }));
    // A hand-edited (or future-written) file claiming a Diplomacy card holds Bob.
    const file = join(h.dataDir, 'relations', `${GAME}-${ANN.feed}.json`);
    const ledger = JSON.parse(readFileSync(file, 'utf8')) as { agreements: Array<Record<string, unknown>> };
    ledger.agreements[0]!.enforced = true;
    writeFileSync(file, JSON.stringify(ledger));
    const p = await planTurn();
    expect(p.relations).toEqual([expect.objectContaining({ agreement: 'a1', honoured: true, enforced: false })]);
    expect(p.rationale.join('\n')).not.toMatch(/Diplomacy card is in effect/);
  });

  it('maps the give-notice advice, naming the partner as untrusted text, when Bob outgrows me (T7)', async () => {
    h = await liveHarness({ feed: [game('2', { seats: 3 })], warapp: live(boardAt()) });
    payload(await record({ with: 'Bob', status: 'agreed' }));
    // Turn 3's board is cached by the plan; on turn 4 Bob's stack beside me has grown far past my income.
    await planTurn();
    const dir = h.dataDir;
    await h.harness.close();
    h = await liveHarness({ dataDir: dir, feed: [game('3', { seats: 3 })], warapp: live(boardAt({ bob158: 20 })) });
    const p = await planTurn();
    expect(p.relations).toEqual([expect.objectContaining({ agreement: 'a1', trust: 'watch', flags: expect.arrayContaining(['outgrowing']) })]);
    expect(p.advice).toEqual([
      { kind: 'give-notice', player: { id: Number(BOB.feed), name: '⟦Bob⟧' }, agreement: 'a1', why: expect.stringMatching(/^player \d+ is outgrowing me$/) },
    ]);
    expect(p.warnings.join('\n')).toMatch(/Truce with player \d+ \(agreement a1\): give notice \(T7\)/);
  });

  it("maps a border cap's moves back by name (T5)", async () => {
    // Bob's 2 on 158 keep the cap of 2; my 3 on 161 stand above it.
    h = await liveHarness({ feed: [game('2', { seats: 3 })], warapp: live(boardAt({ bob158: 2 })) });
    payload(await record({ with: 'Bob', status: 'agreed', territories: [161, 158], border_cap: 2 }));
    const p = await planTurn();
    expect(p.relations).toEqual([
      expect.objectContaining({ agreement: 'a1', capMoved: [{ from: expect.objectContaining({ id: 161 }), to: expect.objectContaining({ id: 159 }), armies: 1 }] }),
    ]);
  });

  it('reports a quiet border with no agreement as tacit, never as a truce', async () => {
    let dir: string | undefined;
    // Four turns of the same board: Bob's border stays quiet three turns running.
    for (const turn of ['2', '3', '4', '5']) {
      await h?.harness.close();
      h = await liveHarness({ ...(dir ? { dataDir: dir } : {}), feed: [game(turn, { seats: 3 })], warapp: live(boardAt()) });
      dir = h.dataDir;
      await planTurn();
    }
    const p = await planTurn();
    expect(p).not.toHaveProperty('relations');
    expect(p.tacit).toEqual([
      { player: { id: Number(BOB.feed), name: '⟦Bob⟧' }, quietTurns: 3, border: [expect.objectContaining({ id: 159 }), expect.objectContaining({ id: 161 })] },
    ]);
  });

  it('a covered territory Bob took is a break: an ordinary opponent the same turn, with the evidence (T8)', async () => {
    h = await liveHarness({ feed: [game('2')], warapp: live(boardAt()) });
    payload(await record({ with: 'Bob', status: 'agreed' }));
    // Turn 3's board is cached by the plan.
    await planTurn();
    const dir = h.dataDir;
    await h.harness.close();
    h = await liveHarness({ dataDir: dir, feed: [game('3')], warapp: live(boardAt({ bobTakes161: true })) });
    const p = await planTurn();
    expect(p.relations).toEqual([
      expect.objectContaining({
        agreement: 'a1',
        state: 'broken',
        honoured: false,
        trust: 'watch',
        flags: ['broken'],
        breach: expect.objectContaining({ term: 'took or attacked a covered territory of mine', turn: 3, territories: [expect.objectContaining({ id: 161 })] }),
      }),
    ]);
    expect(p.warnings.join('\n')).toMatch(/Truce with player \d+ \(agreement a1\) is broken by them: took or attacked a covered territory of mine on turn 3 .*\(T8\)/);
  });
});

// B2 T6: warapp_check_plan keeps a truce partner among the opponents it tries (`safe` is still safe
// against a break) and adds the verdict if every truce holds.
interface CheckPayload {
  safe: boolean | null;
  safeIfTruceHolds?: boolean | null;
  truces?: Array<{ player: { id: number }; agreement?: string; state: string; covered: number }>;
  worst: { opponent: { id: number }; breaksTruce?: boolean } | null;
  summary: string;
}
const checkPlan = async () =>
  payload<CheckPayload>(
    await h!.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: [{ kind: 'deploy', territory: 159, armies: 5 }] }),
  );

describe('warapp_check_plan — the truces in the ledger (B2 T6)', () => {
  it('without an agreement there is no safeIfTruceHolds', async () => {
    h = await liveHarness({ feed: [game('2')], warapp: live(boardAt()) });
    const p = await checkPlan();
    expect(p.safe).toBe(false);
    expect(p).not.toHaveProperty('safeIfTruceHolds');
    expect(p).not.toHaveProperty('truces');
  });

  it("still tries Bob's break of a truce covering both my territories, and says nothing else is tried", async () => {
    h = await liveHarness({ feed: [game('2')], warapp: live(boardAt()) });
    payload(await record({ with: 'Bob', status: 'agreed' }));
    const p = await checkPlan();
    expect(p.safe).toBe(false);
    expect(p.worst).toMatchObject({ opponent: { id: Number(BOB.feed) }, breaksTruce: true });
    expect(p.safeIfTruceHolds).toBeNull();
    expect(p.truces).toEqual([{ player: expect.objectContaining({ id: Number(BOB.feed) }), agreement: 'a1', state: 'active', covered: 2 }]);
    expect(p.summary).toMatch(/Every reply tried breaks a truce/);
  });

  it('a truce covering only 159 leaves the attack on 161 counted: not safe if the truce holds either', async () => {
    h = await liveHarness({ feed: [game('2')], warapp: live(boardAt()) });
    payload(await record({ with: 'Bob', status: 'agreed', territories: [159, 158] }));
    const p = await checkPlan();
    expect(p.safe).toBe(false);
    expect(p.safeIfTruceHolds).toBe(false);
  });

  it('an FFA down to two is a 1v1 to the planner: the truce is over (two left), so the stress test leaves it out too (whole-branch review)', async () => {
    h = await liveHarness({ feed: [game('2', { seats: 3 })], warapp: live(boardAt()) });
    payload(await record({ with: 'Bob', status: 'agreed' }));
    const { dataDir } = h;
    await h.harness.close();
    h = await liveHarness({ dataDir, feed: [game('3', { seats: 3, patch: { Cat: { state: 'SurrenderAccepted' } } })], warapp: live(boardAt()) });
    const p = await checkPlan();
    expect(p).not.toHaveProperty('safeIfTruceHolds');
    expect(p).not.toHaveProperty('truces');
    expect(p.worst).not.toHaveProperty('breaksTruce');
  });
});

// B2: warapp_submit_turn refuses an order that attacks a covered territory of an active or in-notice
// truce unless break_agreement is true; with it, the preview names the agreement and the ledger (and the
// partner's player record) records broken-by-me once the orders are committed.
describe('warapp_submit_turn — breaking a truce (B2)', () => {
  const ME_PAGE = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };
  // Deploy 5 on 159 and attack Bob's 158 from 161: a break of a truce covering everything.
  const ATTACK = [
    { kind: 'deploy', territory: 159, armies: 5 },
    { kind: 'move', from: 161, to: 158, armies: 2 },
  ];
  const withOrders = (sent: unknown[]) => (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method === Method.SendOrders) {
      sent.push(req);
      return { body: (w) => w.bool(false) };
    }
    return live(boardAt())(req);
  };
  const submit = (args: Record<string, unknown>) => h!.call('warapp_submit_turn', { game_id: GAME, orders: ATTACK, ...args });
  const ledgerFile = () => JSON.parse(readFileSync(join(h!.dataDir, 'relations', `${GAME}-${ANN.feed}.json`), 'utf8')) as {
    agreements: Array<{ id: string; status: string; endedTurn?: number }>;
  };

  it('refuses the attack without break_agreement, naming the agreement, and sends nothing', async () => {
    const sent: unknown[] = [];
    h = await liveHarness({ feed: [game('2')], pages: ME_PAGE, warapp: withOrders(sent) });
    payload(await record({ with: 'Bob', status: 'agreed' }));
    const r = await submit({});
    expect(textOf(r)).toMatch(/These orders break a truce — agreement a1 with player \d+ \(active\): move 1 \(161 → 158\) attacks a territory it covers: nothing was sent/);
    expect(textOf(r)).toMatch(/break_agreement: true/);
    expect(JSON.stringify(r)).not.toMatch(/confirmToken/);
    expect(sent).toEqual([]);
    expect(ledgerFile().agreements[0]!.status).toBe('agreed');
  });

  it('a truce in notice still binds; one not covering 158 does not', async () => {
    h = await liveHarness({ feed: [game('2')], pages: ME_PAGE, warapp: withOrders([]) });
    payload(await record({ with: 'Bob', status: 'agreed' }));
    payload(await record({ agreement_id: 'a1', status: 'notice-by-me' }));
    expect(textOf(await submit({}))).toMatch(/agreement a1 with player \d+ \(in notice, still binding\)/);
    payload(await record({ agreement_id: 'a1', status: 'ended' }));
    payload(await record({ with: 'Bob', status: 'agreed', territories: [159, 161] }));
    // 158 is not covered: no break, the preview goes ahead.
    expect(payload<{ confirmToken?: string }>(await submit({})).confirmToken).toEqual(expect.any(String));
  });

  it('with break_agreement: true, warns in the preview, sends, and records broken-by-me in the ledger and the player record', async () => {
    const sent: unknown[] = [];
    // record, preview, confirm, read back (the turn resolved), then the re-read for the record.
    h = await liveHarness({ feed: [game('2'), game('2'), game('2'), game('3')], pages: ME_PAGE, warapp: withOrders(sent) });
    payload(await record({ with: 'Bob', status: 'agreed' }));
    const preview = payload<{ confirmToken: string; preview: { warnings: string[] } }>(await submit({ break_agreement: true }));
    expect(preview.preview.warnings.join('\n')).toMatch(/agreement a1 with player \d+ \(active\).*break_agreement is true: once these orders are committed the ledger records it broken-by-me/);
    expect(preview.preview.warnings.join('\n')).toMatch(/That is final: withdrawing the orders afterwards \(warapp_uncommit_turn\) does not undo it\./);
    expect(sent).toEqual([]);
    const done = payload<{ status: string; outcome: string; agreementsBroken: Array<{ agreement: string; ledger: string; playerRecord?: string }> }>(
      await submit({ break_agreement: true, confirmToken: preview.confirmToken }),
    );
    expect(sent).toHaveLength(1);
    expect(done).toMatchObject({ status: 'resolved', outcome: 'confirmed' });
    expect(done.agreementsBroken).toEqual([{ agreement: 'a1', ledger: 'recorded', playerRecord: 'updated' }]);
    expect(ledgerFile().agreements[0]).toMatchObject({ id: 'a1', status: 'broken-by-me', endedTurn: 3 });
    const rel = payload<RelationsPayload>(await h.call('warapp_get_relations', { game_id: GAME, player: 'Ann' }));
    expect(rel.agreements[0]!.record).toMatchObject({ made: 1 });
    expect(JSON.stringify(rel.agreements[0]!.record)).toMatch(/"brokenByMe":1/);
  });

  it('with break_agreement but the orders not confirmed, the ledger is left for the player to record', async () => {
    h = await liveHarness({ feed: [game('2')], pages: ME_PAGE, warapp: withOrders([]) });
    payload(await record({ with: 'Bob', status: 'agreed' }));
    const preview = payload<{ confirmToken: string }>(await submit({ break_agreement: true }));
    const done = payload<{ outcome: string; agreementsBroken: Array<{ agreement: string; ledger: string; why: string }> }>(
      await submit({ break_agreement: true, confirmToken: preview.confirmToken }),
    );
    expect(done.outcome).toBe('unconfirmed');
    expect(done.agreementsBroken).toEqual([{ agreement: 'a1', ledger: 'not-recorded', why: expect.stringMatching(/broken-by-me/) }]);
    expect(ledgerFile().agreements[0]!.status).toBe('agreed');
  });
});
