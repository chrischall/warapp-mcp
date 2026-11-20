// #415 task 4: the chat automation gate (WARAPP_CHAT_AUTOMATION, off by default) and the advice's `send` block.
// Synthetic names only.
import { describe, expect, it } from 'vitest';
import { AUTOMATION_OFF_REASON, readChatMessage, type ChatReadContext } from '../src/analysis/chat-read.js';
import { CHAT_AUTOMATION_ENV, chatAutomationMode } from '../src/chat-automation.js';

describe('chatAutomationMode', () => {
  it('is off unless the variable says on: unset, off, empty and anything else read off', () => {
    expect(CHAT_AUTOMATION_ENV).toBe('WARAPP_CHAT_AUTOMATION');
    expect(chatAutomationMode({})).toBe('off');
    expect(chatAutomationMode({ WARAPP_CHAT_AUTOMATION: 'off' })).toBe('off');
    expect(chatAutomationMode({ WARAPP_CHAT_AUTOMATION: '' })).toBe('off');
    expect(chatAutomationMode({ WARAPP_CHAT_AUTOMATION: 'yes please' })).toBe('off');
    expect(chatAutomationMode({ WARAPP_CHAT_AUTOMATION: 'onn' })).toBe('off');
    expect(chatAutomationMode({ WARAPP_CHAT_AUTOMATION: 'on' })).toBe('on');
    expect(chatAutomationMode({ WARAPP_CHAT_AUTOMATION: ' ON ' })).toBe('on');
  });
});

const ME = 10;
const BLUE = 20;
const GREEN = 30;
const GAME = 4242;
const players = [
  { id: ME, name: 'Red Fox' },
  { id: BLUE, name: 'Blue Heron' },
  { id: GREEN, name: 'Green Owl' },
];
// Behind a clear leader: an income check is answered with my real income (a draft).
const behind: ChatReadContext['standing'] = {
  standing: 'behind',
  iLead: false,
  myIncome: 9,
  strongest: { playerId: GREEN, income: 20, thin: false },
  leaderId: GREEN,
  basis: "this turn's plan",
};
const ctx = (over: Partial<ChatReadContext> = {}): ChatReadContext => ({ players, meId: ME, gameId: GAME, standing: behind, ...over });

describe('the advice under the gate', () => {
  it('off (the default): automation off, no `send`, and the reasons say the owner sends', () => {
    for (const c of [ctx(), ctx({ automation: 'off' })]) {
      const r = readChatMessage({ text: 'income check?', senderId: BLUE, channel: 'public' }, c, { advise: true });
      expect(r.advice?.draft).toBeDefined();
      expect(r.advice?.automation).toBe('off');
      expect(r.advice).not.toHaveProperty('send');
      expect(r.advice?.reasons).toContain(AUTOMATION_OFF_REASON);
    }
  });

  it('on, with a draft: `send` is the exact warapp_send_chat arguments, automated, back where the message came from', () => {
    const pub = readChatMessage({ text: 'income check?', senderId: BLUE, channel: 'public' }, ctx({ automation: 'on' }), { advise: true });
    expect(pub.advice?.automation).toBe('on');
    expect(pub.advice?.send).toEqual({ game_id: GAME, message: pub.advice!.draft, automated: true });
    expect(pub.advice?.reasons).not.toContain(AUTOMATION_OFF_REASON);
    expect(pub.advice?.reasons.some((x) => /still to be confirmed/.test(x))).toBe(true);

    const dm = readChatMessage({ text: 'income check?', senderId: BLUE, channel: 'private', toMe: true }, ctx({ automation: 'on' }), { advise: true });
    expect(dm.advice?.send).toEqual({ game_id: GAME, message: dm.advice!.draft, to: BLUE, automated: true });

    const teams = [
      { id: ME, name: 'Red Fox', team: 0 },
      { id: BLUE, name: 'Blue Heron', team: 0 },
      { id: GREEN, name: 'Green Owl', team: 1 },
    ];
    const team = readChatMessage(
      { text: 'whats your income?', senderId: BLUE, channel: 'team' },
      ctx({ players: teams, automation: 'on', standing: { standing: 'even', myIncome: 11, basis: 'x' } }),
      { advise: true },
    );
    expect(team.advice?.send).toEqual({ game_id: GAME, message: team.advice!.draft, channel: 'team', automated: true });
  });

  it('on, with no draft: no `send` (a priced truce, a report)', () => {
    const r = readChatMessage({ text: 'want a truce? no attacks till turn 10', senderId: BLUE, channel: 'private', toMe: true }, ctx({ automation: 'on' }), {
      advise: true,
    });
    expect(r.advice?.stance).toBe('price');
    expect(r.advice?.automation).toBe('on');
    expect(r.advice).not.toHaveProperty('send');
  });

  it('on, but the channel or the game is unknown: no `send`, and the reasons say why', () => {
    const unknown = readChatMessage({ text: 'income check?', senderId: BLUE, channel: 'unknown' }, ctx({ automation: 'on' }), { advise: true });
    expect(unknown.advice?.draft).toBeDefined();
    expect(unknown.advice).not.toHaveProperty('send');
    expect(unknown.advice?.reasons.some((x) => /channel .*unknown/.test(x))).toBe(true);
    const noGame = readChatMessage({ text: 'income check?', senderId: BLUE, channel: 'public' }, { players, meId: ME, standing: behind, automation: 'on' }, { advise: true });
    expect(noGame.advice).not.toHaveProperty('send');
  });
});
