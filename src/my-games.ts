// My games: a GetMyGames reply, decoded by the client bundle's own readers,
// turned into a per-game summary that says which games are waiting on me.
//
// Field names in the bundle are minified and change between releases, so
// nothing here keys on them. Classes are found by their stable registered type
// name (`$type`) and fields by read order, as observed through the bridge
// (docs/PLAN-SCOUT.md, GetMyGames). Each record must have exactly its known
// field count and the positions used are checked for their type, so a field
// inserted, dropped or reordered is an error rather than a silently wrong list.

import { McpToolError } from '@chrischall/mcp-utils';
import type { ClassReader } from './live.js';
import type { Reader } from './protocol/codec.js';
import { playerStateName } from './player-states.js';
import { fields, isObj } from './protocol/decoded.js';
import { carriesTeam } from './teams.js';
import type { ChatChannel } from './chat.js';

export const MY_GAMES_RETURN = 'warlight.shared.MyGamesReturn';
export const GAME_INFO = 'warlight.shared.GameInfo';
export const GAME_INFO_PLAYER = 'warlight.shared.GameInfoPlayer';

/** GameState: the web client's codes, named as GameFeed names them. */
export const GAME_STATE_NAMES: Readonly<Record<number, string>> = {
  2: 'WaitingForPlayers',
  3: 'Playing',
  4: 'Finished',
  5: 'DistributingTerritories',
};
/** A GameState code's name; the code itself when it has none. */
export const gameStateName = (code: number): string => GAME_STATE_NAMES[code] ?? String(code);

const GAME_WAITING = 2;
const GAME_PLAYING = 3;
const GAME_DISTRIBUTING = 5;
export const GAME_FINISHED = 4;

const PLAYER_PLAYING = 2;

/** GameInfo field positions in read order, and its whole field count (src/open-games.ts reads the same record). */
const GI = { gameId: 7, name: 13, lastTurn: 14, players: 16, state: 22 } as const;
/**
 * GameInfo's four "unread … messages" flags (#311, docs/WEB-PROTOCOL.md "Marking a game's chat read"): read from
 * the client bundle, UNVERIFIED live. The read-back for RegisterChatView.
 */
const GI_UNREAD = { group: 8, private: 17, public: 18, team: 23 } as const;
/** GameInfo's boot-clock fields (pace; read from the bundle's GameInfo reader and game-list renderer). */
const GI_BOOT = { boot: 5, realTime: 19, banked: 24, turnFor: 26 } as const;
/** The TimeSpan maximum (war.app's "never"), as a decoded number of milliseconds. */
const NEVER_MS = 922_336_666_814_565;
export const GAME_INFO_FIELDS = 27;
/**
 * #523: GameInfo field 20, the client's `SeenEndGameWindow` for my seat (the GameInfo reader's 21st read; GamePlayer
 * names the same minified field `SeenEndGameWindow`). Read from the bundle, UNVERIFIED live: the read-back of
 * warapp_close_finished_game.
 */
const GI_SEEN_END = 20;
/** GameInfoPlayer field positions in read order, and its whole field count. */
const GP = { committed: 2, name: 5, id: 6, state: 7, team: 8 } as const;
export const GAME_INFO_PLAYER_FIELDS = 10;

/** One game as GetMyGames has it (codes not yet named). */
export interface RawMyGame {
  id: number;
  name: string;
  /** -1 before turn 1. */
  lastTurn: number;
  stateCode: number;
  /** `team` only when the player carries one (C1: a fallback for GameFeed's unverified team, V1). */
  players: Array<{ id: number; name: string; stateCode: number; committed: boolean; team?: number }>;
  /** The game's unread-chat flags (#311), only when all four read as booleans: UNVERIFIED live. */
  unreadChat?: UnreadChatFlags;
  /** #523: GameInfo's seen-end-game-window flag, only when it reads `true` (UNVERIFIED live). */
  seenEndGame?: true;
  /** The boot clock (pace), only when its fields read: see {@link BootClock}. */
  boot?: BootClock;
}

/**
 * A game's boot clock from GameInfo, as the web client's game list shows it (read from the bundle: the list's
 * boot label is the boot time plus my banked time, red for a real-time game, and "Your turn for …" is the time
 * my turn has run). TimeSpans in milliseconds. Fields VERIFIED from the bundle's reader and list renderer; the
 * arithmetic (time left = boot + bank − time my turn has run) is UNVERIFIED live.
 */
export interface BootClock {
  /** Field 5: the game's boot time (`DirectBoot`); 0 or the TimeSpan maximum when the game has none. */
  bootMs: number;
  /** Field 24: my banked boot time (banking boot times; 0 without). */
  bankedMs: number;
  /** Field 26: how long my turn has run (the client's "Your turn for"). */
  turnForMs: number;
  /** Field 19: a real-time game. */
  realTime: boolean;
}

/** Which of a game's chats war.app counts unread for the account (GameInfo, #311; UNVERIFIED live). */
export interface UnreadChatFlags {
  /** Game-group messages (this server's `unknown` channel from the web client). */
  group: boolean;
  private: boolean;
  public: boolean;
  team: boolean;
}

/**
 * A game's unread chat as warapp_my_games reports it: war.app's flags per channel (booleans, not counts: the list
 * carries no count) and `toMe`, the private flag — a private conversation in my list is one I am in and my own
 * messages are never unread to me, so unread private chat is addressed to me. UNVERIFIED live, like the flags.
 */
export interface UnreadChatView extends UnreadChatFlags {
  toMe: boolean;
}

/** The view of the flags, or null when they did not read. */
export const unreadChatView = (f: UnreadChatFlags | undefined): UnreadChatView | null =>
  f ? { public: f.public, team: f.team, private: f.private, group: f.group, toMe: f.private } : null;

/** The flag each chat channel's unread state shows in (the web client's `unknown` is the game groups). */
export const CHANNEL_FLAG: Readonly<Record<ChatChannel, keyof UnreadChatFlags>> = {
  public: 'public',
  team: 'team',
  private: 'private',
  unknown: 'group',
};

/** Whether any of the flags is set. */
export const anyUnreadChat = (f: UnreadChatFlags | undefined): boolean =>
  f !== undefined && (f.group || f.private || f.public || f.team);

/** The game's unread-chat flags in the list, or undefined (not listed, or the flags did not read). */
export function unreadChatOf(games: readonly RawMyGame[], gameId: number): UnreadChatFlags | undefined {
  return games.find((g) => g.id === gameId)?.unreadChat;
}

/** The flags, read loosely: a field that is not a boolean leaves them all unknown, never refuses the list. */
function unreadFlagsOf(f: readonly unknown[]): UnreadChatFlags | undefined {
  const group = f[GI_UNREAD.group];
  const priv = f[GI_UNREAD.private];
  const pub = f[GI_UNREAD.public];
  const team = f[GI_UNREAD.team];
  if (typeof group !== 'boolean' || typeof priv !== 'boolean' || typeof pub !== 'boolean' || typeof team !== 'boolean') return undefined;
  return { group, private: priv, public: pub, team };
}

/** One game as the tool reports it. */
export interface MyGame {
  id: number;
  name: string;
  state: string;
  /** lastTurn + 1, or null before turn 1. */
  turn: number | null;
  waitingOnYou: boolean;
  players: Array<{ name: string; state: string; committed: boolean }>;
  /** The game list's unread-chat flags (null when they did not read); see {@link UnreadChatView}. */
  unreadChat?: UnreadChatView | null;
  /** Pace: a multi-day game being played or picked with my seat playing — its boot clock ({@link bootView}). */
  boot?: BootView;
}

/** The GetMyGames reply arrived in a shape this server does not understand. */
export class MyGamesFormatError extends McpToolError {
  constructor(detail: string) {
    super(`war.app's game list arrived in an unexpected shape (${detail}).`, {
      kind: 'unknown',
      hint: 'The war.app client may have changed. warapp_get_game still reads a game by id.',
    });
    this.name = 'MyGamesFormatError';
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isStr = (v: unknown): v is string | null => v === null || typeof v === 'string';

function playerOf(p: unknown): RawMyGame['players'][number] {
  if (!isObj(p) || p.$type !== GAME_INFO_PLAYER) throw new MyGamesFormatError('a player is not a GameInfoPlayer');
  const f = fields(p);
  if (f.length !== GAME_INFO_PLAYER_FIELDS) {
    throw new MyGamesFormatError(`a GameInfoPlayer has ${f.length} fields, not ${GAME_INFO_PLAYER_FIELDS}`);
  }
  const committed = f[GP.committed];
  const name = f[GP.name];
  const id = f[GP.id];
  const state = f[GP.state];
  if (typeof committed !== 'boolean' || !isStr(name) || !isInt(id) || !isInt(state)) {
    throw new MyGamesFormatError('a GameInfoPlayer lacks its fields');
  }
  // The team is read loosely: it is a fallback for GameFeed's (C1), so a value that is not a number is left out
  // rather than refusing the whole list.
  const team = f[GP.team];
  return { id, name: name ?? '', stateCode: state, committed, ...(isInt(team) && carriesTeam(team) ? { team } : {}) };
}

/**
 * The teams GetMyGames gives a game's players, by in-game id (C1, docs/PLAN-TEAMS.md): what a tool falls back on
 * when GameFeed sends no team (V1). Empty when the game is not in the list or no player carries a team.
 */
export function myGamesTeams(games: readonly RawMyGame[], gameId: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of games.find((g) => g.id === gameId)?.players ?? []) if (p.team !== undefined) out.set(p.id, p.team);
  return out;
}

function gameOf(g: unknown): RawMyGame {
  if (!isObj(g) || g.$type !== GAME_INFO) throw new MyGamesFormatError('a game is not a GameInfo');
  const f = fields(g);
  if (f.length !== GAME_INFO_FIELDS) throw new MyGamesFormatError(`a GameInfo has ${f.length} fields, not ${GAME_INFO_FIELDS}`);
  const id = f[GI.gameId];
  const name = f[GI.name];
  const lastTurn = f[GI.lastTurn];
  const players = f[GI.players];
  const state = f[GI.state];
  if (
    !isInt(id) ||
    !isStr(name) ||
    !isInt(lastTurn) ||
    !(players === null || Array.isArray(players)) ||
    !isInt(state)
  ) {
    throw new MyGamesFormatError('a GameInfo lacks its fields');
  }
  const unreadChat = unreadFlagsOf(f);
  const boot = bootClockOf(f);
  return {
    id,
    name: name ?? '',
    lastTurn,
    stateCode: state,
    players: (players ?? []).filter((p) => p !== null).map(playerOf),
    ...(unreadChat ? { unreadChat } : {}),
    ...(f[GI_SEEN_END] === true ? { seenEndGame: true as const } : {}),
    ...(boot ? { boot } : {}),
  };
}

/** The boot clock, read loosely: a field that is not what it should be leaves it unknown, never refuses the list. */
function bootClockOf(f: readonly unknown[]): BootClock | undefined {
  const boot = f[GI_BOOT.boot];
  const realTime = f[GI_BOOT.realTime];
  const banked = f[GI_BOOT.banked];
  const turnFor = f[GI_BOOT.turnFor];
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!num(boot) || !num(banked) || !num(turnFor) || typeof realTime !== 'boolean') return undefined;
  return { bootMs: boot, bankedMs: banked, turnForMs: turnFor, realTime };
}

/** Under this many minutes left before a boot, a game is reported as close to one (and `warapp_session_status` warns). */
export const BOOT_WARN_MINUTES = 6 * 60;

/** What a multi-day game's boot clock means for me ({@link bootView}). */
export interface BootView {
  /** The game's boot time, in minutes. */
  bootMinutes: number;
  /** My banked time, in minutes. */
  bankedMinutes: number;
  /** Boot time plus bank: what a turn of mine may take before I can be booted. */
  allowanceMinutes: number;
  /** While the game waits on me: the allowance less the time my turn has run (at least 0); null otherwise. */
  leftMinutes: number | null;
  /** `leftMinutes` under {@link BOOT_WARN_MINUTES}. */
  soon: boolean;
}

export const BOOT_NOTE =
  "From the game list: the game's boot time plus your banked time, less how long your turn has run (the web client " +
  'shows the first two together beside each game). Banked time is eaten once the boot time is spent. The fields are ' +
  "read from war.app's client; the arithmetic is unverified live.";

/** A multi-day game's boot view, or undefined: real-time, no boot time, the clock unread, or not a game I play. */
export function bootView(clock: BootClock | undefined, waitingOnYou: boolean): BootView | undefined {
  if (!clock || clock.realTime || !(clock.bootMs > 0) || clock.bootMs >= NEVER_MS) return undefined;
  const min = (ms: number) => Math.max(0, Math.floor(ms / 60_000));
  const bootMinutes = min(clock.bootMs);
  const bankedMinutes = clock.bankedMs >= NEVER_MS ? 0 : min(clock.bankedMs);
  const allowanceMinutes = bootMinutes + bankedMinutes;
  const leftMinutes = waitingOnYou ? Math.max(0, allowanceMinutes - min(clock.turnForMs)) : null;
  return { bootMinutes, bankedMinutes, allowanceMinutes, leftMinutes, soon: leftMinutes !== null && leftMinutes < BOOT_WARN_MINUTES };
}

/** Minutes as `2d 3h`, `5h 20m` or `45m`. */
export function minutesText(m: number): string {
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  return d ? `${d}d${h ? ` ${h}h` : ''}` : h ? `${h}h${mm ? ` ${mm}m` : ''}` : `${mm}m`;
}

/** Read a GetMyGames result (the body positioned at the result-present flag). */
export function readMyGames(bundle: ClassReader, body: Reader): RawMyGame[] {
  if (!body.bool()) return [];
  const ret = bundle.readClass(MY_GAMES_RETURN, body);
  if (!isObj(ret)) throw new MyGamesFormatError('no MyGamesReturn');
  const list = fields(ret)[0];
  if (list === null) return [];
  if (!Array.isArray(list)) throw new MyGamesFormatError('no game list');
  return list.filter((g) => g !== null).map(gameOf);
}

/** Whether the game has finished. */
export const isFinished = (g: RawMyGame): boolean => g.stateCode === GAME_FINISHED;

/**
 * Name the codes and decide which games wait on me (`myInGameId`): the game is
 * being played or distributing territories, my player is Playing, and I have
 * not committed. Games waiting on me come first; otherwise war.app's order.
 */
export function summarizeMyGames(games: readonly RawMyGame[], myInGameId: number): MyGame[] {
  const out = games.map((g): MyGame => {
    const me = g.players.find((p) => p.id === myInGameId);
    const active = g.stateCode === GAME_PLAYING || g.stateCode === GAME_DISTRIBUTING;
    const waitingOnYou = active && me !== undefined && me.stateCode === PLAYER_PLAYING && !me.committed;
    const boot = active && me?.stateCode === PLAYER_PLAYING ? bootView(g.boot, waitingOnYou) : undefined;
    return {
      id: g.id,
      name: g.name,
      state: gameStateName(g.stateCode),
      turn: g.lastTurn < 0 ? null : g.lastTurn + 1,
      waitingOnYou,
      players: g.players.map((p) => ({
        name: p.name,
        state: playerStateName(p.stateCode),
        committed: p.committed,
      })),
      unreadChat: unreadChatView(g.unreadChat),
      ...(boot ? { boot } : {}),
    };
  });
  // Waiting on me first, then unread private chat, then the rest (war.app's order within each).
  const privateUnread = (g: MyGame) => !g.waitingOnYou && g.unreadChat?.private === true;
  return [
    ...out.filter((g) => g.waitingOnYou),
    ...out.filter(privateUnread),
    ...out.filter((g) => !g.waitingOnYou && !privateUnread(g)),
  ];
}

/**
 * Games I can still take a turn in (`myInGameId`): being played or distributing
 * territories, with my player Playing — committed or not. war.app's order.
 */
export function activeGameIds(games: readonly RawMyGame[], myInGameId: number): number[] {
  return games
    .filter((g) => g.stateCode === GAME_PLAYING || g.stateCode === GAME_DISTRIBUTING)
    .filter((g) => g.players.some((p) => p.id === myInGameId && p.stateCode === PLAYER_PLAYING))
    .map((g) => g.id);
}

/** Games I am playing now: being played or picked with my seat playing (the policy's cap counts these, #423). */
export const attendedGames = (games: readonly RawMyGame[], myInGameId: number): number => activeGameIds(games, myInGameId).length;

/**
 * Games whose chat is live (#256): lobbies, games being picked and games being played — every
 * game in the list but a finished one, whatever my seat's state — plus a finished game whose chat
 * war.app flags unread, or whose flags did not read at all (#311, GameInfo's unread flags: UNVERIFIED
 * live — a misread position must not hide a finished game's chat without a word; `unflaggedFinished`
 * names those). Ascending id order, so a cursor (the last id read) resumes the list even when games
 * join or leave it between calls.
 */
export function chatGameIds(games: readonly RawMyGame[]): number[] {
  return games
    .filter(
      (g) =>
        g.stateCode === GAME_WAITING ||
        g.stateCode === GAME_PLAYING ||
        g.stateCode === GAME_DISTRIBUTING ||
        (g.stateCode === GAME_FINISHED && (g.unreadChat === undefined || anyUnreadChat(g.unreadChat))),
    )
    .map((g) => g.id)
    .sort((a, b) => a - b);
}

/** Finished games whose unread-chat flags did not read (#311): `chatGameIds` keeps them, unjudged. Ascending ids. */
export function unflaggedFinished(games: readonly RawMyGame[]): number[] {
  return games
    .filter((g) => g.stateCode === GAME_FINISHED && g.unreadChat === undefined)
    .map((g) => g.id)
    .sort((a, b) => a - b);
}

/** The longest line `view: 'brief'` answers (the context-groups contract). */
const BRIEF_MAX = 120;

/**
 * One brief line, `name — <turn N | state> — waiting on you | waiting on others`, then ` — unread private`
 * and ` — unread <channels>` from the game list's unread flags (flags, not counts),
 * at most {@link BRIEF_MAX} characters: the name (another player's text) is
 * flattened to one line and shortened first; a name starting `-- ` or `\` gets
 * one leading `\` so it can never read as a note line.
 */
export function briefGameLine(game: MyGame): string {
  const where = game.state === 'Playing' && game.turn !== null ? `turn ${game.turn}` : game.state;
  const u = game.unreadChat;
  const others = u ? (['public', 'team', 'group'] as const).filter((c) => u[c]) : [];
  const unread = (u?.private ? ' — unread private' : '') + (others.length ? ` — unread ${others.join(', ')}` : '');
  const soon = game.boot?.soon && game.boot.leftMinutes !== null ? ` — boot in ${minutesText(game.boot.leftMinutes)}` : '';
  const tail = ` — ${where} — ${game.waitingOnYou ? 'waiting on you' : 'waiting on others'}${soon}${unread}`;
  const flat = game.name.replace(/\s+/g, ' ').trim() || '(untitled)';
  const escaped = flat.startsWith('-- ') || flat.startsWith('\\') ? `\\${flat}` : flat;
  const room = BRIEF_MAX - tail.length;
  const shown = escaped.length > room ? `${escaped.slice(0, room - 1).trimEnd()}…` : escaped;
  return `${shown}${tail}`;
}
