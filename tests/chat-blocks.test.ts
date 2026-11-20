// #415 task 4b: chat can block a turn — the pure rule (`chatBlocks`) and the gate (WARAPP_CHAT_BLOCKS_TURN, off by
// default). A message blocks only when every condition holds. Synthetic names only.
import { describe, expect, it } from 'vitest';
import { chatBlocks, chatBlockLine, type ChatBlockGame, type ChatBlockMessage } from '../src/analysis/chat-blocks.js';
import { CHAT_BLOCKS_TURN_ENV, chatBlocksTurnMode } from '../src/chat-automation.js';

const ME = 10;
const BLUE = 20;
const GREEN = 30;
const MATE = 40;

const ffa = [
  { id: ME, name: 'Red Fox' },
  { id: BLUE, name: 'Blue Heron' },
  { id: GREEN, name: 'Green Owl' },
];
const teams = [
  { id: ME, name: 'Red Fox', team: 0 },
  { id: MATE, name: 'Gold Lynx', team: 0 },
  { id: BLUE, name: 'Blue Heron', team: 1 },
  { id: GREEN, name: 'Green Owl', team: 1 },
];

/** Turn 7 is being played: 6 turns completed; GameFeed's chat `turn` is the turns completed when it was sent. */
const game = (over: Partial<ChatBlockGame> = {}): ChatBlockGame => ({
  meId: ME,
  turnsCompleted: 6,
  players: ffa,
  truces: new Map(),
  inContact: new Set([BLUE, GREEN]),
  surrenderOwedBy: new Set(),
  ...over,
});

const msg = (over: Partial<ChatBlockMessage> = {}): ChatBlockMessage => ({
  time: '2026-11-20T10:00:00',
  senderId: BLUE,
  text: 'hello',
  turn: 6,
  channel: 'unknown',
  unread: true,
  ...over,
});

describe('chatBlocksTurnMode', () => {
  it('is off unless the variable says on: unset, off, empty and garbage read off', () => {
    expect(CHAT_BLOCKS_TURN_ENV).toBe('WARAPP_CHAT_BLOCKS_TURN');
    expect(chatBlocksTurnMode({})).toBe('off');
    expect(chatBlocksTurnMode({ WARAPP_CHAT_BLOCKS_TURN: 'off' })).toBe('off');
    expect(chatBlocksTurnMode({ WARAPP_CHAT_BLOCKS_TURN: '' })).toBe('off');
    expect(chatBlocksTurnMode({ WARAPP_CHAT_BLOCKS_TURN: 'yes' })).toBe('off');
    expect(chatBlocksTurnMode({ WARAPP_CHAT_BLOCKS_TURN: 'onn' })).toBe('off');
    expect(chatBlocksTurnMode({ WARAPP_CHAT_BLOCKS_TURN: 'on' })).toBe('on');
    expect(chatBlocksTurnMode({ WARAPP_CHAT_BLOCKS_TURN: ' On ' })).toBe('on');
  });

  it('is independent of WARAPP_CHAT_AUTOMATION', () => {
    expect(chatBlocksTurnMode({ WARAPP_CHAT_AUTOMATION: 'on' })).toBe('off');
  });
});

describe('an unknown turn count never blocks', () => {
  it('blocks nothing when the turns completed are not known (negative or not a number)', () => {
    const m = [msg({ text: 'our truce is over' })];
    const truces = new Map([[BLUE, 'active' as const]]);
    expect(chatBlocks(m, { ...game({ truces }), turnsCompleted: -1 })).toEqual([]);
    expect(chatBlocks(m, { ...game({ truces }), turnsCompleted: Number.NaN })).toEqual([]);
  });
});

describe('case 1: a truce message from a partner', () => {
  it('blocks a high-confidence end notice from a player I have an active truce with', () => {
    const blocks = chatBlocks([msg({ text: 'our truce is over' })], game({ truces: new Map([[BLUE, 'active']]) }));
    expect(blocks).toEqual([
      expect.objectContaining({ case: 'truce', intent: 'truce-end-notice', from: BLUE, messageIds: ['2026-11-20T10:00:00'] }),
    ]);
    expect(blocks[0]!.reason).toContain('active');
  });

  it('blocks a proposal from a player in notice, and from one I have a pending proposal to', () => {
    expect(chatBlocks([msg({ text: 'want a truce? no attacks until turn 10' })], game({ truces: new Map([[BLUE, 'in-notice']]) }))).toHaveLength(1);
    expect(chatBlocks([msg({ id: 'm1', text: 'truce?' })], game({ truces: new Map([[BLUE, 'proposed']]) }))[0]!.messageIds).toEqual(['m1']);
  });

  it('does not block the same message from a player with no truce (wrong sender), nor at medium confidence', () => {
    expect(chatBlocks([msg({ text: 'our truce is over' })], game())).toEqual([]);
    expect(chatBlocks([msg({ text: 'deal, truce agreed' })], game({ truces: new Map([[BLUE, 'proposed']]) }))).toEqual([]);
  });
});

describe('case 2: a threat or a gang-up that names me, from a player in contact', () => {
  it('blocks a threat in a private message to me from a player in contact', () => {
    const blocks = chatBlocks([msg({ text: 'I will attack you', channel: 'private', toMe: true })], game());
    expect(blocks).toEqual([expect.objectContaining({ case: 'threat', intent: 'threat', from: BLUE })]);
  });

  it('blocks a threat naming me by name, and a gang-up on me', () => {
    expect(chatBlocks([msg({ text: 'I will attack Red Fox' })], game())).toHaveLength(1);
    expect(chatBlocks([msg({ text: 'everyone gang up on red fox', senderId: GREEN })], game())).toEqual([
      expect.objectContaining({ case: 'threat', intent: 'coordination-ask', from: GREEN }),
    ]);
  });

  it('does not block a public "you" that names no one, a sender not in contact, or contact unknown', () => {
    expect(chatBlocks([msg({ text: 'I will attack you', channel: 'public' })], game())).toEqual([]);
    expect(chatBlocks([msg({ text: 'I will attack Red Fox' })], game({ inContact: new Set([GREEN]) }))).toEqual([]);
    expect(chatBlocks([msg({ text: 'I will attack Red Fox' })], game({ inContact: null }))).toEqual([]);
  });

  it('does not block a gang-up on someone else', () => {
    expect(chatBlocks([msg({ text: 'everyone gang up on green owl' })], game())).toEqual([]);
  });
});

describe('case 3: a surrender ask while my acceptance is owed', () => {
  it('blocks only when the game details show my acceptance owed to the sender', () => {
    expect(chatBlocks([msg({ text: 'accept my surrender please' })], game({ surrenderOwedBy: new Set([BLUE]) }))).toEqual([
      expect.objectContaining({ case: 'surrender', intent: 'surrender-ask', from: BLUE }),
    ]);
    expect(chatBlocks([msg({ text: 'accept my surrender please' })], game())).toEqual([]);
    expect(chatBlocks([msg({ text: 'accept my surrender please' })], game({ surrenderOwedBy: null }))).toEqual([]);
    expect(chatBlocks([msg({ text: 'accept my surrender please' })], game({ surrenderOwedBy: new Set([GREEN]) }))).toEqual([]);
  });
});

describe('case 4: a teammate asking privately about this turn', () => {
  const t = (over: Partial<ChatBlockGame> = {}) => game({ players: teams, inContact: new Set([BLUE, GREEN]), ...over });

  it("blocks a teammate's private question to me about orders, cards or gifts", () => {
    expect(chatBlocks([msg({ senderId: MATE, text: 'what are your orders this turn?', channel: 'private', toMe: true })], t())).toEqual([
      expect.objectContaining({ case: 'teammate', intent: 'team-orders-ask', from: MATE }),
    ]);
    expect(chatBlocks([msg({ senderId: MATE, text: 'can you gift me territory 12 this turn?', channel: 'private', toMe: true })], t())).toHaveLength(1);
  });

  it('does not block it on the team channel, from an opponent, without a question, or outside a team game', () => {
    expect(chatBlocks([msg({ senderId: MATE, text: 'what are your orders this turn?', channel: 'team' })], t())).toEqual([]);
    expect(chatBlocks([msg({ senderId: BLUE, text: 'what are your orders this turn?', channel: 'private', toMe: true })], t())).toEqual([]);
    expect(chatBlocks([msg({ senderId: MATE, text: 'my orders are in', channel: 'private', toMe: true })], t())).toEqual([]);
    expect(chatBlocks([msg({ senderId: GREEN, text: 'what are your orders this turn?', channel: 'private', toMe: true })], game())).toEqual([]);
  });
});

describe('the conditions every case needs', () => {
  const blocking = msg({ text: 'I will attack you', channel: 'private', toMe: true });

  it('a message already read never blocks', () => {
    expect(chatBlocks([{ ...blocking, unread: false }], game())).toEqual([]);
  });

  it('only this turn or the previous one: older, or with no turn, never blocks', () => {
    expect(chatBlocks([{ ...blocking, turn: 6 }], game())).toHaveLength(1);
    expect(chatBlocks([{ ...blocking, turn: 5 }], game())).toHaveLength(1);
    expect(chatBlocks([{ ...blocking, turn: 4 }], game())).toEqual([]);
    expect(chatBlocks([{ ...blocking, turn: null }], game())).toEqual([]);
  });

  it('my own message, or one with no sender, never blocks', () => {
    expect(chatBlocks([{ ...blocking, senderId: ME }], game())).toEqual([]);
    expect(chatBlocks([{ ...blocking, senderId: null }], game())).toEqual([]);
  });

  it('an income check, public banter and gg never block, whatever the truce or contact', () => {
    const g = game({ truces: new Map([[BLUE, 'active']]), surrenderOwedBy: new Set([BLUE]) });
    expect(chatBlocks([msg({ text: 'income check?' }), msg({ text: 'lol nice', channel: 'public' }), msg({ text: 'gg' })], g)).toEqual([]);
  });

  it('a medium-confidence end notice from a partner does not block', () => {
    expect(chatBlocks([msg({ text: 'lets end the truce' })], game({ truces: new Map([[BLUE, 'active']]) }))).toEqual([]);
  });

  it('never throws on junk', () => {
    expect(chatBlocks(null as unknown as ChatBlockMessage[], game())).toEqual([]);
    expect(chatBlocks([null as unknown as ChatBlockMessage], game())).toEqual([]);
    expect(chatBlocks([blocking], null as unknown as ChatBlockGame)).toEqual([]);
  });

  it('names a block by id, sender id, intent and why, never by name or text', () => {
    const [b] = chatBlocks([{ ...blocking, id: 'm7' }], game());
    const line = chatBlockLine(b!);
    expect(line).toContain('m7');
    expect(line).toContain(`player ${BLUE}`);
    expect(line).toContain('threat');
    expect(line).not.toMatch(/Blue Heron|attack you/);
  });
});
