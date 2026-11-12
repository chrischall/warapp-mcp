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
import { loadDotenvSafely, runMcp } from '@chrischall/mcp-utils';
import { envFilePath } from './config.js';
import { registerAllTools } from './tools/index.js';
import { VERSION } from './version.js';

await loadDotenvSafely({ path: envFilePath() });

await runMcp({
  name: 'warapp-mcp',
  version: VERSION,
  tools: [(server) => registerAllTools(server)],
  banner:
    `[warapp-mcp] v${VERSION} — war.app GameFeed advisor (read-only). Set WARAPP_EMAIL and WARAPP_API_TOKEN. ` +
    'This project was developed and is maintained by AI (Claude). Use at your own discretion.',
});
