// Open games: the list war.app's OpenGames page embeds, decoded by the client
// bundle's own GameInfo reader and normalized into what a player picks a game by.
//
// VERIFIED 2026-11-12 (docs/PLAN-OPEN-GAMES.md): `GET /MultiPlayer/OpenGames`
// carries `<script type="text/plain" id="AllOpenGamesData">HEX</script>`; the
// client hex-decodes it and reads an int32 count, then that many
// `warlight.shared.GameInfo` records (no present flags). Field names are
// minified, so GameInfo and its GameInfoSettings are read by registered type
// name and fields by read order (positions below, each checked for its type),
// the same as `my-games.ts`. The reader stays loose: a record that does not
// fit is skipped, a payload that stops decoding keeps what was read, and a
// missing or malformed payload is an empty list with a note — never a throw.
// Whatever the record does not carry reliably is omitted, never guessed.

import { armiesToTake } from './analysis/combat.js';
import { DEFAULT_BASE_INCOME } from './analysis/player.js';
import { cardTypeName } from './cards.js';
import { colorIndexOf } from './join-color.js';
import type { ClassReader } from './live.js';
import type { GameSettings } from './normalize.js';
import { Reader } from './protocol/codec.js';
import { fields, isObj } from './protocol/decoded.js';
import type { ReadBudget } from './protocol/interp.js';
import { holdsSeat, playerStateName } from './player-states.js';
import { carriesTeam } from './teams.js';

export const OPEN_GAMES_URL = 'https://war.app/MultiPlayer/OpenGames';
export const GAME_INFO = 'warlight.shared.GameInfo';
export const GAME_INFO_SETTINGS = 'warlight.shared.GameInfoSettings';
const GAME_INFO_PLAYER = 'warlight.shared.GameInfoPlayer';

/**
 * The most records an OpenGames payload may claim. The count is read from the payload, and each
 * record is a run of the downloaded bundle's reader, so it is bounded: the page lists a few hundred
 * open games at most, and this is far above that.
 */
export const MAX_OPEN_GAMES = 5_000;

/** GameInfo field positions in read order. */
const GI = {
  randomTeamsOf: 0,
  entryFee: 3,
  prize: 4,
  bootTime: 5,
  gameId: 7,
  mapId: 10,
  maxPlayers: 12,
  name: 13,
  openSeats: 15,
  players: 16,
  realTime: 19,
  settings: 21,
} as const;
const GI_MIN_FIELDS = 23;
/** GameInfoPlayer: the colour (an optional GameColor), the in-game id, the state (GamePlayerState) and the team. */
const GP = { color: 0, id: 6, state: 7, team: 8 } as const;
const GP_MIN_FIELDS = 9;

/** GameInfoSettings field positions in read order. */
const GS = {
  armyCap: 0,
  autoDist: 1,
  bonusArmiesPer: 2,
  settingsString: 3,
  attackOnly: 4,
  transferOnly: 5,
  commerce: 6,
  defensiveKillRate: 7,
  distribution: 9,
  commanders: 10,
  overriddenBonuses: 11,
  bankingBoot: 12,
  localDeployments: 13,
  luck: 14,
  minArmies: 15,
  /** MoveOrderEnum (read from the bundle, #132): 0 Random, 1 Cycle, 2 NoLuckCycle. */
  moveOrder: 16,
  multiAttack: 17,
  noSplit: 18,
  wastelands: 19,
  offensiveKillRate: 20,
  oneArmyStandsGuard: 21,
  ranked: 22,
  roundingMode: 23,
} as const;
const GS_MIN_FIELDS = 24;
/** The distribution mode of a custom scenario. */
const DIST_CUSTOM_SCENARIO = -3;
const DEFAULT_MIN_ARMIES = 5;
const DEFAULT_OFFENSIVE = 0.6;
const DEFAULT_DEFENSIVE = 0.7;
const DEFAULT_ROUNDING = 1;
/** MoveOrderEnum's NoLuckCycle: the first turn is a speed race (docs/WEB-PROTOCOL.md "Begin first turn"). */
const MOVE_ORDER_NO_LUCK_CYCLE = 2;
/** TimeSpans at or beyond this many ms are war.app's "never". */
const NEVER_MS = 922_336_666_814_565;

export type Pace = 'multi-day' | 'real-time';

/** One open game as the tool reports it. */
export interface OpenGame {
  id: number;
  /** Written by the game's creator. */
  name: string;
  url: string;
  pace: Pace;
  /** The boot time, e.g. `3d`, `1d12h`, `5m`; absent when it is "never". */
  bootTime?: string;
  bootTimeMinutes?: number;
  /** Players holding a seat (invited, declined and removed players excluded: src/player-states.ts). */
  players: number;
  openSeats: number;
  /** players + the seats kept for invited players + openSeats. */
  seats: number;
  /** A mega game's player cap. */
  maxPlayers?: number;
  teamGame: boolean;
  /** The signed-in account already holds a seat (set by the list tool; absent otherwise). */
  joined?: boolean;
  /** Random teams of this size. */
  randomTeamsOf?: number;
  /** The team of each open seat (team games only). */
  openSeatTeams?: number[];
  mapId: number;
  entryFeeCoins: number;
  prizeCoins: number;
  /** Cards in play, when the settings name them. */
  cards?: string[];
  /** The settings flags read from the record, in war.app's wording. */
  rules: string[];
  /** Rules the turn planner does not model yet (only for flags read from the record). */
  plannerGaps: string[];
}

/** What a join needs from a lobby but the list does not show. */
export interface OpenLobby {
  /** The in-game ids of the players holding a seat. */
  seatedPlayerIds: number[];
  /** The GameColor indices the lobby's players hold (declined and removed players included, as the client counts them). */
  colorsTaken: number[];
}

export interface OpenGamesPage {
  games: OpenGame[];
  /** Per game id: its seated players and the colours taken. */
  lobbies: Map<number, OpenLobby>;
  /** "N games are being hidden due to prerequisites", when the page says so. */
  hiddenByPrerequisites?: number;
  /** Why the list is empty or partial. */
  note?: string;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isIntList = (v: unknown): v is number[] => Array.isArray(v) && v.every(isInt);

/** A TimeSpan in ms as war.app shows it: `3d`, `1d12h`, `6h`, `2h30m`, `5m`, `45s`. */
export function formatDuration(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor(ms / 3_600_000) % 24;
  const mins = Math.floor(ms / 60_000) % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 5) return `${hours}h`;
  if (hours > 0) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  if (mins > 0) return `${mins}m`;
  return `${Math.floor(ms / 1000) % 60}s`;
}

const pct = (rate: number) => Math.round(rate * 100);

interface SettingsRead {
  rules: string[];
  gaps: string[];
  cards?: string[];
}

/** The settings string `<ver>;<f|r>;<card ids>;<p|b>;<o|p>;<m|n>`: cards and mods. */
function settingsString(s: string): { cards: number[]; mods: boolean } | undefined {
  const parts = s.split(';');
  if (!['1', '2', '3'].includes(parts[0] ?? '')) return undefined;
  const cards = (parts[2] ?? '')
    .split(',')
    .filter((c) => c.trim() !== '')
    .map(Number)
    .filter((n) => Number.isInteger(n));
  return { cards, mods: parts[0] === '3' && parts[5] === 'm' };
}

/** The flags a GameInfoSettings record carries; `undefined` when it is not one. */
function readSettings(v: unknown): SettingsRead | undefined {
  if (!isObj(v) || v.$type !== GAME_INFO_SETTINGS) return undefined;
  const f = fields(v);
  if (f.length < GS_MIN_FIELDS) return undefined;
  const rules: string[] = [];
  const gaps: string[] = [];
  let cards: string[] | undefined;
  const bool = (k: keyof typeof GS) => f[GS[k]] === true;

  const dist = f[GS.distribution];
  const scenario = isInt(dist) && dist === DIST_CUSTOM_SCENARIO;
  if (scenario) {
    rules.push('Custom scenario');
    gaps.push('Custom scenario');
  } else if (isBool(f[GS.autoDist])) {
    rules.push(f[GS.autoDist] ? 'Automatic distribution' : 'Manual distribution');
  }
  if (bool('commanders')) {
    rules.push('Commanders');
    gaps.push('Commanders');
  }
  const ss = typeof f[GS.settingsString] === 'string' ? settingsString(f[GS.settingsString] as string) : undefined;
  if (ss?.cards.length) {
    cards = ss.cards.map(cardTypeName);
    rules.push(`Cards: ${cards.join(', ')}`);
  }
  const commerce = f[GS.commerce];
  if (isInt(commerce)) {
    rules.push(`Commerce (${commerce === 0 ? 'no army multiplier' : `army multiplier of ${commerce}`})`);
    gaps.push('Commerce');
  }
  const banking = f[GS.bankingBoot];
  if (isNum(banking) && banking > 0 && banking < NEVER_MS) rules.push(`Start with ${formatDuration(banking)} banked`);
  const waste = f[GS.wastelands];
  if (isInt(waste) && waste > 0 && !scenario) rules.push('Wastelands');
  if (bool('oneArmyStandsGuard')) rules.push('One army must stand guard');
  const luck = f[GS.luck];
  const lucky = isNum(luck) && luck !== 0;
  if (lucky) rules.push(`Luck modifier ${pct(luck)}%`);
  const rounding = f[GS.roundingMode];
  const oddRounding = isInt(rounding) && rounding !== DEFAULT_ROUNDING;
  if (oddRounding) rules.push(`Non-default rounding mode (${rounding})`);
  if (lucky || oddRounding) {
    gaps.push('Luck or rounding — attacks are chances: sized for 95% with luck on (certain otherwise), holds for at most a 5% fall');
  }
  if (f[GS.ranked] === false) rules.push('Practice game');
  const minArmies = f[GS.minArmies];
  if (isInt(minArmies) && minArmies !== DEFAULT_MIN_ARMIES) rules.push(`Minimum armies per turn is ${minArmies}`);
  const per = f[GS.bonusArmiesPer];
  if (isInt(per) && per > 0) {
    // Modelled since #38 (docs/WARAPP-API.md "Income"): a rule, not a gap.
    rules.push(`Extra army for every ${per} ${per === 1 ? 'territory' : 'territories'}`);
  }
  if (bool('overriddenBonuses')) rules.push('Overridden bonuses');
  if (bool('attackOnly') || bool('transferOnly')) {
    rules.push(
      bool('attackOnly') && bool('transferOnly')
        ? 'Can attack-only and transfer-only'
        : bool('attackOnly')
          ? 'Can attack-only'
          : 'Can transfer-only',
    );
  }
  if (ss?.mods) {
    rules.push('Mods');
    gaps.push('Mods');
  }
  // Modelled since #29 (the planner's Local Deployment pools): a rule, not a gap.
  if (bool('localDeployments')) rules.push('Local deployments');
  if (bool('noSplit')) rules.push('No-split mode');
  const cap = f[GS.armyCap];
  if (isNum(cap)) {
    rules.push(`Army cap: ${cap}× income`);
    gaps.push('Army cap');
  }
  const off = f[GS.offensiveKillRate];
  const def = f[GS.defensiveKillRate];
  if (isNum(off) && isNum(def) && (pct(off) !== pct(DEFAULT_OFFENSIVE) || pct(def) !== pct(DEFAULT_DEFENSIVE))) {
    // Modelled since #28 (every capture is sized at the game's rates): a rule, not a gap.
    rules.push(`Kill rates: offensive ${pct(off)}%, defensive ${pct(def)}%`);
  }
  if (bool('multiAttack')) rules.push('Multi-attack');
  if (f[GS.moveOrder] === MOVE_ORDER_NO_LUCK_CYCLE) {
    rules.push('Speed first turn (No-luck cycle move order)');
    gaps.push('Speed first turn — the board stays hidden until Begin (warapp_begin_turn), and whoever orders fastest moves first');
  }
  return { rules, gaps, ...(cards ? { cards } : {}) };
}

interface LobbyPlayer {
  id: number;
  team: number;
  seated: boolean;
  /** An invitation not yet accepted: no seat yet, but one is kept for them. */
  invited: boolean;
  /** The GameColor index, or null when the player has none. */
  color: number | null;
}

/** One GameInfoPlayer record, or `undefined` when it does not fit. */
function lobbyPlayer(p: unknown): LobbyPlayer | undefined {
  if (!isObj(p) || p.$type !== GAME_INFO_PLAYER) return undefined;
  const f = fields(p);
  const id = f[GP.id];
  const state = f[GP.state];
  const team = f[GP.team];
  const color = colorIndexOf(f[GP.color]);
  if (f.length < GP_MIN_FIELDS || !isInt(id) || !isInt(state) || !isInt(team)) return undefined;
  const name = playerStateName(state);
  return { id, team, seated: holdsSeat(name), invited: name === 'Invited', color: color ?? null };
}

/** One decoded GameInfo as an open game; `undefined` when the record does not fit. */
export function openGameOf(record: unknown): OpenGame | undefined {
  return readOpenGame(record)?.game;
}

function readOpenGame(record: unknown): { game: OpenGame; lobby: OpenLobby } | undefined {
  if (!isObj(record) || record.$type !== GAME_INFO) return undefined;
  const f = fields(record);
  if (f.length < GI_MIN_FIELDS) return undefined;
  const id = f[GI.gameId];
  const name = f[GI.name];
  const mapId = f[GI.mapId];
  const realTime = f[GI.realTime];
  const seats = f[GI.openSeats];
  const players = f[GI.players];
  if (!isInt(id) || !(name === null || typeof name === 'string') || !isInt(mapId) || !isBool(realTime)) return undefined;
  if (!(seats === null || isIntList(seats)) || !(players === null || Array.isArray(players))) return undefined;

  const openSeatTeams = seats ?? [];
  const all = (players ?? []).map(lobbyPlayer).filter((p): p is LobbyPlayer => p !== undefined);
  const seated = all.filter((p) => p.seated);
  const invited = all.filter((p) => p.invited).length;
  const randomTeamsOf = f[GI.randomTeamsOf];
  const random = isInt(randomTeamsOf) && randomTeamsOf > 0 ? randomTeamsOf : undefined;
  // The client's own test (its "Team Game" settings icon): random teams, or any player
  // record — whatever its state — or open seat carrying a team.
  const teamGame = random !== undefined || all.some((p) => carriesTeam(p.team)) || openSeatTeams.some(carriesTeam);
  const settings = readSettings(f[GI.settings]);
  const rules = [...(settings?.rules ?? [])];
  if (teamGame) rules.push(random !== undefined ? `Team game (random teams of ${random})` : 'Team game');

  const game: OpenGame = {
    id,
    name: name ?? '',
    url: `https://war.app/MultiPlayer?GameID=${id}`,
    pace: realTime ? 'real-time' : 'multi-day',
    players: seated.length,
    openSeats: openSeatTeams.length,
    seats: seated.length + invited + openSeatTeams.length,
    teamGame,
    mapId,
    entryFeeCoins: isInt(f[GI.entryFee]) ? (f[GI.entryFee] as number) : 0,
    prizeCoins: isInt(f[GI.prize]) ? (f[GI.prize] as number) : 0,
    rules,
    plannerGaps: settings?.gaps ?? [],
  };
  const boot = f[GI.bootTime];
  if (isNum(boot) && boot > 0 && boot < NEVER_MS) {
    game.bootTime = formatDuration(boot);
    game.bootTimeMinutes = Math.round(boot / 60_000);
  }
  const max = f[GI.maxPlayers];
  if (isInt(max) && max > 0) game.maxPlayers = max;
  if (random !== undefined) game.randomTeamsOf = random;
  if (teamGame) game.openSeatTeams = openSeatTeams;
  if (settings?.cards) game.cards = settings.cards;
  const colorsTaken = [...new Set(all.map((p) => p.color).filter((c): c is number => c !== null))];
  return { game: orderKeys(game), lobby: { seatedPlayerIds: seated.map((p) => p.id), colorsTaken } };
}

/** `games` with `joined: true` on each lobby where the in-game id `me` holds a seat. */
export function markJoined(games: readonly OpenGame[], lobbies: ReadonlyMap<number, OpenLobby>, me: number): OpenGame[] {
  return games.map((g) => (lobbies.get(g.id)?.seatedPlayerIds.includes(me) ? orderKeys({ ...g, joined: true }) : g));
}

const KEY_ORDER: Array<keyof OpenGame> = [
  'id', 'name', 'url', 'pace', 'bootTime', 'bootTimeMinutes', 'players', 'openSeats', 'seats', 'maxPlayers',
  'teamGame', 'joined', 'randomTeamsOf', 'openSeatTeams', 'mapId', 'entryFeeCoins', 'prizeCoins', 'cards', 'rules', 'plannerGaps',
];
function orderKeys(g: OpenGame): OpenGame {
  const out: Record<string, unknown> = {};
  for (const k of KEY_ORDER) if (g[k] !== undefined) out[k] = g[k];
  return out as unknown as OpenGame;
}

const PAYLOAD_RE = /<script\b[^>]*\bid=["']AllOpenGamesData["'][^>]*>([\s\S]*?)<\/script>/i;
const HIDDEN_RE = /(\d+)\s+games?\s+(?:is|are)\s+being\s+hidden\s+due\s+to\s+prerequisites/i;

function hexBytes(hex: string): Uint8Array | undefined {
  const h = hex.replace(/\s+/g, '');
  if (h.length === 0 || h.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(h)) return undefined;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const UNREADABLE = "war.app's open-games data could not be read (the client may have changed).";

/** The open games a signed-in OpenGames page lists; never throws. */
export function parseOpenGamesPage(html: string, bundle: ClassReader): OpenGamesPage {
  const out: OpenGamesPage = { games: [], lobbies: new Map() };
  const hidden = HIDDEN_RE.exec(html);
  if (hidden) out.hiddenByPrerequisites = Number(hidden[1]);
  const m = PAYLOAD_RE.exec(html);
  if (!m) {
    out.note = 'The OpenGames page had no open-games data — war.app may have signed this session out.';
    return out;
  }
  const bytes = hexBytes(m[1] ?? '');
  if (!bytes) {
    out.note = UNREADABLE;
    return out;
  }
  const reader = new Reader(bytes);
  let count: number;
  try {
    count = reader.int32();
  } catch {
    out.note = UNREADABLE;
    return out;
  }
  if (count < 0 || count > MAX_OPEN_GAMES) {
    out.note = UNREADABLE;
    return out;
  }
  let read = 0;
  // One step budget for the whole payload, so the reader's CPU is bounded per page, not per record.
  const budget: ReadBudget = { spent: 0 };
  try {
    for (; read < count; read++) {
      const before = reader.position;
      const record = bundle.readClass(GAME_INFO, reader, budget);
      // A GameInfo always takes bytes; one that takes none means the rest would repeat it endlessly.
      if (reader.position === before) throw new Error('a GameInfo record took no bytes');
      const read = readOpenGame(record);
      if (read) {
        out.games.push(read.game);
        out.lobbies.set(read.game.id, read.lobby);
      }
    }
  } catch (e) {
    // Records are back to back with no lengths: after a failed one the rest cannot be found.
    out.note = `${UNREADABLE} Read ${read} of ${count} games before: ${e instanceof Error ? e.message : String(e)}`;
  }
  return out;
}

export interface OpenGameFilters {
  /** Default `multi-day`. */
  pace?: Pace | 'both';
  /** At most this many seats (players + open seats, or a mega game's cap). */
  max_players?: number;
  /** Only games without an entry fee (default true). */
  free_only?: boolean;
  /** Leave out team games (default true). */
  exclude_teams?: boolean;
  limit?: number;
}

/** The games matching `filters`, in war.app's order. */
export function filterOpenGames(games: readonly OpenGame[], filters: OpenGameFilters): OpenGame[] {
  const pace = filters.pace ?? 'multi-day';
  const freeOnly = filters.free_only ?? true;
  const noTeams = filters.exclude_teams ?? true;
  const out = games.filter(
    (g) =>
      (pace === 'both' || g.pace === pace) &&
      (!freeOnly || g.entryFeeCoins === 0) &&
      (!noTeams || !g.teamGame) &&
      (filters.max_players === undefined || (g.maxPlayers ?? g.seats) <= filters.max_players),
  );
  return filters.limit === undefined ? out : out.slice(0, filters.limit);
}

/** The join preview's neutral-cost screen (#132), from a lobby's GameFeed settings. */
export interface JoinScreen {
  /** The smaller of the two neutral sizes the settings name (outside and inside the distribution). */
  cheapestNeutral: number;
  /** Armies to take it at the game's kill rates (no luck margin); null when attackers cannot kill. */
  armiesToTake: number | null;
  baseIncome: number;
  /** armiesToTake / baseIncome, one decimal; null when it cannot be taken. */
  turnsOfBaseIncome: number | null;
  /** The cheapest neutral costs no more than one turn of base income. */
  passes: boolean;
}

/**
 * What a lobby's GameFeed settings add to the join preview, which the open-games record does
 * not carry (#132): the neutral-cost screen — a game whose cheapest neutral costs more than a
 * turn of base income expands slowly, and live one cost five turns of income — and Light Fog.
 * Pure; `screen` is absent when the settings name no neutral size.
 */
export function feedScreen(s: GameSettings): { screen?: JoinScreen; gaps: string[] } {
  const gaps: string[] = [];
  let screen: JoinScreen | undefined;
  const sizes = [s.initialNonDistributionArmies, s.initialNeutralsInDistribution].filter(
    (n): n is number => n !== undefined && Number.isFinite(n) && n >= 0,
  );
  if (sizes.length) {
    const cheapest = Math.min(...sizes);
    const base = s.minimumArmyBonus ?? DEFAULT_BASE_INCOME;
    const armies = armiesToTake(cheapest, {
      ...(s.offensiveKillRate !== undefined ? { offensiveKillRate: s.offensiveKillRate } : {}),
      ...(s.defensiveKillRate !== undefined ? { defensiveKillRate: s.defensiveKillRate } : {}),
    });
    const turns = armies === null || base <= 0 ? null : Math.round((armies / base) * 10) / 10;
    const passes = armies !== null && armies <= base;
    screen = { cheapestNeutral: cheapest, armiesToTake: armies, baseIncome: base, turnsOfBaseIncome: turns, passes };
    if (!passes) {
      gaps.push(
        armies === null
          ? `Costly neutrals — at these kill rates the cheapest (${cheapest}) cannot be taken`
          : `Costly neutrals — the cheapest (${cheapest}) takes ${armies} armies, ${turns ?? '∞'} turns of base income (${base}): expansion is slow`,
      );
    }
  }
  if (s.fog === 'LightFog') {
    gaps.push('Light Fog — owners show everywhere but armies only near you; the planner counts every unseen stack as unknown');
  }
  return { ...(screen ? { screen } : {}), gaps };
}

/** The owner's joining policy (#134): at most this many seats (1v1 preferred). */
export const POLICY_MAX_SEATS = 4;
/** …and a boot time of at least a day. */
export const POLICY_MIN_BOOT_MINUTES = 24 * 60;

/** Whether a lobby keeps the joining policy. Advisory: nothing is refused for it. */
export interface JoinPolicy {
  /** true: keeps it; false: breaks it; null: nothing broke, but part of it could not be checked. */
  passes: boolean | null;
  /** Each rule the lobby breaks, in policy order. */
  breaks: string[];
  /** What could not be checked (the neutral cost needs the lobby's GameFeed settings). */
  unchecked?: string[];
}

/**
 * The owner's joining policy (#134), checked against an open game and, when GameFeed could read
 * the lobby, its neutral-cost screen: no Commerce, mods or custom scenarios; the cheapest neutral
 * costs at most one turn of base income; at most four seats; a boot time of at least a day (no
 * boot time — war.app's "never" — keeps it). Lobbies are not counted against the game cap. Pure.
 */
export function joiningPolicy(game: OpenGame, screen?: JoinScreen | null): JoinPolicy {
  const breaks: string[] = [];
  if (game.rules.some((r) => r.startsWith('Commerce'))) breaks.push('Commerce — the policy joins no Commerce games');
  if (game.rules.includes('Mods')) breaks.push('Mods — the policy joins no mod games');
  if (game.rules.includes('Custom scenario')) breaks.push('Custom scenario — the policy joins no custom scenarios');
  if (screen && !screen.passes) {
    breaks.push(
      screen.armiesToTake === null
        ? 'Costly neutrals — the cheapest cannot be taken at these kill rates; the policy is at most one turn of base income'
        : `Costly neutrals — the cheapest takes ${screen.armiesToTake} armies, ${screen.turnsOfBaseIncome ?? '∞'} turns of base income; the policy is at most one turn`,
    );
  }
  const seats = game.maxPlayers ?? game.seats;
  if (seats > POLICY_MAX_SEATS) breaks.push(`${seats} seats — the policy is 1v1 or at most four players`);
  if (game.bootTimeMinutes !== undefined && game.bootTimeMinutes < POLICY_MIN_BOOT_MINUTES) {
    breaks.push(`Boot time ${game.bootTime} — the policy wants at least a day`);
  }
  if (breaks.length) return { passes: false, breaks };
  return screen ? { passes: true, breaks } : { passes: null, breaks, unchecked: ["the cheapest neutral's cost"] };
}
