// A hand-written synthetic bundle carrying the classes a GameRefresh reply and a SendChat reply read
// (GameDetailsAndChat → GameMessage), in the same *shape* as war.app's generated readers and with the
// GameMessage fields read in the documented order (docs/WEB-PROTOCOL.md, Chat): date, sender
// (optional), game group (optional), an optional int, the message id (a decimal string), the text, the
// channel (-1 = public, else a team), the private counterpart (optional), an optional int, the turn
// (optional). Every var, field name and value here is made up; nothing is taken from the real bundle.
// `writeGameDetailsAndChat` and `writeSendChatReply` encode matching bytes with this project's Writer.
import type { Writer } from '../../src/protocol/codec.js';
import { REQUIRED_HELPER_DEFS } from './mini-bundle.js';

export const CHAT_BUNDLE = [
  REQUIRED_HELPER_DEFS,
  'function Gdc(){}function Gmg(){}function Gwl(){}',
  'W["warlight.shared.GameDetailsAndChat"]=Gdc;',
  'Gdc.Ha=function(a,b,d){null==d&&(d=242);return Gdc.rd(a,d)};',
  'Gdc.rd=function(a,b){var d=new Gdc;' +
    'd.c1=a.Ua()?P.Sd(a,function(){return a.Ua()?Gmg.Ha(a,d,b):null}):null;' +
    'd.c2=a.Ua()?Gwl.Ha(a,d,b):null;d.c3=P.Ya(a);return d};',
  'W["warlight.shared.GameWL"]=Gwl;Gwl.Ha=function(a,b,d){var e=new Gwl;e.w1=P.Ya(a);return e};',
  'W["warlight.shared.GameMessage"]=Gmg;',
  'Gmg.Ha=function(a){return Gmg.rd(a)};',
  'Gmg.rd=function(a){var b=new Gmg;b.m0=P.Td(a);b.m1=a.Ua()?new Z(P.Ya(a)):new Z;' +
    'b.m2=a.Ua()?new Z(P.Ya(a)):new Z;b.m3=a.Ua()?new Z(P.Ya(a)):new Z;b.m4=O.fA(P.wc(a));b.m5=P.wc(a);' +
    'b.m6=P.Ya(a);b.m7=a.Ua()?new Z(P.Ya(a)):new Z;b.m8=a.Ua()?new Z(P.Ya(a)):new Z;' +
    'b.m9=a.Ua()?new Z(P.Ya(a)):new Z;return b};',
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
}

const optInt = (w: Writer, v: number | undefined) => (v === undefined ? w.bool(false) : w.bool(true).int32(v));

/** One GameMessage record (no present flag). */
export function writeGameMessage(w: Writer, m: SyntheticMessage): void {
  w.date(m.date === undefined ? new Date(Date.UTC(2026, 10, 1) + m.id * 60_000) : m.date);
  optInt(w, m.from);
  optInt(w, m.group);
  optInt(w, undefined);
  w.string(String(m.id)).string(m.text).int32(m.channel ?? -1);
  optInt(w, m.privateTo);
  optInt(w, undefined);
  optInt(w, m.turn);
}

/** A list of present GameMessage records (`null`: the list is absent). */
function writeMessages(w: Writer, messages: readonly SyntheticMessage[] | null): void {
  if (messages === null) w.bool(false);
  else w.bool(true).list(messages, (ww, m) => writeGameMessage(ww.bool(true), m));
}

/** The result of GameRefresh (present flag first), as the synthetic bundle reads it. */
export function writeGameDetailsAndChat(w: Writer, messages: readonly SyntheticMessage[] | null): void {
  w.bool(true);
  writeMessages(w, messages);
  w.bool(true).int32(7).int32(0);
}

/**
 * The result of SendChat: the updated message list straight after the result-present flag (the
 * client reads no second flag there), each message behind its own present flag. `null`: no result.
 */
export function writeSendChatReply(w: Writer, messages: readonly SyntheticMessage[] | null): void {
  if (messages === null) w.bool(false);
  else w.bool(true).list(messages, (ww, m) => writeGameMessage(ww.bool(true), m));
}
