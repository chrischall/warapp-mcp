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
interface IncomeRules {
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

/**
 * The army cap's cut (#253): what war.app pays when the game has an army cap.
 *
 * From the client bundle's income function (read-only): after base, bonuses and cities, and before
 * Sanctions and the Reinforcement card armies, the income is cut to the room left under the cap —
 * `round(cap × income) − my armies on the board`, floored at 0, where the rounding is to the nearest
 * with .5 down and the armies are the plain army counts of my territories in the turn's standing
 * (special units not counted). So `received = min(income, max(0, round(cap × income) − armies))`.
 * Verified by two live cases (2026-11-15), each exact to the army: 8× income 52 with 375 armies paid 41
 * (a deploy of 52 drew error 11, 41 committed), and the next turn 8× income 56 with 399 armies paid 49 —
 * the cap is taken on this turn's income (last turn's 52 would have left 17). The client's in-game guide says Reinforcement card armies are not income and always
 * pay in full, so callers add them after this (they neither raise the limit nor are cut).
 */
export interface ArmyCapIncome {
  /** The income before the cap. */
  uncapped: number;
  /** The game's ArmyCap (× income). */
  cap: number;
  /** My armies on the board at the start of the turn (special units out). */
  armies: number;
  /** round(cap × uncapped), .5 down: the most armies the cap lets me reach. */
  limit: number;
  /** What war.app pays: min(uncapped, max(0, limit − armies)). */
  received: number;
  /** The cap cuts this turn's income (`received < uncapped`). */
  cut: boolean;
}

/** To the nearest integer, a half rounded down (the client's round for the cap; x ≥ 0 here). */
function roundHalfDown(x: number): number {
  return Math.ceil(x - 0.5);
}

/** {@link ArmyCapIncome} for an income, a game's cap and my armies on the board; `undefined` with no cap. */
export function armyCapIncome(income: number, cap: number | null | undefined, armies: number): ArmyCapIncome | undefined {
  if (cap === null || cap === undefined || !(cap > 0)) return undefined;
  const limit = roundHalfDown(cap * income);
  const received = Math.min(income, Math.max(0, limit - armies));
  return { uncapped: income, cap, armies, limit, received, cut: received < income };
}

/**
 * The army cap's arithmetic in one clause, e.g. "8 × 52 = 416, less your 375 armies on the board, is 41";
 * over the cap, floored like the income: "…, is 0 (over the cap by 4)".
 */
export function armyCapText(c: ArmyCapIncome): string {
  const room = c.limit - c.armies;
  return `${c.cap} × ${c.uncapped} = ${c.limit}, less your ${c.armies} armies on the board, is ${Math.max(0, room)}${
    room < 0 ? ` (over the cap by ${-room})` : ''
  }`;
}

/**
 * J1 review: under Local Deployment, why the bonus pools are a guess when the army cap cuts my income.
 * The cut total is modelled, but how war.app takes it out of the pools is not known: the pool model
 * (`deployPools`, local-deploy.ts) trims the outermost pools first, an assumption. So the pool check only warns
 * and the plan says so, as for Sanctions under Local Deployment. `undefined` without a cut.
 */
export function armyCapPoolsUncertainty(c: ArmyCapIncome | undefined, localDeployments: boolean | undefined): string | undefined {
  if (!localDeployments || !c?.cut) return undefined;
  return (
    `Local Deployment: the army cap cuts your income from ${c.uncapped} to ${c.received}, and which bonus pools the ` +
    `${c.uncapped - c.received} come out of is not known (the model takes them from the outermost pools first, a guess): ` +
    "deploy as the game's deploy panel shows."
  );
}

/** Why the army cap's figure is not certain: two live cases, and the card armies' place (from the client's guide). */
export const ARMY_CAP_BASIS =
  "the formula rests on two live cases (2026-11-15), the cap taken on this turn's income; Reinforcement card armies are outside it (the client's guide: they are not income and always pay in full, unverified live)";

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
 * flagged when the card is merely enabled: the live board's active-card decoder is
 * unverified (#163), so the model cannot be sure whether I am sanctioned this turn
 * (docs/WARAPP-API.md, the trade-off). With `sanctionsApplied` (PLAN-TEAMS D3: the
 * income already carries the Sanctions read on me) the reason says so instead. An army cap is
 * modelled ({@link armyCapIncome}, #253) but rests on two live cases, so it stays listed: with
 * `armyCap` (the figure the caller applied) the reason states its arithmetic.
 */
export function incomeUncertainties(
  settings: GameSettings | undefined,
  opts: { sanctionsApplied?: boolean; armyCap?: ArmyCapIncome } = {},
): string[] {
  const out: string[] = [];
  if (settings?.minimumArmyBonus === undefined)
    out.push(`The game's base income is missing from its settings; the model assumes ${DEFAULT_BASE_INCOME}.`);
  if (settings?.armyCap !== undefined && settings.armyCap !== null) {
    const c = opts.armyCap;
    out.push(
      c
        ? `This game has an army cap (${c.cap}× income): ${armyCapText(c)}: ${
            c.cut ? `income ${c.received}, not ${c.uncapped}` : `no cut, income ${c.received}`
          }; ${ARMY_CAP_BASIS}.`
        : `This game has an army cap (${settings.armyCap}× income): the income received is min(income, ${settings.armyCap} × income − your armies on the board) at the start of the turn; ${ARMY_CAP_BASIS}.`,
    );
  }
  // Overrides that were read are applied to the map (applyBonusOverrides), so only unreadable ones make income uncertain.
  if (settings?.overriddenBonusesUnparsed) out.push(OVERRIDES_UNPARSED);
  if (settings?.cards.includes('Sanctions')) {
    const pct = settings.raw?.SanctionsCard;
    const p = isRecord(pct) && typeof pct.Percentage === 'number' ? ` by ${Math.round(pct.Percentage * 100)}%` : '';
    out.push(
      opts.sanctionsApplied
        ? `the Sanctions on you${p} are applied as read from the board by an unverified decoder (#163).`
        : `This game has the Sanctions card, which cuts a sanctioned player's income${p}; the model does not apply it.`,
    );
  }
  return out;
}

/**
 * Why warapp_submit_turn's deploy-total check must warn rather than refuse: the income
 * uncertainties plus, while the overrides' shape is unverified, a game's overrides.
 */
export function deployCheckUncertainties(
  settings: GameSettings | undefined,
  opts: { sanctionsApplied?: boolean; armyCap?: ArmyCapIncome } = {},
): string[] {
  return [...new Set([...incomeUncertainties(settings, opts), ...overrideUncertainties(settings)])];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface MissingTerritory {
  territoryId: number;
  name: string;
  owner: TerritoryOwner;
  /** Visible armies, `null` when fogged or absent from the board. */
  armies: number | null;
  /** Attacking armies needed, `null` when armies are unknown. */
  armiesToTake: number | null;
}

interface BonusProgress {
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

interface PlayerAnalysis {
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

interface PlayerAnalysisOptions {
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
