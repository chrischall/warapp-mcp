// One Army Must Stand Guard off (#165): every army may move, so a territory can stand at 0. Such a
// territory falls to any single army, and an enemy territory at 0 is taken by a one-army attack —
// which, in a bonus its owner holds, breaks the bonus for one army. The planner frees every army to
// move and makes neither check; this reports both for a list of orders. Pure and deterministic.
import type { BoardState } from '../board.js';
import type { MapGraph } from './graph.js';
import { neighborsOf } from './graph.js';

export interface GuardOffBreak {
  /** The enemy territory standing at 0. */
  territoryId: number;
  /** My territory beside it (lowest id). */
  from: number;
  playerId: number;
  /** The bonus its owner holds in full that losing it breaks (the most valuable). */
  bonusId: number;
  value: number;
}

export interface GuardOffExposure {
  /** My territories the orders leave at 0 armies beside an enemy or the fog, ascending. */
  emptied: number[];
  /** Enemy territories at 0 beside me whose capture breaks a bonus, that the orders do not attack. */
  breaks: GuardOffBreak[];
}

export function guardOffExposure(args: {
  graph: MapGraph;
  board: BoardState;
  me: number;
  /** Teammates (not enemies). */
  friends?: ReadonlySet<number>;
  deploys: readonly { territoryId: number; armies: number }[];
  moves: readonly { from: number; to: number; armies: number }[];
}): GuardOffExposure {
  const { graph, board, me } = args;
  const friends = args.friends ?? new Set<number>();
  const byId = new Map(board.territories.map((t) => [t.territoryId, t]));
  const ownerOf = (id: number) => {
    const o = byId.get(id)?.owner;
    return o?.kind === 'player' ? o.playerId : undefined;
  };
  const isMine = (id: number) => ownerOf(id) === me;
  const isEnemy = (id: number) => {
    const p = ownerOf(id);
    return p !== undefined && p !== me && !friends.has(p);
  };
  const hidden = (id: number) => {
    const t = byId.get(id);
    return !t || t.owner.kind === 'unknown' || t.armies === null;
  };

  const left = new Map<number, number>();
  for (const t of board.territories) if (isMine(t.territoryId)) left.set(t.territoryId, t.armies ?? 0);
  for (const d of args.deploys) if (left.has(d.territoryId)) left.set(d.territoryId, left.get(d.territoryId)! + d.armies);
  for (const m of args.moves) {
    if (left.has(m.from)) left.set(m.from, Math.max(0, left.get(m.from)! - m.armies));
    if (left.has(m.to)) left.set(m.to, left.get(m.to)! + m.armies);
  }
  const hasMyCommander = (id: number) => byId.get(id)?.specialUnits?.some((u) => u.kind === 'commander' && u.playerId === me) ?? false;
  const emptied = [...left.entries()]
    .filter(([id, n]) => n === 0 && !hasMyCommander(id) && neighborsOf(graph, id).some((x) => isEnemy(x) || hidden(x)))
    .map(([id]) => id)
    .sort((a, b) => a - b);

  const attacked = new Set(args.moves.map((m) => m.to));
  const breaks: GuardOffBreak[] = [];
  for (const t of [...board.territories].sort((a, b) => a.territoryId - b.territoryId)) {
    const id = t.territoryId;
    const owner = ownerOf(id);
    if (owner === undefined || !isEnemy(id) || t.armies !== 0 || t.specialUnits?.length || attacked.has(id)) continue;
    const from = neighborsOf(graph, id).filter(isMine).sort((a, b) => a - b)[0];
    if (from === undefined) continue;
    const held = [...graph.bonusById.values()]
      .filter((b) => b.value > 0 && b.territoryIds.includes(id) && b.territoryIds.every((x) => ownerOf(x) === owner))
      .sort((a, b) => b.value - a.value || a.id - b.id)[0];
    if (held) breaks.push({ territoryId: id, from, playerId: owner, bonusId: held.id, value: held.value });
  }
  return { emptied, breaks };
}
