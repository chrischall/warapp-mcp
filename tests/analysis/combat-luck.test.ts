// S2: the exact combat model — win chances, guaranteed kills and kill breakpoints.
// The rule (verified from the client bundle, see docs/WARAPP-API.md "Combat"): n armies at
// kill rate r and luck L kill rnd((1 − L)·n·r + L·G), G ~ Binomial(n, r); straight rounding
// rounds half up, weighted-random rounds up with probability equal to the fraction.
import { describe, expect, it } from 'vitest';
import {
  armiesToTake,
  guaranteedKills,
  killBreakpoints,
  nextBreakpoint,
  winChance,
  type CombatSettings,
} from '../../src/analysis/combat.js';

const STD = { offensiveKillRate: 60, defensiveKillRate: 70 };
const at = (luck: number, rounding: CombatSettings['rounding'] = 'StraightRound'): CombatSettings => ({
  ...STD,
  luck,
  rounding,
});

describe('winChance — 0% luck', () => {
  it('straight rounding is certain: 1 at armiesToTake, 0 one below', () => {
    // 3 vs 2: round(1.8) = 2 kills ≥ 2; defenders kill round(1.4) = 1 of 3 → captures.
    expect(winChance(3, 2, at(0))).toBe(1);
    // 2 vs 2: round(1.2) = 1 kill < 2.
    expect(winChance(2, 2, at(0))).toBe(0);
    for (let d = 0; d <= 30; d++) {
      const n = armiesToTake(d, STD)!;
      expect(winChance(n, d, at(0))).toBe(1);
      if (n > 1) expect(winChance(n - 1, d, at(0))).toBe(0);
    }
  });

  it('1 vs 1 fails: the attacker kills the defender but the defender kills it back', () => {
    // round(0.6) = 1 ≥ 1, but round(0.7) = 1 kills the only attacker: no survivor moves in.
    expect(winChance(1, 1, at(0))).toBe(0);
    expect(winChance(2, 1, at(0))).toBe(1);
  });

  it('an empty territory falls to one army; no attackers never win', () => {
    expect(winChance(1, 0, at(0))).toBe(1);
    expect(winChance(0, 0, at(0))).toBe(0);
    expect(winChance(0, 3, at(0.5))).toBe(0);
  });

  it('weighted-random rounding: the fraction is the chance of rounding up', () => {
    // 3 vs 2: 1.8 kills → 2 with p 0.8. Defenders' 1.4 → at most 2 of 3 attackers.
    expect(winChance(3, 2, at(0, 'WeightedRandom'))).toBeCloseTo(0.8, 12);
    // 5 vs 3: 3.0 kills exactly; defenders 2.1 → 2 or 3 of 5: always a survivor.
    expect(winChance(5, 3, at(0, 'WeightedRandom'))).toBe(1);
  });
});

describe('winChance — with luck', () => {
  it('luck 0.5, straight: 1 vs 1', () => {
    // Attacker: x = 0.5·0.6 + 0.5·G, G ~ Bin(1, 0.6): x = 0.3 (p 0.4) → 0, 0.8 (p 0.6) → 1.
    //   P(kills ≥ 1) = 0.6.
    // Defender: y = 0.5·0.7 + 0.5·G', G' ~ Bin(1, 0.7): 0.35 (p 0.3) → 0, 0.85 (p 0.7) → 1.
    //   The attacker survives only when the defender kills 0: 0.3.
    // 0.6 × 0.3 = 0.18.
    expect(winChance(1, 1, at(0.5))).toBeCloseTo(0.18, 12);
  });

  it('luck 0.5, weighted: 2 vs 1', () => {
    // x = 0.6 + 0.5·G, G ~ Bin(2, 0.6): 0.6 (p 0.16), 1.1 (p 0.48), 1.6 (p 0.36).
    // P(kills ≥ 1) = 0.16·0.6 + 0.48 + 0.36 = 0.936. The defender kills at most 1 of 2.
    expect(winChance(2, 1, at(0.5, 'WeightedRandom'))).toBeCloseTo(0.936, 12);
  });

  it('luck 0.16, straight: 4 vs 3', () => {
    // x = 0.84·2.4 + 0.16·G = 2.016 + 0.16·G; round(x) ≥ 3 needs x ≥ 2.5, i.e. G = 4:
    // 0.6^4 = 0.1296. The defenders (3) never kill all 4 attackers.
    expect(winChance(4, 3, at(0.16))).toBeCloseTo(0.1296, 12);
    // 5 vs 3: x = 2.52 + 0.16·G ≥ 2.52 → always 3 kills.
    expect(winChance(5, 3, at(0.16))).toBe(1);
  });

  it('the guaranteed-margin size (ceil(cost / (1 − luck))) wins for sure under straight rounding', () => {
    for (const luck of [0.1, 0.16, 0.25, 0.5]) {
      for (let d = 1; d <= 25; d++) {
        const margin = Math.ceil(armiesToTake(d, STD)! / (1 - luck));
        expect(winChance(margin, d, at(luck))).toBe(1);
      }
    }
  });

  it('is monotone in the attackers', () => {
    for (const s of [at(0.16), at(0.5, 'WeightedRandom'), at(0, 'WeightedRandom')]) {
      let last = 0;
      for (let n = 0; n <= 20; n++) {
        const c = winChance(n, 6, s);
        expect(c).toBeGreaterThanOrEqual(last - 1e-12);
        last = c;
      }
    }
  });

  it('accepts luck as a percent too', () => {
    expect(winChance(4, 3, { ...STD, luck: 16 })).toBeCloseTo(0.1296, 12);
  });
});

describe('guaranteedKills', () => {
  it('is the expected share alone, rounded', () => {
    // 0% luck: round(0.6·n).
    expect(guaranteedKills(3, 60, 0)).toBe(2);
    expect(guaranteedKills(4, 60, 0)).toBe(2);
    // 16% luck: round(0.84·0.6·10 = 5.04) = 5.
    expect(guaranteedKills(10, 60, 0.16)).toBe(5);
    // 50% luck: round(0.5·0.6·5 = 1.5) = 2 (half up).
    expect(guaranteedKills(5, 60, 0.5)).toBe(2);
    // Weighted rounding only guarantees the floor: floor(1.8) = 1.
    expect(guaranteedKills(3, 60, 0, 'WeightedRandom')).toBe(1);
  });
});

describe('kill breakpoints', () => {
  it('60%: 1, 3, 5, 6, 8, 10, 11, 13', () => {
    expect(killBreakpoints(60, 13)).toEqual([1, 3, 5, 6, 8, 10, 11, 13]);
  });
  it('50%: every odd size (half rounds up)', () => {
    expect(killBreakpoints(50, 11)).toEqual([1, 3, 5, 7, 9, 11]);
  });
  it('nextBreakpoint: the next size that kills one more', () => {
    expect(nextBreakpoint(3, 60)).toBe(5);
    expect(nextBreakpoint(5, 60)).toBe(6);
    expect(nextBreakpoint(6, 60)).toBe(8);
    expect(nextBreakpoint(4, 50)).toBe(5);
    expect(nextBreakpoint(3, 0)).toBeNull();
  });
});
