// The diplomacy pass (PLAN-TEAMS part E): notes on deals between players who are not on a team, and
// team chat. Each is offered only where it applies; the private-message ones read the game's
// PrivateMessaging setting, and a game that does not state it gets neither.
import { describe, expect, it } from 'vitest';
import type { GameProfile } from '../../src/analysis/profile.js';
import { normalizeSettings } from '../../src/normalize.js';
import { NOTE_TOPICS, type NoteContext, noteContext, noteMatches, notesFor, STRATEGY_NOTES, TOPIC_TITLES } from '../../src/strategy/notes.js';

const profile = (over: Partial<GameProfile> = {}, settings: Partial<GameProfile['settings']> = {}): GameProfile => ({
  format: 'ffa',
  opponents: 3,
  phase: 'contact',
  standing: 'even',
  standingSource: 'visible',
  humansAlive: 4,
  aiOpponents: [],
  endsWith: null,
  notes: [],
  ...over,
  settings: { luck: 0, rounding: 'StraightRound', cards: false, localDeployments: false, noSplit: false, commanders: false, fog: 'Foggy', ...settings },
});
const ids = (p: GameProfile, x: NoteContext = {}) => notesFor(p, undefined, x).map((n) => n.id);

const DIPLOMACY_NOTES = [
  'diplomacy-site-rules',
  'diplomacy-private-off',
  'diplomacy-read-description',
  'diplomacy-first-contact',
  'diplomacy-truce-scope-end',
  'diplomacy-truce-two-left',
  'diplomacy-stack-behind',
  'diplomacy-notice-early',
  'diplomacy-betrayal-cost',
  'diplomacy-restate-terms',
  'diplomacy-no-gang-up-calls',
  'diplomacy-unspoken-truce',
  'diplomacy-others-dealing',
  'diplomacy-two-against-one',
  'diplomacy-fog-checkable-terms',
  'diplomacy-card-farming',
  'teams-team-chat',
];

describe('diplomacy notes: the data', () => {
  it('a diplomacy topic with a title, holding every new note but the team one', () => {
    expect(NOTE_TOPICS).toContain('diplomacy');
    expect(TOPIC_TITLES.diplomacy).toMatch(/diplomacy/i);
    for (const id of DIPLOMACY_NOTES) {
      const n = STRATEGY_NOTES.find((x) => x.id === id);
      expect(n, id).toBeDefined();
      expect(n!.topic, id).toBe(id.startsWith('teams-') ? 'format' : 'diplomacy');
    }
    for (const n of STRATEGY_NOTES.filter((x) => x.topic === 'diplomacy')) expect(n.id.startsWith('diplomacy-'), n.id).toBe(true);
  });

  it('no note advises a card play: the diplomacy cards are played in the game client, not sent', () => {
    for (const id of DIPLOMACY_NOTES) {
      const text = STRATEGY_NOTES.find((x) => x.id === id)!.text;
      expect(text, id).not.toMatch(/\bplay (a|your|the) (Diplomacy|Gift|Sanctions|Spy|Airlift)/i);
    }
  });

  it('names only tools that exist', () => {
    const tools = ['warapp_advise_diplomacy', 'warapp_record_agreement', 'warapp_get_chat', 'warapp_send_chat'];
    for (const id of DIPLOMACY_NOTES) {
      for (const t of STRATEGY_NOTES.find((x) => x.id === id)!.text.match(/warapp_[a-z_]+/g) ?? []) expect(tools, `${id}: ${t}`).toContain(t);
    }
  });
});

describe('the private-messaging condition', () => {
  it('holds only when the game states the setting, and it matches', () => {
    expect(noteMatches({ privateMessaging: false }, profile())).toBe(false);
    expect(noteMatches({ privateMessaging: false }, profile(), { privateMessaging: false })).toBe(true);
    expect(noteMatches({ privateMessaging: false }, profile(), { privateMessaging: true })).toBe(false);
    expect(noteMatches({ privateMessaging: true }, profile(), { privateMessaging: true })).toBe(true);
  });

  it('is read from the PrivateMessaging setting', () => {
    expect(noteContext(normalizeSettings({ PrivateMessaging: false })).privateMessaging).toBe(false);
    expect(noteContext(normalizeSettings({ PrivateMessaging: 'True' })).privateMessaging).toBe(true);
    expect(noteContext(normalizeSettings({})).privateMessaging).toBeUndefined();
  });
});

describe('diplomacy notes: selection', () => {
  it('free-for-all games get the diplomacy notes; a 1v1 gets none', () => {
    const ffa = ids(profile());
    for (const id of ['diplomacy-site-rules', 'diplomacy-read-description', 'diplomacy-truce-scope-end', 'diplomacy-stack-behind', 'diplomacy-betrayal-cost'])
      expect(ffa, id).toContain(id);
    expect(ids(profile({ format: '1v1', opponents: 1 })).filter((id) => id.startsWith('diplomacy-'))).toEqual([]);
    expect(ids(profile({ format: 'teams' })).filter((id) => id.startsWith('diplomacy-'))).toEqual([]);
  });

  it('private messaging off gets the no-proposal note; on or unstated does not', () => {
    expect(ids(profile(), { privateMessaging: false })).toContain('diplomacy-private-off');
    expect(ids(profile(), { privateMessaging: true })).not.toContain('diplomacy-private-off');
    expect(ids(profile())).not.toContain('diplomacy-private-off');
  });

  it('the first-contact note is for before and at contact, not the late game', () => {
    expect(ids(profile({ phase: 'expansion' }))).toContain('diplomacy-first-contact');
    expect(ids(profile({ phase: 'late' }))).not.toContain('diplomacy-first-contact');
  });

  it('two against one is for three players only', () => {
    expect(ids(profile({ opponents: 2 }))).toContain('diplomacy-two-against-one');
    expect(ids(profile({ opponents: 3 }))).not.toContain('diplomacy-two-against-one');
  });

  it('checkable terms under fog that hides land; card farming only with cards', () => {
    expect(ids(profile())).toContain('diplomacy-fog-checkable-terms');
    expect(ids(profile({}, { fog: 'NoFog' }))).not.toContain('diplomacy-fog-checkable-terms');
    expect(ids(profile())).not.toContain('diplomacy-card-farming');
    expect(ids(profile({}, { cards: true }))).toContain('diplomacy-card-farming');
  });

  it('team chat for team games only', () => {
    expect(ids(profile({ format: 'teams' }))).toContain('teams-team-chat');
    expect(ids(profile())).not.toContain('teams-team-chat');
  });
});
