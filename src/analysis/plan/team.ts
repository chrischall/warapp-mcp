// PLAN-TEAMS C3.3: one owner per bonus. A bonus pays only the player who holds every member, so a
// bonus with a member my teammate visibly holds is never a completion target for me (bonus
// scoring, plan/targets.ts, skips it), and the plan reports each bonus we both hold members of and
// who is nearer to holding it (`team.sharedBonuses`). Advisory: nothing else changes. Read from the
// start-of-turn board; a teammate's territory in the fog is unknown (team vision is unverified).
import { teammateAt, type PlanCtx } from './state.js';
import { byNum } from './util.js';

/** A positive bonus both I and a teammate visibly hold members of (PLAN-TEAMS C3.3). */
export interface SharedBonus {
  bonusId: number;
  value: number;
  /** The members I hold, sorted. */
  mine: number[];
  /** Each teammate holding a member, by player id: its members, sorted. */
  teammates: { player: number; territories: number[] }[];
  /** Members neither I nor a teammate visibly holds (a neutral, an opponent's, or fogged), sorted. */
  others: number[];
  /**
   * The player who holds the most members, so is nearer to holding it (my own id when I am); null
   * when two of us hold as many.
   */
  nearer: number | null;
}

/** The team section of a plan (PLAN-TEAMS C3). Present only in a team game with something to say. */
export interface TeamView {
  sharedBonuses: SharedBonus[];
}

/** The teammates visibly holding a member of `ts` (none in a no-team game), sorted. */
export function teammatesIn(pc: Pick<PlanCtx, 'allies' | 'territories'>, ts: readonly number[]): number[] {
  const ids = new Set<number>();
  for (const t of ts) if (teammateAt(pc, t)) ids.add((pc.territories.get(t)!.owner as { playerId: number }).playerId);
  return [...ids].sort(byNum);
}

/** Every positive bonus I share with a teammate, by bonus id (empty in a no-team game). */
export function sharedBonuses(pc: Pick<PlanCtx, 'allies' | 'territories' | 'g' | 'bonusTs' | 'mineSet' | 'me'>): SharedBonus[] {
  if (!pc.allies.size) return [];
  const out: SharedBonus[] = [];
  for (const b of [...pc.g.map.bonuses].sort((x, y) => x.id - y.id)) {
    if (b.value <= 0) continue;
    const ts = pc.bonusTs.get(b.id) ?? [];
    const mine = ts.filter((t) => pc.mineSet.has(t)).sort(byNum);
    if (!mine.length) continue;
    const mates = teammatesIn(pc, ts);
    if (!mates.length) continue;
    const teammates = mates.map((player) => ({
      player,
      territories: ts
        .filter((t) => {
          const o = pc.territories.get(t)?.owner;
          return o?.kind === 'player' && o.playerId === player;
        })
        .sort(byNum),
    }));
    const others = ts.filter((t) => !pc.mineSet.has(t) && !teammateAt(pc, t)).sort(byNum);
    const counts = [{ player: pc.me, n: mine.length }, ...teammates.map((m) => ({ player: m.player, n: m.territories.length }))];
    const most = Math.max(...counts.map((c) => c.n));
    const top = counts.filter((c) => c.n === most);
    out.push({ bonusId: b.id, value: b.value, mine, teammates, others, nearer: top.length === 1 ? top[0]!.player : null });
  }
  return out;
}

/** The plan's team section, or undefined when there is nothing to report. */
export function teamReport(pc: Parameters<typeof sharedBonuses>[0]): TeamView | undefined {
  const shared = sharedBonuses(pc);
  return shared.length ? { sharedBonuses: shared } : undefined;
}
