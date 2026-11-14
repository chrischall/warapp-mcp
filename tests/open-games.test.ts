import { afterEach, describe, expect, it } from 'vitest';
import { Reader, Writer } from '../src/protocol/codec.js';
import type { ReadBudget } from '../src/protocol/interp.js';
import { WarappBundle } from '../src/protocol/bundle.js';
import { feedScreen, filterOpenGames, joiningPolicy, GAME_INFO, lotteryOf, LOTTERY_MAX_TERRITORIES, markJoined, MAX_OPEN_GAMES, OPEN_GAMES_URL, OpenGamesFormatError, parseOpenGamesPage, type OpenGame } from '../src/open-games.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { MY_GAMES_BUNDLE, writeGameInfo, type SyntheticGame } from './protocol/my-games-bundle.js';

const bundle = new WarappBundle(MY_GAMES_BUNDLE, 'test');

const WAITING = 2;
const P_PLAYING = 2;
const P_DECLINED = 5;
const P_INVITED = 1;
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

  it('an invited player holds no seat yet, but the seat kept for them counts in the size (#133)', () => {
    const out = parseOpenGamesPage(
      page(
        payloadHex([
          {
            ...GAMES[0]!,
            players: [
              { id: 111111, name: 'Ann', state: P_PLAYING, committed: false },
              { id: 222222, name: 'Gone', state: P_DECLINED, committed: false },
              { id: 333333, name: 'Asked', state: P_INVITED, committed: false, color: 7 },
            ],
            openSeats: [-1, -1],
          },
        ]),
      ),
      bundle,
    );
    expect(out.lobbies.get(2001)).toEqual({ seatedPlayerIds: [111111], colorsTaken: [7] });
    expect(out.games[0]).toMatchObject({ players: 1, openSeats: 2, seats: 4 });
    expect(markJoined(out.games, out.lobbies, 333333)[0]).not.toHaveProperty('joined');
    expect(markJoined(out.games, out.lobbies, 111111)[0]).toMatchObject({ joined: true });
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
    expect(g.plannerGaps).toEqual(expect.arrayContaining(['Commerce', 'Custom scenario', 'Commanders']));
    expect(g.plannerGaps).not.toContain('Multi-attack');
  });

  it('names no gap the planner has closed: kill rates (#28), Local Deployment (#29), per-territory income (#38)', () => {
    const g = byId(parseOpenGamesPage(page(payloadHex(GAMES)), bundle).games, 2005);
    expect(g.rules).toEqual(expect.arrayContaining(['Local deployments', 'Kill rates: offensive 50%, defensive 70%']));
    expect(g.plannerGaps.join(' ')).not.toMatch(/kill rate|local deployment|#\d+/i);
    const per = parseOpenGamesPage(page(payloadHex([{ ...GAMES[0]!, settings: { bonusArmiesPer: 3 } }])), bundle)
      .games[0]!;
    expect(per.rules).toContain('Extra army for every 3 territories');
    expect(per.plannerGaps).toEqual([]);
  });

  it('flags a speed first turn (No-luck cycle move order) as a rule and a gap (#132)', () => {
    const speed = parseOpenGamesPage(page(payloadHex([{ ...GAMES[0]!, settings: { moveOrder: 2 } }])), bundle).games[0]!;
    expect(speed.rules).toContain('Speed first turn (No-luck cycle move order)');
    expect(speed.plannerGaps).toEqual([
      'Speed first turn — the board stays hidden until Begin (warapp_begin_turn), and whoever orders fastest moves first',
    ]);
    const cycle = parseOpenGamesPage(page(payloadHex([{ ...GAMES[0]!, settings: { moveOrder: 1 } }])), bundle).games[0]!;
    expect(cycle.rules.join(' ')).not.toMatch(/speed/i);
    expect(cycle.plannerGaps).toEqual([]);
  });

  it('flags a non-zero luck modifier or non-straight rounding as a planner gap', () => {
    const gap = 'Luck or rounding — attacks are chances: sized for 95% with luck on (certain otherwise), holds for at most a 5% fall';
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

  /** A reader that takes one byte per record and answers `records` in turn (hand-built decodes). */
  const answering = (...records: unknown[]) => {
    let i = 0;
    return {
      hex: hexOf(new Writer().int32(records.length).bytes()) + '00'.repeat(records.length),
      reader: { readClass: (_t: string, r: Reader) => (r.u8(), records[i++]) },
    };
  };

  it('skips a record that is not a GameInfo instead of throwing', () => {
    const a = answering({ $type: 'warlight.shared.Other', a: 1 }, null);
    const out = parseOpenGamesPage(page(a.hex), a.reader);
    expect(out.games).toEqual([]);
    expect(out.note).toBeUndefined();
    const good = { ...GAMES[0]! };
    const w = new Writer().int32(1);
    writeGameInfo(w, good);
    expect(parseOpenGamesPage(page(hexOf(w.bytes())), bundle).games).toHaveLength(1);
  });

  describe('a shifted record is a typed error, not a silently wrong game (#133)', () => {
    type Obj = Record<string, unknown>;
    /** `o` with `value` inserted as its field at `at`, as a client that added a field would decode it. */
    const inserted = (o: Obj, at: number, value: unknown): Obj => {
      const { $type, ...rest } = o;
      const entries = Object.entries(rest);
      entries.splice(at, 0, ['zz', value]);
      return { $type, ...Object.fromEntries(entries) };
    };
    /** The synthetic bundle's reader, with `edit` applied to each decoded GameInfo. */
    const editing = (edit: (gi: Obj) => Obj) => ({
      readClass: (t: string, r: Reader, budget?: ReadBudget) => edit(bundle.readClass(t, r, budget) as Obj),
    });
    const one = page(payloadHex([GAMES[0]!]));
    const nth = (o: Obj, i: number) => Object.values(o).filter((_, k) => Object.keys(o)[k] !== '$type')[i];

    it('the synthetic bundle decodes records with the client\'s field counts (27, 10, 24)', () => {
      const w = new Writer();
      writeGameInfo(w, GAMES[0]!);
      const gi = bundle.readClass(GAME_INFO, new Reader(w.bytes())) as Obj;
      const count = (o: Obj) => Object.keys(o).filter((k) => k !== '$type').length;
      expect(count(gi)).toBe(27);
      expect(count((nth(gi, 16) as Obj[])[0]!)).toBe(10);
      expect(count(nth(gi, 21) as Obj)).toBe(24);
    });

    it('a GameInfo with a field inserted before the settings', () => {
      expect(() => parseOpenGamesPage(one, editing((gi) => inserted(gi, 21, null)))).toThrow(OpenGamesFormatError);
      expect(() => parseOpenGamesPage(one, editing((gi) => inserted(gi, 21, null)))).toThrow(/GameInfo has 28 fields, not 27/);
    });

    it('a GameInfoPlayer with an int inserted before its id: id and state would both still read as ints', () => {
      const edit = (gi: Obj) => {
        const players = nth(gi, 16) as Obj[];
        const key = Object.keys(gi).filter((k) => k !== '$type')[16]!;
        return { ...gi, [key]: players.map((p) => inserted(p, 6, 999999)) };
      };
      expect(() => parseOpenGamesPage(one, editing(edit))).toThrow(/GameInfoPlayer has 11 fields, not 10/);
    });

    it('a GameInfoSettings with a field inserted first', () => {
      const edit = (gi: Obj) => {
        const key = Object.keys(gi).filter((k) => k !== '$type')[21]!;
        return { ...gi, [key]: inserted(gi[key] as Obj, 0, null) };
      };
      expect(() => parseOpenGamesPage(one, editing(edit))).toThrow(/GameInfoSettings has 25 fields, not 24/);
    });

    it('a GameInfo too short to hold its fields', () => {
      const a = answering({ $type: GAME_INFO, a: 1, b: 'x' });
      expect(() => parseOpenGamesPage(page(a.hex), a.reader)).toThrow(OpenGamesFormatError);
    });
  });

  it('accepts the script tag with its attributes in any order and lowercase hex', () => {
    const html = `<script id="AllOpenGamesData" type="text/plain">\n${payloadHex(GAMES).toLowerCase()}\n</script>`;
    expect(parseOpenGamesPage(html, bundle).games).toHaveLength(5);
  });

  describe('bounds on a hostile payload or bundle', () => {
    /** A one-class bundle whose GameInfo reader is `body` (hand-written, not the real client). */
    const hostile = (body: string, opts?: ConstructorParameters<typeof WarappBundle>[2]) =>
      new WarappBundle(`function Gi(){}W["${GAME_INFO}"]=Gi;Gi.Ha=function(a,b,d){${body}};`, 'test', opts);
    const counted = (b: WarappBundle) => {
      let calls = 0;
      return {
        calls: () => calls,
        reader: {
          readClass: (t: string, r: Reader, budget?: ReadBudget) => {
            calls++;
            return b.readClass(t, r, budget);
          },
        },
      };
    };

    it('refuses a record count above the cap without reading a record', () => {
      const c = counted(bundle);
      const t = Date.now();
      const out = parseOpenGamesPage(page('FFFFFF7F'), c.reader);
      expect(Date.now() - t).toBeLessThan(1000);
      expect(c.calls()).toBe(0);
      expect(out.games).toEqual([]);
      expect(out.note).toMatch(/could not be read/i);
      const over = parseOpenGamesPage(page(hexOf(new Writer().int32(MAX_OPEN_GAMES + 1).bytes())), bundle);
      expect(over.note).toMatch(/could not be read/i);
    });

    it('stops at a record that takes no bytes', () => {
      const c = counted(hostile('return null'));
      const out = parseOpenGamesPage(page(hexOf(new Writer().int32(MAX_OPEN_GAMES).bytes())), c.reader);
      expect(c.calls()).toBe(1);
      expect(out.games).toEqual([]);
      expect(out.note).toMatch(/could not be read/i);
    });

    it('spends one step budget on the whole page, not one per record', () => {
      // Each record takes one byte and burns steps; alone each fits the budget, together they do not.
      const b = hostile('a.bc();var i;for(i=0;i<3000;i++){}return null', { maxSteps: 50_000 });
      const w = new Writer().int32(1000);
      for (let i = 0; i < 1000; i++) w.u8(0);
      const c = counted(b);
      const out = parseOpenGamesPage(page(hexOf(w.bytes())), c.reader);
      expect(c.calls()).toBeLessThan(20);
      expect(out.note).toMatch(/could not be read/i);
      expect(out.note).toMatch(/steps/);
    });
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

  it('marks each game that breaks the joining policy, advisory (#134)', async () => {
    h = await liveHarness({ pages: { [OPEN_GAMES_URL]: page(payloadHex(GAMES)) } });
    const p = payload(await h.call('warapp_list_open_games', { pace: 'both' }));
    const breaks = (id: number) => (byId(p.games as OpenGame[], id) as OpenGame & { policyBreaks?: string[] }).policyBreaks;
    expect(breaks(2001)).toBeUndefined();
    expect(breaks(2002)?.join(' ')).toMatch(/boot time 5m/i);
    expect(breaks(2005)?.join(' ')).toMatch(/Commerce.*Custom scenario|Custom scenario.*Commerce/);
    expect(breaks(2005)?.join(' ')).toMatch(/6 seats/);
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

  describe('marks a lottery from the data (#217)', () => {
    const LOTTERY_SETTINGS = { minArmies: 0, overriddenBonuses: true };
    /** A GameFeed lobby on a made-up map of `n` territories (a line), one +1 bonus over them all. */
    const tinyMapFeed = (gameId: number, mapId: number, n: number) => {
      const f = lobbyFixture();
      const territories = Array.from({ length: n }, (_, i) => ({
        id: String(i + 1),
        name: `T${i + 1}`,
        connectedTo: [i > 0 ? i : null, i < n - 1 ? i + 2 : null].filter((x): x is number => x !== null),
      }));
      return {
        ...f,
        id: String(gameId),
        settings: { ...(f.settings as Record<string, unknown>), Map: String(mapId) },
        map: {
          id: String(mapId),
          name: 'Tiny',
          territories,
          bonuses: [{ id: '1', name: 'All', value: '1', territoryIDs: territories.map((t) => Number(t.id)) }],
          distributionModes: [],
        },
      };
    };

    it('reads the map size from GameFeed for a lobby with base income 0 and overridden bonuses, and breaks the policy', async () => {
      const games: SyntheticGame[] = [
        { ...GAMES[0]!, id: 2020, mapId: 777, settings: LOTTERY_SETTINGS },
        { ...GAMES[0]!, id: 2021 },
      ];
      h = await liveHarness({ pages: { [OPEN_GAMES_URL]: page(payloadHex(games)) }, feed: [tinyMapFeed(2020, 777, 2)] });
      const p = payload(await h.call('warapp_list_open_games'));
      const listed = p.games as Array<OpenGame & { policyBreaks?: string[] }>;
      expect(byId(listed, 2020)).toMatchObject({ lottery: true, lotteryBasis: '2-territory map, base income 0, overridden bonuses' });
      expect(listed.find((g) => g.id === 2020)?.policyBreaks?.join(' ')).toMatch(/Lottery/);
      expect(byId(listed, 2021).lottery).toBeUndefined();
      // Only the lobby whose settings fit the shape was looked up.
      expect(h.calls.map((c) => new URL(c.url).searchParams.get('GameID'))).toEqual(['2020']);
    });

    it('a large map with the same settings is not a lottery', async () => {
      const games: SyntheticGame[] = [{ ...GAMES[0]!, id: 2020, mapId: 777, settings: LOTTERY_SETTINGS }];
      h = await liveHarness({ pages: { [OPEN_GAMES_URL]: page(payloadHex(games)) }, feed: [tinyMapFeed(2020, 777, 30)] });
      const listed = payload(await h.call('warapp_list_open_games')).games as OpenGame[];
      expect(listed[0]!.lottery).toBeUndefined();
    });

    it('a map GameFeed cannot read leaves a likely lottery (null), and that breaks the policy too', async () => {
      const games: SyntheticGame[] = [{ ...GAMES[0]!, id: 2020, mapId: 777, settings: LOTTERY_SETTINGS }];
      h = await liveHarness({
        pages: { [OPEN_GAMES_URL]: page(payloadHex(games)) },
        feed: [{ termsOfUse: 'x', error: 'Something broke' }],
      });
      const listed = payload(await h.call('warapp_list_open_games')).games as Array<OpenGame & { policyBreaks?: string[] }>;
      expect(listed[0]).toMatchObject({ lottery: null, lotteryBasis: 'base income 0, overridden bonuses; map size not read' });
      expect(listed[0]!.policyBreaks).toContain('Likely a lottery (base income 0, overridden bonuses; map size not read) — the policy joins no lotteries');
    });

    it('looks up at most a few lobbies per call', async () => {
      const games: SyntheticGame[] = Array.from({ length: 8 }, (_, i) => ({
        ...GAMES[0]!,
        id: 2030 + i,
        mapId: 777,
        settings: LOTTERY_SETTINGS,
      }));
      h = await liveHarness({ pages: { [OPEN_GAMES_URL]: page(payloadHex(games)) }, feed: [{ termsOfUse: 'x', error: 'Something broke' }] });
      await h.call('warapp_list_open_games');
      expect(h.calls.length).toBeLessThanOrEqual(5);
    });
  });

  it('says so when the page carries no list', async () => {
    h = await liveHarness({ pages: { [OPEN_GAMES_URL]: page(null) } });
    const p = payload(await h.call('warapp_list_open_games'));
    expect(p.games).toEqual([]);
    expect(String(p.warning)).toMatch(/no open-games data/i);
  });
});

describe('feedScreen: the join preview screen from GameFeed settings (#132)', () => {
  const base = { cards: [], raw: {} };
  it('passes when the cheapest neutral costs no more than one turn of base income', () => {
    const r = feedScreen({ ...base, minimumArmyBonus: 5, initialNonDistributionArmies: 2, initialNeutralsInDistribution: 3 });
    expect(r.screen).toEqual({ cheapestNeutral: 2, armiesToTake: 3, baseIncome: 5, turnsOfBaseIncome: 0.6, passes: true });
    expect(r.gaps).toEqual([]);
  });

  it('fails, and names a gap, when the cheapest neutral costs several turns of income', () => {
    const r = feedScreen({
      ...base,
      minimumArmyBonus: 5,
      initialNonDistributionArmies: 10,
      initialNeutralsInDistribution: 12,
      offensiveKillRate: 60,
      defensiveKillRate: 70,
    });
    expect(r.screen).toEqual({ cheapestNeutral: 10, armiesToTake: 16, baseIncome: 5, turnsOfBaseIncome: 3.2, passes: false });
    expect(r.gaps).toEqual([
      'Costly neutrals — the cheapest (10) takes 16 armies, 3.2 turns of base income (5): expansion is slow',
    ]);
  });

  it('neutrals of 0 cost one army', () => {
    expect(feedScreen({ ...base, initialNonDistributionArmies: 0 }).screen).toMatchObject({ armiesToTake: 1, baseIncome: 5, passes: true });
  });

  it('no neutral size in the settings: no screen', () => {
    expect(feedScreen(base).screen).toBeUndefined();
  });

  it('flags Light Fog', () => {
    expect(feedScreen({ ...base, fog: 'LightFog' }).gaps).toEqual([
      'Light Fog — owners show everywhere but armies only near you; the planner counts every unseen stack as unknown',
    ]);
    expect(feedScreen({ ...base, fog: 'Foggy' }).gaps).toEqual([]);
  });
});

describe('joiningPolicy: the owner\'s joining policy, advisory (#134)', () => {
  const plain = (over: Partial<OpenGame> = {}): OpenGame => ({
    id: 1, name: 'x', url: 'u', pace: 'multi-day', bootTime: '3d', bootTimeMinutes: 4320, players: 1, openSeats: 1,
    seats: 2, teamGame: false, mapId: 1, entryFeeCoins: 0, prizeCoins: 0, rules: [], plannerGaps: [], ...over,
  });
  const cheap = { cheapestNeutral: 2, armiesToTake: 3, baseIncome: 5, turnsOfBaseIncome: 0.6, passes: true };

  it('a 1v1 with a day\'s boot and cheap neutrals passes', () => {
    expect(joiningPolicy(plain(), cheap)).toEqual({ passes: true, breaks: [] });
  });

  it('Commerce, mods and custom scenarios break it', () => {
    const r = joiningPolicy(plain({ rules: ['Custom scenario', 'Commerce (no army multiplier)', 'Mods'] }), cheap);
    expect(r.passes).toBe(false);
    expect(r.breaks).toEqual([
      'Commerce — the policy joins no Commerce games',
      'Mods — the policy joins no mod games',
      'Custom scenario — the policy joins no custom scenarios',
    ]);
  });

  it('more than four seats (or a mega game cap above four) breaks it; four is allowed', () => {
    expect(joiningPolicy(plain({ seats: 4 }), cheap).breaks).toEqual([]);
    expect(joiningPolicy(plain({ seats: 5 }), cheap).breaks).toEqual(['5 seats — the policy is 1v1 or at most four players']);
    expect(joiningPolicy(plain({ seats: 3, maxPlayers: 8 }), cheap).breaks).toEqual([
      '8 seats — the policy is 1v1 or at most four players',
    ]);
  });

  it('a boot time under 12 hours breaks it (12h is fine, per the owner); no boot time ("never") does not', () => {
    expect(joiningPolicy(plain({ bootTime: '5m', bootTimeMinutes: 5 }), cheap).breaks).toEqual([
      'Boot time 5m — the policy wants at least 12 hours',
    ]);
    expect(joiningPolicy(plain({ bootTime: '11h', bootTimeMinutes: 660 }), cheap).breaks).toEqual([
      'Boot time 11h — the policy wants at least 12 hours',
    ]);
    expect(joiningPolicy(plain({ bootTime: '12h', bootTimeMinutes: 720 }), cheap).breaks).toEqual([]);
    expect(joiningPolicy(plain({ bootTime: '1d', bootTimeMinutes: 1440 }), cheap).breaks).toEqual([]);
    const never = plain();
    delete never.bootTime;
    delete never.bootTimeMinutes;
    expect(joiningPolicy(never, cheap).breaks).toEqual([]);
  });

  it('a neutral costing more than a turn of base income breaks it', () => {
    const costly = { cheapestNeutral: 10, armiesToTake: 16, baseIncome: 5, turnsOfBaseIncome: 3.2, passes: false };
    expect(joiningPolicy(plain(), costly).breaks).toEqual([
      'Costly neutrals — the cheapest takes 16 armies, 3.2 turns of base income; the policy is at most one turn',
    ]);
    const untakeable = { ...costly, armiesToTake: null, turnsOfBaseIncome: null };
    expect(joiningPolicy(plain(), untakeable).breaks).toEqual([
      'Costly neutrals — the cheapest cannot be taken at these kill rates; the policy is at most one turn of base income',
    ]);
  });

  it('without a neutral screen it cannot pass, only fail: passes is null when nothing else breaks', () => {
    expect(joiningPolicy(plain())).toEqual({ passes: null, breaks: [], unchecked: ['the cheapest neutral\'s cost'] });
    expect(joiningPolicy(plain({ seats: 6 }), null).passes).toBe(false);
  });

  it('a lottery breaks it (#217), and so does a likely one whose map size went unread', () => {
    const lottery = plain({ lottery: true, lotteryBasis: '2-territory map, base income 0, overridden bonuses' });
    expect(joiningPolicy(lottery, cheap)).toEqual({
      passes: false,
      breaks: ['Lottery (2-territory map, base income 0, overridden bonuses) — pure luck; the policy joins no lotteries'],
    });
    const likely = plain({ lottery: null, lotteryBasis: 'base income 0, overridden bonuses; map size not read' });
    expect(joiningPolicy(likely, cheap)).toEqual({
      passes: false,
      breaks: ['Likely a lottery (base income 0, overridden bonuses; map size not read) — the policy joins no lotteries'],
    });
  });
});

describe('lotteryOf: a lottery from the data, not the name (#217)', () => {
  const game = (rules: string[] = []): OpenGame => ({
    id: 1, name: 'Anything', url: 'u', pace: 'multi-day', players: 1, openSeats: 1, seats: 2, teamGame: false,
    mapId: 1, entryFeeCoins: 0, prizeCoins: 0, rules, plannerGaps: [],
  });
  const SHAPE = ['Minimum armies per turn is 0', 'Overridden bonuses'];

  it('a tiny map is a lottery, whatever the settings; the basis names what was read', () => {
    expect(LOTTERY_MAX_TERRITORIES).toBe(4);
    expect(lotteryOf(game(SHAPE), 2)).toEqual({ lottery: true, lotteryBasis: '2-territory map, base income 0, overridden bonuses' });
    expect(lotteryOf(game(), 4)).toEqual({ lottery: true, lotteryBasis: '4-territory map' });
  });

  it('a map larger than that is not, even with base income 0 and overridden bonuses', () => {
    expect(lotteryOf(game(SHAPE), 5)).toBeUndefined();
    expect(lotteryOf(game(SHAPE), 120)).toBeUndefined();
  });

  it('base income 0 with overridden bonuses and no map size is a likely lottery (null); either alone is nothing', () => {
    expect(lotteryOf(game(SHAPE))).toEqual({ lottery: null, lotteryBasis: 'base income 0, overridden bonuses; map size not read' });
    expect(lotteryOf(game([SHAPE[0]!]))).toBeUndefined();
    expect(lotteryOf(game([SHAPE[1]!]))).toBeUndefined();
    expect(lotteryOf(game())).toBeUndefined();
  });
});
