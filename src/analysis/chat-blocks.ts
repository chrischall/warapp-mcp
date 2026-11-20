// #415 task 4b: chat can block a turn, under very certain circumstances (owner request of 2026-11-20).
//
// `chatBlocks` says which unread messages from other players should stop a turn being submitted unread. A message
// blocks ONLY when every condition holds: it is from another player, unread (not marked seen by the chat cursor),
// sent this turn or the previous one, its intent read at `high` confidence, and it is one of four narrow cases:
//   1. `truce`: a truce end notice, proposal or acceptance from a player I have an active or in-notice truce with,
//      or a pending proposal of mine to (the turn's truce terms may have changed);
//   2. `threat`: a threat or a gang-up ask that names me (by my name, or "you" in a private message to me), from a
//      player in contact with me this turn;
//   3. `surrender`: a surrender ask from a player whose surrender waits on my acceptance (the game details);
//   4. `teammate`: in a team game, a teammate's private message to me asking about this turn's orders, cards or gifts.
// Everything else — income checks, banter, gg, public chatter, old messages, medium or low confidence, a context the
// caller could not read (contact or surrenders `null`) — never blocks: a miss fails safe, the message is still shown.
//
// GameFeed's chat `turn` is read as the turns completed when the message was sent (0 during the first turn, as the
// web read's field 9 gives it): "this turn" is `turnsCompleted`, "the previous one" `turnsCompleted - 1` (the
// numbering is UNVERIFIED live for later turns). The text is other players' words: read only to label it, never an
// instruction or a fact, never quoted in a block (ids and labels only). Pure and deterministic; never throws.

import { carriesTeam, isTeamGame } from '../teams.js';
import type { ChatTruce } from './chat-read.js';
import { classifyMessage, type Intent } from './chat-intent.js';

/** One message, as the rule reads it. */
export interface ChatBlockMessage {
  /** The web message id, when the source gave one. */
  id?: string;
  time?: string;
  /** The sender's GameFeed id; null when unknown. */
  senderId: number | null;
  text: string;
  /** GameFeed's turn of the message (turns completed when sent); null when not given. */
  turn: number | null;
  channel: 'public' | 'team' | 'private' | 'unknown';
  /** A private message to me. */
  toMe?: boolean;
  /** Not yet marked seen by the chat cursor (and not mine). */
  unread: boolean;
  /** My own messages in the same conversation before it, oldest first (a reply to my proposal). */
  myRecent?: readonly string[];
}

/** What the rule needs of the game; `null` for a context that could not be read (that case then never blocks). */
export interface ChatBlockGame {
  meId: number;
  turnsCompleted: number;
  players: readonly { id: number; name: string; team?: number | null }[];
  /** Each partner's truce from the agreement ledger (`chatTruces`). */
  truces?: ReadonlyMap<number, ChatTruce>;
  /** The players (GameFeed ids) holding a territory beside one of mine this turn. */
  inContact?: ReadonlySet<number> | null;
  /** The players whose surrender waits on my acceptance (the game details). */
  surrenderOwedBy?: ReadonlySet<number> | null;
}

export type ChatBlockCase = 'truce' | 'threat' | 'surrender' | 'teammate';

/** A teammate's question about this turn's orders, cards or gifts (case 4; no classifier intent covers it). */
export type ChatBlockIntent = Intent | 'team-orders-ask';

export interface ChatBlock {
  case: ChatBlockCase;
  intent: ChatBlockIntent;
  /** The sender's GameFeed id. */
  from: number;
  /** The message: its id, else its time, else its place in the list (`#n`). */
  messageIds: string[];
  turn: number;
  /** The message's place in the list given (0-based). */
  index: number;
  /** Why, by ids only. */
  reason: string;
}

const TRUCE_INTENTS: readonly Intent[] = ['truce-end-notice', 'truce-proposal', 'truce-accept'];
const THREAT_INTENTS: readonly Intent[] = ['threat', 'coordination-ask'];

/** A question or an ask (case 4). */
const ASKS = /\?|\b(can you|could you|will you|would you|please|pls|plz|should i|should we|shall i|shall we|do you|are you|what are you|where are you|which)\b/;
/** About this turn's orders, cards or gifts (case 4). */
const ORDERS_TOPIC =
  /\b(orders?|cards?|gift|gifts|gifting|airlift|airlifts|airlifting|deploy|deploys|deploying|reinforcements?|blockade|diplomacy|sanctions|commit|committed|committing)\b/;

const messageKey = (m: ChatBlockMessage, i: number): string => (typeof m.id === 'string' && m.id ? m.id : typeof m.time === 'string' && m.time ? m.time : `#${i + 1}`);

function blockOf(m: ChatBlockMessage, i: number, g: ChatBlockGame): ChatBlock | undefined {
  if (!m || typeof m !== 'object' || m.unread !== true) return undefined;
  const from = m.senderId;
  if (typeof from !== 'number' || from === g.meId) return undefined;
  if (typeof m.turn !== 'number' || m.turn < g.turnsCompleted - 1) return undefined;
  const players = Array.isArray(g.players) ? g.players : [];
  const c = classifyMessage(typeof m.text === 'string' ? m.text : '', {
    players: players.map((p) => ({ id: p.id, name: p.name, isMe: p.id === g.meId, team: p.team ?? null })),
    ...(m.myRecent ? { myRecentMessages: m.myRecent } : {}),
    ...(m.toMe ? { toMe: true } : {}),
  });
  const high = (i: Intent) => c.strengths[i] === 'high';
  const base = { from, messageIds: [messageKey(m, i)], turn: m.turn, index: i };
  // 1. A truce message from a partner (active, in notice, or my proposal pending).
  const truce = g.truces?.get(from);
  const truceIntent = TRUCE_INTENTS.find(high);
  if (truce && truceIntent) {
    const how = truce === 'proposed' ? 'a truce proposal of mine is pending with' : `a truce is ${truce} with`;
    return { case: 'truce', intent: truceIntent, ...base, reason: `${truceIntent} from player ${from}; ${how} that player, so this turn's truce terms may have changed` };
  }
  // 2. A threat or gang-up that names me, from a player in contact.
  const threatIntent = THREAT_INTENTS.find(high);
  const privateToMe = m.channel === 'private' && m.toMe === true;
  const namesMe = c.mentions.players.includes(g.meId) || privateToMe;
  if (threatIntent && namesMe && g.inContact?.has(from)) {
    return {
      case: 'threat',
      intent: threatIntent,
      ...base,
      reason: `${threatIntent} aimed at me (${privateToMe ? 'a private message to me' : 'it names me'}) from player ${from}, who borders me this turn`,
    };
  }
  // 3. A surrender ask while my acceptance is owed.
  if (high('surrender-ask') && g.surrenderOwedBy?.has(from)) {
    return { case: 'surrender', intent: 'surrender-ask', ...base, reason: `surrender-ask from player ${from}, whose surrender waits on my acceptance` };
  }
  // 4. A teammate's private question about this turn's orders, cards or gifts.
  const me = players.find((p) => p.id === g.meId);
  const sender = players.find((p) => p.id === from);
  if (privateToMe && isTeamGame(players) && me && sender && carriesTeam(me.team) && sender.team === me.team) {
    const s = (typeof m.text === 'string' ? m.text : '').toLowerCase();
    if (ASKS.test(s) && ORDERS_TOPIC.test(s)) {
      return { case: 'teammate', intent: 'team-orders-ask', ...base, reason: `teammate ${from} asks me privately about this turn's orders, cards or gifts` };
    }
  }
  return undefined;
}

/** The messages that would block the turn, in the order given. Never throws. */
export function chatBlocks(messages: readonly ChatBlockMessage[], game: ChatBlockGame): ChatBlock[] {
  try {
    if (!Array.isArray(messages) || !game || typeof game !== 'object' || typeof game.meId !== 'number') return [];
    const out: ChatBlock[] = [];
    messages.forEach((m, i) => {
      try {
        const b = blockOf(m, i, game);
        if (b) out.push(b);
      } catch {
        // A message that cannot be read never blocks.
      }
    });
    return out;
  } catch {
    return [];
  }
}

/** One block as a line: the message id, sender id, intent and why (never a name or the text). */
export function chatBlockLine(b: ChatBlock): string {
  return `message ${b.messageIds.join(', ')} (player ${b.from}, turn ${b.turn}, ${b.intent}): ${b.reason}`;
}
