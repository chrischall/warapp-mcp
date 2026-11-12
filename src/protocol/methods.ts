// war.app web-client method ids (the int32 in every frame header) and the
// parameter writers this server uses. The name is also the `m=` query value of
// https://war.app/Services?m=<name>&js=1.

import type { Reader, Writer } from './codec.js';

export const Method = {
  /** Exists in the client's method table, but the web client never calls it (open games come from a page). */
  GetOpenGames: 10,
  GetGameDetails: 38,
  GameRefresh: 39,
  GetLatestGameInfo: 40,
  SendChat: 42,
  GetGameSettings: 48,
  GetMyGames: 50,
  AcceptGame: 60,
  AcceptOpenSeat: 61,
  AcceptOpenAutoGame: 62,
  GetOpenAutoGame: 63,
  DeclineGame: 64,
  GetMapDetails: 73,
  SendOrders: 74,
  SendInProgressOrders: 75,
  SendTerritoryPicks: 76,
  SendInProgressPicks: 77,
  GetTerritoryPicks: 79,
  UnCommit: 80,
  GetTurns: 81,
  Subscribe: 238,
  GameUpdated: 241,
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

/** GetMyGames filters (`MyGamesFilters`); the server throws when they are absent. */
export interface MyGamesFilters {
  filterType: number;
  count: number;
  sort: number;
}

/** The web client's default filters, verified through the bridge. */
export const DEFAULT_MY_GAMES_FILTERS: Readonly<MyGamesFilters> = { filterType: 4, count: 10, sort: 2 };

/**
 * GetMyGames(auth, …) — verified through the bridge: present + MyGamesFilters
 * { byte filterType, int32 count, byte sort } (required), then bool false,
 * int32 0, bool false, bool false.
 */
export function writeGetMyGamesParams(w: Writer, filters: MyGamesFilters = DEFAULT_MY_GAMES_FILTERS): void {
  w.bool(true).u8(filters.filterType).int32(filters.count).u8(filters.sort);
  w.bool(false).int32(0).bool(false).bool(false);
}

export interface AcceptOpenSeatParams {
  gameId: number;
  /** The team of the open seat being taken, as its record carries it (-1: a no-team seat). */
  team: number;
}

/**
 * AcceptOpenSeat(auth, …) — read from the client's writer (docs/PLAN-OPEN-GAMES.md;
 * the owner verifies it live): the game id, an optional colour preference
 * (absent), the open seat's team, an optional custom-scenario start slot
 * (absent — scenario games are refused), then a bool the client sets when one
 * of the game's mods hooks the join (false: mod games are refused).
 */
export function writeAcceptOpenSeatParams(w: Writer, p: AcceptOpenSeatParams): void {
  w.int32(p.gameId)
    .bool(false) // colour preference
    .int32(p.team)
    .bool(false) // start slot
    .bool(false); // a mod hooks this join
}

/** A `warlight.shared.AcceptOpenSeatReturn`. */
export interface AcceptOpenSeatResult {
  /** The join ended the account's vacation (the client says "Welcome back"). */
  vacationEnded: boolean;
  /**
   * A game id the client opens instead of reporting the join (UNVERIFIED:
   * what war.app means by it is not known).
   */
  otherGameId?: number;
}

/**
 * An AcceptOpenSeat result: the result-present flag, then a bool and an
 * optional int32. Absent is `undefined` (the client treats it as a plain join).
 */
export function readAcceptOpenSeatReturn(body: Reader): AcceptOpenSeatResult | undefined {
  if (!body.bool()) return undefined;
  const vacationEnded = body.bool();
  return body.bool() ? { vacationEnded, otherGameId: body.int32() } : { vacationEnded };
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

/**
 * Subscribe(topics) — sent on the push socket, not through `/Services`, and
 * with NO auth block (verified live): a present list of topic strings
 * (`Game.<id>`), then a null string.
 */
export function writeSubscribeParams(w: Writer, topics: readonly string[]): void {
  w.bool(true)
    .list(topics, (ww, t) => ww.string(t))
    .string(null);
}

/** The push topic for a game's updates. */
export const gameTopic = (gameId: number): string => `Game.${gameId}`;

/**
 * A Subscribe result: present flag, then a dict topic → error code
 * (EnumSerialization_ErrorTypes, int32). Absent or null means every topic
 * was accepted; an entry is a refused topic.
 */
export function readSubscribeResult(body: Reader): Map<string, number> {
  if (!body.bool()) return new Map();
  const d = body.dict(
    (r) => r.string() ?? '',
    (r) => r.int32(),
  );
  return d ?? new Map();
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
// VERIFIED 2026-11-12: these layouts match a live client turn commit byte for byte
// (docs/WEB-PROTOCOL.md, Orders; pinned by golden tests in tests/protocol/methods.test.ts).
// writeSendOrdersParams assembles a whole turn commit from them.

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

/** Encode a Deploy order (layout verified against a live turn commit). */
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

/** Encode an AttackTransfer order (layout verified against a live turn commit). */
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

/**
 * The card plays this server can encode, by order tag. VERIFIED 2026-11-12
 * (docs/PLAN-CARDS-PUSH.md): Reinforcement (5) live, golden-pinned; the others
 * follow the same layout with the fields read from the client.
 */
export const CardPlayTag = { Reinforcement: 5, OrderPriority: 10, OrderDelay: 11, Blockade: 18 } as const;
export type CardPlayKind = keyof typeof CardPlayTag;

export interface CardPlayOrder {
  playerId: number;
  card: CardPlayKind;
  /** The card instance GUID (32 hex digits; dashes allowed). */
  cardId: string;
  /** Blockade only: the territory to blockade. */
  target?: number;
}

/**
 * Encode a play-card order: the tag, the card's own fields (Blockade: the
 * target territory), the card instance GUID in .NET byte order, then the
 * player id and two false bools.
 */
export function writeCardPlayOrder(w: Writer, o: CardPlayOrder): void {
  w.u8(CardPlayTag[o.card]);
  if (o.card === 'Blockade') {
    if (o.target === undefined) throw new Error('A Blockade card play needs a target territory.');
    w.int32(o.target);
  }
  w.guid(o.cardId);
  writeOrderBase(w, o.playerId);
}

/** One order of a turn, as a tool builds it (the player id is supplied per turn). */
export type TurnOrder =
  | { kind: 'deploy'; territoryId: number; armies: number }
  | { kind: 'move'; from: number; to: number; armies: number }
  | { kind: 'card'; card: CardPlayKind; cardId: string; target?: number };

/**
 * The `warlight.shared.TurnPhase` each order runs in. war.app refuses a turn
 * whose orders are out of phase order with error 10 `OrdersInIncorrectOrder`
 * (VERIFIED live 2026-11-12: `[OrderPriority, Reinforcement, deploys]` was
 * accepted, `[Reinforcement, OrderPriority, …]` refused). Order Delay runs in
 * the attack/transfer phase (50) — VERIFIED live 2026-11-12: placed with Order
 * Priority (phase 12) it was refused with error 10.
 */
export const TurnPhase = {
  OrderPriorityCards: 12,
  ReinforcementCards: 20,
  Deploys: 25,
  Attacks: 50,
  BlockadeCards: 60,
} as const;

const CARD_PHASE: Readonly<Record<CardPlayKind, number>> = {
  OrderPriority: TurnPhase.OrderPriorityCards,
  OrderDelay: TurnPhase.Attacks,
  Reinforcement: TurnPhase.ReinforcementCards,
  Blockade: TurnPhase.BlockadeCards,
};

/** The turn phase an order runs in. */
export function turnPhaseOf(o: TurnOrder): number {
  if (o.kind === 'deploy') return TurnPhase.Deploys;
  if (o.kind === 'move') return TurnPhase.Attacks;
  return CARD_PHASE[o.card];
}

/**
 * Turn-phase order, and within one phase the card plays after the other
 * orders (so an Order Delay, phase 50, follows every AttackTransfer). The
 * within-phase position is UNVERIFIED; the phase itself is.
 */
function compareTurnOrders(a: TurnOrder, b: TurnOrder): number {
  return turnPhaseOf(a) - turnPhaseOf(b) || Number(a.kind === 'card') - Number(b.kind === 'card');
}

/**
 * SendOrders(auth, …) — verified against a live turn commit: the game id, a
 * present order list (int32 count, then per order a present flag and the
 * order), the turn number (GameFeed `numberOfTurns` + 1), then two bools the
 * client sends as false. Orders are written in turn-phase order (a stable
 * sort, so orders of one phase keep their given order, card plays after
 * the rest): Order Priority and Reinforcement plays, then every deploy, then
 * the moves (ordinary AttackTransfers, mode 3) followed by any Order Delay
 * plays, then any Blockade plays.
 */
export function writeSendOrdersParams(
  w: Writer,
  gameId: number,
  playerId: number,
  orders: readonly TurnOrder[],
  turnNumber: number,
): void {
  const sorted = [...orders].sort(compareTurnOrders);
  w.int32(gameId).bool(true).int32(sorted.length);
  for (const o of sorted) {
    w.bool(true);
    if (o.kind === 'card') {
      writeCardPlayOrder(w, { playerId, card: o.card, cardId: o.cardId, ...(o.target !== undefined ? { target: o.target } : {}) });
    } else if (o.kind === 'deploy') {
      writeDeployOrder(w, { playerId, territoryId: o.territoryId, armies: o.armies });
    } else {
      writeAttackTransferOrder(w, { playerId, from: o.from, to: o.to, armies: o.armies });
    }
  }
  w.int32(turnNumber).bool(false).bool(false);
}
