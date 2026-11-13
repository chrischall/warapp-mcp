import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import type { GameProfile } from '../../src/analysis/profile.js';
import type { GameMap } from '../../src/normalize.js';
import {
  feedProfile,
  generalNotes,
  NOTE_TOPICS,
  notesFor,
  notesMarkdown,
  STRATEGY_NOTES,
  STRATEGY_SOURCES,
} from '../../src/strategy/notes.js';

const profile = (over: Partial<GameProfile> = {}, settings: Partial<GameProfile['settings']> = {}): GameProfile => ({
  format: '1v1',
  opponents: 1,
  phase: 'expansion',
  standing: 'even',
  notes: [],
  ...over,
  settings: {
    luck: 0,
    rounding: 'StraightRound',
    cards: false,
    localDeployments: false,
    noSplit: false,
    commanders: false,
    fog: 'Foggy',
    ...settings,
  },
});

const ids = (p: GameProfile, topic?: (typeof NOTE_TOPICS)[number]) => notesFor(p, topic).map((n) => n.id);

describe('strategy notes: the data', () => {
  it('every note has a unique id, a known topic, text and a source from the researched pages', () => {
    const seen = new Set<string>();
    const sources = new Set<string>(Object.values(STRATEGY_SOURCES));
    for (const n of STRATEGY_NOTES) {
      expect(seen.has(n.id), n.id).toBe(false);
      seen.add(n.id);
      expect(NOTE_TOPICS).toContain(n.topic);
      expect(n.text.length, n.id).toBeGreaterThan(40);
      expect(n.source, n.id).toMatch(/^https:\/\/war\.app\/(Forum|wiki)\//);
      expect(sources.has(n.source), `${n.id}: ${n.source}`).toBe(true);
      expect(['source', 'derived']).toContain(n.basis);
    }
  });

  it('covers every topic', () => {
    for (const t of NOTE_TOPICS) expect(STRATEGY_NOTES.some((n) => n.topic === t), t).toBe(true);
  });

  it('every researched source backs at least one note', () => {
    for (const url of Object.values(STRATEGY_SOURCES)) expect(STRATEGY_NOTES.some((n) => n.source === url), url).toBe(true);
  });

  it('generalNotes lists every note, or one topic', () => {
    expect(generalNotes()).toHaveLength(STRATEGY_NOTES.length);
    expect(generalNotes('cards').every((n) => n.topic === 'cards')).toBe(true);
    expect(generalNotes('cards').length).toBeGreaterThan(0);
  });

  it('docs/STRATEGY.md names every note id', () => {
    const doc = readFileSync(new URL('../../docs/STRATEGY.md', import.meta.url), 'utf8');
    for (const n of STRATEGY_NOTES) expect(doc, n.id).toContain(`\`${n.id}\``);
  });
});

describe('strategy notes: selection by profile', () => {
  it('1v1 gets the 1v1 notes and none of the FFA or team ones', () => {
    const got = ids(profile());
    expect(got).toContain('1v1-break-bonuses');
    expect(got.some((id) => id.startsWith('ffa-'))).toBe(false);
    expect(got.some((id) => id.startsWith('teams-'))).toBe(false);
  });

  it('FFA gets the FFA notes and none of the 1v1 ones', () => {
    const got = ids(profile({ format: 'ffa', opponents: 3 }));
    expect(got).toContain('ffa-strike-last');
    expect(got).toContain('ffa-pick-fights');
    expect(got.some((id) => id.startsWith('1v1-'))).toBe(false);
  });

  it('teams get the team note', () => {
    expect(ids(profile({ format: 'teams', opponents: 2 }))).toContain('teams-focus');
  });

  it('card notes only when cards are in play', () => {
    expect(ids(profile(), 'cards')).toEqual([]);
    const got = ids(profile({}, { cards: true }), 'cards');
    expect(got).toEqual(expect.arrayContaining(['cards-piece-each-turn', 'cards-order-delay', 'cards-order-priority']));
  });

  it('Blockade on my own bonus only when I am behind (or cannot tell)', () => {
    expect(ids(profile({ standing: 'ahead' }, { cards: true }))).not.toContain('cards-blockade-own-bonus');
    expect(ids(profile({ standing: 'behind' }, { cards: true }))).toContain('cards-blockade-own-bonus');
    expect(ids(profile({ standing: 'unknown' }, { cards: true }))).toContain('cards-blockade-own-bonus');
  });

  it('luck notes follow the luck setting', () => {
    expect(ids(profile())).toContain('settings-no-luck-exact');
    expect(ids(profile())).not.toContain('settings-luck-guaranteed');
    const lucky = ids(profile({}, { luck: 16 }));
    expect(lucky).toContain('settings-luck-guaranteed');
    expect(lucky).not.toContain('settings-no-luck-exact');
  });

  it('rounding, Local Deployment and No-Split notes only when set', () => {
    expect(ids(profile())).not.toContain('settings-weighted-rounding');
    expect(ids(profile())).not.toContain('settings-local-deployments');
    expect(ids(profile())).not.toContain('settings-no-split');
    const on = ids(profile({}, { rounding: 'WeightedRandom', localDeployments: true, noSplit: true }));
    expect(on).toEqual(expect.arrayContaining(['settings-weighted-rounding', 'settings-local-deployments', 'settings-no-split']));
  });

  it('ahead and behind play follow the standing; unknown gets both', () => {
    expect(ids(profile({ standing: 'ahead' }))).toContain('reading-ahead');
    expect(ids(profile({ standing: 'ahead' }))).not.toContain('reading-behind');
    expect(ids(profile({ standing: 'behind' }))).toContain('reading-behind');
    expect(ids(profile({ standing: 'behind' }))).not.toContain('reading-ahead');
    expect(ids(profile({ standing: 'even' }))).not.toContain('reading-ahead');
    expect(ids(profile({ standing: 'unknown' }))).toEqual(expect.arrayContaining(['reading-ahead', 'reading-behind']));
  });

  it('always includes the efficient-sizes and army-counting notes', () => {
    for (const p of [profile(), profile({ format: 'ffa' }), profile({ format: 'teams' })]) {
      expect(ids(p)).toEqual(expect.arrayContaining(['settings-efficient-sizes', 'reading-count-armies']));
    }
  });

  it('filters by topic', () => {
    const got = notesFor(profile(), 'reading');
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((n) => n.topic === 'reading')).toBe(true);
  });
});

describe('feedProfile: a profile from GameFeed alone', () => {
  const map: GameMap = {
    id: 1,
    name: 'Line',
    territories: [1, 2, 3].map((id) => ({ id, name: `T${id}`, connectedTo: [id - 1, id + 1].filter((x) => x >= 1 && x <= 3) })),
    bonuses: [],
    distributionModes: [],
  };
  const graph = buildGraph(map);

  it('two players: 1v1, standing unknown (no board), settings echoed', () => {
    const p = feedProfile({ graph, players: [{ id: 7 }, { id: 9 }], settings: { luckModifier: 0.16, cards: true }, turn: 5 });
    expect(p.format).toBe('1v1');
    expect(p.standing).toBe('unknown');
    expect(p.settings.luck).toBe(16);
    expect(p.settings.cards).toBe(true);
    expect(p.phase).toBe('expansion');
  });

  it('three seated players: ffa; picking: opening', () => {
    const p = feedProfile({ graph, players: [{ id: 7 }, { id: 9 }, { id: 11 }], picking: true });
    expect(p.format).toBe('ffa');
    expect(p.phase).toBe('opening');
  });

  it('teams when a player carries a team', () => {
    const p = feedProfile({ graph, players: [{ id: 7, team: 0 }, { id: 9, team: 1 }, { id: 11, team: 1 }, { id: 13, team: 0 }] });
    expect(p.format).toBe('teams');
  });

  it('players that are out do not count: two of three still playing is a 1v1 late game', () => {
    const p = feedProfile({ graph, players: [{ id: 7 }, { id: 9 }, { id: 11, state: 'Eliminated' }], turn: 9 });
    expect(p.format).toBe('1v1');
    expect(p.phase).toBe('late');
  });
});

describe('notesMarkdown', () => {
  it('groups notes by topic with their source links', () => {
    const md = notesMarkdown(generalNotes());
    expect(md.match(/^## /gm)).toHaveLength(NOTE_TOPICS.length);
    for (const n of STRATEGY_NOTES) expect(md).toContain(n.source);
    expect(md).toContain('`settings-efficient-sizes`');
  });
});
