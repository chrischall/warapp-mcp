// The end-of-game capture (#312 E1), pure: what a finished game's history and my own records say,
// read once and kept name-free by src/finished-store.ts. Nothing here reads a file or the network,
// and no planner decision reads any of it (owner decision P1: it informs only).
//
// History boards are numbered by completed turns (src/trend.ts `historyBoards`: entry N is the board
// after N turns, 0 the start). My orders are cached by the turn they were played on (the turn being
// played = completed + 1), so the orders of turn T ran on board T − 1 and left board T.
import type { BoardState, TerritoryState } from '../board.js';
import type { GameSettings } from '../normalize.js';
import type { MapGraph } from './graph.js';
import type { MyOrders } from './opponents.js';
import { boardIncome, incomeRules } from './player.js';

/** How a finished game ended for me, from my player state. */
export type FinishedOutcome = 'won' | 'lost' | 'surrendered' | 'eliminated' | 'booted' | 'ended-by-vote' | 'unknown';

const BY_STATE: Readonly<Record<string, FinishedOutcome>> = {
  Won: 'won',
  Eliminated: 'eliminated',
  SurrenderAccepted: 'surrendered',
  Booted: 'booted',
  EndedByVote: 'ended-by-vote',
};

/**
 * My outcome from the final player states: my own state when it names an end, else `lost` when
 * another player won, else `unknown` (also when I am not among the players).
 */
export function outcomeOf(players: readonly { id: number; state?: string | undefined }[], me: number): FinishedOutcome {
  const mine = players.find((p) => p.id === me);
  if (!mine) return 'unknown';
  const named = BY_STATE[mine.state ?? ''];
  if (named) return named;
  return players.some((p) => p.id !== me && p.state === 'Won') ? 'lost' : 'unknown';
}

/** One player on one history board. */
export interface PlayerTurn {
  /** Base (or per-territory, when larger) + every bonus held in full: `boardIncome`, cards and the army cap aside. */
  income: number;
  territories: number;
  /**
   * Armies on its territories (plain armies: a commander is counted in `commanders`, #437); `null` when any of
   * them is hidden by the fog. A territory whose count did not read on a board that hides nothing (a finished
   * game's history shows every territory, V1) is left out of the sum and counted in `armiesUnread`.
   */
  armies: number | null;
  /**
   * #437: its territories whose army count did not read though no fog hid it; absent when none. Records written
   * before the commander shape was read (VERIFIED live 2026-11-20) set it where a commander stood; a board parsed
   * now reads that count (the plain armies) and sets `commanders` instead.
   */
  armiesUnread?: number;
  /**
   * #437: its own commanders standing on its land (a commander fights as 7, not counted in `armies`, which are
   * the plain armies GameFeed sends); absent when none.
   */
  commanders?: number;
  /** The bonuses it holds in full, ascending ids. */
  bonuses: number[];
}

const ownerOf = (t: TerritoryState | undefined): number | undefined =>
  t?.owner.kind === 'player' ? t.owner.playerId : undefined;

/** A fog level that hides a territory's armies (fogged or owner-only, by word or number). */
const hidesArmies = (level: string | undefined): boolean => level !== undefined && (/fog|owneronly/i.test(level) || level === '3' || level === '4');

/**
 * Each of `players` on `board`: its income by THE income rule (`boardIncome`, src/analysis/player.ts:
 * base or per-territory income, plus every full bonus; the map's values with the game's overrides
 * applied by the caller), the bonuses it holds, its territories and armies. A player with no land
 * earns 0 (it is out). Pure.
 */
export function turnIncomes(
  g: MapGraph,
  board: BoardState,
  players: readonly number[],
  settings: Pick<GameSettings, 'minimumArmyBonus' | 'bonusArmyPer'> | undefined,
): Map<number, PlayerTurn> {
  const held = new Map<number, Set<number>>(players.map((p) => [p, new Set<number>()]));
  const armies = new Map<number, number | null>(players.map((p) => [p, 0]));
  const unread = new Map<number, number>();
  const commanders = new Map<number, number>();
  for (const t of board.territories) {
    const o = ownerOf(t);
    if (o === undefined || !held.has(o) || !g.territoryById.has(t.territoryId)) continue;
    held.get(o)!.add(t.territoryId);
    const own = t.specialUnits?.filter((u) => u.kind === 'commander' && u.playerId === o).length ?? 0;
    if (own) commanders.set(o, (commanders.get(o) ?? 0) + own);
    const a = armies.get(o)!;
    if (t.armies === null && !hidesArmies(t.fogLevel)) {
      unread.set(o, (unread.get(o) ?? 0) + 1);
      continue;
    }
    armies.set(o, a === null || t.armies === null ? null : a + t.armies);
  }
  const rules = incomeRules(settings);
  const out = new Map<number, PlayerTurn>();
  for (const p of players) {
    const land = held.get(p)!;
    if (!land.size) {
      out.set(p, { income: 0, territories: 0, armies: 0, bonuses: [] });
      continue;
    }
    const inc = boardIncome(g, land, rules);
    const u = unread.get(p);
    const c = commanders.get(p);
    out.set(p, {
      income: inc.total,
      territories: land.size,
      armies: armies.get(p)!,
      bonuses: inc.bonuses.map((b) => b.bonusId).sort((a, b) => a - b),
      ...(u ? { armiesUnread: u } : {}),
      ...(c ? { commanders: c } : {}),
    });
  }
  return out;
}

type Boards = readonly { turn: number; board: BoardState }[];
const ascending = (boards: Boards) => [...boards].sort((a, b) => a.turn - b.turn);
const landOf = (board: BoardState, p: number) =>
  board.territories
    .filter((t) => ownerOf(t) === p)
    .map((t) => t.territoryId)
    .sort((a, b) => a - b);

/** Each player's territories on the first board where it holds any (its start). Pure. */
export function startsOf(boards: Boards, players: readonly number[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const { board } of ascending(boards))
    for (const p of players) {
      if (out.has(p)) continue;
      const land = landOf(board, p);
      if (land.length) out.set(p, land);
    }
  return out;
}

/** The first board, after one where `player` held land, on which it holds none; `null` when never. Pure. */
export function outTurnOf(boards: Boards, player: number): number | null {
  let held = false;
  for (const { turn, board } of ascending(boards)) {
    const has = board.territories.some((t) => ownerOf(t) === player);
    if (has) held = true;
    else if (held) return turn;
  }
  return null;
}

/** One target my attacks of one turn did not take, with what stood on it (the history shows the truth). */
export interface FailedAttack {
  /** The turn the orders were played on. */
  turn: number;
  to: number;
  /** My sources, ascending. */
  from: number[];
  /** The armies my orders sent at it (whole-army moves only: a percentage order is not counted). */
  sent: number;
  /** Before the turn: its owner (a player id, `neutral`, `unknown`) and armies. */
  before: { owner: number | 'neutral' | 'unknown'; armies: number | null };
  /** After the turn. */
  after: { owner: number | 'neutral' | 'unknown'; armies: number | null };
}

const side = (t: TerritoryState | undefined): FailedAttack['before'] => ({
  owner: !t ? 'unknown' : t.owner.kind === 'player' ? t.owner.playerId : t.owner.kind === 'neutral' ? 'neutral' : 'unknown',
  armies: t?.armies ?? null,
});

/**
 * Every target my cached orders attacked and did not take: for orders of turn T (`orders`, by the
 * turn played), the history boards T − 1 and T; a move into a territory not mine on board T − 1 that
 * is still not mine on board T. Moves into one target in one turn are one entry. Pure.
 */
export function failedAttacks(boards: Boards, orders: ReadonlyMap<number, MyOrders>, me: number): FailedAttack[] {
  const byTurn = new Map(boards.map((b) => [b.turn, b.board]));
  const out: FailedAttack[] = [];
  for (const turn of [...orders.keys()].sort((a, b) => a - b)) {
    const was = byTurn.get(turn - 1);
    const now = byTurn.get(turn);
    if (!was || !now) continue;
    const before = new Map(was.territories.map((t) => [t.territoryId, t]));
    const after = new Map(now.territories.map((t) => [t.territoryId, t]));
    const hits = new Map<number, { from: Set<number>; sent: number }>();
    for (const m of orders.get(turn)!.moves) {
      if (ownerOf(before.get(m.to)) === me || ownerOf(after.get(m.to)) === me) continue;
      const h = hits.get(m.to) ?? { from: new Set<number>(), sent: 0 };
      h.from.add(m.from);
      h.sent += Math.max(0, m.armies);
      hits.set(m.to, h);
    }
    for (const [to, h] of [...hits].sort(([a], [b]) => a - b))
      out.push({ turn, to, from: [...h.from].sort((a, b) => a - b), sent: h.sent, before: side(before.get(to)), after: side(after.get(to)) });
  }
  return out;
}

/** What {@link captureFinished} reads. */
export interface CaptureInput {
  /** The map's graph (bonus overrides applied); absent when no map was had, and no income is computed. */
  graph?: MapGraph | undefined;
  settings: Pick<GameSettings, 'minimumArmyBonus' | 'bonusArmyPer'> | undefined;
  me: number;
  /** Every player seated, with its final state. */
  players: readonly { id: number; state?: string | undefined }[];
  /** The game's completed turns at the finish. */
  numberOfTurns: number | undefined;
  /** The history boards (empty when the history did not read). */
  boards: Boards;
  /** My cached orders by the turn played. */
  orders: ReadonlyMap<number, MyOrders>;
  /**
   * #437: the turn being played when my seat left the game (a surrender or a boot), when known from the
   * decision log's events (GameFeed); a history board cannot tell it, since such a seat keeps its land.
   */
  leftTurn?: number | null | undefined;
}

/** Outcomes in which my seat left the game, so my orders of that turn never ran (#437). */
const LEFT: ReadonlySet<FinishedOutcome> = new Set(['surrendered', 'booted']);

/**
 * The turn being played when my seat left (#437): for a surrender or a boot, `leftTurn` (the decision log's
 * events), else my out turn on the history; for an elimination, my out turn; `null` otherwise or unknown. Pure.
 */
export function leftTurnOf(result: FinishedOutcome, outTurn: number | null, leftTurn: number | null | undefined): number | null {
  if (LEFT.has(result)) return leftTurn ?? outTurn;
  return result === 'eliminated' ? outTurn : null;
}

/** A finished game's capture, by real ids (the store keys them). */
export interface FinishedCapture {
  outcome: {
    result: FinishedOutcome;
    /** The game's completed turns at the finish. */
    turn: number | null;
    /** The first history board on which I held no land after holding some; `null` when never (or no history). */
    outTurn: number | null;
    /** #437: the turn being played when my seat left ({@link leftTurnOf}); `null` when it did not, or unknown. */
    leftTurn: number | null;
    winners: number[];
  };
  starts: Map<number, number[]>;
  /** Per history board (after `afterTurn` completed turns), every player; empty without a map. */
  turns: { afterTurn: number; players: Map<number, PlayerTurn> }[];
  failedAttacks: FailedAttack[];
}

/** The whole capture of a finished game from its history boards and my orders. Pure. */
export function captureFinished(input: CaptureInput): FinishedCapture {
  const ids = input.players.map((p) => p.id).sort((a, b) => a - b);
  const boards = ascending(input.boards);
  const result = outcomeOf(input.players, input.me);
  const outTurn = outTurnOf(boards, input.me);
  const leftTurn = leftTurnOf(result, outTurn, input.leftTurn);
  // #437: my orders of the turn my seat left (a surrender or a boot) never ran: no failed attack of theirs.
  const ran = LEFT.has(result) && leftTurn !== null ? (f: FailedAttack) => f.turn < leftTurn : () => true;
  return {
    outcome: {
      result,
      turn: input.numberOfTurns ?? null,
      outTurn,
      leftTurn,
      winners: input.players.filter((p) => p.state === 'Won').map((p) => p.id).sort((a, b) => a - b),
    },
    starts: startsOf(boards, ids),
    turns: input.graph ? boards.map(({ turn, board }) => ({ afterTurn: turn, players: turnIncomes(input.graph!, board, ids, input.settings) })) : [],
    failedAttacks: failedAttacks(boards, input.orders, input.me).filter(ran),
  };
}

// ---- #437: the game's kind ----

/**
 * What kind of game a finished one was (#437): `lottery` (a map of at most `LOTTERY_MAX_TERRITORIES`
 * territories, or the lobby joined was read as one), `no-show` (I never committed a turn, or my seat was
 * booted before turn 2 was played), `legacy` (no decision log and no board cache: played before this server
 * kept either), `team`. Lottery and no-show games teach nothing, so the lessons, the map record and the
 * profile folds count them apart.
 */
export type GameKind = 'lottery' | 'no-show' | 'legacy' | 'team';
export const GAME_KINDS: readonly GameKind[] = ['lottery', 'no-show', 'legacy', 'team'];
/** The kinds kept out of the lessons, the map record and the profile folds. */
export const EXCLUDED_KINDS: readonly GameKind[] = ['lottery', 'no-show'];

/** What {@link gameKinds} reads. */
export interface KindInput {
  result: FinishedOutcome;
  /** The game's format (`profileFormatOf`). */
  team: boolean;
  /** The map's territory count, when the map was had. */
  territories?: number | undefined;
  /** The lobby joined, as the decision log's join context read it (`true`: a lottery, `null`: likely one). */
  joinLottery?: true | null | undefined;
  /** Without the map: the settings fit the lottery shape (base income 0 and overridden bonuses). */
  lotteryShape?: boolean;
  lotteryMaxTerritories: number;
  /** A decision log kept for the game. */
  hasLog: boolean;
  /** A board cache kept for the game as me. */
  hasBoards: boolean;
  /** Turns whose orders I committed (cached orders or the log's sent orders). */
  committedTurns: number;
  /** The turn being played when my seat left ({@link leftTurnOf}). */
  leftTurn: number | null;
  /** The game's completed turns at the finish. */
  numberOfTurns: number | null;
}

/** The kinds of a finished game ({@link GameKind}), in {@link GAME_KINDS} order. Pure. */
export function gameKinds(k: KindInput): GameKind[] {
  const out = new Set<GameKind>();
  const lottery =
    k.territories !== undefined ? k.territories <= k.lotteryMaxTerritories : k.joinLottery !== undefined || k.lotteryShape === true;
  if (lottery) out.add('lottery');
  const legacy = !k.hasLog && !k.hasBoards;
  // Never committed: only where this server kept the game (a legacy game's orders were never cached).
  const neverCommitted = !legacy && k.committedTurns === 0 && k.result !== 'won';
  // Booted before turn 2 was played: seen booted while turn 1 or 2 was being played (a boot at turn 1's
  // deadline is first seen on turn 2), or the game ended with at most one turn completed.
  const bootedEarly = k.result === 'booted' && ((k.leftTurn !== null && k.leftTurn <= 2) || (k.numberOfTurns !== null && k.numberOfTurns <= 1));
  if (neverCommitted || bootedEarly) out.add('no-show');
  if (legacy) out.add('legacy');
  if (k.team) out.add('team');
  return GAME_KINDS.filter((x) => out.has(x));
}

/** The kind a game is kept apart for (lottery first), or `undefined` when it counts. Pure. */
export function excludedKind(kinds: readonly GameKind[]): 'lottery' | 'no-show' | undefined {
  return kinds.includes('lottery') ? 'lottery' : kinds.includes('no-show') ? 'no-show' : undefined;
}
