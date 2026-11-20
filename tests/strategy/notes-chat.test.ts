// #415 task 2: notes on chat play in free-for-alls (what a message reveals, withholding, pricing asks).
import { describe, expect, it } from 'vitest';
import type { GameProfile } from '../../src/analysis/profile.js';
import { notesFor, STRATEGY_NOTES, STRATEGY_SOURCES } from '../../src/strategy/notes.js';

const CHAT_NOTES = [
  'diplomacy-chat-income-check',
  'diplomacy-chat-withhold',
  'diplomacy-chat-gang-up-ask',
  'diplomacy-chat-threat',
  'diplomacy-chat-trust-little',
];

const profile = (over: Partial<GameProfile> = {}): GameProfile => ({
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
  settings: { luck: 0, rounding: 'StraightRound', cards: false, localDeployments: false, noSplit: false, commanders: false, fog: 'Foggy' },
});

describe('chat notes', () => {
  it('are diplomacy notes in our words, at most 340 characters, from a researched page', () => {
    const sources = new Set<string>(Object.values(STRATEGY_SOURCES));
    for (const id of CHAT_NOTES) {
      const n = STRATEGY_NOTES.find((x) => x.id === id);
      expect(n, id).toBeDefined();
      expect(n!.topic, id).toBe('diplomacy');
      expect(n!.text.length, id).toBeLessThanOrEqual(340);
      expect(sources.has(n!.source), id).toBe(true);
    }
  });

  it('name only tools that exist', () => {
    const tools = ['warapp_advise_diplomacy', 'warapp_record_agreement', 'warapp_get_chat', 'warapp_send_chat'];
    for (const id of CHAT_NOTES) {
      for (const t of STRATEGY_NOTES.find((x) => x.id === id)!.text.match(/warapp_[a-z_]+/g) ?? []) expect(tools, `${id}: ${t}`).toContain(t);
    }
  });

  it('apply to free-for-alls, not to a 1v1 or a team game', () => {
    const ffa = notesFor(profile()).map((n) => n.id);
    for (const id of CHAT_NOTES) expect(ffa, id).toContain(id);
    const duel = notesFor(profile({ format: '1v1', opponents: 1 })).map((n) => n.id);
    const teams = notesFor(profile({ format: 'teams', opponents: 2 })).map((n) => n.id);
    for (const id of CHAT_NOTES) {
      expect(duel, id).not.toContain(id);
      expect(teams, id).not.toContain(id);
    }
  });
});
