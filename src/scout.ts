// Scouting a war.app player from two server-rendered pages read through the
// bridge: Profile (stats) and CommonGames (head-to-head with the signed-in
// account). Both pages also carry personal details (e.g. a self-reported
// location); this module projects an ALLOWLIST of fields and never returns
// anything else. Parsing is loose: a block that is missing (a new player has no
// ranked games) reads as null, never a throw.

import { McpToolError } from '@chrischall/mcp-utils';

export interface FormatRecord {
  format: string;
  wins: number;
  games: number;
  pct: number;
}

export interface ProfileStats {
  name: string | null;
  level: number | null;
  multiplayerGames: number | null;
  realTimePct: number | null;
  /** war.app's own wording, e.g. "less than 15 minutes ago". */
  lastSeen: string | null;
  boots: number | null;
  /** Share of their last 100 games they were booted from. */
  bootRatePct: number | null;
  ranked: { completed: number; wins: number; games: number } | null;
  formats: FormatRecord[];
}

export interface CommonGame {
  id: number;
  name: string;
  started: string;
  teams: string;
  /** The signed-in account's state in that game, as war.app words it. */
  myState: string;
}

export interface HeadToHead {
  count: number | null;
  /** My wins and losses in games without teams; a team game is in {@link teamGames} instead. */
  wins: number;
  losses: number;
  inProgress: number;
  /**
   * Common games with teams (e.g. "2v2"): the page does not say which side the player was on, so
   * they may have been my teammate — never counted as a win or a loss against them (#130).
   */
  teamGames: number;
  games: CommonGame[];
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Text of an HTML fragment: tags dropped, entities decoded, whitespace collapsed. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const num = (s: string): number => Number(s.replace(/,/g, ''));
const NUM = '(\\d[\\d,]*)';
const PCT = '(\\d+(?:\\.\\d+)?)';

export function parseProfile(html: string): ProfileStats {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const titleText = title ? textOf(title[1]!) : '';
  const nameMatch = / - War\.app\b/i.exec(titleText);
  const name = nameMatch && nameMatch.index > 0 ? titleText.slice(0, nameMatch.index).trim() : null;

  const text = textOf(html);
  const level = new RegExp(`\\bLevel ${NUM}`).exec(text);
  const played = new RegExp(`Played in ${NUM} multi-player games \\(${PCT}% real-time\\)`).exec(text);
  // From the markup, so the phrase ends where its element does.
  const seen = /Last seen\s+([^<]{1,80})/i.exec(html);
  const booted = new RegExp(`Booted ${NUM} times? \\(${PCT}% of their last 100\\)`).exec(text);
  const ranked = new RegExp(`Completed ${NUM} ranked games \\(${NUM} / ${NUM}\\)`).exec(text);

  const formats: FormatRecord[] = [];
  const marker = /Completed\s*(?:<\/font>)?\s*\d[\d,]*\s*ranked games/i.exec(html);
  if (marker) {
    const row = new RegExp(
      `<font[^>]*class=["']?text-muted["']?[^>]*>\\s*([^<:]{1,60}?)\\s*:\\s*</font>\\s*${NUM}\\s*/\\s*${NUM}\\s*\\(\\s*${PCT}\\s*%\\s*\\)`,
      'gi',
    );
    row.lastIndex = marker.index + marker[0].length;
    for (let m = row.exec(html); m; m = row.exec(html)) {
      formats.push({ format: textOf(m[1]!), wins: num(m[2]!), games: num(m[3]!), pct: Number(m[4]) });
    }
  }

  return {
    name: level || played ? name : null,
    level: level ? num(level[1]!) : null,
    multiplayerGames: played ? num(played[1]!) : null,
    realTimePct: played ? Number(played[2]) : null,
    lastSeen: seen ? textOf(seen[1]!) || null : null,
    boots: booted ? num(booted[1]!) : null,
    bootRatePct: booted ? Number(booted[2]) : null,
    ranked: ranked ? { completed: num(ranked[1]!), wins: num(ranked[2]!), games: num(ranked[3]!) } : null,
    formats,
  };
}

/**
 * Whether a page parsed as a profile is one: every player's profile shows a level and the
 * multi-player games played (a new player's say 0), while a sign-in page or an unknown player's
 * page has neither (#130).
 */
export function isProfile(p: ProfileStats): boolean {
  return p.level !== null || p.multiplayerGames !== null;
}

/** Whether a common game's teams column has teams: a side of more than one player ("2v2", "3v3v3", "Teams"). */
export function isTeamGame(teams: string): boolean {
  if (/\bteams?\b/i.test(teams)) return true;
  const sides = /^\s*\d+(?:\s*v\s*\d+)+\s*$/i.test(teams) ? teams.split(/v/i).map((x) => Number(x.trim())) : [];
  return sides.some((n) => n > 1);
}

type Outcome = 'win' | 'loss' | 'inProgress' | undefined;

/** My state in a common game, as a win, a loss, still going, or none of those (declined, …). */
function outcomeOf(state: string): Outcome {
  if (/^won\b/i.test(state)) return 'win';
  if (/eliminated|booted|surrender|lost/i.test(state)) return 'loss';
  if (/playing|invited|waiting/i.test(state)) return 'inProgress';
  return undefined;
}

export function parseCommonGames(html: string): HeadToHead {
  const header = /<h1[^>]*>\s*(\d[\d,]*)\s+Common Games?\b/i.exec(html);
  const games: CommonGame[] = [];
  const row =
    /<a[^>]*href=["']?[^"'>]*MultiPlayer\?GameID=(\d+)[^>]*>([\s\S]*?)<\/a>\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  for (let m = row.exec(html); m; m = row.exec(html)) {
    games.push({ id: Number(m[1]), name: textOf(m[2]!), started: textOf(m[3]!), teams: textOf(m[4]!), myState: textOf(m[5]!) });
  }
  const tally = { win: 0, loss: 0, inProgress: 0 };
  let teamGames = 0;
  for (const g of games) {
    const o = outcomeOf(g.myState);
    const team = isTeamGame(g.teams);
    if (team) teamGames++;
    if (o === 'inProgress' || (o && !team)) tally[o]++;
  }
  return {
    count: header ? num(header[1]!) : games.length ? games.length : null,
    wins: tally.win,
    losses: tally.loss,
    inProgress: tally.inProgress,
    teamGames,
    games,
  };
}

function checkToken(token: string): string {
  if (!/^\d{5,20}$/.test(token)) {
    throw new McpToolError(`${JSON.stringify(token)} is not a war.app invite token (a GameFeed player id).`, {
      hint: 'Pass the player id from warapp_get_game, or game_id plus the player name.',
    });
  }
  return token;
}

export const profileUrl = (token: string): string => `https://war.app/Profile?p=${checkToken(token)}`;
export const commonGamesUrl = (token: string): string => `https://war.app/CommonGames?p=${checkToken(token)}`;
