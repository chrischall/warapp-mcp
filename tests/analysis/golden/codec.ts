// A lossless JSON codec for planTurn inputs (the golden corpus, #133).
//
// JSON drops what a PlanInput can carry: Maps and Sets (the graph, remembered neutrals, opening
// incomes), `undefined` values (an explicit `armies: undefined` is not an absent key to `in`), and
// the non-finite numbers and -0. Every one is tagged here and restored exactly, in the same
// insertion order, so a decoded input plans the same turn as the original.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Encode a value into tagged, JSON-safe form. Throws on anything it cannot restore exactly. */
export function encode(v: unknown): Json {
  if (v === null) return null;
  switch (typeof v) {
    case 'undefined':
      return { $u: 1 };
    case 'boolean':
    case 'string':
      return v;
    case 'number':
      if (Number.isNaN(v)) return { $n: 'NaN' };
      if (v === Infinity) return { $n: 'Infinity' };
      if (v === -Infinity) return { $n: '-Infinity' };
      if (Object.is(v, -0)) return { $n: '-0' };
      return v;
    case 'object':
      break;
    default:
      throw new Error(`golden codec: cannot encode a ${typeof v}`);
  }
  if (Array.isArray(v)) {
    const out: Json[] = [];
    for (let i = 0; i < v.length; i++) out.push(encode(v[i]));
    return out;
  }
  if (v instanceof Map) return { $m: [...v].map(([k, x]) => [encode(k), encode(x)]) };
  if (v instanceof Set) return { $s: [...v].map(encode) };
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new Error('golden codec: cannot encode a class instance');
  const o: { [k: string]: Json } = {};
  let tagged = false;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k.startsWith('$')) tagged = true;
    o[k] = encode(x);
  }
  return tagged ? { $o: o } : o;
}

/** Restore a value {@link encode} produced. */
export function decode(j: Json): unknown {
  if (j === null || typeof j !== 'object') return j;
  if (Array.isArray(j)) return j.map(decode);
  if ('$u' in j) return undefined;
  if ('$n' in j) return j.$n === '-0' ? -0 : Number(j.$n);
  if ('$m' in j) return new Map((j.$m as Json[][]).map(([k, x]) => [decode(k!), decode(x!)]));
  if ('$s' in j) return new Set((j.$s as Json[]).map(decode));
  const src = ('$o' in j ? j.$o : j) as { [k: string]: Json };
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(src)) o[k] = decode(x);
  return o;
}
