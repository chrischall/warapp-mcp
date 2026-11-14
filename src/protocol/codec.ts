// war.app web-client wire codec — the binary frames the browser client POSTs to
// https://war.app/Services?m=<name>&js=1 (as uppercase hex).
//
// Everything is little-endian. Primitives:
//   bool      one byte, strictly 0 or 1 (anything else is a corrupt frame)
//   int16/32/64, float32/64
//   string    bool "present" flag, then a 7-bit varint byte length, then UTF-8
//   datetime  float64 milliseconds since 2000-01-01T00:00:00Z; ±3.4028235e54 are
//             the "no date" (min) and "max date" sentinels, and anything at or
//             beyond ±2.524556148e14 reads as one of them
//   guid      16 bytes in .NET order (first three groups byte-swapped)
//   list/dict int32 count (-1 = null), then the items / key-value pairs; the reader
//             refuses a count above MAX_WIRE_COUNT, and one above MAX_EMPTY_ITEMS
//             whose items take no bytes
//
// A frame starts with a 14-byte header: uint16 flags (protocol version, high bit
// set on replies), int32 preamble 1514664249, int32 message number, int32 method.
// Requests then carry MessageExtrasUp, an optional auth block, and the method's
// parameters. Replies carry a byte (1 → MessageExtrasDown follows), a kind byte
// (5 → a server error {code, message} follows) and the method's result.

export const PREAMBLE = 1514664249;
export const PROTOCOL_VERSION = 242;
const REPLY_FLAG = 0x8000;

/** Milliseconds from the Unix epoch to 2000-01-01T00:00:00Z, the protocol's date epoch. */
export const DATE_EPOCH_MS = Date.UTC(2000, 0, 1);
/** Written for "no date" (.NET DateTime.MinValue on the server). */
export const NO_DATE_SENTINEL = -3.4028235e54;
/** Written for the maximum date. */
const MAX_DATE_SENTINEL = 3.4028235e54;
/** Values at or beyond ± this many ms read as a sentinel. */
const DATE_SENTINEL_THRESHOLD = 2.524556148e14;
/** The decoded form of the max-date sentinel (the largest JS Date). */
export const MAX_DATE = new Date(8.64e15);

/** Envelope kind byte: a MessageExtrasDown block follows. */
const EXTRAS_PRESENT = 1;
/** Envelope kind byte: a server error follows instead of a result. */
const ERROR_KIND = 5;

type ProtocolErrorKind =
  | 'truncated'
  | 'bad-bool'
  | 'bad-preamble'
  | 'bad-varint'
  | 'bad-string'
  | 'bad-length'
  | 'not-a-reply'
  | 'out-of-range';

/** A malformed frame, or a value that cannot be encoded. */
export class ProtocolError extends Error {
  constructor(
    readonly kind: ProtocolErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/**
 * The largest list or dict count a reply may announce. Counts come from the wire as int32, and the
 * biggest real collections (a board's territories, a map's bonuses, a game's orders) run to a few
 * thousand; a million is far past any honest reply and keeps a forged count from driving a
 * multi-billion-iteration loop.
 */
export const MAX_WIRE_COUNT = 1_000_000;

/**
 * The longest list or dict whose items may take no bytes at all. Every real item carries at least a
 * flag or a number; a count above this whose first item read nothing cannot be honest — it would
 * otherwise loop and allocate `count` times from a handful of bytes. The check is per list: nested
 * lists of zero-byte items still multiply (about this many items per four bytes of frame), bounded by
 * the frame's size, and only an interpreted reader can read zero bytes, which the interpreter's step
 * budget bounds.
 */
export const MAX_EMPTY_ITEMS = 1024;

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();
const GUID_ORDER = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15];

function checkInt(value: number, min: number, max: number, what: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ProtocolError('out-of-range', `${what} out of range: ${value}`);
  }
}

export class Writer {
  private buf = new Uint8Array(64);
  private view = new DataView(this.buf.buffer);
  private len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  get length(): number {
    return this.len;
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  u8(value: number): this {
    checkInt(value, 0, 0xff, 'u8');
    this.ensure(1);
    this.buf[this.len++] = value;
    return this;
  }

  raw(bytes: Uint8Array): this {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
    return this;
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  uint16(value: number): this {
    checkInt(value, 0, 0xffff, 'uint16');
    this.ensure(2);
    this.view.setUint16(this.len, value, true);
    this.len += 2;
    return this;
  }

  int16(value: number): this {
    checkInt(value, -0x8000, 0x7fff, 'int16');
    this.ensure(2);
    this.view.setInt16(this.len, value, true);
    this.len += 2;
    return this;
  }

  int32(value: number): this {
    checkInt(value, -0x80000000, 0x7fffffff, 'int32');
    this.ensure(4);
    this.view.setInt32(this.len, value, true);
    this.len += 4;
    return this;
  }

  int64(value: number | bigint): this {
    if (typeof value === 'number') checkInt(value, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'int64');
    const big = BigInt(value);
    if (big < -(1n << 63n) || big >= 1n << 63n) throw new ProtocolError('out-of-range', `int64 out of range: ${big}`);
    this.ensure(8);
    this.view.setBigInt64(this.len, big, true);
    this.len += 8;
    return this;
  }

  float32(value: number): this {
    this.ensure(4);
    this.view.setFloat32(this.len, value, true);
    this.len += 4;
    return this;
  }

  float64(value: number): this {
    this.ensure(8);
    this.view.setFloat64(this.len, value, true);
    this.len += 8;
    return this;
  }

  varint(value: number): this {
    checkInt(value, 0, 0xffffffff, 'varint');
    let n = value;
    for (;;) {
      const low = n % 128;
      n = Math.floor(n / 128);
      this.u8(n > 0 ? low | 0x80 : low);
      if (n === 0) return this;
    }
  }

  /** A nullable string: present flag, varint byte length, UTF-8. */
  string(value: string | null): this {
    if (value === null) return this.bool(false);
    const encoded = utf8Encoder.encode(value);
    return this.bool(true).varint(encoded.length).raw(encoded);
  }

  /** A datetime; null is the "no date" sentinel. */
  date(value: Date | null): this {
    if (value === null) return this.float64(NO_DATE_SENTINEL);
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new ProtocolError('out-of-range', 'invalid Date');
    if (ms >= MAX_DATE.getTime()) return this.float64(MAX_DATE_SENTINEL);
    return this.float64(ms - DATE_EPOCH_MS);
  }

  /** A GUID from its 32-hex-digit form (dashes allowed), written in .NET byte order. */
  guid(value: string): this {
    const hex = value.replace(/-/g, '');
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new ProtocolError('out-of-range', `not a guid: ${value}`);
    const canonical = Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
    const out = new Uint8Array(16);
    GUID_ORDER.forEach((src, i) => {
      out[src] = canonical[i]!;
    });
    return this.raw(out);
  }

  /** A nullable list: int32 count (-1 = null), then each item. */
  list<T>(items: readonly T[] | null, writeItem: (w: Writer, item: T) => void): this {
    if (items === null) return this.int32(-1);
    this.int32(items.length);
    for (const item of items) writeItem(this, item);
    return this;
  }

  /** A nullable dict: int32 count (-1 = null), then key, value pairs. */
  dict<K, V>(
    entries: ReadonlyMap<K, V> | null,
    writeKey: (w: Writer, key: K) => void,
    writeValue: (w: Writer, value: V) => void,
  ): this {
    if (entries === null) return this.int32(-1);
    this.int32(entries.size);
    for (const [k, v] of entries) {
      writeKey(this, k);
      writeValue(this, v);
    }
    return this;
  }
}

export class Reader {
  private readonly view: DataView;
  private pos: number;

  constructor(
    private readonly buf: Uint8Array,
    offset = 0,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = offset;
  }

  get position(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new ProtocolError('truncated', `read past end: need ${n} byte(s) at offset ${this.pos} of ${this.buf.length}`);
    }
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  /**
   * `n` bytes. `n` often comes from the wire (a string or byte-array length), so anything but a
   * non-negative integer is refused before the position moves: a negative length would rewind the
   * reader and a NaN or fractional one would leave every later read misaligned.
   */
  raw(n: number): Uint8Array {
    if (!Number.isInteger(n) || n < 0) {
      throw new ProtocolError('bad-length', `bad byte count ${n} at offset ${this.pos}`);
    }
    this.need(n);
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new ProtocolError('bad-bool', `bad bool ${v} at offset ${this.pos - 1}`);
    return v === 1;
  }

  uint16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  int16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  int32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** An int64 as a number (exact up to 2^53). */
  int64(): number {
    this.need(8);
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return Number(v);
  }

  float32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  float64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  varint(): number {
    let n = 0;
    let scale = 1;
    for (let i = 0; i < 5; i++) {
      const c = this.u8();
      n += (c & 0x7f) * scale;
      if (!(c & 0x80)) return n;
      scale *= 128;
    }
    throw new ProtocolError('bad-varint', `varint longer than 5 bytes ending at offset ${this.pos}`);
  }

  string(): string | null {
    if (!this.bool()) return null;
    const start = this.pos;
    const n = this.varint();
    const bytes = this.raw(n);
    try {
      return utf8Decoder.decode(bytes);
    } catch {
      throw new ProtocolError('bad-string', `invalid UTF-8 in string at offset ${start}`);
    }
  }

  /** A datetime; the "no date" sentinel reads as null, the max sentinel as MAX_DATE. */
  date(): Date | null {
    const ms = this.float64();
    if (ms <= -DATE_SENTINEL_THRESHOLD) return null;
    if (ms >= DATE_SENTINEL_THRESHOLD) return MAX_DATE;
    return new Date(DATE_EPOCH_MS + ms);
  }

  /** A GUID as 32 lowercase hex digits in canonical order. */
  guid(): string {
    const b = this.raw(16);
    return GUID_ORDER.map((i) => b[i]!.toString(16).padStart(2, '0')).join('');
  }

  private count(): number | null {
    const at = this.pos;
    const n = this.int32();
    if (n === -1) return null;
    if (!Number.isInteger(n) || n < 0) throw new ProtocolError('bad-length', `bad count ${n} at offset ${at}`);
    if (n > MAX_WIRE_COUNT) {
      throw new ProtocolError('bad-length', `count ${n} at offset ${at} exceeds ${MAX_WIRE_COUNT}`);
    }
    return n;
  }

  /** Refuses a long collection once an item is seen to take no bytes (see MAX_EMPTY_ITEMS). */
  private checkItemSize(n: number, before: number, at: number): void {
    if (n > MAX_EMPTY_ITEMS && this.pos === before) {
      throw new ProtocolError(
        'bad-length',
        `count ${n} at offset ${at} of items that take no bytes (at most ${MAX_EMPTY_ITEMS})`,
      );
    }
  }

  list<T>(readItem: (r: Reader) => T): T[] | null {
    const at = this.pos;
    const n = this.count();
    if (n === null) return null;
    const out: T[] = [];
    for (let i = 0; i < n; i++) {
      const before = this.pos;
      out.push(readItem(this));
      this.checkItemSize(n, before, at);
    }
    return out;
  }

  dict<K, V>(readKey: (r: Reader) => K, readValue: (r: Reader) => V): Map<K, V> | null {
    const at = this.pos;
    const n = this.count();
    if (n === null) return null;
    const out = new Map<K, V>();
    for (let i = 0; i < n; i++) {
      const before = this.pos;
      const k = readKey(this);
      out.set(k, readValue(this));
      this.checkItemSize(n, before, at);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Header and extras

interface FrameHeader {
  version: number;
  reply: boolean;
  msgNum: number;
  method: number;
}

function writeHeader(w: Writer, h: FrameHeader): void {
  w.uint16((h.version & 0x7fff) | (h.reply ? REPLY_FLAG : 0))
    .int32(PREAMBLE)
    .int32(h.msgNum)
    .int32(h.method);
}

export function readHeader(r: Reader): FrameHeader {
  const flags = r.uint16();
  const preamble = r.int32();
  if (preamble !== PREAMBLE) {
    throw new ProtocolError('bad-preamble', `bad preamble ${preamble} (expected ${PREAMBLE})`);
  }
  return { version: flags & 0x7fff, reply: (flags & REPLY_FLAG) !== 0, msgNum: r.int32(), method: r.int32() };
}

/** warlight.shared.MessageExtrasUp — sent ahead of every request's parameters. */
export interface ExtrasUp {
  /** Optional int → string map (minified `my`); the browser sends it present and empty. */
  dict: ReadonlyMap<number, string> | null;
  /** Client version string, e.g. "v6.07.0.1". */
  client: string | null;
  /** Echoed from the last reply's ServerInfoForClient (minified `ZR`). */
  serverInfoVersionA: number;
  /** Echoed from the last reply's ServerInfoForClient (minified `YL`). */
  serverInfoVersionB: number;
  /** A client date of unknown purpose (minified `fDb`). */
  fDb: Date | null;
  /** Echoed from the last reply's UnreadMailCheckResults date (minified `kFa`). */
  kFa: Date | null;
  /** EnumSerialization_Platform as int32. */
  platform: number;
}

const writeIntStringDict = (w: Writer, d: ReadonlyMap<number, string> | null): void => {
  if (d === null) {
    w.bool(false);
    return;
  }
  w.bool(true).dict(
    d,
    (ww, k) => ww.int32(k),
    (ww, v) => ww.string(v),
  );
};

const readIntStringDict = (r: Reader): Map<number, string | null> | null =>
  r.bool()
    ? r.dict(
        (rr) => rr.int32(),
        (rr) => rr.string(),
      )
    : null;

function writeExtrasUp(w: Writer, e: ExtrasUp): void {
  writeIntStringDict(w, e.dict);
  w.string(e.client)
    .int32(e.serverInfoVersionA)
    .int32(e.serverInfoVersionB)
    .date(e.fDb)
    .date(e.kFa)
    .int32(e.platform);
}

export function readExtrasUp(r: Reader): ExtrasUp {
  const dict = readIntStringDict(r);
  return {
    dict: dict === null ? null : new Map([...dict].map(([k, v]) => [k, v ?? ''])),
    client: r.string(),
    serverInfoVersionA: r.int32(),
    serverInfoVersionB: r.int32(),
    fDb: r.date(),
    kFa: r.date(),
    platform: r.int32(),
  };
}

/** warlight.shared.Livestream. */
interface Livestream {
  j7: string | null;
  jdb: number;
  lr: Date | null;
  zfd: string | null;
  yfd: string | null;
}

/** warlight.shared.ServerInfoForClient. */
interface ServerInfo {
  okb: string | null;
  /** Leaderboard flags, ';'-separated (minified `YR`). */
  lbFlags: string | null;
  serverInfoVersionA: number;
  livestream: Livestream | null;
  serverInfoVersionB: number;
}

/** warlight.shared.UnreadMailCheckResults. */
interface UnreadMail {
  cYa: boolean;
  /** Becomes the next request's ExtrasUp.kFa (minified `I0a`). */
  kFa: Date | null;
  h9: boolean;
}

/** warlight.shared.MessageExtrasDown — piggybacked on replies. */
export interface ExtrasDown {
  cAa: ReadonlyMap<number, string | null> | null;
  wca: number | null;
  c2a: string | null;
  serverInfo: ServerInfo | null;
  j9: ReadonlyMap<number, Array<string | null> | null> | null;
  unreadMail: UnreadMail | null;
}

function optional<T>(r: Reader, read: (r: Reader) => T): T | null {
  return r.bool() ? read(r) : null;
}

function writeOptional<T>(w: Writer, value: T | null, write: (w: Writer, v: T) => void): void {
  if (value === null) {
    w.bool(false);
    return;
  }
  w.bool(true);
  write(w, value);
}

function readExtrasDown(r: Reader): ExtrasDown {
  return {
    cAa: readIntStringDict(r),
    wca: optional(r, (rr) => rr.int32()),
    c2a: r.string(),
    serverInfo: optional(r, (rr) => ({
      okb: rr.string(),
      lbFlags: rr.string(),
      serverInfoVersionA: rr.int32(),
      livestream: optional(rr, (l) => ({
        j7: l.string(),
        jdb: l.int32(),
        lr: l.date(),
        zfd: l.string(),
        yfd: l.string(),
      })),
      serverInfoVersionB: rr.int32(),
    })),
    j9: optional(r, (rr) =>
      rr.dict(
        (k) => k.int32(),
        (v) => optional(v, (vv) => vv.list((s) => s.string())),
      ),
    ),
    unreadMail: optional(r, (rr) => ({ cYa: rr.bool(), kFa: rr.date(), h9: rr.bool() })),
  };
}

function writeExtrasDown(w: Writer, e: ExtrasDown): void {
  writeOptional(w, e.cAa, (ww, d) =>
    ww.dict(
      d,
      (x, k) => x.int32(k),
      (x, v) => x.string(v),
    ),
  );
  writeOptional(w, e.wca, (ww, v) => ww.int32(v));
  w.string(e.c2a);
  writeOptional(w, e.serverInfo, (ww, s) => {
    ww.string(s.okb).string(s.lbFlags).int32(s.serverInfoVersionA);
    writeOptional(ww, s.livestream, (x, l) => x.string(l.j7).int32(l.jdb).date(l.lr).string(l.zfd).string(l.yfd));
    ww.int32(s.serverInfoVersionB);
  });
  writeOptional(w, e.j9, (ww, d) =>
    ww.dict(
      d,
      (x, k) => x.int32(k),
      (x, v) => writeOptional(x, v, (y, list) => y.list(list, (z, s) => z.string(s))),
    ),
  );
  writeOptional(w, e.unreadMail, (ww, u) => ww.bool(u.cYa).date(u.kFa).bool(u.h9));
}

// ---------------------------------------------------------------------------
// Requests

/** The auth block's type tag, as the browser client writes it before the email. */
const AUTH_TAG = 4;

interface RequestFrame {
  method: number;
  msgNum: number;
  extras: ExtrasUp;
  /**
   * The signed-in account's email for methods whose first parameter is the
   * auth block; null for methods that take none (e.g. GetMapDetails), in which
   * case no auth bytes are written at all.
   */
  email: string | null;
  /** Writes the method's own parameters. */
  params?: (w: Writer) => void;
  version?: number;
}

export function encodeRequest(frame: RequestFrame): Uint8Array {
  const w = new Writer();
  writeHeader(w, {
    version: frame.version ?? PROTOCOL_VERSION,
    reply: false,
    msgNum: frame.msgNum,
    method: frame.method,
  });
  writeExtrasUp(w, frame.extras);
  if (frame.email !== null) w.bool(true).u8(AUTH_TAG).string(frame.email);
  frame.params?.(w);
  return w.bytes();
}

export interface DecodedRequest extends FrameHeader {
  extras: ExtrasUp;
  email: string | null;
  /** Positioned at the method's own parameters. */
  body: Reader;
}

/**
 * Decode a request frame (for tests and mock servers). `hasAuth` says whether
 * the method takes the auth block — the frame itself does not say.
 */
export function decodeRequest(bytes: Uint8Array, opts: { hasAuth: boolean }): DecodedRequest {
  const r = new Reader(bytes);
  const header = readHeader(r);
  if (header.reply) throw new ProtocolError('not-a-reply', 'expected a request frame, got a reply');
  const extras = readExtrasUp(r);
  let email: string | null = null;
  if (opts.hasAuth && r.bool()) {
    r.u8();
    email = r.string();
  }
  return { ...header, extras, email, body: r };
}

// ---------------------------------------------------------------------------
// Replies

export interface ServerError {
  code: number;
  message: string | null;
}

export interface ReplyEnvelope {
  version: number;
  method: number;
  msgNum: number;
  extrasDown?: ExtrasDown;
  error?: ServerError;
  /** Positioned at the method's result (after the kind byte). */
  body: Reader;
}

export function decodeReplyEnvelope(bytes: Uint8Array): ReplyEnvelope {
  const r = new Reader(bytes);
  const header = readHeader(r);
  if (!header.reply) throw new ProtocolError('not-a-reply', `frame for method ${header.method} is not a reply`);
  const env: ReplyEnvelope = { version: header.version, method: header.method, msgNum: header.msgNum, body: r };
  if (r.u8() === EXTRAS_PRESENT) env.extrasDown = readExtrasDown(r);
  if (r.u8() === ERROR_KIND) env.error = { code: r.int32(), message: r.string() };
  return env;
}

export interface ReplyFrame {
  method: number;
  msgNum: number;
  extrasDown?: ExtrasDown;
  error?: ServerError;
  /** Writes the result (only when there is no error). */
  body?: (w: Writer) => void;
  version?: number;
}

/** Encode a reply frame (for tests and mock servers). */
export function encodeReply(frame: ReplyFrame): Uint8Array {
  const w = new Writer();
  writeHeader(w, {
    version: frame.version ?? PROTOCOL_VERSION,
    reply: true,
    msgNum: frame.msgNum,
    method: frame.method,
  });
  if (frame.extrasDown) {
    w.u8(EXTRAS_PRESENT);
    writeExtrasDown(w, frame.extrasDown);
  } else {
    w.u8(0);
  }
  if (frame.error) {
    w.u8(ERROR_KIND).int32(frame.error.code).string(frame.error.message);
  } else {
    w.u8(0);
    frame.body?.(w);
  }
  return w.bytes();
}

/** Bytes → uppercase hex, the form the client POSTs. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new ProtocolError('bad-length', 'not an even-length hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
