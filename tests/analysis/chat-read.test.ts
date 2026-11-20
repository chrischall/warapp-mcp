// #415 task 3: a chat message read for the views — its intent, and for an unread one the advice (synthetic names only).
import { describe, expect, it } from 'vitest';
import type { Agreement } from '../../src/analysis/relations.js';
import {
  chatFormat,
  chatTruces,
  compactAdvice,
  NO_STANDING_REASON,
  readChatMessage,
  type ChatReadContext,
} from '../../src/analysis/chat-read.js';

const ME = 10;
const BLUE = 20;
const GREEN = 30;
const players = [
  { id: ME, name: 'Red Fox' },
  { id: BLUE, name: 'Blue Heron' },
  { id: GREEN, name: 'Green Owl' },
];

function ctx(over: Partial<ChatReadContext> = {}): ChatReadContext {
  return { players, meId: ME, ...over };
}

describe('chatFormat', () => {
  it('reads a free-for-all, a 1v1 and a team game from the seats', () => {
    expect(chatFormat(players, ME)).toBe('ffa');
    expect(chatFormat(players.slice(0, 2), ME)).toBe('1v1');
    expect(chatFormat([{ id: ME, name: 'a', team: 0 }, { id: BLUE, name: 'b', team: 1 }], ME)).toBe('teams');
    // An eliminated opponent is no opponent: two left is a 1v1.
    expect(chatFormat([...players.slice(0, 2), { id: GREEN, name: 'c', state: 'Eliminated' }], ME)).toBe('1v1');
    expect(chatFormat([], ME)).toBe('unknown');
  });
});

describe('chatTruces', () => {
  const agreement = (over: Partial<Agreement>): Agreement => ({
    id: 'a1',
    with: BLUE,
    kind: 'truce',
    status: 'agreed',
    createdTurn: 1,
    terms: { scope: 'all', noticeTurns: 1 },
    history: [],
    ...over,
  }) as Agreement;

  it('maps each partner to its truce: active, in notice, proposed by me; ended or proposed by them is none', () => {
    const m = chatTruces(
      [
        agreement({ id: 'a1', with: BLUE, status: 'agreed' }),
        agreement({ id: 'a2', with: GREEN, status: 'proposed-by-me' }),
        agreement({ id: 'a3', with: 40, status: 'ended' }),
        agreement({ id: 'a4', with: 50, status: 'proposed-by-them' }),
        agreement({ id: 'a5', with: 60, status: 'notice-by-them', noticeTurn: 5 }),
      ],
      5,
      [...players, { id: 40, name: 'x' }, { id: 50, name: 'y' }, { id: 60, name: 'z' }],
    );
    expect(m.get(BLUE)).toBe('active');
    expect(m.get(GREEN)).toBe('proposed');
    expect(m.has(40)).toBe(false);
    expect(m.has(50)).toBe(false);
    expect(m.get(60)).toBe('in-notice');
  });

  it('an active truce outranks an older proposal with the same player; a card truce is no promise', () => {
    const m = chatTruces(
      [agreement({ id: 'a1', status: 'proposed-by-me' }), agreement({ id: 'a2', status: 'agreed' }), agreement({ id: 'a3', with: GREEN, enforced: true })],
      3,
      players,
    );
    expect(m.get(BLUE)).toBe('active');
    expect(m.has(GREEN)).toBe(false);
  });

  it('never throws on junk', () => {
    expect(chatTruces(undefined, null, players).size).toBe(0);
    expect(chatTruces([null as unknown as Agreement], 2, players).size).toBe(0);
  });
});

describe('readChatMessage', () => {
  it('labels a message and, when asked, advises: a truce proposal is priced', () => {
    const r = readChatMessage({ text: 'want a truce? no attacks till turn 10', senderId: BLUE, channel: 'private', toMe: true }, ctx(), { advise: true });
    expect(r.intent.intents).toContain('truce-proposal');
    expect(r.intent.confidence).toBe('high');
    expect(r.advice?.stance).toBe('price');
    expect(r.advice?.priceWith).toBe('warapp_advise_diplomacy');
  });

  it('labels only (no advice) when not asked: a message already seen', () => {
    const r = readChatMessage({ text: 'income check?', senderId: BLUE, channel: 'public' }, ctx(), { advise: false });
    expect(r.intent.intents).toEqual(['income-check']);
    expect(r).not.toHaveProperty('advice');
  });

  it('missing standing: advised as unknown, and the reasons say so', () => {
    const r = readChatMessage({ text: 'income check?', senderId: BLUE, channel: 'public' }, ctx(), { advise: true });
    // An FFA with standing unknown: give no figure.
    expect(r.advice?.stance).toBe('vague');
    expect(r.advice?.reasons).toContain(NO_STANDING_REASON);
    expect(r.advice?.draft).not.toMatch(/\d/);
  });

  it('a standing read: behind with a clear leader shares my real income, and the reasons name where it was read', () => {
    const r = readChatMessage(
      { text: 'income check?', senderId: BLUE, channel: 'public' },
      ctx({
        standing: { standing: 'behind', iLead: false, myIncome: 9, strongest: { playerId: GREEN, income: 20, thin: false }, leaderId: GREEN, basis: "this turn's plan" },
      }),
      { advise: true },
    );
    expect(r.advice?.stance).toBe('share');
    expect(r.advice?.draft).toContain('9');
    // The leader's name never goes into a draft: it is another player's words.
    expect(r.advice?.draft).not.toContain('Green Owl');
    expect(r.advice?.reasons.some((x) => x.includes("this turn's plan"))).toBe(true);
    expect(r.advice?.reasons).not.toContain(NO_STANDING_REASON);
  });

  it('leading the FFA: an income check gets no figure', () => {
    const r = readChatMessage(
      { text: 'whats everyones income?', senderId: BLUE, channel: 'public' },
      ctx({ standing: { standing: 'ahead', iLead: true, myIncome: 25, strongest: { playerId: GREEN, income: 14 }, leaderId: ME, basis: 'x' } }),
      { advise: true },
    );
    expect(['ignore', 'vague']).toContain(r.advice?.stance);
    expect(r.advice?.draft ?? '').not.toMatch(/\d/);
  });

  it('the sender is read from the seats: a teammate asking on the team channel gets my income', () => {
    const teams = [
      { id: ME, name: 'Red Fox', team: 0 },
      { id: BLUE, name: 'Blue Heron', team: 0 },
      { id: GREEN, name: 'Green Owl', team: 1 },
    ];
    const r = readChatMessage(
      { text: 'whats your income?', senderId: BLUE, channel: 'team' },
      ctx({ players: teams, standing: { standing: 'even', myIncome: 11, basis: 'x' } }),
      { advise: true },
    );
    expect(r.advice?.stance).toBe('share');
    expect(r.advice?.draft).toContain('11');
  });

  it('an eliminated sender is out; a gang-up on me (named) is reported', () => {
    const out = readChatMessage(
      { text: 'gl all', senderId: GREEN, channel: 'public' },
      ctx({ players: [...players.slice(0, 2), { id: GREEN, name: 'Green Owl', state: 'Eliminated' }] }),
      { advise: true },
    );
    expect(out.advice?.stance).toBe('ignore');
    const gang = readChatMessage({ text: 'everyone attack red fox, he is winning', senderId: BLUE, channel: 'public' }, ctx(), { advise: true });
    expect(gang.intent.intents).toContain('coordination-ask');
    expect(gang.advice?.stance).toBe('report');
  });

  it('the truce with the sender reaches the advice', () => {
    const r = readChatMessage(
      { text: 'want a truce?', senderId: BLUE, channel: 'private', toMe: true },
      ctx({ truces: new Map([[BLUE, 'active' as const]]) }),
      { advise: true },
    );
    expect(r.advice?.reasons.some((x) => x.includes('already recorded'))).toBe(true);
  });

  it('a reply to my own proposal is read with my recent messages', () => {
    const r = readChatMessage(
      { text: 'deal', senderId: BLUE, channel: 'private', toMe: true, myRecent: ['truce until turn 10?'] },
      ctx(),
      { advise: true },
    );
    expect(r.intent.intents).toContain('truce-accept');
    expect(r.advice?.stance).toBe('report');
  });

  it('never throws on junk', () => {
    const r = readChatMessage({ text: undefined as unknown as string, senderId: null, channel: 'unknown' }, ctx(), { advise: true });
    expect(r.intent).toEqual({ intents: [], confidence: 'low' });
    expect(() => readChatMessage(null as never, null as never, { advise: true })).not.toThrow();
  });
});

describe('compactAdvice', () => {
  it('keeps the stance and the first reason only', () => {
    expect(compactAdvice({ stance: 'price', reasons: ['a', 'b'], priceWith: 'warapp_advise_diplomacy', noteIds: ['n'], draft: 'x' })).toEqual({ stance: 'price', reason: 'a' });
    expect(compactAdvice({ stance: 'ignore', reasons: [], noteIds: [] })).toEqual({ stance: 'ignore' });
  });
});
