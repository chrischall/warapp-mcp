import { describe, expect, it } from 'vitest';
import {
  BRIDGE_DOMAINS,
  createBridgeTransport,
  createWarappBridge,
  DEFAULT_WS_PORT,
  WS_PORT_ENV,
} from '../src/transport-bridge.js';
import { VERSION } from '../src/version.js';
import { mockBridgeServer } from './bridge-mock.js';

const ok = () => ({ status: 200, body: 'hi', url: 'https://war.app/' });

describe('createBridgeTransport', () => {
  it('declares warapp-mcp on war.app at the default port', () => {
    const mock = mockBridgeServer(ok);
    createBridgeTransport({ env: {}, createServer: mock.createServer });
    expect(mock.ctorOpts).toHaveLength(1);
    const opts = mock.ctorOpts[0]!;
    expect(opts.serverName).toBe('warapp-mcp');
    expect(opts.version).toBe(VERSION);
    expect(opts.domains).toEqual(['war.app']);
    expect(BRIDGE_DOMAINS).toEqual(['war.app']);
    expect(opts.port).toBe(37149);
    expect(DEFAULT_WS_PORT).toBe(37149);
    expect(WS_PORT_ENV).toBe('WARAPP_WS_PORT');
  });

  it('honours WARAPP_WS_PORT and ignores a placeholder or junk', () => {
    const port = (env: Record<string, string>) => {
      const mock = mockBridgeServer(ok);
      createBridgeTransport({ env, createServer: mock.createServer });
      return mock.ctorOpts[0]!.port;
    };
    expect(port({ WARAPP_WS_PORT: '40001' })).toBe(40001);
    expect(port({ WARAPP_WS_PORT: '${user_config.ws_port}' })).toBe(37149);
    expect(port({ WARAPP_WS_PORT: '99999999' })).toBe(37149);
  });

  it('passes requests through the wrapped server', async () => {
    const mock = mockBridgeServer(ok);
    const t = createBridgeTransport({ env: {}, createServer: mock.createServer });
    await t.start();
    const res = await t.fetch({ method: 'GET', path: '/' });
    expect(res.body).toBe('hi');
    expect(mock.requests[0]!.path).toBe('/');
  });
});

describe('createWarappBridge', () => {
  it('builds lazily and starts exactly once', async () => {
    const mock = mockBridgeServer(ok);
    const bridge = createWarappBridge({ env: {}, createServer: mock.createServer });
    expect(mock.ctorOpts).toHaveLength(0);
    const [a, b] = await Promise.all([bridge.ready(), bridge.ready()]);
    expect(a).toBe(b);
    await bridge.ready();
    expect(mock.ctorOpts).toHaveLength(1);
    expect(mock.listenCalls).toBe(1);
  });

  it('reports a bridge as unused until it has carried a request', async () => {
    const mock = mockBridgeServer(ok);
    const bridge = createWarappBridge({ env: {}, createServer: mock.createServer });
    expect(bridge.transport().role).toBeNull();
    await (await bridge.ready()).fetch({ method: 'GET', path: '/' });
    expect(bridge.transport().role).toBe('host');
  });
});
