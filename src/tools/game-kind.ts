// #437: a finished game's kind (lottery, no-show, legacy, team) from what was read and what this server
// kept of it, shared by the end-of-game pass (the record's `kinds`) and every profile fold (`foldFinished`),
// so a lottery or no-show game is kept out of the profiles whichever tool reads it first. Never throws.
import { excludedKind, gameKinds, leftTurnOf, outcomeOf, type FinishedCapture, type GameKind } from '../analysis/finished-game.js';
import { profileFormatOf } from '../analysis/opponent-profile.js';
import type { MyOrders } from '../analysis/opponents.js';
import { readDecisionLog, type DecisionLog, type GameEvent } from '../decision-log.js';
import { finishedPath, readFinishedRecord } from '../finished-store.js';
import type { Game } from '../normalize.js';
import { LOTTERY_MAX_TERRITORIES } from '../open-games.js';
import { playerRecordSalt } from '../player-record-store.js';
import { readCachedOrders, readCachedPlayer } from '../trend.js';

/** What this server kept of a game as me, for its kind and the turn my seat left (#437). */
export interface KeptFacts {
  log: DecisionLog | undefined;
  hasBoards: boolean;
  orders: ReadonlyMap<number, MyOrders>;
  /** The turn being played when the log saw my seat leave (my surrender once taken, or my seat booted or surrendered). */
  leftTurn: number | undefined;
}

const LEAVING: ReadonlySet<string> = new Set(['surrender-accepted', 'booted']);

/**
 * Whether a logged event is my seat leaving. My own surrender counts only once war.app shows it taken
 * (`status: 'surrendered'`): a pending one leaves the seat playing until the others accept (logged then as
 * the seat's `surrender-accepted`), and it may be undone, so its turn is not the turn my seat left.
 */
function isLeaving(e: GameEvent, me: number): boolean {
  if (e.kind === 'my-surrender') return typeof e.detail === 'object' && e.detail.status === 'surrendered' && (e.player === undefined || e.player === me);
  return LEAVING.has(e.kind) && e.player === me;
}

export async function keptFacts(dataDir: string, gameId: number, me: number): Promise<KeptFacts> {
  const hasBoards = (await readCachedPlayer(dataDir, gameId).catch(() => undefined)) === me;
  const orders = hasBoards ? await readCachedOrders(dataDir, gameId, me).catch(() => new Map<number, MyOrders>()) : new Map<number, MyOrders>();
  const log = await readDecisionLog(dataDir, gameId, me).catch(() => undefined);
  const left = (log?.events ?? [])
    .filter((e) => isLeaving(e, me))
    .map((e) => e.turn)
    .filter((t) => Number.isInteger(t));
  return { log, hasBoards, orders, leftTurn: left.length ? Math.min(...left) : undefined };
}

/** The game's kinds (#437) from what was read and what this server kept. */
export function kindsOf(game: Game | undefined, me: number, capture: FinishedCapture | undefined, facts: KeptFacts): GameKind[] {
  const committed = new Set(facts.orders.keys());
  for (const [k, e] of Object.entries(facts.log?.turns ?? {})) if (e.sent) committed.add(Number(k));
  const s = game?.settings;
  const result = capture?.outcome.result ?? (game ? outcomeOf(game.players, me) : 'unknown');
  const outTurn = capture?.outcome.outTurn ?? null;
  return gameKinds({
    result,
    team: game ? profileFormatOf(game.players) === 'team' : false,
    territories: game?.map?.territories.length,
    joinLottery: facts.log?.join?.lottery,
    lotteryShape: s?.minimumArmyBonus === 0 && (s.overriddenBonuses?.size ?? 0) > 0,
    lotteryMaxTerritories: LOTTERY_MAX_TERRITORIES,
    hasLog: facts.log !== undefined,
    hasBoards: facts.hasBoards,
    committedTurns: committed.size,
    leftTurn: capture?.outcome.leftTurn ?? leftTurnOf(result, outTurn, facts.leftTurn),
    numberOfTurns: game?.numberOfTurns ?? null,
  });
}

/**
 * Whether a finished game is kept out of the profile folds (#437): the kinds its end-of-game record keeps
 * when there is one (the pass's own verdict), else the kinds read now from the game and what this server
 * kept of it as the cached account. With no cached account (a per-game file kept by another account of
 * mine) only the game itself is read: its map's size, or the lottery settings shape. Read-only (never makes
 * the salt), no request; `undefined` on any failure, so a fold is never blocked by this check.
 */
export async function foldExclusion(dataDir: string, game: Game): Promise<'lottery' | 'no-show' | undefined> {
  try {
    const me = await readCachedPlayer(dataDir, game.id).catch(() => undefined);
    if (me !== undefined) {
      const salt = await playerRecordSalt(dataDir);
      if (salt) {
        const rec = await readFinishedRecord(finishedPath(dataDir, salt, me, game.id));
        if (typeof rec === 'object' && rec.kinds) return excludedKind(rec.kinds);
      }
      return excludedKind(kindsOf(game, me, undefined, await keptFacts(dataDir, game.id, me)));
    }
    const s = game.settings;
    return excludedKind(
      gameKinds({
        result: 'unknown',
        team: false,
        territories: game.map?.territories.length,
        lotteryShape: s?.minimumArmyBonus === 0 && (s.overriddenBonuses?.size ?? 0) > 0,
        lotteryMaxTerritories: LOTTERY_MAX_TERRITORIES,
        // Nothing kept as a known account: never a no-show from here.
        hasLog: false,
        hasBoards: false,
        committedTurns: 0,
        leftTurn: null,
        numberOfTurns: null,
      }),
    );
  } catch {
    return undefined;
  }
}
