// #421, spending a stockpile: the armies of mine in view against my income, and what the planner does when
// they pile up on a flat income. Pure (it imports no plan phase), so the estimates phase, the strike phase
// and planTurn read one rule:
// - the pile (`pileOf`): my income is flat and my armies in view are at least STOCKPILE_TURNS turns of it;
// - outside a 1v1, the pile builds a strike stack facing the opponent beside me whose armies in view mine
//   outnumber STOCKPILE_LEAD× (`stockpileOf`, #450);
// - once in contact on a flat income, STRIKE_SHARE of the income is held out of captures for the strike
//   stack (`strikeShareOf`: holds keep their exact need first; owner decision of 2026-11-20);
// - on the pile, the turn also spends by breaking the strongest opponent's cheapest visible bonus and by
//   all-in completions of the contested bonuses (`contestedBonuses`; planner.ts).
import type { TerritoryState } from '../../board.js';
import { bonusTerritories } from '../bonuses.js';
import { neighborsOf, type MapGraph } from '../graph.js';
import type { IncomeTrend } from '../income-trend.js';
import type { GameProfile } from '../profile.js';
import type { PlanGoal } from './shared.js';

/** #421: armies of mine in view, in turns of my income, that make a stockpile on a flat income. */
export const STOCKPILE_TURNS = 4;
/** #421: the visible-army lead over one opponent beside me that turns a stockpile into a strike stack facing it. */
export const STOCKPILE_LEAD = 2;
/** #421 (owner decision, 2026-11-20): the share of a flat income held out of captures for the strike stack. */
export const STRIKE_SHARE = 0.25;

/** What the pile rules read: the board and the goal, as the estimates phase has them. */
export interface PileArgs {
  territories: ReadonlyMap<number, TerritoryState>;
  mineSet: ReadonlySet<number>;
  unitsAt: (id: number) => number;
  foe: (p: number) => boolean;
  income: number;
  incomeTrend?: IncomeTrend;
  auto: boolean;
  goal: PlanGoal;
  noSplit: boolean;
}

/** My armies in view and each other player's (special units counted), visible territories only. */
export function armiesInView(a: Pick<PileArgs, 'territories' | 'mineSet' | 'unitsAt'>) {
  const by = new Map<number, number>();
  let my = 0;
  for (const [id, st] of a.territories) {
    if (st.owner.kind !== 'player' || st.armies === null) continue;
    if (a.mineSet.has(id)) my += st.armies + a.unitsAt(id);
    else by.set(st.owner.playerId, (by.get(st.owner.playerId) ?? 0) + st.armies + a.unitsAt(id));
  }
  return { my, by };
}

/**
 * #421: the pile — adapting (not `defend`, not No-Split), my income flat and my armies in view at least
 * {@link STOCKPILE_TURNS} turns of it. `undefined` otherwise.
 */
export function pileOf(a: PileArgs): { my: number; by: Map<number, number>; turns: number } | undefined {
  if (!a.auto || a.goal === 'defend' || a.noSplit || !a.incomeTrend?.flat || a.income <= 0) return undefined;
  const { my, by } = armiesInView(a);
  if (my < STOCKPILE_TURNS * a.income) return undefined;
  return { my, by, turns: Math.round((my / a.income) * 10) / 10 };
}

/**
 * #421 (#450): outside a 1v1 and a siege, the pile builds the strike stack facing the opponent in
 * `facing` whose armies in view mine outnumber {@link STOCKPILE_LEAD}× or more (the fewest first, then
 * id). Visible armies only, never an income estimate.
 */
export function stockpileOf(a: PileArgs & { format: GameProfile['format']; siege: boolean; facing: Iterable<number> }) {
  if (a.siege || a.format === '1v1') return undefined;
  const pile = pileOf(a);
  if (!pile) return undefined;
  const { my, by, turns } = pile;
  const p = [...a.facing]
    .filter((q) => a.foe(q) && my >= STOCKPILE_LEAD * (by.get(q) ?? 0))
    .sort((x, y) => (by.get(x) ?? 0) - (by.get(y) ?? 0) || x - y)[0];
  if (p === undefined) return undefined;
  const ratio = by.get(p) ? `${(Math.round((my / by.get(p)!) * 10) / 10).toFixed(1)}×` : 'unbounded';
  return {
    p,
    why: `the opponent whose armies in view mine outnumber ${ratio} (#421)`,
    line: `${my} armies of mine stand on the board, ${turns} turns of my flat ${a.income} income, ${ratio} player ${p}'s in view`,
  };
}

/**
 * #421 (owner decision, 2026-11-20): in contact on a flat income — where rule 0p.3c builds a strike stack
 * (a 1v1 adapting, a siege, or the stockpile above) — {@link STRIKE_SHARE} of my income, rounded down, is
 * held out of captures for the stack. Holds still take their exact need first; the leftover deploy then
 * gives the stack what the captures left, ahead of comfort margins. 0 otherwise.
 */
export function strikeShareOf(
  a: PileArgs & { format: GameProfile['format']; siege: number | undefined; contact: ReadonlySet<number> },
): number {
  if (!a.incomeTrend?.flat || a.income <= 0) return 0;
  const stack =
    (a.siege !== undefined && a.contact.has(a.siege)) ||
    (a.auto && a.format === '1v1' && a.goal !== 'defend' && a.contact.size > 0) ||
    stockpileOf({ ...a, siege: a.siege !== undefined, facing: a.contact }) !== undefined;
  return stack ? Math.floor(STRIKE_SHARE * a.income) : 0;
}

/**
 * #421 (owner decision, 2026-11-20): the contested bonuses an all-in completion could take on the pile — a
 * positive bonus I hold a member of, whose every missing member is in view (armies shown) beside a territory of
 * mine, at least one of them an opponent's, none a teammate's. By id.
 */
export function contestedBonuses(
  g: MapGraph,
  territories: ReadonlyMap<number, TerritoryState>,
  mineSet: ReadonlySet<number>,
  foe: (p: number) => boolean,
): number[] {
  return g.map.bonuses
    .filter((b) => {
      const ts = bonusTerritories(g, b.id);
      if (b.value <= 0 || !ts.some((t) => mineSet.has(t))) return false;
      const missing = ts.filter((t) => !mineSet.has(t));
      if (!missing.length) return false;
      let opponent = false;
      for (const t of missing) {
        const st = territories.get(t);
        if (!st || st.armies === null || st.owner.kind === 'unknown' || st.owner.kind === 'available') return false;
        if (!neighborsOf(g, t).some((n) => mineSet.has(n))) return false;
        if (st.owner.kind === 'player') {
          if (!foe(st.owner.playerId)) return false;
          opponent = true;
        }
      }
      return opponent;
    })
    .map((b) => b.id)
    .sort((a, b) => a - b);
}
