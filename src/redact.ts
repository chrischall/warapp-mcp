// By-value scrubbing of the credentials this server holds (the account email,
// the GameFeed API token, the AuthToken cookie) out of upstream text.
//
// An upstream page that echoes a request body or URL may show a value raw,
// JSON-escaped, or encoded — percent-encoded by any encoder (strict RFC 3986
// writes `*` as `%2A`, JS encoders do not), partly encoded, with hex digits in
// either case, or form-encoded (spaces as `+`). So rather than listing
// spellings, each secret becomes one pattern in which every character matches
// itself, its percent-encoded UTF-8 bytes (hex in any case), its JSON escape
// (`\"`, `\uXXXX`) or, for a space, `+` — the same as comparing after decoding.
// An `anyCase` value (the email) also matches its letters in any case.

/** A secret to scrub: a bare string is matched case-sensitively. */
export type SecretValue = string | null | undefined | { value: string | null | undefined; anyCase?: boolean };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One hex digit, matching either case even in a case-sensitive pattern. */
const hexDigit = (d: string) => (/[0-9]/.test(d) ? d : `[${d.toLowerCase()}${d.toUpperCase()}]`);
const hexPattern = (n: number, width: number) =>
  n
    .toString(16)
    .padStart(width, '0')
    .split('')
    .map(hexDigit)
    .join('');

/** Every way one character of a secret may be written in an echo, as a regex alternation. */
function charPattern(ch: string): string {
  const alts = new Set<string>([escapeRegExp(ch)]);
  // Percent-encoded UTF-8 bytes (a lone surrogate has none worth matching).
  if (!/[\uD800-\uDFFF]/.test(ch) || ch.length === 2) {
    alts.add([...Buffer.from(ch, 'utf8')].map((b) => `%${hexPattern(b, 2)}`).join(''));
  }
  if (ch === ' ') alts.add('\\+');
  const json = JSON.stringify(ch).slice(1, -1);
  if (json !== ch) alts.add(escapeRegExp(json));
  // A \uXXXX escape of each UTF-16 unit (`+` for '+', `@` for '@').
  alts.add(
    ch
      .split('')
      .map((u) => `\\\\u${hexPattern(u.charCodeAt(0), 4)}`)
      .join(''),
  );
  return `(?:${[...alts].join('|')})`;
}

/** The pattern matching every spelling of `value` (see the file header). */
export function secretPattern(value: string, anyCase = false): RegExp {
  return new RegExp(Array.from(value, charPattern).join(''), anyCase ? 'gi' : 'g');
}

/**
 * `text` with every spelling of each secret replaced by `placeholder`
 * ({@link secretPattern}); the longest secrets first, so the longer of two
 * overlapping secrets goes whole.
 */
export function scrubSecrets(text: string, secrets: Iterable<SecretValue>, placeholder = '[REDACTED]'): string {
  const values = new Map<string, boolean>();
  for (const s of secrets) {
    const { value, anyCase = false } = typeof s === 'object' && s !== null ? s : { value: s };
    if (!value) continue;
    values.set(value, (values.get(value) ?? false) || anyCase);
  }
  let out = String(text ?? '');
  for (const [value, anyCase] of [...values].sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(secretPattern(value, anyCase), () => placeholder);
  }
  return out;
}
