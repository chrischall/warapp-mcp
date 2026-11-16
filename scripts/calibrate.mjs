#!/usr/bin/env node
// The calibration and opening benchmark harness (#318): a LOCAL dev script, never a tool, never run in
// CI. It reads the built code (`npm run build` first: tsc emits dist/**) and the data directory, and
// prints aggregates only — no game id, player id or name. docs/PLAN-PROFILES.md "Calibration" says how
// to run it and what it approximates; the pure parts are src/analysis/calibrate.ts.
//
//   node scripts/calibrate.mjs [--data-dir <dir>] [--turns <n>] [--json]
//   node scripts/calibrate.mjs --fetch [--data-dir <dir>]   # owner only: reads war.app
//
// Truth is each finished game's history: the full board after every turn. It is read from
// `<dataDir>/calibrate/histories/<gameId>.json`, which only `--fetch` writes: for every game with a
// settings record (`<dataDir>/games`, the games this server planned), one GameFeed read without the
// history to see whether it is finished, then — for a finished game the cached account played — the
// history ONCE (owner decision P2; the file, whatever its status, is the mark: a game with one is never
// read again). The file holds the decoded boards by id (as the board cache does), the seats' final
// states and the turns; 0600, atomic, one per game with a settings record. A file that does not parse
// is never overwritten. `--fetch` needs WARAPP_EMAIL / WARAPP_API_TOKEN (or the env file); agents and
// tests never run it.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url);
const dist = (p) => import(new URL(`dist/${p}`, root).href);

const VERSION = 1;
const STATUSES = new Set(['captured', 'unreadable', 'not-a-player', 'request-failed']);

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

export const historyPath = (dir, gameId) => join(dir, 'calibrate', 'histories', `${gameId}.json`);

/** The history file: `missing`, `unreadable` (never overwritten), or its body. */
export async function readHistoryFile(dir, gameId) {
  let text;
  try {
    text = await readFile(historyPath(dir, gameId), 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && v.version === VERSION && STATUSES.has(v.status) ? v : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

async function gameIds(dir) {
  const names = await readdir(join(dir, 'games')).catch(() => []);
  return names
    .filter((n) => /^\d+\.json$/.test(n))
    .map((n) => Number(n.slice(0, -5)))
    .sort((a, b) => a - b);
}

// ---- --fetch (owner only) ----

async function fetchHistories(dir) {
  const { loadDotenvSafely } = await import('@chrischall/mcp-utils');
  const { envFilePath } = await dist('config.js');
  await loadDotenvSafely({ path: envFilePath() });
  const { WarappClient } = await dist('client.js');
  const { historyBoards, historyReport, readCachedPlayer } = await dist('trend.js');
  const { writeJsonAtomic } = await dist('map-store.js');
  const { holdsSeat } = await dist('player-states.js');
  const client = new WarappClient({ env: process.env, dataDir: () => dir });
  const tally = {};
  const count = (k) => {
    tally[k] = (tally[k] ?? 0) + 1;
  };
  for (const id of await gameIds(dir)) {
    if ((await readHistoryFile(dir, id)) !== 'missing') {
      count('already-kept');
      continue;
    }
    const me = await readCachedPlayer(dir, id);
    if (me === undefined) {
      count('no-cached-account');
      continue;
    }
    let shown;
    try {
      shown = await client.getGame(id, { map: false });
    } catch {
      count('state-read-failed');
      continue;
    }
    if (shown.state !== 'Finished') {
      count('not-finished');
      continue;
    }
    const write = (body) => writeJsonAtomic(historyPath(dir, id), join(dir, 'calibrate', 'histories'), { version: VERSION, ...body });
    if (!shown.players.some((p) => p.id === me && holdsSeat(p.state))) {
      await write({ status: 'not-a-player' });
      count('not-a-player');
      continue;
    }
    // The one history read (P2): whatever comes of it is kept, so it is never asked again.
    let game;
    try {
      game = await client.getGame(id, { history: true, settings: true });
    } catch {
      await write({ status: 'request-failed' });
      count('request-failed');
      continue;
    }
    const report = historyReport(game);
    if ('unreadable' in report) {
      await write({ status: 'unreadable', reason: report.unreadable.reason });
      count('unreadable');
      continue;
    }
    const boards = historyBoards(game.history, game.players, game.numberOfTurns !== undefined ? { numberOfTurns: game.numberOfTurns } : {});
    await write({
      status: 'captured',
      me,
      numberOfTurns: game.numberOfTurns ?? null,
      players: game.players.map((p) => ({
        id: p.id,
        ...(p.state !== undefined ? { state: p.state } : {}),
        ...(p.team !== undefined ? { team: p.team } : {}),
        ...(p.isAI ? { isAI: true } : {}),
      })),
      boards,
    });
    count('captured');
  }
  return tally;
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

  const counts = { gamesWithSettings: 0, histories: {}, scored: 0, noMap: 0, benchmarked: 0, samples: 0 };
  const byFormat = {};
  const benchByFormat = {};
  for (const id of await gameIds(dir)) {
    counts.gamesWithSettings++;
    const h = await readHistoryFile(dir, id);
    const status = typeof h === 'string' ? h : h.status;
    counts.histories[status] = (counts.histories[status] ?? 0) + 1;
    if (typeof h === 'string' || h.status !== 'captured') continue;
    const replay = await loadReplay(dir, id);
    if (!replay?.map) {
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

function print(r) {
  const out = [];
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
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const { dataDir } = await dist('config.js');
  const dir = args.dataDir ?? dataDir(process.env);
  if (args.fetch) console.log(`fetch: ${JSON.stringify(await fetchHistories(dir))}`);
  const r = await calibrate(dir, args);
  console.log(args.json ? JSON.stringify(r, null, 2) : print(r));
}
