// #415 task 1: classify another player's chat message by what it asks of me (synthetic names only).
import { describe, expect, it } from 'vitest';
import { type ChatIntentContext, classifyMessage, describeIntent, INTENTS, type Intent } from '../../src/analysis/chat-intent.js';

const CTX: ChatIntentContext = {
  players: [
    { id: 1, name: 'Bluefox', isMe: true, team: null },
    { id: 2, name: 'Redcrane', isMe: false, team: null },
    { id: 3, name: 'Green Owl', isMe: false, team: null },
  ],
  territories: [
    { id: 10, name: 'Alaska' },
    { id: 11, name: 'New Zealand' },
  ],
  bonuses: [{ id: 50, name: 'North America' }],
};

const intents = (text: string, ctx: ChatIntentContext = CTX): Intent[] => classifyMessage(text, ctx).intents;

/** Every positive example must carry `intent`; every negative example must not. */
function cases(intent: Intent, positive: string[], negative: string[], ctx: ChatIntentContext = CTX): void {
  for (const text of positive) {
    it(`reads ${JSON.stringify(text)} as ${intent}`, () => {
      expect(intents(text, ctx)).toContain(intent);
    });
  }
  for (const text of negative) {
    it(`does not read ${JSON.stringify(text)} as ${intent}`, () => {
      expect(intents(text, ctx)).not.toContain(intent);
    });
  }
}

describe('INTENTS and describeIntent', () => {
  it('lists every intent once and describes each in a short line', () => {
    expect(new Set(INTENTS).size).toBe(INTENTS.length);
    for (const i of INTENTS) {
      const d = describeIntent(i);
      expect(d.length).toBeGreaterThan(5);
      expect(d.length).toBeLessThanOrEqual(80);
    }
    expect(INTENTS).toEqual(
      expect.arrayContaining([
        'income-check',
        'position-check',
        'truce-proposal',
        'truce-accept',
        'truce-decline',
        'truce-end-notice',
        'coordination-ask',
        'threat',
        'surrender-ask',
        'gg',
        'banter',
        'greeting',
        'question-other',
      ]),
    );
  });
});

describe('classifyMessage: income-check', () => {
  cases(
    'income-check',
    ['income check?', "what's everyone's income", 'inc?', 'Income check pls', 'how much income do u have', 'whats ur inc'],
    ['I have no idea', 'nice move', 'incoming attack on Alaska', 'my income is fine thanks'],
  );
});

describe('classifyMessage: position-check', () => {
  cases(
    'position-check',
    ["who's winning?", 'how are you doing', 'how many armies do you have?', 'how many territories u got', 'hows it going for everyone'],
    ['income check?', 'hello', 'I am winning'],
  );
});

describe('classifyMessage: truce-proposal', () => {
  cases(
    'truce-proposal',
    [
      'truce?',
      'Want a truce?',
      'NAP?',
      'non-aggression pact for 5 turns?',
      'peace between us?',
      "don't attack me and I won't attack you",
      'dont atk me and i wont atk u',
      'truse?',
      'lets make peace',
    ],
    ['gg', 'income check?', 'the truce is over', 'no truce', 'I will attack you'],
  );
});

describe('classifyMessage: truce-accept / truce-decline', () => {
  const proposed: ChatIntentContext = { ...CTX, myRecentMessages: ['Truce for 5 turns?'] };
  cases('truce-accept', ['deal', 'Agreed!', 'ok sure', 'yes', 'sounds good'], ['no thanks', 'gg', 'income?'], proposed);
  cases('truce-decline', ['no thanks', 'nope', 'no deal', 'not interested', 'no'], ['deal', 'agreed', 'gg'], proposed);
  // Without a proposal of mine a bare "deal" or "no" is not about a truce.
  cases('truce-accept', ['I accept the truce', 'truce accepted', 'nap agreed'], ['deal', 'yes', 'ok']);
  cases('truce-decline', ['no truce', 'I decline the truce', 'no nap, sorry'], ['no', 'nope', 'no thanks']);

  it('is high confidence when it answers a proposal of mine', () => {
    expect(classifyMessage('deal', { ...CTX, myRecentMessages: ['want a truce?'] }).confidence).toBe('high');
  });

  it('takes a reply to my proposal as addressed to me', () => {
    expect(classifyMessage('agreed', { ...CTX, myRecentMessages: ['nap?'] }).addressedToMe).toBe(true);
  });
});

describe('classifyMessage: truce-end-notice', () => {
  cases(
    'truce-end-notice',
    ['the truce is over', 'ending our truce in 2 turns', 'breaking the truce, sorry', 'truce ends next turn', 'giving notice: nap is off', 'cancel the NAP'],
    ['truce?', 'I accept the truce', 'gg'],
  );
});

describe('classifyMessage: coordination-ask', () => {
  cases(
    'coordination-ask',
    [
      "let's attack Redcrane",
      'Redcrane is winning, help',
      'everyone gang up on Green Owl',
      'team up against redcrane?',
      'we need to stop Bluefox',
      'can someone help me vs Redcrane',
    ],
    ['gg', 'I will attack you', 'help me understand the map'],
  );

  it('names the player the coordination is against', () => {
    const r = classifyMessage('everyone gang up on Bluefox, he is winning', CTX);
    expect(r.intents).toContain('coordination-ask');
    expect(r.mentions.players).toEqual([1]);
    expect(r.addressedToMe).toBe(true);
  });
});

describe('classifyMessage: threat', () => {
  cases(
    'threat',
    ['I will attack you', 'back off', "i'm coming for you", 'attack me and you will regret it', 'get out of Alaska or else', 'ill wipe u out'],
    ["don't attack me and I won't attack you", 'gg', 'truce?'],
  );
});

describe('classifyMessage: surrender-ask', () => {
  cases(
    'surrender-ask',
    ['accept my surrender', 'please accept', 'gg I surrender', 'pls accept surrender', 'I give up, accept it', 'surender accepted?'],
    ['gg', 'I accept the truce', 'deal'],
  );

  it('reads "gg I surrender" as both gg and a surrender ask', () => {
    expect(intents('gg I surrender')).toEqual(expect.arrayContaining(['gg', 'surrender-ask']));
  });
});

describe('classifyMessage: gg / banter / greeting', () => {
  cases('gg', ['gg', 'GG wp', 'good game!', 'gg all'], ['hello', 'good luck', 'eggs']);
  cases('greeting', ['hi', 'Hello all', 'hey everyone', 'gl hf', 'good luck everyone'], ['gg', 'this is high', 'they will attack']);
  cases('banter', ['lol', 'haha nice', 'ty', 'thx', 'wow lucky roll', 'nice move'], ['income?', 'truce?']);
});

describe('classifyMessage: question-other', () => {
  cases('question-other', ['what map is this?', 'are you a bot?'], ['income check?', 'truce?', 'gg', 'nice move']);

  it('is low confidence when it is the only intent', () => {
    expect(classifyMessage('what map is this?', CTX).confidence).toBe('low');
  });
});

describe('classifyMessage: mentions', () => {
  it('matches player, territory and bonus names case-insensitively on word bounds', () => {
    const r = classifyMessage('redcrane, stay out of north america and new zealand. Green owl too', CTX);
    expect(r.mentions).toEqual({ players: [2, 3], territories: [11], bonuses: [50] });
  });

  it('does not match a name inside another word', () => {
    expect(classifyMessage('Redcranes everywhere; Alaskan cold', CTX).mentions).toEqual({ players: [], territories: [], bonuses: [] });
  });

  it('marks a message naming me as addressed to me', () => {
    expect(classifyMessage('bluefox, income check?', CTX).addressedToMe).toBe(true);
    expect(classifyMessage('redcrane, income check?', CTX).addressedToMe).toBe(false);
  });

  it('marks a private message to me as addressed to me', () => {
    expect(classifyMessage('hi', { ...CTX, toMe: true }).addressedToMe).toBe(true);
  });
});

describe('classifyMessage: cleaned text and robustness', () => {
  it('reads the cleaned text the chat tools produce (⟦ ⟧ delimiters, look-alike quote letters)', () => {
    expect(intents('⟦whatʼs everyoneʼs income?⟧')).toContain('income-check');
    expect(intents('⟦donʼt attack me and I wonʼt attack you⟧')).toContain('truce-proposal');
  });

  it('is high confidence on a specific phrase', () => {
    expect(classifyMessage('income check?', CTX).confidence).toBe('high');
  });

  it('gives no intent and low confidence for empty or unrecognised text', () => {
    for (const text of ['', '   ', 'asdf qwer', '...']) {
      const r = classifyMessage(text, CTX);
      expect(r.intents).toEqual([]);
      expect(r.confidence).toBe('low');
      expect(r.addressedToMe).toBe(false);
    }
  });

  it('never throws on odd input', () => {
    const odd: unknown[] = [null, undefined, 42, {}, [], Symbol('x'), 'x'.repeat(10_000)];
    for (const v of odd) {
      expect(() => classifyMessage(v as string, CTX)).not.toThrow();
      expect(() => classifyMessage('hi', undefined as unknown as ChatIntentContext)).not.toThrow();
      expect(() => classifyMessage('hi', { players: [{ id: 1, name: null as unknown as string }] })).not.toThrow();
    }
  });

  it('returns intents in INTENTS order, each once', () => {
    const r = classifyMessage('gg I surrender, please accept. gg', CTX);
    const order = r.intents.map((i) => INTENTS.indexOf(i));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(r.intents).size).toBe(r.intents.length);
  });
});
