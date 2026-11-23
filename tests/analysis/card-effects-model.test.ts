// The planner's model of active cards: Sanctions cut every income figure of a sanctioned opponent (its
// tracked figure, the fog prior, both ends of the thin-evidence range and the estimate), from the turn
// after the card is played; Sanctions on me are matched by the deploy-total check; an opponent's
// Reinforcement card is valued by the game's rule (flat, or progressive) and shown apart as `cardBonus`.
// Every map, id and figure here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { deployCheckUncertainties, incomeUncertainties } from '../../src/analysis/player.js';
import { enemyDeployEstimates, type PlannerSettings, type ReinforcementPlays } from '../../src/analysis/planner.js';
import { applySanctions } from '../../src/analysis/plan/estimates.js';
import type { EnemyDeployEstimate } from '../../src/analysis/plan/shared.js';
import { normalizeSettings } from '../../src/normalize.js';
import type { GameMap } from '../../src/normalize.js';
import { opponentReinforcement } from '../../src/tools/card-advice.js';
import { opponentDeploy } from '../../src/tools/stress-opponents.js';
import { board, mine } from './helpers.js';

const ME = 10;
const FOE = 20;

/** A fogged opponent read from little of its frontier: tracked 23, prior 94, holding a card the clock adds. */
const thin = (): EnemyDeployEstimate =>
  ({
    playerId: FOE,
    estimate: 59 + 54,
    source: 'prior',
    tracked: 23,
    trackedTurns: [4, 5, 6],
    prior: 94,
    card: { armies: 54, due: 3 },
    thinEvidence: { coverage: 0, rising: null, tracked: 23, prior: 94, trend: null, lower: 23, upper: 94, midpoint: 59, toward: 40, weight: 1, figure: 59 },
  }) as unknown as EnemyDeployEstimate;

describe('Sanctions on an opponent cut every income figure', () => {
  // 60% Sanctions played on turn 7: they cut its income from turn 8 until turn 10.
  const sixty = [{ player: FOE, percentage: 0.6, untilTurn: 10, fromTurn: 8 }];

  it('cuts the thin-evidence range 23..94 to about 9..38 (not an uncut prior plus a card of 127)', () => {
    const [e] = applySanctions([thin()], sixty, 8);
    expect(e!.thinEvidence).toMatchObject({ lower: 9, upper: 38, tracked: 9, prior: 38 });
    const income = e!.estimate - e!.card!.armies;
    expect(income).toBeGreaterThanOrEqual(9);
    expect(income).toBeLessThanOrEqual(38);
    expect(e!.sanctioned).toMatchObject({ applied: true, before: 59, after: income, percentages: [0.6] });
    // The card stays on top, apart.
    expect(e!.card).toEqual({ armies: 54, due: 3 });
  });

  it('cuts a prior, tracked or observed figure as it does one read off the board', () => {
    const base = { playerId: FOE, estimate: 23, card: null, trackedTurns: [4, 5] } as unknown as EnemyDeployEstimate;
    for (const source of ['visible', 'exact', 'observed', 'tracked', 'prior'] as const) {
      const [e] = applySanctions([{ ...base, source }], sixty, 8);
      expect(e, source).toMatchObject({ estimate: 9, sanctioned: { applied: true, before: 23, after: 9 } });
    }
  });

  it('leaves a figure read from deploys made under the card alone: it already carries the cut', () => {
    const base = { playerId: FOE, estimate: 9, card: null, source: 'tracked', trackedTurns: [8, 9] } as unknown as EnemyDeployEstimate;
    const [e] = applySanctions([base], [{ player: FOE, percentage: 0.6, untilTurn: 11, fromTurn: 8 }], 10);
    expect(e).toMatchObject({ estimate: 9, sanctioned: { applied: false, before: 9, after: 9, carried: true } });
    // One turn behind it came before the card bit: cut.
    const [mixed] = applySanctions([{ ...base, estimate: 23, trackedTurns: [7, 9] }], [{ player: FOE, percentage: 0.6, untilTurn: 11, fromTurn: 8 }], 10);
    expect(mixed).toMatchObject({ estimate: 9, sanctioned: { applied: true } });
    // An observed figure is last turn's deploy: under the card when last turn was.
    const [obs] = applySanctions([{ ...base, source: 'observed', estimate: 9, trackedTurns: [] }], [{ player: FOE, percentage: 0.6, untilTurn: 11, fromTurn: 8 }], 9);
    expect(obs).toMatchObject({ estimate: 9, sanctioned: { carried: true } });
  });

  it('raises the figures in a game whose Sanctions percentage is negative', () => {
    const [e] = applySanctions([thin()], [{ player: FOE, percentage: -0.25, untilTurn: 10, fromTurn: 8 }], 8);
    expect(e!.thinEvidence).toMatchObject({ lower: 29, upper: 118 });
    expect(e!.sanctioned).toMatchObject({ applied: true, before: 59 });
    expect(e!.sanctioned!.after).toBeGreaterThan(59);
    const [v] = applySanctions([{ playerId: FOE, estimate: 20, card: null, source: 'visible' } as unknown as EnemyDeployEstimate], [{ player: FOE, percentage: -0.25, untilTurn: 10 }], 8);
    expect(v!.estimate).toBe(25);
  });
});

describe('Sanctions on me', () => {
  const settings = normalizeSettings({ NumberOfCardsToReceiveEachTurn: 1, SanctionsCard: { NumPieces: 4, MinimumPiecesPerTurn: 1, Weight: 1, Duration: 2, Percentage: 0.5 } });

  it('drops the Sanctions reason from the income uncertainties once the cut is modelled', () => {
    const asIs = incomeUncertainties(settings);
    const applied = incomeUncertainties(settings, { sanctionsApplied: true });
    expect(settings?.cards).toContain('Sanctions');
    expect(asIs.join(' ')).toMatch(/Sanctions/);
    expect(applied.join(' ')).not.toMatch(/Sanctions/);
    expect(deployCheckUncertainties(settings, { sanctionsApplied: true }).join(' ')).not.toMatch(/Sanctions/);
  });
});

describe("an opponent's Reinforcement card: the game's value, a clock that resets on a seen play", () => {
  const map: GameMap = {
    id: 1,
    name: 'Cardland',
    territories: [1, 2, 3, 4].map((id) => ({ id, name: `T${id}`, connectedTo: [id - 1, id + 1].filter((n) => n >= 1 && n <= 4) })),
    bonuses: [],
    distributionModes: [],
  };
  const g = buildGraph(map);
  const foe = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: FOE }, armies });
  const b = board([mine(1, 5), mine(2, 5), foe(3, 4), foe(4, 4)]);
  const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
  const est = (turn: number, clock: Parameters<typeof enemyDeployEstimates>[7] extends infer W ? W extends { reinforcement?: infer R } ? R : never : never, plays?: ReinforcementPlays) =>
    enemyDeployEstimates(g, b, ME, STD, undefined, undefined, undefined, { turn, fog: 'Foggy', reinforcement: clock, ...(plays ? { plays } : {}) }).find(
      (e) => e.playerId === FOE,
    )!;

  it('a card seen played on turn N resets the clock: none until the next can be due', () => {
    const clock = { firstTurn: 3, armies: 8, turnsPerCard: 3 };
    expect(est(6, clock).card).toEqual({ armies: 8, due: 3 });
    const seen: ReinforcementPlays = { read: [5], plays: [{ player: FOE, turn: 5 }] };
    expect(est(6, clock, seen).card).toBeNull();
    expect(est(6, clock, seen).cardSeen).toBe(true);
    expect(est(8, clock, seen).card).toEqual({ armies: 8, due: 8 });
  });

  it('reads a flat card at FixedArmies and a progressive one by its formula', () => {
    const raw = (rc: Record<string, unknown>) =>
      normalizeSettings({ NumberOfCardsToReceiveEachTurn: 1, ReinforcementCard: { NumPieces: 4, InitialPieces: 0, MinimumPiecesPerTurn: 1, Weight: 1, ...rc } });
    expect(opponentReinforcement(raw({ Mode: 0, FixedArmies: 7 }), [])).toMatchObject({ armies: 7 });
    expect(opponentReinforcement(raw({ Mode: 0, FixedArmies: 7 }), [])?.progressive).toBeUndefined();
    expect(opponentReinforcement(raw({ Mode: 1, ProgressivePercentage: 0.5 }), [])).toMatchObject({ progressive: { by: 'territories', percentage: 0.5 } });
    expect(opponentReinforcement(raw({ Mode: 'ProgressiveByTurnNumber', ProgressivePercentage: 2 }), [])).toMatchObject({ progressive: { by: 'turns', percentage: 2 } });
    // By territories: its territories in view (2) × 1.5 = 3. By turns: the turn its latest card could come (5) × 2 = 10.
    expect(est(6, { firstTurn: 3, armies: 0, turnsPerCard: 3, progressive: { by: 'territories', percentage: 1.5 } }).card).toEqual({ armies: 3, due: 3 });
    expect(est(6, { firstTurn: 3, armies: 0, turnsPerCard: 3, progressive: { by: 'turns', percentage: 2 } }).card).toEqual({ armies: 10, due: 3 });
  });

  it("check_plan's assume_enemy_cards: the clock's card on top by default, dropped for none", () => {
    const e = { playerId: FOE, estimate: 30, card: { armies: 12, due: 3 } } as unknown as EnemyDeployEstimate;
    expect(opponentDeploy(e, 'clock')).toEqual({ deploy: 30, cardBonus: 12 });
    expect(opponentDeploy(e, 'none')).toEqual({ deploy: 18, cardBonus: 12 });
    expect(opponentDeploy({ ...e, card: null }, 'clock')).toEqual({ deploy: 30 });
  });
});
