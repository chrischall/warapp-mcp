// A war.app mod's stored data (`Mod.PublicGameData`, `Mod.PlayerGameData`), as the web client keeps it:
// one XML string per mod id. Read from the client bundle (its mod-table serializer and parser), the
// format VERIFIED live 2026-11-23 on a lobby's public data (mod 336's table):
//
//   <m><e k="s|ModVersion" v="s|3.0" /><e k="s|Map"><v><e k="d|2.0" v="d|665.0" /></v></e></m>
//
// Each `<e>` is one key and value of a Lua table: a scalar in an attribute (`s|` text, `i|` integer,
// `d|`/`f|` number, `b|1`/`b|0` a bool, `null`), or a nested table as a child element (`<v>`, or `<k>`
// for a table key) holding its own `<e>` entries. Lua arrays are tables keyed 1..n.
//
// Pure. Never throws: a document this parser does not understand is `undefined` (unknown).

/** One value of a mod table. */
export type ModValue = string | number | boolean | null | ModTable;
/** One Lua table: its keys (text or numbers) in document order. */
export type ModTable = Map<string | number, ModValue>;

interface Node {
  name: string;
  attrs: Map<string, string>;
  children: Node[];
}

const ENTITY: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };

/** An attribute value with its XML escapes undone; `undefined` on an escape this parser does not know. */
function unescapeXml(s: string): string | undefined {
  let bad = false;
  const out = s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (_, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    const v = ENTITY[e];
    if (v === undefined) bad = true;
    return v ?? '';
  });
  // A bare `&` (no entity after it) is not well-formed XML.
  if (bad || /&(?!(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);)/.test(s)) return undefined;
  return out;
}

/** The element tree of `xml` (its root), or `undefined` when it is not well formed as far as this reads. */
function parseXml(xml: string): Node | undefined {
  const tag = /<\?[^>]*\?>|<(\/?)([A-Za-z_][\w.-]*)((?:\s+[A-Za-z_][\w.-]*\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/gy;
  const attr = /([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g;
  const stack: Node[] = [];
  let root: Node | undefined;
  let m: RegExpExecArray | null;
  let at = 0;
  while (at < xml.length) {
    tag.lastIndex = at;
    m = tag.exec(xml);
    if (!m) return undefined;
    at = tag.lastIndex;
    if (m[0].startsWith('<?')) continue;
    if (m[5] !== undefined) {
      // Text between elements: only whitespace belongs in this format.
      if (m[5].trim()) return undefined;
      continue;
    }
    const [, close, name, attrs, self] = m;
    if (close) {
      const top = stack.pop();
      if (!top || top.name !== name) return undefined;
      if (!stack.length) {
        if (root) return undefined;
        root = top;
      }
      continue;
    }
    const node: Node = { name: name!, attrs: new Map(), children: [] };
    for (const a of attrs!.matchAll(attr)) {
      const v = unescapeXml(a[2]!);
      if (v === undefined) return undefined;
      node.attrs.set(a[1]!, v);
    }
    if (stack.length) stack[stack.length - 1]!.children.push(node);
    if (self) {
      if (!stack.length) {
        if (root) return undefined;
        root = node;
      }
    } else stack.push(node);
  }
  return stack.length ? undefined : root;
}

const NOT = Symbol('not understood');

/** One scalar as the client's parser reads it. */
function scalar(s: string): Exclude<ModValue, ModTable> | typeof NOT {
  if (s === 'null') return null;
  const kind = s.slice(0, 2);
  const body = s.slice(2);
  if (kind === 's|') return body;
  if (kind === 'i|') {
    const n = Number.parseInt(body, 10);
    return Number.isFinite(n) ? n : NOT;
  }
  if (kind === 'd|' || kind === 'f|') {
    const n = Number(body);
    return body.trim() !== '' && Number.isFinite(n) ? n : NOT;
  }
  if (kind === 'b|') return s === 'b|1';
  return NOT;
}

/** A table element's `<e>` entries, as the client's parser reads them. */
function tableOf(node: Node): ModTable | undefined {
  const out: ModTable = new Map();
  for (const e of node.children) {
    if (e.name !== 'e') continue;
    const part = (n: 'k' | 'v'): ModValue | typeof NOT => {
      const a = e.attrs.get(n);
      if (a !== undefined) return scalar(a);
      const child = e.children.find((c) => c.name === n);
      if (!child) return NOT;
      return tableOf(child) ?? NOT;
    };
    const k = part('k');
    const v = part('v');
    if (k === NOT || v === NOT) return undefined;
    if (typeof k !== 'string' && typeof k !== 'number') return undefined;
    out.set(k, v);
  }
  return out;
}

/** A mod's stored table from its XML; `undefined` when the text is not one this parser understands. */
export function parseModTable(xml: string): ModTable | undefined {
  try {
    const root = parseXml(xml);
    if (root?.name !== 'm') return undefined;
    return tableOf(root);
  } catch {
    return undefined;
  }
}

/** A Lua array (a table keyed 1..n) as a list; `undefined` when `v` is no such table. An empty table is `[]`. */
export function luaArray(v: ModValue | undefined): ModValue[] | undefined {
  if (!(v instanceof Map)) return undefined;
  const out: ModValue[] = [];
  for (let i = 1; i <= v.size; i++) {
    if (!v.has(i)) return undefined;
    out.push(v.get(i)!);
  }
  return out;
}

/** A table's integer field; `undefined` when absent or not an integer. */
export function intField(t: ModTable, key: string): number | undefined {
  const v = t.get(key);
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}
