// #386: what the player learnt in diplomacy and wants every plan to apply, kept per game in the agreement
// ledger (src/relations-store.ts) by `warapp_record_intel`: territories promised to someone, players I
// promised not to attack outside any truce (with a reason from a fixed list: the ledger is name-free, no
// message), and a player's stated income with the turn it was stated. `warapp_plan_turn` and
// `warapp_check_plan` apply them by default (`resolveIntel`); an explicit `avoid_territories`,
// `avoid_players` or `known_income` replaces the stored list of its kind for that call, and a stored
// income older than `INCOME_STALE_TURNS` turns is not applied (the estimate stands, with a warning). Pure.

import type { KnownIncome } from './plan/shared.js';

/** Why a player is not to be attacked: a fixed list, so the ledger holds no free text. */
export const AVOID_REASONS = ['promised', 'asked-by-them', 'joint-enemy', 'kingmaker', 'other'] as const;
export type AvoidReason = (typeof AVOID_REASONS)[number];

/** A stored income is applied while `turn - statedTurn` is at most this; older, the estimate stands. */
export const INCOME_STALE_TURNS = 3;

export interface AvoidTerritoryIntel {
  territory: number;
  /** The turn it was recorded. */
  turn: number;
  /** The player it was promised to, when one. */
  promisedTo?: number;
}
export interface AvoidPlayerIntel {
  player: number;
  turn: number;
  reason: AvoidReason;
}
export interface IncomeIntel {
  player: number;
  income: number;
  /** The turn the income was stated. */
  turn: number;
}

/** The intel kept in a game's ledger. */
export interface StoredIntel {
  avoidTerritories: AvoidTerritoryIntel[];
  avoidPlayers: AvoidPlayerIntel[];
  incomes: IncomeIntel[];
}

export const emptyIntel = (): StoredIntel => ({ avoidTerritories: [], avoidPlayers: [], incomes: [] });
export const intelIsEmpty = (i: StoredIntel | undefined): boolean =>
  !i || (i.avoidTerritories.length === 0 && i.avoidPlayers.length === 0 && i.incomes.length === 0);

/** The per-call arguments, as the tools take them. */
export interface IntelArgs<T> {
  knownIncome?: readonly KnownIncome[];
  avoidTerritories?: readonly T[];
  avoidPlayers?: readonly number[];
}

/** What the plan reports of the stored intel (`intel`). */
export interface IntelReport {
  /** Stored entries the call applied. */
  applied: {
    avoidTerritories: { territory: number; promisedTo?: number }[];
    avoidPlayers: { player: number; reason: AvoidReason }[];
    knownIncome: { player: number; income: number; statedTurn: number }[];
  };
  /** Kinds an explicit argument replaced. */
  overridden: ('avoid_territories' | 'avoid_players' | 'known_income')[];
  /** Stored incomes too old to apply: the estimate stands for them. */
  stale: { player: number; income: number; statedTurn: number; turnsOld: number }[];
}

export interface ResolvedIntel<T> {
  knownIncome?: KnownIncome[];
  avoidTerritories?: (T | number)[];
  avoidPlayers?: number[];
  /** Absent when nothing is stored. */
  report?: IntelReport;
  warnings: string[];
}

/**
 * The arguments a plan uses: each kind given explicitly as it is, else the stored entries (incomes only
 * while fresh on `turn`; `null` turn: every stored income applies, none can be judged stale).
 */
export function resolveIntel<T>(stored: StoredIntel | undefined, turn: number | null, args: IntelArgs<T>): ResolvedIntel<T> {
  const out: ResolvedIntel<T> = {
    ...(args.knownIncome !== undefined ? { knownIncome: [...args.knownIncome] } : {}),
    ...(args.avoidTerritories !== undefined ? { avoidTerritories: [...args.avoidTerritories] } : {}),
    ...(args.avoidPlayers !== undefined ? { avoidPlayers: [...args.avoidPlayers] } : {}),
    warnings: [],
  };
  if (intelIsEmpty(stored)) return out;
  const s = stored!;
  const report: IntelReport = { applied: { avoidTerritories: [], avoidPlayers: [], knownIncome: [] }, overridden: [], stale: [] };

  if (s.avoidTerritories.length) {
    if (args.avoidTerritories !== undefined) report.overridden.push('avoid_territories');
    else {
      report.applied.avoidTerritories = s.avoidTerritories.map((a) => ({ territory: a.territory, ...(a.promisedTo !== undefined ? { promisedTo: a.promisedTo } : {}) }));
      out.avoidTerritories = s.avoidTerritories.map((a) => a.territory);
    }
  }
  if (s.avoidPlayers.length) {
    if (args.avoidPlayers !== undefined) report.overridden.push('avoid_players');
    else {
      report.applied.avoidPlayers = s.avoidPlayers.map((a) => ({ player: a.player, reason: a.reason }));
      out.avoidPlayers = s.avoidPlayers.map((a) => a.player);
    }
  }
  if (s.incomes.length) {
    if (args.knownIncome !== undefined) report.overridden.push('known_income');
    else {
      const fresh: IncomeIntel[] = [];
      for (const i of s.incomes) {
        const age = turn === null ? 0 : turn - i.turn;
        if (age > INCOME_STALE_TURNS) report.stale.push({ player: i.player, income: i.income, statedTurn: i.turn, turnsOld: age });
        else fresh.push(i);
      }
      report.applied.knownIncome = fresh.map((i) => ({ player: i.player, income: i.income, statedTurn: i.turn }));
      if (fresh.length) out.knownIncome = fresh.map((i) => ({ player: i.player, income: i.income, source: 'chat' as const }));
    }
  }

  for (const st of report.stale)
    out.warnings.push(
      `The income ${st.income} recorded for player ${st.player} (stated on turn ${st.statedTurn}) is ${st.turnsOld} turns old, past ` +
        `${INCOME_STALE_TURNS}: it is not applied and the estimate stands. Record a fresh figure with warapp_record_intel, or forget it.`,
    );
  const a = report.applied;
  const parts = [
    ...(a.avoidTerritories.length ? [`avoids territor${a.avoidTerritories.length === 1 ? 'y' : 'ies'} ${a.avoidTerritories.map((t) => t.territory).join(', ')}`] : []),
    ...(a.avoidPlayers.length ? [`avoids player${a.avoidPlayers.length === 1 ? '' : 's'} ${a.avoidPlayers.map((p) => p.player).join(', ')}`] : []),
    ...(a.knownIncome.length ? [`takes the stated income of player${a.knownIncome.length === 1 ? '' : 's'} ${a.knownIncome.map((k) => `${k.player} (${k.income}, turn ${k.statedTurn})`).join(', ')}`] : []),
  ];
  if (parts.length) out.warnings.push(`Recorded intel (warapp_record_intel) applied: the plan ${parts.join('; ')}. Pass the argument explicitly to override it for this call.`);
  out.report = report;
  return out;
}
