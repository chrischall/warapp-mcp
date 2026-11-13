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

/**
 * A commander fights as this many armies, attacking and defending (the client bundle's
 * `Commander`: attack and defence power `a + 7`). It is never partially damaged — it dies
 * only to 7 damage left over after the armies with it are all killed (armies take damage
 * first; its combat order is last) — so a stack of `d` armies plus a commander falls to
 * exactly the attack that takes `d + 7` armies.
 */
export const COMMANDER_STRENGTH = 7;

/**
 * The armies the special units on a territory fight as: {@link COMMANDER_STRENGTH} per
 * commander. Bosses and custom units are not counted (their strength is per-unit data the
 * board does not carry).
 */
export function specialUnitStrength(units: readonly { kind: string }[] | undefined): number {
  return (units ?? []).reduce((n, u) => n + (u.kind === 'commander' ? COMMANDER_STRENGTH : 0), 0);
}

// ---- the exact model (S2) ----
//
// The rule, from the client bundle's shared combat code (`docs/WARAPP-API.md`, "Combat"):
// n armies at kill rate r (a fraction) and luck L kill
//   x = (1 − L)·n·r + L·G,   G ~ Binomial(n, r)   (each army kills with probability r)
// rounded: straight rounding takes round-half-up(x); weighted-random rounding takes
// floor(x) + 1 with probability frac(x), else floor(x). Attackers and defenders fight at
// once; the attack captures when the attackers kill every defender and at least one
// attacker survives the defenders' kills.

export type RoundingMode = 'StraightRound' | 'WeightedRandom';

export interface CombatSettings extends KillRates {
  /** Luck modifier: a fraction (0.16) or a percent (16). Default 0. */
  luck?: number;
  /** Default `StraightRound`; anything other than `WeightedRandom` is straight. */
  rounding?: RoundingMode | string;
}

/** A luck modifier as a fraction in [0, 0.95] (a value above 1 is read as a percent). */
export function luckFraction(v: number | undefined): number {
  if (!v || v <= 0) return 0;
  const f = v > 1 ? v / 100 : v;
  return Math.min(f, 0.95);
}

const weighted = (rounding: string | undefined) => rounding === 'WeightedRandom';

/** ln(k!) for k = 0..n, memoised. */
const logFact: number[] = [0];
function lnFact(k: number): number {
  for (let i = logFact.length; i <= k; i++) logFact.push(logFact[i - 1]! + Math.log(i));
  return logFact[k]!;
}

function binomial(n: number, k: number, p: number): number {
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k === n ? 1 : 0;
  return Math.exp(lnFact(n) - lnFact(k) - lnFact(n - k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

/**
 * The probability that `n` armies at `ratePct`% kill at least `k` (`atLeast`) or at most `k`
 * (`!atLeast`). Summed over the binomial outcomes as 1 − (the failing mass), so a certain
 * outcome is exactly 1 and an impossible one exactly 0.
 */
function killProbability(n: number, ratePct: number, luck: number, rounding: string | undefined, k: number, atLeast: boolean): number {
  const r = ratePct / 100;
  const f = n * r;
  /** P(the kills meet the bound | the expected-plus-random share is x). */
  const meets = (x: number): number => {
    if (weighted(rounding)) {
      const lo = Math.floor(x);
      const frac = x - lo;
      const pUp = frac > 0 ? frac : 0;
      // kills = lo + 1 with pUp, else lo.
      const okLo = atLeast ? lo >= k : lo <= k;
      const okHi = atLeast ? lo + 1 >= k : lo + 1 <= k;
      return (okLo ? 1 - pUp : 0) + (okHi ? pUp : 0);
    }
    const kills = Math.round(x);
    return (atLeast ? kills >= k : kills <= k) ? 1 : 0;
  };
  if (luck === 0) return meets(f);
  let fail = 0;
  let pass = 0;
  for (let g = 0; g <= n; g++) {
    const m = meets(f + (g - f) * luck);
    const p = binomial(n, g, r);
    if (m < 1) fail += p * (1 - m);
    if (m > 0) pass += p * m;
  }
  if (fail === 0) return 1;
  if (pass === 0) return 0;
  return Math.min(1, Math.max(0, 1 - fail));
}

/**
 * The exact probability that `attackers` armies capture a territory held by `defenders`:
 * every defender dies and at least one attacker survives. Summed over the binomial
 * distributions — no simulation, no randomness. Exactly 1 when the capture is certain
 * (0% luck under straight rounding is always 0 or 1).
 */
export function winChance(attackers: number, defenders: number, settings: CombatSettings = {}): number {
  if (attackers <= 0) return 0;
  if (defenders <= 0) return 1;
  const off = settings.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  const def = settings.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  if (off <= 0) return 0;
  const luck = luckFraction(settings.luck);
  const kill = killProbability(attackers, off, luck, settings.rounding, defenders, true);
  if (kill === 0) return 0;
  const survive = killProbability(defenders, def, luck, settings.rounding, attackers - 1, false);
  return kill * survive;
}

/**
 * The kills `n` armies at `ratePct`% make whatever the dice: the expected share
 * `(1 − luck)·n·rate` alone, rounded half up (straight) or down (weighted-random, which only
 * guarantees the floor).
 */
export function guaranteedKills(n: number, ratePct: number, luck = 0, rounding: RoundingMode | string = 'StraightRound'): number {
  if (n <= 0 || ratePct <= 0) return 0;
  const x = (1 - luckFraction(luck)) * n * (ratePct / 100);
  return weighted(rounding) ? Math.floor(x) : Math.round(x);
}

/**
 * The smallest attack larger than `n` that guarantees one more kill at `ratePct`%;
 * `null` when no size ever kills (a zero rate).
 */
export function nextBreakpoint(n: number, ratePct: number, luck = 0, rounding: RoundingMode | string = 'StraightRound'): number | null {
  if (ratePct <= 0 || luckFraction(luck) >= 1) return null;
  const now = guaranteedKills(Math.max(0, n), ratePct, luck, rounding);
  let m = Math.max(0, n) + 1;
  while (guaranteedKills(m, ratePct, luck, rounding) <= now) m++;
  return m;
}

/**
 * The efficient attack sizes up to `upTo`: each size that guarantees one more kill than the
 * size below it (e.g. 1, 3, 5, 6, 8, 10, 11, 13 at 60%). Any size between two of them kills
 * no more than the smaller one.
 */
export function killBreakpoints(ratePct: number, upTo: number, luck = 0, rounding: RoundingMode | string = 'StraightRound'): number[] {
  const out: number[] = [];
  for (let m = 1; m <= upTo; m++)
    if (guaranteedKills(m, ratePct, luck, rounding) > guaranteedKills(m - 1, ratePct, luck, rounding)) out.push(m);
  return out;
}

/**
 * The fewest attackers whose {@link winChance} reaches `minChance` against `defenders`;
 * `null` when attackers cannot kill at all.
 */
export function armiesForChance(defenders: number, minChance: number, settings: CombatSettings = {}): number | null {
  if (defenders <= 0) return 1;
  if ((settings.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE) <= 0) return null;
  const ok = (n: number) => winChance(n, defenders, settings) >= minChance;
  // winChance is monotone in the attackers: double, then bisect.
  let hi = Math.max(1, defenders);
  while (!ok(hi)) {
    hi *= 2;
    if (hi > 1_000_000) return null;
  }
  let lo = 0;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}
