// A progressive Reinforcement card (`Mode` 1, `ProgressivePercentage` 0.1): the client bundle values a card when it
// is earned as round(0.1 × the territories ANY player holds) (`ProgressiveByNumberOfTerritories`, neutrals left out),
// rounded to the nearest with .5 down, at least 1 — not 10% of the earning player's own territories. Every id is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { reinforcementArmiesFor } from '../../src/analysis/plan/shared.js';
import { enemyDeployEstimates, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const OTHER = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const BY_TERRITORIES = { by: 'territories' as const, percentage: 0.1 };

describe('reinforcementArmiesFor: the client formula', () => {
  const clock = (armies = 0) => ({ firstTurn: 5, armies, turnsPerCard: 5, progressive: BY_TERRITORIES });
  it('values the card at 10% of every player-held territory, .5 rounding down, at least 1', () => {
    expect(reinforcementArmiesFor(clock(), { territories: 540, turn: 9 })).toEqual({ armies: 54, basis: 'client formula' });
    expect(reinforcementArmiesFor(clock(), { territories: 545, turn: 9 })).toEqual({ armies: 54, basis: 'client formula' });
    expect(reinforcementArmiesFor(clock(), { territories: 546, turn: 9 })).toEqual({ armies: 55, basis: 'client formula' });
    expect(reinforcementArmiesFor(clock(), { territories: 3, turn: 9 })).toEqual({ armies: 1, basis: 'client formula' });
  });
  it('under fog the territories in view are a floor: a larger card of mine (same game, same formula) is used', () => {
    expect(reinforcementArmiesFor(clock(54), { territories: 150, turn: 9 })).toEqual({ armies: 54, basis: "my card's value" });
    expect(reinforcementArmiesFor(clock(12), { territories: 150, turn: 9 })).toEqual({ armies: 15, basis: 'client formula' });
  });
  it('by turn: (turn the card is earned) × the percentage', () => {
    const turns = { firstTurn: 5, armies: 0, turnsPerCard: 5, progressive: { by: 'turns' as const, percentage: 2 } };
    expect(reinforcementArmiesFor(turns, { territories: 0, turn: 9 })).toEqual({ armies: 16, basis: 'client formula' });
  });
  it('a flat card keeps its armies and carries no basis', () => {
    expect(reinforcementArmiesFor({ firstTurn: 5, armies: 7, turnsPerCard: 5 }, { territories: 540, turn: 9 })).toEqual({ armies: 7 });
  });
});

describe('an opponent\'s progressive card counts every player\'s territories, not its own', () => {
  // 30 territories in a line: mine 1-10, the opponent's 11-12 (beside me), another player's 13-24, neutrals 25-30.
  const ids = Array.from({ length: 30 }, (_, i) => i + 1);
  const map: GameMap = {
    id: 1,
    name: 'Line',
    territories: ids.map((id) => ({ id, name: `T${id}`, connectedTo: ids.filter((n) => Math.abs(n - id) === 1) })),
    bonuses: [],
    distributionModes: [],
  };
  const g = buildGraph(map);
  const foe = (territoryId: number, playerId: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId }, armies: 3 });
  const b = board([
    ...ids.slice(0, 10).map((id) => mine(id, 3)),
    foe(11, FOE),
    foe(12, FOE),
    ...ids.slice(12, 24).map((id) => foe(id, OTHER)),
    ...ids.slice(24).map((id) => neutral(id, 2)),
  ]);
  it('24 territories held by players: 2 armies (10% of 24), not 1 (10% of its 2)', () => {
    const reinforcement = { firstTurn: 1, armies: 0, turnsPerCard: 5, progressive: BY_TERRITORIES };
    const e = enemyDeployEstimates(g, b, ME, STD, undefined, undefined, undefined, { turn: 9, fog: 'NoFog', reinforcement }).find((x) => x.playerId === FOE)!;
    expect(e.card).toEqual({ armies: 2, due: 1, basis: 'client formula' });
  });
  it('a card in my hand worth more is the figure, labelled as mine', () => {
    const reinforcement = { firstTurn: 1, armies: 54, turnsPerCard: 5, progressive: BY_TERRITORIES };
    const e = enemyDeployEstimates(g, b, ME, STD, undefined, undefined, undefined, { turn: 9, fog: 'NoFog', reinforcement }).find((x) => x.playerId === FOE)!;
    expect(e.card).toEqual({ armies: 54, due: 1, basis: "my card's value" });
  });
});
