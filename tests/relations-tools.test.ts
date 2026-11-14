// warapp_record_agreement and warapp_get_relations (docs/PLAN-TEAMS.md A2): recording a truce in the
// local ledger (not confirm-gated: nothing leaves the machine), its refusals, the breach watch over
// the cached boards, and the cross-game player record (salted, name-free, switchable).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
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
    record: null | 'off' | { brokenByThem: number; agreed: number };
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

  it('is registered on a hosted child too (the ledger lives in its per-user data dir)', async () => {
    h = await liveHarness({ env: { MCP_HOST_METER_FILE: '/tmp/meter' } });
    const names = (await h.harness.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['warapp_get_relations', 'warapp_record_agreement']));
  });
});

describe('warapp_record_agreement', () => {
  it('records a truce and its changes in a name-free ledger, without a confirmation step', async () => {
    h = await liveHarness({ feed: [game('2')] });
    const made = payload<RecordPayload>(await record({ with: 'Bob', status: 'proposed-by-them', territories: [159], notice_turns: 2, border_cap: 8 }));
    expect(made).toMatchObject({
      recorded: 'created',
      agreement: { id: 'a1', with: { id: Number(BOB.feed) }, status: 'proposed-by-them', state: 'proposed' },
      playerRecord: 'updated',
    });
    expect(made.agreement.with.name).toMatch(/^⟦Bob⟧$/);
    expect(made.agreement.terms).toMatchObject({ scope: { territories: [{ id: 159 }] }, noticeTurns: 2, borderCap: 8 });
    expect(made.written).toMatch(/nothing was sent to war\.app/);
    const agreed = payload<RecordPayload>(await record({ agreement_id: 'a1', status: 'agreed' }));
    expect(agreed.agreement).toMatchObject({ status: 'agreed', state: 'active' });
    const text = readFileSync(join(h.dataDir, 'relations', `${GAME}.json`), 'utf8');
    expect(text).not.toMatch(/Ann|Bob/);
    expect(JSON.parse(text)).toMatchObject({ gameId: GAME, playerId: Number(ANN.feed), agreements: [{ id: 'a1', with: Number(BOB.feed), status: 'agreed', agreedTurn: 3 }] });
    // The cross-game record: no player id, game id or name.
    const players = readFileSync(join(h.dataDir, 'relations', 'players.json'), 'utf8');
    for (const s of [BOB.feed, String(GAME), 'Bob', 'Ann']) expect(players).not.toContain(s);
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
    expect(first.agreements[0]).toMatchObject({ id: 'a1', state: 'active', trust: { level: 'clear' }, flags: [], record: { agreed: 1 } });
    expect(first.boards).toEqual({ turns: [3], live: true });
    const dir = h.dataDir;
    await h.harness.close();
    h = await liveHarness({ dataDir: dir, feed: [game('3')], warapp: live(boardAt({ bobTakes161: true })) });
    const p = payload<RelationsPayload>(await h.call('warapp_get_relations', { game_id: GAME, player: 'Ann', view: 'full' }));
    const a = p.agreements[0]!;
    expect(a.flags).toEqual([expect.objectContaining({ kind: 'broken', turn: 3, territories: [expect.objectContaining({ id: 161 })] })]);
    expect(a.trust).toEqual({ level: 'watch', reasons: ['flag: broken'] });
    expect(a.history).toHaveLength(1);
    const broke = payload<RecordPayload>(await record({ agreement_id: 'a1', status: 'broken-by-them' }));
    expect(broke.agreement).toMatchObject({ status: 'broken-by-them', state: 'over' });
    const after = payload<RelationsPayload>(await h.call('warapp_get_relations', { game_id: GAME, player: 'Ann' }));
    expect(after.agreements[0]).toMatchObject({ state: 'over', record: { brokenByThem: 1, agreed: 1 } });
    expect(after.agreements[0]).not.toHaveProperty('trust');
    const players = JSON.parse(readFileSync(join(dir, 'relations', 'players.json'), 'utf8')) as {
      players: Record<string, { entries: Array<{ outcome: string; breachFlag: string; breakTurn: number; context: unknown }> }>;
    };
    expect(Object.values(players.players)[0]!.entries[0]).toMatchObject({ outcome: 'broken-by-them', breachFlag: 'broken', breakTurn: 4 });
  });

  it('marks a new proposal from a partner after an over agreement as proposed again', async () => {
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
