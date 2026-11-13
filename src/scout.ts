// Scouting a war.app player from two server-rendered pages read through the
// bridge: Profile (stats) and CommonGames (head-to-head with the signed-in
// account). Both pages also carry personal details (e.g. a self-reported
// location); this module projects an ALLOWLIST of fields and never returns
// anything else. Parsing is loose: a block that is missing (a new player has no
// ranked games) reads as null, never a throw.
//
// The pages are untrusted input, and parts of them are written by the player
// being scouted (name, tagline, location). So: a page over MAX_PAGE_CHARS is not
// parsed at all; no pattern runs over the whole document (blocks are found by
// fixed markers and read through small anchored patterns on a bounded window, so
// parsing is linear in the page); and each stat is read only from its own block,
// where the page lays it out, never from the first place its wording appears.
// A value of the wrong shape is null.
//
// The anchor is war.app's own label markup (`<font class="text-muted">Joined:</font>
// value<br>`), which a player cannot write: Played is the one whole block (div, p, li or td) worded
// "Played in …" straight after a run of label rows, Level the whole block straight
// before them, Last seen and Booted the whole blocks straight after Played. No
// such block, or two, reads as null for all four. What this still relies on (the
// layout is not verified live): the page has at least one label row between the
// Level and Played blocks, and no player-written block sits directly before that
// run (in place of a missing Level block) or directly after Played (in place of
// a missing Last seen or Booted block).

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

/**
 * Larger than any real Profile or CommonGames page (tens of kilobytes). A bigger
 * page is not parsed: every block reads as missing.
 */
export const MAX_PAGE_CHARS = 1 << 20;
/** Text longer than this is never a stat block, a label or a title. */
const MAX_NODE_CHARS = 1024;
/** A tag is classified from at most this many characters. */
const MAX_TAG_CHARS = 512;
/** How far a common-games row's next cell may be from the last. */
const CELL_WINDOW = 2048;
/** Label rows (Location, Joined, …) that may sit between the Level and Played blocks. */
const MAX_LABEL_ROWS = 16;
const MAX_FORMATS = 64;
/** More common games than anyone plays against one player; the rest of a bigger page is dropped. */
const MAX_GAMES = 1000;

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clean = (s: string): string => decodeEntities(s).replace(/\s+/g, ' ').trim();

/** Text of a (bounded) HTML fragment: tags dropped, entities decoded, whitespace collapsed. */
const textOf = (html: string): string => clean(html.replace(/<[^<>]*>/g, ' '));

// Values are validated by shape: an integer (thousands separators allowed), a percentage.
const INT = '(\\d{1,3}(?:,\\d{3})+|\\d{1,12})';
const PCT = '(\\d{1,3}(?:\\.\\d{1,2})?)';
const int = (s: string): number | null => {
  const n = Number(s.replace(/,/g, ''));
  return Number.isSafeInteger(n) ? n : null;
};
const pct = (s: string): number | null => {
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};
/** Every value of a block, or null when any of them has the wrong shape. */
const values = (v: Array<number | null>): number[] | null => (v.every((x) => x !== null) ? (v as number[]) : null);

const LEVEL = new RegExp(`^Level ${INT}$`);
const PLAYED = new RegExp(`^Played in ${INT} multi-player games \\(${PCT}% real-time\\)$`);
// war.app's own phrasing only, e.g. "less than 15 minutes ago", "3 days ago".
const SEEN = /^Last seen ((?:less than )?\d{1,4} (?:second|minute|hour|day|week|month|year)s? ago)$/i;
const SEEN_BLOCK = /^Last seen\b/i;
const PLAYED_BLOCK = /^Played in\b/i;
const BOOTED = new RegExp(`^Booted ${INT} times? \\(${PCT}% of their last 100\\)$`);
const RANKED = new RegExp(`^${INT} ranked games \\(${INT} / ${INT}\\)$`);
const FORMAT_LABEL = /^([^:]{1,60}):$/;
const FORMAT_ROW = new RegExp(`^${INT} ?/ ?${INT} ?\\( ?${PCT} ?% ?\\)$`);
const MUTED = /^<font\b[^>]*\bclass\s*=\s*["']?text-muted\b/i;
const BLOCK_OPEN = /^<(div|p|li|td)\b/i;
const BLOCK_CLOSE = /^<\/(div|p|li|td)\s*>/i;

/** A run of text between two tags: `open` is the tag before it, `close` the tag after. */
interface TextNode {
  text: string;
  open: string;
  close: string;
}

/**
 * The non-empty text nodes of `html` from `from` on, in one linear pass. Script and
 * style bodies are skipped; an over-long node keeps its place but matches nothing.
 */
function textNodes(html: string, from: number): TextNode[] {
  const nodes: TextNode[] = [];
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
const isMuted = (n: TextNode | undefined): boolean =>
  !!n && MUTED.test(n.open) && /^<\/font\s*>/i.test(n.close);
const isLabel = (n: TextNode | undefined): boolean => isMuted(n) && n!.text.endsWith(':');
/** A label's value: the text straight after the label's `</font>`, never a block of its own. */
const isLabelValue = (label: TextNode | undefined, n: TextNode | undefined): boolean =>
  isLabel(label) && !!n && /^<\/font\s*>/i.test(n.open);
/** A whole block: all the text of a `<div>` (or p, li, td) with no tag inside it. */
const isBlock = (n: TextNode | undefined): boolean => {
  const o = n ? BLOCK_OPEN.exec(n.open) : null;
  const c = o ? BLOCK_CLOSE.exec(n!.close) : null;
  return !!c && c[1]!.toLowerCase() === o![1]!.toLowerCase();
};

/** The first match of `re` (anchored, not global) in the `window` characters from `from`, as offsets. */
function near(html: string, from: number, re: RegExp, window = CELL_WINDOW): { start: number; end: number } | null {
  const m = re.exec(html.slice(from, from + window));
  return m ? { start: from + m.index, end: from + m.index + m[0].length } : null;
}

const EMPTY_PROFILE: ProfileStats = {
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

export function parseProfile(html: string): ProfileStats {
  if (html.length > MAX_PAGE_CHARS) return { ...EMPTY_PROFILE, formats: [] };

  // The name comes from the title only; the stats are read after it and after the
  // name heading, both of which the player writes.
  let name: string | null = null;
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
  const at = (i: number): string => nodes[i]?.text ?? '';
  const isValue = (i: number): boolean => isLabelValue(nodes[i - 1], nodes[i]);
  /** The node just before the run of label rows that ends right before node `i`; null when no label row is there. */
  const beforeLabels = (i: number): number | null => {
    let j = i - 1;
    for (let rows = 0; j >= 0 && rows < MAX_LABEL_ROWS; rows++) {
      if (isLabel(nodes[j])) j -= 1;
      else if (isValue(j)) j -= 2;
      else break;
    }
    return j < i - 1 ? j : null;
  };

  // Played: the one whole block worded "Played in …" that follows war.app's label rows
  // (Location, Joined, …) — the player cannot write that markup, only the text in it.
  // Two such blocks, or one of the wrong shape, read as null, and so does everything
  // anchored to it: never an imitation from elsewhere on the page.
  const candidates: number[] = [];
  for (let i = 0; i < nodes.length && candidates.length < 2; i++) {
    if (PLAYED_BLOCK.test(at(i)) && isBlock(nodes[i]) && beforeLabels(i) !== null) candidates.push(i);
  }
  let p = -1;
  let played: number[] | null = null;
  if (candidates.length === 1) {
    const m = PLAYED.exec(at(candidates[0]!));
    played = m ? values([int(m[1]!), pct(m[2]!)]) : null;
    if (played) p = candidates[0]!;
  }

  // Level: the whole block just before those label rows.
  let level: number | null = null;
  if (p >= 0) {
    const j = beforeLabels(p)!;
    const m = j >= 0 && isBlock(nodes[j]) ? LEVEL.exec(at(j)) : null;
    level = m ? int(m[1]!) : null;
  }

  // Last seen, then Booted: the whole blocks right after Played.
  let lastSeen: string | null = null;
  let booted: number[] | null = null;
  if (p >= 0) {
    let k = p + 1;
    if (SEEN_BLOCK.test(at(k)) && isBlock(nodes[k])) {
      lastSeen = SEEN.exec(at(k))?.[1] ?? null;
      k++;
    }
    const m = isBlock(nodes[k]) ? BOOTED.exec(at(k)) : null;
    booted = m ? values([int(m[1]!), pct(m[2]!)]) : null;
  }

  // Ranked: war.app's `Completed` label and its value, then the per-format label rows.
  let ranked: ProfileStats['ranked'] = null;
  const formats: FormatRecord[] = [];
  for (let i = 0; i < nodes.length - 1 && !ranked; i++) {
    if (!isMuted(nodes[i]) || at(i) !== 'Completed') continue;
    const m = RANKED.exec(at(i + 1));
    const v = m ? values([int(m[1]!), int(m[2]!), int(m[3]!)]) : null;
    if (!v) continue;
    ranked = { completed: v[0]!, wins: v[1]!, games: v[2]! };
    for (let r = i + 2; r + 1 < nodes.length && formats.length < MAX_FORMATS; r += 2) {
      const label = isLabel(nodes[r]) ? FORMAT_LABEL.exec(at(r)) : null;
      const row = label ? FORMAT_ROW.exec(at(r + 1)) : null;
      const rv = row ? values([int(row[1]!), int(row[2]!), pct(row[3]!)]) : null;
      if (!rv) break;
      formats.push({ format: label![1]!.trim(), wins: rv[0]!, games: rv[1]!, pct: rv[2]! });
    }
  }

  return {
    // A page with neither a level nor games played is not a profile (signed out, no such player).
    name: level !== null || played ? name : null,
    level,
    multiplayerGames: played ? played[0]! : null,
    realTimePct: played ? played[1]! : null,
    lastSeen,
    boots: booted ? booted[0]! : null,
    bootRatePct: booted ? booted[1]! : null,
    ranked,
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

const HEADER = new RegExp(`^\\s*${INT}\\s+Common Games?\\b`, 'i');
const GAME_LINK = /(?:^|\/)MultiPlayer\?GameID=(\d{1,12})(?!\d)/i;

/** One table row from the game link's tag end at `from`: its four cells and where it ends. */
function rowAt(html: string, from: number): { cells: string[]; end: number } | null {
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

export function parseCommonGames(html: string): HeadToHead {
  const games: CommonGame[] = [];
  let count: number | null = null;
  if (html.length <= MAX_PAGE_CHARS) {
    const h1 = /<h1\b[^<>]{0,200}>/gi;
    for (let m = h1.exec(html); m && count === null; m = h1.exec(html)) {
      const head = HEADER.exec(html.slice(h1.lastIndex, h1.lastIndex + 256));
      if (head) count = int(head[1]!);
    }
    const link = /<a\b[^<>]{0,500}>/gi;
    for (let m = link.exec(html); m && games.length < MAX_GAMES; m = link.exec(html)) {
      const href = /\bhref\s*=\s*(?:"([^"]{0,300})"|'([^']{0,300})'|([^\s"'>]{1,300}))/i.exec(m[0]);
      const id = href ? GAME_LINK.exec(href[1] ?? href[2] ?? href[3]!) : null;
      const row = id ? rowAt(html, link.lastIndex) : null;
      if (!id || !row) continue;
      const [name, started, teams, state] = row.cells.map(textOf) as [string, string, string, string];
      games.push({ id: Number(id[1]), name, started, teams, myState: state });
      link.lastIndex = row.end;
    }
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
    count: count ?? (games.length ? games.length : null),
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
