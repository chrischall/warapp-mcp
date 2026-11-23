import { describe, expect, it } from 'vitest';
import { mentionsOf } from '../../src/analysis/chat-mentions.js';

describe('chat mentions (mentionsMe)', () => {
  const me = { names: ['Stark Lord'], territories: [{ id: 12, name: 'Winterfell' }, { id: 40, name: 'The Neck' }] };

  it('finds my name as a whole word, any case', () => {
    expect(mentionsOf('hey stark lord, truce?', me)).toEqual({ name: true, territories: [] });
    expect(mentionsOf('the starklordship', me)).toBeUndefined();
  });

  it('finds a territory I hold by name or by its chat link', () => {
    expect(mentionsOf('I will take WINTERFELL next turn', me)).toEqual({ name: false, territories: [12] });
    expect(mentionsOf('going for <a t=40> and <a t=41>', me)).toEqual({ name: false, territories: [40] });
    expect(mentionsOf('the necklace', me)).toBeUndefined();
  });

  it('never matches an empty or one-letter name', () => {
    expect(mentionsOf('a b c', { names: ['a', ''], territories: [{ id: 1, name: 'b' }] })).toBeUndefined();
  });
});
