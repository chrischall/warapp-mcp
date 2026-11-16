#!/usr/bin/env node
// The calibration and opening benchmark harness (#318): a LOCAL dev script, never a tool, never run in
// CI. It reads the built code (`npm run build` first: tsc emits dist/**) and the data directory, and
// prints aggregates only — no game id, player id or name. docs/PLAN-PROFILES.md "Calibration" says how
// to run it and what it approximates; the pure parts are src/analysis/calibrate.ts.
//
//   node scripts/calibrate.mjs [--data-dir <dir>] [--turns <n>] [--json]
//
// It makes NO request: truth is each finished game's history as the end-of-game pass (#312 E1,
// src/tools/end-of-game.ts) kept it, the record `<dataDir>/finished/<hmac>.json` with the history's boards
// (owners by `playerKey`; src/finished-store.ts). The records are what it reads (`calibrationSources`,
// src/calibration-source.ts): one matched to its game's settings record gets the ids back by key and my
// cached boards; one whose settings record aged out is read on its own (its own settings, the stored map,
// players by position, no cached boards: the opening benchmark only). So the one history read per finished
// game (owner decision P2) feeds the profiles, the lessons and this harness alike (P4). The data comes from
// the normal end-of-game pass (the warapp_my_games sweep, warapp_get_game, warapp_wait_for_turn's read or a
// game-ended notification in warapp_get_notifications): run those, then this. Until one has run there is
// no truth and the harness has no number to give: it says so. With WARAPP_PLAYER_PROFILE=off it reads nothing.
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url);
const dist = (p) => import(new URL(`dist/${p}`, root).href);

function parseArgs(argv) {
  const out = { json: false, turns: undefined, dataDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--turns') out.turns = Number(argv[++i]);
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

// ---- the measurement ----

export async function calibrate(dir, opts = {}) {
  const { calibrationSources } = await dist('calibration-source.js');
  const { applyBonusOverrides } = await dist('analysis/overrides.js');
  const { graphOf } = await dist('tools/common.js');
  const { plannerSettings } = await dist('tools/turn.js');
  const { trackGame } = await dist('analysis/opponents.js');
  const { profileFormatOf } = await dist('analysis/opponent-profile.js');
  const { addCalibration } = await dist('analysis/game-lessons.js');
  const cal = await dist('analysis/calibrate.js');
  const { holdsSeat } = await dist('player-states.js');

  const src = await calibrationSources(dir);
  const counts = { histories: src.statuses, skipped: src.skipped, scored: 0, recordOnly: 0, benchmarked: 0, samples: 0 };
  const byFormat = {};
  const benchByFormat = {};
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
    const samples = cal.estimateSamples({
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
    const agg = cal.aggregateEstimates(samples);
    const f = (byFormat[format] ??= {});
    for (const [k, c] of Object.entries(agg)) f[k] = addCalibration(f[k] ?? {}, c);
    const bench = cal.openingBenchmark({
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
    }
  }
  const calibration = {};
  for (const [format, ests] of Object.entries(byFormat))
    for (const [k, c] of Object.entries(ests))
      for (const [band, stats] of Object.entries(c)) ((calibration[format] ??= {})[k] ??= {})[band] = cal.ratioSummary(stats);
  const benchmark = {};
  for (const [format, list] of Object.entries(benchByFormat)) benchmark[format] = cal.aggregateBenchmarks(list);
  benchmark.all = cal.aggregateBenchmarks(Object.values(benchByFormat).flat());
  return { counts, calibration, benchmark };
}

const APPROX = [
  'Opening benchmark approximations: the planner sees the whole board (no fog); opponents never attack me —',
  'they hold the land and armies the history shows, except land I hold in the replay; card plays are left out;',
  'with luck or weighted rounding a battle is resolved at its expectation (counted as inexact).',
];

const NO_TRUTH = [
  'No finished game\'s history is kept yet, so there is nothing to score: the end-of-game pass has to run first',
  '(the warapp_my_games sweep, warapp_get_game on a finished game, warapp_wait_for_turn, or a game-ended notification',
  'in warapp_get_notifications: one history read per game). This harness never reads war.app.',
];

const SKIP_WHY = {
  'no-settings': 'the record keeps no settings shape',
  'no-map': 'its map is no longer in the map store',
  'captured-without-boards': 'the record kept no history boards',
};

/** What was left out of the scores, and why: printed with the approximations. */
function skippedLines(c) {
  const out = [];
  for (const [reason, n] of Object.entries(c.skipped)) out.push(`Skipped ${n} captured record(s): ${SKIP_WHY[reason] ?? reason}.`);
  const failed = Object.entries(c.histories).filter(([k]) => k !== 'captured' && k !== 'missing');
  for (const [status, n] of failed) out.push(`Skipped ${n} record(s) with status ${status}: the pass kept no history for them (never re-read).`);
  if (c.histories.missing) out.push(`Skipped ${c.histories.missing} game(s) with a settings record but no end-of-game record yet: their pass has not run.`);
  if (c.recordOnly)
    out.push(
      `${c.recordOnly} record(s) whose settings record aged out were read on their own (their own settings, players by position):`,
      'the opening benchmark only — the calibration (a) needs the boards cached while the game was played, found by game id, which the record does not hold.',
    );
  return out;
}

function print(r) {
  const out = [];
  if (r.off) return 'Profiling is off (WARAPP_PLAYER_PROFILE=off): nothing read.';
  out.push(`End-of-game records: ${JSON.stringify(r.counts.histories)}`);
  out.push(`Scored: ${r.counts.scored} games, ${r.counts.samples} opponent-turns; benchmarked: ${r.counts.benchmarked} (${r.counts.recordOnly} read from the record alone)`);
  out.push('', '(a) estimate ÷ truth, by format, estimator and coverage band: n, mean, geometric mean, sd, share < 0.5, share > 1.5');
  for (const [format, ests] of Object.entries(r.calibration))
    for (const [k, bands] of Object.entries(ests))
      for (const [band, s] of Object.entries(bands))
        if (s) out.push(`  ${format.padEnd(5)} ${k.padEnd(8)} ${band.padEnd(9)} n=${s.n} mean=${s.mean} geo=${s.geoMean} sd=${s.sd} low=${s.under} high=${s.over}`);
  out.push('', '(b) opening benchmark: mean income after N turns, replayed / real / winner; games where the replay was ahead / behind');
  for (const [format, b] of Object.entries(r.benchmark)) {
    out.push(`  ${format}: ${b.games} games (${b.inexact} inexact)`);
    for (const t of b.byTurn) out.push(`    after ${t.afterTurn}: n=${t.n} replay=${t.replay} real=${t.real} winner=${t.winner ?? '-'} ahead=${t.replayAhead} behind=${t.replayBehind}`);
    out.push(`    after turn 4: land without bonuses replay=${b.landWithoutBonuses.replay} real=${b.landWithoutBonuses.real}; an opponent at 1.5x my income replay=${b.outpaced.replay} real=${b.outpaced.real}`);
  }
  out.push('', ...APPROX, ...skippedLines(r.counts));
  if (!r.counts.histories.captured) out.push('', ...NO_TRUTH);
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const { dataDir } = await dist('config.js');
  const dir = args.dataDir ?? dataDir(process.env);
  const { profileEnabled } = await dist('profile-store.js');
  if (!profileEnabled(process.env)) {
    console.log(args.json ? JSON.stringify({ off: true }) : print({ off: true }));
    process.exit(0);
  }
  const r = await calibrate(dir, args);
  console.log(args.json ? JSON.stringify(r, null, 2) : print(r));
}
