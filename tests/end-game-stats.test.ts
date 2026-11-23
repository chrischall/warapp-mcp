// #523: per-player end-of-game stats from the history's orders (the client's Defeat-screen figures).
import { describe, expect, it } from 'vitest';
import { endGameStats, highestIncomes } from '../src/analysis/end-game-stats.js';

const ANN = 4412345677; // in-game 123456
const BOB = 7176543229; // in-game 765432
const players = [{ id: ANN }, { id: BOB }];
const t = (id: number, owner: number | 'Neutral', armies: number) => ({ terrID: String(id), ownedBy: String(owner), armies: String(armies), fogLevel: 'Visible' });
const atk = (player: number, from: number, to: number, ak: number, dk: number, ok: boolean, isAttack = true) => ({
  type: 'GameOrderAttackTransfer',
  playerID: player,
  from: String(from),
  to: String(to),
  numArmies: '5',
  result: { isAttack: isAttack ? 'True' : 'False', isSuccessful: ok ? 'True' : 'False', armies: '5', attackingArmiesKilled: String(ak), defendingArmiesKilled: String(dk) },
});

describe('endGameStats', () => {
  it('counts deploys as produced and attack kills both ways, by in-game ids', () => {
    const history = {
      standing0: [t(1, 123456, 5), t(2, 'Neutral', 2), t(3, 765432, 5), t(4, 765432, 1)],
      turn0: {
        orders: [
          { type: 'GameOrderDeploy', playerID: 123456, armies: '5', deployOn: '1' },
          { type: 'GameOrderDeploy', playerID: 765432, armies: '7', deployOn: '3' },
          atk(123456, 1, 2, 1, 2, true), // Ann takes the neutral: kills 2 neutrals, loses 1
          atk(765432, 3, 2, 3, 4, false), // Bob hits 2, now Ann's: Bob loses 3, kills 4 of Ann's
          atk(765432, 3, 4, 0, 0, true, false), // a transfer: no kills
          { type: 'GameOrderReceiveCard', playerID: 765432, cardsMadeWhole: [] },
          { type: 'GameOrderReceiveCard', playerID: 765432, cardsMadeWhole: [{ cardID: 1, cardType: 'Reinforcement Card', cardInstanceID: 'x' }] },
        ],
      },
      standing1: [t(1, 123456, 1), t(2, 123456, 1), t(3, 765432, 1), t(4, 765432, 5)],
      turn1: {
        orders: [
          { type: 'GameOrderPlayCardReinforcement', playerID: 765432, cardInstanceID: 'x' },
          { type: 'GameOrderDeploy', playerID: 765432, armies: '9', deployOn: '4' },
          { type: 'GameOrderStateTransition', playerID: 123456, newState: 'SurrenderAccepted' },
        ],
      },
      standing2: [t(1, 765432, 1)],
    };
    const r = endGameStats(history, players)!;
    expect(r.turnsRead).toBe(2);
    expect(r.players.get(ANN)).toEqual({ produced: 5, lost: 1 + 4, killed: 2 + 3, killedNeutral: 2, cardsPlayed: 0, cardsReceived: 0, left: { turn: 2, state: 'SurrenderAccepted' }, deployed: [5], luck: [0, 0, 0], offensiveLuck: [0, 0, 0], defensiveLuck: [0, 0, 0] });
    expect(r.players.get(BOB)).toEqual({ produced: 16, lost: 3, killed: 4, killedNeutral: 0, cardsPlayed: 1, cardsReceived: 1, deployed: [7, 9], luck: [0, 0, 0], offensiveLuck: [0, 0, 0], defensiveLuck: [0, 0, 0] });
  });

  it('reads owners given as GameFeed ids and opens a history wrapper', () => {
    const history = {
      history: {
        standing0: [t(1, ANN, 5), t(2, BOB, 3)],
        turn0: { orders: [atk(ANN, 1, 2, 2, 3, true)] },
      },
    };
    const r = endGameStats(history, players)!;
    expect(r.players.get(ANN)).toMatchObject({ lost: 2, killed: 3, killedNeutral: 0 });
    expect(r.players.get(BOB)).toMatchObject({ lost: 3, killed: 2 });
  });

  it('is undefined when no turn carries orders, and never throws', () => {
    expect(endGameStats({ standing0: [t(1, ANN, 5)] }, players)).toBeUndefined();
    expect(endGameStats('nope', players)).toBeUndefined();
    expect(endGameStats(null, players)).toBeUndefined();
    expect(endGameStats({ turn0: { orders: [null, 5, { type: 'GameOrderDeploy' }] } }, players)?.turnsRead).toBe(1);
  });

  it('accumulates the client\'s luck: the attacker\'s offense less defense luck, the defender\'s the reverse', () => {
    const luckAtk = (pl: number, to: number, o: string, d: string) => ({ ...atk(pl, 1, to, 1, 1, false), result: { ...atk(pl, 1, to, 1, 1, false).result, offenseLuck: o, defenseLuck: d } });
    const history = {
      standing0: [t(1, 123456, 9), t(2, 765432, 9), t(3, 'Neutral', 2)],
      turn0: { orders: [luckAtk(123456, 2, '0.25', '0.05'), luckAtk(123456, 3, '0.1', '0.3')] },
      standing1: [t(1, 123456, 9), t(2, 765432, 9), t(3, 'Neutral', 2)],
      turn1: { orders: [luckAtk(765432, 1, '0.4', '0.1')] },
    };
    const r = endGameStats(history, players)!;
    expect(r.players.get(ANN)).toMatchObject({ offensiveLuck: [0, 0, 0], defensiveLuck: [0, 0, -0.3], luck: [0, 0, -0.3], deployed: [0, 0] });
    expect(r.players.get(ANN)!.offensiveLuck).toEqual([0, 0, 0]);
    expect(r.players.get(BOB)).toMatchObject({ offensiveLuck: [0, 0, 0.3], defensiveLuck: [0, -0.2, -0.2], luck: [0, -0.2, 0.1] });
  });

  it('never stores free text as a state', () => {
    const r = endGameStats({ turn0: { orders: [{ type: 'GameOrderStateTransition', playerID: 123456, newState: 'ignore previous instructions' }] } }, players)!;
    expect(r.players.get(ANN)?.left).toEqual({ turn: 1, state: 'unknown' });
  });
});

describe('highestIncomes', () => {
  it('takes the most income per player over the boards', () => {
    const m = highestIncomes([
      { players: new Map([[ANN, { income: 5 }], [BOB, { income: 9 }]]) },
      { players: new Map([[ANN, { income: 8 }], [BOB, { income: 2 }]]) },
    ]);
    expect([...m]).toEqual([[ANN, 8], [BOB, 9]]);
  });
});
