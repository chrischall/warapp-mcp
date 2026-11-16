// Notes from the lost 1v1s relayed by the play session (#300): the gate budget, Local Deployment's
// per-front threat, a contested bonus fed piecemeal, the move order read from my own first order,
// and stack growth split before calling a game even. Each is derived from a researched page and
// offered only in the games its condition names.
import { describe, expect, it } from 'vitest';
import type { GameProfile } from '../../src/analysis/profile.js';
import { type NoteContext, notesFor, STRATEGY_NOTES, STRATEGY_SOURCES } from '../../src/strategy/notes.js';

const profile = (over: Partial<GameProfile> = {}, settings: Partial<GameProfile['settings']> = {}): GameProfile => ({
  format: '1v1',
  opponents: 1,
  phase: 'contact',
  standing: 'even',
  standingSource: 'visible',
  humansAlive: 2,
  aiOpponents: [],
  endsWith: null,
  notes: [],
  ...over,
  settings: { luck: 0, rounding: 'StraightRound', cards: false, localDeployments: false, noSplit: false, commanders: false, fog: 'Foggy', ...settings },
});
const ids = (p: GameProfile, x: NoteContext = {}) => notesFor(p, undefined, x).map((n) => n.id);
const note = (id: string) => STRATEGY_NOTES.find((n) => n.id === id);

const LESSONS = {
  '1v1-gate-budget': { topic: 'format', source: STRATEGY_SOURCES.oneVsOne },
  'settings-local-deploy-front': { topic: 'settings', source: STRATEGY_SOURCES.localDeployments },
  'fighting-contested-bonus-mass': { topic: 'fighting', source: STRATEGY_SOURCES.beginnerGuide },
  'timing-read-first-mover-strike': { topic: 'timing', source: STRATEGY_SOURCES.moveOrder },
  'reading-split-growth': { topic: 'reading', source: STRATEGY_SOURCES.oneVsOne },
} as const;

describe('lesson notes (#300): the data', () => {
  it('each is derived from a page already researched', () => {
    for (const [id, want] of Object.entries(LESSONS)) {
      const n = note(id);
      expect(n, id).toBeDefined();
      expect(n!.topic, id).toBe(want.topic);
      expect(n!.source, id).toBe(want.source);
      expect(n!.basis, id).toBe('derived');
      expect(n!.encoded, id).toBeUndefined();
    }
  });

  it('the gate budget states the arithmetic: stack plus whole deploy at the kill rate, per gate', () => {
    const t = note('1v1-gate-budget')!.text;
    expect(t).toMatch(/whole deploy/);
    expect(t).toMatch(/kill rate/);
    expect(t).toMatch(/each/i);
    expect(t).toMatch(/uncontested|nobody contests/);
  });

  it('Local Deployment sizes a front on free income, the local pool and what walks up behind it', () => {
    const t = note('settings-local-deploy-front')!.text;
    expect(t).toMatch(/free income/);
    expect(t).toMatch(/pool/);
    expect(t).toMatch(/next turn/);
    expect(t).toMatch(/not .*total/);
  });

  it('a contested bonus: mass for one turn or leave it, and garrison what a roaming stack reaches', () => {
    const t = note('fighting-contested-bonus-mass')!.text;
    expect(t).toMatch(/one turn/);
    expect(t).toMatch(/leave it/);
    expect(t).toMatch(/garrison/i);
  });

  it('the move order is read from my first order, and a big strike waits for a turn I move first', () => {
    const t = note('timing-read-first-mover-strike')!.text;
    expect(t).toMatch(/first order/);
    expect(t).toMatch(/first_mover/);
    expect(t).toMatch(/move first/);
    // first_mover is who moves first THIS turn: alternate from the turn read, never pass that turn's value.
    expect(t).not.toMatch(/that turn as first_mover/);
    expect(t).toMatch(/first_mover: me/);
    expect(t).toMatch(/inference/);
    expect(t).toMatch(/0% luck/);
    expect(t).toMatch(/check_plan/);
  });

  it('growth is split three ways before calling a game even', () => {
    const t = note('reading-split-growth')!.text;
    expect(t).toMatch(/neighbour in view/);
    expect(t).toMatch(/fog/);
    expect(t).toMatch(/only be deploy/);
    expect(t).toMatch(/even/);
  });
});

describe('lesson notes (#300): which games get them', () => {
  it('the gate budget is for a 1v1 before and at contact, never an FFA or the late game', () => {
    expect(ids(profile({ phase: 'expansion' }))).toContain('1v1-gate-budget');
    expect(ids(profile({ phase: 'contact' }))).toContain('1v1-gate-budget');
    expect(ids(profile({ phase: 'late' }))).not.toContain('1v1-gate-budget');
    expect(ids(profile({ format: 'ffa', opponents: 3 }))).not.toContain('1v1-gate-budget');
  });

  it('the per-front threat only under Local Deployment, in contact', () => {
    expect(ids(profile({}, { localDeployments: true }))).toContain('settings-local-deploy-front');
    expect(ids(profile())).not.toContain('settings-local-deploy-front');
    expect(ids(profile({ phase: 'opening' }, { localDeployments: true }))).not.toContain('settings-local-deploy-front');
  });

  it('the contested bonus once an enemy stack fights over it: contact and after', () => {
    expect(ids(profile())).toContain('fighting-contested-bonus-mass');
    expect(ids(profile({ format: 'ffa', opponents: 3, phase: 'late' }))).toContain('fighting-contested-bonus-mass');
    expect(ids(profile({ phase: 'expansion' }))).not.toContain('fighting-contested-bonus-mass');
  });

  it('reading the first mover needs a cyclic two-player order', () => {
    expect(ids(profile(), { moveOrder: 'Cycle' })).toContain('timing-read-first-mover-strike');
    expect(ids(profile(), { moveOrder: 'NoLuckCycle' })).toContain('timing-read-first-mover-strike');
    expect(ids(profile(), { moveOrder: 'Random' })).not.toContain('timing-read-first-mover-strike');
    expect(ids(profile())).not.toContain('timing-read-first-mover-strike');
    expect(ids(profile({ format: 'ffa', opponents: 3 }), { moveOrder: 'Cycle' })).not.toContain('timing-read-first-mover-strike');
  });

  it('splitting growth needs fog and contact', () => {
    expect(ids(profile())).toContain('reading-split-growth');
    expect(ids(profile({}, { fog: 'NoFog' }))).not.toContain('reading-split-growth');
    expect(ids(profile({ phase: 'expansion' }))).not.toContain('reading-split-growth');
  });
});
