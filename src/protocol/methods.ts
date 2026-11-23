// war.app web-client method ids (the int32 in every frame header) and the
// parameter writers this server uses. The ids are protocol 243's: 243 inserted six methods
// (ChangeCommitConfirmation 26, TeamSurrender 70, TournamentGroup 94, UploadSharedImage 129,
// ChatRoomReactionsChanged 247, SetReaction 285) and renumbered everything after each. The name is also the `m=` query value of
// https://war.app/Services?m=<name>&js=1.

import type { Reader, Writer } from './codec.js';

export const Method = {
  /** Exists in the client's method table, but the web client never calls it (open games come from a page). */
  GetOpenGames: 10,
  GetGameDetails: 39,
  GameRefresh: 40,
  GetLatestGameInfo: 41,
  SendChat: 43,
  RegisterChatView: 44,
  RetrieveChat: 45,
  RetrievePrivateMessageHistory: 46,
  GetGameSettings: 49,
  GetMyGames: 51,
  AcceptGame: 61,
  AcceptOpenSeat: 62,
  AcceptOpenAutoGame: 63,
  GetOpenAutoGame: 64,
  DeclineGame: 65,
  Surrender: 68,
  AcceptSurrender: 69,
  GetMapDetails: 75,
  SendOrders: 76,
  SendInProgressOrders: 77,
  SendTerritoryPicks: 78,
  SendInProgressPicks: 79,
  BeginFirstTurn: 80,
  GetTerritoryPicks: 81,
  UnCommit: 82,
  GetTurns: 83,
  /**
   * #523: the end-of-game window's data, which the client asks for when it shows that window (`EndGameWindowVM`) and
   * which sets my seat's SeenEndGameWindow — the flag the app's My Games (the Default list) drops a finished game on.
   * Parameters as UnCommit's (auth, int32 game id), read from the bundle's writer; UNVERIFIED live.
   */
  GetEndGameWindowData: 85,
  Subscribe: 242,
  GameUpdated: 245,
  GetInAppNotifications: 323,
  DeleteInAppNotification: 324,
  AcknowledgeInAppNotifications: 325,
} as const;

type MethodName = keyof typeof Method;

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

/**
 * `warlight.shared.MyGamesFilterType`, read from the client bundle (its enum names and the client's
 * own descriptions: "Active games", "All Games", "Finished Games", …; 6 is unused). The filter is
 * sent as one byte. #260: the client's default, `Default` with a count of 10, is the dashboard's
 * short list (live: 10 of an account's 41 games, 7 of them finished).
 */
export const MyGamesFilterType = {
  ActiveGames: 0,
  ActiveNotEliminated: 1,
  YourTurn: 2,
  All: 3,
  Default: 4,
  YourTurnOrPendingChat: 5,
  ActiveGameOrPendingChat: 7,
  Finished: 8,
} as const;

/**
 * GetMyGames filters (`warlight.shared.MyGamesFilters`; the server throws when they are absent):
 * the filter type (a byte), the most games to return (an int32), the sort (a byte,
 * `warlight.shared.EnumSerialization_MyGamesSort`, its values unnamed in the bundle).
 */
export interface MyGamesFilters {
  filterType: number;
  count: number;
  sort: number;
}

/** The client's sort for its game lists (`MyGamesFilters.get_Default`). */
export const MY_GAMES_DEFAULT_SORT = 2;

/** The web client's default filters (`MyGamesFilters.get_Default`), verified through the bridge. */
export const DEFAULT_MY_GAMES_FILTERS: Readonly<MyGamesFilters> = {
  filterType: MyGamesFilterType.Default,
  count: 10,
  sort: MY_GAMES_DEFAULT_SORT,
};

/**
 * GetMyGames(auth, …) — verified through the bridge with the default filters: present +
 * MyGamesFilters { byte filterType, int32 count, byte sort } (required), then bool false,
 * int32 0, bool false, bool false (the client's writer sends those four as constants).
 * Other filter values (#260) follow the same writer and are UNVERIFIED live.
 */
export function writeGetMyGamesParams(w: Writer, filters: Readonly<MyGamesFilters> = DEFAULT_MY_GAMES_FILTERS): void {
  w.bool(true).u8(filters.filterType).int32(filters.count).u8(filters.sort);
  w.bool(false).int32(0).bool(false).bool(false);
}

/** How many colours war.app's colour list has (`warlight.shared.GameColor` indices 0..435). */
export const GAME_COLOR_COUNT = 436;

interface AcceptOpenSeatParams {
  gameId: number;
  /**
   * The team of the open seat being taken, as its record carries it (-1: a no-team seat). In a game with open seats on
   * several teams it is the team chosen (C4): the client's team picker passes the chosen team here (read from the
   * bundle; UNVERIFIED live).
   */
  team: number;
  /** The colour to play as: a `warlight.shared.GameColor` index (0..435). */
  color: number;
}

/**
 * AcceptOpenSeat(auth, …) — read from the client's writer (docs/WEB-PROTOCOL.md,
 * open games): the game id, the colour (a present flag, then the GameColor
 * record — one int32 colour index; war.app refuses an absent colour, verified
 * live as server error 1 "color is null"), the open seat's team, an optional
 * custom-scenario start slot (absent — scenario games are refused), then a bool
 * the client sets when one of the game's mods hooks the join (false: mod games
 * are refused).
 */
export function writeAcceptOpenSeatParams(w: Writer, p: AcceptOpenSeatParams): void {
  if (!Number.isInteger(p.color) || p.color < 0 || p.color >= GAME_COLOR_COUNT) {
    throw new RangeError(`war.app colour index out of range: ${p.color} (0..${GAME_COLOR_COUNT - 1})`);
  }
  w.int32(p.gameId)
    .bool(true) // colour present
    .int32(p.color) // GameColor: the colour index
    .int32(p.team)
    .bool(false) // start slot
    .bool(false); // a mod hooks this join
}

/** A `warlight.shared.AcceptOpenSeatReturn`. */
interface AcceptOpenSeatResult {
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

interface SurrenderParams {
  gameId: number;
  /** true: surrender; false: take back a pending surrender. */
  surrender: boolean;
}

/**
 * Surrender(auth, …) — VERIFIED live 2026-11-12 (issue #30): the game id, the
 * surrender flag (false takes back a pending surrender), then the per-method
 * trailing "ends vacation" bool the client sends as false. No result payload.
 */
export function writeSurrenderParams(w: Writer, p: SurrenderParams): void {
  w.int32(p.gameId).bool(p.surrender).bool(false);
}

interface AcceptSurrenderParams {
  gameId: number;
  /** The in-game id of the player whose pending surrender is accepted. */
  playerId: number;
  /** true: accept; false: take back an acceptance given earlier. */
  accept: boolean;
}

/**
 * AcceptSurrender(auth, …) — accept another player's pending surrender (#317). READ FROM THE CLIENT
 * BUNDLE's writer, NOT VERIFIED LIVE: after the auth block the int32 game id, the int32 in-game id of
 * the surrendering player, the accept flag (false takes an acceptance back), then the per-method
 * "a mod hooks this method" bool, sent false. No result payload: the outcome is read from game state.
 */
export function writeAcceptSurrenderParams(w: Writer, p: AcceptSurrenderParams): void {
  w.int32(p.gameId).int32(p.playerId).bool(p.accept).bool(false);
}

/**
 * BeginFirstTurn(auth, gameId) — the web client's Begin button in a game whose
 * first turn is a speed race (MoveOrder `NoLuckCycle`): war.app withholds the
 * board until it is pressed, and pressing it starts the player's first-turn
 * timer. READ FROM THE CLIENT'S WRITER, NOT VERIFIED LIVE: after the auth block
 * the client writes the game id alone (no trailing bools). The reply is a
 * present flag then the player's GameStanding (this server reads the board back
 * with GetLatestGameInfo instead of decoding it).
 */
export function writeBeginFirstTurnParams(w: Writer, gameId: number): void {
  w.int32(gameId);
}

/**
 * UnCommit(auth, gameId) — withdraws the account's committed orders for the
 * current turn ("Modify orders" in the client). VERIFIED FROM THE CLIENT
 * BUNDLE's writer, not yet against a live capture: after the auth block only
 * the int32 game id — no trailing bools — and no result payload.
 */
export function writeUnCommitParams(w: Writer, gameId: number): void {
  w.int32(gameId);
}

/** GetEndGameWindowData(auth, gameId) — the parameters after the auth block (#523; the bundle's writer, UNVERIFIED live). */
export function writeGetEndGameWindowDataParams(w: Writer, gameId: number): void {
  w.int32(gameId);
}

/** The page size the client always asks GetInAppNotifications for. */
export const NOTIFICATIONS_PAGE_SIZE = 30;

/**
 * GetInAppNotifications(auth, start, count) — the client's notifications screen (#311). READ FROM THE
 * CLIENT BUNDLE's writer, NOT VERIFIED LIVE: after the auth block the int32 start index (the paging
 * offset), then the int32 page size (the client always sends 30). Reply: GetInAppNotificationsReturn.
 */
export function writeGetInAppNotificationsParams(w: Writer, start: number, count: number = NOTIFICATIONS_PAGE_SIZE): void {
  w.int32(start).int32(count);
}

/** A notification id as war.app sends it back: decimal text. */
export const NOTIFICATION_ID = /^\d{1,20}$/;

/**
 * AcknowledgeInAppNotifications(auth, ids) — marks notifications read (#311). READ FROM THE CLIENT
 * BUNDLE's writer, NOT VERIFIED LIVE: after the auth block a present list (int32 count) of the ids, each
 * a string of decimal text. No result payload: the effect is read back from a later list.
 */
export function writeAcknowledgeInAppNotificationsParams(w: Writer, ids: readonly string[]): void {
  if (ids.length === 0) throw new RangeError('no notification ids');
  for (const id of ids) if (!NOTIFICATION_ID.test(id)) throw new RangeError(`not a notification id: ${JSON.stringify(id)}`);
  w.bool(true).list(ids, (ww, id) => ww.string(id));
}

/**
 * DeleteInAppNotification(auth, id) — deletes one notification (#311), the client's Delete button. READ
 * FROM THE CLIENT BUNDLE's writer, NOT VERIFIED LIVE: after the auth block one string, the id as decimal
 * text. No result payload; the client treats server error 699 (`InAppNotificationKeyNotFound`) as already
 * deleted. The effect is read back from a later list.
 */
export function writeDeleteInAppNotificationParams(w: Writer, id: string): void {
  if (!NOTIFICATION_ID.test(id)) throw new RangeError(`not a notification id: ${JSON.stringify(id)}`);
  w.string(id);
}

/** The server error DeleteInAppNotification answers for an id it does not hold: already deleted. */
export const NOTIFICATION_NOT_FOUND = 699;

/**
 * DeclineGame(auth, gameId, modHook) — the lobby's Decline button, which is also how a seated
 * player leaves a game still `WaitingForPlayers` (#217). READ FROM THE CLIENT BUNDLE's writer,
 * NOT VERIFIED LIVE: after the auth block the int32 game id, then one bool the client sets when
 * one of the game's mods hooks the decline (sent false: mod games are refused).
 */
export function writeDeclineGameParams(w: Writer, gameId: number): void {
  w.int32(gameId).bool(false);
}

/**
 * A DeclineGame reply: one bool (no present flag), which the client reads as "the chat messages
 * you sent to this game were removed". `undefined` when the reply carries nothing. Never a
 * success signal: the leave is read back from game state.
 */
export function readDeclineGameReturn(body: Reader): boolean | undefined {
  return body.remaining > 0 ? body.bool() : undefined;
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

/** SendChat channel for the whole game (any other value is a team channel: the sender's team). */
export const CHAT_CHANNEL_PUBLIC = -1;

/** The "last seen" chat marker a client that has seen nothing sends (`-1`, as text). */
export const NO_CHAT_MARKER = '-1';

interface GameRefreshParams {
  gameId: number;
  /** Ask for the chat. */
  chat: boolean;
  /** Ask for the rest of the game's details. */
  nonChat: boolean;
  /** The game is a lobby (waiting for players), not one being played. */
  lobby: boolean;
}

/**
 * GameRefresh(auth, …) per docs/WEB-PROTOCOL.md (read from the client's serializer; UNVERIFIED live):
 * game id, the chat and non-chat flags, the public and team "last seen" markers (decimal text; a
 * client that has seen nothing sends `-1`), the lobby flag, then two optional dicts (game-group chat
 * views; absent). Reply: `GameDetailsAndChat`, the chat list first.
 */
export function writeGameRefreshParams(w: Writer, p: GameRefreshParams): void {
  w.int32(p.gameId)
    .bool(p.chat)
    .bool(p.nonChat)
    .string(NO_CHAT_MARKER)
    .string(NO_CHAT_MARKER)
    .bool(p.lobby)
    .bool(false)
    .bool(false)
    // Protocol 243 added a last, optional value (a nullable number the client sends as text): absent.
    .bool(false);
}

/** A chat read mark: a message id as decimal text, or `-1` (the client's "no mark"). */
export const CHAT_MARK = /^(-1|\d{1,20})$/;

/** What RegisterChatView marks read: per channel, the highest message id seen (decimal text). */
export interface RegisterChatViewParams {
  gameId: number;
  /** The public channel's mark; `-1` (default) marks nothing there. */
  publicMark?: string;
  /** The team channel's mark; `-1` (default) marks nothing there. */
  teamMark?: string;
  /** Per private conversation: the counterpart's in-game id → its mark. Absent or empty: no dict. */
  privateMarks?: ReadonlyMap<number, string>;
  /** Per game group: the group id → its mark. Absent or empty: no dict. */
  groupMarks?: ReadonlyMap<number, string>;
}

function writeMarkDict(w: Writer, marks: ReadonlyMap<number, string> | undefined): void {
  if (!marks || marks.size === 0) {
    w.bool(false);
    return;
  }
  w.bool(true).dict(
    marks,
    (ww, k) => ww.int32(k),
    (ww, v) => ww.string(v),
  );
}

/**
 * RegisterChatView(auth, …) — marks a game's chat read (#311). READ FROM THE CLIENT BUNDLE's writer, NOT
 * VERIFIED LIVE: the int32 game id, the public and team marks (strings of decimal text: the highest message
 * id seen on that channel; the client sends `-1` for a channel it is not marking), then two optional dicts
 * (present flag, int32 count, int32 key, string mark): per private counterpart (in-game id), and per game
 * group. No result payload: the effect is read back from GetMyGames' unread flags.
 */
export function writeRegisterChatViewParams(w: Writer, p: RegisterChatViewParams): void {
  const marks = [p.publicMark, p.teamMark, ...(p.privateMarks?.values() ?? []), ...(p.groupMarks?.values() ?? [])];
  for (const m of marks) if (m !== undefined && !CHAT_MARK.test(m)) throw new RangeError(`not a chat mark: ${JSON.stringify(m)}`);
  w.int32(p.gameId)
    .string(p.publicMark ?? NO_CHAT_MARKER)
    .string(p.teamMark ?? NO_CHAT_MARKER);
  writeMarkDict(w, p.privateMarks);
  writeMarkDict(w, p.groupMarks);
}

/**
 * The "older than" marker of a chat history read when nothing has been received on that channel yet: the
 * client's 9999E14 (its initial lowest-id-received), written as text.
 */
export const OLDEST_CHAT_MARKER = '999900000000000000';

const MESSAGE_ID_TEXT = /^\d{1,20}$/;
function beforeMarker(m: string | undefined): string {
  if (m === undefined) return OLDEST_CHAT_MARKER;
  if (!MESSAGE_ID_TEXT.test(m)) throw new RangeError(`not a message id: ${JSON.stringify(m)}`);
  return m;
}

/** What RetrieveChat asks for: per channel, messages older than the oldest one received (decimal text). */
export interface RetrieveChatParams {
  gameId: number;
  /** The oldest public message id received; absent: none yet ({@link OLDEST_CHAT_MARKER}). */
  publicBefore?: string;
  /** The oldest team message id received; absent: none yet. */
  teamBefore?: string;
}

/**
 * RetrieveChat(auth, …) — the web client's "show older messages" for the public and team channels (#363). READ
 * FROM THE CLIENT BUNDLE's writer: the int32 game id, then per channel the lowest message id the client has
 * received (string; 9999E14 when none). Reply: a result flag, then a list of optional `GameMessage` (as the
 * SendChat reply). GameRefresh with `-1` markers leaves out messages war.app counts as seen (an own team
 * message, seen live 2026-11-19); this read returns them.
 */
export function writeRetrieveChatParams(w: Writer, p: RetrieveChatParams): void {
  w.int32(p.gameId).string(beforeMarker(p.publicBefore)).string(beforeMarker(p.teamBefore));
}

/** What RetrievePrivateMessageHistory asks for: one private conversation's messages older than `before`. */
export interface RetrievePrivateMessageHistoryParams {
  gameId: number;
  /** The oldest message id received in this conversation; absent: none yet. */
  before?: string;
  /** The counterpart's in-game id. */
  counterpart: number;
}

/**
 * RetrievePrivateMessageHistory(auth, …) — the client's history button of one private conversation (#387). READ
 * FROM THE CLIENT BUNDLE's writer: the int32 game id, the lowest message id received in it (string; 9999E14 when
 * none), the counterpart's in-game id (int32). Reply as RetrieveChat's.
 */
export function writeRetrievePrivateMessageHistoryParams(w: Writer, p: RetrievePrivateMessageHistoryParams): void {
  w.int32(p.gameId).string(beforeMarker(p.before)).int32(p.counterpart);
}

interface SendChatParams {
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
 * (`-1`: seen nothing), two optional "last seen" dicts (absent). An optional int32 is a
 * present flag then the value.
 */
export function writeSendChatParams(w: Writer, p: SendChatParams): void {
  w.int32(p.gameId).string(p.text).int32(p.channel ?? CHAT_CHANNEL_PUBLIC);
  if (p.recipient === undefined) w.bool(false);
  else w.bool(true).int32(p.recipient);
  // The two chat markers are the last message seen on each channel: war.app parses them as numbers
  // (ParseLongSafe), so a null one is refused (server error 1); a client that has seen nothing sends `-1`.
  w.bool(false) // game-group id
    .string(NO_CHAT_MARKER)
    .string(NO_CHAT_MARKER)
    .bool(false)
    .bool(false)
    // Protocol 243 added a last, optional list of strings (the shared images a message carries): absent.
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

interface DeployOrder {
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

const ORDER_TAG_PURCHASE = 24;

/** #332: a purchase order — cities to build on my territories (one order per turn; war.app refuses a second, 599). */
interface PurchaseOrder {
  playerId: number;
  cities: ReadonlyArray<{ territoryId: number; count: number }>;
}

/**
 * Encode a Purchase order (`GameOrderPurchase`, client 6.08.0.2's writer; UNVERIFIED live): tag 24, a present bool,
 * an int32 count of territory → cities entries, each two int32s, then the order base.
 */
export function writePurchaseOrder(w: Writer, o: PurchaseOrder): void {
  w.u8(ORDER_TAG_PURCHASE).bool(true).int32(o.cities.length);
  for (const c of o.cities) w.int32(c.territoryId).int32(c.count);
  writeOrderBase(w, o.playerId);
}

/** A commander an order takes along: its GUID and its owner's in-game id, as the live board reads them. */
export interface OrderCommander {
  /** The unit's GUID (32 hex digits; dashes allowed). */
  id: string;
  /** In-game id of its owner. */
  owner: number;
}

/** The special-unit tag of a Commander (`warlight.shared.Commander`, from the bundle; docs/WEB-PROTOCOL.md). */
const SPECIAL_UNIT_COMMANDER = 1;

interface AttackTransferOrder {
  playerId: number;
  from: number;
  to: number;
  /** Armies sent; with {@link byPercent} the percentage (1–100) of what can move when the order runs. */
  armies: number;
  /** 1 Attack Only, 2 Transfer Only, 3 AttackTransfer (default). */
  mode?: AttackTransferMode;
  byPercent?: boolean;
  /** Treat teammates' territories as enemies (attack them). */
  attackTeammates?: boolean;
  /** Take this commander along (the client writes it in the order's Armies as a special unit). */
  commander?: OrderCommander;
}

/**
 * Encode an AttackTransfer order. The layout is verified against a live turn commit (mode 3, no
 * options); the option bytes (mode 1/2, byPercent, attackTeammates, a commander in the Armies)
 * follow the client bundle's writer and are UNVERIFIED live (#165).
 */
export function writeAttackTransferOrder(w: Writer, o: AttackTransferOrder): void {
  w.u8(ORDER_TAG_ATTACK_TRANSFER)
    .bool(o.attackTeammates ?? false)
    .u8(o.mode ?? AttackTransferMode.AttackTransfer)
    .bool(o.byPercent ?? false)
    .int32(o.from)
    // Armies: not fogged, count, then the special units (count byte; each a tag, a GUID, an owner)
    .bool(false)
    .int32(o.armies);
  if (o.commander) w.u8(1).u8(SPECIAL_UNIT_COMMANDER).guid(o.commander.id).int32(o.commander.owner);
  else w.u8(0);
  w.int32(o.to);
  writeOrderBase(w, o.playerId);
}

/**
 * The card plays this server can encode, by order tag. VERIFIED 2026-11-12
 * (docs/PLAN-CARDS-PUSH.md): Reinforcement (5) live, golden-pinned; Order Priority, Order Delay
 * and Blockade follow the same layout with the fields read from the client. The targeted cards
 * (Spy 6, Airlift 12, Gift 13, Diplomacy 14, Sanctions 15, Reconnaissance 16, Surveillance 17;
 * PLAN-TEAMS part D) are read from the bundle's `GameOrderPlayCard<X>` writers and golden-pinned,
 * but UNVERIFIED live (V9): no commit carrying one has been sent. Bomb (20, `GameOrderPlayCardBomb`)
 * and Emergency Blockade (8, `GameOrderPlayCardAbandon`) likewise: each writes one int32 territory.
 */
const CardPlayTag = {
  EmergencyBlockade: 8,
  Reinforcement: 5,
  Spy: 6,
  OrderPriority: 10,
  OrderDelay: 11,
  Airlift: 12,
  Gift: 13,
  Diplomacy: 14,
  Sanctions: 15,
  Reconnaissance: 16,
  Surveillance: 17,
  Blockade: 18,
  Bomb: 20,
} as const;
export type CardPlayKind = keyof typeof CardPlayTag;

/** The card plays that take targets (PLAN-TEAMS part D): `warapp_submit_turn` resolves their fields. */
export const TARGETED_CARD_PLAYS: ReadonlySet<CardPlayKind> = new Set([
  'Spy',
  'Airlift',
  'Gift',
  'Diplomacy',
  'Sanctions',
  'Reconnaissance',
  'Surveillance',
  'Bomb',
  'EmergencyBlockade',
]);

/**
 * The card plays whose encoding is read from the bundle but not yet sent live (V9): the preview warns
 * and the result carries `cardPlayCheck`. Airlift left it once verified live 2026-11-16 (#296), Diplomacy
 * once verified live 2026-11-18 (#369: played through warapp_submit_turn, read in force on later boards),
 * Reconnaissance once war.app accepted it live 2026-11-20 (#443: a turn with the play committed, no error;
 * withdrawn before it resolved, so the reveal itself is not yet seen).
 */
const VERIFIED_CARD_PLAYS: ReadonlySet<CardPlayKind> = new Set<CardPlayKind>(['Airlift', 'Diplomacy', 'Reconnaissance']);
export const UNVERIFIED_CARD_PLAYS: ReadonlySet<CardPlayKind> = new Set(
  [...TARGETED_CARD_PLAYS].filter((kind) => !VERIFIED_CARD_PLAYS.has(kind)),
);

/** A card play's own fields (what each card needs is checked by {@link writeCardPlayOrder}). */
export interface CardPlayFields {
  /** Blockade, Emergency Blockade, Bomb, Reconnaissance and Gift: the territory. */
  target?: number;
  /** Spy, Sanctions: the target player; Gift: the recipient (in-game ids). */
  player?: number;
  /** Diplomacy: the two players who may not attack each other (in-game ids). */
  players?: readonly [number, number];
  /** Surveillance: the bonus. */
  bonus?: number;
  /** Airlift: the territory the armies leave, the one they land on, and how many. */
  from?: number;
  to?: number;
  armies?: number;
  /** Airlift: my commander goes too (written in the Armies as one special unit). */
  commander?: OrderCommander;
}

interface CardPlayOrder extends CardPlayFields {
  playerId: number;
  card: CardPlayKind;
  /** The card instance GUID (32 hex digits; dashes allowed). */
  cardId: string;
}

function need<T>(v: T | undefined, card: CardPlayKind, what: string): T {
  if (v === undefined) throw new Error(`A ${card} card play needs ${what}.`);
  return v;
}

/**
 * Encode a play-card order: the tag, the card's own fields in the order the bundle's writer puts
 * them, the card instance GUID in .NET byte order, then the player id and two false bools.
 * Blockade, Emergency Blockade, Bomb, Reconnaissance: the territory. Spy, Sanctions: the player. Surveillance: the bonus.
 * Gift: the recipient, then the territory. Diplomacy: the two players. Airlift: a present
 * `Armies` (not fogged, the count, the special units: none, or my commander — as an AttackTransfer
 * writes it), the from
 * territory, a legacy army count the client leaves 0, the to territory. Throws when a card's
 * fields are missing.
 */
export function writeCardPlayOrder(w: Writer, o: CardPlayOrder): void {
  w.u8(CardPlayTag[o.card]);
  switch (o.card) {
    case 'Blockade':
    case 'EmergencyBlockade':
    case 'Bomb':
    case 'Reconnaissance':
      w.int32(need(o.target, o.card, 'a target territory'));
      break;
    case 'Spy':
    case 'Sanctions':
      w.int32(need(o.player, o.card, 'a target player'));
      break;
    case 'Surveillance':
      w.int32(need(o.bonus, o.card, 'a target bonus'));
      break;
    case 'Gift': {
      const player = need(o.player, o.card, 'a recipient player');
      w.int32(player).int32(need(o.target, o.card, 'a territory'));
      break;
    }
    case 'Diplomacy': {
      const [a, b] = need(o.players, o.card, 'two players');
      w.int32(a).int32(b);
      break;
    }
    case 'Airlift':
      if (o.from === undefined || o.to === undefined || o.armies === undefined) {
        throw new Error('An Airlift card play needs from, to and armies.');
      }
      w.bool(true).bool(false).int32(o.armies);
      if (o.commander) w.u8(1).u8(SPECIAL_UNIT_COMMANDER).guid(o.commander.id).int32(o.commander.owner);
      else w.u8(0);
      w.int32(o.from).int32(0).int32(o.to);
      break;
    default:
      break;
  }
  w.guid(o.cardId);
  writeOrderBase(w, o.playerId);
}

const ORDER_TAG_DISCARD = 9;

interface DiscardOrder {
  playerId: number;
  /** The card instance GUID (32 hex digits; dashes allowed). */
  cardId: string;
}

/**
 * Encode a discard order (`GameOrderDiscard`): tag 9, the card instance GUID in
 * .NET byte order, then the order base. VERIFIED against the client bundle's
 * writer (the tag, the GUID, the order base), not yet against a live commit.
 */
export function writeDiscardOrder(w: Writer, o: DiscardOrder): void {
  w.u8(ORDER_TAG_DISCARD);
  w.guid(o.cardId);
  writeOrderBase(w, o.playerId);
}

/** One order of a turn, as a tool builds it (the player id is supplied per turn). */
export type TurnOrder =
  | { kind: 'deploy'; territoryId: number; armies: number }
  | {
      kind: 'move';
      from: number;
      to: number;
      armies: number;
      mode?: AttackTransferMode;
      byPercent?: boolean;
      attackTeammates?: boolean;
      commander?: OrderCommander;
    }
  | (CardPlayFields & {
      kind: 'card';
      card: CardPlayKind;
      cardId: string;
      /**
       * Order Delay only (#186): the move (0-based, among this turn's moves in their order) the card
       * is written above. The move count, or absent, writes it after every move — the only
       * live-verified position; a smaller index is UNVERIFIED live (docs/WEB-PROTOCOL.md).
       */
      beforeMove?: number;
    })
  | { kind: 'discard'; cardId: string }
  /** #332: cities to build (a commerce game that allows them). */
  | { kind: 'purchase'; cities: ReadonlyArray<{ territoryId: number; count: number }> };

/**
 * The `warlight.shared.TurnPhase` each order runs in. war.app refuses a turn
 * whose orders are out of phase order with error 10 `OrdersInIncorrectOrder`
 * (VERIFIED live 2026-11-12: `[OrderPriority, Reinforcement, deploys]` was
 * accepted, `[Reinforcement, OrderPriority, …]` refused). Order Delay runs in
 * the attack/transfer phase (50) — VERIFIED live 2026-11-12: placed with Order
 * Priority (phase 12) it was refused with error 10. Discards run first (phase 10,
 * from the bundle's `GameOrderDiscard.Vd`).
 */
export const TurnPhase = {
  /** #332, bundle (`GameOrderPurchase`), UNVERIFIED live: a commerce game's purchase, before every other order. */
  Purchases: 0,
  Discards: 10,
  OrderPriorityCards: 12,
  /** Spy, Reconnaissance and Surveillance (bundle, UNVERIFIED live). */
  SpyingCards: 15,
  ReinforcementCards: 20,
  Deploys: 25,
  /** Bundle (`GameOrderPlayCardBomb`), UNVERIFIED live: after the deploys, before every move. */
  BombCards: 30,
  /** Bundle (`GameOrderPlayCardAbandon`), UNVERIFIED live: the Emergency Blockade, before Airlift and the attacks. */
  EmergencyBlockadeCards: 37,
  /** Bundle, UNVERIFIED live: after the deploys, before the attacks. */
  AirliftCards: 43,
  /** Bundle, UNVERIFIED live. */
  GiftCards: 47,
  Attacks: 50,
  BlockadeCards: 60,
  /** Bundle, UNVERIFIED live. */
  DiplomacyCards: 75,
  /** Bundle, UNVERIFIED live. */
  SanctionsCards: 80,
} as const;

const CARD_PHASE: Readonly<Record<CardPlayKind, number>> = {
  OrderPriority: TurnPhase.OrderPriorityCards,
  OrderDelay: TurnPhase.Attacks,
  Reinforcement: TurnPhase.ReinforcementCards,
  Blockade: TurnPhase.BlockadeCards,
  Bomb: TurnPhase.BombCards,
  EmergencyBlockade: TurnPhase.EmergencyBlockadeCards,
  Spy: TurnPhase.SpyingCards,
  Reconnaissance: TurnPhase.SpyingCards,
  Surveillance: TurnPhase.SpyingCards,
  Airlift: TurnPhase.AirliftCards,
  Gift: TurnPhase.GiftCards,
  Diplomacy: TurnPhase.DiplomacyCards,
  Sanctions: TurnPhase.SanctionsCards,
};

/** The turn phase an order runs in. */
export function turnPhaseOf(o: TurnOrder): number {
  if (o.kind === 'deploy') return TurnPhase.Deploys;
  if (o.kind === 'move') return TurnPhase.Attacks;
  if (o.kind === 'discard') return TurnPhase.Discards;
  if (o.kind === 'purchase') return TurnPhase.Purchases;
  return CARD_PHASE[o.card];
}

/**
 * Turn-phase order, and within one phase the card plays after the other orders (so an Order
 * Delay, phase 50, follows every AttackTransfer: the shape of the 2026-11-12 live commit that
 * verified phase 50). The phase is VERIFIED; an Order Delay ahead of a move in phase 50 is
 * UNVERIFIED live (the client bundle lets a player raise it among the moves and its validator
 * refuses only a phase that goes down, but no such commit has been sent), so it is written there
 * only when its order asks (`beforeMove`, #186; docs/WEB-PROTOCOL.md).
 */
function compareTurnOrders(a: TurnOrder, b: TurnOrder): number {
  return turnPhaseOf(a) - turnPhaseOf(b) || Number(a.kind === 'card') - Number(b.kind === 'card');
}

/**
 * The orders in the sequence SendOrders writes them: turn-phase order ({@link compareTurnOrders}),
 * then each Order Delay that names a `beforeMove` short of the move count lifted out and written
 * just above that move (#186 — the bundle's Order Delay order carries no position field, so its
 * place in the list is its position; UNVERIFIED live). Several placed above one move keep their
 * given order. Throws on a `beforeMove` on any other card, or one outside 0..moves.
 */
function sendOrderSequence(orders: readonly TurnOrder[]): TurnOrder[] {
  const moveCount = orders.filter((o) => o.kind === 'move').length;
  const placed = new Map<TurnOrder, number>();
  for (const o of orders) {
    if (o.kind !== 'card' || o.beforeMove === undefined) continue;
    if (o.card !== 'OrderDelay') throw new Error(`Only an Order Delay takes a position among the moves, not ${o.card}.`);
    if (!Number.isInteger(o.beforeMove) || o.beforeMove < 0 || o.beforeMove > moveCount) {
      throw new Error(`Order Delay beforeMove ${o.beforeMove} is outside the turn's ${moveCount} moves (0–${moveCount}).`);
    }
    if (o.beforeMove < moveCount) placed.set(o, o.beforeMove);
  }
  const sorted = orders.filter((o) => !placed.has(o)).sort(compareTurnOrders);
  if (!placed.size) return sorted;
  const out: TurnOrder[] = [];
  let move = 0;
  for (const o of sorted) {
    if (o.kind === 'move') {
      for (const [card, at] of placed) if (at === move) out.push(card);
      move++;
    }
    out.push(o);
  }
  return out;
}

/**
 * SendOrders(auth, …) — verified against a live turn commit: the game id, a
 * present order list (int32 count, then per order a present flag and the
 * order), the turn number (GameFeed `numberOfTurns` + 1), then two bools the
 * client sends as false. Orders are written in turn-phase order (a stable
 * sort, so orders of one phase keep their given order, card plays after
 * the rest): discards, Order Priority and Reinforcement plays, then every deploy, then
 * the moves (AttackTransfers, mode 3 unless the move sets another) followed by any Order Delay
 * plays (or one written above a chosen move, `beforeMove`, UNVERIFIED live: {@link sendOrderSequence}),
 * then any Blockade plays. The targeted cards (UNVERIFIED live, V9) take the bundle's phases: Spy,
 * Reconnaissance and Surveillance with the early cards (15), Bomb (30), Emergency Blockade (37), Airlift
 * (43) and Gift (47) between the deploys and the moves, Diplomacy (75) and Sanctions (80) last.
 */
export function writeSendOrdersParams(
  w: Writer,
  gameId: number,
  playerId: number,
  orders: readonly TurnOrder[],
  turnNumber: number,
): void {
  const sorted = sendOrderSequence(orders);
  w.int32(gameId).bool(true).int32(sorted.length);
  for (const o of sorted) {
    w.bool(true);
    if (o.kind === 'card') {
      const { kind: _kind, beforeMove: _beforeMove, ...play } = o;
      writeCardPlayOrder(w, { playerId, ...play });
    } else if (o.kind === 'discard') {
      writeDiscardOrder(w, { playerId, cardId: o.cardId });
    } else if (o.kind === 'purchase') {
      writePurchaseOrder(w, { playerId, cities: o.cities });
    } else if (o.kind === 'deploy') {
      writeDeployOrder(w, { playerId, territoryId: o.territoryId, armies: o.armies });
    } else {
      const { kind: _kind, ...move } = o;
      writeAttackTransferOrder(w, { playerId, ...move });
    }
  }
  w.int32(turnNumber).bool(false).bool(false);
}
