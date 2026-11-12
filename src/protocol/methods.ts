// war.app web-client method ids (the int32 in every frame header) and the
// parameter writers this server uses. The name is also the `m=` query value of
// https://war.app/Services?m=<name>&js=1.

import type { Reader, Writer } from './codec.js';

export const Method = {
  GameRefresh: 39,
  GetLatestGameInfo: 40,
  SendChat: 42,
  GetMapDetails: 73,
  SendOrders: 74,
  SendInProgressOrders: 75,
  SendTerritoryPicks: 76,
  SendInProgressPicks: 77,
  GetTerritoryPicks: 79,
  UnCommit: 80,
  GetTurns: 81,
} as const;

export type MethodName = keyof typeof Method;
export type MethodId = (typeof Method)[MethodName];

const NAMES = new Map<number, MethodName>(
  (Object.entries(Method) as Array<[MethodName, number]>).map(([name, id]) => [id, name]),
);

/** The method's name for a known id, or undefined. */
export function methodName(id: number): MethodName | undefined {
  return NAMES.get(id);
}

/** GetMapDetails(mapId) — takes no auth block. */
export function writeGetMapDetailsParams(w: Writer, mapId: number): void {
  w.int32(mapId);
}

/** GetTerritoryPicks(auth, gameId, playerId) — the parameters after the auth block. */
export function writeGetTerritoryPicksParams(w: Writer, gameId: number, playerId: number): void {
  w.int32(gameId).int32(playerId);
}

/** GetLatestGameInfo(auth, gameId) — the parameters after the auth block. */
export function writeGetLatestGameInfoParams(w: Writer, gameId: number): void {
  w.int32(gameId);
}

/**
 * SendTerritoryPicks(auth, gameId, picks) — verified through the bridge: the
 * game id, a present int list of territory ids in priority order, then two
 * bools the client sends as false.
 */
export function writeSendTerritoryPicksParams(w: Writer, gameId: number, territoryIds: readonly number[]): void {
  w.int32(gameId)
    .bool(true)
    .list(territoryIds, (ww, id) => ww.int32(id))
    .bool(false)
    .bool(false);
}

/**
 * A GetTerritoryPicks result: the result-present flag, then an int32-count list
 * of territory ids in priority order. Absent or null is "no picks".
 */
export function readTerritoryPicks(body: Reader): number[] {
  if (!body.bool()) return [];
  return body.list((r) => r.int32()) ?? [];
}

/** SendChat channel for the whole game (any other value is a team channel). */
export const CHAT_CHANNEL_PUBLIC = -1;

export interface SendChatParams {
  gameId: number;
  text: string;
  /** Team channel; default {@link CHAT_CHANNEL_PUBLIC}. */
  channel?: number;
  /** In-game player id of a private recipient. */
  recipient?: number;
}

/**
 * SendChat(auth, …) per docs/WEB-PROTOCOL.md (read from the client's
 * serializer; the owner verifies it live): game id, text, channel, optional
 * private recipient, optional game-group id (absent), two marker strings
 * (absent), two optional "last seen" dicts (absent). An optional int32 is a
 * present flag then the value.
 */
export function writeSendChatParams(w: Writer, p: SendChatParams): void {
  w.int32(p.gameId).string(p.text).int32(p.channel ?? CHAT_CHANNEL_PUBLIC);
  if (p.recipient === undefined) w.bool(false);
  else w.bool(true).int32(p.recipient);
  w.bool(false) // game-group id
    .string(null)
    .string(null)
    .bool(false)
    .bool(false);
}

// ---------------------------------------------------------------------------
// Orders (SendOrders, method 74).
//
// UNVERIFIED: these encoders follow a reading of the client bundle and have not
// been checked against a live turn capture. Nothing may send them until one has.

/** AttackTransfer mode byte. */
export const AttackTransferMode = { Attack: 1, Transfer: 2, AttackTransfer: 3 } as const;
export type AttackTransferMode = (typeof AttackTransferMode)[keyof typeof AttackTransferMode];

const ORDER_TAG_ATTACK_TRANSFER = 1;
const ORDER_TAG_DEPLOY = 2;

function writeOrderBase(w: Writer, playerId: number): void {
  // playerId, no result, no standing updates
  w.int32(playerId).bool(false).bool(false);
}

export interface DeployOrder {
  playerId: number;
  territoryId: number;
  armies: number;
  /** Unknown-purpose flag the client writes after the territory (false in observed use). */
  flag?: boolean;
}

/** @unverified Encode a Deploy order. */
export function writeDeployOrder(w: Writer, o: DeployOrder): void {
  w.u8(ORDER_TAG_DEPLOY)
    .int32(o.territoryId)
    .bool(o.flag ?? false)
    .int32(o.armies);
  writeOrderBase(w, o.playerId);
}

export interface AttackTransferOrder {
  playerId: number;
  from: number;
  to: number;
  armies: number;
  mode?: AttackTransferMode;
  byPercent?: boolean;
  attackTeammates?: boolean;
}

/** @unverified Encode an AttackTransfer order. */
export function writeAttackTransferOrder(w: Writer, o: AttackTransferOrder): void {
  w.u8(ORDER_TAG_ATTACK_TRANSFER)
    .bool(o.attackTeammates ?? false)
    .u8(o.mode ?? AttackTransferMode.AttackTransfer)
    .bool(o.byPercent ?? false)
    .int32(o.from)
    // Armies: not fogged, count, no special units
    .bool(false)
    .int32(o.armies)
    .u8(0)
    .int32(o.to);
  writeOrderBase(w, o.playerId);
}
