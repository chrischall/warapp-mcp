// A hand-written synthetic bundle carrying the classes the live board reads
// (LatestGameInfo → GameStanding → TerritoryStanding → Armies → SpecialUnit), in
// the same *shape* as war.app's generated readers and with TerritoryStanding
// fields read in the documented order: fog level, territory id, Armies, owner,
// then a trailing field. Armies is read as the client reads it: fogged, count,
// then (protocol ≥ 107) a byte count of special units, each dispatched on a
// byte tag (1 Commander, 2 Boss1, 6 CustomSpecialUnit) and ending with the
// shared unit fields GUID, owner — then built through its constructor. Every var, field name and value here is made up; nothing is
// taken from the real bundle. `writeLatestGameInfo` encodes a matching reply
// body with this project's own Writer.
import type { Writer } from '../../src/protocol/codec.js';

export const LIVE_BUNDLE = [
  'var W={};',
  'function Lg(){this.k1=0}function Gs(){}function Ts(){}function Pc(){}',
  'W["warlight.shared.LatestGameInfo"]=Lg;',
  'Lg.Ha=function(a,b,d){null==d&&(d=242);var e=new Lg;e.k1=P.Ya(a);e.k2=a.Ua()?Gs.Ha(a,e,d):null;e.k3=P.Ya(a);return e};',
  'W["warlight.shared.GameStanding"]=Gs;',
  'Gs.Ha=function(a,b,d){var e=new Gs;' +
    'e.q1=a.Ua()?P.ef(a,function(){return P.Ya(a)},function(){return Pc.Ha(a,e,d)}):null;' +
    'e.q2=a.Ua()?P.ef(a,function(){return P.Ya(a)},function(){return a.Ua()?Ts.Ha(a,e,d):null}):null;return e};',
  // Per-player data keyed by in-game id (an unregistered class, as in the client),
  // holding the player's cards: a dict GUID → card instance.
  'Pc.Ha=function(a,b,d){var e=new Pc;e.z1=P.Ya(a);' +
    'e.z2=a.Ua()?P.ef(a,function(){return P.tL(a)},function(){return a.Ua()?Cd.Ha(a,e,d):null}):null;return e};',
  'function Cd(){}function Rc(){}function Nc(){}',
  'W["warlight.shared.CardInstance"]=Cd;',
  'Cd.Ha=function(a,b,d){switch(P.uq(a)){case 1:return Rc.Ha(a,b,d);case 2:return Nc.Ha(a,b,d);' +
    'default:throw Y.sa(new Pa("unknown card instance tag"))}};',
  'W["warlight.shared.ReinforcementCardInstance"]=Rc;',
  'Rc.Ha=function(a,b,d){var e=new Rc;e.c1=P.tL(a);e.c2=P.Ya(a);e.c3=P.Ya(a);return e};',
  'W["warlight.shared.NoParameterCardInstance"]=Nc;',
  'Nc.Ha=function(a,b,d){var e=new Nc;e.c1=P.tL(a);e.c2=P.Ya(a);return e};',
  'W["warlight.shared.TerritoryStanding"]=Ts;',
  'Ts.Ha=function(a,b,d){var e=new Ts;e.f1=P.Ya(a);e.f2=P.Ya(a);e.f3=Am.Ha(a,e,d);e.f4=P.Ya(a);' +
    'e.f5=a.Ua()?P.Ya(a):null;return e};',
  'W["warlight.shared.Armies"]=Am;',
  'Am.Ha=function(a,b,d){null==d&&(d=0);return Am.r(a,d)};' +
    'Am.r=function(a,b){null==b&&(b=0);var d=P.Yc(a),e=P.Ya(a);if(107>b)var f=null;else f=P.uq(a),' +
    'f=0==f?null:E.Sa(E.Za(E.Range(0,f),function(){return Su.Ha(a,null,b)}));return new Am(e,f,d)};',
  'function Am(a,b,d){null==d&&(d=!1);null==a&&(a=0);this.g1=!1;this.g2=0;this.g1=d;this.g2=a;' +
    'this.g3=null!=b&&0==b.length?null:b}',
  'function Su(){}function Cm(){}function Bs(){}function Cu(){}',
  'W["warlight.shared.SpecialUnit"]=Su;',
  'Su.Ha=function(a,b){return Su.k(a,b)};' +
    'Su.k=function(a,b){var d=a.bc();switch(d){case 1:return Cm.r(a,b);case 2:return Bs.r(a,b);' +
    'case 6:return Cu.r(a,b);default:throw Y.sa(new Pa("Unexpected token "+d));}};' +
    'Su.E=function(a,b){b.u1=P.tL(a);b.u2=P.Ya(a)};',
  'W["warlight.shared.Commander"]=Cm;',
  'Cm.r=function(a,b){b=Cm.mc(b);Su.E(a,b);return b};Cm.mc=function(){return new Cm};',
  'W["warlight.shared.Boss1"]=Bs;',
  'Bs.r=function(a,b){b=Bs.mc(b);b.h1=P.Ya(a);Su.E(a,b);return b};Bs.mc=function(){return new Bs};',
  'W["warlight.shared.CustomSpecialUnit"]=Cu;',
  'Cu.r=function(a,b){b=Cu.mc(b);b.h1=a.Ua()?new Z(P.Ya(a)):new Z;b.h2=P.wc(a);Su.E(a,b);return b};' +
    'Cu.mc=function(){return new Cu};',
].join('\n');

/** A synthetic special unit: a made-up GUID and an in-game owner id. */
export type SyntheticUnit =
  | { kind: 'commander'; id: string; owner: number }
  | { kind: 'boss'; id: string; owner: number; health: number }
  | { kind: 'custom'; id: string; owner: number; power: number | null; name: string };

function writeUnit(w: Writer, u: SyntheticUnit): void {
  if (u.kind === 'commander') w.u8(1);
  else if (u.kind === 'boss') w.u8(2).int32(u.health);
  else {
    w.u8(6).bool(u.power !== null);
    if (u.power !== null) w.int32(u.power);
    w.string(u.name);
  }
  w.guid(u.id).int32(u.owner);
}

/** A synthetic card instance: a made-up GUID, the card type id and, for Reinforcement, its armies. */
export interface SyntheticCard {
  id: string;
  type: number;
  armies?: number;
}

export interface SyntheticTerritory {
  id: number;
  /** 1 visible, 2 owner only, 4 fogged. */
  fogLevel: number;
  /** In-game player id, 0 neutral, -2 pickable, -1 hidden. */
  owner: number;
  armies: number;
  fogged?: boolean;
  /** Special units on the territory (commanders, bosses), none by default. */
  units?: readonly SyntheticUnit[];
}

/** The result of GetLatestGameInfo (present flag first), as the synthetic bundle reads it. */
export function writeLatestGameInfo(
  w: Writer,
  territories: readonly SyntheticTerritory[] | null,
  playerIds: readonly number[] = [],
  hands: Readonly<Record<number, readonly SyntheticCard[]>> = {},
): void {
  w.bool(true).int32(1);
  if (territories === null) {
    w.bool(false);
  } else {
    w.bool(true);
    w.bool(true).list(playerIds, (ww, id) => {
      ww.int32(id).int32(0);
      const hand = hands[id];
      if (!hand) {
        ww.bool(false);
        return;
      }
      ww.bool(true).list(hand, (cw, c) => {
        cw.guid(c.id).bool(true);
        // ReinforcementCardInstance reads tc (armies) in its subclass, THEN the base reads Gb (type):
        // the live wire carries armies before the type, so the decoded integer fields are [armies, type].
        if (c.armies !== undefined) cw.u8(1).guid(c.id).int32(c.armies).int32(c.type);
        else cw.u8(2).guid(c.id).int32(c.type);
      });
    });
    w.bool(true).list(territories, (ww, t) => {
      ww.int32(t.id).bool(true).int32(t.fogLevel).int32(t.id).bool(t.fogged ?? false).int32(t.armies);
      const units = t.units ?? [];
      ww.u8(units.length);
      for (const u of units) writeUnit(ww, u);
      ww.int32(t.owner).bool(false);
    });
  }
  w.int32(2);
}
