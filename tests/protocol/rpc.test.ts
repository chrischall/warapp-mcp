import { McpToolError } from '@chrischall/mcp-utils';
import { describe, expect, it } from 'vitest';
import { WarappConfigError } from '../../src/config.js';
import { encodeRequest, toHex, Writer, type ExtrasDown } from '../../src/protocol/codec.js';
import { Method, writeGetMapDetailsParams, writeGetTerritoryPicksParams } from '../../src/protocol/methods.js';
import {
  CLIENT_VERSION,
  INITIAL_SERVER_INFO_A,
  INITIAL_SERVER_INFO_B,
  PLATFORM_WEBSITE,
  SERVER_ERROR_MESSAGES,
  WarappRpc,
  WarappServerError,
} from '../../src/protocol/rpc.js';
import { fakeWarapp, mockWarappBridge, TEST_EMAIL, type WarappExchange } from '../bridge-mock.js';

const ENV = { WARAPP_EMAIL: TEST_EMAIL };

function extrasDown(a: number, b: number, kFa: Date | null): ExtrasDown {
  return {
    cAa: null,
    wca: null,
    c2a: null,
    serverInfo: { okb: null, lbFlags: null, serverInfoVersionA: a, livestream: null, serverInfoVersionB: b },
    j9: null,
    unreadMail: { cYa: false, kFa, h9: false },
  };
}

function setup(reply: Parameters<typeof fakeWarapp>[0], env: Record<string, string> = ENV) {
  const fake = fakeWarapp(reply);
  const { bridge, mock } = mockWarappBridge(fake.handler);
  const rpc = new WarappRpc({ bridge: () => bridge.ready(), env });
  return { rpc, mock, exchanges: fake.exchanges };
}

const picks = (w: Writer) => writeGetTerritoryPicksParams(w, 4242, 1234567);

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('WarappRpc.call', () => {
  it('POSTs the uppercase-hex frame to /Services?m=<name>&js=1 as a form-encoded body', async () => {
    const { rpc, mock, exchanges } = setup(() => ({ body: (w) => w.bool(true).int32(7) }));
    await rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks);

    expect(mock.requests).toHaveLength(1);
    const req = mock.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('https://war.app/Services?m=GetTerritoryPicks&js=1');
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    expect(req.body).toMatch(/^[0-9A-F]+$/);

    const { request } = exchanges[0]!;
    expect(request.version).toBe(242);
    expect(request.method).toBe(Method.GetTerritoryPicks);
    expect(request.email).toBe(TEST_EMAIL);
    expect(request.body.int32()).toBe(4242);
    expect(request.body.int32()).toBe(1234567);
    expect(request.body.remaining).toBe(0);
  });

  it('builds the same bytes the encoder does for the same fields', async () => {
    const { rpc, mock } = setup(() => ({ body: (w) => w.bool(true) }));
    await rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks);
    const expected = encodeRequest({
      method: Method.GetTerritoryPicks,
      msgNum: 1,
      email: TEST_EMAIL,
      extras: {
        dict: new Map(),
        client: CLIENT_VERSION,
        serverInfoVersionA: INITIAL_SERVER_INFO_A,
        serverInfoVersionB: INITIAL_SERVER_INFO_B,
        fDb: null,
        kFa: null,
        platform: PLATFORM_WEBSITE,
      },
      params: picks,
    });
    expect(mock.requests[0]!.body).toBe(toHex(expected));
  });

  it('starts from plausible MessageExtrasUp values (website platform, current client)', async () => {
    const { rpc, exchanges } = setup(() => ({ body: (w) => w.bool(true) }));
    await rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks);
    const { extras } = exchanges[0]!.request;
    expect(extras.client).toBe('v6.07.0.1');
    expect(extras.platform).toBe(15);
    expect(extras.dict).toEqual(new Map());
    expect(extras.serverInfoVersionA).toBe(348);
    expect(extras.serverInfoVersionB).toBe(88732);
    expect(extras.fDb).toBeNull();
    expect(extras.kFa).toBeNull();
  });

  it('returns the envelope with the body positioned at the result', async () => {
    const { rpc } = setup(() => ({ body: (w) => w.bool(true).int32(7).string('ok') }));
    const env = await rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks);
    expect(env.method).toBe(Method.GetTerritoryPicks);
    expect(env.error).toBeUndefined();
    expect(env.body.bool()).toBe(true);
    expect(env.body.int32()).toBe(7);
    expect(env.body.string()).toBe('ok');
  });

  it('sends GetMapDetails with no auth block and without needing an email', async () => {
    const { rpc, exchanges } = setup(() => ({ body: (w) => w.bool(true) }), {});
    await rpc.call('GetMapDetails', Method.GetMapDetails, (w) => writeGetMapDetailsParams(w, 79472));
    const { request } = exchanges[0]!;
    expect(request.email).toBeNull();
    expect(request.body.int32()).toBe(79472);
    expect(request.body.remaining).toBe(0);
  });

  it('sends a method with no parameters when writeParams is omitted', async () => {
    const { rpc, exchanges } = setup(() => ({ body: (w) => w.bool(true) }));
    await rpc.call('UnCommit', Method.UnCommit);
    expect(exchanges[0]!.request.body.remaining).toBe(0);
  });

  it('numbers messages upward across calls', async () => {
    const { rpc, exchanges } = setup(() => ({ body: (w) => w.bool(true) }));
    await rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks);
    await rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks);
    await rpc.call('GetMapDetails', Method.GetMapDetails, (w) => writeGetMapDetailsParams(w, 1));
    expect(exchanges.map((e: WarappExchange) => e.request.msgNum)).toEqual([1, 2, 3]);
  });

  it('echoes serverInfoVersionA/B and kFa from each reply into the next request', async () => {
    const kFa = new Date(Date.UTC(2026, 10, 12, 9, 30));
    const kFa2 = new Date(Date.UTC(2026, 10, 12, 9, 45));
    const { rpc, exchanges } = setup((_req, n) => ({
      extrasDown: n === 1 ? extrasDown(400, 90001, kFa) : n === 2 ? undefined : extrasDown(401, 90002, kFa2),
      body: (w) => w.bool(true),
    }));
    for (let i = 0; i < 4; i++) await rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks);

    const sent = exchanges.map((e) => e.request.extras);
    expect([sent[0]!.serverInfoVersionA, sent[0]!.serverInfoVersionB, sent[0]!.kFa]).toEqual([348, 88732, null]);
    expect([sent[1]!.serverInfoVersionA, sent[1]!.serverInfoVersionB, sent[1]!.kFa]).toEqual([400, 90001, kFa]);
    // A reply without extras leaves the echoed values alone.
    expect([sent[2]!.serverInfoVersionA, sent[2]!.serverInfoVersionB, sent[2]!.kFa]).toEqual([400, 90001, kFa]);
    expect([sent[3]!.serverInfoVersionA, sent[3]!.serverInfoVersionB, sent[3]!.kFa]).toEqual([401, 90002, kFa2]);
  });

  it('keeps the previous values for extras parts a reply leaves out', async () => {
    const kFa = new Date(Date.UTC(2026, 10, 12));
    const { rpc, exchanges } = setup((_req, n) => ({
      extrasDown:
        n === 1
          ? extrasDown(400, 90001, kFa)
          : { ...extrasDown(0, 0, null), serverInfo: null, unreadMail: null },
      body: (w) => w.bool(true),
    }));
    for (let i = 0; i < 3; i++) await rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks);
    const third = exchanges[2]!.request.extras;
    expect([third.serverInfoVersionA, third.serverInfoVersionB, third.kFa]).toEqual([400, 90001, kFa]);
  });

  it('echoes extras carried on an error reply too', async () => {
    const { rpc, exchanges } = setup((_req, n) =>
      n === 1
        ? { extrasDown: extrasDown(500, 91000, null), error: { code: 208, message: null } }
        : { body: (w) => w.bool(true) },
    );
    await rejection(rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks));
    await rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks);
    expect(exchanges[1]!.request.extras.serverInfoVersionA).toBe(500);
    expect(exchanges[1]!.request.extras.serverInfoVersionB).toBe(91000);
  });

  it('exposes a copy of the extras the next request will send', async () => {
    const { rpc } = setup(() => ({ extrasDown: extrasDown(402, 90003, null), body: (w) => w.bool(true) }));
    await rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks);
    const snap = rpc.extras;
    expect(snap.serverInfoVersionA).toBe(402);
    snap.serverInfoVersionA = 1;
    expect(rpc.extras.serverInfoVersionA).toBe(402);
  });
});

describe('WarappRpc server errors', () => {
  const cases: Array<[number, string]> = [
    [10, 'war.app refused the order sequence — card plays must come in turn-phase order'],
    [11, 'Your orders deploy more or fewer armies than you are receiving this turn.'],
    [51, 'You hold more cards than this game allows, so war.app requires you to play or discard one this turn.'],
    [33, 'This message is too long.'],
    [36, 'sending too many messages to this game'],
    [88, 'This game has been deleted.'],
    [208, 'The game has already advanced to the next turn.'],
    [333, 'This game has been archived and can no longer receive new chat'],
    [254, 'your slot was assigned to someone else by the game creator'],
    [750, 'the slot you joined is no longer available'],
    [473, "You don't have enough coins to join this game."],
  ];

  it.each(cases)('maps server error %i to the client wording', async (code, wording) => {
    const { rpc } = setup(() => ({ error: { code, message: `java.lang.Exception at ${TEST_EMAIL}\n\tat x.y` } }));
    const err = await rejection(rpc.call('SendChat', Method.SendChat, (w) => w.int32(1)));
    expect(err).toBeInstanceOf(WarappServerError);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as WarappServerError).code).toBe(code);
    expect((err as Error).message).toContain(wording);
    expect((err as Error).message).not.toContain('java.lang');
    expect((err as Error).message).not.toContain(TEST_EMAIL);
    expect(SERVER_ERROR_MESSAGES[code]).toContain(wording);
  });

  it('reports an unknown code with a short, email-free first line of the server message', async () => {
    const long = `ServerError: thing failed for ${TEST_EMAIL} ${'x'.repeat(400)}\n\tat a.b(c.cs:1)\n\tat d.e`;
    const { rpc } = setup(() => ({ error: { code: 999, message: long } }));
    const err = (await rejection(rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks))) as WarappServerError;
    expect(err).toBeInstanceOf(WarappServerError);
    expect(err.code).toBe(999);
    expect(err.message).toContain('GetTerritoryPicks');
    expect(err.message).toContain('999');
    expect(err.message).toContain('ServerError: thing failed');
    expect(err.message).not.toContain(TEST_EMAIL);
    expect(err.message).not.toContain('\n');
    expect(err.message.length).toBeLessThan(320);
  });

  it('reports an unknown code with no server message', async () => {
    const { rpc } = setup(() => ({ error: { code: 1000, message: null } }));
    const err = (await rejection(rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks))) as WarappServerError;
    expect(err.message).toBe('war.app refused GetTerritoryPicks (server error 1000).');
  });
});

describe('WarappRpc transport failures', () => {
  it('needs WARAPP_EMAIL for a method that takes the auth block, before sending anything', async () => {
    const { rpc, mock } = setup(() => ({ body: (w) => w.bool(true) }), {});
    const err = await rejection(rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks));
    expect(err).toBeInstanceOf(WarappConfigError);
    expect(mock.requests).toHaveLength(0);
  });

  it('turns a non-200 answer into an McpToolError carrying the status', async () => {
    const { rpc } = setup(() => ({ status: 500, body: 'oops', url: 'https://war.app/Services' }));
    const err = (await rejection(rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks))) as McpToolError;
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.status).toBe(500);
    expect(err.kind).toBe('http');
    expect(err.message).toContain('HTTP 500');
  });

  it('says to sign in when the answer is not a frame (e.g. an HTML page)', async () => {
    const { rpc } = setup(() => ({ status: 200, body: '<html>Sign in</html>', url: 'https://war.app/LogIn' }));
    const err = (await rejection(rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks))) as McpToolError;
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.message).toMatch(/signed in/i);
    expect(err.message).not.toContain('<html>');
  });

  it('rejects a reply that does not decode', async () => {
    const { rpc } = setup(() => ({ status: 200, body: 'F2803', url: '' }));
    const err = (await rejection(rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks))) as McpToolError;
    expect(err).toBeInstanceOf(McpToolError);
  });

  it('rejects a reply with a bad preamble', async () => {
    const w = new Writer().uint16(0x80f2).int32(1).int32(1).int32(Method.GetTerritoryPicks).u8(0).u8(0);
    const { rpc } = setup(() => ({ status: 200, body: toHex(w.bytes()), url: '' }));
    const err = (await rejection(rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks))) as McpToolError;
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.message).toContain('GetTerritoryPicks');
  });

  it('rejects a reply that echoes a different message number', async () => {
    const { rpc } = setup((req) => ({ msgNum: req.msgNum + 5, body: (w) => w.bool(true) }));
    const err = (await rejection(rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks))) as McpToolError;
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.message).toMatch(/message number/i);
  });

  it('rejects a reply for a different method', async () => {
    const { rpc } = setup(() => ({ method: Method.GetTurns, body: (w) => w.bool(true) }));
    const err = (await rejection(rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks))) as McpToolError;
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.message).toMatch(/method/i);
  });

  it('lets bridge errors through unchanged', async () => {
    const boom = new Error('bridge down');
    const { bridge } = mockWarappBridge(() => {
      throw boom;
    });
    const rpc = new WarappRpc({ bridge: () => bridge.ready(), env: ENV });
    expect(await rejection(rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks))).toBe(boom);
  });

  it('accepts an explicit email getter over the env', async () => {
    const fake = fakeWarapp(() => ({ body: (w) => w.bool(true) }));
    const { bridge } = mockWarappBridge(fake.handler);
    const rpc = new WarappRpc({ bridge: () => bridge.ready(), email: () => 'other@example.com' });
    await rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, picks);
    expect(fake.exchanges[0]!.request.email).toBe('other@example.com');
  });
});
