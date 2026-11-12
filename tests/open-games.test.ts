import { afterEach, describe, expect, it } from 'vitest';
import { Writer } from '../src/protocol/codec.js';
import { WarappBundle } from '../src/protocol/bundle.js';
import { filterOpenGames, OPEN_GAMES_URL, openGameOf, parseOpenGamesPage, type OpenGame } from '../src/open-games.js';
import { liveHarness, payload, textOf, type Harness } from './helpers.js';
import { MY_GAMES_BUNDLE, writeGameInfo, type SyntheticGame } from './protocol/my-games-bundle.js';

const bundle = new WarappBundle(MY_GAMES_BUNDLE, 'test');

const WAITING = 2;
const P_PLAYING = 2;
const P_DECLINED = 5;
const DAY_MS = 86_400_000;

/** Synthetic open games: made-up ids, names and players. */
const GAMES: SyntheticGame[] = [
  {
    id: 2001,
    name: 'Plain FFA',
    lastTurn: -1,
    state: WAITING,
    players: [
      { id: 111111, name: 'Ann', state: P_PLAYING, committed: false },
      { id: 222222, name: 'Gone', state: P_DECLINED, committed: false },
    ],
    openSeats: [-1, -1, -1],
    maxPlayers: null,
    bootTimeMs: 3 * DAY_MS,
  },
  {
    id: 2002,
    name: 'Fast one',
    lastTurn: -1,
    state: WAITING,
    players: [{ id: 111111, name: 'Ann', state: P_PLAYING, committed: false }],
    openSeats: [-1],
    maxPlayers: null,
    realTime: true,
    bootTimeMs: 5 * 60_000,
  },
  {
    id: 2003,
    name: 'Coin game',
    lastTurn: -1,
    state: WAITING,
    players: [{ id: 333333, name: 'Bo', state: P_PLAYING, committed: false }],
    openSeats: [-1],
    maxPlayers: null,
    entryFee: 10,
    prize: 18,
  },
  {
    id: 2004,
    name: 'Teams',
    lastTurn: -1,
    state: WAITING,
    players: [{ id: 444444, name: 'Cy', state: P_PLAYING, committed: false, team: 0 }],
    openSeats: [0, 1, 1],
    maxPlayers: null,
  },
  {
    id: 2005,
    name: 'Odd rules',
    lastTurn: -1,
    state: WAITING,
    players: [{ id: 555555, name: 'Di', state: P_PLAYING, committed: false }],
    openSeats: [-1, -1, -1, -1, -1],
    maxPlayers: null,
    settings: {
      offensiveKillRate: 0.5,
      defensiveKillRate: 0.7,
      localDeployments: true,
      commerce: 0,
      distribution: -3,
      commanders: true,
      luck: 0.16,
      multiAttack: true,
      settingsString: '3;r;1,5;p;p;n',
      armyCap: 4,
    },
  },
];

const hexOf = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();

function payloadHex(games: readonly SyntheticGame[], count = games.length): string {
  const w = new Writer().int32(count);
  for (const g of games) writeGameInfo(w, g);
  return hexOf(w.bytes());
}

function page(hex: string | null, hidden?: number): string {
  const script = hex === null ? '' : `<script type="text/plain" id="AllOpenGamesData">${hex}</script>`;
  const note = hidden === undefined ? '' : `<p>${hidden} games are being hidden due to prerequisites</p>`;
  return `<html><body><table id="OpenGamesTable"></table>${note}${script}</body></html>`;
}

const byId = (games: readonly OpenGame[], id: number) => games.find((g) => g.id === id)!;

describe('parseOpenGamesPage', () => {
  it('decodes every GameInfo record from the page payload', () => {
    const out = parseOpenGamesPage(page(payloadHex(GAMES)), bundle);
    expect(out.note).toBeUndefined();
    expect(out.games.map((g) => g.id)).toEqual([2001, 2002, 2003, 2004, 2005]);
    expect(byId(out.games, 2001)).toEqual({
      id: 2001,
      name: 'Plain FFA',
      url: 'https://war.app/MultiPlayer?GameID=2001',
      pace: 'multi-day',
      bootTime: '3d',
      bootTimeMinutes: 4320,
      players: 1,
      openSeats: 3,
      seats: 4,
      teamGame: false,
      mapId: 39905,
      entryFeeCoins: 0,
      prizeCoins: 0,
      rules: ['Automatic distribution'],
      plannerGaps: [],
    });
  });

  it('reads pace, boot time, coins, mega-game caps and teams', () => {
    const { games } = parseOpenGamesPage(page(payloadHex(GAMES)), bundle);
    expect(byId(games, 2002)).toMatchObject({ pace: 'real-time', bootTime: '5m', bootTimeMinutes: 5 });
    expect(byId(games, 2003)).toMatchObject({ entryFeeCoins: 10, prizeCoins: 18 });
    expect(byId(games, 2004)).toMatchObject({ teamGame: true, openSeatTeams: [0, 1, 1] });
    expect(byId(games, 2004).rules).toContain('Team game');
    const mega = parseOpenGamesPage(page(payloadHex([{ ...GAMES[0]!, maxPlayers: 40 }])), bundle).games[0]!;
    expect(mega.maxPlayers).toBe(40);
    const teamsOf = parseOpenGamesPage(page(payloadHex([{ ...GAMES[0]!, randomTeamsOf: 2 }])), bundle).games[0]!;
    expect(teamsOf).toMatchObject({ teamGame: true, randomTeamsOf: 2 });
  });

  it('calls a lobby a team game when any player record carries a team, declined ones included (as the client does)', () => {
    const g = parseOpenGamesPage(
      page(
        payloadHex([
          {
            ...GAMES[0]!,
            players: [
              { id: 111111, name: 'Ann', state: P_PLAYING, committed: false },
              { id: 222222, name: 'Gone', state: P_DECLINED, committed: false, team: 1 },
            ],
            openSeats: [-1, -1],
          },
        ]),
      ),
      bundle,
    ).games[0]!;
    expect(g).toMatchObject({ teamGame: true, players: 1, openSeats: 2 });
  });

  it('calls a random-teams lobby a team game though no seat carries a team id yet', () => {
    const g = parseOpenGamesPage(
      page(payloadHex([{ ...GAMES[0]!, name: 'Some-Teams V4', randomTeamsOf: 2, openSeats: [-1, -1, -1] }])),
      bundle,
    ).games[0]!;
    expect(g).toMatchObject({ teamGame: true, randomTeamsOf: 2, openSeatTeams: [-1, -1, -1] });
    expect(g.rules).toContain('Team game (random teams of 2)');
    expect(filterOpenGames([g], {})).toEqual([]);
  });

  it('keeps each lobby\'s seated player ids and the colours its players hold', () => {
    const out = parseOpenGamesPage(
      page(
        payloadHex([
          {
            ...GAMES[0]!,
            players: [
              { id: 111111, name: 'Ann', state: P_PLAYING, committed: false, color: 4 },
              { id: 222222, name: 'Gone', state: P_DECLINED, committed: false, color: 9 },
              { id: 333333, name: 'Cy', state: P_PLAYING, committed: false },
            ],
          },
        ]),
      ),
      bundle,
    );
    expect(out.lobbies.get(2001)).toEqual({ seatedPlayerIds: [111111, 333333], colorsTaken: [4, 9] });
    expect(JSON.stringify(out.games)).not.toContain('colorsTaken');
  });

  it('names the settings flags it reads and the ones the planner does not model', () => {
    const g = byId(parseOpenGamesPage(page(payloadHex(GAMES)), bundle).games, 2005);
    expect(g.rules).toEqual(
      expect.arrayContaining([
        'Custom scenario',
        'Commanders',
        'Cards: Reinforcement, Order Delay',
        'Commerce (no army multiplier)',
        'Luck modifier 16%',
        'Local deployments',
        'Army cap: 4× income',
        'Kill rates: offensive 50%, defensive 70%',
        'Multi-attack',
      ]),
    );
    expect(g.cards).toEqual(['Reinforcement', 'Order Delay']);
    expect(g.plannerGaps).toEqual(
      expect.arrayContaining([
        'Non-default kill rates (#28)',
        'Local deployments (#29)',
        'Commerce',
        'Custom scenario',
        'Commanders',
      ]),
    );
    expect(g.plannerGaps).not.toContain('Multi-attack');
  });

  it('flags an extra army per N territories as a planner gap (income model unverified, #38)', () => {
    const g = parseOpenGamesPage(page(payloadHex([{ ...GAMES[0]!, settings: { bonusArmiesPer: 3 } }])), bundle)
      .games[0]!;
    expect(g.rules).toContain('Extra army for every 3 territories');
    expect(g.plannerGaps).toEqual(['Extra army per 3 territories — income model unverified, see #38']);
  });

  it('flags a non-zero luck modifier or non-straight rounding as a planner gap', () => {
    const gap = 'Luck or rounding — attack sizing assumes straight rounding and adds only a luck margin';
    const luck = parseOpenGamesPage(page(payloadHex([{ ...GAMES[0]!, settings: { luck: 0.75 } }])), bundle).games[0]!;
    expect(luck.plannerGaps).toEqual([gap]);
    const rounding = parseOpenGamesPage(page(payloadHex([{ ...GAMES[0]!, settings: { roundingMode: 0 } }])), bundle)
      .games[0]!;
    expect(rounding.plannerGaps).toEqual([gap]);
    const both = parseOpenGamesPage(
      page(payloadHex([{ ...GAMES[0]!, settings: { luck: 0.75, roundingMode: 0 } }])),
      bundle,
    ).games[0]!;
    expect(both.plannerGaps).toEqual([gap]);
    const straight = parseOpenGamesPage(
      page(payloadHex([{ ...GAMES[0]!, settings: { luck: 0, roundingMode: 1 } }])),
      bundle,
    ).games[0]!;
    expect(straight.plannerGaps).toEqual([]);
  });

  it('reports no rules it cannot read: a game without a settings record has none', () => {
    const g = parseOpenGamesPage(page(payloadHex([{ ...GAMES[0]!, settings: null }])), bundle).games[0]!;
    expect(g.rules).toEqual([]);
    expect(g.plannerGaps).toEqual([]);
  });

  it('reports the prerequisite-hidden count from the page text', () => {
    expect(parseOpenGamesPage(page(payloadHex(GAMES), 12), bundle).hiddenByPrerequisites).toBe(12);
    expect(parseOpenGamesPage(page(payloadHex(GAMES)), bundle).hiddenByPrerequisites).toBeUndefined();
    const one = page(payloadHex(GAMES)).replace('</body>', '<p>1 game is being hidden due to prerequisites</p></body>');
    expect(parseOpenGamesPage(one, bundle).hiddenByPrerequisites).toBe(1);
  });

  it('answers no games with a note when the page has no payload', () => {
    const out = parseOpenGamesPage(page(null), bundle);
    expect(out.games).toEqual([]);
    expect(out.note).toMatch(/no open-games data/i);
  });

  it('answers no games with a note for malformed hex', () => {
    for (const bad of ['ABC', 'ZZZZ', '']) {
      const out = parseOpenGamesPage(page(bad), bundle);
      expect(out.games, bad).toEqual([]);
      expect(out.note, bad).toMatch(/could not be read/i);
    }
  });

  it('keeps the games read before a truncated record, with a note', () => {
    const full = payloadHex(GAMES);
    const out = parseOpenGamesPage(page(full.slice(0, full.length - 40)), bundle);
    expect(out.games.map((g) => g.id)).toEqual([2001, 2002, 2003, 2004]);
    expect(out.note).toMatch(/4 of 5/);
  });

  it('skips a record that is not a GameInfo shape instead of throwing', () => {
    expect(openGameOf({ $type: 'warlight.shared.Other', a: 1 })).toBeUndefined();
    expect(openGameOf({ $type: 'warlight.shared.GameInfo', a: 1, b: 'x' })).toBeUndefined();
    expect(openGameOf(null)).toBeUndefined();
    const good = { ...GAMES[0]! };
    const w = new Writer().int32(1);
    writeGameInfo(w, good);
    expect(parseOpenGamesPage(page(hexOf(w.bytes())), bundle).games).toHaveLength(1);
  });

  it('accepts the script tag with its attributes in any order and lowercase hex', () => {
    const html = `<script id="AllOpenGamesData" type="text/plain">\n${payloadHex(GAMES).toLowerCase()}\n</script>`;
    expect(parseOpenGamesPage(html, bundle).games).toHaveLength(5);
  });
});

describe('filterOpenGames', () => {
  const { games } = parseOpenGamesPage(page(payloadHex(GAMES)), bundle);

  it('defaults to free, multi-day, no-team games', () => {
    expect(filterOpenGames(games, {}).map((g) => g.id)).toEqual([2001, 2005]);
  });

  it('filters by pace', () => {
    expect(filterOpenGames(games, { pace: 'real-time' }).map((g) => g.id)).toEqual([2002]);
    expect(filterOpenGames(games, { pace: 'both' }).map((g) => g.id)).toEqual([2001, 2002, 2005]);
  });

  it('keeps coin games and team games when asked', () => {
    const all = filterOpenGames(games, { pace: 'both', free_only: false, exclude_teams: false });
    expect(all.map((g) => g.id)).toEqual([2001, 2002, 2003, 2004, 2005]);
  });

  it('caps the seat count and the result length', () => {
    expect(filterOpenGames(games, { max_players: 4 }).map((g) => g.id)).toEqual([2001]);
    expect(filterOpenGames(games, { pace: 'both', limit: 1 }).map((g) => g.id)).toEqual([2001]);
  });
});

describe('warapp_list_open_games', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.harness.close();
    h = undefined;
  });

  it('reads the OpenGames page and returns the filtered games, untrusted-framed', async () => {
    h = await liveHarness({ pages: { [OPEN_GAMES_URL]: page(payloadHex(GAMES), 3) } });
    const p = payload(await h.call('warapp_list_open_games'));
    expect(p.untrusted_content).toBe(true);
    expect((p.games as OpenGame[]).map((g) => g.id)).toEqual([2001, 2005]);
    expect(p).toMatchObject({ count: 2, listed: 5, hiddenByPrerequisites: 3 });
    expect(h.exchanges).toEqual([]); // a page GET, no /Services call
  });

  it('marks the lobbies the signed-in account has already joined', async () => {
    const me = { id: 123456, name: 'Me', state: P_PLAYING, committed: false };
    const games: SyntheticGame[] = [
      { ...GAMES[0]!, players: [...GAMES[0]!.players!, me] },
      { ...GAMES[0]!, id: 2010, players: [{ ...me, state: P_DECLINED }] },
      { ...GAMES[0]!, id: 2011 },
    ];
    h = await liveHarness({
      pages: {
        [OPEN_GAMES_URL]: page(payloadHex(games)),
        'https://war.app/InviteToken': '<p>Your invite token is 3312345644</p>',
      },
    });
    const p = payload(await h.call('warapp_list_open_games'));
    const listed = p.games as OpenGame[];
    expect(listed.map((g) => [g.id, g.joined])).toEqual([
      [2001, true],
      [2010, undefined],
      [2011, undefined],
    ]);
  });

  it('still lists the lobbies (marking nothing) when the invite token is too short to be a player id', async () => {
    const me = { id: 123456, name: 'Me', state: P_PLAYING, committed: false };
    h = await liveHarness({
      pages: {
        [OPEN_GAMES_URL]: page(payloadHex([{ ...GAMES[0]!, players: [me] }])),
        'https://war.app/InviteToken': '<p>Your invite token is 1234</p>',
      },
    });
    const p = payload(await h.call('warapp_list_open_games'));
    expect((p.games as OpenGame[])[0]!.joined).toBeUndefined();
  });

  it('marks nothing when the signed-in account cannot be told', async () => {
    const me = { id: 123456, name: 'Me', state: P_PLAYING, committed: false };
    h = await liveHarness({ pages: { [OPEN_GAMES_URL]: page(payloadHex([{ ...GAMES[0]!, players: [me] }])) } });
    const p = payload(await h.call('warapp_list_open_games'));
    expect((p.games as OpenGame[])[0]!.joined).toBeUndefined();
  });

  it('passes the filters through', async () => {
    h = await liveHarness({ pages: { [OPEN_GAMES_URL]: page(payloadHex(GAMES)) } });
    const p = payload(await h.call('warapp_list_open_games', { pace: 'real-time', free_only: false }));
    expect((p.games as OpenGame[]).map((g) => g.id)).toEqual([2002]);
  });

  it('fails with a hint when the page cannot be fetched', async () => {
    h = await liveHarness({ pages: {} });
    const res = await h.call('warapp_list_open_games');
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/open games page/i);
    expect(textOf(res)).toMatch(/warapp_link_session|signed-in war\.app tab/);
  });

  it('rejects a non-positive limit', async () => {
    h = await liveHarness({ pages: { [OPEN_GAMES_URL]: page(payloadHex(GAMES)) } });
    expect((await h.call('warapp_list_open_games', { limit: 0 })).isError).toBe(true);
  });

  it('says so when the page carries no list', async () => {
    h = await liveHarness({ pages: { [OPEN_GAMES_URL]: page(null) } });
    const p = payload(await h.call('warapp_list_open_games'));
    expect(p.games).toEqual([]);
    expect(String(p.warning)).toMatch(/no open-games data/i);
  });
});
