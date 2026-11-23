// Territory and bonus links in chat: the `[[t:…]]` / `[[b:…]]` markers a caller writes, the
// `<a t=ID>` / `<a b=ID>` token war.app's client sends (read from the client bundle), and the decode
// of received messages.
import { describe, expect, it } from 'vitest';
import { McpToolError } from '@chrischall/mcp-utils';
import { decodeChatLinks, encodeChatLinks, hasChatLinkMarkers } from '../src/chat-links.js';
import type { GameMap } from '../src/normalize.js';

const MAP: GameMap = {
  id: 1,
  name: 'Test map',
  territories: [
    { id: 1, name: 'Winterfell', connectedTo: [] },
    { id: 2, name: 'Mistwood', connectedTo: [] },
    { id: 3, name: 'Mistwood', connectedTo: [] },
    { id: 42, name: 'Moat Cailin', connectedTo: [] },
    { id: 7, name: '12', connectedTo: [] },
  ],
  bonuses: [
    { id: 5, name: 'House Stark', value: 5, territoryIds: [1], bonusIds: [] },
    { id: 51, name: 'Moat Cailin', value: 1, territoryIds: [42], bonusIds: [] },
  ],
  distributionModes: [],
};

const refusal = (fn: () => unknown): McpToolError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(McpToolError);
    return e as McpToolError;
  }
  throw new Error('expected a refusal');
};

describe('encodeChatLinks', () => {
  it('a plain message is returned unchanged, with no links', () => {
    for (const text of ['gl hf', 'a [single] bracket', '[[x:1]] not a link kind', 'see <a t=1> typed by hand']) {
      expect(hasChatLinkMarkers(text)).toBe(false);
      expect(encodeChatLinks(text, MAP)).toEqual({ wire: text, rendered: text, links: [] });
    }
  });

  it('resolves a territory by id and by case-insensitive exact name, writing the client token', () => {
    expect(encodeChatLinks('hold [[t:1]] please', MAP)).toEqual({
      wire: 'hold <a t=1> please',
      rendered: 'hold Winterfell please',
      links: [{ kind: 'territory', id: 1, name: 'Winterfell' }],
    });
    expect(encodeChatLinks('watch [[t: moat cailin ]] and [[b:house stark]]', MAP)).toEqual({
      wire: 'watch <a t=42> and <a b=5>',
      rendered: 'watch Moat Cailin and House Stark',
      links: [
        { kind: 'territory', id: 42, name: 'Moat Cailin' },
        { kind: 'bonus', id: 5, name: 'House Stark' },
      ],
    });
  });

  it('the kind decides the namespace: the same name is a territory under t and a bonus under b', () => {
    expect(encodeChatLinks('[[b:Moat Cailin]]', MAP).wire).toBe('<a b=51>');
    expect(encodeChatLinks('[[t:Moat Cailin]]', MAP).wire).toBe('<a t=42>');
  });

  it('an id wins over a territory whose name is that number', () => {
    expect(encodeChatLinks('[[t:7]]', MAP).links).toEqual([{ kind: 'territory', id: 7, name: '12' }]);
    // No territory 12: the name "12" matches.
    expect(encodeChatLinks('[[t:12]]', MAP).links).toEqual([{ kind: 'territory', id: 7, name: '12' }]);
  });

  it('refuses an ambiguous name, listing every match with its id', () => {
    const e = refusal(() => encodeChatLinks('go [[t:mistwood]]', MAP));
    expect(e.message).toMatch(/matches 2 territories/);
    expect(e.message).toContain('(2)');
    expect(e.message).toContain('(3)');
    expect(e.message).toMatch(/nothing was sent/);
  });

  it('refuses an unknown name or id, and never matches part of a name', () => {
    expect(refusal(() => encodeChatLinks('[[t:Winter]]', MAP)).message).toMatch(/No territory .*"Winter"/);
    expect(refusal(() => encodeChatLinks('[[b:99]]', MAP)).message).toMatch(/No bonus .*"99"/);
    expect(refusal(() => encodeChatLinks('[[t:]]', MAP)).message).toMatch(/Name a territory/);
  });
});

describe('encodeChatLinks with linkTerritories', () => {
  const MAP2: GameMap = {
    ...MAP,
    territories: [
      ...MAP.territories,
      { id: 20, name: 'Cono Sur', connectedTo: [] },
      { id: 21, name: 'South Cono Sur', connectedTo: [] },
      { id: 22, name: 'Reach', connectedTo: [] },
    ],
  };
  const auto = (text: string) => encodeChatLinks(text, MAP2, { linkTerritories: true });

  it('links every whole-word mention, repeats included, case-insensitive', () => {
    expect(auto('winterfell then WINTERFELL, then Winterfell.')).toEqual({
      wire: '<a t=1> then <a t=1>, then <a t=1>.',
      rendered: 'Winterfell then Winterfell, then Winterfell.',
      links: [1, 1, 1].map((id) => ({ kind: 'territory', id, name: 'Winterfell' })),
    });
  });

  it('prefers the longest name where names overlap', () => {
    expect(auto('South Cono Sur and Cono Sur').wire).toBe('<a t=21> and <a t=20>');
  });

  it('never matches inside a word, a marker or an existing link token', () => {
    expect(auto('Reaching the reach').wire).toBe('Reaching the <a t=22>');
    expect(auto('[[b:Moat Cailin]] then Moat Cailin').wire).toBe('<a b=51> then <a t=42>');
    expect(auto('[[t:Winterfell]] <a t=42>').wire).toBe('<a t=1> <a t=42>');
  });

  it('a plain message with no territory name is unchanged', () => {
    expect(auto('gl hf')).toEqual({ wire: 'gl hf', rendered: 'gl hf', links: [] });
  });

  it('refuses a mention of a name two territories share, naming both ids', () => {
    const e = refusal(() => auto('meet at Mistwood'));
    expect(e.message).toMatch(/matches 2 territories/);
    expect(e.hint ?? '').toMatch(/\[\[t:<id>\]\]/);
  });
});

describe('decodeChatLinks', () => {
  it('plain text is unchanged, with no links', () => {
    for (const text of ['gl hf', 'a <a href=x> tag', '<a t=> empty', '<a t=12345678901> too long', '<a x=1>']) {
      expect(decodeChatLinks(text, MAP)).toEqual({ text, links: [] });
    }
  });

  it('decodes the tokens into names from the map', () => {
    expect(decodeChatLinks('hold <a t=1> and <a b=5>!', MAP)).toEqual({
      text: 'hold Winterfell and House Stark!',
      links: [
        { kind: 'territory', id: 1, name: 'Winterfell' },
        { kind: 'bonus', id: 5, name: 'House Stark' },
      ],
    });
  });

  it('without the map, or for an id the map lacks, the raw token stays and the name is null', () => {
    expect(decodeChatLinks('at <a t=1>', undefined)).toEqual({ text: 'at <a t=1>', links: [{ kind: 'territory', id: 1, name: null }] });
    expect(decodeChatLinks('<a b=999>', MAP)).toEqual({ text: '<a b=999>', links: [{ kind: 'bonus', id: 999, name: null }] });
  });

  it('round trip: what is encoded decodes back to the same links and rendering', () => {
    const sent = encodeChatLinks('[[t:Winterfell]] is next to [[b:51]], ok?', MAP);
    expect(decodeChatLinks(sent.wire, MAP)).toEqual({ text: sent.rendered, links: sent.links });
  });
});
