// Two one-line helpers every planner module shares (#133): an ascending numeric sort and a percentage.
/** Ascending numeric order, for `Array.prototype.sort`. */
export const byNum = (a: number, b: number) => a - b;
/** `p` (0..1) as a percentage with one decimal, e.g. `12.5%`. */
export const pct = (p: number) => `${Math.round(p * 1000) / 10}%`;
