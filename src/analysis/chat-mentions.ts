// Whether a chat message mentions me (warapp_chat_inbox `only: "mentionsMe"`, its public summary): my name, or a
// territory I hold — by name (a whole word, any case) or by its chat link token `<a t=<id>>` (src/chat-links.ts).
// Pure; other players' text is only matched, never echoed from here.

/** What a mention test reads: my names and the territories I hold. */
export interface MentionTargets {
  names: readonly string[];
  territories: ReadonlyArray<{ id: number; name: string }>;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A whole-word, case-insensitive matcher for `word` (letters and digits around it end no word). */
const wordRe = (word: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(word)}(?![\\p{L}\\p{N}_])`, 'iu');
const usable = (s: string) => s.trim().length >= 2;

/** The mentions of me in `text`: my name, and the ids of my territories named or linked; undefined when none. */
export function mentionsOf(text: string, me: MentionTargets): { name: boolean; territories: number[] } | undefined {
  const name = me.names.some((n) => usable(n) && wordRe(n.trim()).test(text));
  const linked = new Set([...text.matchAll(/<a t=(\d{1,10})>/g)].map((m) => Number(m[1])));
  const territories = me.territories
    .filter((t) => linked.has(t.id) || (usable(t.name) && wordRe(t.name.trim()).test(text)))
    .map((t) => t.id)
    .sort((a, b) => a - b);
  return name || territories.length ? { name, territories } : undefined;
}
