// The opponent-profile hook (docs/PLAN-PROFILES.md A2): every tool that caches a board calls
// `recordProfile` right after `writeBoardCache` (warapp_plan_turn never on a what-if plan), so the
// turns its boards show are observed and kept (src/profile-store.ts). Best effort, never throws.
// Its own module so src/tools/turn.ts can call it without importing the tool that imports turn.ts.
import { stat, utimes } from 'node:fs/promises';
import type { EnvSource } from '@chrischall/mcp-utils';
import { quietNeighbour, type ObserveInput, type ObservedPrimitives } from '../analysis/opponent-profile.js';
import type { MapGraph } from '../analysis/graph.js';
import type { TurnBoard } from '../analysis/opponents.js';
import type { Game, Player } from '../normalize.js';
import {
  foldFinishedGame,
  observeBoards,
  profileEnabled,
  profileFileState,
  profileGameFolded,
  profileGamePath,
  profileSeatsOf,
  readProfileTurns,
  recordBehaviour,
} from '../profile-store.js';
import { teammatesOf } from '../teams.js';
import { boardCachePath, readBoardHistory, readCachedOrders, readCachedPlayer } from '../trend.js';
import { graphOf } from './common.js';
import { foldExclusion } from './game-kind.js';
import { mapOf } from './map.js';
import { keptTeams } from './team-source.js';

/** The combat settings an observation reads, from the game's settings. */
export function observeSettings(game: Game): ObserveInput['settings'] {
  const s = game.settings;
  return {
    ...(s?.offensiveKillRate !== undefined ? { offensiveKillRate: s.offensiveKillRate } : {}),
    ...(s?.defensiveKillRate !== undefined ? { defensiveKillRate: s.defensiveKillRate } : {}),
    ...(s?.luckModifier !== undefined ? { luckModifier: s.luckModifier } : {}),
    ...(s?.roundingMode !== undefined ? { roundingMode: s.roundingMode } : {}),
    ...(s?.oneArmyStandsGuard !== undefined ? { oneArmyStandsGuard: s.oneArmyStandsGuard } : {}),
    ...(s?.multiAttack !== undefined ? { multiAttack: s.multiAttack } : {}),
  };
}

/** The cards in play, when the game's settings were read (else any card may be: unstated). */
export function cardsInPlay(game: Game): { cards?: readonly string[] } {
  return game.settings ? { cards: game.settings.cards } : {};
}

/** My opponents in `game`: every other player but my teammates (teammates are never profiled). */
export function profiledOpponents(game: Game, me: Player): number[] {
  const friends = new Set(teammatesOf(game.players, me).map((p) => p.id));
  return game.players
    .filter((p) => p.id !== me.id && !friends.has(p.id))
    .map((p) => p.id)
    .sort((a, b) => a - b);
}

/**
 * The hook after each board-cache write (A2): observe `boards` (my history plus the board just read,
 * my orders attached) and store each turn. Nothing without a data directory, with
 * `WARAPP_PLAYER_PROFILE=off`, or while `teamsKnown` is false (`resolveTeams`' `known`: a game of
 * more than two seats whose teams could not be read, where any player may be my teammate, and
 * teammates are never profiled). Each write also drops what the file holds for my known teammates.
 * Never throws.
 */
export async function recordProfile(
  dataDir: string | undefined,
  env: EnvSource | undefined,
  game: Game,
  me: Player,
  boards: readonly TurnBoard[],
  teamsKnown: boolean,
): Promise<void> {
  if (!dataDir || !teamsKnown) return;
  try {
    await recordBehaviour(
      dataDir,
      {
        gameId: game.id,
        me: me.id,
        graph: graphOf(mapOf(game)),
        settings: observeSettings(game),
        ...cardsInPlay(game),
        opponents: profiledOpponents(game, me),
        teammates: teammatesOf(game.players, me).map((p) => p.id),
        boards,
        // Kept for a fold by the age rule, when no read shows the game finished (B2).
        seats: profileSeatsOf(game),
      },
      env ?? process.env,
    );
  } catch {
    // Best effort: profiling never blocks a tool.
  }
}


/**
 * #420 (P1 amended, owner decision of 2026-11-20): the quiet neighbours the planner may size at their
 * stack plus their largest top-up (`PlanInput.quiet`). This game's kept turns (`readProfileTurns`) with
 * the turns `boards` show observed afresh over them (`observeBoards`: the board just read included, so an
 * attack on me last turn restores full sizing at once, before the hook keeps it), each opponent read by
 * `quietNeighbour`. Nothing without a data directory, with `WARAPP_PLAYER_PROFILE=off`, or while the
 * teams are unknown (any player may be my teammate). Never throws.
 */
export async function quietNeighbours(a: {
  dataDir: string | undefined;
  env: EnvSource;
  gameId: number;
  me: number;
  graph: MapGraph;
  settings: ObserveInput['settings'];
  cards?: readonly string[] | undefined;
  opponents: readonly number[];
  boards: readonly TurnBoard[];
  teamsKnown: boolean;
}): Promise<{ player: number; contactTurns: number; attacks: number }[]> {
  if (!a.dataDir || !a.teamsKnown || !profileEnabled(a.env)) return [];
  try {
    const kept = await readProfileTurns(a.dataDir, a.gameId, a.me, a.env);
    const fresh = observeBoards({
      gameId: a.gameId,
      me: a.me,
      graph: a.graph,
      settings: a.settings,
      ...(a.cards !== undefined ? { cards: a.cards } : {}),
      opponents: a.opponents,
      boards: a.boards,
    });
    const out: { player: number; contactTurns: number; attacks: number }[] = [];
    for (const player of [...a.opponents].sort((x, y) => x - y)) {
      const byTurn = new Map<number, ObservedPrimitives>((kept.get(player) ?? []).map((t) => [t.turn, t]));
      for (const [turn, m] of fresh) {
        const p = m.get(player);
        if (p) byTurn.set(turn, { turn, primitives: p });
      }
      const q = quietNeighbour([...byTurn.values()]);
      if (q.quiet) out.push({ player, contactTurns: q.contactTurns, attacks: q.attacks });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * {@link foldFinishedGame} for a read that shows a game finished with no fold report (warapp_wait_for_turn's
 * read, a game-ended notification): nothing for a lottery or no-show game (#437, {@link foldExclusion}).
 * The files folded, as `foldFinishedGame` counts them.
 */
export async function foldKeptProfile(dataDir: string, game: Game, env: EnvSource): Promise<number> {
  if (game.state !== 'Finished' || (await foldExclusion(dataDir, game))) return 0;
  return foldFinishedGame(dataDir, game, env);
}

/** What a finished game's fold did (#264), as warapp_get_game and warapp_profile_opponents report it. */
export type FinishedFold =
  | { status: 'off' }
  /** Folded now: `live` from the per-game file kept while it was played, `backfill` from its cached boards. */
  | { status: 'folded'; source: 'live' | 'backfill'; opponents: { id: number; turns: number }[] }
  | { status: 'already-folded' }
  | { status: 'nothing'; reason: BackfillGap; note: string };

/** Why a finished game gave nothing to fold. */
export type BackfillGap =
  | 'not-finished'
  | 'no-boards'
  | 'not-a-player'
  | 'no-turns'
  | 'teams-unknown'
  | 'no-map'
  | 'failed'
  | 'no-data-dir'
  /** #437: a lottery or no-show game, counted apart (the end-of-game pass never folds it). */
  | 'excluded';

/** The note on a finished game with nothing to fold (#264). */
export const NOTHING_TO_FOLD = 'Nothing of this game could be counted: counts start with games played on this build.';
/** The note on a fold that failed (`failed`): the turns may well be kept, and the next read tries again. */
export const FOLD_FAILED =
  "This game's turns could not be counted now (a profile store could not be read or written); the next read of the finished game tries again.";
/** The note when there is no data directory (`no-data-dir`): nothing is kept, so nothing is counted. */
export const NO_DATA_DIR = 'Nothing is kept without a data directory, so no game is counted.';

/** #437: the note on a lottery or no-show game (`excluded`). */
export const EXCLUDED_FOLD_NOTE = 'A lottery or no-show game teaches nothing of its players: it is counted apart, never folded.';

const GAP_NOTES: Partial<Record<BackfillGap, string>> = { failed: FOLD_FAILED, 'no-data-dir': NO_DATA_DIR, excluded: EXCLUDED_FOLD_NOTE };

/** The opponents and turns the per-game file of `game` holds as `me` saw it. */
async function foldedOpponents(dataDir: string, env: EnvSource, game: Game, me: number): Promise<{ id: number; turns: number }[]> {
  const turns = await readProfileTurns(dataDir, game.id, me, env);
  const seated = new Set(game.players.map((p) => p.id));
  return [...turns].filter(([id]) => seated.has(id)).map(([id, list]) => ({ id, turns: list.length })).sort((a, b) => a.id - b.id);
}

/**
 * Fold a finished game into the cross-game record (B2, #264), with no request: the per-game file kept
 * while it was played (`live`), else — a game that finished before profiles were kept, or was never
 * planned on this build — a one-time **backfill**: the boards (and my orders) the board cache holds
 * for it are observed now, kept in a per-game file marked `backfill`, and folded as `live`. Only for
 * the account whose boards were cached (a game the account played), never a teammate (teams from
 * GameFeed, two seats, or the kept team record: no game list is read, so unknown teams fold nothing),
 * never twice (a per-game file already there, or the stores already holding the game, is
 * `already-folded`). The backfilled file takes the board cache's age, so it is deleted when the board
 * cache would be (no id-bearing file outlives it). Nothing with profiling off. A fold that fails
 * (`failed`: an unreadable store, an error) and a missing data directory (`no-data-dir`) carry their
 * own notes, as does a lottery or no-show game (`excluded`, #437: {@link foldExclusion}, checked before
 * any fold, so such a game is never folded whichever tool reads it first); every other gap says counts
 * start with games played on this build. Never throws.
 */
export async function foldFinished(dataDir: string | undefined, env: EnvSource, game: Game): Promise<FinishedFold> {
  if (!profileEnabled(env)) return { status: 'off' };
  const nothing = (reason: BackfillGap): FinishedFold => ({ status: 'nothing', reason, note: GAP_NOTES[reason] ?? NOTHING_TO_FOLD });
  if (!dataDir) return nothing('no-data-dir');
  try {
    if (game.state !== 'Finished') return nothing('not-finished');
    // #437: a lottery or no-show game is counted apart by every fold, whichever tool reads it first.
    if (await foldExclusion(dataDir, game)) return nothing('excluded');
    const me = await readCachedPlayer(dataDir, game.id);
    // A per-game file kept while it was played (any account of mine): the live fold.
    const live = await foldFinishedGame(dataDir, game, env);
    if (me === undefined) return live ? { status: 'folded', source: 'live', opponents: [] } : nothing('no-boards');
    if (live) return { status: 'folded', source: 'live', opponents: await foldedOpponents(dataDir, env, game, me) };
    const mine = game.players.find((p) => p.id === me);
    if (!mine) return nothing('not-a-player');
    const state = await profileFileState(dataDir, game.id, me);
    if (state === 'folded') return { status: 'already-folded' };
    // A file kept but not folded by the live fold just now: it failed; never backfilled over.
    if (state === 'kept') return nothing('failed');
    if (await profileGameFolded(dataDir, me, game.id)) return { status: 'already-folded' };
    const teams = await keptTeams(dataDir, game);
    if (!teams.known) return nothing('teams-unknown');
    if (!game.map) return nothing('no-map');
    const resolved = teams.game;
    const seat = resolved.players.find((p) => p.id === me) ?? mine;
    const orders = await readCachedOrders(dataDir, game.id, me);
    const boards: TurnBoard[] = (await readBoardHistory(dataDir, game.id, me)).map((b) => {
      const o = orders.get(b.turn);
      return { turn: b.turn, board: b.board, ...(o ? { orders: o } : {}) };
    });
    const kept = await recordBehaviour(
      dataDir,
      {
        gameId: game.id,
        me,
        graph: graphOf(mapOf(resolved)),
        settings: observeSettings(resolved),
        ...cardsInPlay(resolved),
        opponents: profiledOpponents(resolved, seat),
        teammates: teammatesOf(resolved.players, seat).map((p) => p.id),
        boards,
        seats: profileSeatsOf(resolved),
        backfill: true,
      },
      env,
    );
    if (!kept) return nothing('no-turns');
    // The backfilled file ages with the board cache it came from.
    const path = profileGamePath(dataDir, game.id, me);
    const boardTime = await stat(boardCachePath(dataDir, game.id)).then((s) => s.mtime).catch(() => undefined);
    if (!(await foldFinishedGame(dataDir, resolved, env))) return nothing('failed');
    if (boardTime) await utimes(path, boardTime, boardTime).catch(() => undefined);
    return { status: 'folded', source: 'backfill', opponents: await foldedOpponents(dataDir, env, resolved, me) };
  } catch {
    return nothing('failed');
  }
}
