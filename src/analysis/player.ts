// One player's view of a board: income, bonuses closest to completion, and
// visible threats. Pure: consumes a source-agnostic BoardState only.

import type { BoardState, TerritoryOwner, TerritoryState } from '../board.js';
import type { GameSettings } from '../normalize.js';
import { bonusTerritories } from './bonuses.js';
import { armiesToTake, DEFAULT_DEFENSIVE_KILL_RATE, DEFAULT_OFFENSIVE_KILL_RATE } from './combat.js';
import { neighborsOf, type MapGraph } from './graph.js';

/** Warzone's default base income when the settings do not say. */
export const DEFAULT_BASE_INCOME = 5;

export interface Income {
  base: number;
  /** From the "one army per N territories" setting, when on. */
  perTerritory: number;
  bonuses: { bonusId: number; name: string; value: number }[];
  total: number;
}

export interface MissingTerritory {
  territoryId: number;
  name: string;
  owner: TerritoryOwner;
  /** Visible armies, `null` when fogged or absent from the board. */
  armies: number | null;
  /** Attacking armies needed, `null` when armies are unknown. */
  armiesToTake: number | null;
}

export interface BonusProgress {
  bonusId: number;
  name: string;
  value: number;
  territoryCount: number;
  ownedCount: number;
  missing: MissingTerritory[];
  missingCounts: { neutral: number; enemy: number; unknown: number };
  /** Sum of `armiesToTake` over missing territories whose armies are visible. */
  armiesNeeded: number;
  /** `false` when some missing territory's armies are unknown (so `armiesNeeded` is a lower bound). */
  armiesNeededComplete: boolean;
}

export interface Threat {
  territoryId: number;
  name: string;
  playerId: number;
  armies: number;
  /** My territories it borders, sorted. */
  adjacentTo: number[];
}

export interface PlayerAnalysis {
  playerId: number;
  boardVerified: boolean;
  territoryCount: number;
  /** Visible armies on my territories. */
  armies: number;
  heldBonusIds: number[];
  income: Income;
  closestBonuses: BonusProgress[];
  threats: Threat[];
  /** Plain-language caveats that apply to these numbers. */
  assumptions: string[];
}

export interface PlayerAnalysisOptions {
  /** Max bonuses in `closestBonuses` (default 10). */
  limit?: number;
}

const UNKNOWN: TerritoryState['owner'] = { kind: 'unknown' };

export function analyzePlayer(
  g: MapGraph,
  board: BoardState,
  playerId: number,
  settings?: GameSettings,
  opts: PlayerAnalysisOptions = {},
): PlayerAnalysis {
  const limit = opts.limit ?? 10;
  const byId = new Map(board.territories.map((t) => [t.territoryId, t]));
  const isMine = (id: number) => {
    const o = byId.get(id)?.owner;
    return o?.kind === 'player' && o.playerId === playerId;
  };
  const mineIds = board.territories
    .filter((t) => g.territoryById.has(t.territoryId) && isMine(t.territoryId))
    .map((t) => t.territoryId)
    .sort((a, b) => a - b);
  const mineSet = new Set(mineIds);
  const armies = mineIds.reduce((s, id) => s + (byId.get(id)!.armies ?? 0), 0);

  const rates = {
    offensiveKillRate: settings?.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE,
    defensiveKillRate: settings?.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE,
  };

  // ---- income ----
  const base = settings?.minimumArmyBonus ?? DEFAULT_BASE_INCOME;
  const per = settings?.bonusArmyPer ?? 0;
  const perTerritory = per > 0 ? Math.floor(mineIds.length / per) : 0;
  const held: Income['bonuses'] = [];
  const progress: BonusProgress[] = [];
  for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
    const ts = bonusTerritories(g, b.id);
    if (!ts.length) continue;
    const owned = ts.filter((t) => mineSet.has(t)).length;
    if (owned === ts.length) {
      held.push({ bonusId: b.id, name: b.name, value: b.value });
      continue;
    }
    if (b.value <= 0) continue;
    const missingIds = ts.filter((t) => !mineSet.has(t));
    const reachable = owned > 0 || missingIds.some((t) => neighborsOf(g, t).some((n) => mineSet.has(n)));
    if (!reachable) continue;
    const counts = { neutral: 0, enemy: 0, unknown: 0 };
    let needed = 0;
    let complete = true;
    const missing = missingIds.map((t): MissingTerritory => {
      const st = byId.get(t);
      const owner = st?.owner ?? UNKNOWN;
      const visible = st?.armies ?? null;
      if (owner.kind === 'player') counts.enemy++;
      else if (owner.kind === 'unknown') counts.unknown++;
      else counts.neutral++;
      const known = owner.kind === 'unknown' ? null : visible;
      const take = known === null ? null : armiesToTake(known, rates);
      if (take === null) complete = false;
      else needed += take;
      return { territoryId: t, name: g.territoryById.get(t)!.name, owner, armies: known, armiesToTake: take };
    });
    progress.push({
      bonusId: b.id,
      name: b.name,
      value: b.value,
      territoryCount: ts.length,
      ownedCount: owned,
      missing,
      missingCounts: counts,
      armiesNeeded: needed,
      armiesNeededComplete: complete,
    });
  }
  progress.sort(
    (a, b) =>
      a.missing.length - b.missing.length ||
      Number(b.armiesNeededComplete) - Number(a.armiesNeededComplete) ||
      a.armiesNeeded - b.armiesNeeded ||
      b.value - a.value ||
      a.bonusId - b.bonusId,
  );

  // ---- threats ----
  const threats: Threat[] = [];
  for (const t of board.territories) {
    if (t.owner.kind !== 'player' || t.owner.playerId === playerId || t.armies === null) continue;
    if (!g.territoryById.has(t.territoryId)) continue;
    const adjacentTo = neighborsOf(g, t.territoryId).filter((n) => mineSet.has(n));
    if (!adjacentTo.length) continue;
    threats.push({
      territoryId: t.territoryId,
      name: g.territoryById.get(t.territoryId)!.name,
      playerId: t.owner.playerId,
      armies: t.armies,
      adjacentTo,
    });
  }
  threats.sort((a, b) => b.armies - a.armies || a.territoryId - b.territoryId);

  // ---- assumptions ----
  const assumptions: string[] = [];
  if (!board.verified)
    assumptions.push('Board state comes from an unverified parser of the GameFeed standing; check it against the game.');
  if (settings?.offensiveKillRate === undefined || settings?.defensiveKillRate === undefined)
    assumptions.push(
      `Kill rates missing from settings; using the defaults (${DEFAULT_OFFENSIVE_KILL_RATE}% offense, ${DEFAULT_DEFENSIVE_KILL_RATE}% defense).`,
    );
  if (settings?.minimumArmyBonus === undefined)
    assumptions.push(`Base income missing from settings; using the default of ${DEFAULT_BASE_INCOME}.`);
  if (settings?.roundingMode !== undefined && settings.roundingMode !== 'StraightRound')
    assumptions.push(`Armies needed assume straight rounding; this game uses ${settings.roundingMode}.`);
  if ((settings?.luckModifier ?? 0) > 0)
    assumptions.push('Armies needed assume 0% luck; this game has luck, so outcomes can vary.');

  const heldTotal = held.reduce((s, b) => s + b.value, 0);
  return {
    playerId,
    boardVerified: board.verified,
    territoryCount: mineIds.length,
    armies,
    heldBonusIds: held.map((b) => b.bonusId),
    income: { base, perTerritory, bonuses: held, total: base + perTerritory + heldTotal },
    closestBonuses: progress.slice(0, limit),
    threats,
    assumptions,
  };
}
