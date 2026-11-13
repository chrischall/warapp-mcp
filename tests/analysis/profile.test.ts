import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { AHEAD_RATIO, BEHIND_RATIO, gameProfile, type ProfileInput } from '../../src/analysis/profile.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;

/** A line 1 ─ 2 ─ … ─ n, no bonuses. */
function line(n: number): GameMap {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  return {
    id: 1,
    name: 'Line',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: ids.filter((x) => Math.abs(x - id) === 1),
    })),
    bonuses: [],
    distributionModes: [],
  };
}

const enemy = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

const g8 = buildGraph(line(8));
/** Me on 1–2, neutrals between, player 20 on 7–8: no contact. */
const apart = board([mine(1, 5), mine(2, 5), neutral(3, 2), neutral(4, 2), neutral(5, 2), neutral(6, 2), enemy(7, 5, 20), enemy(8, 5, 20)]);
/** Me on 1–3, player 20 on 4–6, neutrals 7–8: contact at 3 ─ 4. */
const touching = board([mine(1, 5), mine(2, 5), mine(3, 5), enemy(4, 5, 20), enemy(5, 5, 20), enemy(6, 5, 20), neutral(7, 2), neutral(8, 2)]);

const base = (over: Partial<ProfileInput> = {}): ProfileInput => ({
  graph: g8,
  board: apart,
  me: ME,
  players: [{ id: ME }, { id: 20 }],
  turn: 5,
  income: 5,
  estimates: [{ playerId: 20, estimate: 5 }],
  ...over,
});

describe('gameProfile: format', () => {
  it('two players still playing, no teams: 1v1', () => {
    const p = gameProfile(base());
    expect(p.format).toBe('1v1');
    expect(p.opponents).toBe(1);
  });

  it('three players, no teams: ffa', () => {
    const p = gameProfile(base({ players: [{ id: ME }, { id: 20 }, { id: 30 }] }));
    expect(p.format).toBe('ffa');
    expect(p.opponents).toBe(2);
  });

  it('2v2 with teams: teams, and my teammate is no opponent', () => {
    const p = gameProfile(
      base({
        players: [
          { id: ME, team: 0 },
          { id: 11, team: 0 },
          { id: 20, team: 1 },
          { id: 21, team: 1 },
        ],
      }),
    );
    expect(p.format).toBe('teams');
    expect(p.opponents).toBe(2);
  });

  it('players carrying the no-team value (-1) are not a team game', () => {
    const p = gameProfile(base({ players: [{ id: ME, team: -1 }, { id: 20, team: -1 }, { id: 30, team: -1 }] }));
    expect(p.format).toBe('ffa');
  });

  it('one opponent left of four: 1v1, late', () => {
    const p = gameProfile(
      base({
        players: [
          { id: ME, state: 'Playing' },
          { id: 20, state: 'Playing' },
          { id: 30, state: 'Eliminated' },
          { id: 40, state: 'Booted' },
        ],
      }),
    );
    expect(p.format).toBe('1v1');
    expect(p.opponents).toBe(1);
    expect(p.phase).toBe('late');
  });

  it('with no player list, counts the enemy players on the board', () => {
    const p = gameProfile(base({ players: [], board: board([...apart.territories.slice(0, 6), enemy(7, 5, 20), enemy(8, 5, 30)]) }));
    expect(p.format).toBe('ffa');
    expect(p.opponents).toBe(2);
    expect(p.notes.join('\n')).toMatch(/no player list/i);
  });
});

describe('gameProfile: phase', () => {
  it('turns 1–2 are the opening', () => {
    expect(gameProfile(base({ turn: 1, board: touching })).phase).toBe('opening');
    expect(gameProfile(base({ turn: 2 })).phase).toBe('opening');
  });

  it('the picking stage is the opening', () => {
    expect(gameProfile(base({ turn: null, picking: true })).phase).toBe('opening');
  });

  it('no territory of mine borders an enemy: expansion', () => {
    expect(gameProfile(base()).phase).toBe('expansion');
  });

  it('a border touches an enemy: contact', () => {
    expect(gameProfile(base({ board: touching })).phase).toBe('contact');
  });

  it('a teammate next to me is no contact', () => {
    const p = gameProfile(
      base({
        board: board([mine(1, 5), mine(2, 5), mine(3, 5), enemy(4, 5, 20), neutral(5, 2), neutral(6, 2), neutral(7, 2), neutral(8, 2)]),
        players: [
          { id: ME, team: 0 },
          { id: 20, team: 0 },
          { id: 30, team: 1 },
          { id: 31, team: 1 },
        ],
        estimates: [],
      }),
    );
    expect(p.phase).toBe('expansion');
  });

  it('one side holding over half the map: late', () => {
    const big = board([mine(1, 5), mine(2, 5), mine(3, 5), mine(4, 5), mine(5, 5), neutral(6, 2), enemy(7, 5, 20), enemy(8, 5, 20)]);
    expect(gameProfile(base({ board: big, players: [{ id: ME }, { id: 20 }, { id: 30 }] })).phase).toBe('late');
  });

  it('a 1v1 from the start with one opponent is not late by that alone', () => {
    expect(gameProfile(base({ board: touching })).phase).toBe('contact');
  });
});

describe('gameProfile: standing', () => {
  it(`ahead at ≥ ${AHEAD_RATIO}× the strongest opponent's estimate`, () => {
    const p = gameProfile(base({ income: 10, estimates: [{ playerId: 20, estimate: 8 }] }));
    expect(p.standing).toBe('ahead');
    expect(p.notes.join('\n')).toMatch(/income 10.*player 20.*~8/);
  });

  it(`behind at ≤ ${BEHIND_RATIO}×`, () => {
    expect(gameProfile(base({ income: 8, estimates: [{ playerId: 20, estimate: 10 }] })).standing).toBe('behind');
  });

  it('even in between, against the strongest of several opponents', () => {
    const p = gameProfile(
      base({
        players: [{ id: ME }, { id: 20 }, { id: 30 }],
        income: 10,
        estimates: [
          { playerId: 20, estimate: 5 },
          { playerId: 30, estimate: 9 },
        ],
      }),
    );
    expect(p.standing).toBe('even');
  });

  it('unknown when most of the board I do not hold is fogged', () => {
    const foggy = board([mine(1, 5), mine(2, 5), neutral(3, 2), fogged(4), fogged(5), fogged(6), fogged(7), enemy(8, 5, 20)]);
    const p = gameProfile(base({ board: foggy, income: 20 }));
    expect(p.standing).toBe('unknown');
    expect(p.notes.join('\n')).toMatch(/fog/i);
  });

  it('unknown when no opponent is in sight', () => {
    const p = gameProfile(base({ estimates: [] }));
    expect(p.standing).toBe('unknown');
    expect(p.notes.join('\n')).toMatch(/no opponent/i);
  });

  it("a teammate's estimate is not an opponent's", () => {
    const p = gameProfile(
      base({
        players: [
          { id: ME, team: 0 },
          { id: 20, team: 0 },
          { id: 30, team: 1 },
        ],
        income: 10,
        estimates: [
          { playerId: 20, estimate: 50 },
          { playerId: 30, estimate: 5 },
        ],
      }),
    );
    expect(p.standing).toBe('ahead');
  });
});

describe('gameProfile: settings', () => {
  it('echoes the settings that shape strategy', () => {
    const p = gameProfile(
      base({
        settings: {
          luckModifier: 0.16,
          roundingMode: 'WeightedRandom',
          cards: true,
          localDeployments: true,
          noSplit: true,
          commanders: true,
          fog: 'Foggy',
        },
      }),
    );
    expect(p.settings).toEqual({
      luck: 16,
      rounding: 'WeightedRandom',
      cards: true,
      localDeployments: true,
      noSplit: true,
      commanders: true,
      fog: 'Foggy',
    });
  });

  it('defaults to off / unknown', () => {
    expect(gameProfile(base()).settings).toEqual({
      luck: 0,
      rounding: null,
      cards: false,
      localDeployments: false,
      noSplit: false,
      commanders: false,
      fog: null,
    });
  });
});
