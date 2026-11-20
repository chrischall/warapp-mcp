// #437: the map record's views read only the current game's format (and Local Deployment / Commanders),
// say how many kept games matched, and count lottery and no-show games apart. Synthetic records only.
import { describe, expect, it } from 'vitest';
import type { MapEntry, MapRecord } from '../src/lessons-store.js';
import { mapRecordView, paceView } from '../src/tools/past-games.js';

const key = (n: number) => n.toString(16).padStart(32, '0');
const entry = (n: number, o: Partial<MapEntry>): MapEntry => ({
  key: key(n),
  format: 'ffa',
  seats: 4,
  result: 'eliminated',
  turns: 12,
  me: { territories: [1], bonuses: [100], income: [], income4: 8, income8: 9 },
  winners: [{ territories: [6], bonuses: [200], income4: 20, income8: 40 }],
  ...o,
});
const REC: MapRecord = {
  version: 1,
  mapId: 7,
  games: 2,
  outcomes: { eliminated: 1, won: 1 },
  entries: [
    entry(1, {}),
    entry(2, { format: 'team', result: 'won', me: { territories: [2], bonuses: [300], income: [], income4: 5, income8: 7 }, winners: [{ territories: [2], bonuses: [300], income4: 5, income8: 7 }] }),
  ],
  excluded: { lottery: 2, noShow: 1, keys: [] },
};
const bonusName = (id: number) => ({ id, name: `b${id}` });

describe('#437: the map record views by the current game', () => {
  it('mapRecordView: only the matching format, with what matched and what was counted apart', () => {
    const v = mapRecordView(REC, { bonusName, full: true, match: { format: 'team' } });
    expect(v.games).toBe(1);
    expect(v.outcomes).toEqual({ won: 1 });
    expect(v.myStarts.map((m) => m.bonus.id)).toEqual([300]);
    expect(v.pace.afterTurn4).toEqual({ winners: 5, mine: 5 });
    expect(v.matched).toMatchObject({ by: { format: 'team' }, entries: 1, of: 2, settingsUnknown: 0 });
    expect(v.excluded).toMatchObject({ lottery: 2, noShow: 1 });
  });
  it('mapRecordView without a game: every kept game, as before', () => {
    const v = mapRecordView(REC, { bonusName, full: true });
    expect(v.games).toBe(2);
    expect(v).not.toHaveProperty('matched');
  });
  it('paceView: the pace of the matching games only; none matching gives no pace', () => {
    expect(paceView(REC, 4, 6, { format: 'team' })).toMatchObject({ afterTurn: 4, mine: 6, winners: 5, myPast: 5, games: 1, matched: { entries: 1, of: 2 } });
    expect(paceView(REC, 4, 6, { format: '1v1' })).toBeUndefined();
    expect(paceView(REC, 4, 6)).toMatchObject({ winners: 12.5, games: 2 });
  });
});
