// PLAN-TEAMS C3.3–C3.6: the planner with a teammate.
// C3.3, one owner per bonus: a bonus pays only the player who holds every member, so a bonus with a
// member my teammate visibly holds is never a completion target for me (bonus scoring, plan/targets.ts,
// skips it), and the plan reports each bonus we both hold members of and who is nearer to holding it
// (`team.sharedBonuses`), from the start-of-turn board; a teammate's territory in the fog is unknown.
// C3.4–C3.6 read my teammates' entered orders (`board.teammateOrders`, V5: unverified live) and do nothing
// without them: the opponents they attack (`teamFocusOf`, a tie-break in the capture rankings), their
// borders my idle armies would make hold (`team.support`) and the targets we take only together, on the
// turn simulator (`team.jointCaptures`). Both reports are advisory: a move onto a teammate's territory is
// unverified (V7), and nothing here changes the plan's orders.
import type { BoardState } from '../../board.js';
import type { TeamMove, TeamOrders } from '../../team-orders.js';
import { carriesTeam } from '../../teams.js';
import { neighborsOf } from '../graph.js';
import { simulateTurn, type SimDeploy, type SimOrder, type SimSettings } from '../turn-sim.js';
import type { Holds } from './holds.js';
import { isCyclicMoveOrder, type PlannedDeploy } from './shared.js';
import { teammateAt, type PlanCtx, type PlanState } from './state.js';
import type { Threats } from './threats.js';
import { byNum } from './util.js';

/**
 * PLAN-TEAMS C3.4: the opponents my teammates' entered orders attack this turn, each with the teammates
 * attacking it (sorted). Read from `board.teammateOrders` (V5: whether war.app sends a teammate's orders
 * before they commit is unverified live): a move that is not transfer-only into a territory the board
 * shows a foe holding. Empty in a no-team game, or with no teammate orders read.
 */
export function teamFocusOf(board: BoardState, allies: ReadonlySet<number>, foe: (p: number) => boolean): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (!allies.size || !board.teammateOrders?.length) return out;
  const owner = new Map(board.territories.map((t) => [t.territoryId, t.owner]));
  for (const entry of board.teammateOrders) {
    if (!allies.has(entry.playerId) || !entry.orders) continue;
    for (const m of entry.orders.moves) {
      if (m.mode === 'transfer') continue;
      const o = owner.get(m.to);
      if (o?.kind !== 'player' || !foe(o.playerId)) continue;
      const mates = out.get(o.playerId) ?? [];
      if (!mates.includes(entry.playerId)) mates.push(entry.playerId);
      out.set(o.playerId, mates.sort(byNum));
    }
  }
  return out;
}

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

/**
 * PLAN-TEAMS C3.5: a teammate's border that falls to the threats in view, given the orders they have
 * entered, where my idle armies next to it would make it hold. Advisory: a move onto a teammate's
 * territory is unverified live (V7), so it is never in the plan's orders.
 */
export interface TeamSupport {
  /** The teammate's territory. */
  territory: number;
  teammate: number;
  /** What stays on it as entered: its armies plus their deploys there, less their orders out (special units aside). */
  armies: number;
  /** The strongest threat in view (the plan's own threat model), and whose. */
  threat: number;
  player: number;
  /** Armies it is short of holding. */
  need: number;
  /** My territories beside it and the idle armies each would send (largest first), together at least `need`. */
  from: { territory: number; armies: number }[];
}

/** One way a joint capture can run (PLAN-TEAMS C3.6): whose attack runs first, and how it ends. */
export interface JointCase {
  /** The player whose attack on the target runs first. */
  first: number;
  /** The target falls (to me or a teammate). */
  captured: boolean;
  /** Who takes it, when it falls. */
  by: number | null;
  /** The target still falls when its owner first lands its whole deploy estimate there. */
  capturedIfReinforced: boolean;
}

/**
 * PLAN-TEAMS C3.6: a target neither my teammate's entered attack nor mine takes alone, resolved on the
 * turn simulator with only those attacks (the other orders of the turn left out). Advisory: never put
 * in the plan's orders.
 */
export interface JointCapture {
  target: number;
  /** Who holds it. */
  owner: number;
  /** The teammates' entered attacks on it. */
  teammate: { player: number; from: number; armies: number; percent?: true }[];
  /** My attacks on it: the plan's own when it has any (`inPlan`), else my idle armies beside it. */
  mine: { from: number; armies: number }[];
  inPlan: boolean;
  /** Each order of the two attacks, mine first then theirs first. */
  cases: JointCase[];
  /**
   * Under a cyclic move order: the player whose attack must run first for it to fall (`null` when either
   * order takes it). Absent otherwise, when the move order this turn is not known.
   */
  mustGoFirst?: number | null;
  /** `false` when luck or weighted rounding leaves the battles at their expectation. */
  exact: boolean;
}

/** The team section of a plan (PLAN-TEAMS C3). Present only in a team game with something to say. */
export interface TeamView {
  sharedBonuses: SharedBonus[];
  /** C3.5, only with teammate orders read: borders of a teammate my idle armies would make hold. */
  support?: TeamSupport[];
  /** C3.6, only with teammate orders read: targets my teammate and I take only together. */
  jointCaptures?: JointCapture[];
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

/** What the support and joint-capture reports read of the finished plan. */
export interface TeamPlanView {
  ps: Pick<PlanState, 'avail' | 'locked' | 'coverKeep' | 'centralKeep' | 'captured' | 'moves'>;
  threats: Pick<Threats, 'threatAt' | 'holdArmies'>;
  hd: Pick<Holds, 'keepFor' | 'twoStepKeep' | 'conceded'>;
  deploys: readonly PlannedDeploy[];
}

type TeamCtx = Pick<
  PlanCtx,
  'allies' | 'territories' | 'g' | 'bonusTs' | 'mineSet' | 'me' | 'board' | 'foe' | 'myCommanders' | 'noSplit' | 'toTake' | 'unitsAt' | 's' | 'game' | 'deployOf' | 'guard'
>;

/** The teammate orders read for my teammates (V5), by player id; none with nothing read. */
function mateOrders(pc: Pick<PlanCtx, 'allies' | 'board'>): Map<number, TeamOrders> {
  const out = new Map<number, TeamOrders>();
  for (const e of pc.board.teammateOrders ?? []) if (pc.allies.has(e.playerId) && e.orders) out.set(e.playerId, e.orders);
  return out;
}

/** The armies a teammate's move sends from a territory holding `there`: a percentage of what can move, rounded. */
const sentBy = (m: TeamMove, there: number, guard: number) =>
  m.percent ? Math.round((Math.min(100, Math.max(0, m.armies)) / 100) * Math.max(0, there - guard)) : m.armies;

/** My idle armies on `x` once the plan's orders are made: what it may still send beyond what holds it. */
function idleAt(pc: TeamCtx, v: TeamPlanView, x: number): number {
  const { ps, hd } = v;
  if (!pc.mineSet.has(x) || ps.locked.has(x) || hd.conceded.has(x) || pc.myCommanders.has(x)) return 0;
  // No-Split: a territory that already issues an order sends nothing more.
  if (pc.noSplit && ps.moves.some((m) => m.from === x)) return 0;
  const gone = (n: number) => ps.captured.has(n);
  const keep = Math.max(hd.keepFor(x, gone), hd.twoStepKeep(x, gone), ps.coverKeep.get(x) ?? 0, ps.centralKeep.get(x) ?? 0);
  return Math.max(0, (ps.avail.get(x) ?? 0) - keep);
}

/** PLAN-TEAMS C3.5: the teammates' borders my idle armies would make hold, by territory id. */
export function teamSupport(pc: TeamCtx, v: TeamPlanView): TeamSupport[] {
  const orders = mateOrders(pc);
  if (!orders.size) return [];
  const out: TeamSupport[] = [];
  const gone = (n: number) => v.ps.captured.has(n);
  for (const t of [...pc.territories.keys()].sort(byNum)) {
    const st = pc.territories.get(t)!;
    if (st.owner.kind !== 'player' || st.armies === null) continue;
    const mate = st.owner.playerId;
    const theirs = orders.get(mate);
    if (!theirs) continue;
    const deployed = theirs.deploys.filter((d) => d.territoryId === t).reduce((n, d) => n + d.armies, 0);
    const there = st.armies + deployed;
    const out_ = theirs.moves.filter((m) => m.from === t).reduce((n, m) => n + sentBy(m, there, pc.guard), 0);
    // Armies moved in are left out: they may land after the attack (as the planner counts my own).
    const armies = Math.max(0, there - out_);
    const th = v.threats.threatAt(t, gone);
    if (!th) continue;
    const units = pc.unitsAt(t);
    if ((pc.toTake(armies + units) ?? Infinity) > th.threat) continue;
    // Positive: toTake is monotone, and what stands there does not hold.
    const need = v.threats.holdArmies(th.threat) - armies - units;
    const sources = [...neighborsOf(pc.g, t)]
      .map((x) => ({ territory: x, armies: idleAt(pc, v, x) }))
      .filter((x) => x.armies > 0)
      .sort((a, b) => b.armies - a.armies || a.territory - b.territory);
    const from: TeamSupport['from'] = [];
    let left = need;
    for (const x of sources) {
      if (left <= 0) break;
      // No-Split: a move sends the whole stack.
      const k = pc.noSplit ? x.armies : Math.min(x.armies, left);
      from.push({ territory: x.territory, armies: k });
      left -= k;
    }
    if (left > 0) continue;
    out.push({ territory: t, teammate: mate, armies, threat: th.threat, player: th.player, need, from });
  }
  return out;
}

/** The turn simulator's settings from the planner's. */
function simSettings(s: TeamCtx['s']): SimSettings {
  return {
    ...(s.offensiveKillRate !== undefined ? { offensiveKillRate: s.offensiveKillRate } : {}),
    ...(s.defensiveKillRate !== undefined ? { defensiveKillRate: s.defensiveKillRate } : {}),
    ...(s.luckModifier !== undefined ? { luckModifier: s.luckModifier } : {}),
    ...(s.roundingMode !== undefined ? { roundingMode: s.roundingMode } : {}),
    ...(s.oneArmyStandsGuard !== undefined ? { oneArmyStandsGuard: s.oneArmyStandsGuard } : {}),
    ...(s.multiAttack !== undefined ? { multiAttack: s.multiAttack } : {}),
  };
}

/**
 * PLAN-TEAMS C3.6: the targets my teammate and I take only together, from their entered attacks and mine
 * (the plan's, else my idle armies beside it), each resolved on the turn simulator in both orders.
 */
export function jointCaptures(pc: TeamCtx, v: TeamPlanView): JointCapture[] {
  const orders = mateOrders(pc);
  if (!orders.size) return [];
  const settings = simSettings(pc.s);
  const teams = new Map<number, number>();
  for (const p of pc.game.players ?? []) if (carriesTeam(p.team)) teams.set(p.id, p.team);
  const friendly = (o: number | 'neutral' | 'unknown' | undefined) => o === pc.me || (typeof o === 'number' && pc.allies.has(o));
  const targets = new Map<number, { player: number; move: TeamMove }[]>();
  for (const [player, o] of [...orders].sort((a, b) => a[0] - b[0]))
    for (const m of o.moves) {
      if (m.mode === 'transfer') continue;
      const st = pc.territories.get(m.to);
      if (st?.owner.kind !== 'player' || !pc.foe(st.owner.playerId) || st.armies === null) continue;
      targets.set(m.to, [...(targets.get(m.to) ?? []), { player, move: m }]);
    }
  const myDeploys: SimDeploy[] = v.deploys.filter((d) => d.armies > 0).map((d) => ({ player: pc.me, territoryId: d.territoryId, armies: d.armies }));
  const cyclic = isCyclicMoveOrder(pc.game.moveOrder);
  const out: JointCapture[] = [];
  for (const t of [...targets.keys()].sort(byNum)) {
    const owner = (pc.territories.get(t)!.owner as { playerId: number }).playerId;
    const theirs = targets.get(t)!;
    const mates = [...new Set(theirs.map((x) => x.player))].sort(byNum);
    const planned = v.ps.moves.filter((m) => m.kind === 'attack' && m.to === t).map((m) => ({ from: m.from, armies: m.armies }));
    const mine = planned.length
      ? planned
      : [...neighborsOf(pc.g, t)]
          .sort(byNum)
          .map((x) => ({ from: x, armies: idleAt(pc, v, x) }))
          .filter((x) => x.armies > 0);
    if (!mine.length) continue;
    const mateDeploys: SimDeploy[] = mates.flatMap((p) => orders.get(p)!.deploys.map((d) => ({ player: p, territoryId: d.territoryId, armies: d.armies })));
    const mateOrdersSim = mates.map((p) => ({
      player: p,
      orders: theirs
        .filter((x) => x.player === p)
        .map(({ move: m }): SimOrder => ({
          from: m.from,
          to: m.to,
          armies: m.armies,
          ...(m.mode === 'attack' ? { mode: 'attack-only' as const } : {}),
          ...(m.percent ? { byPercent: true } : {}),
          ...(m.commander ? { withCommander: true } : {}),
        })),
    }));
    const myOrders = { player: pc.me, orders: mine.map((x): SimOrder => ({ from: x.from, to: t, armies: x.armies, mode: 'attack-only' })) };
    const reinforce: SimDeploy = { player: owner, territoryId: t, armies: Math.max(0, Math.floor(pc.deployOf(owner))) };
    let exact = true;
    const run = (who: 'mine' | 'theirs' | 'both', moveOrder: number[], reinforced: boolean) => {
      const r = simulateTurn({
        graph: pc.g,
        board: pc.board,
        deploys: [...(who !== 'theirs' ? myDeploys : []), ...(who !== 'mine' ? mateDeploys : []), ...(reinforced && reinforce.armies > 0 ? [reinforce] : [])],
        orders: [...(who !== 'theirs' ? [myOrders] : []), ...(who !== 'mine' ? mateOrdersSim : [])],
        moveOrder,
        settings,
        ...(teams.size ? { teams } : {}),
      });
      exact &&= r.exact;
      const o = r.territories.get(t)?.owner;
      return friendly(o) ? (o as number) : null;
    };
    // Neither of us alone: the teammate's attack, then mine, each without the other.
    if (run('theirs', mates, false) !== null || run('mine', [pc.me], false) !== null) continue;
    const orderings = [[pc.me, ...mates], [...mates, pc.me]];
    const cases: JointCase[] = orderings.map((order) => {
      const by = run('both', order, false);
      return { first: order[0]!, captured: by !== null, by, capturedIfReinforced: run('both', order, true) !== null };
    });
    if (!cases.some((c) => c.captured)) continue;
    const taking = cases.filter((c) => c.captured);
    out.push({
      target: t,
      owner,
      teammate: theirs.map(({ player, move: m }) => ({ player, from: m.from, armies: m.armies, ...(m.percent ? { percent: true as const } : {}) })),
      mine,
      inPlan: planned.length > 0,
      cases,
      ...(cyclic ? { mustGoFirst: taking.length === 1 ? taking[0]!.first : null } : {}),
      exact,
    });
  }
  return out;
}

/** The plan's team section, or undefined when there is nothing to report. */
export function teamReport(pc: TeamCtx, v?: TeamPlanView): TeamView | undefined {
  const shared = sharedBonuses(pc);
  const support = v ? teamSupport(pc, v) : [];
  const joint = v ? jointCaptures(pc, v) : [];
  if (!shared.length && !support.length && !joint.length) return undefined;
  return {
    sharedBonuses: shared,
    ...(support.length ? { support } : {}),
    ...(joint.length ? { jointCaptures: joint } : {}),
  };
}

/** An option a pass ranks (a capture, a bonus plan, a hold), as {@link teamFocusLine} names it. */
export interface RankedOption {
  kind: string;
  id: number;
  /** The territory it captures, when it is one capture. */
  target?: number;
  /** The player holding `target`. */
  owner?: number;
}

/** "player 11" / "players 11 and 12". */
const playersText = (ids: readonly number[]) =>
  ids.length === 1 ? `player ${ids[0]}` : `players ${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;

/**
 * PLAN-TEAMS C3.4: the rationale line for `c`, a capture of a player my teammate attacks this turn, ranked
 * above `d`, an option that is otherwise equal.
 */
export function teamFocusLine(pc: Pick<PlanCtx, 'label' | 'bonusName' | 'teamFocus'>, c: RankedOption, d: RankedOption): string {
  const what = (o: RankedOption) =>
    o.target !== undefined
      ? `${pc.label(o.target)}${o.owner !== undefined ? ` (player ${o.owner})` : ''}`
      : o.kind === 'hold'
        ? `the hold on ${pc.label(o.id)}`
        : `bonus ${pc.bonusName(o.id)}`;
  const mates = pc.teamFocus.get(c.owner!) ?? [];
  return (
    `Team focus (PLAN-TEAMS C3.4): ${what(c)} ranks above ${what(d)}, which is otherwise equal: my teammate ` +
    `(${playersText(mates)}) attacks player ${c.owner} this turn in the orders they have entered (read from the live board, unverified).`
  );
}
