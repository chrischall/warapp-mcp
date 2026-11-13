// One player's view of a board: income, bonuses closest to completion, and
// visible threats. Pure: consumes a source-agnostic BoardState only.

import type { BoardState, TerritoryOwner, TerritoryState } from '../board.js';
import type { Bonus, GameSettings } from '../normalize.js';
import { bonusTerritories } from './bonuses.js';
import { armiesToTake, DEFAULT_DEFENSIVE_KILL_RATE, DEFAULT_OFFENSIVE_KILL_RATE } from './combat.js';
import { neighborsOf, type MapGraph } from './graph.js';
import { OVERRIDES_UNPARSED, overrideUncertainties } from './overrides.js';

/** Warzone's default base income when the settings do not say. */
export const DEFAULT_BASE_INCOME = 5;

export interface Income {
  /** The game's base income (MinimumArmyBonus). */
  base: number;
  /**
   * floor(territories / BonusArmyPer) when "Extra Armies for Territories" is on,
   * else 0. It REPLACES the base when larger — never adds to it (see {@link territoryIncome}).
   */
  perTerritory: number;
  bonuses: { bonusId: number; name: string; value: number }[];
  total: number;
}

/**
 * Income before bonuses: the base, or floor(territories / per) when that is
 * larger ("Extra Armies for Territories", BonusArmyPer). Read from war.app's
 * client income code, which adds floor(territories / BonusArmyPer) and then tops
 * it up to MinimumArmyBonus when smaller ("Bonus armies for N territories (if
 * more than base armies)"); live (#38): base 4, per 1, 1 territory paid 4, and
 * base 20, per 1, 164 territories paid 164; base 2, per 1, 3 territories
 * refused 5 and accepted 3. `per` 0 (or less) is off.
 */
export function territoryIncome(territories: number, base: number, per: number): number {
  return per > 0 ? Math.max(base, Math.floor(territories / per)) : base;
}

/** The income settings {@link boardIncome} needs: base (MinimumArmyBonus) and BonusArmyPer (0 = off). */
export interface IncomeRules {
  base: number;
  per: number;
}

interface BonusMembers {
  bonus: Bonus;
  /** Its territories, member bonuses flattened ({@link bonusTerritories}). */
  territories: readonly number[];
}
const inIdOrder = new WeakMap<MapGraph, { from: readonly Bonus[]; count: number; sorted: readonly BonusMembers[] }>();

/**
 * A graph's bonuses in id order, each with its territories, remembered per graph: the pick
 * advisor asks for the income thousands of times in one plan, and sorting a large map's bonuses
 * and looking each one's territories up every time was a quarter of it. Built again when the
 * map's bonus list is replaced or changes length.
 */
function bonusesInIdOrder(g: MapGraph): readonly BonusMembers[] {
  const from = g.map.bonuses;
  const hit = inIdOrder.get(g);
  if (hit && hit.from === from && hit.count === from.length) return hit.sorted;
  const sorted = [...from]
    .sort((x, y) => x.id - y.id)
    .map((bonus) => ({ bonus, territories: bonusTerritories(g, bonus.id) }));
  inIdOrder.set(g, { from, count: from.length, sorted });
  return sorted;
}

/**
 * THE income rule (#85): every income figure — warapp_plan_turn's income, warapp_submit_turn's
 * deploy check, warapp_analyze_board, the planner's next income and per-opponent estimate, the
 * picks budget — comes from here, so they cannot disagree. War.app's client income code
 * (docs/WARAPP-API.md, verified from the bundle): max(base, floor(territories / per)), plus the
 * value of EVERY bonus all of whose territories are held — each counted once, whatever it
 * overlaps; a superbonus is one more bonus over all its member territories (flattened, a member
 * id read as a territory first); 0-value bonuses add nothing; negative ones subtract — and never
 * below 0 (the client zeroes the income when the negatives reach it). Card armies come on top
 * (not modelled here: a play is a choice, see `incomeFor` callers). Bonus values are the map's
 * as given: the tools' `mapOf` has already applied the game's `OverriddenBonuses`.
 */
export function boardIncome(g: MapGraph, held: ReadonlySet<number>, rules: IncomeRules): Income {
  let territories = 0;
  for (const t of held) if (g.territoryById.has(t)) territories++;
  const perTerritory = rules.per > 0 ? Math.floor(territories / rules.per) : 0;
  const bonuses: Income['bonuses'] = [];
  for (const { bonus: b, territories: ts } of bonusesInIdOrder(g)) {
    // The first territory settles most bonuses without walking the rest.
    if (ts.length && held.has(ts[0]!) && ts.every((t) => held.has(t)))
      bonuses.push({ bonusId: b.id, name: b.name, value: b.value });
  }
  const total = Math.max(0, territoryIncome(territories, rules.base, rules.per) + bonuses.reduce((s, b) => s + b.value, 0));
  return { base: rules.base, perTerritory, bonuses, total };
}

/** {@link IncomeRules} from a game's settings (the defaults when it does not say). */
export function incomeRules(settings: Pick<GameSettings, 'minimumArmyBonus' | 'bonusArmyPer'> | undefined): IncomeRules {
  return { base: settings?.minimumArmyBonus ?? DEFAULT_BASE_INCOME, per: settings?.bonusArmyPer ?? 0 };
}

/**
 * Settings that make the income model uncertain, each as a reason: war.app's
 * income has a term the model does not compute. Empty when every income rule
 * the game uses is modelled (base, BonusArmyPer, held bonuses, card armies,
 * overridden bonus values once read — only unreadable overrides are listed).
 * Cities and per-player income mods have no known settings key, so they are
 * not detected: those games still get the hard deploy-total check. Sanctions is
 * flagged when the card is merely enabled: the live board's active-card list is
 * not decoded, so the model cannot tell whether I am sanctioned this turn
 * (docs/WARAPP-API.md, the trade-off).
 */
export function incomeUncertainties(settings: GameSettings | undefined): string[] {
  const out: string[] = [];
  if (settings?.minimumArmyBonus === undefined)
    out.push(`The game's base income is missing from its settings; the model assumes ${DEFAULT_BASE_INCOME}.`);
  if (settings?.armyCap !== undefined && settings.armyCap !== null)
    out.push(
      `This game has an army cap (${settings.armyCap}× income), which can cut income; the income model does not apply it (the planner only spends armies above the cap).`,
    );
  // Overrides that were read are applied to the map (applyBonusOverrides), so only unreadable ones make income uncertain.
  if (settings?.overriddenBonusesUnparsed) out.push(OVERRIDES_UNPARSED);
  if (settings?.cards.includes('Sanctions')) {
    const pct = settings.raw?.SanctionsCard;
    const p = isRecord(pct) && typeof pct.Percentage === 'number' ? ` by ${Math.round(pct.Percentage * 100)}%` : '';
    out.push(`This game has the Sanctions card, which cuts a sanctioned player's income${p}; the model does not apply it.`);
  }
  return out;
}

/**
 * Why warapp_submit_turn's deploy-total check must warn rather than refuse: the income
 * uncertainties plus, while the overrides' shape is unverified, a game's overrides.
 */
export function deployCheckUncertainties(settings: GameSettings | undefined): string[] {
  return [...new Set([...incomeUncertainties(settings), ...overrideUncertainties(settings)])];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
  const income = boardIncome(g, mineSet, incomeRules(settings));
  const progress: BonusProgress[] = [];
  for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
    const ts = bonusTerritories(g, b.id);
    if (!ts.length) continue;
    const owned = ts.filter((t) => mineSet.has(t)).length;
    if (owned === ts.length) continue;
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
  if (settings?.overriddenBonusesUnparsed) assumptions.push(OVERRIDES_UNPARSED);
  if ((settings?.luckModifier ?? 0) > 0)
    assumptions.push('Armies needed assume 0% luck; this game has luck, so outcomes can vary.');

  return {
    playerId,
    boardVerified: board.verified,
    territoryCount: mineIds.length,
    armies,
    heldBonusIds: income.bonuses.map((b) => b.bonusId),
    income,
    closestBonuses: progress.slice(0, limit),
    threats,
    assumptions,
  };
}
