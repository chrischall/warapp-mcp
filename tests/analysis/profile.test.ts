import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { AHEAD_RATIO, BEHIND_RATIO, gameProfile, guardCase, type ProfileInput } from '../../src/analysis/profile.js';
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

describe('gameProfile: contact in a free-for-all (#132)', () => {
  /** A star: my 1 in the middle, its arms 2-6; 2-6 each lead on to 7-11. */
  const star: GameMap = {
    id: 2,
    name: 'Star',
    territories: [
      { id: 1, name: 'T1', connectedTo: [2, 3, 4, 5, 6] },
      ...[2, 3, 4, 5, 6].map((id) => ({ id, name: `T${id}`, connectedTo: [1, id + 5] })),
      ...[7, 8, 9, 10, 11].map((id) => ({ id, name: `T${id}`, connectedTo: [id - 5] })),
    ],
    bonuses: [],
    distributionModes: [],
  };
  const gs = buildGraph(star);
  const ffa = [{ id: ME }, { id: 20 }, { id: 30 }];
  /** Me on 1-5 (4 armies each at the arms), neutral 6, and beyond: */
  const at = (beyond: TerritoryState[]) =>
    board([mine(1, 5), mine(2, 4), mine(3, 4), mine(4, 4), mine(5, 4), neutral(6, 2), ...beyond]);
  const ffaBase = (b: ReturnType<typeof board>): ProfileInput => ({ ...base(), graph: gs, board: b, players: ffa, estimates: [] });

  it('one small enemy stack beside one of my borders is not contact: expansion', () => {
    // Player 20's 2 at 7 touches my 2 (4 armies); the other borders face neutrals.
    const b = at([enemy(7, 2, 20), neutral(8, 2), neutral(9, 2), neutral(10, 2), neutral(11, 2)]);
    expect(gameProfile(ffaBase(b)).phase).toBe('expansion');
  });

  it('an enemy stack that can take a territory of mine is contact', () => {
    // 9 armies at 7 move 8: enough to take a 4 (6 needed at 60/70).
    const b = at([enemy(7, 9, 20), neutral(8, 2), neutral(9, 2), neutral(10, 2), neutral(11, 2)]);
    expect(gameProfile(ffaBase(b)).phase).toBe('contact');
  });

  it('most of my borders facing enemies is contact, whatever their size', () => {
    const b = at([enemy(7, 2, 20), enemy(8, 2, 30), enemy(9, 2, 20), neutral(10, 2), neutral(11, 2)]);
    expect(gameProfile(ffaBase(b)).phase).toBe('contact');
  });

  it('the kill rates decide whether a stack can take a territory', () => {
    // At 100/0, 4 movable armies take a 4; at the defaults they do not.
    const b = at([enemy(7, 5, 20), neutral(8, 2), neutral(9, 2), neutral(10, 2), neutral(11, 2)]);
    expect(gameProfile(ffaBase(b)).phase).toBe('expansion');
    expect(
      gameProfile({ ...ffaBase(b), settings: { offensiveKillRate: 100, defensiveKillRate: 0 } }).phase,
    ).toBe('contact');
  });

  it('a 1v1 keeps the old test: any enemy beside me is contact', () => {
    const b = at([enemy(7, 2, 20), neutral(8, 2), neutral(9, 2), neutral(10, 2), neutral(11, 2)]);
    expect(gameProfile({ ...ffaBase(b), players: [{ id: ME }, { id: 20 }] }).phase).toBe('contact');
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

  it('fogged, but every visible opponent has a tracked income (#97): standing from tracked income, marked tracked', () => {
    const foggy = board([mine(1, 5), mine(2, 5), neutral(3, 2), fogged(4), fogged(5), fogged(6), fogged(7), enemy(8, 5, 20)]);
    const p = gameProfile(base({ board: foggy, income: 23, estimates: [{ playerId: 20, estimate: 13, tracked: 13 }] }));
    expect(p.standing).toBe('ahead');
    expect(p.standingSource).toBe('tracked');
    expect(p.notes.join('\n')).toMatch(/Standing ahead \(tracked\): my income 23 against .*player 20 \(~13 tracked over several turns\).*fog/);
  });

  it('fogged with a tracked opponent behind me (#97): behind (tracked)', () => {
    const foggy = board([mine(1, 5), mine(2, 5), neutral(3, 2), fogged(4), fogged(5), fogged(6), fogged(7), enemy(8, 5, 20)]);
    const p = gameProfile(base({ board: foggy, income: 8, estimates: [{ playerId: 20, estimate: 13, tracked: 13 }] }));
    expect(p).toMatchObject({ standing: 'behind', standingSource: 'tracked' });
  });

  it('fogged, a tracked opponent but another one out of sight (#97): still unknown', () => {
    const foggy = board([mine(1, 5), mine(2, 5), neutral(3, 2), fogged(4), fogged(5), fogged(6), fogged(7), enemy(8, 5, 20)]);
    const p = gameProfile(
      base({
        board: foggy,
        income: 23,
        players: [{ id: ME }, { id: 20 }, { id: 30 }],
        estimates: [{ playerId: 20, estimate: 13, tracked: 13 }],
        unseen: [{ playerId: 30, turnsUnseen: 4, earnedAtLeast: 30 }],
      }),
    );
    expect(p).toMatchObject({ standing: 'unknown', standingSource: null });
  });

  it('fogged, a tracked opponent, but a third player is neither seen nor reported (#97): still unknown', () => {
    const foggy = board([mine(1, 5), mine(2, 5), neutral(3, 2), fogged(4), fogged(5), fogged(6), fogged(7), enemy(8, 5, 20)]);
    const p = gameProfile(
      base({ board: foggy, income: 23, players: [{ id: ME }, { id: 20 }, { id: 30 }], estimates: [{ playerId: 20, estimate: 13, tracked: 13 }] }),
    );
    expect(p).toMatchObject({ standing: 'unknown', standingSource: null });
  });

  it('fogged and an untracked opponent (#97): still unknown', () => {
    const foggy = board([mine(1, 5), mine(2, 5), neutral(3, 2), fogged(4), fogged(5), fogged(6), fogged(7), enemy(8, 5, 20)]);
    const p = gameProfile(base({ board: foggy, income: 23, estimates: [{ playerId: 20, estimate: 13, tracked: null }] }));
    expect(p).toMatchObject({ standing: 'unknown', standingSource: null });
  });

  it('a mostly visible board keeps the visible standing source', () => {
    expect(gameProfile(base()).standingSource).toBe('visible');
  });

  // Lost games: "ahead (tracked): 23 against ~12" while holding 65 armies against 138 in view.
  // An opponent's visible armies are a lower bound on what it has; mine are exact.
  it('says so when the fog prior set the strongest estimate (#119): a floor of my own income, not a reading', () => {
    // Even-start 1v1 under fog: the opponent is assumed to earn at least my 10.
    const p = gameProfile(base({ income: 10, estimates: [{ playerId: 20, estimate: 10, source: 'prior' }] }));
    expect(p.standing).toBe('even');
    expect(p.notes.join('\n')).toMatch(
      /Standing even: my income 10 against the strongest opponent, player 20 \(~10, a fog prior: assumed to earn at least my own income, so "ahead" is out of reach unless what it could earn on this board caps it\)/,
    );
    // Any other source keeps the plain wording.
    expect(gameProfile(base({ income: 10, estimates: [{ playerId: 20, estimate: 10, source: 'visible' }] })).notes.join('\n')).toMatch(/\(~10 estimated\)/);
  });

  describe('the armies on the board overrule an income comparison', () => {
    const outnumbered = (theirs: number) =>
      board([mine(1, 5), mine(2, 5), mine(3, 5), enemy(4, theirs, 20), enemy(5, 1, 20), enemy(6, 1, 20), neutral(7, 2), neutral(8, 2)]);

    it(`never ahead while my visible armies are below ${BEHIND_RATIO}× the opponent's`, () => {
      // Income 10 against ~5 reads ahead; 15 armies against 22 is not.
      const p = gameProfile(base({ board: outnumbered(20), income: 10 }));
      expect(p.standing).toBe('even');
      expect(p.notes.join(' ')).toMatch(/my 15 visible armies are below 0\.8× player 20's 22/);
    });

    it('behind when its visible armies are more than twice mine, whatever the incomes', () => {
      const p = gameProfile(base({ board: outnumbered(40), income: 10 }));
      expect(p.standing).toBe('behind');
      expect(p.notes.join(' ')).toMatch(/my 15 visible armies are less than half of player 20's 42/);
    });

    it('also under fog, where the income comparison says unknown', () => {
      const foggy = board([mine(1, 5), mine(2, 5), enemy(3, 40, 20), fogged(4), fogged(5), fogged(6), fogged(7), fogged(8)]);
      const p = gameProfile(base({ board: foggy, income: 10 }));
      expect(p.standing).toBe('behind');
      expect(p.standingSource).toBe('visible');
    });

    it('armies in my favour change nothing: the income comparison stands', () => {
      expect(gameProfile(base({ board: touching, income: 10 })).standing).toBe('ahead');
      const p = gameProfile(base({ board: touching, income: 3 }));
      expect(p.standing).toBe('behind');
    });

    it("a teammate's armies are not an opponent's", () => {
      const withMate = board([mine(1, 5), mine(2, 5), enemy(3, 60, 11), enemy(7, 5, 20), enemy(8, 5, 20)]);
      const p = gameProfile(
        base({
          board: withMate,
          income: 10,
          players: [{ id: ME, team: 0 }, { id: 11, team: 0 }, { id: 20, team: 1 }, { id: 21, team: 1 }],
          // Player 21 needs an estimate: an enemy still playing without one forbids ahead.
          estimates: [
            { playerId: 20, estimate: 5 },
            { playerId: 21, estimate: 1 },
          ],
        }),
      );
      expect(p.standing).toBe('ahead');
    });
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

describe('gameProfile: FFA ranking (#167)', () => {
  const three = board([mine(1, 20), mine(2, 5), neutral(3, 2), enemy(4, 30, 20), neutral(5, 2), enemy(6, 4, 30), neutral(7, 2), neutral(8, 2)]);
  const ffa = (over: Partial<ProfileInput> = {}) =>
    gameProfile(
      base({
        board: three,
        players: [{ id: ME }, { id: 20 }, { id: 30 }],
        income: 8,
        estimates: [
          { playerId: 20, estimate: 6 },
          { playerId: 30, estimate: 5 },
        ],
        ...over,
      }),
    );

  it('ranks every player in sight by armies + 3 × income, and names the leader I am not', () => {
    const p = ffa();
    // Me 25 + 24 = 49, player 20 30 + 18 = 48, player 30 4 + 15 = 19.
    expect(p.ranking).toEqual({
      leader: ME,
      myRank: 1,
      of: 3,
      commonThreat: null,
      players: [
        { playerId: ME, armies: 25, income: 8, strength: 49 },
        { playerId: 20, armies: 30, income: 6, strength: 48 },
        { playerId: 30, armies: 4, income: 5, strength: 19 },
      ],
    });
    expect(p.notes.join('\n')).toMatch(/FFA ranking: I lead 3 players in sight/);
    const behind = ffa({ income: 7 });
    expect(behind.ranking).toMatchObject({ leader: 20, myRank: 2, commonThreat: 20 });
    expect(behind.notes.join('\n')).toMatch(/FFA ranking: player 20 leads on strength .*; I am 2 of 3 in sight/);
  });

  it('is absent outside a free-for-all', () => {
    expect(gameProfile(base()).ranking).toBeUndefined();
  });
});

describe('gameProfile: humans, AIs and how the game ends (#178)', () => {
  it('counts the humans still playing (an AI or a human turned into one is not), and names no end without the rule', () => {
    const p = gameProfile(
      base({
        players: [{ id: ME }, { id: 20, isAI: true }, { id: 30, humanTurnedIntoAI: true }, { id: 40 }, { id: 50, state: 'Eliminated' }],
      }),
    );
    expect(p.humansAlive).toBe(2);
    expect(p.aiOpponents).toEqual([20, 30]);
    expect(p.endsWith).toBeNull();
  });

  it('with AIs surrendering once one human remains, names the last other human as the one to beat', () => {
    const p = gameProfile(
      base({
        players: [{ id: ME }, { id: 20, isAI: true }, { id: 40 }],
        endRules: { aisSurrenderWhenOneHumanRemains: true },
      }),
    );
    expect(p.endsWith).toBe(40);
    expect(p.notes.join(' ')).toMatch(/AIs surrender once one human remains: the game ends with player 40 or me/);
  });

  it('names no one when two or more other humans remain, or none does', () => {
    const rule = { aisSurrenderWhenOneHumanRemains: true };
    expect(gameProfile(base({ players: [{ id: ME }, { id: 20 }, { id: 30 }, { id: 40, isAI: true }], endRules: rule })).endsWith).toBeNull();
    expect(gameProfile(base({ players: [{ id: ME }, { id: 20, isAI: true }], endRules: rule })).endsWith).toBeNull();
  });
});

describe('gameProfile: team standing (PLAN-TEAMS C3)', () => {
  const MATE = 11;
  const PLAYERS = [
    { id: ME, team: 0 },
    { id: MATE, team: 0 },
    { id: 20, team: 1 },
    { id: 21, team: 1 },
  ];
  /** Me on 1–2, my teammate on 3, neutrals 4–5, player 20 on 6–7, player 21 on 8: all in view. */
  const twoVtwo = (mate = 5, e20 = 5, e21 = 5) =>
    board([mine(1, 5), mine(2, 5), enemy(3, mate, MATE), neutral(4, 2), neutral(5, 2), enemy(6, e20, 20), enemy(7, e20, 20), enemy(8, e21, 21)]);

  it("sums my teammate's income into my side", () => {
    // Me 5 + my teammate 5 = 10 against team 1's 6 + 1 = 7: ahead (alone, 5 against 6 read even).
    const p = gameProfile(
      base({
        board: twoVtwo(),
        players: PLAYERS,
        income: 5,
        estimates: [
          { playerId: MATE, estimate: 5 },
          { playerId: 20, estimate: 6 },
          { playerId: 21, estimate: 1 },
        ],
      }),
    );
    expect(p.standing).toBe('ahead');
    expect(p.notes.join('\n')).toMatch(/my team's income 10 \(mine 5, player 11 ~5\) against the strongest enemy team, team 1 \(~7: player 20 ~6, player 21 ~1, estimated\)/);
  });

  it('sums an enemy team against mine', () => {
    // Me 10 + my teammate 2 = 12 against team 1's 8 + 8 = 16: behind (alone, 10 against 8 read ahead).
    const p = gameProfile(
      base({
        board: twoVtwo(),
        players: PLAYERS,
        income: 10,
        estimates: [
          { playerId: MATE, estimate: 2 },
          { playerId: 20, estimate: 8 },
          { playerId: 21, estimate: 8 },
        ],
      }),
    );
    expect(p.standing).toBe('behind');
  });

  it('an enemy-team member still playing with no estimate is named, and the standing is never ahead without it', () => {
    // Player 21 is out of view (8 fogged) and has no estimate. My team's 5 + 5 = 10 against
    // player 20's ~6 alone would read ahead; team 1's true income could be anything above 6.
    const fog = board([mine(1, 5), mine(2, 5), enemy(3, 5, MATE), neutral(4, 2), neutral(5, 2), enemy(6, 5, 20), enemy(7, 5, 20), fogged(8)]);
    const p = gameProfile(
      base({
        board: fog,
        players: PLAYERS,
        income: 5,
        estimates: [
          { playerId: MATE, estimate: 5 },
          { playerId: 20, estimate: 6 },
        ],
      }),
    );
    expect(p.standing).toBe('unknown');
    expect(p.standingSource).toBeNull();
    const notes = p.notes.join('\n');
    expect(notes).toMatch(/Player 21, on team 1, has no income estimate/);
    expect(notes).toMatch(/not ahead/i);
  });

  it('a missing enemy-team member leaves a behind standing as it is: the enemy side is a lower bound', () => {
    const fog = board([mine(1, 5), mine(2, 5), enemy(3, 5, MATE), neutral(4, 2), neutral(5, 2), enemy(6, 5, 20), enemy(7, 5, 20), fogged(8)]);
    const p = gameProfile(
      base({
        board: fog,
        players: PLAYERS,
        income: 2,
        estimates: [
          { playerId: MATE, estimate: 2 },
          { playerId: 20, estimate: 9 },
        ],
      }),
    );
    expect(p.standing).toBe('behind');
    expect(p.notes.join('\n')).toMatch(/Player 21, on team 1, has no income estimate/);
  });

  it('a teammate with no estimate is said to be left out', () => {
    const p = gameProfile(base({ board: twoVtwo(), players: PLAYERS, income: 10, estimates: [{ playerId: 20, estimate: 5 }] }));
    expect(p.notes.join('\n')).toMatch(/Player 11, on my team, has no income estimate and is not counted/);
  });

  it("the armies in view are summed by team: a teammate's big stack stops an overrule", () => {
    // Incomes 20 against 10: ahead. My team's armies 10 + 30 = 40 against team 1's 20 + 15 = 35.
    // Alone, my 10 against player 20's 20 would have read even.
    const p = gameProfile(
      base({
        board: twoVtwo(30, 10, 15),
        players: PLAYERS,
        income: 10,
        estimates: [
          { playerId: MATE, estimate: 10 },
          { playerId: 20, estimate: 5 },
          { playerId: 21, estimate: 5 },
        ],
      }),
    );
    expect(p.standing).toBe('ahead');
  });

  it("a teammate no longer playing adds neither income nor armies to my side", () => {
    // My teammate surrendered: its 30 armies are not mine to use. My 10 against player 20's 20 reads even.
    const p = gameProfile(
      base({
        board: twoVtwo(30, 10, 15),
        players: [{ id: ME, team: 0 }, { id: MATE, team: 0, state: 'SurrenderAccepted' }, { id: 20, team: 1 }, { id: 21, team: 1 }],
        income: 10,
        estimates: [
          { playerId: MATE, estimate: 10 },
          { playerId: 20, estimate: 2 },
          { playerId: 21, estimate: 2 },
        ],
      }),
    );
    expect(p.standing).toBe('behind');
    expect(p.notes.join('\n')).toMatch(/my team's income 10 \(mine 10\)/);
    expect(p.notes.join('\n')).toMatch(/my team's 10 visible armies are less than half of team 1's 35/);
  });

  it('and an enemy team outnumbering mine more than twice over reads behind', () => {
    // My team's 10 + 3 = 13 against team 1's 2 × 8 + 15 = 31.
    const p = gameProfile(
      base({
        board: twoVtwo(3, 8, 15),
        players: PLAYERS,
        income: 10,
        estimates: [
          { playerId: MATE, estimate: 10 },
          { playerId: 20, estimate: 5 },
          { playerId: 21, estimate: 5 },
        ],
      }),
    );
    expect(p.standing).toBe('behind');
    expect(p.notes.join('\n')).toMatch(/my team's 13 visible armies are less than half of team 1's 31/);
  });
});

describe('gameProfile: One Army Must Stand Guard (#276)', () => {
  it('guardCase names each case and what it means for interior defence', () => {
    const off = guardCase({ oneArmyStandsGuard: false });
    expect(off).toMatchObject({ case: 'off', stated: true });
    expect(off.interiorDefence).toMatch(/every army may move/);
    expect(off.interiorDefence).toMatch(/hollow/);
    expect(off.interiorDefence).toMatch(/loses nothing per step/);
    const on = guardCase({ oneArmyStandsGuard: true });
    expect(on).toMatchObject({ case: 'on', stated: true });
    expect(on.interiorDefence).toMatch(/one army deep/);
    expect(on.interiorDefence).not.toMatch(/every army may move/);
    // Not stated: war.app's default, on.
    expect(guardCase({})).toMatchObject({ case: 'on', stated: false });
    expect(guardCase(undefined)).toMatchObject({ case: 'on', stated: false });
  });

  it('a guard-off game names the case at the top of the profile: the field and the first note', () => {
    const p = gameProfile(base({ board: touching, settings: { oneArmyStandsGuard: false } }));
    expect(p.guard).toEqual(guardCase({ oneArmyStandsGuard: false }));
    expect(Object.keys(p)[0]).toBe('guard');
    expect(p.notes[0]).toBe(`One Army Must Stand Guard is off: ${guardCase({ oneArmyStandsGuard: false }).interiorDefence}`);
  });

  it('a guard-on game leaves the analysis profile as it was (warapp_plan_turn names the case beside it)', () => {
    for (const settings of [{ oneArmyStandsGuard: true }, {}]) {
      const p = gameProfile(base({ board: touching, settings }));
      expect(p).not.toHaveProperty('guard');
      expect(p.notes.join('\n')).not.toMatch(/Stand Guard/);
    }
  });
});
