import { describe, expect, it } from 'vitest';
import {
  DATE_EPOCH_MS,
  MAX_DATE,
  PREAMBLE,
  ProtocolError,
  Reader,
  Writer,
  decodeReplyEnvelope,
  decodeRequest,
  encodeReply,
  encodeRequest,
  fromHex,
  readExtrasUp,
  toHex,
  type ExtrasDown,
  type ExtrasUp,
} from '../../src/protocol/codec.js';
import {
  AttackTransferMode,
  Method,
  methodName,
  writeAttackTransferOrder,
  writeDeployOrder,
  writeGetMapDetailsParams,
  writeGetTerritoryPicksParams,
} from '../../src/protocol/methods.js';

const hex = (w: Writer) => toHex(w.bytes()).toLowerCase();
const reader = (h: string) => new Reader(fromHex(h));

function expectProtocolError(fn: () => unknown, kind: ProtocolError['kind']): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolError);
    expect((e as ProtocolError).kind).toBe(kind);
    return;
  }
  throw new Error(`expected ProtocolError ${kind}`);
}

const EXTRAS: ExtrasUp = {
  dict: new Map(),
  client: 'v6.07.0.1',
  serverInfoVersionA: 0,
  serverInfoVersionB: 0,
  fDb: null,
  kFa: null,
  platform: 0,
};

describe('primitives', () => {
  it('writes little-endian integers and floats', () => {
    expect(hex(new Writer().int16(-2))).toBe('feff');
    expect(hex(new Writer().uint16(242))).toBe('f200');
    expect(hex(new Writer().int32(1000))).toBe('e8030000');
    expect(hex(new Writer().int64(-2))).toBe('feffffffffffffff');
    expect(hex(new Writer().int64(5n))).toBe('0500000000000000');
    expect(hex(new Writer().float32(1.5))).toBe('0000c03f');
    expect(hex(new Writer().float64(86400000))).toBe('0000000070999441');
  });

  it('round-trips every primitive', () => {
    const w = new Writer()
      .bool(true)
      .bool(false)
      .u8(200)
      .int16(-300)
      .uint16(65535)
      .int32(-2147483648)
      .int64(-(2 ** 53) + 1)
      .float32(0.25)
      .float64(-1.125)
      .string('héllo')
      .string(null)
      .string('')
      .guid('00112233-4455-6677-8899-aabbccddeeff');
    const r = new Reader(w.bytes());
    expect(r.bool()).toBe(true);
    expect(r.bool()).toBe(false);
    expect(r.u8()).toBe(200);
    expect(r.int16()).toBe(-300);
    expect(r.uint16()).toBe(65535);
    expect(r.int32()).toBe(-2147483648);
    expect(r.int64()).toBe(-(2 ** 53) + 1);
    expect(r.float32()).toBe(0.25);
    expect(r.float64()).toBe(-1.125);
    expect(r.string()).toBe('héllo');
    expect(r.string()).toBeNull();
    expect(r.string()).toBe('');
    expect(r.guid()).toBe('00112233445566778899aabbccddeeff');
    expect(r.remaining).toBe(0);
    expect(r.position).toBe(w.length);
  });

  it('writes strings as present flag + 7-bit length + UTF-8', () => {
    expect(hex(new Writer().string('ab'))).toBe('01026162');
    expect(hex(new Writer().string(null))).toBe('00');
    const long = 'x'.repeat(300); // 300 = 0xac 0x02
    expect(hex(new Writer().string(long)).slice(0, 6)).toBe('01ac02');
    expect(new Reader(new Writer().string(long).bytes()).string()).toBe(long);
  });

  it('round-trips large varints', () => {
    const r = new Reader(new Writer().varint(0).varint(127).varint(128).varint(0xffffffff).bytes());
    expect([r.varint(), r.varint(), r.varint(), r.varint()]).toEqual([0, 127, 128, 0xffffffff]);
  });

  it('writes GUIDs in .NET byte order', () => {
    expect(hex(new Writer().guid('00112233445566778899aabbccddeeff'))).toBe('33221100554477668899aabbccddeeff');
  });

  it('encodes dates as ms since 2000-01-01 with sentinels', () => {
    const day1 = new Date(DATE_EPOCH_MS + 86400000);
    expect(hex(new Writer().date(day1))).toBe('0000000070999441');
    expect(hex(new Writer().date(null))).toBe('c3b10e2979c341cb');
    expect(hex(new Writer().date(MAX_DATE))).toBe('c3b10e2979c3414b');
    const r = reader('0000000070999441c3b10e2979c341cbc3b10e2979c3414b');
    expect(r.date()?.toISOString()).toBe('2000-01-02T00:00:00.000Z');
    expect(r.date()).toBeNull();
    expect(r.date()).toBe(MAX_DATE);
  });

  it('round-trips lists and dicts, with -1 as null', () => {
    const w = new Writer()
      .list([1, 2, 3], (ww, v) => ww.int32(v))
      .list<number>(null, (ww, v) => ww.int32(v))
      .dict(
        new Map([[7, 'seven']]),
        (ww, k) => ww.int32(k),
        (ww, v) => ww.string(v),
      )
      .dict<number, string>(
        null,
        (ww, k) => ww.int32(k),
        (ww, v) => ww.string(v),
      );
    expect(hex(w).slice(0, 8 + 24 + 8)).toBe('03000000' + '010000000200000003000000' + 'ffffffff');
    const r = new Reader(w.bytes());
    expect(r.list((rr) => rr.int32())).toEqual([1, 2, 3]);
    expect(r.list((rr) => rr.int32())).toBeNull();
    expect(
      r.dict(
        (rr) => rr.int32(),
        (rr) => rr.string(),
      ),
    ).toEqual(new Map([[7, 'seven']]));
    expect(
      r.dict(
        (rr) => rr.int32(),
        (rr) => rr.string(),
      ),
    ).toBeNull();
  });
});

describe('malformed input', () => {
  it('rejects a bool other than 0 or 1', () => {
    expectProtocolError(() => reader('02').bool(), 'bad-bool');
    expectProtocolError(() => reader('05').string(), 'bad-bool');
  });

  it('rejects truncated reads', () => {
    expectProtocolError(() => reader('0102').int32(), 'truncated');
    expectProtocolError(() => reader('').u8(), 'truncated');
    expectProtocolError(() => reader('010561').string(), 'truncated');
    expectProtocolError(() => reader('00').float64(), 'truncated');
  });

  it('rejects overlong varints, invalid UTF-8 and negative counts', () => {
    expectProtocolError(() => reader('ffffffffff01').varint(), 'bad-varint');
    expectProtocolError(() => reader('0102c328').string(), 'bad-string');
    expectProtocolError(() => reader('feffffff').list((r) => r.int32()), 'bad-length');
  });

  it('refuses to encode out-of-range values', () => {
    expectProtocolError(() => new Writer().int32(2 ** 31), 'out-of-range');
    expectProtocolError(() => new Writer().int32(1.5), 'out-of-range');
    expectProtocolError(() => new Writer().int16(40000), 'out-of-range');
    expectProtocolError(() => new Writer().u8(256), 'out-of-range');
    expectProtocolError(() => new Writer().int64(2 ** 60), 'out-of-range');
    expectProtocolError(() => new Writer().int64(1n << 63n), 'out-of-range');
    expectProtocolError(() => new Writer().guid('nope'), 'out-of-range');
    expectProtocolError(() => new Writer().date(new Date(NaN)), 'out-of-range');
  });

  it('rejects bad hex', () => {
    expectProtocolError(() => fromHex('abc'), 'bad-length');
    expectProtocolError(() => fromHex('zz'), 'bad-length');
  });
});

describe('encodeRequest golden vectors', () => {
  // header: uint16 242 | int32 preamble 1514664249 | int32 msgNum | int32 method
  // extras up: dict present (01) + count 0 | "v6.07.0.1" | ZR 0 | YL 0 | fDb no-date | kFa no-date | platform 0
  const EXTRAS_HEX =
    '01' +
    '00000000' +
    '01' +
    '09' +
    '76362e30372e302e31' +
    '00000000' +
    '00000000' +
    'c3b10e2979c341cb' +
    'c3b10e2979c341cb' +
    '00000000';

  it('GetMapDetails(39905) carries no auth block', () => {
    const bytes = encodeRequest({
      method: Method.GetMapDetails,
      msgNum: 1,
      extras: EXTRAS,
      email: null,
      params: (w) => writeGetMapDetailsParams(w, 39905),
    });
    const expected = 'f200' + '39f1475a' + '01000000' + '49000000' + EXTRAS_HEX + 'e19b0000';
    expect(toHex(bytes)).toBe(expected.toUpperCase());
  });

  it('GetTerritoryPicks(game 1234, player 1000) carries the auth block', () => {
    const bytes = encodeRequest({
      method: Method.GetTerritoryPicks,
      msgNum: 7,
      extras: EXTRAS,
      email: 'test@example.com',
      params: (w) => writeGetTerritoryPicksParams(w, 1234, 1000),
    });
    const expected =
      'f200' +
      '39f1475a' +
      '07000000' +
      '4f000000' +
      EXTRAS_HEX +
      '01' + // auth present
      '04' + // auth tag
      '01' +
      '10' +
      '74657374406578616d706c652e636f6d' + // test@example.com
      'd2040000' + // game 1234
      'e8030000'; // player 1000
    expect(toHex(bytes)).toBe(expected.toUpperCase());
  });

  it('round-trips through decodeRequest', () => {
    const extras: ExtrasUp = {
      dict: new Map([[3, 'three']]),
      client: null,
      serverInfoVersionA: 11,
      serverInfoVersionB: 22,
      fDb: new Date('2026-01-02T03:04:05.000Z'),
      kFa: MAX_DATE,
      platform: 2,
    };
    const bytes = encodeRequest({
      method: Method.GetTerritoryPicks,
      msgNum: 9,
      extras,
      email: 'test@example.com',
      params: (w) => writeGetTerritoryPicksParams(w, 5, 6),
      version: 243,
    });
    const req = decodeRequest(bytes, { hasAuth: true });
    expect(req).toMatchObject({ version: 243, reply: false, msgNum: 9, method: 79, extras, email: 'test@example.com' });
    expect([req.body.int32(), req.body.int32(), req.body.remaining]).toEqual([5, 6, 0]);

    const noAuth = decodeRequest(encodeRequest({ method: 73, msgNum: 1, extras: { ...extras, dict: null }, email: null }), {
      hasAuth: false,
    });
    expect(noAuth.email).toBeNull();
    expect(noAuth.extras.dict).toBeNull();
    expect(noAuth.body.remaining).toBe(0);
  });

  it('decodeRequest reads an absent auth block and rejects replies', () => {
    const w = new Writer().uint16(242).int32(PREAMBLE).int32(1).int32(79);
    const extrasBytes = encodeRequest({ method: 79, msgNum: 1, extras: EXTRAS, email: null }).slice(14);
    w.raw(extrasBytes).bool(false);
    expect(decodeRequest(w.bytes(), { hasAuth: true }).email).toBeNull();
    expectProtocolError(() => decodeRequest(encodeReply({ method: 79, msgNum: 1 }), { hasAuth: false }), 'not-a-reply');
  });

  it('extras dict entries read back as strings', () => {
    const w = new Writer();
    w.bool(true)
      .int32(1)
      .int32(4)
      .string(null)
      .string(null)
      .int32(0)
      .int32(0)
      .date(null)
      .date(null)
      .int32(0);
    expect(readExtrasUp(new Reader(w.bytes())).dict).toEqual(new Map([[4, '']]));
  });
});

const EXTRAS_DOWN: ExtrasDown = {
  cAa: new Map([[1, 'a']]),
  wca: 5,
  c2a: 'note',
  serverInfo: {
    okb: 'okb',
    lbFlags: 'x;y',
    serverInfoVersionA: 31,
    livestream: { j7: 'stream', jdb: 2, lr: null, zfd: null, yfd: 'y' },
    serverInfoVersionB: 32,
  },
  j9: new Map<number, Array<string | null> | null>([
    [1, ['p', null]],
    [2, null],
  ]),
  unreadMail: { cYa: true, kFa: new Date('2026-03-04T00:00:00.000Z'), h9: false },
};

describe('decodeReplyEnvelope', () => {
  it('decodes a hand-built picks reply without extras', () => {
    // header (reply bit set) | 00 no extras | 00 kind | 01 present | list [3, 9]
    const h = 'f280' + '39f1475a' + '07000000' + '4f000000' + '00' + '00' + '01' + '02000000' + '03000000' + '09000000';
    const env = decodeReplyEnvelope(fromHex(h));
    expect(env).toMatchObject({ version: 242, method: Method.GetTerritoryPicks, msgNum: 7 });
    expect(env.extrasDown).toBeUndefined();
    expect(env.error).toBeUndefined();
    expect(env.body.bool()).toBe(true);
    expect(env.body.list((r) => r.int32())).toEqual([3, 9]);
  });

  it('decodes an error reply (kind 5)', () => {
    const h = 'f280' + '39f1475a' + '02000000' + '28000000' + '00' + '05' + '21000000' + '0102' + '6e6f';
    const env = decodeReplyEnvelope(fromHex(h));
    expect(env.error).toEqual({ code: 33, message: 'no' });
  });

  it('round-trips extras down, errors and bodies through encodeReply', () => {
    const env = decodeReplyEnvelope(
      encodeReply({ method: 40, msgNum: 3, extrasDown: EXTRAS_DOWN, body: (w) => w.bool(true).int32(42) }),
    );
    expect(env.extrasDown).toEqual(EXTRAS_DOWN);
    expect([env.body.bool(), env.body.int32(), env.body.remaining]).toEqual([true, 42, 0]);

    const empty: ExtrasDown = { cAa: null, wca: null, c2a: null, serverInfo: null, j9: null, unreadMail: null };
    const err = decodeReplyEnvelope(
      encodeReply({ method: 40, msgNum: 4, extrasDown: empty, error: { code: 208, message: null } }),
    );
    expect(err.extrasDown).toEqual(empty);
    expect(err.error).toEqual({ code: 208, message: null });

    const noLive = { ...EXTRAS_DOWN, serverInfo: { ...EXTRAS_DOWN.serverInfo!, livestream: null } };
    expect(decodeReplyEnvelope(encodeReply({ method: 40, msgNum: 5, extrasDown: noLive })).extrasDown).toEqual(noLive);
  });

  it('rejects a bad preamble, a request frame and a truncated reply', () => {
    expectProtocolError(() => decodeReplyEnvelope(fromHex('f280' + '00000000' + '01000000' + '28000000' + '0000')), 'bad-preamble');
    expectProtocolError(
      () => decodeReplyEnvelope(encodeRequest({ method: 40, msgNum: 1, extras: EXTRAS, email: null })),
      'not-a-reply',
    );
    const full = encodeReply({ method: 40, msgNum: 3, extrasDown: EXTRAS_DOWN });
    expectProtocolError(() => decodeReplyEnvelope(full.slice(0, full.length - 3)), 'truncated');
    expectProtocolError(() => decodeReplyEnvelope(fromHex('f280')), 'truncated');
  });

  it('hex helpers produce uppercase and accept either case', () => {
    expect(toHex(new Uint8Array([0xab, 0x01]))).toBe('AB01');
    expect(Array.from(fromHex(' ab01\n'))).toEqual([0xab, 0x01]);
  });
});

describe('methods', () => {
  it('names every method id', () => {
    expect(Method).toEqual({
      GameRefresh: 39,
      GetLatestGameInfo: 40,
      SendChat: 42,
      GetMapDetails: 73,
      SendOrders: 74,
      SendInProgressOrders: 75,
      SendTerritoryPicks: 76,
      SendInProgressPicks: 77,
      GetTerritoryPicks: 79,
      UnCommit: 80,
      GetTurns: 81,
    });
    expect(methodName(40)).toBe('GetLatestGameInfo');
    expect(methodName(41)).toBeUndefined();
  });

  it('encodes a Deploy order (unverified)', () => {
    const w = new Writer();
    writeDeployOrder(w, { playerId: 1000, territoryId: 7, armies: 5 });
    // tag 2 | territory 7 | flag 0 | armies 5 | player 1000 | no result | no standing updates
    expect(hex(w)).toBe('02' + '07000000' + '00' + '05000000' + 'e8030000' + '00' + '00');
    const flagged = new Writer();
    writeDeployOrder(flagged, { playerId: 1, territoryId: 2, armies: 3, flag: true });
    expect(hex(flagged).slice(10, 12)).toBe('01');
  });

  it('encodes an AttackTransfer order (unverified)', () => {
    const w = new Writer();
    writeAttackTransferOrder(w, { playerId: 1000, from: 7, to: 9, armies: 4 });
    // tag 1 | attackTeammates 0 | mode 3 | byPercent 0 | from 7 | not fogged | armies 4 | no specials | to 9 | base
    expect(hex(w)).toBe(
      '01' + '00' + '03' + '00' + '07000000' + '00' + '04000000' + '00' + '09000000' + 'e8030000' + '00' + '00',
    );
    const w2 = new Writer();
    writeAttackTransferOrder(w2, {
      playerId: 1,
      from: 1,
      to: 2,
      armies: 50,
      mode: AttackTransferMode.Transfer,
      byPercent: true,
      attackTeammates: true,
    });
    expect(hex(w2).slice(0, 8)).toBe('01010201');
  });
});
