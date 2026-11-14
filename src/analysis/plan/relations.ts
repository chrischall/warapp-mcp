// B2 (docs/PLAN-TEAMS.md section 8): the planner honours a truce. The rule logic lives here; the
// phase modules only call it.
//
// A truce (`PlanInput.relations`) is honoured only in a free-for-all, while `active` or in `notice`
// (until its `endsTurn`), with a player who is a foe (not me, not a teammate):
//   T1  a covered territory of the partner is never a target, in any pass (`noTarget`: the targets,
//       tryCapture, the strikes, the lead strikes, the guard-off breaks and rule 4e's enemy fallback);
//   T2  a covered border of mine that faces only the partner is sized for the partner's visible
//       stacks next to it attacking with no deploy and no trend (`forceAt`; its separate-attack
//       rule still applies);
//   T3  never relaxed: my commander's territory, a border protecting more than
//       TRUCE_RELAX_VALUE × my income, any border while the trust is `watch`;
//   T4  the partner is no front: not for the no-second-front rule (rule 0p.2), and idle armies do
//       not walk toward its covered territories (rule 6);
//   T5  a border cap: my orders leave at most the cap on a covered border territory, the excess
//       deployed or moved one step behind toward another front, said so when I already stand above it;
//   T7  never a surprise break: a notice binds until its `endsTurn`; the plan advises `give-notice`
//       when the trust turned `watch` for the endgame or for outgrowing;
//   T8  broken by them (`state: 'broken'`): an ordinary opponent at once, the plan naming the term,
//       the turn and the evidence;
//   T9  enforced (a Diplomacy card the decoder is sure of): that player is no foe for the turn — its
//       threat is 0 and no attack on it is planned.
// With no relations every function here is a no-op, so every plan is byte-identical to one made
// without them. Pure and deterministic (ties on ascending id).
import { bfsDistances, neighborsOf } from '../graph.js';
import type { GameFormat } from '../profile.js';
import type { DeployBook } from './orders.js';
import type { Holds } from './holds.js';
import { CONCEDE_FACTOR, type PlanAdvice, type PlanInput, type PlanRelation, type PlanRelationView, type TruceWatchReason } from './shared.js';
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
  /** T1: a territory of a binding partner the truce covers (every one of an enforced partner). */
  noTarget: (t: number) => boolean;
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
  for (const r of given) {
    let st: PlanRelationView['state'];
    if (!ffa) st = 'ignored';
    else if (o.notFoe(r.player)) st = 'not-a-foe';
    else if (r.state === 'broken') st = 'broken';
    else if (r.state === 'notice' && r.endsTurn !== undefined && o.turnNow !== null && o.turnNow >= r.endsTurn) st = 'over';
    else st = r.state;
    status.push(st);
    binds.push(st === 'active' || st === 'notice');
  }
  const owner = new Map<number, number>();
  for (const t of input.board.territories) if (t.owner.kind === 'player') owner.set(t.territoryId, t.owner.playerId);
  const partners = new Set<number>();
  const enforced = new Set<number>();
  /** Per binding partner, the territories of theirs covered. */
  const theirs = new Map<number, Set<number>>();
  given.forEach((r, i) => {
    if (!binds[i]) return;
    partners.add(r.player);
    if (r.enforced) enforced.add(r.player);
    const set = theirs.get(r.player) ?? new Set<number>();
    for (const t of r.coveredTheirs) set.add(t);
    theirs.set(r.player, set);
  });
  const noTarget = (t: number): boolean => {
    const p = owner.get(t);
    if (p === undefined || !partners.has(p)) return false;
    return enforced.has(p) || theirs.get(p)!.has(t);
  };
  return { given, status, binds, partners, enforced, noTarget, format: o.format };
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

/**
 * T5, after the transfers: what my orders leave on a covered border territory is at most the cap.
 * The excess is deployed, or moved, one step behind — to a territory of mine on no capped border,
 * nearest another front (a foe's territory no truce covers, else any territory not mine and not
 * covered) — and the plan says so; one already above the cap at the start is said to move back.
 * What cannot be moved (armies that arrived this turn, No-Split, no step) is a warning.
 */
export function applyBorderCaps(pc: PlanCtx, ps: PlanState, book: DeployBook, hd: Holds, tp: TrucePass | undefined): void {
  const { truce, g, mineSet, label, armiesOf, noSplit, territories: state } = pc;
  if (!tp) return;
  const { deployed, avail, moves, warnings, rationale } = ps;
  const capped = new Map<number, number>();
  const borderOf = new Map<number, number[]>();
  truce.given.forEach((r, i) => {
    if (!truce.binds[i] || r.borderCap === undefined || truce.enforced.has(r.player)) return;
    const ts = coveredBorder(pc, r);
    borderOf.set(i, ts);
    for (const t of ts) capped.set(t, Math.min(capped.get(t) ?? Infinity, Math.max(0, Math.floor(r.borderCap))));
  });
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
  const endsAt = (t: number) =>
    moves.reduce((n, m) => n - (m.from === t ? m.armies : 0) + (m.kind === 'transfer' && m.to === t ? m.armies : 0), armiesOf(t) + (deployed.get(t) ?? 0));
  truce.given.forEach((r, i) => {
    for (const t of borderOf.get(i) ?? []) {
      const cap = capped.get(t)!;
      let excess = endsAt(t) - cap;
      if (excess <= 0) continue;
      const already = armiesOf(t) > cap;
      const dist = [...neighborsOf(g, t)].some((x) => distFoe.has(x)) ? distFoe : distAny;
      const step = neighborsOf(g, t)
        .filter((x) => mineSet.has(x) && !capped.has(x) && !hd.conceded.has(x))
        .sort((a, b) => (dist.get(a) ?? Infinity) - (dist.get(b) ?? Infinity) || a - b)[0];
      const moved: { from: number; to: number; armies: number }[] = tp.capMoved.get(i) ?? [];
      const said: string[] = [];
      if (step !== undefined) {
        // This turn's deploys there land one step behind instead.
        const off = Math.min(excess, deployed.get(t) ?? 0, avail.get(t)!);
        if (off > 0) {
          // Taken back first, so the step's room counts them (Local Deployment: what fits there).
          book.undeploy(t, off);
          const shift = Math.min(off, book.roomAt(step));
          if (shift > 0) book.deploy(step, shift);
          if (shift < off) book.deploy(t, off - shift);
          if (shift > 0) said.push(`deploy ${shift} on ${label(step)} instead`);
          excess -= shift;
        }
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
      if (said.length)
        rationale.push(
          `Truce with player ${r.player} (border cap ${cap}): ${already ? `${label(t)} already stands above the cap with ${armiesOf(t)}, so` : `my orders would leave more than ${cap} on ${label(t)}, so`} ${said.join(' and ')}, toward another front (T5).`,
        );
      if (excess > 0)
        warnings.push(
          `Truce with player ${r.player}: my orders leave ${excess} above the agreed border cap of ${cap} on ${label(t)}${
            step === undefined ? ' (no territory of mine one step behind to move them to)' : noSplit ? ' (No-Split: an order sends the whole stack)' : ' (armies that arrived this turn cannot move again)'
          }: that breaks a term of the truce.`,
        );
    }
  });
}

/** The trust reasons that make the plan advise giving notice (T7). */
const NOTICE_REASONS: readonly TruceWatchReason[] = ['endgame', 'outgrowing'];

/**
 * T2's armies freed on `relaxed` (one relation's): per border, the full hold's shortfall less the
 * truce hold's — only where the plan without the truce would have funded the full hold. A border
 * this plan concedes against the smaller threat is conceded against the full one too, and one whose
 * full hold rule 1a would refuse (more than {@link CONCEDE_FACTOR} × its worth, or more than my
 * income) gets nothing there either way: neither frees an army. At most my income in all.
 */
export function armiesFreed(pc: PlanCtx, threats: Threats, relaxed: readonly number[], hold: { conceded: ReadonlySet<number>; valueOf: (t: number) => number }): number {
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
    freed += Math.max(0, fullShort - short(t, now.threat));
  }
  return Math.min(freed, income);
}

/**
 * The report (T2's armies freed, T3's full holds, T5's moves, T7's advice, T8's breaks), and the
 * warnings and rationale that say what the truces did. Run before the plan is finished — also for a
 * plan holding no territory (`tp` undefined, nothing relaxed); with no relations it returns nothing
 * and says nothing. `freedOn` is {@link armiesFreed} for one relation's relaxed borders.
 */
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
      `Truces ignored (B2): ${truce.format === 'teams' ? 'this is a team game' : 'only two players are in this game'}, and the planner honours a truce only in a free-for-all; every player is planned as an ordinary opponent.`,
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
        `${name} is broken by them: ${r.breach.term} on turn ${r.breach.turn}${r.breach.territories.length ? ` (${r.breach.territories.map(label).join(', ')})` : ''} — ${r.breach.evidence}. Player ${r.player} is planned as an ordinary opponent from this turn (T8).`,
      );
    else if (st === 'broken') warnings.push(`${name} is broken by them: player ${r.player} is planned as an ordinary opponent from this turn (T8).`);
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
    };
  });
  return { relations, advice };
}
