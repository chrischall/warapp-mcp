// #412 task 4: replaying the decision log offline — each logged turn's planner input rebuilt and planned
// again (optionally under a scenario), compared with the logged decision and scored against what
// happened, plus the estimate accuracy against the end-of-game truth. Synthetic map, ids and boards only.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accuracyReport,
  applyScenario,
  decisionFixtures,
  replayAggregate,
  replayDecisions,
} from '../../src/analysis/decision-replay.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput } from '../../src/analysis/planner.js';
import type { BoardState } from '../../src/board.js';
import { readDecisionLog, recordDecision, recordOutcome, updateDecisionLog, type DecisionLog } from '../../src/decision-log.js';
import type { GameMap, GameSettings } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const GAME = 9001;

// My T1 beside the neutral T2, the foe's T3 and the neutral T4; bonus 100 = {1, 2} worth 3.
const MAP: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2, 3, 4] },
    { id: 2, name: 'T2', connectedTo: [1] },
    { id: 3, name: 'T3', connectedTo: [1] },
    { id: 4, name: 'T4', connectedTo: [1] },
  ],
  bonuses: [{ id: 100, name: 'B', value: 3, territoryIds: [1, 2], bonusIds: [] }],
  distributionModes: [],
};
const SETTINGS = { mapId: 1 } as unknown as GameSettings;
const replay = { map: MAP, settings: SETTINGS };

const boardOn = (turn: number): BoardState => board([mine(1, 18 + turn), neutral(2, 2), mine(3, 3, FOE), neutral(4, 2)]);
const inputOn = (turn: number, extra: Partial<PlanInput> = {}): PlanInput => ({
  graph: buildGraph(MAP),
  board: boardOn(turn),
  me: ME,
  income: 5,
  turn,
  settings: { offensiveKillRate: 60, defensiveKillRate: 70 },
  game: { players: [{ id: ME }, { id: FOE }], turn },
  ...extra,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'warapp-replay-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function logTurns(turns: number[], extra: (turn: number) => Partial<PlanInput> = () => ({})): Promise<DecisionLog> {
  for (const turn of turns) {
    const input = inputOn(turn, extra(turn));
    const plan = planTurn(input);
    await recordDecision(dir, GAME, ME, { turn, board: input.board, input, plan, outlookState: 'even', estimates: [] }, { mode: 'on' });
  }
  return (await readDecisionLog(dir, GAME))!;
}

describe('decision replay (#412 task 4)', () => {
  it('INVARIANT: a logged turn replayed with unchanged code and no scenario gives the logged deploys and moves', async () => {
    const log = await logTurns([1, 2, 3], (t) => (t === 2 ? { options: { avoid: { territories: [2] } } } : {}));
    const r = replayDecisions(log, replay);
    expect(r.turns).toHaveLength(3);
    for (const t of r.turns) {
      expect(t.status).toBe('compared');
      expect(t.same).toBe(true);
      expect(t.goal.replayed).toBe(t.goal.logged);
      expect(t.nextIncome.replayed).toBe(t.nextIncome.logged);
    }
    expect(replayAggregate([r])).toMatchObject({ games: 1, turns: 3, compared: 3, identical: 3, identicalShare: 1 });
  });

  it('a scenario goal or enemy deploy changes the plan and is reported against the logged goal', async () => {
    const log = await logTurns([1, 2]);
    const r = replayDecisions(log, replay, { goal: 'defend', enemyDeploy: 40 });
    for (const t of r.turns) {
      expect(t.goal.replayed).toBe('defend');
      expect(t.same).toBe(false);
    }
    const agg = replayAggregate([r]);
    expect(agg.identical).toBe(0);
    expect(agg.byGoal[r.turns[0]!.goal.logged]).toMatchObject({ compared: 2, different: 2 });
  });

  it('applyScenario patches goal, enemy deploy, estimate overrides and planner options/settings without touching the logged input', () => {
    const base = inputOn(3, { options: { reserve: 1 }, knownIncome: [{ player: 30, income: 4 }] });
    const out = applyScenario(base, {
      goal: 'expand',
      enemyDeploy: 7,
      estimates: [{ player: FOE, income: 12 }],
      options: { jabs: true },
      settings: { defensiveKillRate: 80 },
    });
    expect(out.options).toMatchObject({ reserve: 1, goal: 'expand', enemyDeploy: 7, jabs: true });
    expect(out.knownIncome).toEqual([
      { player: 30, income: 4 },
      { player: FOE, income: 12 },
    ]);
    expect(out.settings).toMatchObject({ offensiveKillRate: 60, defensiveKillRate: 80 });
    expect(base.options).toEqual({ reserve: 1 });
    expect(applyScenario(base, undefined)).toBe(base);
  });

  it('scores the logged expectation and the new plan’s captures against what happened next', async () => {
    let log = await logTurns([1]);
    const decided = log.turns['1']!.decision!;
    const captures = decided.expected.captures;
    expect(captures.length).toBeGreaterThan(0);
    await recordOutcome(dir, GAME, ME, 1, {
      income: decided.expected.nextIncome - 1,
      gained: [captures[0]!],
      lost: [],
      capturesMade: [captures[0]!],
      capturesMissed: captures.slice(1),
      bonusesHeld: [],
      eliminated: false,
    }, { mode: 'on' });
    log = (await readDecisionLog(dir, GAME))!;
    const t = replayDecisions(log, replay).turns[0]!;
    expect(t.score).toMatchObject({ incomeHeld: false, capturesHeld: captures.length === 1 });
    expect(t.score!.replayedCaptures.backed).toContain(captures[0]);
    expect(replayAggregate([replayDecisions(log, replay)]).expectations).toMatchObject({ scored: 1, incomeHeld: 0 });
  });

  it('a turn without its replay input or board is listed, never planned', async () => {
    const log = await logTurns([1, 2]);
    const { input: _drop, ...rest } = log.turns['2']!;
    const compacted: DecisionLog = { ...log, turns: { ...log.turns, '2': rest, '5': { kind: 'observed', source: 'live' } } };
    const r = replayDecisions(compacted, replay);
    expect(r.turns.map((t) => [t.turn, t.status])).toEqual([
      [1, 'compared'],
      [2, 'no-input'],
    ]);
    expect(replayDecisions(log, { map: undefined, settings: SETTINGS }).turns.every((t) => t.status === 'no-map')).toBe(true);
  });

  it('accuracy: logged estimates against the truth by coverage band and source, and a scenario’s estimates against the same truth', async () => {
    await logTurns([2]);
    await updateDecisionLog(
      dir,
      GAME,
      ME,
      (l) => {
        const e = l.turns['2']!;
        return {
          ...l,
          turns: {
            ...l.turns,
            '2': {
              ...e,
              truth: { board: 1, mine: { income: 5, armies: 20, territories: 1 }, opponents: [{ player: FOE, income: 8, armies: 3, territories: 1, bonuses: [], hidden: [] }] },
              accuracy: {
                estimates: [{ player: FOE, estimate: 4, truth: 8, ratio: 0.5, source: 'visible', coverage: 0.3, thin: false }],
                outlook: { logged: 'even', truth: 'winning', right: false },
                myIncome: 5,
                hiddenStacks: 0,
              },
            },
          },
        };
      },
      { mode: 'on' },
    );
    const log = (await readDecisionLog(dir, GAME))!;
    const plain = accuracyReport([{ log, replay: replayDecisions(log, replay) }]);
    expect(plain.logged.estimates).toMatchObject({ n: 1, mean: 0.5 });
    expect(plain.logged.byCoverage['25-50']).toMatchObject({ n: 1 });
    expect(plain.logged.bySource.visible).toMatchObject({ n: 1 });
    expect(plain.logged.outlook).toEqual({ right: 0, wrong: 1 });
    // Under a scenario that sets the foe's income, its estimate is that figure: 16 ÷ 8 = 2.
    const scen = replayDecisions(log, replay, { estimates: [{ player: FOE, income: 16 }] });
    const r = accuracyReport([{ log, replay: scen }]);
    expect(r.scenario?.estimates).toMatchObject({ n: 1, mean: 2 });
    expect(r.games).toBe(1);
  });

  it('fixtures: each interesting turn as a standalone, name-free JSON (full board, input, decision, next)', async () => {
    const log = await logTurns([1, 2, 3, 4, 5]);
    const fx = decisionFixtures(log, replay);
    // The first three decided turns are interesting (Task 3's rule); 4 and 5 are not.
    expect(fx.map((f) => f.turn)).toEqual([1, 2, 3]);
    const f = fx[0]!;
    expect(f.board.territories).toHaveLength(4);
    expect(f.input).toBeDefined();
    expect(f.decision.deploys).toEqual(log.turns['1']!.decision!.deploys);
    expect(f.mapId).toBe(1);
    expect(JSON.parse(JSON.stringify(f))).toEqual(f);
  });
});
