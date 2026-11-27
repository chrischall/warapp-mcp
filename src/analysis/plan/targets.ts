// The targets of a planning pass (#133): the enemy bonuses I could break and the counter-attacks
// (under `balanced`, #72), the territories next to mine a capture may take (rule 2, #203's lead
// steps), what a capture adds to the frontier (rule 4d, #71), the offence report (#72), the
// bonuses worth working toward and their order (rule 4, R3, #70, #101, #125, #167). Read once the
// holds are defined; the capture passes (plan/captures.ts) and the strike passes work from them.
import type { TerritoryState } from '../../board.js';
import { analyzeBonus, bonusTerritories } from '../bonuses.js';
import { straightKills } from '../combat.js';
import { bfsDistances, neighborsOf } from '../graph.js';
import { DEFAULT_BASE_INCOME } from '../player.js';
import {
  DEFENSE_DISCOUNT,
  HIDDEN_POOL_INCOMES,
  NEUTRAL_BORDER_COST,
  visibleState,
  WASTELAND_FACTOR,
  type BonusPlan,
  type FogNeutral,
  type OffenceEntry,
  type PlanInput,
  type Target,
} from './shared.js';
import type { Holds } from './holds.js';
import { teammateAt, type PlanCtx, type PlanState } from './state.js';
import type { Threats } from './threats.js';
import { byNum } from './util.js';
import { denialsOf, emptyEnemiesOf, fogVacated, VACATED_FOG_ARMIES } from './vacated.js';
import { breakableBonuses, type Breakable } from './siege.js';
import { ALL_IN_VALUE_TURNS, type AllInTry } from './bonus-attempts.js';
import { foggedBreakables, type FoggedBreak } from './fogged-break.js';


export type { Breakable } from './siege.js';

export interface Counter {
  player: number;
  from: number;
  to: number;
  costNow: number;
  costThen: number;
}

/**
 * #203: why a bonus pass's last try at a lead step failed, for its "Not attacking" line: short
 * (the source it tried, what that source could spare and what of this turn's deploy could still
 * reach it, both measured then; no source: none was free), refused by R3 or a trade below even,
 * or stopped by rule 4d's frontier budget. A try that succeeds clears it.
 */
/**
 * #212: why a neighbour of mine could not attack a lead step at all. `locked` cannot fire today
 * (a locked, unconceded border that is not my commander's is a lead step's hold source, a
 * conceded one is funded from deploy (#214), and No-Split, the only other way a source is
 * unusable, turns lead steps off); it is the fallback.
 */
export type LeadBlock = 'commander' | 'order' | 'locked';

export type LeadTry =
  | {
      kind: 'short';
      from?: number;
      spare: number;
      reach: number;
      /** #212: a held border's hold still lacked this much once the step left (its spare is 0). */
      hold?: number;
      /** #212: with no source, why each neighbour of mine could not attack (by id). */
      blocked?: { from: number; why: LeadBlock }[];
    }
  | { kind: 'r3' }
  | { kind: 'trade'; lost: number; killed: number }
  | { kind: 'frontier' };

export type Targets = ReturnType<typeof targetsPhase>;

/** The targets, the frontier costs and the bonus plans, in the order planPass defined them. */
export function targetsPhase(
  pc: PlanCtx,
  ps: PlanState,
  input: PlanInput,
  threats: Threats,
  hd: Holds,
) {
  const c0 = breakTargets(pc, input);
  const c1 = { ...c0, ...captureTargets(pc, ps, input, threats, c0) };
  const c2 = { ...c1, ...frontierCosts(pc, threats, hd, c1) };
  const c3 = { ...c2, ...bonusScoring(pc, ps, threats, c2) };
  const c4 = { ...c3, ...closestBonus(pc, ps, input, c3, hd) };
  // #281: the vacated land worth denying and (the owner's extension) the empty enemy territories
  // pass 3 may take, each judged once on the board as it stands.
  const denials = denialsOf(pc);
  const emptyEnemies = emptyEnemiesOf(
    pc,
    input.previousBoard,
    threats.reinforcementAt,
    (t) => c4.targets.has(t) || c4.repulsed.has(t) || pc.truce.noTarget(t),
  );
  // #593: the bonuses an earlier plan of this turn advanced while conceding another member of them.
  const deadBonuses: ReadonlyMap<number, readonly number[]> = input.deadAdvance ?? new Map();
  return { ...c4, denials, emptyEnemies, deadBonuses };
}

/**
 * #430 (owner decision of 2026-11-22): a retake of a held bonus's lost members costs at most this many
 * times the bonus's value — tighter than PAYBACK_TURNS (10), which the first draft used.
 */
export const RETAKE_VALUE_TURNS = 5;

/** The enemy bonuses I could break and the counter-attacks (under `balanced`, #72). */
export function breakTargets(pc: PlanCtx, input: PlanInput) {
  const { g, me, foe, balanced, territories: state, mineSet, unitsAt, costAt } = pc;
  // ---- enemy bonuses I could break (under `balanced`) ----
  // A bonus is breakable when every territory in it is visible and held by one enemy, or (#72)
  // when the opponent tracker infers it behind the fog: its track (over at least
  // TRACKED_MIN_TURNS observed turns) lists it in every combination of bonuses that fits the
  // opponent's income gap (all of them listed), or in its single best fit (the first listed, with
  // fewer bonuses than the next), and on this board every member
  // is that opponent's or hidden. Such a break is "probable".
  const breakable: Breakable[] = balanced ? breakableBonuses(g, state, foe, input.tracks) : [];
  const breakMember = new Set<number>(breakable.flatMap((b) => bonusTerritories(g, b.bonusId)));
  // #593: in a 1v1, the opponent's bonuses behind the fog (a member in view its and beside mine, no member
  // shown with another owner), and on the opening turns the ones it is one neutral short of. Their members
  // in view are break targets (`foggedMember`), scored and sized by rule 4a (plan/fogged-break.ts).
  const foggedBreaks: FoggedBreak[] =
    balanced && pc.profile.format === '1v1'
      ? foggedBreakables(g, state, foe, mineSet, new Set(breakable.map((b) => b.bonusId)), pc.turnNow)
      : [];
  const foggedMember = new Set<number>(foggedBreaks.flatMap((b) => b.members));

  // ---- counter-attacks (under `balanced`, #72) ----
  // An enemy stack next to me that shrank since the previous board by attacking me: visible on
  // both boards under the same owner (F1, #69), every neighbour visible on both, one of them a
  // territory I held on both, every neighbour that was neither mine nor its owner's unchanged in
  // owner and armies (else it may have expanded or hit a third player), and the shrink not
  // absorbed by its own neighbours' growth (a transfer). The boards cannot tell its attack on me
  // from my failed attack on it (both shrink it next to me), so the rationale says "fighting me":
  // either way it is cheaper to take now. When it is now cheaper to take than it was, it is a strike candidate scored like
  // a break (rule 4a). A member of a breakable bonus is a break instead.
  const counterAt = new Map<number, Counter>();
  if (balanced && input.previousBoard) {
    const before = new Map(input.previousBoard.territories.map((t) => [t.territoryId, t]));
    const heldBy = (st: TerritoryState | undefined, p: number) => st?.owner.kind === 'player' && st.owner.playerId === p;
    for (const [id, st] of [...state].sort((a, b) => a[0] - b[0])) {
      if (st.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null || breakMember.has(id)) continue;
      const p = st.owner.playerId;
      const ns = neighborsOf(g, id);
      if (!ns.some((n) => mineSet.has(n))) continue;
      const was = visibleState(before.get(id));
      if (!heldBy(was, p) || was!.armies! <= st.armies) continue;
      if (!ns.every((n) => visibleState(state.get(n)) && visibleState(before.get(n)))) continue;
      if (!ns.some((n) => mineSet.has(n) && heldBy(before.get(n), me))) continue;
      // Pinned on me: every neighbour that was neither mine nor theirs keeps its owner and armies.
      // A neutral it took (an expansion) or a third player it hit could have spent the shrink.
      const elsewhere = ns.some((n) => {
        const a = state.get(n)!;
        const b = before.get(n)!;
        if (heldBy(b, me) || heldBy(b, p)) return false;
        const owner = (x: TerritoryState) => (x.owner.kind === 'player' ? x.owner.playerId : x.owner.kind);
        return owner(a) !== owner(b) || a.armies !== b.armies;
      });
      if (elsewhere) continue;
      const absorbed = ns.reduce((sum, n) => {
        const a = state.get(n)!;
        const b = before.get(n)!;
        return heldBy(a, p) && heldBy(b, p) ? sum + Math.max(0, a.armies! - b.armies!) : sum;
      }, 0);
      if (was!.armies! - st.armies <= absorbed) continue;
      const costNow = costAt(id);
      const costThen = costAt(id, was!.armies! + unitsAt(id));
      if (costNow === null || costThen === null || costNow >= costThen) continue;
      counterAt.set(id, { player: p, from: was!.armies!, to: st.armies, costNow, costThen });
    }
  }
  return { breakable, breakMember, counterAt, foggedBreaks, foggedMember };
}

/** Rule 2: the targets next to mine, and the lead steps into a bonus on an army lead (#203). */
export function captureTargets(
  pc: PlanCtx,
  ps: PlanState,
  input: PlanInput,
  threats: Threats,
  prev: ReturnType<typeof breakTargets>,
) {
  const {
    g, foe, profile, auto, goal, balanced, territories: state, label, mineSet, unitsAt, uncounted, uncountedKind,
    defenceAt, bonusTs, costAt, noSplit, leadLever, leadText,
  } = pc;
  const { warnings, rationale } = ps;
  const { reinforcementAt, hiddenFoe, hiddenMovable, hiddenPool } = threats;
  const { breakMember, counterAt, foggedMember } = prev;
  // ---- 2. targets ----
  const targets = new Map<number, Target>();
  /**
   * #298: the missing members of the bonuses dropped after repeated failed attempts
   * (`input.bonusPush.dropped`): no bonus step (rule 4e's contact fallback, #203's lead steps) goes into one.
   */
  const bonusDropped: ReadonlySet<number> = input.bonusPush?.dropped ?? new Set<number>();
  const droppedMembers = new Set([...bonusDropped].flatMap((id) => (g.bonusById.has(id) ? bonusTerritories(g, id).filter((t) => !mineSet.has(t)) : [])));
  /** #421: the missing members of the contested bonuses a stockpile pushes all-in: targets, an opponent's included. */
  const pileMembers = new Set(
    [...(input.stockpileAllIn ?? [])].flatMap((id) => (g.bonusById.has(id) ? bonusTerritories(g, id).filter((t) => !mineSet.has(t)) : [])),
  );
  /**
   * #430: the opponents' territories that retake a bonus I held in full on `previousBoard`. Under
   * `balanced` an enemy territory was only a break or counter target, so a held bonus that lost a
   * member to a player was never retaken outside the 1v1 strike stack (0 of 166 breaks regained in
   * planner-era games). Such a member is a bonus target, in every format, when the retake completes
   * the bonus this turn (every missing member in view, beside mine, no special unit, a foe's or a
   * neutral; none of #298's dropped members), its capture costs together are at most
   * RETAKE_VALUE_TURNS (5) × the value, and the profile does not read me behind (behind, the turn goes to
   * holds and strikes: the evidence's confound). It then competes as a completion in the bonus passes
   * and rule 4a's greedy step, so a hold that scores higher is still funded first, and R3 still
   * refuses a retake that cannot be held.
   */
  const retakeMembers = new Set<number>();
  if (balanced && input.previousBoard && profile.standing !== 'behind') {
    const before = new Map(input.previousBoard.territories.map((t) => [t.territoryId, t]));
    for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
      const ts = bonusTs.get(b.id) ?? [];
      if (b.value <= 0 || !ts.length || ts.every((t) => mineSet.has(t)) || bonusDropped.has(b.id)) continue;
      const heldBefore = ts.every((t) => {
        const was = visibleState(before.get(t));
        return was?.owner.kind === 'player' && was.owner.playerId === pc.me;
      });
      if (!heldBefore) continue;
      const missing = ts.filter((t) => !mineSet.has(t));
      let cost = 0;
      const ok = missing.every((t) => {
        const st = state.get(t);
        if (!st || st.armies === null || st.owner.kind === 'unknown' || st.owner.kind === 'available') return false;
        if (st.owner.kind === 'player' && (!foe(st.owner.playerId) || pc.truce.noTarget(t))) return false;
        if (uncounted(t) || droppedMembers.has(t) || !neighborsOf(g, t).some((n) => mineSet.has(n))) return false;
        const c = costAt(t);
        if (c === null) return false;
        cost += c;
        return true;
      });
      if (!ok || cost > RETAKE_VALUE_TURNS * b.value) continue;
      const theirs = missing.filter((t) => state.get(t)!.owner.kind === 'player');
      if (!theirs.length) continue;
      for (const t of theirs) retakeMembers.add(t);
      rationale.push(
        `Retake ${theirs.map(label).join(', ')}: ${theirs.length > 1 ? 'they complete' : 'it completes'} bonus ${b.name} (+${b.value}) again, which I held in full last turn, for ${cost} armies (at most ${RETAKE_VALUE_TURNS} × its value), so ${theirs.length > 1 ? 'they are' : 'it is'} a bonus target (#430).`,
      );
    }
  }
  /**
   * #240: territories my attacks failed on repeatedly while their owner reinforced them
   * (`input.repulsed`, {@link repulsedAttacks}): still that opponent's, armies in view, next to mine,
   * its owner able to deploy there. Every capture of one is sized for its defenders plus that deploy
   * (#120's sure sizing) — #272: or plus the most its owner reinforced it on those failed turns, when less — and is not made when that size does not fit; a rationale line names the
   * failed turns. #240 review: its target keeps its plain cost, so every ranking (the bonus passes,
   * breaks and counter-attacks, rule 4e's fallback) treats it as the plan without the evidence does
   * — the sure size only decides whether it fits and what is sent ({@link sizeOf}). Ranked on the sure
   * size, a target that fitted dropped behind a worse one (under No-Split the whole stack went anyway).
   */
  /**
   * `sure` (#272 review): `extra` is the owner's whole deploy estimate, so the capture lands even if it
   * deploys there first — a worst case (no "assumes" warning; rule 6 counts the target as held). False
   * when the most it reinforced it by is below the estimate: the attack is sized for that, but a larger
   * deploy can still repel it, so it is no worst case and is judged like any other attack on a player.
   */
  const repulsed = new Map<number, { player: number; defenders: number; extra: number; cost: number; sure: boolean }>();
  for (const r of input.repulsed ?? []) {
    const t = r.territoryId;
    const st = state.get(t);
    if (st?.owner.kind !== 'player' || st.owner.playerId !== r.playerId || !foe(r.playerId) || st.armies === null) continue;
    if (uncounted(t) || !neighborsOf(g, t).some((n) => mineSet.has(n))) continue;
    const defenders = defenceAt(t);
    const estimate = reinforcementAt(t);
    // #272: sized for what its owner actually put there on those failed turns (after + my kills −
    // before; a transfer in counts), the most of them, never above its deploy estimate. Live, an
    // owner that had reinforced by 4 and 3 was sized for its ~29 deploy (95 armies) and not attacked;
    // a two-step of 14 then 24 took it next turn against 5.
    const seen = Math.max(...r.attacks.map((a) => a.after + a.kills - a.before));
    const extra = Math.min(estimate, seen);
    const cost = costAt(t, defenders + extra);
    if (extra <= 0 || cost === null) continue;
    repulsed.set(t, { player: r.playerId, defenders, extra, cost, sure: extra >= estimate });
    const turns = r.attacks.map((a) => a.turn);
    const listed = turns.length > 1 ? `${turns.slice(0, -1).join(', ')} and ${turns[turns.length - 1]}` : `${turns[0]}`;
    const size =
      extra < estimate
        ? `the most it reinforced it by on those turns, ~${extra}, below its owner's ~${estimate} deploy estimate (${defenders} + ${extra} defenders, ${cost} armies: a larger deploy there can still repel it, so it is no sure capture), or not made (#240, #272)`
        : `its owner's ~${extra} deploy there (${defenders} + ${extra} defenders, ${cost} armies), or not made (#240)`;
    rationale.push(
      `My attacks on ${label(t)} failed on turns ${listed}, player ${r.playerId} reinforcing it each time (${r.attacks
        .map((a) => `${a.armies} against ${a.before}, ${a.after} after`)
        .join('; ')}): a further attack is sized for ${size}.`,
    );
  }
  /**
   * #298: a bonus pushed all-in (`input.bonusPush.allIn`, after two failed attempts): every missing
   * member must be in view and beside a territory of mine; one another player holds is sized for its
   * defenders plus its owner's deploy (#368's middle figure, `reinforcementAt`), like #240's sure size
   * (taken at that size or not at all), a neutral at its capture cost. The push fits when the whole is at
   * most ALL_IN_VALUE_TURNS × the bonus's value and at most my income; planTurn drops it otherwise.
   */
  const allInTries = new Map<number, AllInTry>();
  for (const bonusId of [...(input.bonusPush?.allIn ?? [])].sort(byNum)) {
    const b = g.bonusById.get(bonusId);
    if (!b) continue;
    // #421: a stockpile's push spends armies already on the board: capped at the payback horizon × its value.
    const pile = input.stockpileAllIn?.has(bonusId) === true;
    const cap = pile ? Math.max(0, pc.capturePaybackTurns * b.value) : Math.max(0, Math.min(ALL_IN_VALUE_TURNS * b.value, pc.income));
    const sized: { t: number; player?: number; defenders: number; extra: number; cost: number }[] = [];
    let why: string | undefined;
    for (const t of bonusTerritories(g, bonusId).filter((x) => !mineSet.has(x))) {
      const st = state.get(t);
      if (!st || st.owner.kind === 'unknown' || st.armies === null) why ??= `${label(t)} is out of view`;
      else if (!neighborsOf(g, t).some((n) => mineSet.has(n))) why ??= `${label(t)} is out of reach this turn`;
      else if (uncounted(t)) why ??= `${label(t)} holds a special unit`;
      else if (st.owner.kind === 'player' && !foe(st.owner.playerId)) why ??= `${label(t)} is my teammate's`;
      else {
        const defenders = defenceAt(t);
        const extra = st.owner.kind === 'player' ? reinforcementAt(t) : 0;
        const cost = costAt(t, defenders + extra);
        if (cost === null) why ??= `${label(t)} cannot be taken`;
        else sized.push({ t, ...(st.owner.kind === 'player' ? { player: st.owner.playerId } : {}), defenders, extra, cost });
      }
    }
    const cost = sized.reduce((n, x) => n + x.cost, 0);
    if (!why && cost > cap)
      why = pile
        ? `the push needs ${cost} armies, over the cap of ${cap} (${pc.capturePaybackTurns} × its +${b.value}, #421)`
        : `the push needs ${cost} armies, over the cap of ${cap} (${ALL_IN_VALUE_TURNS} × its +${b.value}, at most my income ${pc.income})`;
    allInTries.set(bonusId, { feasible: !why, cost, cap, ...(why ? { detail: why } : {}) });
    if (why) continue;
    for (const x of sized)
      if (x.player !== undefined && x.extra > 0) repulsed.set(x.t, { player: x.player, defenders: x.defenders, extra: x.extra, cost: x.cost, sure: true });
  }
  /** A capture's cost of `t` (its ordinary sizing), or #240's sure one for a repulsed territory. */
  const costFor = (t: number): number | null => repulsed.get(t)?.cost ?? costAt(t);
  /**
   * #240 review: what a capture of target `t` must send — its cost, or a repulsed territory's sure
   * size. Fit checks use it; rankings use the target's cost. `cost`: the target's cost when it may
   * no longer be a target (rule 4e drops the enemy targets it added and did not take).
   */
  const sizeOf = (t: number, cost?: number): number => repulsed.get(t)?.cost ?? cost ?? targets.get(t)!.cost;
  /**
   * #203: adapting in a free-for-all on a big army lead (the lead strikes' conditions, #167), an
   * enemy member of a positive bonus next to mine (no special unit on it) is a step into that bonus
   * like a neutral one — sized like a lead strike (its defenders plus what its owner may deploy
   * there first), so the bonus passes fund it from this turn's deploy in rule 4f's order, under the
   * Local Deployment pools. Left to the lead strikes, which run once the income is spent, the
   * closest bonus's enemy member lost its deploy to a farther bonus's step.
   */
  const leadSteps = new Map<number, { player: number; defenders: number; extra: number }>();
  const leadStepsOn = auto && balanced && profile.format === 'ffa' && profile.opponents >= 2 && leadLever && !noSplit;
  const leadTry = new Map<number, LeadTry>();
  /**
   * #203: a lead step's capture reason names it, in every bonus pass that takes it. #214: `sure`
   * given, the step was retried at its bare cost (the sure one could not be funded): the note says
   * what it is sized for, and what would be sure.
   */
  const leadNote = (t: number, sure?: number) => {
    const lead = leadSteps.get(t);
    if (!lead) return '';
    const head = ` — player ${lead.player}'s member, taken on my army lead (${leadText()}): `;
    return sure === undefined
      ? `${head}sure even if player ${lead.player} deploys its ~${lead.extra} there first (${lead.defenders} + ${lead.extra} defenders)`
      : `${head}sized for the ${lead.defenders} defenders there now: ${sure} would be sure even if player ${lead.player} deploys its ~${lead.extra} there first, more than this turn can fund (#214)`;
  };
  for (const t of [...g.territoryById.keys()].sort(byNum)) {
    if (mineSet.has(t)) continue;
    const sources = neighborsOf(g, t).filter((n) => mineSet.has(n));
    if (!sources.length) continue;
    const st = state.get(t);
    const hiddenOwner = hiddenFoe(t);
    if (hiddenOwner !== undefined) {
      // #164: Dense / Heavy fog shows the owner and hides the armies.
      const tr = input.tracks?.find((x) => x.playerId === hiddenOwner);
      const pool = hiddenPool(hiddenOwner);
      const capped = pool.cap !== null && pool.unexplained > pool.cap;
      const bound =
        tr && tr.unexplained !== null
          ? `up to ${hiddenMovable(hiddenOwner)} armies there (player ${hiddenOwner}'s unaccounted armies from the tracker${
              capped
                ? `, ${pool.unexplained} in all, at most ${HIDDEN_POOL_INCOMES} turns of its income in one place: the rest is taken as spread over its hidden territories, and a larger bank there would not show`
                : ''
            }, counted once per border however many of its hidden territories touch it) beyond the guard`
          : 'the guard alone there (no tracker figure for its unaccounted armies)';
      warnings.push(
        `${label(t)} (player ${hiddenOwner}) borders my ${sources.map(label).join(', ')} and its armies are hidden by the fog: the threat from it counts ${bound} plus its deploy, and the win chance of an attack into it is unknown, so none is planned.`,
      );
      continue;
    }
    // #417, the breach force: land a static seat left, hidden now, is attacked at the 2-defender price
    // (`defenceAt` reads it so), until it is taken or the fog shows another player there.
    if (fogVacated(pc.vacated, st, t)) {
      const cost = costAt(t);
      if (cost !== null) {
        targets.set(t, { id: t, cost, enemy: false, sources });
        rationale.push(
          `${label(t)} is fogged and was player ${pc.vacated.get(t)}'s (out, no AI): its land behind the old border stands on ${VACATED_FOG_ARMIES} at most, so an attack into it is priced at ${VACATED_FOG_ARMIES} defenders (${cost} armies) (#417).`,
        );
        continue;
      }
    }
    if (!st || st.owner.kind === 'unknown' || st.armies === null) {
      warnings.push(
        `Fogged territory ${label(t)} borders my ${sources.map(label).join(', ')}: its armies are unknown (fog), so no attack is planned.`,
      );
      continue;
    }
    if (st.owner.kind === 'available') continue;
    // A teammate's territory is never a target (#128), nor a truce's covered territory (B2, T1).
    if (st.owner.kind === 'player' && (!foe(st.owner.playerId) || pc.truce.noTarget(t))) continue;
    if (uncounted(t)) {
      warnings.push(
        `${label(t)} holds ${uncountedKind(t)}, whose strength the board does not carry: its defence is unknown, so no attack is planned on it.`,
      );
      continue;
    }
    const enemy = st.owner.kind === 'player';
    if (enemy && goal !== 'complete-bonus' && !(balanced && (breakMember.has(t) || counterAt.has(t) || foggedMember.has(t))) && !pileMembers.has(t) && !retakeMembers.has(t)) {
      if (!leadStepsOn || unitsAt(t) > 0 || droppedMembers.has(t) || !g.map.bonuses.some((b) => b.value > 0 && bonusTs.get(b.id)!.includes(t))) continue;
      const defenders = defenceAt(t);
      const extra = reinforcementAt(t);
      const sure = costAt(t, defenders + extra);
      if (sure === null) continue;
      leadSteps.set(t, { player: (st.owner as { playerId: number }).playerId, defenders, extra });
      targets.set(t, { id: t, cost: sure, enemy, sources });
      continue;
    }
    // #240 review: a repulsed territory too ranks on its plain cost (its sure size is sent: sizeOf).
    const cost = costAt(t);
    if (cost === null) continue;
    targets.set(t, { id: t, cost, enemy, sources });
  }

  // Bonus passes work toward my own bonuses; under `balanced` enemy targets are only break candidates.
  // #203: a lead step is a bonus target too.
  // #421: a member of a contested bonus a stockpile pushes all-in is a bonus target too.
  // #430: a member that retakes a bonus I held last turn is a bonus target too.
  const bonusTarget = (t: number) =>
    targets.has(t) && !(balanced && targets.get(t)!.enemy && !leadSteps.has(t) && !pileMembers.has(t) && !retakeMembers.has(t));
  return { targets, leadSteps, leadStepsOn, leadTry, leadNote, bonusTarget, repulsed, costFor, sizeOf, allInTries, bonusDropped, droppedMembers };
}

/** Rule 4d: what a capture adds to the frontier (#71), and the offence report (#72). */
export function frontierCosts(
  pc: PlanCtx,
  threats: Threats,
  hd: Holds,
  prev: ReturnType<typeof breakTargets> & ReturnType<typeof captureTargets>,
) {
  const { g, guarded, mineSet, armiesOf, unitsAt, defenceAt, rates } = pc;
  const { holdArmies, nextTurnAt } = threats;
  const { conceded, stood } = hd;
  const { targets } = prev;
  // ---- 4d. frontier cost (#71) ----
  /** Armies a capture of `t` leaves there: its attack's survivors. */
  const survivorsOf = (t: number) => targets.get(t)!.cost - Math.round((defenceAt(t) * rates.defensiveKillRate) / 100);
  /**
   * `x` as a border when I hold `held` with `have` armies on it: a border when a neighbour is not
   * held; facing an enemy when a visible enemy is next to it, and then `need` is the deploys it
   * needs next turn to hold (the R3 arithmetic: threat = movable + max(deploy, growth) per player).
   */
  const deployOnce = pc.opts.experiments?.includes('deploy-once') === true;
  const borderOf = (x: number, held: ReadonlySet<number>, have: number) => {
    if (neighborsOf(g, x).every((n) => held.has(n))) return { border: false, enemy: false, need: 0, needStack: 0, player: -1 };
    // G2: next turn's threat — a player a Diplomacy card shields me from only this turn counts.
    const th = nextTurnAt(x, (n) => held.has(n));
    if (!th) return { border: true, enemy: false, need: 0, needStack: 0, player: -1 };
    const units = mineSet.has(x) ? unitsAt(x) : 0;
    const need = Math.max(0, holdArmies(th.threat) - have - units);
    if (!deployOnce) return { border: true, enemy: true, need, needStack: need, player: th.player };
    const st = nextTurnAt(x, (n) => held.has(n), 0);
    const needStack = st ? Math.min(need, Math.max(0, holdArmies(st.threat) - have - units)) : 0;
    return { border: true, enemy: true, need, needStack, player: th.player };
  };
  /**
   * A border's cost in armies: {@link NEUTRAL_BORDER_COST}, plus its hold need when it faces an
   * enemy under a guarded goal (`expand` and `complete-bonus` ignore defence, as in R3).
   */
  const borderCost = (b: ReturnType<typeof borderOf>, withNeed = true) =>
    b.border ? NEUTRAL_BORDER_COST + (guarded && withNeed ? b.needStack : 0) : 0;
  /**
   * The marginal frontier of adding `adds` to `base` (#71), in armies: the cost of every border
   * the capture touches after it (the captures and their held neighbours) minus their cost
   * before. Borders it opens add, borders it closes (a neighbour whose last outside neighbour it
   * takes) subtract. `haveOf` gives the armies on each territory (a capture: its survivors).
   * `needOnAdds` false leaves the captures' own hold need out (R3's defence cost already counts it).
   */
  const frontierDelta = (
    base: ReadonlySet<number>,
    adds: readonly number[],
    haveOf: (x: number) => number,
    needOnAdds = true,
  ) => {
    const after = new Set([...base, ...adds]);
    const touched = new Set(adds);
    for (const t of adds) for (const n of neighborsOf(g, t)) if (base.has(n)) touched.add(n);
    let armies = 0;
    let enemy = 0;
    for (const x of touched) {
      const now = borderOf(x, after, haveOf(x));
      armies += borderCost(now, needOnAdds || base.has(x));
      enemy += Number(now.enemy);
      if (!base.has(x)) continue;
      const was = borderOf(x, base, haveOf(x));
      armies -= borderCost(was);
      enemy -= Number(was.enemy);
    }
    return { armies, enemy };
  };
  /** Each target's frontier cost captured alone from my holdings at the start of the turn. */
  const edgeCost = new Map(
    [...targets.keys()].map((t) => [t, frontierDelta(mineSet, [t], (x) => (x === t ? survivorsOf(t) : armiesOf(x))).armies]),
  );
  /** A capture's cost in a score: its armies plus its frontier, at least one army (a cost of 0 stays 0). */
  const scoreCost = (cost: number, frontier: number) => (cost > 0 ? Math.max(1, cost + frontier) : 0);
  /** A target's cost in a score: its capture cost plus the frontier it adds alone. */
  const targetScoreCost = (t: number) => scoreCost(targets.get(t)!.cost, edgeCost.get(t)!);
  /**
   * A break's or counter-attack's cost in a score (#72): it only has to land, not survive the
   * counter-attack, so the captured territory's own hold need is left out. The rest of the
   * frontier change stays: its border weight, and my borders around it (the threat it removes).
   */
  const landScoreCost = (t: number) =>
    scoreCost(
      targets.get(t)!.cost,
      frontierDelta(mineSet, [t], (x) => (x === t ? survivorsOf(t) : armiesOf(x)), false).armies,
    );

  // ---- offence report (#72) ----
  /** The offensive options considered, by kind and target, in the order they were found. */
  const offence = new Map<string, OffenceEntry & { bonusId?: number }>();
  /** Why an offensive capture was not made, by target (the first reason wins). */
  const offenceSkip = new Map<number, string>();
  const skipOffence = (t: number, why: string) => {
    if (!offenceSkip.has(t)) offenceSkip.set(t, why);
  };
  /** Captures of a player's territory refused as a trade below even (rule 0p.3), by target. */
  const badTrades = new Map<number, { lost: number; killed: number }>();
  /**
   * The frontier when I hold `held`: borders, those facing an enemy, and the deploys they need next
   * turn to hold. A conceded border counts as a border but not in the hold cost: the plan gives it
   * up rather than pay for it (a garrison that still stands, #59, is held and counts).
   */
  const frontierOf = (held: ReadonlySet<number>, haveOf: (x: number) => number) => {
    let borders = 0;
    let enemyBorders = 0;
    let holdCost = 0;
    /** deploy-once: per opponent, the most its one floating deploy adds to any one border's need. */
    const floating = new Map<number, number>();
    for (const x of [...held].sort(byNum)) {
      const b = borderOf(x, held, haveOf(x));
      borders += Number(b.border);
      enemyBorders += Number(b.enemy);
      if (!conceded.has(x) || stood.has(x)) {
        holdCost += b.needStack;
        if (b.need > b.needStack) floating.set(b.player, Math.max(floating.get(b.player) ?? 0, b.need - b.needStack));
      }
    }
    for (const v of floating.values()) holdCost += v;
    return { borders, enemyBorders, holdCost };
  };
  /**
   * #433: each border's share of {@link frontierOf}'s hold cost (the same borders: a conceded one only while its
   * garrison stands), for the Local Deployment pools that can pay it.
   */
  const frontierNeeds = (held: ReadonlySet<number>, haveOf: (x: number) => number): Map<number, number> => {
    const needs = new Map<number, number>();
    for (const x of [...held].sort(byNum)) {
      const b = borderOf(x, held, haveOf(x));
      if ((!conceded.has(x) || stood.has(x)) && b.need > 0) needs.set(x, b.need);
    }
    return needs;
  };
  /** The frontier's hold cost at the start of the turn (my armies then; today's concessions left out). */
  const startHold = () => frontierOf(mineSet, armiesOf).holdCost;
  return { survivorsOf, borderOf, borderCost, frontierDelta, edgeCost, scoreCost, targetScoreCost, landScoreCost, offence, offenceSkip, skipOffence, badTrades, frontierOf, frontierNeeds, startHold };
}

/** Bonus scoring (rule 4, R3, #70, #101, #125, #167): the bonuses worth working toward, best first. */
export function bonusScoring(
  pc: PlanCtx,
  ps: PlanState,
  threats: Threats,
  prev: ReturnType<typeof breakTargets> & ReturnType<typeof captureTargets> & ReturnType<typeof frontierCosts>,
) {
  const {
    g, s, opts, guarded, focus, capturePaybackTurns: paybackTurns, territories: state, label, mineSet, armiesOf, defenceAt, completedOver,
    territoryShare, rates, costOf, costAt, econCostAt,
  } = pc;
  const { rationale } = ps;
  const { exposure } = threats;
  const { targets, bonusTarget, survivorsOf, frontierDelta, scoreCost } = prev;
  // ---- bonus scoring ----
  /**
   * "N armies to finish", naming the fogged members counted in it (#101): those at the costliest visible
   * member, and (#428) those costed as the game's neutral size.
   */
  const fogNote = (f: { fogged: number; fogEach: number; fogNeutral?: FogNeutral | undefined }) => {
    const parts = [
      ...(f.fogged ? [`${f.fogged} fogged member${f.fogged === 1 ? '' : 's'} counted at ${f.fogEach} each`] : []),
      ...(f.fogNeutral
        ? [`${f.fogNeutral.count} fogged member${f.fogNeutral.count === 1 ? '' : 's'} counted at ${f.fogNeutral.each} each: the game's neutral size, ${f.fogNeutral.size}`]
        : []),
    ];
    return parts.length ? ` (${parts.join('; ')})` : '';
  };
  const toFinish = (cost: number, f: Parameters<typeof fogNote>[0]) => `${cost} armies to finish${fogNote(f)}`;
  const plans: BonusPlan[] = [];
  /** #167: the share of the map's territories that started as wastelands, and what one costs to take and loses. */
  const wasteShare =
    s.wastelands && s.wastelands.count > 0 && s.wastelands.size > 0 && g.territoryById.size > 0
      ? Math.min(1, s.wastelands.count / g.territoryById.size)
      : 0;
  /**
   * #432: a visible neutral at the game's wasteland size or more, when the game has wastelands larger than its
   * ordinary neutrals (`neutralArmies`, when the settings give it).
   */
  const isWasteland = (st: { owner: { kind: string }; armies: number | null }): boolean =>
    s.wastelands !== undefined &&
    s.wastelands.count > 0 &&
    s.wastelands.size > (s.neutralArmies ?? 0) &&
    st.owner.kind === 'neutral' &&
    st.armies !== null &&
    st.armies >= s.wastelands.size;
  const wasteCost = wasteShare > 0 ? (costOf(s.wastelands!.size) ?? Infinity) : 0;
  const wasteLoss = wasteShare > 0 ? Math.min(wasteCost - 1, straightKills(s.wastelands!.size, rates.defensiveKillRate)) + 1 : 0;
  /** Every positive bonus worth completing (net > 0) still missing members: its armies to finish (rule 4e). */
  const finishCost = new Map<number, { cost: number; value: number; net: number; fogged: number; fogEach: number; fogNeutral?: FogNeutral }>();
  const economicMember = new Set<number>();
  const uneconomicMember = new Set<number>();
  /** Missing members of a negative bonus (not focused): plain expansion never steps into one. */
  const negativeMember = new Set<number>();
  /** #201: a remembered neutral's rationale line (its index) and the bonuses it names. */
  const rememberedSaid = new Map<number, { at: number; bonuses: string[] }>();
  /** #428: the same for a member costed at its last sighting. */
  const lastSeenSaid = new Map<number, { at: number; bonuses: string[] }>();
  /** Says once per territory, naming every bonus it is costed in (#201, #428). */
  const sayOnce = (said: Map<number, { at: number; bonuses: string[] }>, t: number, b: { id: number; name: string }, tail: string) => {
    const was = said.get(t);
    if (was) {
      was.bonuses.push(`${b.name} (#${b.id})`);
      rationale[was.at] = `${was.bonuses.join(', ')}: ${tail}`;
    } else {
      said.set(t, { at: rationale.length, bonuses: [`${b.name} (#${b.id})`] });
      rationale.push(`${b.name} (#${b.id}): ${tail}`);
    }
  };
  // #428: the game's neutral size, costed once: a fogged member no board showed, whose owner the fog hides.
  const neutralSize = s.neutralArmies !== undefined && s.neutralArmies >= 0 ? s.neutralArmies : undefined;
  const neutralCost = neutralSize !== undefined ? (costOf(neutralSize) ?? Infinity) : Infinity;
  const neutralLoss = neutralSize !== undefined && Number.isFinite(neutralCost) ? Math.min(neutralCost - 1, straightKills(neutralSize, rates.defensiveKillRate)) + 1 : Infinity;
  // #435: whether the Gift card is in play (the shared-bonus handover needs it).
  const giftInPlay = pc.game.cardsInPlay?.includes('Gift') === true;
  for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
    const isFocus = focus.has(b.id);
    const ts = bonusTerritories(g, b.id);
    let remaining = ts.filter((t) => !mineSet.has(t));
    if (b.value < 0 && !isFocus) {
      // Completing it would cut income: never plan into it (an economic
      // membership elsewhere still wins — see the pass-3 filter).
      for (const t of remaining) {
        uneconomicMember.add(t);
        negativeMember.add(t);
      }
      continue;
    }
    if (b.value <= 0 && !isFocus) continue;
    if (!remaining.length) continue;
    // #298: a bonus dropped after repeated failed attempts is not funded: its members are no bonus step.
    if (prev.bonusDropped.has(b.id)) {
      for (const t of remaining) uneconomicMember.add(t);
      continue;
    }
    // PLAN-TEAMS C3.3: a bonus pays only the player holding every member, so one with a member my
    // teammate visibly holds is not mine to complete (plan/team.ts reports the shared ones).
    const mates = remaining.filter((t) => teammateAt(pc, t));
    // #435 (proposed rule): one of us must work a shared bonus, or nobody does (45701358: four, +69,
    // left to plain expansion). Whoever holds the most members (`nearer`, as team.sharedBonuses reads
    // it) works it: when that is me, alone, its other members are scored as mine to take, and the
    // teammate's members are theirs to hand over (a Gift) — never captured, never costed, and never
    // a completion this turn (`completable` false while they stand), so no income is claimed for it.
    // Owner decision 2026-11-22: only with the Gift card in play — the handover needs one; without it
    // (or the cards unread) a shared bonus is skipped as before.
    const handover = mates.length ? (giftInPlay && nearerMe(pc, ts) ? mates : undefined) : [];
    if (handover === undefined) {
      if (remaining.some(bonusTarget) || isFocus)
        rationale.push(
          `Skip bonus ${b.name} (#${b.id}): my teammate holds ${mates.map(label).join(', ')}, and a bonus pays only the player holding all of it.`,
        );
      if (isFocus) ps.warnings.push(`Focus on bonus ${b.name} (#${b.id}) ignored: my teammate holds ${mates.map(label).join(', ')} (one owner per bonus).`);
      continue;
    }
    if (handover.length) {
      remaining = remaining.filter((t) => !handover.includes(t));
      if (!remaining.length) continue;
    }
    // Cluster as a unit (#70): the negative bonuses its missing members complete come off its
    // worth (on a map without negative bonuses, net = value).
    const rest = new Set(remaining);
    const penalties = completedOver((x) => mineSet.has(x) || rest.has(x), remaining).filter((id) => id !== b.id && g.bonusById.get(id)!.value < 0);
    const penalty = penalties.reduce((n, id) => n + g.bonusById.get(id)!.value, 0);
    // #125: its missing members' per-territory income (Extra Armies for Territories) is income too.
    const perGain = territoryShare(remaining.length);
    const net = b.value + penalty + perGain;
    if (penalty < 0 && remaining.some(bonusTarget))
      rationale.push(
        `Bonus ${b.name} (#${b.id}) (+${b.value}) is worth +${net} net once complete: its missing members also complete ${penalties.length} negative bonus${penalties.length === 1 ? '' : 'es'} (${penalty}), and each step short of completion only adds penalties.`,
      );
    if (net <= 0 && !isFocus) {
      for (const t of remaining) uneconomicMember.add(t);
      if (remaining.some(bonusTarget))
        rationale.push(`Skip bonus ${b.name} (#${b.id}): completing it costs more income than it pays (net ${net}).`);
      continue;
    }
    // Armies to finish (#101): every missing member's capture cost. A fogged member a static seat left
    // is priced by #417 first (below); any other is costed from what is known of it (#428): its last sighting on my boards (unless the fog shows another owner
    // now), else (#201) its size on the picking board, else the game's neutral size (when its owner is
    // hidden too); only with none of those does it count at its bonus's costliest visible missing
    // member (counting it as free made the figure jump when it came into view; 65 finished-game plans
    // counted every one at 208); with none visible either, the bonus cannot be costed.
    let cost = 0;
    let worst = 0;
    let fogged = 0;
    let foggedNeutral = 0;
    // #125: the economy test charges the armies lost, not the armies sent.
    let loss = 0;
    let worstLoss = 0;
    /** #432: its missing members in view that are wastelands. */
    const wastelands: number[] = [];
    const known = (t: number, armies: number) => {
      const c = costAt(t, armies) ?? Infinity;
      cost += c;
      worst = Math.max(worst, c);
      const l = Math.min(c - 1, straightKills(armies, rates.defensiveKillRate)) + 1;
      loss += l;
      worstLoss = Math.max(worstLoss, l);
    };
    /** #417: the fogged members a static seat left, each with its cost and loss at VACATED_FOG_ARMIES. */
    const vacatedFog: { t: number; left: number; c: number; l: number }[] = [];
    for (const t of remaining) {
      const st = state.get(t);
      if (!st || st.owner.kind === 'unknown' || st.armies === null) {
        // #417 first: land a static seat left is thin behind its border stack: costed at most at
        // VACATED_FOG_ARMIES defenders, and never raising what another fogged member counts at.
        const left = pc.vacated.get(t);
        if (left !== undefined) {
          const c = costAt(t, VACATED_FOG_ARMIES) ?? Infinity;
          vacatedFog.push({ t, left, c, l: Math.min(c - 1, straightKills(VACATED_FOG_ARMIES, rates.defensiveKillRate)) + 1 });
          continue;
        }
        const shown = st?.owner.kind === 'player' ? st.owner.playerId : undefined;
        // #428: its last sighting, under the owner the fog shows now (or any, when it shows none).
        const seen = opts.lastSeen?.get(t);
        if (seen && (shown === undefined || seen.owner === shown)) {
          known(t, seen.armies);
          if (remaining.some(bonusTarget))
            sayOnce(lastSeenSaid, t, b, `${label(t)}, fogged now, was last seen at ${seen.armies} armies (#428): costed at that.`);
          continue;
        }
        // #201: a neutral the picking board showed keeps its size (an owner the fog shows is not one).
        const was = opts.rememberedNeutrals?.get(t);
        if (was === undefined || shown !== undefined) {
          // #428: a member whose owner is hidden too is costed as the game's neutral size, when known.
          if (shown === undefined && Number.isFinite(neutralCost)) foggedNeutral++;
          else fogged++;
          continue;
        }
        known(t, was);
        if (remaining.some(bonusTarget))
          sayOnce(rememberedSaid, t, b, `${label(t)}, fogged now, was a neutral of ${was} on the picking board (#201): costed at that.`);
        continue;
      }
      const c = costAt(t) ?? Infinity;
      cost += c;
      worst = Math.max(worst, c);
      if (isWasteland(st)) wastelands.push(t);
      const l = econCostAt(t);
      loss += l;
      worstLoss = Math.max(worstLoss, l);
    }
    // #417: a member a static seat left counts at the lesser of its VACATED_FOG_ARMIES cost and the
    // costliest member in view; with none in view (only fog), at that cost.
    const inView = remaining.length - fogged - foggedNeutral - vacatedFog.length > 0;
    for (const v of vacatedFog) {
      const c = inView ? Math.min(v.c, worst) : v.c;
      cost += c;
      loss += inView ? Math.min(v.l, worstLoss) : v.l;
      if (remaining.some(bonusTarget))
        sayOnce(
          rememberedSaid,
          v.t,
          b,
          `${label(v.t)}, fogged now, was player ${v.left}'s (out, no AI): its land behind a border stack stands on ${VACATED_FOG_ARMIES} at most, so it is costed at ${c}, not at a stack in view (#417).`,
        );
    }
    let fogEach = fogged ? (inView ? worst : Infinity) : 0;
    let fogLoss = fogged ? (inView ? worstLoss : Infinity) : 0;
    let neutralEach = foggedNeutral ? neutralCost : 0;
    let neutralEachLoss = foggedNeutral ? neutralLoss : 0;
    // #167: with automatic Wastelands, a fogged member may be one: its expected surcharge over an
    // ordinary member is (wastelands ÷ territories on the map) × (a wasteland's cost − this one's).
    if (wasteShare > 0 && (fogged || foggedNeutral)) {
      // The loss rises with the cost only (an expected surcharge of 0 adds no loss either).
      const surcharge = (each: number, eachLoss: number) => {
        const extra = Number.isFinite(each) ? Math.ceil(wasteShare * Math.max(0, wasteCost - each)) : 0;
        return { extra, extraLoss: extra > 0 ? Math.ceil(wasteShare * Math.max(0, wasteLoss - eachLoss)) : 0 };
      };
      const a = fogged ? surcharge(fogEach, fogLoss) : { extra: 0, extraLoss: 0 };
      const n = foggedNeutral ? surcharge(neutralEach, neutralEachLoss) : { extra: 0, extraLoss: 0 };
      fogEach += a.extra;
      fogLoss += a.extraLoss;
      neutralEach += n.extra;
      neutralEachLoss += n.extraLoss;
      const count = (a.extra > 0 ? fogged : 0) + (n.extra > 0 ? foggedNeutral : 0);
      const expected = a.extra * fogged + n.extra * foggedNeutral;
      if (expected > 0 && remaining.some(bonusTarget))
        rationale.push(
          `${b.name} (#${b.id}): its ${count} fogged member${count === 1 ? '' : 's'} may be ${count === 1 ? 'a wasteland' : 'wastelands'} (${s.wastelands!.count} of the map's ${g.territoryById.size} territories start at ${s.wastelands!.size}): +${expected} armies expected.`,
        );
    }
    cost += fogged * fogEach + foggedNeutral * neutralEach;
    loss += fogged * fogLoss + foggedNeutral * neutralEachLoss;
    const fogNeutral: FogNeutral | undefined = foggedNeutral ? { count: foggedNeutral, each: neutralEach, size: neutralSize! } : undefined;
    // #432: while the gate budget is short, no bonus is built through a wasteland: its armies go to the gates —
    // unless this turn's captures can complete it (owner decision 2026-11-22: a completing wasteland is taken).
    const wasteStop = !isFocus && pc.shortGates !== undefined && wastelands.length > 0 && !remaining.every(bonusTarget);
    const economic = isFocus || (loss <= paybackTurns * net && worstLoss <= WASTELAND_FACTOR * net && !wasteStop);
    // #435: a shared bonus I am nearer to but that is not worth working stays as C3.3 left it — skipped
    // with its members plain expansion, never marked uneconomic (45701358 turn 1: a 344-member super-bonus,
    // 6 members to my teammate's 5, would otherwise have stopped expansion into all its members).
    if (handover.length && !economic) {
      if (remaining.some(bonusTarget))
        rationale.push(
          `Skip bonus ${b.name} (#${b.id}): my teammate holds ${handover.map(label).join(', ')}, and a bonus pays only the player holding all of it.`,
        );
      continue;
    }
    if (b.value > 0) finishCost.set(b.id, { cost, value: b.value, net, fogged, fogEach, ...(fogNeutral ? { fogNeutral } : {}) });
    for (const t of remaining) (economic ? economicMember : uneconomicMember).add(t);
    if (!remaining.some(bonusTarget)) continue;
    if (!economic && wasteStop && loss <= paybackTurns * net && worstLoss <= WASTELAND_FACTOR * net) {
      rationale.push(
        `Skip bonus ${b.name} (#${b.id}): finishing it means taking the wasteland${wastelands.length === 1 ? '' : 's'} ${wastelands.map(label).join(', ')} (${s.wastelands!.size} armies or more) while the gates facing player ${pc.shortGates!.player} are ${pc.shortGates!.deficit} short (#432).`,
      );
      continue;
    }
    if (!economic) {
      rationale.push(
        `Skip bonus ${b.name} (#${b.id}): uneconomic for +${net === b.value ? b.value : `${b.value} (net +${net})`} (${toFinish(cost, { fogged, fogEach, fogNeutral })}, losing ~${loss}; ${worstLoss} lost on its costliest territory).`,
      );
      continue;
    }
    // #435: said once the bonus is worth working (an uneconomic one says only that).
    if (handover.length) {
      const mineN = ts.filter((t) => mineSet.has(t)).length;
      rationale.push(
        `Bonus ${b.name} (#${b.id}): I hold ${mineN} of its ${ts.length} members, my teammate ${handover.length} — I am nearer, so it is mine to work ` +
          `(#435); it pays only once my teammate hands over ${handover.map(label).join(', ')} (a Gift), so no capture here completes it.`,
      );
    }
    // R3: what holding the completed bonus's frontier would cost next turn (each
    // remaining member holding the survivors of its capture, mine their armies now).
    let defenseCost = 0;
    if (guarded && !handover.length && remaining.every(bonusTarget)) {
      const rem = new Set(remaining);
      const exposed = exposure(ts, (n) => rem.has(n), (m) => {
        if (!rem.has(m)) return armiesOf(m);
        const c = targets.get(m)!.cost;
        return c - straightKills(defenceAt(m), rates.defensiveKillRate);
      });
      defenseCost = exposed.reduce((sum, e) => sum + e.need, 0);
      if (defenseCost > 0)
        rationale.push(
          `Bonus ${b.name} (#${b.id}) needs ~${defenseCost} more armies next turn to hold its frontier once completed (${exposed.map((e) => `${label(e.id)} ${e.need}`).join(', ')}): its score is +${b.value} / (${cost} + ${DEFENSE_DISCOUNT} × ${defenseCost}).`,
        );
    }
    // #71: the frontier its missing members add (their hold need left out when R3 judged it).
    const reach = remaining.filter((t) => targets.has(t));
    const frontier = frontierDelta(
      mineSet,
      reach,
      (x) => (mineSet.has(x) ? armiesOf(x) : survivorsOf(x)),
      !(guarded && !handover.length && remaining.every(bonusTarget)),
    ).armies;
    plans.push({
      bonusId: b.id,
      value: b.value,
      focus: isFocus,
      remaining,
      // #435: never complete while a teammate's member is still theirs.
      completable: !handover.length && remaining.every(bonusTarget),
      cost,
      borders: analyzeBonus(g, b.id)!.borderTerritoryIds.length,
      defenseCost,
      net,
      frontier,
      fogged,
      fogEach,
      ...(fogNeutral ? { fogNeutral } : {}),
    });
  }
  const ratio = (p: BonusPlan) => {
    const cost = scoreCost(p.cost + DEFENSE_DISCOUNT * p.defenseCost, p.frontier);
    return cost > 0 ? p.net / cost : Infinity;
  };
  plans.sort(
    (a, b) =>
      Number(b.focus) - Number(a.focus) || ratio(b) - ratio(a) || a.borders - b.borders || a.bonusId - b.bonusId,
  );
  return { fogNote, toFinish, plans, wasteShare, wasteCost, wasteLoss, finishCost, economicMember, uneconomicMember, negativeMember, rememberedSaid, ratio };
}

/**
 * #435: whether I alone hold the most members of `ts` among me and each teammate visibly holding one
 * (the `nearer` of team.sharedBonuses, plan/team.ts); a tie is nobody's.
 */
function nearerMe(pc: Pick<PlanCtx, 'allies' | 'territories' | 'mineSet'>, ts: readonly number[]): boolean {
  const mine = ts.filter((t) => pc.mineSet.has(t)).length;
  const per = new Map<number, number>();
  for (const t of ts) {
    const o = pc.territories.get(t)?.owner;
    if (o?.kind === 'player' && pc.allies.has(o.playerId)) per.set(o.playerId, (per.get(o.playerId) ?? 0) + 1);
  }
  return mine > Math.max(0, ...per.values());
}

/** #319: the opening warning's bound: at least this many territories held with no bonus. */
export const SPREAD_TERRITORIES = 10;
/** #319: the last turn the opening warning runs on (from turn 2). */
export const SPREAD_LAST_TURN = 6;
/** #319: "near base": an income at most this much above the base income. */
export const SPREAD_INCOME_SLACK = 3;

/** #416: the least value a bonus held in full needs to end rule 4f's commitment and #319's warning. */
export const HOLDS_BONUS_MIN_VALUE = 2;

/** #101: commit to the bonus closest to completion; a break's retake check; #319's spread warning. */
export function closestBonus(
  pc: PlanCtx,
  ps: PlanState,
  input: PlanInput,
  prev: ReturnType<typeof breakTargets> & ReturnType<typeof captureTargets> & ReturnType<typeof frontierCosts> & ReturnType<typeof bonusScoring>,
  hd?: Pick<Holds, 'keepFor'>,
) {
  const { g, me, income, profile, territories: state, label, bonusName, mine, mineSet, bonusTs, toTake, armiesOf, guard } = pc;
  const { rationale, avail } = ps;
  const { fogNote, plans } = prev;
  // ---- #101: commit to the closest bonus ----
  // While no bonus is held (and in the opening and expansion phases), expansion goes to the bonus
  // closest to completion — fewest turns to finish at this income (its armies to finish, counting
  // the members I hold, over the income) — then the next closest, instead of one capture into each
  // of several large bonuses by value per army. Bonuses as close as each other go by the income per
  // army of every bonus their capture completes (#438: a pair bonus on top of a single-territory one
  // counts), then a bonus advanced last turn (a member captured since `previousBoard`) first, then the
  // score order (value per army, rule 4). Focused bonuses come first.
  // #416: a bonus held counts only from HOLDS_BONUS_MIN_VALUE up: one point of income is no base to build
  // on, and holding a +1 silenced #319 in a live game while the captures stayed spread.
  const heldValues = g.map.bonuses
    .filter((b) => {
      const ts = bonusTs.get(b.id)!;
      return b.value > 0 && ts.length > 0 && ts.every((t) => mineSet.has(t));
    })
    .map((b) => b.value);
  const holdsBonus = heldValues.some((v) => v >= HOLDS_BONUS_MIN_VALUE);
  /** #416: a bonus is held, but none worth HOLDS_BONUS_MIN_VALUE: the lines say so instead of "no bonus". */
  const holdsSmallOnly = !holdsBonus && heldValues.length > 0;
  const noBonusText = holdsSmallOnly ? `no bonus worth more than +${HOLDS_BONUS_MIN_VALUE - 1}` : 'no bonus';
  // #132: in an FFA, contact with one front still leaves neutrals to expand into: keep committing
  // while any neutral borders a territory of mine.
  const neutralsInReach =
    profile.format === 'ffa' && mine.some((t) => neighborsOf(g, t).some((n) => state.get(n)?.owner.kind === 'neutral'));
  const committing = !holdsBonus || profile.phase === 'opening' || profile.phase === 'expansion' || neutralsInReach;
  const advancedLast = new Set<number>();
  if (input.previousBoard) {
    const before = new Map(input.previousBoard.territories.map((t) => [t.territoryId, t]));
    for (const p of plans) {
      const took = bonusTs.get(p.bonusId)!.some((t) => {
        const o = before.get(t)?.owner;
        return mineSet.has(t) && o !== undefined && o.kind !== 'unknown' && !(o.kind === 'player' && o.playerId === me);
      });
      if (took) advancedLast.add(p.bonusId);
    }
  }
  /**
   * #125: the layers a bonus's missing members are reached in — the farthest one's distance from
   * what I hold. A capture's armies attack no further this turn, so a chain takes a turn a layer
   * however cheap its members are.
   */
  const fromMine = bfsDistances(g, mine);
  const depthOf = (p: BonusPlan) => Math.max(0, ...p.remaining.map((t) => fromMine.get(t) ?? 0));
  /**
   * #416: the armies already standing beside a bonus's missing members — each territory of mine next to
   * one, counted once, with what it can send beyond the guard and beyond what holds it (`keepFor`:
   * exact holds come first). A start on 10 armies beside a bonus finishes it without waiting for the
   * income, so counting only the income ranked it level with a bonus the deploys need two turns for.
   */
  const standing = new Map<number, number>();
  const standingBeside = (p: BonusPlan) => {
    const was = standing.get(p.bonusId);
    if (was !== undefined) return was;
    const rest = new Set(p.remaining);
    let n = 0;
    for (const x of mine) {
      if (!neighborsOf(g, x).some((t) => rest.has(t))) continue;
      const movable = Math.min(avail.get(x) ?? 0, armiesOf(x) - guard);
      const keep = hd ? hd.keepFor(x, () => false) : 0;
      n += Math.max(0, movable - keep);
    }
    const credit = Math.min(n, p.cost);
    standing.set(p.bonusId, credit);
    return credit;
  };
  /**
   * Turns to finish a bonus at this income once the armies standing beside it are spent (#416), and at
   * least its depth (with no income, its armies to finish less those).
   */
  const turnsOf = (p: BonusPlan) => {
    const left = Math.max(0, p.cost - standingBeside(p));
    return income > 0 ? Math.max(Math.ceil(left / income), depthOf(p)) : left;
  };
  const scoreRank = new Map(plans.map((p, i) => [p.bonusId, i]));
  /**
   * #438: every bonus a plan's capture completes — each plan whose missing members are all among
   * its own (a pair bonus beside a single-territory one) — with their net income added up.
   */
  const completesWith = (p: BonusPlan) => plans.filter((q) => q.remaining.every((t) => p.remaining.includes(t)));
  const incomeOf = (p: BonusPlan) => completesWith(p).reduce((n, q) => n + q.net, 0);
  /** #438: that income per army, on the score's cost (`ratio`, scaled from this bonus's net to the sum). */
  const perArmy = (p: BonusPlan) => {
    const r = prev.ratio(p);
    return Number.isFinite(r) && p.net > 0 ? (r * incomeOf(p)) / p.net : r;
  };
  /** #416: its missing members in the fog, however each is costed. */
  const foggedOf = (p: BonusPlan) => p.fogged + (p.fogNeutral?.count ?? 0);
  /**
   * Bonus plans closest to completion first (focus first; ties: the income per army of every bonus
   * the capture completes, #438, then #416's fewer armies to finish and fewer fogged members — the
   * figure least likely to be wrong —, then advanced last turn, then the score order). #416 asked for
   * its keys first; ahead of #438 they ranked a cheap +3 over completing a bonus that lifts a −8
   * penalty (negative-bonuses (c): next income 20 → lower), so they only split what #438 leaves even.
   */
  const byCloseness = committing
    ? [...plans].sort(
        (a, b) =>
          Number(b.focus) - Number(a.focus) ||
          turnsOf(a) - turnsOf(b) ||
          perArmy(b) - perArmy(a) ||
          a.cost - b.cost ||
          foggedOf(a) - foggedOf(b) ||
          Number(advancedLast.has(b.bonusId)) - Number(advancedLast.has(a.bonusId)) ||
          scoreRank.get(a.bonusId)! - scoreRank.get(b.bonusId)!,
      )
    : plans;
  const turnsText = (p: BonusPlan) => {
    const n = turnsOf(p);
    const deep = n > Math.max(1, Math.ceil(Math.max(0, p.cost - standingBeside(p)) / income)) ? ` (${n} layers deep)` : '';
    return income > 0 ? `${n} turn${n === 1 ? '' : 's'}${deep}` : 'no income';
  };
  /** #416: the armies standing beside it, when any count toward its turns. */
  const standingNote = (p: BonusPlan) => {
    const n = standingBeside(p);
    return n > 0 ? ` (${n} standing beside it)` : '';
  };
  if (committing && byCloseness.length > 1) {
    const why = holdsBonus
      ? `${profile.phase[0]!.toUpperCase()}${profile.phase.slice(1)} phase${
          profile.phase === 'opening' || profile.phase === 'expansion' ? '' : ', neutrals in reach'
        }`
      : `${noBonusText[0]!.toUpperCase()}${noBonusText.slice(1)} held`;
    rationale.push(
      `${why}: expansion goes to the bonus closest to completion first — ${byCloseness
        .map(
          (p, i) =>
            `${bonusName(p.bonusId)} ${i ? p.cost : `${p.cost} armies to finish`}${fogNote(p)}${standingNote(p)}, ${turnsText(p)}${i || income <= 0 ? '' : ` at income ${income}`}`,
        )
        .join(', ')} — and a farther bonus gets only armies the closer ones cannot use.`,
    );
    const top = byCloseness.find((p) => !p.focus);
    // #438: a capture that completes more than one bonus says what they add up to per army.
    const said = new Set<string>();
    for (const p of byCloseness) {
      const all = completesWith(p);
      const key = [...p.remaining].sort((x, y) => x - y).join(',');
      // Only where it ranks: another bonus as close that this capture does not complete.
      const rivals = byCloseness.some((q) => !all.includes(q) && !q.focus && turnsOf(q) === turnsOf(p));
      if (all.length < 2 || !rivals || said.has(key)) continue;
      said.add(key);
      const names = all.map((q) => bonusName(q.bonusId));
      rationale.push(
        `${names.slice(0, -1).join(', ')} and ${names.at(-1)} complete together for ${p.cost} armies: +${incomeOf(p)} next-turn income, ${(incomeOf(p) / p.cost).toFixed(2)} per army — ranked on that among bonuses as close (#438).`,
      );
    }
    for (const p of byCloseness.filter((x) => advancedLast.has(x.bonusId))) {
      if (p === top)
        rationale.push(
          `${bonusName(p.bonusId)} keeps priority: I advanced it last turn, and no bonus is strictly closer to completion.`,
        );
      else if (top && !p.focus && turnsOf(top) < turnsOf(p))
        rationale.push(
          `${bonusName(p.bonusId)}, advanced last turn, gives way to ${bonusName(top.bonusId)}: it is strictly closer to completion (${turnsText(top)} to finish against ${turnsText(p)}).`,
        );
    }
  }
  // #319: in the opening (turns 2–6), many territories on an income near base means the captures are
  // spread over bonuses and none completed (six lost games held 11–20 territories on 8 or less after
  // turn 4). The warning names rule 4f's nearest bonus with its armies and turns; #416 (owner 2026-11-22) binds
  // the deploys to it (plan/spread-bind.ts).
  const turnNow = pc.game.turn ?? null;
  const base = Math.max(0, Math.floor(input.settings?.baseIncome ?? DEFAULT_BASE_INCOME));
  /** #416 part 4: the nearest bonus #319 names, whose reachable steps the deploys are bound to (plan/spread-bind.ts). */
  let spreadNearest: BonusPlan | undefined;
  if (
    turnNow !== null &&
    turnNow >= 2 &&
    turnNow <= SPREAD_LAST_TURN &&
    !holdsBonus &&
    mine.length >= SPREAD_TERRITORIES &&
    income <= base + SPREAD_INCOME_SLACK
  ) {
    const nearest = committing ? byCloseness.find((p) => !p.focus) ?? byCloseness[0] : undefined;
    spreadNearest = nearest;
    ps.warnings.push(
      `${mine.length} territories, ${noBonusText}: the captures are spread (income ${income}, base ${base}). ` +
        (nearest
          ? `Nearest bonus to complete: ${bonusName(nearest.bonusId)}, ${nearest.cost} armies to finish${fogNote(nearest)}${standingNote(nearest)}, ` +
            `${turnsText(nearest)}${income > 0 ? ` at income ${income}` : ''} (rule 4f).`
          : 'No bonus is worth completing from here.') +
        ' Complete one before taking more territories outside it (#319).',
    );
  }
  /**
   * A break's retake check, by its target: the warning it raised (if any) and what it was
   * judged on, so a top-up that adds survivors re-judges it.
   */
  const retakeChecks = new Map<number, { bonusId: number; survivors: number; counter: number; warning?: string }>();
  const retakeWarning = (t: number, bonusId: number, survivors: number, counter: number): string | undefined => {
    const take = toTake(survivors);
    return take !== null && take <= counter
      ? `${label(t)} can be retaken after it breaks ${bonusName(bonusId)}: ${survivors} survivors need ${take} to take, against ~${counter} next turn.`
      : undefined;
  };
  return { holdsBonus, neutralsInReach, committing, advancedLast, fromMine, depthOf, turnsOf, scoreRank, byCloseness, turnsText, spreadNearest, retakeChecks, retakeWarning };
}
