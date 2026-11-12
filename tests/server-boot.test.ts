// Boot smoke test: spawn the REAL bundled artifact (dist/bundle.js) in a temp
// dir with NO node_modules — the exact `.mcpb` runtime — and run the MCP
// `initialize` + `tools/list` handshake. Catches an eager import of an
// externalized dep crashing the bundle at load, and a wrong bin/outfile path.
//
// Runs WITHOUT credentials (deferred-config pattern: the server must still
// boot and answer tools/list) and with WARAPP_ENV_FILE pointed at a file that
// does not exist, so the developer's real ~/.config/warapp-mcp/.env is never
// read. The fetchproxy identity the bridge loads at boot goes in the temp dir.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'dist', 'bundle.js');

function rpc(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

describe('server boot (bundled artifact, no node_modules)', () => {
  beforeAll(() => {
    if (!existsSync(BUNDLE)) {
      execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
    }
  });

  it('answers initialize + tools/list without credentials, keeping stdout pure JSON-RPC', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-boot-'));
    const bundleCopy = join(dir, 'bundle.js');
    copyFileSync(BUNDLE, bundleCopy);

    // The bridge starts at boot and loads (or creates) its fetchproxy identity:
    // keep that inside the temp dir, never the developer's ~/.fetchproxy.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WARAPP_ENV_FILE: join(dir, 'absent.env'),
      FETCHPROXY_IDENTITY_DIR: join(dir, 'identity'),
    };
    delete env.WARAPP_EMAIL;
    delete env.WARAPP_API_TOKEN;
    const child = spawn(process.execPath, [bundleCopy], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });

    const nonJson: string[] = [];
    const tools = await new Promise<string[]>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('timed out waiting for tools/list'));
      }, 15_000);

      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: { id?: number; result?: { tools?: { name: string }[] } };
          try {
            msg = JSON.parse(line);
          } catch {
            nonJson.push(line);
            continue;
          }
          if (msg.id === 2 && msg.result?.tools) {
            clearTimeout(timer);
            child.kill();
            resolve(msg.result.tools.map((t) => t.name).sort());
          }
        }
      });
      child.on('error', reject);

      child.stdin.write(
        rpc(1, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'boot-test', version: '0' },
        }),
      );
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      child.stdin.write(rpc(2, 'tools/list', {}));
    });

    expect(tools).toEqual([
      'warapp_analyze_board',
      'warapp_get_chat',
      'warapp_get_game',
      'warapp_get_live_board',
      'warapp_get_map',
      'warapp_get_my_picks',
      'warapp_healthcheck',
      'warapp_plan_route',
      'warapp_plan_turn',
      'warapp_recent_events',
      'warapp_send_chat',
      'warapp_submit_picks',
      'warapp_submit_turn',
      'warapp_wait_for_turn',
    ]);
    expect(nonJson).toEqual([]);
  });
});
