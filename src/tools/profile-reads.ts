// The opponent reads (docs/PLAN-PROFILES.md parts A3, B and D): each opponent's habits from the turns
// kept for this game and the boards read now, pooled with its earlier finished games and shrunk toward
// the population (src/analysis/opponent-profile.ts). One computation shared by
// warapp_profile_opponents, warapp_plan_turn's `reads`, warapp_advise_diplomacy and
// warapp_scout_player's `met`. Read-only: it writes nothing (the board-caching tools keep the turns
// through src/tools/profile-hook.ts). Profiles INFORM ONLY (owner decision P1): no planner input.
import type { EnvSource } from '@chrischall/mcp-utils';
import type { MapGraph } from '../analysis/index.js';
import {
  COUNTER_PLAY,
  emptyHabits,
  estimateHabits,
  HABIT_NAMES,
  habitsOf,
  labelsOf,
  PROFILE_MIN_CONFIDENCE,
  profileFormatOf,
  type EstimatePriors,
  type HabitEstimate,
  type HabitName,
  type Habits,
  type ObservedPrimitives,
  type ProfileFormat,
  type ProfileLabel,
} from '../analysis/opponent-profile.js';
import type { TurnBoard } from '../analysis/opponents.js';
import type { BoardState } from '../board.js';
import type { Game, Player } from '../normalize.js';
import { observeBoards, profileEnabled, readProfileHistory, readProfileTurns, type ProfileHistory } from '../profile-store.js';
import { graphOf } from './common.js';
import { mapOf } from './map.js';
import { cardsInPlay, observeSettings, profiledOpponents } from './profile-hook.js';

/** One opponent's read. */
export interface OpponentRead {
  id: number;
  /** An AI seat now (`isAI` or `humanTurnedIntoAI`). */
  ai: boolean;
  /** Its observed turns in this game, oldest first. */
  turns: ObservedPrimitives[];
  /** This game's counts. */
  habits: Habits;
  estimates: Record<HabitName, HabitEstimate>;
  labels: ProfileLabel[];
  /** Earlier finished games of mine it was in (absent for an AI seat). */
  gamesMet?: number;
}

export interface OpponentReads {
  /** `WARAPP_PLAYER_PROFILE` is not `off`. */
  on: boolean;
  /** The cross-game record as read: `undefined` with no data directory or profiling off. */
  record: ProfileHistory | 'unreadable' | 'off' | undefined;
  /** Every profiled opponent (never a known teammate), ascending id. */
  reads: OpponentRead[];
}

/**
 * The reads of my opponents in `game`: the turns stored for it (when kept) and those `boards` show now,
 * with the cross-game record when the teams are known (never a possible teammate's past). Never writes.
 */
export async function readOpponents(o: {
  dataDir: string | undefined;
  env: EnvSource;
  game: Game;
  me: Player;
  teamsKnown: boolean;
  boards: readonly TurnBoard[];
}): Promise<OpponentReads> {
  const { dataDir, env, game, me, teamsKnown, boards } = o;
  const on = profileEnabled(env);
  const opponents = profiledOpponents(game, me);
  const stored = on && dataDir ? await readProfileTurns(dataDir, game.id, me.id, env) : new Map<number, ObservedPrimitives[]>();
  const fresh = observeBoards({ gameId: game.id, me: me.id, graph: graphOf(mapOf(game)), settings: observeSettings(game), ...cardsInPlay(game), opponents, boards });
  const turnsOf = (id: number): ObservedPrimitives[] => {
    const byTurn = new Map<number, ObservedPrimitives>();
    for (const t of stored.get(id) ?? []) byTurn.set(t.turn, t);
    for (const [t, m] of fresh) {
      const p = m.get(id);
      if (p) byTurn.set(t, { turn: t, primitives: p });
    }
    return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
  };
  const record = on && dataDir ? await readProfileHistory(dataDir, teamsKnown ? opponents : [], { me: me.id, gameId: game.id }, env) : undefined;
  const known = typeof record === 'object' ? record : undefined;
  const format = profileFormatOf(game.players);
  const players = new Map(game.players.map((p) => [p.id, p]));
  const reads = opponents.map((id): OpponentRead => {
    const p = players.get(id);
    const turns = turnsOf(id);
    const habits = habitsOf(turns);
    const estimates = estimateHabits(habits, priorsOf(known, format, id, Boolean(p?.isAI)));
    return {
      id,
      ai: Boolean(p?.isAI || p?.humanTurnedIntoAI),
      turns,
      habits,
      estimates,
      labels: labelsOf(estimates),
      ...(p?.isAI ? {} : { gamesMet: known?.players.get(id)?.games ?? 0 }),
    };
  });
  return { on, record, reads };
}

/** What the estimate pools with a game's counts: the player's past and the population (the AI pool for an AI seat). */
function priorsOf(known: ProfileHistory | undefined, format: ProfileFormat, id: number, ai: boolean): EstimatePriors {
  if (!known) return {};
  if (ai) return { pools: [known.pools.ai] };
  const pools = [known.pools.byFormat[format], known.pools.all].filter((x): x is Habits => x !== undefined);
  const past = known.players.get(id)?.past;
  return { pools, ...(past ? { past } : {}) };
}

/** The habits at the confidence bar, each with its value, `n` and `basis`. */
export function confidentHabits(e: Record<HabitName, HabitEstimate>): Partial<Record<HabitName, { value: number; n: number; basis: HabitEstimate['basis'] }>> {
  return Object.fromEntries(
    HABIT_NAMES.filter((n) => e[n].confidence >= PROFILE_MIN_CONFIDENCE).map((n) => [n, { value: e[n].value, n: e[n].n, basis: e[n].basis }]),
  );
}

/** The counter-play lines of `labels`. */
export const counterOf = (labels: readonly ProfileLabel[]): string[] => labels.flatMap((l) => (COUNTER_PLAY[l] ? [COUNTER_PLAY[l]] : []));

/** The players next to me on `board`, ascending. */
export function neighboursOf(graph: MapGraph, board: BoardState, me: number): number[] {
  const at = new Map(board.territories.map((t) => [t.territoryId, t]));
  const out = new Set<number>();
  for (const t of board.territories) {
    if (t.owner.kind !== 'player' || t.owner.playerId !== me) continue;
    for (const n of graph.territoryById.get(t.territoryId)?.connectedTo ?? []) {
      const o = at.get(n)?.owner;
      if (o?.kind === 'player' && o.playerId !== me) out.add(o.playerId);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The read of a player from the cross-game record alone (warapp_scout_player's `met`: no game in
 * hand, so every format's pool): games met, every habit and the labels; `undefined` when the record
 * does not hold the player, is unreadable, or profiling is off. Never throws, never writes.
 */
export async function metRead(
  dataDir: string | undefined,
  env: EnvSource,
  id: number,
): Promise<{ games: number; habits: Record<HabitName, HabitEstimate>; labels: ProfileLabel[] } | undefined> {
  if (!dataDir || !profileEnabled(env)) return undefined;
  const record = await readProfileHistory(dataDir, [id], {}, env);
  if (typeof record !== 'object') return undefined;
  const p = record.players.get(id);
  if (!p) return undefined;
  const habits = estimateHabits(emptyHabits(), { past: p.past, pools: [record.pools.all] });
  return { games: p.games, habits, labels: labelsOf(habits) };
}
