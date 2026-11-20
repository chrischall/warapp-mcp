// #415 task 2: advise a stance on another player's chat message (synthetic names only).
import { describe, expect, it } from 'vitest';
import { adviseReply, type ChatAdviceGame } from '../../src/analysis/chat-advice.js';
import { type ClassifiedMessage, classifyMessage, type Intent, type IntentConfidence } from '../../src/analysis/chat-intent.js';
import { STRATEGY_NOTES } from '../../src/strategy/notes.js';

const ME = 1;
const SENDER = 2;
const LEADER = 3;

function cls(intents: Intent[], over: Partial<ClassifiedMessage> = {}, confidence: IntentConfidence = 'high'): ClassifiedMessage {
  const strengths: Partial<Record<Intent, IntentConfidence>> = {};
  for (const i of intents) strengths[i] = confidence;
  return {
    intents,
    confidence,
    strengths,
    addressedToMe: false,
    mentions: { players: [], territories: [], bonuses: [] },
    ...over,
  };
}

function game(over: Partial<ChatAdviceGame> = {}): ChatAdviceGame {
  return {
    format: 'ffa',
    standing: 'even',
    iLead: false,
    myIncome: 12,
    strongest: { playerId: LEADER, income: 20, thin: false, name: 'Green Owl' },
    leaderId: LEADER,
    meId: ME,
    sender: { id: SENDER },
    channel: 'public',
    ...over,
  };
}

const NOTE_IDS = new Set(STRATEGY_NOTES.map((n) => n.id));

describe('adviseReply: income and position checks', () => {
  it('FFA, I lead → ignore or vague, never a figure', () => {
    for (const intent of ['income-check', 'position-check'] as const) {
      const a = adviseReply(cls([intent]), game({ iLead: true, standing: 'ahead', strongest: { playerId: SENDER, income: 9 } }));
      expect(['ignore', 'vague']).toContain(a.stance);
      expect(a.draft ?? '').not.toMatch(/\d/);
      expect(a.reasons.join(' ')).toMatch(/leader/i);
    }
  });

  it('FFA, standing ahead (not ranked leader) → vague when asked directly', () => {
    const a = adviseReply(cls(['income-check'], { addressedToMe: true }), game({ standing: 'ahead' }));
    expect(a.stance).toBe('vague');
    expect(a.draft).toBeDefined();
    expect(a.draft!).not.toMatch(/\d/);
  });

  it('FFA, close to the leader → vague or ignore', () => {
    const a = adviseReply(cls(['income-check']), game({ standing: 'even', myIncome: 19, strongest: { playerId: LEADER, income: 20 } }));
    expect(['ignore', 'vague']).toContain(a.stance);
    expect(a.draft ?? '').not.toMatch(/\d/);
  });

  it('FFA, behind and another player clearly leads → share my real income, naming the leader only with a real estimate', () => {
    const a = adviseReply(cls(['income-check']), game({ standing: 'behind' }));
    expect(a.stance).toBe('share');
    expect(a.draft).toMatch(/\b12\b/);
    expect(a.draft).toMatch(/\b20\b/);
    expect(a.draft).toMatch(/Green Owl/);
    expect(a.noteIds.length).toBeGreaterThan(0);
  });

  it('a thin estimate of the leader is never stated', () => {
    const a = adviseReply(cls(['income-check']), game({ standing: 'behind', strongest: { playerId: LEADER, income: 20, thin: true, name: 'Green Owl' } }));
    expect(a.stance).toBe('share');
    expect(a.draft).toMatch(/\b12\b/);
    expect(a.draft).not.toMatch(/\b20\b/);
    expect(a.draft).not.toMatch(/Green Owl/);
  });

  it('share with no income of mine known falls back to vague (no invented number)', () => {
    const a = adviseReply(cls(['income-check']), game({ standing: 'behind', myIncome: null }));
    expect(a.stance).toBe('vague');
    expect(a.draft ?? '').not.toMatch(/\d/);
  });

  it('the leader asking is not helped: behind, but the sender leads → vague', () => {
    const a = adviseReply(cls(['income-check']), game({ standing: 'behind', sender: { id: LEADER, isLeader: true } }));
    expect(a.stance).toBe('vague');
    expect(a.draft ?? '').not.toMatch(/\d/);
  });

  it('1v1 → ignore', () => {
    const a = adviseReply(cls(['income-check'], { addressedToMe: true }), game({ format: '1v1', standing: 'behind' }));
    expect(a.stance).toBe('ignore');
    expect(a.draft).toBeUndefined();
  });

  it('team game: a teammate on the team channel → share; an enemy → ignore', () => {
    const team = adviseReply(cls(['position-check']), game({ format: 'teams', channel: 'team', sender: { id: SENDER, teammate: true } }));
    expect(team.stance).toBe('share');
    expect(team.draft).toMatch(/\b12\b/);
    const enemy = adviseReply(cls(['income-check']), game({ format: 'teams', channel: 'public', sender: { id: SENDER, teammate: false } }));
    expect(enemy.stance).toBe('ignore');
  });

  it('unknown standing → vague, saying the standing is unknown', () => {
    const a = adviseReply(cls(['income-check']), game({ standing: 'unknown', iLead: undefined, strongest: null, leaderId: null }));
    expect(a.stance).toBe('vague');
    expect(a.reasons.join(' ')).toMatch(/unknown/i);
    expect(a.draft ?? '').not.toMatch(/\d/);
  });
});

describe('adviseReply: truces, gang-ups, threats, surrenders', () => {
  it('truce proposal → price with warapp_advise_diplomacy, never accept', () => {
    const a = adviseReply(cls(['truce-proposal'], { addressedToMe: true }), game());
    expect(a.stance).toBe('price');
    expect(a.priceWith).toBe('warapp_advise_diplomacy');
    expect(a.draft).toBeUndefined();
    expect(a.reasons.join(' ')).toMatch(/player 2/i);
  });

  it('a truce proposal that also threatens is reported (the threat outranks it)', () => {
    const a = adviseReply(cls(['truce-proposal', 'threat'], { addressedToMe: true }), game());
    expect(a.stance).toBe('report');
  });

  it('coordination ask against the leader when I am not the leader → price', () => {
    const a = adviseReply(cls(['coordination-ask'], { mentions: { players: [LEADER], territories: [], bonuses: [] } }), game());
    expect(a.stance).toBe('price');
    expect(a.priceWith).toBe('warapp_advise_diplomacy');
  });

  it('coordination ask that targets me → report, with a counter-truce idea', () => {
    const a = adviseReply(cls(['coordination-ask'], { mentions: { players: [ME], territories: [], bonuses: [] } }), game({ iLead: true }));
    expect(a.stance).toBe('report');
    expect(a.reasons.join(' ')).toMatch(/counter-truce/i);
    expect(a.priceWith).toBeUndefined();
  });

  it('threat → report, re-check the borders facing the sender', () => {
    const a = adviseReply(cls(['threat'], { addressedToMe: true }), game());
    expect(a.stance).toBe('report');
    expect(a.reasons.join(' ')).toMatch(/border/i);
    expect(a.reasons.join(' ')).toMatch(/player 2/i);
  });

  it('surrender ask → report, the accept path is the owner\'s word only', () => {
    const a = adviseReply(cls(['surrender-ask']), game());
    expect(a.stance).toBe('report');
    expect(a.reasons.join(' ')).toMatch(/warapp_accept_surrender/);
    expect(a.reasons.join(' ')).toMatch(/owner/i);
  });

  it('truce end notice → report', () => {
    const a = adviseReply(cls(['truce-end-notice']), game({ sender: { id: SENDER, truce: 'active' } }));
    expect(a.stance).toBe('report');
  });

  it('truce accept → report (record the agreement), decline → ignore', () => {
    expect(adviseReply(cls(['truce-accept'], { addressedToMe: true }), game()).stance).toBe('report');
    expect(adviseReply(cls(['truce-decline'], { addressedToMe: true }), game()).stance).toBe('ignore');
  });
});

describe('adviseReply: small talk and the rest', () => {
  it('gg and greeting → ignore or a short courteous vague; banter → ignore', () => {
    for (const intent of ['gg', 'greeting'] as const) {
      const a = adviseReply(cls([intent], { addressedToMe: true }), game());
      expect(['ignore', 'vague']).toContain(a.stance);
      if (a.draft) expect(a.draft.length).toBeLessThan(40);
    }
    expect(adviseReply(cls(['banter']), game()).stance).toBe('ignore');
  });

  it('nothing recognised → ignore, and asks the caller to read the message itself', () => {
    const a = adviseReply(cls([], {}, 'low'), game());
    expect(a.stance).toBe('ignore');
    expect(a.reasons.join(' ')).toMatch(/read the message/i);
  });

  it('a medium-confidence label says it is a guess', () => {
    const a = adviseReply(cls(['income-check'], {}, 'medium'), game({ standing: 'behind' }));
    expect(a.reasons.join(' ')).toMatch(/medium confidence/i);
  });

  it('a sender who is out → ignore (but courtesy for a gg)', () => {
    expect(adviseReply(cls(['truce-proposal']), game({ sender: { id: SENDER, out: true } })).stance).toBe('ignore');
    expect(['ignore', 'vague']).toContain(adviseReply(cls(['gg']), game({ sender: { id: SENDER, out: true } })).stance);
  });
});

describe('adviseReply: honesty by construction (D3)', () => {
  const all: ChatAdviceGame[] = [
    game(),
    game({ standing: 'behind' }),
    game({ standing: 'ahead', iLead: true }),
    game({ format: 'teams', channel: 'team', sender: { id: SENDER, teammate: true } }),
    game({ format: '1v1' }),
    game({ standing: 'unknown', strongest: null, myIncome: null }),
  ];
  const intentSets: Intent[][] = [
    ['income-check'],
    ['position-check'],
    ['truce-proposal'],
    ['truce-accept'],
    ['truce-decline'],
    ['truce-end-notice'],
    ['coordination-ask'],
    ['threat'],
    ['surrender-ask'],
    ['gg'],
    ['banter'],
    ['greeting'],
    ['question-other'],
    [],
  ];

  it('drafts never claim to be human, never promise, vague drafts carry no figure; every noteId exists', () => {
    for (const g of all) {
      for (const i of intentSets) {
        for (const toMe of [false, true]) {
          const a = adviseReply(cls(i, { addressedToMe: toMe }), g);
          const label = `${JSON.stringify(i)} ${g.format} ${g.standing}`;
          expect(a.reasons.length, label).toBeGreaterThan(0);
          for (const id of a.noteIds) expect(NOTE_IDS.has(id), `${label}: ${id}`).toBe(true);
          if (a.priceWith) expect(a.stance, label).toBe('price');
          if (!a.draft) continue;
          expect(a.draft, label).not.toMatch(/\b(human|person|real player|not a bot|promise|i will|i'll|i won'?t|we will)\b/i);
          if (a.stance === 'vague') expect(a.draft, label).not.toMatch(/\d/);
          if (a.stance === 'share' && g.myIncome != null) expect(a.draft, label).toContain(String(g.myIncome));
        }
      }
    }
  });

  it('never throws on junk', () => {
    expect(() => adviseReply(undefined as unknown as ClassifiedMessage, undefined as unknown as ChatAdviceGame)).not.toThrow();
    expect(adviseReply(undefined as unknown as ClassifiedMessage, undefined as unknown as ChatAdviceGame).stance).toBe('ignore');
  });
});

describe('adviseReply on classified text', () => {
  const ctx = {
    players: [
      { id: ME, name: 'Bluefox', isMe: true },
      { id: SENDER, name: 'Redcrane' },
      { id: LEADER, name: 'Green Owl' },
    ],
  };
  it('reads a real income check, truce offer and gang-up', () => {
    expect(adviseReply(classifyMessage('income check?', ctx), game({ standing: 'behind' })).stance).toBe('share');
    expect(adviseReply(classifyMessage('want a truce? no attacks for 5 turns', { ...ctx, toMe: true }), game()).stance).toBe('price');
    expect(adviseReply(classifyMessage('everyone attack Bluefox, he is winning', ctx), game({ iLead: true })).stance).toBe('report');
  });
});
