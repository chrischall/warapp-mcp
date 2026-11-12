import type { McpServer } from '@modelcontextprotocol/server';
import { registerHealthcheckTool, type HealthcheckDeps } from './healthcheck.js';

export type ToolDeps = HealthcheckDeps;

/** Every tool this server serves. index.ts and the tests share this list. */
export function registerAllTools(server: McpServer, deps: ToolDeps = {}): void {
  registerHealthcheckTool(server, deps);
}
