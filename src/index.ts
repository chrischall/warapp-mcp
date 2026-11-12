#!/usr/bin/env node
// warapp-mcp entrypoint.
//
// war.app (Warzone) exposes a per-player GameFeed API authenticated by the
// player's email + API token. Credentials come from the host env, or from an
// optional dotenv file (WARAPP_ENV_FILE, default ~/.config/warapp-mcp/.env)
// whose values never override the host's.
//
// Deferred config: the server boots and answers tools/list with no
// credentials; a missing credential surfaces on the first call that needs it.
//
// The live-game tools also speak the web-client protocol, relayed through the
// user's signed-in war.app tab by the fetchproxy bridge (src/transport-bridge.ts).
// One bridge per process, started at boot; start() only loads the identity —
// the port binds on the first request.
import { loadDotenvSafely, runMcp } from '@chrischall/mcp-utils';
import { envFilePath } from './config.js';
import { registerAllTools } from './tools/index.js';
import { createWarappBridge } from './transport-bridge.js';
import { VERSION } from './version.js';

await loadDotenvSafely({ path: envFilePath() });

const bridge = createWarappBridge();
// A failed start (e.g. an unwritable identity dir) is not a boot failure: the
// lazy transport forgets it, and the first bridged call retries and reports it.
bridge.ready().catch(() => undefined);

await runMcp({
  name: 'warapp-mcp',
  version: VERSION,
  tools: [(server) => registerAllTools(server, { bridge })],
  shutdown: { onSignal: () => bridge.transport().close() },
  banner:
    `[warapp-mcp] v${VERSION} — war.app GameFeed advisor (read-only). Set WARAPP_EMAIL and WARAPP_API_TOKEN. ` +
    'This project was developed and is maintained by AI (Claude). Use at your own discretion.',
});
