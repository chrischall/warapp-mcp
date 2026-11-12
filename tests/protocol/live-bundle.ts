// A hand-written synthetic bundle carrying the four classes the live board reads
// (LatestGameInfo → GameStanding → TerritoryStanding → Armies), in the same
// *shape* as war.app's generated readers and with TerritoryStanding fields read
// in the documented order: fog level, territory id, Armies, owner, then a
// trailing field. Every var, field name and value here is made up; nothing is
// taken from the real bundle. `writeLatestGameInfo` encodes a matching reply
// body with this project's own Writer.
import type { Writer } from '../../src/protocol/codec.js';

export const LIVE_BUNDLE = [
  'var W={};',
  'function Lg(){this.k1=0}function Gs(){}function Ts(){}function Am(){}function Pc(){}',
  'W["warlight.shared.LatestGameInfo"]=Lg;',
  'Lg.Ha=function(a,b,d){null==d&&(d=242);var e=new Lg;e.k1=P.Ya(a);e.k2=a.Ua()?Gs.Ha(a,e,d):null;e.k3=P.Ya(a);return e};',
  'W["warlight.shared.GameStanding"]=Gs;',
  'Gs.Ha=function(a,b,d){var e=new Gs;' +
    'e.q1=a.Ua()?P.ef(a,function(){return P.Ya(a)},function(){return Pc.Ha(a,e,d)}):null;' +
    'e.q2=a.Ua()?P.ef(a,function(){return P.Ya(a)},function(){return a.Ua()?Ts.Ha(a,e,d):null}):null;return e};',
  // Per-player data keyed by in-game id (an unregistered class, as in the client).
  'Pc.Ha=function(a,b,d){var e=new Pc;e.z1=P.Ya(a);return e};',
  'W["warlight.shared.TerritoryStanding"]=Ts;',
  'Ts.Ha=function(a,b,d){var e=new Ts;e.f1=P.Ya(a);e.f2=P.Ya(a);e.f3=Am.Ha(a,e,d);e.f4=P.Ya(a);' +
    'e.f5=a.Ua()?P.Ya(a):null;return e};',
  'W["warlight.shared.Armies"]=Am;',
  'Am.Ha=function(a,b,d){var e=new Am;e.g1=P.Yc(a);e.g2=P.Ya(a);' +
    'e.g3=a.Ua()?P.Sd(a,function(){return P.Ya(a)}):null;return e};',
].join('\n');

export interface SyntheticTerritory {
  id: number;
  /** 1 visible, 2 owner only, 4 fogged. */
  fogLevel: number;
  /** In-game player id, 0 neutral, -2 pickable, -1 hidden. */
  owner: number;
  armies: number;
  fogged?: boolean;
}

/** The result of GetLatestGameInfo (present flag first), as the synthetic bundle reads it. */
export function writeLatestGameInfo(
  w: Writer,
  territories: readonly SyntheticTerritory[] | null,
  playerIds: readonly number[] = [],
): void {
  w.bool(true).int32(1);
  if (territories === null) {
    w.bool(false);
  } else {
    w.bool(true);
    w.bool(true).list(playerIds, (ww, id) => ww.int32(id).int32(0));
    w.bool(true).list(territories, (ww, t) => {
      ww.int32(t.id).bool(true).int32(t.fogLevel).int32(t.id).bool(t.fogged ?? false).int32(t.armies).bool(false);
      ww.int32(t.owner).bool(false);
    });
  }
  w.int32(2);
}
