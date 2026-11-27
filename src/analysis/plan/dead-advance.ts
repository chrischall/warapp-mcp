// #593 (item 4): never advance a bonus whose other member this same plan concedes. A capture that adds to a
// bonus without completing it builds toward income the plan is already giving up: live (a lost 1v1, turn 16) a
// plan deployed 15 onto Poland to advance Europe while it conceded France and Italy, two other members of Europe,
// and lost both that turn. In a replay of 16 lost 1v1s, 41 advances (17 on truly-behind turns) went into a bonus
// whose other member the same plan conceded.
//
// The check runs where an expansion capture is made (`tryExpand`, plan/captures.ts: pass 2's advances, the
// `balanced` greedy's advance slots, pass 3, #439's stage, rule 5b), so a refused capture leaves its armies and
// deploy to the next candidate. Concessions made after the capture (the greedy concedes pending holds as it goes,
// #215) are caught on the finished plan: planTurn plans again with those bonuses carried (`PlanInput.deadAdvance`).
import type { PlanCtx } from './state.js';

/**
 * #593, set by planTurn (callers leave it out): the bonuses an earlier plan of this turn advanced while it
 * conceded another member of them I hold, each with those members. Their advances are refused from the start.
 */
export type DeadBonuses = ReadonlyMap<number, readonly number[]>;

/** A bonus a capture would advance though another member of it I hold is conceded. */
export interface DeadAdvance {
  bonusId: number;
  /** The members I hold that are conceded (now, or by the earlier plan when `carried`). */
  members: number[];
  /** No member is conceded now: the bonus was carried from an earlier plan of this turn. */
  carried: boolean;
}

/**
 * The bonuses a capture of `t` would advance though this plan concedes another member of them I hold, when every
 * positive bonus `t` is in is such a bonus and the capture (with `held`, what I hold once this turn's captures so
 * far land) completes none of them; else `null`. Called on expansion captures only (a break or a strike is no
 * advance); never for a focused territory or land a static seat left (#281, #417). `conceded` is the plan's
 * conceded borders as they stand; `carried` the bonuses an earlier plan of this turn found dead; `completable` the
 * bonuses this turn's captures could complete (their steps are exempt).
 */
export function deadAdvanceOf(
  pc: Pick<PlanCtx, 'g' | 'territories' | 'mineSet' | 'bonusTs' | 'bonusesWith' | 'inFocus' | 'vacated' | 'foe'>,
  t: number,
  held: ReadonlySet<number>,
  conceded: ReadonlySet<number>,
  carried: DeadBonuses,
  completable: (bonusId: number) => boolean = () => false,
): DeadAdvance[] | null {
  if (pc.inFocus(t) || pc.vacated.has(t) || pc.mineSet.has(t)) return null;
  const bonuses = (pc.bonusesWith.get(t) ?? []).filter((id) => (pc.g.bonusById.get(id)?.value ?? 0) > 0);
  if (!bonuses.length) return null;
  const after = new Set([...held, t]);
  const dead: DeadAdvance[] = [];
  for (const id of bonuses) {
    const ts = pc.bonusTs.get(id) ?? [];
    // A capture that completes the bonus is no advance (rule 1c then keeps its conceded member, #18).
    if (ts.every((x) => after.has(x))) return null;
    const now = ts.filter((x) => x !== t && pc.mineSet.has(x) && conceded.has(x));
    const was = carried.get(id)?.filter((x) => x !== t && pc.mineSet.has(x));
    // A bonus an earlier plan advanced and left incomplete beside a concession is dead whatever this one finds.
    if (was?.length) {
      dead.push({ bonusId: id, members: now.length ? now : [...was], carried: !now.length });
      continue;
    }
    // A step of a bonus this turn's captures can complete (every missing member a target) is left to the
    // finished plan: the completion keeps its conceded member (rule 1c), and a step taken first (#214's order)
    // must not block it; one the plan then leaves incomplete is carried into the next plan.
    if (completable(id) || !now.length) return null;
    // Owner, 2026-11-27: an advance that breaks the bonus for the opponent attacking a conceded member is no dead
    // advance — the capture takes his own member of it, or the one member he would still lack once mine fall.
    if (breaksForAttacker(pc, t, ts, now)) return null;
    dead.push({ bonusId: id, members: now, carried: false });
  }
  return dead;
}

/**
 * Owner, 2026-11-27: the foes with a stack beside one of my conceded members `now` of the bonus `ts` (the attackers
 * the concession gives them to), and whether taking `t` breaks the bonus for one of them: `t` is that attacker's, or
 * `t` is neutral and every other member is already that attacker's or one of the conceded members. Pure.
 */
export function breaksForAttacker(
  pc: Pick<PlanCtx, 'g' | 'territories' | 'foe'>,
  t: number,
  ts: readonly number[],
  now: readonly number[],
): boolean {
  const ownerOf = (x: number): number | null => {
    const o = pc.territories.get(x)?.owner;
    return o?.kind === 'player' ? o.playerId : null;
  };
  const attackers = new Set<number>();
  for (const m of now)
    for (const n of pc.g.neighbors.get(m) ?? []) {
      const p = ownerOf(n);
      const st = pc.territories.get(n);
      if (p !== null && pc.foe(p) && (st?.armies ?? 0) > 0) attackers.add(p);
    }
  if (!attackers.size) return false;
  const owner = ownerOf(t);
  if (owner !== null) return attackers.has(owner);
  if (pc.territories.get(t)?.owner.kind !== 'neutral') return false;
  const conceded = new Set(now);
  return [...attackers].some((a) => ts.every((x) => x === t || conceded.has(x) || ownerOf(x) === a));
}

/** The rationale line for a refused advance of `t` (one per bonus). */
export function deadAdvanceLine(pc: Pick<PlanCtx, 'label' | 'bonusName'>, t: number, d: DeadAdvance): string {
  const members = d.members.map(pc.label).join(', ');
  const its = d.members.length === 1 ? 'its member' : 'its members';
  return d.carried
    ? `Do not take ${pc.label(t)} toward bonus ${pc.bonusName(d.bonusId)}: the plan that took it conceded ${its} ${members}, so the capture builds a bonus this turn gives up: its armies are left to the plan's other orders (#593).`
    : `Do not take ${pc.label(t)} toward bonus ${pc.bonusName(d.bonusId)}: this plan concedes ${its} ${members}, so the capture builds a bonus this turn gives up: its armies are left to the plan's other orders (#593).`;
}
