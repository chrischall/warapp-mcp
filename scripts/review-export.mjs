#!/usr/bin/env node
// The review export (#437 task 5): a LOCAL dev script, never a tool, never run in CI. It reads the built
// code (`npm run build` first: tsc emits dist/**) and the data directory, and writes one name-free JSON per
// game joining everything this server kept of it — the decision log (its turns, events, seats, join context,
// opponents and picks phase), the end-of-game record, the game's map-record and lessons entries, the
// settings record and the stored map's name — plus an `index.json` (game id, kinds, format, map, outcome,
// turns, which sources exist). 0600 files in a 0700 folder. It makes NO request and writes nothing to the
// data dir. The logic is src/review-export.ts.
//
//   node scripts/review-export.mjs --out <dir> [--data-dir <dir>] [--game <id>] [--boards]
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url);
const dist = (p) => import(new URL(`dist/${p}`, root).href);

const HELP = `Usage: node scripts/review-export.mjs --out <dir> [options]   (run \`npm run build\` first)

Writes one JSON per game (game-<id>.json) and an index.json, joining the decision log, the end-of-game
record, the map-record and lessons entries, the events, picks and join context. Name-free; no request.

  --out <dir>        where to write (made 0700; an existing folder others can read is refused)
  --data-dir <dir>   the data directory (default: the server's, MCP_DATA_DIR or ~/.config/warapp-mcp)
  --game <id>        one game only (default: every game with a decision log or a settings record)
  --boards           add each logged turn's board, rebuilt whole (large)
  --help             this text`;

function parseArgs(argv) {
  const out = { boards: false, help: false };
  const value = (i) => {
    const v = argv[i];
    if (v === undefined) throw new Error(`${argv[i - 1]} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--boards') out.boards = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--out') out.out = value(++i);
    else if (a === '--data-dir') out.dataDir = value(++i);
    else if (a === '--game') out.game = Number(value(++i));
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.game !== undefined && !Number.isSafeInteger(out.game)) throw new Error('--game takes a game id');
  if (!out.help && !out.out) throw new Error('--out <dir> is required');
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  const { dataDir } = await dist('config.js');
  const { exportReview } = await dist('review-export.js');
  const dir = args.dataDir ?? dataDir(process.env);
  const r = await exportReview(dir, args.out, { boards: args.boards, ...(args.game !== undefined ? { game: args.game } : {}) });
  console.log(`Wrote ${r.games} game file(s) and index.json to ${r.out}`);
}
