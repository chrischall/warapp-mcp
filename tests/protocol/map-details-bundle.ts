// A hand-written synthetic bundle carrying the classes a GetMapDetails reply reads (#328): MapDetails →
// DistributionMode (a byte tag: 0 NormalDistribution, 1 ScenarioDistribution), in the same *shape* as
// war.app's generated readers (docs/WEB-PROTOCOL.md, "Map details: distribution modes"). MapDetails reads
// fourteen fields, its fourth the modes (an int32-count dict, mode id → mode); a normal mode reads its
// territory ids (an int32-count list), then the base fields (a description, the id, the name); a scenario
// mode reads its slot names (uint16 → string) and its territories (territory id → uint16 slot), then the
// same base fields. Every var, field name and value here is made up; nothing is taken from the real bundle.
// `writeMapDetailsResult` encodes matching bytes with this project's Writer.
import type { Writer } from '../../src/protocol/codec.js';
import { REQUIRED_HELPER_DEFS } from './mini-bundle.js';

export const MAP_DETAILS_BUNDLE = [
  REQUIRED_HELPER_DEFS,
  'function Mdx(){}function Dmx(){this.k=0}function Ndx(){this.k=0}function Scx(){this.k=0}',
  'W["warlight.shared.MapDetails"]=Mdx;',
  'Mdx.Ha=function(a,b,d){null==d&&(d=242);return Mdx.rd(a,b,d)};',
  'Mdx.rd=function(a,b,d){var e=new Mdx;e.m0=a.Ua()?P.ef(a,function(){return P.Ya(a)},function(){return P.wc(a)}):null;' +
    'e.m1=P.Td(a);e.m2=P.Ya(a);' +
    'e.m3=a.Ua()?P.ef(a,function(){return P.Ya(a)},function(){return a.Ua()?Dmx.Ha(a,e,d):null}):null;' +
    'e.m4=a.Ua()?P.wc(a):null;e.m5=P.Ya(a);e.m6=P.Ya(a);e.m7=P.Td(a);e.m8=P.Yc(a);e.m9=P.uq(a);' +
    'e.m10=a.Ua()?P.ef(a,function(){return P.Ya(a)},function(){return P.Ya(a)}):null;' +
    'e.m11=P.Ya(a);e.m12=P.wc(a);e.m13=P.Ya(a);return e};',
  'W["warlight.shared.DistributionMode"]=Dmx;',
  'Dmx.Ha=function(a,b,d){return Dmx.rd(a,b)};',
  'Dmx.rd=function(a,b){var d=a.bc();switch(d){case 0:return Ndx.rd(a,b);case 1:return Scx.rd(a,b);' +
    'default:throw Y.sa(new Pa("unexpected mode tag"))}};',
  'Dmx.base=function(a,b){b.desc=P.wc(a);b.k=P.Ya(a);b.label=P.wc(a)};',
  'W["warlight.shared.NormalDistribution"]=Ndx;',
  'Ndx.mk=function(){return new Ndx};',
  'Ndx.rd=function(a,b){b=Ndx.mk(b);b.ts=a.Ua()?P.uL(a,function(){return P.Ya(a)}):null;Dmx.base(a,b);return b};',
  'W["warlight.shared.ScenarioDistribution"]=Scx;',
  'Scx.mk=function(){return new Scx};',
  'Scx.rd=function(a,b){b=Scx.mk(b);b.slots=a.Ua()?P.ef(a,function(){return P.Z5(a)},function(){return P.wc(a)}):null;' +
    'b.ts=a.Ua()?P.ef(a,function(){return P.Ya(a)},function(){return P.Z5(a)}):null;Dmx.base(a,b);return b};',
].join('\n');

/** One synthetic distribution mode. */
export type SyntheticMode =
  | { kind: 'normal'; id: number; name?: string | null; territories: number[] | null; desc?: string | null }
  | { kind: 'scenario'; id: number; name?: string | null; slots?: Array<[number, string]>; territories: Array<[number, number]> | null };

/** One mode record (no present flag): the tag, its own fields, then the base fields. */
function writeMode(w: Writer, m: SyntheticMode): void {
  if (m.kind === 'normal') {
    w.u8(0);
    if (m.territories === null) w.bool(false);
    else {
      w.bool(true).int32(m.territories.length);
      for (const t of m.territories) w.int32(t);
    }
    w.string(m.desc ?? null);
  } else {
    w.u8(1);
    const slots = m.slots ?? [];
    w.bool(true).int32(slots.length);
    for (const [k, v] of slots) w.uint16(k).string(v);
    if (m.territories === null) w.bool(false);
    else {
      w.bool(true).int32(m.territories.length);
      for (const [t, s] of m.territories) w.int32(t).uint16(s);
    }
    w.string(null);
  }
  w.int32(m.id).string(m.name === undefined ? `Mode ${m.id}` : m.name);
}

/**
 * A GetMapDetails result: the result-present flag, then the MapDetails record with `modes` as its mode dict
 * (`null` writes an absent dict; a mode `null` an absent value). `key` overrides a mode's dict key.
 */
export function writeMapDetailsResult(
  w: Writer,
  modes: Array<SyntheticMode | null | { key: number; mode: SyntheticMode | null }> | null,
): void {
  w.bool(true);
  w.bool(false);
  w.date(new Date(Date.UTC(2026, 0, 1)));
  w.int32(1);
  if (modes === null) w.bool(false);
  else {
    w.bool(true).int32(modes.length);
    for (const entry of modes) {
      const keyed = entry !== null && 'mode' in entry ? entry : { key: entry?.id ?? 0, mode: entry };
      w.int32(keyed.key);
      if (keyed.mode === null) w.bool(false);
      else {
        w.bool(true);
        writeMode(w, keyed.mode);
      }
    }
  }
  w.bool(false);
  w.int32(2).int32(3);
  w.date(new Date(Date.UTC(2026, 0, 2)));
  w.bool(false).u8(0);
  w.bool(false);
  w.int32(4).string('x').int32(5);
}
