// The dialect is derived from the bundle's structure (#340): every war.app build renames the reader's
// methods and helpers, hotfixes included. These synthetic clients have the shape of war.app's generated
// code (a haxe Input, a BinaryReader over it, the Serializer helpers, SharedUtility's date and guid
// readers, MessagePump's identity, Enumerable's Range/Select/ToArray, the wrapper classes) with two
// made-up name sets; every name and value is invented, nothing is taken from the real bundle.
import { describe, expect, it } from 'vitest';
import { Reader, Writer } from '../../src/protocol/codec.js';
import { canonicalize, deriveDialect, SERIALIZER_TEMPLATES } from '../../src/protocol/dialect.js';
import { BundleInterpreter, parseBundle } from '../../src/protocol/interp.js';
import { BundleError, WarappBundle } from '../../src/protocol/bundle.js';

interface Names {
  input: string;
  bytesInput: string;
  reader: string;
  ser: string;
  util: string;
  pump: string;
  en: string;
  // Input methods
  readByte: string;
  i32: string;
  i16: string;
  u16: string;
  f32: string;
  f64: string;
  // BinaryReader methods
  varint: string;
  raw: string;
  int32: string;
  bool: string;
  u8a: string;
  u8b: string;
  str: string;
  rf64: string;
  rf32: string;
  ru16: string;
  ri16: string;
  // Serializer helpers
  h: Record<'int32' | 'string' | 'bool' | 'u8' | 'f32' | 'f64' | 'ts' | 'date' | 'guid' | 'u16' | 'bytes' | 'listPush' | 'listIdx' | 'listSet' | 'dict', string>;
  // SharedUtility
  date: string;
  guid: string;
  parseLong: string;
  // wrappers
  nint: string;
  ts: string;
  dt: string;
  // the class read
  lgi: string;
  protocol: number;
}

const A: Names = {
  input: 'In1', bytesInput: 'Bi1', reader: 'Br1', ser: 'P', util: 'O', pump: 'za', en: 'E',
  readByte: 'rbA', i32: 'riA', i16: 'rsA', u16: 'ruA', f32: 'rfA', f64: 'rdA',
  varint: 'vA', raw: 'xA', int32: 'iA', bool: 'bA', u8a: 'uA', u8b: 'uB', str: 'sA', rf64: 'dA', rf32: 'fA', ru16: 'wA', ri16: 'hA',
  h: { int32: 'Ya', string: 'wc', bool: 'Yc', u8: 'uq', f32: 'Ao', f64: 'ak', ts: 'uy', date: 'Td', guid: 'tL', u16: 'Z5', bytes: 'sL', listPush: 'Sd', listIdx: 'ms', listSet: 'uL', dict: 'ef' },
  date: 'Nd1', guid: 'Qg1', parseLong: 'pL1',
  nint: 'Z', ts: 'Ts1', dt: 'Dt1', lgi: 'Lg1', protocol: 242,
};

const B: Names = {
  input: 'Qx9', bytesInput: 'Kk', reader: 'Mu', ser: 'Sr', util: 'Ut', pump: 'Mp', en: 'D',
  readByte: 'ZQ', i32: 'wza', i16: 'Dyd', u16: 'Eyd', f32: 'Cyd', f64: 'Byd',
  varint: 'N6c', raw: 'bT', int32: 'Tg', bool: 'Ua', u8a: 'JIb', u8b: 'bc', str: 'WJ', rf64: 'b5a', rf32: 'Wm', ru16: 'KIb', ri16: 'X6c',
  h: { int32: 'Ya', string: 'tc', bool: '$c', u8: 'cq', f32: 'Go', f64: 'dk', ts: 'My', date: 'Wd', guid: 'LL', u16: 'G6', bytes: 'KL', listPush: 'Jd', listIdx: 'vs', listSet: 'ML', dict: 'ff' },
  date: 'S6c', guid: 'V6c', parseLong: 'vw',
  nint: 'Zq', ts: 'dcT', dt: 'fcD', lgi: 'Lg9', protocol: 243,
};

/** A synthetic client in war.app's shape, with the given names. */
function client(n: Names, opts: { dropReader?: boolean; dropBool?: boolean } = {}): string {
  const tryRet = (body: string) => `function(){try{return ${body}}catch(a){if(Y.Nb(a).unwrap()instanceof XA)throw Y.sa(new Gy);throw a;}}`;
  const h = n.h;
  const lines = [
    `W["haxe.io.Input"]=${n.input};${n.input}.aa="haxe.io.Input";${n.input}.prototype={` +
      `${n.readByte}:function(){throw new SQ(null,null,{fileName:"haxe/io/Input.hx",lineNumber:53,className:"haxe.io.Input",methodName:"readByte"});},` +
      `${n.f32}:function(){return wt.Fl(this.${n.i32}())},` +
      `${n.f64}:function(){var a=this.${n.i32}(),b=this.${n.i32}();return this.big?wt.Db(b,a):wt.Db(a,b)},` +
      `${n.i16}:function(){var a=this.${n.readByte}(),b=this.${n.readByte}();a=this.big?b|a<<8:a|b<<8;return 0!=(a&32768)?a-65536:a},` +
      `${n.u16}:function(){var a=this.${n.readByte}(),b=this.${n.readByte}();return this.big?b|a<<8:a|b<<8},` +
      `${n.i32}:function(){var a=this.${n.readByte}(),b=this.${n.readByte}(),d=this.${n.readByte}(),e=this.${n.readByte}();return this.big?e|d<<8|b<<16|a<<24:a|b<<8|d<<16|e<<24},va:${n.input}};`,
    `W["haxe.io.BytesInput"]=${n.bytesInput};${n.bytesInput}.prototype=Fa(${n.input}.prototype,{${n.readByte}:function(){return this.b[this.pos++]},va:${n.bytesInput}});`,
  ];
  if (!opts.dropReader) {
    const methods = [
      `${n.varint}:function(){for(var a,b=0,d=0;;){if(35==d)throw Y.sa(new Pa("Bad format"));a=this.${n.u8b}();b|=(a&127)<<d;d+=7;if(0==(a&128))break}return b}`,
      `${n.raw}:function(a){try{for(var b=new Nl(new ArrayBuffer(a)),d=0;d<a;){var e=this.${n.u8a}();b.b[d++]=e}return b}catch(f){throw f;}}`,
      `${n.int32}:${tryRet(`this.q.${n.i32}()`)}`,
      `${n.ru16}:${tryRet(`this.q.${n.u16}()`)}`,
      `${n.ri16}:${tryRet(`this.q.${n.i16}()`)}`,
      `${n.str}:function(){try{var a=this.${n.varint}(),b=this.${n.raw}(a);return b.dec(0,b.length)}catch(d){throw d;}}`,
      opts.dropBool ? '' : `${n.bool}:${tryRet(`0!=this.q.${n.readByte}()`)}`,
      `${n.rf64}:${tryRet(`this.q.${n.f64}()`)}`,
      `${n.rf32}:${tryRet(`this.q.${n.f32}()`)}`,
      `${n.u8b}:${tryRet(`this.${n.u8a}()`)}`,
      `${n.u8a}:function(){return this.q.${n.readByte}()}`,
      `xc:function(){}`,
    ].filter(Boolean);
    lines.push(`W["system.io.BinaryReader"]=${n.reader};${n.reader}.aa="system.io.BinaryReader";${n.reader}.prototype={${methods.join(',')},va:${n.reader}};`);
  }
  lines.push(
    `W["system.Nullable_Int"]=${n.nint};function ${n.nint}(a){this.v=a}`,
    `W["system.TimeSpan"]=${n.ts};function ${n.ts}(a){this.ms=a}`,
    `W["system.DateTime"]=${n.dt};function ${n.dt}(a){this.t=a}`,
    `W["system.CsRef"]=Cr1;function Cr1(a){this.fa=a}`,
    `W["system.collections.generic.Dictionary"]=Dc1;function Dc1(a){}`,
    `W["system.collections.generic.HashSet"]=Hs1;function Hs1(){}`,
    `W["warlight.shared.Assert"]=ta;`,
    `W["warlight.shared.SharedUtility"]=${n.util};`,
    `${n.util}.${n.parseLong}=function(a){if(null==a)throw Y.sa(new bx("ParseLongSafe(null)"));return parseFloat(a)};`,
    `${n.util}.Fz=function(a,b,d){var e=new Cr1(null);return a.Vg(b,e)?e.fa:d};`,
    `${n.util}.${n.date}=function(a){a=a.${n.rf64}();return 2524556148E5<=a?new ${n.dt}(3155378976E9):-2524556148E5>=a?new ${n.dt}(0):new ${n.dt}(a+${n.util}.ep)};`,
    `${n.util}.ep=946684800000;`,
    `${n.util}.${n.guid}=function(a){a=a.${n.raw}(16);for(var b="",d=0;d<16;)b+=a.b[d++];return b};`,
    `W["warlight.shared.MessagePump"]=${n.pump};${n.pump}.rc=function(a){return a};`,
    `W["system.linq.Enumerable"]=${n.en};${n.en}.Range=function(a,b){for(var d=[],e=0;e<b;){var f=e++;d[f]=f+a}return d};`,
    `${n.en}.Za=function(a,b){for(var d=[],e=0;e<a.length;){var f=a[e];++e;d.push(b(f))}return d};`,
    `${n.en}.Sa=function(a){for(var b=[],d=0;d<a.length;){var e=a[d];++d;b.push(e)}return b};`,
    `W["warlight.shared.Serializer"]=${n.ser};${n.ser}.aa="warlight.shared.Serializer";`,
    `${n.ser}.wbx=function(a,b){b.pk(a)};`,
    `${n.ser}.${h.u16}=function(a){return a.${n.ru16}()};`,
    `${n.ser}.${h.int32}=function(a){return a.${n.int32}()};`,
    `${n.ser}.${h.string}=function(a){return a.${n.bool}()?a.${n.str}():null};`,
    `${n.ser}.${h.guid}=function(a){return ${n.util}.${n.guid}(a)};`,
    `${n.ser}.${h.f64}=function(a){return a.${n.rf64}()};`,
    `${n.ser}.${h.date}=function(a){return ${n.util}.${n.date}(a)};`,
    `${n.ser}.${h.bool}=function(a){return a.${n.bool}()};`,
    `${n.ser}.${h.u8}=function(a){return a.${n.u8b}()};`,
    `${n.ser}.${h.f32}=function(a){return a.${n.rf32}()};`,
    `${n.ser}.${h.ts}=function(a){a=a.${n.rf64}();return-922336666814565>=a?${n.ts}.mn:922336666814565<=a?${n.ts}.mx:new ${n.ts}(a)};`,
    `${n.ser}.${h.bytes}=function(a){var b=a.${n.int32}();return-1==b?null:a.${n.raw}(b)};`,
    `${n.ser}.${h.dict}=function(a,b,d){a=a.${n.int32}();if(-1==a)return null;for(var e=new Dc1(a),f=0;f<a;){var g=b();ta.Da(!e.jb(g),"Dupe keys deserialized");e.U(g,d());++f}return e};`,
    `${n.ser}.${h.listPush}=function(a,b){a=a.${n.int32}();if(-1==a)return null;for(var d=[],e=0;e<a;)d.push(b()),++e;return d};`,
    `${n.ser}.${h.listSet}=function(a,b){a=a.${n.int32}();if(-1==a)return null;for(var d=new Hs1,e=0;e<a;)d.U(b()),++e;return d};`,
    `${n.ser}.${h.listIdx}=function(a,b){a=a.${n.int32}();if(-1==a)return null;for(var d=[],e=0;e<a;)d[e]=b(),++e;return d};`,
    // A class read through the helpers, defaulting the protocol like every reader.
    `W["warlight.shared.LatestGameInfo"]=${n.lgi};function ${n.lgi}(){}`,
    `${n.lgi}.Ha=function(a,b,d){null==d&&(d=${n.protocol});var e=new ${n.lgi};e.turn=${n.ser}.${h.int32}(a);e.ok=${n.ser}.${h.bool}(a);` +
      `e.k=${n.ser}.${h.u8}(a);e.name=${n.ser}.${h.string}(a);e.ids=a.${n.bool}()?${n.ser}.${h.listPush}(a,function(){return ${n.ser}.${h.int32}(a)}):null;` +
      `e.cap=a.${n.bool}()?new ${n.nint}(${n.ser}.${h.int32}(a)):new ${n.nint};e.ver=d;return e};`,
    `function Xa1(){}W["warlight.shared.Other1"]=Xa1;Xa1.Ha=function(a,b,d){null==d&&(d=${n.protocol});return null};`,
    `function Xa2(){}W["warlight.shared.Other2"]=Xa2;Xa2.Ha=function(a,b,d){null==d&&(d=${n.protocol});return null};`,
  );
  return lines.join('\n');
}

const board = () =>
  new Writer()
    .int32(7)
    .bool(true)
    .u8(3)
    .string('north')
    .bool(true)
    .list([4, 5], (w, v) => w.int32(v))
    .bool(true)
    .int32(9)
    .bytes();

describe('deriveDialect (#340): names by structure, not by build', () => {
  for (const [label, n] of [
    ['a v6.07-shaped build', A],
    ['a renamed build', B],
  ] as const) {
    it(`finds every reader method, helper and wrapper of ${label}`, () => {
      const d = deriveDialect(parseBundle(client(n)));
      expect(d).not.toBeNull();
      expect(d!.readerMethods).toMatchObject({
        [n.varint]: 'varint',
        [n.raw]: 'raw',
        [n.int32]: 'int32',
        [n.bool]: 'bool',
        [n.u8a]: 'u8',
        [n.u8b]: 'u8',
        [n.str]: 'string',
        [n.rf64]: 'float64',
        [n.rf32]: 'float32',
        [n.ru16]: 'uint16',
        [n.ri16]: 'int16',
      });
      const h = n.h;
      expect(d!.statics[n.ser]).toEqual({
        [h.int32]: 'int32',
        [h.string]: 'string',
        [h.bool]: 'bool',
        [h.u8]: 'u8',
        [h.f32]: 'float32',
        [h.f64]: 'float64',
        [h.ts]: 'timespan',
        [h.date]: 'date',
        [h.guid]: 'guid',
        [h.u16]: 'uint16',
        [h.bytes]: 'bytes',
        [h.listPush]: 'list',
        [h.listIdx]: 'list',
        [h.listSet]: 'list',
        [h.dict]: 'dict',
      });
      expect(d!.statics[n.util]).toEqual({ [n.parseLong]: 'identity', Fz: 'identity' });
      expect(d!.statics[n.pump]).toEqual({ rc: 'identity' });
      expect(d!.statics[n.en]).toEqual({ Range: 'range', Za: 'select', Sa: 'toArray' });
      expect(d!.wrappers).toEqual(expect.arrayContaining([n.nint, n.ts, n.dt, 'Cr1']));
      expect(d!.serializer).toBe(n.ser);
      expect(d!.protocol).toBe(n.protocol);
    });

    it(`reads a class through the derived names, and verifies the count helpers, in ${label}`, () => {
      const interp = new BundleInterpreter(parseBundle(client(n)), { version: n.protocol });
      expect(interp.derived).toBe(true);
      expect(interp.helperClass).toBe(n.ser);
      expect([...interp.requiredHelpers].sort()).toEqual([n.h.bool, n.h.int32, n.h.u8].sort());
      const check = interp.verifyDialect();
      expect(check.mismatched).toEqual([]);
      for (const name of interp.requiredHelpers) expect(check.verified).toContain(`${n.ser}.${name}`);
      expect(interp.readClass('warlight.shared.LatestGameInfo', new Reader(board()))).toEqual({
        $type: 'warlight.shared.LatestGameInfo',
        turn: 7,
        ok: true,
        k: 3,
        name: 'north',
        ids: [4, 5],
        cap: 9,
        ver: n.protocol,
      });
    });
  }

  it('is null when the BinaryReader cannot be found or a reader role is missing: the built-in names are used', () => {
    expect(deriveDialect(parseBundle(client(B, { dropReader: true })))).toBeNull();
    expect(deriveDialect(parseBundle(client(B, { dropBool: true })))).toBeNull();
    const interp = new BundleInterpreter(parseBundle(client(B, { dropReader: true })), { version: 243 });
    expect(interp.derived).toBe(false);
    expect(interp.helperClass).toBe('P');
  });

  it('canonical forms ignore every minified name but keep reader roles and class types', () => {
    const roleOf = (n: string) => ({ Og: 'int32', Tg: 'int32', Ua: 'bool' })[n];
    const typeOf = (n: string) => ({ ec: 'system.TimeSpan', dcT: 'system.TimeSpan' })[n];
    const a = canonicalize('function(a){return a.Ua()?a.Og():new ec(0)}', roleOf, typeOf);
    const b = canonicalize('function(q){return q.Ua()?q.Tg():new dcT(0)}', roleOf, typeOf);
    expect(a).toBe(b);
    expect(a).toBe('function ( #0 ) { return #0 . @bool ( ) ? #0 . @int32 ( ) : new @T:system.TimeSpan ( 0 ) }');
    expect(Object.values(SERIALIZER_TEMPLATES)).toContain('dict');
  });
});

describe('a client speaking another protocol is refused at load (#340)', () => {
  it('a build whose readers default to another protocol than this server speaks is not used', () => {
    const err = (() => {
      try {
        new WarappBundle(client(A), '242build');
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(BundleError);
    expect((err as BundleError).kind).toBe('protocol-mismatch');
    expect((err as Error).message).toMatch(/speaks protocol 242, and this server speaks 243/);
    expect((err as Error).message).toMatch(/older client/);
  });

  it('a build speaking this server protocol loads with its own derived names', () => {
    const b = new WarappBundle(client(B), '243build');
    expect(b.protocol).toBe(243);
    expect(b.derivedDialect).toBe(true);
    expect(b.readClass('warlight.shared.LatestGameInfo', new Reader(board()))).toMatchObject({ turn: 7, name: 'north', ver: 243 });
  });

  it('a newer protocol says the server needs an update', () => {
    expect(() => new WarappBundle(client({ ...B, protocol: 244 }), '244build')).toThrow(/needs an update/);
  });
});
