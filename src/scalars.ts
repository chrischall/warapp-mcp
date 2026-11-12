// Scalar coercion for GameFeed's string-typed values.

/** An integer from a number or an integer string; `undefined` otherwise. */
export function asInt(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : undefined;
  if (typeof v !== 'string' || !/^\s*-?\d+\s*$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** A finite number from a number or a numeric string; `undefined` otherwise. */
export function asNum(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** A boolean from a boolean or a `True`/`False` string (any case); `undefined` otherwise. */
export function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  return s === 'true' ? true : s === 'false' ? false : undefined;
}

