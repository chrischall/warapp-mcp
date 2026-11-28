// #593 5c: the bait warning. A lightly held territory of a player's beside its big stack reads as
// a cheap capture, but that stack can move in before my attack lands (it moves first in the
// zigzag, or my attack is not my first order), and the attack then meets everything at once. The
// owner's rematch lost four 2–3 army attacks this way; the Tibet one met 24 moved in and 12
// deployed. The submit preview has no deploy estimate (warapp_check_plan's `gather` reply adds it):
// this counts only the armies there and what its stacks beside it can move in, so whatever it
// names is short before a single army is deployed.
import { armiesToTake, COMMANDER_STRENGTH, specialUnitStrength } from '../analysis/combat.js';
import { neighborsOf, type MapGraph } from '../analysis/graph.js';
import type { PlannerSettings } from '../analysis/plan/shared.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../live.js';
import type { MoveMode } from './order-options.js';

type Place = { id: number; name: string };

export interface BaitInput {
  graph: MapGraph;
  board: readonly LiveTerritory[];
  /** My in-game id. */
  me: number;
  moves: ReadonlyArray<{ from: Place; to: Place; armies: number; mode?: MoveMode; commander?: boolean; attackTeammates?: boolean }>;
  settings: PlannerSettings;
  /** A territory in a sentence, as the preview names it. */
  label: (place: Place) => string;
  /** A territory id with its name. */
  name: (id: number) => Place;
  teammates?: ReadonlySet<number>;
}

/** The preview's warning, or `undefined` when no attack can be met that way. */
export function baitAttackWarning(input: BaitInput): string | undefined {
  const { graph, board, me, settings, label, name } = input;
  const teammates = input.teammates ?? new Set<number>();
  const standing = new Map(board.map((t) => [t.territoryId, t]));
  const guard = settings.oneArmyStandsGuard === false ? 0 : 1;
  const rates = {
    ...(settings.offensiveKillRate !== undefined ? { offensiveKillRate: settings.offensiveKillRate } : {}),
    ...(settings.defensiveKillRate !== undefined ? { defensiveKillRate: settings.defensiveKillRate } : {}),
  };
  /**
   * My attacks by target, in the order first listed: a player's visible territory, not a teammate's unless asked.
   * Never a neutral's (#617: the live board's owner 0, whose stacks never move) or a hidden or pickable one (below 0).
   */
  const byTarget = new Map<number, { from: Place; to: Place; armies: number }>();
  for (const m of input.moves) {
    const t = standing.get(m.to.id);
    if (m.mode === 'transfer-only' || !t || t.fogged || t.owner === me || t.owner <= OWNER_NEUTRAL) continue;
    if (teammates.has(t.owner) && m.attackTeammates !== true) continue;
    const power = m.armies + (m.commander ? COMMANDER_STRENGTH : 0);
    const g = byTarget.get(m.to.id);
    if (g) g.armies += power;
    else byTarget.set(m.to.id, { from: m.from, to: m.to, armies: power });
  }
  const parts: string[] = [];
  for (const [id, a] of byTarget) {
    const target = standing.get(id)!;
    const owner = target.owner;
    const stacks = neighborsOf(graph, id)
      .map((n) => standing.get(n))
      .filter((s): s is LiveTerritory => s !== undefined && !s.fogged && s.owner === owner && (s.armies ?? 0) > guard)
      .map((s) => ({ id: s.territoryId, moves: (s.armies ?? 0) - guard }))
      .sort((x, y) => y.moves - x.moves || x.id - y.id);
    if (!stacks.length) continue;
    const defenders = (target.armies ?? 0) + specialUnitStrength(target.specialUnits) + stacks.reduce((n, s) => n + s.moves, 0);
    const needs = armiesToTake(defenders, rates);
    if (needs !== null && a.armies >= needs) continue;
    parts.push(
      `${label(a.from)} → ${label(a.to)} with ${a.armies}: player ${owner}'s stacks beside it can move in first (${stacks
        .map((s) => `${label(name(s.id))} ${s.moves}`)
        .join(', ')}), ${defenders} defenders before any deploy, which ${needs === null ? 'no attack can take' : `needs ${needs}`}`,
    );
  }
  if (!parts.length) return undefined;
  return (
    `Possible bait (#593): ${parts.join('; ')}. That happens when it moves first, or when its moves run before the attack in the zigzag. ` +
    'warapp_check_plan tries it with its deploy too (the `gather` reply).'
  );
}
