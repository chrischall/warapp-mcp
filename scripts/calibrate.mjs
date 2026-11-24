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

// The body lives in src/tools/calibration-harness.ts (#569), shared with warapp_calibration's `harness: true`.
export async function calibrate(dir, opts = {}) {
  const { calibrationHarness } = await dist('tools/calibration-harness.js');
  return calibrationHarness(dir, opts);
}

const { HARNESS_APPROXIMATIONS: APPROX } = await dist('tools/calibration-harness.js');

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
  out.push('', '(b) opening benchmark by era: income after N turns, replayed / real / winner as mean (median), n = games per figure;');
  out.push('    games where the replay was ahead / behind. Era read from: ' + JSON.stringify(r.byEra.basis));
  const bench = (label, b, pad) => {
    out.push(`${pad}${label}: ${b.games} games (${b.inexact} inexact)`);
    for (const t of b.byTurn)
      out.push(
        `${pad}  after ${t.afterTurn}: n=${t.n} replay=${t.replay} (${t.median.replay}) real=${t.real} (${t.median.real}) winner=${t.winner ?? '-'} (${t.median.winner ?? '-'}, n=${t.winners}) ahead=${t.replayAhead} behind=${t.replayBehind}`,
      );
    if (b.games)
      out.push(`${pad}  after turn 4: land without bonuses replay=${b.landWithoutBonuses.replay} real=${b.landWithoutBonuses.real}; an opponent at 1.5x my income replay=${b.outpaced.replay} real=${b.outpaced.real}`);
  };
  for (const [era, e] of Object.entries(r.byEra.eras)) {
    out.push(`  ${era}:`);
    bench('all formats', e.all, '    ');
    if (Object.keys(e.byFormat).length > 1) for (const [format, b] of Object.entries(e.byFormat)) bench(format, b, '    ');
    if (e.largeMaps) out.push(`    ${e.largeMaps} of these on a map 5x the median map's territories or more (kept in: read the medians)`);
    const f = e.flagged;
    out.push(`    apart: ${f.games} game(s) with turns 1-4 flagged (${f.noOrderTurns} turn(s) with no orders, ${f.boots} boot(s))`);
    if (f.benchmark) bench('flagged', f.benchmark, '      ');
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
