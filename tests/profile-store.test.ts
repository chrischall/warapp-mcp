// The in-game opponent profile on disk (docs/PLAN-PROFILES.md A2): every observed turn kept, a turn
// observed again overwritten, the off switch, the file modes, a bad file read as empty, the bound.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/analysis/graph.js';
import type { TurnBoard } from '../src/analysis/opponents.js';
import {
  MAX_PROFILE_GAME_FILES,
  profileEnabled,
  profileGamePath,
  profileState,
  profileGamesDir,
  readProfileTurns,
  recordBehaviour,
  type BehaviourInput,
} from '../src/profile-store.js';
import { BOARD_CACHE_MAX_AGE_MS } from '../src/trend.js';
import { board, mine, neutral, tinyMap } from './analysis/helpers.js';

const ME = 10;
const OPP = 20;
const GAME = 4242;
const tmp = () => mkdtempSync(join(tmpdir(), 'warapp-mcp-profile-'));
const g = buildGraph(tinyMap());

/** Turns `from`..`to`: I hold 3 (its other neighbours neutral), it holds 4 and grows by one a turn; my orders attack nothing. */
function boards(from: number, to: number): TurnBoard[] {
  const out: TurnBoard[] = [];
  for (let t = from; t <= to; t++)
    out.push({ turn: t, board: board([neutral(1, 2), neutral(2, 2), mine(3, 5), mine(4, 2 + t, OPP), mine(5, 2, OPP)]), orders: { deploys: [], moves: [] } });
  return out;
}
const input = (b: TurnBoard[]): BehaviourInput => ({ gameId: GAME, me: ME, graph: g, settings: {}, opponents: [OPP], cards: [], boards: b });

describe('profileEnabled', () => {
  it('is on unless WARAPP_PLAYER_PROFILE says off', () => {
    expect(profileEnabled({})).toBe(true);
    expect(profileEnabled({ WARAPP_PLAYER_PROFILE: 'on' })).toBe(true);
    for (const v of ['off', 'OFF', '0', 'false', 'no', ' no ']) expect(profileEnabled({ WARAPP_PLAYER_PROFILE: v })).toBe(false);
  });
});

describe('profileState', () => {
  it('is kept with a data dir, not kept without one, and off when switched off', () => {
    expect(profileState({}, '/data')).toBe('kept');
    expect(profileState({}, undefined)).toBe('not-kept');
    expect(profileState({ WARAPP_PLAYER_PROFILE: 'off' }, '/data')).toBe('off');
    expect(profileState({ WARAPP_PLAYER_PROFILE: 'off' }, undefined)).toBe('off');
  });
});

describe('recordBehaviour', () => {
  it('stores one entry per consecutive pair, keeps every turn ever observed, and rewrites a turn observed again', async () => {
    const dir = tmp();
    expect(await recordBehaviour(dir, input(boards(1, 12)), {})).toBe(true);
    const first = readFileSync(profileGamePath(dir, GAME, ME), 'utf8');
    const turns = await readProfileTurns(dir, GAME, ME, {});
    expect(turns.get(OPP)!.map((t) => t.turn)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(turns.get(OPP)![0]!.primitives).toMatchObject({ contact: true, attackedMe: false, stack: { top: 1, total: 1 } });
    // The same boards again: byte-identical file.
    await recordBehaviour(dir, input(boards(1, 12)), {});
    expect(readFileSync(profileGamePath(dir, GAME, ME), 'utf8')).toBe(first);
    // Only the last ten turns handed in later (as the board cache keeps): the earlier turns stay.
    await recordBehaviour(dir, input(boards(4, 13)), {});
    expect((await readProfileTurns(dir, GAME, ME, {})).get(OPP)!.map((t) => t.turn)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // A turn observed again without my orders (withdrawn) is rewritten without them.
    const noOrders = boards(12, 13).map(({ orders: _o, ...b }) => b);
    await recordBehaviour(dir, input(noOrders), {});
    expect((await readProfileTurns(dir, GAME, ME, {})).get(OPP)!.at(-1)).toMatchObject({ turn: 12, primitives: { attackedMe: null } });
  });

  it('observes no pair with a board read from GameFeed history (unverified for a game in progress)', async () => {
    const dir = tmp();
    const b = boards(1, 4).map((x) => (x.turn === 2 ? { ...x, source: 'history' as const } : x));
    await recordBehaviour(dir, input(b), {});
    expect((await readProfileTurns(dir, GAME, ME, {})).get(OPP)!.map((t) => t.turn)).toEqual([3]);
  });

  it('passes the cards in play: orders without card plays in a game that may have Airlift read no attack from armies', async () => {
    const dir = tmp();
    const { cards: _c, ...unknown } = input(boards(1, 2));
    await recordBehaviour(dir, unknown, {});
    expect((await readProfileTurns(dir, GAME, ME, {})).get(OPP)![0]!.primitives.attackedMe).toBeNull();
    await recordBehaviour(dir, { ...input(boards(1, 2)), cards: ['Airlift'] }, {});
    expect((await readProfileTurns(dir, GAME, ME, {})).get(OPP)![0]!.primitives.attackedMe).toBeNull();
    await recordBehaviour(dir, { ...input(boards(1, 2)), cards: ['Reinforcement'] }, {});
    expect((await readProfileTurns(dir, GAME, ME, {})).get(OPP)![0]!.primitives.attackedMe).toBe(false);
  });

  it('skips pairs that are not consecutive turns, and writes nothing with nothing to observe', async () => {
    const dir = tmp();
    const b = boards(1, 5).filter((x) => x.turn !== 3);
    await recordBehaviour(dir, input(b), {});
    expect((await readProfileTurns(dir, GAME, ME, {})).get(OPP)!.map((t) => t.turn)).toEqual([1, 4]);
    const empty = tmp();
    expect(await recordBehaviour(empty, input(boards(3, 3)), {})).toBe(false);
    expect(existsSync(profileGamesDir(empty))).toBe(false);
  });

  it('drops every entry of a known teammate, even with nothing new to observe', async () => {
    const dir = tmp();
    try {
      await recordBehaviour(dir, input(boards(1, 4)), {});
      expect((await readProfileTurns(dir, GAME, ME, {})).get(OPP)).toHaveLength(3);
      // Later known as my teammate: one board (nothing to observe) still clears what was kept for it.
      expect(await recordBehaviour(dir, { ...input(boards(5, 5)), opponents: [], teammates: [OPP] }, {})).toBe(true);
      expect((await readProfileTurns(dir, GAME, ME, {})).has(OPP)).toBe(false);
      expect(Object.keys((JSON.parse(readFileSync(profileGamePath(dir, GAME, ME), 'utf8')) as { turns: object }).turns)).toEqual(['1', '2', '3']);
      // Nothing left to drop and nothing to observe: no write.
      expect(await recordBehaviour(dir, { ...input(boards(5, 5)), opponents: [], teammates: [OPP] }, {})).toBe(false);
      // Observed turns never keep a teammate either.
      await recordBehaviour(dir, { ...input(boards(1, 4)), teammates: [OPP] }, {});
      expect((await readProfileTurns(dir, GAME, ME, {})).has(OPP)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is 0600 in a 0700 folder, and holds ids and counts only', async () => {
    const dir = tmp();
    await recordBehaviour(dir, input(boards(1, 3)), {});
    expect(statSync(profileGamePath(dir, GAME, ME)).mode & 0o777).toBe(0o600);
    expect(statSync(profileGamesDir(dir)).mode & 0o777).toBe(0o700);
    const f = JSON.parse(readFileSync(profileGamePath(dir, GAME, ME), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(f).sort()).toEqual(['gameId', 'playerId', 'turns', 'version']);
  });

  it('with WARAPP_PLAYER_PROFILE=off reads and writes nothing', async () => {
    const dir = tmp();
    await recordBehaviour(dir, input(boards(1, 3)), {});
    const off = { WARAPP_PLAYER_PROFILE: 'off' };
    expect(await recordBehaviour(dir, input(boards(1, 6)), off)).toBe(false);
    expect((await readProfileTurns(dir, GAME, ME, off)).size).toBe(0);
    expect((await readProfileTurns(dir, GAME, ME, {})).get(OPP)!.map((t) => t.turn)).toEqual([1, 2]);
    const fresh = tmp();
    await recordBehaviour(fresh, input(boards(1, 3)), off);
    expect(existsSync(join(fresh, 'profiles'))).toBe(false);
  });

  it('keeps captures that could not be told as null, never as none', async () => {
    const dir = tmp();
    // A Gift in play and my card plays not recorded: what it took from me cannot be told.
    const b = boards(1, 3);
    await recordBehaviour(dir, { ...input(b), cards: ['Gift'] }, {});
    const turns = (await readProfileTurns(dir, GAME, ME, {})).get(OPP)!;
    expect(turns.map((t) => t.primitives.tookFromMe)).toEqual([null, null]);
    expect(turns.map((t) => t.primitives.attackedMe)).toEqual([null, null]);
  });

  it('keeps the jab reading (#361), and reads a record kept before it as unknown', async () => {
    const dir = tmp();
    await recordBehaviour(dir, input(boards(1, 3)), {});
    // Exact combat (the settings state no luck), my border read and quiet: no jab, read.
    expect((await readProfileTurns(dir, GAME, ME, {})).get(OPP)!.map((t) => t.primitives.jabs)).toEqual([0, 0]);
    const old = { contact: true, attackedMe: true, iAttacked: false, reinforce: { n: 0, e: 0, extra: 0 }, stack: null, tookFromMe: [], lostToMe: [] };
    writeFileSync(profileGamePath(dir, GAME, ME), JSON.stringify({ version: 1, gameId: GAME, playerId: ME, turns: { '2': { [OPP]: old } } }));
    const [t] = (await readProfileTurns(dir, GAME, ME, {})).get(OPP)!;
    expect(t!.primitives).toEqual(old);
    expect(t!.primitives).not.toHaveProperty('jabs');
    expect(t!.primitives).not.toHaveProperty('topUp');
  });

  it('reads an unusable file as empty, drops unusable entries, and never throws', async () => {
    const dir = tmp();
    mkdirSync(profileGamesDir(dir), { recursive: true });
    writeFileSync(profileGamePath(dir, GAME, ME), '{not json');
    expect((await readProfileTurns(dir, GAME, ME, {})).size).toBe(0);
    writeFileSync(
      profileGamePath(dir, GAME, ME),
      JSON.stringify({ version: 1, gameId: GAME, playerId: ME, turns: { '2': { '20': { contact: 'yes' }, '30': null }, x: {} } }),
    );
    expect((await readProfileTurns(dir, GAME, ME, {})).size).toBe(0);
    // Another account's file for the game is not mine.
    writeFileSync(profileGamePath(dir, GAME, ME), JSON.stringify({ version: 1, gameId: GAME, playerId: 99, turns: {} }));
    expect((await readProfileTurns(dir, GAME, ME, {})).size).toBe(0);
    // A data dir that is a file: no throw, nothing written.
    const file = join(tmp(), 'f');
    writeFileSync(file, '');
    expect(await recordBehaviour(file, input(boards(1, 3)), {})).toBe(false);
  });

  it(`keeps the newest ${MAX_PROFILE_GAME_FILES} game files`, async () => {
    const dir = tmp();
    mkdirSync(profileGamesDir(dir), { recursive: true });
    const old = Date.now() / 1000 - 86_400;
    for (let i = 0; i < MAX_PROFILE_GAME_FILES; i++) {
      const p = profileGamePath(dir, 1000 + i, ME);
      writeFileSync(p, '{}');
      utimesSync(p, old + i, old + i);
    }
    await recordBehaviour(dir, input(boards(1, 2)), {});
    const names = readdirSync(profileGamesDir(dir));
    expect(names).toHaveLength(MAX_PROFILE_GAME_FILES);
    expect(names).toContain(`${GAME}-${ME}.json`);
    expect(names).not.toContain(`1000-${ME}.json`);
  });

  it('deletes a game file not written for as long as the board cache keeps a game (B2: no id-bearing file outlives it)', async () => {
    const dir = tmp();
    mkdirSync(profileGamesDir(dir), { recursive: true });
    const stale = profileGamePath(dir, 1000, ME);
    const recent = profileGamePath(dir, 1001, ME);
    for (const p of [stale, recent]) writeFileSync(p, '{}');
    const now = Date.now() / 1000;
    utimesSync(stale, now - BOARD_CACHE_MAX_AGE_MS / 1000 - 86_400, now - BOARD_CACHE_MAX_AGE_MS / 1000 - 86_400);
    utimesSync(recent, now - BOARD_CACHE_MAX_AGE_MS / 1000 + 86_400, now - BOARD_CACHE_MAX_AGE_MS / 1000 + 86_400);
    await recordBehaviour(dir, input(boards(1, 2)), {});
    expect(readdirSync(profileGamesDir(dir)).sort()).toEqual([`1001-${ME}.json`, `${GAME}-${ME}.json`]);
  });
});
