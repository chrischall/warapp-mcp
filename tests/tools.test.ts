import { afterEach, describe, expect, it } from 'vitest';
import { armiesToTake } from '../src/analysis/index.js';
import { harnessFor, lobbyFixture, payload, textOf, TOKEN, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;

/** The lobby fixture turned into an in-progress game with a (synthetic, loose-format) standing. */
function playingFixture(): Record<string, unknown> {
  const f = lobbyFixture();
  return {
    ...f,
    state: 'Playing',
    numberOfTurns: '3',
    players: (f.players as Array<Record<string, string>>).map((p, i) => ({
      ...p,
      hasCommittedOrders: i === 1 ? 'True' : 'False',
    })),
    standing: [
      { terrID: '159', ownedBy: '1000', armies: '4', fogLevel: 'Visible' },
      { terrID: '161', ownedBy: '1000', armies: '3', fogLevel: 'Visible' },
      { terrID: '157', ownedBy: 'Neutral', armies: '2', fogLevel: 'Visible' },
      { terrID: '158', ownedBy: '1001', armies: '7', fogLevel: 'Visible' },
      { terrID: '135', ownedBy: 'Neutral', armies: '0', fogLevel: 'Fogged' },
    ],
  };
}

describe('warapp_get_game', () => {
  it('compact (default): state, turn, players with committed flags, settings digest, map summary', async () => {
    h = await harnessFor(playingFixture());
    const res = await h.call('warapp_get_game', { game_id: GAME });
    const p = payload(res);
    expect(p.untrusted_content).toBe(true);
    expect(p.game).toMatchObject({ id: GAME, name: 'Synthetic lobby game', state: 'Playing', turn: 3 });
    const players = p.players as Array<Record<string, unknown>>;
    expect(players).toHaveLength(9);
    expect(players[0]).toEqual({ id: 1000, name: 'Player 1', state: 'Playing', committed: false });
    expect(players[1]!.committed).toBe(true);
    expect(p.waitingOn).toHaveLength(8);
    expect(p.map).toEqual({ id: 39905, name: expect.any(String), territories: 761, bonuses: 372 });
    const settings = p.settings as Record<string, unknown>;
    expect(settings).toMatchObject({ offensiveKillRate: expect.any(Number), defensiveKillRate: expect.any(Number) });
    expect(Array.isArray(settings.cards)).toBe(true);
    expect(settings).not.toHaveProperty('raw');
    expect(p.boardAvailable).toBe(true);
    // Settings are always requested; history/chat only when asked.
    expect(h.calls[0]!.url).toContain('GetSettings=true');
    expect(h.calls[0]!.url).not.toContain('GetHistory');
    expect(h.calls[0]!.url).not.toContain('GetChat');
    expect(textOf(res)).not.toContain(TOKEN);
  });

  it('flags AI players in compact', async () => {
    const f = lobbyFixture();
    const players = f.players as Array<Record<string, string>>;
    players[2] = { ...players[2]!, isAI: 'True', humanTurnedIntoAI: 'True' };
    h = await harnessFor({ ...f, state: 'Playing' });
    const p = payload(await h.call('warapp_get_game', { game_id: GAME }));
    expect((p.players as Array<Record<string, unknown>>)[2]).toMatchObject({ ai: true, turnedIntoAI: true });
    expect(p.waitingOn).toHaveLength(8);
  });

  it('a lobby has no board and no turn yet', async () => {
    h = await harnessFor();
    const p = payload(await h.call('warapp_get_game', { game_id: GAME }));
    expect(p.boardAvailable).toBe(false);
    expect((p.game as Record<string, unknown>).turn).toBeNull();
  });

  it('full keeps every normalized field but summarizes the map', async () => {
    h = await harnessFor(playingFixture());
    const p = payload(await h.call('warapp_get_game', { game_id: GAME, view: 'full' }));
    const game = p.game as Record<string, unknown>;
    expect(game.players).toHaveLength(9);
    expect((game.settings as Record<string, unknown>).raw).toBeDefined();
    expect(game.map).toEqual({ id: 39905, name: expect.any(String), territories: 761, bonuses: 372 });
    expect((game.standing as { territories: unknown[] }).territories).toHaveLength(5);
  });

  it('raw returns the whole normalized game (map included), indented, still fenced', async () => {
    h = await harnessFor();
    const res = await h.call('warapp_get_game', { game_id: GAME, view: 'raw' });
    expect(textOf(res)).toContain('\n  ');
    const p = payload(res);
    expect(p.untrusted_content).toBe(true);
    expect(((p.game as { map: { territories: unknown[] } }).map.territories)).toHaveLength(761);
  });

  it('passes include_history / include_chat through as GetHistory / GetChat', async () => {
    h = await harnessFor({ ...lobbyFixture(), chat: [{ text: 'hi' }] });
    const p = payload(await h.call('warapp_get_game', { game_id: GAME, include_history: true, include_chat: true }));
    expect(h.calls[0]!.url).toContain('GetHistory=true');
    expect(h.calls[0]!.url).toContain('GetChat=true');
    expect(p.chat).toEqual([{ text: 'hi' }]);
  });

  it('rejects a bad game id before any request', async () => {
    h = await harnessFor();
    const res = await h.call('warapp_get_game', { game_id: 0 });
    expect(res.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  it('surfaces a not-found game as an error with the hint', async () => {
    h = await harnessFor({ termsOfUse: 'x', error: 'Loading the game produced an error: ServerGameKeyNotFound' });
    const res = await h.call('warapp_get_game', { game_id: 99 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no game 99/);
    expect(textOf(res)).toMatch(/GameID=/);
  });
});

describe('warapp_get_map', () => {
  it('compact: ranked bonus table (easiest first, positive only) + chokepoints, limited', async () => {
    h = await harnessFor();
    const p = payload(await h.call('warapp_get_map', { game_id: GAME }));
    expect(p.map).toEqual({ id: 39905, name: expect.any(String), territories: 761, bonuses: 372 });
    const bonuses = p.bonuses as Array<Record<string, number>>;
    expect(bonuses).toHaveLength(25);
    expect(p.bonusesShown).toBe('25 of 316');
    for (let i = 1; i < bonuses.length; i++) expect(bonuses[i - 1]!.score).toBeGreaterThanOrEqual(bonuses[i]!.score);
    expect(Object.keys(bonuses[0]!).sort()).toEqual(
      ['bonusId', 'borders', 'entryPoints', 'name', 'score', 'territories', 'value', 'valuePerTerritory'].sort(),
    );
    const chokes = p.chokepoints as Array<Record<string, unknown>>;
    expect(chokes.length).toBeGreaterThan(0);
    expect(chokes.length).toBeLessThanOrEqual(20);
    expect(chokes[0]).toHaveProperty('reasons');
  });

  it('filters by bonus name (case-insensitive substring) with the members spelled out', async () => {
    h = await harnessFor();
    const p = payload(await h.call('warapp_get_map', { game_id: GAME, bonus: 'broken branch' }));
    const bonuses = p.bonuses as Array<Record<string, unknown>>;
    expect(bonuses.map((b) => b.name)).toEqual(['Broken Branch Riverlords']);
    const b = bonuses[0]!;
    expect(b.value).toBe(2);
    expect((b.territories as Array<{ id: number; name: string }>).map((t) => t.name).sort()).toEqual(
      ['Hornwood', 'Sheepshead Hills', "Widow's Watch"],
    );
    expect(Array.isArray(b.borders)).toBe(true);
    expect(Array.isArray(b.entryPoints)).toBe(true);
    expect(p).not.toHaveProperty('chokepoints');
  });

  it("reports the game's overridden bonus values (#62)", async () => {
    const f = lobbyFixture();
    h = await harnessFor({
      ...f,
      settings: { ...(f.settings as Record<string, unknown>), OverriddenBonuses: [{ bonusID: '118', value: '9' }] },
    });
    const p = payload(await h.call('warapp_get_map', { game_id: GAME, bonus: 'broken branch' }));
    expect((p.bonuses as Array<{ value: number }>)[0]!.value).toBe(9);
  });

  it('sort: value orders by value desc; limit caps rows', async () => {
    h = await harnessFor();
    const p = payload(await h.call('warapp_get_map', { game_id: GAME, sort: 'value', limit: 5 }));
    const values = (p.bonuses as Array<{ value: number }>).map((b) => b.value);
    expect(values).toHaveLength(5);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
  });

  it('sort: name orders alphabetically', async () => {
    h = await harnessFor();
    const p = payload(await h.call('warapp_get_map', { game_id: GAME, sort: 'name', limit: 10 }));
    const names = (p.bonuses as Array<{ name: string }>).map((b) => b.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  it('an unmatched bonus filter is an error naming the filter', async () => {
    h = await harnessFor();
    const res = await h.call('warapp_get_map', { game_id: GAME, bonus: 'zzz-nothing' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/zzz-nothing/);
  });

  it('full: every bonus (non-positive included) with member lists, every chokepoint', async () => {
    h = await harnessFor();
    const p = payload(await h.call('warapp_get_map', { game_id: GAME, view: 'full' }));
    expect(p.bonuses).toHaveLength(372);
    expect((p.bonuses as Array<Record<string, unknown>>)[0]).toHaveProperty('territories');
  });

  it('reuses the cached map on a second call (GetMap=false)', async () => {
    h = await harnessFor(lobbyFixture(), { ...lobbyFixture(), map: {} });
    await h.call('warapp_get_map', { game_id: GAME });
    const p = payload(await h.call('warapp_get_map', { game_id: GAME, limit: 1 }));
    expect(h.calls[1]!.url).toContain('GetMap=false');
    expect(p.bonuses).toHaveLength(1);
  });
});

describe('warapp_analyze_board', () => {
  it('errors clearly when neither the feed nor the live board has one for the game', async () => {
    h = await harnessFor();
    const res = await h.call('warapp_analyze_board', { game_id: GAME, player: 1000 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/war\.app has no board for game 12345678 yet/i);
    expect(textOf(res)).toMatch(/WaitingForPlayers/);
    expect(h.exchanges.map((e) => e.request.method)).toEqual([40]);
  });

  it('asks which player when none is given, listing them', async () => {
    h = await harnessFor(playingFixture());
    const res = await h.call('warapp_analyze_board', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Player 1 \(1000\)/);
  });

  it('rejects an unknown player', async () => {
    h = await harnessFor(playingFixture());
    const res = await h.call('warapp_analyze_board', { game_id: GAME, player: 'Nobody' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Nobody/);
  });

  it('analyzes the board for a player by name: income, closest bonuses, threats, assumptions', async () => {
    h = await harnessFor(playingFixture());
    const p = payload(await h.call('warapp_analyze_board', { game_id: GAME, player: 'player 1' }));
    expect(p.untrusted_content).toBe(true);
    expect(p.player).toEqual({ id: 1000, name: 'Player 1' });
    expect(p.boardVerified).toBe(false);
    expect(p.territoryCount).toBe(2);
    expect(p.armies).toBe(7);
    expect((p.income as { total: number }).total).toBeGreaterThan(0);
    const closest = p.closestBonuses as Array<Record<string, unknown>>;
    const bb = closest.find((b) => b.name === 'Broken Branch Riverlords')!;
    expect(bb).toBeDefined();
    const settings = lobbyFixture().settings as Record<string, number>;
    expect(bb.missing).toEqual([
      {
        territoryId: 157,
        name: "Widow's Watch",
        owner: 'neutral',
        armies: 2,
        armiesToTake: armiesToTake(2, {
          offensiveKillRate: settings.OffensiveKillRate,
          defensiveKillRate: settings.DefensiveKillRate,
        }),
      },
    ]);
    const threats = p.threats as Array<Record<string, unknown>>;
    expect(threats[0]).toMatchObject({ territoryId: 158, player: 'Player 2', armies: 7 });
    expect((p.assumptions as string[]).join(' ')).toMatch(/unverified/);
  });

  it('full: the whole analysis with player ids', async () => {
    h = await harnessFor(playingFixture());
    const p = payload(await h.call('warapp_analyze_board', { game_id: GAME, player: 1000, view: 'full', limit: 1 }));
    expect(p.playerId).toBe(1000);
    expect(p.players).toHaveLength(9);
    expect(p.closestBonuses).toHaveLength(1);
    expect((p.threats as Array<{ playerId: number }>)[0]!.playerId).toBe(1001);
  });

  it('accepts the player by id', async () => {
    h = await harnessFor(playingFixture());
    const p = payload(await h.call('warapp_analyze_board', { game_id: GAME, player: '1001' }));
    expect(p.player).toEqual({ id: 1001, name: 'Player 2' });
    expect(p.territoryCount).toBe(1);
  });
});

describe('warapp_plan_route', () => {
  it('finds the shortest path between two territories by name', async () => {
    h = await harnessFor();
    const p = payload(await h.call('warapp_plan_route', { game_id: GAME, from: "widow's watch", to: 'Hornwood' }));
    expect(p.from).toEqual({ id: 157, name: "Widow's Watch" });
    expect(p.to).toEqual({ id: 159, name: 'Hornwood' });
    expect(p.hops).toBe(2);
    const path = p.path as Array<{ id: number; name: string }>;
    expect(path[0]!.id).toBe(157);
    expect(path[path.length - 1]!.id).toBe(159);
  });

  it('accepts territory ids', async () => {
    h = await harnessFor();
    const p = payload(await h.call('warapp_plan_route', { game_id: GAME, from: '159', to: 161 }));
    expect(p.hops).toBe(1);
  });

  it('a unique partial name resolves; an ambiguous one lists candidates', async () => {
    h = await harnessFor();
    const ok = payload(await h.call('warapp_plan_route', { game_id: GAME, from: 'Sheepshead', to: 'Hornwood' }));
    expect(ok.from).toEqual({ id: 161, name: 'Sheepshead Hills' });
    const res = await h.call('warapp_plan_route', { game_id: GAME, from: 'Mistwood', to: 'Hornwood' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Mistwood.*matches 2 territories/s);
  });

  it('an unknown territory is an error naming it', async () => {
    h = await harnessFor();
    const res = await h.call('warapp_plan_route', { game_id: GAME, from: 'Atlantis', to: 'Hornwood' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Atlantis/);
  });
});
