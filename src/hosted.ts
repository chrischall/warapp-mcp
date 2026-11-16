// Is this process a hosted child (mcp-host), not a local install?
//
// mcp-host gives this server no explicit "hosted" flag, so a hosted child is
// recognised by the variables only the host sets ({@link HOSTED_MARKERS}).
// Consulted by the map statistics (always off when hosted, src/stats.ts) and by
// the direct transport: when hosted no session file is ever read or written
// (src/direct/session.ts) and warapp_link_session is not registered
// (src/tools/session.ts). The direct leg then serves only from the AuthToken
// mcp-host captured at sign-in (WARAPP_AUTH_TOKEN, in memory, #333), the
// bridge its fallback; without one the router is pinned to the browser bridge
// (src/direct/transport.ts).
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
