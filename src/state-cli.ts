// `warapp-mcp export-state --out <file>`: write this install's history as a state bundle
// (src/state-bundle.ts) for `warapp_import_state` on another server, the hosted one included.
// Local only: it reads the data dir (`--data-dir`, else `MCP_DATA_DIR`, else ~/.config/warapp-mcp)
// and nothing else — never the env file or a credential, never a request. It prints counts and sizes
// only: never the salt, a file's contents, or an id.
import { dataDir } from './config.js';
import { collectExport, encodeBundle, humanSize, MAX_EXPORT_DECISION_BYTES, StateBundleError, STORES, writeBundleFile } from './state-bundle.js';

const USAGE =
  'Usage: warapp-mcp export-state --out <file> [--data-dir <dir>] [--account <war.app player id>] [--force]\n' +
  'Writes this install\'s warapp-mcp history (file mode 0600) for warapp_import_state. The file holds the\n' +
  'salt behind your hashed history: keep it private and delete it once imported.';

interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: Io = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) };

/** Run the CLI; resolves to the exit code (0 ok, 1 refused, 2 usage). */
export async function runExportCli(argv: readonly string[], io: Io = defaultIo): Promise<number> {
  let out: string | undefined;
  let dir: string | undefined;
  let account: number | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => argv[++i];
    if (a === '--out') out = value();
    else if (a === '--data-dir') dir = value();
    else if (a === '--account') {
      const v = Number(value());
      if (!Number.isSafeInteger(v) || v <= 0) {
        io.err('--account must be a positive integer.');
        return 2;
      }
      account = v;
    } else if (a === '--force') force = true;
    else if (a === '--help' || a === '-h') {
      io.out(USAGE);
      return 0;
    } else {
      io.err(`Unknown argument.\n${USAGE}`);
      return 2;
    }
  }
  if (!out) {
    io.err(`--out is required.\n${USAGE}`);
    return 2;
  }
  try {
    const r = await collectExport(dir ?? dataDir(), account !== undefined ? { account } : {});
    const bytes = encodeBundle(r);
    await writeBundleFile(out, bytes, { force });
    const raw = r.files.reduce((n, f) => n + f.bytes.length, 0);
    io.out(`Wrote ${out}: ${r.files.length} files, ${humanSize(raw)} (${humanSize(bytes.length)} compressed), file mode 0600.`);
    for (const store of STORES) {
      const fs = r.files.filter((f) => f.store === store);
      if (fs.length) io.out(`  ${store}: ${fs.length} file${fs.length === 1 ? '' : 's'}, ${humanSize(fs.reduce((n, f) => n + f.bytes.length, 0))}`);
    }
    const { finishedGames, unknownGames, otherAccountFiles, decisionLogs } = r.leftOut;
    io.out(
      `Left out: per-game files of ${finishedGames} finished game(s) and ${unknownGames} game(s) of unknown state, ` +
        `${otherAccountFiles} file(s) of another account` +
        (decisionLogs ? `, ${decisionLogs} older decision log(s) past the bundle's ${humanSize(MAX_EXPORT_DECISION_BYTES)} share` : '') +
        '; credentials, chat, maps, stats and the bundle cache are never included.',
    );
    io.out('It holds the salt behind your hashed history: keep it private, and delete it once imported.');
    return 0;
  } catch (e) {
    io.err(e instanceof StateBundleError ? e.message : `Export failed: ${(e as NodeJS.ErrnoException).code ?? 'error'}.`);
    return 1;
  }
}
