// Map notes: what the map itself says about strategy, computed with no extra traffic —
// bonuses ranked by value per army to take at the game's settings, their entry points (and
// which of those are double borders, #166), the chokepoints, and (before the opening) income targets by turn from the pick
// advisor's opening simulation over the territories the game lists as pickable (never a
// start nobody can pick, #132). Pure and deterministic.

import { analyzeBonuses, entryTouches } from '../analysis/bonuses.js';
import { findChokepoints } from '../analysis/chokepoints.js';
import type { MapGraph } from '../analysis/graph.js';
import {
  DEFAULT_NON_DISTRIBUTION_ARMIES,
  PICK_HORIZON,
  planPicks,
  type PickSettings,
} from '../analysis/picks.js';
import { OVERRIDES_UNPARSED } from '../analysis/overrides.js';
import { captureCost } from '../analysis/planner.js';
import { DEFAULT_BASE_INCOME } from '../analysis/player.js';
import { DEFAULT_DEFENSIVE_KILL_RATE, DEFAULT_OFFENSIVE_KILL_RATE } from '../analysis/combat.js';

/** Bonus rows by default. */
const MAP_NOTES_LIMIT = 10;
/** Chokepoint rows by default. */
const MAP_CHOKEPOINTS_LIMIT = 10;

interface MapNotesInput {
  graph: MapGraph;
  settings?: PickSettings;
  /**
   * Simulate the opening (picks still ahead): the players, each one's territory limit, and the
   * territories the game lists as pickable (with the neutral armies on the board, when known).
   * Without `pickable` there are no income targets: a simulation over every territory paces a
   * start nobody can pick (#132).
   */
  opening?: {
    players: number;
    territoryLimit: number;
    pickable?: readonly number[];
    neutralArmies?: ReadonlyMap<number, number>;
  };
  /** Bonus and chokepoint rows (default {@link MAP_NOTES_LIMIT} and {@link MAP_CHOKEPOINTS_LIMIT}). */
  limit?: number;
  /** The game overrides bonus values that could not all be read (`settings.overriddenBonusesUnparsed`). */
  overridesUnparsed?: boolean;
}

interface Named {
  id: number;
  name: string;
}

interface BonusEfficiency {
  bonusId: number;
  name: string;
  value: number;
  territories: number;
  /** Armies to capture every territory from neutral at the settings. */
  armiesToTake: number;
  /** `value / armiesToTake`, 2 decimals. */
  valuePerArmy: number;
  /** Territories outside the bonus next to it: where it is attacked from. */
  entryPoints: Named[];
  /** The entry points next to two or more of its territories, with how many (#166). */
  doubleBorders: Array<Named & { touches: number }>;
}

interface MapChokepoint {
  territoryId: number;
  name: string;
  reasons: string[];
  bonus: string | null;
  connects: string[];
}

interface IncomeTarget {
  turn: number;
  /** Base income plus the bonuses held by the start of the turn. */
  income: number;
  /** Those bonuses, by name. */
  bonuses: string[];
}

export interface MapNotes {
  bonuses: BonusEfficiency[];
  /** Positive-value bonuses ranked (before the limit). */
  bonusesRanked: number;
  chokepoints: MapChokepoint[];
  incomeTargets?: IncomeTarget[];
  assumptions: string[];
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export function mapNotes(input: MapNotesInput): MapNotes {
  const { graph: g } = input;
  const s = input.settings ?? {};
  const limit = input.limit ?? MAP_NOTES_LIMIT;
  const assumptions: string[] = [];
  if (input.overridesUnparsed) assumptions.push(OVERRIDES_UNPARSED);
  const name = (id: number): Named => ({ id, name: g.territoryById.get(id)?.name ?? String(id) });
  const bonusName = (id: number | null) => (id === null ? null : (g.bonusById.get(id)?.name ?? String(id)));

  // ---- bonuses by value per army ----
  const neutral = s.initialNonDistributionArmies ?? DEFAULT_NON_DISTRIBUTION_ARMIES;
  assumptions.push(
    `Every territory is costed as a neutral of ${neutral}${
      s.initialNonDistributionArmies === undefined ? ' (the usual default; the settings did not say)' : ''
    }; wastelands and picked territories are not known from the map.`,
  );
  if (s.offensiveKillRate === undefined || s.defensiveKillRate === undefined)
    assumptions.push(`Kill rates assumed ${DEFAULT_OFFENSIVE_KILL_RATE}/${DEFAULT_DEFENSIVE_KILL_RATE} (offence/defence).`);
  const cost = captureCost(neutral, {
    ...(s.offensiveKillRate !== undefined ? { offensiveKillRate: s.offensiveKillRate } : {}),
    ...(s.defensiveKillRate !== undefined ? { defensiveKillRate: s.defensiveKillRate } : {}),
    ...(s.luckModifier !== undefined ? { luckModifier: s.luckModifier } : {}),
  });
  const ranked: BonusEfficiency[] = [];
  if (cost === null) assumptions.push('At these kill rates attackers cannot kill: no bonus can be taken.');
  else {
    for (const b of analyzeBonuses(g)) {
      if (b.value < 1 || !b.territoryIds.length) continue;
      const armies = b.territoryIds.length * cost;
      ranked.push({
        bonusId: b.bonusId,
        name: b.name,
        value: b.value,
        territories: b.territoryIds.length,
        armiesToTake: armies,
        valuePerArmy: round2(b.value / armies),
        entryPoints: b.entryPointIds.map(name),
        doubleBorders: [...entryTouches(g, b.bonusId)].filter(([, k]) => k > 1).map(([id, k]) => ({ ...name(id), touches: k })),
      });
    }
    ranked.sort(
      (a, b) =>
        b.value / b.armiesToTake - a.value / a.armiesToTake ||
        a.entryPoints.length - b.entryPoints.length ||
        b.value - a.value ||
        a.bonusId - b.bonusId,
    );
  }

  // ---- chokepoints ----
  const chokepoints = findChokepoints(g)
    .slice(0, input.limit ?? MAP_CHOKEPOINTS_LIMIT)
    .map((c) => ({
      territoryId: c.territoryId,
      name: c.name,
      reasons: [...c.reasons],
      bonus: bonusName(c.bonusId),
      connects: c.connectsBonusIds.map((id) => bonusName(id)!),
    }));

  const out: MapNotes = { bonuses: ranked.slice(0, limit), bonusesRanked: ranked.length, chokepoints, assumptions };

  // ---- income targets from the opening simulation ----
  if (input.opening && input.opening.territoryLimit > 0) {
    const { players, territoryLimit } = input.opening;
    const pickable = (input.opening.pickable ?? []).filter((t) => g.territoryById.has(t));
    if (!pickable.length) {
      assumptions.push(
        'No income targets: the game did not list its pickable territories here, and a simulation over every ' +
          'territory would pace a start nobody can pick. warapp_plan_picks reads them from the live board.',
      );
    } else {
      // Only the primary group sets the pace, so only it is searched (maxPicks = the limit): the
      // fallback search behind it took ~10 s in a 1v1 on a 761-territory map, on the server's thread (#129, #132).
      const plan = planPicks({
        graph: g,
        pickable,
        settings: s,
        players: Math.max(2, players),
        territoryLimit,
        maxPicks: territoryLimit,
        ...(input.opening.neutralArmies ? { neutralArmies: input.opening.neutralArmies } : {}),
      });
      const base = s.minimumArmyBonus ?? DEFAULT_BASE_INCOME;
      const done = plan.groups.primary.bonuses;
      out.incomeTargets = Array.from({ length: PICK_HORIZON + 1 }, (_, i) => {
        const turn = i + 1;
        // A bonus completed during turn k (0: held by the picks) pays from turn k + 1.
        const held = done.filter((b) => b.turn < turn);
        return { turn, income: base + held.reduce((n, b) => n + b.value, 0), bonuses: held.map((b) => b.name) };
      });
      assumptions.push(
        `Income targets come from the pick advisor's best opening over the ${pickable.length} territor${
          pickable.length === 1 ? 'y' : 'ies'
        } the game lists as pickable, with nobody in the way: a pace to aim for, not a promise ` +
          '(warapp_plan_picks gives the picks and a fallback group).',
      );
      if (s.bonusArmyPer) assumptions.push('Income targets leave out per-territory income.');
    }
  }
  return out;
}

/** Map notes as markdown. Bonus and territory names are the map designer's text. */
export function mapNotesMarkdown(mapName: string, n: MapNotes): string {
  const lines = [`# Strategy notes for the map ${mapName}`, ''];
  lines.push(`## Bonuses by value per army to take (${n.bonuses.length} of ${n.bonusesRanked})`, '');
  for (const b of n.bonuses) {
    const double = new Map(b.doubleBorders.map((d) => [d.id, d.touches]));
    const entry = (e: Named) =>
      double.has(e.id) ? `${e.name} (a double border: next to ${double.get(e.id)} of its territories)` : e.name;
    lines.push(
      `- ${b.name} (+${b.value}): ${b.territories} territories, ${b.armiesToTake} armies to take, ` +
        `${b.valuePerArmy} per army; entry points: ${b.entryPoints.map(entry).join(', ') || 'none'}`,
    );
  }
  lines.push('', '## Chokepoints', '');
  for (const c of n.chokepoints)
    lines.push(`- ${c.name} (${c.reasons.join(', ')})${c.connects.length ? `: joins ${[c.bonus, ...c.connects].filter(Boolean).join(', ')}` : ''}`);
  if (n.incomeTargets) {
    lines.push('', '## Income targets by turn', '');
    for (const t of n.incomeTargets) lines.push(`- Turn ${t.turn}: ${t.income}${t.bonuses.length ? ` (${t.bonuses.join(', ')})` : ''}`);
  }
  lines.push('', '## Assumptions', '', ...n.assumptions.map((a) => `- ${a}`), '');
  return lines.join('\n');
}
