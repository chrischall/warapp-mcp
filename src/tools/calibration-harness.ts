// The #318 calibration and opening-benchmark harness over the data directory: the body of
// `scripts/calibrate.mjs`, moved here (#569) so the script and warapp_calibration's `harness: true` share it.
// It reads the end-of-game records, settings records, stored maps and cached boards (src/calibration-source.ts)
// and returns aggregates only — no game id, player id or name. No request, nothing written. The pure parts are
// src/analysis/calibrate.ts; docs/PLAN-PROFILES.md "Calibration" says what it approximates.
import { profileFormatOf } from '../analysis/opponent-profile.js';
import { trackGame } from '../analysis/opponents.js';
import { applyBonusOverrides } from '../analysis/overrides.js';
import {
  aggregateBenchmarks,
  aggregateEstimates,
  benchmarkByEra,
  estimateSamples,
  openingBenchmark,
  openingEra,
  openingFlags,
  ratioSummary,
  type Benchmark,
  type BenchmarkAggregate,
  type EraEntry,
  type RatioSummary,
} from '../analysis/calibrate.js';
import { addCalibration, type Calibration } from '../analysis/game-lessons.js';
import { calibrationSources, type SkipReason } from '../calibration-source.js';
import { holdsSeat } from '../player-states.js';
import { graphOf } from './common.js';
import { plannerSettings } from './turn.js';

export interface HarnessCounts {
  /** End-of-game records by status, plus `missing`: settings records with no record yet. */
  histories: Record<string, number>;
  skipped: Partial<Record<SkipReason, number>>;
  scored: number;
  recordOnly: number;
  benchmarked: number;
  samples: number;
}

export interface HarnessResult {
  counts: HarnessCounts;
  /** format → estimator (tracker, prior, plan) → coverage band → summary. */
  calibration: Record<string, Record<string, Record<string, RatioSummary | null>>>;
  benchmark: Record<string, BenchmarkAggregate>;
  byEra: ReturnType<typeof benchmarkByEra>;
}

/** What the opening benchmark approximates: printed by the script and reported by the tool. */
export const HARNESS_APPROXIMATIONS = [
  'Opening benchmark approximations: the planner sees the whole board (no fog); opponents never attack me —',
  'they hold the land and armies the history shows, except land I hold in the replay; card plays are left out;',
  'with luck or weighted rounding a battle is resolved at its expectation (counted as inexact).',
  'Eras (#503): pre-tool = never planned by this server, or no local cache names the game; pre-rule-4f = turn 1',
  'before 2026-11-13 08:24Z by its turn-1 time where known, else game id below 45690000 (ids are assigned at creation,',
  'so the id boundary approximates the time); current = the rest. A game with a turn with no orders of mine (read off',
  'the history boards: no capture, no failed attack, no orders cached; army growth alone is not orders) or a boot of my seat in turns',
  '1-4 is reported apart, never averaged in.',
];

/** Run the harness over `dir`. `turns`: the opening benchmark's length (default the module's). Never requests. */
export async function calibrationHarness(dir: string, opts: { turns?: number } = {}): Promise<HarnessResult> {
  const src = await calibrationSources(dir);
  const counts: HarnessCounts = { histories: src.statuses, skipped: src.skipped, scored: 0, recordOnly: 0, benchmarked: 0, samples: 0 };
  const byFormat: Record<string, Record<string, Calibration>> = {};
  const benchByFormat: Record<string, Benchmark[]> = {};
  const eraEntries: EraEntry[] = [];
  for (const input of src.inputs) {
    const { history: h, settings, map, cached } = input;
    if (input.source === 'record-only') counts.recordOnly++;
    const me = h.me;
    const graph = graphOf(applyBonusOverrides(map, settings));
    const seated = h.players.filter((p) => holdsSeat(p.state));
    const format = profileFormatOf(seated);
    const mine = seated.find((p) => p.id === me);
    const myTeam = typeof mine?.team === 'number' && mine.team >= 0 ? mine.team : undefined;
    const opponents = seated.filter((p) => p.id !== me && (myTeam === undefined || p.team !== myTeam)).map((p) => p.id);
    const asPlaying = seated.map(({ state: _s, ...p }) => p);
    const ps = plannerSettings(settings);
    const samples = estimateSamples({
      graph,
      me,
      cached,
      history: h.boards,
      plannerSettings: ps,
      incomeSettings: settings,
      settings,
      game: trackGame(asPlaying, settings, map),
      players: asPlaying,
      opponents,
    });
    counts.samples += samples.length;
    if (samples.length) counts.scored++;
    const agg = aggregateEstimates(samples);
    const f = (byFormat[format] ??= {});
    for (const [k, c] of Object.entries(agg)) f[k] = addCalibration(f[k] ?? {}, c);
    const bench = openingBenchmark({
      graph,
      me,
      history: h.boards,
      plannerSettings: ps,
      incomeSettings: settings,
      players: asPlaying,
      winners: seated.filter((p) => p.state === 'Won').map((p) => p.id),
      ...(opts.turns ? { turns: opts.turns } : {}),
    });
    if (bench.turns.length) {
      counts.benchmarked++;
      (benchByFormat[format] ??= []).push(bench);
      // #503: the era (turn-1 time where known — no record keeps one yet — else the game id) and the
      // opening window's flags (turns with no orders of mine, a boot of my seat).
      const o = input.opening;
      const { era, basis } = openingEra({ planned: o.planned, ...(o.gameId !== undefined ? { gameId: o.gameId } : {}) });
      const flags = openingFlags({
        me,
        history: h.boards,
        sentTurns: o.sentTurns,
        failedAttackTurns: o.failedAttackTurns,
        booted: { turn: o.bootedTurn },
      });
      eraEntries.push({ era, basis, format, territories: graph.territoryById.size, flags, bench });
    }
  }
  const calibration: HarnessResult['calibration'] = {};
  for (const [format, ests] of Object.entries(byFormat))
    for (const [k, c] of Object.entries(ests))
      for (const [band, stats] of Object.entries(c)) ((calibration[format] ??= {})[k] ??= {})[band] = ratioSummary(stats);
  const benchmark: Record<string, BenchmarkAggregate> = {};
  for (const [format, list] of Object.entries(benchByFormat)) benchmark[format] = aggregateBenchmarks(list);
  benchmark.all = aggregateBenchmarks(Object.values(benchByFormat).flat());
  return { counts, calibration, benchmark, byEra: benchmarkByEra(eraEntries) };
}
