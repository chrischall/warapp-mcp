// Is this process a hosted child (mcp-host), not a local install?
//
// mcp-host gives this server no explicit "hosted" flag, so a hosted child is
// recognised by the variables only the host sets ({@link HOSTED_MARKERS}).
// Consulted by the map statistics (always off when hosted, src/stats.ts) and by
// the direct transport, which is LOCAL-ONLY: when hosted the session store
// reads as empty and refuses writes (src/direct/session.ts), the router is
// pinned to the browser bridge (src/direct/transport.ts), and
// warapp_link_session is not registered (src/tools/session.ts).
import { readEnvVar, type EnvSource } from '@chrischall/mcp-utils';

/**
 * Variables only a hosted child sees: mcp-host's own (its child-env contract —
 * the byte-meter file, the confirm-token key, the blob store) and the
 * platform's machine id. Any one of them set means hosted.
 */
export const HOSTED_MARKERS = [
  'MCP_HOST_METER_FILE',
  'MCP_HOST_CONFIRM_SECRET',
  'MCP_BLOB_BASE_URL',
  'FLY_MACHINE_ID',
] as const;

export function isHosted(env: EnvSource = process.env): boolean {
  return HOSTED_MARKERS.some((k) => readEnvVar(k, { env }) !== undefined);
}
