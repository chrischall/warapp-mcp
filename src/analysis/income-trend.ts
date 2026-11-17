// #303: my income over the last turns — the points, a least-squares slope and whether it is flat.
// Pure. The flat test is #312's (`flatTurn` in game-lessons.ts), on the turns that end at this one.

/** The turns of no growth that make an income flat (#312: "slope ≈ 0 for 3+ turns"). */
export const FLAT_TURNS = 3;
/** What counts as no growth over those turns: at most this share of the income (and at least 1 army). */
export const FLAT_TOLERANCE = 0.1;
/** The turns the trend reports, the current one included (#303: "the last five turns"). */
export const TREND_POINTS = 5;

/** My board income on one turn (card armies out). */
export interface IncomePoint {
  turn: number;
  income: number;
}

export interface IncomeTrend {
  /** At most {@link TREND_POINTS} turns, oldest first, the current one last. */
  turns: IncomePoint[];
  /** Least-squares income change per turn over `turns`, to 0.1. */
  slope: number;
  /**
   * The last {@link FLAT_TURNS} + 1 turns are consecutive, with land held, and each stays within
   * {@link FLAT_TOLERANCE} (at least 1) of the first of them.
   */
  flat: boolean;
}

/**
 * The trend over `earlier` boards' incomes and `current` (later readings of a turn win; a turn at or after the
 * current one is ignored). Absent with no earlier turn.
 */
export function incomeTrend(earlier: readonly IncomePoint[], current: IncomePoint): IncomeTrend | undefined {
  const by = new Map<number, number>();
  for (const p of earlier) if (p.turn < current.turn) by.set(p.turn, p.income);
  if (by.size === 0) return undefined;
  by.set(current.turn, current.income);
  const turns = [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-TREND_POINTS)
    .map(([turn, income]) => ({ turn, income }));
  const n = turns.length;
  const mx = turns.reduce((s, p) => s + p.turn, 0) / n;
  const my = turns.reduce((s, p) => s + p.income, 0) / n;
  const sxx = turns.reduce((s, p) => s + (p.turn - mx) ** 2, 0);
  const sxy = turns.reduce((s, p) => s + (p.turn - mx) * (p.income - my), 0);
  const slope = sxx > 0 ? Math.round((sxy / sxx) * 10) / 10 : 0;
  const tail = turns.slice(-(FLAT_TURNS + 1));
  const first = tail[0]!;
  const tol = Math.max(1, FLAT_TOLERANCE * first.income);
  const flat =
    tail.length === FLAT_TURNS + 1 &&
    first.income > 0 &&
    tail.every((p, i) => p.turn === first.turn + i && p.income > 0 && Math.abs(p.income - first.income) <= tol);
  return { turns, slope: slope === 0 ? 0 : slope, flat };
}
