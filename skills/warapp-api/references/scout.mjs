#!/usr/bin/env node
// scout.mjs — war.app Profile / CommonGames HTML on stdin → allowlisted JSON on stdout.
//
//   fpx get "https://war.app/Profile?p=$PLAYER" -p warapp | node scout.mjs profile
//   fpx get "https://war.app/CommonGames?p=$PLAYER" -p warapp | node scout.mjs common
//
// Dependency-free twin of warapp-mcp's src/scout.ts (its tests pin parity).
// Both pages also carry personal details (e.g. a self-reported location): this
// script projects an ALLOWLIST and never prints anything else. Missing blocks
// (a new player has no ranked games) are null, never an error.
//
// Exit codes: 0 ok · 1 usage · 2 no HTML on stdin (the fetch before it failed).

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const textOf = (html) => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const num = (s) => Number(s.replace(/,/g, ''));
const NUM = '(\\d[\\d,]*)';
const PCT = '(\\d+(?:\\.\\d+)?)';

function parseProfile(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const titleText = title ? textOf(title[1]) : '';
  const nameMatch = / - War\.app\b/i.exec(titleText);
  const name = nameMatch && nameMatch.index > 0 ? titleText.slice(0, nameMatch.index).trim() : null;

  const text = textOf(html);
  const level = new RegExp(`\\bLevel ${NUM}`).exec(text);
  const played = new RegExp(`Played in ${NUM} multi-player games \\(${PCT}% real-time\\)`).exec(text);
  const seen = /Last seen\s+([^<]{1,80})/i.exec(html);
  const booted = new RegExp(`Booted ${NUM} times? \\(${PCT}% of their last 100\\)`).exec(text);
  const ranked = new RegExp(`Completed ${NUM} ranked games \\(${NUM} / ${NUM}\\)`).exec(text);

  const formats = [];
  const marker = /Completed\s*(?:<\/font>)?\s*\d[\d,]*\s*ranked games/i.exec(html);
  if (marker) {
    const row = new RegExp(
      `<font[^>]*class=["']?text-muted["']?[^>]*>\\s*([^<:]{1,60}?)\\s*:\\s*</font>\\s*${NUM}\\s*/\\s*${NUM}\\s*\\(\\s*${PCT}\\s*%\\s*\\)`,
      'gi',
    );
    row.lastIndex = marker.index + marker[0].length;
    for (let m = row.exec(html); m; m = row.exec(html)) {
      formats.push({ format: textOf(m[1]), wins: num(m[2]), games: num(m[3]), pct: Number(m[4]) });
    }
  }

  return {
    // A page with neither a level nor games played is not a profile (signed out, no such player).
    name: level || played ? name : null,
    level: level ? num(level[1]) : null,
    multiplayerGames: played ? num(played[1]) : null,
    realTimePct: played ? Number(played[2]) : null,
    lastSeen: seen ? textOf(seen[1]) || null : null,
    boots: booted ? num(booted[1]) : null,
    bootRatePct: booted ? Number(booted[2]) : null,
    ranked: ranked ? { completed: num(ranked[1]), wins: num(ranked[2]), games: num(ranked[3]) } : null,
    formats,
  };
}

/** A side of more than one player ("2v2", "3v3v3", "Teams"): they may have been my teammate. */
function isTeamGame(teams) {
  if (/\bteams?\b/i.test(teams)) return true;
  const sides = /^\s*\d+(?:\s*v\s*\d+)+\s*$/i.test(teams) ? teams.split(/v/i).map((x) => Number(x.trim())) : [];
  return sides.some((n) => n > 1);
}

function outcomeOf(state) {
  if (/^won\b/i.test(state)) return 'win';
  if (/eliminated|booted|surrender|lost/i.test(state)) return 'loss';
  if (/playing|invited|waiting/i.test(state)) return 'inProgress';
  return undefined;
}

function parseCommonGames(html) {
  const header = /<h1[^>]*>\s*(\d[\d,]*)\s+Common Games?\b/i.exec(html);
  const games = [];
  const row =
    /<a[^>]*href=["']?[^"'>]*MultiPlayer\?GameID=(\d+)[^>]*>([\s\S]*?)<\/a>\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  for (let m = row.exec(html); m; m = row.exec(html)) {
    games.push({ id: Number(m[1]), name: textOf(m[2]), started: textOf(m[3]), teams: textOf(m[4]), myState: textOf(m[5]) });
  }
  // Wins and losses count games without teams only; team games are `teamGames`.
  const tally = { win: 0, loss: 0, inProgress: 0 };
  let teamGames = 0;
  for (const g of games) {
    const o = outcomeOf(g.myState);
    const team = isTeamGame(g.teams);
    if (team) teamGames++;
    if (o === 'inProgress' || (o && !team)) tally[o]++;
  }
  return {
    count: header ? num(header[1]) : games.length ? games.length : null,
    wins: tally.win,
    losses: tally.loss,
    inProgress: tally.inProgress,
    teamGames,
    games,
  };
}

const PARSERS = { profile: parseProfile, common: parseCommonGames };

// A reader that stops early (`| head`) closes the pipe: that is not an error.
process.stdout.on('error', (e) => {
  if (e && e.code === 'EPIPE') process.exit(0);
  throw e;
});

const args = process.argv.slice(2);
const parse = args.length === 1 && Object.hasOwn(PARSERS, args[0]) ? PARSERS[args[0]] : undefined;
if (!parse) {
  process.stderr.write('usage: node scout.mjs profile|common < page.html\n');
  process.exit(1);
}

let html = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) html += chunk;
if (!html.trim()) {
  process.stderr.write('scout: no HTML on stdin (did the fpx call before it fail?)\n');
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(parse(html), null, 2)}\n`);
