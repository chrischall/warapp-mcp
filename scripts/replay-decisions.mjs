#!/usr/bin/env node
// The decision-log replay (#412 task 4): a LOCAL dev script, never a tool, never run in CI. It reads the
// built code (`npm run build` first: tsc emits dist/**) and the data directory: each game's decision log
// (`<dataDir>/decisions/<gameId>.json`), its settings record and the stored map (`loadReplay`,
// src/replay.ts). Every logged turn that still keeps its replay input is planned again — under a scenario
// when given — and compared with the logged decision and what happened next; the end-of-game truth gives
// the estimate accuracy. It makes NO request. The pure parts are src/analysis/decision-replay.ts.
//
//   node scripts/replay-decisions.mjs [--data-dir <dir>] [--game <id>] [--goal <goal>] [--enemy-deploy <n>]
//     [--scenario <json file>] [--json] [--accuracy] [--export-fixtures <dir>]
//
// By default it prints aggregates only (no game id, player id or name); `--json` adds per-turn detail.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url);
const dist = (p) => import(new URL(`dist/${p}`, root).href);

const HELP = `Usage: node scripts/replay-decisions.mjs [options]   (run \`npm run build\` first)

Replays the decision log (#412) offline: every logged turn that keeps its replay input is planned again
and compared with the logged decision and what happened next. No request is made.

  --data-dir <dir>         the data directory (default: the server's, MCP_DATA_DIR or ~/.config/warapp-mcp)
  --game <id>              one game only (default: every game with a decision log)
  --goal <goal>            scenario: plan every turn for this goal (balanced, expand, complete-bonus, defend, siege)
  --enemy-deploy <n>       scenario: size every threat for this enemy deploy
  --scenario <file>        scenario: a JSON file { goal?, enemyDeploy?, estimates?: [{ player, income }],
                           options?: {...PlanOptions}, settings?: {...PlannerSettings} }; --goal/--enemy-deploy win
  --json                   print everything as JSON, per-turn detail included
  --accuracy               print only the estimate accuracy against the end-of-game truth
  --export-fixtures <dir>  write each interesting turn as a standalone, name-free JSON fixture there
  --help                   this text`;

function parseArgs(argv) {
  const out = { json: false, accuracy: false, help: false };
  const value = (i) => {
    const v = argv[i];
    if (v === undefined) throw new Error(`${argv[i - 1]} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--accuracy') out.accuracy = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--data-dir') out.dataDir = value(++i);
    else if (a === '--game') out.game = Number(value(++i));
    else if (a === '--goal') out.goal = value(++i);
    else if (a === '--enemy-deploy') out.enemyDeploy = Number(value(++i));
    else if (a === '--scenario') out.scenarioFile = value(++i);
    else if (a === '--export-fixtures') out.fixtures = value(++i);
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.game !== undefined && !Number.isSafeInteger(out.game)) throw new Error('--game takes a game id');
  if (out.enemyDeploy !== undefined && !Number.isFinite(out.enemyDeploy)) throw new Error('--enemy-deploy takes a number');
  if (out.goal !== undefined && !GOALS.includes(out.goal)) throw new Error(`--goal takes one of ${GOALS.join(', ')}`);
  return out;
}

const GOALS = ['balanced', 'expand', 'complete-bonus', 'defend', 'siege'];

async function scenarioOf(args) {
  const s = args.scenarioFile ? JSON.parse(await readFile(args.scenarioFile, 'utf8')) : {};
  if (args.goal !== undefined) s.goal = args.goal;
  if (args.enemyDeploy !== undefined) s.enemyDeploy = args.enemyDeploy;
  return Object.keys(s).length ? s : undefined;
}

export async function replayAll(dir, args = {}) {
  const { listDecisionLogs, readDecisionLog } = await dist('decision-log.js');
  const { loadReplay } = await dist('replay.js');
  const r = await dist('analysis/decision-replay.js');
  const scenario = await scenarioOf(args);
  const ids = args.game !== undefined ? [args.game] : (await listDecisionLogs(dir)).map((l) => l.gameId);
  const games = [];
  let fixtures = 0;
  let unread = 0;
  let missing = 0;
  for (const gameId of ids) {
    const log = await readDecisionLog(dir, gameId);
    if (!log) {
      if (existsSync(join(dir, 'decisions', `${gameId}.json`))) unread++;
      else missing++;
      continue;
    }
    const src = (await loadReplay(dir, gameId)) ?? { map: undefined, settings: undefined };
    const replay = r.replayDecisions(log, src, scenario);
    games.push({ log, replay });
    if (args.fixtures) {
      await mkdir(args.fixtures, { recursive: true, mode: 0o700 });
      for (const f of r.decisionFixtures(log, src)) {
        await writeFile(join(args.fixtures, `game-${gameId}-turn-${f.turn}.json`), `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
        fixtures++;
      }
    }
  }
  return {
    scenario: scenario ?? null,
    unread,
    missing,
    aggregate: r.replayAggregate(games.map((g) => g.replay)),
    accuracy: r.accuracyReport(games),
    ...(args.fixtures ? { fixtures } : {}),
    ...(args.json ? { games: games.map((g) => g.replay) } : {}),
  };
}

const ratio = (v) => (v ? `n=${v.n} mean=${v.mean} geo=${v.geoMean} low=${v.under} high=${v.over}` : 'none');

function accuracyLines(a) {
  const out = [`Estimate accuracy (estimate ÷ true income) over ${a.games} game(s) with an end-of-game truth:`];
  const view = (label, v) => {
    out.push(`  ${label}: ${ratio(v.estimates)}`);
    for (const [band, s] of Object.entries(v.byCoverage)) out.push(`    coverage ${band.padEnd(9)} ${ratio(s)}`);
    for (const [src, s] of Object.entries(v.bySource)) out.push(`    source ${src.padEnd(11)} ${ratio(s)}`);
  };
  view('logged', a.logged);
  out.push(`    outlook right=${a.logged.outlook.right} wrong=${a.logged.outlook.wrong}`);
  a.perGame.forEach((g, i) => out.push(`  game ${i + 1}: ${ratio(g.estimates)}; outlook right=${g.outlook.right} wrong=${g.outlook.wrong}`));
  if (a.scenario) view('replayed (this run’s estimates against the same truth)', a.scenario);
  if (!a.games) out.push('  No truth yet: the end-of-game pass writes it once a game is finished and its history read.');
  return out;
}

function print(r, args) {
  if (args.accuracy) return accuracyLines(r.accuracy).join('\n');
  const a = r.aggregate;
  const out = [
    `Scenario: ${r.scenario ? JSON.stringify(r.scenario) : 'none (the invariant: every compared turn should be identical)'}`,
    `Games: ${a.games}${r.unread ? ` (${r.unread} log(s) unreadable)` : ''}${r.missing ? ` (${r.missing} with no log)` : ''}; decided turns: ${a.turns}; replayed: ${a.compared}; identical: ${a.identical} (${a.identicalShare ?? '-'})`,
    `Goal changed on ${a.goalChanged} turn(s); skipped: ${JSON.stringify(a.skipped)}`,
    'By logged goal (compared / different):',
    ...Object.entries(a.byGoal).map(([g, b]) => `  ${g.padEnd(15)} ${b.compared} / ${b.different}`),
    `Logged expectations vs next turn: scored ${a.expectations.scored}, income reached ${a.expectations.incomeHeld}, every capture held ${a.expectations.capturesHeld}`,
    `Replayed captures vs what happened: backed ${a.replayedCaptures.backed}, failed ${a.replayedCaptures.failed}, untested ${a.replayedCaptures.untested}`,
    '',
    ...accuracyLines(r.accuracy),
  ];
  if (r.fixtures !== undefined) out.push('', `Fixtures written: ${r.fixtures}`);
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  const { dataDir } = await dist('config.js');
  const dir = args.dataDir ?? dataDir(process.env);
  const r = await replayAll(dir, args);
  console.log(args.json ? JSON.stringify(r, null, 2) : print(r, args));
}
