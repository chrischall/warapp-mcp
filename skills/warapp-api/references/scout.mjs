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
// A page over MAX_PAGE_CHARS is not parsed, every pattern runs on a bounded
// window, and each stat is read only from its own block (never from the name,
// tagline or location the player writes); a value of the wrong shape is null.
//
// Exit codes: 0 ok · 1 usage · 2 no HTML on stdin (the fetch before it failed).

/**
 * Larger than any real Profile or CommonGames page (tens of kilobytes). A bigger
 * page is not parsed: every block reads as missing.
 */
const MAX_PAGE_CHARS = 1 << 20;
/** Text longer than this is never a stat block, a label or a title. */
const MAX_NODE_CHARS = 1024;
/** A tag is classified from at most this many characters. */
const MAX_TAG_CHARS = 512;
/** How far a common-games row's next cell may be from the last. */
const CELL_WINDOW = 2048;
/** Label rows (Location, Joined, …) that may sit between the Level and Played blocks. */
const MAX_LABEL_ROWS = 16;
const MAX_FORMATS = 64;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,8});/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clean = (s) => decodeEntities(s).replace(/\s+/g, ' ').trim();

/** Text of a (bounded) HTML fragment: tags dropped, entities decoded, whitespace collapsed. */
const textOf = (html) => clean(html.replace(/<[^<>]*>/g, ' '));

// Values are validated by shape: an integer (thousands separators allowed), a percentage.
const INT = '(\\d{1,3}(?:,\\d{3})+|\\d{1,12})';
const PCT = '(\\d{1,3}(?:\\.\\d{1,2})?)';
const int = (s) => {
  const n = Number(s.replace(/,/g, ''));
  return Number.isSafeInteger(n) ? n : null;
};
const pct = (s) => {
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};
/** Every value of a block, or null when any of them has the wrong shape. */
const values = (v) => (v.every((x) => x !== null) ? v : null);

const LEVEL = new RegExp(`^Level ${INT}$`);
const PLAYED = new RegExp(`^Played in ${INT} multi-player games \\(${PCT}% real-time\\)$`);
// war.app's own phrasing only, e.g. "less than 15 minutes ago", "3 days ago".
const SEEN = /^Last seen ((?:less than )?\d{1,4} (?:second|minute|hour|day|week|month|year)s? ago)$/i;
const SEEN_BLOCK = /^Last seen\b/i;
const BOOTED = new RegExp(`^Booted ${INT} times? \\(${PCT}% of their last 100\\)$`);
const RANKED = new RegExp(`^${INT} ranked games \\(${INT} / ${INT}\\)$`);
const FORMAT_LABEL = /^([^:]{1,60}):$/;
const FORMAT_ROW = new RegExp(`^${INT} ?/ ?${INT} ?\\( ?${PCT} ?% ?\\)$`);
const MUTED = /^<font\b[^>]*\bclass\s*=\s*["']?text-muted\b/i;

/**
 * The non-empty text nodes of `html` from `from` on, in one linear pass. Script and
 * style bodies are skipped; an over-long node keeps its place but matches nothing.
 */
function textNodes(html, from) {
  const nodes = [];
  let open = '';
  let pos = from;
  while (pos < html.length) {
    const lt = html.indexOf('<', pos);
    const end = lt < 0 ? html.length : lt;
    const raw = html.slice(pos, end);
    const text = raw.length > MAX_NODE_CHARS ? '\u0000' : clean(raw);
    const gt = lt < 0 ? -1 : html.indexOf('>', lt + 1);
    const close = gt < 0 ? '' : html.slice(lt, Math.min(gt + 1, lt + MAX_TAG_CHARS));
    if (text) nodes.push({ text, open, close });
    if (gt < 0) break;
    open = close;
    pos = gt + 1;
    const body = /^<(script|style)\b/i.exec(close);
    if (body && !close.endsWith('/>')) {
      const shut = new RegExp(`</${body[1]}\\s*>`, 'gi');
      shut.lastIndex = pos;
      const m = shut.exec(html);
      if (!m) break;
      pos = m.index;
    }
  }
  return nodes;
}

/** A label in war.app's own markup, `<font class="text-muted">LABEL</font>`. */
const isMuted = (n) => !!n && MUTED.test(n.open) && /^<\/font\s*>/i.test(n.close);
const isLabel = (n) => isMuted(n) && n.text.endsWith(':');

/** The first match of `re` (anchored, not global) in the `window` characters from `from`, as offsets. */
function near(html, from, re, window = CELL_WINDOW) {
  const m = re.exec(html.slice(from, from + window));
  return m ? { start: from + m.index, end: from + m.index + m[0].length } : null;
}

const EMPTY_PROFILE = {
  name: null,
  level: null,
  multiplayerGames: null,
  realTimePct: null,
  lastSeen: null,
  boots: null,
  bootRatePct: null,
  ranked: null,
  formats: [],
};

function parseProfile(html) {
  if (html.length > MAX_PAGE_CHARS) return { ...EMPTY_PROFILE, formats: [] };

  // The name comes from the title only; the stats are read after it and after the
  // name heading, both of which the player writes.
  let name = null;
  let start = 0;
  const title = /<title\b[^<>]{0,200}>/i.exec(html);
  if (title) {
    const from = title.index + title[0].length;
    const shut = near(html, from, /<\/title\s*>/i, MAX_NODE_CHARS);
    if (shut) {
      const titleText = textOf(html.slice(from, shut.start));
      const nameMatch = / - War\.app\b/i.exec(titleText);
      name = nameMatch && nameMatch.index > 0 ? titleText.slice(0, nameMatch.index).trim() : null;
      start = shut.end;
    }
  }
  const heading = /<\/h1\s*>/i.exec(html.slice(start));
  if (heading) start += heading.index + heading[0].length;

  const nodes = textNodes(html, start);
  const at = (i) => nodes[i]?.text ?? '';
  const isValue = (i) => isLabel(nodes[i - 1]);

  // Played: a block of its own (never a label's value, such as a location); the
  // player's free text comes before the real blocks, so the last one is the page's.
  let p = -1;
  let played = null;
  for (let i = 0; i < nodes.length; i++) {
    const m = PLAYED.exec(at(i));
    const v = m && !isValue(i) ? values([int(m[1]), pct(m[2])]) : null;
    if (v) [p, played] = [i, v];
  }

  // Level: the block just before the label rows that precede Played.
  let level = null;
  if (p >= 0) {
    let j = p - 1;
    for (let rows = 0; j >= 0 && rows < MAX_LABEL_ROWS; rows++) {
      if (isLabel(nodes[j])) j -= 1;
      else if (isValue(j)) j -= 2;
      else break;
    }
    const m = j >= 0 && !isValue(j) ? LEVEL.exec(at(j)) : null;
    level = m ? int(m[1]) : null;
  }

  // Last seen, then Booted: the blocks right after Played.
  let lastSeen = null;
  let booted = null;
  if (p >= 0) {
    let k = p + 1;
    if (SEEN_BLOCK.test(at(k))) {
      lastSeen = SEEN.exec(at(k))?.[1] ?? null;
      k++;
    }
    const m = BOOTED.exec(at(k));
    booted = m ? values([int(m[1]), pct(m[2])]) : null;
  }

  // Ranked: war.app's `Completed` label and its value, then the per-format label rows.
  let ranked = null;
  const formats = [];
  for (let i = 0; i < nodes.length - 1 && !ranked; i++) {
    if (!isMuted(nodes[i]) || at(i) !== 'Completed') continue;
    const m = RANKED.exec(at(i + 1));
    const v = m ? values([int(m[1]), int(m[2]), int(m[3])]) : null;
    if (!v) continue;
    ranked = { completed: v[0], wins: v[1], games: v[2] };
    for (let r = i + 2; r + 1 < nodes.length && formats.length < MAX_FORMATS; r += 2) {
      const label = isLabel(nodes[r]) ? FORMAT_LABEL.exec(at(r)) : null;
      const row = label ? FORMAT_ROW.exec(at(r + 1)) : null;
      const rv = row ? values([int(row[1]), int(row[2]), pct(row[3])]) : null;
      if (!rv) break;
      formats.push({ format: label[1].trim(), wins: rv[0], games: rv[1], pct: rv[2] });
    }
  }

  return {
    // A page with neither a level nor games played is not a profile (signed out, no such player).
    name: level !== null || played ? name : null,
    level,
    multiplayerGames: played ? played[0] : null,
    realTimePct: played ? played[1] : null,
    lastSeen,
    boots: booted ? booted[0] : null,
    bootRatePct: booted ? booted[1] : null,
    ranked,
    formats,
  };
}

/** A side of more than one player ("2v2", "3v3v3", "Teams"): they may have been my teammate. */
function isTeamGame(teams) {
  if (/\bteams?\b/i.test(teams)) return true;
  const sides = /^\s*\d+(?:\s*v\s*\d+)+\s*$/i.test(teams) ? teams.split(/v/i).map((x) => Number(x.trim())) : [];
  return sides.some((n) => n > 1);
}

/** My state in a common game, as a win, a loss, still going, or none of those (declined, …). */
function outcomeOf(state) {
  if (/^won\b/i.test(state)) return 'win';
  if (/eliminated|booted|surrender|lost/i.test(state)) return 'loss';
  if (/playing|invited|waiting/i.test(state)) return 'inProgress';
  return undefined;
}

const HEADER = new RegExp(`^\\s*${INT}\\s+Common Games?\\b`, 'i');
const GAME_LINK = /(?:^|\/)MultiPlayer\?GameID=(\d{1,12})(?!\d)/i;

/** One table row from the game link's tag end at `from`: its four cells and where it ends. */
function rowAt(html, from) {
  const a = near(html, from, /<\/a\s*>/i);
  if (!a) return null;
  const cells = [html.slice(from, a.start)];
  const first = near(html, a.end, /^\s*<\/td\s*>/i, MAX_TAG_CHARS);
  if (!first) return null;
  let pos = first.end;
  for (let c = 0; c < 3; c++) {
    const td = near(html, pos, /^\s*<td\b[^<>]{0,200}>/i, MAX_TAG_CHARS);
    if (!td) return null;
    const shut = near(html, td.end, /<\/td\s*>/i);
    if (!shut) return null;
    cells.push(html.slice(td.end, shut.start));
    pos = shut.end;
  }
  return { cells, end: pos };
}

function parseCommonGames(html) {
  const games = [];
  let count = null;
  if (html.length <= MAX_PAGE_CHARS) {
    const h1 = /<h1\b[^<>]{0,200}>/gi;
    for (let m = h1.exec(html); m && count === null; m = h1.exec(html)) {
      const head = HEADER.exec(html.slice(h1.lastIndex, h1.lastIndex + 256));
      if (head) count = int(head[1]);
    }
    const link = /<a\b[^<>]{0,500}>/gi;
    for (let m = link.exec(html); m; m = link.exec(html)) {
      const href = /\bhref\s*=\s*(?:"([^"]{0,300})"|'([^']{0,300})'|([^\s"'>]{1,300}))/i.exec(m[0]);
      const id = href ? GAME_LINK.exec(href[1] ?? href[2] ?? href[3]) : null;
      const row = id ? rowAt(html, link.lastIndex) : null;
      if (!id || !row) continue;
      const [name, started, teams, state] = row.cells.map(textOf);
      games.push({ id: Number(id[1]), name, started, teams, myState: state });
      link.lastIndex = row.end;
    }
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
    count: count ?? (games.length ? games.length : null),
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
