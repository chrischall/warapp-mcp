// The opponent-profile hook (docs/PLAN-PROFILES.md A2): every tool that caches a board calls
// `recordProfile` right after `writeBoardCache` (warapp_plan_turn never on a what-if plan), so the
// turns its boards show are observed and kept (src/profile-store.ts). Best effort, never throws.
// Its own module so src/tools/turn.ts can call it without importing the tool that imports turn.ts.
import { stat, utimes } from 'node:fs/promises';
import type { EnvSource } from '@chrischall/mcp-utils';
import type { ObserveInput } from '../analysis/opponent-profile.js';
import type { TurnBoard } from '../analysis/opponents.js';
import type { Game, Player } from '../normalize.js';
import {
  foldFinishedGame,
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


/** What a finished game's fold did (#264), as warapp_get_game and warapp_profile_opponents report it. */
export type FinishedFold =
  | { status: 'off' }
  /** Folded now: `live` from the per-game file kept while it was played, `backfill` from its cached boards. */
  | { status: 'folded'; source: 'live' | 'backfill'; opponents: { id: number; turns: number }[] }
  | { status: 'already-folded' }
  | { status: 'nothing'; reason: BackfillGap; note: string };

/** Why a finished game gave nothing to fold. */
export type BackfillGap = 'not-finished' | 'no-boards' | 'not-a-player' | 'no-turns' | 'teams-unknown' | 'no-map' | 'failed';

/** The note on a finished game with nothing to fold (#264). */
export const NOTHING_TO_FOLD = 'Nothing of this game could be counted: counts start with games played on this build.';

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
 * cache would be (no id-bearing file outlives it). Nothing with profiling off. Never throws.
 */
export async function foldFinished(dataDir: string, env: EnvSource, game: Game): Promise<FinishedFold> {
  if (!profileEnabled(env)) return { status: 'off' };
  const nothing = (reason: BackfillGap): FinishedFold => ({ status: 'nothing', reason, note: NOTHING_TO_FOLD });
  try {
    if (game.state !== 'Finished') return nothing('not-finished');
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
