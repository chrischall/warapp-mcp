// PLAN-TEAMS C4: the team brief — the content of a team-chat message as data, never sent by the server. The
// tool (`warapp_team_brief`, src/tools/team-brief.ts) gathers the board, the plan and the pick lists; this
// module turns them into the brief's facts. Pure and deterministic: no I/O, ties on ascending id.
//
// Everything that reads my teammates' entered orders (V5) or their pick lists (V5/V6) is UNVERIFIED live, and
// what a move onto a teammate's territory does is unverified (V7): an ask or a conflict that rests on one says
// so in the tool's notes, and nothing here changes a plan.
import type { BoardState } from '../board.js';
import type { TeammateOrders } from '../team-orders.js';
import type { AwardReading } from './award.js';
import { bonusTerritories } from './bonuses.js';
import { neighborsOf, type MapGraph } from './graph.js';
import type { EnemyDeployEstimate, PlannedMove } from './plan/shared.js';

const byNum = (a: number, b: number) => a - b;

/** Why an opponent's estimate is what it is, in one line (ids and figures only). */
export function incomeBasis(e: EnemyDeployEstimate): string {
  const card = e.card ? `; with a Reinforcement card of ${e.card.armies} it may hold since turn ${e.card.due}` : '';
  switch (e.source) {
    case 'exact':
      return `exact: every owner is shown${card}`;
    case 'tracked':
      return `tracked: ${e.tracked} over observed turns ${e.trackedTurns.join(', ')}${card}`;
    case 'observed':
      return `observed: deployed ${e.observed} since the previous board${card}`;
    case 'prior':
      return `a prior, not an observation: ${e.prior}${card}`;
    default:
      return `base ${e.base} + visibly held bonuses ${e.bonusIncome}${card}`;
  }
}

/** An opponent's estimated income in the brief. */
export interface BriefIncome {
  player: number;
  /** `null` when nothing of theirs is in view. */
  estimate: number | null;
  source: EnemyDeployEstimate['source'] | null;
  basis: string;
}

/** Each opponent in `foes` (still playing, not on my team), ascending, with its estimate when one exists. */
export function opponentIncomes(estimates: readonly EnemyDeployEstimate[], foes: readonly number[]): BriefIncome[] {
  const by = new Map(estimates.map((e) => [e.playerId, e]));
  return [...foes].sort(byNum).map((player) => {
    const e = by.get(player);
    return e
      ? { player, estimate: e.estimate, source: e.source, basis: incomeBasis(e) }
      : { player, estimate: null, source: null, basis: 'nothing of theirs in view' };
  });
}

/**
 * Where my plan and a teammate's entered orders collide:
 * - `same-target`: we both attack it; whichever lands second moves onto a teammate's territory (V7) — unless
 *   it is a joint capture the plan reports (`joint`), where both are meant;
 * - `bonus`: their attack takes a member of a bonus my plan completes this turn (a bonus pays one holder);
 * - `attacks-me`: their order attacks a territory of mine (`attack_teammates`);
 * - `onto-mine`: their plain order moves onto a territory of mine (what it does is V7).
 */
export type BriefConflict =
  | { kind: 'same-target'; territory: number; teammate: number; mine: number; theirs: number; joint: boolean }
  | { kind: 'bonus'; bonus: number; territory: number; teammate: number }
  | { kind: 'attacks-me'; from: number; to: number; teammate: number; armies: number }
  | { kind: 'onto-mine'; from: number; to: number; teammate: number; armies: number };

/** The teammates' entries the board carries, theirs only, ascending by player. */
function mateEntries(board: BoardState, allies: ReadonlySet<number>): TeammateOrders[] {
  return (board.teammateOrders ?? []).filter((e) => allies.has(e.playerId) && e.orders).sort((a, b) => a.playerId - b.playerId);
}

/**
 * The conflicts between my plan's moves and my teammates' entered orders (none when no orders were read:
 * unknown, not "none"). In each teammate's entry order.
 */
export function briefConflicts(input: {
  g: MapGraph;
  board: BoardState;
  me: number;
  allies: ReadonlySet<number>;
  moves: readonly PlannedMove[];
  /** The bonuses my plan completes this turn. */
  bonusesCompleted: readonly number[];
  /** Targets the plan reports as joint captures with a teammate. */
  joint?: ReadonlySet<number>;
}): BriefConflict[] {
  const { g, board, me, allies, moves, bonusesCompleted } = input;
  const owner = new Map(board.territories.map((t) => [t.territoryId, t.owner]));
  const mine = (id: number) => {
    const o = owner.get(id);
    return o?.kind === 'player' && o.playerId === me;
  };
  const myAttacks = new Map<number, number>();
  for (const m of moves) if (m.kind === 'attack') myAttacks.set(m.to, (myAttacks.get(m.to) ?? 0) + m.armies);
  const completing = new Map<number, number>();
  for (const b of [...bonusesCompleted].sort(byNum)) for (const t of bonusTerritories(g, b)) if (!completing.has(t)) completing.set(t, b);
  const out: BriefConflict[] = [];
  for (const e of mateEntries(board, allies)) {
    const theirAttacks = new Map<number, number>();
    for (const m of e.orders!.moves) {
      if (mine(m.to)) {
        out.push(
          m.attackTeammates && m.mode !== 'transfer'
            ? { kind: 'attacks-me', from: m.from, to: m.to, teammate: e.playerId, armies: m.armies }
            : { kind: 'onto-mine', from: m.from, to: m.to, teammate: e.playerId, armies: m.armies },
        );
        continue;
      }
      if (m.mode === 'transfer') continue;
      const o = owner.get(m.to);
      if (o?.kind === 'player' && allies.has(o.playerId)) continue;
      theirAttacks.set(m.to, (theirAttacks.get(m.to) ?? 0) + m.armies);
      const bonus = completing.get(m.to);
      if (bonus !== undefined && !myAttacks.has(m.to)) out.push({ kind: 'bonus', bonus, territory: m.to, teammate: e.playerId });
    }
    for (const [territory, theirs] of [...theirAttacks].sort((a, b) => a[0] - b[0])) {
      const mineSent = myAttacks.get(territory);
      if (mineSent === undefined) continue;
      out.push({ kind: 'same-target', territory, teammate: e.playerId, mine: mineSent, theirs, joint: input.joint?.has(territory) ?? false });
    }
  }
  return out;
}

/** What I ask of my teammates this turn. */
export type BriefAsk =
  /** A target we take only together: keep the attack you entered (and, when known, who must go first). */
  | { kind: 'joint-capture'; target: number; teammates: number[]; mustGoFirst?: number | null }
  /** A border of mine the plan concedes, beside territories of theirs with armies to spare (a move onto mine is V7). */
  | { kind: 'cover'; territory: number; beside: { teammate: number; territory: number; armies: number }[] };

/** The asks: each joint capture, then each conceded border of mine a teammate's stack borders. */
export function briefAsks(input: {
  g: MapGraph;
  board: BoardState;
  allies: ReadonlySet<number>;
  conceded: readonly number[];
  jointCaptures: readonly { target: number; teammates: number[]; mustGoFirst?: number | null }[];
}): BriefAsk[] {
  const { g, board, allies } = input;
  const state = new Map(board.territories.map((t) => [t.territoryId, t]));
  const out: BriefAsk[] = input.jointCaptures.map((j) => ({
    kind: 'joint-capture' as const,
    target: j.target,
    teammates: [...j.teammates].sort(byNum),
    ...(j.mustGoFirst !== undefined ? { mustGoFirst: j.mustGoFirst } : {}),
  }));
  for (const territory of [...input.conceded].sort(byNum)) {
    const beside: { teammate: number; territory: number; armies: number }[] = [];
    for (const n of [...neighborsOf(g, territory)].sort(byNum)) {
      const t = state.get(n);
      if (t?.owner.kind !== 'player' || !allies.has(t.owner.playerId) || t.armies === null || t.armies <= 1) continue;
      beside.push({ teammate: t.owner.playerId, territory: n, armies: t.armies });
    }
    if (beside.length) out.push({ kind: 'cover', territory, beside });
  }
  return out;
}

/** My pick list against each teammate's. */
export interface PickOverlap {
  /** Each pick on my list a teammate also lists: both 1-based positions. */
  overlap: { territory: number; mine: number; teammate: number; theirs: number }[];
  /** Each positive bonus with a member on my list and one on a teammate's (a bonus pays one holder). */
  sharedBonuses: { bonus: number; mine: number[]; teammate: number; theirs: number[] }[];
  /** Teammates whose list could not be read. */
  unknown: number[];
}

export function pickOverlap(g: MapGraph, mine: readonly number[], mates: readonly { player: number; list: readonly number[] | null }[]): PickOverlap {
  const out: PickOverlap = { overlap: [], sharedBonuses: [], unknown: [] };
  const bonuses = [...g.bonusById.values()].filter((b) => b.value > 0).sort((a, b) => a.id - b.id);
  for (const m of [...mates].sort((a, b) => a.player - b.player)) {
    if (!m.list) {
      out.unknown.push(m.player);
      continue;
    }
    mine.forEach((t, i) => {
      const j = m.list!.indexOf(t);
      if (j >= 0) out.overlap.push({ territory: t, mine: i + 1, teammate: m.player, theirs: j + 1 });
    });
    for (const b of bonuses) {
      const members = new Set(bonusTerritories(g, b.id));
      const a = mine.filter((t) => members.has(t)).sort(byNum);
      const c = m.list.filter((t) => members.has(t)).sort(byNum);
      if (a.length && c.length) out.sharedBonuses.push({ bonus: b.id, mine: a, teammate: m.player, theirs: c });
    }
  }
  return out;
}

/** The picks my list lost, from the award reading (#166, C2): who took each, as far as the board shows. */
export interface PicksLost {
  granted: number[];
  /**
   * Each territory ranked above a pick I was granted that went to another player, in list order: `teammate`
   * when the first board showed it as a teammate's, `opponent` when it did not (a team reading), `other`
   * outside a team reading.
   */
  lost: { territory: number; rank: number; by: 'teammate' | 'opponent' | 'other' }[];
  /** Starts my list did not hold (it ran out). */
  unlisted: number[];
}

export function picksLost(list: readonly number[], r: AwardReading): PicksLost {
  const mates = new Set(r.teammateStarts ?? []);
  const theirs = new Set(r.opponentStarts);
  const team = r.teammateStarts !== undefined;
  const lost: PicksLost['lost'] = [];
  list.forEach((territory, i) => {
    if (mates.has(territory)) lost.push({ territory, rank: i + 1, by: 'teammate' });
    else if (theirs.has(territory)) lost.push({ territory, rank: i + 1, by: team ? 'opponent' : 'other' });
  });
  return { granted: [...r.granted], lost, unlisted: [...r.unlisted] };
}
