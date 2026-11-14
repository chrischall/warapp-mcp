// Since last turn (#194): this turn's income against the next income the plan of the previous
// turn expected, and what changed hands since the previous board — the positive bonuses I held
// that are broken now, and the territories I held that are no longer mine (taken by a player,
// neutral again, or out of view). Pure and deterministic (ascending ids); no I/O.
//
// The expected figure is the plan's `expected.nextIncome` as it stood when the previous turn was
// planned: it assumed the plan's orders were sent and every kept border held, so a shortfall says
// either an order was not sent as planned or a border fell — the lists say which borders.

import type { BoardState } from '../board.js';
import { bonusTerritories } from './bonuses.js';
import type { MapGraph } from './graph.js';

interface SinceLastInput {
  graph: MapGraph;
  /** The board of the previous turn as I saw it; absent when neither the cache nor history has it. */
  previous?: BoardState | undefined;
  /** This turn's board. */
  current: BoardState;
  me: number;
  /** This turn's income on the board, cards aside (the figure `expected` predicted). */
  income: number;
  /** The previous turn's plan's `expected.nextIncome`; absent when it was not planned here. */
  expected?: number | undefined;
  /** The turn whose plan made `expected`. */
  expectedTurn?: number | undefined;
}

export interface SinceLast {
  income: number;
  expected: number | null;
  expectedTurn: number | null;
  /** How far this turn's income fell short of the expected (0 when it met it); null without one. */
  shortfall: number | null;
  /** Positive bonuses I held on the previous board and no longer hold; absent without that board. */
  bonusesBroken?: Array<{ bonusId: number; value: number }>;
  /** Territories I held on the previous board and no longer hold, with the player who has them when shown. */
  territoriesLost?: Array<{ territoryId: number; to: number | null }>;
}

const byNum = (a: number, b: number) => a - b;

function heldBy(b: BoardState, me: number, g: MapGraph): Set<number> {
  const out = new Set<number>();
  for (const t of b.territories)
    if (g.territoryById.has(t.territoryId) && t.owner.kind === 'player' && t.owner.playerId === me) out.add(t.territoryId);
  return out;
}

export function sinceLastTurn(input: SinceLastInput): SinceLast {
  const { graph, previous, current, me, income } = input;
  const expected = input.expected ?? null;
  const out: SinceLast = {
    income,
    expected,
    expectedTurn: expected === null ? null : (input.expectedTurn ?? null),
    shortfall: expected === null ? null : Math.max(0, expected - income),
  };
  if (!previous) return out;
  const before = heldBy(previous, me, graph);
  const now = heldBy(current, me, graph);
  const holds = (held: ReadonlySet<number>, ts: readonly number[]) => ts.length > 0 && ts.every((t) => held.has(t));
  out.bonusesBroken = [...graph.bonusById.values()]
    .filter((b) => b.value > 0)
    .map((b) => ({ b, ts: bonusTerritories(graph, b.id) }))
    .filter(({ ts }) => holds(before, ts) && !holds(now, ts))
    .map(({ b }) => ({ bonusId: b.id, value: b.value }))
    .sort((x, y) => x.bonusId - y.bonusId);
  const ownerNow = new Map(current.territories.map((t) => [t.territoryId, t.owner]));
  out.territoriesLost = [...before]
    .filter((id) => !now.has(id))
    .sort(byNum)
    .map((territoryId) => {
      const o = ownerNow.get(territoryId);
      return { territoryId, to: o?.kind === 'player' ? o.playerId : null };
    });
  return out;
}
