// By-value scrubbing of the credentials this server holds (the account email,
// the GameFeed API token, the AuthToken cookie) out of upstream text.
//
// mcp-utils' `redactValues` replaces a value's raw and JSON-escaped spellings.
// An upstream page that echoes a request body or URL shows the value encoded
// instead — percent-encoded, or form-encoded (spaces as `+`, `@` as `%40`) —
// and may print hex digits or, for an email, letters in another case. This
// helper adds those spellings and wraps `redactValues`; an `anyCase` value
// (the email) is matched case-insensitively, its encoded spellings included.
import { redactValues } from '@chrischall/mcp-utils';

/** A secret to scrub: a bare string is matched case-sensitively. */
export type SecretValue = string | null | undefined | { value: string | null | undefined; anyCase?: boolean };

const lowerHex = (s: string) => s.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());

/**
 * Every spelling of `value` an upstream echo may carry: raw, percent-encoded
 * (`encodeURIComponent`), form-encoded (`URLSearchParams`), and each encoded
 * spelling with lowercase hex digits. Distinct; empty for an empty value.
 */
export function secretSpellings(value: string): string[] {
  if (!value) return [];
  const uri = encodeURIComponent(value);
  const form = new URLSearchParams({ v: value }).toString().slice(2);
  return [...new Set([value, uri, form, lowerHex(uri), lowerHex(form)])];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `text` with every {@link secretSpellings} spelling of each secret (and its
 * JSON-escaped form) replaced by `placeholder`. Case-sensitive values go
 * through mcp-utils `redactValues` (longest first); `anyCase` values are
 * replaced first, case-insensitively, as escaped literals.
 */
export function scrubSecrets(text: string, secrets: Iterable<SecretValue>, placeholder = '[REDACTED]'): string {
  const exact: string[] = [];
  const anyCase: string[] = [];
  for (const s of secrets) {
    const { value, anyCase: ci = false } = typeof s === 'object' && s !== null ? s : { value: s };
    if (!value) continue;
    for (const spelling of secretSpellings(value)) {
      if (!ci) {
        exact.push(spelling);
        continue;
      }
      anyCase.push(spelling);
      const json = JSON.stringify(spelling).slice(1, -1);
      if (json !== spelling) anyCase.push(json);
    }
  }
  let out = String(text ?? '');
  for (const needle of [...new Set(anyCase)].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRegExp(needle), 'gi'), () => placeholder);
  }
  return redactValues(out, exact, { placeholder });
}
