import { describe, expect, it } from 'vitest';
import { scrubSecrets } from '../src/redact.js';

// Made-up values only.
const EMAIL = 'first.last+wz@example.com';
const TOKEN = 'Ab$12*xyz#tok/3n+Z= q';

const form = (v: string) => new URLSearchParams({ v }).toString().slice(2);
const lowerHex = (s: string) => s.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
/** A strict RFC 3986 encoder (as .NET Uri.EscapeDataString): also escapes !'()*. */
const strict = (v: string) =>
  encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

describe('scrubSecrets', () => {
  it('removes the raw, percent-encoded and form-encoded spellings, in either hex case', () => {
    for (const v of [EMAIL, TOKEN]) {
      for (const spelling of [v, encodeURIComponent(v), form(v), lowerHex(encodeURIComponent(v)), lowerHex(form(v))]) {
        expect(scrubSecrets(`<${spelling}>`, [v], '[x]'), spelling).toBe('<[x]>');
      }
    }
    expect(scrubSecrets('<first.last%2bwz%40example.com>', [EMAIL], '[x]')).toBe('<[x]>');
  });

  it('removes every spelling of a value, longest first', () => {
    const text = `raw ${TOKEN} uri ${encodeURIComponent(TOKEN)} form ${form(TOKEN)} json ${JSON.stringify(TOKEN)}`;
    const out = scrubSecrets(text, [TOKEN], '[x]');
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(encodeURIComponent(TOKEN));
    expect(out).not.toContain(form(TOKEN));
    expect(out).not.toContain('Ab$12');
    expect(out).toContain('raw [x] uri [x] form [x]');
  });

  it('decodes percent sequences rather than listing spellings: strict RFC 3986, mixed hex case, partly encoded', () => {
    const token = 'Ab*12!x(y)z~tok/3n+Z= q';
    expect(strict(token)).toContain('%2A');
    expect(scrubSecrets(`t=${strict(token)};`, [token], '[x]')).toBe('t=[x];');
    expect(scrubSecrets(`t=${lowerHex(strict(token))};`, [token], '[x]')).toBe('t=[x];');
    expect(scrubSecrets('t=Ab%2a12!x(y)z~tok%2f3n%2BZ%3d+q;', [token], '[x]')).toBe('t=[x];');
    // Any character may arrive encoded, an unreserved one included.
    expect(scrubSecrets('t=%41b*12!x(y)z~tok/3n+Z= q;', [token], '[x]')).toBe('t=[x];');
    // The '+' left raw and the '@' encoded, and the other way round.
    expect(scrubSecrets('e=first.last+wz%40example.com;', [{ value: EMAIL, anyCase: true }], '[e]')).toBe('e=[e];');
    expect(scrubSecrets('e=first.last%2Bwz@example.com;', [{ value: EMAIL, anyCase: true }], '[e]')).toBe('e=[e];');
    expect(scrubSecrets('e=FIRST.Last%2bWZ%40example.COM;', [{ value: EMAIL, anyCase: true }], '[e]')).toBe('e=[e];');
  });

  it('removes a JSON-escaped spelling, a \\u escape included', () => {
    const v = 'a"b\\c+d';
    expect(scrubSecrets(`x ${JSON.stringify(v)} y`, [v], '[x]')).toBe('x "[x]" y');
    expect(scrubSecrets('x a\\u0022b\\\\c\\u002Bd y', [v], '[x]')).toBe('x [x] y');
  });

  it('matches an anyCase value in every letter case, its encoded spellings included', () => {
    const text = `a ${EMAIL.toUpperCase()} b First.Last%2bWZ%40Example.com c ${form(EMAIL)}`;
    const out = scrubSecrets(text, [{ value: EMAIL, anyCase: true }], '[email]');
    expect(out).toBe('a [email] b [email] c [email]');
  });

  it('keeps a case-sensitive value case-sensitive, encoded letters included', () => {
    expect(scrubSecrets('abcDEF', ['abcdef'])).toBe('abcDEF');
    // %41 is 'A', not 'a'; the hex digits themselves may be in either case.
    expect(scrubSecrets('%41bc', ['abc'])).toBe('%41bc');
    expect(scrubSecrets('%61bc', ['abc'], '[x]')).toBe('[x]');
  });

  it('skips empty and missing values, and treats regex characters literally', () => {
    expect(scrubSecrets('a.b', [null, undefined, '', { value: '' }])).toBe('a.b');
    expect(scrubSecrets('aXb a.b', [{ value: 'a.b', anyCase: true }], '[x]')).toBe('aXb [x]');
    expect(scrubSecrets('x $& y', [{ value: 'x', anyCase: true }], '$&')).toBe('$& $& y');
  });

  it('scrubs the longer of two overlapping secrets whole', () => {
    expect(scrubSecrets('Bearer abc123', ['abc123', 'Bearer abc123'], '[x]')).toBe('[x]');
  });

  it('handles non-ASCII values encoded as UTF-8 bytes', () => {
    const v = 'pä$s';
    expect(scrubSecrets(`<${encodeURIComponent(v)}>`, [v], '[x]')).toBe('<[x]>');
    expect(scrubSecrets(`<${v}>`, [v], '[x]')).toBe('<[x]>');
  });
});
