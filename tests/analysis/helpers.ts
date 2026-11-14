import { readFileSync } from 'node:fs';
import type { BoardState, TerritoryState } from '../../src/board.js';
import type { PlannedMove, TurnPlan } from '../../src/analysis/planner.js';
import { normalizeMap, normalizeSettings, type GameMap, type GameSettings } from '../../src/normalize.js';

/** The anonymized lobby fixture's map (761 territories, 372 bonuses). */
export function fixtureMap(): GameMap {
  const raw = JSON.parse(
    readFileSync(new URL('../fixtures/gamefeed-lobby-map39905.json', import.meta.url), 'utf8'),
  ) as { map: unknown };
  return normalizeMap(raw.map);
}

export function fixtureSettings(): GameSettings {
  const raw = JSON.parse(
    readFileSync(new URL('../fixtures/gamefeed-lobby-map39905.json', import.meta.url), 'utf8'),
  ) as { settings: unknown };
  return normalizeSettings(raw.settings);
}

/**
 * A small hand-built map:
 *
 *   1 ─ 2        bonus A (3):  1, 2, 3
 *    \ /         bonus B (2):  4, 5
 *     3 ─ 4 ─ 5 ─ 6 ─ 7      bonus C (0):  6
 *                            bonus S (4):  A + B (superbonus)
 *                            7 is in no bonus
 */
export function tinyMap(): GameMap {
  const edges: [number, number][] = [
    [1, 2],
    [2, 3],
    [1, 3],
    [3, 4],
    [4, 5],
    [5, 6],
    [6, 7],
  ];
  const ids = [1, 2, 3, 4, 5, 6, 7];
  return {
    id: 1,
    name: 'Tiny',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      // Deliberately one-sided adjacency for 6-7: the graph must symmetrize it.
      connectedTo: edges
        .filter(([a, b]) => a === id || (b === id && !(a === 6 && b === 7)))
        .map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: [
      { id: 101, name: 'A', value: 3, territoryIds: [1, 2, 3], bonusIds: [] },
      { id: 102, name: 'B', value: 2, territoryIds: [4, 5], bonusIds: [] },
      { id: 103, name: 'C', value: 0, territoryIds: [6], bonusIds: [] },
      { id: 104, name: 'S', value: 4, territoryIds: [], bonusIds: [101, 102] },
    ],
    distributionModes: [],
  };
}

export function board(entries: TerritoryState[], verified = false): BoardState {
  return { source: 'gamefeed', verified, territories: entries };
}

export const mine = (territoryId: number, armies: number, playerId = 10): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
export const neutral = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'neutral' },
  armies,
});
export const fogged = (territoryId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'unknown' },
  armies: null,
  fogLevel: 'Fogged',
});

/**
 * The raw (GameFeed-shaped) synthetic map. Territories 1–8 in a line (1–2–3–4–5–6–7–8).
 *   bonus 1  "Hidden 1"  −2: territory 1          (bonus id 1 is also territory id 1)
 *   bonus 2  "Hidden 2"  −1: territory 2
 *   bonus 3  "Hidden 3"  +1: territory 3
 *   bonus 10 "North"     +4: 1, 2, 3
 *   bonus 11 "East"      +3: 3, 4, 5              (overlaps North on 3)
 *   bonus 12 "Ring"      +2: 5, 6
 *   bonus 13 "Waste"      0: 7
 *   bonus 20 "Realm"     +5: North + East, and member id 3 — a territory first, not bonus 3
 */
export function overlapRawMap(): Record<string, unknown> {
  const ids = [1, 2, 3, 4, 5, 6, 7, 8];
  return {
    id: '424242',
    name: 'Synthetic Overlap',
    territories: ids.map((id) => ({
      id: String(id),
      name: `Plot ${id}`,
      connectedTo: [id - 1, id + 1].filter((n) => n >= 1 && n <= 8),
    })),
    bonuses: [
      { id: '1', name: 'Hidden 1', value: '-2', territoryIDs: [1] },
      { id: '2', name: 'Hidden 2', value: '-1', territoryIDs: [2] },
      { id: '3', name: 'Hidden 3', value: '1', territoryIDs: [3] },
      { id: '10', name: 'North', value: '4', territoryIDs: [1, 2, 3] },
      { id: '11', name: 'East', value: '3', territoryIDs: [3, 4, 5] },
      { id: '12', name: 'Ring', value: '2', territoryIDs: [5, 6] },
      { id: '13', name: 'Waste', value: '0', territoryIDs: [7] },
      { id: '20', name: 'Realm', value: '5', territoryIDs: [10, 11, 3] },
    ],
    distributionModes: [],
  };
}

/**
 * Attacks other than #107's contact fallback (reason "cheapest capture …" / "cheapest expansion …",
 * or a combined capture's softener for one): in the contact and late phases a plan that would
 * otherwise capture nothing now takes one, so a test of another rule checks only the rest.
 */
export function ruleAttacks(p: TurnPlan): PlannedMove[] {
  return p.moves.filter(
    (m) => m.kind === 'attack' && !/^(wears .* down for a combined capture \()?cheapest (capture|expansion)/.test(m.reason),
  );
}

/**
 * #226: the size an attack was planned at before the margin from idle armies joined it — the "up
 * from N" of its margin line — else what it sends. Tests of a sizing rule read this one.
 */
export function sizedBeforeMargin(plan: TurnPlan, from: number, to: number): number | undefined {
  const line = plan.rationale.find((l) => l.startsWith(`Margin on the attack on T${to} (#${to}) from T${from} (#${from}) (#226): up from `));
  if (line) return Number(/up from (\d+) to/.exec(line)![1]);
  return plan.moves.find((m) => m.kind === 'attack' && m.from === from && m.to === to)?.armies;
}
