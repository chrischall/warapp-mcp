import { describe, expect, it } from 'vitest';
import { scrubSecrets, secretSpellings } from '../src/redact.js';

// Made-up values only.
const EMAIL = 'first.last+wz@example.com';
const TOKEN = 'Ab$12*xyz#tok/3n+Z= q';

const form = (v: string) => new URLSearchParams({ v }).toString().slice(2);

describe('secretSpellings', () => {
  it('lists the raw, percent-encoded and form-encoded spellings', () => {
    const s = secretSpellings(EMAIL);
    expect(s).toContain(EMAIL);
    expect(s).toContain(encodeURIComponent(EMAIL));
    expect(s).toContain('first.last%2Bwz%40example.com');
    expect(s).toContain(form(EMAIL));
    expect(secretSpellings(TOKEN)).toContain(form(TOKEN));
  });

  it('includes the lowercase-hex form of a percent-encoded spelling', () => {
    expect(secretSpellings(EMAIL)).toContain('first.last%2bwz%40example.com');
  });

  it('is empty for an empty value', () => {
    expect(secretSpellings('')).toEqual([]);
  });
});

describe('scrubSecrets', () => {
  it('removes every spelling of a value, longest first', () => {
    const text = `raw ${TOKEN} uri ${encodeURIComponent(TOKEN)} form ${form(TOKEN)} json ${JSON.stringify(TOKEN)}`;
    const out = scrubSecrets(text, [TOKEN], '[x]');
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(encodeURIComponent(TOKEN));
    expect(out).not.toContain(form(TOKEN));
    expect(out).not.toContain('Ab$12');
    expect(out).toContain('raw [x] uri [x] form [x]');
  });

  it('matches an anyCase value in every letter case, its encoded spellings included', () => {
    const text = `a ${EMAIL.toUpperCase()} b First.Last%2bWZ%40Example.com c ${form(EMAIL)}`;
    const out = scrubSecrets(text, [{ value: EMAIL, anyCase: true }], '[email]');
    expect(out).toBe('a [email] b [email] c [email]');
  });

  it('keeps a case-sensitive value case-sensitive', () => {
    expect(scrubSecrets('abcDEF', ['abcdef'])).toBe('abcDEF');
  });

  it('skips empty and missing values, and treats regex characters literally', () => {
    expect(scrubSecrets('a.b', [null, undefined, '', { value: '' }])).toBe('a.b');
    expect(scrubSecrets('aXb a.b', [{ value: 'a.b', anyCase: true }], '[x]')).toBe('aXb [x]');
    expect(scrubSecrets('x $& y', [{ value: 'x', anyCase: true }], '$&')).toBe('$& $& y');
  });
});
