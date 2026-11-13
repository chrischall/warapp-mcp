// The test process must never reach a live host (tests/setup/no-network.ts).
// Every target here is unroutable or reserved (example.invalid, TEST-NET-1), so
// even a broken guard sends nothing anywhere real; what is asserted is that the
// guard refuses first, with its own message.
import { createServer } from 'node:http';
import { get as httpsGet } from 'node:https';
import { connect } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { fetchPublic } from '@chrischall/mcp-utils/netguard';
import { NETWORK_GUARD_MESSAGE } from './setup/no-network.js';

const refused = new RegExp(NETWORK_GUARD_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/** The message of an error or of anything in its cause chain. */
function chain(err: unknown): string {
  const parts: string[] = [];
  for (let e = err as { message?: string; cause?: unknown } | undefined, i = 0; e && i < 8; e = e.cause as typeof e, i++) {
    parts.push(String(e.message ?? e));
  }
  return parts.join(' <- ');
}

describe('the test network guard', () => {
  it('refuses the global fetch to a non-loopback host with a clear message', async () => {
    await expect(fetch('https://example.invalid/')).rejects.toThrow(refused);
  });

  it('refuses a netguard fetchPublic (undici with its own dispatcher)', async () => {
    // The resolver and address check are overridden so the request reaches the socket layer
    // (netguard would itself refuse a reserved address); the address is TEST-NET-1.
    const err = await fetchPublic('https://example.invalid/', {
      requireHttps: true,
      resolve: async () => ['192.0.2.1'],
      isAllowedAddress: () => true,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(chain(err)).toMatch(refused);
  });

  it('refuses node:https and raw sockets', async () => {
    const httpsErr = await new Promise<unknown>((resolve) => {
      const req = httpsGet('https://192.0.2.1/', () => resolve(null));
      req.on('error', resolve);
    });
    expect(chain(httpsErr)).toMatch(refused);
    const sockErr = await new Promise<unknown>((resolve) => {
      const s = connect({ host: '192.0.2.1', port: 443 });
      s.on('connect', () => resolve(null));
      s.on('error', resolve);
    });
    expect(chain(sockErr)).toMatch(refused);
  });

  it('refuses a DNS lookup of a non-loopback name', async () => {
    await expect(lookup('example.invalid')).rejects.toThrow(refused);
  });

  it('still allows loopback', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe('ok');
      // localhost may resolve to ::1 where the server only listens on IPv4; whatever happens, the guard does not refuse it.
      const viaName = await fetch(`http://localhost:${port}/`).then(
        (r) => r.text(),
        (e: unknown) => chain(e),
      );
      expect(viaName).not.toMatch(refused);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
