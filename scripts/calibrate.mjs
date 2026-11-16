#!/usr/bin/env node
// The calibration and opening benchmark harness (#318): a LOCAL dev script, never a tool, never run in
// CI. It reads the built code (`npm run build` first: tsc emits dist/**) and the data directory, and
// prints aggregates only — no game id, player id or name. docs/PLAN-PROFILES.md "Calibration" says how
// to run it and what it approximates; the pure parts are src/analysis/calibrate.ts.
//
//   node scripts/calibrate.mjs [--data-dir <dir>] [--turns <n>] [--json]
//   node scripts/calibrate.mjs --fetch [--data-dir <dir>]   # owner only: reads war.app
//
// Truth is each finished game's history, as the end-of-game pass (#312 E1, src/tools/end-of-game.ts) kept
// it: the record `<dataDir>/finished/<hmac>.json` holds the history's boards with owners by `playerKey`
// (src/finished-store.ts). The harness keeps no store of its own and never reads a history itself: it
// matches each record's keys against the ids of the game's settings record (`historyOfRecord`, a key is
// never reversed). So the one history read per finished game (owner decision P2) feeds the profiles, the
// lessons and this harness alike, under the one bound and the one name-free store (P4).
// `--fetch` only runs that pass (`fetchFinished`) on the games of `<dataDir>/games` with no record yet:
// one GameFeed read without the history (is it finished?), then the pass's single history read; a game
// with a record of any status costs nothing. It needs WARAPP_EMAIL / WARAPP_API_TOKEN (or the env file);
// agents and tests never run it. With WARAPP_PLAYER_PROFILE=off nothing is read or written, and the
// measurement reads nothing either. Until a pass has run (the warapp_my_games sweep, warapp_get_game on a
// finished game, or `--fetch`) there is no truth and the harness has no number to give: it says so.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url);
const dist = (p) => import(new URL(`dist/${p}`, root).href);

function parseArgs(argv) {
  const out = { fetch: false, json: false, turns: undefined, dataDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fetch') out.fetch = true;
    else if (a === '--json') out.json = true;
    else if (a === '--turns') out.turns = Number(argv[++i]);
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

async function gameIds(dir) {
  const names = await readdir(join(dir, 'games')).catch(() => []);
  return names
    .filter((n) => /^\d+\.json$/.test(n))
    .map((n) => Number(n.slice(0, -5)))
    .sort((a, b) => a - b);
}

// ---- --fetch (owner only): the end-of-game pass, nothing else ----

async function fetchHistories(dir) {
  const { loadDotenvSafely } = await import('@chrischall/mcp-utils');
  const { envFilePath } = await dist('config.js');
  await loadDotenvSafely({ path: envFilePath() });
  const { WarappClient } = await dist('client.js');
  const { readCachedPlayer } = await dist('trend.js');
  const { fetchFinished } = await dist('tools/end-of-game.js');
  const client = new WarappClient({ env: process.env, dataDir: () => dir });
  const games = [];
  let noAccount = 0;
  for (const gameId of await gameIds(dir)) {
    const me = await readCachedPlayer(dir, gameId);
    if (me === undefined) noAccount++;
    else games.push({ gameId, me });
  }
  const tally = await fetchFinished({ client, dataDir: dir, env: process.env }, games);
  return noAccount ? { ...tally, 'no-cached-account': noAccount } : tally;
}

/** The kept history of `id` with its ids put back, or why there is none (a status to count). */
async function historyOf(dir, id, salt, replay) {
  const { finishedPath, readFinishedRecord, historyOfRecord } = await dist('finished-store.js');
  if (replay?.playerId === undefined) return 'no-cached-account';
  if (!salt) return 'missing';
  const rec = await readFinishedRecord(finishedPath(dir, salt, replay.playerId, id));
  if (typeof rec === 'string') return rec;
  if (rec.status !== 'captured') return rec.status;
  const h = historyOfRecord(rec, salt, [replay.playerId, ...replay.game.players.map((p) => p.id)]);
  return typeof h === 'string' ? (h === 'no-boards' ? 'captured-without-boards' : h) : h;
}

// ---- the measurement ----

export async function calibrate(dir, opts = {}) {
  const { loadReplay } = await dist('replay.js');
  const { mapOf } = await dist('tools/map.js');
  const { graphOf } = await dist('tools/common.js');
  const { plannerSettings } = await dist('tools/turn.js');
  const { trackGame } = await dist('analysis/opponents.js');
  const { profileFormatOf } = await dist('analysis/opponent-profile.js');
  const { addCalibration } = await dist('analysis/game-lessons.js');
  const cal = await dist('analysis/calibrate.js');
  const { holdsSeat } = await dist('player-states.js');
  const { playerRecordSalt } = await dist('player-record-store.js');
  const salt = await playerRecordSalt(dir).catch(() => undefined);

  const counts = { gamesWithSettings: 0, histories: {}, scored: 0, noMap: 0, benchmarked: 0, samples: 0 };
  const byFormat = {};
  const benchByFormat = {};
  for (const id of await gameIds(dir)) {
    counts.gamesWithSettings++;
    const replay = await loadReplay(dir, id);
    const h = await historyOf(dir, id, salt, replay);
    const status = typeof h === 'string' ? h : 'captured';
    counts.histories[status] = (counts.histories[status] ?? 0) + 1;
    if (typeof h === 'string') continue;
    if (!replay.map) {
      counts.noMap++;
      continue;
    }
    const me = h.me;
    const graph = graphOf(mapOf(replay.game));
    const settings = replay.settings;
    const seated = h.players.filter((p) => holdsSeat(p.state));
    const format = profileFormatOf(seated);
    const mine = seated.find((p) => p.id === me);
    const myTeam = typeof mine?.team === 'number' && mine.team >= 0 ? mine.team : undefined;
    const opponents = seated.filter((p) => p.id !== me && (myTeam === undefined || p.team !== myTeam)).map((p) => p.id);
    const asPlaying = seated.map(({ state: _s, ...p }) => p);
    const ps = plannerSettings(settings);
    const cached = replay.playerId === me ? replay.boards.map((b) => ({ ...b, ...(replay.orders.get(b.turn) ? { orders: replay.orders.get(b.turn) } : {}) })) : [];
    const samples = cal.estimateSamples({
      graph,
      me,
      cached,
      history: h.boards,
      plannerSettings: ps,
      incomeSettings: settings,
      settings,
      game: trackGame(asPlaying, settings, replay.map),
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
  '(the warapp_my_games sweep, warapp_get_game on a finished game, or `--fetch`, which reads war.app: owner only).',
];

function print(r) {
  const out = [];
  if (r.off) return 'Profiling is off (WARAPP_PLAYER_PROFILE=off): nothing read.';
  out.push(`Games with settings: ${r.counts.gamesWithSettings}; histories: ${JSON.stringify(r.counts.histories)}`);
  out.push(`Scored: ${r.counts.scored} games, ${r.counts.samples} opponent-turns; benchmarked: ${r.counts.benchmarked}; no map: ${r.counts.noMap}`);
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
  out.push('', ...APPROX);
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
  if (args.fetch) console.log(`fetch: ${JSON.stringify(await fetchHistories(dir))}`);
  const r = await calibrate(dir, args);
  console.log(args.json ? JSON.stringify(r, null, 2) : print(r));
}
