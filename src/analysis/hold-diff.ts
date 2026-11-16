// Given orders against the default plan's holds (#275, pattern 3). Pure and deterministic; ties resolve
// on ascending ids.
//
// A hand-edited turn can drain a border the plan sized: a deploy moved to the interior, an extra attack
// out. The headroom table (headroom.ts) says what deploy takes a border after the given orders; this
// says which borders the given orders leave below what the default plan (planTurn on the same board,
// default options) leaves there, and by how much — a diff against the plan, so it names the edit.
//
// A border is a territory I hold at the start of the turn beside an enemy stack (its owner shown, armies
// in view; a teammate is no enemy) that the plan does not concede. Its hold is what stands on it once
// the plan's deploys and moves have run on the turn simulator (turn-sim.ts) with no opponent order — my
// commander counted as COMMANDER_STRENGTH — and what is left is the same after the given orders. Only a
// border the given orders leave below the hold is named. Card plays are not carried out (a Blockade or an
// Airlift changes nothing here), and luck is resolved at its expectation, as the simulator does.

import type { BoardState } from '../board.js';
import { COMMANDER_STRENGTH } from './combat.js';
import type { MapGraph } from './graph.js';
import { neighborsOf } from './graph.js';
import { simTerritories, simulateTurn, type SimOrder, type SimSettings, type SimTerritory } from './turn-sim.js';

export interface HoldOrders {
  deploys: readonly { territoryId: number; armies: number }[];
  /** Attacks and transfers, in the order they will be submitted. */
  moves: readonly SimOrder[];
}

export interface HoldDiffInput {
  graph: MapGraph;
  board: BoardState;
  me: number;
  settings?: SimSettings;
  teams?: ReadonlyMap<number, number>;
  /** The default plan's orders. */
  plan: HoldOrders;
  /** The borders the plan concedes: it holds none of them. */
  conceded?: readonly number[];
  /** The orders given. */
  given: HoldOrders;
}

export interface HoldShortfall {
  territory: number;
  /** What the plan leaves standing on it (my commander as COMMANDER_STRENGTH). */
  hold: number;
  /** What the given orders leave standing on it. */
  left: number;
  /** `hold − left`, always positive. */
  short: number;
}

/** Every border the given orders leave below the default plan's hold, the largest shortfall first. */
export function holdsBelowPlan(input: HoldDiffInput): HoldShortfall[] {
  const { graph, board, me, teams } = input;
  const start = simTerritories(board);
  const sameTeam = (a: number, b: number) => teams !== undefined && teams.get(a) !== undefined && teams.get(a) === teams.get(b);
  const enemy = (owner: SimTerritory['owner'] | undefined) => typeof owner === 'number' && owner !== me && !sameTeam(owner, me);
  const conceded = new Set(input.conceded ?? []);
  const borders = [...start]
    .filter(([id, t]) => t.owner === me && !conceded.has(id) && neighborsOf(graph, id).some((n) => enemy(start.get(n)?.owner)))
    .map(([id]) => id);
  if (!borders.length) return [];
  const standing = (o: HoldOrders) => {
    const r = simulateTurn({
      graph,
      board,
      deploys: o.deploys.map((d) => ({ player: me, territoryId: d.territoryId, armies: d.armies })),
      orders: [{ player: me, orders: o.moves.map((m) => ({ ...m })) }],
      moveOrder: [me],
      ...(input.settings ? { settings: input.settings } : {}),
      ...(teams ? { teams } : {}),
    });
    return (id: number) => {
      const t = r.territories.get(id);
      if (!t || t.owner !== me) return 0;
      return t.armies + (t.commander === me ? COMMANDER_STRENGTH : 0);
    };
  };
  const planned = standing(input.plan);
  const given = standing(input.given);
  const out: HoldShortfall[] = [];
  for (const id of borders) {
    const hold = planned(id);
    const left = given(id);
    if (left < hold) out.push({ territory: id, hold, left, short: hold - left });
  }
  return out.sort((a, b) => b.short - a.short || a.territory - b.territory);
}
