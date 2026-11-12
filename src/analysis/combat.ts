// Attack arithmetic under straight rounding and no luck.

export const DEFAULT_OFFENSIVE_KILL_RATE = 60;
export const DEFAULT_DEFENSIVE_KILL_RATE = 70;

export interface KillRates {
  /** Percent of attackers that kill a defender (default 60). */
  offensiveKillRate?: number;
  /** Percent of defenders that kill an attacker (default 70). */
  defensiveKillRate?: number;
}

/**
 * Fewest attacking armies that take a territory held by `defenders` armies,
 * assuming straight rounding and 0% luck: enough to kill every defender
 * (`round(a·off) ≥ d`) with at least one survivor to move in
 * (`a − round(d·def) ≥ 1`). `null` when attackers cannot kill at all.
 */
export function armiesToTake(defenders: number, rates: KillRates = {}): number | null {
  const off = rates.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  const def = rates.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  if (defenders <= 0) return 1;
  if (off <= 0) return null;
  // round(a·off/100) ≥ d  ⇔  a·off ≥ 100d − 50 (integer-exact for integer rates).
  const toKill = Math.ceil((100 * defenders - 50) / off);
  const lost = Math.round((defenders * def) / 100);
  return Math.max(toKill, lost + 1);
}
