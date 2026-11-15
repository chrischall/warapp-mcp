// The opponent-profile hook (docs/PLAN-PROFILES.md A2): every tool that caches a board calls
// `recordProfile` right after `writeBoardCache` (warapp_plan_turn never on a what-if plan), so the
// turns its boards show are observed and kept (src/profile-store.ts). Best effort, never throws.
// Its own module so src/tools/turn.ts can call it without importing the tool that imports turn.ts.
import type { EnvSource } from '@chrischall/mcp-utils';
import type { ObserveInput } from '../analysis/opponent-profile.js';
import type { TurnBoard } from '../analysis/opponents.js';
import type { Game, Player } from '../normalize.js';
import { recordBehaviour } from '../profile-store.js';
import { teammatesOf } from '../teams.js';
import { graphOf } from './common.js';
import { mapOf } from './map.js';

/** The combat settings an observation reads, from the game's settings. */
export function observeSettings(game: Game): ObserveInput['settings'] {
  const s = game.settings;
  return {
    ...(s?.offensiveKillRate !== undefined ? { offensiveKillRate: s.offensiveKillRate } : {}),
    ...(s?.defensiveKillRate !== undefined ? { defensiveKillRate: s.defensiveKillRate } : {}),
    ...(s?.luckModifier !== undefined ? { luckModifier: s.luckModifier } : {}),
    ...(s?.roundingMode !== undefined ? { roundingMode: s.roundingMode } : {}),
    ...(s?.oneArmyStandsGuard !== undefined ? { oneArmyStandsGuard: s.oneArmyStandsGuard } : {}),
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
 * my orders attached) and store each turn. Nothing without a data directory, or with
 * `WARAPP_PLAYER_PROFILE=off`. Never throws.
 */
export async function recordProfile(
  dataDir: string | undefined,
  env: EnvSource | undefined,
  game: Game,
  me: Player,
  boards: readonly TurnBoard[],
): Promise<void> {
  if (!dataDir) return;
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
        boards,
      },
      env ?? process.env,
    );
  } catch {
    // Best effort: profiling never blocks a tool.
  }
}

