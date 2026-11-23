// Territory and bonus links in chat (docs/WEB-PROTOCOL.md "Chat links").
//
// war.app's chat editor shows a link as <span class="ujsChatLink" data-link="t_<id>">Name</span>
// (`b_<id>` for a bonus). Before posting, the client serializes the editor to `<a t_<id>>Name</a>` and
// rewrites that (ChatTab's send) to the bare token `<a t=<id>>` — the name and `</a>` are dropped — and the
// receiving client (ChatChunk's parser) splits a message on `<a t=…>` / `<a b=…>` and renders the id
// through the map: the territory's or bonus's name, "(???)" for an id the map lacks. The territory token is
// VERIFIED live (owner, 2026-11-23: a sent message read back through GameRefresh); the bonus token is read
// from the client bundle and UNVERIFIED live.
//
// A caller writes `[[t:<id or name>]]` / `[[b:<id or name>]]` in a message; `link_territories` also links
// every whole-word mention of a territory name. Names are other players' maps' words: callers delimit them.

import { McpToolError } from '@chrischall/mcp-utils';
import type { GameMap } from './normalize.js';
import { UNTRUSTED_LIST_MAX, untrustedList, untrustedText } from './tools/common.js';

export type ChatLinkKind = 'territory' | 'bonus';

export interface ChatLink {
  kind: ChatLinkKind;
  id: number;
  /** The territory's or bonus's name on the game's map; `null` when the map is not known or lacks the id. */
  name: string | null;
}

/** A caller's link marker: `[[t:…]]` or `[[b:…]]`. */
const MARKER = /\[\[([tb]):([^[\]]*)\]\]/g;
/** The wire token war.app's client sends and parses (its parser takes 1–10 characters of id). */
const TOKEN = /<a ([tb])=(\d{1,10})>/g;
/** A marker or a wire token: never auto-linked inside. */
const PROTECTED = /\[\[[tb]:[^[\]]*\]\]|<a [tb]=\d{1,10}>/g;

const kindOf = (c: string): ChatLinkKind => (c === 't' ? 'territory' : 'bonus');
const token = (kind: ChatLinkKind, id: number) => `<a ${kind === 'territory' ? 't' : 'b'}=${id}>`;
const plural = (kind: ChatLinkKind) => (kind === 'territory' ? 'territories' : 'bonuses');

export const hasChatLinkMarkers = (text: string): boolean => new RegExp(MARKER.source).test(text);

type Named = { id: number; name: string };
const itemsOf = (map: GameMap, kind: ChatLinkKind): readonly Named[] => (kind === 'territory' ? map.territories : map.bonuses);

function ambiguous(kind: ChatLinkKind, raw: string, hits: readonly Named[]): McpToolError {
  const label = (i: Named) => `${untrustedText(i.name)} (${i.id})`;
  return new McpToolError(
    `${JSON.stringify(raw)} matches ${hits.length} ${plural(kind)}: ${untrustedList(hits, UNTRUSTED_LIST_MAX, label)}; nothing was sent.`,
    { hint: `Link the one you mean by its id: [[${kind === 'territory' ? 't' : 'b'}:<id>]].` },
  );
}

/** A marker's target: an id on the map first, else the one case-insensitive exact name (never part of a name). */
export function resolveChatLink(map: GameMap, kind: ChatLinkKind, input: string): Named {
  const raw = input.trim();
  if (!raw) throw new McpToolError(`Name a ${kind} in the link (an id or a name); nothing was sent.`);
  const items = itemsOf(map, kind);
  if (/^\d+$/.test(raw)) {
    const byId = items.find((i) => i.id === Number(raw));
    if (byId) return byId;
  }
  const q = raw.toLowerCase();
  const hits = items.filter((i) => i.name.toLowerCase() === q);
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) {
    throw new McpToolError(`No ${kind} on this game's map matches ${JSON.stringify(raw)}; nothing was sent.`, {
      hint: `Use the ${kind}'s id, or its full name as the map spells it (warapp_get_map lists them).`,
    });
  }
  throw ambiguous(kind, raw, hits);
}

const WORD = /[\p{L}\p{N}_]/u;
const isWord = (c: string | undefined) => c !== undefined && WORD.test(c);

/**
 * Every whole-word, case-insensitive mention of a territory name in `text`, the longest name first where names
 * overlap at one place, scanning left to right (a match is never re-entered). A name two territories share is refused.
 */
function autoLink(text: string, map: GameMap, push: (wire: string, rendered: string, link?: ChatLink) => void): void {
  const byName = new Map<string, Named[]>();
  for (const t of map.territories) {
    const k = t.name.trim().toLowerCase();
    if (k) byName.set(k, [...(byName.get(k) ?? []), t]);
  }
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  let plain = '';
  for (let i = 0; i < text.length; ) {
    let hit: string | undefined;
    if (!isWord(text[i - 1])) {
      hit = names.find((n) => lower.startsWith(n, i) && !isWord(text[i + n.length]) && n.length > 0);
    }
    if (hit === undefined) {
      plain += text[i]!;
      i++;
      continue;
    }
    const hits = byName.get(hit)!;
    if (hits.length > 1) throw ambiguous('territory', text.slice(i, i + hit.length), hits);
    const t = hits[0]!;
    if (plain) push(plain, plain);
    plain = '';
    push(token('territory', t.id), t.name, { kind: 'territory', id: t.id, name: t.name });
    i += hit.length;
  }
  if (plain) push(plain, plain);
}

export interface EncodedChat {
  /** The text war.app is sent: each link as the client's `<a t=ID>` / `<a b=ID>` token. */
  wire: string;
  /** The text as players see it: each link as its name. */
  rendered: string;
  /** The links, in the order they appear. */
  links: ChatLink[];
}

/**
 * A caller's message with its `[[t:…]]` / `[[b:…]]` markers (and, with `linkTerritories`, every territory name
 * it mentions) turned into the client's link tokens. With nothing to link the message comes back unchanged.
 * Throws a `McpToolError` (nothing sent) on a name that is unknown or ambiguous.
 */
export function encodeChatLinks(message: string, map: GameMap, opts: { linkTerritories?: boolean } = {}): EncodedChat {
  let wire = '';
  let rendered = '';
  const links: ChatLink[] = [];
  const push = (w: string, r: string, link?: ChatLink) => {
    wire += w;
    rendered += r;
    if (link) links.push(link);
  };
  const plainPart = (s: string) => (opts.linkTerritories ? autoLink(s, map, push) : push(s, s));
  let at = 0;
  for (const m of message.matchAll(PROTECTED)) {
    plainPart(message.slice(at, m.index));
    at = m.index + m[0].length;
    const marker = /^\[\[([tb]):([^[\]]*)\]\]$/.exec(m[0]);
    if (marker) {
      const kind = kindOf(marker[1]!);
      const it = resolveChatLink(map, kind, marker[2]!);
      push(token(kind, it.id), it.name, { kind, id: it.id, name: it.name });
    } else {
      // A token already in the message passes as written (a caller's own `<a t=ID>`).
      push(m[0], m[0]);
    }
  }
  plainPart(message.slice(at));
  if (!links.length) return { wire: message, rendered: message, links: [] };
  return { wire, rendered, links };
}

/**
 * A received message's link tokens decoded: `text` with each token rendered as its name (an id the map lacks,
 * or no map, keeps the raw token) and `links` in order. A message with no token comes back unchanged.
 */
export function decodeChatLinks(text: string, map: GameMap | undefined): { text: string; links: ChatLink[] } {
  const links: ChatLink[] = [];
  const out = text.replace(TOKEN, (raw, c: string, digits: string) => {
    const kind = kindOf(c);
    const id = Number(digits);
    const it = map ? itemsOf(map, kind).find((i) => i.id === id) : undefined;
    links.push({ kind, id, name: it?.name ?? null });
    return it ? it.name : raw;
  });
  return { text: out, links };
}
