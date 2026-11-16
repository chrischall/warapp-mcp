// #281: land a player who is out left behind (a static seat, #270), and what taking it denies. Pure.
//
// planTurn plans a static seat's territories as neutrals; `BoardCtx.vacated` keeps which ones they
// were. Such a territory beside a live opponent is one that opponent takes for free next turn when
// its stack there can (nobody defends it but its static armies), so the border it would add comes
// either way: taking it first moves the front one step out, onto land the opponent would otherwise
// gain. Rule 4d's frontier budget therefore never refuses a cheap one on its hold cost alone, and
// pass 3 ranks it with the denial credited. Everything else is as any neutral: the capture spends only
// the armies above what holds its source (#121), and is sized at its cost (the fewest that take it).
import { neighborsOf } from '../graph.js';
import type { PlanCtx } from './state.js';
import type { Targets } from './targets.js';

/** A vacated territory costing at most this many armies to take is cheap enough to deny (#281). */
export const VACATED_MAX_COST = 2;

/** What taking a vacated territory denies the opponent beside it (#281). */
export interface Denial {
  /** The live opponent that would take it free: the one it gives the most, then the lowest id. */
  player: number;
  /** My capture cost. */
  cost: number;
  /** The income it would give that opponent: a bonus it completes, else its share of the bonuses it advances. */
  progress: number;
  /** The bonuses it completes for that opponent, by id. */
  completes: number[];
}

/**
 * What capturing `t` denies (#281), or `null`: `t` must be vacated by a static seat (still a neutral
 * on this board), cost me at most {@link VACATED_MAX_COST}, and border a visible live opponent's stack
 * that can take it with the armies it has (a teammate never counts).
 */
export function denialOf(pc: PlanCtx, t: number): Denial | null {
  if (!pc.vacated.has(t) || pc.territories.get(t)?.owner.kind !== 'neutral') return null;
  const cost = pc.costAt(t);
  if (cost === null || cost > VACATED_MAX_COST) return null;
  let best: Denial | null = null;
  for (const n of [...neighborsOf(pc.g, t)].sort((a, b) => a - b)) {
    const o = pc.territories.get(n);
    if (o?.owner.kind !== 'player' || !pc.foe(o.owner.playerId) || pc.allies.has(o.owner.playerId)) continue;
    if (o.armies === null || o.armies - pc.guard < cost) continue;
    const player = o.owner.playerId;
    const holds = (x: number) => {
      const s = pc.territories.get(x);
      return s?.owner.kind === 'player' && s.owner.playerId === player;
    };
    let progress = 0;
    const completes: number[] = [];
    for (const id of pc.bonusesWith.get(t) ?? []) {
      const value = pc.g.bonusById.get(id)?.value ?? 0;
      const members = pc.bonusTs.get(id) ?? [];
      if (value <= 0 || !members.length) continue;
      const others = members.filter((x) => x !== t);
      const theirs = others.filter(holds).length;
      if (theirs === others.length) {
        progress += value;
        completes.push(id);
      } else if (theirs > 0) progress += value / members.length;
    }
    progress = Math.round(progress * 100) / 100;
    if (!best || progress > best.progress) best = { player, cost, progress, completes };
  }
  return best;
}

/**
 * A denial's credit in a score, in armies: the territory the opponent would gain (1) plus its income
 * over the payback horizon.
 */
export function denialCredit(pc: PlanCtx, d: Denial): number {
  return 1 + pc.paybackTurns * d.progress;
}

/** The rationale line for a vacated territory taken though it adds a border facing an enemy (#281). */
export function denialLine(pc: PlanCtx, t: number, d: Denial): string {
  const by = `player ${pc.vacated.get(t)}`;
  const gives = d.completes.length
    ? `, completing bonus ${d.completes.map((id) => `${pc.bonusName(id)} (+${pc.g.bonusById.get(id)!.value})`).join(', ')} for it`
    : d.progress > 0
      ? `, toward its bonuses (~+${d.progress} a turn)`
      : '';
  return `Take ${pc.label(t)} though it faces player ${d.player}: ${by} left it (out, no AI), it costs ${d.cost}, and player ${d.player} would take it free next turn${gives} — the border comes either way (#281).`;
}

/**
 * Pass 3's order (and rule 5b's): capture cost plus the frontier it adds. A denial (#281) pays no hold
 * need there — its border comes either way — and is credited with {@link denialCredit}.
 */
export function plainOrderCost(pc: PlanCtx, tgt: Pick<Targets, 'landScoreCost' | 'targetScoreCost'>, t: number): number {
  const d = denialOf(pc, t);
  return d ? tgt.landScoreCost(t) - denialCredit(pc, d) : tgt.targetScoreCost(t);
}
