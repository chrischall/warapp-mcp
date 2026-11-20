// Since last turn (#194): this turn's income against the next income the plan of the previous
// turn expected, and what changed hands since the previous board — the positive bonuses I held
// that are broken now, and the territories I held that are no longer mine (taken by a player,
// neutral again, or out of view), and (#442) the captures that plan expected and did not make, with
// who holds each now. Pure and deterministic (ascending ids); no I/O.
//
// The expected figure is the plan's `expected.nextIncome` as it stood when the previous turn was
// planned: it assumed the plan's orders were sent and every kept border held, so a shortfall says
// either an order was not sent as planned or a border fell — the lists say which borders.

import type { BoardState } from '../board.js';
import { bonusTerritories } from './bonuses.js';
import type { MapGraph } from './graph.js';
import type { ArmyCapIncome } from './player.js';

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
  /** #253: the army cap's arithmetic this turn, when the game has a cap (a cut is named in the line). */
  armyCap?: ArmyCapIncome | undefined;
  /** #442: the captures the previous turn's plan expected (its orders' targets); absent when unknown. */
  expectedCaptures?: readonly number[] | undefined;
}

export interface SinceLast {
  income: number;
  expected: number | null;
  expectedTurn: number | null;
  /** How far this turn's income fell short of the expected (0 when it met it); null without one. */
  shortfall: number | null;
  /**
   * #253: the army cap took `cut` of this turn's income `uncapped` (before Sanctions); absent without a cut.
   * A shortfall the cut explains is no lost border: the plan of the previous turn did not price the cap.
   */
  capCut?: { uncapped: number; cut: number };
  /** Positive bonuses I held on the previous board and no longer hold; absent without that board. */
  bonusesBroken?: Array<{ bonusId: number; value: number }>;
  /** Territories I held on the previous board and no longer hold, with the player who has them when shown. */
  territoriesLost?: Array<{ territoryId: number; to: number | null }>;
  /**
   * #442: the previous plan's captures I do not hold now, with the player who holds each when shown
   * (`to`; `fresh` when the previous board did not show it as that player's: my attack hit its fresh
   * capture, in effect an attack on that player); absent without those captures.
   */
  capturesMissed?: Array<{ territoryId: number; to: number | null; fresh?: true }>;
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
  const c = input.armyCap;
  if (c?.cut) out.capCut = { uncapped: c.uncapped, cut: c.uncapped - c.received };
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
  const toOf = (territoryId: number) => {
    const o = ownerNow.get(territoryId);
    return o?.kind === 'player' ? o.playerId : null;
  };
  const ownerBefore = new Map(previous.territories.map((t) => [t.territoryId, t.owner]));
  if (input.expectedCaptures)
    out.capturesMissed = [...new Set(input.expectedCaptures)]
      .filter((id) => graph.territoryById.has(id) && !now.has(id) && !before.has(id))
      .sort(byNum)
      .map((territoryId) => {
        const to = toOf(territoryId);
        const was = ownerBefore.get(territoryId);
        const fresh = to !== null && !(was?.kind === 'player' && was.playerId === to);
        return { territoryId, to, ...(fresh ? { fresh: true as const } : {}) };
      });
  out.territoriesLost = [...before]
    .filter((id) => !now.has(id))
    .sort(byNum)
    .map((territoryId) => ({ territoryId, to: toOf(territoryId) }));
  return out;
}
