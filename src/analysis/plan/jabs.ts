// Single-army jabs (#361). At 0% luck under straight rounding one attacking army kills
// round(1 × the offensive kill rate) defenders: at a 60% rate that is 1 (seen live: 75 → 74, 19 → 18),
// and the defenders kill it back. A one-for-one trade, the best rate an attack gets under these rules
// (10 attackers kill only 6). It captures nothing and earns no card piece, so its only use is
// attrition, and attrition pays only against an opponent I out-earn or out-army.
//
// Once every other order is sized (after the #226 margin), the armies still idle on a territory of
// mine beyond what holds it (`spareBeyondHold`: never a hold's own armies, a conceded border's or my
// commander's; never a step's saving source, where rule 5's leftover went to stay, or the strike stack
// but for a siege's break member) jab enemy stacks beside it, one army each, at most one jab per enemy stack, filler orders:
//   1. the siege target's breakable bonus members (#382), its cheapest break first: each jab is one
//      defender fewer for next turn's break;
//   2. a member of a bonus an opponent holds in full in view (wearing down a bonus edge);
//   3. any other stack of an opponent I out-earn or out-army.
// On under `goal: 'siege'`, opt-in otherwise (`PlanOptions.jabs`), until measured further (#361).
// Never a territory another order of this plan attacks, a truce's or the held siege's (`noTarget`), a
// #240 repulsed one, a
// territory with a special unit, or a stack of fewer than 2 (a lone defender and the jab destroy
// each other and the territory keeps one: nothing traded).
import { straightKills } from '../combat.js';
import { neighborsOf } from '../graph.js';
import { breakableBonuses } from './siege.js';
import type { PlanCtx, PlanState } from './state.js';

/** One jab the plan makes (`TurnPlan.jabs`): an attrition order, never a capture. */
export interface Jab {
  from: number;
  to: number;
  player: number;
  /** The defenders there before the jab. */
  defenders: number;
  /** What the jab kills (round(1 × the offensive kill rate)) and what it loses (the one army). */
  kills: number;
  loses: number;
  why: 'siege-break' | 'bonus-edge' | 'attrition';
}

/** Whether jabs trade one for one in this game: 0% luck, straight rounding, a lone army kills one. */
export function jabsTrade(pc: Pick<PlanCtx, 'luck' | 'weightedRounding' | 'rates'>): boolean {
  return pc.luck === 0 && !pc.weightedRounding && straightKills(1, pc.rates.offensiveKillRate) >= 1;
}

/**
 * Plans the jabs and adds them to `ps.moves` (1 army, `winChance` 0), spending `spare` (the armies a
 * source has beyond its hold; read once per source, then counted down here). `skip`: sources kept
 * whole (the strike stack, a step's saving source); `strike`, the strike stack, jabs only the siege
 * target's break members (a siege's stack grows or breaks, #382). `refused`: targets no jab goes to (#240's repulsed
 * ones, attacked only at their sure size).
 */
export function planJabs(
  pc: PlanCtx,
  ps: PlanState,
  spare: (src: number) => number,
  skip: ReadonlySet<number>,
  refused: (t: number) => boolean = () => false,
  strike?: number,
): Jab[] {
  const { g, territories: state, label, mineSet, foe, noSplit, unitsAt, defenceAt } = pc;
  const { moves, avail, captured, rationale } = ps;
  if (noSplit || !jabsTrade(pc)) return [];
  const kills = straightKills(1, pc.rates.offensiveKillRate);
  // Who the trade favours: an opponent I out-earn, or whose armies in view are fewer than mine.
  const armiesOf = new Map<number, number>();
  let myArmies = 0;
  for (const st of state.values()) {
    if (st.owner.kind !== 'player' || st.armies === null) continue;
    if (mineSet.has(st.territoryId)) myArmies += st.armies;
    else armiesOf.set(st.owner.playerId, (armiesOf.get(st.owner.playerId) ?? 0) + st.armies);
  }
  const favours = (p: number) => pc.income > pc.incomeOfPlayer(p) || myArmies > (armiesOf.get(p) ?? 0);
  const siegeRank = new Map<number, number>();
  if (pc.siege)
    pc.siege.breaks.forEach((b, i) => {
      for (const t of pc.bonusTs.get(b.bonusId) ?? []) if (!siegeRank.has(t)) siegeRank.set(t, i);
    });
  const edge = new Set(
    breakableBonuses(g, state, foe, undefined)
      .filter((b) => !b.probable)
      .flatMap((b) => pc.bonusTs.get(b.bonusId) ?? []),
  );
  const attacked = new Set(moves.filter((m) => m.kind === 'attack').map((m) => m.to));
  const left = new Map<number, number>();
  const spareAt = (x: number) => {
    if (!left.has(x)) left.set(x, (skip.has(x) && x !== strike) || ps.leftoverKept.has(x) ? 0 : Math.max(0, spare(x)));
    return left.get(x)!;
  };
  type Cand = { t: number; player: number; d: number; why: Jab['why']; rank: number };
  const cands: Cand[] = [];
  for (const [t, st] of state) {
    if (st.owner.kind !== 'player' || st.armies === null || mineSet.has(t)) continue;
    const p = st.owner.playerId;
    if (!foe(p) || attacked.has(t) || captured.has(t) || refused(t) || pc.truce.noTarget(t) || unitsAt(t) > 0) continue;
    const d = defenceAt(t);
    if (d < 2 || !neighborsOf(g, t).some((n) => mineSet.has(n))) continue;
    const why: Jab['why'] = siegeRank.has(t) && pc.siege?.target === p ? 'siege-break' : edge.has(t) ? 'bonus-edge' : 'attrition';
    if (why !== 'siege-break' && !favours(p)) continue;
    // Before its trigger a siege attacks nothing of its target but the break members (noTarget says so).
    cands.push({ t, player: p, d, why, rank: why === 'siege-break' ? siegeRank.get(t)! : why === 'bonus-edge' ? 1000 : 2000 });
  }
  cands.sort((a, b) => a.rank - b.rank || a.d - b.d || a.t - b.t);
  const jabs: Jab[] = [];
  for (const c of cands) {
    const from = neighborsOf(g, c.t)
      .filter((x) => mineSet.has(x) && (x !== strike || (c.why === 'siege-break' && skip.has(x))) && spareAt(x) >= 1)
      .sort((a, b) => spareAt(b) - spareAt(a) || a - b)[0];
    if (from === undefined) continue;
    left.set(from, spareAt(from) - 1);
    avail.set(from, avail.get(from)! - 1);
    const what =
      c.why === 'siege-break'
        ? `one defender fewer on player ${c.player}'s bonus member for the siege's break (#382)`
        : c.why === 'bonus-edge'
          ? `wearing down an edge of a bonus player ${c.player} holds`
          : `attrition against player ${c.player}, whom I out-earn or out-army`;
    moves.push({
      from,
      to: c.t,
      armies: 1,
      kind: 'attack',
      reason: `jab (#361): 1 army kills ${kills} of the ${c.d} at 0% luck and straight rounding, a one-for-one trade — ${what}; it takes nothing`,
      winChance: 0,
    });
    jabs.push({ from, to: c.t, player: c.player, defenders: c.d, kills, loses: 1, why: c.why });
  }
  if (jabs.length)
    rationale.push(
      `Jab (#361): ${jabs.map((j) => `1 from ${label(j.from)} into ${label(j.to)} (${j.defenders})`).join(', ')} — each lone army kills ${kills} and dies (0% luck, straight rounding), from armies beyond what holds their source: attrition, never a capture.`,
    );
  return jabs;
}
