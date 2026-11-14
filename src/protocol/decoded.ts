// Helpers for the records the interpreter decodes (src/protocol/interp.ts). Field names in the
// bundle are minified and change between releases, so readers find a record by its registered
// type name (`$type`) and its fields by read order.

/** A decoded record: its fields in read order, plus the interpreter's `$type`. */
export type DecodedRecord = Record<string, unknown> & { $type?: unknown };

export const isObj = (v: unknown): v is DecodedRecord => typeof v === 'object' && v !== null && !Array.isArray(v);

// The interpreter adds `$type` (and `$ctorError` when a constructor threw); every other key is a
// field in read order. Minified field names can start with `$` too (`$c`, `$a` live), so drop
// only those two.
const META_KEYS = new Set(['$type', '$ctorError']);

/** A decoded record's field values in read order. */
export const fields = (o: DecodedRecord): unknown[] =>
  Object.entries(o)
    .filter(([k]) => !META_KEYS.has(k))
    .map(([, v]) => v);
