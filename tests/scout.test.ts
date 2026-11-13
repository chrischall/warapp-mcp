import { afterEach, describe, expect, it } from 'vitest';
import { MAX_PAGE_CHARS, parseCommonGames, parseProfile, profileUrl, commonGamesUrl } from '../src/scout.js';
import { ANCHOR_CASES } from './scout-cases.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

// All synthetic: made-up names, ids and invite tokens.
const BOB = { token: '7176543229', name: 'Bob' };
const GAME = 12345678;

/** A synthetic Profile page in the shape war.app serves, with a personal line that must never surface. */
const PROFILE_HTML = `<!DOCTYPE html><html><head><title>Bob &amp; Co - War.app - Strategy game</title></head>
<body><div id="MainSiteContent">
<h1>Bob &amp; Co</h1>
<div>Level 55</div>
<font class="text-muted">Location:</font> Springfield, Nowhereland<br>
<font class="text-muted">Joined:</font> 1/2/2020<br>
<div>Played in 1,606 multi-player games (87.1% real-time)</div>
<div>Last seen less than 15 minutes ago</div>
<div>Booted 200 times (14% of their last 100)</div>
<h3>Ranked Games</h3>
<font class="text-muted">Completed</font> 1582 ranked games (485 / 1582)<br>
<font class="text-muted">1v1:</font> 300 / 900 (33%)<br>
<font class="text-muted">9 player FFA:</font> 120 / 500 (24%)<br>
<font class="text-muted">2v2:</font> 65 / 182 (35.7%)<br>
<font class="text-muted">Email:</font> test@example.com<br>
</div></body></html>`;

/** A new player: no ranked block, no boots line. */
const NEW_PLAYER_HTML = `<html><head><title>Newbie - War.app</title></head><body>
<div>Level 1</div><font class="text-muted">Location:</font> Springfield<br>
<div>Played in 0 multi-player games (0% real-time)</div></body></html>`;

const COMMON_HTML = `<html><body><h1>4 Common Games with Bob &amp; Co</h1>
<table class="dataTable">
<thead><tr><td>Game</td><td>Started</td><td>Teams</td><td>Your State</td></tr></thead>
<tr><td><a href="MultiPlayer?GameID=2001">Grudge &lt;match&gt;</a></td><td>1/5/2026</td><td>1v1</td><td>Won</td></tr>
<tr><td><a href="MultiPlayer?GameID=2002">Second</a></td><td>2/5/2026</td><td>FFA</td><td>Eliminated</td></tr>
<tr><td><a href="MultiPlayer?GameID=2003">Third</a></td><td>3/5/2026</td><td>1v1</td><td>Playing</td></tr>
<tr><td><a href="/MultiPlayer?GameID=2004">Fourth</a></td><td>4/5/2026</td><td>2v2</td><td><font color="red">Booted</font></td></tr>
</table></body></html>`;

describe('parseProfile', () => {
  it('reads only the allowlisted stats', () => {
    expect(parseProfile(PROFILE_HTML)).toEqual({
      name: 'Bob & Co',
      level: 55,
      multiplayerGames: 1606,
      realTimePct: 87.1,
      lastSeen: 'less than 15 minutes ago',
      boots: 200,
      bootRatePct: 14,
      ranked: { completed: 1582, wins: 485, games: 1582 },
      formats: [
        { format: '1v1', wins: 300, games: 900, pct: 33 },
        { format: '9 player FFA', wins: 120, games: 500, pct: 24 },
        { format: '2v2', wins: 65, games: 182, pct: 35.7 },
      ],
    });
  });

  it('never returns location, email or any other personal field', () => {
    const text = JSON.stringify(parseProfile(PROFILE_HTML));
    expect(text).not.toMatch(/Springfield|Nowhereland|Location|Joined|example\.com/i);
  });

  it('reports null for missing blocks (a new player) instead of throwing', () => {
    expect(parseProfile(NEW_PLAYER_HTML)).toEqual({
      name: 'Newbie',
      level: 1,
      multiplayerGames: 0,
      realTimePct: 0,
      lastSeen: null,
      boots: null,
      bootRatePct: null,
      ranked: null,
      formats: [],
    });
  });

  it('tolerates an empty or unrelated page', () => {
    expect(parseProfile('')).toMatchObject({ name: null, level: null, ranked: null, formats: [] });
    expect(parseProfile('<html><title>War.app</title></html>').name).toBeNull();
  });
});

/**
 * A player controls their name (title, heading), their tagline and their self-reported
 * location. Here all of them imitate stat blocks, placed before the real ones.
 */
const SPOOF_HTML = `<html><head><title>Level 99 Last seen less than 1 minute ago - War.app</title></head>
<body><h1>Level 99</h1>
<div>Level 99</div>
<div>Last seen less than 1 minute ago</div>
<div>Booted 0 times (0% of their last 100)</div>
<div>Played in 9 multi-player games (1% real-time)</div>
<div>Level 99 Last seen less than 1 minute ago Booted 0 times (0% of their last 100)</div>
<div>Level 55</div>
<font class="text-muted">Location:</font> Level 98<br>
<font class="text-muted">Joined:</font> 1/2/2020<br>
<div>Played in 1,606 multi-player games (87.1% real-time)</div>
<div>Last seen 3 days ago</div>
<div>Booted 200 times (14% of their last 100)</div>
</body></html>`;

/** The same imitations, but the page has no real Level, Last seen or Booted block. */
const SPOOF_ABSENT_HTML = `<html><head><title>Last seen less than 1 minute ago - War.app</title></head>
<body><h1>Level 99</h1>
<div>Level 99</div>
<div>Last seen less than 1 minute ago</div>
<div>Booted 0 times (0% of their last 100)</div>
<font class="text-muted">Location:</font> Last seen 1 minute ago<br>
<div>Played in 3 multi-player games (0% real-time)</div>
</body></html>`;

describe('parseProfile anchors every stat to the label rows', () => {
  it.each(ANCHOR_CASES)('%s', (_what, html, expected) => {
    expect(parseProfile(html)).toMatchObject(expected);
  });
});

describe('parseProfile against owner-written text', () => {
  it('reads the real blocks, never an imitation in the name, tagline or location', () => {
    expect(parseProfile(SPOOF_HTML)).toMatchObject({
      level: 55,
      multiplayerGames: 1606,
      realTimePct: 87.1,
      lastSeen: '3 days ago',
      boots: 200,
      bootRatePct: 14,
    });
  });

  it('reads null where the real block is absent, never the imitation', () => {
    expect(parseProfile(SPOOF_ABSENT_HTML)).toMatchObject({
      level: null,
      multiplayerGames: 3,
      realTimePct: 0,
      lastSeen: null,
      boots: null,
      bootRatePct: null,
    });
  });

  it('a value of the wrong shape is null', () => {
    const page = (lines: string[]) => `<html><head><title>X - War.app</title></head><body><h1>X</h1>
<div>${lines[0]}</div><font class="text-muted">Joined:</font> 1/2/2020<br><div>Played in 5 multi-player games (${lines[1]}% real-time)</div>
<div>${lines[2]}</div><div>${lines[3]}</div></body></html>`;
    expect(
      parseProfile(page(['Level 5x', '40', 'Last seen visit my site', 'Booted 3 times (250% of their last 100)'])),
    ).toMatchObject({ level: null, multiplayerGames: 5, realTimePct: 40, lastSeen: null, boots: null, bootRatePct: null });
    expect(parseProfile(page(['Level 5', '140', 'Last seen 2 hours ago', 'Booted 1 time (1% of their last 100)']))).toMatchObject({
      level: null,
      multiplayerGames: null,
      realTimePct: null,
      lastSeen: null,
      boots: null,
    });
    expect(parseProfile(page(['Level 5', '40', 'Last seen 2 hours ago', 'Booted 1 time (1% of their last 100)']))).toMatchObject({
      level: 5,
      multiplayerGames: 5,
      realTimePct: 40,
      lastSeen: '2 hours ago',
      boots: 1,
      bootRatePct: 1,
    });
  });
});

describe('page size and pathological input', () => {
  const quick = (f: () => unknown) => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };

  it('treats a page larger than MAX_PAGE_CHARS as unparseable: nulls, never a throw', () => {
    const pad = `<!-- ${'x'.repeat(MAX_PAGE_CHARS)} -->`;
    expect(parseProfile(PROFILE_HTML + pad)).toEqual({
      name: null,
      level: null,
      multiplayerGames: null,
      realTimePct: null,
      lastSeen: null,
      boots: null,
      bootRatePct: null,
      ranked: null,
      formats: [],
    });
    expect(parseCommonGames(COMMON_HTML + pad)).toEqual({ count: null, wins: 0, losses: 0, inProgress: 0, teamGames: 0, games: [] });
  });

  it('a page of one repeated character returns quickly', () => {
    expect(quick(() => parseProfile(`<title>${'<'.repeat(200_000)}`))).toBeLessThan(200);
    expect(quick(() => parseProfile('<'.repeat(900_000)))).toBeLessThan(200);
    expect(quick(() => parseCommonGames(`<h1${' '.repeat(900_000)}`))).toBeLessThan(200);
  });

  it('unterminated rows return quickly', () => {
    const open = '<a href="MultiPlayer?GameID=1">';
    expect(quick(() => parseCommonGames(open.repeat(20_000) + '</a>'.repeat(20_000)))).toBeLessThan(200);
    expect(quick(() => parseCommonGames(open + 'x</a></td><td>'.repeat(40_000)))).toBeLessThan(200);
    expect(quick(() => parseCommonGames(`${open}${'<td>'.repeat(200_000)}`))).toBeLessThan(200);
  });

  // Guards the parser's own script skipping and entity decoding (textNodes), not an older flaw.
  it('the script skipping and entity decoding stay linear on a page of unclosed tags', () => {
    expect(quick(() => parseProfile(`<title>X - War.app</title>${'<script>'.repeat(100_000)}`))).toBeLessThan(200);
    expect(quick(() => parseProfile(`<title>X</title>${'&aaaaaaaaaaaaaaaaaaaa'.repeat(40_000)}`))).toBeLessThan(200);
  });
});

describe('parseCommonGames', () => {
  it('reads the common games and counts my wins, losses and games in progress', () => {
    // #130: the 2v2 is not a loss to them — the page does not say which side they were on.
    expect(parseCommonGames(COMMON_HTML)).toEqual({
      count: 4,
      wins: 1,
      losses: 1,
      inProgress: 1,
      teamGames: 1,
      games: [
        { id: 2001, name: 'Grudge <match>', started: '1/5/2026', teams: '1v1', myState: 'Won' },
        { id: 2002, name: 'Second', started: '2/5/2026', teams: 'FFA', myState: 'Eliminated' },
        { id: 2003, name: 'Third', started: '3/5/2026', teams: '1v1', myState: 'Playing' },
        { id: 2004, name: 'Fourth', started: '4/5/2026', teams: '2v2', myState: 'Booted' },
      ],
    });
  });

  it('answers zero common games without throwing', () => {
    expect(parseCommonGames('<h1>0 Common Games with Newbie</h1><table class="dataTable"></table>')).toEqual({
      count: 0,
      wins: 0,
      losses: 0,
      inProgress: 0,
      teamGames: 0,
      games: [],
    });
    expect(parseCommonGames('')).toEqual({ count: null, wins: 0, losses: 0, inProgress: 0, teamGames: 0, games: [] });
  });

  it('a team game counts toward neither wins nor losses: they may have been my teammate (#130)', () => {
    const row = (id: number, teams: string, state: string) =>
      `<tr><td><a href="MultiPlayer?GameID=${id}">G</a></td><td>d</td><td>${teams}</td><td>${state}</td></tr>`;
    const html = row(1, '2v2', 'Won') + row(2, '3v3v3', 'Eliminated') + row(3, '1v1', 'Won') + row(4, 'FFA', 'Booted');
    expect(parseCommonGames(html)).toMatchObject({ count: 4, wins: 1, losses: 1, teamGames: 2 });
  });

  it('returns at most 1000 games from a page of minimal rows', () => {
    const rows = Array.from({ length: 1500 }, (_, i) => `<a href="MultiPlayer?GameID=${i + 1}">G</a></td><td>d</td><td>1v1</td><td>Won</td>`);
    const r = parseCommonGames(`<h1>1500 Common Games with X</h1>${rows.join('')}`);
    expect(r.games).toHaveLength(1000);
    expect(r.count).toBe(1500);
  });

  it('a state it cannot classify counts as none of the three', () => {
    const html = '<tr><td><a href="MultiPlayer?GameID=9">X</a></td><td>d</td><td>t</td><td>Declined</td></tr>';
    expect(parseCommonGames(html)).toMatchObject({ count: 1, wins: 0, losses: 0, inProgress: 0 });
  });
});

describe('page urls', () => {
  it('takes only an invite token', () => {
    expect(profileUrl(BOB.token)).toBe(`https://war.app/Profile?p=${BOB.token}`);
    expect(commonGamesUrl(BOB.token)).toBe(`https://war.app/CommonGames?p=${BOB.token}`);
    expect(() => profileUrl('12&x=1')).toThrow(/invite token/);
  });
});

const PAGES = {
  [`https://war.app/Profile?p=${BOB.token}`]: PROFILE_HTML,
  [`https://war.app/CommonGames?p=${BOB.token}`]: COMMON_HTML,
};

function gameWithBob(): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>).map((p, i) =>
    i === 1 ? { ...p, id: BOB.token, name: BOB.name } : p,
  );
  return { ...f, id: String(GAME), players };
}

describe('warapp_scout_player', () => {
  it('scouts a player named in a game: profile stats and head-to-head, nothing personal', async () => {
    h = await liveHarness({ feed: [gameWithBob()], pages: PAGES });
    const res = await h.call('warapp_scout_player', { game_id: GAME, player: 'bob' });
    const p = payload(res);
    expect(p.untrusted_content).toBe(true);
    expect(p.player).toEqual({ id: BOB.token, name: 'Bob & Co' });
    expect(p.profile).toMatchObject({ level: 55, boots: 200, bootRatePct: 14 });
    expect(p.headToHead).toMatchObject({ count: 4, wins: 1, losses: 1, inProgress: 1, teamGames: 1 });
    expect(textOf(res)).not.toMatch(/Springfield|Nowhereland|Location|example\.com/i);
    expect(h.calls[0]!.url).toContain(`GameID=${GAME}`);
    // The two pages are fetched concurrently, so their order is not fixed.
    expect(h.bridge.requests.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [`GET https://war.app/Profile?p=${BOB.token}`, `GET https://war.app/CommonGames?p=${BOB.token}`].sort(),
    );
  });

  it('scouts by a raw invite token without a game', async () => {
    h = await liveHarness({ pages: PAGES });
    const p = payload(await h.call('warapp_scout_player', { player: BOB.token }));
    expect(p.player).toEqual({ id: BOB.token, name: 'Bob & Co' });
    expect(h.calls).toEqual([]);
  });

  it('reports the id as the exact token string, leading zeros kept, so it can be passed back', async () => {
    const ZED = '0412345601';
    const pages = {
      [`https://war.app/Profile?p=${ZED}`]: PROFILE_HTML,
      [`https://war.app/CommonGames?p=${ZED}`]: COMMON_HTML,
    };
    h = await liveHarness({ pages });
    const first = payload(await h.call('warapp_scout_player', { player: ZED }));
    expect((first.player as { id: unknown }).id).toBe(ZED);
    const again = payload(await h.call('warapp_scout_player', { player: (first.player as { id: string }).id }));
    expect((again.player as { id: unknown }).id).toBe(ZED);
    // The two pages are fetched concurrently, so their order is not fixed.
    expect(h.bridge.requests.map((r) => r.path).sort()).toEqual(
      [
        `https://war.app/Profile?p=${ZED}`,
        `https://war.app/CommonGames?p=${ZED}`,
        `https://war.app/Profile?p=${ZED}`,
        `https://war.app/CommonGames?p=${ZED}`,
      ].sort(),
    );
  });

  it('refuses a name without a game to look it up in', async () => {
    h = await liveHarness({ pages: PAGES });
    const res = await h.call('warapp_scout_player', { player: 'Bob' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/game_id/);
    expect(h.bridge.requests).toEqual([]);
  });

  it('a new player: nulls, not an error', async () => {
    h = await liveHarness({
      pages: {
        [`https://war.app/Profile?p=${BOB.token}`]: NEW_PLAYER_HTML,
        [`https://war.app/CommonGames?p=${BOB.token}`]: '<h1>0 Common Games with Newbie</h1>',
      },
    });
    const p = payload(await h.call('warapp_scout_player', { player: BOB.token }));
    expect(p.profile).toMatchObject({ ranked: null, formats: [], boots: null });
    expect(p.headToHead).toMatchObject({ count: 0, games: [] });
  });

  it('a page that is not a profile (signed out, no such player) is an error, not a new player named "Sign in" (#130)', async () => {
    const SIGN_IN = '<html><head><title>Sign in - War.app</title></head><body><form><input type="email"></form></body></html>';
    h = await liveHarness({
      pages: {
        [`https://war.app/Profile?p=${BOB.token}`]: SIGN_IN,
        [`https://war.app/CommonGames?p=${BOB.token}`]: SIGN_IN,
      },
    });
    const res = await h.call('warapp_scout_player', { player: BOB.token });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not a player profile/);
    expect(textOf(res)).not.toMatch(/"name":"Sign in"/);
  });

  it('errors with a bridge hint when a page cannot be read', async () => {
    h = await liveHarness({ pages: {} });
    const res = await h.call('warapp_scout_player', { player: BOB.token });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/war\.app tab/);
  });
});
