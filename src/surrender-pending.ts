// A pending surrender, read from the game details (#317). Read from the client bundle locally,
// UNVERIFIED live (docs/WEB-PROTOCOL.md, "Accepting a surrender").
//
// GameFeed keeps a player who asked to surrender `Playing`, and neither GetMyGames nor
// LatestGameInfo says anything about it: only the game details do. GameRefresh (40) asked with
// `nonChat` answers `warlight.shared.GameDetailsAndChat`, whose second field is the game
// (`warlight.shared.GameWL`); the game's eighth field is its players, a dict of in-game id →
// `warlight.shared.GamePlayer`. Of a player's 37 fields this reads the AI id, "human turned into
// an AI", the in-game id, who accepted its surrender, its state and the `Surrendered` flag.
//
// The client's player reader first sets a link back to the game being read (only when it is read
// inside one), so a decoded player can carry the game as an extra leading field: such a value is
// left out before the fields are counted. Records are found by registered type name and fields by
// read order, with exact counts, so a field added or moved reads as unknown rather than wrong.
//
// Readers here never throw: a shape this server does not understand is `undefined` (unknown).

import type { ClassReader } from './live.js';
import type { Reader } from './protocol/codec.js';
import { fields, isObj } from './protocol/decoded.js';
import { GAME_DETAILS_AND_CHAT } from './chat.js';
import { playerStateName } from './player-states.js';

export const GAME_WL = 'warlight.shared.GameWL';
export const GAME_PLAYER = 'warlight.shared.GamePlayer';

/** GameWL: its field count and where the players are, in read order. */
export const GAME_WL_FIELDS = 14;
const GW_PLAYERS = 7;
/** GamePlayer: its field count (protocol 243 added an int32 at 31) and the positions read, in read order. */
export const GAME_PLAYER_FIELDS = 37;
const GPL = { aiId: 0, turnedAI: 14, id: 20, accepted: 21, state: 28, surrendered: 29 } as const;


/** One seat as the game details give it. */
export interface DetailsSeat {
  /** The in-game id (the AI id when the seat has no player id). */
  id: number;
  ai: boolean;
  turnedAI: boolean;
  /** GamePlayerState code (2 Playing, 7 SurrenderAccepted, …). */
  state: number;
  /** Asked to surrender, still pending. */
  surrendered: boolean;
  /** In-game ids that accepted this seat's surrender. */
  acceptedBy: number[];
}

/** A surrender waiting for the others to accept it. */
export interface PendingSurrender {
  /** The surrendering player's in-game id. */
  inGameId: number;
  /** Its GameFeed id, when the caller could map it (`null`: not known here). */
  player: number | null;
  /**
   * Whether my acceptance is still owed: `true` when my seat can accept and has not; `false` when I
   * already accepted or my seat cannot accept (not playing, or an AI); `null` when my seat is unknown.
   */
  owedByMe: boolean | null;
}

/** Whether a details seat is still playing (GamePlayerState `Playing`, src/player-states.ts). */
export const seatPlaying = (s: Pick<DetailsSeat, 'state'>): boolean => playerStateName(s.state) === 'Playing';

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const optInt = (v: unknown): v is number | null => v === null || isInt(v);

/** The accepted-by dict (pairs of in-game id and time) as ids; `undefined` when it is not one. */
function acceptedIds(v: unknown): number[] | undefined {
  if (v === null) return [];
  if (!Array.isArray(v)) return undefined;
  const out: number[] = [];
  for (const pair of v) {
    if (!Array.isArray(pair) || pair.length !== 2 || !isInt(pair[0])) return undefined;
    out.push(pair[0]);
  }
  return out;
}

/** One decoded GamePlayer as a seat; `undefined` when a field is not what it should be. */
function seatOf(p: unknown): DetailsSeat | undefined {
  if (!isObj(p) || p.$type !== GAME_PLAYER) return undefined;
  // The link back to the game the reader may set first is not a read field.
  const f = fields(p).filter((v) => !(isObj(v) && v.$type === GAME_WL));
  if (f.length !== GAME_PLAYER_FIELDS) return undefined;
  const aiId = f[GPL.aiId];
  const turnedAI = f[GPL.turnedAI];
  const id = f[GPL.id];
  const state = f[GPL.state];
  const surrendered = f[GPL.surrendered];
  const acceptedBy = acceptedIds(f[GPL.accepted]);
  if (!optInt(aiId) || !optInt(id) || typeof turnedAI !== 'boolean' || !isInt(state) || typeof surrendered !== 'boolean') return undefined;
  if (acceptedBy === undefined) return undefined;
  const seatId = id ?? aiId;
  if (seatId === null) return undefined;
  return { id: seatId, ai: aiId !== null, turnedAI, state, surrendered, acceptedBy };
}

/**
 * The seats of a GameRefresh reply asked with `nonChat` (the body positioned at the result-present
 * flag); `undefined` when there is no result, no game, no players, or a shape this server does not
 * understand. Never throws.
 */
export function readGameDetailsSeats(bundle: ClassReader, body: Reader): DetailsSeat[] | undefined {
  try {
    if (!body.bool()) return undefined;
    const ret = bundle.readClass(GAME_DETAILS_AND_CHAT, body);
    if (!isObj(ret) || ret.$type !== GAME_DETAILS_AND_CHAT) return undefined;
    const game = fields(ret)[1];
    if (!isObj(game) || game.$type !== GAME_WL) return undefined;
    const gf = fields(game);
    if (gf.length !== GAME_WL_FIELDS) return undefined;
    const players = gf[GW_PLAYERS];
    if (!Array.isArray(players)) return undefined;
    const seats: DetailsSeat[] = [];
    for (const pair of players) {
      if (!Array.isArray(pair) || pair.length !== 2) return undefined;
      if (pair[1] === null) continue;
      const seat = seatOf(pair[1]);
      if (!seat) return undefined;
      seats.push(seat);
    }
    return seats.length ? seats : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The surrenders pending in a game, other than my own (`me`: my in-game id, `undefined` when unknown),
 * each with whether my acceptance is owed — the client's own test: the other seat `Playing` with
 * `Surrendered` set, my seat `Playing` and neither an AI nor turned into one, and my id not among
 * those that accepted. `feedIdOf` maps an in-game id to its GameFeed id where the caller knows it.
 * In seat order (war.app's).
 */
export function pendingSurrenders(
  seats: readonly DetailsSeat[],
  me: number | undefined,
  feedIdOf: (inGameId: number) => number | null = () => null,
): PendingSurrender[] {
  const mine = me === undefined ? undefined : seats.find((s) => s.id === me);
  const canAccept = mine !== undefined && seatPlaying(mine) && !mine.ai && !mine.turnedAI;
  return seats
    .filter((s) => s.surrendered && seatPlaying(s) && s.id !== me)
    .map((s) => ({
      inGameId: s.id,
      player: feedIdOf(s.id),
      owedByMe: mine === undefined ? null : canAccept && !s.acceptedBy.includes(me!),
    }));
}

/** Whether any of `pending` waits on my acceptance. */
export const surrenderOwed = (pending: readonly PendingSurrender[] | null | undefined): boolean =>
  (pending ?? []).some((p) => p.owedByMe === true);
