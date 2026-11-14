// B2 (docs/PLAN-TEAMS.md section 8): the planner honours a truce. The rule logic lives here; the
// phase modules only call it.
//
// A truce (`PlanInput.relations`) is honoured only in a free-for-all, while `active` or in `notice`
// (until its `endsTurn`), with a player who is a foe (not me, not a teammate) — except T1, which
// holds wherever the agreement binds, a team or two-player game included (D3: never a surprise
// break; `warapp_submit_turn` refuses such an order in any format):
//   T1  a covered territory of the partner is never a target, in any pass (`noTarget`: the targets,
//       tryCapture, the strikes, the lead strikes, the guard-off breaks and rule 4e's enemy fallback);
//   T2  a covered border of mine that faces only the partner is sized for the partner's visible
//       stacks next to it attacking with no deploy and no trend (`forceAt`; its separate-attack
//       rule still applies), and the report never says it is sized for that deploy (`relaxedFor`);
//   T3  never relaxed: my commander's territory, a border protecting more than
//       TRUCE_RELAX_VALUE × my income, any border while the trust is `watch`;
//   T4  the partner is no front: not for the no-second-front rule (rule 0p.2, a partner still
//       playing: `partnerFronts`), and idle armies do not walk toward its covered territories (rule 6);
//   T5  a border cap: my orders leave at most the cap on a covered border territory — no transfer or
//       withdrawal of mine fills it past the cap (`capRoom`), and the excess is deployed one step
//       behind, an incoming transfer trimmed, or the standing armies moved one step behind toward
//       another front, said so when I already stand above it; a warning when what the cap leaves
//       falls short against another opponent there, or of T3's full hold under my commander;
//   T6  what a break would cost (`truceBreakLosses`, after the plan is finished): for each binding
//       truce, the partner's whole deploy estimate on one of its covered territories beside a covered
//       territory of mine and an attack on it with everything there, carried out against this plan's
//       own deploys and moves on the turn simulator (turn-sim.ts), both move orders unless the first
//       mover is known; the costliest is reported (`lossIfBroken`);
//   T7  never a surprise break: a notice binds until its `endsTurn`; the plan advises `give-notice`
//       when the trust turned `watch` for the endgame or for outgrowing;
//   T8  broken by them (`state: 'broken'`): an ordinary opponent at once, the plan naming the term,
//       the turn and the evidence, and saying to record `broken-by-them` before submitting;
//   T9  enforced (a Diplomacy card the decoder is sure of): that player is no foe for the turn — its
//       threat is 0 and no attack on it is planned.
// With no relations every function here is a no-op, so every plan is byte-identical to one made
// without them. Pure and deterministic (ties on ascending id).
import { bonusTerritories } from '../bonuses.js';
import { bfsDistances, neighborsOf } from '../graph.js';
import { simTerritories, simulateTurn, type SimResult } from '../turn-sim.js';
import type { GameFormat } from '../profile.js';
import type { DeployBook } from './orders.js';
import type { Holds } from './holds.js';
import {
  CONCEDE_FACTOR,
  type PlanAdvice,
  type PlanInput,
  type PlannedDeploy,
  type PlannedMove,
  type PlanRelation,
  type PlanRelationView,
  type TruceBreakLoss,
  type TruceWatchReason,
} from './shared.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Threats } from './threats.js';
import { byNum } from './util.js';

/** T3: a covered border protecting more than this share of my income keeps its full hold. */
export const TRUCE_RELAX_VALUE = 0.25;

/** The truces of one plan, as the estimates phase resolved them (T1, T4, T7, T8, T9). */
export interface Truce {
  /** The relations given, in input order. */
  given: readonly PlanRelation[];
  /** How each given relation was read, parallel to `given`. */
  status: readonly PlanRelationView['state'][];
  /** Whether each given relation binds this turn, parallel to `given`. */
  binds: readonly boolean[];
  /** T4: players a binding truce holds (no front for rule 0p.2). */
  partners: ReadonlySet<number>;
  /** T9: players an enforced truce makes no foe this turn. */
  enforced: ReadonlySet<number>;
  /**
   * T1: a territory of a partner the agreement covers (every one of an enforced partner) — wherever
   * the agreement binds, a team or two-player game included.
   */
  noTarget: (t: number) => boolean;
  /** T4 for rule 6: a covered territory of a partner a truce binds the planner to (free-for-all only). */
  noFront: (t: number) => boolean;
  /** The format the truces were read in (for the ignored warning). */
  format: GameFormat;
}

/** No relations: every check false, nothing to report. */
const NONE: Truce = {
  given: [],
  status: [],
  binds: [],
  partners: new Set(),
  enforced: new Set(),
  noTarget: () => false,
  noFront: () => false,
  format: 'ffa',
};

/**
 * Read the truces of `input` (the estimates phase, before the foes are fixed): which bind this turn
 * and the territories none of my passes may attack. `notFoe` says who is me or a teammate.
 */
export function truceOf(input: PlanInput, o: { notFoe: (p: number) => boolean; format: GameFormat; turnNow: number | null }): Truce {
  const given = input.relations ?? [];
  if (!given.length) return NONE;
  const ffa = o.format === 'ffa';
  const status: PlanRelationView['state'][] = [];
  const binds: boolean[] = [];
  /** Whether the agreement itself binds this turn, whatever the format (T1 keeps to it everywhere). */
  const kept: boolean[] = [];
  for (const r of given) {
    let st: PlanRelationView['state'];
    if (o.notFoe(r.player)) st = 'not-a-foe';
    else if (r.state === 'broken') st = 'broken';
    else if (r.state === 'notice' && r.endsTurn !== undefined && o.turnNow !== null && o.turnNow >= r.endsTurn) st = 'over';
    else st = r.state;
    kept.push(st === 'active' || st === 'notice');
    if (!ffa) st = 'ignored';
    status.push(st);
    binds.push(st === 'active' || st === 'notice');
  }
  const owner = new Map<number, number>();
  for (const t of input.board.territories) if (t.owner.kind === 'player') owner.set(t.territoryId, t.owner.playerId);
  const partners = new Set<number>();
  const enforced = new Set<number>();
  /** Per partner whose agreement binds (in any format), the territories of theirs covered. */
  const theirs = new Map<number, Set<number>>();
  given.forEach((r, i) => {
    if (!kept[i]) return;
    // T2–T5 and T9 only in a free-for-all; T1 (never a surprise break, D3) wherever the agreement binds.
    if (binds[i]) {
      partners.add(r.player);
      if (r.enforced) enforced.add(r.player);
    }
    const set = theirs.get(r.player) ?? new Set<number>();
    for (const t of r.coveredTheirs) set.add(t);
    theirs.set(r.player, set);
  });
  const noTarget = (t: number): boolean => {
    const p = owner.get(t);
    if (p === undefined) return false;
    const set = theirs.get(p);
    if (!set) return false;
    return enforced.has(p) || set.has(t);
  };
  const noFront = (t: number): boolean => {
    const p = owner.get(t);
    return p !== undefined && partners.has(p) && noTarget(t);
  };
  return { given, status, binds, partners, enforced, noTarget, noFront, format: o.format };
}

/**
 * T4 for rule 0p.2: the binding partners the game profile counts among my opponents — on the
 * game's player list and still `Playing`, or, with no list, holding a territory in sight — so a
 * truce with a player who is out takes no front away. 0 with no binding truce.
 */
export function partnerFronts(pc: PlanCtx): number {
  const { truce, game, board, g } = pc;
  if (!truce.partners.size) return 0;
  const listed = game.players ?? [];
  const playing = listed.length
    ? (p: number) => listed.some((x) => x.id === p && (x.state ?? 'Playing') === 'Playing')
    : (p: number) =>
        board.territories.some(
          (t) => g.territoryById.has(t.territoryId) && t.owner.kind === 'player' && t.owner.playerId === p && t.armies !== null,
        );
  return [...truce.partners].filter(playing).length;
}

/** T2/T3 for one pass: the covered borders sized at the truce level, and those kept full and why. */
export interface TrucePass {
  /** My border → the partner whose deploy it is not sized for (T2). */
  relaxed: Map<number, number>;
  /** My covered border facing only a partner that keeps its full hold (T3), with the partner. */
  fullHold: Map<number, { player: number; why: 'commander' | 'value' | 'watch' }>;
  /** T5: the armies moved off each capped border, per relation index. */
  capMoved: Map<number, { from: number; to: number; armies: number }[]>;
}

/** The foe players with a stack (visible, or its owner shown) next to my `t`, ascending. */
function foesNext(pc: PlanCtx, t: number): number[] {
  const out = new Set<number>();
  for (const n of neighborsOf(pc.g, t)) {
    const st = pc.territories.get(n);
    if (st?.owner.kind === 'player' && pc.foe(st.owner.playerId)) out.add(st.owner.playerId);
  }
  return [...out].sort(byNum);
}

/**
 * T2 and T3, once the deploy book knows what each border protects (`valueOf`, my holdings at the
 * start of the turn): a covered border of mine facing only its partner is relaxed unless my
 * commander stands there, it protects more than {@link TRUCE_RELAX_VALUE} × my income, or the trust
 * is `watch`. `undefined` with no binding truce (the threats phase then reads nothing).
 */
export function trucePass(pc: PlanCtx, valueOf: (t: number) => number): TrucePass | undefined {
  const { truce, mineSet, myCommanders, income } = pc;
  if (!truce.partners.size) return undefined;
  const relaxed = new Map<number, number>();
  const fullHold = new Map<number, { player: number; why: 'commander' | 'value' | 'watch' }>();
  truce.given.forEach((r, i) => {
    if (!truce.binds[i] || truce.enforced.has(r.player)) return;
    for (const t of [...r.coveredMine].sort(byNum)) {
      if (!mineSet.has(t) || relaxed.has(t) || fullHold.has(t)) continue;
      const foes = foesNext(pc, t);
      if (foes.length !== 1 || foes[0] !== r.player) continue;
      const why = myCommanders.has(t) ? 'commander' : r.trust === 'watch' ? 'watch' : valueOf(t) > TRUCE_RELAX_VALUE * income ? 'value' : undefined;
      if (why) fullHold.set(t, { player: r.player, why });
      else relaxed.set(t, r.player);
    }
  });
  return { relaxed, fullHold, capMoved: new Map() };
}

/**
 * T2 in the report: my `t` is relaxed for player `p` this pass — sized for its visible stacks there
 * with no deploy, so no line may call it sized for (or a gamble on) that player's deploy. Always
 * false with no binding truce.
 */
export function relaxedFor(ps: PlanState, t: number, p: number): boolean {
  return ps.truce?.relaxed.get(t) === p;
}

/**
 * T4's other half: a territory of mine next to a truce's covered territory is no interior, though
 * the partner is no front — it keeps what holds it against the threat there (T2's truce hold, or
 * T3's full one), so rule 6 never walks its garrison away. 0 beside no covered territory.
 */
export function truceKeep(pc: PlanCtx, threats: Threats, t: number): number {
  if (!pc.truce.partners.size || !neighborsOf(pc.g, t).some((n) => pc.truce.noTarget(n))) return 0;
  const b = threats.borderAt(t, () => false);
  return b ? Math.max(0, threats.holdArmies(b.threat) - pc.unitsAt(t)) : 0;
}

/** My covered territories next to a covered territory of the partner of `r` (the covered border). */
function coveredBorder(pc: PlanCtx, r: PlanRelation): number[] {
  const theirs = new Set(r.coveredTheirs);
  return [...r.coveredMine]
    .filter((t) => pc.mineSet.has(t))
    .filter((t) =>
      neighborsOf(pc.g, t).some((n) => {
        const st = pc.territories.get(n);
        return theirs.has(n) && st?.owner.kind === 'player' && st.owner.playerId === r.player;
      }),
    )
    .sort(byNum);
}

/** T5: per relation index, its capped covered border; and per territory, the lowest cap on it. */
interface Caps {
  borderOf: Map<number, number[]>;
  capped: Map<number, number>;
}
const capsMemo = new WeakMap<PlanCtx, Caps>();
function capsOf(pc: PlanCtx): Caps {
  const hit = capsMemo.get(pc);
  if (hit) return hit;
  const { truce } = pc;
  const capped = new Map<number, number>();
  const borderOf = new Map<number, number[]>();
  truce.given.forEach((r, i) => {
    if (!truce.binds[i] || r.borderCap === undefined || truce.enforced.has(r.player)) return;
    const ts = coveredBorder(pc, r);
    borderOf.set(i, ts);
    for (const t of ts) capped.set(t, Math.min(capped.get(t) ?? Infinity, Math.max(0, Math.floor(r.borderCap))));
  });
  const caps = { borderOf, capped };
  capsMemo.set(pc, caps);
  return caps;
}

/** What the orders planned so far (`ps.moves`, plus `pending` not yet in it) leave on my `t`. */
function endsAt(pc: PlanCtx, ps: PlanState, t: number, pending: readonly PlannedMove[] = []): number {
  let n = pc.armiesOf(t) + (ps.deployed.get(t) ?? 0);
  for (const m of [...ps.moves, ...pending]) n += (m.kind === 'transfer' && m.to === t ? m.armies : 0) - (m.from === t ? m.armies : 0);
  return n;
}

/**
 * T5 for the moves that fill a border (rule 1b's withdrawals, #125's staging, rule 6's transfers):
 * how many more armies my orders may move onto `t` without leaving more than a truce's border cap
 * there, counting this turn's deploys and the orders planned so far (`pending`: those not yet in
 * `ps.moves`). Infinity on a territory no cap binds — always, with no relations.
 */
export function capRoom(pc: PlanCtx, ps: PlanState, t: number, pending: readonly PlannedMove[] = []): number {
  if (!pc.truce.partners.size) return Infinity;
  const cap = capsOf(pc).capped.get(t);
  if (cap === undefined) return Infinity;
  return Math.max(0, cap - endsAt(pc, ps, t, pending));
}

/**
 * T5 for one fill move from my `from` onto my `to`: {@link capRoom} on `to`, and 0 when a transfer
 * from `to` into `from` is already planned — a cap that closes the nearest step turns idle armies
 * another way, and they must not walk back along a move of this turn. Infinity with no binding truce.
 */
export function capStepRoom(pc: PlanCtx, ps: PlanState, from: number, to: number, pending: readonly PlannedMove[] = []): number {
  if (!pc.truce.partners.size) return Infinity;
  if ([...ps.moves, ...pending].some((m) => m.kind === 'transfer' && m.from === to && m.to === from)) return 0;
  return capRoom(pc, ps, to, pending);
}

/**
 * T5, after the transfers: what my orders leave on a covered border territory is at most the cap.
 * The excess is deployed one step behind — to a territory of mine on no capped border, nearest
 * another front (a foe's territory no truce covers, else any territory not mine and not covered) —
 * then taken off a transfer of mine into it (the latest first; No-Split: a whole one only), then the
 * standing armies move one step behind, and the plan says so; one already above the cap at the
 * start is said to move back. What cannot go (No-Split, no step, Local Deployment's room, armies that
 * cannot move again) is a warning that names it — this plan's own deploy for a hold, when that is
 * what exceeds the cap; the plan never exceeds a term silently: it says to deploy less there, or to
 * give notice and ask the owner first. A capped border that also faces another opponent is not
 * "toward another front": when what the cap leaves there no longer holds it against that opponent
 * (and it held before), a warning names the opponent and the hold — the cap's cost (section 4). So
 * does one where my commander stands, when what the cap leaves no longer meets T3's full hold against
 * the partner itself.
 */
export function applyBorderCaps(pc: PlanCtx, ps: PlanState, book: DeployBook, hd: Holds, tp: TrucePass | undefined, threats: Threats): void {
  const { truce, g, mineSet, label, armiesOf, noSplit, unitsAt, territories: state } = pc;
  if (!tp) return;
  const { deployed, avail, moves, warnings, rationale, incoming } = ps;
  const { capped, borderOf } = capsOf(pc);
  if (!capped.size) return;
  // Another front: a foe's territory no truce covers, else any territory not mine no truce covers.
  const ids = [...g.territoryById.keys()];
  const open = (id: number) => !mineSet.has(id) && !truce.noTarget(id);
  const foeFront = ids.filter((id) => {
    const st = state.get(id);
    return open(id) && st?.owner.kind === 'player' && pc.foe(st.owner.playerId);
  });
  const passable = (id: number) => mineSet.has(id) && !hd.conceded.has(id);
  const distFoe = bfsDistances(g, foeFront, { passable });
  const distAny = bfsDistances(g, ids.filter(open), { passable });
  truce.given.forEach((r, i) => {
    for (const t of borderOf.get(i) ?? []) {
      const cap = capped.get(t)!;
      const before = endsAt(pc, ps, t);
      let excess = before - cap;
      if (excess <= 0) continue;
      // Another opponent beside it, with every truce partner's stacks left out.
      const facesOther = foesNext(pc, t).some((p) => !truce.partners.has(p));
      const already = armiesOf(t) > cap;
      const dist = [...neighborsOf(g, t)].some((x) => distFoe.has(x)) ? distFoe : distAny;
      const step = neighborsOf(g, t)
        .filter((x) => mineSet.has(x) && !capped.has(x) && !hd.conceded.has(x))
        .sort((a, b) => (dist.get(a) ?? Infinity) - (dist.get(b) ?? Infinity) || a - b)[0];
      const moved: { from: number; to: number; armies: number }[] = tp.capMoved.get(i) ?? [];
      const said: string[] = [];
      const trimmed: string[] = [];
      /** Local Deployment: deploys the step's pool had no room for, put back on `t`. */
      let noRoom: { shift: number; off: number } | undefined;
      if (step !== undefined) {
        // This turn's deploys there land one step behind instead.
        const off = Math.min(excess, deployed.get(t) ?? 0, avail.get(t)!);
        if (off > 0) {
          // Taken back first, so the step's room counts them (Local Deployment: what fits there).
          book.undeploy(t, off);
          const shift = Math.min(off, book.roomAt(step));
          if (shift > 0) book.deploy(step, shift);
          if (shift < off) book.deploy(t, off - shift);
          if (shift < off) noRoom = { shift, off };
          if (shift > 0) said.push(`deploy ${shift} on ${label(step)} instead`);
          excess -= shift;
        }
      }
      // A transfer of mine into it carries fewer (the latest first; No-Split: a whole one only): the
      // armies stay where they stood rather than arrive and move back. Its own line is retold.
      for (let j = moves.length - 1; j >= 0 && excess > 0; j--) {
        const m = moves[j]!;
        if (m.kind !== 'transfer' || m.to !== t) continue;
        const k = Math.min(excess, m.armies);
        if (noSplit && k < m.armies) continue;
        retell(pc, ps, m, m.armies - k);
        m.armies -= k;
        if (!m.armies) moves.splice(j, 1);
        avail.set(m.from, (avail.get(m.from) ?? 0) + k);
        if (hd.arrived.has(t)) hd.arrived.set(t, Math.max(0, hd.arrived.get(t)! - k));
        if (m.reason === WITHDRAWS && incoming.has(t)) incoming.set(t, Math.max(0, incoming.get(t)! - k));
        excess -= k;
        trimmed.push(`move ${k} fewer from ${label(m.from)} into it`);
      }
      if (step !== undefined) {
        // Then the armies standing there, unless No-Split would send the whole stack.
        const k = Math.min(excess, avail.get(t)!);
        const busy = moves.some((m) => m.from === t);
        if (k > 0 && !(noSplit && (k < avail.get(t)! || busy))) {
          avail.set(t, avail.get(t)! - k);
          // One order per pair: a transfer already planned there carries them too.
          const same = moves.find((m) => m.from === t && m.to === step);
          if (same) same.armies += k;
          else
            moves.push({
              from: t,
              to: step,
              armies: k,
              kind: 'transfer',
              reason: `keeps the truce's border cap of ${cap} with player ${r.player} on ${label(t)}`,
            });
          hd.arrived.set(step, (hd.arrived.get(step) ?? 0) + k);
          moved.push({ from: t, to: step, armies: k });
          excess -= k;
          said.push(`move ${k} back to ${label(step)}`);
        }
      }
      if (moved.length) tp.capMoved.set(i, moved);
      if (said.length || trimmed.length)
        rationale.push(
          `Truce with player ${r.player} (border cap ${cap}): ${already ? `${label(t)} already stands above the cap with ${armiesOf(t)}, so` : `my orders would leave more than ${cap} on ${label(t)}, so`} ${[...trimmed, ...said].join(' and ')}${said.length && !facesOther ? ', toward another front' : ''} (T5).`,
        );
      if (excess > 0) {
        const dep = deployed.get(t) ?? 0;
        const why =
          step === undefined && dep > 0
            ? `: this plan's own deploy of ${dep} there (for its hold, or the leftover)${armiesOf(t) > cap ? `, on top of the ${armiesOf(t)} already standing there,` : ''} is what exceeds it, and no territory of mine one step behind can take it, so these orders break a term of the truce — keep it by deploying less there, or give notice (notice-by-me) and ask the owner before exceeding the cap; never break it silently.`
            : step === undefined
            ? ' (no territory of mine one step behind to move them to)'
            : noSplit
            ? ' (No-Split: an order sends the whole stack)'
            : noRoom
            ? ` (Local Deployment: the pools had room for only ${noRoom.shift} of the ${noRoom.off} deployed there on ${label(step)}, and the armies there cannot move again this turn)`
            : ' (the armies there cannot move again this turn)';
        warnings.push(
          why.endsWith('.')
            ? `Truce with player ${r.player}: my orders leave ${excess} above the agreed border cap of ${cap} on ${label(t)}${why}`
            : `Truce with player ${r.player}: my orders leave ${excess} above the agreed border cap of ${cap} on ${label(t)}${why}: that breaks a term of the truce.`,
        );
      }
      if (facesOther) {
        // The cap's cost: what it leaves no longer holds the border against another opponent.
        const f = threats.forceAt(
          t,
          (n) => {
            const st = state.get(n);
            return st?.owner.kind === 'player' && truce.partners.has(st.owner.playerId);
          },
          { trend: true, allPlayers: true },
        );
        const need = f && !truce.partners.has(f.player) ? Math.max(0, threats.holdArmies(f.threat) - unitsAt(t)) : 0;
        const left = endsAt(pc, ps, t);
        if (f && need > 0 && left < need && before >= need)
          warnings.push(
            `Truce with player ${r.player} (border cap ${cap}): ${label(t)} also faces player ${f.player}, and the ${left} the cap leaves there do not hold it — its hold needs ${need} against player ${f.player}'s ~${f.threat}. Keep the term, or give notice (notice-by-me) and ask the owner before exceeding the cap; never break it silently.`,
          );
      }
      if (pc.myCommanders.has(t)) {
        // T3 keeps my commander's full hold against the partner; the cap may still thin it below that.
        const f = threats.forceAt(
          t,
          (n) => {
            const st = state.get(n);
            return !(st?.owner.kind === 'player' && st.owner.playerId === r.player);
          },
          { trend: true, allPlayers: true, full: true },
        );
        const need = f ? Math.max(0, threats.holdArmies(f.threat) - unitsAt(t)) : 0;
        const left = endsAt(pc, ps, t);
        if (f && need > 0 && left < need && before >= need)
          warnings.push(
            `Truce with player ${r.player} (border cap ${cap}): my commander stands on ${label(t)}, and the ${left} the cap leaves there do not hold it against player ${r.player}'s full attack — its hold needs ${need} against ~${f.threat}. Keep the term, or give notice (notice-by-me) and ask the owner before exceeding the cap; never break it silently.`,
          );
      }
    }
  });
}

/** Rule 1b's withdrawal reason (holds.ts), which the line retold below is keyed on. */
const WITHDRAWS = 'withdraws from a conceded border';

/**
 * T5: a transfer the cap trims now carries `armies`: its own rationale line says so, or goes with
 * it (and so does a dropped withdrawal's Order Priority warning) — the lines rule 1b, #125's staging
 * and rule 6 wrote for it, as stand-still.ts's reclaim finds them.
 */
function retell(pc: PlanCtx, ps: PlanState, m: PlannedMove, armies: number): void {
  const { label } = pc;
  const { rationale, warnings } = ps;
  const verb = m.reason === WITHDRAWS ? 'Withdraw' : m.reason === 'moves idle interior armies toward the front' ? 'Transfer' : 'Move';
  const head = `${verb} ${m.armies} from ${label(m.from)} to ${label(m.to)}:`;
  const r = rationale.findIndex((l) => l.startsWith(head));
  if (r >= 0) {
    if (armies) rationale[r] = `${verb} ${armies} from ${label(m.from)} to ${label(m.to)}:${rationale[r]!.slice(head.length)}`;
    else rationale.splice(r, 1);
  }
  if (!armies && m.reason === WITHDRAWS) {
    const w = warnings.findIndex((l) => l.startsWith(`The withdrawal from ${label(m.from)} only executes`));
    if (w >= 0) warnings.splice(w, 1);
  }
}

/** The trust reasons that make the plan advise giving notice (T7). */
const NOTICE_REASONS: readonly TruceWatchReason[] = ['endgame', 'outgrowing'];

/**
 * T2's armies freed on `relaxed` (one relation's): per border, the full hold's shortfall less the
 * truce hold's — only where the plan without the truce would have funded the full hold. A border
 * this plan concedes against the smaller threat is conceded against the full one too, and one whose
 * full hold rule 1a would refuse (more than {@link CONCEDE_FACTOR} × its worth, or more than my
 * income) gets nothing there either way: neither frees an army. Each border's figure is capped at
 * what the plan's orders really leave it short of the full hold (`ps`'s deploys and moves), so armies
 * that end there anyway — the leftover, a #172 two-step keep, a transfer in — are not counted as
 * freed. At most my income in all.
 */
export function armiesFreed(
  pc: PlanCtx,
  ps: PlanState,
  threats: Threats,
  relaxed: readonly number[],
  hold: { conceded: ReadonlySet<number>; valueOf: (t: number) => number },
): number {
  const { armiesOf, unitsAt, income, paybackTurns, profile } = pc;
  const { forceAt, holdArmies } = threats;
  /** What a hold of `t` needs beyond the armies there against `threat`. */
  const short = (t: number, threat: number) => Math.max(0, holdArmies(threat) - armiesOf(t) - unitsAt(t));
  let freed = 0;
  for (const t of relaxed) {
    if (hold.conceded.has(t)) continue;
    const full = forceAt(t, () => false, { trend: true, allPlayers: true, full: true });
    const now = forceAt(t, () => false, { trend: true, allPlayers: true });
    if (!full || !now) continue;
    const fullShort = short(t, full.threat);
    const worth = hold.valueOf(t) + armiesOf(t) / paybackTurns;
    // Rule 1a's economic test, as holdBasics' `uneconomic` reads it (#122: not in the opening when
    // the hold costs no more than the armies already there).
    const uneconomic = fullShort > CONCEDE_FACTOR * worth && !(profile.phase === 'opening' && fullShort <= armiesOf(t));
    if (fullShort > income || uneconomic) continue;
    // What the plan's orders really leave short of the full hold on `t`.
    const leftShort = Math.max(0, holdArmies(full.threat) - endsAt(pc, ps, t) - unitsAt(t));
    freed += Math.min(Math.max(0, fullShort - short(t, now.threat)), leftShort);
  }
  return Math.min(freed, income);
}

/**
 * The report (T2's armies freed, T3's full holds, T5's moves, T7's advice, T8's breaks), and the
 * warnings and rationale that say what the truces did. Run before the plan is finished — also for a
 * plan holding no territory (`tp` undefined, nothing relaxed); with no relations it returns nothing
 * and says nothing. `freedOn` is {@link armiesFreed} for one relation's relaxed borders.
 */
/** T8: `warapp_submit_turn` reads only the ledger, so a break the plan acts on must be recorded first. */
const RECORD_BROKEN = (r: PlanRelation): string =>
  `Record it with warapp_record_agreement (${r.agreement ? `agreement_id ${r.agreement}, ` : ''}status broken-by-them) before submitting: until then warapp_submit_turn refuses an order on its covered territories.`;

export function reportTruce(
  pc: PlanCtx,
  ps: PlanState,
  tp: TrucePass | undefined,
  freedOn: (relaxed: readonly number[]) => number,
): { relations: PlanRelationView[]; advice: PlanAdvice[] } | undefined {
  const { truce, label, turnNow } = pc;
  if (!truce.given.length) return undefined;
  const { warnings, rationale } = ps;
  if (truce.status.some((s) => s === 'ignored'))
    warnings.push(
      `Truces ignored (B2): ${truce.format === 'teams' ? 'this is a team game' : 'only two players are in this game'}, and the planner honours a truce only in a free-for-all; every player is planned as an ordinary opponent, except that the covered territories of an active or in-notice agreement are still never a target (T1: the plan never orders a surprise break).`,
    );
  const advice: PlanAdvice[] = [];
  const relations = truce.given.map((r, i): PlanRelationView => {
    const st = truce.status[i]!;
    const flags = [...(r.watch ?? [])];
    const name = `Truce with player ${r.player}${r.agreement ? ` (agreement ${r.agreement})` : ''}`;
    const mineRelaxed = tp ? [...tp.relaxed].filter(([t, p]) => p === r.player && r.coveredMine.includes(t)).map(([t]) => t).sort(byNum) : [];
    const fullHold = tp
      ? [...tp.fullHold]
          .filter(([t, f]) => f.player === r.player && r.coveredMine.includes(t))
          .map(([territory, f]) => ({ territory, why: f.why }))
          .sort((a, b) => a.territory - b.territory)
      : [];
    const freed = mineRelaxed.length ? freedOn(mineRelaxed) : 0;
    if (st === 'broken' && r.breach)
      warnings.push(
        `${name} is broken by them: ${r.breach.term} on turn ${r.breach.turn}${r.breach.territories.length ? ` (${r.breach.territories.map(label).join(', ')})` : ''} — ${r.breach.evidence}. Player ${r.player} is planned as an ordinary opponent from this turn (T8). ${RECORD_BROKEN(r)}`,
      );
    else if (st === 'broken') warnings.push(`${name} is broken by them: player ${r.player} is planned as an ordinary opponent from this turn (T8). ${RECORD_BROKEN(r)}`);
    else if (st === 'over')
      rationale.push(`${name}: its notice ran out on turn ${r.endsTurn}, so player ${r.player} is an ordinary opponent this turn (T7).`);
    else if (st === 'not-a-foe') warnings.push(`${name}: player ${r.player} is me or a teammate, so the truce changes nothing.`);
    else if (st === 'active' || st === 'notice') {
      const enforced = truce.enforced.has(r.player);
      const notice = st === 'notice' && r.endsTurn !== undefined ? ` (in notice${r.noticeBy ? ` given by ${r.noticeBy === 'me' ? 'me' : 'them'}` : ''}: binding until turn ${r.endsTurn})` : '';
      rationale.push(
        enforced
          ? `${name}${notice}: a Diplomacy card is in effect, so player ${r.player}'s attacks on me do nothing this turn — its threat is 0 and no attack on it is planned (T9).`
          : `${name}${notice}: none of its ${r.coveredTheirs.length} covered ${r.coveredTheirs.length === 1 ? 'territory is' : 'territories are'} a target this turn (T1), and player ${r.player} is no front for the no-second-front rule or the idle armies (T4).`,
      );
      if (mineRelaxed.length)
        rationale.push(
          `${name}: ${mineRelaxed.map(label).join(', ')} ${mineRelaxed.length === 1 ? 'faces' : 'face'} only player ${r.player}, so ${mineRelaxed.length === 1 ? 'it is' : 'they are'} held against its visible stacks there attacking with no deploy (T2) — a break needs a visible build-up first; ${freed} ${freed === 1 ? 'army' : 'armies'} freed this turn.`,
        );
      const why = { commander: 'my commander stands there', value: `it protects more than ${TRUCE_RELAX_VALUE} × my income`, watch: `the trust is watch (${flags.join(', ') || 'a flag'})` } as const;
      for (const f of fullHold)
        rationale.push(`${name}: ${label(f.territory)} keeps its full hold against player ${r.player}'s deploy: ${why[f.why]} (T3).`);
      if (r.trust === 'watch' && flags.some((x) => NOTICE_REASONS.includes(x)) && !(st === 'notice' && r.noticeBy === 'me')) {
        const reason = flags.includes('endgame') ? 'the endgame: no other opponent is still a match for either of us, so the partner no longer needs me' : 'player ' + r.player + ' is outgrowing me';
        advice.push({ kind: 'give-notice', player: r.player, ...(r.agreement ? { agreement: r.agreement } : {}), why: reason });
        warnings.push(
          `${name}: give notice (T7) — ${reason}. The plan never breaks it by surprise: it stays binding until its notice runs${turnNow !== null ? ` (counted from the turn notice is given, after turn ${turnNow})` : ''}.`,
        );
      }
    }
    return {
      player: r.player,
      ...(r.agreement ? { agreement: r.agreement } : {}),
      state: st,
      honoured: truce.binds[i]!,
      enforced: truce.binds[i]! && truce.enforced.has(r.player),
      trust: r.trust,
      flags,
      ...(r.endsTurn !== undefined ? { endsTurn: r.endsTurn } : {}),
      relaxed: mineRelaxed,
      fullHold,
      armiesFreed: freed,
      ...(tp?.capMoved.get(i)?.length ? { capMoved: tp.capMoved.get(i)! } : {}),
      ...(r.breach ? { breach: r.breach } : {}),
      // T6: filled in once the plan's orders are final (truceBreakLosses).
      lossIfBroken: null,
    };
  });
  return { relations, advice };
}

/**
 * T6, once the plan's orders are final: for each binding truce that is not enforced, what a break
 * would cost this turn. The partner lands its whole deploy estimate (`deployOf`) on one of its covered
 * territories in view beside a covered territory of mine and attacks it with everything there (its
 * commander too), against this plan's deploys and moves; each such pair is carried out on the turn
 * simulator, with me moving first and with the partner first unless the first mover is known (and
 * verified), and the costliest is kept: my commander, then the income lost, the territories, the armies,
 * then ascending ids. Per relation index (parallel to `truce.given`): `null` where nothing binds or no
 * such pair exists. Only the partner moves besides me: every other player is left out of the break.
 */
export function truceBreakLosses(pc: PlanCtx, plan: { deploys: readonly PlannedDeploy[]; moves: readonly PlannedMove[] }): (TruceBreakLoss | null)[] {
  const { truce, g, board, me, s, opts, deployOf } = pc;
  if (!truce.given.length) return [];
  const start = simTerritories(board);
  const settings = {
    ...(s.offensiveKillRate !== undefined ? { offensiveKillRate: s.offensiveKillRate } : {}),
    ...(s.defensiveKillRate !== undefined ? { defensiveKillRate: s.defensiveKillRate } : {}),
    ...(s.luckModifier !== undefined ? { luckModifier: s.luckModifier } : {}),
    ...(s.roundingMode !== undefined ? { roundingMode: s.roundingMode } : {}),
    ...(s.oneArmyStandsGuard !== undefined ? { oneArmyStandsGuard: s.oneArmyStandsGuard } : {}),
    ...(s.multiAttack !== undefined ? { multiAttack: s.multiAttack } : {}),
  };
  const myDeploys = plan.deploys.filter((d) => d.armies > 0).map((d) => ({ player: me, territoryId: d.territoryId, armies: d.armies }));
  const myOrders = plan.moves.map((m) => ({ from: m.from, to: m.to, armies: m.armies }));
  const run = (partner: number, from: number, to: number, deploy: number, order: number[]): SimResult =>
    simulateTurn({
      graph: g,
      board,
      deploys: [...myDeploys, ...(deploy > 0 ? [{ player: partner, territoryId: from, armies: deploy }] : [])],
      orders: [
        { player: me, orders: myOrders },
        { player: partner, orders: [{ from, to, armies: (start.get(from)?.armies ?? 0) + deploy, withCommander: true }] },
      ],
      moveOrder: order,
      settings,
    });
  const baseline = simulateTurn({ graph: g, board, deploys: myDeploys, orders: [{ player: me, orders: myOrders }], moveOrder: [me], settings });
  const mineAfter = (r: SimResult) => new Set([...r.territories].filter(([, t]) => t.owner === me).map(([id]) => id));
  const armiesAfter = (r: SimResult) => [...r.territories.values()].reduce((n, t) => n + (t.owner === me ? t.armies : 0), 0);
  const bonusIds = [...g.bonusById.keys()].sort(byNum);
  const heldBonuses = (held: ReadonlySet<number>) =>
    bonusIds.filter((id) => {
      const ts = bonusTerritories(g, id);
      return ts.length > 0 && ts.every((t) => held.has(t));
    });
  const baseMine = mineAfter(baseline);
  const baseBonuses = heldBonuses(baseMine);
  const baseArmies = armiesAfter(baseline);
  const known = opts.movesFirst !== undefined && !opts.movesFirstUnverified;
  const worse = (a: TruceBreakLoss, b: TruceBreakLoss) =>
    Number(a.commanderLost) - Number(b.commanderLost) ||
    Math.max(0, a.bonusValue) - Math.max(0, b.bonusValue) ||
    a.territories.length - b.territories.length ||
    a.armies - b.armies;
  return truce.given.map((r, i) => {
    if (!truce.binds[i] || truce.enforced.has(r.player)) return null;
    const theirs = [...new Set(r.coveredTheirs)].filter((t) => start.get(t)?.owner === r.player).sort(byNum);
    const mineCovered = new Set(r.coveredMine.filter((t) => start.get(t)?.owner === me));
    const deploy = Math.max(0, Math.floor(deployOf(r.player)));
    let best: TruceBreakLoss | null = null;
    for (const from of theirs) {
      for (const to of [...neighborsOf(g, from)].filter((n) => mineCovered.has(n)).sort(byNum)) {
        const orders: { who: 'me' | 'partner'; order: number[] }[] = known
          ? [{ who: opts.movesFirst ? 'me' : 'partner', order: opts.movesFirst ? [me, r.player] : [r.player, me] }]
          : [
              { who: 'me', order: [me, r.player] },
              { who: 'partner', order: [r.player, me] },
            ];
        const outcomes = orders.map(({ who, order }) => {
          const res = run(r.player, from, to, deploy, order);
          const after = mineAfter(res);
          const held = new Set(heldBonuses(after));
          const bonuses = baseBonuses.filter((b) => !held.has(b)).map((id) => ({ id, value: g.bonusById.get(id)?.value ?? 0 }));
          const loss: TruceBreakLoss = {
            from,
            to,
            deploy,
            attackers: res.log.find((e) => e.player === r.player && e.index === 0)?.sent ?? 0,
            territories: [...baseMine].filter((t) => !after.has(t)).sort(byNum),
            armies: Math.max(0, baseArmies - armiesAfter(res)),
            bonuses,
            bonusValue: bonuses.reduce((n, b) => n + b.value, 0),
            commanderLost: res.eliminated.includes(me),
            exact: res.exact,
          };
          return { who, loss };
        });
        const top = outcomes.reduce((a, b) => (worse(b.loss, a.loss) > 0 ? b : a));
        const same = outcomes.every((o) => JSON.stringify(o.loss) === JSON.stringify(top.loss));
        const loss: TruceBreakLoss = !known && !same ? { ...top.loss, firstMover: top.who } : top.loss;
        if (!best || worse(loss, best) > 0) best = loss;
      }
    }
    return best;
  });
}

/**
 * T6's report: each binding truce's {@link truceBreakLosses} on its view, and a rationale line that
 * says what a break would take. Nothing with no relations.
 */
export function reportBreakLosses(pc: PlanCtx, views: PlanRelationView[], plan: { deploys: readonly PlannedDeploy[]; moves: readonly PlannedMove[]; rationale: string[] }): void {
  const losses = truceBreakLosses(pc, plan);
  const { label } = pc;
  views.forEach((v, i) => {
    const loss = losses[i] ?? null;
    v.lossIfBroken = loss;
    if (!loss) return;
    const name = `Truce with player ${v.player}${v.agreement ? ` (agreement ${v.agreement})` : ''}`;
    const lost = loss.commanderLost
      ? 'my commander, and with it everything'
      : loss.territories.length
        ? `${loss.territories.map(label).join(', ')}, ${loss.armies} ${loss.armies === 1 ? 'army' : 'armies'} and +${loss.bonusValue} income`
        : `no territory (${loss.armies} ${loss.armies === 1 ? 'army' : 'armies'})`;
    const when = loss.firstMover ? ` (if ${loss.firstMover === 'me' ? 'I move' : 'it moves'} first)` : '';
    plan.rationale.push(
      `${name}: if it broke this turn — its ~${loss.deploy} deploy on ${label(loss.from)} and an attack on ${label(loss.to)} with ${loss.attackers} — I would lose ${lost}${when} (T6).`,
    );
  });
}
