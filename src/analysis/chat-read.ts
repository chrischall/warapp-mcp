// #415 task 3: another player's chat message read for the views — its intent, and for an unread one the advice.
//
// `readChatMessage` puts the classifier (chat-intent.ts) and the stance (chat-advice.ts) together for one message,
// from what a tool can read cheaply: the game's seats (who is a teammate, who is out, the format), my standing as the
// caller read it (this turn's plan, or the outlook log of the last turn planned; absent → `unknown`, said in the
// reasons), and the truces of the agreement ledger (`chatTruces`). The label and the advice are hints, not the judge:
// the views carry the message itself beside them, as other players' text. Nothing here sends, marks or writes
// anything. Pure and deterministic; never throws.

import type { ChatAutomation } from '../chat-automation.js';
import { carriesTeam, isTeamGame } from '../teams.js';
import { adviseReply, type ChatAdvice, type ChatAdviceGame, type ChatAdviceSender, type ChatStance } from './chat-advice.js';
import { classifyMessage, type ChatIntentPlayer, type Intent, type IntentConfidence, type NamedPlace } from './chat-intent.js';
import type { GameFormat, GameStanding } from './profile.js';
import { agreementState, type Agreement, type RelationPlayer } from './relations.js';

/** A seat, as the reading needs it (GameFeed ids). */
export interface ChatReadPlayer {
  id: number;
  name: string;
  team?: number | null;
  /** GameFeed's state; absent reads as Playing. */
  state?: string;
  isAI?: boolean;
  humanTurnedIntoAI?: boolean;
}

/** My standing as the caller read it, and where from (said in the reasons). */
export interface ChatStandingRead {
  standing: GameStanding;
  iLead?: boolean;
  myIncome?: number | null;
  strongest?: ChatAdviceGame['strongest'];
  leaderId?: number | null;
  /** Where it was read, e.g. "this turn's plan". */
  basis: string;
}

export type ChatTruce = NonNullable<ChatAdviceSender['truce']>;

export interface ChatReadContext {
  players: readonly ChatReadPlayer[];
  /** My GameFeed id, when known. */
  meId?: number;
  territories?: readonly NamedPlace[];
  bonuses?: readonly NamedPlace[];
  /** Absent or null: the standing is unknown, and the reasons say so. */
  standing?: ChatStandingRead | null;
  /** The truce with each partner (GameFeed id), from {@link chatTruces}. */
  truces?: ReadonlyMap<number, ChatTruce>;
  /** The format as the caller knows it (the plan's profile); else read from the seats. */
  format?: GameFormat;
  /** The game, for the advice's `send` block. */
  gameId?: number;
  /** The chat automation gate (`WARAPP_CHAT_AUTOMATION`); absent reads `off`. */
  automation?: ChatAutomation;
}

/** One message to read. */
export interface ChatReadMessage {
  text: string;
  /** The sender's GameFeed id; null when the source named none. */
  senderId: number | null;
  channel: 'public' | 'team' | 'private' | 'unknown';
  /** A private message to me. */
  toMe?: boolean;
  /** My own messages in the same conversation before it, oldest first (a reply to my proposal). */
  myRecent?: readonly string[];
}

/** The label as the views show it. */
export interface ChatIntentView {
  intents: Intent[];
  confidence: IntentConfidence;
}

/** The exact warapp_send_chat arguments for an advice's draft (gate on only): still to be confirmed. */
export interface ChatReplySend {
  game_id: number;
  message: string;
  /** A reply on the team channel. */
  channel?: 'team';
  /** A private reply to the sender (GameFeed id). */
  to?: number;
  automated: true;
}

/** An advice as the views carry it: the stance, plus the gate's state and, with it on and a draft, `send`. */
export type ChatReadAdvice = ChatAdvice & { automation: ChatAutomation; send?: ChatReplySend };

export interface ChatReading {
  intent: ChatIntentView;
  /** Only when asked (an unread message) and the sender is known. */
  advice?: ChatReadAdvice;
}

/** What the reasons say when no standing could be read. */
export const NO_STANDING_REASON =
  'My standing is unknown here (no plan of this game is logged): the stance is worked out with standing `unknown`.';

/** What the reasons say with the automation gate off. */
export const AUTOMATION_OFF_REASON =
  'Automated chat is off (WARAPP_CHAT_AUTOMATION): the owner sends any reply; nothing here is sent.';

/** What the reasons say with the gate on and a `send` block. */
const AUTOMATION_ON_REASON =
  'Automated chat is on (WARAPP_CHAT_AUTOMATION): `send` holds the warapp_send_chat arguments for the draft, still to be confirmed (every send is confirm-gated).';

/**
 * Where a reply to a message goes: the sender privately, my team, or the whole game; null when the channel it came
 * on is unknown (a public reply could carry a private answer to everyone).
 */
function replyRoute(channel: ChatReadMessage['channel'], senderId: number): Pick<ChatReplySend, 'channel' | 'to'> | null {
  if (channel === 'private') return { to: senderId };
  if (channel === 'team') return { channel: 'team' };
  if (channel === 'public') return {};
  return null;
}

/** States of a player out of the game. */
const OUT = new Set(['Eliminated', 'SurrenderAccepted', 'Booted', 'EndedByVote', 'Declined', 'RemovedByHost']);
const playing = (p: ChatReadPlayer) => (p.state ?? 'Playing') === 'Playing';

/** The game's format from its seats: teams, a 1v1 (one opponent still playing), else a free-for-all. */
export function chatFormat(players: readonly ChatReadPlayer[], meId: number | undefined): GameFormat | 'unknown' {
  try {
    if (!Array.isArray(players) || !players.length) return 'unknown';
    if (isTeamGame(players)) return 'teams';
    const opponents = players.filter((p) => p.id !== meId && playing(p)).length - (meId === undefined ? 1 : 0);
    return opponents <= 1 ? '1v1' : 'ffa';
  } catch {
    return 'unknown';
  }
}

const TRUCE_RANK: Readonly<Record<ChatTruce, number>> = { active: 3, 'in-notice': 2, proposed: 1 };

/**
 * Each partner's truce from the agreement ledger: `active`, `in-notice`, or `proposed` (one I proposed, unanswered);
 * the strongest when there are several. A Diplomacy card's (enforced) is no promise, and an agreement over is none.
 * With the turn unknown, read from the status alone. Never throws.
 */
export function chatTruces(
  agreements: readonly Agreement[] | undefined,
  turn: number | null,
  players: readonly RelationPlayer[],
): Map<number, ChatTruce> {
  const out = new Map<number, ChatTruce>();
  if (!Array.isArray(agreements)) return out;
  for (const a of agreements) {
    try {
      if (!a || typeof a !== 'object' || a.enforced === true || typeof a.with !== 'number') continue;
      let truce: ChatTruce | null = null;
      if (turn !== null) {
        const st = agreementState(a, turn, players);
        if (st.phase === 'active') truce = 'active';
        else if (st.phase === 'notice') truce = 'in-notice';
        else if (st.phase === 'proposed' && a.status === 'proposed-by-me') truce = 'proposed';
      } else if (a.status === 'agreed') truce = 'active';
      else if (a.status === 'notice-by-me' || a.status === 'notice-by-them') truce = 'in-notice';
      else if (a.status === 'proposed-by-me') truce = 'proposed';
      if (!truce) continue;
      const was = out.get(a.with);
      if (!was || TRUCE_RANK[truce] > TRUCE_RANK[was]) out.set(a.with, truce);
    } catch {
      // Skip what cannot be read.
    }
  }
  return out;
}

const STANDING_INTENTS: ReadonlySet<Intent> = new Set(['income-check', 'position-check']);

/** Label one message and, with `advise`, say how to answer it. Never throws. */
export function readChatMessage(msg: ChatReadMessage, ctx: ChatReadContext, opts: { advise: boolean }): ChatReading {
  try {
    const c: ChatReadContext = ctx && typeof ctx === 'object' ? ctx : { players: [] };
    const players = Array.isArray(c.players) ? c.players : [];
    const seats: ChatIntentPlayer[] = players.map((p) => ({ id: p.id, name: p.name, isMe: p.id === c.meId, team: p.team ?? null }));
    const classified = classifyMessage(typeof msg?.text === 'string' ? msg.text : '', {
      players: seats,
      ...(c.territories ? { territories: c.territories } : {}),
      ...(c.bonuses ? { bonuses: c.bonuses } : {}),
      ...(msg?.myRecent ? { myRecentMessages: msg.myRecent } : {}),
      ...(msg?.toMe ? { toMe: true } : {}),
    });
    const intent: ChatIntentView = { intents: classified.intents, confidence: classified.confidence };
    if (!opts?.advise || typeof msg?.senderId !== 'number') return { intent };
    const senderId = msg.senderId;
    const sender = players.find((p) => p.id === senderId);
    const me = players.find((p) => p.id === c.meId);
    const s = c.standing ?? null;
    const truce = c.truces?.get(senderId) ?? null;
    const game: ChatAdviceGame = {
      format: c.format ?? chatFormat(players, c.meId),
      standing: s?.standing ?? 'unknown',
      ...(s?.iLead !== undefined ? { iLead: s.iLead } : {}),
      ...(s && s.myIncome !== undefined ? { myIncome: s.myIncome } : {}),
      // The leader's name is never put in a draft: it is another player's words.
      ...(s?.strongest ? { strongest: { playerId: s.strongest.playerId, income: s.strongest.income, ...(s.strongest.thin !== undefined ? { thin: s.strongest.thin } : {}) } } : {}),
      ...(s && s.leaderId !== undefined ? { leaderId: s.leaderId } : {}),
      ...(c.meId !== undefined ? { meId: c.meId } : {}),
      sender: {
        id: senderId,
        ...(s?.leaderId != null && s.leaderId === senderId ? { isLeader: true } : {}),
        ...(me && sender && carriesTeam(me.team) && sender.team === me.team ? { teammate: true } : {}),
        ...(sender && OUT.has(sender.state ?? 'Playing') ? { out: true } : {}),
        truce,
      },
      channel: msg.channel,
    };
    const automation: ChatAutomation = c.automation === 'on' ? 'on' : 'off';
    const advice: ChatReadAdvice = { ...adviseReply(classified, game), automation };
    if (!s) advice.reasons.push(NO_STANDING_REASON);
    else if (classified.intents.some((i) => STANDING_INTENTS.has(i))) advice.reasons.push(`My standing as read from ${s.basis}.`);
    if (automation === 'off') advice.reasons.push(AUTOMATION_OFF_REASON);
    else if (advice.draft !== undefined) {
      const route = replyRoute(msg.channel, senderId);
      if (route === null) advice.reasons.push('The channel this message came on is unknown, so no `send` is offered: the owner picks where a reply goes.');
      else if (typeof c.gameId !== 'number') advice.reasons.push('The game is unknown here, so no `send` is offered.');
      else {
        advice.send = { game_id: c.gameId, message: advice.draft, ...route, automated: true };
        advice.reasons.push(AUTOMATION_ON_REASON);
      }
    }
    return { intent, advice };
  } catch {
    return { intent: { intents: [], confidence: 'low' } };
  }
}

/** The compact view of an advice: the stance and its first reason. */
export function compactAdvice(a: ChatAdvice): { stance: ChatStance; reason?: string } {
  return { stance: a.stance, ...(a.reasons[0] !== undefined ? { reason: a.reasons[0] } : {}) };
}
