import { describe, expect, it } from 'vitest';
import { DATE_EPOCH_MS, NO_DATE_SENTINEL, Reader, Writer } from '../../src/protocol/codec.js';
import { BundleInterpreter, InterpError, parseBundle } from '../../src/protocol/interp.js';
import { MINI_BUNDLE } from './mini-bundle.js';

const GUID = '00112233445566778899aabbccddeeff';
const WHEN = new Date(DATE_EPOCH_MS + 86_400_000);

function boardBytes(version: number): Uint8Array {
  const w = new Writer();
  w.string('Alpha');
  w.bool(true).int32(1).int32(2); // origin
  w.bool(true).int32(2).bool(true).int32(3).int32(4).bool(false); // points: [Pt(3,4), null]
  w.bool(true).int32(1).int32(7).string('neutral'); // owners
  w.bool(true).int32(5); // army: fogged, 5
  if (version >= 240) w.int32(99); // extra
  w.u8(3); // kind
  w.u8(2).int32(6); // shape: square side 6
  w.int32(2).int32(10).int32(11); // ids
  w.date(WHEN);
  w.guid(GUID);
  w.float64(0.6); // P.ak reads a float64 (kill rates, luck)
  w.uint16(65535);
  w.int32(2).raw(new Uint8Array([0xab, 0xcd]));
  w.bool(true);
  return w.bytes();
}

const interp = (opts?: ConstructorParameters<typeof BundleInterpreter>[1]) =>
  new BundleInterpreter(parseBundle(MINI_BUNDLE), opts);

function interpError(fn: () => unknown): InterpError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(InterpError);
    return e as InterpError;
  }
  throw new Error('expected an InterpError');
}

describe('parseBundle', () => {
  it('indexes class registrations both ways', () => {
    const b = parseBundle(MINI_BUNDLE);
    expect(b.typeNameOf.get('Bd')).toBe('demo.shared.Board');
    expect(b.varOf.get('warlight.shared.LatestGameInfo')).toBe('NE');
  });

  it('keeps the first registration of a var', () => {
    const b = parseBundle('W["a.First"]=X;W["a.Second"]=X;');
    expect(b.typeNameOf.get('X')).toBe('a.First');
  });
});

describe('BundleInterpreter', () => {
  it('reads every construct of a nested class and consumes every byte', () => {
    const r = new Reader(boardBytes(242));
    const calls: string[] = [];
    const v = interp({ trace: (k) => calls.push(k) }).readClass('demo.shared.Board', r);
    expect(r.remaining).toBe(0);
    expect(v).toEqual({
      $type: 'demo.shared.Board',
      name: 'Alpha',
      origin: { $type: 'demo.shared.Point', x: 1, y: 2 },
      points: [{ $type: 'demo.shared.Point', x: 3, y: 4 }, null],
      owners: [[7, 'neutral']],
      army: { $type: 'demo.shared.Army', n: 5, fog: true, tag: '{}' },
      extra: 99,
      kind: 3,
      shape: { $type: 'demo.shared.Square', side: 6 },
      round: false,
      square: true,
      ids: [10, 11],
      when: WHEN,
      id: GUID,
      big: 0.6,
      u16: 65535,
      blob: new Uint8Array([0xab, 0xcd]),
      flag: true,
    });
    expect(calls).toContain('Bd.rd');
    expect(calls).toContain('Pt.rd');
  });

  it('honours version checks', () => {
    const r = new Reader(boardBytes(200));
    const v = interp({ version: 200 }).readClass('demo.shared.Board', r) as Record<string, unknown>;
    expect(v.extra).toBeNull();
    expect(r.remaining).toBe(0);
  });

  it('accepts a var name and passes the protocol version', () => {
    const r = new Reader(new Writer().int32(4).bytes());
    expect(interp().readClass('NE', r)).toEqual({ $type: 'warlight.shared.LatestGameInfo', turn: 4, ver: 242 });
  });

  it('switches on a type tag with fall-through, break and instanceof', () => {
    const i = interp();
    const circle = i.readClass('demo.shared.Shape', new Reader(new Writer().u8(1).float32(1.5).bytes()));
    expect(circle).toEqual({ $type: 'demo.shared.Circle', r: 1.5 });
    const sq = i.readClass('demo.shared.Shape', new Reader(new Writer().u8(3).bytes()));
    expect(sq).toEqual({ $type: 'demo.shared.Square', side: -1 });
    const e = interpError(() => i.readClass('demo.shared.Shape', new Reader(new Writer().u8(9).bytes())));
    expect(e.kind).toBe('reader-threw');
    expect(e.message).toContain('unknown shape tag');
    expect(e.where).toBe('Sh.Ha');
  });

  it('evaluates operators, closures, wrappers and reader methods', () => {
    const w = new Writer().int32(3);
    w.u8(1).u8(2).u8(3); // E.Range mapped
    w.int32(-7).u8(200);
    w.varint(2).raw(new TextEncoder().encode('hi'));
    w.float64(42.5).float32(0.5).uint16(7).int16(-2).u8(9).raw(new Uint8Array([1, 2])).varint(300);
    w.float64(259_200_000).int32(1).int32(8).int32(-1).int32(-1).float64(NO_DATE_SENTINEL);
    const r = new Reader(w.bytes());
    const d = interp().readClass('demo.shared.Ops', r) as Record<string, unknown>;
    expect(r.remaining).toBe(0);
    expect(d).toMatchObject({
      sum: 5, diff: 1, prod: 6, bor: 3, band: 1, neg: -3, not: false, v: undefined, u: undefined,
      eq: true, ne: false, seq: true, sne: false, lt: false, le: true, gt: false, ge: true,
      or: 3, and: 7, andf: 0, seqv: 9, dbl: 6, pre: 4, post: 4, after: 3, w: 5, wn: null, arr: [],
      r: [1, 3, 5],
      raw: [-7, 200, 'hi', 42.5, 0.5, 7, -2, 9, new Uint8Array([1, 2]), 300],
      more: [259_200_000, [8], null, null, null],
      len: 10, id: 4, branch: 'else',
    });
  });

  it('keeps a constructor failure on the object instead of aborting the read', () => {
    const v = interp().readClass('demo.shared.BadCtor', new Reader(new Uint8Array())) as Record<string, unknown>;
    expect(v.$type).toBe('demo.shared.BadCtor');
    expect(String(v.$ctorError)).toContain('deeper of undefined in new Bk');
  });

  it('rejects an unknown type name', () => {
    const e = interpError(() => interp().readClass('demo.shared.Nope', new Reader(new Uint8Array())));
    expect(e.kind).toBe('unknown-class');
  });

  it.each([
    ['demo.shared.Loop', 'unsupported', 'WhileStatement', 'while'],
    ['demo.shared.BadMethod', 'unsupported', 'reader method Zq', 'a.Zq()'],
    ['demo.shared.NullMember', 'bad-value', 'x of null', 'b.x'],
    ['demo.shared.ObjLit', 'unsupported', 'ObjectExpression', '{}'],
    ['demo.shared.ReaderRef', 'unsupported', 'reader member Ua', 'a.Ua'],
    ['demo.shared.CallNum', 'unsupported', 'call of a non-function', 'b()'],
    ['demo.shared.CallObj', 'unsupported', 'call foo', 'b.foo()'],
    ['demo.shared.Compound', 'unsupported', '+=', 'b+=1'],
  ])('reports %s as %s with its location', (type, kind, text, at) => {
    const bundle = parseBundle(MINI_BUNDLE);
    const e = interpError(() => new BundleInterpreter(bundle).readClass(type, new Reader(new Uint8Array([1]))));
    expect(e.kind).toBe(kind);
    expect(e.message).toContain(text);
    expect(e.where).toMatch(/\.Ha$/);
    expect(e.message).toContain(e.where);
    expect(e.offset).toBeTypeOf('number');
    expect(bundle.src.slice(e.offset)).toMatch(new RegExp('^' + at.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('reports a static with no definition', () => {
    const e = interpError(() => interp().readClass('demo.shared.Missing', new Reader(new Uint8Array())));
    expect(e.kind).toBe('no-definition');
    expect(e.message).toContain('Nx.Ha');
  });

  it('stops a runaway loop', () => {
    const e = interpError(() => interp({ maxIterations: 50 }).readClass('demo.shared.Spin', new Reader(new Uint8Array())));
    expect(e.kind).toBe('loop-guard');
  });

  it('propagates codec errors from the bytes', () => {
    expect(() => interp().readClass('demo.shared.Board', new Reader(new Uint8Array([1])))).toThrow(/read past end|truncated/);
  });

  it('rejects a negative byte-array length', () => {
    const custom = parseBundle('W["d.B"]=Bb;Bb.Ha=function(a){return P.sL(a)};');
    expect(() => new BundleInterpreter(custom).readClass('d.B', new Reader(new Writer().int32(-5).bytes()))).toThrow(
      /negative/,
    );
  });

  it('caches resolved functions', () => {
    const i = interp();
    const read = () => i.readClass('demo.shared.Point', new Reader(new Writer().int32(1).int32(2).bytes()));
    expect(read()).toEqual(read());
  });
  it('hoists var declarations: a var declared in an untaken branch reads as undefined (#131)', () => {
    const b = parseBundle(
      'W["t.Hx"]=Hx;Hx.Ha=function(a,b,d){if(P.Yc(a))var f=P.Ya(a);var e=new Hx;e.v=null!=f?f:-1;e.w=f?1:0;' +
        'for(var i=0;2>i;i++){var g;if(0==i)g=5}e.g=g;return e};',
    );
    const i = new BundleInterpreter(b);
    expect(i.readClass('t.Hx', new Reader(new Writer().bool(false).bytes()))).toEqual({ $type: 't.Hx', v: -1, w: 0, g: 5 });
    expect(i.readClass('t.Hx', new Reader(new Writer().bool(true).int32(7).bytes()))).toEqual({ $type: 't.Hx', v: 7, w: 1, g: 5 });
  });

  it('caches a failed static lookup instead of rescanning the bundle (#131)', () => {
    const parsed = parseBundle('W["t.Q"]=Qq;Qq.Ha=function(a){return Qq.nope(a)};');
    let scans = 0;
    const src = parsed.src;
    Object.defineProperty(parsed, 'src', {
      get: () => {
        scans++;
        return src;
      },
    });
    const i = new BundleInterpreter(parsed);
    const read = () => interpError(() => i.readClass('t.Q', new Reader(new Uint8Array())));
    expect(read().kind).toBe('no-definition');
    const after = scans;
    expect(read().kind).toBe('no-definition');
    expect(scans).toBe(after);
  });


  it('reports an unbalanced function body', () => {
    const b = parseBundle('W["d.U"]=Uu;Uu.Ha=function(a){return "}"');
    const e = interpError(() => new BundleInterpreter(b).readClass('d.U', new Reader(new Uint8Array())));
    expect(e.kind).toBe('parse');
  });

  it('lets a dialect override primitives', () => {
    const b = parseBundle('W["d.Q"]=Qq;Qq.Ha=function(a){return Q2.zz(a)};');
    const i = new BundleInterpreter(b, { dialect: { statics: { Q2: { zz: () => 'custom' } } } });
    expect(i.readClass('d.Q', new Reader(new Uint8Array()))).toBe('custom');
  });
});
