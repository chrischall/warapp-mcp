// Moving history into this server, and finishing the end-of-game backlog faster.
//
// warapp_upload_slots + warapp_import_state (registered only where mcp-host hands this server a blob
// store, i.e. hosted): a local install's history, written by `warapp-mcp export-state`
// (src/state-cli.ts, src/state-bundle.ts), comes in through the fleet's upload-slot pattern
// (@chrischall/mcp-utils/export: `mintUploadSlot` signs a PUT the caller curls the bundle to, and
// `resolveUploadSource` reads it back by its `blobKey`), since the bundle is far too big for one tool
// argument. The import is confirm-gated like every write here (`defineGatedWrite`): the preview shows
// the counts per store, the bundle's account against the signed-in one (another account is refused),
// and the salt on this server against the bundle's (a different one is refused unless `replace`, which
// moves this server's hashed stores aside into a backup, never deleting them). Each file's sha256 is
// checked against the manifest before anything is written. Neither the preview nor the result carries
// the salt or any file's contents. The upload is deleted once imported, and at once when it is no
// bundle (it can never import); a refusal that a retry may clear (the account, the salt) keeps it.
//
// warapp_backfill_history: the warapp_my_games sweep (src/tools/end-of-game.ts) at a bigger batch —
// up to 25 finished games not yet processed per call, each history read once, as the sweep reads it —
// with an optional wider window. Writes only this server's state; nothing goes to war.app.
import { backfillWinnerCurves } from './map-curves.js';
import { CONFIRM_INJECTION_RULE, McpToolError, toolAnnotations, type EnvSource } from '@chrischall/mcp-utils';
import { mintUploadSlot, resolveUploadSource, type BlobStore, type UploadSource } from '@chrischall/mcp-utils/export';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { COLLECTOR_VERSION, MAX_FINISHED_RECORDS } from '../finished-store.js';
import { profileEnabled } from '../profile-store.js';
import {
  applyImport,
  decodeBundle,
  MAX_BUNDLE_BYTES,
  planImport,
  StateBundleError,
  type ImportResult,
  type StateBundle,
} from '../state-bundle.js';
import { respond } from './common.js';
import { sweepFinished, sweepWindow } from './end-of-game.js';
import { mintMeta } from './hints.js';
import { requireApprovedAccount, writeAccount, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE } from './live.js';
import { fetchMyGames, finishedGamesOf } from './my-games.js';
import { accountUnknown, defineGatedWrite, refuse } from './write-kit.js';

const SLOT_TOOL = 'warapp_upload_slots';
/** Finished games warapp_backfill_history processes per call: the default and the most. */
export const BACKFILL_DEFAULT = 10;
export const BACKFILL_MAX = 25;

export interface StateToolsDeps {
  env?: EnvSource;
  /** The blob store; none (`null`/`undefined`): the upload and import tools are not registered. */
  store?: BlobStore | null | undefined;
}

interface ImportState {
  me: number;
  replace: boolean;
  bundle: StateBundle;
  source: UploadSource;
}

export function registerStateTools(server: McpServer, ctx: LiveContext, deps: StateToolsDeps = {}): void {
  const env = deps.env ?? process.env;
  const store = deps.store ?? undefined;
  if (store) registerImportTools(server, ctx, store);
  registerBackfillTool(server, ctx, env);
}

function registerImportTools(server: McpServer, ctx: LiveContext, store: BlobStore): void {
  server.registerTool(
    SLOT_TOOL,
    {
      title: 'Get an upload URL for a warapp-mcp state bundle',
      _meta: mintMeta('other', ['upload my warapp history', 'move local warapp state']),
      description:
        'Get a signed upload URL for a warapp-mcp state bundle (the file `warapp-mcp export-state` writes on a ' +
        'local install), so warapp_import_state can read it on this hosted server. PUT the file to `uploadUrl` with ' +
        'exactly its Content-Type (the returned `curl` does it), then call warapp_import_state with the `blobKey`. ' +
        'Changes nothing; the URL is a short-lived credential to write that one file, so share it with no one, and ' +
        'the upload is deleted once imported.',
      annotations: toolAnnotations({ title: 'Upload URL for a state bundle', readOnly: true, destructive: false, idempotent: false, openWorld: true }),
      inputSchema: z.object({
        filename: z
          .string()
          .optional()
          .describe('The bundle file name (default "warapp-state.json.gz"); one plain name, no path.'),
      }),
    },
    async ({ filename }) => {
      const slot = mintUploadSlot(store, { filename: filename ?? 'warapp-state.json.gz', mimeType: 'application/octet-stream' });
      return respond(undefined, ['compact'], () => ({
        slot,
        maxBytes: MAX_BUNDLE_BYTES,
        next:
          "Replace the curl's `<path to …>` with the bundle's path and run it, then call warapp_import_state with " +
          'blob_key set to `blobKey`: it previews first and imports only once you confirm.',
      }));
    },
  );

  defineGatedWrite(
    server,
    {
      title: 'Import a warapp-mcp state bundle into this server',
      _meta: mintMeta('change', ['import my warapp history', 'move local warapp state to hosted']),
    },
    {
      name: 'warapp_import_state',
      description:
        "Import a local install's warapp-mcp history (the bundle `warapp-mcp export-state` writes, uploaded with " +
        'warapp_upload_slots) into this server: the salt behind its hashed keys, the deal record and ledgers, the ' +
        'opponent profiles, lessons, map records and end-of-game records, and the per-game files of games still in ' +
        "play. The preview shows the files per store, the bundle's account against the signed-in one (another " +
        "account is refused) and whether this server already has a salt: a different one is refused unless " +
        "`replace: true`, which moves this server's hashed stores (profiles, relations, finished, lessons, " +
        'maps-record) into a dated backup folder (never deleted), since entries under two salts would count twice. ' +
        "Each file's sha256 is checked against the bundle's manifest first; files are written atomically, 0600. " +
        'Without `replace` a file already here that differs is kept. Writes only this server\'s state, never ' +
        `war.app; never shows the salt or any file's contents. ${CONFIRM_INJECTION_RULE}`,
      annotations: toolAnnotations({
        title: 'Import a warapp-mcp state bundle',
        readOnly: false,
        destructive: false,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: z.object({
        blob_key: z.string().describe('The `blobKey` from warapp_upload_slots, after PUTting the bundle to its URL.'),
        replace: z
          .boolean()
          .optional()
          .describe(
            "Take the bundle's salt over a different one here: this server's hashed stores, and every file the " +
              'bundle replaces, are moved into state-backups/<time>/ first (default false).',
          ),
      }),
      async plan({ blob_key, replace }) {
        const dir = ctx.dataDir;
        if (!dir) refuse('This server has no data directory, so there is nowhere to import into; nothing was imported.', 'Nothing to do here.');
        const source = await resolveUploadSource(
          { blobKey: blob_key },
          { maxBytes: MAX_BUNDLE_BYTES, store, hosted: true, names: { blobKey: 'blob_key', inline: 'blob_key', path: 'blob_key', slotTool: SLOT_TOOL } },
        );
        let bundle: StateBundle;
        try {
          bundle = decodeBundle(source.bytes);
        } catch (e) {
          // It can never import: drop the upload now rather than leave it to the store's retention.
          await source.release();
          if (e instanceof StateBundleError) refuse(e.message, 'Export the bundle again with `warapp-mcp export-state` and upload the new file.');
          throw e;
        }
        const me = await ctx.myInviteToken({ fresh: true }).catch(() => undefined);
        if (me === undefined) throw accountUnknown(ctx, 'nothing was imported');
        const p = await planImport(dir, bundle, me);
        if (!p.accountMatches) {
          refuse(
            `The bundle is for war.app account ${p.accountId}, but account ${me} is signed in here, so nothing was imported.`,
            'Sign in to war.app as the account the bundle was exported from, or export the right account (`--account`).',
          );
        }
        const conflictSalt = p.salt === 'different' || p.salt === 'malformed';
        if (conflictSalt && !replace) {
          refuse(
            `This server already has a ${p.salt} salt, so its hashed history cannot be merged with the bundle's ` +
              `(${p.totals.files} files); nothing was imported.`,
            "Call again with replace: true to move this server's hashed stores (profiles, relations, finished, lessons, " +
              "maps-record) into a dated backup folder, never deleted, and take the bundle's.",
          );
        }
        return {
          gate: {
            action: 'warapp.import_state',
            summary: `Import a state bundle of ${p.totals.files} files for war.app account ${p.accountId} into this server`,
            account: writeAccount(me),
            target: source.sha256,
            payload: { action: 'import-state', sha256: source.sha256, replace: replace === true, salt: p.salt },
            willSend: { files: p.totals.files, bytes: p.totals.bytes },
            preview: {
              warning:
                "This writes this server's own state only (nothing goes to war.app or to any player)." +
                (replace && conflictSalt
                  ? " replace: this server's hashed stores move into state-backups/<time>/ (kept, not deleted) and the bundle's salt is taken."
                  : '') +
                (p.conflicts && !replace ? ` ${p.conflicts} file(s) here differ from the bundle's and are kept.` : '') +
                (p.conflicts && replace ? ` ${p.conflicts} file(s) here that differ are moved into the backup and replaced.` : ''),
              account: `war.app account ${me}`,
              bundleAccount: p.accountId,
              accountMatches: p.accountMatches,
              bundleCreatedAt: p.createdAt,
              saltOnServer: p.salt,
              stores: p.stores,
              totals: p.totals,
              conflicts: p.conflicts,
              sha256: source.sha256,
            },
          },
          state: { me, replace: replace === true, bundle, source } satisfies ImportState,
        };
      },
      async execute({ me, replace, bundle, source }: ImportState) {
        await requireApprovedAccount(ctx, writeAccount(me));
        let r: ImportResult;
        try {
          r = await applyImport(ctx.dataDir!, bundle, { signedIn: me, replace });
        } catch (e) {
          if (e instanceof StateBundleError) throw new McpToolError(e.message, { kind: 'unknown' });
          throw new McpToolError(`The import stopped part way (${(e as NodeJS.ErrnoException).code ?? 'write failed'}); import the same bundle again to finish it.`, {
            kind: 'unknown',
          });
        }
        const released = await source.release();
        return {
          status: 'imported' as const,
          outcome: 'confirmed' as const,
          ...r,
          blobDeleted: released.deleted === true,
          note:
            'Imported. The bundle held the salt behind your hashed history: delete the local file too. Finished ' +
            'games not yet processed here get their pass from warapp_backfill_history.',
        };
      },
    },
  );
}

function registerBackfillTool(server: McpServer, ctx: LiveContext, env: EnvSource): void {
  server.registerTool(
    'warapp_backfill_history',
    {
      title: 'Process more finished war.app games at once',
      _meta: mintMeta('change', ['backfill my war.app history', 'process finished games', 'catch up past games']),
      description:
        'Give the end-of-game pass to up to `limit` (default 10, at most 25) of your finished war.app games not yet ' +
        'processed, newest first: each game\'s history is read ONCE from GameFeed (never again, whatever comes of ' +
        'it) and kept name-free for the opponent profiles, map records and lessons — what warapp_my_games does two ' +
        'games per call. `window` widens how many of your newest finished games are considered (default 250, at ' +
        `most ${MAX_FINISHED_RECORDS}). Reports what it processed and how many remain; safe to call again until ` +
        '`remaining` is 0. `games` lists every game considered one by one, from this server\'s state (no request): ' +
        'recorded (captured, read-failed or history-unreadable, with the failure code, history turns, boards kept, ' +
        'stats version, collector version and `outdated` when kept under an older collector), not-processed, ' +
        'processed-record-pruned or record-unreadable, and what this call did to it (read, reread, waiting). ' +
        '`game_ids` limits it to those games. `reread` reads the history AGAIN (one more GameFeed request per game) ' +
        'for games already processed — `failed` (read-failed or history-unreadable), `outdated` (kept under an older ' +
        'collector version, so newer metrics get captured) or `all` — and rebuilds the record and what was processed ' +
        'from it (each store replaces the game\'s share; nothing counts twice); a re-read that fails never replaces a ' +
        'captured record (`keptPrevious`). It also gives map records kept before the winners\' income curves were those curves, from the ' +
        'histories already kept (`winnerCurves`, no request). Writes only this server\'s state and never writes to war.app. ' +
        BRIDGE_NOTE,
      annotations: toolAnnotations({ title: 'Backfill finished war.app games', readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      inputSchema: z.object({
        limit: z.number().int().min(1).max(BACKFILL_MAX).optional().describe(`Games to process this call (default ${BACKFILL_DEFAULT}, max ${BACKFILL_MAX}).`),
        window: z
          .number()
          .int()
          .min(1)
          .max(MAX_FINISHED_RECORDS)
          .optional()
          .describe(`How many of your newest finished games to consider (default ${sweepWindow()}, max ${MAX_FINISHED_RECORDS}).`),
        game_ids: z
          .array(z.number().int().positive())
          .min(1)
          .max(MAX_FINISHED_RECORDS)
          .optional()
          .describe('Only these games (each a finished game of yours; others are listed in `notFinishedOrNotMine`).'),
        reread: z
          .enum(['failed', 'outdated', 'all'])
          .optional()
          .describe(
            "Read again the history of games already processed: `failed` (read-failed or history-unreadable), `outdated` (kept under an older collector version) or `all`. One GameFeed request per game; default none.",
          ),
      }),
    },
    async ({ limit, window, game_ids, reread }) => {
      if (!ctx.dataDir) refuse('This server has no data directory, so no history can be kept.', 'Nothing to do here.');
      if (!profileEnabled(env)) refuse('The end-of-game pass is off (WARAPP_PLAYER_PROFILE=off), so nothing was read.', 'Turn profiling on to backfill.');
      const { me, games } = await fetchMyGames(ctx);
      const token = await ctx.myInviteToken().catch(() => undefined);
      if (token === undefined) throw accountUnknown(ctx, 'nothing was read');
      const ids = finishedGamesOf(games, me);
      const size = Math.min(window ?? sweepWindow(), MAX_FINISHED_RECORDS);
      const r = await sweepFinished({ client: ctx.client, dataDir: ctx.dataDir, env }, token, ids, {
        limit: limit ?? BACKFILL_DEFAULT,
        window: size,
        report: true,
        ...(game_ids ? { only: game_ids } : {}),
        ...(reread ? { reread } : {}),
      });
      const finished = new Set(ids);
      const notMine = game_ids ? [...new Set(game_ids)].filter((id) => !finished.has(id)) : [];
      // #419: entries kept before the winners' curves were, given them from the kept histories (no request).
      const winnerCurves = await backfillWinnerCurves(ctx.dataDir);
      return respond(undefined, ['compact'], () => ({
        winnerCurves,
        processed: r.processed,
        processedCount: r.processed.length,
        remaining: r.pending,
        finishedGames: ids.length,
        window: size,
        ...(ids.length > size && !game_ids ? { outsideWindow: ids.length - size } : {}),
        collectorVersion: COLLECTOR_VERSION,
        games: r.games ?? [],
        ...(notMine.length ? { notFinishedOrNotMine: notMine } : {}),
      }));
    },
  );
}
