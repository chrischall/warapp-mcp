// My games: a GetMyGames reply, decoded by the client bundle's own readers,
// turned into a per-game summary that says which games are waiting on me.
//
// Field names in the bundle are minified and change between releases, so
// nothing here keys on them. Classes are found by their stable registered type
// name (`$type`) and fields by read order, as observed through the bridge
// (docs/PLAN-SCOUT.md, GetMyGames). The positions used are checked for their
// type, so a reordered layout is an error rather than a silently wrong list.

import { McpToolError } from '@chrischall/mcp-utils';
import type { ClassReader } from './live.js';
import type { Reader } from './protocol/codec.js';
import { playerStateName } from './player-states.js';
import { fields, isObj } from './protocol/decoded.js';

export const MY_GAMES_RETURN = 'warlight.shared.MyGamesReturn';
export const GAME_INFO = 'warlight.shared.GameInfo';
export const GAME_INFO_PLAYER = 'warlight.shared.GameInfoPlayer';

/** GameState. */
export const GAME_STATE_NAMES: Readonly<Record<number, string>> = {
  2: 'WaitingForPlayers',
  3: 'Playing',
  4: 'Finished',
  5: 'DistributingTerritories',
};
const GAME_PLAYING = 3;
const GAME_DISTRIBUTING = 5;

const PLAYER_PLAYING = 2;

/** GameInfo field positions in read order. */
const GI = { gameId: 7, name: 13, lastTurn: 14, players: 16, state: 22 } as const;
const GI_MIN_FIELDS = 23;
/** GameInfoPlayer field positions in read order. */
const GP = { committed: 2, name: 5, id: 6, state: 7 } as const;
const GP_MIN_FIELDS = 8;

/** One game as GetMyGames has it (codes not yet named). */
export interface RawMyGame {
  id: number;
  name: string;
  /** -1 before turn 1. */
  lastTurn: number;
  stateCode: number;
  players: Array<{ id: number; name: string; stateCode: number; committed: boolean }>;
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
  const committed = f[GP.committed];
  const name = f[GP.name];
  const id = f[GP.id];
  const state = f[GP.state];
  if (f.length < GP_MIN_FIELDS || typeof committed !== 'boolean' || !isStr(name) || !isInt(id) || !isInt(state)) {
    throw new MyGamesFormatError('a GameInfoPlayer lacks its fields');
  }
  return { id, name: name ?? '', stateCode: state, committed };
}

function gameOf(g: unknown): RawMyGame {
  if (!isObj(g) || g.$type !== GAME_INFO) throw new MyGamesFormatError('a game is not a GameInfo');
  const f = fields(g);
  const id = f[GI.gameId];
  const name = f[GI.name];
  const lastTurn = f[GI.lastTurn];
  const players = f[GI.players];
  const state = f[GI.state];
  if (
    f.length < GI_MIN_FIELDS ||
    !isInt(id) ||
    !isStr(name) ||
    !isInt(lastTurn) ||
    !(players === null || Array.isArray(players)) ||
    !isInt(state)
  ) {
    throw new MyGamesFormatError('a GameInfo lacks its fields');
  }
  return {
    id,
    name: name ?? '',
    lastTurn,
    stateCode: state,
    players: (players ?? []).filter((p) => p !== null).map(playerOf),
  };
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

/**
 * Name the codes and decide which games wait on me (`myInGameId`): the game is
 * being played or distributing territories, my player is Playing, and I have
 * not committed. Games waiting on me come first; otherwise war.app's order.
 */
export function summarizeMyGames(games: readonly RawMyGame[], myInGameId: number): MyGame[] {
  const out = games.map((g): MyGame => {
    const me = g.players.find((p) => p.id === myInGameId);
    const active = g.stateCode === GAME_PLAYING || g.stateCode === GAME_DISTRIBUTING;
    return {
      id: g.id,
      name: g.name,
      state: GAME_STATE_NAMES[g.stateCode] ?? String(g.stateCode),
      turn: g.lastTurn < 0 ? null : g.lastTurn + 1,
      waitingOnYou: active && me !== undefined && me.stateCode === PLAYER_PLAYING && !me.committed,
      players: g.players.map((p) => ({
        name: p.name,
        state: playerStateName(p.stateCode),
        committed: p.committed,
      })),
    };
  });
  return [...out.filter((g) => g.waitingOnYou), ...out.filter((g) => !g.waitingOnYou)];
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

/** The longest line `view: 'brief'` answers (the context-groups contract). */
export const BRIEF_MAX = 120;

/**
 * One brief line, `name — <turn N | state> — waiting on you | waiting on others`,
 * at most {@link BRIEF_MAX} characters: the name (another player's text) is
 * flattened to one line and shortened first; a name starting `-- ` or `\` gets
 * one leading `\` so it can never read as a note line.
 */
export function briefGameLine(game: MyGame): string {
  const where = game.state === 'Playing' && game.turn !== null ? `turn ${game.turn}` : game.state;
  const tail = ` — ${where} — ${game.waitingOnYou ? 'waiting on you' : 'waiting on others'}`;
  const flat = game.name.replace(/\s+/g, ' ').trim() || '(untitled)';
  const escaped = flat.startsWith('-- ') || flat.startsWith('\\') ? `\\${flat}` : flat;
  const room = BRIEF_MAX - tail.length;
  const shown = escaped.length > room ? `${escaped.slice(0, room - 1).trimEnd()}…` : escaped;
  return `${shown}${tail}`;
}
