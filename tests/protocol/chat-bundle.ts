// A hand-written synthetic bundle carrying the classes a GameRefresh reply and a SendChat reply read
// (GameDetailsAndChat → GameMessage), in the same *shape* as war.app's generated readers and with the
// GameMessage fields read in protocol 243's order (docs/WEB-PROTOCOL.md, Chat): date, sender
// (optional), game group (optional), an optional int, the message id (a decimal string), the images
// (an optional list of strings, new in 243), the text, the reactions (an optional list of records, new
// in 243), the channel (-1 = public, else a team), the private counterpart (optional), an optional int,
// the turn (optional). Every var, field name and value here is made up; nothing is taken from the real bundle.
// `writeGameDetailsAndChat` and `writeSendChatReply` encode matching bytes with this project's Writer.
import type { Writer } from '../../src/protocol/codec.js';
import { REQUIRED_HELPER_DEFS } from './mini-bundle.js';

export const CHAT_BUNDLE = [
  REQUIRED_HELPER_DEFS,
  'function Gdc(){}function Gmg(){}function Gwl(){}function Grx(){}',
  // MessageReaction (243): an id, a reaction name and a nested value; here a plain int stands for the last.
  'W["warlight.shared.MessageReaction"]=Grx;Grx.Ha=function(a,b,d){null==d&&(d=243);var e=new Grx;' +
    'e.x0=P.Ya(a);e.x1=P.wc(a);e.x2=P.Ya(a);return e};',
  'W["warlight.shared.GameDetailsAndChat"]=Gdc;',
  'Gdc.Ha=function(a,b,d){null==d&&(d=243);return Gdc.rd(a,d)};',
  'Gdc.rd=function(a,b){var d=new Gdc;' +
    'd.c1=a.Ua()?P.Sd(a,function(){return a.Ua()?Gmg.Ha(a,d,b):null}):null;' +
    'd.c2=a.Ua()?Gwl.Ha(a,d,b):null;d.c3=P.Ya(a);' +
    // My mod data (a dict of mod id → XML text), fourth as in the real reader.
    'd.c4=a.Ua()?P.ef(a,function(){return P.Ya(a)},function(){return P.wc(a)}):null;return d};',
  // GameWL: 14 fields, the players (a dict of in-game id → GamePlayer) eighth (docs/WEB-PROTOCOL.md,
  // "Accepting a surrender"). The other fields are placeholders of this file's own choosing.
  'W["warlight.shared.GameWL"]=Gwl;Gwl.Ha=function(a,b,d){null==d&&(d=243);return Gwl.rd(a,d)};',
  'Gwl.rd=function(a,b){var e=new Gwl;e.g0=P.Ya(a);e.g1=P.Ya(a);e.g2=P.Td(a);e.g3=a.Ua()?new Z(P.Ya(a)):new Z;' +
    'e.g4=P.Ya(a);e.g5=P.Td(a);e.g6=a.Ua()?new Z(P.Ya(a)):new Z;' +
    'e.g7=a.Ua()?P.ef(a,function(){return P.Ya(a)},function(){return a.Ua()?Gpl.Ha(a,e,b):null}):null;' +
    // The public mod data (a dict of mod id → XML text), at 8 as in the real reader.
    'e.g8=a.Ua()?P.ef(a,function(){return P.Ya(a)},function(){return P.wc(a)}):null;e.g9=P.Td(a);e.g10=P.Td(a);e.g11=P.Td(a);e.g12=P.Ya(a);' +
    'e.g13=a.Ua()?new Z(P.Ya(a)):new Z;return e};',
  // GamePlayer: 37 fields (243 added an int at 31). Read inside a game, the record first links back to it (as the client's
  // reader does), which is not a read field. Read here: 0 the AI id (optional), 14 turned into an AI,
  // 20 the in-game id (optional), 21 who accepted its surrender (a dict of id → time), 28 the state
  // (a byte), 29 Surrendered. The rest are placeholders.
  'function Gpl(){}W["warlight.shared.GamePlayer"]=Gpl;',
  'Gpl.mc=function(a){var b=new Gpl;a instanceof Gwl&&(b.wl=a);return b};',
  'Gpl.Ha=function(a,b,d){b=Gpl.mc(b);b.p0=a.Ua()?new Z(P.Ya(a)):new Z;' +
    Array.from({ length: 13 }, (_, i) => `b.p${i + 1}=P.Ya(a);`).join('') +
    'b.p14=P.Yc(a);' +
    Array.from({ length: 5 }, (_, i) => `b.p${i + 15}=P.Ya(a);`).join('') +
    'b.p20=a.Ua()?new Z(P.Ya(a)):new Z;b.p21=a.Ua()?P.ef(a,function(){return P.Ya(a)},function(){return P.Td(a)}):null;' +
    Array.from({ length: 6 }, (_, i) => `b.p${i + 22}=P.Ya(a);`).join('') +
    'b.p28=P.uq(a);b.p29=P.Yc(a);' +
    Array.from({ length: 7 }, (_, i) => `b.p${i + 30}=P.Ya(a);`).join('') +
    'return b};',
  'W["warlight.shared.GameMessage"]=Gmg;',
  'Gmg.Ha=function(a,b,d){null==d&&(d=243);return Gmg.rd(a,d)};',
  'Gmg.rd=function(a,b){var d=new Gmg;d.m0=P.Td(a);var e=a.Ua()?new Z(P.Ya(a)):new Z;d.m1=e;' +
    'e=a.Ua()?new Z(P.Ya(a)):new Z;d.m2=e;e=a.Ua()?new Z(P.Ya(a)):new Z;d.m3=e;e=P.wc(a);d.m4=O.fA(e);' +
    'e=a.Ua()?P.Sd(a,function(){return P.wc(a)}):null;d.m5=e;d.m6=P.wc(a);' +
    'e=a.Ua()?P.Sd(a,function(){return a.Ua()?Grx.Ha(a,d,b):null}):null;d.m7=e;' +
    'd.m8=P.Ya(a);e=a.Ua()?new Z(P.Ya(a)):new Z;d.m9=e;e=a.Ua()?new Z(P.Ya(a)):new Z;d.m10=e;' +
    'e=a.Ua()?new Z(P.Ya(a)):new Z;d.m11=e;return d};',
].join('\n');

/** One synthetic chat message, as war.app's GameMessage carries it. */
export interface SyntheticMessage {
  /** The message id (sent as a decimal string). */
  id: number;
  date?: Date | null;
  /** Sender, in-game player id; absent: a system line. */
  from?: number;
  /** A game-group message. */
  group?: number;
  text: string;
  /** -1 = public (default), else the team. */
  channel?: number;
  /** A private message's counterpart (in-game id). */
  privateTo?: number;
  turn?: number;
  /** Shared images (243); absent: the list is absent. */
  images?: string[];
  /** Reactions (243), as reaction ids; absent: the list is absent. */
  reactions?: number[];
}

const optInt = (w: Writer, v: number | undefined) => (v === undefined ? w.bool(false) : w.bool(true).int32(v));

/** One GameMessage record (no present flag). */
export function writeGameMessage(w: Writer, m: SyntheticMessage): void {
  w.date(m.date === undefined ? new Date(Date.UTC(2026, 10, 1) + m.id * 60_000) : m.date);
  optInt(w, m.from);
  optInt(w, m.group);
  optInt(w, undefined);
  w.string(String(m.id));
  if (m.images === undefined) w.bool(false);
  else w.bool(true).list(m.images, (ww, s) => ww.string(s));
  w.string(m.text);
  if (m.reactions === undefined) w.bool(false);
  else w.bool(true).list(m.reactions, (ww, r) => ww.bool(true).int32(r).string('Heart').int32(0));
  w.int32(m.channel ?? -1);
  optInt(w, m.privateTo);
  optInt(w, undefined);
  optInt(w, m.turn);
}

/** A list of present GameMessage records (`null`: the list is absent). */
function writeMessages(w: Writer, messages: readonly SyntheticMessage[] | null): void {
  if (messages === null) w.bool(false);
  else w.bool(true).list(messages, (ww, m) => writeGameMessage(ww.bool(true), m));
}

/** One synthetic seat of the game details (GamePlayer). */
export interface SyntheticSeat {
  /** In-game id; absent with `aiId`: an AI seat with no player id. */
  id?: number;
  aiId?: number;
  turnedAI?: boolean;
  /** GamePlayerState code (default 2, Playing). */
  state?: number;
  surrendered?: boolean;
  /** In-game ids that accepted this seat's surrender (`null`: the dict is absent). */
  acceptedBy?: number[] | null;
}

/** One GamePlayer record (no present flag). */
export function writeGamePlayer(w: Writer, s: SyntheticSeat): void {
  optInt(w, s.aiId);
  for (let i = 1; i <= 13; i++) w.int32(i);
  w.bool(s.turnedAI ?? false);
  for (let i = 15; i <= 19; i++) w.int32(i);
  optInt(w, s.id);
  const accepted = s.acceptedBy === undefined ? [] : s.acceptedBy;
  if (accepted === null) w.bool(false);
  else w.bool(true).list(accepted, (ww, id) => ww.int32(id).date(new Date(Date.UTC(2026, 10, 2))));
  for (let i = 22; i <= 27; i++) w.int32(i);
  w.u8(s.state ?? 2).bool(s.surrendered ?? false);
  for (let i = 30; i <= 36; i++) w.int32(i);
}

/** Mod data per mod id (XML text), as the details carry it; `null` leaves the dict out. */
export type SyntheticModData = ReadonlyMap<number, string> | null;

function writeModData(w: Writer, data: SyntheticModData | undefined): void {
  if (!data) w.bool(false);
  else w.bool(true).list([...data], (ww, [id, xml]) => ww.int32(id).string(xml));
}

/** One GameWL record (no present flag): `seats` `null` leaves the players dict out; `publicMods` the mods' public data. */
export function writeGameWL(w: Writer, seats: readonly SyntheticSeat[] | null, publicMods?: SyntheticModData): void {
  const d = new Date(Date.UTC(2026, 10, 1));
  w.int32(7).int32(0).date(d).bool(false).int32(0).date(d).bool(false);
  if (seats === null) w.bool(false);
  else
    w.bool(true).list(seats, (ww, s) => {
      ww.int32(s.id ?? s.aiId ?? 0).bool(true);
      writeGamePlayer(ww, s);
    });
  writeModData(w, publicMods);
  w.date(d).date(d).date(d).int32(3).bool(false);
}

/**
 * The result of GameRefresh (present flag first), as the synthetic bundle reads it: the chat, then the
 * game with `seats` (none by default: the players dict absent).
 */
export function writeGameDetailsAndChat(
  w: Writer,
  messages: readonly SyntheticMessage[] | null,
  seats: readonly SyntheticSeat[] | null = null,
  mods: { public?: SyntheticModData; mine?: SyntheticModData } = {},
): void {
  w.bool(true);
  writeMessages(w, messages);
  w.bool(true);
  writeGameWL(w, seats, mods.public);
  w.int32(0);
  writeModData(w, mods.mine);
}

/**
 * The result of SendChat: the updated message list straight after the result-present flag (the
 * client reads no second flag there), each message behind its own present flag. `null`: no result.
 */
export function writeSendChatReply(w: Writer, messages: readonly SyntheticMessage[] | null): void {
  if (messages === null) w.bool(false);
  else w.bool(true).list(messages, (ww, m) => writeGameMessage(ww.bool(true), m));
}
