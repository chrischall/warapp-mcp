import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { leavers, normalizeGame, parseEndRules, parseFeedTime } from '../src/normalize.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/gamefeed-lobby-map39905.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('parseEndRules (#178)', () => {
  it('reads the lobby fixture: instant surrender, no AIs, boot after two days', () => {
    const r = parseEndRules((FIXTURE.settings as Record<string, unknown>));
    expect(r).toEqual({
      instantSurrender: true,
      surrenderedTurnIntoAI: false,
      bootedTurnIntoAI: false,
      timesCanComeBackFromAI: 2,
      aisSurrenderWhenOneHumanRemains: false,
      directBootMinutes: 2880,
      autoBootMinutes: 2880,
      bankingBoot: { bankMinutes: 0, initialBankMinutes: 480 },
      allowVacations: false,
    });
  });

  it('reads booleans and string booleans; a surrender value it does not know is kept, not guessed', () => {
    expect(parseEndRules({ InstantSurrender: false }).instantSurrender).toBe(false);
    expect(parseEndRules({ InstantSurrender: 'False' }).instantSurrender).toBe(false);
    expect(parseEndRules({ InstantSurrender: 'True' }).instantSurrender).toBe(true);
    const odd = parseEndRules({ InstantSurrender: 'SomethingElse' });
    expect(odd.instantSurrender).toBeUndefined();
    expect(odd.instantSurrenderRaw).toBe('SomethingElse');
    expect(parseEndRules({ SurrenderedPlayersTurnIntoAIs: 'True', AIsSurrenderWhenOneHumanRemains: true })).toMatchObject({
      surrenderedTurnIntoAI: true,
      aisSurrenderWhenOneHumanRemains: true,
    });
  });

  it('leaves out what the feed does not send', () => {
    expect(parseEndRules({})).toEqual({});
  });

  it('normalizeGame puts them on Game.endRules', () => {
    const g = normalizeGame(FIXTURE);
    expect(g.endRules?.instantSurrender).toBe(true);
    expect(normalizeGame({ ...FIXTURE, settings: undefined }).endRules).toBeUndefined();
  });
});

describe('parseFeedTime', () => {
  it('reads the feed\'s M/D/YYYY HH:MM:SS as UTC', () => {
    expect(parseFeedTime('11/3/2026 07:05:09')).toBe(Date.UTC(2026, 10, 3, 7, 5, 9));
    expect(parseFeedTime('not a date')).toBeUndefined();
    expect(parseFeedTime(undefined)).toBeUndefined();
  });
});

describe('leavers (#178)', () => {
  const base = normalizeGame({
    ...FIXTURE,
    state: 'Playing',
    lastTurnTime: '11/3/2026 00:00:00',
    players: [
      { id: '1001', name: 'A', state: 'Playing', hasCommittedOrders: 'False', isAI: 'False' },
      { id: '1002', name: 'B', state: 'Playing', hasCommittedOrders: 'True', isAI: 'False' },
      { id: '1003', name: 'C', state: 'Playing', hasCommittedOrders: 'False', isAI: 'True' },
      { id: '1004', name: 'D', state: 'Eliminated', hasCommittedOrders: 'False', isAI: 'False' },
    ],
  });
  const at = (h: number) => Date.UTC(2026, 10, 3) + h * 3_600_000;

  it('lists humans who have not committed, with the time left to each boot and what the seat becomes', () => {
    const r = leavers(base, at(40));
    expect(r.players).toEqual([
      { playerId: 1001, waitingMinutes: 2400, autoBootInMinutes: 480, directBootInMinutes: 480, becomes: 'neutral' },
    ]);
    expect(r.unverified).toMatch(/lastTurnTime/);
  });

  it('says a booted seat becomes an AI when the setting says so, and a boot already open is 0 minutes away', () => {
    const ai = { ...base, endRules: { ...base.endRules!, bootedTurnIntoAI: true } };
    const r = leavers(ai, at(50));
    expect(r.players[0]).toMatchObject({ autoBootInMinutes: 0, directBootInMinutes: 0, becomes: 'AI' });
  });

  it('lists no one outside a game being played, or without a readable lastTurnTime', () => {
    expect(leavers({ ...base, state: 'Finished' }, at(40)).players).toEqual([]);
    const { lastTurnTime: _l, ...noTime } = base;
    expect(leavers(noTime, at(40)).players).toEqual([]);
  });

  it('only names players within the soon window when one is given', () => {
    expect(leavers(base, at(10), { withinMinutes: 600 }).players).toEqual([]);
    expect(leavers(base, at(40), { withinMinutes: 600 }).players).toHaveLength(1);
  });
});
