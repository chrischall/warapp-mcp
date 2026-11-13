import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import type { GameProfile } from '../../src/analysis/profile.js';
import type { BoardState } from '../../src/board.js';
import type { GameMap } from '../../src/normalize.js';
import {
  feedProfile,
  generalNotes,
  hasCostlyBonus,
  type NoteContext,
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
  standingSource: 'visible',
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

const ids = (p: GameProfile, topic?: (typeof NOTE_TOPICS)[number], context?: NoteContext) =>
  notesFor(p, topic, context).map((n) => n.id);

describe('strategy notes: the data', () => {
  it('every note has a unique id, a known topic, text and a source from the researched pages', () => {
    const seen = new Set<string>();
    const sources = new Set<string>(Object.values(STRATEGY_SOURCES));
    for (const n of STRATEGY_NOTES) {
      expect(seen.has(n.id), n.id).toBe(false);
      seen.add(n.id);
      expect(NOTE_TOPICS).toContain(n.topic);
      expect(n.text.length, n.id).toBeGreaterThan(40);
      // The war.app wiki and forum, or one of the community guides they link to.
      expect(n.source, n.id).toMatch(/^https:\/\/(war\.app\/(Forum|wiki)\/|warlight\.nghood\.com\/|docs\.google\.com\/document\/d\/)/);
      // Short enough to read at a glance: one or two sentences.
      expect(n.text.length, n.id).toBeLessThanOrEqual(340);
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

  it('defend-with-three only where its breakpoints hold: the default 60/70, not a 20/80 game', () => {
    expect(ids(profile())).toContain('settings-defend-with-three');
    expect(ids(profile(), 'settings', { offensiveKillRate: 60, defensiveKillRate: 70 })).toContain('settings-defend-with-three');
    expect(ids(profile(), 'settings', { offensiveKillRate: 20, defensiveKillRate: 80 })).not.toContain('settings-defend-with-three');
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

  const board = (owners: Array<[number, number]>): BoardState => ({
    source: 'gamefeed',
    verified: false,
    territories: owners.map(([territoryId, playerId]) => ({ territoryId, owner: { kind: 'player', playerId }, armies: 3 })),
  });

  it('with no board the phase falls back to expansion after the opening', () => {
    expect(feedProfile({ graph, players: [{ id: 7 }, { id: 9 }], turn: 5 }).phase).toBe('expansion');
  });

  it('a standing from GameFeed is read: bordering the opponent is contact', () => {
    const p = feedProfile({ graph, players: [{ id: 7 }, { id: 9 }], turn: 5, board: board([[1, 7], [2, 9]]) });
    expect(p.phase).toBe('contact');
  });

  it('a standing from GameFeed is read: one side over half the map is late', () => {
    const p = feedProfile({ graph, players: [{ id: 7 }, { id: 9 }], turn: 5, board: board([[1, 7], [2, 9], [3, 9]]) });
    expect(p.phase).toBe('late');
  });

  it('players that are out do not count: two of three still playing is a 1v1 late game', () => {
    const p = feedProfile({ graph, players: [{ id: 7 }, { id: 9 }, { id: 11, state: 'Eliminated' }], turn: 9 });
    expect(p.format).toBe('1v1');
    expect(p.phase).toBe('late');
  });
});

describe('hasCostlyBonus: a bonus whose completion cuts income', () => {
  const map = (bonuses: Array<[number, number, number[]]>): GameMap => ({
    id: 1,
    name: 'Bonuses',
    territories: [1, 2, 3, 4].map((id) => ({ id, name: `T${id}`, connectedTo: [id - 1, id + 1].filter((x) => x >= 1 && x <= 4) })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  });
  it('is false with no negative bonus, true with one that stands alone', () => {
    expect(hasCostlyBonus(buildGraph(map([[10, 3, [1, 2]]])))).toBe(false);
    expect(hasCostlyBonus(buildGraph(map([[10, 3, [1, 2]], [11, -2, [3, 4]]])))).toBe(true);
  });
  it('is false when the bonuses inside a negative one pay more than it costs (overlapping "progressive" maps)', () => {
    // −1 over territories 1–3, but the +2 and +1 inside it make the set worth +2.
    expect(hasCostlyBonus(buildGraph(map([[10, -1, [1, 2, 3]], [11, 2, [1, 2]], [12, 1, [3]]])))).toBe(false);
    // A bonus only partly inside does not offset it.
    expect(hasCostlyBonus(buildGraph(map([[10, -1, [1, 2, 3]], [11, 5, [3, 4]]])))).toBe(true);
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

// Research pass (the official wiki's Move order, Manual distribution, Turn phases, card and
// settings pages): rules the notes had wrong or lacked, and gating for notes whose arithmetic
// only holds under some settings.
describe('strategy notes: rules checked against the wiki, and gating', () => {
  const note = (id: string) => STRATEGY_NOTES.find((n) => n.id === id)!;

  it('no-luck-exact is not offered under weighted-random rounding (3 against 2 wins 80% there)', () => {
    expect(ids(profile())).toContain('settings-no-luck-exact');
    expect(ids(profile({}, { rounding: 'WeightedRandom' }))).not.toContain('settings-no-luck-exact');
  });

  it('the one-army poke needs a kill rate at which one attacker kills one, and exact results', () => {
    expect(ids(profile())).toContain('settings-poke');
    expect(ids(profile(), 'settings', { offensiveKillRate: 30, defensiveKillRate: 75 })).not.toContain('settings-poke');
    expect(ids(profile({}, { luck: 16 }))).not.toContain('settings-poke');
    expect(ids(profile({}, { rounding: 'WeightedRandom' }))).not.toContain('settings-poke');
  });

  it('defend-with-three needs exact results as well as the 60/70 breakpoints', () => {
    expect(ids(profile())).toContain('settings-defend-with-three');
    expect(ids(profile({}, { luck: 75 }))).not.toContain('settings-defend-with-three');
    expect(ids(profile({}, { rounding: 'WeightedRandom' }))).not.toContain('settings-defend-with-three');
  });

  it('move order: the zigzag always, attacking second only where defence out-kills attack', () => {
    const got = ids(profile());
    expect(got).toEqual(expect.arrayContaining(['settings-move-order-zigzag', 'settings-attack-second', 'reading-who-moves-first']));
    expect(note('settings-move-order-zigzag').source).toBe(STRATEGY_SOURCES.moveOrder);
    expect(ids(profile(), 'settings', { offensiveKillRate: 70, defensiveKillRate: 60 })).not.toContain('settings-attack-second');
    expect(ids(profile(), 'settings', { offensiveKillRate: 70, defensiveKillRate: 60 })).toContain('settings-move-order-zigzag');
  });

  it('a contested 2-army neutral: last with three, or first with four — at the 60/70 breakpoints only', () => {
    expect(ids(profile())).toContain('settings-contested-neutral');
    expect(ids(profile(), 'settings', { offensiveKillRate: 20, defensiveKillRate: 80 })).not.toContain('settings-contested-neutral');
  });

  it('the army cap and Multi-Attack notes follow the game settings', () => {
    expect(ids(profile())).not.toContain('settings-army-cap');
    expect(ids(profile(), 'settings', { armyCap: 8 })).toContain('settings-army-cap');
    expect(ids(profile(), 'settings', { armyCap: null })).not.toContain('settings-army-cap');
    expect(ids(profile())).not.toContain('settings-multi-attack');
    expect(ids(profile(), 'settings', { multiAttack: true })).toContain('settings-multi-attack');
  });

  it('the pick notes are offered in the opening only', () => {
    expect(ids(profile({ phase: 'opening' }))).toContain('reading-pick-zigzag');
    expect(ids(profile({ phase: 'contact' }))).not.toContain('reading-pick-zigzag');
    expect(note('reading-pick-zigzag').source).toBe(STRATEGY_SOURCES.manualDistribution);
  });

  it('an opponent out of sight is assumed to grow like me, under fog', () => {
    expect(ids(profile())).toContain('reading-unseen-opponent');
    expect(ids(profile({}, { fog: 'NoFog' }))).not.toContain('reading-unseen-opponent');
  });

  it('the card notes say what each card really moves, from its own page', () => {
    const c = { cards: true };
    expect(ids(profile({}, c), 'cards')).toEqual(expect.arrayContaining(['cards-turn-order']));
    // Order Priority moves the first order only; Order Delay only the orders listed after it.
    expect(note('cards-order-priority').text).toMatch(/only your first order/);
    expect(note('cards-order-priority').source).toBe(STRATEGY_SOURCES.orderPriority);
    expect(note('cards-order-delay').text).toMatch(/listed after it/);
    expect(note('cards-order-delay').text).toMatch(/does nothing/);
    expect(note('cards-order-delay').source).toBe(STRATEGY_SOURCES.orderDelay);
    // A Blockade resolves after the attacks and is lost with the territory.
    expect(note('cards-blockade-own-bonus').text).toMatch(/after the attacks/);
    expect(note('cards-blockade-own-bonus').source).toBe(STRATEGY_SOURCES.blockade);
  });

  it('No-Split says the whole stack moves', () => {
    expect(note('settings-no-split').text).toMatch(/everything/);
    expect(note('settings-no-split').source).toBe(STRATEGY_SOURCES.noSplit);
  });
});
